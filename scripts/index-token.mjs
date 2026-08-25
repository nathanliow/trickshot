/**
 * Index a token into the shared cache, from your own machine.
 *
 * Everything the hosted site serves is built here: the chart, the trader
 * board, and — for whichever wallets you name — their linked wallets. The
 * deployment reads and never builds, so a token that has not been through this
 * script is not on the site.
 *
 * Writes wherever the store is configured. With SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY set, that is the shared cache the deployment
 * reads; without them it is .trickshot-cache/ next to the project, which is
 * only useful locally.
 *
 *   npm run index -- <mint> [<mint>…] [--wallets a,b,c] [--top N] [--update]
 *
 *   --wallets   work out linked wallets for these addresses
 *   --top N     …and for the top N and bottom N of the board
 *   --include   pin these wallets onto the board, whatever nomination thinks
 *   --update    re-read the board even if one is already cached
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The app reads its configuration from the environment; load .env.local the
// way `next dev` would, so the script needs no separate setup.
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
const mints = argv.filter((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--"));
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? "") : null;
};
const wantsUpdate = argv.includes("--update");
const named = (flag("wallets") ?? "").split(",").map((w) => w.trim()).filter(Boolean);
const pinned = (flag("include") ?? "").split(",").map((w) => w.trim()).filter(Boolean);
const topN = Number(flag("top") ?? 0);

if (mints.length === 0) {
  console.error(
    "usage: npm run index -- <mint> [--wallets a,b] [--include a,b] [--top N] [--update]",
  );
  process.exit(1);
}
if (!process.env.HELIUS_API_KEY) {
  console.error("HELIUS_API_KEY is not set. Put it in .env.local.");
  process.exit(1);
}

const jiti = createJiti(import.meta.url);
const engine = await jiti.import(path.join(root, "src/server/history.ts"));

const shared = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log(
  shared
    ? "Writing to Supabase — the deployment will see this."
    : "Writing to .trickshot-cache/ — local only. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to publish.",
);

const started = Date.now();
for (const mint of mints) {
  console.log(`\n${mint}`);

  const chart = await step("chart", () => engine.reconstruct(mint));
  if (!chart) {
    console.log("  no pool found — nothing to index");
    continue;
  }
  console.log(
    `        ${chart.name ?? "?"} ${chart.symbol ?? ""} · ${chart.candles.length} bars · ${Math.round(chart.swaps ?? 0).toLocaleString()} swaps`,
  );

  const board = await step("board", () =>
    engine.traderBoard(mint, wantsUpdate, pinned),
  );
  if (board) console.log(`        ${board.wallets} wallets ranked`);

  // Anything pinned is worth a graph too — you named it for a reason.
  const wallets = new Set([...named, ...pinned]);
  if (topN > 0 && board) {
    for (const row of board.top.slice(0, topN)) wallets.add(row.wallet);
    for (const row of board.bottom.slice(0, topN)) wallets.add(row.wallet);
  }
  for (const wallet of wallets) {
    const report = await step(`links ${wallet.slice(0, 8)}`, () =>
      engine.relatedWallets(mint, wallet),
    );
    const linked = report && report !== "not computed" ? report.linked.length : 0;
    console.log(`        ${linked} linked`);
  }
}

console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s.`);

async function step(label, run) {
  const at = Date.now();
  process.stdout.write(`  ${label.padEnd(20)}`);
  try {
    const result = await run();
    process.stdout.write(`${String(Date.now() - at).padStart(6)}ms\n`);
    return result;
  } catch (error) {
    process.stdout.write(`  failed: ${error.message}\n`);
    return null;
  }
}
