/**
 * What the Mix view reads from the engine, shared by every meter on screen:
 * one engine read per animation frame (strip meters, master meters, the
 * loudness readouts and the Glue indicator all take it from here), plus
 * formatting for levels and loudness.
 *
 * Meters and readouts update the DOM from requestAnimationFrame loops; nothing
 * here causes React renders.
 */
import type { MeterFrame } from '../../../audio/contracts';
import { session } from '../../instance';

const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
let frameAt = -Infinity;
let frameLive = false;

/** The current meter frame (read from the engine at most once per ~12 ms). */
export function readMixFrame(): MeterFrame {
  const now = performance.now();
  if (now - frameAt > 12) {
    frameAt = now;
    frameLive = session.readMeters(frame);
    if (!frameLive) {
      frame.masterPeakL = frame.masterPeakR = frame.masterRms = frame.limiterReductionDb = 0;
      frame.tracks.length = 0;
      frame.loudness = undefined;
      frame.glueReductionDb = undefined;
    }
  }
  return frame;
}

/** True when the last read came from a running engine (audio has started). */
export function mixFrameLive(): boolean {
  return frameLive;
}

/** A part's post-fader peak (linear), 0 when it has no meter. */
export function trackPeak(trackId: string): number {
  const tracks = readMixFrame().tracks;
  for (const t of tracks) if (t.trackId === trackId) return t.peak;
  return 0;
}

/** Forget the cached frame (tests that swap the meter source). */
export function resetMixFrame(): void {
  frameAt = -Infinity;
}

const MINUS = '−';

/**
 * "−14.2 LUFS" style number with a real minus sign ("−14.2" without a unit);
 * "—" when there is nothing to show. `signed` adds "+" to positive values.
 */
export function formatLoudness(v: number | undefined, unit = 'LUFS', signed = false): string {
  if (v === undefined || !Number.isFinite(v)) return '\u2014';
  const r = Math.round(v * 10) / 10;
  const text = `${r < 0 ? MINUS : r > 0 && signed ? '+' : ''}${Math.abs(r).toFixed(1)}`;
  return unit ? `${text} ${unit}` : text;
}

/** Signed dB with one decimal: "+2.0 dB", "−6.5 dB", "0.0 dB". */
export function formatDb(v: number): string {
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${Math.abs(r).toFixed(1)} dB`;
}

/** Level fader text: the bottom of the fader is silence. */
export function formatLevel(db: number, minDb: number): string {
  return db <= minDb ? `Silent (${formatDb(db)})` : formatDb(db);
}
