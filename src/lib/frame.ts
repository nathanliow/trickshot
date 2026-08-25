/**
 * One frame of an exported clip, painted.
 *
 * The screen shows the chart with a header above it and figures below, all of
 * it HTML; the chart library knows nothing about any of that, so a recording
 * made by screenshotting the chart carried the chart alone. This draws the rest
 * back on at full resolution, laid out for whichever shape is being exported.
 *
 * Everything here is authored against the 1920-wide frame and multiplied by
 * `layout.type`, so one set of numbers describes all three formats.
 */

import { capLabel, usdCompact } from "@/lib/format";
import { DESIGN_W, type Layout } from "@/lib/clip";
import type { ReplayPoint } from "@/lib/replay";

const MONO = 'ui-monospace, "JetBrains Mono", "SF Mono", monospace';

/** The replay's palette, from the `@theme` block in globals.css. */
const GROUND = "#0a0b0d";
const TX = "#e8ecf2";
const TX2 = "#98a2b0";
const TX3 = "#7a8494";
const MINT = "#35d399";
const SIGNAL = "#ff5a5a";
const AMBER = "#ffb224";
const LINE = "#242a33";

/**
 * A floating fill label, with its envelopes already resolved.
 *
 * The exporter works these out because it is the thing that knows what time it
 * is in the clip; the painter only draws what it is handed.
 */
export interface PaintFlash {
  isBuy: boolean;
  usd: number;
  cap: number;
  slot: number;
  who?: string;
  /** Label opacity, 0..1. */
  alpha: number;
  /**
   * Wash opacity, 0..1, on its own 900ms curve — and zero the moment the label
   * starts leaving, because the DOM only renders a wash for flashes that are
   * not on their way out.
   */
  wash: number;
  /** Leaving, which reverses the drift. */
  out: boolean;
}

export interface Totals {
  bought: number;
  sold: number;
  total: number;
  /** Null when nothing was ever spent, which no percentage can describe. */
  pct: number | null;
}

export interface FrameState {
  layout: Layout;
  /** The chart exactly as drawn, at export resolution. */
  shot: HTMLCanvasElement | null;
  /** The token's symbol. Empty when the chain never gave one. */
  ticker?: string;
  label?: string;
  wallet: string;
  /** Whether the figures are market caps, which changes the flash suffix. */
  asCap: boolean;
  point: ReplayPoint | null;
  trades: number;
  flashes: PaintFlash[];
  /** 0 while the replay runs; 0..1 across the end card. */
  outro: number;
  totals: Totals | null;
}

interface TextOptions {
  size: number;
  weight?: number;
  color?: string;
  align?: CanvasTextAlign;
  tracking?: number;
  alpha?: number;
}

function draw(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  o: TextOptions,
): number {
  ctx.save();
  ctx.font = `${o.weight ?? 400} ${o.size}px ${MONO}`;
  ctx.fillStyle = o.color ?? TX;
  ctx.textAlign = o.align ?? "left";
  ctx.textBaseline = "alphabetic";
  if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
  // Not every engine supports letter spacing on a canvas; where it is missing
  // the assignment is simply ignored and the text is a touch tighter.
  (ctx as unknown as { letterSpacing: string }).letterSpacing =
    `${o.tracking ?? 0}px`;
  ctx.fillText(s, x, y);
  const width = ctx.measureText(s).width;
  ctx.restore();
  return width;
}

/** Middle-truncated, so both ends of an address stay readable. */
function shortAddress(v: string, keep = 6): string {
  return v.length <= keep * 2 + 1 ? v : `${v.slice(0, keep)}…${v.slice(-keep)}`;
}

function signed(v: number): string {
  return `${v >= 0 ? "+" : "−"}${usdCompact(Math.abs(v))}`;
}

function toneOf(v: number): string {
  return v >= 0 ? MINT : SIGNAL;
}

/** The same smoothstep the replay eases its bars with. */
function ease(p: number): number {
  const c = Math.min(Math.max(p, 0), 1);
  return c * c * (3 - 2 * c);
}

export function paint(ctx: CanvasRenderingContext2D, s: FrameState): void {
  const { layout: L } = s;

  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, L.w, L.h);

  paintHeader(ctx, s);

  if (s.shot) {
    /**
     * Explicit source and destination boxes rather than a bare `drawImage`.
     * At a fractional device pixel ratio the chart's CSS size rounds to the
     * device grid, so its bitmap can come back a pixel off the rect it was
     * sized for; stretching it into the rect hides that, where a 1:1 blit
     * would leave a seam of bare ground along an edge.
     */
    ctx.drawImage(
      s.shot,
      0, 0, s.shot.width, s.shot.height,
      L.chart.x, L.chart.y, L.chart.w, L.chart.h,
    );
  }

  paintStats(ctx, s);

  // Wash last but one: it has to cross the chart's edge and the figures below
  // it, with only the labels sitting on top.
  const placed = placeFlashes(ctx, s);
  paintWash(ctx, s, placed);
  paintLabels(ctx, placed);

  if (s.outro > 0) paintOutro(ctx, s);
}

function paintHeader(ctx: CanvasRenderingContext2D, s: FrameState): void {
  const { layout: L } = s;
  const t = L.type;
  const r = L.header;
  const pnl = s.point?.total ?? 0;

  /**
   * Both columns share a baseline just above the chart, and everything is laid
   * out UPWARD from it — so the empty space lands at the top of the frame as
   * padding rather than between the wallet and the number it belongs to.
   */
  const wide = L.shape === "landscape";
  const address = wide ? s.wallet : shortAddress(s.wallet, 10);

  /**
   * The two columns are centred on one axis rather than sharing a baseline.
   *
   * A baseline is the wrong thing to share here: the left column is two small
   * lines and the right is one large one over a caption, so aligning their
   * feet left the wallet sitting visibly low against the number. These are
   * cap-height approximations for the mono stack, which is enough — the eye is
   * judging two blocks of text, not measuring them.
   */
  const cap = (size: number) => size * 0.72;
  const drop = (size: number) => size * 0.22;

  /**
   * The left column, top to bottom: which token, then which wallet.
   *
   * Built as a list because the ticker is optional — a mint the chain never
   * named has no symbol to show, and the column has to close up rather than
   * leave a gap where one would have been.
   */
  const addrSize = s.label ? 30 * t : 40 * t;
  const lines: { text: string; size: number; weight: number; color: string }[] =
    [];
  if (s.ticker) {
    lines.push({ text: s.ticker, size: 30 * t, weight: 800, color: AMBER });
  }
  if (s.label) {
    lines.push({ text: s.label, size: 42 * t, weight: 800, color: TX });
  }
  lines.push({
    text: address,
    size: addrSize,
    weight: s.label ? 500 : 800,
    color: s.label ? TX2 : TX,
  });

  /** Baseline-to-baseline, indexed by the line the gap sits above. */
  const leads = lines.map((l) => (l.size > 36 * t ? 46 * t : 40 * t));
  const leftH =
    cap(lines[0].size) +
    leads.slice(1).reduce((a, b) => a + b, 0) +
    drop(lines[lines.length - 1].size);

  const pnlSize = 92 * t;
  const capSize = 19 * t;
  const rightH = cap(pnlSize) + 24 * t + drop(capSize);

  // The taller column's foot lands just above the chart; the shorter one
  // centres against it, and the slack collects at the top of the frame.
  const foot = r.y + r.h - 30 * t;
  const mid = foot - Math.max(leftH, rightH) / 2;

  let y = mid - leftH / 2 + cap(lines[0].size);
  lines.forEach((line, i) => {
    if (i > 0) y += leads[i];
    draw(ctx, line.text, L.pad, y, {
      size: line.size,
      weight: line.weight,
      color: line.color,
      tracking: line.color === AMBER ? 2 * t : 0,
    });
  });

  const rightTop = mid - rightH / 2;
  draw(ctx, signed(pnl), L.w - L.pad, rightTop + cap(pnlSize), {
    size: pnlSize, weight: 800, color: toneOf(pnl), align: "right",
  });
  draw(ctx, "TOTAL PNL", L.w - L.pad, rightTop + cap(pnlSize) + 24 * t, {
    size: capSize, weight: 700, color: TX3, tracking: 2.4 * t, align: "right",
  });
}

/**
 * Where each label sits, and how wide its text run is.
 *
 * Measured once so the wash can be centred on the label rather than on the
 * frame — the glow is meant to read as coming off the number, and a gradient
 * pinned to the middle of the chart does not.
 */
interface Placed {
  f: PaintFlash;
  /** Left edge of the run, and the baseline. */
  x: number;
  y: number;
  width: number;
  k: number;
  head: string;
  tail: string;
  who: string;
}

function placeFlashes(ctx: CanvasRenderingContext2D, s: FrameState): Placed[] {
  const r = s.layout.chart;
  /** Chart space: what the axis and its clearances are measured in. */
  const k = r.w / DESIGN_W;
  /** Label space: the same, scaled up where the format wants louder labels. */
  const fk = k * s.layout.flashType;
  const mid = r.x + r.w / 2;
  const out: Placed[] = [];

  for (const f of s.flashes) {
    if (f.alpha <= 0 && f.wash <= 0) continue;
    const head = `${usdCompact(f.usd)} ${f.isBuy ? "BUY" : "SELL"}`;
    const tail = ` (${capLabel(f.cap)}${s.asCap ? " MC" : ""})`;
    const who = f.who ? `  ${shortAddress(f.who, 4)}` : "";

    ctx.save();
    ctx.font = `800 ${26 * fk}px ${MONO}`;
    const headWidth = ctx.measureText(head).width;
    ctx.font = `700 ${17 * fk}px ${MONO}`;
    const tailWidth = ctx.measureText(tail).width;
    ctx.font = `700 ${15 * fk}px ${MONO}`;
    const whoWidth = who ? ctx.measureText(who).width : 0;
    ctx.restore();

    /**
     * Shrink to fit rather than run off the edge.
     *
     * A label is one line that cannot wrap, and the widest case — a six-figure
     * fill, a billion-dollar cap and a cluster wallet's address — is a good
     * deal longer than the common one. In a 1080-wide frame at the enlarged
     * size that reaches the margins, so the rare long label gives up some size
     * and everything else is unaffected.
     */
    const room = s.layout.w - s.layout.pad * 2;
    const raw = headWidth + tailWidth + whoWidth;
    const fit = raw > room ? room / raw : 1;
    const scale = fk * fit;
    const width = raw * fit;
    // The drift the CSS applies — upward either way, so it reads the same
    // against the bottom edge as against the top.
    const rise = (f.out ? (1 - f.alpha) * 30 : (1 - f.alpha) * -14) * fk;
    /**
     * The edge clearance is in chart space and the stacking is in label space:
     * the gap at the foot exists to clear lightweight-charts' timestamps, which
     * scale with the chart, while the space between two labels has to grow with
     * the labels or a bigger second line would sit on the first.
     */
    const y =
      s.layout.flashAt === "bottom"
        ? r.y + r.h - 76 * k - f.slot * 42 * fk - rise
        : r.y + 60 * k + f.slot * 42 * fk - rise;

    out.push({ f, x: mid - width / 2, y, width, k: scale, head, tail, who });
  }
  return out;
}

/**
 * The colour a fill throws off as it lands.
 *
 * Centred on the label and painted across the WHOLE frame rather than clipped
 * to the chart. It used to be a gradient in the middle of the chart rect,
 * which put the brightest part of it nowhere near the thing it was reacting to
 * and cut a visible edge where the chart ended.
 *
 * Drawn after the chart and the figures but before the labels, so it washes
 * over every boundary in the frame while the number still reads on top of it.
 */
function paintWash(
  ctx: CanvasRenderingContext2D,
  s: FrameState,
  placed: Placed[],
): void {
  /**
   * Whether this frame carries both signs at once.
   *
   * Two washes of opposite sign centred on their own labels still met in the
   * middle and cancelled to a neutral grey — the same defect the screen had,
   * and it has to be fixed identically here or an export stops matching the
   * replay it is of. See `WASH` in WalletReplay for the measured colours.
   */
  const split =
    placed.some((p) => p.f.wash > 0 && p.f.isBuy) &&
    placed.some((p) => p.f.wash > 0 && !p.f.isBuy);

  for (const p of placed) {
    if (p.f.wash <= 0) continue;
    const tint = p.f.isBuy ? "53, 211, 153" : "255, 90, 90";
    // Wide enough to surround the text rather than halo it. Split washes are
    // anchored off-frame instead, so they need to reach across it.
    const radius = split
      ? s.layout.w * 0.7
      : Math.max(p.width * 0.95, 320 * p.k);
    // Sell from the left edge, buy from the right, matching the screen.
    const cx = split ? (p.f.isBuy ? s.layout.w : 0) : p.x + p.width / 2;
    const cy = split ? s.layout.h / 2 : p.y - 9 * p.k;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, `rgba(${tint}, ${0.34 * p.f.wash})`);
    glow.addColorStop(0.45, `rgba(${tint}, ${0.13 * p.f.wash})`);
    glow.addColorStop(1, `rgba(${tint}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, s.layout.w, s.layout.h);
  }
}

/**
 * The floating fill labels.
 *
 * They live in HTML above the chart and the chart cannot see them, so they are
 * drawn here from the same fills the page is showing. Positions are authored
 * against the on-screen chart and scale with it, which is what keeps an export
 * looking like the replay rather than like a rearrangement of it.
 */
function paintLabels(ctx: CanvasRenderingContext2D, placed: Placed[]): void {
  for (const p of placed) {
    if (p.f.alpha <= 0) continue;
    let x = p.x;
    x += draw(ctx, p.head, x, p.y, {
      size: 26 * p.k, weight: 800,
      color: p.f.isBuy ? MINT : SIGNAL, alpha: p.f.alpha,
    });
    x += draw(ctx, p.tail, x, p.y, {
      size: 17 * p.k, weight: 700, color: TX2, alpha: p.f.alpha,
    });
    if (p.who) {
      draw(ctx, p.who, x, p.y, {
        size: 15 * p.k, weight: 700, color: TX3, alpha: p.f.alpha,
      });
    }
  }
}

function paintStats(ctx: CanvasRenderingContext2D, s: FrameState): void {
  const p = s.point;
  if (!p) return;
  const { layout: L } = s;
  const t = L.statType;
  const r = L.stats;

  const figures: { label: string; value: string; color: string }[] = [
    { label: "BOUGHT", value: usdCompact(p.boughtUsd), color: MINT },
    { label: "SOLD", value: usdCompact(p.soldUsd), color: SIGNAL },
    { label: "REALIZED", value: signed(p.realized), color: toneOf(p.realized) },
    { label: "UNREALIZED", value: signed(p.unrealized), color: toneOf(p.unrealized) },
    { label: "HOLDING", value: usdCompact(p.qty * p.price), color: TX },
    { label: "TRADES", value: String(s.trades), color: TX },
  ];

  ctx.fillStyle = LINE;
  ctx.fillRect(L.pad, r.y, L.w - L.pad * 2, Math.max(1, Math.round(L.type)));

  const cols = L.cols;
  const rows = Math.ceil(figures.length / cols);
  const cellW = (L.w - L.pad * 2) / cols;
  /**
   * Rows are as tall as their contents, and the block is centred in whatever
   * band is left. Dividing the band by the row count instead spread three rows
   * of two figures over 700px in the tall format, which put more empty space
   * between a number and its neighbour than between the groups.
   */
  const rowH = 140 * t;
  const top = r.y + 34 * t + Math.max(0, (r.h - 34 * t - rows * rowH) / 2);

  figures.forEach((f, i) => {
    const x = L.pad + (i % cols) * cellW;
    const y = top + Math.floor(i / cols) * rowH;
    draw(ctx, f.label, x, y + 24 * t, {
      size: 24 * t, weight: 700, color: TX3, tracking: 2.6 * t,
    });
    draw(ctx, f.value, x, y + 82 * t, { size: 52 * t, weight: 800, color: f.color });
  });
}

/**
 * The end card.
 *
 * The chart is not cut away — it is dimmed behind a scrim, so the clip reads as
 * settling on its result rather than jumping to a different picture. The
 * figures count up over the first part of the hold and then sit still, which
 * leaves the last frame clean enough to serve as a thumbnail.
 */
function paintOutro(ctx: CanvasRenderingContext2D, s: FrameState): void {
  const { layout: L } = s;
  const t = L.type;
  const total = s.totals;

  const veil = ease(s.outro / 0.28) * 0.85;
  ctx.fillStyle = `rgba(10, 11, 13, ${veil})`;
  ctx.fillRect(0, 0, L.w, L.h);

  if (!total) return;

  const appear = ease((s.outro - 0.12) / 0.3);
  if (appear <= 0) return;
  const count = ease((s.outro - 0.12) / 0.45);

  const pct =
    total.pct === null ? "—" : `${total.pct >= 0 ? "+" : "−"}${Math.abs(total.pct * count).toFixed(1)}%`;

  const figures: { label: string; value: string; color: string }[] = [
    { label: "TOTAL BOUGHT", value: usdCompact(total.bought * count), color: MINT },
    { label: "TOTAL SOLD", value: usdCompact(total.sold * count), color: SIGNAL },
    { label: "NET PNL", value: signed(total.total * count), color: toneOf(total.total) },
    { label: "PNL", value: pct, color: toneOf(total.total) },
  ];

  const cols = L.shape === "landscape" ? 4 : 2;
  const rows = Math.ceil(figures.length / cols);
  const cellW = (L.w - L.pad * 2) / cols;
  const rowH = 168 * t;
  const blockH = rows * rowH;
  const top = (L.h - blockH) / 2 + 40 * t;

  // Rises a little as it arrives, the same gesture the fill labels make.
  const lift = (1 - appear) * 26 * t;

  if (s.ticker) {
    draw(ctx, s.ticker, L.w / 2, top - 126 * t - lift, {
      size: 34 * t, weight: 800, color: AMBER, align: "center",
      tracking: 2.4 * t, alpha: appear,
    });
  }
  draw(ctx, s.label ?? shortAddress(s.wallet, 8), L.w / 2, top - 74 * t - lift, {
    size: 34 * t, weight: 800, color: TX2, align: "center", alpha: appear,
  });

  figures.forEach((f, i) => {
    const cx = L.pad + (i % cols) * cellW + cellW / 2;
    const y = top + Math.floor(i / cols) * rowH - lift;
    draw(ctx, f.label, cx, y, {
      size: 21 * t, weight: 700, color: TX3, tracking: 2.6 * t,
      align: "center", alpha: appear,
    });
    draw(ctx, f.value, cx, y + 74 * t, {
      size: 68 * t, weight: 800, color: f.color, align: "center", alpha: appear,
    });
  });
}
