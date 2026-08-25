import { config } from "./config";
import { take } from "./limit";
import { charge } from "./meter";
import { QUOTE_MINTS } from "./mints";

/**
 * Which tokens a wallet has actually touched.
 *
 * Nothing else in this app asks this question. Every read here is scoped to a
 * (mint, wallet) pair, because the site was built around knowing the mint
 * first — you find a token, then you find who won on it. The demand runs the
 * other way: people want to replay THEIR trades, and they do not have a
 * forty-four character mint to hand.
 *
 * Asked of the wallet's TOKEN ACCOUNTS, not of its transfers. The first
 * version paged `getTransfersByAddress` and it was wrong in a way that only
 * showed up on a real wallet: MEASURED on 83b2LMf1, two thousand transfers —
 * twenty pages, two hundred credits — turned up ONE token, because 1,999 of
 * them were USDC moved inside a two-hour window. A transfer budget is a budget
 * of the wrong thing; any wallet with a high-frequency leg spends the whole of
 * it before reaching the trades.
 *
 * The same wallet's token accounts are 329 mints in ONE call at ten credits,
 * names and balances included, closed positions among them. Twenty times the
 * answer for a twentieth of the price, and it cannot be starved by noise
 * because it is not a window over time at all.
 */

/** DAS pages assets; a thousand is the ceiling per call. */
const PAGE = 1_000;
const MAX_PAGES = Number(process.env.WALLET_ASSET_PAGES ?? 3);

export interface TradedMint {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  /** Raw base units still held. Zero means the position was closed. */
  balance: number;
  decimals: number;
  /** What the remaining balance is worth, when the token has a market. */
  valueUsd: number;
  /** Whether DAS knows a price for it at all — i.e. whether it has a market. */
  priced: boolean;
  /**
   * Almost certainly an airdrop rather than something this wallet traded.
   *
   * The signature is holding a full balance of something with no market: the
   * wallet received it and has never moved any of it, and there is nowhere it
   * could have been bought. A token that was genuinely traded either has a
   * market or has been sold down — usually both.
   *
   * A heuristic, and reported rather than enforced: the caller decides whether
   * to hide these, because a real token that has since rugged looks the same
   * from here and its owner may well want to replay exactly that.
   */
  likelySpam: boolean;
}

interface Asset {
  id?: string;
  content?: {
    metadata?: { name?: string; symbol?: string };
    links?: { image?: string };
    files?: { uri?: string; cdn_uri?: string }[];
  };
  token_info?: {
    balance?: number | string;
    decimals?: number;
    price_info?: { price_per_token?: number; total_price?: number };
  };
}

async function page(
  wallet: string,
  index: number,
): Promise<{ items: Asset[]; total: number } | null> {
  try {
    await take();
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "traded",
        method: "searchAssets",
        params: {
          ownerAddress: wallet,
          tokenType: "fungible",
          limit: PAGE,
          page: index,
          /**
           * Zero balances are the POINT, not noise.
           *
           * A closed position leaves an empty token account behind, and a
           * closed position is exactly what somebody wants to replay — the
           * trade they finished. Without this the list is only what the wallet
           * still holds, which is the least interesting half.
           */
          options: { showZeroBalance: true },
        },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: { items?: Asset[]; total?: number };
    };
    charge({ kind: "das" });
    return { items: body.result?.items ?? [], total: body.result?.total ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Every fungible token this wallet holds or has held.
 *
 * Ordered by what is most likely to be worth replaying: what it still holds
 * and what that is worth, then closed positions, then the airdrop tail. There
 * are no timestamps in this answer — DAS reports holdings, not history — so
 * "most recent" is not available and value is the better proxy anyway.
 */
export async function tradedMints(
  wallet: string,
  opts: { pages?: number } = {},
): Promise<{ mints: TradedMint[]; truncated: boolean; scanned: number }> {
  const limit = Math.max(1, Math.min(opts.pages ?? MAX_PAGES, 10));

  const found: TradedMint[] = [];
  let scanned = 0;
  let truncated = false;

  for (let i = 1; i <= limit; i += 1) {
    const res = await page(wallet, i);
    if (!res) break;
    scanned += res.items.length;

    for (const asset of res.items) {
      const mint = asset.id;
      if (!mint) continue;
      // The money side of every trade. True, and not a token anyone replays.
      if (QUOTE_MINTS.has(mint)) continue;

      const info = asset.token_info;
      const balance = Number(info?.balance ?? 0);
      const decimals = info?.decimals ?? 0;
      const perToken = info?.price_info?.price_per_token;
      const priced = typeof perToken === "number" && perToken > 0;
      const valueUsd = Number(info?.price_info?.total_price ?? 0);

      const meta = asset.content?.metadata;
      const files = asset.content?.files ?? [];
      found.push({
        mint,
        name: meta?.name,
        symbol: meta?.symbol,
        image: files[0]?.cdn_uri ?? files[0]?.uri ?? asset.content?.links?.image,
        balance,
        decimals,
        valueUsd,
        priced,
        likelySpam: !priced && balance > 0,
      });
    }

    if (res.items.length < PAGE) break;
    if (i === limit) truncated = true;
  }

  found.sort((a, b) => {
    // Held and worth something, then closed positions, then the tail.
    const rank = (t: TradedMint) => (t.valueUsd > 0 ? 0 : t.balance === 0 ? 1 : 2);
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return b.valueUsd - a.valueUsd;
  });

  return { mints: found, truncated, scanned };
}
