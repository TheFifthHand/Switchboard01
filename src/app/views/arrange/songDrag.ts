/**
 * Song lane gestures as pure functions (no DOM, no React): where a dragged
 * group of blocks lands, where every other block sits while it is dragged,
 * how many passes an edge drag makes, how fast the lane scrolls near its
 * edges, selection, the paste position and the scene-card drop target.
 *
 * The lane calls these on every pointer move and writes the results straight
 * to the DOM, so what a preview shows is exactly what the drop commits (the
 * preview order comes from `orderAfterMove`, the same function moveBlocks
 * uses).
 */

/** Movement (px) before a press becomes a drag; a shorter press is a click. */
export const DRAG_THRESHOLD_PX = 4;
/** How far (px) the dragged centre must pass the halfway point between two slots before the target changes. */
export const GAP_HYSTERESIS_PX = 10;
/** Width (px) of the lane edge zones that scroll it during a drag. */
export const AUTOSCROLL_ZONE_PX = 56;
/** Fastest auto-scroll (px per second), reached at (or past) the lane edge. */
export const AUTOSCROLL_MAX_PX_S = 900;
/** Smallest pointer travel (px) for one pass in an edge drag, so passes of a short block are still easy to hit. */
export const MIN_PASS_STEP_PX = 18;

type Id = string;

/* ------------------------------------------------------------------ */
/* Moving and copying blocks                                           */
/* ------------------------------------------------------------------ */

/** Left edge of each insertion slot among blocks of `widths` placed edge to edge (n + 1 values). */
export function slotLefts(widths: readonly number[]): number[] {
  const out = [0];
  for (const w of widths) out.push(out[out.length - 1] + w);
  return out;
}

/**
 * Insertion gap (0..n) among the `others` (the blocks that are not dragged)
 * for a dragged group of width `groupWidth` whose centre is at `centre`.
 *
 * The group goes to the slot whose centre is nearest, which is the same as
 * comparing its centre with the neighbours' midpoints. Next to the current
 * target the halfway point must be passed by `hysteresis` px, so a pointer
 * resting on a boundary never makes the blocks flicker; a fast move that
 * skips several slots is followed at once.
 */
export function targetGap(otherWidths: readonly number[], groupWidth: number, centre: number, current: number | null, hysteresis = GAP_HYSTERESIS_PX): number {
  const lefts = slotLefts(otherWidths);
  const centres = lefts.map((l) => l + groupWidth / 2);
  let best = 0;
  for (let g = 1; g < centres.length; g++) if (Math.abs(centre - centres[g]) < Math.abs(centre - centres[best])) best = g;
  if (current === null || current < 0 || current >= centres.length || best === current) return best;
  if (best === current + 1) {
    const half = (centres[current] + centres[current + 1]) / 2;
    return centre > half + hysteresis ? best : current;
  }
  if (best === current - 1) {
    const half = (centres[current] + centres[current - 1]) / 2;
    return centre < half - hysteresis ? best : current;
  }
  return best;
}

/**
 * Convert a gap among the others into the insertion point of the full list
 * that orderAfterMove / moveBlocks / duplicateBlocks expect.
 */
export function fullGap(list: readonly { id: Id }[], moving: ReadonlySet<Id>, othersGap: number): number {
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    if (moving.has(list[i].id)) continue;
    if (seen === othersGap) return i;
    seen++;
  }
  return list.length;
}

/** The gap among the others where the moving blocks are now (the slot of the first of them). */
export function currentOthersGap(list: readonly { id: Id }[], moving: ReadonlySet<Id>): number {
  let g = 0;
  for (const b of list) {
    if (moving.has(b.id)) return g;
    g++;
  }
  return g;
}

/**
 * Positions of blocks placed edge to edge in `order`, with an optional
 * empty slot of `slot.width` px opened before index `slot.at`.
 */
export function packPositions(order: readonly Id[], widthOf: (id: Id) => number, slot?: { at: number; width: number } | null): Map<Id, number> {
  const out = new Map<Id, number>();
  let x = 0;
  order.forEach((id, i) => {
    if (slot && i === slot.at) x += slot.width;
    out.set(id, x);
    x += widthOf(id);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Labels that follow a drag stay readable                             */
/* ------------------------------------------------------------------ */

/** Room (px) kept between a drag label and the lane's visible edge. */
export const LABEL_INSET_PX = 4;

/**
 * Where the label under a dragged group sits so the lane edge never cuts it:
 * in the left half of the view it starts at the group's left edge, in the
 * right half it ends at the group's right edge, and either way it is pushed
 * back inside the visible part of the lane. `shift` is in px from that edge.
 */
export function badgePlacement(left: number, width: number, scrollLeft: number, viewport: number): { side: 'left' | 'right'; shift: number } {
  const lo = scrollLeft + LABEL_INSET_PX;
  const hi = scrollLeft + viewport - LABEL_INSET_PX;
  const centre = left + width / 2;
  if (centre > scrollLeft + viewport / 2) return { side: 'right', shift: Math.round(Math.min(0, hi - (left + width))) };
  return { side: 'left', shift: Math.round(Math.max(0, lo - left)) };
}

/** Width (px) a scene card's floating label may need; nearer the window's right edge than this it flips to the pointer's left. */
export const GHOST_FLIP_PX = 300;

export function ghostFlips(clientX: number, windowWidth: number): boolean {
  return clientX > windowWidth - GHOST_FLIP_PX;
}

/* ------------------------------------------------------------------ */
/* Edge drag (length in passes)                                        */
/* ------------------------------------------------------------------ */

/** Pointer travel for one pass: the pass width at the lane's scale, never under MIN_PASS_STEP_PX. */
export function edgeStepPx(passBars: number, pxPerBar: number): number {
  return Math.max(MIN_PASS_STEP_PX, passBars * pxPerBar);
}

/** Repeats after dragging a block's right edge by `dx` px (whole passes, 1..max). */
export function repeatsFromEdge(startRepeats: number, dx: number, stepPx: number, max = 16): number {
  const r = startRepeats + Math.round(dx / Math.max(1, stepPx));
  return Math.min(max, Math.max(1, r));
}

/* ------------------------------------------------------------------ */
/* Auto-scroll                                                         */
/* ------------------------------------------------------------------ */

/**
 * Scroll velocity (px per second; negative = left) for a pointer at `x`
 * near the visible edges [left, right] of the lane: zero outside the edge
 * zones, growing towards the edge, fastest at and beyond it.
 */
export function autoScrollVelocity(x: number, left: number, right: number, zone = AUTOSCROLL_ZONE_PX, max = AUTOSCROLL_MAX_PX_S): number {
  const z = Math.max(1, Math.min(zone, (right - left) / 3));
  const into = (d: number) => {
    const f = Math.min(1, Math.max(0, (z - d) / z));
    return max * f * f;
  };
  if (x < left + z) return -into(x - left);
  if (x > right - z) return into(right - x);
  return 0;
}

/** Speed (px per second) of an edge drag's auto-scroll with the pointer right at the lane's visible edge. */
export const EDGE_SCROLL_MIN_PX_S = 240;
/** How far past the visible edge (px) an edge drag's auto-scroll reaches full speed. */
export const EDGE_SCROLL_RAMP_PX = 48;

/**
 * Auto-scroll for a block's right-edge drag: only once the pointer reaches or
 * passes the lane's visible edge (a pointer still inside the lane never
 * scrolls it, so the last block's edge cannot run away), faster the further
 * past the edge it goes.
 */
export function edgeDragVelocity(x: number, left: number, right: number, max = AUTOSCROLL_MAX_PX_S): number {
  const speed = (past: number) => {
    const f = Math.min(1, past / EDGE_SCROLL_RAMP_PX);
    return EDGE_SCROLL_MIN_PX_S + (max - EDGE_SCROLL_MIN_PX_S) * f * f;
  };
  if (x >= right - 1) return speed(x - (right - 1));
  if (x <= left + 1) return -speed(left + 1 - x);
  return 0;
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

export interface LaneSelection {
  /** Selected block ids in song order. */
  ids: readonly Id[];
  /** Where a Shift range starts. */
  anchor: Id | null;
}

export const EMPTY_SELECTION: LaneSelection = { ids: [], anchor: null };

/**
 * The selection the Loop button acts on: only one the user made (a click, a
 * modified click, the arrow keys, Ctrl+A), never one an action left behind
 * (the blocks a drop, a paste, a duplicate or a helper made).
 */
export interface LaneSelectionState extends LaneSelection {
  byUser: boolean;
}

function inOrder(order: readonly Id[], ids: Iterable<Id>): Id[] {
  const want = new Set(ids);
  return order.filter((id) => want.has(id));
}

function range(order: readonly Id[], a: Id, b: Id): Id[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return j >= 0 ? [b] : [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * A click on block `id`: plain = only it; `toggle` (Ctrl/Cmd) adds or
 * removes it; `shift` selects the range from the anchor (with `toggle`,
 * adds the range to what is selected).
 */
export function selectByClick(sel: LaneSelection, order: readonly Id[], id: Id, mods: { shift?: boolean; toggle?: boolean } = {}): LaneSelection {
  if (!order.includes(id)) return sel;
  if (mods.shift) {
    const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : id;
    const span = range(order, anchor, id);
    return { ids: inOrder(order, mods.toggle ? [...sel.ids, ...span] : span), anchor };
  }
  if (mods.toggle) {
    const has = sel.ids.includes(id);
    return { ids: inOrder(order, has ? sel.ids.filter((x) => x !== id) : [...sel.ids, id]), anchor: id };
  }
  return { ids: [id], anchor: id };
}

export type LaneKeyMove = 'prev' | 'next' | 'first' | 'last';

/**
 * Arrow keys / Home / End from the focused block: focus moves and the
 * selection follows it; with `extend` (Shift) the selection becomes the range
 * from the anchor to the new focus.
 */
export function selectByKey(sel: LaneSelection, order: readonly Id[], focus: Id | null, move: LaneKeyMove, extend: boolean): { selection: LaneSelection; focus: Id | null } {
  if (!order.length) return { selection: EMPTY_SELECTION, focus: null };
  const i = focus ? order.indexOf(focus) : -1;
  let j: number;
  if (move === 'first') j = 0;
  else if (move === 'last') j = order.length - 1;
  else if (i < 0) j = move === 'next' ? 0 : order.length - 1;
  else j = Math.min(order.length - 1, Math.max(0, i + (move === 'next' ? 1 : -1)));
  const to = order[j];
  if (!extend) return { selection: { ids: [to], anchor: to }, focus: to };
  const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : (focus && order.includes(focus) ? focus : to);
  return { selection: { ids: range(order, anchor, to), anchor }, focus: to };
}

export function selectAll(order: readonly Id[]): LaneSelection {
  return { ids: [...order], anchor: order[0] ?? null };
}

/** Drop ids that are no longer in the song (undo, another edit). Returns `sel` itself when nothing changed. */
export function pruneSelection(sel: LaneSelection, order: readonly Id[]): LaneSelection {
  const ids = inOrder(order, sel.ids);
  const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : (ids[0] ?? null);
  if (ids.length === sel.ids.length && ids.every((x, i) => x === sel.ids[i]) && anchor === sel.anchor) return sel;
  return { ids, anchor };
}

/** The blocks an action applies to: the selection when there is one, else the focused block. */
export function actionTargets(sel: LaneSelection, order: readonly Id[], focus: Id | null): Id[] {
  const ids = inOrder(order, sel.ids);
  if (ids.length) return ids;
  return focus && order.includes(focus) ? [focus] : [];
}

/** The blocks a block's own menu acts on: the selection when that block is in it, else the block alone. */
export function menuTargets(sel: LaneSelection, order: readonly Id[], id: Id): Id[] {
  const ids = inOrder(order, sel.ids);
  return ids.includes(id) ? ids : [id];
}

/**
 * Where pasted blocks go, the way the other block actions pick their blocks
 * (Ctrl+C, Ctrl+D, the block's menu): from a block (`focus`), right after the
 * selection when that block is in it, else right after the block; with no
 * block, after the selection, else at the end.
 */
export function pasteGap(order: readonly Id[], sel: LaneSelection, focus: Id | null): number {
  const targets = focus && order.includes(focus) ? menuTargets(sel, order, focus) : actionTargets(sel, order, null);
  if (!targets.length) return order.length;
  return order.indexOf(targets[targets.length - 1]) + 1;
}

/**
 * Where a moved selection goes with Alt+Left/Right: one block earlier or
 * later, as an insertion gap of the full list; null at the edge.
 */
export function nudgeGap(order: readonly Id[], ids: readonly Id[], dir: -1 | 1): number | null {
  const moving = new Set(ids);
  const idx = order.map((id, i) => (moving.has(id) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return null;
  if (dir < 0) {
    const first = idx[0];
    // The nearest block before the first moving one that is not moving itself.
    let j = first - 1;
    while (j >= 0 && moving.has(order[j])) j--;
    return j < 0 ? null : j;
  }
  const last = idx[idx.length - 1];
  let j = last + 1;
  while (j < order.length && moving.has(order[j])) j++;
  return j >= order.length ? null : j + 1;
}

/* ------------------------------------------------------------------ */
/* Scene card drop: insert between blocks, or layer into one           */
/* ------------------------------------------------------------------ */

export type CardTarget = { kind: 'none' } | { kind: 'insert'; gap: number } | { kind: 'layer'; index: number };

export const NO_TARGET: CardTarget = { kind: 'none' };

export interface CardBlock {
  x: number;
  width: number;
  /** False for a block whose scene is missing (it can only be dropped next to). */
  layerable: boolean;
}

/** Width of the zone at each end of a block that means "insert next to it" rather than "layer into it". */
export function cardEdge(width: number): number {
  return Math.min(40, Math.max(14, width * 0.25));
}

/** The insertion slot a scene card has opened (its blocks after it are drawn shifted right by `width`). */
export interface OpenSlot {
  width: number;
  /**
   * Which way the pointer was going when the slot opened (1 = right, -1 =
   * left, 0 = not known): the way it came to rest on the boundary.
   */
  dir: -1 | 0 | 1;
}

/**
 * Where a scene card being dragged at lane position `x` would go. Blocks are
 * given at their resting positions; while an insertion slot is open at a gap
 * (`slot`), the blocks after it are drawn shifted right by its width.
 *
 * Away from a target the answer comes from the resting layout: the middle of
 * a block layers into it, its ends (cardEdge) insert before or after it. The
 * current target is kept while the pointer stays over what it shows, so
 * opening or closing the slot never flips the target back and forth:
 * - a layer target: the middle of its block;
 * - an insertion with its slot open: only the edge zones next to the boundary
 *   and the slot itself. If the pointer goes on the way it came (`moving` is
 *   the slot's `dir`; either way when it came straight up or down, `dir` 0)
 *   past the next block's resting edge zone, it was passing through, not
 *   dropping: the slot closes and the resting layout decides (the middle of
 *   that block layers into it).
 */
export function cardTarget(blocks: readonly CardBlock[], x: number, current: CardTarget, slot: OpenSlot | null = null, moving: -1 | 0 | 1 = 0): CardTarget {
  const n = blocks.length;
  if (n === 0) return { kind: 'insert', gap: 0 };
  const end = blocks[n - 1].x + blocks[n - 1].width;
  if (current.kind === 'insert' && current.gap >= 0 && current.gap <= n) {
    const g = current.gap;
    const left = g < n ? blocks[g].x : end;
    const before = g > 0 ? cardEdge(blocks[g - 1].width) : Infinity;
    const after = g < n ? cardEdge(blocks[g].width) : Infinity;
    const width = slot ? Math.max(0, slot.width) : 0;
    // Passing through: on the way it came, or either way when it came straight up or down (dir 0).
    const passedRight = !!slot && slot.dir >= 0 && moving > 0 && x > left + after;
    const passedLeft = !!slot && slot.dir <= 0 && moving < 0 && x < left - before;
    if (!passedRight && !passedLeft && x >= left - before && x <= left + Math.max(width, after)) return current;
  } else if (current.kind === 'layer' && current.index >= 0 && current.index < n) {
    const b = blocks[current.index];
    const e = cardEdge(b.width);
    if (b.layerable && x >= b.x + e && x <= b.x + b.width - e) return current;
  }
  return restingCardTarget(blocks, x);
}

/** Where a card at lane position `x` goes on the resting layout (no slot open). */
export function restingCardTarget(blocks: readonly CardBlock[], x: number): CardTarget {
  const n = blocks.length;
  if (n === 0) return { kind: 'insert', gap: 0 };
  const end = blocks[n - 1].x + blocks[n - 1].width;
  if (x < 0) return { kind: 'insert', gap: 0 };
  if (x >= end) return { kind: 'insert', gap: n };
  for (let i = 0; i < n; i++) {
    const b = blocks[i];
    if (x >= b.x + b.width) continue;
    if (!b.layerable) return { kind: 'insert', gap: x < b.x + b.width / 2 ? i : i + 1 };
    const e = cardEdge(b.width);
    if (x < b.x + e) return { kind: 'insert', gap: i };
    if (x > b.x + b.width - e) return { kind: 'insert', gap: i + 1 };
    return { kind: 'layer', index: i };
  }
  return { kind: 'insert', gap: n };
}

/* ------------------------------------------------------------------ */
/* Resting on a boundary: when the insertion slot opens                */
/* ------------------------------------------------------------------ */

/** A pointer that moves more than this (px) since it last came to rest is moving again. */
export const DWELL_SLOP_PX = 3;
/** A pointer faster than this (px per ms) between two samples is moving, however short the step. */
export const DWELL_MAX_SPEED = 0.1;
/** Horizontal travel (px) that sets which way the pointer is going now. */
const DIR_STEP_PX = 2;
/** Net horizontal travel (px) that sets which way the pointer came (the slot's `dir`). */
export const NET_DIR_PX = 12;
/** Vertical travel (px) with less than NET_DIR_PX across: it came straight up or down (no way across). */
const NET_VERTICAL_PX = 36;

/**
 * Whether a dragged scene card has come to rest: the insertion slot opens
 * only after it rests on a boundary for SLOT_DELAY_MS. Each pointer sample
 * (lane x, client y, time in ms) either keeps the rest going or starts it
 * again: moving more than DWELL_SLOP_PX from where it came to rest, or faster
 * than DWELL_MAX_SPEED between two samples, restarts it. Also tracks which
 * way the pointer is going (`dir`, from the last DIR_STEP_PX of travel) and
 * which way it came (`netDir`, from its last NET_DIR_PX across; 0 after
 * NET_VERTICAL_PX up or down with less across).
 */
export class Dwell {
  private anchor: { x: number; y: number; t: number } | null = null;
  private last: { x: number; t: number } | null = null;
  private dirX = NaN;
  private net: { x: number; y: number } | null = null;
  /** Which way the pointer goes now (its last DIR_STEP_PX across): 1 right, -1 left, 0 not yet known. */
  dir: -1 | 0 | 1 = 0;
  /**
   * Which way it came: its last NET_DIR_PX of travel across (1 right, -1
   * left), or 0 when it came straight up or down (or has not travelled yet),
   * so a few pixels of wobble never decide it.
   */
  netDir: -1 | 0 | 1 = 0;

  /** Take a sample; true when it starts a new rest (the pointer moved). */
  sample(x: number, y: number, t: number): boolean {
    const last = this.last;
    this.last = { x, t };
    if (!Number.isFinite(this.dirX)) this.dirX = x;
    else if (Math.abs(x - this.dirX) >= DIR_STEP_PX) {
      this.dir = x > this.dirX ? 1 : -1;
      this.dirX = x;
    }
    const n = this.net;
    if (!n) this.net = { x, y };
    else if (Math.abs(x - n.x) >= NET_DIR_PX) {
      this.netDir = x > n.x ? 1 : -1;
      this.net = { x, y };
    } else if (Math.abs(y - n.y) >= NET_VERTICAL_PX) {
      this.netDir = 0;
      this.net = { x, y };
    }
    const a = this.anchor;
    const fast = !!last && t > last.t && Math.abs(x - last.x) / (t - last.t) > DWELL_MAX_SPEED;
    if (!a || fast || Math.abs(x - a.x) > DWELL_SLOP_PX || Math.abs(y - a.y) > DWELL_SLOP_PX) {
      this.anchor = { x, y, t };
      return true;
    }
    return false;
  }

  /** When the current rest began (ms), or null before the first sample. */
  get since(): number | null {
    return this.anchor?.t ?? null;
  }
}

export function sameCardTarget(a: CardTarget, b: CardTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'insert' && b.kind === 'insert') return a.gap === b.gap;
  if (a.kind === 'layer' && b.kind === 'layer') return a.index === b.index;
  return true;
}
