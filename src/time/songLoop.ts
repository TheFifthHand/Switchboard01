/**
 * Song loop helpers (pure: no DOM, no audio).
 *
 * A loop (`SongLoop`) is a range of whole bars of the song timeline,
 * [fromBar, toBar). Time is absolute, so edits to the song never move it:
 * the session owns it (runtime `songLoop`, never saved) and the sequencer
 * plays it (`Sequencer.setSongLoop`).
 */
import { MAX_SONG_BARS } from '../project/types';
import type { SongLoop } from './contracts';

/**
 * `loop` as playback takes it: whole bars inside the song's range
 * (0 ≤ fromBar < toBar ≤ MAX_SONG_BARS), or null when it is not a loop
 * (no range left, or not numbers).
 */
export function cleanSongLoop(loop: SongLoop | null | undefined): SongLoop | null {
  if (!loop || !Number.isFinite(loop.fromBar) || !Number.isFinite(loop.toBar)) return null;
  const a = Math.min(MAX_SONG_BARS - 1, Math.max(0, Math.round(loop.fromBar)));
  const b = Math.min(MAX_SONG_BARS, Math.max(0, Math.round(loop.toBar)));
  return b > a ? { fromBar: a, toBar: b } : null;
}

export function sameSongLoop(a: SongLoop | null, b: SongLoop | null): boolean {
  if (!a || !b) return a === b;
  return a.fromBar === b.fromBar && a.toBar === b.toBar;
}

/** Bar `bar` (fractional allowed) lies inside the loop. */
export function inSongLoop(loop: SongLoop | null, bar: number): boolean {
  return !!loop && bar >= loop.fromBar && bar < loop.toBar;
}

/** "Bars 9–16" (1-based, as the ruler counts them); "Bar 9" for one bar. */
export function barRangeWords(fromBar: number, toBar: number): string {
  return toBar - fromBar <= 1 ? `Bar ${fromBar + 1}` : `Bars ${fromBar + 1}–${toBar}`;
}
