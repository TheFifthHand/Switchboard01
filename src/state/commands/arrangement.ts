/** Song arrangement: an ordered list of scene blocks with repeat counts. */
import { uid } from '../../project/factory';
import type { Id } from '../../project/types';
import { VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, isFiniteNumber, refuse, run, type CommandResult } from './common';

export const DEFAULT_BLOCK_REPEATS = 2;

/** Add a block for a scene at `index` (default: the end). */
export function addBlock(store: ProjectStore, sceneId: Id, index?: number, repeats = DEFAULT_BLOCK_REPEATS, gesture?: string): CommandResult & { blockId?: Id } {
  const p = store.getState();
  if (!p.scenes.some((s) => s.id === sceneId)) return NOT_FOUND('scene');
  if (p.arrangement.blocks.length >= VALIDATION_LIMITS.maxBlocks) return refuse('limit', 'The song already has as many blocks as it can hold.');
  const len = p.arrangement.blocks.length;
  const at = index === undefined || !Number.isFinite(index) ? len : clamp(Math.round(index), 0, len);
  const block = { id: uid('blk'), sceneId, repeats: clamp(Math.round(isFiniteNumber(repeats) ? repeats : DEFAULT_BLOCK_REPEATS), 1, 8) };
  // A shared gesture id makes several additions (e.g. "Add all scenes") one undo step.
  const r = run(store, 'arrange:Add block', (d) => {
    d.arrangement.blocks.splice(at, 0, block);
  }, gesture);
  return { ...r, blockId: block.id };
}

export function removeBlock(store: ProjectStore, blockId: Id): CommandResult {
  if (!store.getState().arrangement.blocks.some((b) => b.id === blockId)) return NOT_FOUND('block');
  return run(store, 'arrange:Remove block', (d) => {
    d.arrangement.blocks = d.arrangement.blocks.filter((b) => b.id !== blockId);
  });
}

/** Move a block from one position to another (drag to reorder). */
export function moveBlock(store: ProjectStore, fromIndex: number, toIndex: number): CommandResult {
  const n = store.getState().arrangement.blocks.length;
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= n || !Number.isInteger(toIndex)) return refuse('invalid', 'Unknown block position.');
  const to = clamp(toIndex, 0, n - 1);
  if (to === fromIndex) return { changed: false };
  return run(store, 'arrange:Move block', (d) => {
    const [b] = d.arrangement.blocks.splice(fromIndex, 1);
    d.arrangement.blocks.splice(to, 0, b);
  });
}

/** Repeats 1–8. */
export function setBlockRepeats(store: ProjectStore, blockId: Id, repeats: number): CommandResult {
  if (!store.getState().arrangement.blocks.some((b) => b.id === blockId)) return NOT_FOUND('block');
  if (!isFiniteNumber(repeats)) return refuse('invalid', 'Repeats must be a number.');
  const v = clamp(Math.round(repeats), 1, 8);
  return run(store, 'arrange:Change repeats', (d) => {
    const b = d.arrangement.blocks.find((x) => x.id === blockId);
    if (b) b.repeats = v;
  });
}

/** Point a block at a different scene. */
export function setBlockScene(store: ProjectStore, blockId: Id, sceneId: Id): CommandResult {
  const p = store.getState();
  if (!p.arrangement.blocks.some((b) => b.id === blockId)) return NOT_FOUND('block');
  if (!p.scenes.some((s) => s.id === sceneId)) return NOT_FOUND('scene');
  return run(store, 'arrange:Change block scene', (d) => {
    const b = d.arrangement.blocks.find((x) => x.id === blockId);
    if (b) b.sceneId = sceneId;
  });
}

/** Effect tail appended to exports, 0–10 seconds. */
export function setTailSeconds(store: ProjectStore, seconds: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(seconds)) return refuse('invalid', 'The tail length must be a number.');
  const v = clamp(seconds, 0, 10);
  return run(store, 'arrange:Change tail length', (d) => {
    d.arrangement.tailSeconds = v;
  }, gesture);
}
