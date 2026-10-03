/**
 * The Song view's drag rules (pure: no DOM, no React).
 *
 * A drag never writes to the project until it is let go. While it runs, the
 * song as it would be after the drop is worked out here with the same rules
 * the commands use (project/arrangement.ts) on a copy of the regions, and the
 * view draws only the difference: the regions that would change are hidden
 * and drawn again as they would end up (carved, started later, gone), with
 * the dragged ones on top. So what the preview shows is what the drop makes.
 *
 * - Move: the pointer's travel in whole bars (snapped to the nearest bar
 *   line), along the region's own row; Alt or Ctrl (⌘) at the drop copies.
 * - Edges: the right edge sets the length (the clip repeats to fill it), the
 *   left edge trims or extends the start (the music stays in place in time).
 * - Drops from the loop browser: a scene (every part with a clip in that row)
 *   or one part's loop, from the bar under the pointer.
 * - Touches: where a dragged edge lands exactly on a neighbour's edge, the
 *   view flashes both ("snapped together").
 */
import {
  clampMove,
  clipBarsOf,
  moveRegions,
  placeRegions,
  placeSection,
  regionEnd,
  resizeRegions,
  sceneRegions,
  sectionRegions,
  type Edge,
  type NewId,
} from '../../../project/arrangement';
import { MAX_SONG_BARS, type Id, type Project, type SongRegion, type SongSection } from '../../../project/types';

/** Pointer travel (px) before a press on a region, an edge or the ruler becomes a drag. */
export const DRAG_SLOP_PX = 4;

/** Ids for regions a preview makes (a carve's second piece, a copy). Never stored. */
export function previewIds(prefix = 'preview'): NewId {
  let n = 0;
  return () => `${prefix}:${++n}`;
}

/** Whole bars for a pointer travel of `dx` px (nearest bar line). */
export function barsMoved(dx: number, pxPerBar: number): number {
  return Math.round(dx / Math.max(1e-6, pxPerBar));
}

/** The copy key is held (Alt, or Ctrl / ⌘). */
export function copyKey(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.altKey || e.ctrlKey || e.metaKey;
}

/**
 * The pointer has left the dragged region's row by more than a row's height
 * (the view shows "not allowed": parts keep their own loops, so the drop
 * still lands on the region's own row).
 */
export function offRow(y: number, rowTop: number, rowH: number): boolean {
  return y < rowTop - rowH || y > rowTop + 2 * rowH;
}

function sameRegion(a: SongRegion, b: SongRegion): boolean {
  return a === b || (a.trackId === b.trackId && a.clipId === b.clipId && a.start === b.start && a.bars === b.bars && a.offset === b.offset);
}

/** What changes between two lists of regions: those now drawn that would change or go, and what would be drawn instead. */
export function diffRegions(before: readonly SongRegion[], after: readonly SongRegion[]): { hidden: Id[]; shown: SongRegion[] } {
  const was = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  const hidden = before.filter((r) => {
    const a = now.get(r.id);
    return !a || !sameRegion(a, r);
  });
  const shown = after.filter((a) => {
    const b = was.get(a.id);
    return !b || !sameRegion(a, b);
  });
  return { hidden: hidden.map((r) => r.id), shown };
}

/** A place where two regions of a part meet edge to edge. */
export interface Touch {
  trackId: Id;
  bar: number;
}

/**
 * Where the regions `ids` (as they are in `regions`) meet a neighbour of
 * their part exactly: at their start (a neighbour ends there) and/or their
 * end (a neighbour starts there), as `edges` says.
 */
export function touches(regions: readonly SongRegion[], ids: readonly Id[], edges: 'both' | Edge = 'both'): Touch[] {
  const set = new Set(ids);
  const out: Touch[] = [];
  const seen = new Set<string>();
  const add = (trackId: Id, bar: number) => {
    const k = `${trackId}@${bar}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ trackId, bar });
  };
  for (const m of regions) {
    if (!set.has(m.id)) continue;
    for (const r of regions) {
      if (r.trackId !== m.trackId || set.has(r.id)) continue;
      if (edges !== 'end' && regionEnd(r) === m.start) add(m.trackId, m.start);
      if (edges !== 'start' && r.start === regionEnd(m)) add(m.trackId, regionEnd(m));
    }
  }
  return out;
}

/** The song as a drag would leave it, and what the view draws differently meanwhile. */
export interface DragPreview {
  /** Every region after the drop. */
  regions: SongRegion[];
  /** Regions on screen now that would change or go (drawn hidden). */
  hidden: Id[];
  /** Regions as they would end up where they differ from now (drawn on top). */
  shown: SongRegion[];
  /** The dragged regions (or their copies, or the dropped ones) as they would land. */
  moved: SongRegion[];
  trimmed: number;
  removed: number;
  /** New edge-to-edge meetings the dragged regions make. */
  touches: Touch[];
  /** How far the drag really goes, in bars (limited at the song's ends and to at least a bar per region). */
  delta: number;
}

function preview(before: readonly SongRegion[], res: { regions: SongRegion[]; moved: SongRegion[]; trimmed: number; removed: number }, edges: 'both' | Edge, delta: number): DragPreview {
  const { hidden, shown } = diffRegions(before, res.regions);
  const movedIds = res.moved.map((m) => m.id);
  const was = new Set(touches(before, movedIds, edges).map((t) => `${t.trackId}@${t.bar}`));
  const now = touches(res.regions, movedIds, edges).filter((t) => !was.has(`${t.trackId}@${t.bar}`));
  return { regions: res.regions, hidden, shown, moved: res.moved, trimmed: res.trimmed, removed: res.removed, touches: now, delta };
}

function unchanged(regions: readonly SongRegion[], ids: readonly Id[]): DragPreview {
  return { regions: [...regions], hidden: [], shown: [], moved: regions.filter((r) => ids.includes(r.id)), trimmed: 0, removed: 0, touches: [], delta: 0 };
}

/** Regions `ids` moved `delta` bars along their rows (copies with `copy`), as moveRegions places them. */
export function previewMove(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], ids: readonly Id[], delta: number, copy: boolean): DragPreview {
  if (!ids.length || (!delta && !copy)) return unchanged(regions, ids);
  return preview(regions, moveRegions(p, regions, ids, delta, { copy, newId: previewIds() }), 'both', clampMove(regions, ids, delta));
}

/**
 * Regions `ids` with an edge moved `delta` bars, as resizeRegions leaves them.
 * `delta` in the result is how far the edge of `anchorId` (default: the first
 * of `ids`) really went.
 */
export function previewResize(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], ids: readonly Id[], edge: Edge, delta: number, anchorId: Id = ids[0]): DragPreview {
  if (!ids.length || !delta) return unchanged(regions, ids);
  const res = resizeRegions(p, regions, ids, edge, delta, previewIds());
  const a = regions.find((r) => r.id === anchorId);
  const m = res.moved.find((r) => r.id === anchorId);
  const went = a && m ? (edge === 'end' ? regionEnd(m) - regionEnd(a) : m.start - a.start) : 0;
  return preview(regions, res, edge, went);
}

/** New regions `placed` dropped on the song (a scene card, a part's loop): they win where they land. */
export function previewPlace(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], placed: readonly SongRegion[]): DragPreview {
  const res = placeRegions(p, regions, placed, { newId: previewIds('carve') });
  const ids = new Set(placed.map((r) => r.id));
  return preview(regions, { ...res, moved: res.regions.filter((r) => ids.has(r.id)) }, 'both', 0);
}

/** The regions a scene card dropped at `bar` would add (one per part with a clip in that row). */
export function sceneDrop(p: Pick<Project, 'tracks'>, row: number, bar: number): SongRegion[] {
  return sceneRegions(p, row, bar, previewIds('drop'));
}

/** The region one of a part's loops dropped at `bar` would add (its clip's length). */
export function loopDrop(p: Pick<Project, 'tracks'>, trackId: Id, clipId: Id, bar: number): SongRegion[] {
  const bars = clipBarsOf(p, { trackId, clipId });
  const start = Math.min(Math.max(0, Math.round(bar)), MAX_SONG_BARS - 1);
  return [{ id: 'drop:1', trackId, clipId, start, bars: Math.min(bars, MAX_SONG_BARS - start), offset: 0 }];
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/** The song after section `id` moves `delta` bars with the regions that start in it (copies with `copy`). */
export function previewSectionMove(
  p: Pick<Project, 'tracks'>,
  regions: readonly SongRegion[],
  sections: readonly SongSection[],
  id: Id,
  delta: number,
  copy: boolean,
): { regions: DragPreview; sections: SongSection[]; section: SongSection | null } {
  const s = sections.find((x) => x.id === id);
  if (!s) return { regions: previewMove(p, regions, [], 0, false), sections: [...sections], section: null };
  const d = Math.max(-s.start, Math.min(MAX_SONG_BARS - regionEnd(s), Math.round(delta)));
  const owned = sectionRegions(regions, s).map((r) => r.id);
  const reg = owned.length ? previewMove(p, regions, owned, d, copy) : previewMove(p, regions, [], 0, false);
  const placed: SongSection = { ...s, id: copy ? 'preview:section' : s.id, start: s.start + d };
  return { regions: reg, sections: d || copy ? placeSection(sections, placed) : [...sections], section: placed };
}

/** Sections after section `id`'s edge moves `delta` bars (a label only: the music stays). At least one bar. */
export function previewSectionResize(sections: readonly SongSection[], id: Id, edge: Edge, delta: number): { sections: SongSection[]; section: SongSection | null } {
  const s = sections.find((x) => x.id === id);
  if (!s) return { sections: [...sections], section: null };
  const end = regionEnd(s);
  let start = s.start;
  let stop = end;
  if (edge === 'start') start = Math.max(0, Math.min(end - 1, s.start + Math.round(delta)));
  else stop = Math.min(MAX_SONG_BARS, Math.max(s.start + 1, end + Math.round(delta)));
  const placed = { ...s, start, bars: stop - start };
  return { sections: placeSection(sections, placed), section: placed };
}

/* ------------------------------------------------------------------ */
/* The loop range on the ruler                                         */
/* ------------------------------------------------------------------ */

export interface BarRange {
  fromBar: number;
  toBar: number;
}

/** The loop range a drag along the ruler from bar `a` to bar `b` (fractional) sets: both ends on the nearest bar line, at least one bar. */
export function rangeFromDrag(a: number, b: number): BarRange {
  const lo = Math.max(0, Math.min(MAX_SONG_BARS - 1, Math.round(Math.min(a, b))));
  const hi = Math.max(lo + 1, Math.min(MAX_SONG_BARS, Math.round(Math.max(a, b))));
  return { fromBar: lo, toBar: hi };
}

/** The loop range with one end dragged to bar `bar` (fractional; nearest bar line), at least one bar long. */
export function rangeEdgeDrag(range: BarRange, edge: Edge, bar: number): BarRange {
  const b = Math.round(bar);
  if (edge === 'start') return { fromBar: Math.max(0, Math.min(range.toBar - 1, b)), toBar: range.toBar };
  return { fromBar: range.fromBar, toBar: Math.min(MAX_SONG_BARS, Math.max(range.fromBar + 1, b)) };
}
