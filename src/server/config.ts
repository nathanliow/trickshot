import { visitorKey } from "./key";

/**
 * Everything this app needs from the environment, which is one key.
 *
 * The replay reads the chain and nothing else — no stream, no database, no
 * notifications — so the whole configuration is the Helius endpoint it reads
 * from. The key is read lazily rather than at module load so that importing
 * this from a route that never calls it cannot break the build.
 */
/**
 * Thrown when there is no key to spend at all.
 *
 * Its own type so the routes can answer "add your key" rather than
 * "something went wrong".
 */
export class NoKey extends Error {
  constructor() {
    super("this request needs a Helius key");
    this.name = "NoKey";
  }
}

/**
 * The visitor's key if they brought one, otherwise the server's own.
 *
 * Theirs takes precedence: they entered it to escape the visitor limits, and
 * preferring the server's would ignore it wherever one is configured.
 */
function heliusKey(): string {
  const mine = visitorKey();
  if (mine) return mine;
  const server = process.env.HELIUS_API_KEY;
  if (!server) throw new NoKey();
  return server;
}

/** Whether anything at all can be spent — a server key, or a visitor's. */
export function hasKey(): boolean {
  return visitorKey() !== null || Boolean(process.env.HELIUS_API_KEY);
}

/** Whether this install has a key of its own, i.e. can serve without BYOK. */
export function hasServerKey(): boolean {
  return Boolean(process.env.HELIUS_API_KEY);
}

/**
 * Whether this instance refuses to build anything it has not already got.
 *
 * A hosted copy serves a curated set: the owner indexes from their own machine
 * and the site reads the result. There is no administrator login to go with
 * this, and deliberately so — the hosted copy is handed a Supabase key that
 * cannot write, so it could not persist a build even if it made one. A login
 * would be a second lock on a door that does not open.
 */
export function readOnly(): boolean {
  return process.env.TRICKSHOT_READONLY === "1";
}

/**
 * Whether a visitor may spend their own key on this deployment.
 *
 * On by default. Worth turning off on a read-only install, where the build
 * cannot be persisted and is rebuilt for every visitor who asks.
 */
export function byokAllowed(): boolean {
  return process.env.TRICKSHOT_DISABLE_BYOK !== "1";
}

export const config = {
  /** The raw key, for the REST endpoints that are not JSON-RPC. */
  get apiKey(): string {
    return heliusKey();
  },
  /**
   * Read as a GETTER on every call, which is what makes BYOK work at all.
   *
   * Ten fetch sites across seven modules build their URL from this, and none of
   * them knows whose key it is — so a per-request key needs nothing more than
   * this property consulting the active scope. Hoisting it to a module constant
   * would bind the server's key at import time and silently ignore every
   * visitor's.
   */
  get rpcUrl(): string {
    const base = process.env.HELIUS_RPC_URL ?? "https://mainnet.helius-rpc.com";
    return `${base}/?api-key=${heliusKey()}`;
  },
  commitment: (process.env.COMMITMENT ?? "confirmed") as
    | "processed"
    | "confirmed"
    | "finalized",
};

/**
 * Whether this request carries the owner's token.
 *
 * Every guard in this app used to be spelled `!readOnly()`, which works only
 * while the flag is on. The destination is a deployment that BUILDS — flag
 * off, writable key — and at that moment each of those guards silently flips
 * from denying to allowing: `?update=1` would re-read every ranked wallet for
 * anyone who typed it, and `/api/related` would compute a graph on request.
 *
 * Permission therefore comes from something being present, not from a flag
 * being absent. Absent or empty `TRICKSHOT_OWNER_TOKEN` means NOBODY is the
 * owner over HTTP — which is the state of every current deployment and every
 * checkout, so the safe answer is also the default. The indexer passes its
 * capabilities in-process and never calls this, so it keeps working with no
 * token configured at all.
 */
export function owner(request: Request): boolean {
  const expected = process.env.TRICKSHOT_OWNER_TOKEN;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (offered.length !== expected.length) return false;

  // Constant time over equal-length strings, so a wrong token cannot be
  // narrowed down by how long the comparison took.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ offered.charCodeAt(i);
  }
  return diff === 0;
}
