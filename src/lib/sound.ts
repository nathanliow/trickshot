/**
 * Sound for the replay.
 *
 * Through Web Audio rather than `<audio>` elements for two reasons. Several
 * sells can land in the same second and each needs its own voice, which one
 * element cannot give — it would cut itself off. And an export needs the same
 * cues rendered offline onto its own timeline, which only an audio graph can
 * do.
 *
 * Everything here fails quietly. A browser that refuses to decode a clip, or
 * to start audio at all, should cost the sound and nothing else.
 */

export type Cue = "kaching" | "bandos";

const FILES: Record<Cue, string> = {
  kaching: "/sfx/kaching.mp3",
  /** QuickTime container, audio only — decoded by the platform, not the tag. */
  bandos: "/sfx/bandos.mov",
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** Decoded for the live context, which is the only thing `play` needs. */
const buffers = new Map<Cue, AudioBuffer>();
/**
 * The undecoded clips, kept so any context can decode its own copies.
 *
 * An export renders its soundtrack in an OfflineAudioContext fixed at 48kHz,
 * while these were decoded at whatever rate the hardware runs at, so it cannot
 * borrow the live buffers. It cannot borrow the bytes either without a copy:
 * `decodeAudioData` DETACHES the ArrayBuffer it is handed, so passing the
 * cached one straight in would empty the cache and make the second export of a
 * session silent.
 */
const bytes = new Map<Cue, ArrayBuffer>();
let loading: Promise<void> | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Decode both clips once.
 *
 * Called on a user gesture, because a browser will not start an AudioContext
 * without one and there is no point decoding into a context that cannot run.
 */
export function prepare(): Promise<void> {
  const audio = context();
  if (!audio) return Promise.resolve();
  if (audio.state === "suspended") void audio.resume();
  loading ??= Promise.all(
    (Object.keys(FILES) as Cue[]).map(async (cue) => {
      try {
        const res = await fetch(FILES[cue]);
        if (!res.ok) return;
        const raw = await res.arrayBuffer();
        bytes.set(cue, raw);
        buffers.set(cue, await audio.decodeAudioData(raw.slice(0)));
      } catch {
        // A clip that will not decode simply never plays.
      }
    }),
  ).then(() => undefined);
  return loading;
}

/** Fire a cue. Overlapping calls each get their own voice. */
export function play(cue: Cue): void {
  const audio = ctx;
  const buffer = buffers.get(cue);
  if (!audio || !master || !buffer) return;
  if (audio.state === "suspended") void audio.resume();
  try {
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    source.start();
  } catch {
    // Nothing to do; the replay carries on silently.
  }
}

/** One cue at one moment in a clip. */
export interface Cued {
  t: number;
  cue: Cue;
}

/**
 * Render a clip's whole soundtrack ahead of time.
 *
 * The exported video no longer runs on the wall clock, so recording the page's
 * live output would be recording a different timeline — the cues would land
 * wherever the export happened to be when they fired. Scheduling them into an
 * offline context puts every cue on the frame it belongs to, however long the
 * export actually takes.
 *
 * Returns null when there is nothing to play, so the caller can leave the audio
 * track out of the file entirely rather than muxing silence.
 */
export async function renderCues(
  cues: Cued[],
  seconds: number,
): Promise<AudioBuffer | null> {
  if (cues.length === 0 || seconds <= 0) return null;
  if (typeof OfflineAudioContext === "undefined") return null;
  await prepare();
  if (bytes.size === 0) return null;

  try {
    const rate = 48_000;
    // The length is a frame COUNT, and a duration in seconds rarely lands on one.
    const offline = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
    const gain = offline.createGain();
    gain.gain.value = 0.6; // The same master level the page plays at.
    gain.connect(offline.destination);

    const decoded = new Map<Cue, AudioBuffer>();
    for (const [cue, raw] of bytes) {
      try {
        decoded.set(cue, await offline.decodeAudioData(raw.slice(0)));
      } catch {
        // A clip this context will not decode simply never plays.
      }
    }
    if (decoded.size === 0) return null;

    for (const { t, cue } of cues) {
      const buffer = decoded.get(cue);
      if (!buffer || t < 0 || t >= seconds) continue;
      const source = offline.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(t);
    }

    return await offline.startRendering();
  } catch {
    // A clip with no sound is worth more than a failed export.
    return null;
  }
}
