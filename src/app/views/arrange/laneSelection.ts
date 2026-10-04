/**
 * Which regions are selected in the Song view (pure: no DOM, no React).
 *
 * As in GarageBand: a click selects one region (Shift or Ctrl adds or
 * removes it), a marquee drag on empty rows selects what it touches (with
 * Shift or Ctrl added to what was selected), a click on an empty spot clears
 * it, Ctrl+A takes everything. Pressing a region that is already part of a
 * selection keeps the selection, so the whole group can be dragged; a click
 * that ends without a drag then selects that region alone. The selection
 * never names a region that is gone (pruneSelection after every edit).
 *
 * The keyboard moves between regions with ↑ / ↓ (the part above or below,
 * nearest in time) and Ctrl+← / Ctrl+→ (the previous or next loop on the
 * same part): see neighbour().
 */
import { regionEnd } from '../../../project/arrangement';
import type { Id, SongRegion, SongSection } from '../../../project/types';

export interface LaneSelection {
  ids: readonly Id[];
  /** The region keyboard focus is on (the roving Tab stop), or null. */
  focus: Id | null;
  /**
   * Sections selected with the loops (Ctrl+A takes the sections too, so
   * Delete then clears the song, labels and all). Absent: none. Any click on
   * a loop or an empty spot leaves them.
   */
  sections?: readonly Id[];
}

export const EMPTY_SELECTION: LaneSelection = { ids: [], focus: null };

/** How a click selects: replace the selection, or add/remove the region (Shift, Ctrl/⌘). */
export type SelectMode = 'replace' | 'toggle';

export function clickSelect(sel: LaneSelection, id: Id, mode: SelectMode): LaneSelection {
  if (mode === 'toggle') {
    const has = sel.ids.includes(id);
    return { ids: has ? sel.ids.filter((x) => x !== id) : [...sel.ids, id], focus: id };
  }
  return sel.ids.length === 1 && sel.ids[0] === id && sel.focus === id ? sel : { ids: [id], focus: id };
}

/**
 * The selection a press on region `id` starts a drag with: kept as it is when
 * the region is already selected (the group moves together), else as a click
 * would make it.
 */
export function pressSelect(sel: LaneSelection, id: Id, mode: SelectMode): LaneSelection {
  if (mode === 'replace' && sel.ids.includes(id)) return sel.focus === id ? sel : { ...sel, focus: id };
  return clickSelect(sel, id, mode);
}

/** A marquee's result: what it touches, added to `base` when `additive`. */
export function marqueeSelect(base: LaneSelection, hits: readonly Id[], additive: boolean): LaneSelection {
  const ids = additive ? [...base.ids, ...hits.filter((h) => !base.ids.includes(h))] : [...hits];
  const focus = hits.length ? hits[0] : additive ? base.focus : null;
  return { ids, focus };
}

/** Every loop, and every section label too. */
export function selectAll(regions: readonly SongRegion[], sections: readonly SongSection[] = []): LaneSelection {
  return { ids: regions.map((r) => r.id), focus: regions[0]?.id ?? null, sections: sections.map((s) => s.id) };
}

/**
 * The selection without regions (and sections) that no longer exist (the
 * focus moves to a kept one, else to `fallback`). `existingSections` absent:
 * the sections are kept as they are.
 */
export function pruneSelection(sel: LaneSelection, existing: ReadonlySet<Id>, fallback: Id | null = null, existingSections?: ReadonlySet<Id>): LaneSelection {
  const ids = sel.ids.filter((id) => existing.has(id));
  const focus = sel.focus && existing.has(sel.focus) ? sel.focus : (ids[0] ?? (fallback && existing.has(fallback) ? fallback : null));
  const before = sel.sections ?? [];
  const sections = existingSections ? before.filter((id) => existingSections.has(id)) : before;
  if (ids.length === sel.ids.length && focus === sel.focus && sections.length === before.length) return sel;
  return sections.length ? { ids, focus, sections } : { ids, focus };
}

/** Nothing selected (keyboard focus stays where it was, for Tab). */
export function selectNone(sel: LaneSelection): LaneSelection {
  return sel.ids.length || sel.sections?.length ? { ids: [], focus: sel.focus } : sel;
}


/** A box on the timeline: bars [bar0, bar1) (fractional) over rows row0..row1 (inclusive). */
export interface LaneBox {
  bar0: number;
  bar1: number;
  row0: number;
  row1: number;
}

/** The regions a marquee box touches (a region counts when the box overlaps any of it). */
export function regionsInBox(regions: readonly SongRegion[], rowOf: (trackId: Id) => number, box: LaneBox): Id[] {
  const b0 = Math.min(box.bar0, box.bar1);
  const b1 = Math.max(box.bar0, box.bar1);
  const r0 = Math.min(box.row0, box.row1);
  const r1 = Math.max(box.row0, box.row1);
  return regions
    .filter((r) => {
      const row = rowOf(r.trackId);
      return row >= r0 && row <= r1 && r.start < b1 && regionEnd(r) > b0;
    })
    .map((r) => r.id);
}

/**
 * The region the keyboard moves to from `fromId`: on the part above or below
 * (`up`, `down`: the region there nearest in time, skipping parts with none),
 * or the previous or next one on the same part (`prev`, `next`). With nothing
 * focused, the first region at or after `atBar` (any part). Null when there is
 * nowhere to go.
 */
export function neighbour(regions: readonly SongRegion[], trackOrder: readonly Id[], fromId: Id | null, dir: 'up' | 'down' | 'prev' | 'next', atBar = 0): Id | null {
  const from = fromId ? regions.find((r) => r.id === fromId) : undefined;
  if (!from) {
    const sorted = [...regions].sort((a, b) => a.start - b.start || trackOrder.indexOf(a.trackId) - trackOrder.indexOf(b.trackId));
    return (sorted.find((r) => regionEnd(r) > atBar) ?? sorted[sorted.length - 1])?.id ?? null;
  }
  if (dir === 'prev' || dir === 'next') {
    const row = regions.filter((r) => r.trackId === from.trackId).sort((a, b) => a.start - b.start);
    const i = row.findIndex((r) => r.id === from.id);
    return row[dir === 'next' ? i + 1 : i - 1]?.id ?? null;
  }
  const at = trackOrder.indexOf(from.trackId);
  const step = dir === 'down' ? 1 : -1;
  for (let t = at + step; t >= 0 && t < trackOrder.length; t += step) {
    const row = regions.filter((r) => r.trackId === trackOrder[t]);
    if (!row.length) continue;
    // Nearest in time: overlapping the start of the region we come from, else the closest edge.
    const dist = (r: SongRegion) => (r.start <= from.start && from.start < regionEnd(r) ? 0 : Math.min(Math.abs(r.start - from.start), Math.abs(regionEnd(r) - 1 - from.start)));
    return row.reduce((best, r) => (dist(r) < dist(best) ? r : best)).id;
  }
  return null;
}
