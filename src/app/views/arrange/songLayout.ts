/**
 * Song lane geometry (pure: no DOM, no React).
 *
 * Blocks are laid out left to right with widths proportional to their length
 * in bars (scene bars × repeats). A block never gets narrower than
 * MIN_BLOCK_WIDTH so its controls stay usable; the ruler and the playhead map
 * bars through the same per-block geometry, so bar numbers always line up
 * with block edges even when a short block is widened.
 *
 * A song that fits fills the lane. A song that does not fit scrolls, at the
 * scale where its shortest block is exactly the minimum width (so all blocks
 * keep their true proportions), within SCROLL_MAX_PX_PER_BAR.
 */

export interface LaneBlockInput {
  id: string;
  /** Bars of one pass of the block's scene (0 when the scene is missing: the block is skipped). */
  bars: number;
  /** 1..8 */
  repeats: number;
}

export interface LaneBlock {
  id: string;
  index: number;
  x: number;
  width: number;
  /** First bar of the block on the song timeline (0-based). */
  startBar: number;
  /** Length of the block in bars (bars × repeats; 0 for a skipped block). */
  totalBars: number;
}

export interface SongLayout {
  blocks: LaneBlock[];
  totalBars: number;
  /** Pixels per bar of the proportional (non-widened) blocks. */
  pxPerBar: number;
  /** Right edge of the last block. */
  contentWidth: number;
}

export const BLOCK_GAP = 6;
export const MIN_BLOCK_WIDTH = 140;
export const MAX_PX_PER_BAR = 60;
export const MIN_PX_PER_BAR = 10;
/** Largest scale of a song that scrolls (so one short block cannot make long ones huge). */
export const SCROLL_MAX_PX_PER_BAR = 24;

export function clampRepeats(r: number): number {
  return Number.isFinite(r) ? Math.min(8, Math.max(1, Math.round(r))) : 1;
}

/**
 * The largest scale (≤ MAX_PX_PER_BAR) at which every block, widened to at
 * least MIN_BLOCK_WIDTH, fits in `room`; null when the song only fits below
 * MIN_PX_PER_BAR (it then scrolls).
 */
function fitScale(totals: readonly number[], room: number): number | null {
  // Blocks that would be too narrow get the minimum width; the rest share what is left.
  // Fixing a block only ever lowers the scale, so this settles in at most n rounds.
  const fixed = totals.map((t) => t <= 0);
  for (let iter = 0; iter <= totals.length; iter++) {
    let flexBars = 0;
    let fixedCount = 0;
    let longestFixed = 0;
    totals.forEach((t, i) => {
      if (fixed[i]) {
        fixedCount++;
        longestFixed = Math.max(longestFixed, t);
      } else flexBars += t;
    });
    const flexRoom = room - fixedCount * MIN_BLOCK_WIDTH;
    if (flexRoom < 0) return null;
    // Every block sits at the minimum width: the scale at which the longest of them just fills it.
    const scale = Math.min(MAX_PX_PER_BAR, flexBars > 0 ? flexRoom / flexBars : longestFixed > 0 ? MIN_BLOCK_WIDTH / longestFixed : MAX_PX_PER_BAR);
    if (scale < MIN_PX_PER_BAR) return null;
    let changed = false;
    totals.forEach((t, i) => {
      if (!fixed[i] && t * scale < MIN_BLOCK_WIDTH) {
        fixed[i] = true;
        changed = true;
      }
    });
    if (!changed) return scale;
  }
  return null;
}

/**
 * Scale of a song that does not fit: the shortest block gets exactly the
 * minimum width, so every block stays in true proportion (unless that would
 * pass SCROLL_MAX_PX_PER_BAR, or fall under MIN_PX_PER_BAR).
 */
function scrollScale(totals: readonly number[]): number {
  const shortest = Math.min(...totals.filter((t) => t > 0));
  if (!Number.isFinite(shortest)) return MIN_PX_PER_BAR;
  return Math.min(SCROLL_MAX_PX_PER_BAR, Math.max(MIN_PX_PER_BAR, MIN_BLOCK_WIDTH / shortest));
}

/** Lay the blocks out in `available` pixels (the lane scrolls when they do not fit). */
export function layoutSong(inputs: readonly LaneBlockInput[], available: number): SongLayout {
  const n = inputs.length;
  const totals = inputs.map((b) => (b.bars > 0 ? b.bars * clampRepeats(b.repeats) : 0));
  const totalBars = totals.reduce((a, b) => a + b, 0);
  const room = Math.max(0, available - BLOCK_GAP * Math.max(0, n - 1));
  const ppb = fitScale(totals, room) ?? scrollScale(totals);

  const blocks: LaneBlock[] = [];
  let x = 0;
  let bar = 0;
  inputs.forEach((b, index) => {
    // Floor, so rounding never makes a fitting song overflow the lane.
    const width = Math.floor(Math.max(MIN_BLOCK_WIDTH, totals[index] * ppb));
    blocks.push({ id: b.id, index, x, width, startBar: bar, totalBars: totals[index] });
    x += width + BLOCK_GAP;
    bar += totals[index];
  });
  const last = blocks[blocks.length - 1];
  return { blocks, totalBars, pxPerBar: ppb, contentWidth: last ? last.x + last.width : 0 };
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

/** Insertion gap (0..n) nearest to lane position `x`: the gap before block i, or n for the end. */
export function gapAt(layout: SongLayout, x: number): number {
  for (const b of layout.blocks) if (x < b.x + b.width / 2) return b.index;
  return layout.blocks.length;
}

/** Lane position of an insertion gap (the middle of the space between two blocks). */
export function gapX(layout: SongLayout, gap: number): number {
  const b = layout.blocks;
  if (!b.length) return 0;
  if (gap <= 0) return b[0].x - BLOCK_GAP / 2;
  if (gap >= b.length) return b[b.length - 1].x + b[b.length - 1].width + BLOCK_GAP / 2;
  return (b[gap - 1].x + b[gap - 1].width + b[gap].x) / 2;
}

/** moveBlock destination for dropping block `from` into insertion gap `gap` (null = no change). */
export function moveTarget(from: number, gap: number): number | null {
  const to = gap > from ? gap - 1 : gap;
  return to === from ? null : to;
}
