import bs58 from "bs58";
import { config } from "./config";
import { take } from "./limit";
import { normalizeTx, type NormalizedTx } from "./decode/normalizeTx";
import {
  PositionBook,
  type PnlRow,
  type ReplayPoint,
  type StoredPosition,
} from "./positions";
import { SolPriceHistory } from "./solPrice";
import type { Candle } from "./candles";
import {
  buildCandles,
  priceSwap,
  spotPrice,
  type RawTx,
  type Swap,
} from "./candles";
import { densityMap } from "./density";
import { estimateSeconds, estimateWindow } from "./estimate";
import { walletGraph, type Related, type WalletGraph } from "./graph";
import { identify, tokenIdentity } from "./identity";
import {
  BudgetExceeded,
  charge,
  checkBudget,
  currentCaller,
  metered,
  spentSoFar,
} from "./meter";
import { recordSpend } from "./budget";
import {
  accountKeys,
  pickVenue,
  programOwned,
  scanHolders,
  tradeFilter,
  type Venue,
} from "./pool";
import { QUOTE_MINTS, WSOL_MINT } from "./mints";
import { isProgramDerived } from "./address";
import {
  galleryTokens,
  tokenRow,
  loadBlob,
  loadBlobs,
  saveBlobs,
  loadSeries,
  loadZoom,
  mergeCandles,
  missingRanges,
  rememberToken,
  saveBlob,
  saveSeries,
  type BuiltToken,
  type Coverage,
} from "./store";

/**
 * A token's whole life, rebuilt from archival transactions.
 *
 * The live worker only knows what it was watching. This answers the other
 * question — "show me what happened on this token, and what this wallet did" —
 * for any mint, at any age, including ones we never tracked.
 *
 * Priced from BALANCES throughout — the pool's vaults for the chart, the
 * wallet's own token account for a wallet's trades. There are no venue
 * decoders here on purpose. Per-program decoding covers only the venues
 * someone wrote code for, and most volume on a busy token arrives through
 * routers and aggregators that no such decoder knows; balances are produced by
 * every venue equally, and a wallet's own balance cannot double-count a swap
 * that was routed through several pools.
 *
 * Costs about 500 credits for a 5,000-transaction token — a quarter of a cent —
 * because getTransactionsForAddress returns 1,000 FULL transactions per call at
 * 10 credits per 100, rather than one transaction per credit.
 */

/**
 * Signatures are cheap; transactions are not.
 *
 * getSignaturesForAddress returns 1,000 at a time for a credit, and gives the
 * time of each. Full transactions cost roughly ten times that and are the only
 * slow part — so the shape of this module is: page the signatures to learn what
 * happened when, then fetch only the transactions actually needed.
 */
/**
 * Candles per chart. The chart is built one window at a time, so this bounds
 * the work rather than the span: a 27-day token is drawn at two-hour bars.
 */
const MAX_BUCKETS = Number(process.env.HISTORY_MAX_BUCKETS ?? 400);
/** Shortest chart worth playing back, in candles. */
const MIN_CANDLES = Number(process.env.HISTORY_MIN_CANDLES ?? 60);

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Where the time went, when asked.
 *
 * A reconstruction is a dozen phases with very different costs and the
 * expensive one is not the one you would guess — reading the trader board's
 * nominees turned out to dwarf drawing the chart. Off unless HISTORY_DEBUG is
 * set, so it costs nothing in a normal request.
 */
const DEBUG = process.env.HISTORY_DEBUG === "1";
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!DEBUG) return run();
  const started = Date.now();
  try {
    return await run();
  } finally {
    console.log(`[history] ${name} ${Date.now() - started}ms`);
  }
}
/**
 * The same, for money.
 *
 * Reported unconditionally rather than behind HISTORY_DEBUG: what a request
 * cost is the one number the daily ceiling and the per-class limits are set
 * from, and it needs to be in the log of a deployment nobody is watching. The
 * per-kind breakdown is what makes a total explicable — 36,000 credits reads
 * as a mystery until it reads as 3,600 archive calls of two transactions each.
 */
async function priced<T>(
  label: string,
  run: () => Promise<T>,
  ceiling?: number,
): Promise<T> {
  /**
   * Reported and booked when the scope CLOSES, not when it returns.
   *
   * A build that spent forty thousand credits and then threw is the single
   * most important thing a daily ceiling needs to know about, and reporting on
   * the success path alone is how it would be the one thing never counted.
   *
   * Nested calls join the outer scope and settle nothing of their own, so a
   * board that internally rebuilds a chart reports one number rather than two
   * that have to be added up.
   */
  const { result } = await metered(
    label,
    run,
    (spend) => {
      // Attributed to the caller as well as the day, so a visitor replaying
      // indexed tokens is bounded by the same budget a builder is.
      void recordSpend(spend.credits, currentCaller());
      const kinds = Object.entries(spend.byKind)
        .map(([kind, k]) => `${kind} ${k.calls}×${k.credits}`)
        .join(", ");
      console.log(
        `[credits] ${label} ${spend.credits} credits over ${spend.calls} calls (${kinds})`,
      );
    },
    ceiling,
  );
  return result;
}
const PAGE = 1_000;

/**
 * Candle width for a span.
 *
 * 15s bars over six days is 34,000 candles nobody can read and a fetch nobody
 * wants to wait for. The width follows the span the way a chart's would.
 */
export function pickInterval(spanSec: number): number {
  if (spanSec <= 60 * 60) return 15;
  if (spanSec <= 6 * 60 * 60) return 60;
  if (spanSec <= 24 * 60 * 60) return 300;
  if (spanSec <= 4 * 24 * 60 * 60) return 900;
  if (spanSec <= 10 * 24 * 60 * 60) return 3_600;
  if (spanSec <= 30 * 24 * 60 * 60) return 7_200;
  /**
   * Past a month the ladder stops guessing and just keeps the bar count
   * readable. A year at four-hour bars is 2,190 candles — more than any chart
   * shows and more windows than any request should open.
   */
  let interval = 4 * 3_600;
  while (spanSec / interval > MAX_BUCKETS) interval *= 2;
  return interval;
}

export interface HistoryFill {
  ts: number;
  /**
   * Where it traded.
   *
   * A token lives on several books at once — its bonding curve, a PumpSwap
   * pool, one or more Raydium pools — and they do not hold the same price. Bars
   * built from whichever venue happened to be sampled jumped 20% between one
   * bucket's close and the next bucket's open A SECOND LATER, which is not a
   * market moving, it is two different books being read alternately.
   */
  venue: string;
  /**
   * Who traded, when the venue says so.
   *
   * Null on Raydium/Orca/Meteora fills, which carry no trader — the live path
   * does not attribute them either. The fee payer is NOT a substitute: MEASURED
   * on the live stream, it is the actual trader only 85% of the time, and the
   * rest are Telegram bots submitting for other people, which would collapse
   * thousands of traders into a handful of wallets and corrupt the leaderboard.
   * These fills still price the candles; they just do not name anyone.
   */
  wallet: string | null;
  isBuy: boolean;
  base: number;
  usd: number;
  priceUsd: number;
  /** "transfer" when tokens moved with no money against them. */
  kind?: "swap" | "transfer";
  /**
   * True when `priceUsd` is this fill's own execution price rather than the
   * chart's bar close. Reported per build so a board can say how much of it
   * was measured and how much was approximated.
   */
  exact?: boolean;
}

export interface TokenHistory {
  mint: string;
  candles: Candle[];
  /**
   * Circulating supply, so the client can show market cap instead of price.
   *
   * Sent rather than applied: the candles stay denominated in price, which is
   * what everything else here is measured in, and the conversion is one
   * multiplication wherever it is wanted.
   */
  supply: number;
  /** Candle width chosen for this span — 15s for a launch, 30m for a week. */
  interval: number;
  fills: number;
  /** What the token is called, when its metadata says. */
  name?: string;
  symbol?: string;
  image?: string;
  /** Trades read to nominate the board. Not the token's trade count. */
  transactions: number;
  /** Swaps on the charted book over its whole life, from the density map. */
  swaps?: number;
  /** The pool the chart was drawn from. */
  venue?: string;
  /** True when every swap in the window was read rather than sampled. */
  exact?: boolean;
  /** True when the named wallet has more history than was read. */
  partial?: boolean;
  /**
   * How much of the token this chart covers.
   *
   * On the wire because the client has to decide whether to ask for a trader
   * board at all — and a `window` chart has none, by construction. Without it
   * the page asks anyway, gets a 404, and renders two empty panels promising
   * rankings that were never going to exist.
   */
  coverage?: Coverage;
  /**
   * The stretch of this chart drawn at a finer bar width, when one was asked
   * for. Bars inside it are `zoom.interval` wide and the rest are `interval`,
   * in one series — so nothing may bucket by dividing a timestamp.
   */
  zoom?: { from: number; to: number; interval: number };
  /** The stretch a zoom section may be picked from. See `zoomFor`. */
  zoomable?: { from: number; to: number; interval: number };
  /** Every wallet in the replay, when more than the subject was asked for. */
  cluster?: string[];
  /** The named wallet's own identity, when Helius knows one. */
  walletName?: string;
  firstTs: number;
  lastTs: number;
}

/**
 * Who made and lost the most, answered separately from the chart.
 *
 * Split out because the two cost wildly different amounts and only one of them
 * is what the page is for. MEASURED on a 27-day token: drawing the chart took
 * 5.6 seconds, and ranking the traders took 81 — it reads a hundred and twenty
 * wallets' complete histories, which is 1.7GB of transactions and the only way
 * to put an honest number next to a wallet.
 *
 * Blocking the chart on that meant staring at nothing for a minute and a half
 * to see a chart that was ready in five seconds. Now the chart returns as soon
 * as it is drawn and the board arrives when it arrives.
 */
export interface TraderBoard {
  top: PnlRow[];
  bottom: PnlRow[];
  wallets: number;
  /** True when a wallet that traded the token was left unread. */
  truncated: boolean;
  /** When the ranked wallets were last read, unix seconds. */
  builtAt: number;
  /** The mark every open position is valued at. */
  price: number;
}

/**
 * What an update needs to carry on from.
 *
 * Kept beside the board rather than inside it because it is machinery, not
 * something the page reads: the candidate list so an update ranks the same
 * wallets, the books so average-cost accounting does not have to be replayed
 * from the beginning, and the cutoff so only new transactions are read.
 */
interface BoardState {
  candidates: string[];
  positions: Record<string, StoredPosition>;
  considered: number;
  lastTs: number;
  /** Wallets that must be ranked whatever nomination thinks. */
  pinned?: string[];
  /**
   * Names already looked up, kept so a read costs nothing.
   *
   * An address's identity does not change, and the lookup is a REST round trip
   * — paying it on every board read would have made re-marking, which is
   * otherwise 0.4 seconds, the slowest thing on the page.
   */
  names?: Record<string, { name?: string; category?: string; type?: string }>;
  /**
   * Which vintage of `names` this is.
   *
   * A wallet recorded here is never asked about again — "Helius had no name"
   * is stored as `{}` and that answer is permanent, not one that ages out. So
   * when the lookup learns to name more wallets, the boards already built are
   * exactly the ones that would never find out. Bumping this re-asks once.
   */
  namesV?: number;
}

/**
 * Comparison filters, exactly as the method documents them.
 *
 * `{ gte, lt }`, not `{ from, to }` — the wrong shape is rejected wholesale
 * with "expected end of params", which reads like the feature is unsupported.
 * It cost a detour through a third-party index before I read the spec properly.
 */
export interface ArchiveFilters {
  blockTime?: { gte?: number; lt?: number; lte?: number; gt?: number };
  tokenTransfer?: {
    mint?: string;
    with?: string;
    direction?: "in" | "out" | "any";
    /** Raw base units, not UI amount. Finds whales in one request. */
    amount?: { gt?: number; gte?: number; lt?: number; lte?: number };
  };
  status?: "succeeded" | "failed" | "any";
}

async function archive(
  address: string,
  paginationToken?: string,
  sortOrder: "asc" | "desc" = "asc",
  filters?: ArchiveFilters,
  limit = PAGE,
  /** "signatures" costs ten credits flat and a fraction of the bytes. */
  transactionDetails: "full" | "signatures" = "full",
): Promise<{ data: unknown[]; paginationToken?: string } | null> {
  try {
    await take();
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "history",
        method: "getTransactionsForAddress",
        // POSITIONAL params. The documented object form is rejected outright.
        params: [
          address,
          {
            transactionDetails,
            sortOrder,
            limit,
            maxSupportedTransactionVersion: 0,
            ...(filters ? { filters } : {}),
            ...(paginationToken ? { paginationToken } : {}),
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { data: unknown[]; paginationToken?: string } };
    const result = body.result ?? null;
    // Charged on what came BACK, because that is how the endpoint bills: a
    // signatures page is flat, and a full page is per hundred rows returned.
    // A failed response is free, so nothing is charged above.
    charge(
      transactionDetails === "signatures"
        ? { kind: "signatures" }
        : { kind: "archive", returned: result?.data?.length ?? 0 },
    );
    return result;
  } catch {
    return null;
  }
}

/**
 * An archival transaction, in the shape the stream decoders expect.
 *
 * Two differences, both silent if missed. `meta` sits BESIDE `transaction`
 * rather than inside it, and loaded addresses live under
 * `meta.loadedAddresses.{writable,readonly}`.
 *
 * The third is the one that actually costs you: JSON-RPC encodes instruction
 * data as BASE58, while the stream sends raw bytes and `toBuffer` treats every
 * string as base64. Left alone, every anchor event decodes to noise and the
 * token looks like it barely traded — MEASURED, 5 fills found in 1,000
 * transactions instead of several hundred.
 */
function adapt(raw: unknown): NormalizedTx | null {
  const t = raw as {
    transaction?: { message?: { instructions?: unknown[] }; signatures?: string[] };
    meta?: Record<string, unknown>;
    slot?: number;
    blockTime?: number;
  };
  if (!t?.transaction || !t.meta) return null;

  const loaded = (t.meta.loadedAddresses ?? {}) as { writable?: string[]; readonly?: string[] };
  const inner = (t.meta.innerInstructions ?? []) as {
    index: number;
    instructions: { programIdIndex: number; data: string; stackHeight?: number }[];
  }[];

  return normalizeTx({
    transaction: {
      transaction: t.transaction,
      meta: {
        ...t.meta,
        loadedWritableAddresses: loaded.writable ?? [],
        loadedReadonlyAddresses: loaded.readonly ?? [],
        innerInstructions: inner.map((g) => ({
          index: g.index,
          instructions: g.instructions.map((ix) => ({
            ...ix,
            data: decodeBase58(ix.data),
          })),
        })),
      },
      signature: t.transaction.signatures?.[0],
    },
    slot: t.slot,
    blockTime: t.blockTime,
  });
}

/**
 * One wallet's own balance change for one mint in one transaction.
 *
 * The only thing that decides a position's SIZE, and it needs nothing from the
 * network — which is what lets `stillOpen` ask whether a wallet is still in a
 * token before the chart it would be priced against has been drawn.
 */
function baseDelta(tx: NormalizedTx, mint: string, wallet: string): number {
  let base = 0;
  for (const after of tx.postTokenBalances) {
    if (after.owner !== wallet || after.mint !== mint) continue;
    const before = tx.preTokenBalances.find(
      (b) => b.accountIndex === after.accountIndex,
    );
    base +=
      Number(after.amountRaw - (before?.amountRaw ?? 0n)) / 10 ** after.decimals;
  }
  /**
   * An account present before and absent after was CLOSED, which is how a
   * wallet exits a position entirely. Left out, the final sell vanishes and
   * the wallet looks like it is still holding.
   */
  for (const before of tx.preTokenBalances) {
    if (before.owner !== wallet || before.mint !== mint) continue;
    const survives = tx.postTokenBalances.some(
      (a) => a.accountIndex === before.accountIndex,
    );
    if (!survives) base -= Number(before.amountRaw) / 10 ** before.decimals;
  }
  return base;
}

/**
 * How much of what a wallet ever took on it must still hold for the position
 * to count as OPEN.
 *
 * A ratio rather than "any tokens at all", because the two failure modes point
 * opposite ways. A wallet that still holds its position has a story that runs
 * to today, and ending its replay at its last trade prices a live position at
 * a dead price. A wallet left with the dust of a closed position does not —
 * and stretching its replay to now would drag a ten-minute clip across every
 * month since for a mark worth pennies.
 *
 * One percent, because that is the level at which the mark stops mattering:
 * below it the stale price cannot move the total by more than the noise
 * already in it, so there is nothing to fix and no reason to pay for the bars.
 */
const OPEN_RATIO = Number(process.env.HISTORY_OPEN_RATIO ?? 0.01);

/** See `OPEN_RATIO`. `everHeld` is everything that ever arrived. */
function stillOpen(held: number, everHeld: number): boolean {
  return everHeld > 0 && held / everHeld > OPEN_RATIO;
}

/**
 * One wallet's fills, from its own balance sheet, one per transaction.
 *
 * The wallet's token delta is the size. It cannot double-count, because there
 * is only one balance, and it gives an invariant nothing else here has:
 * summed over a wallet's whole history it must equal what that wallet holds
 * now. MEASURED against the chain on this token's largest holder, exact to the
 * token, where running the venue decoders over the same history gave 2.2x — a
 * routed swap touches several pools and they emit a fill for each leg.
 *
 * A fill counts as a TRADE when the tokens came from, or went to, a pool.
 * Two cheaper tests were wrong in opposite directions and both are worth
 * remembering:
 *
 *   the wallet's own SOL moved
 *     Misses real buyers. MEASURED on `498g1rVn`: 42 of its 59 transactions
 *     route through Jupiter, PumpSwap or Meteora and buy 5.77M tokens, and in
 *     every one the wallet's SOL delta is zero or POSITIVE — it is not the fee
 *     payer, so the money leaves an account it does not own. Judged this way
 *     its entire position read as a gift.
 *
 *   the transaction invoked some non-plumbing program
 *     Catches transfers into programs. MEASURED on `HDixbrzww`: of four
 *     "sells", one really did send 1.2M tokens to the PumpSwap pool and three
 *     sent 3.7M into a lock program — booked as sales they inflated its
 *     proceeds sevenfold.
 *
 * Whether the counterparty is a pool is exactly the question, and one batched
 * `getMultipleAccounts` over the handful of counterparties a wallet ever has
 * answers it: a person's account is System-owned, a vault's is not.
 *
 * The PRICE comes from the COUNTERPARTY POOL's quote leg in the same
 * transaction — see `execPrice`. Not from the wallet's own SOL delta, for the
 * reason the first test above failed: the payer is often not the holder. And
 * not from the chart, which was the old answer and the single biggest source
 * of wrong PnL in this app.
 *
 * MEASURED, and this is why it matters: the board prices fills from a series
 * built at `pickInterval(life)`, which for a token a year old is a bar 2.67
 * DAYS wide — 21.3 days at the widest. `priceLookup` returns that bar's close
 * for every fill inside it. MELANIA's first bar spans $3.85 to $12.21 and
 * closes at $4.3833, so every trade of its entire launch — where all of the
 * money was made and lost — was booked at one price, and four of the five
 * largest traders came out at EXACTLY $0 with avgBuy equal to avgSell.
 *
 * The pool's own quote delta is the real execution price, slippage included,
 * and it is already sitting in the transaction we fetched. It costs nothing.
 * The chart price stays as the fallback for a fill whose quote leg cannot be
 * resolved, which is where this used to start.
 */
async function walletFills(
  txs: NormalizedTx[],
  mint: string,
  wallet: string,
  priceAt: (ts: number) => number,
  sol: SolPriceHistory,
): Promise<HistoryFill[]> {
  interface Move {
    ts: number;
    base: number;
    counterparties: string[];
    /** Execution price from the pool's quote leg, or 0 when unresolvable. */
    exec: number;
    /**
     * Whether ANY money moved in the transaction, however it was routed.
     *
     * Weaker than `exec` and deliberately so: it is what separates "a real
     * swap whose quote leg we could not attribute" — which still deserves the
     * chart's price — from "no money changed hands here at all", which is a
     * transfer whatever program carried it.
     */
    quoteMoved: boolean;
  }

  const moves: Move[] = [];
  const seen = new Set<string>();

  for (const tx of txs) {
    const ts = tx.blockTime ?? 0;
    if (ts <= 0 || tx.failed) continue;
    // Pagination can overlap; a transaction counted twice is a position twice
    // the size it should be.
    if (seen.has(tx.signature)) continue;
    seen.add(tx.signature);

    const base = baseDelta(tx, mint, wallet);
    if (base === 0) continue;

    // Whoever moved the mint the other way. A buy's counterparty gave tokens
    // up; a sell's took them on.
    const counterparties: string[] = [];
    /**
     * How much of the mint the POOLS moved, which is the denominator the
     * execution price needs — not this wallet's share of it.
     *
     * MEASURED, and this is the whole reason it is tracked separately:
     * `8WiUx5Ah` takes 0.02 to 1.4 TRUMP out of transactions whose pool leg is
     * thousands of dollars, because the transaction carries a far larger trade
     * than this wallet's cut of it. Dividing the pool's quote movement by the
     * WALLET's base priced 1,739 of its 1,795 fills over $1,000 a token, on a
     * token that peaked near $75, and put it on the board at -$14.9m.
     */
    let poolBase = 0;
    for (const after of tx.postTokenBalances) {
      if (after.mint !== mint || after.owner === wallet || !after.owner) continue;
      const before = tx.preTokenBalances.find(
        (b) => b.accountIndex === after.accountIndex,
      );
      const delta = after.amountRaw - (before?.amountRaw ?? 0n);
      if (delta === 0n) continue;
      if (base > 0 ? delta < 0n : delta > 0n) {
        counterparties.push(after.owner);
        if (isProgramDerived(after.owner)) {
          poolBase += Number(delta) / 10 ** after.decimals;
        }
      }
    }
    // Scoped to the pools that took the other side of THIS mint, so a routed
    // swap's later hops — which never touch the mint — cannot be read as part
    // of what was paid for it.
    const books = programOwned(counterparties);
    moves.push({
      ts,
      base,
      counterparties,
      exec:
        books.size > 0 && poolBase !== 0 ? execPrice(tx, poolBase, books, sol) : 0,
      quoteMoved: quoteMoved(tx),
    });
  }

  const pools = programOwned(moves.flatMap((m) => m.counterparties));

  const fills: HistoryFill[] = [];
  for (const move of moves) {
    /**
     * A pool on the other side is NOT enough. Money has to have moved.
     *
     * `isProgramDerived` says "not a person", which is true of a pool and
     * equally true of a Squads multisig, a Meteora DLMM position, an escrow
     * and a vesting contract. Treating all of them as trades, and then pricing
     * the ones with no quote leg off the chart, invents money that never
     * changed hands.
     *
     * MEASURED on TRUMP's top-ranked wallet, `2Fe47zbh`: 67 of its 68 "swaps"
     * had no quote leg at all. Two of them were 25,000,000 and 27,000,000
     * tokens arriving from a Squads multisig — round numbers, a treasury
     * distribution — and the chart priced them at $17.67 for $919m of
     * fabricated buying. The rest were liquidity going into a DLMM position,
     * booked as sales. The wallet had never traded, and it was first on the
     * board at +$66m.
     */
    const traded =
      move.counterparties.some((owner) => pools.has(owner)) &&
      (move.exec > 0 || move.quoteMoved);
    // The fill's own execution price where the quote leg resolved, and the
    // chart's bar close only where money demonstrably moved but could not be
    // attributed to the pool.
    const price = move.exec > 0 ? move.exec : priceAt(move.ts);
    const baseAbs = Math.abs(move.base);
    /**
     * Transfers carry a MARK as well, which they did not used to.
     *
     * Tokens leaving the wallet are booked as an exit at the prevailing price
     * — see the transfer branch of `PositionBook.apply`. That needs a price,
     * and the chart is the only one available, because a transfer has no quote
     * leg by construction.
     *
     * Tokens arriving still create no basis: `apply` ignores this figure on
     * the way in, deliberately, so that being handed tokens can never look
     * like having bought them.
     */
    fills.push({
      ts: move.ts,
      venue: traded ? "pool" : "transfer",
      wallet,
      isBuy: move.base > 0,
      base: baseAbs,
      usd: baseAbs * price,
      priceUsd: price,
      kind: traded ? "swap" : "transfer",
      exact: move.exec > 0,
    });
  }

  fills.sort((a, b) => a.ts - b.ts);
  return fills;
}

/**
 * Whether any quote asset changed hands anywhere in this transaction.
 *
 * Scoped to the whole transaction rather than to the pools, because that is
 * the question: a swap routed somewhere we did not resolve still moved SOL or
 * a stablecoin SOMEWHERE, and a treasury distribution or a liquidity deposit
 * moves none at all. Native lamports count — a bonding curve's quote leg is
 * never a token balance — but only where they move by more than a transaction
 * fee, since every signer's lamports change on every transaction.
 */
const MAX_FEE_LAMPORTS = 100_000_000;

function quoteMoved(tx: NormalizedTx): boolean {
  for (const after of tx.postTokenBalances) {
    if (!QUOTE_MINTS.has(after.mint)) continue;
    const before = tx.preTokenBalances.find(
      (b) => b.accountIndex === after.accountIndex,
    );
    if (after.amountRaw !== (before?.amountRaw ?? 0n)) return true;
  }
  for (const before of tx.preTokenBalances) {
    if (!QUOTE_MINTS.has(before.mint)) continue;
    const survives = tx.postTokenBalances.some(
      (a) => a.accountIndex === before.accountIndex,
    );
    if (!survives && before.amountRaw !== 0n) return true;
  }
  for (let i = 0; i < tx.preBalances.length; i += 1) {
    const delta = (tx.postBalances[i] ?? 0n) - (tx.preBalances[i] ?? 0n);
    const size = delta < 0n ? -delta : delta;
    if (size > BigInt(MAX_FEE_LAMPORTS)) return true;
  }
  return false;
}

/**
 * What the pool actually paid or received, in dollars, for this fill.
 *
 * `priceSwap` answers the same question for the CHART, and cannot be reused
 * here: it is pinned to one venue's resolved `baseVault`/`quoteVault`, and a
 * wallet trades wherever it likes. This works from ownership instead, so it
 * prices a fill on a pool nothing has ever discovered.
 *
 * Only the pools that moved THIS mint are looked at, which is what keeps a
 * multi-hop route honest: a TRUMP→SOL→USDC swap has a second pool trading SOL
 * for USDC, and counting its leg would double the money attributed to the
 * TRUMP trade. That pool holds no TRUMP, so it is not in `books`.
 *
 * Returns 0 rather than guessing. The caller falls back to the chart, so an
 * unresolvable fill is priced no worse than it was before this existed.
 */
function execPrice(
  tx: NormalizedTx,
  /** The POOLS' own base movement, not the wallet's. See `poolBase`. */
  poolBase: number,
  books: Set<string>,
  sol: SolPriceHistory,
): number {
  const ts = tx.blockTime ?? 0;
  if (ts <= 0) return 0;
  const solUsd = sol.at(ts);
  let quoteUsd = 0;

  const rate = (quoteMint: string): number =>
    quoteMint === WSOL_MINT ? solUsd : QUOTE_MINTS.has(quoteMint) ? 1 : 0;

  for (const after of tx.postTokenBalances) {
    if (!books.has(after.owner) || !QUOTE_MINTS.has(after.mint)) continue;
    const before = tx.preTokenBalances.find(
      (b) => b.accountIndex === after.accountIndex,
    );
    const delta =
      Number(after.amountRaw - (before?.amountRaw ?? 0n)) / 10 ** after.decimals;
    quoteUsd += delta * rate(after.mint);
  }
  /**
   * A vault emptied and closed in the same transaction has no post balance, so
   * the loop above cannot see the money leave. Same shape as the base leg's
   * closed-account case, and the same consequence if it is missed: the sell
   * that took the wallet out prices at nothing.
   */
  for (const before of tx.preTokenBalances) {
    if (!books.has(before.owner) || !QUOTE_MINTS.has(before.mint)) continue;
    const survives = tx.postTokenBalances.some(
      (a) => a.accountIndex === before.accountIndex,
    );
    if (survives) continue;
    quoteUsd -= (Number(before.amountRaw) / 10 ** before.decimals) * rate(before.mint);
  }

  /**
   * A bonding curve holds lamports on the pool account itself rather than in a
   * wrapped-SOL account, so its quote leg is not a token balance at all. This
   * is every pump.fun token before it graduates.
   */
  if (quoteUsd === 0 && solUsd > 0) {
    for (const book of books) {
      const i = tx.accountKeys.indexOf(book);
      if (i < 0) continue;
      const delta =
        Number((tx.postBalances[i] ?? 0n) - (tx.preBalances[i] ?? 0n)) / 1e9;
      quoteUsd += delta * solUsd;
    }
  }

  if (quoteUsd === 0) return 0;
  /**
   * A pool's two legs must move OPPOSITE ways: it gives up the token and takes
   * in the quote, or the reverse. Both moving the same way is a liquidity
   * deposit or withdrawal, which has no execution price and must not be booked
   * as one.
   */
  if (Math.sign(quoteUsd) === Math.sign(poolBase)) return 0;
  return Math.abs(quoteUsd) / Math.abs(poolBase);
}

/**
 * The token's price at a moment, from the bars already drawn.
 *
 * Bars are regular, so the bucket is arithmetic rather than a search. Before
 * the first bar and after the last, the nearest one stands — a wallet that
 * traded in a gap the chart does not cover is better priced approximately than
 * not at all.
 */
/**
 * Several bars folded into one, for the part-bar at either edge of a section.
 *
 * Open from the first, close from the last, extremes and totals across all of
 * them — a wider bar of the same trades. Returned as an array so the caller
 * can splice it in whether or not there was anything to fold: an edge that
 * lands exactly on a coarse boundary has no stub, and no bar should appear.
 */
function stub(bars: Candle[], t: number): Candle[] {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last) return [];
  return [
    {
      t,
      o: first.o,
      h: Math.max(...bars.map((b) => b.h)),
      l: Math.min(...bars.map((b) => b.l)),
      c: last.c,
      v: bars.reduce((n, b) => n + b.v, 0),
      vb: bars.reduce((n, b) => n + b.vb, 0),
      n: bars.reduce((n, b) => n + b.n, 0),
    },
  ];
}

function priceLookup(candles: Candle[]): (ts: number) => number {
  if (candles.length === 0) return () => 0;
  const first = candles[0] as Candle;
  const last = candles[candles.length - 1] as Candle;

  return (ts: number) => {
    if (ts <= first.t) return first.o;
    if (ts >= last.t) return last.c;
    /**
     * The bar is FOUND, not computed.
     *
     * `Math.floor(ts / interval)` assumes every bar is the same width, which
     * stops being true the moment a finer section is spliced in: a fill inside
     * the fine stretch would be asked for a two-hour bucket that holds no bar,
     * miss, fall through to the series' last close, and book a trade from
     * Tuesday at Friday's price. Searching the times that are actually there
     * is right for both shapes.
     */
    let lo = 0;
    let hi = candles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((candles[mid] as Candle).t <= ts) lo = mid;
      else hi = mid - 1;
    }
    return (candles[lo] as Candle).c;
  };
}

function decodeBase58(value: string): Buffer {
  try {
    return Buffer.from(bs58.decode(value));
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Everything the wallet did on this token, from the WALLET's own history.
 *
 * A wallet has a few hundred transactions; a busy token has tens of thousands
 * every few minutes. MEASURED on the pair that exposed this: 463 transactions
 * for the wallet, 46 of them on the mint, against a token doing 20,000 in three
 * minutes — its trades from six days ago were unreachable from either end of
 * the token's own history, at any cap.
 *
 * So the wallet's trades come from here, exactly and cheaply, and the token's
 * history is only read for the window they span.
 */
/**
 * Pages of a wallet's history on one mint.
 *
 * MEASURED, a wallet the board nominates on this token holds 9,813 mint
 * transactions — so six pages truncated it, and a truncated wallet does not
 * give a slightly wrong PnL, it gives a fabricated one: the buys are read and
 * the sells that paid for them are not. Twelve pages covers every candidate
 * seen, and anything past it is reported rather than quietly cut.
 */
const WALLET_PAGES = Number(process.env.HISTORY_WALLET_PAGES ?? 12);

async function walletActivity(
  mint: string,
  wallet: string,
  /** Only transactions at or after this time. Used to update a stored book. */
  since = 0,
  /**
   * Pages of full transactions this read may spend.
   *
   * Lower for a visitor than for the owner. Twelve pages is twelve thousand
   * transactions and some sixty megabytes, which is fine for a machine
   * indexing one token on purpose and is not something an anonymous request
   * should be able to ask for repeatedly.
   */
  maxPages = WALLET_PAGES,
): Promise<{
  txs: NormalizedTx[];
  first: number;
  last: number;
  anchor?: string;
  /** True when the wallet has more history than was read. */
  truncated: boolean;
}> {
  const txs: NormalizedTx[] = [];
  let token: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    /**
     * Asked for by mint, not filtered afterwards.
     *
     * `tokenTransfer.mint` returns only the wallet's transactions that moved
     * this token — MEASURED, 45 rows in one call against 463 transactions read
     * and sifted before.
     */
    /**
     * Successful transactions only, filtered UPSTREAM.
     *
     * `walletActivity` already threw failures away after decoding them, which
     * is not the same thing as not paying for them. MEASURED on a bot that the
     * trader board nominates: 6,000 transactions returned on this mint, 5,941
     * of them failed — a hundredfold in transferred bytes for 59 usable rows,
     * and the board reads a hundred and twenty wallets like it.
     */
    const res = await archive(wallet, token, "asc", {
      ...tradeFilter(mint),
      ...(since > 0 ? { blockTime: { gte: since } } : {}),
    });
    if (!res || res.data.length === 0) break;
    for (const raw of res.data) {
      const tx = adapt(raw);
      if (tx && !tx.failed) txs.push(tx);
    }
    token = res.paginationToken;
    if (!token) break;
  }

  txs.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  return {
    txs,
    first: txs[0]?.blockTime ?? 0,
    last: txs[txs.length - 1]?.blockTime ?? 0,
    anchor: txs[txs.length - 1]?.signature,
    truncated: Boolean(token),
  };
}



/** Circulating supply in whole tokens, for market cap. One standard RPC call. */
async function tokenSupply(mint: string): Promise<number> {
  const res = await rpc<{ value?: { amount?: string; decimals?: number } }>(
    "getTokenSupply",
    [mint],
  );
  const amount = Number(res?.value?.amount ?? 0);
  const decimals = res?.value?.decimals ?? 6;
  return amount > 0 ? amount / 10 ** decimals : 0;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    await take();
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "history", method, params }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: T };
    charge({ kind: "rpc" });
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * The book this token is charted from, looked up once per mint.
 *
 * Discovery is a handful of RPC calls and the answer barely changes — a pool
 * that is the busiest today was the busiest an hour ago — so it is worth
 * holding on to across requests about the same token.
 */
const venues = new Map<string, { at: number; venue: Venue | null }>();
/** A pool that was the busiest yesterday still is. A day is safe and useful. */
const VENUE_TTL = Number(process.env.HISTORY_VENUE_TTL ?? 24 * 3_600);

async function venueFor(mint: string): Promise<Venue | null> {
  const hit = venues.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.venue;

  const key = `venue:${mint}`;
  const stored = await loadBlob<{ at: number; venue: Venue }>(key);
  if (stored && nowSec() - stored.at < VENUE_TTL) {
    venues.set(mint, { at: Date.now(), venue: stored.venue });
    return stored.venue;
  }

  const venue = await pickVenue(mint);
  venues.set(mint, { at: Date.now(), venue });
  if (venue) await saveBlob(key, { at: nowSec(), venue });
  return venue;
}

/**
 * When this book first and last traded.
 *
 * Asked of the POOL rather than the mint, and with the trade filter on. The
 * mint's own first transaction is its creation and its last is as likely to be
 * an unrelated bot as a trade, so a span measured that way starts before there
 * was a price and ends after there stopped being one.
 */
async function poolLifespan(
  venue: Venue,
  mint: string,
): Promise<{ first: number; last: number } | null> {
  const filters = tradeFilter(mint);
  const [oldest, newest] = await Promise.all([
    archive(venue.pool, undefined, "asc", filters, 1),
    archive(venue.pool, undefined, "desc", filters, 1),
  ]);
  const first = adapt(oldest?.data?.[0])?.blockTime ?? 0;
  const last = adapt(newest?.data?.[0])?.blockTime ?? 0;
  return first > 0 && last >= first ? { first, last } : null;
}

/**
 * Candles for a window, served from the cache wherever it can be.
 *
 * A token's past does not move. Only the newest bar can still change — it was
 * built while its own interval was open — so a second look at the same token
 * refetches that one bar and reads the rest. The first build of a three-week
 * token is the expensive one; every one after it is not.
 */
async function series(
  venue: Venue,
  mint: string,
  from: number,
  to: number,
  interval: number,
  sol: SolPriceHistory,
): Promise<{ candles: Candle[]; exact: boolean }> {
  const cached = await loadSeries(mint, interval);
  const gaps = missingRanges(cached, from, to, interval);

  /**
   * SOL prices for the gaps only, not for the span.
   *
   * A cached three-week token needs one bar rebuilt; fetching three weeks of
   * minute-by-minute SOL to price it was a second of every warm request. The
   * loader remembers what it already holds, so callers that need the whole
   * span still ask for it plainly.
   */
  for (const gap of gaps) await sol.load(gap.from, Math.min(gap.to, nowSec()));
  if (DEBUG) {
    const bars = gaps.reduce((n, g) => n + (g.to - g.from) / interval, 0);
    const span = Math.round((to - from) / interval);
    console.log(`[history] gaps ${gaps.length} covering ${bars} of ${span} bars`);
  }

  let exact = cached?.exact ?? true;
  let stored: Candle[] = cached?.candles ?? [];
  const fresh: Candle[] = [];
  /** Bars to return but not store, when a window could not be read whole. */
  let drew: Candle[] = [];
  for (const gap of gaps) {
    checkBudget();
    /**
     * A density map for the gap, sized to the gap.
     *
     * Built here rather than handed in, because only the caller that needs the
     * WHOLE token mapped should pay for the whole map. A warm request is
     * usually one or two bars behind, and probing forty points across a month
     * to plan two bars was the single largest fixed cost left on that path.
     */
    const bars = Math.ceil((gap.to - gap.from) / interval);
    const density = await densityMap(
      venue.pool,
      mint,
      gap.from,
      Math.min(gap.to, nowSec()),
      Math.max(2, Math.min(bars, 40)),
    );
    /**
     * The last price known BEFORE this gap, handed to the builder.
     *
     * A gap that turns out to hold no trades produces no bars without it, so
     * the gap survives the rebuild and is refetched for ever — which is how
     * five contiguous days of one-minute bars came back as six ranges split by
     * single quiet minutes.
     */
    const seed =
      [...stored].reverse().find((c) => c.t < gap.from)?.c ?? 0;
    const built = await buildCandles(
      venue,
      mint,
      gap.from,
      Math.min(gap.to, nowSec()),
      interval,
      sol,
      density,
      seed,
    );
    if (!built.exact) exact = false;
    /**
     * Bars the builder could not read are drawn but NOT kept.
     *
     * A transient failure looks exactly like a quiet market once it is in the
     * cache — a flat bar at the last price — and the cache only ever refetches
     * the newest bar, so it would be served for ever. Leaving them out means
     * `missingRanges` sees a gap next time and tries again.
     */
    const unresolved = new Set(built.suspect);
    const keep = built.candles.filter((c) => !unresolved.has(c.t));
    fresh.push(...keep);
    if (unresolved.size > 0) drew = built.candles;

    /**
     * Saved per GAP, not once at the end.
     *
     * A build that is abandoned part-way — the tab closed, the function timed
     * out — used to throw away every bar it had already paid for, and the next
     * attempt read all of them again. The gaps are independent and each one is
     * a complete, correct set of bars the moment it lands, so there is nothing
     * to be gained by holding them.
     *
     * `exact` stays conservative and only ever moves downward: one sampled
     * range makes the whole stored series sampled until it is rebuilt. So a
     * partial save carries the honest value for the bars actually written, and
     * a later gap can only lower it.
     */
    if (keep.length > 0) {
      stored = mergeCandles(stored, keep);
      await saveSeries({ mint, interval, venue, candles: stored, exact, builtAt: nowSec() });
    }
  }

  const merged = mergeCandles(cached?.candles ?? [], fresh);

  const start = Math.floor(from / interval) * interval;
  // Anything unresolved is shown from this build even though it was not kept.
  const shown = mergeCandles(merged, drew);
  return { candles: shown.filter((c) => c.t >= start && c.t < to), exact };
}

/**
 * Wallets worth reading in full, from a sample of real trades.
 *
 * Kept separate from the candles so that a cached chart does not cost the board
 * its candidates. Forty windows spread across the token's life, twenty-five
 * trades each: a thousand actual fills, which is enough to name the wallets
 * that moved size and cheap enough not to matter.
 *
 * The sample is used ONLY to nominate. Every number the board shows comes from
 * reading that wallet's own history — see `exactBoard`.
 */
const NOMINATION_WINDOWS = Number(process.env.HISTORY_NOMINATION_WINDOWS ?? 60);
const NOMINATION_PER_WINDOW = Number(process.env.HISTORY_NOMINATION_PER ?? 25);

/**
 * Pools sampled for candidates, not just the one the chart is drawn from.
 *
 * A token's liquidity is spread — Catecoin trades on a PumpSwap pool and some
 * twenty-nine Meteora ones — and a trader who worked a secondary pool never
 * appeared in a sample taken from the busiest. The chart still comes from one
 * book, because interleaving prices from books that disagree is not a chart;
 * the BOARD has no such constraint and should see everyone.
 */
const NOMINATION_POOLS = Number(process.env.HISTORY_NOMINATION_POOLS ?? 8);

async function nominees(
  venue: Venue,
  mint: string,
  first: number,
  last: number,
  pools: string[],
  sol: SolPriceHistory,
): Promise<Swap[]> {
  // The charted book first, then the next largest, deduped.
  const books = [venue.pool, ...pools.filter((p) => p !== venue.pool)].slice(
    0,
    NOMINATION_POOLS,
  );
  // The window budget is shared out, so adding pools widens coverage rather
  // than multiplying the request count.
  const perPool = Math.max(4, Math.floor(NOMINATION_WINDOWS / books.length));
  const step = Math.max(1, Math.floor((last - first) / perPool));

  const pages = await Promise.all(
    books.flatMap((book) =>
      Array.from({ length: perPool }, (_, i) =>
        archive(
          book,
          undefined,
          "asc",
          { ...tradeFilter(mint), blockTime: { gte: first + i * step, lt: first + (i + 1) * step } },
          NOMINATION_PER_WINDOW,
        ),
      ),
    ),
  );

  /**
   * Priced against the charted venue's vaults where it can be, and otherwise
   * counted for its size alone.
   *
   * A nomination only needs to know WHO traded and roughly how much — every
   * number on the board comes from reading that wallet in full afterwards. So
   * a swap on a pool whose vaults are not resolved still nominates its trader,
   * using the tokens that moved rather than a price we cannot compute.
   */
  const swaps: Swap[] = [];
  for (const page of pages) {
    for (const raw of page?.data ?? []) {
      const priced = priceSwap(raw as never, venue, mint, sol);
      if (priced) {
        swaps.push(priced);
        continue;
      }
      const nominated = nominateFromBalances(raw as never, mint);
      if (nominated) swaps.push(nominated);
    }
  }
  return swaps;
}

/**
 * A trader and a size, from a transaction on a pool we have not resolved.
 *
 * Deliberately crude: `usd` here is a RANKING WEIGHT, not money. It is the
 * tokens that moved, which orders candidates within a pool correctly and is
 * never shown to anyone — `exactBoard` reads every nominee's real history.
 */
function nominateFromBalances(raw: RawTx, mint: string): Swap | null {
  const keys = accountKeys(raw);
  const pre = raw.meta?.preTokenBalances ?? [];
  const post = raw.meta?.postTokenBalances ?? [];
  const signerCount = raw.transaction?.message?.header?.numRequiredSignatures ?? 1;
  const signers = new Set(keys.slice(0, signerCount));

  let best: { owner: string; delta: number } | null = null;
  for (const after of post) {
    if (after.mint !== mint || !after.owner || !signers.has(after.owner)) continue;
    const before = pre.find((b) => b.accountIndex === after.accountIndex);
    const delta =
      (Number(after.uiTokenAmount.amount) -
        Number(before?.uiTokenAmount.amount ?? 0)) /
      10 ** after.uiTokenAmount.decimals;
    if (delta === 0) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { owner: after.owner, delta };
    }
  }
  if (!best) return null;

  return {
    ts: raw.blockTime ?? 0,
    priceUsd: 0,
    base: Math.abs(best.delta),
    usd: Math.abs(best.delta),
    isBuy: best.delta > 0,
    wallet: best.owner,
  };
}

/**
 * The biggest trades on the book, whenever they happened.
 *
 * The third nomination source, and the one that finds LOSERS. The other two
 * are structurally blind to them: a holder list ranks by what a wallet still
 * has, and someone who bought the top and dumped has nothing; a trade sample
 * ranks by how often a wallet appears in ~1,500 trades out of 1.8 million, and
 * a whale who bought $500,000 in three transactions has almost no chance of
 * appearing at all. Between them the board found 5 losers among 141 wallets,
 * which says more about who was nominated than about who lost money.
 *
 * `tokenTransfer.amount` asks the index for big trades directly. The threshold
 * has to be denominated in DOLLARS and converted per window, not fixed in
 * tokens: MEASURED, `>= 5,000,000 tokens` matches 193 transactions and every
 * one of them is inside the first two and a half hours, because $50 bought
 * five million tokens at launch and buys six hundred now. The bar's own close
 * does the conversion.
 */
/**
 * Raised from $5,000, which was not selective enough to matter. Each window
 * returns its most RECENT qualifying trades, not its biggest, so a threshold
 * that lets thousands of trades qualify hands back a recency sample of them.
 * MEASURED: a wallet that sold 2.77M tokens in one go — six figures — never
 * appeared, while $5,000 fills did.
 */
const BIG_TRADE_USD = Number(process.env.HISTORY_BIG_TRADE_USD ?? 25_000);
const BIG_TRADE_WINDOWS = Number(process.env.HISTORY_BIG_TRADE_WINDOWS ?? 60);

async function bigTrades(
  venue: Venue,
  mint: string,
  candles: Candle[],
  pools: string[],
  sol: SolPriceHistory,
): Promise<Swap[]> {
  if (candles.length === 0) return [];
  const books = [venue.pool, ...pools.filter((p) => p !== venue.pool)].slice(
    0,
    NOMINATION_POOLS,
  );
  const step = Math.max(1, Math.floor(candles.length / BIG_TRADE_WINDOWS));

  const windows: { from: number; to: number; price: number }[] = [];
  for (let i = 0; i < candles.length; i += step) {
    const slice = candles.slice(i, i + step);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!first || !last) continue;
    // The highest close in the window, so the threshold is not set by a dip
    // and then flooded by everything around it.
    const price = Math.max(...slice.map((c) => c.c));
    if (price > 0) windows.push({ from: first.t, to: last.t + step, price });
  }

  /**
   * Across every pool, because an exit does not have to happen on the busiest
   * one. MEASURED: a wallet that bought $138,612 and sold $303,934 vanished
   * from the board entirely — it holds nothing now, so the holder list cannot
   * see it, and its sells went through Meteora, so a whale query pointed at
   * the PumpSwap pool could not either.
   */
  const pages = await Promise.all(
    books.flatMap((book) =>
      windows.map((w) =>
        archive(
          book,
          undefined,
          "desc",
          {
            ...tradeFilter(mint),
            blockTime: { gte: w.from, lt: w.to },
            tokenTransfer: {
              mint,
              // Raw units. Decimals come from the balances, so 1e6 is assumed
              // only for the threshold — an order of magnitude either way just
              // moves how many big trades come back.
              amount: { gte: Math.round((BIG_TRADE_USD / w.price) * 1e6) },
            },
          },
          20,
        ),
      ),
    ),
  );

  const swaps: Swap[] = [];
  for (const page of pages) {
    for (const raw of page?.data ?? []) {
      const priced = priceSwap(raw as never, venue, mint, sol);
      if (priced) {
        swaps.push(priced);
        continue;
      }
      const nominated = nominateFromBalances(raw as never, mint);
      if (nominated) swaps.push(nominated);
    }
  }
  return swaps;
}

/**
 * Who the board should look at, from three sources that miss different people.
 *
 * A trade sample sees whoever traded a lot and is blind to whoever bought once
 * and held — MEASURED, the fourteenth-largest holder of this token, up
 * $487,000, made 101 trades out of 1.8 million and never appeared in a
 * thousand-trade sample. A holder list is the mirror image: it sees everyone
 * still in and nobody who got out.
 *
 * Between them they cover the board's two headings, which is not a
 * coincidence — the biggest winners are usually still holding, and so are the
 * biggest losers.
 */
async function nominate(
  venue: Venue,
  mint: string,
  first: number,
  last: number,
  candles: Candle[],
  sol: SolPriceHistory,
): Promise<{ candidates: string[]; considered: number }> {
  /**
   * The holder scan runs first because it also finds every pool, and the trade
   * sample needs to know which books to read.
   */
  const scan = await stage("nominate:holders", () =>
    scanHolders(mint, BOARD_CANDIDATES),
  );
  const holders = scan.holders;
  const [sampled, big] = await Promise.all([
    stage("nominate:trades", () =>
      nominees(venue, mint, first, last, scan.pools.map((p) => p.pool), sol),
    ),
    stage("nominate:whales", () =>
      bigTrades(venue, mint, candles, scan.pools.map((p) => p.pool), sol),
    ),
  ]);

  // Ranked by the money each wallet was SEEN moving. Gross, not net: a wallet
  // that bought big and sold big is exactly who the board is looking for, and
  // netting it out would rank it alongside one that never traded.
  const gross = new Map<string, number>();
  for (const f of [...sampled, ...big]) {
    if (!f.wallet) continue;
    gross.set(f.wallet, (gross.get(f.wallet) ?? 0) + Math.abs(f.usd));
  }
  const traders = [...gross.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  // Interleaved rather than concatenated, so a cap falls on the tail of every
  // list instead of removing one of them — which is what a board with no
  // losers on it looks like.
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(traders.length, holders.length); i += 1) {
    for (const w of [traders[i], holders[i]?.owner]) {
      if (!w || seen.has(w)) continue;
      seen.add(w);
      candidates.push(w);
    }
  }
  return { candidates: candidates.slice(0, BOARD_CANDIDATES), considered: gross.size };
}

/**
 * Bars a spliced section may hold. A backstop, not the real bound.
 *
 * The real bound is that a section is only offered over the stretch already
 * built at the fine width — see `zoomable` — so the series call behind it is a
 * cache read. This catches the case where that stretch is itself enormous:
 * `buildCandles` holds every response of a sweep at once, and a few thousand
 * bars of full transactions is gigabytes of them.
 */
const ZOOM_MAX_BARS = Number(process.env.ZOOM_MAX_BARS ?? 4_000);

/**
 * Whether this token has bars finer than its own chart, and how fine.
 *
 * Read from the index a build leaves behind rather than from configuration:
 * a token is zoomable exactly when someone has run `scripts/zoom-window.mjs`
 * over it, and there is nothing to switch on. That is also what bounds the
 * cost — the section a caller may ask for is a slice of what is already
 * stored, so it is a cache read however hard the slider is dragged.
 */
async function zoomFor(
  mint: string,
  /** The replay's own window, so the best-fitting range is the one offered. */
  window: { from: number; to: number },
) {
  const index = await loadZoom(mint);
  if (!index || !(index.interval > 0)) return null;
  /**
   * The range that overlaps this replay most, not merely the first one.
   *
   * A token built over two stretches has one that matters to any given
   * wallet — usually the only one it traded in. Ties go to the later range,
   * which is the one a fresh replay is more likely to be about.
   */
  let best: { from: number; to: number; overlap: number } | null = null;
  for (const r of index.ranges ?? []) {
    const overlap = Math.min(r.to, window.to) - Math.max(r.from, window.from);
    if (overlap <= 0) continue;
    if (!best || overlap >= best.overlap) best = { ...r, overlap };
  }
  return best ? { interval: index.interval, from: best.from, to: best.to } : null;
}

/** A stretch of the chart drawn at the finer width. Snapped by the caller. */
export interface ZoomSection {
  from: number;
  to: number;
}

async function walletHistory(
  mint: string,
  wallet: string,
  leadSec: number,
  /**
   * Wallets to replay ALONGSIDE the subject, as one position.
   *
   * A trader's position is often split across several wallets, and replaying
   * one of them animates a fraction of the story. Booked under a single
   * identity rather than summed afterwards, which is what makes it correct:
   * a transfer between two wallets in the cluster leaves one and enters the
   * other, so as one position it cancels exactly, the way it should.
   */
  alongside: string[] = [],
  limits: ReplayLimits = OWNER_LIMITS,
  /** The stretch to draw finely, when the caller picked one. See `zoomFor`. */
  section?: ZoomSection,
): Promise<WalletReplay | null> {
  const cluster = [wallet, ...alongside.filter((w) => w !== wallet)];
  const [activities, venue] = await Promise.all([
    Promise.all(cluster.map((w) => walletActivity(mint, w, 0, limits.pages))),
    venueFor(mint),
  ]);
  const activity = activities[0] as (typeof activities)[number];
  if (activity.txs.length === 0 || !venue) return null;

  // The window has to cover everyone being replayed, not just the subject.
  const firstTs = Math.min(...activities.filter((a) => a.first > 0).map((a) => a.first));
  const lastTs = Math.max(...activities.map((a) => a.last));

  /**
   * Whether the cluster still holds, worked out from the transactions already
   * in hand rather than from fills — `walletFills` cannot run yet, because it
   * prices against a chart that this window is what decides.
   *
   * Summed across the cluster, which is the same reason `walletHistory` books
   * it as one position: a transfer between two of these wallets leaves one and
   * enters the other and nets to nothing, exactly as it should.
   */
  let held = 0;
  let everHeld = 0;
  activities.forEach((a, i) => {
    const w = cluster[i] as string;
    const counted = new Set<string>();
    for (const tx of a.txs) {
      if (tx.failed || counted.has(tx.signature)) continue;
      counted.add(tx.signature);
      const delta = baseDelta(tx, mint, w);
      held += delta;
      if (delta > 0) everHeld += delta;
    }
  });

  /**
   * A window worth watching, not just the one the trades occupy.
   *
   * A wallet with a single buy spans zero seconds, which produced a chart three
   * candles wide — correct, and useless to record. The window is padded to a
   * readable length either side, so a replay always opens on the token in
   * motion and carries on past the last trade to show how it played out.
   */
  const { interval, from, to } = replayWindow(
    firstTs,
    lastTs,
    leadSec,
    stillOpen(held, everHeld),
  );

  /**
   * Refuse a window too large to draw on demand — do not quietly narrow it.
   *
   * Counted as bars MISSING from the cache rather than bars in the window, so
   * an already-indexed token costs nothing here: `missingRanges` returns one
   * or two, and this never fires. It fires on a cold mint where the wallet
   * held across a long span, which is precisely the request that would
   * otherwise draw hundreds of sampled bars for one anonymous visitor.
   *
   * Refusing rather than trimming is deliberate. A narrowed window would price
   * the wallet's entry against bars that were never read, and a confidently
   * wrong PnL is worse than an honest no — the same reason `exactBoard` drops
   * a wallet it could not read whole instead of ranking it on part of one.
   */
  /**
   * Price the window before drawing any of it.
   *
   * This replaces attempting the build and letting the credit ceiling stop it
   * part-way, which was the worst of both: MEASURED, 4,342 credits spent to
   * learn one fact, and nothing kept — the window is a single gap and gaps are
   * only stored once they complete, so four clicks in a row bought four
   * identical nothings.
   *
   * Counting signatures answers the same question for a fortieth of that, and
   * answers it BEFORE the money is gone, which is what lets the caller say
   * "this needs indexing first" instead of "something went wrong".
   */
  const bounded = Number.isFinite(limits.credits);
  if (bounded) {
    const cached = await loadSeries(mint, interval);
    const missing = missingRanges(cached, from, to, interval).reduce(
      (n, gap) => n + Math.ceil((gap.to - gap.from) / interval),
      0,
    );
    if (missing > limits.buildBars) {
      throw new TooLarge(`this window needs ${missing} bars built`, {
        bars: missing,
        credits: missing * 170,
        seconds: Math.round(missing * 0.048),
        interval,
        from,
        to,
      });
    }
    if (missing > 0) {
      const cost = await stage("estimate", () =>
        estimateWindow(venue, mint, from, to, interval, missing),
      );
      if (cost.credits > limits.credits) {
        throw new TooLarge(
          `drawing this window would cost about ${cost.credits} credits`,
          {
            bars: cost.bars,
            credits: cost.credits,
            seconds: estimateSeconds(cost),
            interval,
            from,
            to,
          },
        );
      }
    }
  }

  const sol = new SolPriceHistory();
  await sol.load(from, to);

  /**
   * The replay window is read EXACTLY wherever it fits, not sampled.
   *
   * This is the whole reason a wallet's replay can look right where a
   * three-week overview cannot. A wallet usually trades over minutes, and once
   * the trade filter has removed the bot traffic, minutes are nothing —
   * MEASURED on this token, 300 seconds is 45 swaps at mid-life and 310 at its
   * busiest, which is one request either way. So the bars a recording actually
   * shows have every trade in them, with real highs, real lows and real volume.
   *
   * `buildCandles` makes that call per window from the density map. A wallet
   * that traded across three weeks gets the sampled chart, which is the honest
   * answer for a span that size.
   */
  let drawn;
  try {
    drawn = await stage("candles", () => series(venue, mint, from, to, interval, sol));
  } catch (error) {
    /**
     * A ceiling hit here still knows which window it was drawing.
     *
     * `BudgetExceeded` is thrown from the meter, five layers down, and carries
     * only a number — so the route caught it with no idea what to queue and
     * enqueued the mint alone. The worker then had a job with no windows,
     * built nothing, and marked it failed: three people waiting on a token
     * that could never succeed.
     *
     * Re-thrown as the refusal that carries the window, so the queue can
     * actually build the thing that was refused.
     */
    if (error instanceof BudgetExceeded) {
      const cached = await loadSeries(mint, interval);
      const bars = missingRanges(cached, from, to, interval).reduce(
        (n, gap) => n + Math.ceil((gap.to - gap.from) / interval),
        0,
      );
      throw new TooLarge(error.message, {
        bars,
        credits: error.spent,
        seconds: Math.round(bars * 0.048),
        interval,
        from,
        to,
      });
    }
    throw error;
  }

  if (drawn.candles.length === 0) return null;

  /**
   * One stretch of the chart at a finer bar width, spliced into the coarse one.
   *
   * Not a second chart and not a zoom of the first: the bars either side stay
   * two hours wide and the ones inside the section are minutes, in a single
   * series that runs straight through. The replay steps one bar at a time, so
   * the section plays out slowly while the rest of the token's life goes past
   * at the width it was always drawn at — which is the point, since a minute
   * that moved 45% is one flat-looking bar on a two-hour chart.
   *
   * Offered ONLY over the stretch already built at the fine width. That is
   * what keeps this from being a way to spend money by dragging a slider: the
   * `series` call below is a cache read, not a build. Anything else is a run
   * of `scripts/zoom-window.mjs` away.
   */
  const fine = await zoomFor(mint, { from, to });
  /**
   * The stretch a section may be cut from, in COARSE bars.
   *
   * Snapped INWARD, which is the direction that matters: the edges of a
   * section are filled from fine bars either side of it (see below), so the
   * usable range has to be one where the whole coarse bar containing each edge
   * is itself covered at the fine width. Snapping outward would reach for
   * minute bars that were never built and turn a slider drag into a build.
   */
  const covered = fine
    ? {
        from: Math.ceil(Math.max(fine.from, from) / interval) * interval,
        to: Math.floor(Math.min(fine.to, to) / interval) * interval,
      }
    : null;

  let candles = drawn.candles;
  let exact = drawn.exact;
  let zoomed: { from: number; to: number; interval: number } | undefined;

  if (fine && covered && section && covered.to > covered.from) {
    const zf = Math.min(Math.max(section.from, covered.from), covered.to);
    const zt = Math.min(Math.max(section.to, zf), covered.to);
    /**
     * The coarse bars the two edges land inside.
     *
     * A section that starts at 02:37 sits in the middle of the 02:00 bar. That
     * bar cannot stay — it covers ground the minute bars are about to cover
     * again, and a bar drawn twice is volume counted twice — and it cannot
     * simply go either, because dropping it leaves 02:00 to 02:37 with no bar
     * at all. So it is REBUILT from the fine bars of just that stub, and the
     * same at the far end. That is what lets the section begin and end on a
     * minute instead of being widened to the nearest two hours.
     */
    const head = Math.floor(zf / interval) * interval;
    const tail = Math.ceil(zt / interval) * interval;
    const bars = (tail - head) / fine.interval;
    if (zt > zf && bars <= ZOOM_MAX_BARS) {
      const inner = await stage("candles:zoom", () =>
        series(venue, mint, head, tail, fine.interval, sol),
      );
      const within = (lo: number, hi: number) =>
        inner.candles.filter((c) => c.t >= lo && c.t < hi);
      const body = within(zf, zt);
      if (body.length > 0) {
        candles = [
          ...drawn.candles.filter((c) => c.t < head),
          ...stub(within(head, zf), head),
          ...body,
          ...stub(within(zt, tail), zt),
          ...drawn.candles.filter((c) => c.t >= tail),
        ];
        if (!inner.exact) exact = false;
        zoomed = { from: zf, to: zt, interval: fine.interval };
      }
    } else if (bars > ZOOM_MAX_BARS) {
      console.warn(`[zoom] refused ${Math.round(bars)} bars, over ${ZOOM_MAX_BARS}`);
    }
  }

  const priceAt = priceLookup(candles);
  const perWallet = await Promise.all(
    cluster.map((w, i) =>
      walletFills(
        (activities[i] as (typeof activities)[number]).txs,
        mint,
        w,
        priceAt,
        sol,
      ),
    ),
  );
  const fills = perWallet.flat().sort((a, b) => a.ts - b.ts);

  /**
   * Three lookups that need nothing from each other, awaited together.
   *
   * Written inline in the return object they ran in sequence — three round
   * trips stacked end to end on the path a click waits for. None of them
   * depends on another.
   */
  const [walletName, token, supply] = await Promise.all([
    identify([wallet]).then((m) => m.get(wallet)?.name),
    tokenIdentity(mint),
    tokenSupply(mint),
  ]);

  await remember(mint, interval, drawn.candles, "window", token);

  const history: TokenHistory = {
    mint,
    cluster: cluster.length > 1 ? cluster : undefined,
    walletName,
    ...token,
    candles,
    supply,
    interval,
    fills: fills.length,
    /**
     * Swaps in THIS WINDOW, not over the token's life.
     *
     * It was simply absent, and the page renders a missing count as zero — so
     * a replay built from a hundred and forty-four bars of real trading
     * reported "Swaps 0", which reads as a broken number rather than a missing
     * one. The lifetime figure comes from the whole-life density map, and a
     * wallet replay never builds one: it draws a window, so the honest count
     * is what that window holds.
     *
     * On a sampled window this is what was READ rather than what happened —
     * which is why the panel shows "sampled" beside it.
     */
    swaps: candles.reduce((n, c) => n + c.n, 0),
    transactions: activities.reduce((n, a) => n + a.txs.length, 0),
    firstTs: candles[0]?.t ?? activity.first,
    lastTs: candles[candles.length - 1]?.t ?? activity.last,
    venue: venue.pool,
    exact,
    partial: activity.truncated,
    zoom: zoomed,
    /**
     * The stretch a section may be picked from, which is what the control
     * under the chart is drawn against. Absent means the feature is off for
     * this pair, or nothing has been built at the fine width yet — either way
     * there is nothing to offer and no control to show.
     */
    zoomable: covered && covered.to > covered.from
      ? { interval: (fine as { interval: number }).interval, ...covered }
      : undefined,
  };
  return { history, fills, interval };
}

/**
 * Record a token as replayable, from whichever path just drew it.
 *
 * Every path that builds a chart calls this, because any of them can be the
 * first thing a visitor does with a token — asking for one wallet, or asking
 * for the board, both leave a cached chart behind that the page should offer.
 */
async function remember(
  mint: string,
  interval: number,
  candles: Candle[],
  /**
   * Whether these candles are the token's whole life or one wallet's slice.
   *
   * Required rather than defaulted, because the two callers that produce
   * `window` and the two that produce `full` look identical from here, and
   * guessing wrong in either direction is a visible bug: a slice in the
   * gallery, or a whole-life chart hidden from it.
   */
  coverage: Coverage,
  extra: Partial<BuiltToken> = {},
): Promise<void> {
  if (candles.length === 0) return;
  await rememberToken({
    mint,
    coverage,
    interval,
    bars: candles.length,
    firstTs: candles[0]?.t ?? 0,
    lastTs: candles[candles.length - 1]?.t ?? 0,
    builtAt: nowSec(),
    ...extra,
  });
}

/**
 * Rebuilt charts, and the builds still running.
 *
 * The promise is stored BEFORE the work starts, not the result after it. The
 * old shape only wrote on success at the end, so two requests for the same
 * cold mint both missed, both ran the whole reconstruction, and paid for it
 * twice — the window where that happens is precisely the minute the build is
 * expensive.
 *
 * Bounded, because it never was. An unbounded map of every mint an instance
 * has ever drawn is a leak that grows with traffic.
 */
const cache = new Map<string, { at: number; history: Promise<TokenHistory | null> }>();
const CACHE_MS = Number(process.env.HISTORY_CACHE_MS ?? 10 * 60_000);
const CACHE_MAX = Number(process.env.HISTORY_CACHE_MAX ?? 200);

/**
 * Wallet replays in flight. Shared, never kept.
 *
 * Two people opening the same wallet at once should cost one read; the same
 * person opening it a minute later should get fresh numbers. A wallet replay
 * is cheap on an indexed token and its whole value is being current — the
 * chart path bypassed this cache entirely for exactly that reason — so these
 * entries are deleted the moment they settle, success or failure.
 */
const walletsInFlight = new Map<string, Promise<WalletReplay | null>>();

function remember_<T>(map: Map<string, T>, key: string, value: T, max: number): void {
  map.delete(key);
  map.set(key, value);
  // Insertion-ordered, so the first key is the least recently written.
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Traders read exactly for the board. Two calls each, run in parallel. */
const BOARD_CANDIDATES = Number(process.env.HISTORY_BOARD_CANDIDATES ?? 220);
/** Linked wallets read in full. The tail of the ranking is noise anyway. */
const GRAPH_READ_LIMIT = Number(process.env.HISTORY_GRAPH_READ ?? 8);

/** Rows kept per side. The page scrolls, so this is what "many more" costs. */
const BOARD_ROWS = Number(process.env.HISTORY_BOARD_ROWS ?? 60);

/** Bumped when `identify` learns to name wallets it used to call unknown. */
/**
 * Bumped to 3 when `type` joined the stored identity.
 *
 * A board cached under v2 holds names with no `type`, so the protocol test
 * would silently never fire on exactly the wallets it exists to catch.
 */
const NAMES_V = 3;

/**
 * An honest trader board on a token too busy to read whole.
 *
 * A sampled book does not give a small PnL, it gives a WRONG one: a wallet
 * whose buy was sampled and whose sell was not looks like it is still holding,
 * and one with two of its forty fills sampled shows two trades and a few
 * dollars. That is what put fifteen wallets on screen all reading "2 trades"
 * on a token where people made thousands.
 *
 * So the sample is used for what a sample is good for — NOMINATING who is worth
 * looking at — and never for the numbers. Every nominee is then read exactly
 * via its own history, which is a call or two per wallet because
 * `tokenTransfer.mint` returns only the transactions that touched this token.
 * The resulting PnL is complete for every wallet shown.
 *
 * The nomination comes from a sample spanning the token's whole life, so a
 * wallet that made its money in the first minutes is a candidate on equal terms
 * with one still trading.
 */
/**
 * How many transactions a wallet has on this mint, up to a ceiling.
 *
 * Asked BEFORE reading anything, because the answer decides whether reading is
 * worth starting. A wallet past the page cap is discarded — its buys would be
 * read and its sells would not, which fabricates a winner — and discarding it
 * after fetching twelve pages of full transactions means throwing away as much
 * as 240MB. Signatures answer the same question for ten credits and a
 * rounding error of the bytes.
 */
async function walletSize(
  mint: string,
  wallet: string,
  since: number,
): Promise<number> {
  let count = 0;
  let token: string | undefined;
  for (let page = 0; page <= WALLET_PAGES; page += 1) {
    const res = await archive(
      wallet,
      token,
      "asc",
      {
        ...tradeFilter(mint),
        ...(since > 0 ? { blockTime: { gte: since } } : {}),
      },
      PAGE,
      "signatures",
    );
    const data = res?.data ?? [];
    count += data.length;
    token = res?.paginationToken;
    if (!token || data.length === 0) break;
  }
  return count;
}

async function exactBoard(
  mint: string,
  candidates: string[],
  priceAt: (ts: number) => number,
  sol: SolPriceHistory,
  /** Seeded book and cutoff, when updating rather than building. */
  carry?: { book: PositionBook; since: number },
): Promise<{ book: PositionBook; fills: HistoryFill[] }> {
  const since = carry?.since ?? 0;
  const fills: HistoryFill[] = [];
  const CONCURRENCY = Number(process.env.HISTORY_BOARD_CONCURRENCY ?? 60);

  /**
   * Measure every candidate first, then read only the ones worth reading.
   *
   * The probes are signature pages — cheap, small, and all in flight at once.
   * What they buy is skipping the wallets that would have been discarded
   * anyway, which are exactly the most expensive ones to fetch.
   */
  const sizes = new Map<string, number>();
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    await Promise.all(
      candidates.slice(i, i + CONCURRENCY).map(async (w) => {
        try {
          sizes.set(w, await walletSize(mint, w, since));
        } catch {
          sizes.set(w, 0);
        }
      }),
    );
  }

  const readable = candidates.filter((w) => {
    const n = sizes.get(w) ?? 0;
    return n > 0 && n <= WALLET_PAGES * PAGE;
  });
  if (DEBUG) {
    const skipped = candidates.length - readable.length;
    const total = readable.reduce((sum, w) => sum + (sizes.get(w) ?? 0), 0);
    console.log(
      `[history] board: ${readable.length} of ${candidates.length} candidates readable (${skipped} skipped), ${total.toLocaleString()} transactions`,
    );
  }

  for (let i = 0; i < readable.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      readable.slice(i, i + CONCURRENCY).map(async (w) => {
        try {
          const activity = await walletActivity(mint, w, since);
          // Better absent than fabricated: a wallet whose sells were read and
          // whose buys were not ranks as a winner that never existed.
          if (activity.truncated) return [];
          return await walletFills(activity.txs, mint, w, priceAt, sol);
        } catch {
          return [];
        }
      }),
    );
    for (const got of batch) fills.push(...got);
  }

  fills.sort((a, b) => a.ts - b.ts);
  const book = carry?.book ?? new PositionBook();
  for (const f of fills) {
    if (!f.wallet) continue;
    book.apply(mint, f.wallet, {
      ts: f.ts,
      isBuy: f.isBuy,
      base: f.base,
      usd: f.usd,
      kind: f.kind,
    });
  }
  return { book, fills };
}

export async function reconstruct(
  mint: string,
  leadSec = 300,
): Promise<TokenHistory | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.history;

  /**
   * Published before it is awaited, so a second caller joins instead of
   * starting its own. This is the whole of the coalescing: no table, no lock,
   * no waiter protocol — just not throwing away the fact that the work is
   * already happening.
   */
  const pending = priced(`history ${mint}`, () => reconstructInner(mint, leadSec));
  remember_(cache, mint, { at: Date.now(), history: pending }, CACHE_MAX);

  try {
    const built = await pending;
    /**
     * A null is not an answer worth keeping.
     *
     * `reconstructInner` returns null when the venue or the lifespan could not
     * be read, and either can be a one-off upstream failure. Memoising that
     * would turn a blip into ten minutes of a token that "has no trades".
     */
    if (built === null) cache.delete(mint);
    return built;
  } catch (error) {
    cache.delete(mint);
    throw error;
  }
}

/**
 * Transactions read to decide whether a wallet ever TRADED a mint.
 *
 * Small on purpose. The question is "any swap at all", not "how many", and a
 * page of a thousand full transactions costs a hundred credits to answer a
 * yes/no that thirty answers just as well.
 */
const TRADE_PROBE = Number(process.env.TRADE_PROBE ?? 30);

/**
 * Did this wallet ever buy or sell this token, as opposed to just holding it?
 *
 * Holding is not trading, and the wallet page cannot tell them apart on its
 * own: it lists token ACCOUNTS, so an airdrop the owner never touched looks
 * exactly like a position they built. Offering those for indexing is offering
 * a replay with nothing in it — and, worse, offering to spend a build on one.
 *
 * Read newest-first, because a wallet that trades at all usually traded
 * recently. The important part is the `complete` test: a definite "no" is only
 * safe when the whole of the wallet's history on this mint fitted in one probe.
 * Past that the honest answer is "do not know", and a row is kept rather than
 * hidden — a false positive shows one dead row, a false negative hides a
 * replay somebody came for.
 */
export async function tradedOn(mint: string, wallet: string): Promise<boolean> {
  /**
   * Cached, because the wallet page asks this forty-odd times at once.
   *
   * Ten credits a row is nothing; forty rows on every page load is 440, and
   * forty CONCURRENT reads is what actually hurts — ten visitors at once puts
   * four hundred calls in flight and the governor queues them, so everybody
   * waits. The answer barely moves: a wallet that has traded a token has
   * traded it for ever, and one that has not is only one swap away from
   * flipping, which the shorter miss TTL covers.
   */
  const key = `traded:${mint}:${wallet}`;
  const held = await loadBlob<{ at: number; traded: boolean }>(key);
  if (held && nowSec() - held.at < (held.traded ? TRADED_TTL : TRADED_MISS_TTL)) {
    return held.traded;
  }

  const answer = await probeTraded(mint, wallet);
  await saveBlob(key, { at: nowSec(), traded: answer });
  return answer;
}

/**
 * The same question for many mints at once, which is how the wallet page asks.
 *
 * One batched cache read for the whole page, then probes only for what is
 * missing — rather than forty independent round trips to answer forty
 * questions that are usually all already answered.
 */
export async function tradedOnMany(
  pairs: { mint: string; wallet: string }[],
): Promise<Map<string, boolean>> {
  const keys = pairs.map((p) => `traded:${p.mint}:${p.wallet}`);
  const held = await loadBlobs<{ at: number; traded: boolean }>(keys);
  const out = new Map<string, boolean>();
  const ask: { mint: string; wallet: string }[] = [];

  pairs.forEach((p, i) => {
    const hit = held.get(keys[i]!);
    const fresh =
      hit && nowSec() - hit.at < (hit.traded ? TRADED_TTL : TRADED_MISS_TTL);
    if (fresh) out.set(p.mint, hit!.traded);
    else ask.push(p);
  });

  const fresh = await Promise.all(
    ask.map(async (p) => ({ ...p, traded: await probeTraded(p.mint, p.wallet) })),
  );
  const at = nowSec();
  await saveBlobs(
    fresh.map((f) => ({
      key: `traded:${f.mint}:${f.wallet}`,
      value: { at, traded: f.traded },
    })),
  );
  for (const f of fresh) out.set(f.mint, f.traded);
  return out;
}

const TRADED_TTL = Number(process.env.TRADED_TTL ?? 30 * 24 * 3_600);
const TRADED_MISS_TTL = Number(process.env.TRADED_MISS_TTL ?? 6 * 3_600);

async function probeTraded(mint: string, wallet: string): Promise<boolean> {
  const res = await archive(wallet, undefined, "desc", tradeFilter(mint), TRADE_PROBE);
  const rows = res?.data ?? [];
  if (rows.length === 0) return false;

  const txs: NormalizedTx[] = [];
  for (const raw of rows) {
    const tx = adapt(raw);
    if (tx && !tx.failed) txs.push(tx);
  }
  // Prices are irrelevant to the question; a zero mark keeps it free. An
  // unloaded SOL history quotes zero too, so `execPrice` resolves nothing and
  // every fill falls through to that mark — no Binance fetch, no credits.
  const fills = await walletFills(txs, mint, wallet, () => 0, new SolPriceHistory());
  if (fills.some((f) => f.kind !== "transfer")) return true;

  // Nothing but transfers — trustworthy only if that was all there was.
  return rows.length >= TRADE_PROBE;
}

/**
 * The chart a wallet's replay needs: which bar width, over what span.
 *
 * Extracted because two places have to agree on it exactly. The replay derives
 * it when somebody clicks; the board pre-builds it in advance so that click is
 * instant. Any drift between the two and the pre-build fills a different cache
 * key from the one the click looks in — the work gets done, paid for, and
 * never used.
 *
 * The bar width comes from the WALLET's span, not the token's, which is the
 * whole reason this differs per wallet: a trader who was in for ten minutes is
 * one candle on the token's own two-hour chart, and no replay at all.
 */
/**
 * The finest bar a replay will draw, and how many of them it will draw.
 *
 * `pickInterval` widens fast because it is shared with the whole-life chart,
 * where a year of fifteen-minute bars is 35,000 candles nobody can read. A
 * replay is a different question: it covers ONE wallet's window, so the same
 * ladder hands a wallet that traded for three days 15m bars and a wallet that
 * traded for three weeks 2h bars — a visible difference between two rows of
 * the same board, and nothing to do with which token they are on.
 *
 * So a replay steps back down to 15m whenever the window still fits in a
 * readable chart. At 3,000 bars that covers any wallet active up to about a
 * month, which is the rung — "≤30 days → 2h" — where the jump was widest.
 */
const REPLAY_FINE = Number(process.env.HISTORY_REPLAY_FINE ?? 900);
const REPLAY_MAX_BARS = Number(process.env.HISTORY_REPLAY_MAX_BARS ?? 3_000);

/** The finest bar this span may be drawn at, never coarser than the ladder. */
function replayInterval(spanSec: number): number {
  const ladder = pickInterval(spanSec);
  if (ladder <= REPLAY_FINE) return ladder;
  return spanSec / REPLAY_FINE <= REPLAY_MAX_BARS ? REPLAY_FINE : ladder;
}

export function replayWindow(
  firstTs: number,
  lastTs: number,
  leadSec: number,
  /**
   * Whether the wallet is STILL IN the token at the end of those trades.
   *
   * An open position has not finished happening, so its replay runs to now
   * rather than to its last fill. Without this the curve marks tokens the
   * wallet still holds at whatever the price was when it stopped trading, and
   * the board beside it marks the same tokens at spot: MEASURED on ApZuxdpz,
   * `3Wxibuv` last traded 22.8h before the board was built and still held
   * 16.96M tokens, so its replay ended on a bar at $0.026045 and finished at
   * $440k against the board's $257,272 — the two numbers on the same screen
   * disagreeing by 71%, and the headline the whole clip builds to being the
   * wrong one.
   *
   * The bar width comes from the window this returns, so a long tail widens
   * the bars rather than multiplying them. See `stillOpen` for why dust does
   * not qualify.
   */
  holding = false,
): { interval: number; from: number; to: number } {
  const until = holding ? nowSec() : lastTs;
  const traded = Math.max(until - firstTs, 0);
  const interval = replayInterval(traded + leadSec);
  const pad = interval * MIN_CANDLES;
  return {
    interval,
    from: firstTs - Math.max(leadSec, pad / 2),
    to: Math.min(until + Math.max(interval, pad / 2), nowSec()),
  };
}

/**
 * A wallet's replay, and the material the curve is drawn from.
 *
 * Separate from `reconstruct` rather than a parameter on it, because the two
 * are different requests that happen to share an endpoint: this is bounded by
 * one wallet's own history and is the cheap path, and the other is the token's
 * entire life. Keeping them apart is also what removes the trapdoor — a wallet
 * with nothing on the mint used to fall through and rebuild the whole token.
 */
export interface WalletReplay {
  history: TokenHistory;
  fills: HistoryFill[];
  interval: number;
}

/**
 * What a caller is allowed to spend on one wallet replay.
 *
 * The wallet window is the only build a visitor can start, so it carries all
 * the weight that the read-only flag used to. Every field here bounds a
 * different way the same request can turn expensive: how much of the wallet's
 * history is read, how many wallets are read at once, and how much of the
 * token has to be drawn to show it.
 */
export interface ReplayLimits {
  /** Pages of the wallet's own transactions. The owner's default is 12. */
  pages: number;
  /** Cluster members read alongside the subject. */
  cluster: number;
  /**
   * Bars this request may BUILD, over and above what is already cached.
   *
   * A backstop, not the real limit — see `credits`. Note the FLOOR: every
   * replay window is padded by `MIN_CANDLES` either side so a recording opens
   * on the token already moving, which makes the narrowest possible window
   * sixty bars wide. Setting this to sixty therefore refuses essentially every
   * cold build, which is exactly what it did.
   */
  buildBars: number;
  /**
   * Credits this request may spend, enforced by the meter as it goes.
   *
   * The honest bound, because bars are a poor proxy for cost: `pickInterval`
   * already keeps any wallet window under about 460 bars however long the
   * wallet held, and the ninefold difference between a sampled bar and an
   * exact one is invisible to a bar count. A hundred and sixty bars measured
   * at 16,391 credits sampled; the same count read exactly would be nearer
   * two thousand.
   */
  credits: number;
}

export const OWNER_LIMITS: ReplayLimits = {
  pages: WALLET_PAGES,
  cluster: 8,
  buildBars: Number.POSITIVE_INFINITY,
  credits: Number.POSITIVE_INFINITY,
};

export const VISITOR_LIMITS: ReplayLimits = {
  pages: Number(process.env.VISITOR_WALLET_PAGES ?? 3),
  cluster: Number(process.env.VISITOR_CLUSTER ?? 1),
  // Comfortably clear of the sixty-bar padding floor.
  buildBars: Number(process.env.VISITOR_MAX_BARS ?? 500),
  /**
   * Set from what queueing actually BUYS, not from the credits alone.
   *
   * Ten thousand looked like the gap between ordinary and expensive, and in
   * production it queued a sixty-four bar window the estimator priced at
   * 10,010 — a build that takes three seconds. Sending that round the queue
   * costs the visitor a minute's wait and the site a whole tick, to save
   * nothing: nobody else was asking for it.
   *
   * The queue earns its keep on work measured in tens of seconds, where the
   * dedup matters and the wait is unavoidable anyway. Twenty-five thousand is
   * roughly a hundred and fifty sampled bars, about seven seconds — past that,
   * waiting is the better answer; short of it, waiting is theatre.
   */
  credits: Number(process.env.VISITOR_MAX_CREDITS ?? 25_000),
};

/**
 * Thrown when a request is refused for being too large, not for failing.
 *
 * Carries the estimate, because "no" on its own is a dead end: the caller
 * turns these numbers into "queued, about a minute" rather than an error.
 */
export class TooLarge extends Error {
  constructor(
    message: string,
    readonly estimate: {
      bars: number;
      credits: number;
      seconds: number;
      /**
       * The exact window that was refused, so the queue can build THAT.
       *
       * Not optional, and not something the worker can re-derive. A wallet's
       * bar width comes from its own trading span, and the token's whole-life
       * chart uses a different rung entirely — MEASURED on a 27-day token, the
       * whole-life build picks 7,200s bars while the wallet needed 900s. A
       * worker told only the mint would build the wrong series, the click
       * would be refused again for the same reason, and the queue would loop
       * for ever while spending real money each time round.
       */
      interval: number;
      from: number;
      to: number;
    },
  ) {
    super(message);
    this.name = "TooLarge";
  }
}

/**
 * Build one window of a token's chart, at one bar width.
 *
 * What the queue worker runs. Deliberately narrower than `reconstruct`: the
 * thing somebody is waiting for is their own replay, and that needs the series
 * at THEIR rung over THEIR window — not the token's whole life at whatever
 * width suits the token. Building the wrong one costs the same and helps
 * nobody.
 *
 * Unbounded, because this is the owner's budget being spent once for everyone
 * who asks for that token afterwards.
 */
/**
 * Bars one queued build may draw.
 *
 * A whole-life chart is capped at `MAX_BUCKETS` (400) — `pickInterval` widens
 * the bar until the token fits. Nothing capped a WINDOW, so a job could carry
 * one seven times larger than any chart the app would draw itself: MEASURED,
 * 2,833 bars at 900s, estimated at 481,780 credits. The cap is generous
 * against a real wallet window (~460 bars at worst) and refuses the ones that
 * can only come from a merge that went wrong.
 */
const BUILD_MAX_BARS = Number(process.env.BUILD_MAX_BARS ?? 1_000);

export async function buildWindow(
  mint: string,
  interval: number,
  from: number,
  to: number,
): Promise<number> {
  const bars = Math.ceil((to - from) / interval);
  if (bars > BUILD_MAX_BARS) {
    console.error(
      `[history] refusing ${mint} @${interval}s: ${bars} bars, over ${BUILD_MAX_BARS}`,
    );
    return 0;
  }
  return priced(`build ${mint} @${interval}s`, async () => {
    const venue = await stage("venue", () => venueFor(mint));
    if (!venue) return 0;
    const sol = new SolPriceHistory();
    await sol.load(from, to);
    const drawn = await stage("candles", () =>
      series(venue, mint, from, to, interval, sol),
    );
    await remember(mint, interval, drawn.candles, "window");
    return drawn.candles.length;
  });
}

export async function walletReplay(
  mint: string,
  wallet: string,
  leadSec = 300,
  alongside: string[] = [],
  limits: ReplayLimits = OWNER_LIMITS,
  section?: ZoomSection,
): Promise<WalletReplay | null> {
  const cluster = alongside.slice(0, Math.max(0, limits.cluster));
  /**
   * Keyed on everything that changes the answer.
   *
   * The subject, who is replayed alongside it, and the run-up all alter both
   * the window and the curve, so a key of the mint alone would hand one
   * wallet's replay to a request asking about another.
   */
  const key =
    `${mint}|${wallet}|${[...cluster].sort().join(",")}|${leadSec}|${limits.pages}` +
    // The section changes the candles, so two requests picking different
    // stretches must not share one in-flight build.
    `|${section ? `${section.from}-${section.to}` : ""}`;
  const running = walletsInFlight.get(key);
  if (running) return running;

  const pending = priced(
    `wallet ${mint} ${wallet}`,
    () => walletHistory(mint, wallet, leadSec, cluster, limits, section),
    limits.credits,
  );
  walletsInFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    // Shared while it runs, kept afterwards by nobody: a replay's value is
    // that it is current, and this path was never cached before.
    walletsInFlight.delete(key);
  }
}

/**
 * The token's whole life, at one bar width.
 *
 * A wallet's replay is NOT this with an extra argument — it is `walletReplay`,
 * bounded by that wallet's own history. Keeping them apart is what closed the
 * trapdoor where naming a wallet with nothing on the mint fell through to the
 * most expensive request the app can make.
 */
/**
 * Everything about a whole-life chart that is expensive and does not change.
 *
 * NOT the candles. Those live in `series:{mint}:{interval}` and `series()`
 * rewrites that blob on every top-up, so a second copy here would disagree
 * with it the moment any instance refreshed — and then go on serving stale
 * bars, because nothing would ever rewrite it. There is one home for bars.
 *
 * `lastTs` is absent for the same reason in reverse: it moves whenever the
 * token trades, and reusing a stored one would draw the window up to where the
 * token was when this was written, so the newest-bar refresh would refresh a
 * bar days old and the chart would quietly stop.
 */
interface ChartMeta {
  interval: number;
  firstTs: number;
  swaps: number;
  supply: number;
  venue: Venue;
  name?: string;
  symbol?: string;
  image?: string;
  at: number;
}

/**
 * How long the derived figures stand before being worked out again.
 *
 * `swaps` comes from integrating the density map and `supply` from a supply
 * lookup, and both genuinely move: the lifetime swap count of a live token
 * climbs, and supply changes when tokens are burned or minted. Caching them
 * forever would freeze the number under the chart and the market-cap axis it
 * is drawn against.
 */
const META_TTL = Number(process.env.HISTORY_META_TTL ?? 6 * 3_600);


async function reconstructInner(
  mint: string,
  leadSec = 300,
): Promise<TokenHistory | null> {
  void leadSec;
  /**
   * The book, then how busy it was, then the chart.
   *
   * In that order because each answer decides the next. Which pool to read
   * decides what counts as a trade; how busy it was decides whether a window
   * can be read exactly or has to be sampled; and only then is it worth
   * fetching a transaction. MEASURED, the first two steps together are about a
   * second and a half for a token with 1.8 million swaps behind it.
   */
  const cachedMeta = await loadBlob<ChartMeta>(`chart:${mint}`);
  const metaFresh = cachedMeta !== null && nowSec() - cachedMeta.at < META_TTL;

  const venue = cachedMeta?.venue ?? (await stage("venue", () => venueFor(mint)));
  if (!venue) return null;

  /**
   * `poolLifespan` is paid even on a cache hit, and it is worth it.
   *
   * It is the only thing that knows where the token is NOW — two calls and
   * about twenty credits against the four hundred or so that skipping the
   * density map, the asset lookup and the supply read saves. Taking the stored
   * `lastTs` instead would put every bar built since outside the requested
   * window, so `missingRanges` would never ask for them.
   */
  const life = await stage("lifespan", () => poolLifespan(venue, mint));
  if (!life) return null;
  const firstTs = cachedMeta?.firstTs ?? life.first;
  const lastTs = life.last;
  /**
   * The stored bar width is kept, not recomputed.
   *
   * `pickInterval` widens with the span, so a live token eventually crosses a
   * rung and the same chart would start writing `series:{mint}:{wider}` — a
   * key with nothing in it, i.e. a full rebuild from nothing, triggered by
   * nothing more than the token ageing a day. The staleness refresh below is
   * the one place allowed to change it.
   */
  const interval = metaFresh && cachedMeta ? cachedMeta.interval : pickInterval(lastTs - firstTs);

  // `series` loads the SOL prices it needs; the whole span is rarely one of
  // them, since most of a rebuilt token comes from the cache.
  const sol = new SolPriceHistory();

  // The whole-life map is worth its forty probes here: it is what tells the
  // page how many swaps the token has ever had. Skipped while the stored
  // figure is still fresh, which is most warm requests.
  const density = metaFresh
    ? null
    : await stage("density", () => densityMap(venue.pool, mint, firstTs, lastTs));
  const drawn = await stage("candles", () =>
    series(venue, mint, firstTs, Math.min(lastTs, nowSec()) + interval, interval, sol),
  );
  if (drawn.candles.length === 0) return null;

  const [token, supply] = metaFresh && cachedMeta
    ? [
        { name: cachedMeta.name, symbol: cachedMeta.symbol, image: cachedMeta.image },
        cachedMeta.supply,
      ]
    : await Promise.all([tokenIdentity(mint), tokenSupply(mint)]);

  const swaps = density ? Math.round(density.total) : (cachedMeta?.swaps ?? 0);
  const history: TokenHistory = {
    mint,
    ...token,
    candles: drawn.candles,
    supply,
    fills: 0,
    transactions: 0,
    swaps,
    interval,
    firstTs,
    lastTs,
    venue: venue.pool,
    exact: drawn.exact,
  };

  if (!metaFresh) {
    await saveBlob(`chart:${mint}`, {
      interval,
      firstTs,
      swaps,
      supply,
      venue,
      ...token,
      at: nowSec(),
    } satisfies ChartMeta);
  }

  // The page offers these back; a token already built redraws in ~2s.
  await remember(mint, interval, drawn.candles, "full", {
    ...token,
    firstTs,
    lastTs,
    swaps: history.swaps ?? 0,
  });
  return history;
}

/**
 * The trader board for a token, read exactly and kept.
 *
 * Every wallet shown has its COMPLETE history on this mint behind its number.
 * A sampled book does not give a small PnL, it gives a wrong one — a wallet
 * whose buy was sampled and whose sell was not looks like it is still holding.
 * So the sample nominates and the reading decides; see `exactBoard`.
 *
 * Expensive, and cached durably for that reason: a token's finished traders do
 * not change, so this is a cost paid once rather than once per visitor.
 */
/**
 * Wallets whose replay is pre-built when a board is.
 *
 * Per side, so ten means the top ten and the bottom ten. These are the names
 * somebody will actually click — nobody opens the fortieth row — and each one
 * they click without this waits a minute for a chart to be built.
 */
const PREBUILD_ROWS = Number(process.env.BOARD_PREBUILD_ROWS ?? 10);

/** The run-up the replay path defaults to; the pre-build must match it. */
const LEAD_SEC = 300;

/**
 * Credits the pre-build may spend before it stops and leaves the rest to the
 * queue. A ceiling, not a target: most of these are cache hits.
 */
const PREBUILD_CREDITS = Number(process.env.BOARD_PREBUILD_CREDITS ?? 150_000);

/**
 * Draw the charts the board's own wallets will ask for, while indexing.
 *
 * The gap this closes is the one nobody expects: a token is fully indexed, its
 * board is on screen, you click a name off it — and wait, because a wallet's
 * replay is drawn at ITS bar width and only the token's own was built. On this
 * token the board is at 7,200s bars and its wallets have wanted 28,800s.
 *
 * Nothing here is newly discovered. `exactBoard` has just read every ranked
 * wallet's complete history to rank them at all, so the first and last trade
 * of each is already in hand — this only stops throwing that away.
 *
 * Ordered by rank and budgeted rather than exhaustive, because the windows
 * overlap: once the first wallet at a given bar width is drawn, the next one
 * at that width is mostly a cache hit, and the tail is wallets nobody opens.
 */
async function prebuildReplays(
  venue: Venue,
  mint: string,
  board: TraderBoard,
  fills: HistoryFill[],
): Promise<void> {
  /**
   * `held` and `everHeld` alongside the span, because the window depends on
   * them — see `replayWindow`. The pre-build has to reach the SAME window the
   * click will, or it fills a different cache key and the work is paid for and
   * never used.
   */
  const span = new Map<
    string,
    { first: number; last: number; held: number; everHeld: number }
  >();
  for (const f of fills) {
    if (!f.wallet) continue;
    const base = f.isBuy ? f.base : -f.base;
    const seen = span.get(f.wallet);
    if (seen) {
      seen.first = Math.min(seen.first, f.ts);
      seen.last = Math.max(seen.last, f.ts);
      seen.held += base;
      if (base > 0) seen.everHeld += base;
    } else {
      span.set(f.wallet, {
        first: f.ts,
        last: f.ts,
        held: base,
        everHeld: Math.max(base, 0),
      });
    }
  }

  const wanted = [
    ...board.top.slice(0, PREBUILD_ROWS),
    ...board.bottom.slice(0, PREBUILD_ROWS),
  ];

  // One entry per distinct chart, so wallets sharing a bar width and an
  // overlapping span are drawn once rather than once each.
  const charts = new Map<string, { interval: number; from: number; to: number }>();
  for (const row of wanted) {
    const seen = span.get(row.wallet);
    if (!seen) continue;
    const w = replayWindow(
      seen.first,
      seen.last,
      LEAD_SEC,
      stillOpen(seen.held, seen.everHeld),
    );
    /**
     * Checked against every chart already open at this bar width, not just
     * the first one drawn.
     *
     * A single `charts.get(interval)` slot meant a THIRD window at a shared
     * width could only ever be compared against the first — a window that
     * overlapped the second instead, but not the first, silently opened a
     * third chart rather than joining the second. Scanning every entry at
     * this width is what actually finds the one it overlaps.
     *
     * Only widened where it actually overlaps — and only while the result is
     * still a chart worth drawing.
     *
     * The bar-count test matters now that a replay can be 15m wide: merging
     * two overlapping month-long windows at that width is four thousand bars
     * of a busy token, and `series` holds every response of a sweep at once.
     * Refusing the merge costs one extra chart; taking it costs the build.
     */
    const held = [...charts.values()].find(
      (c) =>
        c.interval === w.interval &&
        w.from <= c.to &&
        w.to >= c.from &&
        (Math.max(c.to, w.to) - Math.min(c.from, w.from)) / w.interval <=
          REPLAY_MAX_BARS,
    );
    if (held) {
      held.from = Math.min(held.from, w.from);
      held.to = Math.max(held.to, w.to);
      continue;
    }
    charts.set(`${w.interval}:${w.from}`, w);
  }

  const before = spentSoFar();
  for (const w of charts.values()) {
    if (spentSoFar() - before > PREBUILD_CREDITS) {
      if (DEBUG) console.log("[history] prebuild: budget reached, leaving the rest");
      break;
    }
    try {
      const sol = new SolPriceHistory();
      await sol.load(w.from, w.to);
      const drawn = await series(venue, mint, w.from, w.to, w.interval, sol);
      await remember(mint, w.interval, drawn.candles, "window");
    } catch {
      // A chart that will not draw now is one the queue can pick up later.
    }
  }
  if (DEBUG) {
    console.log(
      `[history] prebuild: ${charts.size} charts for ${wanted.length} ranked wallets`,
    );
  }
}

export async function traderBoard(
  mint: string,
  update = false,
  pin: string[] = [],
  /**
   * Whether this caller may BUILD a board that does not exist yet.
   *
   * Defaults true so the indexer, which calls this in-process, keeps working
   * unchanged; the routes pass the answer from `owner(request)`. Without it a
   * board is served if one is stored and refused if not, which is the only
   * safe behaviour on a path anyone can reach: nomination plus reading two
   * hundred wallets in full is minutes of work and the single most expensive
   * thing this app does.
   */
  mayBuild = true,
): Promise<TraderBoard | null> {
  return priced(`board ${mint}${update ? " (update)" : ""}`, () =>
    traderBoardInner(mint, update, pin, mayBuild),
  );
}

async function traderBoardInner(
  mint: string,
  /**
   * Read what has happened since the last build before ranking.
   *
   * Off by default because it is the slow path and a board an hour old is
   * still a board; the page offers it as a button and says how stale it is.
   */
  update = false,
  /**
   * Wallets that must be ranked whatever nomination thinks.
   *
   * Nomination is a sample and samples miss people. When you already know a
   * wallet matters, saying so is more reliable than widening the search until
   * it happens to be caught. Kept in the stored state, so it stays pinned
   * across later builds.
   */
  pin: string[] = [],
  mayBuild = true,
): Promise<TraderBoard | null> {
  const key = `board:${mint}`;
  const stateKey = `boardstate:${mint}`;
  const held = await loadBlob<TraderBoard>(key);
  const state = await loadBlob<BoardState>(stateKey);

  /**
   * Nothing stored and no permission to build: stop before spending anything.
   *
   * Placed above `venueFor` deliberately. Discovery is a handful of calls on a
   * mint nobody has looked at, and doing it only to refuse afterwards is a
   * cost a visitor can trigger repeatedly just by asking for boards that do
   * not exist.
   */
  if (!mayBuild && !held) return null;

  const venue = await stage("venue", () => venueFor(mint));
  if (!venue) return held ?? null;

  /**
   * Re-marked on every read, even without an update.
   *
   * An open position's worth moves with the price whether or not its owner
   * trades, so a board served straight from cache was quoting yesterday's
   * marks. Re-pricing is one request against the stored books; it is the
   * READING of wallets that costs minutes, and that only happens on update.
   */
  const sol = new SolPriceHistory();
  await sol.load(nowSec() - 3_600, nowSec());
  const price = await spotPrice(venue, mint, sol);

  /**
   * A newly pinned wallet has to get past the cache, or pinning it does
   * nothing at all — the cached path returns before nomination is even
   * considered.
   */
  const alreadyPinned = pin.every((w) => state?.candidates.includes(w));

  /**
   * Supply, for telling a token's plumbing apart from its traders.
   *
   * Read from the chart's cached metadata rather than looked up: `reconstruct`
   * has already paid for it, this is a blob read, and a board built for a mint
   * with no chart yet simply gets 0 — which turns the test off rather than
   * guessing at it.
   */
  const supply = (await loadBlob<ChartMeta>(`chart:${mint}`))?.supply ?? 0;

  if (held && state && !update && alreadyPinned) {
    if (price <= 0) return held;
    const book = new PositionBook();
    book.restore(mint, state.positions);
    const before = Object.keys(state.names ?? {}).length;
    const wasV = state.namesV;
    const board = await rank(mint, book, price, state, held.builtAt, supply);
    await saveBlob(key, board);
    /**
     * Only when the lookup actually learned something — or re-asked.
     *
     * The count alone cannot tell: a re-ask clears the map and refills it with
     * the same sixty wallets, so an unsaved bump would leave every later read
     * paying for the same lookup all over again.
     */
    if (
      Object.keys(state.names ?? {}).length !== before ||
      state.namesV !== wasV
    ) {
      await saveBlob(stateKey, state);
    }
    return board;
  }

  /**
   * Past here is the build, and it is minutes of work.
   *
   * Reaching this point without permission means the stored board could not
   * answer — no state, or the caller asked for an update. A visitor gets what
   * is stored, re-marked, or nothing; only the owner gets the wallets read.
   */
  if (!mayBuild) return held ?? null;

  const life = await stage("lifespan", () => poolLifespan(venue, mint));
  if (!life) return held ?? null;
  await sol.load(life.first, life.last);

  const interval = pickInterval(life.last - life.first);
  const drawn =
    (await loadSeries(mint, interval))?.candles ??
    (await series(venue, mint, life.first, Math.min(life.last, nowSec()) + interval, interval, sol))
      .candles;
  // The board draws the token's whole life to price its fills.
  await remember(mint, interval, drawn, "full");
  const priceAt = priceLookup(await pricingSeries(venue, mint, life, interval, drawn, sol));

  /**
   * An update keeps the candidates it already has and only reads what is new.
   *
   * Re-nominating would find slightly different wallets each time and force
   * every one of them to be read from scratch — several minutes to learn that
   * almost nothing changed. MEASURED, a full build reads ~220 wallets' entire
   * histories; an update reads only the transactions since the last one, which
   * for most wallets is none.
   */
  let candidates = state?.candidates ?? [];
  let considered = state?.considered ?? 0;
  const pinned = [...new Set([...(state?.pinned ?? []), ...pin])];
  let carry: { book: PositionBook; since: number } | undefined;

  const missing = pinned.filter((w) => !candidates.includes(w));
  if (state && update && candidates.length > 0 && missing.length === 0) {
    const book = new PositionBook();
    book.restore(mint, state.positions);
    carry = { book, since: state.lastTs };
  } else if (state && candidates.length > 0 && missing.length > 0) {
    // A newly pinned wallet has to be read from the beginning; everyone else
    // carries on from where they were.
    candidates = [...candidates, ...missing];
  } else {
    const nominated = await nominate(venue, mint, life.first, life.last, drawn, sol);
    /**
     * Merged with whoever was ranked before, not replacing them.
     *
     * Nomination looks at the token as it is TODAY, so a wallet that has since
     * closed its position stops being nominated and drops off the board —
     * taking its realised profit with it. MEASURED: a wallet that made
     * $165,323 and sold out was ranked tenth one day and absent the next.
     * Once a wallet has been ranked it stays a candidate; on an update it
     * costs only the transactions it has made since.
     */
    const merged = [...nominated.candidates];
    const seen = new Set(merged);
    for (const w of state?.candidates ?? []) {
      if (!seen.has(w)) merged.push(w);
    }
    candidates = merged.slice(0, BOARD_CANDIDATES * 2);
    considered = Math.max(nominated.considered, state?.considered ?? 0);
  }
  // Pinned wallets survive the cap.
  for (const w of pinned) if (!candidates.includes(w)) candidates.push(w);
  if (candidates.length === 0) return held ?? null;

  const { book, fills } = await stage("board", () =>
    exactBoard(mint, candidates, priceAt, sol, carry),
  );

  if (price <= 0) return held ?? null;

  const next: BoardState = {
    candidates,
    positions: book.snapshot(mint),
    considered,
    lastTs: nowSec(),
    pinned,
  };
  next.names = state?.names ?? {};
  const board = await rank(mint, book, price, next, nowSec(), supply);
  await saveBlob(key, board);
  await saveBlob(stateKey, next);

  /**
   * Saved BEFORE the pre-build, so a slow one cannot cost the board.
   *
   * The board is the answer somebody asked for; the pre-built replays are work
   * done in advance for a click that has not happened yet. If drawing them
   * fails or runs out of budget, the board is already on disk and the queue
   * picks up whatever is missing the first time anyone asks.
   */
  await stage("prebuild", () => prebuildReplays(venue, mint, board, fills));
  return board;
}


/**
 * Days from launch drawn finely, for pricing rather than for looking at.
 *
 * The whole-life series is what the CHART shows, and at a bar every 2.67 days
 * it is fine for that — the token spends most of its life going nowhere. It is
 * not fine for pricing a fill, and the error is not spread evenly: a bar's
 * close is only as good as the price is steady across it, so a flat month is
 * priced almost exactly and the launch is priced not at all.
 *
 * MEASURED, that is where the money is. Roughly a quarter of the proceeds on
 * both boards come from tokens LEAVING a wallet — an exchange deposit has no
 * quote leg, so it can only be priced from the chart — and those exits cluster
 * in the first days, exactly where a 2.67-day bar spans a 3x move.
 *
 * So the fix is resolution where price moves, not resolution everywhere: a
 * uniform four-hour rebuild costs ~593,000 credits a token and spends most of
 * it on the flat tail, where the coarse bar was already right.
 */
const LAUNCH_DAYS = Number(process.env.HISTORY_LAUNCH_DAYS ?? 14);
const LAUNCH_INTERVAL = Number(process.env.HISTORY_LAUNCH_INTERVAL ?? 1_800);
/** Credits the fine launch window may cost before the coarse series stands. */
const LAUNCH_CREDITS = Number(process.env.HISTORY_LAUNCH_CREDITS ?? 250_000);

/**
 * The coarse whole-life series with a fine launch window spliced into it.
 *
 * Returned as ONE array of mixed bar widths, which `priceLookup` handles by
 * construction — it binary-searches the times that are actually there rather
 * than computing a bucket, precisely so a spliced section works.
 *
 * Not written back to `series:{mint}:{interval}`. That blob is the chart, it
 * is keyed by a single bar width, and `missingRanges` reasons about it in
 * whole buckets of that width; mixing widths into it would make later top-ups
 * disagree with themselves. The fine bars go in their own key, where they are
 * also reusable, and the splice happens in memory.
 */
async function pricingSeries(
  venue: Venue,
  mint: string,
  life: { first: number; last: number },
  interval: number,
  coarse: Candle[],
  sol: SolPriceHistory,
): Promise<Candle[]> {
  // Nothing to gain when the chart is already finer than the launch window.
  if (interval <= LAUNCH_INTERVAL) return coarse;

  const to = Math.min(life.first + LAUNCH_DAYS * 86_400, life.last, nowSec());
  if (to <= life.first) return coarse;

  let fine: Candle[] = [];
  try {
    fine = (
      await priced(
        `launch ${mint}`,
        () => series(venue, mint, life.first, to, LAUNCH_INTERVAL, sol),
        LAUNCH_CREDITS,
      )
    ).candles;
  } catch (error) {
    /**
     * A refusal here costs precision, never the board.
     *
     * The coarse series is already in hand and already prices every fill; this
     * only makes the early ones better. Losing it to a budget ceiling on a
     * token with a very busy launch is the correct trade, and silently
     * carrying on with worse prices would not be.
     */
    console.warn(
      `[history] launch window not drawn for ${mint}: ${(error as Error).message}`,
    );
    return coarse;
  }
  if (fine.length === 0) return coarse;

  const firstFine = fine[0]!.t;
  const lastFine = fine[fine.length - 1]!.t + LAUNCH_INTERVAL;
  const spliced = [
    ...coarse.filter((c) => c.t + interval <= firstFine),
    ...fine,
    ...coarse.filter((c) => c.t >= lastFine),
  ];
  if (DEBUG) {
    console.log(
      `[history] pricing series: ${coarse.length} coarse bars + ${fine.length} fine ` +
        `(${LAUNCH_INTERVAL}s over ${LAUNCH_DAYS}d) = ${spliced.length}`,
    );
  }
  return spliced;
}

/** Order a book at a price. Shared by the cached read and the fresh build. */
/**
 * Share of a token's whole supply a wallet can be HANDED before it is
 * infrastructure rather than a trader.
 *
 * Nobody is given five percent of a token for nothing and then trades it. The
 * wallets on the far side of this line are minters, treasuries, liquidity
 * managers and exchange hot wallets, and their PnL is not a trade — it is the
 * token's own plumbing moving through them.
 *
 * MEASURED, and the gap either side is what makes it safe: on MELANIA the
 * shares are 102.92% (the minter, which handled the entire supply), 10.78%
 * (its liquidity account), then 1.00% for the next wallet down. On TRUMP,
 * 5.40% then 0.55%. There is no trader anywhere near the boundary.
 */
const INFRA_SUPPLY_SHARE = Number(process.env.HISTORY_INFRA_SUPPLY_SHARE ?? 0.05);

async function rank(
  mint: string,
  book: PositionBook,
  price: number,
  state: BoardState,
  builtAt: number,
  /** Circulating supply, for the infrastructure test. 0 disables it. */
  supply = 0,
): Promise<TraderBoard> {
  /**
   * Twice as deep as the board shows, because rows are about to be REMOVED.
   *
   * Filtering infrastructure out of an already-trimmed list would leave the
   * board short by however many it dropped — and the wallets it drops are
   * near the top, where a gap is most visible.
   */
  const ranked = book.leaderboard(mint, price, BOARD_ROWS * 2);

  /**
   * Handed a large share of the supply: a minter, a treasury, an LP manager.
   *
   * Behavioural rather than by name, because Helius calls these plain wallets
   * — MEASURED, both "Melania Meme Token Minter" and "Melania Meme Liquidity
   * 2" come back with `type: "wallet"`, indistinguishable from a person. Only
   * the bridge vault self-identifies, and that is handled below.
   */
  const distributor = (r: PnlRow): boolean =>
    supply > 0 && r.receivedBase / supply > INFRA_SUPPLY_SHARE;

  /**
   * Names for the rows that will actually be shown.
   *
   * After ranking, not before: identifying two hundred candidates to display
   * sixty of them is two wasted requests, and the ones cut are the ones nobody
   * reads. Only addresses not already in the stored map are asked about, so a
   * board that has been read once never asks again.
   */
  const shown = [...ranked.top, ...ranked.bottom].filter((r) => !distributor(r));
  if (state.namesV !== NAMES_V) {
    state.names = {};
    state.namesV = NAMES_V;
  }
  const known = (state.names ??= {});
  const missing = shown.map((r) => r.wallet).filter((w) => !(w in known));
  if (missing.length > 0) {
    const found = await identify(missing);
    // Absent is recorded too, so an unnamed wallet is not looked up forever.
    for (const wallet of missing) {
      const hit = found.get(wallet);
      known[wallet] = hit
        ? { name: hit.name, category: hit.category, type: hit.type }
        : {};
    }
  }
  for (const row of shown) {
    const hit = known[row.wallet];
    if (hit?.name) {
      row.name = hit.name;
      row.category = hit.category;
    }
  }

  /**
   * A protocol's own account, where Helius says so outright.
   *
   * Catches what the supply test cannot: a bridge vault moves other people's
   * tokens and need never hold much of the supply at once. MEASURED, the
   * DeBridge vault sat on the MELANIA losers board at -$1.1m.
   */
  const protocolOwned = (r: PnlRow): boolean => known[r.wallet]?.type === "protocol";
  const tradersOnly = (r: PnlRow): boolean => !distributor(r) && !protocolOwned(r);

  return {
    top: ranked.top.filter((r) => r.total > 0 && tradersOnly(r)).slice(0, BOARD_ROWS),
    /**
     * Only wallets that actually lost.
     *
     * The candidates are nominated by size, and on a token that ran 250x the
     * biggest movers are mostly winners — so the bottom of that ranking was a
     * wallet up sixty-four dollars under a heading saying "lost the most". A
     * short honest list beats a full dishonest one.
     */
    bottom: ranked.bottom
      .filter((r) => r.total < 0 && tradersOnly(r))
      .slice(0, BOARD_ROWS),
    wallets: ranked.wallets,
    truncated: state.considered > BOARD_CANDIDATES,
    builtAt,
    price,
  };
}

/**
 * Bars of run-up before a wallet's first trade.
 *
 * Enough that the chart is visibly moving when the replay opens, and few
 * enough that the wallet's own story is still what the clip is about.
 */
const LEAD_BARS = Number(process.env.HISTORY_LEAD_BARS ?? 8);

/** Reconstructed books, kept so a replay does not re-read the chain. */
/**
 * One wallet's replay over a reconstructed history.
 *
 * `leadSec` is the run-up: the chart starts before the wallet's first trade so
 * a recording opens on the token in motion rather than on the wallet's entry.
 */
export function replayFrom(
  mint: string,
  wallet: string,
  candles: Candle[],
  /** The fills and bar width `walletReplay` just produced for this cluster. */
  replay: { fills: HistoryFill[]; interval: number },
  leadSec = 300,
  alongside: string[] = [],
): { points: ReplayPoint[]; candles: Candle[]; trades: HistoryFill[] } {
  /**
   * Given the fills, not fetching them — and that is the whole point.
   *
   * This used to read a module-level Map that `walletHistory` had written a
   * few milliseconds earlier in the same request. That was not a cache: the
   * chart path skips its memo whenever a wallet is named, so the write and the
   * read always happened together, and the Map was a way of returning a second
   * value without changing a signature. It cost three bugs to keep — it never
   * survived a process boundary, so any worker or second instance answered
   * with an empty curve and a 200; it fell back to the BOARD's book for the
   * mint, whose fills are capped at sixty per position, which is what produced
   * replay curves that stopped partway; and it was never evicted.
   *
   * Passing the fills in makes it a pure function of its arguments. There is
   * nothing left to miss, go stale, or leak.
   */
  const cluster = [wallet, ...alongside.filter((w) => w !== wallet)];
  const held = replay;

  const inCluster = new Set(cluster);
  const mine = held.fills.filter((f) => f.wallet && inCluster.has(f.wallet));

  /**
   * The run-up is counted in BARS, not seconds.
   *
   * It was `leadSec`, defaulting to five minutes, which is less than one bar on
   * anything wider than a five-minute chart — so on a two-hour chart the lead
   * rounded away entirely and the replay opened on the wallet's first trade
   * with no context in front of it. A recording wants the token already in
   * motion before anyone does anything.
   *
   * Measured from the first TRADE rather than the first fill: tokens arriving
   * by transfer are not the moment the story starts, and a wallet that was
   * airdropped dust weeks earlier would otherwise begin its replay there.
   */
  const opening = mine.find((f) => f.kind !== "transfer") ?? mine[0];
  const firstTrade = opening?.ts ?? candles[0]?.t ?? 0;
  /**
   * Never before the first bar there is.
   *
   * The run-up is measured back from the wallet's first trade, and a zoomed
   * replay starts long after it — so without the floor the window opens at a
   * time the series does not reach, and every marker in the stretch it does
   * not draw is placed at a bar that does not exist.
   */
  const from = Math.max(
    Math.floor(firstTrade / held.interval) * held.interval -
      Math.max(leadSec, LEAD_BARS * held.interval),
    candles[0]?.t ?? 0,
  );
  const window = candles.filter((c) => c.t >= from);
  const trades = mine.filter((f) => f.ts >= from);
  const closes = new Map(window.map((c) => [c.t, c.c]));

  /**
   * The book is rebuilt here rather than carried.
   *
   * `PositionBook.replay` walks the fills and recomputes quantity, basis and
   * realized from scratch, so the only state it needs IS the fills. Every fill
   * goes under the SUBJECT's key because a cluster is one position: a transfer
   * between two wallets in it leaves one and enters the other, and booked
   * together those cancel exactly, which is what makes the combined curve
   * correct rather than a sum of two wrong ones.
   */
  const book = new PositionBook(Number.POSITIVE_INFINITY);
  for (const f of held.fills) {
    book.apply(mint, wallet, {
      ts: f.ts,
      isBuy: f.isBuy,
      base: f.base,
      usd: f.usd,
      kind: f.kind,
    });
  }

  return {
    candles: window,
    trades,
    points: book.replay(mint, wallet, closes, held.interval),
  };
}


/** Tokens this install has already reconstructed. See `builtTokens`. */
export async function replayable(): Promise<BuiltToken[]> {
  return galleryTokens();
}

/** Whether a mint has been indexed, without building anything to find out. */
export async function indexed(mint: string): Promise<boolean> {
  return (await tokenRow(mint)) !== null;
}

/**
 * What a request is ALLOWED to do with this mint, which is not the same as
 * what has been built for it.
 *
 * `indexed()` was doing double duty: the routes used it to decide whether a
 * request might proceed, so anything that put a row in the index also granted
 * permission to rebuild that mint from scratch. Once visitors can create rows
 * by replaying a wallet, that turns a ~15-credit request into a licence for a
 * ~55,000-credit one.
 *
 * So coverage decides which PATH serves a request, never whether the request
 * is permitted:
 *
 *   - any known mint may serve the wallet path
 *   - only `full` may serve the mint-only chart from cache
 *   - a mint-only request for anything else is a whole-life build, which is
 *     owner-only
 */
export async function coverageOf(mint: string): Promise<Coverage | null> {
  const row = await tokenRow(mint);
  if (!row) return null;
  return row.coverage ?? "full";
}

/** A linked wallet with its own complete PnL on this mint. */
export interface RelatedWallet extends Related {
  total: number;
  realized: number;
  unrealized: number;
  qty: number;
  boughtUsd: number;
  soldUsd: number;
  trades: number;
}

export interface RelatedReport extends Omit<WalletGraph, "linked"> {
  linked: RelatedWallet[];
}

/**
 * The wallets a wallet is operating with, and what each of them made.
 *
 * Optional and off the critical path: a replay never waits for it. Cached per
 * mint and wallet because a transfer graph is history — the edges that exist
 * today existed yesterday.
 *
 * Every linked wallet is then READ IN FULL, the same way a board candidate is,
 * so its figure is exact rather than inferred from the edge that found it. The
 * LINK is the inference; the money is not.
 */
export async function relatedWallets(
  mint: string,
  wallet: string,
  mayCompute = true,
): Promise<RelatedReport | "not computed" | null> {
  return priced(`related ${mint} ${wallet}`, () =>
    relatedWalletsInner(mint, wallet, mayCompute),
  );
}

async function relatedWalletsInner(
  mint: string,
  wallet: string,
  /**
   * Whether this caller may work out a graph that does not exist yet.
   *
   * False for a visitor on the hosted site: they see the graphs the owner
   * chose to compute, and asking about an uncomputed wallet says so rather
   * than reading a slice of its history to find out.
   */
  mayCompute = true,
): Promise<RelatedReport | "not computed" | null> {
  const key = `graph:${mint}:${wallet}`;
  const held = await loadBlob<RelatedReport>(key);
  if (held) return worthShowing(held);
  if (!mayCompute) return "not computed";

  const venue = await stage("venue", () => venueFor(mint));
  if (!venue) return null;

  const activity = await stage("subject", () => walletActivity(mint, wallet));
  if (activity.txs.length === 0) return null;

  const interval = pickInterval(
    Math.max(activity.last - activity.first, 0) + 300,
  );
  const pad = interval * MIN_CANDLES;
  const from = activity.first - Math.max(300, pad / 2);
  const to = Math.min(activity.last + Math.max(interval, pad / 2), nowSec());

  const sol = new SolPriceHistory();
  const drawn = await stage("candles", () =>
    series(venue, mint, from, to, interval, sol),
  );
  // The graph reads the subject's window, not the token's life.
  await remember(mint, interval, drawn.candles, "window");
  const priceAt = priceLookup(drawn.candles);

  const graph = await stage("graph", () =>
    walletGraph(mint, wallet, activity.txs, { from, to }, adapt),
  );

  /**
   * Read each linked wallet properly. Bounded, because this runs while someone
   * is waiting and the tail of the ranking is noise by construction.
   */
  const shortlist = graph.linked.slice(0, GRAPH_READ_LIMIT);
  const priced = await Promise.all(
    shortlist.map(async (related): Promise<RelatedWallet> => {
      const own = await walletActivity(mint, related.wallet);
      const fills = await walletFills(own.txs, mint, related.wallet, priceAt, sol);
      const book = new PositionBook(Number.POSITIVE_INFINITY);
      for (const f of fills) {
        book.apply(mint, related.wallet, {
          ts: f.ts,
          isBuy: f.isBuy,
          base: f.base,
          usd: f.usd,
          kind: f.kind,
        });
      }
      const row = book.leaderboard(mint, priceAt(nowSec()), 1, true).top[0];
      return {
        ...related,
        total: row?.total ?? 0,
        realized: row?.realized ?? 0,
        unrealized: row?.unrealized ?? 0,
        qty: row?.qty ?? 0,
        boughtUsd: row?.boughtUsd ?? 0,
        soldUsd: row?.soldUsd ?? 0,
        trades: row?.trades ?? 0,
      };
    }),
  );

  const report: RelatedReport = {
    ...graph,
    linked: priced.sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    builtAt: nowSec(),
  };
  await saveBlob(key, report);
  return worthShowing(report);
}

/**
 * Drop linked wallets that hold nothing and made nothing.
 *
 * They are real relationships — a wallet that funded the subject with SOL and
 * never touched the token is exactly that — but they add nothing to a PnL and
 * every row costs the reader attention. Filtered on the way OUT rather than
 * before caching, so the reasoning stays in the stored report.
 */
function worthShowing(report: RelatedReport): RelatedReport {
  return {
    ...report,
    linked: report.linked.filter((r) => Math.abs(r.total) >= 1 || r.qty > 0),
  };
}
