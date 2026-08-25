/**
 * Build one token's chart at a bar width the ladder would never pick.
 *
 * What this builds is what the zoom-section control under the replay can then
 * offer: the server only splices a stretch it already holds at the fine width,
 * so the slider is bounded by whatever range has been through here.
 *
 *   node scripts/zoom-window.mjs <mint> --from 2026-08-19 [--to …]
 *
 * Two things it does that `npm run index` deliberately does not:
 *
 * LOCAL, ALWAYS. Supabase is unset for this process, so a run writes files and
 * the deployment sees nothing. That is not only caution: with Supabase
 * configured a cache miss does not fall back to disk — see `loadBlob` — so a
 * build pointed at it would ignore every bar already on disk and pay for all
 * of them again. `scripts/publish-zoom.mjs` copies a finished series up.
 *
 * CHUNKED. `buildCandles` holds every response of a sweep in memory at once,
 * which is fine for the few hundred bars a replay normally needs and is several
 * gigabytes at seven thousand. Each chunk is a separate build that saves as it
 * lands, so the run is bounded in memory and resumes where it stopped.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const name of [".env.local", ".env"]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const mint = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--"));

/** A unix second, from one or an ISO date. */
const when = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value.includes("T") ? value : `${value}T00:00:00Z`);
  if (Number.isNaN(at)) {
    console.error(`not a date: ${value}`);
    process.exit(1);
  }
  return Math.floor(at / 1000);
};

const interval = Number(flag("interval", 60));
const from = when(flag("from"), null);
const to = when(flag("to"), Math.floor(Date.now() / 1000));
/**
 * Bars per build. Sixty one-minute bars is about 120MB of transactions held at
 * once, which is the figure that actually bounds this — not the credits.
 */
const chunkBars = Number(flag("bars", 60));
const cacheDir = path.resolve(root, flag("cache", ".trickshot-cache"));

if (!mint || !from || !(interval > 0)) {
  console.error(
    "usage: node scripts/zoom-window.mjs <mint> --from <YYYY-MM-DD|unix> [--interval 60] [--to …] [--bars 60] [--cache dir]",
  );
  process.exit(1);
}
if (!process.env.HELIUS_API_KEY) {
  console.error("HELIUS_API_KEY is not set. Put it in .env.local.");
  process.exit(1);
}

/**
 * Unset rather than ignored, because `store.ts` chooses its backend from these
 * two variables being present — leaving them set would publish every bar of an
 * experiment into the shared cache the site serves from.
 */
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.TRICKSHOT_CACHE_DIR = cacheDir;
/**
 * A bar read WHOLE up to ninety-nine swaps rather than forty.
 *
 * One archive call bills ten credits for anything under a hundred returned, so
 * a bar of ninety swaps costs the same read as a bar of five — and sampling
 * that bar instead costs seventeen of them. MEASURED across this window:
 * 253,200 credits at 99 against 550,800 at the default, with 84% of bars
 * getting a true high, low and volume instead of an estimated one. What it
 * spends instead is bandwidth, which is why the chunk is small.
 */
process.env.HISTORY_EXACT_BUCKET ??= "99";

fs.mkdirSync(cacheDir, { recursive: true });
console.log(
  `Writing to ${path.basename(cacheDir)}/ only. Supabase is unset for this process.`,
);

const jiti = createJiti(import.meta.url);
const engine = await jiti.import(path.join(root, "src/server/history.ts"));

const chunk = chunkBars * interval;
const start = Math.floor(from / interval) * interval;
const end = Math.ceil(Math.min(to, Math.floor(Date.now() / 1000)) / interval) * interval;
const chunks = Math.ceil((end - start) / chunk);
console.log(
  `${mint} @${interval}s · ${new Date(start * 1000).toISOString()} → ${new Date(end * 1000).toISOString()}`,
);
console.log(`${Math.round((end - start) / interval).toLocaleString()} bars in ${chunks} builds\n`);

const began = Date.now();
let built = 0;
for (let i = 0; i < chunks; i += 1) {
  const at = start + i * chunk;
  const until = Math.min(at + chunk, end);
  const t0 = Date.now();
  let bars = 0;
  try {
    bars = await engine.buildWindow(mint, interval, at, until);
  } catch (error) {
    // A chunk that fails is a chunk to run again, not a run to abandon: the
    // ones already saved stay saved and the next attempt skips them.
    console.log(`  ${new Date(at * 1000).toISOString()}  failed: ${error.message}`);
    continue;
  }
  built += bars;
  const elapsed = (Date.now() - began) / 1000;
  const left = Math.round((elapsed / (i + 1)) * (chunks - i - 1));
  console.log(
    `  ${new Date(at * 1000).toISOString()}  ${String(bars).padStart(4)} bars  ${String(Date.now() - t0).padStart(6)}ms  ` +
      `[${i + 1}/${chunks}] ~${Math.floor(left / 60)}m${String(left % 60).padStart(2, "0")}s left`,
  );
}

/**
 * The index is what makes the token zoomable, and it is written LAST.
 *
 * A run that dies partway leaves bars behind and no index, so the replay goes
 * on serving its ordinary chart rather than offering a section that is full of
 * holes. Its span is read back off the series actually stored, not from the
 * arguments, so a partial rebuild cannot claim more than it has.
 */
const store = await jiti.import(path.join(root, "src/server/store.ts"));
const stored = await store.loadSeries(mint, interval);
const bars = stored?.candles ?? [];

/**
 * The unbroken runs in what is stored, which is what may be offered.
 *
 * Read back off the series rather than taken from this run's arguments: the
 * blob accumulates across runs, so a second window on the same token leaves
 * two runs with a hole between them, and the hole must not be advertised.
 */
const ranges = [];
for (const bar of bars) {
  const open = ranges[ranges.length - 1];
  if (open && bar.t === open.to) open.to = bar.t + interval;
  else ranges.push({ from: bar.t, to: bar.t + interval });
}
if (ranges.length > 0) await store.saveZoom({ mint, interval, ranges });

const day = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
console.log(
  `\n${built.toLocaleString()} bars in ${Math.round((Date.now() - began) / 1000)}s.`,
);
for (const r of ranges) {
  console.log(`  zoomable  ${day(r.from)} → ${day(r.to)}  ${Math.round((r.to - r.from) / interval).toLocaleString()} bars`);
}
