/**
 * Simple, Audacity-style edits of a recording (pure: no DOM, no Web Audio).
 *
 * Every edit works on the trimmed region (Start..End, what the part plays)
 * and returns new channel arrays; the source audio is never changed (it may
 * be the buffer the sampler is playing right now). The app stores the result
 * as a new version of the recording (see sampleVersions.ts).
 *
 * - Normalize: the region's loudest peak reaches -1 dBFS.
 * - Reverse: the region plays backwards (the rest stays where it is).
 * - Crop: only the region is kept; it then plays from start to end.
 * - Fade in / Fade out: a linear fade over the chosen length, at the region's
 *   start or end (silence before a fade-in start stays silent).
 * - Gain: the region louder or quieter by up to 12 dB.
 *
 * Results are clipped to full scale (-1..1), as the stored WAV is, so the
 * version that plays right away sounds exactly like the one kept in the
 * project (`peak` still tells when a gain change went over and clipped).
 */

export type SampleEditKind = 'normalize' | 'reverse' | 'crop' | 'fadeIn' | 'fadeOut' | 'gain';

/** Fade lengths offered: seconds, or the whole region. */
export type FadeLength = 'short' | 'half' | 'two' | 'region';

export const FADE_LENGTHS: readonly { value: FadeLength; label: string; seconds: number | null }[] = [
  { value: 'short', label: 'Short (50 ms)', seconds: 0.05 },
  { value: 'half', label: 'Half a second', seconds: 0.5 },
  { value: 'two', label: '2 seconds', seconds: 2 },
  { value: 'region', label: 'Whole region', seconds: null },
];

export type SampleEdit =
  | { kind: 'normalize' }
  | { kind: 'reverse' }
  | { kind: 'crop' }
  | { kind: 'fadeIn'; length: FadeLength }
  | { kind: 'fadeOut'; length: FadeLength }
  | { kind: 'gain'; db: number };

/** Normalize target: -1 dBFS, just under full scale. */
export const NORMALIZE_PEAK_DB = -1;
export const NORMALIZE_PEAK = 10 ** (NORMALIZE_PEAK_DB / 20);
export const GAIN_EDIT_LIMIT_DB = 12;
/** A region quieter than this (about -100 dBFS) counts as silence. */
const SILENCE = 1e-5;

/** Undo label (and the words used in messages) per edit. */
export const EDIT_LABEL: Record<SampleEditKind, string> = {
  normalize: 'Normalize recording',
  reverse: 'Reverse recording',
  crop: 'Crop recording',
  fadeIn: 'Fade in recording',
  fadeOut: 'Fade out recording',
  gain: 'Change recording gain',
};

/** The trim region as whole frames [a, b) of a recording `length` frames long (at least one frame). */
export function regionFrames(length: number, start: number, end: number): [number, number] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  let a = Math.round(clamp01(lo) * length);
  let b = Math.round(clamp01(hi) * length);
  a = Math.min(Math.max(0, a), Math.max(0, length - 1));
  b = Math.max(a + 1, Math.min(length, b));
  return [a, b];
}

/** Highest absolute sample value in frames [a, b) over all channels. */
export function peakOf(channels: readonly Float32Array[], a = 0, b = Infinity): number {
  let peak = 0;
  for (const ch of channels) {
    const end = Math.min(ch.length, b);
    for (let i = Math.max(0, a); i < end; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

const copy = (channels: readonly Float32Array[]) => channels.map((c) => Float32Array.from(c));

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Frames a fade of `length` lasts in a region of `regionFrames` frames. */
export function fadeFrames(length: FadeLength, sampleRate: number, regionLength: number): number {
  const seconds = FADE_LENGTHS.find((f) => f.value === length)?.seconds ?? null;
  const n = seconds === null ? regionLength : Math.round(seconds * sampleRate);
  return Math.max(1, Math.min(regionLength, n));
}

export interface EditOutcome {
  /** The new version, clipped to -1..1 (what a stored WAV holds). */
  channels: Float32Array[];
  /** Start and End for the new version (a crop plays all of it); null keeps the trim. */
  region: { start: number; end: number } | null;
  /** Peak of the edited region (linear) before clipping, to tell when a gain change clips. */
  peak: number;
}

/** Clip every sample to full scale in place, as the WAV encoder does (a broken value becomes silence). */
function clipToFullScale(channels: readonly Float32Array[]): void {
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      if (!Number.isFinite(v)) ch[i] = 0;
      else if (v > 1) ch[i] = 1;
      else if (v < -1) ch[i] = -1;
    }
  }
}

export type EditResult = ({ ok: true } & EditOutcome) | { ok: false; message: string };

/**
 * Apply one edit to the region [start, end] (fractions of the recording).
 * Refuses edits that would change nothing (a silent region to normalize, a
 * crop of the whole recording, a 0 dB gain), with the reason in words.
 * The result is clipped to full scale, exactly as it will be stored.
 */
export function applySampleEdit(channels: readonly Float32Array[], sampleRate: number, start: number, end: number, edit: SampleEdit): EditResult {
  const res = editChannels(channels, sampleRate, start, end, edit);
  // New arrays every time: the source (maybe the buffer playing now) is never touched.
  if (res.ok) clipToFullScale(res.channels);
  return res;
}

function editChannels(channels: readonly Float32Array[], sampleRate: number, start: number, end: number, edit: SampleEdit): EditResult {
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  if (length === 0 || channels.length === 0) return { ok: false, message: 'The recording is empty.' };
  const [a, b] = regionFrames(length, start, end);
  const n = b - a;
  switch (edit.kind) {
    case 'normalize': {
      const peak = peakOf(channels, a, b);
      if (peak < SILENCE) return { ok: false, message: 'The region is silent, so there is nothing to normalize.' };
      const g = NORMALIZE_PEAK / peak;
      if (Math.abs(20 * Math.log10(g)) < 0.01) return { ok: false, message: 'The region already peaks at -1 dB: normalizing changes nothing.' };
      const out = copy(channels);
      for (const ch of out) for (let i = a; i < Math.min(b, ch.length); i++) ch[i] *= g;
      return { ok: true, channels: out, region: null, peak: peakOf(out, a, b) };
    }
    case 'gain': {
      const db = Math.max(-GAIN_EDIT_LIMIT_DB, Math.min(GAIN_EDIT_LIMIT_DB, Number.isFinite(edit.db) ? edit.db : 0));
      if (Math.abs(db) < 0.05) return { ok: false, message: 'A gain of 0 dB changes nothing. Choose louder (+) or quieter (−).' };
      const g = dbToGain(db);
      const out = copy(channels);
      for (const ch of out) for (let i = a; i < Math.min(b, ch.length); i++) ch[i] *= g;
      return { ok: true, channels: out, region: null, peak: peakOf(out, a, b) };
    }
    case 'reverse': {
      const out = copy(channels);
      for (const ch of out) {
        const hi = Math.min(b, ch.length);
        for (let i = a, j = hi - 1; i < j; i++, j--) {
          const t = ch[i];
          ch[i] = ch[j];
          ch[j] = t;
        }
      }
      return { ok: true, channels: out, region: null, peak: peakOf(out, a, b) };
    }
    case 'crop': {
      if (a === 0 && b === length) return { ok: false, message: 'The region already covers the whole recording. Move Start or End first, then crop.' };
      const out = channels.map((c) => {
        const x = new Float32Array(n);
        x.set(c.subarray(Math.min(a, c.length), Math.min(b, c.length)));
        return x;
      });
      return { ok: true, channels: out, region: { start: 0, end: 1 }, peak: peakOf(out) };
    }
    case 'fadeIn':
    case 'fadeOut': {
      const f = fadeFrames(edit.length, sampleRate, n);
      const out = copy(channels);
      for (const ch of out) {
        for (let k = 0; k < f; k++) {
          // Linear: 0 at the region edge, 1 where the fade ends.
          const g = f === 1 ? 0 : k / (f - 1);
          const i = edit.kind === 'fadeIn' ? a + k : b - 1 - k;
          if (i >= 0 && i < ch.length) ch[i] *= g;
        }
      }
      return { ok: true, channels: out, region: null, peak: peakOf(out, a, b) };
    }
    default:
      return { ok: false, message: 'Unknown edit.' };
  }
}

/** What an edit did, in one plain sentence for the status line. */
export function editSummary(edit: SampleEdit, outcome: EditOutcome): string {
  switch (edit.kind) {
    case 'normalize':
      return 'Normalized: the loudest peak of the region is now at -1 dB.';
    case 'gain': {
      const clipped = outcome.peak > 1.0001;
      const words = `Made the region ${Math.abs(edit.db).toFixed(1).replace(/\.0$/, '')} dB ${edit.db > 0 ? 'louder' : 'quieter'}.`;
      return clipped ? `${words} Its loudest peaks went over full scale and were clipped; Undo, then try Normalize.` : words;
    }
    case 'reverse':
      return 'Reversed: the region now plays backwards.';
    case 'crop':
      return 'Cropped: only the region is kept, and it plays from start to end.';
    case 'fadeIn':
      return 'Faded in: the start of the region now rises from silence.';
    case 'fadeOut':
      return 'Faded out: the end of the region now falls to silence.';
    default:
      return 'Edited.';
  }
}

/** "Vocal (edit 2)": a name for a new version, numbered after the versions already in the project. */
export function versionName(name: string, existing: readonly string[]): string {
  const root = name.replace(/\s*\(edit(?: \d+)?\)\s*$/i, '').trim() || 'Recording';
  let n = 1;
  const pattern = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(edit(?: (\\d+))?\\)$`, 'i');
  for (const e of existing) {
    const m = pattern.exec(e);
    if (m) n = Math.max(n, (m[1] ? Number(m[1]) : 1) + 1);
  }
  return `${root.slice(0, 68)} (edit ${n})`;
}
