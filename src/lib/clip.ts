/**
 * Turning a replay into a file people can post.
 *
 * The old exporter recorded whatever size the chart happened to be — which is
 * the viewport width times the display's pixel ratio, so the same wallet gave a
 * different file on every machine, at an aspect ratio no platform wants. This
 * chooses the size first and renders to fit it.
 *
 * Encoding is WebCodecs rather than MediaRecorder, and the reason is timing.
 * MediaRecorder stamps frames by the wall clock, so a machine that cannot
 * composite 1080p in 33ms does not drop frames — it produces a slower, jerkier
 * video. Here every frame is handed an explicit timestamp, so the file is the
 * same length and the same smoothness whatever the machine managed.
 */

import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  type AudioCodec,
  type VideoCodec,
} from "mediabunny";

export type Shape = "landscape" | "portrait" | "square";

/** In picker order. */
export const SHAPES = ["landscape", "portrait", "square"] as const;

export const FORMATS: Record<Shape, { w: number; h: number; label: string }> = {
  landscape: { w: 1920, h: 1080, label: "16:9" },
  portrait: { w: 1080, h: 1920, label: "9:16" },
  square: { w: 1080, h: 1080, label: "1:1" },
};

export const FPS = 30;

/** The end card, in seconds. */
export const OUTRO_SECONDS = 3;

/**
 * How long a clip may run.
 *
 * Not a preference — a limit. The whole file is muxed in memory, because
 * `fastStart` has to move the index to the front and cannot do that while
 * streaming, so the ceiling is roughly bitrate times duration sitting in one
 * ArrayBuffer. Ninety seconds at 12 Mbps is about 135MB, which a browser will
 * hold; five minutes would not be sensible. It is also inside what X accepts.
 */
export const MAX_CLIP_SECONDS = 90;

/**
 * The width the chart was designed against — today's desktop replay.
 *
 * Every chart dimension scales from this, so an export is the on-screen chart
 * enlarged rather than a differently-proportioned one: the same number of bars
 * on screen, the same relative type size.
 */
export const DESIGN_W = 992;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  shape: Shape;
  w: number;
  h: number;
  pad: number;
  /**
   * Multiplier on every type size, which are authored against the 1920-wide
   * frame. The tall formats are scaled UP relative to their width on purpose —
   * a 9:16 clip is watched full-screen on a phone, where type that is correct
   * in proportion to the frame reads as too small.
   */
  type: number;
  header: Rect;
  chart: Rect;
  stats: Rect;
  /** Figures per row in the stats band. */
  cols: number;
  /**
   * Type scale for the stats band alone.
   *
   * Separate from `type` because the two bands want opposite things in a tall
   * frame: the header is one row and scales down with the width, while the six
   * figures have a whole band to fill and reading them is the point.
   */
  statType: number;
  /**
   * Type scale for the floating fill labels, over the chart's own scale.
   *
   * Same reasoning as `statType`. Sized purely off the chart these came out
   * the same fraction of the frame in every format, which is too small in a
   * tall one — a 9:16 clip is watched full-screen on a phone, where the fill
   * that just landed should be as loud as the number in the corner.
   */
  flashType: number;
  /**
   * Which edge of the chart the fill labels sit against.
   *
   * Top for the wide formats, where the price action tends to sit low and a
   * label above it covers nothing. A tall frame is the other way round: the
   * chart is deep enough that the action fills it, and the bottom edge is also
   * where a phone viewer is already looking.
   */
  flashAt: "top" | "bottom";
  /**
   * What the price scale keeps empty, as a fraction of the chart's height.
   *
   * lightweight-charts defaults to 20% above the candles and 10% below, which
   * is most of a second of staring at nothing on a 1250px-tall frame. Kept
   * only on the side the fill labels occupy, and cut to almost nothing on the
   * other — so the headroom that remains is headroom something uses.
   */
  scaleMargins: { top: number; bottom: number };
}

export function layoutFor(shape: Shape): Layout {
  const { w, h } = FORMATS[shape];
  if (shape === "portrait") {
    return {
      shape, w, h, pad: 56, type: 0.78, cols: 2, statType: 1.1, flashType: 1.6,
      flashAt: "bottom", scaleMargins: { top: 0.05, bottom: 0.17 },
      // Compact, because the header is one row now rather than a stack: the
      // wallet on the left and the number on the right, sitting just above the
      // chart with the padding above them.
      header: { x: 0, y: 0, w, h: 210 },
      // Everything the old proportions were wasting goes to the chart. Six
      // figures never needed 700px, and the gaps between them read as the
      // layout having lost its nerve.
      chart: { x: 0, y: 210, w, h: 1080 },
      stats: { x: 0, y: 1290, w, h: 630 },
    };
  }
  if (shape === "square") {
    return {
      shape, w, h, pad: 48, type: 0.72, cols: 3, statType: 0.8, flashType: 1.2,
      flashAt: "top", scaleMargins: { top: 0.2, bottom: 0.06 },
      header: { x: 0, y: 0, w, h: 190 },
      chart: { x: 0, y: 190, w, h: 610 },
      stats: { x: 0, y: 800, w, h: 280 },
    };
  }
  return {
    shape, w, h, pad: 56, type: 1, cols: 6, statType: 1, flashType: 1,
    flashAt: "top", scaleMargins: { top: 0.22, bottom: 0.06 },
    header: { x: 0, y: 0, w, h: 200 },
    chart: { x: 0, y: 200, w, h: 700 },
    stats: { x: 0, y: 900, w, h: 180 },
  };
}

/**
 * Bits per second for a frame of this size.
 *
 * Derived rather than fixed: the old exporter asked for 8 Mbps whatever it was
 * encoding, which is generous for a 992x340 chart and thin for 1080p.
 */
export function bitrateFor(w: number, h: number, fps = FPS): number {
  return Math.round(w * h * fps * 0.19);
}

export interface Encoders {
  ext: "mp4" | "webm";
  mime: string;
  video: VideoCodec;
  audio: AudioCodec | null;
}

/**
 * What this browser can actually encode.
 *
 * MP4 first because X does not accept WebM, and an export that cannot be posted
 * is not an export. Firefox has `VideoEncoder` but no AAC, so it lands on
 * WebM/VP9 and the caller says so rather than leaving anyone wondering why the
 * upload was refused.
 *
 * Async, unlike the `MediaRecorder.isTypeSupported` check it replaces, so the
 * caller has to hold a "still asking" state rather than a plain boolean.
 */
export async function negotiate(): Promise<Encoders | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const size = { width: 1920, height: 1080 };
  try {
    const avc = await getFirstEncodableVideoCodec(["avc"], size);
    if (avc) {
      const aac = await getFirstEncodableAudioCodec(["aac"], {
        numberOfChannels: 2,
        sampleRate: 48_000,
      });
      return {
        ext: "mp4",
        mime: new Mp4OutputFormat().mimeType,
        video: avc,
        audio: aac,
      };
    }
    const vp9 = await getFirstEncodableVideoCodec(["vp9", "vp8"], size);
    if (!vp9) return null;
    const opus = await getFirstEncodableAudioCodec(["opus"], {
      numberOfChannels: 2,
      sampleRate: 48_000,
    });
    return {
      ext: "webm",
      mime: new WebMOutputFormat().mimeType,
      video: vp9,
      audio: opus,
    };
  } catch {
    // A browser that throws while being asked cannot encode either.
    return null;
  }
}

export interface EncodeOptions {
  shape: Shape;
  encoders: Encoders;
  frames: number;
  fps: number;
  /** The whole soundtrack, rendered ahead of time. Null for a silent clip. */
  audio: AudioBuffer | null;
  /** Paint frame `i`. Runs to completion before the frame is encoded. */
  draw: (ctx: CanvasRenderingContext2D, i: number) => void;
  /** Stop and keep nothing. */
  cancelled: () => boolean;
  onProgress: (i: number) => void;
}

export async function encode(
  o: EncodeOptions,
): Promise<{ blob: Blob; ext: string } | null> {
  const { w, h } = FORMATS[o.shape];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;

  const format =
    o.encoders.ext === "mp4"
      ? /**
         * The index in front of the data, so the clip starts playing before it
         * has finished downloading. Without it X and iOS will hold a preview
         * blank until the whole file is in.
         */
        new Mp4OutputFormat({ fastStart: "in-memory" })
      : new WebMOutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });

  const video = new CanvasSource(canvas, {
    codec: o.encoders.video,
    quality: new Quality(bitrateFor(w, h, o.fps)),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(video, { frameRate: o.fps });

  /**
   * No track at all rather than a silent one: a muxed-but-empty AAC stream
   * costs bytes and gives some players a reason to stall on open.
   */
  const audio =
    o.audio && o.encoders.audio
      ? new AudioBufferSource({
          codec: o.encoders.audio,
          quality: new Quality(128_000),
        })
      : null;
  if (audio) output.addAudioTrack(audio);

  await output.start();

  try {
    if (audio && o.audio) {
      await audio.add(o.audio);
      audio.close();
    }

    const dt = 1 / o.fps;
    for (let i = 0; i < o.frames; i += 1) {
      if (o.cancelled()) {
        await output.cancel();
        return null;
      }
      o.draw(ctx, i);
      // Awaited so the encoder's backpressure is respected rather than
      // queueing every frame of a 90-second clip at once.
      await video.add(i * dt, dt);
      o.onProgress(i);
    }
    video.close();
  } catch (err) {
    // Leaves nothing half-written; the caller decides what to say.
    if (output.state === "started") await output.cancel();
    throw err;
  }

  await output.finalize();
  const buffer = target.buffer;
  if (!buffer) return null;
  return { blob: new Blob([buffer], { type: format.mimeType }), ext: o.encoders.ext };
}
