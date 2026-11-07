/**
 * "Try a ready-made loop…" in words and numbers (pure: no DOM, no React, no
 * audio): the library loops an instrument can take (its own kind of loop:
 * bass loops for a bass, chords for keys…), in the library's style order,
 * and the notes a loop leaves in a loop of the song (in the song's key, on
 * the instrument's register, repeated to fill the loop when it is longer).
 */
import { GENRES, loopFitsKind, searchLoops, type LibraryLoop, type RealizedLoop } from '../../../../content/loops';
import { MAX_CLIP_BARS, TICKS_PER_BAR, type ClipBars, type InstrumentKind, type Note, type TrackRole } from '../../../../project/types';
import { loopRoleOf } from './libraryModel';

/** The library loops for an instrument, style by style (empty: an instrument the library has no loops for). */
export function readyLoopsFor(trackRole: TrackRole, kind: InstrumentKind): LibraryLoop[] {
  const role = loopRoleOf({ role: trackRole });
  if (!role) return [];
  const order = new Map(GENRES.map((g, i) => [g.id as string, i]));
  return searchLoops('', { role })
    .filter((l) => loopFitsKind(l, kind))
    .map((l, i) => ({ l, i, g: order.get(l.genres[0]) ?? GENRES.length }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.l);
}

/**
 * The length and notes a loop of `loopBars` gets from a library loop: its own
 * length when the library loop repeats evenly in it (repeated to fill it),
 * else the library loop's length (as "Try a ready-made beat" does).
 */
export function fitReadyLoop(realized: Pick<RealizedLoop, 'bars' | 'notes'>, loopBars: number): { bars: ClipBars; notes: Omit<Note, 'id'>[] } {
  const own = realized.bars;
  const bars = (loopBars >= own && loopBars % own === 0 && loopBars <= MAX_CLIP_BARS ? loopBars : own) as ClipBars;
  const period = own * TICKS_PER_BAR;
  const notes: Omit<Note, 'id'>[] = [];
  for (let start = 0; start < bars * TICKS_PER_BAR; start += period) {
    for (const n of realized.notes) notes.push({ tick: n.tick + start, pitch: n.pitch, velocity: n.velocity, duration: n.duration });
  }
  return { bars, notes };
}
