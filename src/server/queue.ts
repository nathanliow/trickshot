import { loadBlob, saveBlob } from "./store";

function supabase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

/** A jobs row as PostgREST returns it. */
interface JobRow {
  mint: string;
  status: JobStatus;
  windows: Window[] | null;
  requests: number;
  attempts: number;
  credits: number | null;
  seconds: number | null;
  error: string | null;
  at: number;
  started_at: number | null;
  finished_at: number | null;
}

const fromRow = (r: JobRow): Job => ({
  mint: r.mint,
  status: r.status,
  windows: r.windows ?? [],
  requests: r.requests,
  attempts: r.attempts,
  credits: r.credits ?? undefined,
  seconds: r.seconds ?? undefined,
  error: r.error ?? undefined,
  at: r.at,
  startedAt: r.started_at ?? undefined,
  finishedAt: r.finished_at ?? undefined,
});

async function rpc<T>(fn: string, body: unknown): Promise<T | null> {
  const remote = supabase();
  if (!remote) return null;
  try {
    const res = await fetch(`${remote.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: remote.key,
        authorization: `Bearer ${remote.key}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 404) {
        console.error(
          `[queue] ${fn} is missing — run scripts/migrate.sql. Using the blob queue until then.`,
        );
      }
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function table<T>(path: string, init?: RequestInit): Promise<T | null> {
  const remote = supabase();
  if (!remote) return null;
  try {
    const res = await fetch(`${remote.url}/rest/v1/trickshot_jobs?${path}`, {
      ...init,
      headers: {
        apikey: remote.key,
        authorization: `Bearer ${remote.key}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Tokens somebody asked for that were too expensive to draw on demand.
 *
 * The point is not to make the expensive build cheap — it is still the same
 * work. The point is that it happens ONCE, off the request path, for whoever
 * asked and everybody who asks later. Ten people wanting the same token is one
 * build; that dedup is the whole reason this is affordable rather than a way
 * for visitors to spend money in a loop.
 *
 * Deliberately not a general job system. One kind of job, one worker, no
 * retries beyond a count, and a hard cap on depth — because everything queued
 * here spends real money without anyone watching.
 */

export type JobStatus = "queued" | "building" | "done" | "failed";

/**
 * A window somebody is actually waiting for.
 *
 * The job cannot be just a mint. A wallet's bar width comes from its own
 * trading span, so two people asking about the same token can need different
 * rungs, and the token's own whole-life chart is usually a third — building
 * that instead satisfies neither, at full price.
 */
export interface Window {
  interval: number;
  from: number;
  to: number;
}

export interface Job {
  mint: string;
  status: JobStatus;
  /**
   * Every rung asked for, merged per interval.
   *
   * Merged rather than listed because two wallets on the same rung usually
   * overlap, and one build spanning both is cheaper than two that each
   * re-read the middle.
   */
  windows: Window[];
  /** Distinct people who have asked. Ranks the queue by actual demand. */
  requests: number;
  /** Unix seconds. */
  at: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  error?: string;
  /** What the pre-flight thought this would cost, for reporting a wait. */
  credits?: number;
  seconds?: number;
}

const KEY = "jobs:queue";
const MAX_DEPTH = Number(process.env.QUEUE_MAX_DEPTH ?? 50);
/** Distinct charts one job may carry. See `merge`. */
const MAX_WINDOWS = Number(process.env.QUEUE_MAX_WINDOWS ?? 6);
/** Must match `BUILD_MAX_BARS`: never queue what the worker will refuse. */
const MAX_BARS = Number(process.env.BUILD_MAX_BARS ?? 1_000);
const MAX_ATTEMPTS = Number(process.env.QUEUE_MAX_ATTEMPTS ?? 2);
/** A claim older than this is assumed dead and may be taken again. */
const STALE_SEC = Number(process.env.QUEUE_STALE_SEC ?? 900);
/** Finished rows kept, so a page that is polling still sees the answer. */
const KEEP_DONE_SEC = Number(process.env.QUEUE_KEEP_DONE_SEC ?? 1_800);

const nowSec = () => Math.floor(Date.now() / 1000);

async function read(): Promise<Job[]> {
  return (await loadBlob<Job[]>(KEY)) ?? [];
}

/**
 * Prune on write rather than on a schedule.
 *
 * Nothing else runs often enough to be trusted with it, and the list is small
 * by construction — a stale `building` row is a worker that died mid-build and
 * has to become claimable again, or the token is stuck for ever.
 */
function prune(jobs: Job[]): Job[] {
  const now = nowSec();
  return jobs.filter((job) => {
    if (job.status === "done" || job.status === "failed") {
      return now - (job.finishedAt ?? job.at) < KEEP_DONE_SEC;
    }
    return true;
  }).map((job) => {
    if (job.status === "building" && now - (job.startedAt ?? job.at) > STALE_SEC) {
      return { ...job, status: "queued" as const, startedAt: undefined };
    }
    return job;
  });
}

export interface Enqueued {
  job: Job;
  /** How many queued jobs are ahead of it. */
  ahead: number;
  /** False when the queue is full and nothing was added. */
  accepted: boolean;
}

/** Widen an existing rung to cover a new ask, or add the rung. */
function merge(windows: Window[], next?: Window): Window[] {
  if (!next) return windows;
  /**
   * Widened only where the spans actually OVERLAP.
   *
   * Matching on bar width alone and taking min/max was the mistake, and an
   * expensive one: two wallets that both happen to want 900s bars but traded
   * a month apart merged into a single window spanning that month — MEASURED,
   * 2,833 bars, estimated at 481,780 credits, for a chart the app would never
   * draw itself (a whole-life chart is capped at 400 bars).
   *
   * Overlapping spans genuinely are cheaper as one build, because the middle
   * is read once. Disjoint ones are two builds either way, and merging them
   * adds everything in between for nothing.
   */
  const held = windows.find(
    (w) =>
      w.interval === next.interval &&
      next.from <= w.to &&
      next.to >= w.from &&
      /**
       * And only if the union is still buildable.
       *
       * Overlapping is not enough: two windows that each fit can union into
       * one that does not, and the worker then refuses it every tick — the
       * job is claimed, fails instantly, returns to the queue, and because
       * ordering is by demand a popular one sits at the front doing that
       * forever. MEASURED: a 1,323-bar union blocking four other tokens.
       */
      Math.ceil(
        (Math.max(w.to, next.to) - Math.min(w.from, next.from)) / w.interval,
      ) <= MAX_BARS,
  );
  if (!held) {
    // Bounded: a token nobody agrees on the shape of is not worth unbounded
    // work, and the tail here is rungs one visitor each asked for.
    return windows.length >= MAX_WINDOWS ? windows : [...windows, next];
  }
  held.from = Math.min(held.from, next.from);
  held.to = Math.max(held.to, next.to);
  return windows;
}

/**
 * Ask for a token to be built, or join the request already standing.
 *
 * Returns the existing row rather than adding a second one — that is the
 * dedup, and it is what turns "every visitor triggers a build" into "the first
 * visitor triggers a build". A repeat ask still counts, because demand is how
 * the queue is ordered.
 */
export async function enqueue(
  mint: string,
  hint: { credits?: number; seconds?: number; window?: Window } = {},
): Promise<Enqueued> {
  /**
   * A job with no window is a job that cannot succeed.
   *
   * The worker builds the windows it is given and nothing else, so an empty
   * list means it draws no bars, reports none built, and the job is marked
   * failed after its retries — MEASURED in production: three people waiting on
   * a token queued without one. Refusing the enqueue is the honest answer;
   * silently accepting work that will fail is not.
   */
  if (!hint.window) {
    return {
      job: { mint, status: "failed", windows: [], requests: 1, at: nowSec(), attempts: 0 },
      ahead: 0,
      accepted: false,
    };
  }
  /**
   * One statement in Postgres, or read-modify-write on a blob.
   *
   * The blob shape lost jobs: two visitors enqueueing at the same moment each
   * read the list, each appended their own, and the later write erased the
   * earlier — leaving somebody waiting on a page that would never update. The
   * function does the find, the dedup, the depth check and the insert together,
   * so there is no window between them.
   */
  const row = await rpc<JobRow | null>("trickshot_enqueue", {
    p_mint: mint,
    p_window: hint.window ?? null,
    p_credits: hint.credits ?? null,
    p_seconds: hint.seconds ?? null,
    p_max_depth: MAX_DEPTH,
  });
  if (row !== null) {
    // A null row from the function means the queue was full.
    if (!row.mint) {
      return {
        job: { mint, status: "queued", windows: [], requests: 1, at: nowSec(), attempts: 0 },
        ahead: MAX_DEPTH,
        accepted: false,
      };
    }
    const job = fromRow(row);
    return { job, ahead: await aheadOfRemote(job), accepted: true };
  }

  const jobs = prune(await read());
  const existing = jobs.find((j) => j.mint === mint);

  if (existing) {
    // A finished job that is asked for again goes back in: the token may have
    // moved on, and refusing would leave the asker with no way forward.
    if (existing.status === "done" || existing.status === "failed") {
      existing.status = "queued";
      existing.at = nowSec();
      existing.attempts = 0;
      existing.error = undefined;
      existing.finishedAt = undefined;
    }
    existing.requests += 1;
    existing.windows = merge(existing.windows ?? [], hint.window);
    await saveBlob(KEY, jobs);
    return { job: existing, ahead: aheadOf(jobs, existing), accepted: true };
  }

  const queued = jobs.filter((j) => j.status === "queued" || j.status === "building");
  if (queued.length >= MAX_DEPTH) {
    const job: Job = {
      mint,
      status: "queued",
      windows: merge([], hint.window),
      requests: 1,
      at: nowSec(),
      attempts: 0,
    };
    return { job, ahead: queued.length, accepted: false };
  }

  const job: Job = {
    mint,
    status: "queued",
    windows: merge([], hint.window),
    requests: 1,
    at: nowSec(),
    attempts: 0,
    credits: hint.credits,
    seconds: hint.seconds,
  };
  jobs.push(job);
  await saveBlob(KEY, jobs);
  return { job, ahead: aheadOf(jobs, job), accepted: true };
}

/** How many queued jobs outrank this one, counted in the database. */
async function aheadOfRemote(job: Job): Promise<number> {
  if (job.status !== "queued") return 0;
  const rows = await table<{ mint: string }[]>(
    `select=mint&status=eq.queued&or=(requests.gt.${job.requests},and(requests.eq.${job.requests},at.lt.${job.at}))`,
  );
  return rows?.length ?? 0;
}

/**
 * Most-wanted first, then oldest.
 *
 * Demand rather than arrival, so a token twenty people are waiting on is not
 * stuck behind one nobody has asked about since.
 */
function order(jobs: Job[]): Job[] {
  return jobs
    .filter((j) => j.status === "queued")
    .sort((a, b) => b.requests - a.requests || a.at - b.at);
}

function aheadOf(jobs: Job[], job: Job): number {
  return order(jobs).findIndex((j) => j.mint === job.mint);
}

export async function statusOf(mint: string): Promise<{ job: Job; ahead: number } | null> {
  const rows = await table<JobRow[]>(
    `select=*&mint=eq.${encodeURIComponent(mint)}&limit=1`,
  );
  if (rows) {
    const row = rows[0];
    if (!row) return null;
    const job = fromRow(row);
    return { job, ahead: await aheadOfRemote(job) };
  }

  const jobs = prune(await read());
  const job = jobs.find((j) => j.mint === mint);
  if (!job) return null;
  return { job, ahead: job.status === "queued" ? aheadOf(jobs, job) : 0 };
}

/**
 * The status of many mints at once, for a page rendering a list of them.
 *
 * One read rather than one per row. Only in-flight states come back — a token
 * that is done or was never asked for is simply absent, which is what the
 * caller wants to show anyway.
 */
export async function queued(mints: string[]): Promise<Map<string, JobStatus>> {
  const wanted = new Set(mints);
  const out = new Map<string, JobStatus>();
  if (wanted.size === 0) return out;

  const list = [...wanted].map((m) => `"${m}"`).join(",");
  const rows = await table<JobRow[]>(
    `select=mint,status&status=in.(queued,building)&mint=in.(${encodeURIComponent(list)})`,
  );
  if (rows) {
    for (const r of rows) out.set(r.mint, r.status);
    return out;
  }

  for (const job of prune(await read())) {
    if (!wanted.has(job.mint)) continue;
    if (job.status === "queued" || job.status === "building") out.set(job.mint, job.status);
  }
  return out;
}

export async function depth(): Promise<number> {
  const rows = await table<{ mint: string }[]>("select=mint&status=eq.queued");
  if (rows) return rows.length;
  return order(prune(await read())).length;
}

/** Take the next job, marking it building so nothing else takes it too. */
export async function claim(): Promise<Job | null> {
  /**
   * The update picks its own row, so two workers cannot take the same job.
   *
   * `for update skip locked` inside the function means the second worker walks
   * past a row the first is claiming rather than blocking on it or duplicating
   * it — which on a blob was only prevented by there being one worker.
   */
  const row = await rpc<JobRow | null>("trickshot_claim", { p_stale: STALE_SEC });
  if (row !== null) return row.mint ? fromRow(row) : null;

  const jobs = prune(await read());
  const next = order(jobs)[0];
  if (!next) {
    await saveBlob(KEY, jobs);
    return null;
  }
  next.status = "building";
  next.startedAt = nowSec();
  next.attempts += 1;
  await saveBlob(KEY, jobs);
  return next;
}

export async function finish(
  mint: string,
  /** `terminal` marks a failure retrying cannot fix, so it does not requeue. */
  outcome: { ok: boolean; error?: string; terminal?: boolean },
): Promise<void> {
  const remote = supabase();
  if (remote) {
    const rows = await table<JobRow[]>(
      `select=attempts&mint=eq.${encodeURIComponent(mint)}&limit=1`,
    );
    const attempts = rows?.[0]?.attempts ?? MAX_ATTEMPTS;
    const status = outcome.ok
      ? "done"
      : outcome.terminal
        ? "failed"
      : // Back in the queue while it has attempts left; a token that keeps
        // failing is usually one with no readable pool, and retrying for ever
        // is a way to spend money on the same disappointment.
        attempts >= MAX_ATTEMPTS
        ? "failed"
        : "queued";
    const done = await table(
      `mint=eq.${encodeURIComponent(mint)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status,
          error: outcome.error ?? null,
          finished_at: nowSec(),
          started_at: null,
        }),
      },
    );
    if (done !== null) return;
  }

  const jobs = prune(await read());
  const job = jobs.find((j) => j.mint === mint);
  if (!job) return;
  if (outcome.ok) {
    job.status = "done";
  } else {
    // Back in the queue while it has attempts left; a token that keeps failing
    // is usually one with no readable pool, and retrying it for ever is just a
    // way to spend money on the same disappointment.
    job.status =
      outcome.terminal || job.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
    job.error = outcome.error;
  }
  job.finishedAt = nowSec();
  job.startedAt = undefined;
  await saveBlob(KEY, jobs);
}
