/**
 * What a visitor may start, and what the whole site may spend in a day.
 *
 * Until now the answer to both was `TRICKSHOT_READONLY`: the deployment built
 * nothing, so nothing needed bounding. A deployment that DOES build needs the
 * distinction the flag never made — a wallet overlay and a whole-life
 * reconstruction arrive at the same endpoint and differ in cost by roughly
 * four thousand times, so they cannot share an allowance.
 *
 * Counting is atomic and shared where it can be. Read-modify-write is fine for
 * a cache, where a lost write costs a rebuild, and useless for a limit: two
 * instances reading "1" and both writing "2" is precisely the case a limit
 * exists to catch. Postgres adds and returns in one statement, so it does.
 */

const TABLE_RPC = "trickshot_bump";

function supabase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

/**
 * Per-process counting, for when there is no shared store.
 *
 * Correct for `next dev` and for one long-lived server, which is the whole of
 * the file backend's world. On serverless it is per-instance and therefore
 * lenient by however many instances are warm — which is why it is the fallback
 * and not the design.
 */
const local = new Map<string, { count: number; expires: number }>();

function bumpLocal(id: string, amount: number, ttlSec: number): number {
  const now = Date.now();
  const held = local.get(id);
  if (held && held.expires > now) {
    held.count += amount;
    return held.count;
  }
  local.set(id, { count: amount, expires: now + ttlSec * 1000 });
  // Cheap sweep: this map only grows with distinct keys inside one window.
  if (local.size > 10_000) {
    for (const [key, value] of local) if (value.expires <= now) local.delete(key);
  }
  return amount;
}

/**
 * Add to a counter and return the running total.
 *
 * Falls back to per-process counting when Supabase is absent, and when the RPC
 * is missing — a deployment that has not run `scripts/migrate.sql` yet should
 * degrade to lenient limiting rather than refusing every request, because the
 * failure mode of the alternative is a site that does nothing at all.
 */
export async function bump(id: string, amount: number, ttlSec: number): Promise<number> {
  const remote = supabase();
  if (!remote) return bumpLocal(id, amount, ttlSec);

  try {
    const res = await fetch(`${remote.url}/rest/v1/rpc/${TABLE_RPC}`, {
      method: "POST",
      headers: {
        apikey: remote.key,
        authorization: `Bearer ${remote.key}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ counter_id: id, amount, ttl_seconds: ttlSec }),
    });
    if (!res.ok) {
      if (res.status === 404) {
        console.error(
          "[budget] trickshot_bump is missing — run scripts/migrate.sql. Counting per-process until then.",
        );
      }
      return bumpLocal(id, amount, ttlSec);
    }
    return Number(await res.json());
  } catch {
    return bumpLocal(id, amount, ttlSec);
  }
}

/** Nothing builds while this is set, without a redeploy. */
export function buildsDisabled(): boolean {
  return process.env.TRICKSHOT_DISABLE_BUILDS === "1";
}

const DAILY_CREDITS = Number(process.env.HELIUS_DAILY_CREDITS ?? 0);

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Record what a build cost, and say whether the day still has room.
 *
 * Called per PHASE rather than once at the end. A build killed by the function
 * timeout is exactly the runaway this ceiling exists to catch, and end-of-build
 * accounting records nothing for it — the one request that most needed to be
 * counted would be the one that never was.
 */
export async function recordSpend(credits: number, ip?: string | null): Promise<void> {
  if (credits <= 0) return;
  const n = Math.round(credits);
  if (DAILY_CREDITS > 0) await bump(`spend:${today()}`, n, 36 * 3_600);
  // Attributed as well as totalled, so one visitor cannot quietly account for
  // the whole day inside limits that only ever counted builds.
  if (ip && VISITOR_CREDITS > 0) await bump(`spend:ip:${today()}:${ip}`, n, 24 * 3_600);
}

/**
 * Credits one visitor may spend in a day, across everything.
 *
 * The limit that actually binds, because it does not care what KIND of request
 * spent it: a hundred replays of indexed tokens and one cold build are the
 * same money, and the build counters only ever saw the second.
 */
const VISITOR_CREDITS = Number(process.env.VISITOR_CREDITS_PER_DAY ?? 150_000);

export async function withinVisitorBudget(ip: string): Promise<boolean> {
  if (VISITOR_CREDITS <= 0) return true;
  const spent = await bump(`spend:ip:${today()}:${ip}`, 0, 24 * 3_600);
  return spent < VISITOR_CREDITS;
}

export async function withinDailyBudget(): Promise<boolean> {
  if (DAILY_CREDITS <= 0) return true;
  // Adding zero reads the running total without disturbing it.
  const spent = await bump(`spend:${today()}`, 0, 36 * 3_600);
  return spent < DAILY_CREDITS;
}

/**
 * Whether the SITE is done for the day, regardless of who is asking.
 *
 * Separate from `mayBuild` because it answers a different question at a
 * different moment. `mayBuild` decides whether one caller may have one build
 * and increments counters doing it; this one only looks, so it is safe to call
 * on any request — including the page render that draws the banner.
 *
 * Only the site-wide ceilings count here. A visitor who has used their own
 * three builds has not stopped anybody else, and telling the whole site it is
 * closed because one person is finished would be a lie on every other screen.
 */
export type SiteLimit = "disabled" | "credits" | "builds" | null;

export async function siteLimit(): Promise<SiteLimit> {
  if (buildsDisabled()) return "disabled";
  const day = today();
  if (DAILY_CREDITS > 0) {
    const spent = await bump(`spend:${day}`, 0, 36 * 3_600);
    if (spent >= DAILY_CREDITS) return "credits";
  }
  if (MAX_BUILDS_PER_DAY > 0) {
    const builds = await bump(`build:total:${day}`, 0, 24 * 3_600);
    if (builds >= MAX_BUILDS_PER_DAY) return "builds";
  }
  return null;
}

/**
 * One sentence, written once, shown everywhere.
 *
 * The banner and the refused request must say the same thing — a page that
 * reads "closed for the day" over a replay that says "something went wrong"
 * is the version of this that makes the site look broken rather than full.
 */
export const LIMIT_MESSAGE =
  "trickshot has hit its daily indexing limit — new tokens resume tomorrow. " +
  "Everything already indexed still replays.";

/**
 * Seconds until the counters roll, for `Retry-After`.
 *
 * The counters are keyed by UTC date, so this is the UTC midnight that key
 * changes at — not the caller's midnight, which would be wrong by up to half
 * a day in either direction.
 */
export function secondsUntilReset(): number {
  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(60, Math.round((midnight - now.getTime()) / 1_000));
}

export interface Allowance {
  ok: boolean;
  /** Set when refused, for the caller to turn into a message. */
  reason?: "disabled" | "budget" | "ip" | "wallet" | "total" | "busy";
}

const BUILDS_PER_IP = Number(process.env.VISITOR_BUILDS_PER_IP ?? 3);
const BUILDS_PER_WALLET = Number(process.env.VISITOR_BUILDS_PER_WALLET ?? 20);

/**
 * Builds running AT ONCE, across the whole site.
 *
 * The per-IP and per-wallet counts stop one person being a nuisance; they do
 * nothing about a thousand people arriving at once, each perfectly within
 * their own allowance. This is the bound that actually protects the account,
 * because it is the only one an attacker cannot widen by finding more IPs.
 */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_BUILDS ?? 3);

/**
 * Builds started in a day, across the whole site.
 *
 * A ceiling on volume where `HELIUS_DAILY_CREDITS` is a ceiling on cost. Both
 * are worth having: the credit ceiling can be reached by one runaway build,
 * and this one is reached by a lot of ordinary ones — different failures,
 * different limits.
 */
const MAX_BUILDS_PER_DAY = Number(process.env.MAX_BUILDS_PER_DAY ?? 300);

/**
 * Bucketed by five minutes so a leaked slot cannot wedge the site.
 *
 * A build that dies without releasing — a killed function, a crash between the
 * take and the finally — would otherwise hold its slot for ever, and three of
 * those means nothing ever builds again. Keying the counter to a window means
 * the worst case is a few minutes of reduced capacity rather than permanent.
 */
const SLOT_WINDOW = 300;
const slotKey = () => `slots:${Math.floor(Date.now() / 1000 / SLOT_WINDOW)}`;

/** Take a concurrency slot, or report that the site is at capacity. */
export async function takeBuildSlot(): Promise<boolean> {
  const running = await bump(slotKey(), 1, SLOT_WINDOW * 2);
  if (running > MAX_CONCURRENT) {
    // Give it straight back, so a refusal does not consume capacity.
    await bump(slotKey(), -1, SLOT_WINDOW * 2);
    return false;
  }
  return true;
}

export async function releaseBuildSlot(): Promise<void> {
  await bump(slotKey(), -1, SLOT_WINDOW * 2);
}

/**
 * Whether this request may start a build, counted on the ATTEMPT.
 *
 * Two counters rather than one, because they catch different abuses and
 * neither sees the other's: per-IP stops one visitor grinding through a
 * five-hundred-token wallet, and per-wallet stops the same wallet being farmed
 * from many addresses. Both count builds, never reads — replaying a token that
 * is already indexed costs nothing here.
 */
export async function mayBuild(
  ip: string,
  wallet?: string,
): Promise<Allowance> {
  if (buildsDisabled()) return { ok: false, reason: "disabled" };
  if (!(await withinDailyBudget())) return { ok: false, reason: "budget" };
  if (!(await withinVisitorBudget(ip))) return { ok: false, reason: "ip" };

  const day = today();

  /**
   * Site-wide before per-person.
   *
   * Checked first because it is the one that means "come back later" rather
   * than "you personally have had enough" — and because spending a visitor's
   * own allowance on a request the site was never going to serve is the wrong
   * way round.
   */
  const total = await bump(`build:total:${day}`, 1, 24 * 3_600);
  if (total > MAX_BUILDS_PER_DAY) return { ok: false, reason: "total" };

  const perIp = await bump(`build:ip:${day}:${ip}`, 1, 24 * 3_600);
  if (perIp > BUILDS_PER_IP) return { ok: false, reason: "ip" };

  if (wallet) {
    const perWallet = await bump(`build:wallet:${day}:${wallet}`, 1, 24 * 3_600);
    if (perWallet > BUILDS_PER_WALLET) return { ok: false, reason: "wallet" };
  }

  return { ok: true };
}

/** The caller's address, as far as the platform will say. */
/**
 * What this visitor has left today, for the page to say so plainly.
 *
 * Read with a zero bump, the same counter `mayBuild` increments, so the number
 * on screen cannot drift from the one actually enforced — a limit a visitor
 * discovers only by hitting it reads as the site being broken.
 */
export async function buildsLeft(ip: string): Promise<{ used: number; limit: number }> {
  const used = await bump(`build:ip:${today()}:${ip}`, 0, 24 * 3_600);
  return { used: Math.max(0, used), limit: BUILDS_PER_IP };
}

export function callerIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Where the day stands, without disturbing it.
 *
 * Every figure is read by adding ZERO to the counter it lives in — the same
 * atomic call the limits use to increment, which is why this cannot drift from
 * what they actually enforce. Reporting from a separate tally would be a
 * second source of truth, and the one that is wrong is always the one on the
 * dashboard.
 */
/** Does a counter write actually reach Postgres? */
async function probeShared(): Promise<boolean> {
  const remote = supabase();
  if (!remote) return false;
  try {
    const res = await fetch(`${remote.url}/rest/v1/rpc/${TABLE_RPC}`, {
      method: "POST",
      headers: {
        apikey: remote.key,
        authorization: `Bearer ${remote.key}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ counter_id: "probe:shared", amount: 0, ttl_seconds: 60 }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function usage(): Promise<{
  disabled: boolean;
  shared: boolean;
  credits: { spent: number; limit: number; pct: number | null };
  builds: { today: number; limit: number };
  concurrent: { running: number; limit: number };
  perVisitor: { perIp: number; perWallet: number; creditsPerDay: number };
}> {
  const day = today();
  const [spent, builds, running] = await Promise.all([
    bump(`spend:${day}`, 0, 36 * 3_600),
    bump(`build:total:${day}`, 0, 24 * 3_600),
    bump(slotKey(), 0, SLOT_WINDOW * 2),
  ]);
  return {
    disabled: buildsDisabled(),
    /**
     * False means these numbers are this INSTANCE's, not the site's.
     *
     * Without Supabase, or before `scripts/migrate.sql` has been applied,
     * counting falls back to per-process — so a serverless deployment reports
     * one lambda's share and the real total is higher by however many are warm.
     * Worth saying plainly on a page whose whole job is to be trusted.
     */
    /**
     * Whether the counter actually round-tripped, not merely whether Supabase
     * is configured. The first version reported the configuration and said
     * "true" while every write was being silently refused, which is precisely
     * the reassurance this field must never give.
     */
    shared: supabase() !== null && (await probeShared()),
    credits: {
      spent,
      limit: DAILY_CREDITS,
      pct: DAILY_CREDITS > 0 ? Math.round((spent / DAILY_CREDITS) * 100) : null,
    },
    builds: { today: builds, limit: MAX_BUILDS_PER_DAY },
    concurrent: { running: Math.max(0, running), limit: MAX_CONCURRENT },
    perVisitor: {
      perIp: BUILDS_PER_IP,
      perWallet: BUILDS_PER_WALLET,
      creditsPerDay: VISITOR_CREDITS,
    },
  };
}
