"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchBoard,
  fetchBuiltTokens,
  fetchHistory,
  fetchJob,
  fetchWalletTokens,
  type BuiltToken,
  type HistoryTrader,
  type TokenHistory,
  type JobState,
  type TraderBoard,
  type WalletTokens,
} from "@/lib/replay";
import { usdCompact } from "@/lib/format";
import { WalletReplay } from "./WalletReplay";
import { Copy, cx, Label, Panel, PlayButton } from "./ui";

/**
 * Replay for any token, reconstructed on demand.
 *
 * Two steps rather than one form: a mint alone rebuilds the token and shows who
 * made and lost the most, because the useful question is usually "who won
 * here?" before "show me this wallet". Naming a wallet skips straight to it.
 *
 * The chart and the board are fetched SEPARATELY and drawn as they arrive.
 * They cost an order of magnitude apart — the chart is windows read across the
 * token's life, the board is a couple of hundred wallets read in full — and
 * waiting for the second to show the first meant a blank page for minutes on a
 * token that had been drawable in seconds.
 */
export function HistoryReplay({
  /** Rendered on the server so the gallery is there on first paint. */
  initialTokens = [],
  /** True when this deployment serves a curated set and builds nothing new. */
  readOnly = false,
  /** True when the site has spent its day and can build nothing more. */
  limited = false,
}: {
  initialTokens?: BuiltToken[];
  readOnly?: boolean;
  limited?: boolean;
}) {
  /**
   * Seeded by the server and raised by any refusal that says so.
   *
   * Both, because the day can end mid-visit: the server render is right when
   * the page loads and stale from then on, and a `limited` refusal is the only
   * thing that knows the moment it changed.
   */
  const [closed, setClosed] = useState(limited);
  const [mint, setMint] = useState("");
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<TokenHistory | null>(null);
  const [board, setBoard] = useState<TraderBoard | null>(null);
  const [ranking, setRanking] = useState(false);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<{ wallet: string; label?: string } | null>(
    null,
  );
  const [built, setBuilt] = useState<BuiltToken[]>(initialTokens);
  /**
   * Which way round the visitor is looking.
   *
   * Two explicit tabs rather than one box that guesses: a mint and a wallet are
   * both base58 of the same length, so nothing about the string says which it
   * is, and guessing wrong sends an expensive request to the wrong endpoint.
   */
  const [mode, setMode] = useState<"token" | "wallet">("token");
  const [owner, setOwner] = useState("");
  const [ownerTokens, setOwnerTokens] = useState<WalletTokens | null>(null);
  const [ownerLoading, setOwnerLoading] = useState(false);
  const [depth, setDepth] = useState(0);
  /**
   * Airdrops are hidden by default and never dropped silently.
   *
   * A wallet that has been sprayed with dust has a long tail of tokens it
   * never bought, and showing them first buries the trades. But "no market and
   * still holding the whole balance" is a heuristic, and a token that has since
   * rugged looks identical — so the count is always stated and the tail is one
   * click away.
   */
  const [showSpam, setShowSpam] = useState(false);
  /**
   * A token being indexed after a click was refused.
   *
   * Held next to the error rather than inside it because the two behave
   * differently: an error is final and this is a wait, so it polls and the
   * page changes underneath the reader rather than asking them to try again.
   */
  const [waiting, setWaiting] = useState<{
    mint: string;
    /** Carried, not read from state: the poll reloads long after the click. */
    wallet?: string;
    job: JobState;
    /**
     * Reloads already attempted after the worker said it was done.
     *
     * Bounded because the loop is not free. If the rebuilt series still does
     * not satisfy the window, the reload is refused, re-queues, the worker
     * builds again, and round it goes — each lap costing a pre-flight here and
     * a full build there. Two laps is enough to survive a race; more than that
     * is a fault, and a fault should be shown rather than paid for.
     */
    tries: number;
  } | null>(null);

  const lookUpWallet = useCallback(async function lookUpWallet(
    pages?: number,
    spam?: boolean,
  ) {
    const address = owner.trim();
    if (!address) return;
    setOwnerLoading(true);
    try {
      const found = await fetchWalletTokens(address, pages, spam);
      setOwnerTokens(found);
      if (found?.limited) setClosed(true);
      if (pages) setDepth(pages);
    } finally {
      setOwnerLoading(false);
    }
  }, [owner]);

  /**
   * Reflect what is on screen in the address bar, without a navigation.
   *
   * `replaceState` rather than `pushState`: every step of one visit reading
   * the same token is a detail of the same look, not a new page to go back
   * through — a wallet clicked off a board and then closed should return to
   * the token, not to whatever the tab's history holds two entries back.
   */
  function setUrl(target: string, who: string): void {
    const url = new URL(window.location.href);
    if (target) url.searchParams.set("mint", target);
    else url.searchParams.delete("mint");
    if (who) url.searchParams.set("wallet", who);
    else url.searchParams.delete("wallet");
    window.history.replaceState(null, "", url);
  }

  /**
   * Open a wallet's replay from an already-loaded token, and say so in the
   * address bar.
   *
   * This is the common way a replay actually gets opened — off the board, not
   * off the form — so it needs the same URL update `load` gives the form path.
   * Read from `history.mint` rather than the `mint` input, which is live text
   * the visitor may have started typing a different token into without
   * submitting it; the board that is being clicked belongs to `history`.
   */
  function openWallet(wallet: string, label?: string): void {
    setPlaying({ wallet, label });
    setUrl(history?.mint ?? mint.trim(), wallet);
  }

  const load = useCallback(async function load(
    override?: string,
    walletOverride?: string,
    /** Carried through a queue wait, so a loop cannot go round for ever. */
    tries?: number,
  ) {
    const target = (override ?? mint).trim();
    if (!target) return;
    if (override) setMint(override);
    /**
     * Passed rather than read from state, because the wallet list sets both at
     * once and `setWallet` has not landed by the time this runs.
     */
    const who = (walletOverride ?? wallet).trim();
    if (walletOverride) setWallet(walletOverride);
    /**
     * What is being watched belongs in the address bar.
     *
     * The only way to hand someone a replay used to be the exported video —
     * the page itself always came back to a bare `/`, so the live chart, the
     * board and the "still building" state all had exactly one viewer. Set
     * before the fetch resolves, not after: a link to a token that turns out
     * not to exist is still a link worth the URL saying what was asked for.
     */
    setUrl(target, who);
    setLoading(true);
    setHistory(null);
    setBoard(null);
    setPlaying(null);
    // Whatever was being waited for, this is not it any more.
    setWaiting(null);
    try {
      const h = await fetchHistory(target, who || undefined);
      setHistory(h);
      if (h?.limited) setClosed(true);
      if (h?.queued) {
        setWaiting({
          mint: target,
          wallet: who || undefined,
          tries: tries ?? 0,
          job: {
            mint: target,
            status: h.status ?? "queued",
            ahead: h.ahead,
            buildSeconds: h.buildSeconds,
          },
        });
      }
      if (h && !h.error) {
        if (who) {
          setPlaying({ wallet: who, label: h.walletName });
        }
        /**
         * Only a fully indexed token has a board to ask for.
         *
         * A `window` chart is one wallet's slice: there is no ranking of who
         * won on it, because nobody read the other wallets. Asking anyway got
         * a 404 and rendered two empty panels headed "Made the most" — an
         * answer of "nobody" to a question that was never put.
         *
         * Deliberately not awaited: the board arrives into the page it belongs
         * to rather than holding up the chart that is already drawn.
         */
        if (h.coverage !== "window") {
          setRanking(true);
          void fetchBoard(target)
            .then(setBoard)
            .finally(() => setRanking(false));
        }
      }
    } finally {
      setLoading(false);
      void fetchBuiltTokens().then(setBuilt);
    }
  }, [mint, wallet]);

  /**
   * A link opens on what it links to.
   *
   * Read once, on mount, from whatever the page was actually loaded with.
   * `mint` and `wallet` are set by `load` itself, the same way a form submit
   * sets them. Deferred a tick rather than called straight from the effect
   * body, the same way the poll below only ever calls `load` from inside a
   * timer callback — `load` sets state synchronously the moment it starts,
   * and doing that as the direct, immediate result of an effect running is
   * what React's own lint rule is warning a mount effect never to do.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedMint = params.get("mint")?.trim();
    if (!linkedMint) return;
    const linkedWallet = params.get("wallet")?.trim() ?? undefined;
    const timer = setTimeout(() => void load(linkedMint, linkedWallet), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * While something is queued, ask every few seconds and reload when it lands.
   *
   * Polling rather than anything cleverer because the question is cheap — one
   * look at the queue, no chain reads — and because the alternative is telling
   * somebody to come back and refresh, which they will not do.
   */
  const pollFor = waiting?.mint;
  useEffect(() => {
    if (!pollFor) return;
    let live = true;

    const tick = async () => {
      const job = await fetchJob(pollFor);
      if (!live || !job) return;

      setWaiting((held) => {
        if (!held || held.mint !== pollFor) return held;

        /**
         * A build that gave up has to say so.
         *
         * Left to itself this polled a "failed" job for ever while the page
         * cheerfully read "queued for indexing" — the one state where waiting
         * longer cannot help.
         */
        if (job.status === "failed") {
          setHistory({
            mint: pollFor,
            error:
              job.error === "no trades found"
                ? "no trades found for this token"
                : "indexing this token did not work — it may have no readable pool",
          } as TokenHistory);
          return null;
        }

        if (job.status === "done" || job.status === "none") {
          if (held.tries >= 2) {
            setHistory({
              mint: pollFor,
              error:
                "this token was indexed but the replay still will not draw — " +
                "worth reporting rather than retrying",
            } as TokenHistory);
            return null;
          }
          void load(pollFor, held.wallet, held.tries + 1);
          return null;
        }

        return { ...held, job };
      });
    };

    const timer = setInterval(() => void tick(), 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // Keyed on the mint alone: the interval must not be torn down and rebuilt
    // every time the status object changes, or it never reaches a full tick.
  }, [pollFor, load]);

  /**
   * Rows the filter keeps. Matched against the address and the name, so both
   * "HDix" and "latentfish" find the same wallet.
   */
  const q = query.trim().toLowerCase();
  const keep = (r: HistoryTrader) =>
    !q ||
    r.wallet.toLowerCase().includes(q) ||
    (r.name ?? "").toLowerCase().includes(q);
  const top = (board?.top ?? []).filter(keep);
  const bottom = (board?.bottom ?? []).filter(keep);
  const found = top.length + bottom.length;

  /**
   * Back to the gallery. State rather than a navigation, so the overview
   * comes back instantly and the tokens it already has are not refetched.
   */
  function back() {
    setHistory(null);
    setBoard(null);
    setPlaying(null);
    setQuery("");
    setWallet("");
    // Or the poll keeps running for a token nobody is looking at any more,
    // and lands its replay on top of the gallery when it finishes.
    setWaiting(null);
    setUrl("", "");
  }

  return (
    <>
      {closed && <ClosedBanner />}
      {/*
        The header lives here rather than in the page so the wordmark can clear
        the open token. A link to `/` cannot: it is the same route, so the state
        holding the token survives the navigation.
      */}
      <header className="mb-7">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={back}
            title="Back to all tokens"
            className="cursor-pointer font-display text-[34px] leading-none font-semibold tracking-[-0.025em] text-tx transition-colors hover:text-tx2"
          >
            <h1>Trickshot</h1>
          </button>
          <a
            href="https://github.com/nathanliow/trickshot"
            target="_blank"
            rel="noreferrer"
            aria-label="Trickshot on GitHub"
            title="Source on GitHub"
            className="text-tx3 transition-colors hover:text-tx"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-[19px] w-[19px]"
              fill="currentColor"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </div>
        <p className="mt-2.5 max-w-[62ch] text-[14.5px] leading-relaxed text-tx2">
          {readOnly
            ? "Solana tokens rebuilt from the chain. Pick one, then play back what any wallet did on it."
            : "Rebuild any Solana token from the chain, then play back what a wallet did on it."}
        </p>
      </header>

      {playing && history && (
        <WalletReplay
          mint={mint.trim()}
          wallet={playing.wallet}
          label={playing.label}
          /** The wallet typed into the form was already fetched with the chart;
           *  opening its replay should not fetch the same thing again. */
          preloaded={history.wallet === playing.wallet ? history : undefined}
          onClose={() => {
            setPlaying(null);
            // Back to the token, not to a bare `/` — the chart and board it
            // belongs to are still on screen.
            setUrl(history.mint, "");
          }}
        />
      )}

      {/*
        Two ways in, because the site was built the wrong way round for most
        people. Finding a token and then finding who won on it is the owner's
        question; "show me MY trades" is everyone else's, and nobody has a
        forty-four character mint to hand for that.

        The wallet tab works even on a curated deployment: enumerating what a
        wallet has traded builds nothing, and being told which of your tokens
        are already here is the useful half of the answer.
      */}
      <Panel className="p-4 sm:p-5">
        <div className="mb-4 flex gap-1">
          {(["token", "wallet"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setMode(tab)}
              className={cx(
                "cursor-pointer rounded-xs border px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] uppercase",
                mode === tab
                  ? "border-amber/40 bg-amber/10 text-amber"
                  : "border-line-strong text-tx3 hover:text-tx2",
              )}
            >
              {tab === "token" ? "By token" : "By wallet"}
            </button>
          ))}
        </div>

        {mode === "wallet" ? (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setDepth(0);
                void lookUpWallet();
              }}
              className="flex flex-col gap-4 sm:flex-row sm:items-end"
            >
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
                  Wallet address
                </span>
                <input
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="paste a wallet to see what it has traded"
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 rounded-xs border border-line-strong bg-ink-900 px-3 py-2.5 font-mono text-[12px] text-tx placeholder:text-tx3 focus:border-amber/50 focus:outline-none"
                />
              </label>
              <button
                type="submit"
                disabled={ownerLoading || !owner.trim()}
                className="shrink-0 cursor-pointer rounded-xs border border-amber/40 bg-amber/10 px-5 py-2.5 font-mono text-[10px] tracking-[0.12em] text-amber uppercase hover:bg-amber/20 disabled:cursor-default disabled:opacity-40"
              >
                {ownerLoading ? "reading…" : "look up"}
              </button>
            </form>

            {ownerTokens?.error && (
              <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] text-signal">
                {ownerTokens.error}
              </p>
            )}

            {ownerTokens && !ownerTokens.error && (
              <div className="mt-4 border-t border-line pt-3">
                {/*
                  What was looked at, and what was set aside — not just what is
                  shown. A list that quietly drops rows is indistinguishable
                  from a wallet that never held them.
                */}
                <p className="font-mono text-[11px] text-tx3">
                  {ownerTokens.name && (
                    <span className="text-tx2">{ownerTokens.name} — </span>
                  )}
                  {ownerTokens.tokens.length} of {ownerTokens.scanned.toLocaleString()}{" "}
                  token accounts
                  {ownerTokens.hidden > 0 &&
                    ` · ${ownerTokens.hidden} airdrop${ownerTokens.hidden === 1 ? "" : "s"} hidden`}
                  {ownerTokens.truncated && " · more further down"}
                </p>

                {/*
                  What they have left, before they spend it.
                  
                  Every row marked "not indexed yet" costs one of these to
                  open. A visitor who learns the limit by hitting it has
                  already spent their last one on whichever token they happened
                  to click first, which reads as the site refusing at random.
                */}
                {ownerTokens.builds && (
                  <p
                    className={cx(
                      "mt-1 font-mono text-[11px]",
                      ownerTokens.builds.used >= ownerTokens.builds.limit
                        ? "text-signal"
                        : "text-tx3",
                    )}
                  >
                    {ownerTokens.builds.used >= ownerTokens.builds.limit
                      ? "No new tokens left to build today — rows marked ready still replay."
                      : `${ownerTokens.builds.limit - ownerTokens.builds.used} of ${ownerTokens.builds.limit} new tokens left to build today.`}
                  </p>
                )}

                {ownerTokens.tokens.length === 0 && (
                  <p className="mt-2 font-mono text-[11px] text-tx3">
                    Nothing here but the money side of trades — SOL and
                    stablecoins — which is not a replay.
                  </p>
                )}

                {/*
                  Fixed height, scrolled inside.
                  
                  Fifty rows pushed the controls under them off the bottom of
                  the page, so "load more" and "show airdrops" were only
                  reachable by scrolling past everything they act on. Bounding
                  the list keeps the whole panel — count, rows, controls — in
                  one place that does not move as the list grows.
                */}
                <div className="mt-3 max-h-[22rem] overflow-y-auto rounded-xs border border-line">
                <div className="grid gap-2 p-2 sm:grid-cols-2">
                  {ownerTokens.tokens.map((t) => {
                    const openable = t.indexed || !readOnly;
                    return (
                      <button
                        key={t.mint}
                        type="button"
                        disabled={!openable}
                        title={
                          openable
                            ? undefined
                            : "not on this site yet — the owner indexes what appears here"
                        }
                        onClick={() => {
                          setMode("token");
                          void load(t.mint, ownerTokens.wallet);
                        }}
                        className={cx(
                          "rounded-xs border border-line px-3 py-2.5 text-left",
                          openable
                            ? "cursor-pointer hover:border-line-strong"
                            : "cursor-default opacity-45",
                        )}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate font-mono text-[12px] text-tx">
                            {t.symbol ?? t.name ?? `${t.mint.slice(0, 6)}…`}
                          </span>
                          {/*
                            What is still HELD, not what was made.
                            
                            It is the current mark on the remaining balance, and
                            the wallet's profit is a different number entirely —
                            a trader who bought at $1k and sold the lot shows
                            "closed" here however well they did. Labelled rather
                            than left as a bare figure, because an unlabelled
                            dollar amount beside a token name reads as PnL.
                          */}
                          <span
                            className="shrink-0 font-mono text-[10px] text-tx3"
                            title={
                              t.held
                                ? "value of the balance still held — not profit"
                                : "position closed; nothing held"
                            }
                          >
                            {t.held
                              ? t.valueUsd > 0
                                ? `holds ${usdCompact(t.valueUsd)}`
                                : "holding"
                              : "closed"}
                          </span>
                        </div>
                        {/*
                          "not indexed yet", never "will be built".
                          
                          Whether a cold token CAN be drawn on demand depends on
                          how much of it this wallet traded, and there is no way
                          to know that without paying to find out — MEASURED
                          across one wallet's rows: 483, 3,793, 26,433, 37,063,
                          43,873 and 62,603 credits. Two of six fit inside what a
                          visitor may spend. Promising a build and then refusing
                          it is worse than saying plainly that it is not ready.
                        */}
                        <div
                          className={cx(
                            "mt-1 font-mono text-[10px]",
                            t.job ? "text-amber" : "text-tx3",
                          )}
                        >
                          {t.job === "building"
                            ? "indexing now"
                            : t.job === "queued"
                              ? "queued for indexing"
                              : t.indexed
                                ? t.coverage === "full"
                                  ? "ready"
                                  : "one window built"
                                : "not indexed yet"}
                        </div>
                      </button>
                    );
                  })}
                </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {ownerTokens.truncated && (
                    <button
                      type="button"
                      disabled={ownerLoading}
                      onClick={() => void lookUpWallet((depth || 3) + 3, showSpam)}
                      className="cursor-pointer rounded-xs border border-line-strong px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-tx2 uppercase hover:text-tx disabled:opacity-40"
                    >
                      {ownerLoading ? "reading…" : "load more"}
                    </button>
                  )}
                  {(ownerTokens.hidden > 0 || showSpam) && (
                    <button
                      type="button"
                      disabled={ownerLoading}
                      onClick={() => {
                        const next = !showSpam;
                        setShowSpam(next);
                        void lookUpWallet(depth || undefined, next);
                      }}
                      className="cursor-pointer rounded-xs border border-line-strong px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-tx2 uppercase hover:text-tx disabled:opacity-40"
                    >
                      {showSpam ? "hide airdrops" : "show airdrops"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
        <>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
          className="flex flex-col gap-4 sm:flex-row sm:items-end"
        >
          <label className="flex min-w-0 flex-[3] flex-col gap-1.5">
            <span className="font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
              Token mint
            </span>
            <input
              value={mint}
              onChange={(e) => setMint(e.target.value)}
              placeholder={
                readOnly ? "paste a mint that is on this site" : "paste a mint address"
              }
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 rounded-xs border border-line-strong bg-ink-900 px-3 py-2.5 font-mono text-[12px] text-tx placeholder:text-tx3 focus:border-amber/50 focus:outline-none"
            />
          </label>
          <label className="flex min-w-0 flex-[3] flex-col gap-1.5">
            <span className="flex items-baseline gap-2 font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
              Wallet
              <span className="tracking-normal normal-case">optional</span>
            </span>
            <input
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="skip straight to one wallet's replay"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 rounded-xs border border-line-strong bg-ink-900 px-3 py-2.5 font-mono text-[12px] text-tx placeholder:text-tx3 focus:border-amber/50 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={loading || !mint.trim()}
            className="shrink-0 cursor-pointer rounded-xs border border-amber/40 bg-amber/10 px-5 py-2.5 font-mono text-[10px] tracking-[0.12em] text-amber uppercase hover:bg-amber/20 disabled:cursor-default disabled:opacity-40"
          >
            {loading ? "loading…" : readOnly ? "open" : "build"}
          </button>
        </form>

        {loading && (
          <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] text-tx3">
            Finding the busiest pool, then reading windows across the
            token&rsquo;s whole life. About ten seconds the first time, then
            it&rsquo;s cached.
          </p>
        )}
        {/*
          A wait, not an error.
          
          Being told "too large to draw" and nothing else is a dead end: the
          reader has no idea whether that is permanent, whether anything is
          happening, or what to do. This says what is happening, roughly how
          long, and then changes by itself when it lands — the poll reloads the
          replay, so nobody has to know to come back.
        */}
        {waiting && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="font-mono text-[11px] text-amber">
              {waiting.job.status === "building"
                ? "Indexing this token now."
                : waiting.job.ahead && waiting.job.ahead > 0
                  ? `Queued for indexing — ${waiting.job.ahead} ahead.`
                  : "Queued for indexing — starting shortly."}
            </p>
            <p className="mt-1 font-mono text-[11px] text-tx3">
              {waiting.job.buildSeconds
                ? `The build itself takes about ${waiting.job.buildSeconds}s. `
                : ""}
              This page opens the replay as soon as it is ready — no need to
              reload. It only happens once; everyone who asks for this token
              afterwards gets it straight away.
            </p>
          </div>
        )}
        {history?.error && !waiting && (
          <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] text-signal">
            {history.error}
          </p>
        )}
        </>
        )}
      </Panel>

      {built.length > 0 && !history && (
        <section className="mt-8">
          <div className="mb-3 flex items-baseline justify-between">
            <Label>Already indexed</Label>
            <span className="font-mono text-[10.5px] text-tx3">
              redraws from cache in about two seconds
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {built.map((t) => (
              <button
                key={t.mint}
                type="button"
                onClick={() => void load(t.mint)}
                title={t.mint}
                className="group flex cursor-pointer items-center gap-3 rounded-md border border-line bg-ink-800 p-3 text-left transition-colors hover:border-line-strong hover:bg-ink-700 focus-visible:border-amber/50 focus-visible:outline-none"
              >
                <TokenMark image={t.image} symbol={t.symbol ?? t.name} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-display text-[15px] font-semibold text-tx">
                      {t.name ?? t.symbol ?? "Unnamed"}
                    </span>
                    {t.symbol && t.name && (
                      <span className="shrink-0 font-mono text-[10.5px] tracking-[0.08em] text-tx3">
                        {t.symbol}
                      </span>
                    )}
                  </span>
                  {/* Numbers a trader actually scans: how much happened, over
                      how long, at what resolution it was drawn. */}
                  <span className="tnum flex flex-wrap gap-x-3 font-mono text-[10.5px] text-tx3">
                    <span>{compact(t.swaps)} swaps</span>
                    <span>{duration(t.lastTs - t.firstTs)}</span>
                    <span>{duration(t.interval)} bars</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {history && !history.error && (
        <>
          {/*
            With a wallet loaded, the replay IS the page.
            
            The token's name and its build stats — how many swaps, how many
            bars, how wide, sampled or not — are what somebody reads when they
            are looking at the TOKEN. Somebody who named a wallet is here for
            that wallet's trades, and the modal carries the ticker and the PnL
            itself. Left in, they sit above the thing that matters and push it
            down the page.
            
            The back arrow stays either way: it is the only way out.
          */}
          <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={back}
                aria-label="Back to all tokens"
                title="Back to all tokens"
                className="-ml-1 cursor-pointer rounded-xs p-1 text-tx3 transition-colors hover:text-tx"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 3 5 8l5 5" />
                </svg>
              </button>
              {!history.wallet && (history.name || history.symbol) && (
                <>
                  <span className="font-display text-[18px] font-semibold text-tx">
                    {history.name ?? history.symbol}
                  </span>
                  {history.name && history.symbol && (
                    <span className="font-mono text-[12px] text-tx3">
                      {history.symbol}
                    </span>
                  )}
                </>
              )}
              {/*
                Beside the arrow, not under it. Two controls that are the whole
                of this view stacked into two rows of one, which read as two
                unrelated things rather than the pair they are.
              */}
              {history.wallet && !playing && (
                <button
                  type="button"
                  onClick={() =>
                    openWallet(history.wallet!, history.walletName)
                  }
                  className="cursor-pointer rounded-xs border border-amber/40 bg-amber/10 px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] text-amber uppercase hover:bg-amber/20"
                >
                  replay{" "}
                  {history.walletName ??
                    `${history.wallet.slice(0, 4)}…${history.wallet.slice(-4)}`}
                </button>
              )}
            </div>
          {!history.wallet && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Swaps" value={compact(history.swaps ?? 0)} />
              <Stat label="Candles" value={history.candles.length.toLocaleString()} />
              <Stat label="Bar" value={duration(history.interval)} />
              <Stat label="Span" value={duration(history.lastTs - history.firstTs)} />
              <Stat
                label="Bars from"
                value={history.exact ? "every trade" : "sampled"}
              />
            </div>
          )}

          {/*
            `partial` finally says something.
            
            It has been on the response all along and rendered nowhere, which
            was survivable while only the owner built anything and the read
            reached twelve pages deep. Visitors get three, so a heavily-traded
            wallet now hits the cap routinely — and a replay missing its
            earliest buys does not look broken, it looks like a wallet that
            started later and did better. Silence is the dangerous option.
          */}
          {/*
            A way back into the replay after closing it.
            
            Everything it needs is already on this page — the candles, the
            wallet's fills, its PnL curve — so closing the modal and wanting it
            back was a rebuild of work that never left. There was no control at
            all: the only route was to run the whole thing again.
          */}
          {history.partial && (
            <p className="mt-3 font-mono text-[11px] text-signal">
              This wallet has more history on this token than was read, so the
              replay starts part-way through and its PnL is not the whole story.
            </p>
          )}

          {/*
            The whole traders section, or none of it.
            
            A `window` chart is one wallet's slice of a token — the other
            wallets were never read, so there is no ranking to show and no
            honest empty state for one either. Two panels headed "Made the
            most" and "Lost the most" reporting nothing is not a blank table,
            it is a wrong answer: it says nobody made money here, when what
            happened is that nobody looked.
            
            These tables belong to a fully indexed token, which is something
            the owner decides with `npm run index -- <mint> --top 5`. Until
            then the page is what the visitor asked for: this token, and their
            trades on it.
          */}
          {history.coverage !== "window" && (
            <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Label>Traders</Label>
            <span className="font-mono text-[11px] text-tx3">
              {board?.builtAt
                ? `updated ${ago(board.builtAt)} ago`
                : ranking
                  ? "reading…"
                  : "not read yet"}
            </span>
            {/*
              * No update button.
              *
              * Refreshing a board re-reads every ranked wallet's history — a
              * minute or more of work and the most expensive thing here — so it
              * is the owner's to spend, from `npm run index -- <mint> --update`.
              * A button was fine while the site built nothing and the flag kept
              * visitors out of it. On a site that DOES build, the server refuses
              * the refresh unless the request carries the owner's token, and a
              * control that announces it is "reading each ranked wallet's new
              * trades" and then hands back the cached board is worse than no
              * control at all.
              */}
          </div>

          <div className="mt-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by address or name"
              spellCheck={false}
              className="w-full rounded-xs border border-line-strong bg-ink-900 px-3 py-2 font-mono text-[12px] text-tx placeholder:text-tx3"
            />
            {query.trim() && found === 0 && (
              /**
               * A wallet absent from the board is not a wallet without a
               * history — the board is a shortlist, and plenty of real traders
               * never make it onto one. Replaying works for any address, so an
               * empty search offers that rather than a dead end.
               */
              <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xs border border-line px-3 py-2">
                <span className="font-mono text-[11px] text-tx3">
                  {isAddress(query.trim())
                    ? "Not on this board — it may not have been among the wallets read."
                    : "No match on this board."}
                </span>
                {isAddress(query.trim()) && (
                  <button
                    type="button"
                    onClick={() => openWallet(query.trim())}
                    className="cursor-pointer rounded-xs border border-amber/40 bg-amber/10 px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-amber uppercase"
                  >
                    replay it anyway
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <Board
              title="Made the most"
              rows={top}
              loading={ranking}
              missing={Boolean(board?.error)}
              tone="mint"
              onPlay={(w, n) => openWallet(w, n)}
            />
            <Board
              title="Lost the most"
              rows={bottom}
              loading={ranking}
              missing={Boolean(board?.error)}
              tone="signal"
              onPlay={(w, n) => openWallet(w, n)}
            />
          </div>
          {board?.truncated && (
            <p className="mt-2 font-mono text-[10px] tracking-[0.1em] text-amber uppercase">
              Top traders and worst traders list may be inaccurate — demo
              purposes only
            </p>
          )}
            </>
          )}
        </>
      )}
    </>
  );
}

/** Helius mirrors token art here; the original is embedded in the path. */
const CDN = "https://cdn.helius-rpc.com/cdn-cgi/image//";

/**
 * A gateway that will actually serve the file.
 *
 * Most Solana token art lives on IPFS and most of it is addressed through
 * `ipfs.io`, which rate-limits hard. MEASURED across the tokens on this site:
 * every image that failed to load was an `ipfs.io` URL answering 403, and
 * every one that loaded was hosted somewhere else. `dweb.link` is the same
 * operator and fails with it; Cloudflare's gateway is gone. Pinata and
 * Filebase both serve the same CIDs.
 */
const IPFS_FALLBACK = "https://gateway.pinata.cloud/ipfs/";

/** Rewrite an IPFS URL onto a gateway that answers. */
function viaGateway(url: string): string | null {
  const cid = url.match(/\/ipfs\/([A-Za-z0-9]+)/)?.[1];
  return cid ? IPFS_FALLBACK + cid : null;
}

/**
 * The token's own artwork, which is how anyone actually recognises one.
 *
 * Two sources are tried, because one is not reliable enough. Helius mirrors
 * the file, which is what makes hotlink-protected hosts work at all; but the
 * mirror has to fetch from wherever the creator put it — often an IPFS gateway
 * — and that can fail or time out. The original is embedded in the mirror's
 * own path, so the fallback needs nothing stored alongside it.
 *
 * `referrerPolicy="no-referrer"` matters more than it looks: at least one host
 * here serves the image to a bare request and answers 403 when a browser sends
 * a Referer, so sending none is what makes the direct URL usable at all.
 *
 * A plain `img` rather than `next/image`: these come from whatever host the
 * creator used, and `next/image` would need every one declared up front.
 */
function TokenMark({ image, symbol }: { image?: string; symbol?: string }) {
  const [attempt, setAttempt] = useState(0);
  const initials = (symbol ?? "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 3);

  /**
   * The mirror, then a working IPFS gateway, then the original.
   *
   * In that order deliberately: the mirror handles hosts that refuse to serve
   * anyone else, the gateway handles the mirror failing to reach a rate-limited
   * `ipfs.io`, and the original covers whatever neither anticipated.
   */
  const origin = image?.startsWith(CDN) ? image.slice(CDN.length) : image;
  const sources = [image, origin ? viaGateway(origin) : null, origin]
    .filter((u): u is string => Boolean(u))
    .filter((u, i, all) => all.indexOf(u) === i);
  const src = sources[attempt];

  if (!src) {
    return (
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-line bg-ink-900 font-mono text-[11px] font-bold tracking-[0.04em] text-tx3 uppercase">
        {initials || "?"}
      </span>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element --
       remote hosts are unknowable at build time; see TokenMark. */
    <img
      key={src}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setAttempt((n) => n + 1)}
      className="h-11 w-11 shrink-0 rounded-sm border border-line bg-ink-900 object-cover"
    />
  );
}

/** Base58, 32-44 characters — the same shape the API insists on. */
function isAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/** 1.8M, 12.4K — a swap count nobody wants to read digit by digit. */
function compact(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

/** "4h", "12m" — how long ago a unix timestamp was. */
function ago(at: number): string {
  return duration(Math.max(Math.floor(Date.now() / 1000) - at, 0));
}

function duration(sec: number): string {
  if (sec >= 86_400) return `${(sec / 86_400).toFixed(1)}d`;
  if (sec >= 3_600) return `${(sec / 3_600).toFixed(sec % 3_600 ? 1 : 0)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec)}s`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-line bg-ink-800 px-3 py-2.5">
      <div className="font-mono text-[9px] tracking-[0.14em] text-tx3 uppercase">
        {label}
      </div>
      <div className="tnum mt-1 font-mono text-[15px] font-bold text-tx">{value}</div>
    </div>
  );
}

function Board({
  title,
  rows,
  loading,
  tone,
  missing,
  onPlay,
}: {
  title: string;
  rows: HistoryTrader[];
  loading: boolean;
  tone: "mint" | "signal";
  /** True when no board exists at all, as against one with nothing in it. */
  missing?: boolean;
  onPlay: (wallet: string, name?: string) => void;
}) {
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <Label>{title}</Label>
        {rows.length > 0 && (
          <span className="tnum font-mono text-[10px] text-tx3">{rows.length}</span>
        )}
      </div>
      {loading && rows.length === 0 && (
        <p className="px-4 py-6 font-mono text-[11px] text-tx3">
          reading every candidate wallet&rsquo;s full history on this mint…
        </p>
      )}
      {/*
        Two different nothings, and they were saying the same sentence.
        
        "No wallets with a known cost basis" is a real and useful answer: the
        board WAS worked out, and every wallet on it got its position by
        transfer rather than by buying, so ranking them would be fiction. It is
        the wrong answer entirely for a board that was never built — which is
        the normal state of a token the queue has only drawn a chart for, and
        reading it as a data problem is exactly what it looks like.
      */}
      {!loading && rows.length === 0 && (
        <p className="px-4 py-6 font-mono text-[11px] text-tx3">
          {missing
            ? "not worked out for this token yet — the chart is built, the traders are not"
            : "no wallets with a known cost basis"}
        </p>
      )}
      <div className="max-h-[420px] overflow-y-auto">
      {rows.map((r, i) => (
        /* A row, not a button: the address needs to be selectable and to carry
           its own copy control, and a button inside a button is invalid markup
           the browser resolves by dropping one of them. */
        <div
          key={r.wallet}
          /* Two lines on a phone, one on a desktop. Seven things competing for
             one row left nothing for the address, which is the only part that
             identifies the wallet. */
          className="flex w-full flex-col gap-1.5 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-ink-700 sm:flex-row sm:items-center sm:gap-2"
        >
          <span className="flex min-w-0 items-center gap-2 sm:flex-1">
            <span className="tnum w-5 shrink-0 font-mono text-[11px] text-tx3">
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              {r.name && (
                <span
                  title={r.category ?? r.name}
                  className="truncate font-mono text-[11.5px] font-medium text-tx"
                >
                  {r.name}
                </span>
              )}
              {/*
                The clipping lives on this BLOCK, not on the address inside it.
                `truncate` needs a box with a width to clip against, and an
                inline element has neither — so the full address rendered at
                its natural width and ran straight through the copy button and
                the figures beside it.
              */}
              <span
                title={r.wallet}
                className={cx(
                  "block min-w-0 truncate font-mono",
                  r.name ? "text-[10px] text-tx3" : "text-[11.5px] text-tx2",
                )}
              >
                {/* Ends only where there is no room for the middle. The copy
                    button is what people actually use to take the address. */}
                <span className="sm:hidden">
                  {r.wallet.slice(0, 6)}…{r.wallet.slice(-6)}
                </span>
                <span className="hidden select-all sm:inline">{r.wallet}</span>
              </span>
            </span>
            <Copy value={r.wallet} label="wallet address" />
          </span>

          <span className="flex items-center gap-3 pl-7 sm:shrink-0 sm:gap-2 sm:pl-0">
            <span
              title="First trade to last — or to now, if still holding"
              className="tnum shrink-0 font-mono text-[10.5px] text-tx3"
            >
              {r.heldSec ? `held ${duration(r.heldSec)}` : "—"}
            </span>
            <span className="tnum shrink-0 font-mono text-[10.5px] text-tx3">
              {r.trades} trades
            </span>
            <span
              className={cx(
                "tnum ml-auto text-right font-mono text-[12.5px] font-bold sm:ml-0 sm:w-24",
                tone === "mint" ? "text-mint" : "text-signal",
              )}
            >
              {r.total >= 0 ? "+" : "−"}
              {usdCompact(Math.abs(r.total))}
            </span>
            <PlayButton
              onClick={() => onPlay(r.wallet, r.name)}
              label={`Replay ${r.name ?? r.wallet}`}
            />
          </span>
        </div>
      ))}
      </div>
    </Panel>
  );
}

/**
 * The site is full for the day, said once at the top.
 *
 * Amber rather than the signal red: nothing has gone wrong. Every token
 * already on the site still replays, and the only thing that stopped is
 * reading new ones off the chain — so the tone is "come back tomorrow", not
 * "something failed". Read the room before reaching for the error colour.
 *
 * It says WHEN, because a banner that only says "later" gets ignored, and the
 * counters roll at UTC midnight whatever the reader's clock says.
 */
function ClosedBanner() {
  return (
    <div
      role="status"
      className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-sm border border-amber/35 bg-amber/8 px-3.5 py-2.5"
    >
      <span className="text-[13px] font-semibold tracking-[-0.01em] text-amber">
        daily limit reached
      </span>
      <span className="text-[13.5px] leading-relaxed text-tx2">
        New tokens resume at <span className="text-tx">midnight UTC</span>.
        Everything already indexed still replays.
      </span>
    </div>
  );
}
