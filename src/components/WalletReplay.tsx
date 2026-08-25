"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  barAt,
  fetchHistory,
  ZOOM_MAX_BARS,
  type RelatedReport,
  type Replay,
  type ReplayCandle,
  type ReplayPoint,
  type TokenHistory,
} from "@/lib/replay";
import { capLabel, usdCompact } from "@/lib/format";
import { save } from "@/lib/record";
import {
  play as playCue,
  prepare as prepareSound,
  renderCues,
  type Cued,
} from "@/lib/sound";
import {
  DESIGN_W,
  encode,
  FORMATS,
  FPS,
  layoutFor,
  MAX_CLIP_SECONDS,
  negotiate,
  OUTRO_SECONDS,
  SHAPES,
  type Encoders,
  type Shape,
} from "@/lib/clip";
import { paint, type PaintFlash, type Totals } from "@/lib/frame";
import {
  Copy,
  cx,
  Label,
  useAutoPlay,
  useEffects,
  useStoredFlag,
  useStoredValue,
} from "./ui";

/**
 * One wallet's trades on one token, played back on the real chart.
 *
 * Built to be screen-recorded, and every choice follows from that: the same
 * lightweight-charts renderer the token page uses, so a capture matches what
 * people already recognise; a bar width chosen from the window the wallet
 * actually traded in, so a launch that runs in ninety seconds is not two
 * frames; the wallet's own buys and sells marked on the bars as they happen;
 * and playback that LOOPS, so a recording can be trimmed anywhere without
 * hunting for the start.
 *
 * The chart is fed a growing slice of the candles rather than being scrolled,
 * which is what makes the replay read as the token forming rather than as a
 * viewport moving across finished history.
 */
let lwcChunk: Promise<typeof import("lightweight-charts")> | null = null;
function loadLwc() {
  lwcChunk ??= import("lightweight-charts");
  return lwcChunk;
}

const SPEEDS = [1, 2, 4, 8] as const;
/**
 * Bar widths offered, as multiples of the one the replay was built at.
 *
 * Only coarser. Merging bars is arithmetic on data already in the browser and
 * happens between frames; a FINER bar is a different series — they are stored
 * per mint and interval — so it would mean going back to the chain and waiting.
 */
const ZOOMS = [1, 2, 4, 8] as const;

/**
 * Merge every `factor` bars into one.
 *
 * The open comes from the first bar in the group and the close from the last,
 * with the extremes carried across all of them, which is what a wider bar of
 * the same trades is. The PnL curve is sampled rather than combined: each
 * point is already the wallet's running position at that bar, so the right
 * value for a merged bar is simply the last one inside it.
 */
function coarsen(d: Replay | null, factor: number): Replay | null {
  /**
   * Refused outright on a series with a zoomed section in it.
   *
   * Merging by `floor(t / (interval * factor))` groups bars by wall-clock
   * time, so every minute bar of the fine stretch would collapse back into the
   * two-hour bucket it sits inside — silently undoing the section the moment
   * anyone touched the bar-width control. The control is disabled while a
   * section is shown; this is the guard behind it.
   */
  if (!d || factor <= 1 || d.candles.length === 0 || d.zoom) return d;
  const interval = d.interval * factor;

  const candles: Replay["candles"] = [];
  const points: Replay["points"] = [];
  let bucket = -1;

  d.candles.forEach((c, i) => {
    const t = Math.floor(c.t / interval) * interval;
    const last = candles[candles.length - 1];
    if (!last || t !== bucket) {
      bucket = t;
      candles.push({ ...c, t });
      if (d.points[i]) points.push(d.points[i]);
      return;
    }
    last.h = Math.max(last.h, c.h);
    last.l = Math.min(last.l, c.l);
    last.c = c.c;
    last.v += c.v;
    // Later point in the same bucket wins: it is the more recent position.
    if (d.points[i]) points[points.length - 1] = d.points[i];
  });

  return { ...d, interval, candles, points };
}
/** Where the scrubber is, in seconds — what the "here" buttons snap an edge to. */
function barTime(d: Replay | null, bar: number): number {
  return d?.candles[Math.min(Math.max(bar, 0), d.candles.length - 1)]?.t ?? 0;
}

/** A moment, short and in UTC — the chart's own timebase. */
function stamp(sec: number): string {
  return new Date(sec * 1_000).toISOString().slice(5, 16).replace("T", " ") + "Z";
}

/** Bar width for a label: 15s, 5m, 2h. */
function barLabel(sec: number): string {
  if (sec >= 3_600) return `${(sec / 3_600).toFixed(sec % 3_600 ? 1 : 0)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec)}s`;
}
/** Pixels per bar. Fixed, so the replay scrolls instead of squeezing. */
const BAR_SPACING = 9;
/**
 * Real milliseconds one bar takes to form at 1x.
 *
 * Long enough that the bar visibly grows rather than blinking into place —
 * the whole point of animating it — and short enough that a token's first few
 * minutes still replay in a recordable span.
 */
const STEP_MS = 600;

type Mode = "candles" | "line";

/** One fill announcing itself over the chart. */
interface Flash {
  id: number;
  isBuy: boolean;
  usd: number;
  /** Market cap at the bar it landed on, already converted. */
  cap: number;
  /** Stacking offset, so a buy and a sell in one bar do not sit on top of
   *  each other. */
  slot: number;
  /** Which wallet, when a cluster is being replayed. */
  who?: string;
  /**
   * `enter` for one frame so the transition has somewhere to come from, then
   * `shown`, then `out` — either when its time is up or when the next fill
   * needs the space.
   */
  phase: "enter" | "shown" | "out";
  /** When it appeared, so it can retire itself. */
  bornAt: number;
  /** When it started leaving, so the fade can run from there. */
  outAt?: number;
}

let flashId = 0;
/** How long a label holds before it leaves of its own accord. */
const FLASH_MS = 1_400;

/**
 * The wash a fill throws, and where it is anchored.
 *
 * Both signs used to be `ellipse at center`, so a bar holding a buy AND a sell
 * composited one over the other at the same point. MEASURED: sell alone is
 * #3b1b1c at 54% saturation and buy alone #133329 at 63%, but green over red
 * is #3a4035 at 17% — a neutral grey that reads as a white flash rather than
 * as two fills. Anchoring each to its own edge when both are present keeps
 * them apart, and the common single-sign bar is centred exactly as before.
 *
 * Spelled out as four whole class names because Tailwind scans for literals;
 * building the string from an `at ${side}` fragment compiles and then renders
 * nothing, because the class it names was never generated.
 */
const WASH = {
  buy: {
    center:
      "bg-[radial-gradient(ellipse_at_center,rgba(53,211,153,0.20),transparent_70%)]",
    split:
      "bg-[radial-gradient(ellipse_at_right,rgba(53,211,153,0.20),transparent_70%)]",
  },
  sell: {
    center:
      "bg-[radial-gradient(ellipse_at_center,rgba(255,90,90,0.20),transparent_70%)]",
    split:
      "bg-[radial-gradient(ellipse_at_left,rgba(255,90,90,0.20),transparent_70%)]",
  },
} as const;

/** Once per this much gained, the fanfare sounds. */
const FANFARE_AT = 20_000;

/** The handle onto the mounted chart. Held in a ref; see `api`. */
interface ChartApi {
  chart: {
    remove(): void;
    resize(width: number, height: number): void;
    applyOptions(options: Record<string, unknown>): void;
    timeScale(): { scrollToRealTime(): void };
    /** A composed copy of the chart exactly as drawn — axes and all. */
    takeScreenshot(): HTMLCanvasElement;
  };
  series: { setData(rows: unknown[]): void; update(row: unknown): void };
  markers: { setMarkers(m: unknown[]): void } | null;
  lwc: typeof import("lightweight-charts");
  /** Index already painted into THIS series, so a step can append instead of
   *  rebuilding. Lives on the handle because it is only meaningful for the
   *  chart currently mounted — a mode switch builds a fresh, empty one. */
  painted: number;
}

type Mark = { time: number };

/** One label's worth of fills. */
export interface Fill {
  isBuy: boolean;
  usd: number;
  who?: string;
}

/**
 * One bar's fills, summed the way a single label represents them.
 *
 * The unit here is the LABEL, not the trade: a router can put a dozen fills in
 * one bar, and twelve numbers climbing the screen together says less than two
 * do. Both the live view and the exporter read this, so neither can disagree
 * with the other about what happened in a bar — re-deriving that on one side
 * is exactly how an earlier exporter drifted away from the screen.
 */
function fillsInBar(data: Replay, bar: number, perWallet: boolean): Fill[] {
  const candle = data.candles[bar];
  if (!candle) return [];
  const grouped = new Map<string, Fill>();
  for (const t of data.trades) {
    if (t.kind === "transfer" || !(t.usd > 0)) continue;
    if (barAt(data.candles, t.ts) !== bar) continue;
    const who = perWallet ? (t.wallet ?? undefined) : undefined;
    const key = `${t.isBuy}:${who ?? ""}`;
    const held = grouped.get(key) ?? { isBuy: t.isBuy, usd: 0, who };
    held.usd += t.usd;
    grouped.set(key, held);
  }
  return [...grouped.values()];
}

/** Whether a bar sold anything, which is what the till rings for. */
function soldInBar(data: Replay, bar: number): boolean {
  const candle = data.candles[bar];
  if (!candle) return false;
  return data.trades.some(
    (t) =>
      t.kind !== "transfer" &&
      !t.isBuy &&
      t.usd > 0 &&
      barAt(data.candles, t.ts) === bar,
  );
}

/**
 * Every cue a clip will play, and when.
 *
 * The bar-zero case is the subtle one: the live view ARMS the fanfare at the
 * opening bar without sounding it, so a wallet that is already up $80K when
 * the replay starts does not open with four blasts. Seeding `tier` from the
 * first point does the same thing here.
 */
function cueSchedule(data: Replay, stepMs: number): Cued[] {
  const cues: Cued[] = [];
  let tier = Math.max(Math.floor((data.points[0]?.total ?? 0) / FANFARE_AT), 0);
  for (let bar = 0; bar < data.candles.length; bar += 1) {
    const t = (bar * stepMs) / 1_000;
    if (soldInBar(data, bar)) cues.push({ t, cue: "kaching" });
    if (bar === 0) continue;
    const reached = Math.floor((data.points[bar]?.total ?? 0) / FANFARE_AT);
    if (reached > tier) {
      tier = reached;
      cues.push({ t, cue: "bandos" });
    }
  }
  return cues;
}

function finishedRow(c: ReplayCandle, mode: Mode): unknown {
  return mode === "candles"
    ? { time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }
    : { time: c.t, value: c.c };
}

/**
 * The bar being replayed, part-formed.
 *
 * Its close walks from the open toward the real close across the step, with
 * the high and low revealed as it goes, exactly as a live candle behaves while
 * trades land in it. Appending finished bars on a timer made the chart tick
 * like a slideshow, which is the thing that read as unnatural.
 */
function formingRow(data: Replay, bar: number, p: number, mode: Mode): unknown {
  const b = data.candles[bar];
  const from = data.candles[bar - 1]?.c ?? b.o;
  // Ease slightly: a linear walk looks mechanical at low speeds.
  const eased = p * p * (3 - 2 * p);
  const close =
    mode === "candles" ? b.o + (b.c - b.o) * eased : from + (b.c - from) * eased;
  return mode === "candles"
    ? {
        time: b.t,
        open: b.o,
        high: Math.max(b.o, close, b.o + (b.h - b.o) * eased),
        low: Math.min(b.o, close, b.o + (b.l - b.o) * eased),
        close,
      }
    : { time: b.t, value: close };
}

/**
 * Put the chart exactly where a moment in the replay says it should be.
 *
 * The one place the series is written, called both by the live frame loop and
 * by the exporter — so an export cannot drift from the screen, because it is
 * not copying the screen, it is the same instruction.
 *
 * Everything structural sits behind `painted !== bar`. The exporter calls this
 * thirty times a second with the same bar, and the guard it replaced (`painted
 * !== bar - 1`, written for an effect that ran once per bar) would have
 * rebuilt the entire history on every one of those frames.
 */
function seek(
  a: ChartApi,
  data: Replay,
  marks: Mark[],
  mode: Mode,
  bar: number,
  p: number,
): void {
  const candle = data.candles[bar];
  if (!candle) return;

  if (a.painted !== bar) {
    // `bar > 0` guards the opening frame: `painted` starts at -1, so without
    // it the append branch would take -1 === -1 and read candles[-1].
    if (bar > 0 && a.painted === bar - 1) {
      // The bar that was forming is finished history now; snap it to its close.
      a.series.update(finishedRow(data.candles[bar - 1], mode));
    } else {
      a.series.setData(data.candles.slice(0, bar).map((c) => finishedRow(c, mode)));
      a.chart.timeScale().scrollToRealTime();
    }

    const visible = marks.filter((m) => m.time <= candle.t);
    if (a.markers) a.markers.setMarkers(visible);
    else if (visible.length > 0) {
      a.markers = a.lwc.createSeriesMarkers(
        a.series as never,
        visible as never,
      ) as unknown as { setMarkers(m: unknown[]): void };
    }

    a.painted = bar;
  }

  a.series.update(formingRow(data, bar, p, mode));
}

/** Matches the CSS: 240ms in, hold, 240ms out. */
const FADE_MS = 240;

/**
 * The colour wash, on the 900ms curve the `replay-wash` keyframe describes —
 * up by 22%, down to nothing by the end. It rode the label's 240ms fade for a
 * while, which made an exported wash a third the length of the screen's.
 */
function washAt(age: number): number {
  if (age < 0 || age > 900) return 0;
  return age < 198 ? age / 198 : 1 - (age - 198) / 702;
}

/**
 * The labels floating over the chart at one moment of a clip.
 *
 * Time here is clip time, not the wall clock, which is the whole reason the
 * exporter cannot reuse the live view's state. The displacement rule is the
 * part that matters: a new fill pushes the previous one OUT rather than
 * stacking on it, so only the most recent filled bar is ever fully on screen.
 * Deriving this as "any fill within FLASH_MS" instead would pile eighteen bars
 * of labels on top of each other at 8x, where the screen shows one.
 */
function flashesAtClip(
  filled: { bar: number; at: number; fills: Fill[] }[],
  cursor: number,
  clipMs: number,
  caps: number[],
): PaintFlash[] {
  const out: PaintFlash[] = [];
  const live = filled[cursor];
  if (!live) return out;

  const push = (
    group: { bar: number; at: number; fills: Fill[] },
    leftAt: number | null,
  ) => {
    group.fills.forEach((f, slot) => {
      const age = clipMs - group.at;
      const alpha =
        leftAt === null
          ? Math.min(1, age / FADE_MS)
          : Math.max(0, 1 - (clipMs - leftAt) / FADE_MS);
      if (alpha <= 0) return;
      out.push({
        isBuy: f.isBuy,
        usd: f.usd,
        cap: caps[group.bar] ?? 0,
        slot,
        who: f.who,
        alpha,
        // The DOM renders a wash only for flashes that are not on their way
        // out, so an outgoing one glows nowhere.
        wash: leftAt === null ? washAt(age) : 0,
        out: leftAt !== null,
      });
    });
  };

  // Its time ran out with no later fill to displace it.
  const expired = clipMs - live.at > FLASH_MS;
  push(live, expired ? live.at + FLASH_MS : null);

  const before = filled[cursor - 1];
  if (before) push(before, live.at);

  return out;
}

/**
 * Redenominate the candles from price to market cap.
 *
 * Done once at the boundary rather than at each draw: the chart, the crosshair,
 * the axis and the ATH line then all read the same number, and nothing
 * downstream has to know a conversion happened. A market cap is what anyone
 * watching a recording actually recognises — "it ran to four million" means
 * something, "it ran to 0.0000042" does not.
 *
 * Supply is constant over a replay, so scaling every OHLC value by it leaves
 * the shape of the chart untouched. With no supply figure the prices stand
 * as they are rather than collapsing the chart to zero.
 */
function toMarketCap(d: Replay): Replay {
  if (!(d.supply > 0)) return d;
  const s = d.supply;
  return {
    ...d,
    candles: d.candles.map((c) => ({
      ...c,
      o: c.o * s,
      h: c.h * s,
      l: c.l * s,
      c: c.c * s,
    })),
  };
}

/**
 * Market cap when we have supply, price when we do not.
 *
 * A price axis with nine decimals is unreadable at a glance and a market cap
 * axis with nine decimals is nonsense, so the format follows the units the
 * data is actually in.
 */
const capFormat = { type: "custom" as const, formatter: capLabel, minMove: 1 };
const priceFormat = { type: "price" as const, precision: 9, minMove: 1e-9 };

export function WalletReplay({
  mint,
  wallet,
  label,
  preloaded,
  onClose,
}: {
  mint: string;
  wallet: string;
  label?: string;
  /**
   * The history this replay needs, when the page already has it.
   *
   * Opening a replay used to refetch exactly what the page had just fetched,
   * and the wallet path is not cached by mint alone, so it ran the whole
   * reconstruction a second time.
   */
  preloaded?: TokenHistory;
  onClose: () => void;
}) {
  const [raw, setRaw] = useState<Replay | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  /**
   * The stretch drawn at the finer bar width, and the one the control is
   * currently pointing at.
   *
   * The control appears only when the server offers `zoomable`, which means a
   * finer series is stored for this mint. `applied` is what the last fetch
   * asked for; `picked` is what the sliders
   * say and costs nothing until Apply is pressed, because moving them would
   * otherwise refetch on every pixel of drag.
   */
  const [applied, setApplied] = useState<{ from: number; to: number } | null>(null);
  const [picked, setPicked] = useState<{ from: number; to: number } | null>(null);
  /**
   * What the chart actually draws. `raw` is what the server sent; every bar
   * width offered is derived from it without another request.
   */
  const data = useMemo(() => coarsen(raw, zoom), [raw, zoom]);
  const [at, setAt] = useState(0);
  /**
   * Starts false and is turned on when the data lands.
   *
   * The FIRST play always happens — a replay that opens paused on an empty
   * frame reads as broken. The toggle governs what happens when it loops.
   */
  const [playing, setPlaying] = useState(false);
  /**
   * Bumped whenever the chart is rebuilt, purely to re-run the paint effect.
   *
   * This was `setAt((i) => i)`, which sets the same value — React bails out of
   * the render, so nothing repainted into the new series. The chart is rebuilt
   * exactly when the data arrives (`asCap` flips as supply becomes known), so
   * the first paint was the one being lost, and the replay sat blank until
   * some unrelated click forced a render.
   */
  const [chartBuilt, setChartBuilt] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(2);
  const [mode, setMode] = useState<Mode>("candles");
  const [effectsOn, setEffectsOn] = useEffects();
  /**
   * Whether the replay LOOPS. The first play always happens; this decides
   * whether it starts over at the end or holds on the final bar, which is what
   * you want once a recording is done.
   */
  const [autoPlay, setAutoPlay] = useAutoPlay();
  const [soundOn, setSoundOn] = useStoredFlag("trickshot:sound");
  /**
   * The highest $20K step the fanfare has already sounded for.
   *
   * A high-water mark rather than the last value, so a wallet that dips and
   * recovers does not sound the same step twice — it fires on GAINING another
   * twenty thousand, not on wobbling across a line.
   */
  const tier = useRef(0);
  /** Null when not recording; otherwise 0..1. */
  const [clipping, setClipping] = useState<number | null>(null);
  const abortClip = useRef(false);
  const [shape, setShape] = useStoredValue<Shape>(
    "trickshot:shape",
    "landscape",
    SHAPES,
  );
  /** Set to the projected length when a clip would run past the ceiling. */
  const [tooLong, setTooLong] = useState<number | null>(null);
  /** Shows the frames as they are encoded, where the chart usually sits. */
  const previewRef = useRef<HTMLCanvasElement>(null);
  /** The token's symbol, shown in the header and drawn on exported frames. */
  const [ticker, setTicker] = useState("");
  /** Why the chart is empty, when the reason is the site rather than the wallet. */
  const [failure, setFailure] = useState<{ message: string; queued: boolean } | null>(
    null,
  );
  /**
   * What this browser can encode. Asked once, and asked ASYNCHRONOUSLY —
   * WebCodecs answers with a promise, so unlike the check this replaced there
   * is a moment where the answer is not known yet and the button has to say so
   * rather than claim the browser cannot do it.
   */
  const [encoders, setEncoders] = useState<Encoders | null | "probing">(
    "probing",
  );
  useEffect(() => {
    let dead = false;
    void negotiate().then((e) => {
      if (!dead) setEncoders(e);
    });
    return () => {
      dead = true;
    };
  }, []);
  /**
   * Fills currently animating over the chart.
   *
   * Held in state rather than drawn into the canvas because the chart library
   * owns that canvas — anything painted there is wiped on the next update, and
   * a fill's flash has to outlive the bar that produced it.
   */
  const [flashes, setFlashes] = useState<Flash[]>([]);
  /**
   * Wallets this one appears to be operating with. Never fetched on open —
   * it reads other wallets' histories, and a replay should not wait for that.
   */
  const [related, setRelated] = useState<RelatedReport | null>(null);
  /** Null until asked; false when this wallet has no graph to show. */
  /**
   * Never set any more — the control that fetched a graph has been removed.
   *
   * Kept as state rather than deleted with the panel below it, because that
   * panel is also where a linked wallet is TICKED into the replay, and the
   * cluster machinery (`folded`, `alongside`) hangs off it. Removing the
   * display would quietly remove folding too, which is a bigger decision than
   * taking a button off the controls row.
   */
  const [hasGraph] = useState<boolean | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  /** Which wallet the loaded data belongs to, so a cluster change is not
   *  mistaken for a wallet change. */
  const subject = useRef("");
  /** Whether the loaded candles are market caps. Drives the axis format, so
   *  the chart is rebuilt once when it flips on load. */
  const asCap = (data?.supply ?? 0) > 0;

  /**
   * Where the section sliders currently sit, defaulting to the whole offered
   * stretch until someone moves them, and clamped to it afterwards — the
   * offered stretch changes when the wallet does, and a leftover pick from the
   * previous wallet would sit outside it.
   */
  const zoomable = raw?.zoomable;
  const span = useMemo(() => {
    if (!zoomable) return null;
    const from = Math.min(Math.max(picked?.from ?? zoomable.from, zoomable.from), zoomable.to);
    const to = Math.max(Math.min(picked?.to ?? zoomable.to, zoomable.to), from);
    // The selectable bounds travel with the selection, so the control reads
    // them off one object that is known to exist rather than re-narrowing
    // `raw?.zoomable` at every use inside the markup.
    return { from, to, min: zoomable.from, max: zoomable.to, fine: zoomable.interval };
  }, [zoomable, picked]);
  const tooManyBars = Boolean(
    span && (span.to - span.from) / span.fine > ZOOM_MAX_BARS,
  );

  /** Sorted so the same selection in a different order is the same request. */
  const foldedKey = [...folded].sort().join(",");
  const alongside = useMemo(
    () => (foldedKey ? foldedKey.split(",") : []),
    [foldedKey],
  );

  const holder = useRef<HTMLDivElement>(null);
  const api = useRef<ChartApi | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * The token is read back off the chain, whole, however old it is — there
     * is no live feed here to fall back to, and it turns out not to be needed:
     * a reconstruction covers the run-up as well as the present.
     */
    const shape = (h: TokenHistory | null): Replay => ({
      /**
       * The server's own bar width, not a constant.
       *
       * This was hardcoded to 15, and everything that buckets by it inherited
       * that: a trade at 12:47 on a two-hour chart was marked at 12:47:00
       * rounded to the nearest 15 seconds, which is not a time any bar sits at,
       * so the marker was dropped and the wallet's trades never appeared on the
       * candles they belonged to.
       */
      interval: h?.interval || 15,
      supply: h?.supply ?? 0,
      candles: h?.candles ?? [],
      trades: h?.trades ?? [],
      points: h?.points ?? [],
      zoom: h?.zoom,
      zoomable: h?.zoomable,
    });
    /**
     * A cluster reload is a real request, so it waits a moment: ticking three
     * wallets in a row should fetch once, not three times.
     */
    const load: Promise<TokenHistory | null> =
      // The preloaded history is the one the page fetched with no section, so
      // it cannot answer a request that has one.
      preloaded && alongside.length === 0 && !applied
        ? Promise.resolve(preloaded)
        : new Promise<void>((r) => {
            timer = setTimeout(r, alongside.length > 0 ? 400 : 0);
          }).then(() =>
            fetchHistory(mint, wallet, 300, alongside, applied ?? undefined),
          );
    void load.then((h) => {
      if (cancelled) return;
      /**
       * Why it is empty, not just that it is.
       *
       * `shape` maps anything it does not understand to no candles, and the
       * chart reads no candles as "not enough history yet" — which is a
       * sentence about the WALLET. A refusal, a queued build and a rate limit
       * are sentences about the SITE, and all three arrived here dressed as
       * the first. MEASURED: a token being indexed answered 413 twice and the
       * page said the wallet had barely traded.
       */
      setFailure(h?.error ? { message: h.error, queued: Boolean(h.queued) } : null);
      setRaw(toMarketCap(shape(h)));
      /**
       * Which token this is, for the exported frame to say.
       *
       * `shape` deliberately keeps only what the chart consumes, so the symbol
       * would be thrown away here — it is read off the history before that.
       */
      setTicker((h?.symbol ?? h?.name ?? "").trim().toUpperCase());
      setAt(0);
      /**
       * A different wallet's graph is not this wallet's — but a CLUSTER change
       * is the same wallet, and clearing the selection there would undo the
       * tick that caused the reload.
       */
      if (subject.current !== `${mint}|${wallet}`) {
        subject.current = `${mint}|${wallet}`;
        setRelated(null);
        setFolded(new Set());
        /**
         * A different wallet is a different chart over a different span, so a
         * section picked on the last one means nothing on this one. Both are
         * already null on the common path, and React bails out of a set to the
         * value it is holding — so this refetches only when a section really
         * was applied, which is exactly when it should.
         */
        setPicked(null);
        setApplied(null);
      }

      // Always, whatever the toggle says. See `playing`.
      setPlaying(true);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [mint, wallet, preloaded, alongside, applied]);

  // Build the chart once per display mode. Switching mode swaps the series
  // type, which means a fresh chart rather than a mutated one.
  useEffect(() => {
    let dead = false;
    void (async () => {
      const lwc = await loadLwc();
      if (dead || !holder.current) return;
      holder.current.innerHTML = "";
      const chart = lwc.createChart(holder.current, {
        height: 340,
        layout: {
          background: { color: "transparent" },
          textColor: "#8a93a6",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.04)" },
          horzLines: { color: "rgba(255,255,255,0.04)" },
        },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
        timeScale: {
          borderColor: "rgba(255,255,255,0.08)",
          timeVisible: true,
          secondsVisible: true,
          /**
           * Fixed spacing with the right edge pinned — the way a live chart
           * behaves. The first version called fitContent() on every frame,
           * which rescaled the whole range each step, so bars squeezed
           * narrower as the replay ran instead of scrolling past.
           */
          barSpacing: BAR_SPACING,
          /**
           * Half the visible bars of empty space to the right, so the newest
           * bar sits mid-chart with room ahead of it. Pinning it to the right
           * edge left the action crammed against the frame with nowhere for
           * the next move to go — bad to watch and worse to record.
           */
          rightOffset: Math.round(
            (holder.current.clientWidth || 900) / BAR_SPACING / 2,
          ),
          shiftVisibleRangeOnNewBar: true,
          lockVisibleTimeRangeOnResize: true,
        },
        crosshair: { mode: 0 },
        handleScroll: false,
        handleScale: false,
      });
      const series =
        mode === "candles"
          ? chart.addSeries(lwc.CandlestickSeries, {
              upColor: "#3fd08a",
              downColor: "#ff5c5c",
              borderVisible: false,
              wickUpColor: "#3fd08a",
              wickDownColor: "#ff5c5c",
              priceFormat: asCap ? capFormat : priceFormat,
            })
          : chart.addSeries(lwc.LineSeries, {
              color: "#f0b429",
              lineWidth: 2,
              priceFormat: asCap ? capFormat : priceFormat,
            });
      api.current = {
        chart: chart as never,
        series: series as never,
        markers: null,
        lwc,
        painted: -1,
      };
      setChartBuilt((n) => n + 1); // repaint into the new series
    })();
    return () => {
      dead = true;
      api.current?.chart.remove();
      api.current = null;
    };
  }, [mode, asCap, zoom]);

  /**
   * The wallet's trades, one marker per bar per side, labelled where there is room.
   *
   * Three things had to go right for this to be readable.
   *
   * TRANSFERS ARE NOT TRADES. Tokens arriving by transfer have no price, so
   * they were drawing as "BUY $0" — and there can be a great many of them:
   * one wallet on this token has 267 transfers against 73 real fills. They are
   * dropped; the chart marks what the wallet bought and sold.
   *
   * FILLS IN THE SAME BAR ARE SUMMED. A router can put a dozen fills inside
   * one bar, and a marker each stacked them into an unreadable pile.
   *
   * LABELS ARE ASSIGNED BY SIZE, NOT BY TIME. Bars are nine pixels apart and
   * "SELL $12.3K" is about seventy, so any two labels within eight bars of
   * each other overlap. Every marker keeps its dot; the TEXT goes to the
   * biggest trades first, and a smaller one inside the space an already
   * labelled trade needs stays a dot. Reading it left to right instead would
   * let a $20 fill claim the space and silently mute the $40,000 one beside it.
   */
  const marks = useMemo(() => {
    if (!data) return [];

    /**
     * Grouped per wallet as well as per side once a cluster is being replayed:
     * seeing WHICH wallet bought is most of the point of replaying them
     * together, and summing them into one marker throws it away.
     */
    const grouped = new Map<
      string,
      { time: number; bar: number; isBuy: boolean; usd: number; wallet?: string | null }
    >();
    for (const t of data.trades) {
      if (t.kind === "transfer" || !(t.usd > 0)) continue;
      /**
       * The bar index is CARRIED, not recovered from the time later on.
       *
       * `time / interval` was a bar index only while every bar was the same
       * width and the series started at a multiple of it. With a finer section
       * spliced in, neither holds — a marker two thirds of the way along a
       * 400-bar chart came out at bar 29,790,000, and the collision test that
       * spaces the labels compared it against nothing.
       */
      const i = barAt(data.candles, t.ts);
      if (i < 0) continue;
      const time = data.candles[i]?.t ?? t.ts;
      const who = alongside.length > 0 ? (t.wallet ?? "") : "";
      const key = `${i}:${t.isBuy}:${who}`;
      const at = grouped.get(key) ?? {
        time,
        bar: i,
        isBuy: t.isBuy,
        usd: 0,
        wallet: t.wallet,
      };
      at.usd += t.usd;
      grouped.set(key, at);
    }

    const all = [...grouped.values()];
    type Marker = (typeof all)[number];
    const keyOf = (g: Marker) => `${g.time}:${g.isBuy}:${g.wallet ?? ""}`;
    const tag = (g: Marker) =>
      alongside.length > 0 && g.wallet ? ` ${g.wallet.slice(0, 4)}` : "";

    /**
     * Two ways to write the same marker, and the shorter one is not a
     * degradation — the side is already in the colour and in which way the
     * marker hangs off the bar, so "SELL" is the one part of the label that
     * repeats what the reader can see.
     */
    const full = (g: Marker) =>
      `${g.isBuy ? "BUY" : "SELL"} ${usdCompact(g.usd)}${tag(g)}`;
    const compact = (g: Marker) => `${usdCompact(g.usd)}${tag(g)}`;

    /** Rough width of a marker label. The font is ~11px; this is close enough
     *  to keep neighbours apart without measuring text on a canvas. */
    const widthOf = (text: string) => text.length * 6.2 + 10;

    /** Which of one side's markers can carry `write` without overlapping. */
    const place = (side: Marker[], write: (g: Marker) => string) => {
      const kept = new Set<string>();
      const placed: { bar: number; half: number }[] = [];
      for (const g of side) {
        const half = widthOf(write(g)) / 2;
        const clear = placed.every(
          (other) => Math.abs(other.bar - g.bar) * BAR_SPACING >= other.half + half,
        );
        if (!clear) continue;
        placed.push({ bar: g.bar, half });
        kept.add(keyOf(g));
      }
      return kept;
    };

    /**
     * Full labels where they all fit, short ones where they do not.
     *
     * The rule used to be one form and silence for whatever collided with it,
     * which is the right call against a $20 fill crowding a $40,000 one and
     * the wrong one against two big sells minutes apart — and zooming into a
     * section is precisely what turns the second case from rare into normal.
     * MEASURED on Frank's exit: two sells six one-minute bars apart, 54px of
     * room, 81px wanted as "SELL $167.2K" and "SELL $74.1K" — so the smaller
     * one lost its text. Dropping the word costs 31px and keeps both.
     *
     * Chosen per side and applied to all of that side, because a row where
     * some markers say SELL and others do not reads as two kinds of event.
     * Buys and sells are laid out independently — they sit on opposite sides
     * of the bar and cannot collide with each other.
     */
    const text = new Map<string, string>();
    for (const isBuy of [true, false]) {
      const side = all
        .filter((g) => g.isBuy === isBuy)
        // Biggest first: the space goes to the trades worth reading, and a
        // smaller one inside the room an already-placed label needs stays a dot.
        .sort((a, b) => b.usd - a.usd);
      const long = place(side, full);
      const short = long.size === side.length ? long : place(side, compact);
      const better = short.size > long.size;
      const write = better ? compact : full;
      const kept = better ? short : long;
      for (const g of side) if (kept.has(keyOf(g))) text.set(keyOf(g), write(g));
    }

    // Ascending, because the library requires markers in time order.
    return all
      .sort((a, b) => a.time - b.time || Number(b.isBuy) - Number(a.isBuy))
      .map((g) => ({
        time: g.time,
        position: g.isBuy ? "belowBar" : "aboveBar",
        color: g.isBuy ? "#3fd08a" : "#ff5c5c",
        shape: "circle",
        text: text.get(keyOf(g)) ?? "",
      }));
  }, [data, alongside]);

  /**
   * A fill lands: wash the chart, float the number.
   *
   * Keyed off the bar index rather than the clock, so scrubbing to a bar
   * replays its fills and a paused chart stays still.
   *
   * A new fill pushes the previous one OUT rather than stacking on it. At
   * eight times speed a busy wallet lands fills faster than a label can finish
   * leaving, and they piled up on top of each other; now the outgoing label
   * fades and keeps drifting from wherever it had got to, which reads as being
   * displaced rather than as two labels fighting.
   */
  useEffect(() => {
    if (!effectsOn || !data) return;
    const bar = data.candles[at];
    if (!bar) return;

    const inBar = fillsInBar(data, at, alongside.length > 0);
    if (inBar.length === 0) return;

    const born: Flash[] = inBar.map((v, i) => ({
      id: (flashId += 1),
      isBuy: v.isBuy,
      usd: v.usd,
      cap: bar.c,
      slot: i,
      who: v.who,
      phase: "enter",
      bornAt: 0,
    }));

    /**
     * Spawned on the next frame rather than in the effect body.
     *
     * Adding to state synchronously here is a cascading render — the effect
     * runs as part of the commit that moved the bar, so it would immediately
     * schedule another. It also gives the `enter` phase a frame to be painted
     * from, which is what the transition eases out of.
     */
    let show = 0;
    const raf = requestAnimationFrame(() => {
      const bornAt = Date.now();
      setFlashes((held) => [
        // Whatever is on screen makes way.
        ...held.map((f) => ({ ...f, phase: "out" as const, outAt: bornAt })),
        ...born.map((f) => ({ ...f, bornAt })),
      ]);
      show = requestAnimationFrame(() =>
        setFlashes((held) =>
          held.map((f) =>
            f.phase === "enter" ? { ...f, phase: "shown" as const } : f,
          ),
        ),
      );
    });

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(show);
    };
  }, [at, data, effectsOn, alongside]);

  /**
   * Labels retire themselves, on a clock of their own.
   *
   * This used to be a `setTimeout` inside the effect that spawned them, and
   * that effect's cleanup runs on every bar change — so the moment the replay
   * reached a bar with no fills, the pending timer was cancelled and the last
   * label sat there for good. Nothing was left to retire it, because the only
   * other thing that did was the NEXT fill arriving.
   *
   * Driven off each label's own birth time instead, so it leaves on schedule
   * whatever the chart is doing.
   */
  useEffect(() => {
    if (flashes.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setFlashes((held) => {
        let changed = false;
        const next = held.map((f) => {
          if (f.phase !== "shown" || now - f.bornAt < FLASH_MS) return f;
          changed = true;
          return { ...f, phase: "out" as const, outAt: now };
        });
        // Returning the same array when nothing expired keeps this from
        // re-rendering the chart every tick.
        return changed ? next : held;
      });
    }, 120);
    return () => clearInterval(timer);
  }, [flashes.length]);

  /**
   * Sound follows the bar, not the fills list.
   *
   * A kaching for every bar that sold something — one per bar rather than one
   * per fill, or a router splitting a sale across a dozen pools would fire a
   * dozen tills at once.
   */
  useEffect(() => {
    // Never while exporting: that clip's sound is rendered offline onto its own
    // timeline, and a cue firing here would only be heard by the room.
    if (!soundOn || !data || !playing || clipping !== null) return;
    const bar = data.candles[at];
    if (!bar) return;

    if (soldInBar(data, at)) playCue("kaching");

    /**
     * Once per $20K gained. A bar that leaps several steps at once still
     * sounds once — five fanfares stacked on one frame is noise, not emphasis.
     * Rewinding to the start arms it again, so a second play sounds the same.
     */
    const total = data.points[at]?.total ?? 0;
    const reached = Math.floor(total / FANFARE_AT);
    if (at === 0) tier.current = Math.max(reached, 0);
    else if (reached > tier.current) {
      tier.current = reached;
      playCue("bandos");
    }
  }, [at, data, playing, soundOn, clipping]);

  /**
   * Render the replay to a file.
   *
   * The replay is DRIVEN here rather than watched: the exporter decides what
   * moment each frame is, seeks the chart to it, and composes the frame around
   * the result. That is what lets the clip come out at a flat 30fps on any
   * machine — a slow composite makes the export take longer, not the video run
   * badly, which is precisely what the old wall-clock recorder could not do.
   *
   * For the duration the chart belongs to this function. Playback is stopped,
   * the controls that could rebuild or reload it are disabled, and the holder
   * is moved off-screen at the export's own size so the chart redraws crisply
   * at that resolution instead of being upscaled from the page.
   */
  const exportClip = useCallback(async () => {
    const a = api.current;
    const holderEl = holder.current;
    if (!a || !holderEl || !data || data.candles.length < 2) return;
    if (!encoders || encoders === "probing") return;

    const bars = data.candles.length;
    const stepMs = STEP_MS / speed;
    const replaySeconds = (bars * stepMs) / 1_000;
    if (replaySeconds + OUTRO_SECONDS > MAX_CLIP_SECONDS) {
      setTooLong(Math.round(replaySeconds + OUTRO_SECONDS));
      return;
    }
    setTooLong(null);

    const layout = layoutFor(shape);
    const dpr = window.devicePixelRatio || 1;
    /** Output pixels per design pixel. Everything the chart draws scales by it. */
    const k = layout.chart.w / DESIGN_W;
    const cssW = layout.chart.w / dpr;
    const cssH = layout.chart.h / dpr;
    /** A lightweight-charts option, which are all in CSS pixels. */
    const opt = (designPx: number) => (designPx * k) / dpr;

    const perWallet = alongside.length > 0;
    const filled: { bar: number; at: number; fills: Fill[] }[] = [];
    const caps: number[] = [];
    for (let bar = 0; bar < bars; bar += 1) {
      caps.push(data.candles[bar]?.c ?? 0);
      if (!effectsOn) continue;
      const fills = fillsInBar(data, bar, perWallet);
      if (fills.length > 0) filled.push({ bar, at: bar * stepMs, fills });
    }

    const replayFrames = Math.ceil((replaySeconds * FPS));
    const outroFrames = OUTRO_SECONDS * FPS;
    const frames = replayFrames + outroFrames;

    const last = data.points[data.points.length - 1];
    const bought = last?.boughtUsd ?? 0;
    const totals: Totals | null = last
      ? {
          bought,
          sold: last.soldUsd,
          total: last.total,
          // Nothing spent means no percentage exists to show — a wallet that
          // was airdropped its tokens would otherwise divide by zero.
          pct: bought > 0 ? (last.total / bought) * 100 : null,
        }
      : null;

    abortClip.current = false;
    setClipping(0);
    setPlaying(false);

    /**
     * Past a macrotask, not just a frame.
     *
     * `clipping` is what stands the live paint loop down, and React may not
     * have run that effect by the next animation frame — so yielding only an
     * rAF here leaves the live loop writing over the exporter's first seek.
     */
    await new Promise((r) => setTimeout(r, 0));

    const restore = (() => {
      const style = holderEl.getAttribute("style") ?? "";
      return () => {
        holderEl.setAttribute("style", style);
        const live = api.current;
        if (!live) return;
        // Against the live handle, not the captured one: if the chart was
        // rebuilt it was built inside a holder still at export size, and with
        // no autoSize it kept that width.
        live.chart.resize(holderEl.clientWidth, 340);
        live.chart.applyOptions({
          layout: { fontSize: 12 },
          timeScale: {
            barSpacing: BAR_SPACING,
            rightOffset: Math.round(
              (holderEl.clientWidth || 900) / BAR_SPACING / 2,
            ),
          },
          // The library's own defaults, which the export overrides.
          rightPriceScale: { scaleMargins: { top: 0.2, bottom: 0.1 } },
        });
        live.chart.timeScale().scrollToRealTime();
        live.painted = -1;
      };
    })();

    try {
      if (soundOn) await prepareSound();
      const audio = soundOn
        ? await renderCues(
            cueSchedule(data, stepMs),
            replaySeconds + OUTRO_SECONDS,
          )
        : null;

      holderEl.style.position = "fixed";
      holderEl.style.left = "-100000px";
      holderEl.style.top = "0";
      holderEl.style.width = `${cssW}px`;
      holderEl.style.height = `${cssH}px`;

      /**
       * Resize first, then apply the options.
       *
       * `lockVisibleTimeRangeOnResize` rewrites barSpacing by the ratio of the
       * new width to the old one on every resize; setting ours afterwards
       * simply overwrites that, so the option needs no special handling.
       *
       * `rightOffset` is a bar COUNT, so it works out to the same number at
       * any scale — but it is only ever set at construction, so it has to be
       * named here and again on the way back.
       */
      a.chart.resize(cssW, cssH);
      a.chart.applyOptions({
        layout: { fontSize: opt(12) },
        timeScale: {
          barSpacing: opt(BAR_SPACING),
          rightOffset: Math.round(cssW / opt(BAR_SPACING) / 2),
        },
        rightPriceScale: { scaleMargins: layout.scaleMargins },
      });

      a.painted = -1;
      seek(a, data, marks, mode, 0, 0);
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      let cursor = -1;
      const result = await encode({
        shape,
        encoders,
        frames,
        fps: FPS,
        audio,
        cancelled: () => abortClip.current || api.current !== a,
        onProgress: (i) => {
          // On bar boundaries only — a setState per frame would cost more than
          // the frame does.
          if (i % FPS === 0) setClipping(i / frames);
        },
        draw: (ctx, i) => {
          if (api.current !== a) throw new Error("chart went away mid-export");
          const clipMs = Math.min(i / FPS, replaySeconds) * 1_000;
          const exact = clipMs / stepMs;
          const bar = Math.min(Math.floor(exact), bars - 1);
          seek(a, data, marks, mode, bar, Math.min(exact - bar, 1));

          while (cursor + 1 < filled.length && filled[cursor + 1].at <= clipMs) {
            cursor += 1;
          }

          const point = data.points[Math.min(bar, data.points.length - 1)] ?? null;
          paint(ctx, {
            layout,
            shot: a.chart.takeScreenshot(),
            // TEMP: ticker hidden in the export. Restore `ticker,` to bring it back.
            ticker: undefined,
            label,
            wallet,
            asCap,
            point,
            trades: data.trades.filter(
              (t) => barAt(data.candles, t.ts) <= bar,
            ).length,
            flashes:
              cursor >= 0 ? flashesAtClip(filled, cursor, clipMs, caps) : [],
            outro:
              i < replayFrames ? 0 : (i - replayFrames + 1) / outroFrames,
            totals,
          });

          const preview = previewRef.current;
          if (preview) {
            const pctx = preview.getContext("2d");
            if (pctx) {
              pctx.drawImage(ctx.canvas, 0, 0, preview.width, preview.height);
            }
          }
        },
      });

      if (result && !abortClip.current) {
        const who = (label ?? wallet).replace(/[^\w.-]+/g, "-").slice(0, 40);
        const { w, h } = FORMATS[shape];
        save(result.blob, `trickshot-${who}-${w}x${h}.${result.ext}`);
      }
    } catch {
      // A chart pulled out from under the loop, or an encoder that gave up.
      // Nothing is saved and the replay goes back to how it was.
    } finally {
      restore();
      setClipping(null);
    }
  }, [
    alongside.length,
    asCap,
    data,
    effectsOn,
    encoders,
    label,
    marks,
    mode,
    shape,
    soundOn,
    speed,
    ticker,
    wallet,
  ]);

  /**
   * Paint and play, in one loop.
   *
   * Driven by requestAnimationFrame off the wall clock, so the motion is smooth
   * at any speed and honest about dropped frames. React state only changes on a
   * bar boundary — a re-render per frame would cost more than it drew, and
   * `seek` keeps the structural work behind its own per-bar guard.
   */
  useEffect(() => {
    const a = api.current;
    if (!a || !data || data.candles.length === 0) return;
    /**
     * The exporter owns the chart while a clip is being made — it seeks the
     * series itself, and two writers on one series fight. `clipping` is in the
     * deps, so an export starting re-runs this effect: the cleanup cancels the
     * frame already queued and the return stops another being asked for.
     */
    if (clipping !== null) return;
    const total = data.candles.length;

    if (!playing) {
      seek(a, data, marks, mode, at, 1);
      return;
    }

    const duration = STEP_MS / speed;
    const started = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const p = Math.min((now - started) / duration, 1);
      seek(a, data, marks, mode, at, p);
      if (p >= 1) {
        const next = at + 1;
        if (next >= total) {
          /**
           * The loop is the "subsequent play" the toggle governs.
           *
           * Off means the replay STOPS ON ITS LAST BAR. Leaving `at` where it
           * is does that: the effect re-runs with `playing` false and paints
           * the finished bar. Winding back to zero first put the chart on the
           * opening frame before it stopped, which throws away the ending —
           * the part a recording is usually made for.
           */
          if (!autoPlay) {
            setPlaying(false);
            return;
          }
          setAt(0);
        } else {
          setAt(next);
        }
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [at, data, marks, mode, playing, speed, autoPlay, chartBuilt, clipping]);


  const now: ReplayPoint | undefined = data?.points[Math.min(at, (data?.points.length ?? 1) - 1)];
  const up = (now?.total ?? 0) >= 0;
  const total = data?.candles.length ?? 0;

  /**
   * Everything that could move the replay is frozen while a clip renders.
   *
   * Not politeness — the export holds the chart for up to a minute and a half,
   * and several of these controls destroy it. Changing zoom or mode rebuilds
   * the chart outright; ticking a linked wallet re-runs the load, which resets
   * the playhead, starts playback and can flip the axis into rebuilding the
   * chart as well. Any of them mid-clip leaves the exporter screenshotting
   * something that no longer exists.
   */
  const locked = clipping !== null;
  const clipSeconds = Math.round(
    (total * (STEP_MS / speed)) / 1_000 + OUTRO_SECONDS,
  );

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/75 p-2 sm:items-center sm:p-4"
      /* Ignored while a clip renders: closing would unmount the chart the
         exporter is still reading frames from. */
      onClick={locked ? undefined : onClose}
    >
      <div
        className="my-auto w-full max-w-[1040px] rounded-md border border-line-strong bg-ink-900 p-4 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            {/*
              The ticker belongs on screen, not only in the export.
              
              The exported frame has always carried it, because a clip that
              leaves the page has to say which token it is. On the page itself
              it was left out on the grounds that the surrounding UI already
              said — but the modal covers that UI, and once it is open the
              chart is a wallet's PnL against bars with no name attached. Same
              amber, same weight as the frame draws it, so a recording and the
              thing being recorded agree.
            */}
            {ticker && (
              <div className="font-mono text-[10.5px] leading-none font-bold tracking-[0.1em] text-amber">
                {ticker}
              </div>
            )}
            {label && (
              <div className="mt-1.5 font-mono text-[18px] font-bold text-tx">
                {label}
              </div>
            )}
            {/* The address stays on screen whether or not it has a name — a
                recording of a replay should say which wallet it is. */}
            {alongside.length > 0 && (
              <div className="mt-1 font-mono text-[10.5px] tracking-[0.1em] text-amber uppercase">
                replaying as one position with {alongside.length} linked wallet
                {alongside.length === 1 ? "" : "s"}
              </div>
            )}
            <div className="mt-1 flex items-center gap-2">
              <span
                title={wallet}
                className={cx(
                  "truncate font-mono select-all",
                  label ? "text-[11px] text-tx3" : "text-[13px] font-bold text-tx sm:text-[15px]",
                )}
              >
                {wallet}
              </span>
              <Copy value={wallet} label="wallet address" />
            </div>
          </div>
          <div className="text-left sm:text-right">
            <div
              className={cx(
                "tnum font-mono text-[32px] leading-none font-bold sm:text-[44px]",
                up ? "text-mint" : "text-signal",
              )}
            >
              {now ? `${up ? "+" : "−"}${usdCompact(Math.abs(now.total))}` : "—"}
            </div>
            <div className="mt-1.5 font-mono text-[10px] tracking-[0.12em] text-tx3 uppercase">
              total pnl
            </div>
          </div>
        </div>

        <div className="relative w-full" style={{ minHeight: 340 }}>
          <div ref={holder} className="w-full" style={{ height: 340 }} />

          {/* The chart is off-screen at export size while this renders, so its
              usual place shows the frames actually being encoded. */}
          {locked && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink-900">
              <canvas
                ref={previewRef}
                width={FORMATS[shape].w / 4}
                height={FORMATS[shape].h / 4}
                className="max-h-[320px] max-w-full rounded-xs border border-line object-contain"
              />
            </div>
          )}

          {!data && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900">
              <div
                aria-hidden="true"
                className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-amber"
              />
              <div className="font-mono text-[11px] tracking-[0.12em] text-tx3 uppercase">
                reading this wallet&rsquo;s trades
              </div>
              <div className="font-mono text-[11px] text-tx3">
                and the token&rsquo;s price over the window it traded in
              </div>
            </div>
          )}

          {/* Purely decorative, and never in the way of the chart or a click. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {/* Only the arriving fill washes the chart. Leaving ones would
                stack their gradients and hold the screen bright. */}
            {(() => {
              const arriving = flashes.filter((f) => f.phase !== "out");
              // Only a bar carrying both signs needs separating; one that does
              // not stays centred, so the ordinary fill looks untouched.
              const split =
                arriving.some((f) => f.isBuy) && arriving.some((f) => !f.isBuy);
              return arriving.map((f) => (
                <div
                  key={f.id}
                  className={cx(
                    "replay-wash absolute inset-0",
                    WASH[f.isBuy ? "buy" : "sell"][split ? "split" : "center"],
                  )}
                />
              ));
            })()}
            {flashes.map((f) => (
              <div
                key={`t${f.id}`}
                onTransitionEnd={(e) => {
                  if (e.propertyName !== "opacity" || f.phase !== "out") return;
                  setFlashes((held) => held.filter((x) => x.id !== f.id));
                }}
                style={{
                  left: "50%",
                  /* Top of the chart: the price action is usually in the lower
                     two thirds, and a label there covered the bars it was
                     describing. Enough headroom above it for the exit to
                     travel without clipping while it is still visible. */
                  top: 34 + f.slot * 42,
                  opacity: f.phase === "shown" ? 1 : 0,
                  transform:
                    f.phase === "enter"
                      ? "translate(-50%, 14px) scale(0.94)"
                      : f.phase === "shown"
                        ? "translate(-50%, 0) scale(1)"
                        : "translate(-50%, -30px) scale(1)",
                }}
                className={cx(
                  "replay-flash absolute font-mono text-[26px] leading-none font-black tracking-[-0.01em] whitespace-nowrap",
                  f.isBuy ? "text-mint" : "text-signal",
                )}
              >
                {usdCompact(f.usd)} {f.isBuy ? "BUY" : "SELL"}
                <span className="ml-2 text-[17px] font-bold text-tx2">
                  ({capLabel(f.cap)}
                  {asCap ? " MC" : ""})
                </span>
                {f.who && (
                  <span className="ml-2 text-[15px] font-bold text-tx3">
                    {f.who.slice(0, 4)}…{f.who.slice(-4)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {failure && (
          <div className="py-10 text-center">
            <p
              className={cx(
                "font-mono text-[11px] tracking-[0.12em] uppercase",
                failure.queued ? "text-amber" : "text-signal",
              )}
            >
              {failure.queued ? "building this replay" : "could not draw this replay"}
            </p>
            <p className="mx-auto mt-2 max-w-[46ch] font-mono text-[11px] normal-case text-tx3">
              {failure.message}
              {failure.queued && " — reopen this wallet in a minute or two."}
            </p>
          </div>
        )}

        {!failure && data && total < 2 && (
          <p className="py-10 text-center font-mono text-[11px] tracking-[0.12em] text-tx3 uppercase">
            not enough history yet
          </p>
        )}

        {now && (
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6 sm:gap-4">
            {/* Bought and sold first: they are what the viewer is watching the
                wallet DO, and the PnL figures below are the consequence. Both
                are as of the current bar, not lifetime. */}
            <Figure label="Bought" value={now.boughtUsd} tone="mint" />
            <Figure label="Sold" value={now.soldUsd} tone="signal" />
            <Figure label="Realized" value={now.realized} signed />
            <Figure label="Unrealized" value={now.unrealized} signed />
            <Figure label="Holding" value={now.qty * now.price} />
            <Figure
              label="Trades"
              value={
                data
                  ? data.trades.filter(
                      (t) => barAt(data.candles, t.ts) <= at,
                    ).length
                  : 0
              }
              plain
            />
          </div>
        )}

        {tooLong !== null && clipping === null && (
          <p className="mt-4 font-mono text-[11px] text-amber">
            That clip would run {tooLong}s, past the {MAX_CLIP_SECONDS}s ceiling
            — the whole file is held in memory while it is written. Raise the
            speed or the bar width and it will fit.
          </p>
        )}

        {clipping !== null && (
          <div className="mt-4 flex items-center gap-3">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700">
              <div
                className="h-full bg-mint transition-[width] duration-150"
                style={{ width: `${Math.round(clipping * 100)}%` }}
              />
            </div>
            <span className="tnum font-mono text-[11px] text-tx3">
              {Math.round(clipping * 100)}%
            </span>
            <button
              type="button"
              onClick={() => {
                abortClip.current = true;
              }}
              className="cursor-pointer rounded-xs border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.12em] text-tx3 uppercase hover:text-tx2"
            >
              cancel
            </button>
          </div>
        )}

        {encoders && encoders !== "probing" && encoders.ext === "webm" && clipping === null && (
          <p className="mt-3 font-mono text-[10.5px] text-tx3">
            This browser records WebM, which X does not accept. Chrome and
            Safari save MP4 directly.
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              if (soundOn) void prepareSound();
              setPlaying((p) => !p);
            }}
            className="cursor-pointer rounded-xs border border-line-strong px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] text-tx2 uppercase hover:text-tx"
          >
            {playing ? "pause" : "play"}
          </button>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={locked}
              onClick={() => setSpeed(s)}
              className={cx(
                "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] uppercase",
                speed === s
                  ? "border-amber/40 bg-amber/10 text-amber"
                  : "border-line-strong text-tx3 hover:text-tx2",
              )}
            >
              {s}x
            </button>
          ))}
          <div className="flex gap-1">
            {ZOOMS.map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => {
                  if (!raw) return;
                  /**
                   * Hold the moment, not the index. A wider bar means fewer of
                   * them, so keeping `at` would jump the replay backwards in
                   * time by however much the count shrank.
                   */
                  const now = data?.candles[at]?.t ?? 0;
                  const next = coarsen(raw, z);
                  const i = next
                    ? next.candles.findIndex((c) => c.t + next.interval > now)
                    : 0;
                  setZoom(z);
                  setAt(i < 0 ? Math.max((next?.candles.length ?? 1) - 1, 0) : i);
                }}
                disabled={!raw || locked || Boolean(raw?.zoom)}
                title={
                  raw?.zoom
                    ? "not available while a zoom section is shown"
                    : `${barLabel((raw?.interval ?? 15) * z)} bars`
                }
                className={cx(
                  "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase disabled:opacity-40",
                  zoom === z
                    ? "border-amber/40 bg-amber/10 text-amber"
                    : "border-line-strong text-tx3 hover:text-tx2",
                )}
              >
                {barLabel((raw?.interval ?? 15) * z)}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              const next = !soundOn;
              setSoundOn(next);
              // Decoding needs a user gesture; this click is one.
              if (next) void prepareSound();
            }}
            title="A till for every bar that sold, and a fanfare past $20K"
            className={cx(
              "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase",
              soundOn
                ? "border-amber/40 bg-amber/10 text-amber"
                : "border-line-strong text-tx3 hover:text-tx2",
            )}
          >
            sound
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => setAutoPlay(!autoPlay)}
            title="Start over at the end instead of holding on the last bar"
            className={cx(
              "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase",
              autoPlay
                ? "border-amber/40 bg-amber/10 text-amber"
                : "border-line-strong text-tx3 hover:text-tx2",
            )}
          >
            loop
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setEffectsOn(!effectsOn);
              if (effectsOn) setFlashes([]);
            }}
            title="Flash and float each fill as it lands"
            className={cx(
              "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase",
              effectsOn
                ? "border-amber/40 bg-amber/10 text-amber"
                : "border-line-strong text-tx3 hover:text-tx2",
            )}
          >
            fx
          </button>
          <div className="flex gap-1">
            {SHAPES.map((sh) => (
              <button
                key={sh}
                type="button"
                onClick={() => {
                  setShape(sh);
                  setTooLong(null);
                }}
                disabled={locked}
                title={`${FORMATS[sh].w}x${FORMATS[sh].h}`}
                className={cx(
                  "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase disabled:cursor-default disabled:opacity-40",
                  shape === sh
                    ? "border-amber/40 bg-amber/10 text-amber"
                    : "border-line-strong text-tx3 hover:text-tx2",
                )}
              >
                {FORMATS[sh].label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void exportClip()}
            disabled={!data || total < 2 || locked || !encoders || encoders === "probing"}
            title={
              encoders === "probing"
                ? "Checking what this browser can encode"
                : encoders
                  ? `Render ${FORMATS[shape].w}x${FORMATS[shape].h} and save it as ${encoders.ext.toUpperCase()}`
                  : "This browser cannot encode video"
            }
            className="cursor-pointer rounded-xs border border-mint/40 bg-mint/10 px-2.5 py-1.5 font-mono text-[10px] tracking-[0.1em] text-mint uppercase disabled:opacity-40"
          >
            {clipping !== null ? "rendering…" : "export clip"}
          </button>
          {clipping === null && (
            <span className="tnum font-mono text-[10px] text-tx3">
              ~{clipSeconds}s
            </span>
          )}
          <div className="flex gap-1">
            {(["candles", "line"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={locked}
                onClick={() => setMode(m)}
                className={cx(
                  "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase",
                  mode === m
                    ? "border-amber/40 bg-amber/10 text-amber"
                    : "border-line-strong text-tx3 hover:text-tx2",
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <input
            type="range"
            disabled={locked}
            min={0}
            max={Math.max(total - 1, 0)}
            value={at}
            onChange={(e) => {
              setPlaying(false);
              setAt(Number(e.target.value));
            }}
            className="min-w-[140px] flex-1 accent-amber"
          />
          <span className="tnum font-mono text-[11px] text-tx3">
            {total ? at + 1 : 0}/{total} ·{" "}
            {data?.zoom
              ? `${barLabel(data.interval)} / ${barLabel(data.zoom.interval)}`
              : barLabel(data?.interval ?? 15)}
          </span>
        </div>

        {/*
          * Draw one stretch of the replay at a finer bar width.
          *
          * Shown only for a token that HAS finer bars stored — see `zoomable`
          * — so the control appears where it can be answered from the cache
          * and nowhere else. Dragging it never starts a build.
          *
          * The sliders move one fine bar per notch: the server fills the
          * part-bars at each edge, so a section really can begin and end on
          * the minute. Arrow keys nudge one notch, and `here` snaps an edge to
          * the scrubber, which is the usable way to hit an exact moment on a
          * range this long.
          */}
        {raw?.zoomable && span && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono text-[9.5px] tracking-[0.14em] text-amber uppercase">
                Zoom section
              </span>
              <span className="font-mono text-[10px] text-tx3">
                {barLabel(span.fine)} bars inside the range, {barLabel(raw.interval)}{" "}
                outside
              </span>
            </div>

            <div className="mt-2.5 flex flex-col gap-1.5">
              {(["from", "to"] as const).map((edge) => (
                <label key={edge} className="flex items-center gap-2">
                  <span className="w-8 font-mono text-[10px] text-tx3 uppercase">
                    {edge}
                  </span>
                  <input
                    type="range"
                    disabled={locked}
                    /**
                     * The SELECTABLE range, not the current selection.
                     *
                     * These were `span.from`/`span.to`, which made each handle
                     * sit exactly on its own bound — `from` was always at min
                     * and `to` always at max — so every drag snapped straight
                     * back and neither slider could be moved at all.
                     */
                    min={span.min}
                    max={span.max}
                    /**
                     * A FINE bar per notch, not a coarse one.
                     *
                     * The section used to be widened to the nearest coarse
                     * boundary, so anything smaller than a notch of two hours
                     * would have been a precision the answer did not have. The
                     * edges are filled from part-bars now, so a section can
                     * begin and end on the minute and the slider says so.
                     * Arrow keys move one notch, which is the accurate way to
                     * place an edge on a range this long.
                     */
                    step={span.fine}
                    value={span[edge]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      // From the CLAMPED span rather than the stored pick:
                      // the pick survives a change of wallet and the bounds do
                      // not, so reading it raw can start from a range the new
                      // wallet's chart never had. The handles may not cross —
                      // each stops a bar short of the other.
                      setPicked(
                        edge === "from"
                          ? { from: Math.min(v, span.to - span.fine), to: span.to }
                          : { from: span.from, to: Math.max(v, span.from + span.fine) },
                      );
                    }}
                    className="min-w-[140px] flex-1 accent-amber"
                  />
                  <span className="tnum w-[128px] shrink-0 text-right font-mono text-[10px] text-tx2">
                    {stamp(span[edge])}
                  </span>
                  <button
                    type="button"
                    disabled={locked}
                    title="here"
                    onClick={() =>
                      setPicked(
                        edge === "from"
                          ? {
                              from: Math.min(
                                Math.max(barTime(data, at), span.min),
                                span.to - span.fine,
                              ),
                              to: span.to,
                            }
                          : {
                              from: span.from,
                              to: Math.max(
                                Math.min(barTime(data, at), span.max),
                                span.from + span.fine,
                              ),
                            },
                      )
                    }
                    className="shrink-0 cursor-pointer rounded-xs border border-line-strong px-1.5 py-1 font-mono text-[9px] tracking-[0.1em] text-tx3 uppercase hover:text-tx2 disabled:cursor-default disabled:opacity-40"
                  >
                    here
                  </button>
                </label>
              ))}
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <span className="tnum font-mono text-[10px] text-tx3">
                {barLabel(span.to - span.from)} ·{" "}
                {Math.round((span.to - span.from) / span.fine).toLocaleString()}{" "}
                fine bars
                {tooManyBars ? ` · over the ${ZOOM_MAX_BARS.toLocaleString()} cap` : ""}
              </span>
              <button
                type="button"
                disabled={locked || tooManyBars || span.to <= span.from}
                onClick={() => setApplied({ from: span.from, to: span.to })}
                className="cursor-pointer rounded-xs border border-amber/40 bg-amber/10 px-3 py-1.5 font-mono text-[10px] tracking-[0.1em] text-amber uppercase hover:bg-amber/20 disabled:cursor-default disabled:opacity-40"
              >
                apply
              </button>
              <button
                type="button"
                disabled={locked || !applied}
                onClick={() => {
                  setApplied(null);
                  setZoom(1);
                }}
                className="cursor-pointer rounded-xs border border-line-strong px-3 py-1.5 font-mono text-[10px] tracking-[0.1em] text-tx3 uppercase hover:text-tx2 disabled:cursor-default disabled:opacity-40"
              >
                clear
              </button>
            </div>
          </div>
        )}

        {now && (related || hasGraph === false) && (
          <div className="mt-4 border-t border-line pt-4">
            {hasGraph === false && (
              /**
               * The honest empty state. Linked wallets are worked out one
               * wallet at a time, so "none here" means nobody looked — not that
               * this wallet trades alone.
               */
              <p className="mt-2 font-mono text-[11px] text-tx3">
                Linked wallets have not been worked out for this one.
              </p>
            )}
            {related?.error && !related.linked && hasGraph !== false && (
              <p className="mt-2 font-mono text-[11px] text-signal">
                {related.error}
              </p>
            )}

            {related && !related.error && (
              <>
                <div className="flex flex-wrap items-baseline gap-2">
                  <Label>Linked wallets</Label>
                  <span
                    title={
                      "Wallets this one moved tokens or SOL with, judged material " +
                      "and not an exchange, a distributor or a temporary account. " +
                      "Tick one to replay both as a single position — transfers " +
                      "between them then cancel, the way they should. The link is " +
                      "inferred from funding and timing; it is not proof of common " +
                      "ownership."
                    }
                    className="cursor-help rounded-xs border border-line-strong px-1.5 py-0.5 font-mono text-[9px] tracking-[0.1em] text-tx3 uppercase"
                  >
                    what is this
                  </span>
                  <span className="font-mono text-[10.5px] text-tx3">
                    tick to fold into the replay
                  </span>
                </div>

                {related.linked.length === 0 && (
                  <p className="mt-2 font-mono text-[11px] text-tx3">
                    Nothing material — {related.dismissed.length} counterpart
                    {related.dismissed.length === 1 ? "y" : "ies"} looked at and
                    ruled out.
                  </p>
                )}

                {related.linked.map((r) => {
                  const on = folded.has(r.wallet);
                  return (
                    <label
                      key={r.wallet}
                      className="mt-2 flex cursor-pointer flex-wrap items-start gap-x-3 gap-y-1 rounded-xs border border-line px-3 py-2 hover:bg-ink-800"
                    >
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={on}
                        onChange={() =>
                          setFolded((held) => {
                            const next = new Set(held);
                            if (on) next.delete(r.wallet);
                            else next.add(r.wallet);
                            return next;
                          })
                        }
                        className="mt-0.5 accent-amber"
                      />
                      <span className="min-w-0 flex-1 basis-[60%]">
                        <span className="flex flex-wrap items-baseline gap-2">
                          {r.name && (
                            <span className="font-mono text-[12px] font-medium text-tx">
                              {r.name}
                            </span>
                          )}
                          <span className="truncate font-mono text-[10.5px] text-tx3 select-all">
                            {r.wallet}
                          </span>
                          <span className="tnum font-mono text-[10.5px] text-tx3">
                            {r.trades} trades
                          </span>
                        </span>
                        <span className="mt-0.5 block font-mono text-[10.5px] text-tx3">
                          {r.why.join(" · ")}
                        </span>
                      </span>
                      <span
                        className={cx(
                          "tnum shrink-0 font-mono text-[13px] font-bold",
                          r.total >= 0 ? "text-mint" : "text-signal",
                        )}
                      >
                        {r.total >= 0 ? "+" : "−"}
                        {usdCompact(Math.abs(r.total))}
                      </span>
                    </label>
                  );
                })}

                {folded.size > 0 && (
                  <p className="mt-3 rounded-xs border border-amber/30 bg-amber/5 px-3 py-2 font-mono text-[10.5px] tracking-[0.1em] text-amber uppercase">
                    {alongside.length === folded.size
                      ? `replaying as one position — the chart, the markers and the PnL above cover all ${folded.size + 1} wallets`
                      : "reloading the replay with these wallets…"}
                  </p>
                )}

              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  signed,
  plain,
  tone: forced,
}: {
  label: string;
  value: number;
  signed?: boolean;
  plain?: boolean;
  /** Fixed colour for figures whose sign carries no meaning. */
  tone?: "mint" | "signal";
}) {
  const tone = forced
    ? forced === "mint"
      ? "text-mint"
      : "text-signal"
    : signed
      ? value >= 0
        ? "text-mint"
        : "text-signal"
      : "text-tx";
  return (
    <div>
      <div className="font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
        {label}
      </div>
      <div className={cx("tnum mt-1 font-mono text-[15px] font-bold sm:text-[17px]", tone)}>
        {plain
          ? value
          : `${signed && value >= 0 ? "+" : signed ? "−" : ""}${usdCompact(Math.abs(value))}`}
      </div>
    </div>
  );
}
