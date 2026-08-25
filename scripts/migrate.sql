-- Trickshot: schema for a deployment that builds.
--
-- Apply in the Supabase SQL editor.
--
-- Safe to run against a live database and safe to re-run: every statement is
-- `if not exists` or `create or replace`, and nothing is dropped.
--
-- Section 3 enables row-level security with no policies, which means the
-- deployment MUST hold the service-role key. Read it before you run it — if
-- your deployment is on an anon key today, that section is what will change
-- its access.
--
-- The file backend (no SUPABASE_URL) needs none of this and keeps working
-- exactly as it does today — counters and budgets simply fall back to
-- per-process counting, which is correct for one long-lived server.


-- ---------------------------------------------------------------------------
-- 1. The blob cache.
-- ---------------------------------------------------------------------------
--
-- The DDL published in .env.example omitted `updated_at`, which `saveBlob`
-- sends on every write. PostgREST answers an unknown column with a 400, so a
-- table created from that older DDL rejected EVERY write while looking
-- perfectly healthy — the errors were swallowed. `saveBlob` now logs them, and
-- this is the shape it expects.

create table if not exists trickshot_cache (
  id         text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

alter table trickshot_cache
  add column if not exists updated_at timestamptz not null default now();

-- Least-recently-written first, for a future eviction sweep. Nothing is
-- deleted today, so storage grows with traffic; this is what makes it
-- cheap to find the coldest rows when that changes.
create index if not exists trickshot_cache_updated_at
  on trickshot_cache (updated_at);


-- ---------------------------------------------------------------------------
-- 2. Counters, for rate limits and the daily credit ceiling.
-- ---------------------------------------------------------------------------
--
-- Needed only by a deployment with a writable key, i.e. one where visitors can
-- start builds. A read-only install can skip this section entirely.
--
-- Counting has to be ATOMIC and cross-instance. Read-modify-write over a blob
-- is fine for a cache — a lost write costs a rebuild — and useless for a limit,
-- because two instances reading "1" and both writing "2" is exactly the case
-- the limit exists to catch. Postgres can add and return in one statement, so
-- it does.

create table if not exists trickshot_counters (
  -- What is being counted, and over which window. The window start is part of
  -- the key so expiry is arithmetic rather than a job: yesterday's rows simply
  -- stop being addressed.
  id         text primary key,
  count      bigint not null default 0,
  expires_at timestamptz not null
);

create index if not exists trickshot_counters_expires_at
  on trickshot_counters (expires_at);

-- Add `amount` to a counter and return the running total.
--
-- `amount` rather than a bare increment because the same mechanism serves two
-- different jobs: request counting adds one, and the credit ceiling adds what
-- a phase actually cost. Both want the same atomicity.
create or replace function trickshot_bump(
  counter_id text,
  amount     bigint,
  ttl_seconds integer
) returns bigint
language plpgsql
as $$
declare
  total bigint;
begin
  insert into trickshot_counters (id, count, expires_at)
    values (counter_id, amount, now() + make_interval(secs => ttl_seconds))
  on conflict (id) do update
    set count = trickshot_counters.count + excluded.count
  returning count into total;
  return total;
end;
$$;

-- Housekeeping. Safe to call from anywhere; there is no job scheduled for it.
create or replace function trickshot_sweep_counters() returns void
language sql
as $$
  delete from trickshot_counters where expires_at < now();
$$;


-- ---------------------------------------------------------------------------
-- 2b. The token index, as a table rather than one JSON row.
-- ---------------------------------------------------------------------------
--
-- It began as a single `index:tokens` blob, which every request loads in full:
-- `tokenRow`, `coverageOf` and the gallery all read the whole array to answer a
-- question about one mint. Nine rows is 3KB and invisible; six hundred is
-- ~200KB fetched per request, and `rememberToken` rewrites all of it on every
-- build, so two concurrent builds lose each other's row.
--
-- A table makes the lookup one row, the gallery a LIMIT, and the write an
-- upsert that cannot lose a neighbour.

create table if not exists trickshot_tokens (
  mint         text primary key,
  name text, symbol text, image text,
  interval     int    not null default 0,
  bars         int    not null default 0,
  first_ts     bigint not null default 0,
  last_ts      bigint not null default 0,
  swaps        bigint not null default 0,
  coverage     text   not null default 'window',
  built_at     bigint not null default 0,
  updated_at   timestamptz not null default now()
);

create index if not exists trickshot_tokens_gallery
  on trickshot_tokens (coverage, built_at desc);

-- Merge, never overwrite.
--
-- The three paths that build a chart know different things about a token: the
-- whole-life rebuild has its name and lifetime swap count, a wallet replay has
-- the name and only its own window, the board has neither. Taking whichever
-- wrote last is how a fully indexed token loses its name — so each column is
-- combined on the rule that suits it, and `full` coverage never degrades back
-- to `window`.
create or replace function trickshot_remember(
  p_mint text, p_name text, p_symbol text, p_image text,
  p_interval int, p_bars int, p_first_ts bigint, p_last_ts bigint,
  p_swaps bigint, p_coverage text, p_built_at bigint
) returns void
language sql
as $$
  insert into trickshot_tokens as t
    (mint, name, symbol, image, interval, bars, first_ts, last_ts, swaps,
     coverage, built_at, updated_at)
  values
    (p_mint, p_name, p_symbol, p_image, p_interval, p_bars,
     nullif(p_first_ts, 0), p_last_ts, p_swaps, p_coverage, p_built_at, now())
  on conflict (mint) do update set
    name     = coalesce(excluded.name,   t.name),
    symbol   = coalesce(excluded.symbol, t.symbol),
    image    = coalesce(excluded.image,  t.image),
    interval = coalesce(nullif(excluded.interval, 0), t.interval),
    bars     = greatest(excluded.bars,     t.bars),
    swaps    = greatest(excluded.swaps,    t.swaps),
    last_ts  = greatest(excluded.last_ts,  t.last_ts),
    first_ts = least(nullif(excluded.first_ts, 0), nullif(t.first_ts, 0)),
    built_at = greatest(excluded.built_at, t.built_at),
    coverage = case when t.coverage = 'full' or excluded.coverage = 'full'
                    then 'full' else 'window' end,
    updated_at = now();
$$;

grant execute on function trickshot_remember(
  text, text, text, text, int, int, bigint, bigint, bigint, text, bigint
) to service_role;


-- ---------------------------------------------------------------------------
-- 2c. The build queue, as a table.
-- ---------------------------------------------------------------------------
--
-- Same problem as the token index, worse consequence. The queue was one JSON
-- blob read, modified and written back, so two visitors enqueueing at the same
-- moment lost one of each other's jobs — and a lost job is somebody waiting on
-- a page that will never update. It self-heals on their next click, at the
-- cost of another pre-flight.
--
-- `windows` is jsonb because a job accumulates one entry per bar width people
-- have asked for, merged where they overlap. It is a list the worker consumes,
-- not something to query on.

create table if not exists trickshot_jobs (
  mint        text primary key,
  status      text   not null default 'queued',
  windows     jsonb  not null default '[]'::jsonb,
  requests    int    not null default 1,
  attempts    int    not null default 0,
  credits     int,
  seconds     int,
  error       text,
  at          bigint not null,
  started_at  bigint,
  finished_at bigint
);

create index if not exists trickshot_jobs_next
  on trickshot_jobs (status, requests desc, at);

-- Fold a window into a job's list, widening only where spans OVERLAP.
--
-- The first version was `windows || p_window`, which appended: asking twice
-- for the same token stored the same span twice and the worker built it twice.
-- Matching on bar width alone and taking min/max is the opposite mistake —
-- two wallets that both want 900s bars but traded a month apart become one
-- window spanning that month, MEASURED at 2,833 bars against a whole-life
-- chart's cap of 400.
--
-- Overlapping spans are genuinely cheaper as one build, because the middle is
-- read once. Disjoint ones are two builds either way.
create or replace function trickshot_merge_window(p_windows jsonb, p_window jsonb)
returns jsonb
language sql immutable
as $$
  select case
    when p_window is null then p_windows
    -- Nothing it overlaps: keep it separate, up to a bounded number of rungs.
    when not exists (
      select 1 from jsonb_array_elements(p_windows) w
       where (w->>'interval')::bigint = (p_window->>'interval')::bigint
         and (p_window->>'from')::bigint <= (w->>'to')::bigint
         and (p_window->>'to')::bigint   >= (w->>'from')::bigint
    ) then
      case when jsonb_array_length(p_windows) >= 6 then p_windows
           else p_windows || jsonb_build_array(p_window) end
    else (
      select jsonb_agg(
        case
          when (w->>'interval')::bigint = (p_window->>'interval')::bigint
           and (p_window->>'from')::bigint <= (w->>'to')::bigint
           and (p_window->>'to')::bigint   >= (w->>'from')::bigint
          then jsonb_build_object(
                 'interval', (w->>'interval')::bigint,
                 'from', least((w->>'from')::bigint, (p_window->>'from')::bigint),
                 'to',   greatest((w->>'to')::bigint, (p_window->>'to')::bigint))
          else w
        end)
      from jsonb_array_elements(p_windows) w
    )
  end;
$$;

grant execute on function trickshot_merge_window(jsonb, jsonb) to service_role;

-- Ask for a build, or join the ask already standing.
--
-- The dedup, and the whole reason this is affordable: ten people wanting the
-- same token is one build. A repeat ask still counts, because demand is how
-- the queue is ordered.
create or replace function trickshot_enqueue(
  p_mint text, p_window jsonb, p_credits int, p_seconds int, p_max_depth int
) returns trickshot_jobs
language plpgsql
as $$
declare
  row   trickshot_jobs;
  depth int;
begin
  select * into row from trickshot_jobs where mint = p_mint;

  if found then
    update trickshot_jobs set
      requests = requests + 1,
      -- A finished job asked for again goes back in: the token may have moved
      -- on, and refusing leaves the asker no way forward.
      status   = case when status in ('done','failed') then 'queued' else status end,
      attempts = case when status in ('done','failed') then 0 else attempts end,
      error    = case when status in ('done','failed') then null else error end,
      at       = case when status in ('done','failed') then p_at_now() else at end,
      windows  = trickshot_merge_window(windows, p_window)
    where mint = p_mint
    returning * into row;
    return row;
  end if;

  select count(*) into depth from trickshot_jobs
   where status in ('queued','building');
  if depth >= p_max_depth then
    return null;
  end if;

  insert into trickshot_jobs (mint, status, windows, requests, at, credits, seconds)
  values (p_mint, 'queued',
          case when p_window is null then '[]'::jsonb else jsonb_build_array(p_window) end,
          1, p_at_now(), p_credits, p_seconds)
  returning * into row;
  return row;
end;
$$;

-- Unix seconds, so the app and the database agree on the clock.
create or replace function p_at_now() returns bigint
language sql immutable
as $$ select extract(epoch from now())::bigint $$;

-- Take the next job, and mark it taken in the same statement.
--
-- The important part is that two workers cannot take the same one: the update
-- picks its own row and returns it, so the second worker finds it already
-- 'building' and moves on. A claim older than p_stale is treated as a dead
-- worker and may be taken again.
create or replace function trickshot_claim(p_stale int) returns trickshot_jobs
language sql
as $$
  update trickshot_jobs set
    status = 'building', started_at = p_at_now(), attempts = attempts + 1
  where mint = (
    select mint from trickshot_jobs
     where status = 'queued'
        or (status = 'building' and coalesce(started_at, at) < p_at_now() - p_stale)
     order by requests desc, at
     limit 1
     for update skip locked
  )
  returning *;
$$;

grant execute on function trickshot_enqueue(text, jsonb, int, int, int) to service_role;
grant execute on function p_at_now() to service_role;
grant execute on function trickshot_claim(int) to service_role;


-- ---------------------------------------------------------------------------
-- 3. Access.
-- ---------------------------------------------------------------------------
--
-- Enable RLS on all four tables, and give NOBODY a policy.
--
-- That reads as locking yourself out, and it is the point. The service role
-- bypasses RLS entirely, so the deployment keeps full access; every other key
-- gets nothing. There is no policy to get subtly wrong, and a leaked anon key
-- is worth nothing rather than worth a rewrite of your cache.
--
-- This REQUIRES the deployment to hold the service-role key. That key is read
-- only by `src/server/*`, never prefixed `NEXT_PUBLIC_`, and never sent to the
-- browser — so it lives in the same place as the Helius key and carries the
-- same risk, which is server compromise and nothing else.
--
-- Get it wrong and nothing breaks loudly: `store.ts` and `queue.ts` fall back
-- to JSON blobs and per-process counters, log once, and carry on. Correct for
-- one long-lived server, too loose for serverless — each instance counts its
-- own share. Check `/api/usage`: `"shared": false` means you are on that path.

alter table trickshot_cache    enable row level security;
alter table trickshot_counters enable row level security;
alter table trickshot_tokens   enable row level security;
alter table trickshot_jobs     enable row level security;

-- Deliberately no policies. See above.
--
-- If you would rather run the site on an anon key, you need a select policy on
-- `trickshot_tokens` and `trickshot_jobs`, write access to `trickshot_cache`,
-- and the three functions changed to `security definer` with a pinned
-- `search_path` so they may write the tables the caller cannot. That is more
-- moving parts to hold correct, for a key that is no less powerful in practice
-- because it can still queue builds and spend your credits.

-- What you have now, if you want to check before or after:
--
--   select relname, relrowsecurity
--     from pg_class
--    where relname like 'trickshot_%';
--
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where tablename like 'trickshot_%';


-- ---------------------------------------------------------------------------
-- 4. What is NOT here.
-- ---------------------------------------------------------------------------
--
-- No eviction, anywhere. `trickshot_cache` grows with traffic: a series blob
-- per token per bar width, a replay verdict per wallet-and-token. The
-- `updated_at` index above is what a sweep would use when that matters.
--
-- The file backend keeps the old `index:tokens` blob rather than this table —
-- one long-lived process has no lost-update problem and no per-request cost
-- worth removing, and `next dev` should not need Postgres to start.
