/**
 * The Song view's own state outside React: which regions are selected (and
 * which one has keyboard focus), the loop range shown on the ruler, and what
 * a drag in progress shows over the timeline. Each is a small store, so a
 * region re-renders only when its own selected state changes and a drag
 * re-renders only the overlay, never the rows.
 *
 * The selection belongs to the project open now: another project starts
 * with none, and regions that go away leave it (see pruneSelection).
 */
import type { Id, SongSection } from '../../../project/types';
import { createStore, useStore } from '../../../state/store';
import type { BarRange, DragPreview, Touch } from './laneGestures';
import { EMPTY_SELECTION, type LaneSelection } from './laneSelection';

export const selectionStore = createStore<LaneSelection>(EMPTY_SELECTION);

export function setSelection(sel: LaneSelection): void {
  const cur = selectionStore.getState();
  if (cur === sel || (cur.focus === sel.focus && cur.ids.length === sel.ids.length && cur.ids.every((id, i) => id === sel.ids[i]))) return;
  selectionStore.setState(sel);
}

export function clearSelection(): void {
  const cur = selectionStore.getState();
  if (cur.ids.length) setSelection({ ids: [], focus: cur.focus });
}

export function useSelected(id: Id): boolean {
  return useStore(selectionStore, (s) => s.ids.includes(id));
}

export function useSelectedIds(): readonly Id[] {
  return useStore(selectionStore, (s) => s.ids);
}


/**
 * The loop range (bars) as the ruler shows it: the runtime's loop while
 * looping is on; kept, dimmed, while it is off (this session).
 */
export const rangeStore = createStore<BarRange | null>(null);

export function useRange(): BarRange | null {
  return useStore(rangeStore, (s) => s);
}

/** What the overlay draws while a drag runs (null: nothing). */
export interface DragView {
  kind: 'move' | 'start' | 'end' | 'drop' | 'marquee' | 'section' | 'range';
  /** The song as the drop would leave it (regions drags and drops). */
  preview?: DragPreview;
  /** Moved regions slide from where they were by this many bars (eased). */
  slide?: number;
  /** The badge by the dragged regions, in timeline px (x) and row index. */
  badge?: { text: string; x: number; row: number; align: 'start' | 'end' };
  /** Marquee rectangle in timeline px (x) and rows px (y). */
  marquee?: { x0: number; y0: number; x1: number; y1: number };
  /** The pointer is off the region's row (or a loop over another part's row): the drop does not go there. */
  notAllowed?: boolean;
  touches?: readonly Touch[];
  /** The sections as a section drag would leave them. */
  sections?: readonly SongSection[];
  /** The section being dragged (as it would land). */
  section?: SongSection | null;
  /** The loop range as a ruler drag would set it. */
  range?: BarRange;
  /** A loop from the browser: its part's row lights up; other rows say not here. */
  ownRow?: Id;
  /** A scene card: the section it would add (when none is there yet). */
  newSection?: { start: number; bars: number; name: string } | null;
}

export const dragStore = createStore<DragView | null>(null);

export function useDragView(): DragView | null {
  return useStore(dragStore, (s) => s);
}

/** A loop or scene picked up in the browser, drawn under the pointer (fixed position) while it is away from the rows. */
export interface Carried {
  x: number;
  y: number;
  text: string;
  hue?: number;
  overRows: boolean;
}

export const carriedStore = createStore<Carried | null>(null);

/** The timeline's scale (pixels per bar), shared by the timeline and the header's zoom keys. */
export const ppbStore = createStore<number>(32);

export function usePxPerBar(): number {
  return useStore(ppbStore, (s) => s);
}

/** The region under the pointer (its ⋯ shows), or null. */
export const hoverStore = createStore<Id | null>(null);
