/**
 * Song arrangement: an ordered list of scene blocks with repeat counts,
 * optional names, per-part changes and song moves (see ArrangementBlock).
 *
 * Every command is one undo step. Several blocks are addressed by id and
 * keep their song order; "gap" positions count insertion points in the
 * current list (0 = before the first block, n = after the last).
 */
import { uid } from '../../project/factory';
import {
  BLOCK_MOVE_KINDS,
  MAX_BLOCK_LABEL,
  MAX_BLOCK_REPEATS,
  TICKS_PER_BAR,
  type ArrangementBlock,
  type BlockMove,
  type BlockMoveKind,
  type Id,
  type Project,
  type TrackRole,
} from '../../project/types';
import { VALIDATION_LIMITS } from '../../project/validate';
import { blockBars, blockPart, blockParts, sameMaterial, sceneRow } from '../../project/arrangement';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, cleanName, isFiniteNumber, partName, refuse, run, type CommandResult } from './common';

export const DEFAULT_BLOCK_REPEATS = 2;

/** A song move without its identity (what templates and setBlockMoves take). */
export interface BlockMoveTemplate {
  kind: BlockMoveKind;
  parts?: Id[];
}

/** A block without its identity: what the clipboard holds and what duplicates copy. */
export interface BlockTemplate {
  sceneId: Id;
  repeats: number;
  label?: string;
  parts?: Record<Id, Id | null>;
  moves?: BlockMoveTemplate[];
}

const LIMIT_MESSAGE = `The song already has as many blocks as it can hold (${VALIDATION_LIMITS.maxBlocks}).`;

function clampRep(r: unknown, fallback = 1): number {
  return isFiniteNumber(r) ? clamp(Math.round(r), 1, MAX_BLOCK_REPEATS) : fallback;
}

/* ------------------------------------------------------------------ */
/* Song moves                                                          */
/* ------------------------------------------------------------------ */

/** What the song moves are called in menus and undo steps. */
export const BLOCK_MOVE_NAMES: Readonly<Record<BlockMoveKind, string>> = {
  fadeIn: 'Fade in',
  fadeOut: 'Fade out',
  filterRise: 'Filter rise',
  echoThrow: 'Echo throw',
};

/** Moves that act at a block's start; the others act across it or toward its end. */
function startMove(kind: BlockMoveKind): boolean {
  return kind === 'fadeIn';
}

/**
 * Moves cleaned for `p`: known kinds, one of each (the first wins), `parts`
 * limited to existing parts without repeats (fades never carry parts; an
 * empty list is left out: every melodic part). Ids are kept when `keepIds`
 * and present, else new.
 */
function cleanMoves(p: Project, moves: readonly (BlockMoveTemplate & { id?: Id })[] | undefined, keepIds: boolean): BlockMove[] {
  const out: BlockMove[] = [];
  for (const m of moves ?? []) {
    if (!m || !BLOCK_MOVE_KINDS.includes(m.kind) || out.some((x) => x.kind === m.kind)) continue;
    const move: BlockMove = { id: keepIds && typeof m.id === 'string' ? m.id : uid('mv'), kind: m.kind };
    if (m.kind !== 'fadeIn' && m.kind !== 'fadeOut' && Array.isArray(m.parts)) {
      const parts = m.parts.filter((t, i, a) => typeof t === 'string' && p.tracks.some((x) => x.id === t) && a.indexOf(t) === i);
      if (parts.length) move.parts = parts;
    }
    out.push(move);
  }
  return out;
}

function templateMoves(moves: readonly BlockMove[] | undefined): BlockMoveTemplate[] | undefined {
  if (!moves?.length) return undefined;
  return moves.map((m) => (m.parts ? { kind: m.kind, parts: [...m.parts] } : { kind: m.kind }));
}

/** Deep copy of a block's musical content (no id). */
export function blockTemplate(b: ArrangementBlock): BlockTemplate {
  const t: BlockTemplate = { sceneId: b.sceneId, repeats: b.repeats };
  if (b.label) t.label = b.label;
  if (b.parts && Object.keys(b.parts).length) t.parts = { ...b.parts };
  const moves = templateMoves(b.moves);
  if (moves) t.moves = moves;
  return t;
}

/** A new block (fresh ids) from a template, with part changes and moves that no longer apply removed. */
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
  const moves = cleanMoves(p, t.moves, false);
  if (moves.length) block.moves = moves;
  return block;
}

/** Detached copies of moves (same ids). */
function copyMoves(moves: readonly BlockMove[]): BlockMove[] {
  return moves.map((m) => (m.parts ? { ...m, parts: [...m.parts] } : { ...m }));
}

/** A block's moves that happen at its start (fade in) and those across it or toward its end (the rest). */
function movesByEnd(moves: readonly BlockMove[] | undefined): { start: BlockMove[]; end: BlockMove[] } {
  return { start: copyMoves((moves ?? []).filter((m) => startMove(m.kind))), end: copyMoves((moves ?? []).filter((m) => !startMove(m.kind))) };
}

/**
 * Share a block's moves out over the blocks that replace it (a song helper):
 * a move at the start (fade in) goes to the first, the others (fade out,
 * filter rise, echo throw) to the last, so each still happens where it did.
 * Ids are kept, so no move is doubled.
 */
function shareMoves<T extends { moves?: BlockMove[] }>(moves: readonly BlockMove[] | undefined, pieces: T[]): T[] {
  if (!moves?.length || !pieces.length) return pieces;
  const { start, end } = movesByEnd(moves);
  return pieces.map((x, i) => {
    const mine = [...(i === 0 ? start : []), ...(i === pieces.length - 1 ? end : [])];
    const out = { ...x };
    if (mine.length) out.moves = mine;
    else delete out.moves;
    return out;
  });
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

/** Remove several blocks in one step (`opts.cut`: the step is called Cut, as the clipboard's Cut is). */
export function removeBlocks(store: ProjectStore, ids: readonly Id[], opts: { cut?: boolean } = {}): CommandResult & { removed?: number } {
  const order = inSongOrder(store.getState(), ids);
  if (!order.length) return NOT_FOUND('block');
  const gone = new Set(order);
  const what = order.length === 1 ? 'block' : 'blocks';
  const r = run(store, `arrange:${opts.cut ? 'Cut' : 'Remove'} ${what}`, (d) => {
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
  if (!isFiniteNumber(repeats)) return refuse('invalid', 'How many times a block plays must be a number.');
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
  if (!Number.isInteger(afterPass) || afterPass < 1 || afterPass >= b.repeats) return refuse('invalid', b.repeats < 2 ? 'A block that plays once cannot be split.' : 'Split between two times the block plays.');
  if (p.arrangement.blocks.length >= VALIDATION_LIMITS.maxBlocks) return refuse('limit', LIMIT_MESSAGE);
  // The fade in stays on the first half; the moves toward the end go with the second.
  const { start, end } = movesByEnd(b.moves);
  const second = fromTemplate(p, { ...blockTemplate(b), moves: undefined, repeats: b.repeats - afterPass });
  if (end.length) second.moves = end;
  const r = run(store, 'arrange:Split block', (d) => {
    const x = d.arrangement.blocks.find((y) => y.id === blockId)!;
    x.repeats = afterPass;
    if (start.length) x.moves = start;
    else delete x.moves;
    d.arrangement.blocks.splice(i + 1, 0, second);
  });
  return { ...r, blockId: second.id };
}

/** Why a block cannot be joined with the next one (a few words and the full reason), or null when it can. */
export function joinProblemDetail(p: Project, blockId: Id): { short: string; text: string } | null {
  const list = p.arrangement.blocks;
  const i = list.findIndex((b) => b.id === blockId);
  if (i < 0) return { short: 'Gone', text: 'That block no longer exists.' };
  const next = list[i + 1];
  if (!next) return { short: 'Last block', text: 'There is no block after this one.' };
  if (!sameMaterial(list[i], next)) return { short: 'Not the same', text: 'Only neighbours that play the same scene with the same parts can be joined.' };
  if (list[i].repeats + next.repeats > MAX_BLOCK_REPEATS) return { short: `Over ${MAX_BLOCK_REPEATS} times`, text: `Together they would play more than ${MAX_BLOCK_REPEATS} times, the most one block holds.` };
  return null;
}

/** Why a block cannot be joined with the next one, or null when it can. */
export function joinProblem(p: Project, blockId: Id): string | null {
  return joinProblemDetail(p, blockId)?.text ?? null;
}

/**
 * Join a block with the next one (same scene and parts): one block with both
 * blocks' passes. The joined block starts like the first (its fade in) and
 * ends like the second (its fade out, filter rise, echo throw).
 */
export function joinWithNext(store: ProjectStore, blockId: Id): CommandResult {
  const p = store.getState();
  const problem = joinProblem(p, blockId);
  if (problem) return refuse(p.arrangement.blocks.some((b) => b.id === blockId) ? 'invalid' : 'not-found', problem);
  const i = p.arrangement.blocks.findIndex((b) => b.id === blockId);
  const moves = [...movesByEnd(p.arrangement.blocks[i].moves).start, ...movesByEnd(p.arrangement.blocks[i + 1].moves).end];
  return run(store, 'arrange:Join blocks', (d) => {
    const at = d.arrangement.blocks.findIndex((x) => x.id === blockId);
    const [next] = d.arrangement.blocks.splice(at + 1, 1);
    const x = d.arrangement.blocks[at];
    x.repeats += next.repeats;
    if (moves.length) x.moves = moves;
    else delete x.moves;
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
 * How layering a scene into a block treats the parts the block already plays:
 * - 'fill' (the default): only parts that are silent in the block (its scene
 *   has no clip for them, or what they were set to has none) take the
 *   layered scene's clip; parts that play something, and parts switched Off
 *   on purpose, keep what they do;
 * - 'replace': every part with a clip in the layered scene plays it here.
 */
export type LayerMode = 'fill' | 'replace';

/**
 * The parts layering scene `sceneId` into block `b` changes, in track order
 * (pure; the lane previews exactly this). Empty for the block's own scene.
 */
export function layerChanges(p: Project, b: ArrangementBlock, sceneId: Id, mode: LayerMode = 'fill'): Id[] {
  const row = p.scenes.findIndex((s) => s.id === sceneId);
  if (row < 0 || sceneId === b.sceneId) return [];
  const ownRow = p.scenes.findIndex((s) => s.id === b.sceneId);
  const out: Id[] = [];
  for (const t of p.tracks) {
    if (!t.clips[row]) continue;
    const has = !!b.parts && Object.prototype.hasOwnProperty.call(b.parts, t.id);
    const cur = has ? b.parts![t.id] : undefined;
    if (cur === sceneId) continue;
    if (mode === 'fill') {
      // Off on purpose stays off; a part that plays something keeps it.
      if (cur === null) continue;
      const curRow = cur === undefined ? ownRow : p.scenes.findIndex((s) => s.id === cur);
      const sounds = curRow >= 0 ? !!t.clips[curRow] : cur !== undefined && ownRow >= 0 && !!t.clips[ownRow];
      if (sounds) continue;
    }
    out.push(t.id);
  }
  return out;
}

/**
 * Layer a scene onto a block (one undo step): in 'fill' mode (the default)
 * the parts that are silent in the block play that scene's clips; in
 * 'replace' mode every part with a clip in that scene plays it here. Other
 * parts keep what they play. Returns how many parts changed.
 */
export function layerScene(store: ProjectStore, blockId: Id, sceneId: Id, mode: LayerMode = 'fill'): CommandResult & { parts?: number } {
  const p = store.getState();
  const b = p.arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return NOT_FOUND('block');
  const row = p.scenes.findIndex((s) => s.id === sceneId);
  if (row < 0) return NOT_FOUND('scene');
  if (sceneId === b.sceneId) return { ...refuse('empty', 'This block already plays that scene.'), parts: 0 };
  const changes = layerChanges(p, b, sceneId, mode);
  if (!changes.length) {
    const more = mode === 'fill' && layerChanges(p, b, sceneId, 'replace').length > 0;
    return { ...refuse('empty', more ? 'Nothing to fill: every part that scene has a clip for already plays in this block. Replace the parts to use its clips instead.' : 'That scene adds nothing new to this block.'), parts: 0 };
  }
  const next: Record<Id, Id | null> = { ...(b.parts ?? {}) };
  for (const id of changes) next[id] = sceneId;
  const parts = changes.length;
  const r = run(store, mode === 'replace' ? 'arrange:Replace parts with a scene' : 'arrange:Layer scene', (d) => {
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

/* ------------------------------------------------------------------ */
/* Song helpers: build up, strip down, breakdown                       */
/* ------------------------------------------------------------------ */

/**
 * The order parts come in during a build-up (and leave in reverse during a
 * strip-down), by role: the atmosphere first (texture, then pad), then the
 * harmony and the tunes (chords, lead, then the sampler part, which carries
 * vocals and chops), then the rhythm section (percussion, bass) and the drums
 * last, so the beat lands as the payoff. Parts with the same role keep their
 * track order.
 */
export const BUILD_ORDER: readonly TrackRole[] = ['texture', 'pad', 'chords', 'lead', 'sampler', 'percussion', 'bass', 'drums'];

/** The parts a breakdown switches off (where they sound). */
export const BREAKDOWN_ROLES: readonly TrackRole[] = ['drums', 'percussion', 'bass'];

/**
 * - 'build': the block is split into its passes and parts come in one at a
 *   time (pass i plays the first ceil((i+1)·k/n) of its k sounding parts);
 * - 'strip': the reverse: every part first, then they drop out one at a time
 *   (the last pass keeps at least one);
 * - 'breakdown': the drums, percussion and bass that sound in the block are
 *   switched off.
 */
export type ShapeKind = 'build' | 'strip' | 'breakdown';

export interface ShapeProblem {
  /** A few words (the menu item's hint). */
  short: string;
  /** The full reason. */
  text: string;
}

/** The parts that sound in a block (a clip plays), in build order. */
export function soundingInBuildOrder(p: Project, b: ArrangementBlock): Id[] {
  const rank = (role: TrackRole) => {
    const i = BUILD_ORDER.indexOf(role);
    return i < 0 ? BUILD_ORDER.length : i;
  };
  const sounding = new Set(blockParts(p, b).filter((x) => x.clip !== null).map((x) => x.trackId));
  return p.tracks
    .map((t, i) => ({ id: t.id, rank: rank(t.role), i }))
    .filter((t) => sounding.has(t.id))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((t) => t.id);
}

/**
 * Which parts play in each pass (pure): for 'build', pass i (0-based) plays
 * the first ceil((i+1)·k/n) of the k parts in `order`; for 'strip', the same
 * sets in reverse pass order.
 */
export function shapePasses(order: readonly Id[], passes: number, kind: 'build' | 'strip'): Id[][] {
  const n = Math.max(1, Math.round(passes));
  const k = order.length;
  const build = Array.from({ length: n }, (_, i) => order.slice(0, Math.ceil(((i + 1) * k) / n)));
  return kind === 'build' ? build : build.reverse();
}

function breakdownParts(p: Project, b: ArrangementBlock): { off: Id[]; left: number } {
  const roles = new Set<TrackRole>(BREAKDOWN_ROLES);
  const sounding = blockParts(p, b).filter((x) => x.clip !== null);
  const off = sounding.filter((x) => roles.has(p.tracks.find((t) => t.id === x.trackId)?.role ?? 'lead')).map((x) => x.trackId);
  return { off, left: sounding.length - off.length };
}

/**
 * Blocks that play `parts` of block `b` for `passes` of its passes: the pass
 * keeps its length in bars (when the parts left are shorter, it plays more
 * often, so the song's timing does not change), split into blocks of at most
 * MAX_BLOCK_REPEATS passes. Null when the parts left cannot fill those bars
 * exactly (a 3-bar clip in a 4-bar pass): whole passes only, and the song
 * must keep its length.
 */
function shapedBlocks(p: Project, b: ArrangementBlock, parts: Record<Id, Id | null>, passes: number, passBars: number): Omit<ArrangementBlock, 'id'>[] | null {
  const draft: ArrangementBlock = { id: b.id, sceneId: b.sceneId, repeats: 1, parts };
  const bars = blockBars(p, draft);
  const total = passes * passBars;
  if (total % bars !== 0) return null;
  let repeats = total / bars;
  const out: Omit<ArrangementBlock, 'id'>[] = [];
  while (repeats > 0) {
    const r = Math.min(MAX_BLOCK_REPEATS, repeats);
    const x: Omit<ArrangementBlock, 'id'> = { sceneId: b.sceneId, repeats: r };
    if (Object.keys(parts).length) x.parts = { ...parts };
    out.push(x);
    repeats -= r;
  }
  return out;
}

/* Helper labels: "Lift · build 1/4" ... "Lift · build 4/4", "Lift · breakdown". */
const HELPER_WORDS: Record<ShapeKind, string> = { build: 'build', strip: 'strip', breakdown: 'breakdown' };
const HELPER_SUFFIX = / · (?:build|strip|breakdown)(?: \d+\/\d+)?$/;
const COUNTER = / \d+\/\d+$/;

/** A block's name as shown in the lane: its label, else its scene's name. */
export function blockDisplayName(p: Project, b: ArrangementBlock): string {
  return b.label || p.scenes.find((s) => s.id === b.sceneId)?.name || 'Block';
}

/** Labels for `n` blocks a helper made from a block named `name` (an earlier helper's suffix is replaced). */
export function helperLabels(name: string, kind: ShapeKind, n: number): string[] {
  const base = name.replace(HELPER_SUFFIX, '') || name;
  return Array.from({ length: n }, (_, i) => {
    const suffix = ` · ${HELPER_WORDS[kind]}${n > 1 ? ` ${i + 1}/${n}` : ''}`;
    return `${base.slice(0, MAX_BLOCK_LABEL - suffix.length).trimEnd()}${suffix}`;
  });
}

/**
 * The blocks that belong together with `label` (song order): those whose name
 * (label, else scene name) is the same, counting a song helper's numbered
 * blocks as one ("Lift · build 2/4" finds "Lift · build 1/4" to "4/4"). Pure;
 * the lane uses it to select a section as one.
 */
export function blocksWithLabel(p: Project, label: string): Id[] {
  const group = (name: string) => name.replace(COUNTER, '');
  const want = group(cleanName(label, MAX_BLOCK_LABEL) ?? '');
  if (!want) return [];
  return p.arrangement.blocks.filter((b) => group(blockDisplayName(p, b)) === want).map((b) => b.id);
}

/**
 * What a song helper makes of block `b` (pure): the blocks that replace it
 * (without ids) and how many parts it shapes; `uneven` names the first part
 * set that cannot fill its passes exactly (the helper is then refused, so the
 * song never changes length behind the user's back).
 */
function shapePlan(p: Project, b: ArrangementBlock, kind: ShapeKind): { shaped: Omit<ArrangementBlock, 'id'>[]; parts: number; uneven: { clipBars: number; passBars: number } | null } {
  const plan = shapePlanParts(p, b, kind);
  if (plan.uneven || !plan.shaped.length) return plan;
  // Named after the block, numbered, so a build-up reads as one section; the block's moves keep their place.
  const labels = helperLabels(blockDisplayName(p, b), kind, plan.shaped.length);
  const shaped = shareMoves(b.moves, plan.shaped.map((x, i) => ({ ...x, label: labels[i] })));
  return { ...plan, shaped };
}

function shapePlanParts(p: Project, b: ArrangementBlock, kind: ShapeKind): { shaped: Omit<ArrangementBlock, 'id'>[]; parts: number; uneven: { clipBars: number; passBars: number } | null } {
  const passBars = blockBars(p, b);
  const base = { ...(b.parts ?? {}) };
  const uneven = (parts: Record<Id, Id | null>) => ({ clipBars: blockBars(p, { id: b.id, sceneId: b.sceneId, repeats: 1, parts }), passBars });
  if (kind === 'breakdown') {
    const { off } = breakdownParts(p, b);
    for (const t of off) base[t] = null;
    const shaped = shapedBlocks(p, b, base, clampRep(b.repeats), passBars);
    return shaped ? { shaped, parts: off.length, uneven: null } : { shaped: [], parts: off.length, uneven: uneven(base) };
  }
  const order = soundingInBuildOrder(p, b);
  const sets = shapePasses(order, clampRep(b.repeats), kind);
  // Neighbouring passes with the same parts are one block.
  const runs: { set: Id[]; passes: number }[] = [];
  for (const s of sets) {
    const last = runs[runs.length - 1];
    if (last && last.set.length === s.length) last.passes += 1;
    else runs.push({ set: s, passes: 1 });
  }
  const shaped: Omit<ArrangementBlock, 'id'>[] = [];
  for (const run of runs) {
    const x = { ...base };
    for (const t of order) if (!run.set.includes(t)) x[t] = null;
    const made = shapedBlocks(p, b, x, run.passes, passBars);
    if (!made) return { shaped: [], parts: order.length, uneven: uneven(x) };
    shaped.push(...made);
  }
  return { shaped, parts: order.length, uneven: null };
}

/** Why a song helper cannot shape a block (a few words and the full reason), or null when it can. */
export function shapeProblem(p: Project, blockId: Id, kind: ShapeKind): ShapeProblem | null {
  const b = p.arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return { short: 'Gone', text: 'That block no longer exists.' };
  return shapeProblemFor(p, b, kind);
}

function shapeProblemFor(p: Project, b: ArrangementBlock, kind: ShapeKind): ShapeProblem | null {
  if (sceneRow(p, b.sceneId) < 0) return { short: 'Scene missing', text: 'The scene this block played was deleted.' };
  if (kind === 'breakdown') {
    const { off, left } = breakdownParts(p, b);
    if (!off.length) return { short: 'No beat or bass', text: 'No drums, percussion or bass play in this block.' };
    if (!left) return { short: 'Nothing left', text: 'Only drums, percussion and bass play here: a breakdown would leave silence.' };
  } else {
    const k = soundingInBuildOrder(p, b).length;
    if (clampRep(b.repeats) < 2) return { short: 'Plays once', text: 'The block plays once: make it play at least 2 times first.' };
    if (k === 0) return { short: 'Nothing plays', text: 'No part plays in this block.' };
    if (k === 1) return { short: 'One part', text: `Only one part plays in this block: there is nothing to ${kind === 'build' ? 'bring in' : 'drop out'} one at a time.` };
  }
  const { uneven } = shapePlan(p, b, kind);
  if (uneven) {
    const lengths = `Its clips have different lengths (${uneven.clipBars} and ${uneven.passBars} bars)`;
    const text =
      kind === 'breakdown'
        ? `${lengths}: without the drums and bass the rest would not fill the block exactly, and the song would change length.`
        : `${lengths}, so the repeats would not line up and the song would change length.`;
    return { short: 'Uneven clips', text };
  }
  return null;
}

/**
 * Shape a block with a song helper (one undo step). Build up and strip down
 * split the block into its passes, switch parts off pass by pass (parts that
 * are silent in the block stay silent) and join neighbouring passes that end
 * up with the same parts again; breakdown switches off the block's sounding
 * drums, percussion and bass. The first resulting block keeps the block's id.
 * Every change is a per-part change, so it shows in the part cells and plays
 * at once. The song keeps its length exactly: when the parts left could not
 * fill a pass (uneven clip lengths), the helper is refused. The new blocks are
 * named after the block and numbered ("Lift · build 1/4" to "4/4",
 * "Lift · breakdown"); its fade in stays on the first, its other moves go to
 * the last.
 */
export function shapeBlock(store: ProjectStore, blockId: Id, kind: ShapeKind): CommandResult & { blockIds?: Id[]; parts?: number } {
  const p = store.getState();
  const i = p.arrangement.blocks.findIndex((b) => b.id === blockId);
  if (i < 0) return NOT_FOUND('block');
  const problem = shapeProblem(p, blockId, kind);
  if (problem) return refuse('invalid', problem.text);
  const b = p.arrangement.blocks[i];
  const { shaped, parts } = shapePlan(p, b, kind);
  if (p.arrangement.blocks.length - 1 + shaped.length > VALIDATION_LIMITS.maxBlocks) return refuse('limit', LIMIT_MESSAGE);
  const out: ArrangementBlock[] = shaped.map((x, j) => ({ ...x, id: j === 0 ? b.id : uid('blk') }));
  const label = kind === 'build' ? 'arrange:Build up' : kind === 'strip' ? 'arrange:Strip down' : 'arrange:Breakdown';
  const r = run(store, label, (d) => {
    const at = d.arrangement.blocks.findIndex((x) => x.id === blockId);
    if (at >= 0) d.arrangement.blocks.splice(at, 1, ...out);
  });
  return { ...r, blockIds: out.map((x) => x.id), parts };
}

/** Effect tail appended to exports, 0–10 seconds. */
export function setTailSeconds(store: ProjectStore, seconds: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(seconds)) return refuse('invalid', 'The tail length must be a number.');
  const v = clamp(seconds, 0, 10);
  return run(store, 'arrange:Change tail length', (d) => {
    d.arrangement.tailSeconds = v;
  }, gesture);
}

/* ------------------------------------------------------------------ */
/* Parts across several blocks                                         */
/* ------------------------------------------------------------------ */

/** "Drums off", "Drums back", "Drums plays Lift": what a part choice does, for undo steps and messages. */
function partChoiceWords(p: Project, trackId: Id, choice: Id | null | undefined): string {
  const name = partName(p, trackId);
  if (choice === null) return `${name} off`;
  if (choice === undefined) return `${name} back`;
  return `${name} plays ${p.scenes.find((s) => s.id === choice)?.name ?? 'another scene'}`;
}

/**
 * What one part plays in several blocks at once (one undo step; Undo says
 * "Drums off in 4 blocks"): a scene id, null (silent) or undefined (follow
 * each block's scene). Blocks where nothing changes are left as they are.
 * Returns how many blocks changed.
 */
export function setBlocksPart(store: ProjectStore, blockIds: readonly Id[], trackId: Id, choice: Id | null | undefined, gesture?: string): CommandResult & { blocks?: number } {
  const p = store.getState();
  const order = inSongOrder(p, blockIds);
  if (!order.length) return NOT_FOUND('block');
  if (!p.tracks.some((t) => t.id === trackId)) return NOT_FOUND('part');
  if (typeof choice === 'string' && !p.scenes.some((s) => s.id === choice)) return NOT_FOUND('scene');
  const changes = new Map<Id, Id | null | undefined>();
  for (const id of order) {
    const b = p.arrangement.blocks.find((x) => x.id === id)!;
    const v = choice === b.sceneId ? undefined : choice;
    const cur = b.parts && Object.prototype.hasOwnProperty.call(b.parts, trackId) ? b.parts[trackId] : undefined;
    if (cur !== v) changes.set(id, v);
  }
  if (!changes.size) return { changed: false, blocks: 0 };
  const where = changes.size === 1 ? `in ${blockDisplayName(p, p.arrangement.blocks.find((b) => changes.has(b.id))!)}` : `in ${changes.size} blocks`;
  const r = run(store, 'arrange:Change part in blocks', (d) => {
    for (const x of d.arrangement.blocks) {
      if (!changes.has(x.id)) continue;
      const v = changes.get(x.id);
      const parts = { ...(x.parts ?? {}) };
      if (v === undefined) delete parts[trackId];
      else parts[trackId] = v;
      if (Object.keys(parts).length) x.parts = parts;
      else delete x.parts;
    }
  }, gesture, { display: `${partChoiceWords(p, trackId, choice)} ${where}` });
  return { ...r, blocks: changes.size };
}

/**
 * Switch a part off in every block of the song where it plays (`on` false),
 * or bring it back everywhere it was switched off (`on` true; clips layered
 * in from other scenes stay). One undo step ("Drums off everywhere").
 */
export function setPartEverywhere(store: ProjectStore, trackId: Id, on: boolean): CommandResult & { blocks?: number } {
  const p = store.getState();
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return NOT_FOUND('part');
  if (!p.arrangement.blocks.length) return refuse('empty', 'The song has no blocks yet.');
  const isOff = (b: ArrangementBlock) => !!b.parts && Object.prototype.hasOwnProperty.call(b.parts, trackId) && b.parts[trackId] === null;
  const plays = (b: ArrangementBlock) => sceneRow(p, b.sceneId) >= 0 && blockPart(p, b, track).clip !== null;
  const touched = p.arrangement.blocks.filter((b) => (on ? isOff(b) : plays(b))).map((b) => b.id);
  if (!touched.length) return { changed: false, blocks: 0 };
  const set = new Set(touched);
  const name = partName(p, trackId);
  const r = run(store, 'arrange:Change part everywhere', (d) => {
    for (const x of d.arrangement.blocks) {
      if (!set.has(x.id)) continue;
      const parts = { ...(x.parts ?? {}) };
      if (on) delete parts[trackId];
      else parts[trackId] = null;
      if (Object.keys(parts).length) x.parts = parts;
      else delete x.parts;
    }
  }, undefined, { display: on ? `${name} back on everywhere` : `${name} off everywhere` });
  return { ...r, blocks: touched.length };
}

/* ------------------------------------------------------------------ */
/* A recorded take as song blocks                                      */
/* ------------------------------------------------------------------ */

export interface TakeBlocksPlan {
  /** The blocks, in order. */
  blocks: BlockTemplate[];
  /** Some stretch did not fill whole passes of its scene (it was rounded, or left out when under half a pass). */
  rounded: boolean;
  /** What a block cannot hold and was left out: played notes, and knob, macro, mute, tempo, swing and volume moves. */
  ignored: { notes: number; knobs: number };
  /**
   * Scenes the take launched that have been deleted since (their names as the
   * take knew them): what played them was left out (a stretch of such a scene
   * makes no block; a part playing one counts as off).
   */
  deletedScenes: string[];
}

const KNOB_EVENTS = new Set(['macro', 'param', 'mute', 'tempo', 'swing', 'master']);

/**
 * How a recorded take becomes song blocks (pure). The take's scene launches,
 * pad launches and Stop All mark stretches; each stretch becomes a block of
 * the scene launched last (before the first launch, the row most parts were
 * playing), and a part that plays something else there becomes a part change:
 * another row's clip layered in, or switched off. Neighbouring stretches with
 * the same material are one block. A stretch plays whole passes of its
 * block, rounded from the take's timing (shorter than half a pass: left out),
 * and silence is left out. The take's snapshot gives only the timing and which
 * scene (by id) was launched; the blocks play the project's clips as they are
 * now. A scene deleted since is left out and named in `deletedScenes`. Null
 * when there is no such take.
 */
export function takeToBlocks(p: Project, takeId: Id): TakeBlocksPlan | null {
  const perf = p.performances.find((x) => x.id === takeId);
  if (!perf) return null;
  const snap = perf.snapshot;
  const start = perf.startTick;
  const end = perf.endTick;
  const ignored = { notes: 0, knobs: 0 };
  for (const e of perf.events) {
    if (e.t < start || e.t >= end) continue;
    if (e.type === 'noteOn') ignored.notes++;
    else if (KNOB_EVENTS.has(e.type)) ignored.knobs++;
  }

  // The scene of a row of the take, as the project has it now (by id: rows may have moved since).
  // A scene deleted since is left out and reported, never guessed by position.
  const deleted = new Set<string>();
  const sceneOfRow = (row: number): Id | null => {
    const s = snap.scenes[row];
    if (!s) return null;
    if (p.scenes.some((x) => x.id === s.id)) return s.id;
    deleted.add(s.name);
    return null;
  };
  const playing = new Map<Id, number | null>(snap.tracks.map((t) => [t.id, null]));
  for (const e of snap.launcher) if (playing.has(e.trackId)) playing.set(e.trackId, e.playing ? e.playing.slot : null);
  const rowCount = (row: number) => [...playing.values()].filter((v) => v === row).length;
  // Before any scene launch, the take's "scene" is the row most parts play (the first such row on a tie).
  let mainRow: number | null = null;
  for (let row = 0; row < snap.scenes.length; row++) if (rowCount(row) > 0 && (mainRow === null || rowCount(row) > rowCount(mainRow))) mainRow = row;

  type Stretch = { from: number; to: number; template: BlockTemplate | null };
  const stretches: Stretch[] = [];
  const templateNow = (): BlockTemplate | null => {
    if (mainRow === null) return null;
    const sceneId = sceneOfRow(mainRow);
    if (!sceneId) return null;
    const row = sceneRow(p, sceneId);
    const parts: Record<Id, Id | null> = {};
    let sounds = false;
    for (const t of p.tracks) {
      const slot = playing.get(t.id) ?? null;
      const plays = slot === null ? null : sceneOfRow(slot);
      if (plays === sceneId) {
        if (t.clips[row]) sounds = true;
      } else if (plays) {
        // Another row's clip: layered in.
        parts[t.id] = plays;
        if (t.clips[sceneRow(p, plays)]) sounds = true;
      } else if (t.clips[row]) {
        // Stopped (or playing a scene deleted since) while the scene has a clip for it: off here.
        parts[t.id] = null;
      }
    }
    if (!sounds) return null;
    return Object.keys(parts).length ? { sceneId, repeats: 1, parts } : { sceneId, repeats: 1 };
  };

  const changes = perf.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (e.type === 'launch' || e.type === 'scene' || e.type === 'stopAll') && e.atTick >= start && e.atTick < end)
    .sort((a, b) => ((a.e as { atTick: number }).atTick - (b.e as { atTick: number }).atTick) || a.i - b.i);
  let from = start;
  let k = 0;
  while (from < end) {
    // Everything that lands at `from` applies before the stretch starts.
    while (k < changes.length && (changes[k].e as { atTick: number }).atTick <= from) {
      const e = changes[k].e;
      if (e.type === 'scene') {
        mainRow = e.row;
        for (const t of snap.tracks) playing.set(t.id, t.clips[e.row] ? e.row : null);
      } else if (e.type === 'stopAll') {
        for (const id of playing.keys()) playing.set(id, null);
      } else if (e.type === 'launch' && playing.has(e.trackId)) {
        playing.set(e.trackId, e.slot);
      }
      k++;
    }
    const to = k < changes.length ? Math.min(end, (changes[k].e as { atTick: number }).atTick) : end;
    stretches.push({ from, to, template: templateNow() });
    from = to;
  }

  // Neighbours with the same material are one stretch.
  const same = (a: BlockTemplate | null, b: BlockTemplate | null) =>
    a === b || (!!a && !!b && sameMaterial({ id: '', sceneId: a.sceneId, repeats: 1, parts: a.parts }, { id: '', sceneId: b.sceneId, repeats: 1, parts: b.parts }));
  const merged: Stretch[] = [];
  for (const st of stretches) {
    const last = merged[merged.length - 1];
    if (last && same(last.template, st.template)) last.to = st.to;
    else merged.push({ ...st });
  }

  const blocks: BlockTemplate[] = [];
  let rounded = false;
  for (const st of merged) {
    if (!st.template) {
      // Silence (nothing playing) has no block; the song simply goes on.
      continue;
    }
    const bars = (st.to - st.from) / TICKS_PER_BAR;
    const pass = blockBars(p, { id: '', sceneId: st.template.sceneId, repeats: 1, parts: st.template.parts });
    let passes = Math.round(bars / pass);
    if (Math.abs(passes * pass - bars) > 1e-6) rounded = true;
    while (passes > 0) {
      const r = Math.min(MAX_BLOCK_REPEATS, passes);
      blocks.push({ ...st.template, ...(st.template.parts ? { parts: { ...st.template.parts } } : {}), repeats: r });
      passes -= r;
    }
  }
  return { blocks, rounded, ignored, deletedScenes: [...deleted] };
}

/**
 * "Make song blocks" from a recorded take (see takeToBlocks), in one undo
 * step: 'append' adds them after the song, 'replace' makes them the song.
 * Returns the new blocks' ids, whether timing was rounded and what was left
 * out, so the message can say so.
 */
export function makeSongFromTake(
  store: ProjectStore,
  takeId: Id,
  opts: { mode: 'append' | 'replace' },
): CommandResult & { blockIds?: Id[]; rounded?: boolean; ignored?: { notes: number; knobs: number }; deletedScenes?: string[] } {
  const p = store.getState();
  const plan = takeToBlocks(p, takeId);
  if (!plan) return NOT_FOUND('performance');
  if (!plan.blocks.length) {
    const why = plan.deletedScenes.length ? `the scenes it played (${plan.deletedScenes.join(', ')}) were deleted` : 'nothing played long enough to fill a pass';
    return { ...refuse('empty', `This take makes no song blocks: ${why}.`), rounded: plan.rounded, ignored: plan.ignored, deletedScenes: plan.deletedScenes };
  }
  const replace = opts.mode === 'replace';
  if ((replace ? 0 : p.arrangement.blocks.length) + plan.blocks.length > VALIDATION_LIMITS.maxBlocks) return refuse('limit', LIMIT_MESSAGE);
  const blocks = plan.blocks.map((t) => fromTemplate(p, t));
  const r = run(store, 'arrange:Make song blocks', (d) => {
    if (replace) d.arrangement.blocks = blocks;
    else d.arrangement.blocks.push(...blocks);
  });
  return { ...r, blockIds: blocks.map((b) => b.id), rounded: plan.rounded, ignored: plan.ignored, deletedScenes: plan.deletedScenes };
}

/* ------------------------------------------------------------------ */
/* An intro and an ending                                              */
/* ------------------------------------------------------------------ */

/** Seconds of echo tail an added ending makes sure of (when the tail was off). */
export const ENDING_TAIL_SECONDS = 2;

/** A new block of `sceneId` shaped by a helper (build or strip), with one pass per part (2 to 4). */
function shapedSceneBlocks(p: Project, sceneId: Id, kind: 'build' | 'strip'): { blocks: ArrangementBlock[] } | { problem: string } {
  const probe: ArrangementBlock = { id: uid('blk'), sceneId, repeats: MAX_BLOCK_REPEATS };
  const k = soundingInBuildOrder(p, probe).length;
  const block: ArrangementBlock = { ...probe, repeats: clamp(k, 2, 4) };
  const problem = shapeProblemFor(p, block, kind);
  if (problem) return { problem: problem.text };
  const { shaped } = shapePlan(p, block, kind);
  return { blocks: shaped.map((x, j) => ({ ...x, id: j === 0 ? block.id : uid('blk') })) };
}

/**
 * "Add an intro": a Build up of the scene the song starts with (the first
 * scene when the song is empty), inserted at the start, its parts coming in
 * one at a time. One undo step.
 */
export function addIntro(store: ProjectStore): CommandResult & { blockIds?: Id[] } {
  const p = store.getState();
  const sceneId = p.arrangement.blocks[0]?.sceneId ?? p.scenes[0]?.id;
  if (!sceneId) return NOT_FOUND('scene');
  const made = shapedSceneBlocks(p, sceneId, 'build');
  if ('problem' in made) return refuse('invalid', made.problem);
  if (p.arrangement.blocks.length + made.blocks.length > VALIDATION_LIMITS.maxBlocks) return refuse('limit', LIMIT_MESSAGE);
  const r = run(store, 'arrange:Add an intro', (d) => {
    d.arrangement.blocks.splice(0, 0, ...made.blocks);
  });
  return { ...r, blockIds: made.blocks.map((b) => b.id) };
}

/**
 * "Add an ending": a Strip down of the scene the song ends with (the last
 * scene when the song is empty), appended, its parts dropping out one at a
 * time; an Echo tail of 0 s becomes ENDING_TAIL_SECONDS so the end rings out.
 * One undo step.
 */
export function addEnding(store: ProjectStore): CommandResult & { blockIds?: Id[] } {
  const p = store.getState();
  const sceneId = p.arrangement.blocks[p.arrangement.blocks.length - 1]?.sceneId ?? p.scenes[p.scenes.length - 1]?.id;
  if (!sceneId) return NOT_FOUND('scene');
  const made = shapedSceneBlocks(p, sceneId, 'strip');
  if ('problem' in made) return refuse('invalid', made.problem);
  if (p.arrangement.blocks.length + made.blocks.length > VALIDATION_LIMITS.maxBlocks) return refuse('limit', LIMIT_MESSAGE);
  const r = run(store, 'arrange:Add an ending', (d) => {
    d.arrangement.blocks.push(...made.blocks);
    if (d.arrangement.tailSeconds === 0) d.arrangement.tailSeconds = ENDING_TAIL_SECONDS;
  });
  return { ...r, blockIds: made.blocks.map((b) => b.id) };
}

/* ------------------------------------------------------------------ */
/* Song moves                                                          */
/* ------------------------------------------------------------------ */

/**
 * Set a block's song moves (one undo step): at most one of each kind (the
 * first wins), parts limited to existing parts. An empty list removes them.
 * Moves already on the block keep their ids.
 */
export function setBlockMoves(store: ProjectStore, blockId: Id, moves: readonly (BlockMoveTemplate & { id?: Id })[]): CommandResult {
  const p = store.getState();
  const b = p.arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return NOT_FOUND('block');
  if (!Array.isArray(moves)) return refuse('invalid', 'The song moves could not be read.');
  const unknown = moves.find((m) => !m || !BLOCK_MOVE_KINDS.includes(m.kind));
  if (unknown) return refuse('invalid', 'That is not a song move.');
  const own = new Map((b.moves ?? []).map((m) => [m.kind, m.id]));
  const next = cleanMoves(p, moves.map((m) => ({ ...m, id: own.get(m.kind) })), true);
  const same = (b.moves ?? []).length === next.length && next.every((m, i) => {
    const o = b.moves![i];
    return o.id === m.id && o.kind === m.kind && JSON.stringify(o.parts ?? null) === JSON.stringify(m.parts ?? null);
  });
  if (same) return { changed: false };
  return run(store, 'arrange:Change song moves', (d) => {
    const x = d.arrangement.blocks.find((y) => y.id === blockId);
    if (!x) return;
    if (next.length) x.moves = next;
    else delete x.moves;
  });
}

/**
 * Add a move of `kind` to a block, or remove it when the block has one (one
 * undo step, "Add Fade in" / "Remove Fade in"). `parts` (filter rise, echo
 * throw) lists the parts it acts on; left out: every melodic part.
 */
export function toggleBlockMove(store: ProjectStore, blockId: Id, kind: BlockMoveKind, parts?: readonly Id[]): CommandResult & { on?: boolean } {
  const p = store.getState();
  const b = p.arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return NOT_FOUND('block');
  if (!BLOCK_MOVE_KINDS.includes(kind)) return refuse('invalid', 'That is not a song move.');
  const has = (b.moves ?? []).some((m) => m.kind === kind);
  const next = has ? (b.moves ?? []).filter((m) => m.kind !== kind) : [...(b.moves ?? []), ...cleanMoves(p, [{ kind, ...(parts ? { parts: [...parts] } : {}) }], false)];
  const r = run(store, 'arrange:Change song moves', (d) => {
    const x = d.arrangement.blocks.find((y) => y.id === blockId);
    if (!x) return;
    if (next.length) x.moves = next;
    else delete x.moves;
  }, undefined, { display: `${has ? 'Remove' : 'Add'} ${BLOCK_MOVE_NAMES[kind]}` });
  return { ...r, on: !has };
}
