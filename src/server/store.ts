import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "./candles";
import type { Venue } from "./pool";

/**
 * Anything built from the chain, kept between requests.
 *
 * A token's past does not change. Rebuilding a month of it on every visit is
 * the one cost in this app that buys nothing — the bars before the last one
 * are the same bars they were an hour ago, and a wallet's trades from last
 * Tuesday will never be different. Keeping them turns a second visit from a
 * full reconstruction into a read plus whatever happened since.
 *
 * Two backends, chosen by what is configured rather than by a flag. Supabase
 * when its two environment variables are set, which is the deployed case and
 * is shared across serverless instances; otherwise a file on disk, which needs
 * no setup and is enough for `next dev` and for one long-lived server. Both
 * are caches: losing either costs time, never correctness — which is why every
 * failure here is swallowed rather than raised.
 */

const TABLE = process.env.SUPABASE_TABLE ?? "trickshot_cache";
/**
 * Where the file cache lives.
 *
 * Project-local rather than the OS temp directory. Temp is cleaned out
 * periodically by the system, and it takes the gallery of built tokens and the
 * trader boards with it — boards cost minutes to build, so losing them to a
 * housekeeping job is expensive. Deployments that mount a read-only filesystem
 * set the Supabase variables instead; the write below already fails quietly.
 */
const DIR =
  process.env.TRICKSHOT_CACHE_DIR ?? path.join(process.cwd(), ".trickshot-cache");

/**
 * The Supabase endpoint, and whichever key this instance was given.
 *
 * Deliberately not named for one key. A deployment that only serves what has
 * already been indexed wants the ANON key with a read-only policy on this one
 * table: it can read everything the site shows and cannot write, so a leak
 * costs nothing. The machine doing the indexing wants the service key. Same
 * code, different reach.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is still read as a fallback so an existing
 * setup keeps working.
 */
function supabase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

/** Hashed, so a key may contain anything and still be a filename. */
function fileFor(key: string): string {
  return path.join(DIR, `${createHash("sha256").update(key).digest("hex")}.json`);
}

export async function loadBlob<T>(key: string): Promise<T | null> {
  const remote = supabase();
  if (remote) {
    try {
      const res = await fetch(
        `${remote.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(key)}&select=payload`,
        {
          headers: { apikey: remote.key, authorization: `Bearer ${remote.key}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        const rows = (await res.json()) as { payload?: T }[];
        /**
         * A MISS is an answer, and the answer is no.
         *
         * Falling through to disk here looked harmless and quietly broke
         * publishing: a token already built locally answered from the file
         * cache, so the indexer returned early and never wrote it upstream.
         * It reported success and the deployment saw nothing. Disk is the
         * fallback for when Supabase is ABSENT or DOWN, never a second place
         * to look when it has already said no.
         */
        return rows[0]?.payload ?? null;
      }
    } catch {
      // Unreachable, not empty. Disk may still have it, and a cache that is
      // down is a slow request rather than an error.
    }
  }

  try {
    return JSON.parse(await readFile(fileFor(key), "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * How many keys one `id=in.(…)` may name.
 *
 * A URL, not a body — so the whole key list has to fit in one. The board hands
 * this ~220 wallet addresses at a time, and `identity:` plus 44 base58
 * characters times 220 is roughly 12KB of query string, past what the gateway
 * in front of PostgREST accepts. Fifty keys is ~2.7KB, comfortably inside it,
 * and the chunks run in parallel anyway.
 */
const READ_CHUNK = 50;

/**
 * Many blobs in one round trip.
 *
 * The board's identity lookup is the case that forced this: reading a cache of
 * 220 wallets one `loadBlob` at a time is 220 sequential round trips to save
 * three calls to Helius, which is worse than not caching at all.
 */
export async function loadBlobs<T>(keys: string[]): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  const unique = [...new Set(keys)].filter(Boolean);
  if (unique.length === 0) return found;

  const remote = supabase();
  if (remote) {
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += READ_CHUNK) {
      chunks.push(unique.slice(i, i + READ_CHUNK));
    }
    const pages = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const list = chunk.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(",");
          const res = await fetch(
            `${remote.url}/rest/v1/${TABLE}?id=in.(${encodeURIComponent(list)})&select=id,payload`,
            {
              headers: { apikey: remote.key, authorization: `Bearer ${remote.key}` },
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!res.ok) return [];
          return (await res.json()) as { id: string; payload: T }[];
        } catch {
          return [];
        }
      }),
    );
    for (const rows of pages) {
      for (const row of rows) found.set(row.id, row.payload);
    }
    // As in `loadBlob`: Supabase answering is the answer. Disk is only for
    // when it is absent or unreachable, never a second place to look.
    return found;
  }

  await Promise.all(
    unique.map(async (key) => {
      const held = await loadBlob<T>(key);
      if (held !== null) found.set(key, held);
    }),
  );
  return found;
}

/**
 * Many blobs in one write.
 *
 * PostgREST upserts an array body in a single call, so caching a batch of
 * identities costs one request rather than one per address — which matters
 * because the thing being cached only cost three requests to fetch.
 */
export async function saveBlobs(entries: { key: string; value: unknown }[]): Promise<void> {
  if (entries.length === 0) return;
  const remote = supabase();
  if (remote) {
    try {
      const now = new Date().toISOString();
      const res = await fetch(`${remote.url}/rest/v1/${TABLE}`, {
        method: "POST",
        headers: {
          apikey: remote.key,
          authorization: `Bearer ${remote.key}`,
          "content-type": "application/json",
          prefer: "resolution=merge-duplicates",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify(
          entries.map((e) => ({ id: e.key, payload: e.value, updated_at: now })),
        ),
      });
      if (!res.ok) {
        console.error(
          `[store] batch write of ${entries.length} rejected: ${res.status} ${await res
            .text()
            .catch(() => "")}`,
        );
      }
    } catch (error) {
      console.error(`[store] batch write failed: ${(error as Error).message}`);
    }
    return;
  }

  await Promise.all(entries.map((e) => saveBlob(e.key, e.value)));
}

export async function saveBlob(key: string, value: unknown): Promise<void> {
  const remote = supabase();
  if (remote) {
    try {
      const res = await fetch(`${remote.url}/rest/v1/${TABLE}`, {
        method: "POST",
        headers: {
          apikey: remote.key,
          authorization: `Bearer ${remote.key}`,
          "content-type": "application/json",
          prefer: "resolution=merge-duplicates",
        },
        signal: AbortSignal.timeout(10_000),
        // `updated_at` is sent rather than left to its default so it moves on
        // an upsert too, which is when it is actually interesting.
        body: JSON.stringify({
          id: key,
          payload: value,
          updated_at: new Date().toISOString(),
        }),
      });
      /**
       * A rejected write is reported, because it used to be invisible.
       *
       * Every failure in this file is swallowed on the grounds that a cache is
       * a convenience — true for reads, and false for writes: a build that
       * cost minutes and did not persist is not slower, it is lost, and the
       * next request pays for it again. PostgREST answers a column it does not
       * know with a 400, so a table created from an out-of-date DDL fails
       * every single write while looking perfectly healthy.
       */
      if (!res.ok) {
        console.error(
          `[store] write of ${key} rejected: ${res.status} ${await res.text().catch(() => "")}`,
        );
      }
    } catch (error) {
      console.error(`[store] write of ${key} failed: ${(error as Error).message}`);
    }
  }

  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(fileFor(key), JSON.stringify(value));
  } catch {
    // A read-only filesystem is the normal deployed case when Supabase is
    // configured, so this is not worth reporting.
  }
}

export interface Series {
  mint: string;
  interval: number;
  venue: Venue;
  /** Ascending, one per interval, gaps already filled. */
  candles: Candle[];
  /**
   * True only if every bar in here was built from every swap in its window.
   *
   * Stored rather than recomputed because a cached series outlives the request
   * that built it: a window served three-quarters from cache reported itself
   * exact on the strength of the one fresh bar, which is how a chart sampled
   * from 1.8 million swaps came back labelled "every trade".
   */
  exact: boolean;
  /** When the newest bar was built, so a live token can be topped up. */
  builtAt: number;
}

/**
 * Bumped when a fix changes the BARS a given window builds to, rather than the
 * shape they are stored in.
 *
 * A cached series is only ever topped up — `missingRanges` refetches the bars
 * it does not have and leaves the rest — so a bar built by a version with a
 * pricing bug in it is permanent, and a corrected build never runs. v2 is the
 * dust and non-trade outlier guards in `candles.ts`, without which this
 * token's chart drew market caps in the trillions.
 */
const seriesKey = (mint: string, interval: number) => `series:v2:${mint}:${interval}`;

export const loadSeries = (mint: string, interval: number) =>
  loadBlob<Series>(seriesKey(mint, interval));

export const saveSeries = (series: Series) =>
  saveBlob(seriesKey(series.mint, series.interval), series);

/**
 * Where a token has bars finer than its own chart, so a replay can zoom in.
 *
 * Its own blob, and a tiny one, because it is read on the REQUEST path — every
 * wallet replay asks whether this mint can be zoomed. Deriving it from the
 * fine series instead means pulling that whole series to look at its first and
 * last bar: MEASURED, 1.18MB for five days of one-minute bars, and 6.8MB had
 * it covered the token's life. A hundred bytes answers the same question.
 */
export interface ZoomIndex {
  mint: string;
  /** Bar width of the fine series, seconds. */
  interval: number;
  /**
   * The CONTIGUOUS spans it covers, unix seconds, ascending.
   *
   * Ranges rather than one from/to, because a token can be built over two
   * stretches that do not touch — its launch and its best day a fortnight
   * later. Collapsed to first-bar-to-last-bar, the empty fortnight between
   * them would be advertised as zoomable, and asking for a section inside it
   * would put a live build on the request path, which is the one thing this
   * index exists to prevent.
   */
  ranges: { from: number; to: number }[];
}

export const loadZoom = (mint: string) => loadBlob<ZoomIndex>(`zoom:${mint}`);

export const saveZoom = (zoom: ZoomIndex) => saveBlob(`zoom:${zoom.mint}`, zoom);

/**
 * Which parts of a window the cache cannot answer.
 *
 * Returned as whole intervals so the caller fetches bar-aligned ranges. The
 * newest cached bar is always refetched: it was built while its own interval
 * was still open, so it is the one bar that can still change.
 */
export function missingRanges(
  series: Series | null,
  from: number,
  to: number,
  interval: number,
): { from: number; to: number }[] {
  const start = Math.floor(from / interval) * interval;
  const end = Math.ceil(to / interval) * interval;
  if (!series || series.candles.length === 0) return [{ from: start, to: end }];

  const have = new Set(series.candles.map((c) => c.t));
  const newest = series.candles[series.candles.length - 1]?.t ?? 0;
  have.delete(newest);

  const gaps: { from: number; to: number }[] = [];
  let open: { from: number; to: number } | null = null;
  for (let t = start; t < end; t += interval) {
    if (have.has(t)) {
      if (open) {
        gaps.push(open);
        open = null;
      }
      continue;
    }
    if (open) open.to = t + interval;
    else open = { from: t, to: t + interval };
  }
  if (open) gaps.push(open);
  return gaps;
}

/** Newly built bars over cached ones, ascending, one per interval. */
export function mergeCandles(existing: Candle[], fresh: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of existing) byTime.set(c.t, c);
  for (const c of fresh) byTime.set(c.t, c);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * What has already been built, for the page to offer back.
 *
 * There is no list of "tokens you can replay" — it is any Solana mint, and
 * nothing is indexed ahead of time. What there IS is a list of tokens this
 * install has already reconstructed, and those are worth surfacing because
 * they load in a couple of seconds instead of ten.
 *
 * Kept as its own small blob rather than by scanning the cache: the file
 * backend names its files by hash, and the Supabase one would need a query per
 * key. One index, rewritten on each build, answers it either way.
 */
export interface BuiltToken {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  /** Bar width the token was last drawn at. */
  interval: number;
  bars: number;
  firstTs: number;
  lastTs: number;
  /** Swaps on the charted book over its life. */
  swaps: number;
  builtAt: number;
  /**
   * How much of the token this chart actually covers.
   *
   * `full` is the mint-only rebuild: the whole life, at one bar width. Any
   * wallet replay produces `window` — one wallet's slice, padded, and nothing
   * either side of it. Both are legitimate charts and they are not
   * interchangeable, so the gallery shows only `full` and the wallet pages may
   * show either. Without the distinction, letting visitors build turns the
   * home page into a list of half-drawn tokens.
   *
   * Optional so a row written before this existed reads back as `undefined`
   * rather than a wrong answer; treat that as `full`, since every such row was
   * written by the owner running the indexer.
   */
  coverage?: Coverage;
}

export type Coverage = "window" | "full";

/** `full` always wins. A slice never demotes a whole-life chart. */
function mergeCoverage(a?: Coverage, b?: Coverage): Coverage {
  return a === "full" || b === "full" ? "full" : "window";
}

const INDEX_KEY = "index:tokens";
/**
 * Whole-life charts kept. These are the gallery.
 *
 * Each one cost a deliberate act — the owner running the indexer — so they are
 * never evicted to make room for a visitor's wallet window.
 */
const INDEX_MAX = Number(process.env.TRICKSHOT_INDEX_MAX ?? 200);
/**
 * Wallet windows kept, over and above those.
 *
 * Held in their own budget rather than sharing one list, because they arrive
 * at a completely different rate: a `full` row appears when someone indexes a
 * token, and a `window` row appears every time any visitor replays any wallet
 * on any mint. Sharing a cap means the second kind evicts the first within an
 * afternoon of traffic, and a `full` row falling out of the index is not a
 * cosmetic loss — the token vanishes from the gallery while its series and
 * board blobs stay behind, orphaned and unreachable.
 */
const WINDOW_MAX = Number(process.env.TRICKSHOT_WINDOW_MAX ?? 400);

/** A table row as PostgREST returns it, snake_case and all. */
interface TokenRow {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  interval: number;
  bars: number;
  first_ts: number;
  last_ts: number;
  swaps: number;
  coverage: Coverage;
  built_at: number;
}

const fromRow = (r: TokenRow): BuiltToken => ({
  mint: r.mint,
  name: r.name ?? undefined,
  symbol: r.symbol ?? undefined,
  image: r.image ?? undefined,
  interval: r.interval,
  bars: r.bars,
  firstTs: r.first_ts ?? 0,
  lastTs: r.last_ts,
  swaps: r.swaps,
  coverage: r.coverage,
  builtAt: r.built_at,
});

async function query(path: string): Promise<TokenRow[] | null> {
  const remote = supabase();
  if (!remote) return null;
  try {
    const res = await fetch(`${remote.url}/rest/v1/trickshot_tokens?${path}`, {
      headers: { apikey: remote.key, authorization: `Bearer ${remote.key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as TokenRow[];
  } catch {
    return null;
  }
}

/**
 * Every known token. Prefer `galleryTokens` or `tokenRow` — this loads all of
 * them, which is exactly the cost the table exists to avoid.
 */
export async function builtTokens(): Promise<BuiltToken[]> {
  const rows = await query("select=*&order=built_at.desc&limit=1000");
  if (rows) return rows.map(fromRow);
  return (await loadBlob<BuiltToken[]>(INDEX_KEY)) ?? [];
}

/**
 * Newest first, one row per mint, MERGED with whatever is already there.
 *
 * Merged rather than replaced because the three paths that build a chart know
 * different things about the token: the mint-only rebuild has its name and its
 * lifetime swap count, a wallet replay has the name but only its own window,
 * and the trader board has neither. Overwriting from whichever ran last is how
 * a token that was fully rebuilt an hour ago loses its name.
 */
export async function rememberToken(
  token: Partial<BuiltToken> & { mint: string },
): Promise<void> {
  /**
   * One atomic upsert where this used to be read-modify-write.
   *
   * The old shape loaded the whole index, merged in JS and wrote it all back —
   * so two builds finishing together lost one of each other's rows, and the
   * loser vanished from the gallery while its series and board blobs stayed
   * behind, orphaned and unreachable. Postgres merges column by column in one
   * statement, which is both cheaper and impossible to race.
   */
  const remote = supabase();
  if (remote) {
    try {
      const res = await fetch(`${remote.url}/rest/v1/rpc/trickshot_remember`, {
        method: "POST",
        headers: {
          apikey: remote.key,
          authorization: `Bearer ${remote.key}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          p_mint: token.mint,
          p_name: token.name ?? null,
          p_symbol: token.symbol ?? null,
          p_image: token.image ?? null,
          p_interval: token.interval ?? 0,
          p_bars: token.bars ?? 0,
          p_first_ts: token.firstTs ?? 0,
          p_last_ts: token.lastTs ?? 0,
          p_swaps: token.swaps ?? 0,
          p_coverage: token.coverage ?? "window",
          p_built_at: token.builtAt ?? 0,
        }),
      });
      if (res.ok) return;
      console.error(
        res.status === 404
          ? "[store] trickshot_remember is missing — run scripts/migrate.sql. Using the index blob until then."
          : `[store] remember ${token.mint} rejected: ${res.status}`,
      );
    } catch (error) {
      console.error(`[store] remember ${token.mint} failed: ${(error as Error).message}`);
    }
    // Falls through to the blob, so nothing is lost while the table is absent.
  }

  const held = (await loadBlob<BuiltToken[]>(INDEX_KEY)) ?? [];
  const existing = held.find((t) => t.mint === token.mint);

  const merged: BuiltToken = {
    mint: token.mint,
    name: token.name ?? existing?.name,
    symbol: token.symbol ?? existing?.symbol,
    image: token.image ?? existing?.image,
    interval: token.interval ?? existing?.interval ?? 0,
    bars: Math.max(token.bars ?? 0, existing?.bars ?? 0),
    firstTs: Math.min(token.firstTs || Infinity, existing?.firstTs || Infinity),
    lastTs: Math.max(token.lastTs ?? 0, existing?.lastTs ?? 0),
    swaps: Math.max(token.swaps ?? 0, existing?.swaps ?? 0),
    builtAt: token.builtAt ?? existing?.builtAt ?? 0,
  };
  if (!Number.isFinite(merged.firstTs)) merged.firstTs = 0;
  merged.coverage = mergeCoverage(
    token.coverage,
    existing ? (existing.coverage ?? "full") : undefined,
  );

  const rest = held.filter((t) => t.mint !== token.mint);
  const ordered = [merged, ...rest];
  const full = ordered.filter((t) => (t.coverage ?? "full") === "full").slice(0, INDEX_MAX);
  const windows = ordered
    .filter((t) => (t.coverage ?? "full") === "window")
    .slice(0, WINDOW_MAX);
  await saveBlob(INDEX_KEY, [...full, ...windows]);
}

/**
 * What the gallery shows: whole-life charts only, newest first.
 *
 * A LIMIT where it used to be "load every row and slice", which is the
 * difference between a fixed cost and one that grows with the catalogue.
 */
export async function galleryTokens(limit = INDEX_MAX): Promise<BuiltToken[]> {
  const rows = await query(
    `select=*&coverage=eq.full&order=built_at.desc&limit=${limit}`,
  );
  if (rows && rows.length > 0) return rows.map(fromRow);

  /**
   * An empty table is not the same as an authoritative "no tokens".
   *
   * Row-level security filters rows rather than refusing the request, so a key
   * without access gets 200 and `[]` — indistinguishable from a table nobody
   * has written yet. Treating that as the answer emptied a live gallery that
   * had ten tokens sitting in the blob beside it.
   *
   * Consulting the blob when the table says nothing costs one read on an
   * install that has genuinely built nothing, and is the difference between a
   * migration that degrades and one that takes the site down.
   */
  const all = await loadBlob<BuiltToken[]>(INDEX_KEY);
  return (all ?? []).filter((t) => (t.coverage ?? "full") === "full").slice(0, limit);
}

/**
 * One row, without reading the rest.
 *
 * The hot one: every request that names a mint asks this, and on the blob it
 * meant fetching the whole index to answer a question about a single token.
 */
export async function tokenRow(mint: string): Promise<BuiltToken | null> {
  const rows = await query(`select=*&mint=eq.${encodeURIComponent(mint)}&limit=1`);
  if (rows && rows[0]) return fromRow(rows[0]);
  // A miss falls through for the same reason `galleryTokens` does: under RLS a
  // blocked read is an empty result, not an error.
  const all = await loadBlob<BuiltToken[]>(INDEX_KEY);
  return (all ?? []).find((t) => t.mint === mint) ?? null;
}
