/**
 * Song loop helpers (pure: no DOM, no audio).
 *
 * A loop (`SongLoop`) names its first and last block by id and covers every
 * block between them in the song's current order (either way round). The
 * session owns it (runtime `songLoop`) and keeps it valid across edits with
 * `songLoopAfterEdit`, and across undo and redo with `SongLoopHistory`; the
 * sequencer plays it (`Sequencer.setSongLoop`).
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
 * - The loop's last block itself changed (another length or other parts)
 *   and new blocks of its scene follow it right after (Split, Build up,
 *   Strip down, Breakdown, undoing a join, or redoing any of them): those
 *   blocks join the loop, the last of them becomes its last block. A block
 *   of the same scene added after an unchanged last block (pasted,
 *   duplicated) stays outside.
 * - The loop's first or last block joined into the block before it: that
 *   block takes its place.
 * - Otherwise a deleted first (last) block: the loop shrinks to the first
 *   (last) block of its old span that is still in the song; none left, it
 *   is cleared.
 * By itself this does not widen a loop again when a deletion is undone;
 * `SongLoopHistory` does, for the undo step that shrank it.
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
  // The loop's last block was itself changed by this edit and became several blocks of its scene (split,
  // a song helper, undoing a join, or redoing any of them): the new blocks right after it stay in the loop.
  let li = now.findIndex((b) => b.id === last);
  const was = before.find((b) => b.id === last);
  const cur = now[li];
  if (was && cur && (was.repeats !== cur.repeats || !sameMaterial(was, cur))) {
    while (li + 1 < now.length && !beforeIndex.has(now[li + 1].id) && now[li + 1].sceneId === cur.sceneId) li++;
    last = now[li].id;
  }
  // Unchanged: the same object (orientation kept).
  const ends = fi <= ti ? [loop.fromBlockId, loop.toBlockId] : [loop.toBlockId, loop.fromBlockId];
  if (first === ends[0] && last === ends[1]) return loop;
  return { fromBlockId: first, toBlockId: last };
}

/** A project change as the store reports it (see ProjectStore.lastChange). */
export interface SongLoopChange {
  kind: 'edit' | 'undo' | 'redo' | 'other';
  /** The undo step the change belongs to (null outside the history). */
  entryId: number | null;
}

/**
 * The loop across undo and redo. The loop is not part of the project or its
 * history, but an edit that changed it (a deleted end block shrank or cleared
 * it, a helper widened it) is remembered by its undo step: undoing that step
 * brings the loop back as it was before the edit, redoing it as it was after,
 * as long as the loop was not changed since (by hand or by another edit) and
 * its end blocks are in the song. An undo or redo that changed the loop by
 * `songLoopAfterEdit` (undoing the step that made a block the loop ends on)
 * is remembered the same way, so going back through that step restores the
 * loop. Every other change follows `songLoopAfterEdit`.
 */
export class SongLoopHistory {
  private readonly steps = new Map<number, { before: SongLoop | null; after: SongLoop | null }>();

  constructor(private readonly limit = 200) {}

  /** The loop after the change from `prev` to `next` (the same object when it is unchanged). */
  follow(loop: SongLoop | null, prev: Project, next: Project, change: SongLoopChange): SongLoop | null {
    const step = change.entryId === null ? undefined : this.steps.get(change.entryId);
    const fits = (l: SongLoop | null): boolean => !l || (next.arrangement.blocks.some((b) => b.id === l.fromBlockId) && next.arrangement.blocks.some((b) => b.id === l.toBlockId));
    const back = change.kind === 'undo' ? step?.before : change.kind === 'redo' ? step?.after : undefined;
    const from = change.kind === 'undo' ? step?.after : step?.before;
    if (step && back !== undefined && from !== undefined && sameSongLoop(loop, from) && fits(back)) return sameSongLoop(loop, back) ? loop : back;
    const out = songLoopAfterEdit(loop, prev, next);
    if (change.entryId !== null && change.kind !== 'other' && !sameSongLoop(out, loop)) {
      // A gesture merged into one step: its first change keeps the loop from before the step.
      if (change.kind === 'edit' && step) step.after = out;
      // An edit, or an undo or redo that changed the loop by those rules (a block the loop ends on made by
      // the step undone): going the other way through the step brings this loop back.
      else this.remember(change.entryId, change.kind === 'undo' ? { before: out, after: loop } : { before: loop, after: out });
    }
    return out;
  }

  private remember(entryId: number, step: { before: SongLoop | null; after: SongLoop | null }): void {
    this.steps.delete(entryId);
    this.steps.set(entryId, step);
    if (this.steps.size > this.limit) this.steps.delete(this.steps.keys().next().value!);
  }

  /** Forget every step (another project). */
  clear(): void {
    this.steps.clear();
  }
}
