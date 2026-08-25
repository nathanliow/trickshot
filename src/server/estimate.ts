import { EXACT_BUCKET, EXACT_MAX, SUBS } from "./candles";
import { countSwaps } from "./density";
import type { Venue } from "./pool";

/**
 * What a window will cost to draw, worked out before drawing it.
 *
 * The old order was: attempt, spend up to the ceiling, discover it was too
 * much, throw away everything bought. MEASURED on one wallet, that was 4,342
 * credits to learn a single fact — and the fact was already available for
 * about forty.
 *
 * Cost is not mysterious. It is bars times the cost of a bar, and a bar costs
 * one read if it can be read exactly and about seventeen if it has to be
 * sampled. Bars come from the window and the interval, both known. Whether
 * bars sample comes from how many swaps are in the window, and SIGNATURES
 * answer that: ten credits per thousand, no transactions fetched.
 *
 * MEASURED against the builds it predicts: 63,300 estimated against 62,603 and
 * 33,700 actual on two runs of the same window. Deliberately at the pessimistic
 * end of that spread.
 */

/** Credits for one windowed read, whatever it returns. See `meter.ts`. */
const PER_READ = 10;
/**
 * Reads a sampled bar actually costs, MEASURED rather than derived.
 *
 * `SUBS + 1` is the arithmetic — eight sub-windows and a read for the true
 * close — and it is about half the truth. A bar first spends one read at the
 * exact-bucket limit to find out whether it can be read whole, escalates to
 * the sub-windows when that comes back full, and the builder then re-sweeps
 * buckets that came back empty against a density that says they should not
 * have. MEASURED on a 370-bar window: 6,192 reads, which is 16.7 a bar.
 *
 * Rounding UP matters more than precision here. An estimate that is low lets
 * a build start that should have been queued, and the only thing standing
 * behind it is the credit ceiling — which stops the spending but wastes
 * whatever it spent getting there.
 */
const READS_PER_SAMPLED_BAR = Math.max(SUBS + 1, 17);

export interface Estimate {
  /** Swaps in the window, exact up to the ceiling asked for. */
  swaps: number;
  /** True when the count hit its ceiling and the real number is higher. */
  partial: boolean;
  bars: number;
  sampled: boolean;
  credits: number;
}

/**
 * Price the work, using signatures rather than a density map.
 *
 * `densityMap` would be the obvious tool and is the wrong one here: its own
 * documentation says the estimate for any particular window can be fifty-fold
 * wrong, which is fine for planning a fetch and useless for telling somebody
 * whether their replay is affordable. `countSwaps` pages signatures and is
 * exact up to whatever ceiling it is given — ten credits per thousand swaps,
 * and a wallet's window rarely holds more than a few thousand.
 *
 * The ceiling matters: counting is bounded so that pricing an enormous window
 * cannot itself become the expensive thing. Past it the answer is simply "more
 * than this", which is all the caller needs to refuse.
 */
export async function estimateWindow(
  venue: Venue,
  mint: string,
  from: number,
  to: number,
  interval: number,
  /** Bars that are actually missing from the cache; cached ones are free. */
  missingBars: number,
): Promise<Estimate> {
  if (missingBars <= 0) {
    return { swaps: 0, partial: false, bars: 0, sampled: false, credits: 0 };
  }

  /**
   * Counted up to what a sampled build of this size would need anyway.
   *
   * Bounded by bars rather than by a constant: a window of six bars needs no
   * more than a few hundred swaps counted to know it is cheap, and one of four
   * hundred is going to be expensive whatever the exact figure turns out to be.
   */
  const ceiling = Math.max(EXACT_MAX, missingBars * EXACT_BUCKET);
  const counted = await countSwaps(venue.pool, mint, from, to, ceiling);
  const swaps = counted.count;
  const partial = !counted.complete;

  /**
   * No shortcut for "small enough to read whole", even though one exists.
   *
   * `buildCandles` reads an entire window in about four calls when it is under
   * `EXACT_MAX` — but it decides that from the DENSITY MAP, not from a count,
   * and density's own documentation says it can be fifty-fold wrong for any
   * particular window. So a window this function knows holds 1,100 swaps can
   * still be sampled, because density guessed 5,000.
   *
   * Predicting the cheap path and getting the expensive one is the failure
   * that matters: MEASURED, a window predicted at 40 credits cost 4,010 and
   * was killed by the ceiling part-way, wasting all of it. Costing every bar
   * individually predicted 4,100 against that same 4,010. Being wrong upward
   * queues something that could have run inline; being wrong downward burns
   * the budget and delivers nothing.
   */
  const perBar = swaps / missingBars;
  const sampled = partial || perBar > EXACT_BUCKET;
  const reads = missingBars * (sampled ? READS_PER_SAMPLED_BAR : 1);

  return {
    swaps,
    partial,
    bars: missingBars,
    sampled,
    // Plus the density probes the builder spends planning the gap.
    credits: reads * PER_READ + Math.min(missingBars, 40) * PER_READ,
  };
}

/**
 * Roughly how long a build of this size takes, for telling somebody to wait.
 *
 * From measurement rather than theory: a 363-bar sampled window took 17.4s, a
 * 226-bar exact one 2.0s, a 60-bar exact one 1.3s. That is about 48ms per
 * sampled bar and about 9ms per exact one, which is close enough for a range
 * and honest about being one.
 */
export function estimateSeconds(estimate: Estimate): number {
  const perBar = estimate.sampled ? 0.048 : 0.009;
  return Math.max(1, Math.round(estimate.bars * perBar));
}
