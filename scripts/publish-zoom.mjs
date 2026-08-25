/**
 * Copy already-built fine series from the file cache into Supabase.
 *
 *   node scripts/publish-zoom.mjs [<mint>…]     (no mints = every one indexed)
 *
 * A COPY, not a build. `zoom-window.mjs` cannot do this itself: with Supabase
 * configured, a cache miss deliberately does not fall back to disk — see
 * `loadBlob` — so running the builder against Supabase would find nothing,
 * rebuild every bar, and spend the money a second time. This moves the bytes
 * that already exist.
 *
 * Writes are VERIFIED by reading back. `saveBlob` reports a rejection and
 * carries on, because a failed cache write is not worth crashing a request
 * over — but a publish that silently wrote nothing would leave the deployment
 * offering a zoom control with no bars behind it.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const name of [".env.local", ".env"]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.error("SUPABASE_URL and a service key are required to publish.");
  process.exit(1);
}

const DIR = process.env.TRICKSHOT_CACHE_DIR ?? path.join(root, ".trickshot-cache");
const fileFor = (key) =>
  path.join(DIR, crypto.createHash("sha256").update(key).digest("hex") + ".json");
const local = (key) => {
  const f = fileFor(key);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};

const jiti = createJiti(import.meta.url);
const store = await jiti.import(path.join(root, "src/server/store.ts"));

const asked = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mints =
  asked.length > 0
    ? asked
    : fs
        .readdirSync(DIR)
        .map((f) => {
          try {
            const v = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
            return v && v.mint && Array.isArray(v.ranges) ? v.mint : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

if (mints.length === 0) {
  console.error("nothing to publish — no zoom index found in " + DIR);
  process.exit(1);
}

const mb = (v) => (Buffer.byteLength(JSON.stringify(v)) / 1e6).toFixed(2) + " MB";
let failed = 0;

for (const mint of [...new Set(mints)]) {
  const index = local(`zoom:${mint}`);
  if (!index) {
    console.log(`${mint}  no zoom index — skipped`);
    failed += 1;
    continue;
  }
  const key = `series:${mint}:${index.interval}`;
  const series = local(key);
  if (!series) {
    console.log(`${mint}  index names ${key} and it is not on disk — skipped`);
    failed += 1;
    continue;
  }

  process.stdout.write(
    `${mint}  ${series.candles.length.toLocaleString()} bars, ${mb(series)} … `,
  );
  await store.saveBlob(key, series);
  await store.saveBlob(`zoom:${mint}`, index);

  /**
   * Read back through the store, which prefers Supabase — so this asks the
   * deployment's own source, not the disk copy that was just written beside it.
   */
  const back = await store.loadSeries(mint, index.interval);
  const backIndex = await store.loadZoom(mint);
  const ok =
    back?.candles?.length === series.candles.length &&
    backIndex?.ranges?.length === index.ranges.length;
  console.log(ok ? "ok" : "MISMATCH — not published correctly");
  if (!ok) failed += 1;
}

console.log(
  failed === 0
    ? `\nPublished ${new Set(mints).size} token(s). The deployment can see these.`
    : `\n${failed} token(s) did not publish — see above.`,
);
process.exit(failed === 0 ? 0 : 1);
