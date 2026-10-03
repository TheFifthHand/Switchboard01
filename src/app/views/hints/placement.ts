/**
 * Where the hint chip goes: the free spot nearest the top of the workspace
 * that covers nothing. The transport is never covered; the pads and the
 * keyboard are avoided as a whole (gaps included); every other control is
 * avoided, and so are headings (a view's title, a panel's name) and status
 * explanations (what "Playback follows", a recording's state); the rest of a
 * panel header's text (the Song header's "Export tail") comes next, then
 * other text and displays, avoided where possible. When no spot is free (a
 * crowded view, a very small window), the spot that covers the least wins:
 * controls, headings and status lines count far more than a panel header's
 * text, which counts more than other text.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Obstacle {
  box: Box;
  /** Cost per covered pixel. */
  weight: number;
  /** Never to be covered, whatever the room (see placeOk). */
  hard?: boolean;
}

export interface Spot {
  x: number;
  y: number;
  /** Weighted covered area (0 = covers nothing). */
  cost: number;
}

/** The transport must stay reachable: covering any of it costs more than covering everything else. */
export const WEIGHT_FORBIDDEN = 1e6;
/** The pad surface and the keyboard strip: played constantly, gaps included. */
export const WEIGHT_PLAYED = 3;
/** Buttons, knobs, sliders, fields. */
export const WEIGHT_CONTROL = 6;
/** Headings and status lines: what a view or panel is, and what is happening. Covering them hides the context. */
export const WEIGHT_KEY_TEXT = 6;
/** The text of a panel's header (labels of the controls beside it): avoided before other text, but never at a control's cost. */
export const WEIGHT_PANEL_TEXT = 2;
/** Other text, meters and displays. */
export const WEIGHT_INFO = 0.4;

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  if (w <= 0) return 0;
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return h > 0 ? w * h : 0;
}

export function spotCost(x: number, y: number, size: { w: number; h: number }, obstacles: readonly Obstacle[]): number {
  const box = { left: x, top: y, right: x + size.w, bottom: y + size.h };
  let cost = 0;
  for (const o of obstacles) {
    const a = overlap(box, o.box);
    if (a > 0) cost += a * o.weight;
  }
  return cost;
}

/**
 * Scan `area` top to bottom, left to right. The first spot that covers
 * nothing (cost within `tolerance`) wins; otherwise the cheapest one.
 */
export function findSpot(size: { w: number; h: number }, area: Box, obstacles: readonly Obstacle[], opts: { stepX?: number; stepY?: number; tolerance?: number } = {}): Spot {
  const stepX = opts.stepX ?? 8;
  const stepY = opts.stepY ?? 6;
  const tolerance = opts.tolerance ?? 0.5;
  const maxX = Math.max(area.left, area.right - size.w);
  const maxY = Math.max(area.top, area.bottom - size.h);
  // Only obstacles that can touch the area matter.
  const near = obstacles.filter((o) => o.box.right > area.left && o.box.left < area.right && o.box.bottom > area.top && o.box.top < area.bottom);
  let best: Spot | null = null;
  const xs: number[] = [];
  for (let x = area.left; x < maxX; x += stepX) xs.push(Math.round(x));
  xs.push(Math.round(maxX));
  for (let y = area.top; ; y += stepY) {
    const yy = Math.round(Math.min(y, maxY));
    // Obstacles in this band of rows.
    const band = near.filter((o) => o.box.bottom > yy && o.box.top < yy + size.h);
    for (const x of xs) {
      const cost = spotCost(x, yy, size, band);
      if (cost <= tolerance) return { x, y: yy, cost };
      if (!best || cost < best.cost) best = { x, y: yy, cost };
    }
    if (yy >= maxY) break;
  }
  return best ?? { x: area.left, y: area.top, cost: 0 };
}

/** The coarse grid of findSpotFast (px). */
export const COARSE_STEP = 32;
/** How many of the cheapest coarse cells above the first free one are looked at closely. */
const REFINE_CELLS = 10;

/**
 * findSpot's answer for much less work: every cell of a coarse 32 px grid is
 * costed once (no early exit), then the fine grid is searched only around
 * the first free cell and around the cheapest cells above it (a gap narrower
 * than the coarse grid, between two rows of controls, is found there). The
 * first free spot from the top wins, else the cheapest one.
 */
export function findSpotFast(size: { w: number; h: number }, area: Box, obstacles: readonly Obstacle[], opts: { tolerance?: number } = {}): Spot {
  const tolerance = opts.tolerance ?? 0.5;
  const maxX = Math.max(area.left, area.right - size.w);
  const maxY = Math.max(area.top, area.bottom - size.h);
  const near = obstacles.filter((o) => o.box.right > area.left && o.box.left < area.right && o.box.bottom > area.top && o.box.top < area.bottom);
  const xs: number[] = [];
  for (let x = area.left; x < maxX; x += COARSE_STEP) xs.push(Math.round(x));
  xs.push(Math.round(maxX));
  const cells: Spot[] = [];
  let firstFree: Spot | null = null;
  for (let y = area.top; !firstFree; y += COARSE_STEP) {
    const yy = Math.round(Math.min(y, maxY));
    const band = near.filter((o) => o.box.bottom > yy && o.box.top < yy + size.h);
    for (const x of xs) {
      const cell = { x, y: yy, cost: spotCost(x, yy, size, band) };
      cells.push(cell);
      if (cell.cost <= tolerance) {
        firstFree = cell;
        break;
      }
    }
    if (yy >= maxY) break;
  }
  // Where to look closely: the first free cell, and the cheapest cells before it.
  const candidates = cells
    .filter((c) => c !== firstFree)
    .sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x)
    .slice(0, REFINE_CELLS);
  if (firstFree) candidates.push(firstFree);
  let best: Spot | null = null;
  const better = (s: Spot) => {
    if (!best) return true;
    const free = s.cost <= tolerance;
    const bestFree = best.cost <= tolerance;
    if (free !== bestFree) return free;
    if (free) return s.y < best.y || (s.y === best.y && s.x < best.x);
    return s.cost < best.cost;
  };
  for (const c of candidates) {
    const around: Box = {
      left: Math.max(area.left, c.x - COARSE_STEP),
      top: Math.max(area.top, c.y - COARSE_STEP),
      right: Math.min(area.right, c.x + size.w + COARSE_STEP),
      bottom: Math.min(area.bottom, c.y + size.h + COARSE_STEP),
    };
    const s = findSpot(size, around, near, { tolerance });
    if (better(s)) best = s;
    if (better(c)) best = c;
  }
  return best ?? findSpot(size, area, near, { tolerance });
}

/* ------------------------------------------------------------------ */
/* Reading the page                                                    */
/* ------------------------------------------------------------------ */

/** Text that says what a view or panel is, or what is happening now (see WEIGHT_KEY_TEXT). */
const KEY_TEXT = 'h1, h2, h3, h4, h5, h6, [role="heading"], [role="status"], [role="alert"]';
/**
 * A panel's header (the Song header's totals and field labels such as
 * "Export tail"): it names what the controls beside it do, so it is avoided
 * before other text (see WEIGHT_PANEL_TEXT).
 */
const PANEL_TEXT = 'main header';
const CONTROLS = 'button, a[href], input, select, textarea, [role="slider"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="button"], [role="menuitem"], [draggable="true"], [tabindex]:not([tabindex="-1"])';
const GRAPHICS = 'canvas, svg, img, [role="img"], [role="meter"], [role="progressbar"]';
/**
 * Readouts people watch (meters, the spectrum, other graphics a view names)
 * and anything a view marks with data-hint-avoid: checked by the quick check
 * too, so the chip moves off a readout that appears under it later.
 */
const READOUTS = '[role="meter"], [role="img"], [data-hint-avoid]';
/** Room kept between the chip and what it avoids. */
const MARGIN = 6;
/**
 * Never in the way: inert content (behind a dialog), and passing layers
 * above the chip (the toasts' live region in body, tooltips). A toast that
 * briefly covers the chip is fine; the chip running from it onto a control
 * is not.
 */
const PASSING = '[inert], body > [aria-live], [role="tooltip"]';
/** The banners under the transport (a project open in another tab, playback stopped): their keys must stay reachable. */
const BANNERS = '[data-banners]';
/**
 * True when a spot covers nothing the chip must never cover, whatever the
 * room: the transport and the banners, the pads and the keyboard, controls,
 * and what a view marks data-hint-avoid (obstacles marked `hard`). Headings
 * and status lines are avoided wherever there is room, but a crowded view
 * may have the chip over one rather than nowhere.
 */
export function placeOk(x: number, y: number, size: { w: number; h: number }, obstacles: readonly Obstacle[]): boolean {
  return spotCost(x, y, size, obstacles.filter((o) => o.hard)) <= 0.5;
}

/**
 * The obstacles with what must never be covered made far dearer than any
 * amount of text, so a search prefers covering every line of text to
 * touching one control.
 */
export function hardened(obstacles: readonly Obstacle[]): Obstacle[] {
  return obstacles.map((o) => (o.hard && o.weight < WEIGHT_FORBIDDEN ? { ...o, weight: o.weight * 1e4 } : o));
}

function grow(r: DOMRect, by: number): Box {
  return { left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by };
}

function onScreen(r: DOMRect, vw: number, vh: number): boolean {
  return r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
}

/**
 * Everything the chip should not cover, read from the page (the chip itself
 * excluded): the transport, the pads and the keyboard, every control, the
 * headings and status lines, and the other text and graphics on screen (each
 * line of text by its own box, so a wide heading element with short text
 * leaves the rest of its row free).
 *
 * `text: false` is the quick check while the chip is shown: controls,
 * headings, status lines and panel headers only (a few elements), so a
 * part's longer name in a heading moves the chip as surely as a new button
 * does.
 */
export function readObstacles(chip: Element | null, vw: number, vh: number, opts: { text?: boolean } = {}): Obstacle[] {
  const out: Obstacle[] = [];
  // A view's hint home ([data-hint-home]) is where the chip may sit: what it holds is not in the way.
  const add = (el: Element, weight: number, margin = MARGIN, hard = false) => {
    if (chip?.contains(el) || el.closest(`${PASSING}, [data-hint-home]`)) return;
    const r = el.getBoundingClientRect();
    if (onScreen(r, vw, vh)) out.push({ box: grow(r, margin), weight, hard });
  };
  const transport = document.querySelector('header[aria-label="Transport"]');
  if (transport) add(transport, WEIGHT_FORBIDDEN, 4, true);
  const banners = document.querySelector(BANNERS);
  if (banners) add(banners, WEIGHT_FORBIDDEN, 4, true);
  const pads = document.getElementById('pad-surface');
  if (pads) add(pads, WEIGHT_PLAYED, MARGIN, true);
  const keyboard = document.querySelector('main ~ footer');
  if (keyboard) add(keyboard, WEIGHT_PLAYED, MARGIN, true);
  for (const el of document.querySelectorAll(CONTROLS)) add(el, WEIGHT_CONTROL, MARGIN, true);
  // What a view asks the chip to keep clear of counts like a status line, and is never covered; meters and the spectrum like other text.
  for (const el of document.querySelectorAll(READOUTS)) {
    const avoid = el.hasAttribute('data-hint-avoid');
    add(el, avoid ? WEIGHT_KEY_TEXT : WEIGHT_INFO, 2, avoid);
  }
  const range = document.createRange();
  /** Each visible line of text under `root`, at `weight`. */
  const addText = (root: Node, weight: number, margin: number, skip?: (n: Node) => boolean) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue || !n.nodeValue.trim() || chip?.contains(n) || skip?.(n) || n.parentElement?.closest(`${PASSING}, [data-hint-home]`)) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (onScreen(r, vw, vh)) out.push({ box: grow(r, margin), weight });
    }
  };
  // Headings and status lines that are on screen (not the transport's, which is out of bounds anyway, nor visually hidden ones).
  for (const el of document.querySelectorAll(KEY_TEXT)) {
    if (chip?.contains(el) || el.closest(`${PASSING}, header[aria-label="Transport"], ${BANNERS}`) || !onScreen(el.getBoundingClientRect(), vw, vh)) continue;
    addText(el, WEIGHT_KEY_TEXT, 4);
  }
  // The rest of a panel header's text (its headings and status lines are in already).
  for (const el of document.querySelectorAll(PANEL_TEXT)) {
    if (chip?.contains(el) || el.closest(PASSING) || !onScreen(el.getBoundingClientRect(), vw, vh)) continue;
    addText(el, WEIGHT_PANEL_TEXT, 4, (n) => !!n.parentElement?.closest(KEY_TEXT));
  }
  if (opts.text !== false) {
    for (const el of document.querySelectorAll(GRAPHICS)) add(el, WEIGHT_INFO, 2);
    // Other visible text, line by line (headings, status lines and panel headers are in already).
    addText(document.body, WEIGHT_INFO, 2, (n) => !!n.parentElement?.closest(`${KEY_TEXT}, ${PANEL_TEXT}`));
  }
  range.detach();
  return out;
}

/** The part of the window the chip may use: below the transport and any banner under it, inside the window edges. */
export function workArea(vw: number, vh: number): Box {
  let top = 8;
  for (const sel of ['header[aria-label="Transport"]', BANNERS]) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.height > 0 && r.bottom > 0 && r.top < vh) top = Math.max(top, r.bottom + 8);
  }
  return { left: 10, top, right: vw - 10, bottom: vh - 10 };
}
