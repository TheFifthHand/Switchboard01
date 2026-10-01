/**
 * Where the hint chip goes: the free spot nearest the top of the workspace
 * that covers nothing. The transport is never covered; the pads and the
 * keyboard are avoided as a whole (gaps included); every other control is
 * avoided, and text and displays are avoided where possible. When no spot is
 * free (a crowded view, a very small window), the spot that covers the least
 * wins, and controls count far more than text.
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
/** Headings, text, meters and displays. */
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

/* ------------------------------------------------------------------ */
/* Reading the page                                                    */
/* ------------------------------------------------------------------ */

const CONTROLS = 'button, a[href], input, select, textarea, [role="slider"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="button"], [role="menuitem"], [draggable="true"], [tabindex]:not([tabindex="-1"])';
const GRAPHICS = 'canvas, svg, img, [role="img"], [role="meter"], [role="progressbar"]';
/** Room kept between the chip and what it avoids. */
const MARGIN = 6;

function grow(r: DOMRect, by: number): Box {
  return { left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by };
}

function onScreen(r: DOMRect, vw: number, vh: number): boolean {
  return r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
}

/**
 * Everything the chip should not cover, read from the page (the chip itself
 * excluded): the transport, the pads and the keyboard, every control, and the
 * text and graphics on screen (each line of text by its own box, so a wide
 * heading element with short text leaves the rest of its row free).
 */
export function readObstacles(chip: Element | null, vw: number, vh: number, opts: { text?: boolean } = {}): Obstacle[] {
  const out: Obstacle[] = [];
  const add = (el: Element, weight: number, margin = MARGIN) => {
    if (chip?.contains(el) || el.closest('[inert]')) return;
    const r = el.getBoundingClientRect();
    if (onScreen(r, vw, vh)) out.push({ box: grow(r, margin), weight });
  };
  const transport = document.querySelector('header[aria-label="Transport"]');
  if (transport) add(transport, WEIGHT_FORBIDDEN, 4);
  const pads = document.getElementById('pad-surface');
  if (pads) add(pads, WEIGHT_PLAYED);
  const keyboard = document.querySelector('main ~ footer');
  if (keyboard) add(keyboard, WEIGHT_PLAYED);
  for (const el of document.querySelectorAll(CONTROLS)) add(el, WEIGHT_CONTROL);
  // The quick check while the chip is shown looks at controls only; text and graphics matter when choosing a spot.
  if (opts.text === false) return out;
  for (const el of document.querySelectorAll(GRAPHICS)) add(el, WEIGHT_INFO, 2);
  // Visible text, line by line.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue || !n.nodeValue.trim() || chip?.contains(n)) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (onScreen(r, vw, vh)) out.push({ box: grow(r, 2), weight: WEIGHT_INFO });
  }
  range.detach();
  return out;
}

/** The part of the window the chip may use: below the transport, inside the window edges. */
export function workArea(vw: number, vh: number): Box {
  const t = document.querySelector('header[aria-label="Transport"]')?.getBoundingClientRect();
  const top = t && t.bottom > 0 && t.top < vh ? t.bottom + 8 : 8;
  return { left: 10, top, right: vw - 10, bottom: vh - 10 };
}
