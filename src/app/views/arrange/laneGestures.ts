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
 * - Slides are Web Animations with both ends given, so nothing ever forces a
 *   layout to start one (a block React just moved in the DOM still slides),
 *   and a slide retargeted mid-way starts where the block is on screen.
 * - Geometry is read once when a gesture starts (and again after the page or
 *   window moves the lane); pointer moves and the lane's own scrolling never
 *   read layout: the scroll position and the visible width are tracked.
 * - What a drag shows is what its drop commits: the preview order comes from
 *   orderAfterMove, the same function the moveBlocks command uses.
 * - Every gesture ends through one path (`finish`), which removes every
 *   listener it added and releases pointer capture: on drop, Escape, a release
 *   away from the lane, pointercancel, loss of our pointer capture, window
 *   blur, a hidden tab, an outside change to the song, or the lane unmounting.
 * - While something is carried, other pointers (a second finger, a pen) are
 *   ignored on the lane: they cannot edit the song under the drag.
 * - Touch: a finger lifts a block or a scene card only after it rests on it
 *   (HOLD_MS, moving less than HOLD_SLOP_PX); a finger that moves first is a
 *   swipe, which the browser turns into native scrolling (the blocks allow
 *   panning, see touch-action in SongPanel.module.css) and the press ends
 *   with nothing done. Once a press is held, the lane owns the touch: its
 *   touchmove listener (`ownsTouch`) stops the browser panning, and the
 *   long-press menu the browser would open is swallowed. A hold let go
 *   without moving opens the block's actions (the part picker on a cell), as
 *   a long press did. Mouse and pen drag at once (after DRAG_THRESHOLD_PX);
 *   the right-edge handle is immediate for every pointer.
 */
import type { Id } from '../../../project/types';
import type { LayerMode } from '../../../state/commands/arrangement';
import { orderAfterMove } from '../../../state/commands';
import {
  DRAG_THRESHOLD_PX,
  Dwell,
  NO_TARGET,
  autoScrollVelocity,
  badgePlacement,
  cardTarget,
  edgeDragVelocity,
  edgeStepPx,
  fullGap,
  ghostFlips,
  packPositions,
  repeatsFromEdge,
  sameCardTarget,
  targetGap,
  type CardTarget,
  type LaneSelection,
} from './songDrag';
import { blockWidth, type SongLayout } from './songLayout';
import { EASE_SLIDE_CSS, EASE_SPRING_CSS, RESIZE_SLIDE_MS, SETTLE_MS, SLIDE_MS, ZOOM_MS, easeSlide, easeSpring, prefersReducedMotion } from './laneMotion';

/** How far above or below the lane (px) a drop still counts. */
export const DROP_MARGIN = 40;
/**
 * A scene card resting on a boundary for this long opens the insertion slot
 * (until then a line marks it). The rest starts again whenever the pointer
 * moves (more than DWELL_SLOP_PX, or faster than DWELL_MAX_SPEED: see Dwell),
 * so passing over a boundary on the way to the middle of a block, however
 * slowly, never pushes that block away; only a deliberate rest does.
 */
export const SLOT_DELAY_MS = 250;
/** A finger resting this long (ms) on a block or a scene card lifts it. */
export const HOLD_MS = 300;
/** A finger that moves this far (px) before the hold is a swipe (the lane scrolls), not a lift. */
export const HOLD_SLOP_PX = 8;
/** After a touch gesture, the browser's own long-press menu is swallowed for this long (ms). */
const MENU_GUARD_MS = 800;

export type DragUi =
  /** `held`: lifted by a finger's press-and-hold (the lift is shown as a short animation). */
  | { kind: 'move'; ids: Id[]; copy: boolean; outside: boolean; held?: boolean }
  | { kind: 'card'; sceneId: Id; layerInto: Id | null; replace: boolean; outside: boolean; held?: boolean }
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
  /** The status text inside the clone or ghost ("Move to position 3"), the clone's label chip, the ghost's second line. */
  labelEl(): HTMLElement | null;
  badgeEl(): HTMLElement | null;
  ghostHintEl(): HTMLElement | null;
  /** The lane and the scene palette: where other pointers are ignored while something is carried. */
  contains(node: Node): boolean;

  layout(): SongLayout;
  /** Visible width of the lane (px; from its ResizeObserver, so reading it costs no layout). */
  viewport(): number;
  /** Blocks in song order, with whether their scene exists. */
  order(): readonly { id: Id; layerable: boolean; name: string }[];
  selection(): LaneSelection;
  /** A performance take records: the song cannot be edited. */
  locked(): boolean;
  /** Width of a new block of this scene at the current scale. */
  sceneWidth(sceneId: Id): number;
  sceneName(sceneId: Id): string;
  /** What dropping the card on a block would do ("Layer Lift into Groove" and a second line). */
  layerText(blockId: Id, sceneId: Id, mode: LayerMode): { title: string; hint: string | null };

  setDragUi(ui: DragUi | null): void;
  selectOnly(id: Id): void;
  /** A gesture was refused because the song is locked: say so quietly on the lane. */
  refuseLocked(): void;

  /** Commit a move (copy: duplicate) of `ids` to insertion gap `gap` of the full list; returns the ids that land (moved or new), or null. */
  commitMove(ids: Id[], gap: number, copy: boolean): Id[] | null;
  commitInsert(sceneId: Id, gap: number): Id | null;
  commitLayer(blockId: Id, sceneId: Id, mode: LayerMode): void;
  commitRepeats(id: Id, repeats: number): void;
  /** Live label for the edge bubble ("3 times · 12 bars"). */
  resizeLabel(id: Id, repeats: number): string;
  /** The block's length as its header shows it while its edge is dragged ("12 bars"). */
  lengthLabel(id: Id, repeats: number): string;
  /** A finger held on block `id` and let go without moving: open its actions (or the part picker, on a cell). */
  holdMenu(id: Id, target: Element | null): void;
}

interface Base {
  pointerId: number;
  captureEl: HTMLElement;
  clientX: number;
  clientY: number;
}

/** The pointer state a gesture keeps from its press: where it started and whether a finger held it. */
interface Origin {
  startX: number;
  startY: number;
  /** A finger (touch): a block or card lifts only after a hold. */
  touch: boolean;
  /** The finger rested long enough: the gesture was lifted by a hold. */
  held: boolean;
  /** What the press landed on (a part cell opens the picker after a hold let go in place). */
  pressedEl: Element | null;
}

interface Press extends Base, Origin {
  kind: 'press' | 'edgePress' | 'cardPress';
  id: Id;
  /** The pointerdown that started it (a handler further up the tree may see the same event). */
  down: PointerEvent;
}

/** The pointer fields a gesture needs from the event that starts it (a hold starts one without an event). */
type PointerPos = Pick<PointerEvent, 'clientX' | 'clientY' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>;

interface Geometry {
  /** Client x of the content's left edge when scrollLeft is 0. */
  contentLeft0: number;
  lane: { left: number; right: number; top: number; bottom: number };
}

interface MoveDrag extends Base, Geometry, Origin {
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

interface CardDrag extends Base, Geometry, Origin {
  kind: 'card';
  sceneId: Id;
  slotWidth: number;
  target: CardTarget;
  /** The insertion slot is open (the blocks after it moved aside); before that a line marks it. */
  open: boolean;
  /** Which way the pointer was going when the slot opened (see OpenSlot.dir). */
  slotDir: -1 | 0 | 1;
  /** Whether (and since when) the pointer rests; which way it goes. */
  dwell: Dwell;
  outside: boolean;
  /** Shift held: layering replaces the block's parts instead of filling its silent ones. */
  replace: boolean;
}

interface Resize extends Base, Geometry {
  kind: 'resize';
  id: Id;
  startX: number;
  /** The lane's scroll position when the drag started (scrolling during the drag adds to the distance). */
  scroll0: number;
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

/** A running Web Animation of a block's x, with what it needs to know where the block is now. */
interface Slide {
  anim: Animation;
  from: number;
  to: number;
  dur: number;
  ease: (t: number) => number;
}

const translate = (x: number) => `translate3d(${Math.round(x)}px, 0, 0)`;
/** Lifted look while a block is carried (also the start of its settle animation). */
const lifted = (x: number) => `translate3d(${Math.round(x)}px, -3px, 0) scale(1.015)`;

export class LaneGestures {
  private g: Gesture | null = null;
  private listeners: Listener[] = [];
  private raf = 0;
  private lastFrame = 0;
  /** A pointer move arrived while the lane auto-scrolls: the next frame applies it. */
  private pendingMove = false;
  /** The lane's scroll position as last seen or set (tracked, never read during a gesture). */
  private scrollLeft = 0;
  /** Width last written to the content (px). */
  private contentPx = 0;
  private suppressClick = false;
  /** Last written position / width / passes per block element (skip unchanged writes). */
  private written = new WeakMap<HTMLElement, { x: number; w: number; p: number }>();
  private slides = new WeakMap<HTMLElement, Slide>();
  private running = new Set<Animation>();
  private lastScale = 0;
  /** Blocks that just landed: they settle from where they were dropped. */
  private settle: { from: Map<Id, number>; tries: number } | null = null;
  private slotTimer = 0;
  private badge: { side: string; shift: number } | null = null;
  /** Where the lifted copy was last put (view coordinates), to write only changes. */
  private cloneAt: { el: HTMLElement | null; x: number } = { el: null, x: NaN };
  private ghostAt = '';
  /** A finger is waiting to lift what it rests on. */
  private holdTimer = 0;
  /** The current gesture is a finger the lane has taken over (held, or on an edge): the browser must not pan. */
  private touchOwned = false;
  /** Where the press-and-hold look is shown (the pressed block or card). */
  private pressingEl: HTMLElement | null = null;

  constructor(private host: LaneHost) {}

  /** A gesture that moves something is in progress (not just a press). */
  get dragging(): boolean {
    return !!this.g && (this.g.kind === 'move' || this.g.kind === 'card' || this.g.kind === 'resize');
  }

  /**
   * The lane owns the finger now down (a held block or card, an edge drag):
   * its touchmove must not scroll the page or the lane. Call from a
   * non-passive touchmove listener and preventDefault when true.
   */
  get ownsTouch(): boolean {
    return this.touchOwned && !!this.g;
  }

  /** The click that follows a drag (or a cancelled one) is not a click. Call from click handlers. */
  consumeClick(): boolean {
    return this.suppressClick;
  }

  /** The lane's scroll position as the gestures know it. */
  get scroll(): number {
    return this.scrollLeft;
  }

  /**
   * The lane is being auto-scrolled by a drag: its scroll events are the echo
   * of positions already applied, so the lane need not read the position (a
   * read after the pointer moved would force a style and layout update).
   */
  get scrolling(): boolean {
    return this.raf !== 0 && this.dragging;
  }

  /* ---------------------------------------------------------------- */
  /* Placement                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Called by the lane after every render: place the blocks (or the live
   * preview) and settle dropped blocks. A change of scale places them at once
   * (the lane animates a zoom itself, see `animateZoom`). `keepView` keeps the
   * content at least as wide as what is in view (false for a zoom, which
   * scrolls to its own anchor and asks for `minWidth` to have room for it).
   */
  sync(keepView = true, minWidth = 0): void {
    const g = this.g;
    if (g && (g.kind === 'move' || g.kind === 'card' || g.kind === 'resize')) {
      this.preview(g);
      return;
    }
    const layout = this.host.layout();
    const animate = this.lastScale !== 0 && layout.pxPerBar === this.lastScale;
    this.lastScale = layout.pxPerBar;
    this.placeBase(animate, keepView, minWidth);
    this.runSettle();
  }

  private placeBase(animate: boolean, keepView = true, minWidth = 0): void {
    const layout = this.host.layout();
    const x = new Map<Id, number>();
    const w = new Map<Id, number>();
    const p = new Map<Id, number>();
    for (const b of layout.blocks) {
      x.set(b.id, b.x);
      w.set(b.id, b.width);
      p.set(b.id, b.repeats);
    }
    this.place(x, w, p, Math.max(minWidth, layout.contentWidth + layout.room), { animate, keepView });
    this.hideSlot();
  }

  /**
   * Write block positions (sliding from where each block is now when
   * `animate`), widths and passes, and the content width. The content never
   * gets narrower than what is in view, so a shorter song does not pull the
   * lane (and the block under the pointer) sideways; the extra room goes at
   * the next placement after a scroll.
   */
  private place(x: Map<Id, number>, w: Map<Id, number> | null, passes: Map<Id, number> | null, contentWidth: number, opts: { animate: boolean; dur?: number; keepView?: boolean }): void {
    const content = this.host.content();
    const animate = opts.animate && !prefersReducedMotion();
    const dur = opts.dur ?? SLIDE_MS;
    for (const [id, bx] of x) {
      const el = this.host.blockEl(id);
      if (!el) continue;
      const prev = this.written.get(el);
      const bw = w?.get(id) ?? prev?.w ?? 0;
      const bp = passes?.get(id) ?? prev?.p ?? 1;
      if (!prev || prev.x !== bx) {
        if (animate && prev) this.slide(el, this.currentX(el, prev.x), bx, dur);
        else {
          this.stopSlide(el);
          el.style.transform = translate(bx);
        }
      }
      if (!prev || prev.w !== bw) el.style.width = `${bw}px`;
      if (!prev || prev.p !== bp) el.style.setProperty('--passes', String(bp));
      this.written.set(el, { x: bx, w: bw, p: bp });
    }
    // Keeping the view only ever stops the content shrinking under it; it never makes it wider.
    const kept = this.contentPx ? Math.min(this.contentPx, Math.floor(this.scrollLeft) + this.host.viewport()) : 0;
    const width = Math.ceil(opts.keepView === false ? contentWidth : Math.max(contentWidth, kept));
    if (content && width !== this.contentPx) {
      this.contentPx = width;
      content.style.width = `max(100%, ${width}px)`;
    }
  }

  /** Where a block is on screen now (its running slide, or where it was placed). */
  private currentX(el: HTMLElement, fallback: number): number {
    const s = this.slides.get(el);
    if (!s) return fallback;
    const t = Number(s.anim.currentTime ?? 0) / s.dur;
    if (s.anim.playState === 'finished' || t >= 1) return s.to;
    return s.from + (s.to - s.from) * s.ease(Math.max(0, t));
  }

  private stopSlide(el: HTMLElement): void {
    const s = this.slides.get(el);
    if (!s) return;
    this.slides.delete(el);
    this.running.delete(s.anim);
    delete el.dataset.settling;
    s.anim.cancel();
  }

  private track(el: HTMLElement, anim: Animation, from: number, to: number, dur: number, ease: (t: number) => number, done?: () => void): void {
    this.slides.set(el, { anim, from, to, dur, ease });
    this.running.add(anim);
    const end = () => {
      this.running.delete(anim);
      if (this.slides.get(el)?.anim === anim) this.slides.delete(el);
      done?.();
    };
    anim.onfinish = end;
    anim.oncancel = end;
  }

  /** Slide a block from x `from` to `to` (its resting transform is `to` at once; the animation only shows the way there). */
  private slide(el: HTMLElement, from: number, to: number, dur: number): void {
    this.stopSlide(el);
    el.style.transform = translate(to);
    if (Math.abs(from - to) < 0.5 || dur <= 0 || typeof el.animate !== 'function') return;
    const anim = el.animate([{ transform: translate(from) }, { transform: translate(to) }], { duration: dur, easing: EASE_SLIDE_CSS });
    this.track(el, anim, from, to, dur, easeSlide);
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
    // Spring from where the block was let go (lifted) into its slot, starting with the next frame.
    for (const [el, from, to] of els) {
      this.stopSlide(el);
      el.style.transform = translate(to);
      const prev = this.written.get(el);
      if (prev) prev.x = to;
      if (prefersReducedMotion() || typeof el.animate !== 'function') continue;
      el.dataset.settling = '';
      const anim = el.animate([{ transform: lifted(from) }, { transform: translate(to) }], { duration: SETTLE_MS, easing: EASE_SPRING_CSS });
      this.track(el, anim, from, to, SETTLE_MS, easeSpring, () => {
        if (!this.slides.has(el)) delete el.dataset.settling;
      });
    }
  }

  /**
   * After a change of scale: every block glides from where it was on screen
   * (`from`, lane coordinates after the change) to its new place and width.
   */
  animateZoom(from: ReadonlyMap<Id, { x: number; w: number }>): void {
    if (prefersReducedMotion()) return;
    const layout = this.host.layout();
    for (const b of layout.blocks) {
      const f = from.get(b.id);
      const el = this.host.blockEl(b.id);
      if (!f || !el || typeof el.animate !== 'function') continue;
      if (Math.abs(f.x - b.x) < 0.5 && Math.abs(f.w - b.width) < 0.5) continue;
      this.stopSlide(el);
      const anim = el.animate(
        [
          { transform: translate(f.x), width: `${f.w}px` },
          { transform: translate(b.x), width: `${b.width}px` },
        ],
        { duration: ZOOM_MS, easing: EASE_SLIDE_CSS },
      );
      this.track(el, anim, f.x, b.x, ZOOM_MS, easeSlide);
    }
  }

  /** Where each block is on screen now, in lane coordinates (for a zoom to start from). */
  positions(): Map<Id, { x: number; w: number }> {
    const out = new Map<Id, { x: number; w: number }>();
    for (const b of this.host.layout().blocks) {
      const el = this.host.blockEl(b.id);
      const prev = el ? this.written.get(el) : undefined;
      out.set(b.id, { x: el && prev ? this.currentX(el, prev.x) : b.x, w: prev?.w ?? b.width });
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Starting gestures                                                */
  /* ---------------------------------------------------------------- */

  /** The press fields every gesture starts with. */
  private origin(e: PointerEvent): Base & Origin {
    return { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, startX: e.clientX, startY: e.clientY, touch: e.pointerType === 'touch', held: false, pressedEl: e.target as Element | null, captureEl: e.currentTarget as HTMLElement };
  }

  /** Pointer down on a block (its header or a part cell): a click, or a move once it travels (a finger: once it is held). */
  pressBlock(e: PointerEvent, id: Id, el: HTMLElement): void {
    if (!this.canStart(e)) return;
    const t = e.target as Element | null;
    if (t?.closest('[data-no-drag], input, a, [role="menuitem"]')) return;
    // A part cell, and with a mouse or pen the header's ▶ and ⋯ ([data-drag-ok]: on a compact block they
    // cover most of the header), stay buttons for a click and move the block once the press becomes a drag.
    if (t?.closest('button') && !t.closest('[data-cell]') && !(e.pointerType !== 'touch' && t.closest('[data-drag-ok]'))) return;
    this.begin({ ...this.origin(e), kind: 'press', captureEl: el, id, down: e });
  }

  /** Pointer down on a block's right-edge handle (immediate for every pointer, a finger too). */
  pressEdge(e: PointerEvent, id: Id, el: HTMLElement): void {
    if (!this.canStart(e)) return;
    e.stopPropagation();
    e.preventDefault();
    this.begin({ ...this.origin(e), kind: 'edgePress', captureEl: el, id, down: e });
  }

  /** Pointer down on a scene card in the palette (a finger: it lifts once it is held). */
  pressCard(e: PointerEvent, sceneId: Id, el: HTMLElement): void {
    if (!this.canStart(e)) return;
    const t = e.target as Element | null;
    if (t?.closest('button, input, a')) return;
    this.begin({ ...this.origin(e), kind: 'cardPress', captureEl: el, id: sceneId, down: e });
  }

  /** A finger rested on a block or card long enough: lift it where it is (the drag goes on from there). */
  private onHold = (): void => {
    this.holdTimer = 0;
    const g = this.g;
    if (!g || (g.kind !== 'press' && g.kind !== 'cardPress') || !g.touch || g.held) return;
    g.held = true;
    this.touchOwned = true;
    this.clearPressing();
    const at: PointerPos = { clientX: g.clientX, clientY: g.clientY, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
    if (g.kind === 'press') this.startMove(g, at);
    else this.startCard(g, at);
  };

  private clearPressing(): void {
    if (this.pressingEl) delete this.pressingEl.dataset.pressing;
    this.pressingEl = null;
  }

  /** After a touch gesture the browser may still open its long-press menu: swallow it for a moment. */
  private guardMenu(): void {
    const until = performance.now() + MENU_GUARD_MS;
    const swallow = (ev: Event) => {
      if (performance.now() > until) return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener('contextmenu', swallow, true);
    window.setTimeout(() => window.removeEventListener('contextmenu', swallow, true), MENU_GUARD_MS);
  }

  private canStart(e: PointerEvent): boolean {
    if (e.button !== 0 || !e.isPrimary) return false;
    if (this.g && 'down' in this.g && this.g.down === e) return false;
    if (this.g) {
      // Another pointer while something is carried: ignore it.
      if (this.dragging && e.pointerId !== this.g.pointerId) return false;
      // The same pointer pressing again (its release never reached us), or a press that never became a drag: start over.
      this.cancel(false);
    }
    this.suppressClick = false;
    return true;
  }

  private begin(g: Press): void {
    this.g = g;
    if (g.touch) {
      if (g.kind === 'edgePress') this.touchOwned = true;
      else {
        // A finger lifts a block or card only after resting on it; until then the browser may scroll.
        this.holdTimer = window.setTimeout(this.onHold, HOLD_MS);
        this.pressingEl = g.captureEl;
        g.captureEl.dataset.pressing = '';
      }
    }
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
    // Other pointers pressing or clicking on the lane while something is carried are ignored.
    for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) this.listen(window, type, this.onOtherPointer, opts);
  }

  /** Keep receiving this pointer's events while it is dragged, even outside the window; the captured element shows the cursor. */
  private capture(g: Base, cursor: string): void {
    g.captureEl.style.cursor = cursor;
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

  private startMove(p: Press, ev: PointerPos): void {
    if (this.host.locked()) {
      this.host.refuseLocked();
      return this.endQuietly();
    }
    const geo = this.geometry();
    const layout = this.host.layout();
    const pressed = layout.blocks.find((b) => b.id === p.id);
    if (!geo || !pressed) return this.finish();
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
      startX: p.startX,
      startY: p.startY,
      touch: p.touch,
      held: p.held,
      pressedEl: p.pressedEl,
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
    this.badge = null;
    this.cloneAt = { el: null, x: NaN };
    this.capture(g, 'grabbing');
    this.host.setDragUi({ kind: 'move', ids, copy: g.copy, outside: false, held: g.held || undefined });
    this.updateMove(g);
  }

  private startCard(p: Press, ev: PointerPos): void {
    if (this.host.locked()) {
      this.host.refuseLocked();
      return this.endQuietly();
    }
    const geo = this.geometry();
    if (!geo) return this.finish();
    const g: CardDrag = {
      kind: 'card',
      pointerId: p.pointerId,
      captureEl: p.captureEl,
      clientX: ev.clientX,
      clientY: ev.clientY,
      startX: p.startX,
      startY: p.startY,
      touch: p.touch,
      held: p.held,
      pressedEl: p.pressedEl,
      ...geo,
      sceneId: p.id,
      slotWidth: this.host.sceneWidth(p.id),
      target: NO_TARGET,
      open: false,
      slotDir: 0,
      dwell: new Dwell(),
      outside: true,
      replace: ev.shiftKey,
    };
    this.g = g;
    this.capture(g, 'grabbing');
    this.host.setDragUi({ kind: 'card', sceneId: p.id, layerInto: null, replace: g.replace, outside: true, held: g.held || undefined });
    this.updateCard(g, true);
  }

  private startResize(p: Press, ev: PointerPos): void {
    const layout = this.host.layout();
    const b = layout.blocks.find((x) => x.id === p.id);
    if (!b || b.totalBars <= 0) return this.endQuietly();
    if (this.host.locked()) {
      this.host.refuseLocked();
      return this.endQuietly();
    }
    const geo = this.geometry();
    if (!geo) return this.finish();
    // The block whose edge is dragged is the one the next actions apply to.
    if (!this.host.selection().ids.includes(p.id)) this.host.selectOnly(p.id);
    const g: Resize = {
      kind: 'resize',
      pointerId: p.pointerId,
      captureEl: p.captureEl,
      clientX: ev.clientX,
      clientY: ev.clientY,
      ...geo,
      id: p.id,
      startX: p.startX,
      scroll0: this.scrollLeft,
      r0: b.repeats,
      r: b.repeats,
      step: edgeStepPx(b.passBars, layout.pxPerBar),
      passBars: b.passBars,
      pxPerBar: layout.pxPerBar,
    };
    this.g = g;
    this.capture(g, 'col-resize');
    this.host.setDragUi({ kind: 'resize', id: p.id });
    this.updateResize(g, true);
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
    if ((g.kind === 'press' || g.kind === 'cardPress') && g.touch) {
      // A finger waiting for its hold: moving first makes it a swipe (the browser scrolls), never a drag.
      if (Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY) > HOLD_SLOP_PX) this.endQuietly();
      return;
    }
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
    } else if (g.kind === 'card') {
      if (ev.shiftKey !== g.replace) this.setReplace(g, ev.shiftKey);
    }
    // While the lane auto-scrolls, its frame applies the pointer after scrolling (scroll first, then
    // write: nothing forces a layout); otherwise the preview follows the pointer at once.
    if (this.raf) {
      this.pendingMove = true;
      return;
    }
    this.afterScroll();
    this.autoScroll();
  };

  private onUp = (ev: PointerEvent): void => {
    const g = this.g;
    if (!g || ev.pointerId !== g.pointerId) return;
    g.clientX = ev.clientX;
    g.clientY = ev.clientY;
    if ((g.kind === 'move' || g.kind === 'card') && g.held && Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY) < HOLD_SLOP_PX) {
      // Held and let go in place: no move. A block shows its actions, as a long press does.
      const id = g.kind === 'move' ? g.ids.find((x) => this.host.blockEl(x) === g.captureEl) ?? g.ids[0] : null;
      const target = g.pressedEl;
      this.cancel(false);
      this.blockClick();
      if (id) this.host.holdMenu(id, target);
      return;
    }
    if (g.kind === 'move') {
      const copy = ev.ctrlKey || ev.altKey || ev.metaKey;
      if (copy !== g.copy) this.setCopy(g, copy);
      this.updateMove(g);
      this.dropMove(g);
    } else if (g.kind === 'card') {
      if (ev.shiftKey !== g.replace) this.setReplace(g, ev.shiftKey);
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

  /**
   * Only the end of our own capture counts. With touch and pen the element
   * under the finger holds the pointer (implicit capture) until we take it
   * for the block or card: its lostpointercapture bubbles up here and must
   * not cancel the drag that is just starting.
   */
  private onLostCapture = (ev: PointerEvent): void => {
    const g = this.g;
    if (!g || ev.pointerId !== g.pointerId || ev.target !== g.captureEl) return;
    this.cancel(false);
  };

  private onAbort = (): void => {
    if (this.g) this.cancel(false);
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.onAbort();
  };

  /** A press, click or menu from another pointer (a second finger, a pen) on the lane while something is carried: ignored. */
  private onOtherPointer = (ev: Event): void => {
    const g = this.g;
    // The browser's long-press menu while a finger holds a block, card or edge: swallowed.
    if (g && this.touchOwned && ev.type === 'contextmenu') {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!g || !this.dragging) return;
    const pid = (ev as PointerEvent).pointerId;
    if (pid === g.pointerId) return;
    const t = ev.target;
    if (!(t instanceof Node) || !this.host.contains(t)) return;
    ev.preventDefault();
    ev.stopPropagation();
  };

  private onWindowScroll = (ev: Event): void => {
    const g = this.g;
    if (!g || (g.kind !== 'move' && g.kind !== 'card' && g.kind !== 'resize')) return;
    // The lane's own scrolling comes through onScroll; this is the page or the window moving the lane.
    if (ev.target === this.host.scroller()) return;
    const geo = this.geometry();
    if (!geo) return;
    Object.assign(g, geo);
    this.afterScroll();
  };

  /**
   * The lane scrolled (wheel, keyboard, the follow or auto-scroll): keep the
   * dragged blocks under the pointer. A scroll this controller made itself
   * was already applied when it was made.
   */
  onScroll(scrollLeft: number): void {
    if (Math.abs(scrollLeft - this.scrollLeft) < 0.5) return;
    this.scrollLeft = scrollLeft;
    this.afterScroll();
  }

  private afterScroll(): void {
    const g = this.g;
    if (g?.kind === 'move') this.updateMove(g);
    else if (g?.kind === 'card') this.updateCard(g);
    else if (g?.kind === 'resize') this.updateResize(g);
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
    if (g.kind === 'card' && ev.key === 'Shift') {
      // Replace follows Shift while it is held.
      const replace = ev.type === 'keydown';
      if (replace !== g.replace) {
        this.setReplace(g, replace);
        this.updateCard(g, true);
      }
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
    this.host.setDragUi({ kind: 'move', ids: g.ids, copy, outside: g.outside, held: g.held || undefined });
  }

  private setReplace(g: CardDrag, replace: boolean): void {
    g.replace = replace;
    this.host.setDragUi({ kind: 'card', sceneId: g.sceneId, layerInto: this.layerInto(g), replace, outside: g.outside, held: g.held || undefined });
  }

  private updateMove(g: MoveDrag): void {
    const left = this.contentX(g) - g.grab;
    const outside = this.isOutside(g);
    const flipped = outside !== g.outside;
    if (flipped) {
      g.outside = outside;
      this.host.setDragUi({ kind: 'move', ids: g.ids, copy: g.copy, outside, held: g.held || undefined });
    }
    this.moveClone(g, left);
    const prevGap = g.gap;
    if (!outside) {
      const widths = g.copy ? g.list.map((b) => g.widths.get(b.id) ?? 0) : g.list.filter((b) => !g.moving.has(b.id)).map((b) => g.widths.get(b.id) ?? 0);
      g.gap = targetGap(widths, g.groupWidth, left + g.groupWidth / 2, g.gap);
    }
    if (flipped || g.gap !== prevGap || prevGap === null) this.preview(g);
    else this.label(g);
  }

  /**
   * The lifted copy follows the pointer; its label chip stays inside the
   * visible lane. The copy floats over the lane (not in the scrolled content),
   * so it is placed in view coordinates: auto-scrolling under a still pointer
   * writes nothing here.
   */
  private moveClone(g: MoveDrag, left: number): void {
    const clone = this.host.cloneEl();
    const x = Math.round(left - this.scrollLeft);
    if (clone && (clone !== this.cloneAt.el || x !== this.cloneAt.x)) {
      clone.style.transform = lifted(x);
      this.cloneAt = { el: clone, x };
    }
    const badge = this.host.badgeEl();
    if (!badge) return;
    const b = badgePlacement(x, g.groupWidth, 0, this.host.viewport());
    if (this.badge && this.badge.side === b.side && this.badge.shift === b.shift) return;
    this.badge = b;
    badge.dataset.side = b.side;
    badge.style.transform = b.shift ? `translateX(${b.shift}px)` : '';
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

  private layerInto(g: CardDrag): Id | null {
    return g.target.kind === 'layer' ? (this.host.layout().blocks[g.target.index]?.id ?? null) : null;
  }

  private placeGhost(g: CardDrag): void {
    const ghost = this.host.ghostEl();
    if (!ghost) return;
    // Near the window's right or bottom edge the card floats on the other side of the pointer, so its words stay readable.
    const x = ghostFlips(g.clientX, window.innerWidth) ? `calc(${Math.round(g.clientX - 14)}px - 100%)` : `${Math.round(g.clientX + 14)}px`;
    const y = g.clientY > window.innerHeight - 90 ? `calc(${Math.round(g.clientY - 12)}px - 100%)` : `${Math.round(g.clientY + 12)}px`;
    const t = `translate3d(${x}, ${y}, 0)`;
    if (t === this.ghostAt && ghost.style.transform === t) return;
    this.ghostAt = t;
    ghost.style.transform = t;
  }

  private updateCard(g: CardDrag, force = false): void {
    this.placeGhost(g);
    const outside = this.isOutside(g) || g.clientY > g.lane.bottom;
    const layout = this.host.layout();
    const order = this.host.order();
    const blocks = layout.blocks.map((b, i) => ({ x: b.x, width: b.width, layerable: order[i]?.layerable ?? false }));
    const x = this.contentX(g);
    // The pointer moved on the lane (itself, or the lane scrolled under it): any rest starts again.
    const restarted = g.dwell.sample(x, g.clientY, performance.now());
    const next = outside ? NO_TARGET : cardTarget(blocks, x, g.target, g.open ? { width: g.slotWidth, dir: g.slotDir } : null, g.dwell.dir);
    const moved = !sameCardTarget(next, g.target);
    const changed = moved || outside !== g.outside;
    g.target = next;
    g.outside = outside;
    if (moved) g.open = false;
    // The slot opens only once the pointer has rested on the boundary for SLOT_DELAY_MS.
    if (next.kind !== 'insert' || g.open) {
      window.clearTimeout(this.slotTimer);
      this.slotTimer = 0;
    } else if (moved || restarted || !this.slotTimer) {
      window.clearTimeout(this.slotTimer);
      this.slotTimer = window.setTimeout(() => {
        this.slotTimer = 0;
        this.openSlot(g);
      }, SLOT_DELAY_MS);
    }
    if (changed) {
      this.host.setDragUi({ kind: 'card', sceneId: g.sceneId, layerInto: this.layerInto(g), replace: g.replace, outside, held: g.held || undefined });
      this.preview(g);
    }
    if (!changed && !force) return;
    const el = this.host.labelEl();
    const hintEl = this.host.ghostHintEl();
    const name = this.host.sceneName(g.sceneId);
    let text = 'Drop on the song to add it';
    let hint: string | null = null;
    if (next.kind === 'insert') text = `Insert ${name} as block ${next.gap + 1}`;
    else if (next.kind === 'layer') {
      const id = this.layerInto(g);
      const t = id ? this.host.layerText(id, g.sceneId, g.replace ? 'replace' : 'fill') : null;
      text = t?.title ?? `Layer ${name} into ${order[next.index]?.name ?? 'this block'}`;
      hint = t?.hint ?? null;
    }
    if (el && el.textContent !== text) el.textContent = text;
    if (hintEl && hintEl.textContent !== (hint ?? '')) hintEl.textContent = hint ?? '';
  }

  private openSlot(g: CardDrag): void {
    if (this.g !== g || g.target.kind !== 'insert' || g.open || g.outside) return;
    g.open = true;
    g.slotDir = g.dwell.dir;
    this.preview(g);
  }

  private updateResize(g: Resize, force = false): void {
    const r = repeatsFromEdge(g.r0, g.clientX - g.startX + (this.scrollLeft - g.scroll0), g.step);
    if (r !== g.r || force) {
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
      this.place(x, null, null, layout.contentWidth + extra + layout.room, { animate: true });
      this.moveClone(g, this.contentX(g) - g.grab);
      this.label(g);
      return;
    }
    if (g.kind === 'card') {
      const t = g.target;
      const slot = this.host.slotEl();
      if (t.kind === 'insert') {
        const width = g.open ? g.slotWidth : 0;
        const x = packPositions(ids, widthOf, { at: t.gap, width });
        this.place(x, null, null, layout.contentWidth + width + layout.room, { animate: true });
        const left = t.gap < layout.blocks.length ? layout.blocks[t.gap].x : layout.contentWidth;
        if (slot) {
          slot.style.transform = translate(left);
          slot.style.width = `${g.open ? g.slotWidth : 0}px`;
          slot.dataset.on = '';
          if (g.open) delete slot.dataset.pending;
          else slot.dataset.pending = '';
        }
      } else {
        this.place(new Map(layout.blocks.map((b) => [b.id, b.x])), null, null, layout.contentWidth + layout.room, { animate: true });
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
    this.place(x, w, passes, total + layout.room, { animate: true, dur: RESIZE_SLIDE_MS });
    const bubble = this.host.bubbleEl();
    if (bubble) {
      bubble.textContent = this.host.resizeLabel(g.id, g.r);
      bubble.style.transform = translate((x.get(g.id) ?? 0) + (w.get(g.id) ?? 0));
      bubble.dataset.on = '';
    }
    // The header says the length the drop will give (an element React leaves empty while the edge is dragged).
    const live = this.host.blockEl(g.id)?.querySelector<HTMLElement>('[data-live-len]');
    const text = this.host.lengthLabel(g.id, g.r);
    if (live && live.textContent !== text) live.textContent = text;
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
    if (!g || (g.kind !== 'move' && g.kind !== 'card' && g.kind !== 'resize')) return 0;
    if (g.clientY < g.lane.top - DROP_MARGIN || g.clientY > g.lane.bottom + DROP_MARGIN) return 0;
    // An edge scrolls the lane only from its visible edge on: inside the lane the pointer never moves it.
    if (g.kind === 'resize') return edgeDragVelocity(g.clientX, g.lane.left, g.lane.right);
    return autoScrollVelocity(g.clientX, g.lane.left, g.lane.right);
  }

  private autoScroll(): void {
    if (this.raf || !this.velocity()) return;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /**
   * One auto-scroll step: the new position is computed from what is tracked
   * (no layout read), written once, and the preview follows in the same
   * frame; the scroll event that comes after it finds nothing left to do.
   */
  private frame = (now: number): void => {
    this.raf = 0;
    const scroller = this.host.scroller();
    if (!scroller || !this.dragging) return;
    const v = this.velocity();
    const dt = Math.min(50, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    let moved = false;
    if (v) {
      const max = Math.max(0, this.contentPx - this.host.viewport());
      const next = Math.max(0, Math.min(max, this.scrollLeft + (v * dt) / 1000));
      if (Math.abs(next - this.scrollLeft) >= 0.01) {
        scroller.scrollLeft = next;
        this.scrollLeft = next;
        moved = true;
      }
    }
    if (moved || this.pendingMove) {
      this.pendingMove = false;
      this.afterScroll();
    }
    if (v) this.raf = requestAnimationFrame(this.frame);
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
      if (id) this.host.commitLayer(id, g.sceneId, g.replace ? 'replace' : 'fill');
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
    this.stopHold();
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
    this.pendingMove = false;
  }

  private stopHold(): void {
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.clearPressing();
  }

  /** End the gesture: every listener removed, capture released, nothing left half-done. */
  private finish(): void {
    const g = this.g;
    this.g = null;
    window.clearTimeout(this.slotTimer);
    this.slotTimer = 0;
    this.stopHold();
    if (this.touchOwned) {
      this.touchOwned = false;
      this.guardMenu();
    }
    this.stopAutoScroll();
    this.hideTransient();
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
    if (g) {
      g.captureEl.style.cursor = '';
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
    for (const a of [...this.running]) a.cancel();
    this.running.clear();
    this.settle = null;
    if (wasDragging) this.host.setDragUi(null);
  }
}
