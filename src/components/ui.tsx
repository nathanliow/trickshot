"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

export function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Label({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "font-mono text-[10px] font-medium tracking-[0.16em] text-tx3 uppercase",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("rounded-md border border-line bg-ink-800", className)}>
      {children}
    </div>
  );
}

/**
 * Copy an address to the clipboard.
 *
 * Rendered as a sibling of whatever it copies rather than inside it: the board
 * rows carry their own controls, and a button inside a button is invalid
 * markup that browsers resolve by dropping one of them.
 *
 * Icon-only, so it needs `aria-label` and `title` to say what it does — an
 * unlabelled glyph is unusable to a screen reader and ambiguous to everyone
 * else. The icon itself is `aria-hidden`; the label is the accessible name.
 *
 * `navigator.clipboard` needs a secure context, which localhost counts as. It
 * still rejects when the page is not focused or permission is refused, so the
 * failure is shown rather than swallowed — a copy button that silently does
 * nothing is worse than one that says it did not work.
 */
export function Copy({ value, label }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1_200);
  }

  const title =
    state === "done"
      ? "Copied"
      : state === "failed"
        ? "Could not copy"
        : `Copy ${label ?? "address"}`;

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={title}
      aria-label={title}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-xs border p-1",
        state === "done"
          ? "border-mint/40 text-mint"
          : state === "failed"
            ? "border-signal/40 text-signal"
            : "border-line-strong text-tx3 hover:text-tx2",
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {state === "done" ? (
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        ) : state === "failed" ? (
          <path d="M4 4l8 8M12 4l-8 8" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9a1.5 1.5 0 0 0 1.5 1.5h1" />
          </>
        )}
      </svg>
    </button>
  );
}

/** Play glyph for a control whose whole job is "start this replay". */
export function PlayButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-amber/40 bg-amber/10 p-1 text-amber hover:bg-amber/20"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
        <path d="M5 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 5 3.5Z" />
      </svg>
    </button>
  );
}

/**
 * A boolean the browser remembers, shared by every toggle on the page.
 *
 * Through `useSyncExternalStore` rather than an effect that seeds state: React
 * flags a setState in an effect body as a cascading render, and reading
 * localStorage straight into `useState` makes the first client render disagree
 * with the server's, which cannot see it. The third argument is the server
 * snapshot, so both renders start from the same value and the stored one
 * arrives on subscription.
 *
 * `storage` events do not fire in the document that wrote them, so writers
 * notify local subscribers directly.
 */
const listeners = new Map<string, Set<() => void>>();

function subscribeTo(key: string) {
  return (onChange: () => void) => {
    let held = listeners.get(key);
    if (!held) {
      held = new Set();
      listeners.set(key, held);
    }
    held.add(onChange);
    window.addEventListener("storage", onChange);
    return () => {
      held.delete(onChange);
      window.removeEventListener("storage", onChange);
    };
  };
}

export function useStoredFlag(
  key: string,
  fallback = true,
): [boolean, (next: boolean) => void] {
  const read = () => {
    try {
      const held = localStorage.getItem(key);
      return held === null ? fallback : held === "1";
    } catch {
      // Private windows and blocked site data throw on access.
      return fallback;
    }
  };

  const value = useSyncExternalStore(subscribeTo(key), read, () => fallback);

  return [
    value,
    (next: boolean) => {
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // A preference that cannot be stored still applies to this session.
      }
      for (const listener of listeners.get(key) ?? []) listener();
    },
  ];
}

/**
 * The same store, for a value out of a fixed set.
 *
 * `useStoredFlag` coerces what it reads (`held === "1"`); anything returning a
 * raw string does not, and a stale or hand-edited key would then be handed
 * straight to code that indexes on it. So the permitted values come in with the
 * call and anything else falls back — which covers a first visit's null too.
 */
export function useStoredValue<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (next: T) => void] {
  const read = () => {
    try {
      const held = localStorage.getItem(key) as T | null;
      return held !== null && allowed.includes(held) ? held : fallback;
    } catch {
      // Private windows and blocked site data throw on access.
      return fallback;
    }
  };

  const value = useSyncExternalStore(subscribeTo(key), read, () => fallback);

  return [
    value,
    (next: T) => {
      try {
        localStorage.setItem(key, next);
      } catch {
        // A preference that cannot be stored still applies to this session.
      }
      for (const listener of listeners.get(key) ?? []) listener();
    },
  ];
}

/** Whether a replay starts playing the moment it opens. */
export function useAutoPlay() {
  return useStoredFlag("trickshot:autoplay");
}

/** Whether fills flash and float when they land. */
export function useEffects() {
  return useStoredFlag("trickshot:effects");
}
