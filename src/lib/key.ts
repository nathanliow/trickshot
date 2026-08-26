"use client";

import { useSyncExternalStore } from "react";

/**
 * The visitor's own Helius key, kept in the browser and sent per request.
 *
 * Only ever to this site's own API, and never as a query parameter. The browser
 * does not call Helius directly: reconstruction is thousands of archival
 * requests, so the key travels one hop and is spent server-side.
 */

const KEY = "trickshot:helius-key";
/** Stored itself, so the choice survives a reload. */
const WHERE = "trickshot:helius-where";

export type Where = "local" | "session";

export const WHERE_LABEL: Record<Where, string> = {
  local: "Local storage",
  session: "Session storage",
};

/** How long it survives, since neither option is "the secure one". */
export const WHERE_NOTE: Record<Where, string> = {
  local: "Kept after you close the tab. Best on your own machine.",
  session: "Cleared when this tab closes. Best on a shared one.",
};

/** Mirrors the server's check, so the dialog can refuse before a round trip. */
const SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeKey(value: string): boolean {
  return SHAPE.test(value.trim());
}

/** Private windows and blocked site data throw on plain access. */
function store(where: Where): Storage | null {
  try {
    return where === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

// `storage` events do not fire in the document that wrote them, so writers
// notify locally. Same reason `ui.tsx` keeps its own set.
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readWhere(): Where {
  try {
    return window.localStorage.getItem(WHERE) === "session" ? "session" : "local";
  } catch {
    return "local";
  }
}

/** Both stores, so switching where it lives never reads as losing it. */
function readKey(): string {
  try {
    return (
      window.sessionStorage.getItem(KEY) ?? window.localStorage.getItem(KEY) ?? ""
    );
  } catch {
    return "";
  }
}

export function saveKey(value: string, where: Where): void {
  const key = value.trim();
  try {
    window.localStorage.setItem(WHERE, where);
  } catch {
    // The preference is cosmetic; the key below is what matters.
  }
  // Cleared from both first, so switching never leaves a copy behind.
  forgetKey({ quiet: true });
  if (key) store(where)?.setItem(KEY, key);
  announce();
}

export function forgetKey(opts: { quiet?: boolean } = {}): void {
  try {
    window.localStorage.removeItem(KEY);
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored is the state we were after anyway.
  }
  if (!opts.quiet) announce();
}

/**
 * The stored key, or "".
 *
 * The server snapshot is "" because it cannot see storage, and anything else
 * would hydrate into a flash of the wrong state.
 */
export function useHeliusKey(): {
  key: string;
  where: Where;
  save: (value: string, where: Where) => void;
  forget: () => void;
} {
  const key = useSyncExternalStore(subscribe, readKey, () => "");
  const where = useSyncExternalStore(subscribe, readWhere, () => "local" as Where);
  return { key, where, save: saveKey, forget };
}

/** Module scope, so `useHeliusKey` hands back a stable identity. */
const forget = () => forgetKey();

/** Spreads into a `fetch` init. Empty when there is no key. */
export function keyHeaders(): Record<string, string> {
  const key = readKey();
  return key ? { "x-helius-key": key } : {};
}
