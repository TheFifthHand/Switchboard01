/**
 * Song loop helpers (pure: no DOM, no audio).
 *
 * A loop (`SongLoop`) names its first and last block by id and covers every
 * block between them in the song's current order (either way round). The
 * session owns it (runtime `songLoop`) and keeps it valid across edits with
 * `songLoopAfterEdit`; the sequencer plays it (`Sequencer.setSongLoop`).
 */
import { sameMaterial } from '../project/arrangement';
import type { Id, Project } from '../project/types';
import type { SongLoop } from './contracts';
import type { SongBlockPlan } from './sequencer';

/**
 * The loop on the lane `lane` (`songBlocks` of the project): the positions of
 * its first and last block, or null when there is no loop or one of its
 * blocks is not on the lane.
 */
export function songLoopRange(lane: readonly SongBlockPlan[], loop: SongLoop | null): [number, number] | null {
  if (!loop) return null;
  const a = lane.findIndex((b) => b.blockId === loop.fromBlockId);
  const z = lane.findIndex((b) => b.blockId === loop.toBlockId);
  if (a < 0 || z < 0) return null;
  return a <= z ? [a, z] : [z, a];
}

export function sameSongLoop(a: SongLoop | null, b: SongLoop | null): boolean {
  if (!a || !b) return a === b;
  return a.fromBlockId === b.fromBlockId && a.toBlockId === b.toBlockId;
}

/** Ids of the blocks the loop covers, in song order (empty when it covers none). */
export function songLoopBlockIds(p: Project, loop: SongLoop | null): Id[] {
  if (!loop) return [];
  const blocks = p.arrangement.blocks;
  const a = blocks.findIndex((b) => b.id === loop.fromBlockId);
  const z = blocks.findIndex((b) => b.id === loop.toBlockId);
  if (a < 0 || z < 0) return [];
  return blocks.slice(Math.min(a, z), Math.max(a, z) + 1).map((b) => b.id);
}

/**
 * The loop after an edit from `prev` to `next` (same object when it is
 * unchanged, null when nothing of it is left):
 * - Its first and last block still there: unchanged (it covers what lies
 *   between them in the new order, so blocks moved in or out follow).
 * - A block split in two: both halves stay in the loop (the second half,
 *   new and right after the loop's last block, becomes its last block).
 * - The loop's first or last block joined into the block before it: that
 *   block takes its place.
 * - Otherwise a deleted first (last) block: the loop shrinks to the first
 *   (last) block of its old span that is still in the song; none left, it
 *   is cleared.
 * The loop is not part of the undo history: undoing a deletion does not
 * widen it again (undoing a join or split does, by the rules above).
 */
export function songLoopAfterEdit(loop: SongLoop | null, prev: Project, next: Project): SongLoop | null {
  if (!loop || prev.arrangement === next.arrangement) return loop;
  const before = prev.arrangement.blocks;
  const now = next.arrangement.blocks;
  const nowById = new Map(now.map((b) => [b.id, b]));
  const beforeIndex = new Map(before.map((b, i) => [b.id, i]));
  const fi = beforeIndex.get(loop.fromBlockId);
  const ti = beforeIndex.get(loop.toBlockId);
  // Not a loop of the previous song (e.g. another project): kept only when it fits the new one.
  if (fi === undefined || ti === undefined) return nowById.has(loop.fromBlockId) && nowById.has(loop.toBlockId) ? loop : null;
  const lo = Math.min(fi, ti);
  const hi = Math.max(fi, ti);
  /** The block before `i` (in the old order) that absorbed it in a join, if any. */
  const joinedInto = (i: number): Id | null => {
    if (i === 0) return null;
    const left = before[i - 1];
    const gone = before[i];
    const merged = nowById.get(left.id);
    return merged && merged.repeats === left.repeats + gone.repeats && sameMaterial(merged, gone) ? left.id : null;
  };
  let first: Id | null = before[lo].id;
  if (!nowById.has(first)) {
    first = joinedInto(lo);
    for (let i = lo + 1; first === null && i <= hi; i++) if (nowById.has(before[i].id)) first = before[i].id;
  }
  let last: Id | null = before[hi].id;
  if (!nowById.has(last)) {
    last = joinedInto(hi);
    for (let i = hi - 1; last === null && i >= lo; i--) if (nowById.has(before[i].id)) last = before[i].id;
  }
  if (first === null || last === null) return null;
  // The loop's last block split in two: the second half (new, right after it) stays in the loop.
  const li = now.findIndex((b) => b.id === last);
  const half = now[li + 1];
  const was = before.find((b) => b.id === last);
  const cur = now[li];
  if (half && was && !beforeIndex.has(half.id) && was.repeats === cur.repeats + half.repeats && sameMaterial(cur, half)) last = half.id;
  // Unchanged: the same object (orientation kept).
  const ends = fi <= ti ? [loop.fromBlockId, loop.toBlockId] : [loop.toBlockId, loop.fromBlockId];
  if (first === ends[0] && last === ends[1]) return loop;
  return { fromBlockId: first, toBlockId: last };
}
