/**
 * Dragging a library loop onto the song: press a row of the library and
 * carry it over the timeline. Over a part that can play it, that row lights
 * up and the loop is drawn where it would land (on the bar under the
 * pointer, with "Bar 9" by it; what it would cut short is drawn cut); over a
 * part of the wrong kind the pointer says what it needs ("Needs a drum
 * part"), and a drop there says why in full. Release adds it (one undo step
 * "Add <name>"); Escape, or a release away from the rows, adds nothing.
 *
 * It uses the timeline's drag overlay (dragStore) and the browser's carried
 * label (carriedStore) as the scene and pad-loop carries do; the new loop's
 * face, which has no clip in the project yet, is drawn by LibraryGhost.
 */
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { LibraryLoop } from '../../../../content/loops';
import type { Id } from '../../../../project/types';
import { MAX_SONG_BARS } from '../../../../project/types';
import { createStore } from '../../../../state/store';
import { session } from '../../../instance';
import { notify } from '../../../runtime';
import { dragCursor } from '../laneController';
import { previewPlace } from '../laneGestures';
import { carriedStore, dragStore, hoverStore, ppbStore } from '../laneStore';
import { addLibraryLoop } from '../songActions';
import { RULER_H, SECTIONS_H, barAt } from '../songLayout';
import { partHue } from '../songModel';
import { partProblem, partProblemShort, realizeFor } from './libraryModel';

/** The pointer travels this far (px) before a press becomes a drag. */
const DRAG_SLOP_PX = 4;

/** What LibraryGhost draws over the rows while a library loop is carried. */
export type LibraryGhost =
  | { kind: 'loop'; trackId: Id; row: number; hue: number; start: number; bars: number; name: string; notes: readonly { tick: number; pitch: number; velocity: number; duration: number }[]; drums: boolean }
  | { kind: 'no'; text: string; x: number; y: number };

export const libraryGhostStore = createStore<LibraryGhost | null>(null);

/** Where the pointer is over the rows: the part's row and the bar, in timeline px too (null: not over the rows). */
interface Over {
  trackId: Id;
  row: number;
  bar: number;
  /** Timeline px from the rows' top-left corner (bar 0, first row). */
  x: number;
  y: number;
}

function overRows(cx: number, cy: number): Over | null {
  const scroller = document.querySelector<HTMLElement>('[data-testid="lane-scroller"]');
  if (!scroller) return null;
  const s = scroller.getBoundingClientRect();
  const head = scroller.querySelector<HTMLElement>('[data-part-head]');
  const left = s.left + (head?.offsetWidth ?? 0);
  const top = s.top + RULER_H + SECTIONS_H;
  if (cx < left || cx >= s.left + scroller.clientWidth || cy < top || cy >= s.top + scroller.clientHeight) return null;
  const lanes = scroller.querySelectorAll<HTMLElement>('[data-lane]');
  if (!lanes.length) return null;
  const first = lanes[0].getBoundingClientRect();
  for (const lane of lanes) {
    const r = lane.getBoundingClientRect();
    if (cy < r.top || cy >= r.bottom) continue;
    const row = lane.closest<HTMLElement>('[data-lane-row]');
    const ppb = ppbStore.getState();
    return { trackId: lane.dataset.lane!, row: Number(row?.dataset.rowIndex ?? 0), bar: barAt(cx - r.left, ppb), x: cx - r.left, y: cy - first.top };
  }
  return null;
}

interface Carrying {
  loop: LibraryLoop;
  hue: number;
  pointerId: number;
  x0: number;
  y0: number;
  started: boolean;
  /** Where it would land now (null: nowhere). */
  drop: { trackId: Id; bar: number } | null;
  /** Over a part that cannot play it: that part. */
  wrong: Id | null;
  key: string;
  source: HTMLElement;
}

let carrying: Carrying | null = null;

function clear(): void {
  dragStore.setState(null);
  carriedStore.setState(null);
  libraryGhostStore.setState(null);
  dragCursor(null);
}

function move(c: Carrying, cx: number, cy: number): void {
  const over = overRows(cx, cy);
  const p = session.store.getState();
  const t = over ? p.tracks.find((x) => x.id === over.trackId) : undefined;
  const problem = t ? partProblem(c.loop, t) : null;
  carriedStore.setState({ x: cx, y: cy, text: c.loop.name, hue: c.hue, overRows: !!over && !problem });
  dragCursor(over && problem ? 'not-allowed' : 'grabbing');
  if (!over || !t) {
    c.drop = null;
    c.wrong = null;
    if (c.key !== '') {
      c.key = '';
      dragStore.setState(null);
      libraryGhostStore.setState(null);
    }
    return;
  }
  if (problem) {
    c.drop = null;
    c.wrong = t.id;
    c.key = `no|${t.id}`;
    dragStore.setState({ kind: 'drop' });
    libraryGhostStore.setState({ kind: 'no', text: partProblemShort(c.loop), x: over.x, y: over.y });
    return;
  }
  c.wrong = null;
  const bars = c.loop.bars;
  const start = Math.min(over.bar, MAX_SONG_BARS - bars);
  c.drop = { trackId: t.id, bar: start };
  const key = `ok|${t.id}|${start}`;
  if (key === c.key) return;
  c.key = key;
  const notes = realizeFor(p, c.loop, t);
  const placed = { id: 'library:drop', trackId: t.id, clipId: 'library:drop', start, bars, offset: 0 };
  const pv = previewPlace(p, p.arrangement.regions, [placed]);
  // The new loop is drawn by LibraryGhost (it has no clip in the project yet), not by the overlay.
  const shown = pv.shown.filter((r) => r.id !== placed.id);
  const ppb = ppbStore.getState();
  dragStore.setState({
    kind: 'drop',
    preview: { ...pv, shown, moved: [] },
    ownRow: t.id,
    touches: pv.touches,
    badge: { text: `Bar ${start + 1}`, x: start * ppb, row: over.row, align: 'start' },
  });
  libraryGhostStore.setState({ kind: 'loop', trackId: t.id, row: over.row, hue: partHue(over.row), start, bars, name: c.loop.name, notes: notes?.notes ?? [], drums: c.loop.part.kind === 'drums' });
}

function onMove(e: PointerEvent): void {
  const c = carrying;
  if (!c || e.pointerId !== c.pointerId) return;
  if (!c.started) {
    if (Math.hypot(e.clientX - c.x0, e.clientY - c.y0) < DRAG_SLOP_PX) return;
    c.started = true;
    hoverStore.setState(null);
  }
  move(c, e.clientX, e.clientY);
}

function end(e: PointerEvent, cancel: boolean): void {
  const c = carrying;
  if (!c || e.pointerId !== c.pointerId) return;
  stop();
  if (cancel || !c.started) return;
  if (c.drop) addLibraryLoop(c.loop.id, c.drop.trackId, c.drop.bar);
  else if (c.wrong) {
    const t = session.store.getState().tracks.find((x) => x.id === c.wrong);
    const problem = t ? partProblem(c.loop, t) : null;
    if (problem) notify(problem, 'warn');
  }
}

const onUp = (e: PointerEvent) => end(e, false);
const onCancel = (e: PointerEvent) => end(e, true);
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !carrying) return;
  e.preventDefault();
  e.stopPropagation();
  stop();
}

function stop(): void {
  const c = carrying;
  carrying = null;
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  if (c?.source.hasPointerCapture?.(c.pointerId)) c.source.releasePointerCapture(c.pointerId);
  clear();
}

/** A press on a library row: carry the loop onto the song (`hue`: the colour of the part it would go to). */
export function carryLibraryLoop(e: ReactPointerEvent<HTMLElement>, loop: LibraryLoop, hue: number): void {
  // (A locked song refuses the drop itself, with the reason.)
  if (e.button !== 0 || carrying) return;
  const source = e.currentTarget;
  carrying = { loop, hue, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, drop: null, wrong: null, key: '-', source };
  try {
    source.setPointerCapture(e.pointerId);
  } catch {
    /* the pointer is gone already */
  }
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
}

/** For tests: drop whatever is being carried. */
export function cancelLibraryCarry(): void {
  if (carrying) stop();
}
