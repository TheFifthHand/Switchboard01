/**
 * What the Mix view reads from the engine, shared by every meter on screen:
 * the session's one engine read per animation frame (session.readMetersShared,
 * the same frame the transport and the Loops grid read), plus formatting for
 * levels and loudness.
 *
 * Meters and readouts update the DOM from the shared meter loop; nothing here
 * causes React renders.
 */
import type { MeterFrame } from '../../../audio/contracts';
import { session } from '../../instance';

/** What is read before audio has started: silence everywhere. */
const SILENT: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
let frameLive = false;

/** The current meter frame (read-only; the engine is read at most once per animation frame). */
export function readMixFrame(): MeterFrame {
  const f = session.readMetersShared();
  frameLive = f !== null;
  return f ?? SILENT;
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

/** The peak after a shared return (linear): what the Reverb or the Echo adds to the mix. */
export function returnPeak(which: 'reverb' | 'delay'): number {
  return readMixFrame().returns?.[which].peak ?? 0;
}

/** Forget what was read (tests that swap the meter source). */
export function resetMixFrame(): void {
  frameLive = false;
}

const MINUS = '−';

/**
 * "−14.2 LUFS" style number with a real minus sign ("−14.2" without a unit);
 * "—" when there is nothing to show. `signed` adds "+" to positive values.
 */
export function formatLoudness(v: number | undefined, unit = 'LUFS', signed = false): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  const text = `${r < 0 ? MINUS : r > 0 && signed ? '+' : ''}${Math.abs(r).toFixed(1)}`;
  return unit ? `${text} ${unit}` : text;
}

/** Signed dB with one decimal: "+2.0 dB", "−6.5 dB", "0.0 dB". */
export function formatDb(v: number): string {
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${Math.abs(r).toFixed(1)} dB`;
}

/** Level fader text (aria and title): the bottom of the fader is silence ("−60.0 dB, silent"). */
export function formatLevel(db: number, minDb: number): string {
  return db <= minDb ? `${formatDb(db)}, silent` : formatDb(db);
}

/** The level as shown under a fader: "Silent" at the bottom, so it fits a narrow strip. */
export function formatLevelShort(db: number, minDb: number): string {
  return db <= minDb ? 'Silent' : formatDb(db);
}
