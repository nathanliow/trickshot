import { config } from "./config";
import { take } from "./limit";
import { charge } from "./meter";
import { loadBlobs, saveBlobs } from "./store";

/**
 * Names for addresses, where Helius knows one.
 *
 * A board of base58 is a board nobody reads. The Wallet Identity API turns a
 * useful fraction of it into people — MEASURED on this token's board, of 22
 * addresses looked up in 1.7 seconds:
 *
 *      HDixbrzw   +$4.7M    "latentfish83215" on Pump.fun
 *      2M2vLX34   +$1.6M    "SossaDotKek" on Pump.fun
 *      498g1rVn   +$487k    Frank Degods
 *      8deJ9xeU    -$27k    Cooker @CookerFlips
 *
 * Most addresses come back unknown, which is expected and fine: an unnamed
 * wallet keeps its address. Nothing here is load-bearing — a failed lookup
 * costs a label, never a number — so every error resolves to "no name".
 *
 * The Wallet API is in beta and needs a paid plan; a free key answers 403.
 */

/** The documented ceiling for one batch-identity request. */
const BATCH = 100;

/**
 * How long a cached answer stands.
 *
 * The lookup is a hundred credits per REQUEST, whether it carries one address
 * or a hundred — so the single-wallet call on every replay cost exactly as
 * much as the board's batch of two hundred, and was the largest line item on
 * the cheapest path in the app.
 *
 * A name is a near-static fact about an address, so this can be long. The
 * shorter window is for MISSES: an unnamed wallet may acquire a name later,
 * and it is worth asking again occasionally — but not on every visit, which is
 * what caching only the hits would mean. Most addresses come back unknown, so
 * without negative caching the cache would barely bite.
 */
const NAMED_TTL = Number(process.env.IDENTITY_TTL ?? 30 * 24 * 3_600);
const UNNAMED_TTL = Number(process.env.IDENTITY_MISS_TTL ?? 3 * 24 * 3_600);

/** `null` name means "asked, and Helius had none" — a cached miss. */
interface CachedIdentity {
  at: number;
  identity: Identity | null;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * `v2` because the shape of a MISS changed.
 *
 * A wallet holding `desmartin.sol` and no `name` was cached under v1 as
 * "Helius has nothing", and a miss stands for days. Widening what counts as a
 * name only reaches those wallets if the old answers stop being read.
 */
const identityKey = (address: string) => `identity:v2:${address}`;

function fresh(held: CachedIdentity | undefined): boolean {
  if (!held) return false;
  const age = nowSec() - held.at;
  return age < (held.identity ? NAMED_TTL : UNNAMED_TTL);
}

export interface Identity {
  /** A human name: an exchange, a protocol, a person. */
  name?: string;
  /** "Centralized Exchange", "Individual", "Key Opinion Leader". */
  category?: string;
  /** "exchange", "wallet", "program", "unknown". */
  type?: string;
}

interface IdentityRow {
  address?: string | null;
  name?: string;
  category?: string;
  type?: string;
  /** SNS domains the address holds, favourite first. */
  domainNames?: string[];
}

/**
 * Look up many addresses at once.
 *
 * Only addresses Helius can actually NAME come back in the map, and a wallet's
 * own `.sol` domain counts as one: `desmartin.sol` is a name a person chose,
 * and it names wallets the `name` field misses entirely.
 *
 * Tags — "Pump.fun User", "Jup.ag User", "Fomo User" — cover far more of a
 * board (MEASURED on 300 board wallets: 163 tagged against 16 named) and are
 * still dropped. They say which venue a wallet trades through, not who it is,
 * and the commonest of them by a wide margin is "Jup.ag User", which is true
 * of nearly everyone and so tells a reader nothing.
 */
export async function identify(
  addresses: string[],
): Promise<Map<string, Identity>> {
  const found = new Map<string, Identity>();
  const unique = [...new Set(addresses)].filter(Boolean);
  if (unique.length === 0) return found;

  /**
   * The cache is read for the whole set in one go, not one address at a time.
   *
   * The board hands this a couple of hundred addresses. Reading them
   * individually would be a couple of hundred sequential round trips to avoid
   * two or three calls to Helius — slower than not caching at all, and the
   * reason `loadBlobs` exists.
   */
  const held = await loadBlobs<CachedIdentity>(unique.map(identityKey));
  const ask: string[] = [];
  for (const address of unique) {
    const hit = held.get(identityKey(address));
    if (!fresh(hit)) {
      ask.push(address);
      continue;
    }
    if (hit?.identity) found.set(address, hit.identity);
  }
  if (ask.length === 0) return found;

  const batches: string[][] = [];
  for (let i = 0; i < ask.length; i += BATCH) {
    batches.push(ask.slice(i, i + BATCH));
  }

  const pages = await Promise.all(
    batches.map(async (batch) => {
      try {
        await take();
        const res = await fetch(
          `https://api.helius.xyz/v1/wallet/batch-identity?api-key=${config.apiKey}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(15_000),
            body: JSON.stringify({ addresses: batch }),
          },
        );
        if (!res.ok) return null;
        const body: unknown = await res.json();
        // Flat per REQUEST, not per address — one lookup of a single wallet
        // costs the same hundred credits as a full batch of a hundred. That
        // asymmetry is why this is cached and why the fan-out never calls it.
        charge({ kind: "identity" });
        return Array.isArray(body) ? (body as IdentityRow[]) : [];
      } catch {
        return null;
      }
    }),
  );

  /**
   * Only what was actually ASKED gets written back, hits and misses alike.
   *
   * A batch whose request failed returns null rather than an empty list, so a
   * transient error is not cached as "this address has no name" for days.
   */
  const asked = new Set<string>();
  batches.forEach((batch, i) => {
    if (pages[i] !== null) for (const address of batch) asked.add(address);
  });

  for (const rows of pages) {
    for (const row of rows ?? []) {
      if (!row?.address) continue;
      /**
       * The first domain, not the shortest or the prettiest one.
       *
       * A wallet with thirteen of them lists its favourite first and the rest
       * alphabetically — MEASURED, `gremlin.sol` ahead of `615.sol`,
       * `aristocracy.sol`, `chai.sol` — so index zero is a choice somebody
       * made, not an accident of sorting.
       */
      const name = row.name ?? row.domainNames?.[0];
      if (!name) continue;
      found.set(row.address, {
        name,
        category: row.category,
        type: row.type,
      });
    }
  }

  const at = nowSec();
  await saveBlobs(
    [...asked].map((address) => ({
      key: identityKey(address),
      value: { at, identity: found.get(address) ?? null } satisfies CachedIdentity,
    })),
  );

  return found;
}

export interface TokenIdentity {
  name?: string;
  symbol?: string;
  image?: string;
}

/**
 * What a token is called, from DAS.
 *
 * The identity endpoint answers "unknown" for a mint — it names wallets and
 * programs, not tokens — so the name comes from the asset's own metadata.
 * MEASURED: `Ai66LHZG…` is Catecoin (CATE), which is a great deal more use in
 * a list than `Ai66LHZG…` is.
 */
export async function tokenIdentity(mint: string): Promise<TokenIdentity> {
  try {
    await take();
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "identity",
        method: "getAsset",
        params: { id: mint },
      }),
    });
    if (!res.ok) return {};
    charge({ kind: "das" });
    const body = (await res.json()) as {
      result?: {
        content?: {
          metadata?: { name?: string; symbol?: string };
          links?: { image?: string };
          files?: { uri?: string; cdn_uri?: string; mime?: string }[];
        };
      };
    };
    const content = body.result?.content;
    /**
     * The CDN copy first, the original only as a fallback.
     *
     * Token art is hosted wherever its creator put it, and plenty of those
     * hosts refuse to serve it to anyone else. MEASURED on this token: its
     * image returns 403 when a browser asks with a Referer header and 200
     * without, which is hotlink protection — so it loaded from curl and not
     * from the page. Helius mirrors the same file and serves it to anyone.
     */
    const file = content?.files?.find((f) => f.cdn_uri || f.uri);
    return {
      name: content?.metadata?.name,
      symbol: content?.metadata?.symbol,
      image: file?.cdn_uri ?? content?.links?.image ?? file?.uri,
    };
  } catch {
    return {};
  }
}
