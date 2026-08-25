/**
 * Does a bar still draw a market cap the token never had?
 *
 * Runs the real `buildCandles` over four bars that MEASURABLY drew billions
 * before the dust and non-trade guards existed, and checks each against the
 * only thing that can contradict it: the trades in the bar itself. A bar whose
 * high is many times its own median price is not a bar the market made.
 *
 * Reads the chain, so it needs HELIUS_API_KEY.
 *
 *   node scripts/check-candle-outliers.mjs
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
if (!process.env.HELIUS_API_KEY) {
  console.error("HELIUS_API_KEY is not set. Put it in .env.local.");
  process.exit(1);
}
// Read each window whole rather than sampled, so the bar sees every trade.
process.env.HISTORY_EXACT_MAX = "4000";

const jiti = createJiti(import.meta.url);
const { buildCandles } = await jiti.import(path.join(root, "src/server/candles.ts"));
const { SolPriceHistory } = await jiti.import(path.join(root, "src/server/solPrice.ts"));

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const SUPPLY = 997_378_987.913924;
const VENUE = {
  pool: "6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN",
  baseVault: "GnyzhweyVAeGhdD9nLrzCUr6T4ZBvnbJoyBEBgN6i5da",
  quoteVault: "BprsHVMgdCPP1s8KkwUCx9tkszrHmAEMdJFkynP3NW7N",
  quoteMint: "So11111111111111111111111111111111111111112",
};
const INTERVAL = 3600;
/**
 * The six worst bars in the cached hourly series, with the market cap each
 * one's high drew. Taken from the cache rather than invented, so a rebuild
 * that quietly stopped removing outliers would show up here as a number.
 */
const BROKEN = [
  { t: 1785024000, wasM: 23_008 },
  { t: 1784534400, wasM: 14_371 },
  { t: 1784538000, wasM: 14_371 },
  { t: 1783252800, wasM: 12_233 },
  { t: 1783134000, wasM: 7_709 },
  { t: 1784548800, wasM: 2_529 },
];
/**
 * The bar's own trades are the reference, not a fixed market-cap ceiling: a
 * token that really runs should still draw the bar it earned. This is the same
 * factor the builder uses, so a bar cannot exceed it while holding a trade the
 * rest of the bar contradicts.
 */
const LIMIT = 3;

const sol = new SolPriceHistory();
for (const b of BROKEN) await sol.load(b.t - 3600, b.t + 2 * INTERVAL);

const cap = (p) => (p * SUPPLY) / 1e6;
let failed = 0;

for (const { t, wasM } of BROKEN) {
  // A density of zero keeps the whole window on the exact path.
  const density = { points: [{ t: 0, rate: 0 }], total: 0 };
  const out = await buildCandles(VENUE, MINT, t, t + INTERVAL, INTERVAL, sol, density);
  const bar = out.candles.find((c) => c.t === t);
  if (!bar || bar.n === 0) {
    console.log(`FAIL ${new Date(t * 1000).toISOString()}  no bar built`);
    failed += 1;
    continue;
  }
  const prices = out.swaps
    .filter((s) => s.ts >= t && s.ts < t + INTERVAL)
    .map((s) => s.priceUsd)
    .sort((a, b) => a - b);
  const mid = prices[prices.length >> 1];
  const high = bar.h / mid;
  const low = mid / bar.l;
  const ok = high <= LIMIT && low <= LIMIT;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${new Date(t * 1000).toISOString()}  ` +
      `was $${wasM}M high -> now $${cap(bar.h).toFixed(0)}M high / $${cap(bar.l).toFixed(0)}M low ` +
      `(median $${cap(mid).toFixed(0)}M, x${high.toFixed(2)} up, x${low.toFixed(2)} down, n=${bar.n})`,
  );
}

console.log(failed === 0 ? "\nAll bars sane." : `\n${failed} bar(s) still broken.`);
process.exit(failed === 0 ? 0 : 1);
