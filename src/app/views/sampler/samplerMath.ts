/**
 * Pure helpers for the sampler editor: trim limits, the edge-fade shape the
 * engine plays, tempo/bars arithmetic and display formatting.
 *
 * The fade and region rules mirror src/audio/instruments/sampler.ts so the
 * waveform shows what is actually heard.
 */
import { MIN_REGION_SECONDS, samplerRate } from '../../../audio/instruments/sampler';
import { SAMPLER_PARAMS, specById } from '../../../project/params';

const OBPM = specById(SAMPLER_PARAMS, 'originalBpm')!;
/** Original BPM range accepted by the sampler (registry limits). */
export const ORIGINAL_BPM_MIN = OBPM.min;
export const ORIGINAL_BPM_MAX = OBPM.max;

/** Bars helper range and resolution (quarter-bar steps = one beat in 4/4). */
export const BARS_MIN = 0.25;
export const BARS_MAX = 64;
export const BARS_STEP = 0.25;

/** One-shot fade-out floor used by the engine (seconds of output). */
const MIN_FADE_OUT = 0.001;
/** The engine's edge envelope reaches zero this long before the region end (buffer seconds). */
const EDGE_ZERO_SECONDS = 2 / 8000;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Smallest start→end distance as a fraction of the file (the engine's 5 ms minimum region). */
export function minTrimGap(duration: number): number {
  if (!(duration > 0)) return 0.001;
  return clamp(MIN_REGION_SECONDS / duration, 0.001, 0.5);
}

/**
 * Clamp a proposed trim position so the region keeps end > start by at
 * least the minimum gap. `other` is the opposite handle's position.
 */
export function clampTrim(which: 'start' | 'end', value: number, other: number, duration: number): number {
  const gap = minTrimGap(duration);
  const v = which === 'start' ? clamp(value, 0, Math.max(0, other - gap)) : clamp(value, Math.min(1, other + gap), 1);
  return Math.round(v * 1e6) / 1e6;
}

export interface SamplerPlayback {
  pitch: number;
  fine: number;
  rootNote: number;
  sync: number;
  originalBpm: number;
}

/** Playback rate of the root note (speed and pitch together), with Tempo Sync at `bpm`. */
export function rootRate(v: SamplerPlayback, bpm: number): number {
  return samplerRate({ pitch: v.pitch, fine: v.fine, rootNote: v.rootNote, sync: v.sync === 1, originalBpm: v.originalBpm }, v.rootNote, bpm);
}

/** Rate multiplier from Tempo Sync alone. */
export function syncRate(originalBpm: number, bpm: number): number {
  return clamp(bpm, ORIGINAL_BPM_MIN, ORIGINAL_BPM_MAX) / originalBpm;
}

export function rateToSemitones(rate: number): number {
  return rate > 0 ? 12 * Math.log2(rate) : 0;
}

export interface EdgeFades {
  /** Fade-in length in buffer seconds from the region start. */
  fadeIn: number;
  /** Fade-out length in buffer seconds before the region end (0 in Loop mode). */
  fadeOut: number;
  /** Buffer seconds from the region start where the one-shot envelope reaches zero. */
  zeroAt: number;
}

/**
 * The edge fades in buffer time, as the engine plays them at `rate`:
 * one-shot fades are output seconds × rate, the fade-out has a 1 ms floor,
 * and overlapping fades are scaled to fit the region. In Loop mode the fade
 * in applies at the note start only and Fade Out acts as the release.
 */
export function edgeFades(regionLen: number, fadeInMs: number, fadeOutMs: number, rate: number, loop: boolean): EdgeFades {
  const len = Math.max(0, regionLen);
  const r = rate > 0 && Number.isFinite(rate) ? rate : 1;
  if (loop) return { fadeIn: Math.min(len, Math.max(0, fadeInMs / 1000) * r), fadeOut: 0, zeroAt: len };
  const zeroAt = Math.max(0, len - Math.min(EDGE_ZERO_SECONDS, len / 4));
  let fi = Math.max(0, fadeInMs / 1000) * r;
  let fo = Math.max(MIN_FADE_OUT, fadeOutMs / 1000) * r;
  if (fi + fo > zeroAt && fi + fo > 0) {
    const k = zeroAt / (fi + fo);
    fi *= k;
    fo *= k;
  }
  return { fadeIn: fi, fadeOut: fo, zeroAt };
}

/** Edge gain (0..1) at `t` buffer seconds after the region start. */
export function edgeGain(t: number, fades: EdgeFades): number {
  if (t < 0 || t > fades.zeroAt) return 0;
  let g = 1;
  if (fades.fadeIn > 0) g = Math.min(g, t / fades.fadeIn);
  if (fades.fadeOut > 0) g = Math.min(g, (fades.zeroAt - t) / fades.fadeOut);
  return clamp(g, 0, 1);
}

/** Original BPM that makes a region of `regionSeconds` exactly `bars` bars of 4/4. */
export function barsToBpm(bars: number, regionSeconds: number): number {
  return regionSeconds > 0 ? (bars * 4 * 60) / regionSeconds : NaN;
}

export function bpmToBars(bpm: number, regionSeconds: number): number {
  return (regionSeconds * bpm) / 240;
}

/** Bars the helper suggests for a region at the current Original BPM (quarter-bar steps). */
export function suggestedBars(regionSeconds: number, originalBpm: number): number {
  const raw = bpmToBars(originalBpm, regionSeconds);
  if (!Number.isFinite(raw)) return 1;
  return clamp(Math.round(raw / BARS_STEP) * BARS_STEP, BARS_MIN, BARS_MAX);
}

/** Bar counts (quarter-bar steps) whose Original BPM lands inside the accepted range, or null. */
export function barsRange(regionSeconds: number): { min: number; max: number } | null {
  if (!(regionSeconds > 0)) return null;
  const lo = Math.ceil(bpmToBars(ORIGINAL_BPM_MIN, regionSeconds) / BARS_STEP - 1e-9) * BARS_STEP;
  const hi = Math.floor(bpmToBars(ORIGINAL_BPM_MAX, regionSeconds) / BARS_STEP + 1e-9) * BARS_STEP;
  const min = Math.max(BARS_MIN, lo);
  const max = Math.min(BARS_MAX, hi);
  return min <= max ? { min, max } : null;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Seconds with precision that suits the file length: "0.125 s", "12.40 s". */
export function formatTime(seconds: number, fileDuration: number): string {
  const s = Math.max(0, seconds);
  return `${s.toFixed(fileDuration < 10 ? 3 : 2)} s`;
}

export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return '0 s';
  if (seconds < 10) return `${seconds.toFixed(2)} s`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.round(seconds - m * 60)).padStart(2, '0')}`;
}

export function formatSampleRate(hz: number): string {
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)} kHz`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatBpm(bpm: number): string {
  const r = Math.round(bpm * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} BPM`;
}

export function formatBars(bars: number): string {
  const v = Number(bars.toFixed(2));
  return `${v} ${v === 1 ? 'bar' : 'bars'}`;
}

export function formatSemitones(semis: number): string {
  const r = Math.round(semis * 10) / 10;
  if (Math.abs(r) < 0.05) return '0 st';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(Number.isInteger(r) ? 0 : 1)} st`;
}

/** File type label from a MIME type. */
export function fileKind(mime: string): string {
  return mime.includes('mpeg') || mime.includes('mp3') ? 'MP3' : 'WAV';
}
