import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whose Helius key this request spends, when the visitor brought their own.
 *
 * Scoped rather than threaded through signatures, for the same reason
 * `meter.ts` carries the caller that way: everything goes through
 * `config.rpcUrl`, and that reads this store, so a call site cannot opt out.
 *
 * Never logged, never persisted, never part of a cache key.
 */
const store = new AsyncLocalStorage<string>();

/** A Helius key is a UUID. */
const KEY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const KEY_HEADER = "x-helius-key";

/**
 * The visitor's key, if this request carried a usable one.
 *
 * A header, never a query parameter: that would put a paid credential into
 * access logs, browser history and every Referer the page sends.
 */
export function keyFrom(request: Request): string | null {
  // Checked here so an install with BYOK off cannot have one route still
  // honouring a key.
  if (process.env.TRICKSHOT_DISABLE_BYOK === "1") return null;
  const offered = request.headers.get(KEY_HEADER)?.trim() ?? "";
  return KEY_SHAPE.test(offered) ? offered : null;
}

/** Run `work` on the given key, or the server's own when there is none. */
export function withKey<T>(key: string | null, work: () => Promise<T>): Promise<T> {
  return key === null ? work() : store.run(key, work);
}

/** The key the active scope spends, or null for the server's own. */
export function visitorKey(): string | null {
  return store.getStore() ?? null;
}

/**
 * Whether this request is spending somebody else's credits.
 *
 * What the budget checks read: the money limits protect the site's account,
 * which a BYOK request never touches. The concurrency cap still applies, since
 * that bounds function time.
 */
export function isByok(): boolean {
  return store.getStore() !== undefined;
}
