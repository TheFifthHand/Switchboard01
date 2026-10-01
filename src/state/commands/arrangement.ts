/**
 * Song arrangement: an ordered list of scene blocks with repeat counts,
 * optional names and per-part changes (see ArrangementBlock).
 *
 * Every command is one undo step. Several blocks are addressed by id and
 * keep their song order; "gap" positions count insertion points in the
 * current list (0 = before the first block, n = after the last).
 */
import { uid } from '../../project/factory';
import { MAX_BLOCK_LABEL, MAX_BLOCK_REPEATS, type ArrangementBlock, type Id, type Project } from '../../project/types';
import { VALIDATION_LIMITS } from '../../project/validate';
import { sameMaterial } from '../../project/arrangement';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, cleanName, isFiniteNumber, refuse, run, type CommandResult } from './common';

export const DEFAULT_BLOCK_REPEATS = 2;

/** A block without its identity: what the clipboard holds and what duplicates copy. */
export interface BlockTemplate {
  sceneId: Id;
  repeats: number;
  label?: string;
  parts?: Record<Id, Id | null>;
}

const LIMIT_MESSAGE = `The song already has as many blocks as it can hold (${VALIDATION_LIMITS.maxBlocks}).`;

function clampRep(r: unknown, fallback = 1): number {
  return isFiniteNumber(r) ? clamp(Math.round(r), 1, MAX_BLOCK_REPEATS) : fallback;
}

/** Deep copy of a block's musical content (no id). */
export function blockTemplate(b: ArrangementBlock): BlockTemplate {
  const t: BlockTemplate = { sceneId: b.sceneId, repeats: b.repeats };
  if (b.label) t.label = b.label;
  if (b.parts && Object.keys(b.parts).length) t.parts = { ...b.parts };
  return t;
}

/** A new block (fresh id) from a template, with part changes that no longer apply removed. */
function fromTemplate(p: Project, t: BlockTemplate): ArrangementBlock {
  const block: ArrangementBlock = { id: uid('blk'), sceneId: t.sceneId, repeats: clampRep(t.repeats) };
  const label = t.label ? cleanName(t.label, MAX_BLOCK_LABEL) : null;
  if (label) block.label = label;
  if (t.parts) {
    const parts: Record<Id, Id | null> = {};
    for (const [trackId, v] of Object.entries(t.parts)) {
      if (!p.tracks.some((x) => x.id === trackId)) continue;
      if (v !== null && (v === t.sceneId || !p.scenes.some((s) => s.id === v))) continue;
      parts[trackId] = v;
    }
    if (Object.keys(parts).length) block.parts = parts;
  }
  return block;
}

function clampGap(gap: number | undefined, n: number): number {
  return gap === undefined || !Number.isFinite(gap) ? n : clamp(Math.round(gap), 0, n);
}

/** Ids that exist, in song order (duplicates and unknown ids dropped). */
function inSongOrder(p: Project, ids: readonly Id[]): Id[] {
  const want = new Set(ids);
  return p.arrangement.blocks.filter((b) => want.has(b.id)).map((b) => b.id);
}

/* ------------------------------------------------------------------ */
/* Add, remove, move, duplicate                                        */
/* ------------------------------------------------------------------ */

/** Add a block for a scene at `index` (default: the end). */
export function addBlock(store: ProjectStore, sceneId: Id, index?: number, repeats = DEFAULT_BLOCK_REPEATS, gesture?: string): CommandResult & { blockId?: Id } {
  const p = store.getState();
  if (!p.scenes.some((s) => s.id === sceneId)) return NOT_FOUND('scene');
  if (p.arrangement.blocks.length >= VALIDATION_LIMITS.maxBlocks) return refuse('limit', LIMIT_MESSAGE);
  const at = clampGap(index, p.arrangement.blocks.length);
  const block: ArrangementBlock = { id: uid('blk'), sceneId, repeats: clampRep(repeats, DEFAULT_BLOCK_REPEATS) };
  // A shared gesture id makes several additions (e.g. "Add all scenes") one undo step.
  const r = run(store, 'arrange:Add block', (d) => {
    d.arrangement.blocks.splice(at, 0, block);
  }, gesture);
  return { ...r, blockId: block.id };
}

/**
 * Insert copies of `templates` as a group at insertion point `gap` (default:
 * the end). Templates whose scene no longer exists are skipped.
 */
export function insertBlocks(store: ProjectStore, templates: readonly BlockTemplate[], gap?: number, label = 'arrange:Paste blocks'): CommandResult & { blockIds?: Id[]; skipped?: number } {
  const p = store.getState();
  const usable = templates.filter((t) => p.scenes.some((s) => s.id === t.sceneId));
  const skipped = templates.length - usable.length;
  if (!usable.length) return { ...refuse('empty', templates.length ? 'Those blocks played scenes that no longer exist.' : 'Nothing to add.'), skipped };
  if (p.arrangement.blocks.length + usable.length > VALIDATION_LIMITS.maxBlocks) return refuse('limit', LIMIT_MESSAGE);
  const at = clampGap(gap, p.arrangement.blocks.length);
  const blocks = usable.map((t) => fromTemplate(p, t));
  const r = run(store, label, (d) => {
    d.arrangement.blocks.splice(at, 0, ...blocks);
  });
  return { ...r, blockIds: blocks.map((b) => b.id), skipped };
}

/**
 * Copies of the given blocks (in song order), inserted together at `gap`
 * (default: right after the last of them).
 */
export function duplicateBlocks(store: ProjectStore, ids: readonly Id[], gap?: number): CommandResult & { blockIds?: Id[] } {
  const p = store.getState();
  const order = inSongOrder(p, ids);
  if (!order.length) return NOT_FOUND('block');
  const list = p.arrangement.blocks;
  const last = list.findIndex((b) => b.id === order[order.length - 1]);
  const templates = order.map((id) => blockTemplate(list.find((b) => b.id === id)!));
  return insertBlocks(store, templates, gap ?? last + 1, order.length === 1 ? 'arrange:Duplicate block' : 'arrange:Duplicate blocks');
}

export function removeBlock(store: ProjectStore, blockId: Id): CommandResult {
  if (!store.getState().arrangement.blocks.some((b) => b.id === blockId)) return NOT_FOUND('block');
  return run(store, 'arrange:Remove block', (d) => {
    d.arrangement.blocks = d.arrangement.blocks.filter((b) => b.id !== blockId);
  });
}

/** Remove several blocks in one step. */
export function removeBlocks(store: ProjectStore, ids: readonly Id[]): CommandResult & { removed?: number } {
  const order = inSongOrder(store.getState(), ids);
  if (!order.length) return NOT_FOUND('block');
  const gone = new Set(order);
  const r = run(store, order.length === 1 ? 'arrange:Remove block' : 'arrange:Remove blocks', (d) => {
    d.arrangement.blocks = d.arrangement.blocks.filter((b) => !gone.has(b.id));
  });
  return { ...r, removed: order.length };
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

/**
 * The song order after moving `ids` (kept in their song order, side by side)
 * to insertion point `gap` of the current list. Pure; used by the command and
 * by the lane to preview a drag.
 */
export function orderAfterMove<T extends { id: Id }>(list: readonly T[], ids: readonly Id[], gap: number): T[] {
  const moving = new Set(ids);
  const g = clampGap(gap, list.length);
  const before = list.slice(0, g).filter((b) => !moving.has(b.id));
  const after = list.slice(g).filter((b) => !moving.has(b.id));
  return [...before, ...list.filter((b) => moving.has(b.id)), ...after];
}

/** Move several blocks together to insertion point `gap` (one undo step). */
export function moveBlocks(store: ProjectStore, ids: readonly Id[], gap: number): CommandResult {
  const p = store.getState();
  const order = inSongOrder(p, ids);
  if (!order.length) return NOT_FOUND('block');
  if (!Number.isFinite(gap)) return refuse('invalid', 'Unknown block position.');
  const next = orderAfterMove(p.arrangement.blocks, order, gap);
  if (next.every((b, i) => b === p.arrangement.blocks[i])) return { changed: false };
  const nextIds = next.map((b) => b.id);
  return run(store, order.length === 1 ? 'arrange:Move block' : 'arrange:Move blocks', (d) => {
    const byId = new Map(d.arrangement.blocks.map((b) => [b.id, b]));
    d.arrangement.blocks = nextIds.map((id) => byId.get(id)!);
  });
}

/* ------------------------------------------------------------------ */
/* Length: repeats, split, join                                        */
/* ------------------------------------------------------------------ */

/** Repeats 1–MAX_BLOCK_REPEATS. A shared gesture id (an edge drag) makes one undo step. */
export function setBlockRepeats(store: ProjectStore, blockId: Id, repeats: number, gesture?: string): CommandResult {
  if (!store.getState().arrangement.blocks.some((b) => b.id === blockId)) return NOT_FOUND('block');
  if (!isFiniteNumber(repeats)) return refuse('invalid', 'Repeats must be a number.');
  const v = clampRep(repeats);
  return run(store, 'arrange:Change length', (d) => {
    const b = d.arrangement.blocks.find((x) => x.id === blockId);
    if (b) b.repeats = v;
  }, gesture);
}

/**
 * Split a block after pass `afterPass` (1 ≤ afterPass < repeats): the block
 * keeps the first passes and a new block with the same material follows it.
 */
export function splitBlock(store: ProjectStore, blockId: Id, afterPass: number): CommandResult & { blockId?: Id } {
  const p = store.getState();
  const i = p.arrangement.blocks.findIndex((b) => b.id === blockId);
  if (i < 0) return NOT_FOUND('block');
  const b = p.arrangement.blocks[i];
  if (!Number.isInteger(afterPass) || afterPass < 1 || afterPass >= b.repeats) return refuse('invalid', b.repeats < 2 ? 'A block that plays once cannot be split.' : 'Split between two passes of the block.');
  if (p.arrangement.blocks.length >= VALIDATION_LIMITS.maxBlocks) return refuse('limit', LIMIT_MESSAGE);
  const second = fromTemplate(p, { ...blockTemplate(b), repeats: b.repeats - afterPass });
  const r = run(store, 'arrange:Split block', (d) => {
    const x = d.arrangement.blocks.find((y) => y.id === blockId)!;
    x.repeats = afterPass;
    d.arrangement.blocks.splice(i + 1, 0, second);
  });
  return { ...r, blockId: second.id };
}

/** Why a block cannot be joined with the next one, or null when it can. */
export function joinProblem(p: Project, blockId: Id): string | null {
  const list = p.arrangement.blocks;
  const i = list.findIndex((b) => b.id === blockId);
  if (i < 0) return 'That block no longer exists.';
  const next = list[i + 1];
  if (!next) return 'There is no block after this one.';
  if (!sameMaterial(list[i], next)) return 'Only neighbours that play the same scene with the same parts can be joined.';
  if (list[i].repeats + next.repeats > MAX_BLOCK_REPEATS) return `Together they would pass ${MAX_BLOCK_REPEATS} repeats, the most one block holds.`;
  return null;
}

/** Join a block with the next one (same scene and parts): one block with both blocks' passes. */
export function joinWithNext(store: ProjectStore, blockId: Id): CommandResult {
  const p = store.getState();
  const problem = joinProblem(p, blockId);
  if (problem) return refuse(p.arrangement.blocks.some((b) => b.id === blockId) ? 'invalid' : 'not-found', problem);
  return run(store, 'arrange:Join blocks', (d) => {
    const i = d.arrangement.blocks.findIndex((b) => b.id === blockId);
    const [next] = d.arrangement.blocks.splice(i + 1, 1);
    d.arrangement.blocks[i].repeats += next.repeats;
  });
}

/* ------------------------------------------------------------------ */
/* Scene, name, parts                                                  */
/* ------------------------------------------------------------------ */

/** Point a block at a different scene (part changes that now equal the scene are dropped). */
export function setBlockScene(store: ProjectStore, blockId: Id, sceneId: Id): CommandResult {
  const p = store.getState();
  if (!p.arrangement.blocks.some((b) => b.id === blockId)) return NOT_FOUND('block');
  if (!p.scenes.some((s) => s.id === sceneId)) return NOT_FOUND('scene');
  return run(store, 'arrange:Change block scene', (d) => {
    const b = d.arrangement.blocks.find((x) => x.id === blockId);
    if (!b) return;
    b.sceneId = sceneId;
    if (b.parts) {
      for (const k of Object.keys(b.parts)) if (b.parts[k] === sceneId) delete b.parts[k];
      if (!Object.keys(b.parts).length) delete b.parts;
    }
  });
}

/** Name a block ("" or only spaces removes the name: the block shows its scene name again). */
export function renameBlock(store: ProjectStore, blockId: Id, label: string): CommandResult {
  const b = store.getState().arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return NOT_FOUND('block');
  const v = cleanName(label, MAX_BLOCK_LABEL);
  if ((v ?? undefined) === b.label) return { changed: false };
  return run(store, 'arrange:Rename block', (d) => {
    const x = d.arrangement.blocks.find((y) => y.id === blockId);
    if (!x) return;
    if (v) x.label = v;
    else delete x.label;
  });
}

/**
 * What one part plays in one block: a scene id (that scene's clip for this
 * part), null (silent here), or undefined (follow the block's scene again).
 */
export function setBlockPart(store: ProjectStore, blockId: Id, trackId: Id, choice: Id | null | undefined, gesture?: string): CommandResult {
  const p = store.getState();
  const b = p.arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return NOT_FOUND('block');
  if (!p.tracks.some((t) => t.id === trackId)) return NOT_FOUND('part');
  if (typeof choice === 'string' && !p.scenes.some((s) => s.id === choice)) return NOT_FOUND('scene');
  const v = choice === b.sceneId ? undefined : choice;
  const cur = b.parts && Object.prototype.hasOwnProperty.call(b.parts, trackId) ? b.parts[trackId] : undefined;
  if (cur === v) return { changed: false };
  return run(store, 'arrange:Change part in block', (d) => {
    const x = d.arrangement.blocks.find((y) => y.id === blockId);
    if (!x) return;
    const parts = { ...(x.parts ?? {}) };
    if (v === undefined) delete parts[trackId];
    else parts[trackId] = v;
    if (Object.keys(parts).length) x.parts = parts;
    else delete x.parts;
  }, gesture);
}

/**
 * Layer a scene onto a block: every part that has a clip in that scene plays
 * it in this block (replacing what the part played there); other parts keep
 * what they play. Returns how many parts changed.
 */
export function layerScene(store: ProjectStore, blockId: Id, sceneId: Id): CommandResult & { parts?: number } {
  const p = store.getState();
  const b = p.arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return NOT_FOUND('block');
  const row = p.scenes.findIndex((s) => s.id === sceneId);
  if (row < 0) return NOT_FOUND('scene');
  const next: Record<Id, Id | null> = { ...(b.parts ?? {}) };
  let parts = 0;
  for (const t of p.tracks) {
    if (!t.clips[row]) continue;
    const cur = Object.prototype.hasOwnProperty.call(next, t.id) ? next[t.id] : undefined;
    const want = sceneId === b.sceneId ? undefined : sceneId;
    if (cur === want) continue;
    if (want === undefined) delete next[t.id];
    else next[t.id] = want;
    parts++;
  }
  if (!parts) return { ...refuse('empty', sceneId === b.sceneId ? 'This block already plays that scene.' : 'That scene adds nothing new to this block.'), parts: 0 };
  const r = run(store, 'arrange:Layer scene', (d) => {
    const x = d.arrangement.blocks.find((y) => y.id === blockId);
    if (!x) return;
    if (Object.keys(next).length) x.parts = next;
    else delete x.parts;
  });
  return { ...r, parts };
}

/** Every part follows the block's scene again. */
export function resetBlockParts(store: ProjectStore, blockId: Id): CommandResult {
  const b = store.getState().arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return NOT_FOUND('block');
  if (!b.parts) return { changed: false };
  return run(store, 'arrange:Reset parts in block', (d) => {
    const x = d.arrangement.blocks.find((y) => y.id === blockId);
    if (x) delete x.parts;
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
