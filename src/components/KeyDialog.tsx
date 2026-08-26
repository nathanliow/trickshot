"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  looksLikeKey,
  useHeliusKey,
  WHERE_LABEL,
  WHERE_NOTE,
  type Where,
} from "@/lib/key";
import { Copy, cx } from "./ui";

/**
 * Where the visitor puts their own Helius key.
 *
 * Never in the way: everything already indexed replays without one.
 */
export function KeyDialog({
  open,
  onClose,
  /** Why it opened, when something refused rather than the visitor asking. */
  reason,
}: {
  open: boolean;
  onClose: () => void;
  reason?: string;
}) {
  // Unmounted rather than hidden, so the body mounts on open and the stored key
  // is simply its initial state. Syncing it in with an effect is a cascading
  // render that briefly shows the old draft.
  if (!open) return null;
  return <KeyForm onClose={onClose} reason={reason} />;
}

function KeyForm({
  onClose,
  reason,
}: {
  onClose: () => void;
  reason?: string;
}) {
  const { key, where, save, forget } = useHeliusKey();
  // Seeded once, then owned by the visitor.
  const [draft, setDraft] = useState(key);
  const [choice, setChoice] = useState<Where>(where);
  const [touched, setTouched] = useState(false);
  const inputId = useId();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  // Safe to read directly: this only mounts from a click.
  const host = window.location.hostname;

  /** Escape closes, and focus moves in — the two things a dialog owes you. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    box.current?.querySelector("input")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmed = draft.trim();
  const valid = looksLikeKey(trimmed);
  /** Only complain once they have actually typed something wrong. */
  const complain = touched && trimmed.length > 0 && !valid;

  function submit() {
    setTouched(true);
    if (!valid) return;
    save(trimmed, choice);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/80 p-4 pt-[10vh] backdrop-blur-sm"
      // A click on the backdrop itself closes; one that started inside the
      // panel and drifted out does not, which is what `currentTarget` checks.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[520px] rounded-md border border-line bg-ink-800 p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id={titleId}
              className="font-display text-[17px] leading-tight font-semibold tracking-[-0.01em] text-tx"
            >
              Bring your own key
            </h2>
            <p className="mt-1 max-w-[46ch] text-[13px] leading-relaxed text-tx2">
              Optional. Lifts the daily build caps.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="-mt-1 -mr-1 cursor-pointer rounded-xs p-1 text-tx3 transition-colors hover:text-tx"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {reason && (
          <p className="mt-3.5 rounded-xs border border-amber/30 bg-amber/10 px-3 py-2 text-[12.5px] leading-relaxed text-amber">
            {reason}
          </p>
        )}

        {/* First, because scoping is advice for before the key exists. */}
        <div className="mt-4 rounded-xs border border-line bg-ink-900/40 px-3 py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
              <span className="text-amber">1.</span> Lock it to this site
            </span>
            <span className="font-mono text-[10px] text-tx3">
              Helius &rsaquo; RPCs &rsaquo; Access Control
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-tx2">
            Add this host under <span className="text-tx">Allowed Domains</span>{" "}
            so the key is useless anywhere else.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-xs border border-line-strong bg-ink-900 px-2.5 py-1.5 font-mono text-[11.5px] text-tx">
              {host}
            </code>
            <Copy value={host} label="domain" />
          </div>
        </div>

        <label htmlFor={inputId} className="mt-4 flex flex-col gap-1.5">
          <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
            <span>
              <span className="text-amber">2.</span> Paste the key
            </span>
            <span className="normal-case tracking-normal text-tx3/70">
              paid plan required
            </span>
          </span>
          <input
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setTouched(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="00000000-0000-0000-0000-000000000000"
            spellCheck={false}
            autoComplete="off"
            type="password"
            aria-invalid={complain || undefined}
            className={cx(
              "min-w-0 rounded-xs border bg-ink-900 px-3 py-2.5 font-mono text-[12px] text-tx placeholder:text-tx3 focus:outline-none",
              complain
                ? "border-signal/50 focus:border-signal/60"
                : "border-line-strong focus:border-amber/50",
            )}
          />
          {complain && (
            <span className="font-mono text-[10.5px] text-signal">
              That does not look like a Helius key. They are UUIDs.
            </span>
          )}
        </label>

        <fieldset className="mt-4">
          <legend className="font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
            <span className="text-amber">3.</span> Keep it in
          </legend>
          <div className="mt-1.5 flex gap-1">
            {(["local", "session"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setChoice(option)}
                aria-pressed={choice === option}
                className={cx(
                  "cursor-pointer rounded-xs border px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] uppercase",
                  choice === option
                    ? "border-amber/40 bg-amber/10 text-amber"
                    : "border-line-strong text-tx3 hover:text-tx2",
                )}
              >
                {WHERE_LABEL[option]}
              </button>
            ))}
          </div>
          <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-tx3">
            {WHERE_NOTE[choice]}
          </p>
        </fieldset>

        {/* Folded away: the three steps above are the whole flow. */}
        <details className="group mt-4 border-t border-line pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-tx3 uppercase transition-colors marker:content-none hover:text-tx2">
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-3 w-3 transition-transform group-open:rotate-90"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
            What this changes
          </summary>

          <dl className="mt-3 overflow-hidden rounded-xs border border-line">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-3 py-2.5">
              <dt className="w-[92px] shrink-0 font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
                No key
              </dt>
              <dd className="min-w-[16ch] flex-1 text-[12.5px] leading-relaxed text-tx2">
                Replay everything indexed, look up any wallet, and build a few
                new tokens a day on this site&apos;s key.
              </dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5">
              <dt className="w-[92px] shrink-0 font-mono text-[9.5px] tracking-[0.14em] text-mint uppercase">
                Your key
              </dt>
              <dd className="min-w-[16ch] flex-1 text-[12.5px] leading-relaxed text-tx2">
                The same, without the daily caps. Bigger windows and deeper
                wallet history, billed to your Helius account.
              </dd>
            </div>
          </dl>

          <p className="mt-2.5 text-[12px] leading-relaxed text-tx3">
            Sent as a header, never in a URL, and not logged or stored on the
            server. It does sit in your browser, where any script on this page
            could read it, so remove it when you are done.
          </p>
        </details>

        <div className="mt-4 flex items-center justify-between gap-3">
          {key ? (
            <button
              type="button"
              onClick={() => {
                forget();
                setDraft("");
                onClose();
              }}
              className="cursor-pointer rounded-xs border border-line-strong px-3 py-2 font-mono text-[10px] tracking-[0.12em] text-tx3 uppercase hover:border-signal/40 hover:text-signal"
            >
              Forget key
            </button>
          ) : (
            <a
              href="https://dashboard.helius.dev"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10.5px] text-tx3 underline decoration-line-strong underline-offset-4 hover:text-tx2"
            >
              Get a key
            </a>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!valid}
            className="cursor-pointer rounded-xs border border-amber/40 bg-amber/10 px-5 py-2 font-mono text-[10px] tracking-[0.12em] text-amber uppercase hover:bg-amber/20 disabled:cursor-default disabled:opacity-40"
          >
            {key ? "Update" : "Save key"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The header control that opens it, showing whether a key is set. */
export function KeyButton({ onClick }: { onClick: () => void }) {
  const { key } = useHeliusKey();
  const set = key.length > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      // The tooltip carries the expansion; the four-character label cannot.
      title={
        set
          ? "Your own Helius key is set. Builds are billed to you"
          : "Bring your own Helius key"
      }
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xs border px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] uppercase transition-colors",
        set
          ? "border-mint/40 bg-mint/10 text-mint hover:bg-mint/20"
          : "border-line-strong text-tx3 hover:text-tx2",
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6" cy="8" r="3" />
        <path d="M9 8h5M12 8v2.5" />
      </svg>
      {set ? "B.Y.O.K on" : "B.Y.O.K"}
    </button>
  );
}
