/**
 * What the song lane shows, derived from the project (pure: no DOM, no
 * React). Built on project/arrangement.ts, the same helpers playback and
 * export read, so a cell that says "plays" is a part that sounds.
 */
import { blockBars, blockParts, sceneRow } from '../../../project/arrangement';
import { MAX_BLOCK_REPEATS, type ArrangementBlock, type Id, type Project } from '../../../project/types';

/**
 * How one part sounds in one block:
 * - 'scene': plays the block's scene clip;
 * - 'layer': plays another scene's clip (layered in);
 * - 'off': switched off in this block;
 * - 'empty': follows the block's scene, which has no clip for this part (silent).
 */
export type CellKind = 'scene' | 'layer' | 'off' | 'empty';

export interface CellView {
  trackId: Id;
  partName: string;
  kind: CellKind;
  /** Name of the clip that plays, or null when the part is silent. */
  clipName: string | null;
  /** Scene the clip comes from when layered in (its name), else null. */
  fromScene: string | null;
  /** The block's own scene has a clip for this part. */
  sceneHasClip: boolean;
}

export interface BlockView {
  id: Id;
  index: number;
  sceneId: Id;
  sceneName: string;
  /** Scene row, or -1 when the scene no longer exists (the song skips the block). */
  row: number;
  label: string | null;
  /** What the block is called: its label, else its scene's name. */
  name: string;
  /** Bars of one pass (the longest clip the block plays); 0 when skipped. */
  passBars: number;
  repeats: number;
  totalBars: number;
  missing: boolean;
  cells: CellView[];
  /** Parts that differ from the block's scene (layered or switched off). */
  changes: number;
}

export function blockView(p: Project, b: ArrangementBlock, index: number): BlockView {
  const row = sceneRow(p, b.sceneId);
  const scene = row >= 0 ? p.scenes[row] : null;
  const missing = !scene;
  const sceneName = scene ? scene.name : 'Missing scene';
  const parts = missing ? null : blockParts(p, b);
  const cells: CellView[] = p.tracks.map((t, i) => {
    const sceneHasClip = row >= 0 && !!t.clips[row];
    const part = parts?.[i];
    if (!part) return { trackId: t.id, partName: t.name, kind: 'empty', clipName: null, fromScene: null, sceneHasClip };
    if (part.kind === 'off') return { trackId: t.id, partName: t.name, kind: 'off', clipName: null, fromScene: null, sceneHasClip };
    if (part.kind === 'layer') {
      const from = p.scenes[part.row ?? -1]?.name ?? 'another scene';
      return { trackId: t.id, partName: t.name, kind: 'layer', clipName: part.clip?.name ?? null, fromScene: from, sceneHasClip };
    }
    return { trackId: t.id, partName: t.name, kind: part.clip ? 'scene' : 'empty', clipName: part.clip?.name ?? null, fromScene: null, sceneHasClip };
  });
  const passBars = missing ? 0 : blockBars(p, b);
  const repeats = Math.min(MAX_BLOCK_REPEATS, Math.max(1, Math.round(b.repeats) || 1));
  return {
    id: b.id,
    index,
    sceneId: b.sceneId,
    sceneName,
    row,
    label: b.label ?? null,
    name: b.label || sceneName,
    passBars,
    repeats,
    totalBars: passBars * repeats,
    missing,
    cells,
    changes: cells.filter((c) => c.kind === 'layer' || c.kind === 'off').length,
  };
}

export function laneBlocks(p: Project): BlockView[] {
  return p.arrangement.blocks.map((b, i) => blockView(p, b, i));
}

/** Structural identity of a block view (for keeping unchanged views stable between renders). */
export function viewKey(v: BlockView): string {
  return JSON.stringify(v);
}

export function barsText(bars: number): string {
  return bars === 1 ? '1 bar' : `${bars} bars`;
}

export function passesText(n: number): string {
  return n === 1 ? '1 pass' : `${n} passes`;
}

/** "16 bars (4 × 4)": the length with how it is made. */
export function lengthDetail(v: BlockView): string {
  return `${barsText(v.totalBars)} (${v.passBars} × ${v.repeats})`;
}

/** Accessible name of a block. */
export function blockLabel(v: BlockView, count: number, opts: { current?: boolean; selected?: boolean } = {}): string {
  if (v.missing) return `Block ${v.index + 1} of ${count}: its scene no longer exists, so the song skips it${opts.selected ? ', selected' : ''}`;
  const named = v.label ? `${v.label} (scene ${v.sceneName})` : v.name;
  const changes = v.changes ? `, ${v.changes === 1 ? '1 part changed' : `${v.changes} parts changed`}` : '';
  return `Block ${v.index + 1} of ${count}: ${named}, ${barsText(v.passBars)} × ${v.repeats} = ${barsText(v.totalBars)}${changes}${opts.current ? ', playing now' : ''}${opts.selected ? ', selected' : ''}`;
}

/** What a cell says, in words (its accessible name and tooltip). */
export function cellState(c: CellView): string {
  switch (c.kind) {
    case 'scene':
      return `plays “${c.clipName}”`;
    case 'layer':
      return `plays “${c.clipName ?? 'nothing'}” from ${c.fromScene}`;
    case 'off':
      return 'off';
    case 'empty':
      return 'silent, no clip in this scene';
  }
}

export function cellLabel(v: BlockView, c: CellView): string {
  return `${c.partName} in ${v.name} (block ${v.index + 1}): ${cellState(c)}`;
}

/** Whether a cell counts as "playing" (aria-pressed). */
export function cellOn(c: CellView): boolean {
  return c.kind === 'scene' || c.kind === 'layer';
}

/**
 * What clicking a cell does: switch a sounding part off (null), switch an
 * off part back to the block's scene (undefined) when that scene has a clip
 * for it; otherwise there is nothing to switch, so the part picker opens.
 */
export function cellToggle(c: CellView): { choice: Id | null | undefined } | 'picker' {
  if (c.kind === 'scene' || c.kind === 'layer') return { choice: null };
  if (c.kind === 'off' && c.sceneHasClip) return { choice: undefined };
  return 'picker';
}

export interface PartChoice {
  key: string;
  /** setBlockPart choice: undefined = follow the block's scene, a scene id, or null = off. */
  choice: Id | null | undefined;
  label: string;
  hint?: string;
  checked: boolean;
}

/** The part picker for one part of one block: the scene's own clip, every other scene with a clip for it, or Off. */
export function partChoices(p: Project, b: ArrangementBlock, trackId: Id): PartChoice[] {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  const row = sceneRow(p, b.sceneId);
  const scene = row >= 0 ? p.scenes[row] : null;
  const has = b.parts !== undefined && Object.prototype.hasOwnProperty.call(b.parts, trackId);
  const cur = has ? b.parts![trackId] : undefined;
  const curLayer = typeof cur === 'string' && cur !== b.sceneId && sceneRow(p, cur) >= 0 ? cur : undefined;
  const out: PartChoice[] = [];
  const own = scene ? track.clips[row] : null;
  out.push({
    key: 'scene',
    choice: undefined,
    label: `${scene?.name ?? 'Block scene'}: ${own ? own.name : 'no clip (silent)'}`,
    hint: 'default',
    checked: cur === undefined || (typeof cur === 'string' && !curLayer),
  });
  p.scenes.forEach((s, r) => {
    if (s.id === b.sceneId) return;
    const clip = track.clips[r];
    if (!clip) return;
    out.push({ key: s.id, choice: s.id, label: `${s.name}: ${clip.name}`, hint: barsText(clip.bars), checked: curLayer === s.id });
  });
  out.push({ key: 'off', choice: null, label: 'Off in this block', checked: cur === null });
  return out;
}

export interface LayerPreview {
  sceneName: string;
  /** Parts that would change, with the clip they would play. */
  changes: Map<Id, string>;
}

/**
 * What layering scene `sceneId` into block `b` would change (mirrors the
 * layerScene command): every part with a clip in that scene plays it here.
 */
export function layerPreview(p: Project, b: ArrangementBlock, sceneId: Id): LayerPreview {
  const row = sceneRow(p, sceneId);
  const changes = new Map<Id, string>();
  const sceneName = p.scenes[row]?.name ?? 'scene';
  if (row < 0) return { sceneName, changes };
  for (const t of p.tracks) {
    const clip = t.clips[row];
    if (!clip) continue;
    const has = b.parts !== undefined && Object.prototype.hasOwnProperty.call(b.parts, t.id);
    const cur = has ? b.parts![t.id] : undefined;
    const want = sceneId === b.sceneId ? undefined : sceneId;
    if (cur === want) continue;
    changes.set(t.id, clip.name);
  }
  return { sceneName, changes };
}
