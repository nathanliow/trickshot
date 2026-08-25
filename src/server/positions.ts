/**
 * Per-token PnL: the leaderboard, and the replay curve behind it.
 *
 * Two accountings are kept side by side on purpose.
 *
 *   cash-flow   pnl = cash + qty × price. Pure sums, so it is order-
 *               independent and immune to replayed or out-of-order fills.
 *               This is the number the leaderboard ranks on.
 *
 *   avg-cost    splits that total into realized and unrealized. Order-
 *               dependent, so it can only be folded here in the worker where
 *               stream order is known.
 *
 * They must agree. `basisDrift` reports where they do not, which is how we
 * catch tokens arriving by transfer rather than by purchase — a wallet that
 * sells what it never bought has no cost basis, and would otherwise show up on
 * the board as a fabricated winner.
 */

export interface Fill {
  ts: number;
  isBuy: boolean;
  base: number;
  usd: number;
  /**
   * Whether money changed hands.
   *
   * A transfer moves tokens with no price attached — an airdrop, a bundler
   * distributing to its wallets, someone consolidating their own funds. It
   * must move `qty`, because the position is real and the chain says so, and
   * it must NOT create a cost basis, because none was paid. Booking transfers
   * as buys at the prevailing price is how a wallet that was given 32 million
   * tokens ends up on a leaderboard as its biggest winner.
   */
  kind?: "swap" | "transfer";
}

export interface Position {
  wallet: string;
  qty: number;
  /** Signed cash flow: negative when net spent. */
  cash: number;
  /** Cost basis of the currently held qty. */
  costBasis: number;
  realized: number;
  buys: number;
  sells: number;
  /**
   * Lifetime traded totals, kept as running sums rather than derived from
   * `fills` — that array is capped at MAX_FILLS_PER_POSITION, so a busy wallet
   * would silently lose the earliest half of its history.
   */
  boughtUsd: number;
  boughtBase: number;
  soldUsd: number;
  soldBase: number;
  firstTs: number;
  lastTs: number;
  /**
   * Tokens, and dollars, sold with no cost basis behind them.
   *
   * Summed rather than flagged. A single boolean made any unmatched sell
   * disqualifying however small, and small is the normal case: MEASURED, a
   * wallet up $487,000 was kept off the board because the first thing it ever
   * did on the mint was sell 503 tokens for $2.34. Airdrop dust, a bundler
   * distribution, a transfer in from another wallet — all of them trip it, and
   * none of them means the wallet's PnL is fiction.
   */
  unknownBase: number;
  unknownUsd: number;
  /**
   * Unpriced tokens the wallet STILL HOLDS, as opposed to `unknownBase`, which
   * is the lifetime total and never comes down.
   *
   * Both are needed and they answer different questions. The lifetime figure
   * says how much of this wallet's story is unexplained, which is the flag.
   * This one says how much of what it holds right now must be left out of the
   * mark — because marking a gift to market is how a wallet handed 32.2M
   * tokens ranks as the biggest winner on the board.
   */
  unknownHeld: number;
  fills: Fill[];
}

export interface PnlRow {
  wallet: string;
  /** A human name, when Helius knows one. See `identity.ts`. */
  name?: string;
  category?: string;
  qty: number;
  /** Lifetime USD in and out. */
  boughtUsd: number;
  soldUsd: number;
  /**
   * Size-weighted execution price per side, or 0 when that side never traded.
   * Multiply by supply for the average market cap they bought or sold at —
   * the client already knows supply, and this keeps the worker unit-agnostic.
   */
  avgBuyPrice: number;
  avgSellPrice: number;
  realized: number;
  unrealized: number;
  total: number;
  trades: number;
  /**
   * How long the wallet has been in this token, in seconds.
   *
   * First trade to last, or to NOW while it is still holding — a position
   * opened last week and never closed has been held for a week, not for the
   * few minutes it took to buy.
   */
  heldSec: number;
  unknownBasis: boolean;
  /**
   * Tokens held that were never bought, and what they would be worth.
   *
   * Deliberately NOT folded into `total`. The row stays on the board and the
   * reader gets to see both — "made $40,000, and also holds 32.2M tokens it
   * never paid for" is the honest sentence, where dropping the wallet outright
   * hid it and marking the gift inflated it.
   */
  unpricedBase: number;
  unpricedValue: number;
  /**
   * Tokens this wallet was ever HANDED, over its whole life.
   *
   * Distinct from `unpricedBase`, which is only what it still holds. A minter
   * that received the entire supply and passed it on holds nothing today, so
   * the held figure says nothing about it — this one says it moved 100% of the
   * token. That is what tells infrastructure apart from a trader.
   */
  receivedBase: number;
  /** |cash-flow total − (realized+unrealized)|. Should be ~0. */
  basisDrift: number;
}

export interface ReplayPoint {
  minute: number;
  qty: number;
  price: number;
  realized: number;
  unrealized: number;
  total: number;
  /** Cash in and out UP TO this point, so the replay can show them growing. */
  boughtUsd: number;
  soldUsd: number;
}

/**
 * Fills kept per wallet, for the replay.
 *
 * MEASURED, and this is where the memory actually goes: a position holding 2
 * fills is 400 bytes, one holding 500 is 48KB — 120x for history nothing reads.
 * The PnL figures do not depend on it (buys, sells and the traded totals are
 * running sums), so trimming this costs only the tail of a heavy wallet's
 * replay, and 60 fills is already more trades than a replay can legibly mark.
 */
const MAX_FILLS_PER_POSITION = Number(process.env.MAX_FILLS_PER_POSITION ?? 60);

/**
 * Wallets kept per token.
 *
 * Every wallet that trades gets a position, and a position with a full fill
 * ring is ~20KB — MEASURED at 592 wallets on one ordinary token, so a launch
 * that actually runs would carry tens of thousands and hundreds of megabytes
 * with it.
 *
 * What the product asks of this data is the two ENDS: who made the most and
 * who lost the most. The middle — a wallet that bought $9 and sold $9 — is
 * never read. So the book is bounded and the middle is what gets dropped.
 *
 * Four hundred rather than twenty, even though only ten are displayed. The
 * ranking is not static: a wallet sitting fortieth becomes first the moment it
 * sells, and an evicted wallet loses its cost basis for good — it comes back as
 * `unknownBasis` and can never rank again. Keeping only what is currently
 * displayed would produce "the top ten of the twenty we happened to keep".
 * MEASURED at ~600 bytes a position once the fill ring is bounded, 400 wallets
 * is a quarter of a megabyte per token.
 */
const MAX_WALLETS_PER_MINT = Number(process.env.MAX_WALLETS_PER_MINT ?? 400);

/**
 * How much of a wallet may be unaccounted for before its PnL is not worth
 * showing.
 *
 * A ratio, not a flag. Below this the unexplained tokens move the total by less
 * than the noise already in it; above it, the number on screen is mostly a
 * guess about where the tokens came from.
 */
const UNKNOWN_BASIS_RATIO = Number(process.env.UNKNOWN_BASIS_RATIO ?? 0.05);

/** See `PnlRow.heldSec`. */
function heldFor(p: Position): number {
  const until = p.qty > 0 ? Math.floor(Date.now() / 1000) : p.lastTs;
  return Math.max(until - p.firstTs, 0);
}

function unknownBasis(p: Position): boolean {
  /**
   * Measured in TOKENS as well as dollars.
   *
   * The dollar test only sees tokens sold without a basis. A wallet that was
   * handed its whole position and has not sold yet has no unexplained dollars
   * at all, and its unrealized "profit" is the entire mark-to-market value of
   * a gift. MEASURED on this token's number-one wallet: 32.2M tokens in by
   * transfer, 0.37 SOL ever spent, ranked at +$4.66M.
   */
  const position = p.qty + p.soldBase;
  if (position > 0 && p.unknownBase / position > UNKNOWN_BASIS_RATIO) return true;
  const flow = Math.max(p.boughtUsd, p.soldUsd);
  return flow <= 0 ? p.unknownUsd > 0 : p.unknownUsd / flow > UNKNOWN_BASIS_RATIO;
}
/** Trim to this many, so the sort runs occasionally rather than per fill. */
const TRIM_TO = Math.floor(MAX_WALLETS_PER_MINT * 0.75);

export class PositionBook {
  /** mint -> wallet -> position */
  private readonly byMint = new Map<string, Map<string, Position>>();

  /**
   * The default bound suits a book holding hundreds of wallets. A book holding
   * ONE — the wallet being replayed — should keep everything: the replay curve
   * is drawn from these fills while the headline PnL is drawn from running
   * sums, so truncating them made the curve stop moving partway through while
   * the number beside it carried on.
   */
  constructor(private readonly maxFills: number = MAX_FILLS_PER_POSITION) {}

  apply(
    mint: string,
    wallet: string,
    fill: Fill,
  ): void {
    let wallets = this.byMint.get(mint);
    if (!wallets) {
      wallets = new Map();
      this.byMint.set(mint, wallets);
    }

    let p = wallets.get(wallet);
    if (!p) {
      p = {
        wallet,
        qty: 0,
        cash: 0,
        costBasis: 0,
        realized: 0,
        buys: 0,
        sells: 0,
        boughtUsd: 0,
        boughtBase: 0,
        soldUsd: 0,
        soldBase: 0,
        firstTs: fill.ts,
        lastTs: fill.ts,
        unknownBase: 0,
        unknownUsd: 0,
        unknownHeld: 0,
        fills: [],
      };
      wallets.set(wallet, p);
    }

    p.lastTs = Math.max(p.lastTs, fill.ts);
    if (p.fills.length < this.maxFills) p.fills.push(fill);
    // The fill's own execution price: the freshest mark available here, and
    // trimming is the only thing that needs one.
    if (wallets.size > MAX_WALLETS_PER_MINT) {
      this.trim(wallets, fill.base > 0 ? fill.usd / fill.base : 0);
    }

    if (fill.kind === "transfer") {
      // Tokens in with no basis, or out with no proceeds. Counted in the
      // position and excluded from every price-derived figure.
      if (fill.isBuy) {
        p.qty += fill.base;
        p.unknownBase += fill.base;
        p.unknownHeld += fill.base;
      } else {
        const sent = Math.min(fill.base, p.qty);
        if (sent > 0 && p.qty > 0) {
          /**
           * Tokens leaving are booked as an EXIT at the prevailing price.
           *
           * Nothing on chain says what happened next — a deposit to an
           * exchange, a move to another wallet, a burn all look identical —
           * and the two defensible readings are "we do not know" and "assume
           * they sold". This is the second: an exchange deposit is
           * overwhelmingly a prelude to selling, and treating it as nothing
           * left the buy standing as a pure loss. MEASURED, that is where the
           * whole board went wrong: `A3ZcnXcC` bought $26m of TRUMP, sent
           * every token to an exchange, and read as a $26m loser.
           *
           * The cost of this choice, and it is real: if the tokens went to
           * ANOTHER WALLET THE SAME PERSON OWNS, this books a sale that never
           * happened — and if that wallet is also on the board, the position
           * is counted twice. `graph.ts` already finds linked wallets; netting
           * them out before this runs is the upgrade path.
           *
           * ponytail: assumes an exchange deposit is a sale. Ceiling is
           * wallet-to-wallet moves by one owner; fix by merging linked
           * wallets from `relatedWallets` before folding fills.
           */
          const avgCost = p.costBasis / p.qty;
          const proceeds = fill.usd * (sent / fill.base);
          // Handed-over tokens leaving again are not profit; same split the
          // sell path uses.
          const giftSent = (p.unknownHeld / p.qty) * sent;
          const giftUsd = giftSent > 0 ? proceeds * (giftSent / sent) : 0;
          p.unknownUsd += giftUsd;
          p.cash += proceeds;
          p.realized += proceeds - avgCost * sent - giftUsd;
          p.unknownHeld -= giftSent;
          p.costBasis -= avgCost * sent;
          p.qty -= sent;
          /**
           * `sells`, `soldUsd` and `soldBase` are deliberately NOT touched.
           * Those describe trades the wallet actually made, and they feed the
           * trade count and the average sell price on the board. An assumed
           * exit is not a fill and must not appear as one.
           */
        }
      }
      return;
    }

    if (fill.isBuy) {
      p.qty += fill.base;
      p.cash -= fill.usd;
      p.costBasis += fill.usd;
      p.buys += 1;
      p.boughtUsd += fill.usd;
      p.boughtBase += fill.base;
      return;
    }

    p.cash += fill.usd;
    p.sells += 1;
    p.soldUsd += fill.usd;
    p.soldBase += fill.base;

    // Weighted-average realisation over the portion we can account for.
    const sold = Math.min(fill.base, p.qty);
    if (sold > 0) {
      const avgCost = p.costBasis / p.qty;
      const proceeds = fill.usd * (sold / fill.base);
      /**
       * The share of this sell that was never paid for, and its proceeds.
       *
       * The `unmatched` branch below only fires when a sell EXCEEDS the
       * position — a wallet selling out of thin air. It cannot see the far
       * more common shape: tokens arrive as a tracked transfer first, so `qty`
       * is positive, `sold` covers the whole fill, and the proceeds book as
       * pure profit against a zero basis. MEASURED on MELANIA, `BgKsDTAT`
       * bought nothing, sold $45,232,141, and ranked fifth on the board; the
       * three above it sold three to four times more than they ever bought.
       *
       * Taken off `realized` as well as recorded, so the two accountings still
       * agree — `basisDrift` is only worth reading if both sides exclude the
       * same money.
       */
      const giftSold = (p.unknownHeld / p.qty) * sold;
      const giftUsd = giftSold > 0 ? proceeds * (giftSold / sold) : 0;
      p.unknownUsd += giftUsd;
      p.realized += proceeds - avgCost * sold - giftUsd;
      // Selling draws on the same proportional mix a transfer out does.
      p.unknownHeld -= giftSold;
      p.costBasis -= avgCost * sold;
      p.qty -= sold;
    }
    const unmatched = fill.base - sold;
    if (unmatched > 1e-9) {
      // Sold tokens that never arrived as a tracked buy: airdrop, dev alt,
      // bundler distribution. Proceeds are pure profit but the basis is a
      // fiction, so record how much of the wallet is fiction rather than
      // condemning the whole of it.
      p.unknownBase += unmatched;
      p.unknownUsd += fill.usd * (unmatched / fill.base);
    }
  }

  /** Ranked by cash-flow total PnL at the given price. */
  leaderboard(
    mint: string,
    price: number,
    limit = 10,
    includeUnknownBasis = false,
  ): { top: PnlRow[]; bottom: PnlRow[]; wallets: number } {
    const wallets = this.byMint.get(mint);
    if (!wallets) return { top: [], bottom: [], wallets: 0 };

    const rows: PnlRow[] = [];
    for (const p of wallets.values()) {
      const unknown = unknownBasis(p);
      /**
       * Kept on the board, and marked only on what it actually paid for.
       *
       * This used to `continue` — and on a token where people move size
       * through exchanges that threw most of the board away: MEASURED on
       * TRUMP, 171 of 195 positions were discarded by this line and the
       * "biggest winners" list came back with fifteen rows. The wallets it
       * removed were disproportionately the ones worth showing, because a
       * trader big enough to matter is a trader who has touched a CEX.
       *
       * The filter's own reason still stands: a wallet handed 32.2M tokens
       * must not rank on the market value of the gift. So the gift is excluded
       * from the MARK instead of the wallet being excluded from the board.
       * `cash` is already pure — transfers never touch it — so a wallet that
       * bought nothing and sold nothing now ranks at ~$0 rather than at
       * +$4.66M, and one that genuinely traded keeps its real number.
       */
      const priced = Math.max(0, p.qty - p.unknownHeld);
      const unrealized = priced * price - p.costBasis;
      /**
       * `unknownUsd` comes back OUT of the cash flow.
       *
       * `cash` counts every dollar a sell brought in, including sells of
       * tokens that were never bought — and those proceeds are not profit,
       * they are the value of a gift being realised. MEASURED on MELANIA,
       * `BgKsDTAT` bought nothing, sold $45,232,141, and ranked fifth.
       *
       * Excluding the gift from the MARK, which is what `priced` does, cannot
       * catch this: by the time the board is drawn the wallet holds nothing to
       * mark. The two together are what make a handed-over position rank at
       * zero whether it is still held or already sold.
       */
      const total = p.cash - p.unknownUsd + priced * price;
      if (unknown && !includeUnknownBasis && total === 0 && p.realized === 0) {
        // Nothing bought, nothing sold, only tokens handed over. No story.
        continue;
      }
      rows.push({
        wallet: p.wallet,
        qty: p.qty,
        boughtUsd: p.boughtUsd,
        soldUsd: p.soldUsd,
        avgBuyPrice: p.boughtBase > 0 ? p.boughtUsd / p.boughtBase : 0,
        avgSellPrice: p.soldBase > 0 ? p.soldUsd / p.soldBase : 0,
        realized: p.realized,
        unrealized,
        total,
        trades: p.buys + p.sells,
        heldSec: heldFor(p),
        unknownBasis: unknown,
        unpricedBase: p.unknownHeld,
        unpricedValue: p.unknownHeld * price,
        receivedBase: p.unknownBase,
        basisDrift: Math.abs(total - (p.realized + unrealized)),
      });
    }

    rows.sort((a, b) => b.total - a.total);
    return {
      top: rows.slice(0, limit),
      bottom: rows.slice(-limit).reverse(),
      wallets: rows.length,
    };
  }

  /** Every wallet with an open position, largest first. */
  openPositions(mint: string, price: number, limit = 100): PnlRow[] {
    const wallets = this.byMint.get(mint);
    if (!wallets) return [];
    return [...wallets.values()]
      .filter((p) => p.qty > 0)
      .map((p) => ({
        wallet: p.wallet,
        qty: p.qty,
        boughtUsd: p.boughtUsd,
        soldUsd: p.soldUsd,
        avgBuyPrice: p.boughtBase > 0 ? p.boughtUsd / p.boughtBase : 0,
        avgSellPrice: p.soldBase > 0 ? p.soldUsd / p.soldBase : 0,
        realized: p.realized,
        unrealized: Math.max(0, p.qty - p.unknownHeld) * price - p.costBasis,
        total: p.cash + Math.max(0, p.qty - p.unknownHeld) * price,
        trades: p.buys + p.sells,
        heldSec: heldFor(p),
        unknownBasis: unknownBasis(p),
        unpricedBase: p.unknownHeld,
        unpricedValue: p.unknownHeld * price,
        receivedBase: p.unknownBase,
        basisDrift: 0,
      }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, limit);
  }

  /**
   * Minute-by-minute PnL for one wallet on one token.
   *
   * Re-folds the wallet's fills against the token's 1m closes, so realized and
   * unrealized are both correct as of each minute rather than back-projected
   * from the current position.
   */
  /**
   * Drop the wallets nobody will ever ask about.
   *
   * Ranked by how likely a row is to be READ: anything still holding stays,
   * because an open position is what "who is in this token" means and its PnL
   * is still moving. Everything closed is ranked by the size of what it moved
   * — `cash`, the signed net flow — so the biggest winners and the biggest
   * losers are both at the top of that ordering and the noise is at the bottom.
   *
   * A trimmed wallet that trades again starts fresh with `unknownBasis`, so it
   * is excluded from the rankings rather than appearing with a fabricated cost
   * basis. That is the cost of the bound, and it only ever lands on wallets
   * that were too small to rank in the first place.
   */
  private trim(wallets: Map<string, Position>, price: number): void {
    /**
     * Ranked by what the wallet is WORTH, not only by what it has moved.
     *
     * Cash alone evicts the most interesting wallet on the board: someone who
     * spent $50 and is riding it to a hundred times that has tiny cash flow
     * until the moment they sell. Adding the mark-to-market value of what they
     * still hold keeps them, which is the whole reason anyone reads this table.
     */
    const worth = (p: Position) => Math.abs(p.cash) + p.qty * price;
    const ranked = [...wallets.values()].sort((a, b) => worth(b) - worth(a));
    for (const p of ranked.slice(TRIM_TO)) wallets.delete(p.wallet);
  }

  /** A wallet's own fills on one token, oldest first. */
  fillsFor(mint: string, wallet: string): Fill[] {
    const p = this.byMint.get(mint)?.get(wallet);
    return p ? [...p.fills].sort((a, b) => a.ts - b.ts) : [];
  }

  replay(
    mint: string,
    wallet: string,
    closesByBucket: Map<number, number>,
    /** Bucket width. 60 when walking minutes, 15 for the fine-grained replay. */
    intervalSec = 60,
  ): ReplayPoint[] {
    const p = this.byMint.get(mint)?.get(wallet);
    if (!p || p.fills.length === 0) return [];

    const minutes = [...closesByBucket.keys()].sort((a, b) => a - b);
    if (minutes.length === 0) return [];

    const fills = [...p.fills].sort((a, b) => a.ts - b.ts);
    let i = 0;
    let qty = 0;
    let costBasis = 0;
    let realized = 0;
    let lastPrice = 0;
    // Running totals rather than the position's lifetime figures: the replay
    // is a moment in time, so what was spent and taken must be as of that bar.
    let boughtUsd = 0;
    let soldUsd = 0;
    const out: ReplayPoint[] = [];

    for (let k = 0; k < minutes.length; k += 1) {
      const minute = minutes[k] as number;
      /**
       * A bucket ends where the NEXT one starts, not a fixed width later.
       *
       * The two are the same thing on an evenly spaced chart and stop being
       * the same the moment a finer section is spliced into a coarser one,
       * where a two-hour bar can be followed by a one-minute bar. Taking the
       * end from the neighbour books every fill exactly once whatever the
       * widths are; adding a constant would sweep the next 119 minutes of
       * fills into the bar before them. The width is still needed for the
       * last bucket, which has no neighbour.
       */
      const cutoff = minutes[k + 1] ?? minute + intervalSec;
      while (i < fills.length && fills[i]!.ts < cutoff) {
        const f = fills[i]!;
        /**
         * Transfers move tokens, not money — exactly as `apply` books them.
         *
         * Without this branch a transfer is walked as an ordinary fill with
         * `usd: 0`, and both directions lie: tokens arriving add quantity
         * against no basis, so `qty * price - costBasis` reports their whole
         * market value as gain, and tokens leaving book `0 - avgCost * sent`
         * as a realized LOSS the size of the basis. The board already refuses
         * to price these — see `unknownBase` — and the replay curve is the one
         * place that still did.
         */
        if (f.kind === "transfer") {
          if (f.isBuy) {
            qty += f.base;
          } else {
            const sent = Math.min(f.base, qty);
            if (sent > 0 && qty > 0) {
              costBasis -= (costBasis / qty) * sent;
              qty -= sent;
            }
          }
          i += 1;
          continue;
        }
        if (f.isBuy) {
          qty += f.base;
          costBasis += f.usd;
          boughtUsd += f.usd;
        } else {
          soldUsd += f.usd;
          const sold = Math.min(f.base, qty);
          if (sold > 0 && qty > 0) {
            const avgCost = costBasis / qty;
            const proceeds = f.usd * (sold / f.base);
            realized += proceeds - avgCost * sold;
            costBasis -= avgCost * sold;
            qty -= sold;
          }
        }
        i += 1;
      }

      const price = closesByBucket.get(minute) ?? lastPrice;
      lastPrice = price;
      const unrealized = qty * price - costBasis;
      out.push({
        minute,
        qty,
        price,
        realized,
        unrealized,
        total: realized + unrealized,
        boughtUsd,
        soldUsd,
      });
    }

    return out;
  }

  /**
   * MEASURED at 133.7 MB of a 178 MB snapshot — 75% of it — across 221,454
   * wallets and 820,364 stored fills. The median token has 13 wallets and the
   * largest has 4,688, so the weight is a long tail of one-trade wallets that
   * no view ever reads: the leaderboard shows 10 each way and openPositions
   * caps at 100.
   *
   * So the tail is dropped rather than persisted. Wallets still holding rank
   * first, then by cash flow, which is what the board orders by. `fills` are
   * kept only for the top slice — they are half the remaining bytes and only
   * feed the per-wallet replay chart, which is opened for a named wallet, not
   * for all 4,688 of them.
   */
  /**
   * Persisted positions.
   *
   * `maxPerMint` matches the live cap on purpose. It used to be 100 against a
   * live book of 400, so every restart deleted three quarters of the field —
   * MEASURED, 4 of 18 tracked tokens were over 100 wallets, and their all-time
   * rankings were being drawn from whatever survived the last deploy. Fills are
   * still kept for only the first few, since those are for the replay and cost
   * far more than the figures do.
   */
  toJSON(keep?: Set<string>, maxPerMint = 400, withFills = 20): [string, Position[]][] {
    return [...this.byMint]
      .filter(([mint]) => !keep || keep.has(mint))
      .map(([mint, w]) => {
        const ranked = [...w.values()].sort((a, b) => {
          const open = Number(b.qty > 0) - Number(a.qty > 0);
          return open !== 0 ? open : Math.abs(b.cash) - Math.abs(a.cash);
        });
        const kept = ranked.slice(0, maxPerMint).map((p, i) =>
          i < withFills ? p : { ...p, fills: [] },
        );
        return [mint, kept] as [string, Position[]];
      });
  }

  load(rows: [string, Position[]][]): void {
    for (const [mint, positions] of rows) {
      this.byMint.set(
        mint,
        new Map(
          positions.map((p) => [
            p.wallet,
            // Positions written before the traded totals existed have no such
            // fields; left undefined they propagate NaN through every average
            // computed from them. Their history is genuinely unknown, so they
            // start at zero and rebuild from subsequent fills.
            {
              ...p,
              boughtUsd: p.boughtUsd ?? 0,
              boughtBase: p.boughtBase ?? 0,
              soldUsd: p.soldUsd ?? 0,
              soldBase: p.soldBase ?? 0,
            },
          ]),
        ),
      );
    }
  }

  /**
   * Lifetime buy/sell flow per wallet, keyed by wallet.
   *
   * The holders view is a balance snapshot from the RPC, which knows nothing
   * about how those tokens were acquired. Joining this on gives each holder
   * the same bought/sold columns the traders board has — for wallets we have
   * seen trade; a wallet that only ever received a transfer has no entry.
   */
  flows(mint: string): Map<string, {
    boughtUsd: number;
    soldUsd: number;
    avgBuyPrice: number;
    avgSellPrice: number;
  }> {
    const wallets = this.byMint.get(mint);
    if (!wallets) return new Map();
    const out = new Map<string, {
      boughtUsd: number;
      soldUsd: number;
      avgBuyPrice: number;
      avgSellPrice: number;
    }>();
    for (const p of wallets.values()) {
      out.set(p.wallet, {
        boughtUsd: p.boughtUsd,
        soldUsd: p.soldUsd,
        avgBuyPrice: p.boughtBase > 0 ? p.boughtUsd / p.boughtBase : 0,
        avgSellPrice: p.soldBase > 0 ? p.soldUsd / p.soldBase : 0,
      });
    }
    return out;
  }

  /** Called when a token is evicted from tracking. */
  drop(mint: string): void {
    this.byMint.delete(mint);
  }

  get tokens(): number {
    return this.byMint.size;
  }

  get positions(): number {
    let n = 0;
    for (const w of this.byMint.values()) n += w.size;
    return n;
  }

  /**
   * Every position on a mint, in a shape that survives a round trip to storage.
   *
   * The fill ring is deliberately left out: it is the only unbounded part of a
   * position and nothing that reads a restored book needs it. A replay is
   * always built from the wallet's own freshly-read history, never from here.
   */
  snapshot(mint: string): Record<string, StoredPosition> {
    const wallets = this.byMint.get(mint);
    if (!wallets) return {};
    const out: Record<string, StoredPosition> = {};
    for (const [address, p] of wallets) {
      const { wallet, fills, ...rest } = p;
      void wallet;
      void fills;
      out[address] = rest;
    }
    return out;
  }

  /**
   * Put a stored book back, so an update can carry on from where it stopped.
   *
   * This is what makes refreshing a token cheap. Average-cost accounting is
   * order-dependent, so without the position in hand the whole history has to
   * be read again to price one new sell; with it, only what happened since the
   * last build matters.
   */
  restore(mint: string, stored: Record<string, StoredPosition>): void {
    const wallets = new Map<string, Position>();
    for (const [address, p] of Object.entries(stored)) {
      wallets.set(address, {
        wallet: address,
        ...p,
        /**
         * Defaulted, because a book stored before this field existed has no
         * value for it — and `unknownHeld / qty` on an undefined is NaN, which
         * propagates silently through the mark and puts NaN on the board for
         * every token indexed before this change. Falling back to the lifetime
         * figure is the conservative read: it can only understate the mark, and
         * it converges on the truth the moment the wallet is read again.
         */
        unknownHeld: p.unknownHeld ?? p.unknownBase ?? 0,
        fills: [],
      });
    }
    this.byMint.set(mint, wallets);
  }

}

/** A position without its fill ring. See `PositionBook.snapshot`. */
export type StoredPosition = Omit<Position, "wallet" | "fills">;
