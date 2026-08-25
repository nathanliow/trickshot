/** Formatting helpers. Every figure they return is meant to be set in mono. */

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

/** $412K, $1.2M, $61.4K — the market-cap / volume convention. */
export function usdCompact(value: number): string {
  if (value >= 1_000_000_000) return `$${trim(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `$${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `$${trim(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

/**
 * $1.24M, $61.4K — a market cap or a price, at a glance.
 *
 * Two decimals above a thousand where `usdCompact` gives one, because a cap is
 * usually being compared with another cap rather than read on its own.
 */
export function capLabel(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
