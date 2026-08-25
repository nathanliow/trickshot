import { NextResponse } from "next/server";
import { owner } from "@/server/config";
import {
  callerIp,
  LIMIT_MESSAGE,
  mayBuild,
  releaseBuildSlot,
  secondsUntilReset,
  siteLimit,
  takeBuildSlot,
} from "@/server/budget";
import { BudgetExceeded, withCaller } from "@/server/meter";
import { enqueue } from "@/server/queue";
import {
  coverageOf,
  OWNER_LIMITS,
  reconstruct,
  replayFrom,
  TooLarge,
  VISITOR_LIMITS,
  walletReplay,
} from "@/server/history";

/**
 * Rebuild a token from the chain, and optionally one wallet's trades on it.
 *
 * Runs the reconstruction in-process rather than proxying to a worker: this
 * app has no stream to keep alive, so the only thing a separate process would
 * add is a second thing to deploy. A rebuild is cached per mint, so asking
 * about a second wallet on the same token costs that wallet's history alone.
 */
export const dynamic = "force-dynamic";
/** A first reconstruction reads a few hundred windows; it needs the headroom. */
export const maxDuration = 300;

export async function GET(request: Request) {
  /**
   * Every credit this request spends is billed to the caller.
   *
   * Set once, here, rather than passed down: the spending happens five layers
   * in, and a parameter threaded that far is one a future call site forgets.
   */
  return withCaller(callerIp(request), () => handle(request));
}

async function handle(request: Request) {
  const { searchParams } = new URL(request.url);
  const mint = searchParams.get("mint")?.trim() ?? "";
  const wallet = searchParams.get("wallet")?.trim() || undefined;
  const lead = Number(searchParams.get("lead") ?? 300);
  /**
   * Extra wallets replayed as ONE position with the subject. Capped, because
   * each one is a full history read and the caller is waiting.
   */
  const alongside = (searchParams.get("with") ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w && isAddress(w))
    .slice(0, 8);
  /**
   * The stretch to draw at the finer bar width, when the control under the
   * chart picked one. Ignored unless finer bars are stored for this mint, and
   * clamped there to the span that actually is — see `zoomFor`.
   */
  const zoomFrom = Number(searchParams.get("zoomFrom") ?? 0);
  const zoomTo = Number(searchParams.get("zoomTo") ?? 0);
  const section =
    Number.isFinite(zoomFrom) && Number.isFinite(zoomTo) && zoomFrom > 0 && zoomTo > zoomFrom
      ? { from: zoomFrom, to: zoomTo }
      : undefined;

  if (!isAddress(mint)) {
    return NextResponse.json({ error: "a valid mint is required" }, { status: 400 });
  }
  if (wallet && !isAddress(wallet)) {
    return NextResponse.json({ error: "wallet is not an address" }, { status: 400 });
  }

  /**
   * What has been built decides which PATH serves this, not whether it may.
   *
   * The distinction matters because a wallet replay and a whole-life rebuild
   * arrive at the same endpoint and differ in cost by roughly four thousand
   * times. A wallet request is bounded by the wallet's own history and is the
   * one build a visitor may start; a mint alone is the token's entire life
   * across every bar, which is owner-only.
   *
   * So coverage is read for what it says — `full` means there IS a whole-life
   * chart to serve — and never as permission to make one. A `window` row was
   * written by some visitor replaying a wallet; treating it as authorisation
   * would let anyone promote a cheap request into an expensive one just by
   * asking twice.
   */
  const isOwner = owner(request);
  /**
   * Read once per request, not per decision.
   *
   * Four places below need to know whether the day is spent, and each one is
   * a counter read against Supabase. Asking once and passing the answer down
   * keeps a closed day cheap — which matters, because a closed day is exactly
   * when the site is getting the most requests it cannot serve.
   */
  const limited = isOwner ? null : await siteLimit();

  const coverage = await coverageOf(mint);
  if (!wallet && coverage !== "full" && !isOwner) {
    return NextResponse.json(
      {
        error: coverage
          ? "only one wallet's window has been built for this token — try a wallet"
          : "that token is not on this site yet — try your wallet",
      },
      { status: 404 },
    );
  }

  try {
    /**
     * Two different requests, kept apart.
     *
     * A wallet replay reads one wallet's own history and draws only the window
     * it traded in; a mint alone reconstructs the token's entire life. They
     * used to share one call with the wallet as an optional argument, which
     * meant a wallet with nothing on the mint quietly became the expensive
     * one.
     */
    if (wallet) {
      /**
       * Building the window is what costs; replaying an indexed one does not.
       *
       * So the allowance is spent only when this request would actually build
       * something. Charging every replay would make the site unusable for the
       * exact person it is for — someone stepping through their own trades on
       * tokens that are already here.
       */
      const willBuild = !isOwner && (await coverageOf(mint)) === null;
      let slot = false;
      /**
       * Nothing new gets built once the day is spent — refused HERE, before
       * the wallet's own history is read, because reading it is the first
       * thing that costs and this request was never going to be served.
       */
      if (willBuild && limited) return closedForToday();
      if (willBuild) {
        const allowed = await mayBuild(callerIp(request), wallet);
        // Capacity is separate from allowance: the visitor may be entitled to
        // a build and the site may still be busy doing three others.
        if (allowed.ok && !(await takeBuildSlot())) allowed.reason = "busy";
        slot = allowed.ok && allowed.reason !== "busy";
        if (!allowed.ok || allowed.reason === "busy") {
          /**
           * "Come back later" and "you have had enough" are different answers,
           * and NEITHER of them is a 5xx.
           *
           * They were a 503, which is defensible by the letter of the spec and
           * wrong in practice: a refusal the app chose, on a path working
           * exactly as designed, was indistinguishable from the app falling
           * over. Vercel alerted on a sustained 503 rate and the alert was
           * correct about the status code and wrong about the site.
           *
           * A 429 says the same thing — too many, come back — without claiming
           * the server failed. `Retry-After` still carries when.
           */
          const siteWide =
            allowed.reason === "busy" ||
            allowed.reason === "budget" ||
            allowed.reason === "total" ||
            allowed.reason === "disabled";
          if (siteWide && allowed.reason !== "busy") return closedForToday();
          return NextResponse.json(
            {
              error: siteWide
                ? "the site is busy building right now — try again shortly"
                : "you have built a lot of new tokens today; try again tomorrow",
            },
            {
              status: 429,
              headers: { "retry-after": siteWide ? "30" : String(secondsUntilReset()) },
            },
          );
        }
      }

      let built;
      try {
        built = await walletReplay(
          mint,
          wallet,
          lead,
          alongside,
          isOwner ? OWNER_LIMITS : VISITOR_LIMITS,
          section,
        );
      } finally {
        // Released however this ends — including the refusal that queues it,
        // which is the common case and the one most likely to leak a slot.
        if (slot) await releaseBuildSlot();
      }
      if (!built) {
        return NextResponse.json(
          { error: "no trades found for this wallet on this mint" },
          { status: 404 },
        );
      }
      // The wallet's own window replaces the token-wide one, so the replay
      // opens on its trades rather than on the token's whole life.
      const replay = replayFrom(
        mint,
        wallet,
        built.history.candles,
        built,
        lead,
        alongside,
      );
      return NextResponse.json({
        ...built.history,
        wallet,
        // What was built by the time this returns, not what was there before:
        // a window just built for a new token makes this "window", not null.
        coverage: (await coverageOf(mint)) ?? "window",
        candles: replay.candles,
        trades: replay.trades,
        points: replay.points,
      });
    }

    const history = await reconstruct(mint, lead);
    if (!history) {
      return NextResponse.json(
        { error: "no trades found for this mint" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ...history, coverage: "full" });
  } catch (error) {
    /**
     * Refused is not failed.
     *
     * A window too large to draw on demand is a complete, correct answer about
     * what this endpoint will do — rendering it as a 500 would tell the visitor
     * the app is broken when it is working exactly as intended.
     */
    /**
     * Too expensive is not a failure, and it is not a dead end either.
     *
     * The pre-flight priced the window before spending anything, so this is
     * the app declining knowingly rather than crashing into a limit. The token
     * goes into the queue and the answer says how long — one build, however
     * many people ask, because the queue dedups by mint.
     */
    if (error instanceof TooLarge) {
      const { estimate } = error;
      /**
       * "This token needs indexing" is false when the token IS indexed.
       *
       * A fully indexed token has its whole life drawn at ONE bar width — the
       * one that suits the token. A wallet replay picks its width from the
       * WALLET's span instead, because a trader who was in for ten minutes is
       * a single candle on a two-hour chart and no replay at all.
       *
       * It goes both ways: MEASURED on this token, the whole-life chart is at
       * 7,200s and wallets off its own board have wanted 28,800s. Neither is
       * "finer" — they are different questions about the same trades.
       *
       * So a wallet can need a rung that has never been built on a token that
       * is otherwise complete, which is exactly what happens clicking a name
       * off its own trader board — and being told the token is not indexed, on
       * a page that only exists because it is, reads as a bug in the site.
       */
      const known = await coverageOf(mint);

      /**
       * The day's limit stops NEW TOKENS, not replays.
       *
       * A token already on the site is a replay however the request lands
       * here, including the common case that brought this back: a wallet's
       * bars come from the WALLET's span, so clicking a name off a token's
       * own board routinely wants a rung that token has never been built at.
       * Refusing that read "could not draw this replay" on a page that only
       * exists because the token is indexed — a limit on indexing, reported
       * as the replay being broken.
       *
       * A mint the site has never seen is the thing being held back, and it
       * is held back here as well as at the entry check, because a window
       * that turns out too large arrives at this branch instead.
       */
      if (limited && !known) return closedForToday();
      const queued = await enqueue(mint, {
        credits: estimate.credits,
        seconds: estimate.seconds,
        // The rung and span this click needed — the worker builds THAT, not
        // the token's own whole-life width, which is usually a different key.
        window: {
          interval: estimate.interval,
          from: estimate.from,
          to: estimate.to,
        },
      });
      return NextResponse.json(
        {
          error: !queued.accepted
            ? "this needs building and the queue is full — try again shortly"
            : limited
              ? "this wallet traded over a different span than the token's own " +
                "chart covers, and the day's build limit is reached — its bars " +
                "are queued for tomorrow"
              : known
                ? "this wallet traded over a different span than the token's own " +
                  "chart covers, so its bars are being built now"
                : "this token has not been indexed yet — it is queued now",
          queued: queued.accepted,
          status: queued.job.status,
          ahead: queued.ahead,
          /** Seconds to build it, once it starts. Not counting the wait. */
          buildSeconds: estimate.seconds,
        },
        { status: 413 },
      );
    }

    // Only reachable if the estimate was wrong; the ceiling is the backstop.
    if (error instanceof BudgetExceeded) {
      if (limited && !(await coverageOf(mint))) return closedForToday();
      const queued = await enqueue(mint);
      return NextResponse.json(
        {
          error:
            "this wallet's window turned out larger than expected to draw — " +
            "building it now",
          queued: queued.accepted,
          status: queued.job.status,
          ahead: queued.ahead,
        },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

/**
 * The one refusal every site-wide ceiling ends at.
 *
 * 429 rather than 503 on purpose: the server is fine, the day is not. It
 * carries `limited` so the page can raise the banner without a second request,
 * and a `Retry-After` measured to the UTC midnight the counters roll at rather
 * than a guess.
 */
function closedForToday() {
  return NextResponse.json(
    { error: LIMIT_MESSAGE, limited: true },
    { status: 429, headers: { "retry-after": String(secondsUntilReset()) } },
  );
}

/**
 * Base58, 32–44 characters.
 *
 * Checked before anything is fetched: these values are interpolated into
 * upstream RPC requests, and an address is the only thing that belongs there.
 */
function isAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}
