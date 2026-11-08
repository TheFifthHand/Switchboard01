/**
 * Song loop helpers (pure: no DOM, no audio).
 *
 * A loop (`SongLoop`) is a range of whole bars of the song timeline,
 * [fromBar, toBar). In Advanced time is absolute, so edits never move it:
 * the session owns it (runtime `songLoop`, never saved) and the sequencer
 * plays it (`Sequencer.setSongLoop`). In Simple the session moves it with the
 * music an edit moves (followSongLoop).
 */
import { regionEnd, shiftRange, songBars, type TimeShift } from '../project/arrangement';
import { MAX_SONG_BARS, type Project } from '../project/types';
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

/**
 * Where the song loop (Simple's "Repeat this part") goes after an edit that
 * changed the song from `prev` to `next` (pure), so the person never ends up
 * repeating music they did not choose:
 * - a loop over the whole song stays over the whole song (an intro, an
 *   ending or a new part is heard);
 * - a loop over whole sections (one, or a run of them) follows those
 *   sections, by id, wherever they are now and however long;
 * - any other range follows the edit's time `shifts` (bars inserted before it
 *   move it later, inside it make it longer; bars taken out move it earlier
 *   or make it shorter).
 * Null: nothing it repeated is left (its bars or sections went), so repeat
 * goes off; `loop` itself (the same object) when nothing moves it.
 */
export function followSongLoop(
  prev: Pick<Project, 'arrangement'>,
  next: Pick<Project, 'arrangement'>,
  loop: SongLoop,
  shifts: readonly TimeShift[] = [],
): SongLoop | null {
  const pa = prev.arrangement;
  const na = next.arrangement;
  if (pa.regions === na.regions && pa.sections === na.sections && !shifts.length) return loop;
  const keep = (r: SongLoop | null): SongLoop | null => {
    const clean = cleanSongLoop(r);
    return clean && sameSongLoop(clean, loop) ? loop : clean;
  };
  const before = songBars(prev);
  if (loop.fromBar === 0 && before > 0 && loop.toBar >= before) {
    const after = songBars(next);
    return after > 0 ? keep({ fromBar: 0, toBar: after }) : null;
  }
  // Whole sections: the first one starts where the loop starts, the last one ends where it ends.
  const first = pa.sections.find((s) => s.start === loop.fromBar);
  const last = pa.sections.find((s) => regionEnd(s) === loop.toBar);
  if (first && last && first.start <= last.start) {
    const a = na.sections.find((s) => s.id === first.id);
    const b = na.sections.find((s) => s.id === last.id);
    if (a && b && a.start <= b.start) return keep({ fromBar: a.start, toBar: regionEnd(b) });
  }
  if (!shifts.length) return loop;
  const moved = shiftRange(shifts, loop.fromBar, loop.toBar);
  return moved ? keep({ fromBar: moved[0], toBar: moved[1] }) : null;
}
