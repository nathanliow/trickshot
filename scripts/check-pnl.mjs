/**
 * The PnL accounting, checked against cases with a known answer.
 *
 * No framework and no network: `PositionBook` is pure arithmetic over fills,
 * so the only thing worth asserting is that the arithmetic is right. Run it
 * after touching `positions.ts`.
 *
 *   node scripts/check-pnl.mjs
 *
 * Every case asserts the TOTAL and the DRIFT. Drift is the point: the book
 * keeps two accountings side by side — cash-flow and average-cost — and they
 * must agree. A change that fixes the headline number while pushing drift up
 * has not fixed anything, it has moved the error somewhere less visible.
 *
 * The gift cases exist because they are what went wrong in the wild. A wallet
 * that is HANDED tokens and sells them has proceeds and no basis, and booking
 * those proceeds as profit put a wallet that bought nothing on the MELANIA
 * board at +$45,232,141.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jiti = createJiti(import.meta.url);
const { PositionBook } = await jiti.import(
  path.join(root, "src/server/positions.ts"),
);

const MINT = "m";
let failures = 0;

function check(name, fills, price, expected) {
  const book = new PositionBook(Number.POSITIVE_INFINITY);
  for (const fill of fills) book.apply(MINT, "w", fill);
  const row = book.leaderboard(MINT, price, 5, true).top.find((r) => r.wallet === "w");
  const total = Math.round(row?.total ?? NaN);
  const drift = Math.round(row?.basisDrift ?? NaN);
  // A dollar of slack: these are floating-point sums, not exact arithmetic.
  const ok = Math.abs(total - expected) <= 1 && drift <= 1;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(48)}` +
      `total $${total.toLocaleString().padStart(12)}` +
      `  expected $${expected.toLocaleString().padStart(12)}  drift $${drift}`,
  );
}

const swap = (ts, isBuy, base, usd) => ({ ts, isBuy, base, usd, kind: "swap" });
const gift = (ts, base) => ({ ts, isBuy: true, base, usd: 0, kind: "transfer" });

// An ordinary winner and an ordinary loser: the cases that must NOT change.
check("bought 100 @ $1, sold 100 @ $3", [swap(1, true, 100, 100), swap(2, false, 100, 300)], 3, 200);
check("bought $1,000, sold $200", [swap(1, true, 100, 1_000), swap(2, false, 100, 200)], 2, -800);

// Still open, marked at the current price.
check("bought 100 @ $1, holding at $5", [swap(1, true, 100, 100)], 5, 400);

// Gifted tokens carry no basis, so realising them is not profit.
check("gifted 100, sold all for $45m", [gift(1, 100), swap(2, false, 100, 45_000_000)], 1, 0);
check("gifted 100, still holding at $50", [gift(1, 100)], 50, 0);
check("gifted 100, sent 100 away", [gift(1, 100), { ts: 2, isBuy: false, base: 100, usd: 0, kind: "transfer" }], 50, 0);

// A mix: half the position was paid for, so half the proceeds are real.
check(
  "bought 100 @ $1 + gifted 100, sold 200 @ $3",
  [swap(1, true, 100, 100), gift(2, 100), swap(3, false, 200, 600)],
  3,
  200,
);

// Selling more than was ever held — the older, cruder unmatched path.
check("sold 100 having never bought", [swap(1, false, 100, 500)], 1, 0);

/**
 * Tokens LEAVING are booked as an exit at the prevailing price.
 *
 * The transfer fill carries a mark (`base * chart price`), so a wallet that
 * deposits to an exchange is credited with what the tokens were worth at that
 * moment instead of standing as a total loss. Drift must stay at zero: an
 * assumed exit still has to balance both accountings.
 */
const out = (ts, base, usd) => ({ ts, isBuy: false, base, usd, kind: "transfer" });

check(
  "bought $1,000, sent all out when worth $3,000",
  [swap(1, true, 100, 1_000), out(2, 100, 3_000)],
  1,
  2_000,
);
check(
  "bought $1,000, sold half $1,500, sent half out worth $1,500",
  [swap(1, true, 100, 1_000), swap(2, false, 50, 1_500), out(3, 50, 1_500)],
  1,
  2_000,
);
// Gifted in, then straight back out: still nothing earned.
check("gifted 100, sent all out when worth $3,000", [gift(1, 100), out(2, 100, 3_000)], 1, 0);
// Half bought, half gifted, everything sent out at $30/token.
//   paid $1,000 for 100; 100 more were free; 200 leave worth $6,000.
//   half those proceeds belong to the gift -> $3,000 real, less $1,000 cost.
check(
  "bought 100 @ $1 + gifted 100, sent all 200 out worth $6,000",
  [swap(1, true, 100, 1_000), gift(2, 100), out(3, 200, 6_000)],
  1,
  2_000,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
