import { isProgramDerived } from "./address";
import { config } from "./config";
import { take } from "./limit";
import { chargeRpc } from "./meter";
import { WSOL_MINT } from "./mints";

/**
 * Which book to draw the chart from, found by asking who holds the token.
 *
 * The chart used to be built by reading the MINT's transactions. That is the
 * wrong address, and it is the single reason candles were unreliable. Asking
 * Helius for a mint returns every transaction that so much as references the
 * mint account, and on a token people actually trade that is overwhelmingly
 * bot traffic that never touches a pool:
 *
 *      MEASURED on Ai66LHZG (27 days old, ~1.8M swaps)
 *      300 transactions sampled across its whole life via the mint    3 trades
 *      11,085 transactions returned for one 300-second window       310 trades
 *
 * At ~50 sampled transactions per bucket that is one real fill per candle,
 * which is why bars came back flat, empty, or wicked through the floor. Read
 * the POOL instead and the same request returns nothing but trades.
 */

export interface Venue {
  /** The pool account. Every swap on this book references it. */
  pool: string;
  /** Token account holding the token being charted. */
  baseVault: string;
  /** Token account holding what it trades against, once a swap has named it. */
  quoteVault?: string;
  quoteMint?: string;
  /** Set when the book holds native lamports rather than wrapped SOL. */
  nativeQuote?: boolean;
  /** Swaps per second when it was ranked. Picks the book to draw. */
  rate: number;
}

/**
 * `params` is passed through as given: standard RPC methods take a positional
 * array, and Helius's DAS methods take a single object. Wrapping a DAS object
 * in an array is rejected.
 */
async function rpc<T>(method: string, params: unknown): Promise<T | null> {
  try {
    await take();
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "pool", method, params }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: T };
    chargeRpc(method, params, body.result);
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Every pool holding this token, from its twenty largest holders.
 *
 * A pool is a holder like any other, and it is nearly always among the biggest.
 * Telling it apart from a whale needs no registry of DEX programs: a person's
 * token account is owned by their wallet, which the System Program owns, while
 * a vault is owned by a PDA the DEX program owns. Three standard RPC calls —
 * MEASURED at 800ms — and it works for a bonding curve minutes old as well as
 * for a pool that has been trading for a month.
 */
export async function discoverVenues(mint: string): Promise<Venue[]> {
  const largest = await rpc<{ value?: { address: string; amount: string }[] }>(
    "getTokenLargestAccounts",
    [mint],
  );
  const holders = largest?.value ?? [];
  if (holders.length === 0) return [];

  const accounts = await rpc<{
    value?: ({ data?: { parsed?: { info?: { owner?: string } } } } | null)[];
  }>("getMultipleAccounts", [holders.map((h) => h.address), { encoding: "jsonParsed" }]);

  const owners = (accounts?.value ?? []).map(
    (a) => a?.data?.parsed?.info?.owner ?? "",
  );

  // Whether the owner is a person is decided from the address itself — see
  // `isProgramDerived`. Asking the chain what program owns it cannot tell a
  // funded PDA from a wallet, and costs a round trip to be wrong.
  const venues: Venue[] = [];
  owners.forEach((owner, i) => {
    const holder = holders[i];
    if (!owner || !holder || !isProgramDerived(owner)) return;
    venues.push({ pool: owner, baseVault: holder.address, rate: 0 });
  });
  return venues;
}

/**
 * Only the transactions that traded, and all of them.
 *
 * `tokenTransfer.mint` is the filter that makes this app possible. MEASURED
 * against reading the same windows unfiltered and classifying every
 * transaction by hand:
 *
 *      window            returned unfiltered   real swaps   filter returned
 *      300s at mid-life          275               45          45  (0 missed)
 *      300s at day 26         11,085              310         310  (0 missed)
 *
 * Perfect precision and perfect recall, for a thirty-sixth of the data. It is
 * applied to every read in this app that wants trades.
 */
export function tradeFilter(mint: string) {
  return { status: "succeeded" as const, tokenTransfer: { mint } };
}

async function swapRate(
  pool: string,
  mint: string,
): Promise<{ rate: number; sample: unknown[] }> {
  const res = await rpc<{ data?: { blockTime?: number }[] }>(
    "getTransactionsForAddress",
    [
      pool,
      {
        transactionDetails: "signatures",
        sortOrder: "desc",
        limit: 1_000,
        maxSupportedTransactionVersion: 0,
        filters: tradeFilter(mint),
      },
    ],
  );
  const data = res?.data ?? [];
  if (data.length < 2) return { rate: 0, sample: data };
  const span = (data[0]?.blockTime ?? 0) - (data[data.length - 1]?.blockTime ?? 0);
  return { rate: span > 0 ? data.length / span : 0, sample: data };
}

/**
 * The busiest book, which is the one the chart should be drawn from.
 *
 * A token trades on several at once — this one has a PumpSwap pool and some
 * twenty-nine Meteora pools — and they do not hold exactly the same price.
 * Interleaving them put 20% steps between bars a second apart, which is two
 * books being read alternately rather than a market moving. So the chart comes
 * from one book. A wallet's own PnL still counts every venue it traded on;
 * that path reads the wallet, not the pool.
 */
export async function pickVenue(mint: string): Promise<Venue | null> {
  const venues = await discoverVenues(mint);
  if (venues.length === 0) return null;

  const ranked = await Promise.all(
    venues.map(async (v) => ({ ...v, rate: (await swapRate(v.pool, mint)).rate })),
  );
  ranked.sort((a, b) => b.rate - a.rate);
  const best = ranked[0];
  if (!best || best.rate === 0) return null;

  return (await resolveQuote(best, mint)) ?? best;
}

/**
 * Which account holds the other side, learned from a real swap.
 *
 * Pinning both vaults by ADDRESS rather than by owner because Raydium's v4
 * pools share one global authority — every pool's vaults report the same
 * owner, so grouping a swap's legs by owner would merge unrelated books. The
 * base vault comes from discovery; this reads a handful of swaps to see which
 * account consistently moves opposite it.
 */
async function resolveQuote(venue: Venue, mint: string): Promise<Venue | null> {
  const res = await rpc<{ data?: unknown[] }>("getTransactionsForAddress", [
    venue.pool,
    {
      transactionDetails: "full",
      sortOrder: "desc",
      limit: 8,
      maxSupportedTransactionVersion: 0,
      filters: tradeFilter(mint),
    },
  ]);
  const seen = new Map<string, { mint: string; hits: number }>();
  let nativeHits = 0;

  for (const raw of res?.data ?? []) {
    const tx = raw as {
      meta?: {
        preTokenBalances?: TokenBalanceRow[];
        postTokenBalances?: TokenBalanceRow[];
        preBalances?: number[];
        postBalances?: number[];
        loadedAddresses?: { writable?: string[]; readonly?: string[] };
      };
      transaction?: { message?: { accountKeys?: (string | { pubkey: string })[] } };
    };
    const keys = accountKeys(tx);
    const pre = tx.meta?.preTokenBalances ?? [];
    const post = tx.meta?.postTokenBalances ?? [];

    // The base vault's own owner scopes the search to this pool's accounts.
    const baseRow = post.find((b) => keys[b.accountIndex] === venue.baseVault);
    if (!baseRow) continue;

    for (const b of post) {
      const address = keys[b.accountIndex];
      if (!address || address === venue.baseVault) continue;
      if (b.owner !== baseRow.owner || b.mint === mint) continue;
      const before = pre.find((p) => p.accountIndex === b.accountIndex);
      if (b.uiTokenAmount.amount === (before?.uiTokenAmount.amount ?? "0")) continue;
      const held = seen.get(address) ?? { mint: b.mint, hits: 0 };
      held.hits += 1;
      seen.set(address, held);
    }

    // A bonding curve holds lamports rather than wrapped SOL, so its quote leg
    // never appears as a token balance at all.
    const poolIndex = keys.indexOf(venue.pool);
    if (
      poolIndex >= 0 &&
      (tx.meta?.preBalances?.[poolIndex] ?? 0) !==
        (tx.meta?.postBalances?.[poolIndex] ?? 0)
    ) {
      nativeHits += 1;
    }
  }

  const best = [...seen.entries()].sort((a, b) => b[1].hits - a[1].hits)[0];
  if (best) {
    return { ...venue, quoteVault: best[0], quoteMint: best[1].mint };
  }
  if (nativeHits > 0) {
    return { ...venue, nativeQuote: true, quoteMint: WSOL_MINT };
  }
  return null;
}

export interface TokenBalanceRow {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/**
 * Static keys, then loaded writable, then loaded readonly.
 *
 * The order the runtime resolves `accountIndex` against. Getting it wrong does
 * not throw — it silently names the wrong account, which reads as a pool that
 * never traded.
 */
export function accountKeys(tx: {
  transaction?: { message?: { accountKeys?: (string | { pubkey: string })[] } };
  meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } };
}): string[] {
  const stat = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === "string" ? k : k.pubkey,
  );
  return [
    ...stat,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
}

/**
 * Everyone still holding the token, biggest first.
 *
 * The trader board used to nominate purely from a sample of trades, and that
 * sample cannot see a wallet that bought once and sat on it: MEASURED, a
 * wallet holding 5.5M tokens — the FOURTEENTH largest holder, up $487,000 —
 * made 101 trades out of this token's 1.8 million, so a thousand-trade sample
 * missed it every time. Both sides of the board were wrong for the same
 * reason: the biggest winners are usually holding, and so are the biggest
 * losers.
 *
 * `getTokenLargestAccounts` gives a definitive top twenty in one call but
 * stops there. Paging every holder costs more — MEASURED, 101,153 holders in
 * 103 pages, 19 seconds — and is worth it exactly once per token, which is
 * what the board's cache makes it.
 */
const HOLDER_PAGES = Number(process.env.HISTORY_HOLDER_PAGES ?? 120);

export interface HolderScan {
  /** Wallets, biggest first. Pools removed. */
  holders: { owner: string; amount: number }[];
  /**
   * Every pool holding the token, biggest first.
   *
   * Falls out of the same scan for free, and it is the only Helius-only way to
   * find ALL of them — `getTokenLargestAccounts` stops at twenty, and this
   * token's liquidity is spread over a PumpSwap pool and some twenty-nine
   * Meteora ones, most of which hold too little to make that top twenty.
   */
  pools: { pool: string; amount: number }[];
}

export async function scanHolders(
  mint: string,
  limit: number,
): Promise<HolderScan> {
  const byOwner = new Map<string, number>();
  let cursor: string | undefined;

  for (let page = 0; page < HOLDER_PAGES; page += 1) {
    const res = await rpc<{
      token_accounts?: { owner: string; amount: number | string }[];
      cursor?: string;
    }>("getTokenAccounts", {
      mint,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
      options: { showZeroBalance: false },
    });
    const accounts = res?.token_accounts ?? [];
    // One owner can hold the token in several accounts; the board ranks people.
    for (const a of accounts) {
      byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0) + Number(a.amount));
    }
    cursor = res?.cursor;
    if (!cursor || accounts.length === 0) break;
  }

  const ranked = [...byOwner.entries()]
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => b.amount - a.amount)
    // Wide enough that the pools removed below do not eat into the limit, and
    // deep enough to catch pools that hold little.
    .slice(0, limit * 3);

  const split = splitPools(ranked);
  return { holders: split.wallets.slice(0, limit), pools: split.pools };
}

/**
 * Wallets on one side, pools on the other.
 *
 * Both halves are wanted — the wallets are board candidates, and the pools are
 * where the rest of the trading happened. Purely local: this used to batch
 * `getMultipleAccounts` over every holder, which on a token with a hundred
 * thousand of them is a lot of requests to answer a question the address
 * already answers.
 */
function splitPools(holders: { owner: string; amount: number }[]): {
  wallets: { owner: string; amount: number }[];
  pools: { pool: string; amount: number }[];
} {
  const wallets: { owner: string; amount: number }[] = [];
  const pools: { pool: string; amount: number }[] = [];
  for (const h of holders) {
    if (isProgramDerived(h.owner)) pools.push({ pool: h.owner, amount: h.amount });
    else wallets.push(h);
  }
  return { wallets, pools };
}

/**
 * Which of these addresses a program controls.
 *
 * Used to decide whether a wallet's counterparty was a pool, and therefore
 * whether tokens that moved were traded or transferred. Kept as a set-returning
 * helper because that is how the caller wants it; the work itself is local.
 */
export function programOwned(addresses: string[]): Set<string> {
  return new Set(addresses.filter((a) => a && isProgramDerived(a)));
}
