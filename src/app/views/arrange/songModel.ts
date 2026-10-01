/**
 * What the song lane shows, derived from the project (pure: no DOM, no
 * React). Built on project/arrangement.ts, the same helpers playback and
 * export read, so a cell that says "plays" is a part that sounds.
 */
import { blockBars, blockParts, sceneRow } from '../../../project/arrangement';
import { MAX_BLOCK_REPEATS, type ArrangementBlock, type Id, type Project } from '../../../project/types';
import { layerChanges, type LayerMode } from '../../../state/commands/arrangement';

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

/** The edge-drag bubble: "3 passes · 12 bars" (Advanced adds how it is made: "(4 × 3)"). */
export function resizeText(passBars: number, repeats: number, advanced = false): string {
  return `${passesText(repeats)} · ${barsText(passBars * repeats)}${advanced ? ` (${passBars} × ${repeats})` : ''}`;
}

/** "16 bars (4 × 4)": the length with how it is made. */
export function lengthDetail(v: BlockView): string {
  return `${barsText(v.totalBars)} (${v.passBars} × ${v.repeats})`;
}

/** Accessible name of a block. */
export function blockLabel(v: BlockView, count: number, opts: { current?: boolean; next?: boolean; selected?: boolean } = {}): string {
  if (v.missing) return `Block ${v.index + 1} of ${count}: its scene no longer exists, so the song skips it${opts.selected ? ', selected' : ''}`;
  const named = v.label ? `${v.label} (scene ${v.sceneName})` : v.name;
  const changes = v.changes ? `, ${v.changes === 1 ? '1 part changed' : `${v.changes} parts changed`}` : '';
  const now = opts.current ? ', playing now' : opts.next ? ', plays next' : '';
  return `Block ${v.index + 1} of ${count}: ${named}, ${barsText(v.passBars)} × ${v.repeats} = ${barsText(v.totalBars)}${changes}${now}${opts.selected ? ', selected' : ''}`;
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
  mode: LayerMode;
  /** The card's scene is the block's own scene: dropping it does nothing. */
  same: boolean;
  /** Parts that would change, with the clip they would play. */
  changes: Map<Id, string>;
  /** How many parts 'replace' would change (to say what Shift would do). */
  replaceCount: number;
}

/**
 * What layering scene `sceneId` into block `b` would change (exactly the
 * parts the layerScene command changes in that mode).
 */
export function layerPreview(p: Project, b: ArrangementBlock, sceneId: Id, mode: LayerMode = 'fill'): LayerPreview {
  const row = sceneRow(p, sceneId);
  const changes = new Map<Id, string>();
  const sceneName = p.scenes[row]?.name ?? 'scene';
  const same = sceneId === b.sceneId;
  if (row < 0 || same) return { sceneName, mode, same, changes, replaceCount: 0 };
  for (const id of layerChanges(p, b, sceneId, mode)) {
    const clip = p.tracks.find((t) => t.id === id)?.clips[row];
    if (clip) changes.set(id, clip.name);
  }
  const replaceCount = mode === 'replace' ? changes.size : layerChanges(p, b, sceneId, 'replace').length;
  return { sceneName, mode, same, changes, replaceCount };
}

/**
 * What dropping a scene card on a block says (the block header and the
 * card under the pointer), and whether the drop would change anything.
 */
export function layerText(preview: LayerPreview, blockName: string): { title: string; hint: string | null; changes: boolean } {
  const { sceneName: scene, mode, same, changes, replaceCount } = preview;
  if (same) return { title: `${blockName} already plays ${scene}`, hint: 'Drop between blocks to add another one', changes: false };
  if (mode === 'replace') {
    if (changes.size) return { title: `Replace ${blockName}’s parts with ${scene}’s`, hint: `${partsCount(changes.size)} · release Shift to fill only silent parts`, changes: true };
    return { title: `${scene} adds nothing new to ${blockName}`, hint: null, changes: false };
  }
  if (changes.size) return { title: `Layer ${scene} into ${blockName}`, hint: replaceCount > changes.size ? `Fills ${partsCount(changes.size)} · Shift replaces ${partsCount(replaceCount)}` : `Fills ${partsCount(changes.size)}`, changes: true };
  if (replaceCount) return { title: `Nothing silent to fill in ${blockName}`, hint: `Hold Shift to replace ${partsCount(replaceCount)} with ${scene}’s`, changes: false };
  return { title: `${scene} adds nothing new to ${blockName}`, hint: null, changes: false };
}

function partsCount(n: number): string {
  return n === 1 ? '1 part' : `${n} parts`;
}

/* ------------------------------------------------------------------ */
/* Part cells: what a click does, and what it says it did              */
/* ------------------------------------------------------------------ */

/** The tooltip of a part cell: what a click on it does. */
export function cellTip(v: Pick<BlockView, 'name'>, c: CellView): string {
  const t = cellToggle(c);
  if (t === 'picker') return `Click: choose what ${c.partName} plays in ${v.name}`;
  return t.choice === null ? `Click: switch ${c.partName} off in this block` : `Click: switch ${c.partName} back on in this block`;
}

/** The toast after a cell click ("Drums off in Groove"). */
export function cellToast(part: string, block: string, choice: Id | null | undefined, from: string | null): string {
  if (choice === null) return `${part} off in ${block}`;
  if (choice === undefined) return `${part} back on in ${block}`;
  return `${part} plays ${from ?? 'another scene'} in ${block}`;
}
