/**
 * Song lane geometry (pure: no DOM, no React).
 *
 * Blocks sit edge to edge, left to right, with widths proportional to their
 * length in bars (one pass × repeats). A block is never narrower than the
 * minimum width of its scale (MIN_BLOCK_WIDTH, so its header stays usable;
 * at the overview steps below OVERVIEW_BELOW px per bar COMPACT_BLOCK_WIDTH,
 * with a compact header); the ruler, the playhead and the pass dividers map
 * bars through the same per-block geometry, so bar numbers always line up
 * with block edges even when a short block is widened.
 *
 * After the last block the lane keeps free room (`room`, one block width at
 * the scale) where blocks are dropped at the end and where the last block's
 * edge can be dragged out without reaching the lane's visible edge.
 *
 * The scale (pixels per bar) comes from a fixed ladder of zoom steps. The
 * lane fits the song (the largest step at which the whole song and its room
 * fit) when it opens and when the window is resized: at a readable step, or,
 * for a song of OVERVIEW_MIN_BLOCKS blocks or more, at an overview step
 * (compact blocks) when only that shows it whole; otherwise it opens
 * scrolling at a readable step (its shortest block about the minimum width,
 * within SCROLL_MAX_PX_PER_BAR). Fit song shows the whole song at any step
 * that does, else as much as the smallest step allows (fitSong). Edits keep
 * the scale the lane has (a longer song scrolls), so blocks never change size
 * under the pointer. Zooming keeps an anchor (a block and how far into it)
 * where it is on screen.
 */

export interface LaneBlockInput {
  id: string;
  /** Bars of one pass of the block (0 when its scene is missing: the song skips the block). */
  bars: number;
  /** 1..MAX_BLOCK_REPEATS */
  repeats: number;
}

export interface LaneBlock {
  id: string;
  index: number;
  x: number;
  width: number;
  /** First bar of the block on the song timeline (0-based). */
  startBar: number;
  /** Length of the block in bars (pass × repeats; 0 for a skipped block). */
  totalBars: number;
  /** Bars of one pass (0 for a skipped block). */
  passBars: number;
  repeats: number;
}

export interface SongLayout {
  blocks: LaneBlock[];
  totalBars: number;
  /** Pixels per bar of the proportional (non-widened) blocks. */
  pxPerBar: number;
  /** Right edge of the last block. */
  contentWidth: number;
  /** Free room kept after the last block (px). */
  room: number;
}

export const MIN_BLOCK_WIDTH = 112;
/** Narrowest block at an overview step (its header shows the name; play and actions on hover, focus or the menu). */
export const COMPACT_BLOCK_WIDTH = 44;
/**
 * A block narrower than this (px) is drawn compact: its name only in the
 * header, no clip names in its cells (SongPanel.module.css, the container
 * query at 95 px). Only overview steps make blocks this narrow.
 */
export const COMPACT_HEADER_BELOW = 96;
/** Zoom steps (pixels per bar), smallest first. The steps below OVERVIEW_BELOW show a long song whole. */
export const ZOOM_STEPS = [3, 4, 5, 6, 8, 10, 11, 12, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40, 45, 50, 56] as const;
/** Scales under this many px per bar are overview steps: blocks may be compact. */
export const OVERVIEW_BELOW = 10;
export const MIN_PX_PER_BAR = ZOOM_STEPS[0];
export const MAX_PX_PER_BAR = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** Largest scale of a song that scrolls (so one short block cannot make long ones huge). */
export const SCROLL_MAX_PX_PER_BAR = 25;
/** Most repeats a block can have (mirrors MAX_BLOCK_REPEATS; kept here so the geometry stays dependency-free). */
const MAX_REPEATS = 16;

export function clampRepeats(r: number): number {
  return Number.isFinite(r) ? Math.min(MAX_REPEATS, Math.max(1, Math.round(r))) : 1;
}

/** The narrowest a block may be at `pxPerBar` (compact at the overview steps). */
export function minBlockWidth(pxPerBar: number): number {
  return pxPerBar < OVERVIEW_BELOW ? COMPACT_BLOCK_WIDTH : MIN_BLOCK_WIDTH;
}

/** Free room after the last block at `pxPerBar`: one block width (drops at the end, the last block's edge). */
export function tailRoom(pxPerBar: number): number {
  return minBlockWidth(pxPerBar);
}

/** Width of a block of `totalBars` at `pxPerBar` (a skipped block gets the minimum). */
export function blockWidth(totalBars: number, pxPerBar: number): number {
  return Math.floor(Math.max(minBlockWidth(pxPerBar), totalBars * pxPerBar));
}

function widthAt(totals: readonly number[], ppb: number): number {
  let w = 0;
  for (const t of totals) w += blockWidth(t, ppb);
  return w;
}

/**
 * The largest zoom step at which every block and the room after them fit in
 * `room`, or null when none does (`readableOnly`: no overview step).
 */
function fitScale(totals: readonly number[], room: number, readableOnly = false): number | null {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const s = ZOOM_STEPS[i];
    if (readableOnly && s < OVERVIEW_BELOW) break;
    if (widthAt(totals, s) + tailRoom(s) <= room) return s;
  }
  return null;
}

/**
 * A song with at least this many blocks opens at an overview step (compact
 * blocks) when that is the only way to show it whole; a shorter one opens
 * readable and scrolls (Fit song still shows it whole).
 */
export const OVERVIEW_MIN_BLOCKS = 10;

/** The scale the lane opens at (and fits again at on a window resize). */
function openScale(totals: readonly number[], available: number): number {
  const room = Math.max(0, available);
  return fitScale(totals, room, true) ?? (totals.length >= OVERVIEW_MIN_BLOCKS ? fitScale(totals, room) : null) ?? scrollScale(totals);
}

/** Scale of a song that does not fit: about the step where its shortest block is the minimum width (never an overview step). */
function scrollScale(totals: readonly number[]): number {
  const shortest = Math.min(...totals.filter((t) => t > 0));
  const steps = ZOOM_STEPS.filter((s) => s >= OVERVIEW_BELOW);
  if (!Number.isFinite(shortest)) return steps[0];
  const want = Math.min(SCROLL_MAX_PX_PER_BAR, MIN_BLOCK_WIDTH / shortest);
  let step: number = steps[0];
  for (const s of steps) if (s <= want) step = s;
  return step;
}

function totalsOf(inputs: readonly LaneBlockInput[]): number[] {
  return inputs.map((b) => (b.bars > 0 ? b.bars * clampRepeats(b.repeats) : 0));
}

/**
 * What Fit song does in `available` px: the largest step at which the whole
 * song fits (`fits`), else the smallest step, which shows as much of it as
 * the lane can (`fits` false: the rest scrolls). It never picks a scale at
 * which a song that is cut off would grow.
 */
export function fitSong(inputs: readonly LaneBlockInput[], available: number): { pxPerBar: number; fits: boolean } {
  const ppb = fitScale(totalsOf(inputs), Math.max(0, available));
  return ppb === null ? { pxPerBar: MIN_PX_PER_BAR, fits: false } : { pxPerBar: ppb, fits: true };
}

/**
 * Lay the blocks out in `available` pixels (the lane scrolls when they do
 * not fit). `opts.pxPerBar` keeps a given scale (used while a gesture is in
 * progress so nothing rescales under the pointer).
 */
export function layoutSong(inputs: readonly LaneBlockInput[], available: number, opts: { pxPerBar?: number } = {}): SongLayout {
  const totals = totalsOf(inputs);
  const totalBars = totals.reduce((a, b) => a + b, 0);
  const ppb = opts.pxPerBar ?? openScale(totals, available);
  const blocks: LaneBlock[] = [];
  let x = 0;
  let bar = 0;
  inputs.forEach((b, index) => {
    const width = blockWidth(totals[index], ppb);
    blocks.push({ id: b.id, index, x, width, startBar: bar, totalBars: totals[index], passBars: b.bars > 0 ? b.bars : 0, repeats: clampRepeats(b.repeats) });
    x += width;
    bar += totals[index];
  });
  return { blocks, totalBars, pxPerBar: ppb, contentWidth: x, room: tailRoom(ppb) };
}

/** Horizontal position of a bar line (0-based bar, may be fractional) on the lane. */
export function barToX(layout: SongLayout, bar: number): number {
  const blocks = layout.blocks.filter((b) => b.totalBars > 0);
  if (!blocks.length) return 0;
  for (const b of blocks) {
    if (bar < b.startBar + b.totalBars) {
      const f = Math.max(0, bar - b.startBar) / b.totalBars;
      return b.x + f * b.width;
    }
  }
  const last = blocks[blocks.length - 1];
  return last.x + last.width;
}

/**
 * The bar at lane position `x` (0-based, whole bars) and the block it is in;
 * null outside the song or over a skipped block.
 */
export function xToBar(layout: SongLayout, x: number): { bar: number; index: number } | null {
  for (const b of layout.blocks) {
    if (x < b.x || x >= b.x + b.width) continue;
    if (b.totalBars <= 0) return null;
    const k = Math.min(b.totalBars - 1, Math.max(0, Math.floor(((x - b.x) / b.width) * b.totalBars)));
    return { bar: b.startBar + k, index: b.index };
  }
  return null;
}

/** The block that holds song bar `bar` (0-based), or null past the end. */
export function blockAtBar(layout: SongLayout, bar: number): LaneBlock | null {
  return layout.blocks.find((b) => b.totalBars > 0 && bar >= b.startBar && bar < b.startBar + b.totalBars) ?? null;
}

/** Offsets (inside the block) of the lines between its passes. */
export function passDividers(width: number, repeats: number): number[] {
  const r = clampRepeats(repeats);
  const out: number[] = [];
  for (let k = 1; k < r; k++) out.push(Math.round((k * width) / r));
  return out;
}

export interface RulerMark {
  /** 0-based bar index. */
  bar: number;
  x: number;
  /** Show the bar number (1-based) at this mark. */
  label: boolean;
  /** First bar of a block. */
  blockStart: boolean;
}

const LABEL_STEPS = [1, 2, 4, 8, 16, 32, 64, 128];

/**
 * Bar lines for the ruler. Every block start is numbered; bars in between
 * are numbered at a regular step when there is room (at least `minSpacing`
 * pixels from the neighbouring numbers).
 */
export function rulerMarks(layout: SongLayout, minSpacing = 56): RulerMark[] {
  const out: RulerMark[] = [];
  const step = LABEL_STEPS.find((s) => s * layout.pxPerBar >= minSpacing) ?? 128;
  const blocks = layout.blocks.filter((b) => b.totalBars > 0);
  blocks.forEach((b, i) => {
    const barW = b.width / b.totalBars;
    const nextStart = i + 1 < blocks.length ? blocks[i + 1].x : b.x + b.width + minSpacing / 2;
    let lastLabelX = -Infinity;
    for (let k = 0; k < b.totalBars; k++) {
      const bar = b.startBar + k;
      const x = b.x + k * barW;
      const blockStart = k === 0;
      let label = blockStart;
      if (!blockStart && bar % step === 0 && x - lastLabelX >= minSpacing * 0.6 && nextStart - x >= minSpacing * 0.6) label = true;
      if (label) lastLabelX = x;
      // Unnumbered bar lines only where they are far enough apart to read.
      if (label || barW >= 5) out.push({ bar, x, label, blockStart });
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Zoom: the scale stays put while the song is edited                  */
/* ------------------------------------------------------------------ */

/**
 * The next zoom step from `pxPerBar` (dir 1 = zoom in, -1 = zoom out), or
 * null at the end of the ladder.
 */
export function zoomStep(pxPerBar: number, dir: 1 | -1): number | null {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > pxPerBar + 1e-6) ?? null;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < pxPerBar - 1e-6) return ZOOM_STEPS[i];
  return null;
}

/** A place on the lane that a zoom keeps still: a block and how far into it (0..1; past its end beyond 1). */
export interface LaneAnchor {
  id: string;
  f: number;
}

/** The anchor at lane position `x` (null on an empty lane). */
export function anchorAt(layout: SongLayout, x: number): LaneAnchor | null {
  const b = layout.blocks;
  if (!b.length) return null;
  const hit = b.find((lb) => x < lb.x + lb.width) ?? b[b.length - 1];
  return { id: hit.id, f: (x - hit.x) / Math.max(1, hit.width) };
}

/** Where an anchor is on a (re-scaled) layout, or null when its block is gone. */
export function anchorX(layout: SongLayout, a: LaneAnchor): number | null {
  const lb = layout.blocks.find((b) => b.id === a.id);
  return lb ? lb.x + a.f * lb.width : null;
}

/** The scroll position that puts lane position `x` at `screenX` in a viewport of `viewport` px (clamped to the content). */
export function scrollToShow(x: number, screenX: number, viewport: number, contentWidth: number): number {
  return Math.max(0, Math.min(Math.max(0, contentWidth - viewport), x - screenX));
}

/* ------------------------------------------------------------------ */
/* Following the playhead                                              */
/* ------------------------------------------------------------------ */

/** Share of the viewport left of the playhead after the lane turns a page. */
export const FOLLOW_LEAD = 0.2;

/**
 * Where the lane should scroll so the playhead at lane position `x` stays in
 * view, or null when it is comfortably in view already: it turns a page when
 * the playhead nears the right edge (or is left of the view), putting it
 * FOLLOW_LEAD of the way in.
 */
export function followScroll(x: number, scrollLeft: number, viewport: number, contentWidth: number): number | null {
  if (viewport <= 0 || contentWidth <= viewport) return null;
  if (x >= scrollLeft + 4 && x <= scrollLeft + viewport * 0.85) return null;
  const to = scrollToShow(x, viewport * FOLLOW_LEAD, viewport, contentWidth);
  return Math.abs(to - scrollLeft) < 1 ? null : to;
}

/** Lane position of insertion gap `gap` (0 = before the first block, n = after the last). */
export function gapX(layout: SongLayout, gap: number): number {
  const b = layout.blocks;
  if (!b.length || gap <= 0) return 0;
  if (gap >= b.length) return layout.contentWidth;
  return b[gap].x;
}

/* ------------------------------------------------------------------ */
/* Part rows: they grow with the free height                           */
/* ------------------------------------------------------------------ */

/** Part rows never get shorter than this (px)… */
export const ROW_MIN_PX = 18;
/** …nor taller than this. */
export const ROW_MAX_PX = 32;
/** Room the Performances panel keeps below the song when it lists takes (its header and about two takes). */
export const PERF_ROOM_PX = 180;

/** The row height that shares `free` px out among `rows` part rows, within ROW_MIN_PX..ROW_MAX_PX. */
export function fitRowHeight(free: number, rows: number): number {
  if (!(rows > 0) || !Number.isFinite(free)) return ROW_MIN_PX;
  return Math.max(ROW_MIN_PX, Math.min(ROW_MAX_PX, Math.floor(free / rows)));
}

/**
 * How the lane fills `free` px of height: the part rows grow first (up to
 * ROW_MAX_PX); what is left once they are as tall as they get (`extra`) goes
 * to the lane itself, below the blocks, so a tall window has no empty band
 * under the song.
 */
export function fitLaneHeight(free: number, rows: number): { row: number; extra: number } {
  const row = fitRowHeight(free, rows);
  if (!(rows > 0) || !Number.isFinite(free)) return { row, extra: 0 };
  return { row, extra: Math.max(0, Math.floor(free - rows * row)) };
}
