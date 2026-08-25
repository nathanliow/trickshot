/**
 * Historical SOL/USD, by the minute.
 *
 * Every price this system computes is denominated in its quote asset — SOL for
 * nearly every pump token — so a USD figure needs the SOL price AT THAT TIME.
 * The live path uses Jupiter's current price, which is correct to the second
 * and useless for history: replaying a token from last week against today's SOL
 * would misprice every fill by however much SOL has moved since.
 *
 * Binance klines, because they are free, need no key, go back years and are
 * denominated in USDT — which is within a fraction of a percent of USD and far
 * closer than any error this replaces. No Helius credits.
 */

/**
 * The public data mirror, not api.binance.com — that host answers 451 from
 * restricted regions, which would make this silently return nothing depending
 * on where the worker runs. The mirror serves the identical payload with no key.
 */
const KLINES = "https://data-api.binance.vision/api/v3/klines";
/** Binance caps a request at 1000 candles; a minute each is ~16h per call. */
const PER_CALL = 1000;

/**
 * Shared by every instance in the process, not held per instance.
 *
 * SOL's price at 14:32 last Tuesday is the same fact for every token on the
 * site, and `new SolPriceHistory()` is constructed fresh on each build — so a
 * page that opens ten of a wallet's tokens used to refetch the same overlapping
 * windows ten times. Free in credits, since Binance is not metered, but it is
 * real latency on the path someone is waiting on, and the data is immutable
 * once published.
 *
 * Bounded because it is process-wide now: a month of minutes is about forty
 * thousand entries, which is nothing, but nothing times an uptime is not.
 */
const MINUTES = new Map<number, number>();
const LOADED = new Set<number>();
/** Windows kept. Each is ~16h, so this is a couple of years of coverage. */
const MAX_WINDOWS = Number(process.env.SOL_PRICE_WINDOWS ?? 1_200);

export class SolPriceHistory {
  private readonly byMinute = MINUTES;
  /** Windows already fetched, so overlapping loads cost nothing. */
  private readonly loaded = LOADED;

  /**
   * Fetch every minute between two unix timestamps, inclusive.
   *
   * Every window at once, not one after another. Each call covers about
   * sixteen hours, so a token three weeks old needs forty of them — and walked
   * in sequence that was NINE SECONDS of a twenty-two second reconstruction,
   * spent waiting on a free endpoint for data that has not changed since the
   * day it was published. The windows do not depend on each other; only the
   * first cursor did, and that is arithmetic.
   */
  async load(fromSec: number, toSec: number): Promise<void> {
    const start = Math.floor(fromSec / 60) * 60;
    const end = Math.ceil(toSec / 60) * 60;
    const step = PER_CALL * 60;

    // Aligned to the step so the same window is always identified the same
    // way, and asked for once however many callers want it.
    const first = Math.floor(start / step) * step;
    const windows: number[] = [];
    for (let cursor = first; cursor <= end; cursor += step) {
      if (this.loaded.has(cursor)) continue;
      this.loaded.add(cursor);
      windows.push(cursor);
    }
    if (windows.length === 0) return;

    // Oldest windows first out, so a long-running process keeps what it is
    // actually being asked for rather than whatever it saw first.
    while (this.loaded.size > MAX_WINDOWS) {
      const oldest = this.loaded.values().next().value;
      if (oldest === undefined) break;
      this.loaded.delete(oldest);
      for (let m = oldest; m < oldest + step; m += 60) this.byMinute.delete(m);
    }

    const pages = await Promise.all(
      windows.map(async (cursor) => {
        const url =
          `${KLINES}?symbol=SOLUSDT&interval=1m` +
          `&startTime=${cursor * 1000}&limit=${PER_CALL}`;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return [];
          return (await res.json()) as [number, string, string, string, string][];
        } catch {
          return [];
        }
      }),
    );

    for (const rows of pages) {
      for (const [openMs, , , , close] of rows) {
        this.byMinute.set(Math.floor(openMs / 1000), Number(close));
      }
    }
  }

  /**
   * The price at a moment, or the nearest earlier minute we have.
   *
   * Falling back to the previous minute rather than to zero: a gap in the
   * series is a missing candle, not a token that was briefly worthless, and a
   * zero would silently zero out every fill in that minute.
   */
  at(tsSec: number): number {
    const minute = Math.floor(tsSec / 60) * 60;
    for (let m = minute, i = 0; i < 120; m -= 60, i += 1) {
      const price = this.byMinute.get(m);
      if (price !== undefined && price > 0) return price;
    }
    return 0;
  }

  get size(): number {
    return this.byMinute.size;
  }
}
