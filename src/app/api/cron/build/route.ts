import { NextResponse } from "next/server";
import { releaseBuildSlot, siteLimit, takeBuildSlot } from "@/server/budget";
import { buildWindow } from "@/server/history";
import { claim, finish } from "@/server/queue";

/**
 * Builds whatever the queue is holding, once a minute.
 *
 * This is the only thing in the app that spends money with nobody watching, so
 * it is bounded four ways: the daily credit ceiling, the kill switch, one job
 * per tick, and the queue's own depth cap. Any of them can stop it without a
 * deploy.
 *
 * It runs the WHOLE-LIFE build — the owner-grade path a visitor may not
 * trigger — because that is the point. A wallet window is what gets refused;
 * indexing the token properly is what makes every later request for it cheap,
 * for every wallet, not just the one that asked.
 */
export const dynamic = "force-dynamic";
/**
 * Long, because a cold build of a busy token is minutes of work and being
 * killed part-way wastes everything it spent. Vercel allows up to 800 on Pro.
 */
export const maxDuration = 800;

/**
 * One per tick, deliberately.
 *
 * The cron fires every minute, so a queue of ten drains in ten. Draining
 * several at once would multiply the worst case — several cold builds sharing
 * one function's time and the account's rate limit — for no gain a shorter
 * interval does not already give.
 */
const PER_TICK = Number(process.env.QUEUE_PER_TICK ?? 3);
const MAX_BARS = Number(process.env.BUILD_MAX_BARS ?? 1_000);

export async function GET(request: Request) {
  /**
   * Vercel signs its cron requests; nothing else may start a build here.
   *
   * Without `CRON_SECRET` set this endpoint refuses everyone, which is the
   * right default for a route whose only job is to spend money.
   */
  const secret = process.env.CRON_SECRET;
  const offered = request.headers.get("authorization");
  if (!secret || offered !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }

  /**
   * The same ceilings the request path answers with, asked the same way.
   *
   * It used to check the kill switch and the credit ceiling and nothing else,
   * which left the build-COUNT ceiling bounding visitors alone — the worker
   * kept spending past it, on a limit whose whole purpose is to bound the day.
   * MEASURED: 1.07M credits drawn down while the counter it was supposed to
   * respect sat still, because the worker never increments it either.
   */
  const limit = await siteLimit();
  if (limit) return NextResponse.json({ skipped: `daily limit: ${limit}` });

  const built: { mint: string; ok: boolean; error?: string }[] = [];
  for (let i = 0; i < PER_TICK; i += 1) {
    const job = await claim();
    if (!job) break;

    /**
     * The worker competes for the same capacity as visitors do.
     *
     * Without this the cap is only half a cap: three visitor builds plus the
     * cron makes four, and the number that was supposed to bound the site
     * bounds only part of it. Putting the job back is the right failure — it
     * is still wanted, just not right now.
     */
    if (!(await takeBuildSlot())) {
      await finish(job.mint, { ok: false, error: "at capacity" });
      break;
    }

    try {
      /**
       * The rungs people asked for, NOT the token's own.
       *
       * A wallet's bar width comes from its own trading span; the whole-life
       * chart picks a width to suit the token. MEASURED on a 27-day token they
       * are 900s and 7,200s — different series, different keys. Building the
       * token's and calling the job done would leave every waiting click
       * refused for exactly the reason it was refused before, and the queue
       * would go round again at full price.
       */
      const windows = job.windows ?? [];
      if (windows.length === 0) {
        // Nothing to draw. Older rows predate the guard in `enqueue`; marking
        // them done rather than failed keeps the queue honest about which
        // tokens actually could not be read.
        await finish(job.mint, { ok: true });
        built.push({ mint: job.mint, ok: true });
        await releaseBuildSlot();
        continue;
      }

      /**
       * A window past the bar cap can never be built, so it must not be
       * retried. Left as an ordinary failure it was claimed every tick,
       * refused, and requeued — and since the queue is ordered by demand, a
       * popular one held the front of the line indefinitely.
       */
      const tooBig = windows.filter(
        (w) => Math.ceil((w.to - w.from) / w.interval) > MAX_BARS,
      );
      if (tooBig.length === windows.length) {
        await finish(job.mint, {
          ok: false,
          error: "window too large to build",
          terminal: true,
        });
        built.push({ mint: job.mint, ok: false, error: "window too large" });
        await releaseBuildSlot();
        continue;
      }

      let bars = 0;
      for (const w of windows.filter((w) => !tooBig.includes(w))) {
        bars += await buildWindow(job.mint, w.interval, w.from, w.to);
      }

      /**
       * And that is ALL a queued job does.
       *
       * It deliberately does not run the whole-life rebuild or the trader
       * board. Both were here and both were wrong:
       *
       *   `reconstruct` marks the token `full`, which puts it in the gallery —
       *   a token nobody has vetted, whose chart covers one wallet's span.
       *
       *   `traderBoard` is ~19,500 credits and ~80 seconds to answer a
       *   question nobody asked. Somebody clicked a row to see THEIR trades.
       *
       * A queued build serves the click that caused it: this wallet, this
       * token, this window. The token stays `window` coverage, stays off the
       * home page, and its page shows the replay without pretending to a
       * leaderboard it has not earned. Promoting it to a full token page is
       * `npm run index -- <mint> --top 5`, which is a decision, not a
       * side effect.
       */
      const ok = bars > 0;
      await finish(job.mint, { ok, error: ok ? undefined : "no trades found" });
      built.push({ mint: job.mint, ok });
    } catch (error) {
      const message = (error as Error).message;
      await finish(job.mint, { ok: false, error: message });
      built.push({ mint: job.mint, ok: false, error: message });
    }
    await releaseBuildSlot();
    // Stop if this build used up what was left for the day.
    if (await siteLimit()) break;
  }

  return NextResponse.json({ built });
}
