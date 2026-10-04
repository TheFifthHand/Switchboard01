/**
 * Pointer gestures on the Song view's timeline (and drags from the loop
 * browser onto it).
 *
 * The timeline hands every primary-button press to `press()`; what was
 * pressed decides the gesture:
 *
 * - a region's body: select it, and once the pointer travels, move it (and
 *   every selected region) along its row in whole bars; Alt or Ctrl (⌘)
 *   copies;
 * - a region's edge grip: lengthen or shorten it (right), trim or extend its
 *   start (left);
 * - an empty spot on a row: a marquee that selects what it touches (a click
 *   clears the selection);
 * - the ruler: a click moves the playhead (or the song's start point); a
 *   drag sets the loop range and turns looping on; the band's ends drag, a
 *   click on the band switches the loop;
 * - a section: a click selects its loops, a drag moves it with its music
 *   (Alt or Ctrl copies), its edges resize the label.
 *
 * While a gesture runs nothing is written to the project: the drop's result
 * is worked out with the timeline rules (laneGestures) and published to the
 * drag store, which only the overlay draws. The project changes once, at
 * the drop, as one undo step. Escape cancels. Near the timeline's left or
 * right edge the view scrolls by itself.
 *
 * Pointer moves are cheap: positions come from the geometry cached when the
 * gesture began (no layout reads), and the overlay is told only when what it
 * shows changes (a new bar, the copy key, leaving the row).
 *
 * Touch follows the app's rule (ui/components/touchDrag.ts): a finger swipe
 * scrolls the song; a finger that rests TOUCH_HOLD_MS first picks the loop,
 * edge or section up, and from then on the browser does not pan. A tap is a
 * click.
 */
import { regionEnd, type Edge } from '../../../project/arrangement';
import { TOUCH_HOLD_MS, TOUCH_SLOP_PX } from '../../../ui/components';
import type { Id, Project, SongRegion } from '../../../project/types';
import {
  DRAG_SLOP_PX,
  barsMoved,
  copyKey,
  loopDrop,
  offRow,
  previewMove,
  previewPlace,
  previewResize,
  previewSectionMove,
  previewSectionResize,
  rangeEdgeDrag,
  rangeFromDrag,
  sceneDrop,
  type BarRange,
  type DragPreview,
} from './laneGestures';
import { EMPTY_SELECTION, clickSelect, marqueeSelect, pressSelect, regionsInBox, type LaneSelection } from './laneSelection';
import { carriedStore, dragStore, rangeStore, selectionStore, setSelection, type DragView } from './laneStore';
import { addLoop, addScene, moveLoops, moveSectionBy, resizeLoops, resizeSectionBy } from './songActions';
import { barAt, edgeAt, rowAt, rulerBarAt, xToBar } from './songLayout';
import { lengthBadge, moveBadge, startBadge } from './songModel';

/** What the timeline gives the controller. */
export interface LaneHost {
  /** The scrolling element. */
  scroller(): HTMLElement | null;
  /** The layer whose left edge is bar 0 and whose top is the first row's top. */
  origin(): HTMLElement | null;
  pxPerBar(): number;
  rowH(): number;
  /** Width of the sticky part headers (the timeline's visible left edge is that far into the scroller). */
  headW(): number;
  /** Part ids in row order. */
  tracks(): readonly Id[];
  project(): Project;
  /** A click on the ruler at `bar`. */
  rulerClick(bar: number): void;
  /** A click on the loop band. */
  rangeClick(): void;
  /** A ruler drag set the loop range. */
  rangeSet(range: BarRange): void;
  /** A click on a section (`add`: Shift or Ctrl held). */
  sectionClick(id: Id, add: boolean): void;
  /** A gesture began or ended (the playhead stops following meanwhile). */
  busy(on: boolean): void;
}

/** Something picked up in the loop browser. */
export type Carry = { kind: 'scene'; row: number; name: string; bars: number } | { kind: 'loop'; trackId: Id; clipId: Id; name: string; bars: number; hue: number };

type Gesture =
  | { kind: 'region'; edge: 'move' | 'start' | 'end'; anchor: SongRegion; ids: Id[]; rowTop: number; toggleOnClick: boolean; additive: boolean }
  | { kind: 'marquee'; base: LaneSelection; additive: boolean }
  | { kind: 'ruler'; bar0: number; onBand: boolean }
  | { kind: 'rangeEdge'; edge: 'start' | 'end'; range: BarRange }
  | { kind: 'section'; id: Id; edge: 'move' | 'start' | 'end' }
  | { kind: 'carry'; item: Carry; source: HTMLElement };

interface Active {
  g: Gesture;
  pointerId: number;
  /** Where the press was, client px. */
  x0: number;
  y0: number;
  /** The origin layer's client position and the scroll when the gesture began. */
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  /** The scroller's visible box (client px), for auto-scroll and drops. */
  box: { left: number; right: number; top: number; bottom: number };
  started: boolean;
  /** Last pointer position and modifier keys. */
  cx: number;
  cy: number;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  /** What the overlay shows now (its key, so unchanged moves publish nothing). */
  key: string;
  /** The last preview (committed at the drop). */
  last: { delta: number; copy: boolean; range?: BarRange; drop?: { bar: number; ok: boolean } } | null;
  captured: Element | null;
  /**
   * The view may scroll by itself near its edges: at once for gestures that
   * start on the timeline; for a loop carried in from the browser only once
   * it has been well inside the timeline (crossing the edge on the way in
   * must not scroll the song away).
   */
  armed: boolean;
  /** A finger that has not rested long enough yet: moving now makes it a swipe (the browser scrolls). */
  touchWait: boolean;
  holdTimer: number;
}

/** Distance from the timeline's left or right edge (px) where a drag starts scrolling the view. */
export const AUTOSCROLL_EDGE_PX = 36;
/** Fastest auto-scroll (px per frame) with the pointer at or past the edge. */
const AUTOSCROLL_MAX_PX = 22;

export class LaneController {
  private a: Active | null = null;
  private raf = 0;
  private readonly onMove = (e: PointerEvent) => this.move(e);
  private readonly onUp = (e: PointerEvent) => this.up(e);
  private readonly onCancel = (e: PointerEvent) => {
    if (this.a && e.pointerId === this.a.pointerId) this.cancel();
  };
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  /** Once a finger has picked something up, the browser must not pan under it. */
  private readonly onTouchMove = (e: TouchEvent) => {
    if (this.a && !this.a.touchWait && e.cancelable) e.preventDefault();
  };
  private readonly onScroll = () => {
    if (this.a?.started) this.update();
  };

  constructor(private readonly host: LaneHost) {}

  /** A gesture is running (pressed, dragging or not yet). */
  get active(): boolean {
    return this.a !== null;
  }

  get dragging(): boolean {
    return !!this.a?.started;
  }

  dispose(): void {
    this.cancel();
  }

  /* ---------------------------------------------------------------- */
  /* Starting                                                         */
  /* ---------------------------------------------------------------- */

  /** A primary-button press on the timeline. Returns true when it starts a gesture. */
  press(e: PointerEvent): boolean {
    if (this.a || e.button !== 0 || !(e.target instanceof Element)) return false;
    const t = e.target;
    const p = this.host.project();
    let g: Gesture | null = null;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const regionEl = t.closest<HTMLElement>('[data-region-id]');
    if (regionEl) {
      const id = regionEl.dataset.regionId!;
      const r = p.arrangement.regions.find((x) => x.id === id);
      if (!r) return false;
      const rect = regionEl.getBoundingClientRect();
      const edge = edgeAt(e.clientX - rect.left, rect.width) ?? 'move';
      const sel = selectionStore.getState();
      const was = sel.ids.includes(id);
      const next = add ? (was ? { ...sel, focus: id } : clickSelect(sel, id, 'toggle')) : pressSelect(sel, id, 'replace');
      setSelection(next);
      const row = this.host.tracks().indexOf(r.trackId);
      g = { kind: 'region', edge, anchor: r, ids: next.ids.includes(id) ? [...next.ids] : [id], rowTop: row * this.host.rowH(), toggleOnClick: add && was, additive: add };
    } else if (t.closest('[data-range-edge]')) {
      const range = rangeStore.getState();
      if (!range) return false;
      g = { kind: 'rangeEdge', edge: (t.closest<HTMLElement>('[data-range-edge]')!.dataset.rangeEdge as 'start' | 'end') ?? 'end', range };
    } else if (t.closest('[data-ruler]')) {
      g = { kind: 'ruler', bar0: 0, onBand: !!t.closest('[data-range-band]') };
    } else if (t.closest('[data-section-id]')) {
      const el = t.closest<HTMLElement>('[data-section-id]')!;
      if (el.querySelector('input')) return false;
      const edgeEl = t.closest<HTMLElement>('[data-section-edge]');
      g = { kind: 'section', id: el.dataset.sectionId!, edge: (edgeEl?.dataset.sectionEdge as 'start' | 'end' | undefined) ?? 'move' };
    } else if (t.closest('[data-lane]')) {
      g = { kind: 'marquee', base: add ? selectionStore.getState() : EMPTY_SELECTION, additive: add };
    }
    if (!g) return false;
    // Captured by the scroller: the drag keeps its events (and the cursor the scroller shows) wherever the pointer goes.
    this.begin(e, g, this.host.scroller() ?? t);
    if (g.kind === 'ruler') g.bar0 = this.bar(e.clientX);
    return true;
  }

  /** A press on a scene card or a part's loop in the browser: drag it onto the song. */
  carry(e: PointerEvent, item: Carry, source: HTMLElement): void {
    if (this.a || e.button !== 0) return;
    this.begin(e, { kind: 'carry', item, source }, source);
  }

  private begin(e: PointerEvent, g: Gesture, captureOn: Element): void {
    const scroller = this.host.scroller();
    const origin = this.host.origin();
    if (!scroller || !origin) return;
    const o = origin.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    this.a = {
      g,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      ox: o.left,
      oy: o.top,
      sx: scroller.scrollLeft,
      sy: scroller.scrollTop,
      box: { left: s.left + this.host.headW(), right: s.left + scroller.clientWidth, top: s.top, bottom: s.top + scroller.clientHeight },
      started: false,
      cx: e.clientX,
      cy: e.clientY,
      alt: e.altKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      key: '',
      last: null,
      captured: null,
      armed: g.kind !== 'carry',
      touchWait: e.pointerType === 'touch',
      holdTimer: 0,
    };
    const a = this.a;
    if (a.touchWait) {
      a.holdTimer = window.setTimeout(() => {
        if (this.a === a) a.touchWait = false;
      }, TOUCH_HOLD_MS);
      window.addEventListener('touchmove', this.onTouchMove, { passive: false, capture: true });
    }
    try {
      captureOn.setPointerCapture(e.pointerId);
      this.a.captured = captureOn;
    } catch {
      /* the pointer is gone already */
    }
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
  }

  /* ---------------------------------------------------------------- */
  /* Geometry                                                          */
  /* ---------------------------------------------------------------- */

  /** Timeline x (px from bar 0) of a client x, with the scroll since the gesture began. */
  private tx(clientX: number): number {
    const a = this.a!;
    const sc = this.host.scroller();
    return clientX - a.ox + ((sc?.scrollLeft ?? a.sx) - a.sx);
  }

  /** Rows y (px from the first row's top) of a client y. */
  private ty(clientY: number): number {
    const a = this.a!;
    const sc = this.host.scroller();
    return clientY - a.oy + ((sc?.scrollTop ?? a.sy) - a.sy);
  }

  private bar(clientX: number): number {
    return xToBar(this.tx(clientX), this.host.pxPerBar());
  }

  private overRows(clientX: number, clientY: number): boolean {
    const a = this.a!;
    const y = this.ty(clientY);
    return clientX >= a.box.left && clientX <= a.box.right && clientY >= a.box.top && clientY <= a.box.bottom && y >= 0 && y < this.host.tracks().length * this.host.rowH();
  }

  /* ---------------------------------------------------------------- */
  /* Moving                                                            */
  /* ---------------------------------------------------------------- */

  private move(e: PointerEvent): void {
    const a = this.a;
    if (!a || e.pointerId !== a.pointerId) return;
    a.cx = e.clientX;
    a.cy = e.clientY;
    a.alt = e.altKey;
    a.ctrl = e.ctrlKey;
    a.meta = e.metaKey;
    if (a.touchWait) {
      // A finger moving before it rested: a swipe. The browser scrolls; nothing is picked up.
      if (Math.hypot(e.clientX - a.x0, e.clientY - a.y0) >= TOUCH_SLOP_PX) this.cancel();
      return;
    }
    if (!a.started) {
      if (Math.hypot(e.clientX - a.x0, e.clientY - a.y0) < DRAG_SLOP_PX) return;
      a.started = true;
      this.host.busy(true);
      this.host.scroller()?.setAttribute('data-drag', a.g.kind === 'region' ? a.g.edge : a.g.kind);
    }
    e.preventDefault();
    if (!a.armed && e.clientX > a.box.left + AUTOSCROLL_EDGE_PX * 2 && e.clientX < a.box.right - AUTOSCROLL_EDGE_PX * 2 && this.overRows(e.clientX, e.clientY)) a.armed = true;
    this.update();
    this.autoScroll();
  }

  /** Work out what the gesture shows now (after a move, a scroll or a modifier key) and publish it when it changed. */
  private update(): void {
    const a = this.a;
    if (!a || !a.started) return;
    const g = a.g;
    const ppb = this.host.pxPerBar();
    const rowH = this.host.rowH();
    const p = this.host.project();
    const regions = p.arrangement.regions;
    const copy = copyKey({ altKey: a.alt, ctrlKey: a.ctrl, metaKey: a.meta });
    // The pointer's travel along the timeline since the press (scrolling included).
    const dx = this.tx(a.cx) - (a.x0 - a.ox);
    switch (g.kind) {
      case 'region': {
        const delta = barsMoved(dx, ppb);
        const isMove = g.edge === 'move';
        const off = isMove && offRow(this.ty(a.cy), g.rowTop, rowH);
        const key = `${delta}|${isMove && copy}|${off}`;
        if (key === a.key) return;
        a.key = key;
        const pv: DragPreview = isMove ? previewMove(p, regions, g.ids, delta, copy) : previewResize(p, regions, g.ids, g.edge as Edge, delta, g.anchor.id);
        a.last = { delta: pv.delta, copy: isMove && copy };
        const row = this.host.tracks().indexOf(g.anchor.trackId);
        let badge: DragView['badge'];
        if (isMove) {
          const start = g.anchor.start + pv.delta;
          badge = { text: moveBadge(start, copy), x: start * ppb, row, align: 'start' };
        } else {
          const m = pv.moved.find((r) => r.id === g.anchor.id) ?? g.anchor;
          const clipBars = p.tracks.find((t) => t.id === m.trackId)?.clips.find((c) => c?.id === m.clipId)?.bars ?? 1;
          badge = g.edge === 'end' ? { text: lengthBadge(m.bars, clipBars), x: regionEnd(m) * ppb, row, align: 'end' } : { text: startBadge(m.start), x: m.start * ppb, row, align: 'start' };
        }
        this.publish({ kind: isMove ? 'move' : g.edge, preview: pv, slide: isMove ? pv.delta : undefined, badge, notAllowed: off, touches: pv.touches });
        this.host.scroller()?.toggleAttribute('data-not-allowed', off);
        return;
      }
      case 'marquee': {
        const x0 = a.x0 - a.ox;
        const y0 = a.y0 - a.oy;
        const x1 = this.tx(a.cx);
        const y1 = this.ty(a.cy);
        const box = { bar0: xToBar(Math.min(x0, x1), ppb), bar1: xToBar(Math.max(x0, x1), ppb), row0: rowAt(Math.max(0, Math.min(y0, y1)), rowH), row1: rowAt(Math.max(0, Math.max(y0, y1)), rowH) };
        const tracks = this.host.tracks();
        const hits = regionsInBox(regions, (id) => tracks.indexOf(id), box);
        setSelection(marqueeSelect(g.base, hits, g.additive));
        this.publish({ kind: 'marquee', marquee: { x0, y0, x1, y1 } }, `${Math.round(x1)}|${Math.round(y1)}`);
        return;
      }
      case 'ruler': {
        const range = rangeFromDrag(g.bar0, this.bar(a.cx));
        a.last = { delta: 0, copy: false, range };
        this.publish({ kind: 'range', range }, `${range.fromBar}|${range.toBar}`);
        return;
      }
      case 'rangeEdge': {
        const range = rangeEdgeDrag(g.range, g.edge, this.bar(a.cx));
        a.last = { delta: 0, copy: false, range };
        this.publish({ kind: 'range', range }, `${range.fromBar}|${range.toBar}`);
        return;
      }
      case 'section': {
        const delta = barsMoved(dx, ppb);
        const sections = p.arrangement.sections;
        if (g.edge === 'move') {
          const key = `${delta}|${copy}`;
          if (key === a.key) return;
          a.key = key;
          const pv = previewSectionMove(p, regions, sections, g.id, delta, copy);
          const d = pv.section ? pv.section.start - (sections.find((s) => s.id === g.id)?.start ?? 0) : 0;
          a.last = { delta: d, copy };
          this.publish({ kind: 'section', preview: pv.regions, slide: pv.regions.delta, sections: pv.sections, section: pv.section, touches: [] });
        } else {
          const key = `${delta}`;
          if (key === a.key) return;
          a.key = key;
          const pv = previewSectionResize(sections, g.id, g.edge, delta);
          const before = sections.find((s) => s.id === g.id);
          const d = pv.section && before ? (g.edge === 'start' ? pv.section.start - before.start : regionEnd(pv.section) - regionEnd(before)) : 0;
          a.last = { delta: d, copy: false };
          this.publish({ kind: 'section', sections: pv.sections, section: pv.section });
        }
        return;
      }
      case 'carry': {
        const item = g.item;
        const over = this.overRows(a.cx, a.cy);
        const bar = barAt(this.tx(a.cx), ppb);
        const row = rowAt(this.ty(a.cy), rowH);
        const tracks = this.host.tracks();
        const ok = over && (item.kind === 'scene' || tracks[row] === item.trackId);
        carriedStore.setState({ x: a.cx, y: a.cy, text: item.kind === 'scene' ? `${item.name} · ${item.bars} bars` : item.name, hue: item.kind === 'loop' ? item.hue : undefined, overRows: over });
        document.documentElement.dataset.songCarry = !over ? 'away' : ok ? 'ok' : 'no';
        const key = `${over}|${bar}|${ok}|${row}`;
        if (key === a.key) return;
        a.key = key;
        a.last = { delta: 0, copy: false, drop: { bar, ok } };
        if (!over) {
          this.publish(item.kind === 'loop' ? { kind: 'drop', ownRow: item.trackId } : null);
          return;
        }
        if (!ok) {
          this.publish({ kind: 'drop', ownRow: item.kind === 'loop' ? item.trackId : undefined, notAllowed: true });
          return;
        }
        const placed = item.kind === 'scene' ? sceneDrop(p, item.row, bar) : loopDrop(p, item.trackId, item.clipId, bar);
        const pv = previewPlace(p, regions, placed);
        const newSection =
          item.kind === 'scene' && placed.length && !p.arrangement.sections.some((s) => s.start < bar + placed[0].bars && regionEnd(s) > bar) ? { start: bar, bars: placed[0].bars, name: item.name } : null;
        this.publish({
          kind: 'drop',
          preview: pv,
          ownRow: item.kind === 'loop' ? item.trackId : undefined,
          touches: pv.touches,
          newSection,
          badge: { text: `Bar ${bar + 1}`, x: bar * ppb, row: item.kind === 'loop' ? tracks.indexOf(item.trackId) : 0, align: 'start' },
        });
        return;
      }
    }
  }

  private publish(view: DragView | null, key?: string): void {
    if (key !== undefined && this.a) {
      if (key === this.a.key) return;
      this.a.key = key;
    }
    dragStore.setState(view);
  }

  /** Near the timeline's left or right edge, scroll a little every frame while the drag lasts. */
  private autoScroll(): void {
    const a = this.a;
    if (!a || this.raf || a.g.kind === 'ruler' || a.g.kind === 'rangeEdge') return;
    const step = () => {
      this.raf = 0;
      const cur = this.a;
      const sc = this.host.scroller();
      if (!cur || !cur.started || !sc) return;
      if (cur.g.kind === 'carry' && (!cur.armed || !this.overRows(cur.cx, Math.min(cur.box.bottom - 1, Math.max(cur.box.top + 1, cur.cy))))) return;
      const { left, right } = cur.box;
      let v = 0;
      if (cur.cx < left + AUTOSCROLL_EDGE_PX) v = -Math.min(1, (left + AUTOSCROLL_EDGE_PX - cur.cx) / AUTOSCROLL_EDGE_PX);
      else if (cur.cx > right - AUTOSCROLL_EDGE_PX) v = Math.min(1, (cur.cx - (right - AUTOSCROLL_EDGE_PX)) / AUTOSCROLL_EDGE_PX);
      if (!v) return;
      const before = sc.scrollLeft;
      sc.scrollLeft = before + v * AUTOSCROLL_MAX_PX;
      if (sc.scrollLeft === before) return;
      this.update();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /* ---------------------------------------------------------------- */
  /* Ending                                                            */
  /* ---------------------------------------------------------------- */

  private up(e: PointerEvent): void {
    const a = this.a;
    if (!a || e.pointerId !== a.pointerId) return;
    a.cx = e.clientX;
    a.cy = e.clientY;
    a.alt = e.altKey;
    a.ctrl = e.ctrlKey;
    a.meta = e.metaKey;
    if (a.started) this.update();
    const g = a.g;
    const started = a.started;
    const last = a.last;
    this.end();
    if (!started) {
      this.click(g, e);
      return;
    }
    switch (g.kind) {
      case 'region':
        if (!last) return;
        if (g.edge === 'move') moveLoops(g.ids, last.delta, { copy: last.copy });
        else resizeLoops(g.ids, g.edge, last.delta);
        return;
      case 'ruler':
      case 'rangeEdge':
        if (last?.range) this.host.rangeSet(last.range);
        return;
      case 'section':
        if (!last) return;
        if (g.edge === 'move') moveSectionBy(g.id, last.delta, last.copy);
        else resizeSectionBy(g.id, g.edge, last.delta);
        return;
      case 'carry':
        if (!last?.drop?.ok) return;
        if (g.item.kind === 'scene') addScene(g.item.row, last.drop.bar);
        else addLoop(g.item.trackId, g.item.clipId, last.drop.bar);
        return;
      case 'marquee':
        return;
    }
  }

  /** A press that never travelled: a click. */
  private click(g: Gesture, e: PointerEvent): void {
    switch (g.kind) {
      case 'region': {
        const sel = selectionStore.getState();
        if (g.toggleOnClick) setSelection(clickSelect(sel, g.anchor.id, 'toggle'));
        else if (!g.additive) setSelection(clickSelect(sel, g.anchor.id, 'replace'));
        return;
      }
      case 'marquee':
        if (!g.additive) {
          const sel = selectionStore.getState();
          if (sel.ids.length) setSelection({ ids: [], focus: sel.focus });
        }
        return;
      case 'ruler':
        if (g.onBand) this.host.rangeClick();
        else this.host.rulerClick(rulerBarAt(this.txAt(e.clientX), this.host.pxPerBar()));
        return;
      case 'section':
        this.host.sectionClick(g.id, e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      case 'rangeEdge':
      case 'carry':
        return;
    }
  }

  /** Timeline x of a client x outside a gesture (read now). */
  private txAt(clientX: number): number {
    const o = this.host.origin()?.getBoundingClientRect();
    return o ? clientX - o.left : 0;
  }

  private key(e: KeyboardEvent): void {
    const a = this.a;
    if (!a) return;
    if (e.type === 'keydown' && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
      return;
    }
    if (e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') {
      // The copy key, pressed or let go mid-drag (and never the browser's menu bar for Alt).
      e.preventDefault();
      a.alt = e.altKey;
      a.ctrl = e.ctrlKey;
      a.meta = e.metaKey;
      this.update();
    }
  }

  /** Stop the gesture without changing anything. */
  cancel(): void {
    if (!this.a) return;
    this.end();
  }

  private end(): void {
    const a = this.a;
    if (!a) return;
    this.a = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onCancel, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('touchmove', this.onTouchMove, true);
    window.clearTimeout(a.holdTimer);
    const sc = this.host.scroller();
    sc?.removeEventListener('scroll', this.onScroll);
    sc?.removeAttribute('data-drag');
    sc?.removeAttribute('data-not-allowed');
    delete document.documentElement.dataset.songCarry;
    try {
      if (a.captured?.hasPointerCapture(a.pointerId)) a.captured.releasePointerCapture(a.pointerId);
    } catch {
      /* already released */
    }
    if (dragStore.getState()) dragStore.setState(null);
    if (carriedStore.getState()) carriedStore.setState(null);
    if (a.started) this.host.busy(false);
  }
}

