/**
 * The song's loop range (pure: no DOM, no React).
 *
 * Like GarageBand's cycle area: the range is a band over the ruler, set by
 * dragging along the ruler (which also turns looping on), changed by dragging
 * its ends, and switched on and off by a click on the band or the Loop key.
 * The range stays (dimmed) while looping is off, for this session only; the
 * runtime's songLoop is the range while looping is on.
 *
 * The Loop key with no range yet sets one first: the selected regions' bars,
 * else the section under the cursor, else the whole song.
 */
import { regionEnd, sectionAt } from '../../../project/arrangement';
import type { SongSection } from '../../../project/types';
import type { BarRange } from './laneGestures';

export type { BarRange };

/** Two ranges that cover the same bars (either may be null). */
export function sameRange(a: BarRange | null | undefined, b: BarRange | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.fromBar === b.fromBar && a.toBar === b.toBar;
}

/**
 * What the Loop key loops when no range is set yet: the selected regions'
 * bars, else the section under the song cursor, else the whole song (null for
 * an empty song).
 */
export function loopKeyRange(o: { selection: [number, number] | null; sections: readonly SongSection[]; cursorBar: number; songBars: number }): BarRange | null {
  if (o.selection && o.selection[1] > o.selection[0]) return { fromBar: o.selection[0], toBar: o.selection[1] };
  const s = sectionAt(o.sections, o.cursorBar);
  if (s) return { fromBar: s.start, toBar: regionEnd(s) };
  return o.songBars > 0 ? { fromBar: 0, toBar: o.songBars } : null;
}

/** "Loop Bars 9–16" / "Loop Bar 9" as the Loop key and the band read it. */
export function rangeWords(r: BarRange): string {
  return r.toBar - r.fromBar <= 1 ? `Bar ${r.fromBar + 1}` : `Bars ${r.fromBar + 1}–${r.toBar}`;
}

