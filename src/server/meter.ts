import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What a request spent at Helius, counted where the money actually goes.
 *
 * Every figure this project quotes about cost — "a wallet overlay is about
 * eleven credits", "a cold build is fifty-five thousand" — was arithmetic over
 * call counts read out of the source, never a measurement. Some of it was
 * wrong by an order of magnitude: `identify([wallet])` is ONE address and a
 * flat hundred credits, and it ran on every single replay.
 *
 * So this counts. Everything else that bounds spend — the daily ceiling, the
 * per-class limits — is downstream of being able to answer "what did that
 * request cost" with a number rather than an estimate.
 */

/**
 * Helius's published metering, as of 2026-08.
 *
 * The shape that matters: `getTransactionsForAddress` bills per CALL, not per
 * byte — ten credits per hundred transactions returned, rounded up, with a
 * ten-credit floor, and ten flat for a signatures-only page however many come
 * back. A request asking for two full transactions costs the same as one
 * asking for a hundred. That is why the sampled chart path, which issues nine
 * reads of two transactions per bar, is the most expensive phase in the app.
 */
export type Meterable =
  /** getTransactionsForAddress / getTransfersByAddress, full detail. */
  | { kind: "archive"; returned: number }
  /** The same, asking only for signatures. Flat. */
  | { kind: "signatures" }
  /** getAsset, getTokenAccounts, anything on the DAS endpoint. */
  | { kind: "das" }
  /** /v1/wallet/batch-identity. Flat per REQUEST, not per address. */
  | { kind: "identity" }
  /** getMultipleAccounts, getTokenSupply, getTokenLargestAccounts, … */
  | { kind: "rpc" };

export function creditsFor(call: Meterable): number {
  switch (call.kind) {
    case "archive":
      return Math.max(10, Math.ceil(call.returned / 100) * 10);
    case "signatures":
      return 10;
    case "das":
      return 10;
    case "identity":
      return 100;
    case "rpc":
      return 1;
  }
}

export interface Spend {
  label: string;
  credits: number;
  calls: number;
  /** Credits and calls broken out by kind, so a total can be explained. */
  byKind: Record<string, { credits: number; calls: number }>;
  /**
   * What this scope may spend before it is stopped.
   *
   * Enforced here rather than by the caller because this is the only place
   * that knows the running total, and because a ceiling checked between phases
   * is not a ceiling: the expensive phase is one `Promise.all` of a few
   * thousand reads, and it would sail past any check that only ran before and
   * after it.
   */
  ceiling?: number;
}

/**
 * Thrown when a scope hits its ceiling. Not a failure — a refusal.
 *
 * Distinct from an ordinary error so the routes can answer "that request is
 * too expensive to serve" rather than "something went wrong", which are very
 * different things to tell somebody.
 */
export class BudgetExceeded extends Error {
  constructor(readonly spent: number, readonly ceiling: number) {
    super(`this request would cost more than ${ceiling} credits`);
    this.name = "BudgetExceeded";
  }
}

/**
 * Scoped with AsyncLocalStorage rather than threaded through every signature.
 *
 * The alternative was passing a counter down through `reconstruct` →
 * `series` → `buildCandles` → `pool` → `read`, and through every sibling that
 * happens to make a call. That is a change to a few dozen signatures to
 * collect a number, and it would be quietly wrong the first time someone added
 * a call site without the parameter. Here a call site cannot opt out: if it
 * goes through one of the wrappers, it is counted.
 */
const store = new AsyncLocalStorage<Spend>();

/**
 * Who to bill this request to, carried alongside the count.
 *
 * The per-visitor limits used to count BUILDS, and only builds of mints the
 * site had never seen — so a visitor replaying wallet after wallet on tokens
 * that were already indexed spent real credits and incremented nothing.
 * MEASURED in production: 2.1 million credits recorded as "1 build".
 *
 * Counting spend rather than builds fixes the category error. The caller is
 * carried out of band for the same reason the counter is: threading it through
 * every function that might spend is a change nobody remembers to make.
 */
const caller = new AsyncLocalStorage<string>();

export function withCaller<T>(ip: string, run: () => Promise<T>): Promise<T> {
  return caller.run(ip, run);
}

export function currentCaller(): string | null {
  return caller.getStore() ?? null;
}

/**
 * Count everything the given work does, and hand back the total with it.
 *
 * Nested calls JOIN the outer scope rather than opening their own. The
 * question worth answering is "what did this request cost", and a board build
 * that internally reconstructs a chart should report one number, not two that
 * have to be added up by whoever reads the log.
 */
export async function metered<T>(
  label: string,
  run: () => Promise<T>,
  /**
   * Called once the scope closes, however it closes.
   *
   * In a `finally`, because the request that matters most to a spending
   * ceiling is the expensive one that then threw — a build killed part-way
   * still spent everything it spent, and counting only successes would leave
   * exactly the runaway shape uncounted. Not called by a nested scope, which
   * has no scope of its own to close.
   */
  onSettle?: (spend: Spend) => void,
  /** Credits this scope may spend before `charge` starts refusing. */
  ceiling?: number,
): Promise<{ result: T; spend: Spend }> {
  const outer = store.getStore();
  if (outer) return { result: await run(), spend: outer };
  const spend: Spend = { label, credits: 0, calls: 0, byKind: {}, ceiling };
  try {
    const result = await store.run(spend, run);
    return { result, spend };
  } finally {
    onSettle?.(spend);
  }
}

/**
 * Record one call against whatever `metered` scope is active.
 *
 * A no-op outside one, deliberately: the CLI and any future worker should be
 * able to call the same functions without being wrapped, and a missing scope
 * is not an error worth throwing on the path of a chart.
 */
export function charge(call: Meterable): void {
  const spend = store.getStore();
  if (!spend) return;
  const credits = creditsFor(call);
  spend.credits += credits;
  spend.calls += 1;
  const bucket = (spend.byKind[call.kind] ??= { credits: 0, calls: 0 });
  bucket.credits += credits;
  bucket.calls += 1;

  /**
   * Charged first, then checked.
   *
   * The call has already been made and already cost money by the time this
   * runs, so pretending otherwise would under-count. What the throw stops is
   * everything that would have come AFTER it — which on the sampled path is
   * thousands of reads, so it stops the bleeding within one call of the limit.
   */
  if (spend.ceiling !== undefined && spend.credits > spend.ceiling) {
    throw new BudgetExceeded(spend.credits, spend.ceiling);
  }
}

/** Methods billed at the DAS rate rather than the standard one. */
const DAS_METHODS = new Set([
  "getAsset",
  "getAssets",
  "getAssetProof",
  "getAssetsByOwner",
  "getAssetsByAuthority",
  "getAssetsByCreator",
  "getAssetsByGroup",
  "getTokenAccounts",
  "searchAssets",
  "getSignaturesForAsset",
]);

/**
 * Charge a generic JSON-RPC call by looking at what was asked and returned.
 *
 * `pool.ts` and `graph.ts` route everything through one `rpc(method, params)`
 * helper — standard RPC, DAS, and `getTransactionsForAddress` alike — so the
 * only place that knows which rate applies is the method name plus the request
 * shape. Doing that classification here rather than at each call site means a
 * new call through those helpers is billed correctly without anyone
 * remembering to say so.
 */
export function chargeRpc(method: string, params: unknown, result: unknown): void {
  if (method === "getTransactionsForAddress" || method === "getTransfersByAddress") {
    const opts = Array.isArray(params)
      ? (params[1] as { transactionDetails?: string } | undefined)
      : undefined;
    if (opts?.transactionDetails === "signatures") {
      charge({ kind: "signatures" });
      return;
    }
    const data = (result as { data?: unknown[] } | null)?.data;
    charge({ kind: "archive", returned: data?.length ?? 0 });
    return;
  }
  charge({ kind: DAS_METHODS.has(method) ? "das" : "rpc" });
}

/**
 * Throw if the active scope is over its ceiling.
 *
 * Needed as well as the check inside `charge` because every fetch wrapper in
 * this codebase swallows exceptions on purpose — a transient upstream failure
 * should cost a bar, not the whole build — and that catch swallows the budget
 * throw along with everything else. MEASURED: with the check only in `charge`,
 * a capped build ran to 62,443 credits over 6,238 calls, refusing each read and
 * then cheerfully making the next one.
 *
 * So the ceiling is enforced where work is DISPATCHED rather than where it
 * fails: before each job the pool starts, and before each gap the series
 * builder opens. Neither sits inside a catch, so the throw travels.
 */
export function checkBudget(): void {
  const spend = store.getStore();
  if (spend?.ceiling !== undefined && spend.credits > spend.ceiling) {
    throw new BudgetExceeded(spend.credits, spend.ceiling);
  }
}

/** What has been spent so far in the active scope. For mid-build ceilings. */
export function spentSoFar(): number {
  return store.getStore()?.credits ?? 0;
}

export function currentSpend(): Spend | null {
  return store.getStore() ?? null;
}
