/**
 * What a song block plays (pure: no DOM, no audio).
 *
 * A block plays its scene's row on every part, except where `block.parts`
 * says otherwise: a part can play the clip of another scene's row (layered
 * in) or be silent. The playback plan, the export, the Arrange lane and the
 * part cells all read these helpers, so what is drawn is what plays.
 */
import { MAX_BLOCK_REPEATS, type ArrangementBlock, type Clip, type Id, type Project, type Track } from './types';

/** Where one part of a block gets its clip from. */
export type PartSourceKind = 'scene' | 'layer' | 'off';

export interface BlockPart {
  trackId: Id;
  /**
   * 'scene': follows the block's scene (default); 'layer': plays another
   * scene's clip; 'off': silenced in this block.
   */
  kind: PartSourceKind;
  /** Scene row whose slot this part plays, or null when it is silent. */
  row: number | null;
  /** Scene the clip comes from (null when silent by choice). */
  sceneId: Id | null;
  /** The clip that plays, or null (silent: switched off, or no clip in that row). */
  clip: Clip | null;
}

export function clampRepeats(r: unknown): number {
  return typeof r === 'number' && Number.isFinite(r) ? Math.min(MAX_BLOCK_REPEATS, Math.max(1, Math.round(r))) : 1;
}

/** Row of a scene id, or -1. */
export function sceneRow(project: Project, sceneId: Id): number {
  return project.scenes.findIndex((s) => s.id === sceneId);
}

/** How one part plays in a block (the block's scene must exist: callers skip blocks whose scene is missing). */
export function blockPart(project: Project, block: ArrangementBlock, track: Track, blockRow = sceneRow(project, block.sceneId)): BlockPart {
  const parts = block.parts;
  const has = parts !== undefined && Object.prototype.hasOwnProperty.call(parts, track.id);
  const choice = has ? parts![track.id] : undefined;
  if (choice === null) return { trackId: track.id, kind: 'off', row: null, sceneId: null, clip: null };
  if (choice !== undefined && choice !== block.sceneId) {
    const row = sceneRow(project, choice);
    // A layer whose scene was deleted falls back to the block's scene.
    if (row >= 0) return { trackId: track.id, kind: 'layer', row, sceneId: choice, clip: track.clips[row] ?? null };
  }
  return { trackId: track.id, kind: 'scene', row: blockRow < 0 ? null : blockRow, sceneId: block.sceneId, clip: blockRow < 0 ? null : (track.clips[blockRow] ?? null) };
}

/** Every part of a block, in track order. */
export function blockParts(project: Project, block: ArrangementBlock): BlockPart[] {
  const row = sceneRow(project, block.sceneId);
  return project.tracks.map((t) => blockPart(project, block, t, row));
}

/**
 * Rows each part plays in a block, for the parts that differ from the block's
 * scene row (null = silent). Parts not listed play the scene row.
 */
export function blockRowOverrides(project: Project, block: ArrangementBlock): Record<Id, number | null> {
  const out: Record<Id, number | null> = {};
  if (!block.parts) return out;
  const row = sceneRow(project, block.sceneId);
  for (const t of project.tracks) {
    const p = blockPart(project, block, t, row);
    if (p.kind !== 'scene') out[t.id] = p.row;
  }
  return out;
}

/**
 * Length of one pass of a block in bars: the longest clip the block actually
 * plays (at least 1). Without per-part changes this equals the scene's length.
 */
export function blockBars(project: Project, block: ArrangementBlock): number {
  const row = sceneRow(project, block.sceneId);
  let bars = 1;
  for (const t of project.tracks) {
    const c = blockPart(project, block, t, row).clip;
    if (c && c.bars > bars) bars = c.bars;
  }
  return bars;
}

/** Number of parts that make a sound in a block. */
export function soundingParts(project: Project, block: ArrangementBlock): number {
  return blockParts(project, block).filter((p) => p.clip !== null).length;
}

/** Same scene and the same per-part changes: two neighbours that can be joined into one block. */
export function sameMaterial(a: ArrangementBlock, b: ArrangementBlock): boolean {
  if (a.sceneId !== b.sceneId) return false;
  const pa = a.parts ?? {};
  const pb = b.parts ?? {};
  const ka = Object.keys(pa);
  const kb = Object.keys(pb);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(pb, k) && pb[k] === pa[k]);
}
