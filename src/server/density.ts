import { config } from "./config";
import { take } from "./limit";
import { charge } from "./meter";
import { tradeFilter } from "./pool";

/**
 * How busy the book was, minute by minute, before anything is fetched.
 *
 * A token does not trade evenly and this one is the extreme case: MEASURED
 * across its 27 days, 7.5 swaps a second in the first hour falling to 0.08 a
 * second three weeks later — a hundredfold range. Any plan made without
 * knowing that is wrong at one end or the other. Reading a fixed number of
 * transactions per bucket wastes calls on the quiet weeks and captures a
 * rounding error of the launch.
 *
 * Signatures are the cheap way to ask. They cost TEN CREDITS FLAT however many
 * come back, so a probe that returns a thousand of them costs the same as one
 * that returns three, and each one carries a blockTime — a thousand signatures
 * spanning 134 seconds means 7.5 swaps a second, with no transaction fetched.
 *
 * MEASURED: forty probes across the whole life, run in parallel, 510ms.
 */

const PROBES = Number(process.env.HISTORY_DENSITY_PROBES ?? 40);

export interface Density {
  /** Probe points, ascending, with the local swap rate at each. */
  points: { t: number; rate: number }[];
  /** Swaps over the whole span, by integrating the rate. */
  total: number;
}

async function probe(
  pool: string,
  mint: string,
  from: number,
): Promise<{ t: number; rate: number }> {
  try {
    await take();
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "density",
        method: "getTransactionsForAddress",
        params: [
          pool,
          {
            transactionDetails: "signatures",
            sortOrder: "asc",
            limit: 1_000,
            maxSupportedTransactionVersion: 0,
            filters: { ...tradeFilter(mint), blockTime: { gte: from } },
          },
        ],
      }),
    });
    if (!res.ok) return { t: from, rate: 0 };
    const body = (await res.json()) as {
      result?: { data?: { blockTime?: number }[] };
    };
    charge({ kind: "signatures" });
    const data = body.result?.data ?? [];
    if (data.length < 2) return { t: from, rate: 0 };
    const span = (data[data.length - 1]?.blockTime ?? 0) - (data[0]?.blockTime ?? 0);
    // A thousand signatures inside one second is a burst, not a rate anything
    // can be planned from; treat the probe's own resolution as the floor.
    return { t: from, rate: span > 0 ? data.length / span : data.length };
  } catch {
    return { t: from, rate: 0 };
  }
}

export async function densityMap(
  pool: string,
  mint: string,
  first: number,
  last: number,
  /**
   * Probes to spend. Scaled by the caller to the work being planned: mapping a
   * token's whole life is worth forty, and deciding how to draw the six bars a
   * cached chart is missing is not — that cost 400ms of every warm request to
   * plan 800ms of fetching.
   */
  probes: number = PROBES,
): Promise<Density> {
  const span = Math.max(last - first, 1);
  const count = Math.max(1, Math.min(probes, PROBES));
  const step = span / count;
  const points = await Promise.all(
    Array.from({ length: count }, (_, i) => probe(pool, mint, Math.floor(first + i * step))),
  );
  points.sort((a, b) => a.t - b.t);
  const total = points.reduce((sum, p) => sum + p.rate * step, 0);
  return { points, total };
}

/**
 * Swaps expected in a window, by integrating the probed rate across it.
 *
 * An estimate, and used only where an estimate is the right tool: deciding
 * whether a window is small enough to read exactly, and scaling a sampled
 * bucket's volume. Nothing on the chart is priced from it.
 */
export function expectedSwaps(d: Density, from: number, to: number): number {
  if (d.points.length === 0 || to <= from) return 0;
  let total = 0;
  for (let i = 0; i < d.points.length; i += 1) {
    const point = d.points[i];
    if (!point) continue;
    const start = point.t;
    const end = d.points[i + 1]?.t ?? Infinity;
    const overlap = Math.min(to, end) - Math.max(from, start);
    if (overlap > 0) total += point.rate * overlap;
  }
  return total;
}

/**
 * Exactly how many swaps a window holds, up to a ceiling.
 *
 * The density map is a probe grid and a token's activity swings by two orders
 * of magnitude across its life, so its estimate for any particular window can
 * be fifty-fold wrong. That is fine for planning and not fine for deciding
 * whether a window can be read whole: guessing low meant speculatively pulling
 * four thousand full transactions — some eighty megabytes — discovering the
 * window was bigger, and throwing all of it away.
 *
 * Signatures answer it properly. They cost ten credits flat per page whatever
 * they return, and a handful of pages settles any window worth reading whole.
 */
export async function countSwaps(
  pool: string,
  mint: string,
  from: number,
  to: number,
  ceiling: number,
): Promise<{ count: number; complete: boolean }> {
  let count = 0;
  let token: string | undefined;

  for (let page = 0; page <= Math.ceil(ceiling / 1_000); page += 1) {
    try {
      await take();
    const res = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "count",
          method: "getTransactionsForAddress",
          params: [
            pool,
            {
              transactionDetails: "signatures",
              sortOrder: "asc",
              limit: 1_000,
              maxSupportedTransactionVersion: 0,
              filters: { ...tradeFilter(mint), blockTime: { gte: from, lt: to } },
              ...(token ? { paginationToken: token } : {}),
            },
          ],
        }),
      });
      if (!res.ok) return { count, complete: false };
      const body = (await res.json()) as {
        result?: { data?: unknown[]; paginationToken?: string };
      };
      charge({ kind: "signatures" });
      const data = body.result?.data ?? [];
      count += data.length;
      token = body.result?.paginationToken;
      if (!token || data.length === 0) return { count, complete: true };
    } catch {
      return { count, complete: false };
    }
  }
  return { count, complete: false };
}
