/**
 * One ceiling on Helius traffic, for the whole process.
 *
 * Until now every bound was per call site and several fan-outs had none at
 * all: forty density probes at once, sixty nominations, and up to four hundred
 * and eighty whale-sweep reads in a single `Promise.all`. Each was reasonable
 * alone; nothing stopped them overlapping, and two of them plus a board build
 * is well past the account's requests-per-second.
 *
 * The reason that matters is not politeness. `exactBoard` swallows a failed
 * read into an empty result, so a throttled 429 does not surface as an error —
 * it silently drops that wallet from the board. Being rate-limited produces a
 * WRONG board, not a slow one.
 *
 * So the bucket is applied inside the fetch wrappers rather than at the call
 * sites. Every burst above queues behind it without any of them being touched,
 * and a call site added later cannot forget to.
 */
import { checkBudget } from "./meter";


/**
 * Requests per second this PROCESS may make.
 *
 * Not the account ceiling. Vercel runs many instances and each gets its own
 * bucket, so the account limit is this times however many are warm — which is
 * why the default is left near the plan's figure rather than divided by a
 * guess. Dividing it costs real latency: a 400-bar build issues ~3,600 reads,
 * so 400/s is ~9s of queueing and 125/s is ~29s, on a path already close to
 * the function timeout. Measure the concurrent-instance count with the meter
 * before lowering this; a genuinely global ceiling needs a shared counter, not
 * a smaller local one.
 */
const RPS = Number(process.env.HELIUS_RPS ?? 400);

/** A whole second of budget may be spent at once; it refills continuously. */
const BURST = RPS;

let tokens = BURST;
let last = Date.now();

function refill(): void {
  const now = Date.now();
  tokens = Math.min(BURST, tokens + ((now - last) / 1000) * RPS);
  last = now;
}

/**
 * Wait until one request's worth of budget is available.
 *
 * Sleeps rather than rejecting: the callers are all inside a request someone
 * is waiting on, and a queued read is always better than a dropped one — the
 * failure mode this exists to prevent is exactly a read that quietly returns
 * nothing.
 */
export async function take(): Promise<void> {
  for (;;) {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    const waitMs = Math.max(1, Math.ceil(((1 - tokens) / RPS) * 1000));
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Run jobs with at most `limit` in flight, flat rather than in batches.
 *
 * Lifted from `candles.ts`, where it is measured at 350 windowed reads in 2.2s.
 * Flat matters: a batch waits for its slowest member before starting the next,
 * which on the board's wallet reads leaves most of the pool idle, since one
 * wallet with twelve pages holds up fifty-nine that had one.
 */
export async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      // Before taking work, not after failing at it. The reads themselves
      // swallow errors, so this is where a budget refusal can still be heard.
      checkBudget();
      const i = next;
      next += 1;
      const job = jobs[i];
      if (!job) return;
      out[i] = await job();
    }
  });
  await Promise.all(workers);
  return out;
}
