/**
 * A wallet's position in one token, minute by minute.
 *
 * The worker walks that wallet's fills in order and books average-cost PnL:
 * `realized` moves only on a sell, `unrealized` is the open position marked to
 * that minute's close, and `total` is what the wallet is up or down overall.
 */
export interface ReplayPoint {
  minute: number;
  qty: number;
  price: number;
  realized: number;
  unrealized: number;
  total: number;
  /** Cash in and out up to this point in the replay, not lifetime. */
  boughtUsd: number;
  soldUsd: number;
}

/** One bar of the token's price. Its width is `Replay.interval`. */
export interface ReplayCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** One of the wallet's own fills, marked on the chart. */
export interface ReplayTrade {
  ts: number;
  /** Which wallet made it, when a cluster is being replayed. */
  wallet?: string | null;
  isBuy: boolean;
  base: number;
  usd: number;
  /** "transfer" when tokens moved with no money against them. */
  kind?: "swap" | "transfer";
}

/**
 * A token and one wallet's trades on it, as the chart consumes them.
 *
 * Reconstructed from the chain on demand — there is no live feed behind this
 * app, so every replay is history, however recent.
 */
export interface Replay {
  interval: number;
  /** Circulating supply. Price x supply is the market cap the chart draws. */
  supply: number;
  candles: ReplayCandle[];
  trades: ReplayTrade[];
  points: ReplayPoint[];
  /**
   * The stretch drawn at a finer width, when one was asked for. Its presence
   * means `candles` is NOT evenly spaced — see `barAt`.
   */
  zoom?: { from: number; to: number; interval: number };
  /** The stretch a section may be picked from, when the feature is on. */
  zoomable?: { from: number; to: number; interval: number };
}

/**
 * Fine bars one zoom section may hold. Mirrors ZOOM_MAX_BARS on the
 * server, which is the one that actually refuses; this only greys the button
 * out rather than letting someone press it and get the coarse chart back.
 */
export const ZOOM_MAX_BARS = 4_000;

/**
 * The index of the bar a moment falls in, FOUND rather than computed.
 *
 * `Math.floor(ts / interval)` is only a bar index while every bar is the same
 * width, and a chart with a zoomed section spliced into it has two widths in
 * one series. Every place that marks a trade on a bar goes through here, so
 * none of them can quietly assume the even spacing that used to hold.
 *
 * Returns -1 for a moment before the first bar.
 */
export function barAt(candles: { t: number }[], ts: number): number {
  if (candles.length === 0) return -1;
  if (ts < (candles[0] as { t: number }).t) return -1;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((candles[mid] as { t: number }).t <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A wallet's standing on a reconstructed token. */
export interface HistoryTrader {
  wallet: string;
  /** A human name, when Helius knows one. */
  name?: string;
  category?: string;
  total: number;
  realized: number;
  unrealized: number;
  boughtUsd: number;
  soldUsd: number;
  trades: number;
  qty: number;
  /** First trade to last, or to now while still holding, in seconds. */
  heldSec?: number;
}

/** Where a token sits in the indexing queue. See `/api/jobs`. */
export interface JobState {
  mint: string;
  status: "none" | "queued" | "building" | "done" | "failed";
  ahead?: number;
  requests?: number;
  /** Seconds the build itself takes, once it starts. Not the wait. */
  buildSeconds?: number;
  error?: string;
}

export async function fetchJob(mint: string): Promise<JobState | null> {
  try {
    const res = await fetch(`/api/jobs?mint=${mint}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as JobState;
  } catch {
    return null;
  }
}

export interface TokenHistory {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  candles: ReplayCandle[];
  supply: number;
  /** Bar width in seconds. 15s for a launch, hours for a month-old token. */
  interval: number;
  fills: number;
  transactions: number;
  /** Swaps on the charted book over its whole life. */
  swaps?: number;
  /** The pool the chart was drawn from. */
  venue?: string;
  /** True when every swap in the window was read rather than sampled. */
  exact?: boolean;
  /** True when the named wallet has more history than was read. */
  partial?: boolean;
  /** "window" is one wallet's slice and has no trader board. */
  coverage?: "window" | "full";
  /**
   * The stretch of this chart drawn at a finer bar width, when one was asked
   * for. Bars inside it are `zoom.interval` wide and the rest are `interval`,
   * in one series — so nothing may bucket by dividing a timestamp.
   */
  zoom?: { from: number; to: number; interval: number };
  /** The stretch a zoom section may be picked from. See `zoomFor`. */
  zoomable?: { from: number; to: number; interval: number };
  firstTs: number;
  lastTs: number;
  /** Present only when a wallet was named. */
  wallet?: string;
  walletName?: string;
  /** Every wallet in the replay, when more than one was asked for. */
  cluster?: string[];
  trades?: ReplayTrade[];
  points?: ReplayPoint[];
  error?: string;
  /**
   * Set when the token was too expensive to draw and has been queued instead.
   *
   * `error` still carries a sentence for anywhere that only shows one; these
   * are what turn it from a refusal into a wait somebody can watch.
   */
  queued?: boolean;
  status?: JobState["status"];
  ahead?: number;
  buildSeconds?: number;
  /**
   * The site is done building for the day; this is not a fault.
   *
   * Carried on the refusal itself so the page can raise the banner the moment
   * it happens, without polling a status endpoint for a thing that changes
   * once a day.
   */
  limited?: boolean;
}

/** Who made and lost the most. Fetched separately; see `/api/board`. */
export interface TraderBoard {
  top: HistoryTrader[];
  bottom: HistoryTrader[];
  wallets: number;
  truncated: boolean;
  /** When the ranked wallets were last read, unix seconds. */
  builtAt?: number;
  /** The mark every open position is valued at. */
  price?: number;
  error?: string;
}

/**
 * Rebuild a token from the chain.
 *
 * Slow the first time — the chart is drawn from windows read across the
 * token's whole life — and served from the cache after that, since the bars
 * behind the newest one can never change.
 */
export async function fetchHistory(
  mint: string,
  wallet?: string,
  lead = 300,
  /** Wallets replayed as one position with `wallet`. */
  alongside: string[] = [],
  /** The stretch to draw at the finer bar width. See `TokenHistory.zoomable`. */
  section?: { from: number; to: number },
): Promise<TokenHistory | null> {
  const query = new URLSearchParams({ mint, lead: String(lead) });
  if (wallet) query.set("wallet", wallet);
  if (alongside.length > 0) query.set("with", alongside.join(","));
  if (section) {
    query.set("zoomFrom", String(section.from));
    query.set("zoomTo", String(section.to));
  }
  const res = await fetch(`/api/history?${query}`, { cache: "no-store" });
  const body = (await res.json()) as TokenHistory;
  if (!res.ok) return { ...body, error: body.error ?? `error ${res.status}` };
  return body;
}

/**
 * The trader board, which is the slow half.
 *
 * Fetched on its own so the chart is not held behind it: every wallet ranked
 * here has its complete history read back, which takes an order of magnitude
 * longer than drawing the chart does.
 */
export async function fetchBoard(
  mint: string,
  /** Read every ranked wallet's new transactions before ranking. Slow. */
  update = false,
): Promise<TraderBoard | null> {
  const query = new URLSearchParams({ mint });
  if (update) query.set("update", "1");
  const res = await fetch(`/api/board?${query}`, { cache: "no-store" });
  const body = (await res.json()) as TraderBoard;
  if (!res.ok) return { ...body, error: body.error ?? `error ${res.status}` };
  return body;
}

/** A token this install has already reconstructed. */
export interface BuiltToken {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  interval: number;
  bars: number;
  firstTs: number;
  lastTs: number;
  swaps: number;
  builtAt: number;
}

/**
 * What has already been built.
 *
 * There is no list of every replayable token — it is any Solana mint. This is
 * the useful subset: the ones already reconstructed, which redraw from cache.
 */
export async function fetchBuiltTokens(): Promise<BuiltToken[]> {
  try {
    const res = await fetch("/api/tokens", { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { tokens?: BuiltToken[] }).tokens ?? [];
  } catch {
    return [];
  }
}

/** One token a wallet has traded, as `/api/wallet` reports it. */
export interface WalletToken {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  /** Raw base units still held; zero means the position was closed. */
  balance: number;
  decimals: number;
  /** What the remaining balance is worth, when the token has a market. */
  valueUsd: number;
  held: boolean;
  /** Holding a full balance of something with no market — an airdrop. */
  likelySpam: boolean;
  /** Whether anything has been built for it yet. */
  indexed: boolean;
  /** "full" is a whole-life chart; "window" is one wallet's slice. */
  coverage: "window" | "full" | null;
  /** Set when the worker already has this token in hand. */
  job: "queued" | "building" | null;
}

export interface WalletTokens {
  wallet: string;
  name?: string;
  /** New tokens this visitor may still build today. */
  builds?: { used: number; limit: number };
  /** Token accounts looked at. */
  scanned: number;
  /** Rows set aside as airdrops, so the page can offer to show them. */
  hidden: number;
  /** True when the wallet holds more than was read. */
  truncated: boolean;
  tokens: WalletToken[];
  /** Nothing here can be built today; rows that are ready still replay. */
  limited?: boolean;
  error?: string;
}

/**
 * Every token a wallet has traded.
 *
 * The other direction from everything else here: no mint required, because the
 * thing most people want is their own trades and nobody has a mint to hand for
 * that. Enumerating is cheap — parsed transfers, a hundred to a page — and
 * builds nothing; each row says whether it is ready to replay.
 *
 * Read from the wallet's token accounts rather than its transfers, which is
 * what makes it immune to a high-frequency leg: a wallet moving USDC a
 * thousand times an hour would otherwise spend the whole budget before
 * reaching a single trade.
 */
export async function fetchWalletTokens(
  address: string,
  pages?: number,
  /** Include the airdrop tail, which is hidden by default. */
  spam = false,
): Promise<WalletTokens | null> {
  const query = new URLSearchParams({ address });
  if (pages) query.set("pages", String(pages));
  if (spam) query.set("spam", "1");
  const res = await fetch(`/api/wallet?${query}`, { cache: "no-store" });
  const body = (await res.json()) as WalletTokens;
  if (!res.ok) return { ...body, error: body.error ?? `error ${res.status}` };
  return body;
}

/** A wallet the subject moved this token, or real money, with. */
export interface RelatedWallet {
  wallet: string;
  name?: string;
  category?: string;
  kind: "linked" | "infrastructure" | "ephemeral" | "incidental";
  /** Plain sentences behind the classification. */
  why: string[];
  tokensFromSubject: number;
  tokensToSubject: number;
  solFromSubject: number;
  solToSubject: number;
  transfers: number;
  total: number;
  realized: number;
  unrealized: number;
  qty: number;
  trades: number;
}

export interface RelatedReport {
  mint: string;
  wallet: string;
  linked: RelatedWallet[];
  dismissed: RelatedWallet[];
  builtAt: number;
  error?: string;
}

/**
 * The wallets a wallet appears to be operating with.
 *
 * Opt-in: it reads a slice of the subject's non-token history to find funding
 * legs, then reads every candidate it keeps, so it is never on the path of a
 * replay. The links are inference; each carries its evidence.
 */
export async function fetchRelated(
  mint: string,
  wallet: string,
): Promise<RelatedReport | null> {
  const query = new URLSearchParams({ mint, wallet });
  const res = await fetch(`/api/related?${query}`, { cache: "no-store" });
  const body = (await res.json()) as RelatedReport;
  if (!res.ok) return { ...body, error: body.error ?? `error ${res.status}` };
  return body;
}
