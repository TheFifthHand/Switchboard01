/**
 * Pointer gestures of the song lane: moving and copying blocks, dragging a
 * block's right edge to change its length, and dragging a scene card in to
 * insert or layer it.
 *
 * Performance and reliability rules:
 * - Block positions and widths are written here, straight to the DOM
 *   (`place`), never through React: the lane calls `sync()` after each render
 *   and during a gesture every pointer move only writes transforms. React
 *   re-renders only when something visible changes kind (a drag starts, Copy
 *   is toggled, a layer target changes, the drop).
 * - Geometry is read once when a gesture starts (and again after a scroll or
 *   resize); pointer moves never read layout.
 * - What a drag shows is what its drop commits: the preview order comes from
 *   orderAfterMove, the same function the moveBlocks command uses.
 * - Every gesture ends through one path (`finish`), which removes every
 *   listener it added and releases pointer capture: on drop, Escape, a release
 *   away from the lane, pointercancel, lost capture, window blur, a hidden tab,
 *   an outside change to the song, or the lane unmounting.
 */
import type { Id } from '../../../project/types';
import { orderAfterMove } from '../../../state/commands';
import {
  DRAG_THRESHOLD_PX,
  NO_TARGET,
  autoScrollVelocity,
  cardTarget,
  edgeStepPx,
  fullGap,
  packPositions,
  repeatsFromEdge,
  sameCardTarget,
  targetGap,
  type CardTarget,
  type LaneSelection,
} from './songDrag';
import { blockWidth, type SongLayout } from './songLayout';

/** Room after the last block (px) for dropping at the end. */
export const END_ROOM = 48;
/** How far above or below the lane (px) a drop still counts. */
export const DROP_MARGIN = 40;
/** Lifted look while a block is carried (also the start of its settle animation). */
const LIFT = 'translate3d(VAR_X, -3px, 0) scale(1.015)';
const SETTLE_MS = 300;
/**
 * A scene card resting on a boundary for this long opens the insertion slot
 * (until then a line marks it). Passing over a boundary on the way to the
 * middle of a block therefore does not push that block away.
 */
export const SLOT_DELAY_MS = 140;

export type DragUi =
  | { kind: 'move'; ids: Id[]; copy: boolean; outside: boolean }
  | { kind: 'card'; sceneId: Id; layerInto: Id | null; outside: boolean }
  | { kind: 'resize'; id: Id };

export interface LaneHost {
  scroller(): HTMLElement | null;
  content(): HTMLElement | null;
  track(): HTMLElement | null;
  blockEl(id: Id): HTMLElement | undefined;
  /** The lifted copy of the dragged blocks, the drop slot, the size bubble and the card ghost (rendered while a gesture needs them). */
  cloneEl(): HTMLElement | null;
  slotEl(): HTMLElement | null;
  bubbleEl(): HTMLElement | null;
  ghostEl(): HTMLElement | null;
  /** The status text inside the clone or ghost ("Move to position 3"). */
  labelEl(): HTMLElement | null;

  layout(): SongLayout;
  /** Blocks in song order, with whether their scene exists. */
  order(): readonly { id: Id; layerable: boolean; name: string }[];
  selection(): LaneSelection;
  /** The edit lock reason (a performance take records), or null. */
  locked(): string | null;
  /** Width of a new block of this scene at the current scale. */
  sceneWidth(sceneId: Id): number;
  sceneName(sceneId: Id): string;

  setDragUi(ui: DragUi | null): void;
  selectOnly(id: Id): void;
  refuse(message: string): void;

  /** Commit a move (copy: duplicate) of `ids` to insertion gap `gap` of the full list; returns the ids that land (moved or new), or null. */
  commitMove(ids: Id[], gap: number, copy: boolean): Id[] | null;
  commitInsert(sceneId: Id, gap: number): Id | null;
  commitLayer(blockId: Id, sceneId: Id): void;
  commitRepeats(id: Id, repeats: number): void;
  /** Live label for the edge bubble ("×3 · 12 bars"). */
  resizeLabel(id: Id, repeats: number): string;
}

interface Base {
  pointerId: number;
  captureEl: HTMLElement;
  clientX: number;
  clientY: number;
}

interface Press extends Base {
  kind: 'press' | 'edgePress' | 'cardPress';
  startX: number;
  startY: number;
  id: Id;
  /** The pointerdown that started it (a handler further up the tree may see the same event). */
  down: PointerEvent;
}

interface Geometry {
  /** Client x of the content's left edge when scrollLeft is 0. */
  contentLeft0: number;
  lane: { left: number; right: number; top: number; bottom: number };
}

interface MoveDrag extends Base, Geometry {
  kind: 'move';
  ids: Id[];
  moving: Set<Id>;
  list: { id: Id }[];
  widths: Map<Id, number>;
  groupWidth: number;
  /** Pointer x minus the group's left edge (content coordinates). */
  grab: number;
  copy: boolean;
  outside: boolean;
  /** Gap among the others (move) or in the full list (copy); null before the first target. */
  gap: number | null;
}

interface CardDrag extends Base, Geometry {
  kind: 'card';
  sceneId: Id;
  slotWidth: number;
  target: CardTarget;
  /** The insertion slot is open (the blocks after it moved aside); before that a line marks it. */
  open: boolean;
  outside: boolean;
}

interface Resize extends Base {
  kind: 'resize';
  id: Id;
  startX: number;
  r0: number;
  r: number;
  step: number;
  passBars: number;
  pxPerBar: number;
}

/** After a cancel: wait for the pointer to come up so its click does nothing. */
interface Ended extends Base {
  kind: 'ended';
}

type Gesture = Press | MoveDrag | CardDrag | Resize | Ended;

type Listener = [EventTarget, string, EventListener, AddEventListenerOptions | boolean];

const translate = (x: number) => `translate3d(${Math.round(x)}px, 0, 0)`;
const lifted = (x: number) => LIFT.replace('VAR_X', `${Math.round(x)}px`);

export class LaneGestures {
  private g: Gesture | null = null;
  private listeners: Listener[] = [];
  private raf = 0;
  private lastFrame = 0;
  private scrollLeft = 0;
  private suppressClick = false;
  /** Last written position / width / passes per block element (skip unchanged writes). */
  private written = new WeakMap<HTMLElement, { x: number; w: number; p: number }>();
  private lastScale = 0;
  /** Blocks that just landed: they settle from where they were dropped. */
  private settle: { from: Map<Id, number>; tries: number } | null = null;
  /** Blocks still springing into place (each drop's own timer ends its own). */
  private settling = new Set<HTMLElement>();
  private settleTimers = new Set<number>();
  private slotTimer = 0;

  constructor(private host: LaneHost) {}

  /** A gesture that moves something is in progress (not just a press). */
  get dragging(): boolean {
    return !!this.g && (this.g.kind === 'move' || this.g.kind === 'card' || this.g.kind === 'resize');
  }

  /** The click that follows a drag (or a cancelled one) is not a click. Call from click handlers. */
  consumeClick(): boolean {
    return this.suppressClick;
  }

  /* ---------------------------------------------------------------- */
  /* Placement                                                        */
  /* ---------------------------------------------------------------- */

  /** Called by the lane after every render: place the blocks (or the live preview) and settle dropped blocks. */
  sync(): void {
    const g = this.g;
    if (g && (g.kind === 'move' || g.kind === 'card' || g.kind === 'resize')) {
      this.preview(g);
      return;
    }
    const layout = this.host.layout();
    const animate = this.lastScale === 0 || layout.pxPerBar === this.lastScale;
    this.lastScale = layout.pxPerBar;
    this.placeBase(animate);
    this.runSettle();
  }

  private placeBase(animate: boolean): void {
    const layout = this.host.layout();
    const x = new Map<Id, number>();
    const w = new Map<Id, number>();
    const p = new Map<Id, number>();
    for (const b of layout.blocks) {
      x.set(b.id, b.x);
      w.set(b.id, b.width);
      p.set(b.id, b.repeats);
    }
    this.place(x, w, p, layout.contentWidth + END_ROOM, { animate, flush: true });
    this.hideSlot();
  }

  /**
   * Write block positions. `flush` first lets the browser see the current
   * positions (React may have just moved elements in the DOM, and a moved
   * element would otherwise jump instead of sliding).
   */
  private place(x: Map<Id, number>, w: Map<Id, number> | null, passes: Map<Id, number> | null, contentWidth: number, opts: { animate: boolean; flush: boolean }): void {
    const track = this.host.track();
    const content = this.host.content();
    if (!track) return;
    if (!opts.animate) track.dataset.instant = '';
    if (opts.flush) void track.offsetWidth;
    for (const [id, bx] of x) {
      const el = this.host.blockEl(id);
      if (!el) continue;
      const prev = this.written.get(el);
      const bw = w?.get(id) ?? prev?.w ?? 0;
      const bp = passes?.get(id) ?? prev?.p ?? 1;
      if (!prev || prev.x !== bx) el.style.transform = translate(bx);
      if (!prev || prev.w !== bw) el.style.width = `${bw}px`;
      if (!prev || prev.p !== bp) el.style.setProperty('--passes', String(bp));
      this.written.set(el, { x: bx, w: bw, p: bp });
    }
    if (content) content.style.width = `max(100%, ${Math.ceil(contentWidth)}px)`;
    if (!opts.animate) {
      void track.offsetWidth;
      delete track.dataset.instant;
    }
  }

  private runSettle(): void {
    const s = this.settle;
    if (!s) return;
    const layout = this.host.layout();
    const els: [HTMLElement, number, number][] = [];
    for (const [id, from] of s.from) {
      const el = this.host.blockEl(id);
      const to = layout.blocks.find((b) => b.id === id)?.x;
      if (!el || to === undefined) continue;
      els.push([el, from, to]);
      s.from.delete(id);
    }
    if (!s.from.size || ++s.tries > 3) this.settle = null;
    if (!els.length) return;
    // Start where the block was dropped (lifted), then spring into the slot.
    for (const [el, from] of els) {
      el.style.transition = 'none';
      el.style.transform = lifted(from);
      el.dataset.settling = '';
    }
    void this.host.track()?.offsetWidth;
    for (const [el, , to] of els) {
      el.style.transition = '';
      el.style.transform = translate(to);
      const prev = this.written.get(el);
      if (prev) prev.x = to;
    }
    for (const [el] of els) this.settling.add(el);
    const timer = window.setTimeout(() => {
      this.settleTimers.delete(timer);
      for (const [el] of els) {
        delete el.dataset.settling;
        this.settling.delete(el);
      }
    }, SETTLE_MS);
    this.settleTimers.add(timer);
  }

  /* ---------------------------------------------------------------- */
  /* Starting gestures                                                */
  /* ---------------------------------------------------------------- */

  /** Pointer down on a block (its header or a part cell): a click, or a move once it travels. */
  pressBlock(e: PointerEvent, id: Id, el: HTMLElement): void {
    if (!this.canStart(e)) return;
    const t = e.target as Element | null;
    if (t?.closest('[data-no-drag], input, a, [role="menuitem"]')) return;
    if (t?.closest('button') && !t.closest('[data-cell]')) return;
    this.begin({ kind: 'press', pointerId: e.pointerId, captureEl: el, clientX: e.clientX, clientY: e.clientY, startX: e.clientX, startY: e.clientY, id, down: e });
  }

  /** Pointer down on a block's right-edge handle. */
  pressEdge(e: PointerEvent, id: Id, el: HTMLElement): void {
    if (!this.canStart(e)) return;
    e.stopPropagation();
    e.preventDefault();
    this.begin({ kind: 'edgePress', pointerId: e.pointerId, captureEl: el, clientX: e.clientX, clientY: e.clientY, startX: e.clientX, startY: e.clientY, id, down: e });
  }

  /** Pointer down on a scene card in the palette. */
  pressCard(e: PointerEvent, sceneId: Id, el: HTMLElement): void {
    if (!this.canStart(e)) return;
    const t = e.target as Element | null;
    if (t?.closest('button, input, a')) return;
    this.begin({ kind: 'cardPress', pointerId: e.pointerId, captureEl: el, clientX: e.clientX, clientY: e.clientY, startX: e.clientX, startY: e.clientY, id: sceneId, down: e });
  }

  private canStart(e: PointerEvent): boolean {
    if (e.button !== 0 || !e.isPrimary) return false;
    if (this.g && 'down' in this.g && this.g.down === e) return false;
    if (this.g) {
      // Another finger while something is carried: ignore it.
      if (this.dragging && e.pointerId !== this.g.pointerId) return false;
      // The same pointer pressing again: its release never reached us. Put things back and start over.
      this.cancel(false);
    }
    this.suppressClick = false;
    return true;
  }

  private begin(g: Press): void {
    this.g = g;
    // Pointer capture waits until the press becomes a drag: captured, a plain click on a part
    // cell would be sent to the block instead of the cell.
    const opts = { capture: true };
    this.listen(window, 'pointermove', this.onMove as EventListener, opts);
    this.listen(window, 'pointerup', this.onUp as EventListener, opts);
    this.listen(window, 'pointercancel', this.onCancel as EventListener, opts);
    this.listen(window, 'keydown', this.onKey as EventListener, opts);
    this.listen(window, 'keyup', this.onKey as EventListener, opts);
    this.listen(window, 'blur', this.onAbort, false);
    this.listen(document, 'visibilitychange', this.onVisibility, false);
    this.listen(g.captureEl, 'lostpointercapture', this.onLostCapture as EventListener, false);
    this.listen(window, 'scroll', this.onWindowScroll, { capture: true, passive: true });
    this.listen(window, 'resize', this.onWindowScroll, false);
  }

  /** Keep receiving this pointer's events while it is dragged, even outside the window. */
  private capture(g: Base): void {
    try {
      g.captureEl.setPointerCapture(g.pointerId);
    } catch {
      /* not an active pointer (a synthetic event) */
    }
  }

  private listen(target: EventTarget, type: string, fn: EventListener, opts: AddEventListenerOptions | boolean): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  private geometry(): Geometry | null {
    const scroller = this.host.scroller();
    const content = this.host.content();
    if (!scroller || !content) return null;
    const r = scroller.getBoundingClientRect();
    this.scrollLeft = scroller.scrollLeft;
    return { contentLeft0: content.getBoundingClientRect().left + this.scrollLeft, lane: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
  }

  private startMove(p: Press, ev: PointerEvent): void {
    const geo = this.geometry();
    const layout = this.host.layout();
    const pressed = layout.blocks.find((b) => b.id === p.id);
    if (!geo || !pressed) return this.finish();
    const lock = this.host.locked();
    if (lock) {
      this.host.refuse(lock);
      return this.endQuietly();
    }
    const order = this.host.order().map((b) => b.id);
    const sel = this.host.selection();
    let ids = sel.ids.includes(p.id) ? order.filter((id) => sel.ids.includes(id)) : [p.id];
    if (!ids.length) ids = [p.id];
    if (!sel.ids.includes(p.id)) this.host.selectOnly(p.id);
    const widths = new Map(layout.blocks.map((b) => [b.id, b.width]));
    let offset = 0;
    let pressedOffset = 0;
    for (const id of ids) {
      if (id === p.id) pressedOffset = offset;
      offset += widths.get(id) ?? 0;
    }
    const startContentX = p.startX - geo.contentLeft0 + this.scrollLeft;
    const g: MoveDrag = {
      kind: 'move',
      pointerId: p.pointerId,
      captureEl: p.captureEl,
      clientX: ev.clientX,
      clientY: ev.clientY,
      ...geo,
      ids,
      moving: new Set(ids),
      list: layout.blocks.map((b) => ({ id: b.id })),
      widths,
      groupWidth: offset,
      grab: startContentX - pressed.x + pressedOffset,
      copy: ev.ctrlKey || ev.altKey || ev.metaKey,
      outside: false,
      gap: null,
    };
    this.g = g;
    this.capture(g);
    this.host.setDragUi({ kind: 'move', ids, copy: g.copy, outside: false });
    this.updateMove(g);
  }

  private startCard(p: Press, ev: PointerEvent): void {
    const geo = this.geometry();
    if (!geo) return this.finish();
    const lock = this.host.locked();
    if (lock) {
      this.host.refuse(lock);
      return this.endQuietly();
    }
    const g: CardDrag = { kind: 'card', pointerId: p.pointerId, captureEl: p.captureEl, clientX: ev.clientX, clientY: ev.clientY, ...geo, sceneId: p.id, slotWidth: this.host.sceneWidth(p.id), target: NO_TARGET, open: false, outside: true };
    this.g = g;
    this.capture(g);
    this.host.setDragUi({ kind: 'card', sceneId: p.id, layerInto: null, outside: true });
    this.updateCard(g);
  }

  private startResize(p: Press, ev: PointerEvent): void {
    const layout = this.host.layout();
    const b = layout.blocks.find((x) => x.id === p.id);
    if (!b || b.totalBars <= 0) return this.endQuietly();
    const lock = this.host.locked();
    if (lock) {
      this.host.refuse(lock);
      return this.endQuietly();
    }
    const g: Resize = {
      kind: 'resize',
      pointerId: p.pointerId,
      captureEl: p.captureEl,
      clientX: ev.clientX,
      clientY: ev.clientY,
      id: p.id,
      startX: p.startX,
      r0: b.repeats,
      r: b.repeats,
      step: edgeStepPx(b.passBars, layout.pxPerBar),
      passBars: b.passBars,
      pxPerBar: layout.pxPerBar,
    };
    this.g = g;
    this.capture(g);
    this.host.setDragUi({ kind: 'resize', id: p.id });
    this.updateResize(g);
  }

  /* ---------------------------------------------------------------- */
  /* Pointer and key events                                           */
  /* ---------------------------------------------------------------- */

  private onMove = (ev: PointerEvent): void => {
    const g = this.g;
    if (!g || ev.pointerId !== g.pointerId) return;
    g.clientX = ev.clientX;
    g.clientY = ev.clientY;
    if (g.kind === 'ended') return;
    if (g.kind === 'press' || g.kind === 'edgePress' || g.kind === 'cardPress') {
      if (Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY) < DRAG_THRESHOLD_PX) return;
      ev.preventDefault();
      if (g.kind === 'press') this.startMove(g, ev);
      else if (g.kind === 'edgePress') this.startResize(g, ev);
      else this.startCard(g, ev);
      return;
    }
    ev.preventDefault();
    if (g.kind === 'move') {
      const copy = ev.ctrlKey || ev.altKey || ev.metaKey;
      if (copy !== g.copy) this.setCopy(g, copy);
      this.updateMove(g);
      this.autoScroll();
    } else if (g.kind === 'card') {
      this.updateCard(g);
      this.autoScroll();
    } else if (g.kind === 'resize') {
      this.updateResize(g);
    }
  };

  private onUp = (ev: PointerEvent): void => {
    const g = this.g;
    if (!g || ev.pointerId !== g.pointerId) return;
    g.clientX = ev.clientX;
    g.clientY = ev.clientY;
    if (g.kind === 'move') {
      const copy = ev.ctrlKey || ev.altKey || ev.metaKey;
      if (copy !== g.copy) this.setCopy(g, copy);
      this.updateMove(g);
      this.dropMove(g);
    } else if (g.kind === 'card') {
      this.updateCard(g);
      this.dropCard(g);
    } else if (g.kind === 'resize') {
      this.updateResize(g);
      this.dropResize(g);
    } else if (g.kind === 'ended') {
      this.blockClick();
      this.finish();
    } else {
      // A press that never travelled: a plain click (the click handlers do the rest).
      this.finish();
    }
  };

  private onCancel = (ev: PointerEvent): void => {
    if (this.g && ev.pointerId === this.g.pointerId) this.cancel(false);
  };

  private onLostCapture = (ev: PointerEvent): void => {
    if (this.g && ev.pointerId === this.g.pointerId) this.cancel(false);
  };

  private onAbort = (): void => {
    if (this.g) this.cancel(false);
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.onAbort();
  };

  private onWindowScroll = (ev: Event): void => {
    const g = this.g;
    if (!g || (g.kind !== 'move' && g.kind !== 'card')) return;
    // The lane's own scrolling comes through onScroll; this is the page or the window moving the lane.
    if (ev.target === this.host.scroller()) return;
    const geo = this.geometry();
    if (!geo) return;
    Object.assign(g, geo);
    if (g.kind === 'move') this.updateMove(g);
    else this.updateCard(g);
  };

  /** The lane scrolled (wheel, keyboard or auto-scroll): keep the dragged blocks under the pointer. */
  onScroll(scrollLeft: number): void {
    this.scrollLeft = scrollLeft;
    const g = this.g;
    if (g?.kind === 'move') this.updateMove(g);
    else if (g?.kind === 'card') this.updateCard(g);
  }

  private onKey = (ev: KeyboardEvent): void => {
    const g = this.g;
    if (!g) return;
    if (ev.key === 'Escape' && ev.type === 'keydown') {
      if (g.kind === 'move' || g.kind === 'card' || g.kind === 'resize') {
        ev.preventDefault();
        ev.stopPropagation();
        this.cancel(true);
      }
      return;
    }
    if (g.kind === 'move' && (ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta')) {
      // Copy follows the modifier while it is held, also without moving the pointer.
      const copy = ev.type === 'keydown' ? true : ev.ctrlKey || ev.altKey || ev.metaKey;
      if (copy !== g.copy) {
        this.setCopy(g, copy);
        this.updateMove(g);
      }
      if (ev.key === 'Alt') ev.preventDefault();
      return;
    }
    // Keys other than the modifiers do nothing while blocks are carried (no stray note or shortcut).
    if (g.kind === 'move' || g.kind === 'card' || g.kind === 'resize') {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };

  /* ---------------------------------------------------------------- */
  /* Live previews                                                    */
  /* ---------------------------------------------------------------- */

  private contentX(g: Geometry & Base): number {
    return g.clientX - g.contentLeft0 + this.scrollLeft;
  }

  /**
   * Away from the lane: above or below it, beyond DROP_MARGIN. A release there
   * cancels. Past its left or right end still counts (first or last place).
   */
  private isOutside(g: Geometry & Base): boolean {
    return g.clientY < g.lane.top - DROP_MARGIN || g.clientY > g.lane.bottom + DROP_MARGIN;
  }

  private setCopy(g: MoveDrag, copy: boolean): void {
    g.copy = copy;
    // The gap counts different lists in the two modes.
    g.gap = null;
    this.host.setDragUi({ kind: 'move', ids: g.ids, copy, outside: g.outside });
  }

  private updateMove(g: MoveDrag): void {
    const left = this.contentX(g) - g.grab;
    const outside = this.isOutside(g);
    const flipped = outside !== g.outside;
    if (flipped) {
      g.outside = outside;
      this.host.setDragUi({ kind: 'move', ids: g.ids, copy: g.copy, outside });
    }
    const clone = this.host.cloneEl();
    if (clone) clone.style.transform = lifted(left);
    const prevGap = g.gap;
    if (!outside) {
      const widths = g.copy ? g.list.map((b) => g.widths.get(b.id) ?? 0) : g.list.filter((b) => !g.moving.has(b.id)).map((b) => g.widths.get(b.id) ?? 0);
      g.gap = targetGap(widths, g.groupWidth, left + g.groupWidth / 2, g.gap);
    }
    if (flipped || g.gap !== prevGap || prevGap === null) this.preview(g);
    else this.label(g);
  }

  /** The full-list insertion point a move drop would commit (null: nothing would change). */
  private moveGap(g: MoveDrag): number | null {
    if (g.outside || g.gap === null) return null;
    if (g.copy) return g.gap;
    const gap = fullGap(g.list, g.moving, g.gap);
    const next = orderAfterMove(g.list, g.ids, gap);
    return next.every((b, i) => b.id === g.list[i].id) ? null : gap;
  }

  private label(g: MoveDrag): void {
    const el = this.host.labelEl();
    if (!el) return;
    const what = g.ids.length > 1 ? `${g.ids.length} blocks` : '';
    let text: string;
    if (g.outside || g.gap === null) text = 'Release to cancel';
    else if (g.copy) text = `+ Copy ${what ? `${what} ` : ''}to position ${g.gap + 1}`;
    else {
      const gap = this.moveGap(g);
      text = gap === null ? 'Back in place' : `Move ${what ? `${what} ` : ''}to position ${orderAfterMove(g.list, g.ids, gap).findIndex((b) => g.moving.has(b.id)) + 1}`;
    }
    if (el.textContent !== text) el.textContent = text;
  }

  private updateCard(g: CardDrag): void {
    const ghost = this.host.ghostEl();
    if (ghost) ghost.style.transform = `translate3d(${Math.round(g.clientX + 14)}px, ${Math.round(g.clientY + 12)}px, 0)`;
    const outside = this.isOutside(g) || g.clientY > g.lane.bottom;
    const layout = this.host.layout();
    const order = this.host.order();
    const blocks = layout.blocks.map((b, i) => ({ x: b.x, width: b.width, layerable: order[i]?.layerable ?? false }));
    const next = outside ? NO_TARGET : cardTarget(blocks, this.contentX(g), g.target, g.open ? g.slotWidth : 0);
    const moved = !sameCardTarget(next, g.target);
    const changed = moved || outside !== g.outside;
    g.target = next;
    g.outside = outside;
    if (moved) {
      g.open = false;
      window.clearTimeout(this.slotTimer);
      if (next.kind === 'insert') this.slotTimer = window.setTimeout(() => this.openSlot(g), SLOT_DELAY_MS);
    }
    if (changed) {
      const layerInto = next.kind === 'layer' ? (layout.blocks[next.index]?.id ?? null) : null;
      this.host.setDragUi({ kind: 'card', sceneId: g.sceneId, layerInto, outside });
      this.preview(g);
    }
    const el = this.host.labelEl();
    if (el) {
      const name = this.host.sceneName(g.sceneId);
      const text =
        next.kind === 'insert'
          ? `Insert ${name} as block ${next.gap + 1}`
          : next.kind === 'layer'
            ? `Layer ${name} into ${order[next.index]?.name ?? 'this block'}`
            : 'Drop on the song to add it';
      if (el.textContent !== text) el.textContent = text;
    }
  }

  private openSlot(g: CardDrag): void {
    if (this.g !== g || g.target.kind !== 'insert' || g.open) return;
    g.open = true;
    this.preview(g);
  }

  private updateResize(g: Resize): void {
    const r = repeatsFromEdge(g.r0, g.clientX - g.startX, g.step);
    if (r !== g.r || !this.host.bubbleEl()?.textContent) {
      g.r = r;
      this.preview(g);
    }
  }

  /** Write the live preview of a gesture. */
  private preview(g: MoveDrag | CardDrag | Resize): void {
    const layout = this.host.layout();
    const widthOf = (id: Id) => layout.blocks.find((b) => b.id === id)?.width ?? 0;
    const ids = layout.blocks.map((b) => b.id);
    if (g.kind === 'move') {
      const gap = g.outside ? null : g.gap;
      let x: Map<Id, number>;
      let extra = 0;
      if (gap === null) x = new Map(layout.blocks.map((b) => [b.id, b.x]));
      else if (g.copy) {
        x = packPositions(ids, widthOf, { at: gap, width: g.groupWidth });
        extra = g.groupWidth;
      } else x = packPositions(orderAfterMove(g.list, g.ids, fullGap(g.list, g.moving, gap)).map((b) => b.id), widthOf);
      this.place(x, null, null, layout.contentWidth + extra + END_ROOM, { animate: true, flush: false });
      const clone = this.host.cloneEl();
      if (clone) clone.style.transform = lifted(this.contentX(g) - g.grab);
      this.label(g);
      return;
    }
    if (g.kind === 'card') {
      const t = g.target;
      const slot = this.host.slotEl();
      const ghost = this.host.ghostEl();
      if (ghost) ghost.style.transform = `translate3d(${Math.round(g.clientX + 14)}px, ${Math.round(g.clientY + 12)}px, 0)`;
      if (t.kind === 'insert') {
        const width = g.open ? g.slotWidth : 0;
        const x = packPositions(ids, widthOf, { at: t.gap, width });
        this.place(x, null, null, layout.contentWidth + width + END_ROOM, { animate: true, flush: false });
        const left = t.gap < layout.blocks.length ? layout.blocks[t.gap].x : layout.contentWidth;
        if (slot) {
          slot.style.transform = translate(left);
          slot.style.width = `${g.open ? g.slotWidth : 0}px`;
          slot.dataset.on = '';
          if (g.open) delete slot.dataset.pending;
          else slot.dataset.pending = '';
        }
      } else {
        this.place(new Map(layout.blocks.map((b) => [b.id, b.x])), null, null, layout.contentWidth + END_ROOM, { animate: true, flush: false });
        this.hideSlot();
      }
      return;
    }
    // Resize: the block takes its new width at the scale the drag started with; the blocks after it follow.
    const w = new Map<Id, number>();
    const passes = new Map<Id, number>();
    for (const b of layout.blocks) {
      w.set(b.id, b.id === g.id ? blockWidth(g.passBars * g.r, g.pxPerBar) : b.width);
      passes.set(b.id, b.id === g.id ? g.r : b.repeats);
    }
    const x = packPositions(ids, (id) => w.get(id) ?? 0);
    let total = 0;
    for (const v of w.values()) total += v;
    this.place(x, w, passes, total + END_ROOM, { animate: true, flush: false });
    const bubble = this.host.bubbleEl();
    if (bubble) {
      bubble.textContent = this.host.resizeLabel(g.id, g.r);
      bubble.style.transform = translate((x.get(g.id) ?? 0) + (w.get(g.id) ?? 0));
      bubble.dataset.on = '';
    }
  }

  private hideSlot(): void {
    const slot = this.host.slotEl();
    if (slot) {
      delete slot.dataset.on;
      delete slot.dataset.pending;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Auto-scroll                                                      */
  /* ---------------------------------------------------------------- */

  private velocity(): number {
    const g = this.g;
    if (!g || (g.kind !== 'move' && g.kind !== 'card')) return 0;
    if (g.clientY < g.lane.top - DROP_MARGIN || g.clientY > g.lane.bottom + DROP_MARGIN) return 0;
    return autoScrollVelocity(g.clientX, g.lane.left, g.lane.right);
  }

  private autoScroll(): void {
    if (this.raf || !this.velocity()) return;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    const v = this.velocity();
    const scroller = this.host.scroller();
    if (!v || !scroller) return;
    const dt = Math.min(50, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    const before = scroller.scrollLeft;
    scroller.scrollLeft = before + (v * dt) / 1000;
    this.onScroll(scroller.scrollLeft);
    this.raf = requestAnimationFrame(this.frame);
  };

  /* ---------------------------------------------------------------- */
  /* Drops                                                            */
  /* ---------------------------------------------------------------- */

  private landedFrom(g: MoveDrag): Map<Id, number> {
    const left = this.contentX(g) - g.grab;
    const from = new Map<Id, number>();
    let off = 0;
    for (const id of g.ids) {
      from.set(id, left + off);
      off += g.widths.get(id) ?? 0;
    }
    return from;
  }

  private dropMove(g: MoveDrag): void {
    const gap = this.moveGap(g);
    const from = this.landedFrom(g);
    this.finish();
    this.blockClick();
    this.host.setDragUi(null);
    // The render that follows (the drag UI goes away) calls sync(), which places every block
    // from the new layout and lets the landed ones settle from where they were dropped.
    const landed = gap === null ? null : this.host.commitMove(g.ids, gap, g.copy);
    if (!landed) {
      // Back where they were: originals spring home from the drop point (a copy just vanishes).
      if (!g.copy) this.settle = { from, tries: 0 };
      return;
    }
    const settleFrom = new Map<Id, number>();
    const fromList = [...from.values()];
    landed.forEach((id, i) => settleFrom.set(id, fromList[i] ?? fromList[0] ?? 0));
    this.settle = { from: settleFrom, tries: 0 };
  }

  private dropCard(g: CardDrag): void {
    const t = g.outside ? NO_TARGET : g.target;
    const layout = this.host.layout();
    this.finish();
    this.blockClick();
    this.host.setDragUi(null);
    if (t.kind === 'insert') this.host.commitInsert(g.sceneId, t.gap);
    else if (t.kind === 'layer') {
      const id = layout.blocks[t.index]?.id;
      if (id) this.host.commitLayer(id, g.sceneId);
    }
  }

  private dropResize(g: Resize): void {
    this.finish();
    this.blockClick();
    this.host.setDragUi(null);
    if (g.r !== g.r0) this.host.commitRepeats(g.id, g.r);
  }

  /** Esc, a lost pointer, blur: put everything back, commit nothing. */
  cancel(waitForUp: boolean): void {
    const g = this.g;
    if (!g) return;
    const from = g.kind === 'move' && !g.copy ? this.landedFrom(g) : null;
    const moved = g.kind === 'move' || g.kind === 'card' || g.kind === 'resize';
    if (waitForUp) this.endQuietly();
    else this.finish();
    if (!moved) return;
    if (from) this.settle = { from, tries: 0 };
    // Its render calls sync(), which puts every block back.
    this.host.setDragUi(null);
  }

  /** Stop the gesture but keep listening until the pointer comes up, so its click is swallowed. */
  private endQuietly(): void {
    const g = this.g;
    if (!g) return;
    this.stopAutoScroll();
    this.hideTransient();
    this.g = { kind: 'ended', pointerId: g.pointerId, captureEl: g.captureEl, clientX: g.clientX, clientY: g.clientY };
  }

  private blockClick(): void {
    this.suppressClick = true;
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
  }

  private hideTransient(): void {
    this.hideSlot();
    const bubble = this.host.bubbleEl();
    if (bubble) delete bubble.dataset.on;
  }

  private stopAutoScroll(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** End the gesture: every listener removed, capture released, nothing left half-done. */
  private finish(): void {
    const g = this.g;
    this.g = null;
    window.clearTimeout(this.slotTimer);
    this.stopAutoScroll();
    this.hideTransient();
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
    if (g) {
      try {
        if (g.captureEl.hasPointerCapture(g.pointerId)) g.captureEl.releasePointerCapture(g.pointerId);
      } catch {
        /* element already gone */
      }
    }
  }

  /** The song changed underneath a gesture (undo, another view): drop the gesture, commit nothing. */
  externalChange(): void {
    if (this.dragging) this.cancel(true);
  }

  /** The lane unmounts or its view goes away. */
  dispose(): void {
    const wasDragging = this.dragging;
    this.finish();
    for (const t of this.settleTimers) window.clearTimeout(t);
    this.settleTimers.clear();
    for (const el of this.settling) delete el.dataset.settling;
    this.settling.clear();
    if (wasDragging) this.host.setDragUi(null);
  }
}
