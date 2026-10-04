/**
 * Song view geometry (pure: no DOM, no React).
 *
 * The song is an absolute timeline, like GarageBand's Tracks area: bar `b`
 * sits at `b * pxPerBar` on every row, the ruler and the playhead alike, so
 * a region's left edge, its notches and the bar numbers always line up.
 * Positions are whole bars; whatever the pointer points at becomes a bar here
 * (snapBar for an edge or a region being moved, barAt for "the bar under the
 * pointer").
 *
 * The scale (pixels per bar) comes from a fixed ladder of zoom steps; Fit
 * picks the largest step that shows the whole song. The timeline always runs
 * on past the song's end (END_ROOM_BARS, and at least the width of the view)
 * so a loop can be dropped or stretched after the last one.
 *
 * Part rows share the free height (ROW_MIN_PX to ROW_MAX_PX each); the ruler
 * and the sections strip have fixed heights above them.
 */
import { MAX_SONG_BARS } from '../../../project/types';

/** Zoom steps (pixels per bar), smallest first. */
export const ZOOM_STEPS = [4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128] as const;
export const MIN_PX_PER_BAR = ZOOM_STEPS[0];
export const MAX_PX_PER_BAR = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** The scale of a song with nothing in it yet (about 24 bars on a 1366 px window). */
export const DEFAULT_PX_PER_BAR = 32;
/** Bars of free timeline kept after the song's end (to drop and stretch into). */
export const END_ROOM_BARS = 16;

/** Height of the ruler (bar numbers and the loop band) and of the sections strip, px. */
export const RULER_H = 30;
export const SECTIONS_H = 26;
/** Part rows are never shorter than this… */
export const ROW_MIN_PX = 40;
/** …nor taller than this (a tall window: about 1080 px and up). */
export const ROW_MAX_PX = 84;
/** Width of the sticky part headers at the left of the rows. */
export const HEADER_W = 168;
/** A narrower header for windows under 1280 px. */
export const HEADER_W_NARROW = 136;

/** Width of a region's edge grip (px): a press this close to an edge drags the edge. */
export const EDGE_GRIP_PX = 8;

/* ------------------------------------------------------------------ */
/* Bars and pixels                                                     */
/* ------------------------------------------------------------------ */

export function barToX(bar: number, pxPerBar: number): number {
  return bar * pxPerBar;
}

/** The (fractional) bar at timeline position `x`. */
export function xToBar(x: number, pxPerBar: number): number {
  return x / Math.max(1e-6, pxPerBar);
}

/** The bar line nearest to `x` (≥ 0): where an edge or a moved region snaps. */
export function snapBar(x: number, pxPerBar: number): number {
  return Math.max(0, Math.round(xToBar(x, pxPerBar)));
}

/** The bar `x` is in (≥ 0): where a click on an empty spot, or a drop, lands. */
export function barAt(x: number, pxPerBar: number): number {
  return Math.min(MAX_SONG_BARS - 1, Math.max(0, Math.floor(xToBar(x, pxPerBar))));
}

/**
 * The bar a click on the ruler means: the bar it is in, or the next one when
 * the click lands just before that bar's line (its number sits right of the
 * line, so a click a hair to its left still means it).
 */
export function rulerBarAt(x: number, pxPerBar: number): number {
  const slack = Math.min(6, pxPerBar * 0.25);
  return Math.min(MAX_SONG_BARS - 1, Math.max(0, Math.floor(xToBar(x + slack, pxPerBar))));
}

/** How many bars the timeline shows: the song, room after it, and at least what fills the view. */
export function timelineBars(songBars: number, viewBars: number): number {
  return Math.min(MAX_SONG_BARS, Math.max(Math.ceil(songBars) + END_ROOM_BARS, Math.ceil(viewBars)));
}


/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

/**
 * The scale that shows the whole song in `viewport` px (with a bar of room
 * either side): the largest zoom step that fits, the smallest when none
 * does. An empty song gets the default scale.
 */
export function fitZoom(songBars: number, viewport: number): number {
  if (!(songBars > 0)) return DEFAULT_PX_PER_BAR;
  const want = Math.max(1, viewport) / (songBars + 2);
  let best: number = MIN_PX_PER_BAR;
  for (const s of ZOOM_STEPS) if (s <= want) best = s;
  return best;
}

/** The ladder index of a scale (the nearest step). */
export function zoomIndex(pxPerBar: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) if (Math.abs(ZOOM_STEPS[i] - pxPerBar) < Math.abs(ZOOM_STEPS[best] - pxPerBar)) best = i;
  return best;
}

/**
 * The zoom step `by` steps from `pxPerBar` (dir 1 = in, -1 = out), or null at
 * the end of the ladder. A scale between two steps counts from the step past
 * it in that direction.
 */
export function zoomStep(pxPerBar: number, dir: 1 | -1, by = 1): number | null {
  const n = ZOOM_STEPS.length;
  if (dir > 0) {
    const i = ZOOM_STEPS.findIndex((s) => s > pxPerBar + 1e-6);
    return i < 0 ? null : ZOOM_STEPS[Math.min(n - 1, i + Math.max(1, by) - 1)];
  }
  let i = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (ZOOM_STEPS[j] < pxPerBar - 1e-6) {
      i = j;
      break;
    }
  }
  return i < 0 ? null : ZOOM_STEPS[Math.max(0, i - Math.max(1, by) + 1)];
}

/**
 * The scroll position after a zoom from `from` to `to` px per bar that keeps
 * the bar at `pointerX` (px from the timeline's visible left edge) under it.
 */
export function zoomScroll(scrollLeft: number, pointerX: number, from: number, to: number): number {
  const bar = xToBar(scrollLeft + pointerX, from);
  return Math.max(0, barToX(bar, to) - pointerX);
}

/* ------------------------------------------------------------------ */
/* Ruler and grid                                                      */
/* ------------------------------------------------------------------ */

const STEPS = [1, 2, 4, 8, 16, 32, 64] as const;

/** Bars between numbers on the ruler: numbers at least `minPx` apart. */
export function labelStep(pxPerBar: number, minPx = 44): number {
  return STEPS.find((s) => s * pxPerBar >= minPx) ?? 64;
}

/** Bars between the grid lines drawn on the rows: lines at least 6 px apart. */
export function gridStep(pxPerBar: number): number {
  return STEPS.find((s) => s * pxPerBar >= 6) ?? 64;
}

export interface RulerMark {
  /** 0-based bar. */
  bar: number;
  x: number;
  /** Shows its number (1-based, as people count). */
  label: boolean;
}

/** Bar lines of the ruler from bar `from` to bar `to`: a numbered line every labelStep bars, plain lines on the grid between. */
export function rulerMarks(pxPerBar: number, from: number, to: number): RulerMark[] {
  const step = labelStep(pxPerBar);
  const grid = Math.min(step, gridStep(pxPerBar));
  const out: RulerMark[] = [];
  const first = Math.max(0, Math.floor(from / grid) * grid);
  for (let bar = first; bar <= Math.min(to, MAX_SONG_BARS); bar += grid) out.push({ bar, x: barToX(bar, pxPerBar), label: bar % step === 0 });
  return out;
}

/* ------------------------------------------------------------------ */
/* Following the playhead                                              */
/* ------------------------------------------------------------------ */

/** Share of the view left of the playhead after a page flip. */
export const FOLLOW_LEAD = 0.05;

/**
 * Where the timeline should scroll so the playhead at `x` stays in view, or
 * null when it is in view: like GarageBand, the view turns a page when the
 * playhead reaches its right edge (or is left of it).
 */
export function followScroll(x: number, scrollLeft: number, viewport: number, contentWidth: number): number | null {
  if (viewport <= 0) return null;
  if (x >= scrollLeft && x <= scrollLeft + viewport - 12) return null;
  const to = Math.max(0, Math.min(Math.max(0, contentWidth - viewport), x - viewport * FOLLOW_LEAD));
  return Math.abs(to - scrollLeft) < 1 ? null : to;
}

/* ------------------------------------------------------------------ */
/* Rows and regions                                                    */
/* ------------------------------------------------------------------ */

/** The height each of `rows` part rows gets from `free` px (within ROW_MIN_PX..ROW_MAX_PX). */
export function rowHeight(free: number, rows: number): number {
  if (!(rows > 0) || !Number.isFinite(free)) return ROW_MIN_PX;
  return Math.max(ROW_MIN_PX, Math.min(ROW_MAX_PX, Math.floor(free / rows)));
}

/** The row at `y` px below the first row's top (rows of `rowH`): -1 above the rows, ≥ the row count below them. */
export function rowAt(y: number, rowH: number): number {
  return y < 0 ? -1 : Math.floor(y / Math.max(1, rowH));
}

/**
 * Which edge of a region a press `x` px into it (of `width` px) grabs: the
 * outer EDGE_GRIP_PX at either end, less on a narrow region so its middle
 * can still be grabbed to move it.
 */
export function edgeAt(x: number, width: number): 'start' | 'end' | null {
  const grip = Math.min(EDGE_GRIP_PX, Math.max(3, width / 4));
  if (x >= width - grip) return 'end';
  if (x <= grip) return 'start';
  return null;
}
