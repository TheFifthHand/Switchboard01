/**
 * The song lane's pure logic: geometry (edge to edge, proportional, zoom
 * steps), where a dragged group lands (with hysteresis) and where every other
 * block sits meanwhile, edge-drag passes, auto-scroll speed, zoom anchors and
 * the kept scale, following the playhead, drag labels kept readable, the
 * slide easing, the remembered Follow setting, selection, the paste position,
 * the scene-card target (insert vs layer, stable while the slot opens), what
 * each part cell shows and says, and the layer preview in both modes.
 */
import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/project/factory';
import type { Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import {
  AUTOSCROLL_MAX_PX_S,
  EDGE_SCROLL_MIN_PX_S,
  EMPTY_SELECTION,
  GAP_HYSTERESIS_PX,
  MIN_PASS_STEP_PX,
  NO_TARGET,
  actionTargets,
  autoScrollVelocity,
  badgePlacement,
  cardEdge,
  Dwell,
  cardTarget,
  restingCardTarget,
  currentOthersGap,
  edgeDragVelocity,
  edgeStepPx,
  fullGap,
  ghostFlips,
  menuTargets,
  nudgeGap,
  packPositions,
  pasteGap,
  pruneSelection,
  repeatsFromEdge,
  selectAll,
  selectByClick,
  selectByKey,
  slotLefts,
  targetGap,
  type CardBlock,
  type CardTarget,
  type OpenSlot,
} from '../../src/app/views/arrange/songDrag';
import { SLOT_DELAY_MS } from '../../src/app/views/arrange/laneGestures';
import {
  COMPACT_BLOCK_WIDTH,
  FOLLOW_LEAD,
  FULL_HEADER_WIDTH,
  MIN_PX_PER_BAR,
  OVERVIEW_BELOW,
  OVERVIEW_MIN_BLOCKS,
  ROW_MAX_PX,
  ROW_MIN_PX,
  ZOOM_STEPS,
  anchorAt,
  anchorX,
  barToX,
  blockAtBar,
  fitLaneHeight,
  LANE_EXTRA_MAX_PX,
  fitRowHeight,
  fitSong,
  followScroll,
  gapX,
  layoutSong,
  minBlockWidth,
  passDividers,
  rulerMarks,
  scrollToShow,
  tailRoom,
  xToBar,
  zoomStep,
} from '../../src/app/views/arrange/songLayout';
import { cubicBezier, easeSlide, easeSpring } from '../../src/app/views/arrange/laneMotion';
import { LANE_SETTINGS_KEY, readFollow, writeFollow } from '../../src/app/views/arrange/laneSettings';
import { blockLabel, blockView, cellLabel, cellTip, cellToast, cellToggle, laneBlocks, layerPreview, layerText, liveLengthText, partChoices, resizeText, timesText } from '../../src/app/views/arrange/songModel';

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

describe('lane geometry', () => {
  const song = [
    { id: 'a', bars: 4, repeats: 2 },
    { id: 'b', bars: 4, repeats: 4 },
    { id: 'c', bars: 4, repeats: 2 },
  ];

  it('places blocks edge to edge, proportional, at a zoom step that fits (with one block width of room after them)', () => {
    const l = layoutSong(song, 1000);
    expect(ZOOM_STEPS).toContain(l.pxPerBar);
    expect(l.room).toBe(FULL_HEADER_WIDTH);
    expect(l.contentWidth + l.room).toBeLessThanOrEqual(1000);
    // The next step up would not fit.
    const bigger = ZOOM_STEPS.find((s) => s > l.pxPerBar)!;
    expect(32 * bigger + tailRoom(bigger)).toBeGreaterThan(1000);
    expect(l.blocks.map((b) => b.x)).toEqual([0, l.blocks[0].width, l.blocks[0].width + l.blocks[1].width]);
    expect(l.blocks[1].width).toBe(2 * l.blocks[0].width);
    expect(l.blocks.map((b) => b.startBar)).toEqual([0, 8, 24]);
    expect(l.totalBars).toBe(32);
  });

  it('keeps the scale for small edits (zoom steps), and holds a given scale', () => {
    // 30 bars fit at 28 px per bar (840 px and 112 px of room): one more bar still fits at the same step.
    const thirty = [song[0], song[1], { id: 'c', bars: 6, repeats: 1 }];
    const before = layoutSong(thirty, 1000);
    expect(before.pxPerBar).toBe(28);
    const after = layoutSong([song[0], song[1], { id: 'c', bars: 7, repeats: 1 }], 1000);
    expect(after.pxPerBar).toBe(before.pxPerBar);
    expect(after.blocks[1].width).toBe(before.blocks[1].width);
    const held = layoutSong([...song, { id: 'd', bars: 4, repeats: 16 }], 1000, { pxPerBar: before.pxPerBar });
    expect(held.pxPerBar).toBe(before.pxPerBar);
    expect(held.contentWidth).toBeGreaterThan(1000);
  });

  it('only a block under the 44 px floor is widened; the ruler stays on block edges and its numbers on a regular bar step', () => {
    const l = layoutSong([{ id: 'a', bars: 1, repeats: 1 }, ...song], 1000);
    expect(l.pxPerBar).toBeGreaterThanOrEqual(OVERVIEW_BELOW);
    expect(l.blocks[0].width).toBe(Math.max(COMPACT_BLOCK_WIDTH, l.pxPerBar));
    // Every other block is exactly to scale.
    for (const b of l.blocks.slice(1)) expect(b.width).toBe(b.totalBars * l.pxPerBar);
    const starts = rulerMarks(l).filter((m) => m.blockStart);
    expect(starts.map((m) => m.bar)).toEqual([0, 1, 9, 25]);
    expect(starts.map((m) => m.x)).toEqual(l.blocks.map((b) => b.x));
    // Numbers sit at multiples of one step (bar 1, 1 + step, …), not at block starts.
    const labelled = rulerMarks(l).filter((m) => m.label).map((m) => m.bar);
    const step = labelled[1] - labelled[0];
    expect(labelled[0]).toBe(0);
    expect(labelled.every((b) => b % step === 0)).toBe(true);
  });

  it('is linear at 11 px per bar and up: widths proportional to bars, ruler numbers evenly spaced', () => {
    const house = [8, 16, 16, 8, 16, 8, 4, 4, 4, 4].map((bars, i) => ({ id: String(i), bars: 4, repeats: bars / 4 }));
    for (const s of ZOOM_STEPS.filter((z) => z >= OVERVIEW_BELOW)) {
      const l = layoutSong(house, 1000, { pxPerBar: s });
      for (const b of l.blocks) expect(Math.abs(b.width - b.totalBars * s)).toBeLessThanOrEqual(1);
      const xs = rulerMarks(l).filter((m) => m.label).map((m) => m.x);
      const gaps = xs.slice(1).map((x, i) => x - xs[i]);
      for (const g of gaps) expect(Math.abs(g - gaps[0])).toBeLessThanOrEqual(1);
      // The playhead's px per bar is the same in an 8-bar and a 4-bar block.
      expect(barToX(l, 1) - barToX(l, 0)).toBeCloseTo(barToX(l, 81) - barToX(l, 80), 6);
    }
    expect(OVERVIEW_BELOW).toBe(11);
  });

  it('a long song fits whole at an overview step: compact blocks (never narrower than COMPACT_BLOCK_WIDTH)', () => {
    // 14 blocks, 140 bars: no readable step fits 1200 px; an overview step does.
    const bars = [16, 16, 12, 8, 16, 8, 8, 8, 8, 8, 8, 8, 8, 8];
    const l = layoutSong(bars.map((b, i) => ({ id: String(i), bars: b, repeats: 1 })), 1200);
    expect(l.pxPerBar).toBeLessThan(OVERVIEW_BELOW);
    expect(l.contentWidth + l.room).toBeLessThanOrEqual(1200);
    expect(l.room).toBe(COMPACT_BLOCK_WIDTH);
    for (const b of l.blocks) expect(b.width).toBe(Math.max(COMPACT_BLOCK_WIDTH, Math.floor(b.totalBars * l.pxPerBar)));
    // The floor is the same at every scale; only the room after the song is smaller at an overview step.
    expect(minBlockWidth(OVERVIEW_BELOW)).toBe(COMPACT_BLOCK_WIDTH);
    expect(minBlockWidth(OVERVIEW_BELOW - 1)).toBe(COMPACT_BLOCK_WIDTH);
    expect(tailRoom(OVERVIEW_BELOW)).toBe(FULL_HEADER_WIDTH);
    expect(tailRoom(OVERVIEW_BELOW - 1)).toBe(COMPACT_BLOCK_WIDTH);
  });

  it('a song too long to fit at any step opens scrolling at a readable step (its shortest block about a full header wide)', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: String(i), bars: 8, repeats: 1 }));
    const l = layoutSong(many, 1200);
    expect(l.contentWidth).toBeGreaterThan(1200);
    expect(ZOOM_STEPS).toContain(l.pxPerBar);
    expect(l.pxPerBar).toBeGreaterThanOrEqual(OVERVIEW_BELOW);
    expect(8 * l.pxPerBar).toBeLessThanOrEqual(FULL_HEADER_WIDTH);
    for (const b of l.blocks) expect(b.width).toBe(Math.max(COMPACT_BLOCK_WIDTH, Math.floor(b.totalBars * l.pxPerBar)));
  });

  it('Fit song never makes a song that is cut off bigger: 24 blocks fit at 1366 px; one that cannot fit goes to the smallest step and says it does not fit', () => {
    // The starter's six blocks four times (24 blocks, 288 bars) in a 1366 px window's lane (about 1218 px).
    const house = [8, 16, 16, 8, 16, 8];
    const long = Array.from({ length: 24 }, (_, i) => ({ id: String(i), bars: 4, repeats: house[i % 6] / 4 }));
    const fit = fitSong(long, 1218);
    expect(fit.fits).toBe(true);
    const l = layoutSong(long, 1218, { pxPerBar: fit.pxPerBar });
    expect(l.contentWidth + l.room).toBeLessThanOrEqual(1218);
    // Opening the lane picks the same scale; a scrolling scale it zoomed in to before is not what Fit does.
    expect(layoutSong(long, 1218).pxPerBar).toBe(fit.pxPerBar);
    // Whatever scale the lane is at, Fit is never larger than a scale at which the song is cut off.
    for (const s of ZOOM_STEPS) {
      const at = layoutSong(long, 1218, { pxPerBar: s });
      if (at.contentWidth + at.room > 1218) expect(fit.pxPerBar).toBeLessThan(s);
    }
    // 100 blocks cannot fit: the smallest step, and it says so.
    const huge = Array.from({ length: 100 }, (_, i) => ({ id: String(i), bars: 4, repeats: 2 }));
    expect(fitSong(huge, 1218)).toEqual({ pxPerBar: MIN_PX_PER_BAR, fits: false });
    expect(layoutSong(huge, 1218).pxPerBar).toBeGreaterThanOrEqual(OVERVIEW_BELOW);
  });

  it('a long song of few blocks opens readable (it scrolls); Fit song still shows it whole, compact', () => {
    // The starter's six blocks (72 bars) in a 200 % zoomed lane (about 800 px): no readable step fits.
    const house = [8, 16, 16, 8, 16, 8].map((bars, i) => ({ id: String(i), bars: 4, repeats: bars / 4 }));
    expect(house.length).toBeLessThan(OVERVIEW_MIN_BLOCKS);
    const open = layoutSong(house, 800);
    expect(open.pxPerBar).toBeGreaterThanOrEqual(OVERVIEW_BELOW);
    expect(open.contentWidth + open.room).toBeGreaterThan(800);
    const fit = fitSong(house, 800);
    expect(fit.fits).toBe(true);
    expect(fit.pxPerBar).toBeLessThan(OVERVIEW_BELOW);
    // Ten blocks or more: the lane opens whole, at that overview step.
    const ten = Array.from({ length: 12 }, (_, i) => house[i % 6]).map((b, i) => ({ ...b, id: String(i) }));
    const tenFit = fitSong(ten, 1218);
    expect(tenFit.fits).toBe(true);
    expect(layoutSong(ten, 1218).pxPerBar).toBe(tenFit.pxPerBar);
  });

  it('part rows share the free height out, 18 to 48 px', () => {
    expect(ROW_MIN_PX).toBe(18);
    expect(ROW_MAX_PX).toBe(48);
    expect(fitRowHeight(8 * 27 + 5, 8)).toBe(27);
    expect(fitRowHeight(1000, 8)).toBe(48);
    expect(fitRowHeight(40, 8)).toBe(18);
    expect(fitRowHeight(-50, 8)).toBe(18);
    expect(fitRowHeight(200, 0)).toBe(18);
  });

  it('what the rows cannot use (they stop at 48 px) goes to the lane below the blocks, up to a limit', () => {
    // A tall window: 8 rows at 48 px, and some of the rest for the lane (never an empty band in it).
    expect(fitLaneHeight(8 * 48 + 60, 8)).toEqual({ row: 48, extra: 60 });
    expect(fitLaneHeight(8 * 48 + 300, 8)).toEqual({ row: 48, extra: LANE_EXTRA_MAX_PX });
    expect(LANE_EXTRA_MAX_PX).toBeLessThanOrEqual(100);
    // Rows still growing: only the rounding is left over.
    expect(fitLaneHeight(8 * 27 + 5, 8)).toEqual({ row: 27, extra: 5 });
    // Too little room: the rows keep their minimum, nothing extra.
    expect(fitLaneHeight(40, 8)).toEqual({ row: 18, extra: 0 });
    expect(fitLaneHeight(Number.NaN, 8)).toEqual({ row: 18, extra: 0 });
  });

  it('maps bars to x and back through the same geometry', () => {
    const l = layoutSong(song, 1000);
    expect(barToX(l, 0)).toBe(0);
    expect(barToX(l, 8)).toBe(l.blocks[1].x);
    expect(barToX(l, 999)).toBe(l.contentWidth);
    expect(xToBar(l, l.blocks[1].x + 1)).toEqual({ bar: 8, index: 1 });
    expect(xToBar(l, l.blocks[1].x + l.blocks[1].width - 1)).toEqual({ bar: 23, index: 1 });
    expect(xToBar(l, l.contentWidth + 5)).toBeNull();
    expect(blockAtBar(l, 24)?.id).toBe('c');
    expect(gapX(l, 0)).toBe(0);
    expect(gapX(l, 2)).toBe(l.blocks[2].x);
    expect(gapX(l, 3)).toBe(l.contentWidth);
    expect(passDividers(120, 4)).toEqual([30, 60, 90]);
    expect(passDividers(120, 1)).toEqual([]);
  });

  it('skips a block whose scene is missing on the ruler but keeps it on the lane', () => {
    const l = layoutSong([song[0], { id: 'gone', bars: 0, repeats: 2 }, song[2]], 1000);
    expect(l.blocks[1].width).toBe(COMPACT_BLOCK_WIDTH);
    expect(l.blocks[1].totalBars).toBe(0);
    expect(l.totalBars).toBe(16);
    expect(xToBar(l, l.blocks[1].x + 4)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Moving                                                              */
/* ------------------------------------------------------------------ */

describe('drag target', () => {
  // Others: 100, 200, 100 px; a 100 px block is dragged.
  const others = [100, 200, 100];
  const W = 100;

  it('goes to the nearest slot by the dragged centre', () => {
    expect(slotLefts(others)).toEqual([0, 100, 300, 400]);
    expect(targetGap(others, W, 10, null)).toBe(0);
    // Slot centres: 50, 150, 350, 450. Halfway 0|1 = 100.
    expect(targetGap(others, W, 99, null)).toBe(0);
    expect(targetGap(others, W, 101, null)).toBe(1);
    expect(targetGap(others, W, 260, null)).toBe(2);
    expect(targetGap(others, W, 2000, null)).toBe(3);
    expect(targetGap(others, W, -500, null)).toBe(0);
  });

  it('needs the halfway point passed by the hysteresis before it changes (no flicker)', () => {
    const h = GAP_HYSTERESIS_PX;
    expect(targetGap(others, W, 100 + h - 1, 0)).toBe(0);
    expect(targetGap(others, W, 100 + h + 1, 0)).toBe(1);
    expect(targetGap(others, W, 100 - h + 1, 1)).toBe(1);
    expect(targetGap(others, W, 100 - h - 1, 1)).toBe(0);
    // Wobbling around the boundary from either side keeps the current target.
    for (const c of [97, 103, 99, 101, 100]) {
      expect(targetGap(others, W, c, 0)).toBe(0);
      expect(targetGap(others, W, c, 1)).toBe(1);
    }
    // A fast move skipping slots is followed at once.
    expect(targetGap(others, W, 455, 0)).toBe(3);
  });

  it('maps a gap among the others to the insertion point of the full list', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    const moving = new Set(['b', 'd']);
    expect(currentOthersGap(list, moving)).toBe(1);
    expect(fullGap(list, moving, 0)).toBe(0);
    expect(fullGap(list, moving, 1)).toBe(2);
    expect(fullGap(list, moving, 2)).toBe(4);
    expect(fullGap(list, moving, 3)).toBe(5);
  });

  it('the preview order is exactly what moveBlocks commits (multi-select keeps its order)', () => {
    const p = createProject({ now: 0 });
    p.arrangement = { tailSeconds: 2, blocks: [] };
    const store = new ProjectStore(p);
    for (let i = 0; i < 6; i++) cmd.addBlock(store, p.scenes[i % p.scenes.length].id, undefined, 1 + (i % 3));
    const list = store.getState().arrangement.blocks.map((b) => ({ id: b.id }));
    const ids = [list[4].id, list[1].id];
    const moving = new Set(ids);
    for (let g = 0; g <= list.length - ids.length; g++) {
      const gap = fullGap(list, moving, g);
      const preview = cmd.orderAfterMove(list, ids, gap).map((b) => b.id);
      const s = new ProjectStore(store.getState());
      cmd.moveBlocks(s, ids, gap);
      expect(s.getState().arrangement.blocks.map((b) => b.id)).toEqual(preview);
      // Selected blocks keep their song order, side by side.
      const at = preview.indexOf(list[1].id);
      expect(preview[at + 1]).toBe(list[4].id);
    }
  });

  it('packs positions edge to edge, with an optional open slot', () => {
    const w: Record<string, number> = { a: 100, b: 50, c: 80 };
    expect([...packPositions(['a', 'b', 'c'], (id) => w[id]).values()]).toEqual([0, 100, 150]);
    expect([...packPositions(['a', 'b', 'c'], (id) => w[id], { at: 1, width: 70 }).values()]).toEqual([0, 170, 220]);
    expect([...packPositions(['a', 'b', 'c'], (id) => w[id], { at: 3, width: 70 }).values()]).toEqual([0, 100, 150]);
  });
});

describe('edge drag and auto-scroll', () => {
  it('changes passes in whole steps, 1 to 16', () => {
    expect(edgeStepPx(4, 16)).toBe(64);
    expect(edgeStepPx(1, 10)).toBe(MIN_PASS_STEP_PX);
    expect(repeatsFromEdge(2, 0, 64)).toBe(2);
    expect(repeatsFromEdge(2, 31, 64)).toBe(2);
    expect(repeatsFromEdge(2, 33, 64)).toBe(3);
    expect(repeatsFromEdge(2, 3 * 64, 64)).toBe(5);
    expect(repeatsFromEdge(2, -500, 64)).toBe(1);
    expect(repeatsFromEdge(2, 5000, 64)).toBe(16);
  });

  it("an edge drag scrolls the lane only once the pointer reaches the lane's visible edge, faster past it", () => {
    // Anywhere inside the lane, also near its edges: no scrolling (the last block's edge cannot run away).
    for (const x of [500, 940, 990, 998, 10, 3]) expect(edgeDragVelocity(x, 0, 1000)).toBe(0);
    expect(edgeDragVelocity(999, 0, 1000)).toBe(EDGE_SCROLL_MIN_PX_S);
    expect(edgeDragVelocity(1020, 0, 1000)).toBeGreaterThan(EDGE_SCROLL_MIN_PX_S);
    expect(edgeDragVelocity(1200, 0, 1000)).toBe(AUTOSCROLL_MAX_PX_S);
    expect(edgeDragVelocity(-100, 0, 1000)).toBe(-AUTOSCROLL_MAX_PX_S);
  });

  it('scrolls only near the lane edges, faster closer to them', () => {
    expect(autoScrollVelocity(500, 0, 1000)).toBe(0);
    const near = autoScrollVelocity(990, 0, 1000);
    const nearer = autoScrollVelocity(999, 0, 1000);
    expect(near).toBeGreaterThan(0);
    expect(nearer).toBeGreaterThan(near);
    expect(autoScrollVelocity(1100, 0, 1000)).toBe(AUTOSCROLL_MAX_PX_S);
    expect(autoScrollVelocity(5, 0, 1000)).toBeLessThan(0);
    expect(autoScrollVelocity(-50, 0, 1000)).toBe(-AUTOSCROLL_MAX_PX_S);
  });
});

describe('zoom, follow and labels that stay readable', () => {
  const song = [
    { id: 'a', bars: 4, repeats: 2 },
    { id: 'b', bars: 4, repeats: 4 },
    { id: 'c', bars: 4, repeats: 2 },
  ];

  it('zoom steps walk the ladder and stop at its ends', () => {
    expect(zoomStep(16, 1)).toBe(18);
    expect(zoomStep(16, -1)).toBe(14);
    expect(zoomStep(ZOOM_STEPS[0], -1)).toBeNull();
    expect(zoomStep(ZOOM_STEPS[ZOOM_STEPS.length - 1], 1)).toBeNull();
  });

  it('an edit keeps the scale it was given: a longer song scrolls instead of shrinking', () => {
    const fit = layoutSong(song, 700);
    const longer = [...song, { id: 'd', bars: 4, repeats: 2 }];
    // Fitting again would shrink every block; holding the scale keeps each block's width and place.
    expect(layoutSong(longer, 700).pxPerBar).toBeLessThan(fit.pxPerBar);
    const held = layoutSong(longer, 700, { pxPerBar: fit.pxPerBar });
    for (const b of fit.blocks) expect(held.blocks.find((x) => x.id === b.id)).toMatchObject({ x: b.x, width: b.width });
    expect(held.contentWidth).toBeGreaterThan(700);
  });

  it('a zoom keeps its anchor (a block and how far into it) at the same place on screen', () => {
    const before = layoutSong(song, 2000, { pxPerBar: 20 });
    const after = layoutSong(song, 2000, { pxPerBar: 40 });
    // The middle of block b, 300 px into a view scrolled by 100.
    const x = before.blocks[1].x + before.blocks[1].width / 2;
    const a = anchorAt(before, x)!;
    expect(a).toEqual({ id: 'b', f: 0.5 });
    const nx = anchorX(after, a)!;
    expect(nx).toBe(after.blocks[1].x + after.blocks[1].width / 2);
    const left = scrollToShow(nx, x - 100, 700, after.contentWidth + 48);
    expect(nx - left).toBe(x - 100);
    // Clamped to the content.
    expect(scrollToShow(10, 300, 700, 2000)).toBe(0);
    expect(scrollToShow(1990, 0, 700, 2000)).toBe(1300);
    // Past the end anchors to the last block; a gone block has no place.
    expect(anchorAt(before, 5000)!.id).toBe('c');
    expect(anchorX(after, { id: 'gone', f: 0 })).toBeNull();
  });

  it('the playhead turns a page only when it nears the edge of the view', () => {
    // In view: nothing to do.
    expect(followScroll(300, 0, 800, 3000)).toBeNull();
    // Near the right edge: the view moves so the playhead is a fifth of the way in.
    expect(followScroll(700, 0, 800, 3000)).toBe(700 - 800 * FOLLOW_LEAD);
    // Left of the view (a jump back): back into view.
    expect(followScroll(100, 900, 800, 3000)).toBe(0);
    // A song that fits never scrolls.
    expect(followScroll(700, 0, 800, 800)).toBeNull();
    // Never past the end.
    expect(followScroll(2950, 1000, 800, 3000)).toBe(2200);
  });

  it('the label under a dragged block stays inside the visible lane', () => {
    // Left half: starts at the block, pushed right if the block starts left of the view.
    expect(badgePlacement(300, 120, 0, 1000)).toEqual({ side: 'left', shift: 0 });
    expect(badgePlacement(-60, 120, 0, 1000)).toEqual({ side: 'left', shift: 64 });
    // Right half: ends at the block's right edge, pulled back if the block runs past the view.
    expect(badgePlacement(700, 120, 0, 1000)).toEqual({ side: 'right', shift: 0 });
    expect(badgePlacement(940, 120, 0, 1000)).toEqual({ side: 'right', shift: -64 });
    // Scrolled: the same in content coordinates.
    expect(badgePlacement(1940, 120, 1000, 1000)).toEqual({ side: 'right', shift: -64 });
    // A scene card's label flips to the pointer's left near the window's right edge.
    expect(ghostFlips(1200, 1366)).toBe(true);
    expect(ghostFlips(600, 1366)).toBe(false);
  });

  it('slides retarget from where the block is: the easing matches the CSS curve', () => {
    expect(easeSlide(0)).toBe(0);
    expect(easeSlide(1)).toBe(1);
    // cubic-bezier(0.2, 0.8, 0.25, 1) is well past half way at half the time.
    expect(easeSlide(0.5)).toBeGreaterThan(0.85);
    expect(easeSlide(0.5)).toBeLessThan(0.97);
    // A linear curve is the identity; the spring overshoots before it lands.
    const linear = cubicBezier(0.25, 0.25, 0.75, 0.75);
    for (const t of [0.1, 0.3, 0.7]) expect(linear(t)).toBeCloseTo(t, 3);
    expect(Math.max(...[0.4, 0.5, 0.6, 0.7].map(easeSpring))).toBeGreaterThan(1);
    for (let t = 0; t <= 1.0001; t += 0.05) expect(easeSlide(t)).toBeGreaterThanOrEqual(easeSlide(Math.max(0, t - 0.05)) - 1e-9);
  });

  it('remembers Follow playhead (on unless turned off), surviving broken storage', () => {
    const mem = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const saved = g.localStorage;
    g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    try {
      expect(readFollow()).toBe(true);
      writeFollow(false);
      expect(JSON.parse(mem.get(LANE_SETTINGS_KEY)!)).toEqual({ follow: false });
      expect(readFollow()).toBe(false);
      writeFollow(true);
      expect(readFollow()).toBe(true);
      mem.set(LANE_SETTINGS_KEY, '{not json');
      expect(readFollow()).toBe(true);
      g.localStorage = {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      };
      expect(readFollow()).toBe(true);
      expect(() => writeFollow(false)).not.toThrow();
    } finally {
      g.localStorage = saved;
    }
  });
});

/* ------------------------------------------------------------------ */
/* Selection, paste, nudge                                             */
/* ------------------------------------------------------------------ */

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('click, Ctrl/Cmd+click and Shift+click', () => {
    let s = selectByClick(EMPTY_SELECTION, order, 'b');
    expect(s).toEqual({ ids: ['b'], anchor: 'b' });
    s = selectByClick(s, order, 'd', { shift: true });
    expect(s.ids).toEqual(['b', 'c', 'd']);
    s = selectByClick(s, order, 'a', { toggle: true });
    expect(s.ids).toEqual(['a', 'b', 'c', 'd']);
    s = selectByClick(s, order, 'c', { toggle: true });
    expect(s.ids).toEqual(['a', 'b', 'd']);
    // Shift from the new anchor (c), replacing the rest; Ctrl+Shift adds the range.
    expect(selectByClick(s, order, 'e', { shift: true }).ids).toEqual(['c', 'd', 'e']);
    expect(selectByClick(s, order, 'e', { shift: true, toggle: true }).ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(selectByClick(s, order, 'zz')).toBe(s);
  });

  it('arrow keys move focus and selection; Shift extends; Home/End', () => {
    let r = selectByKey(EMPTY_SELECTION, order, 'b', 'next', false);
    expect(r).toEqual({ selection: { ids: ['c'], anchor: 'c' }, focus: 'c' });
    r = selectByKey(r.selection, order, r.focus, 'next', true);
    r = selectByKey(r.selection, order, r.focus, 'next', true);
    expect(r.selection.ids).toEqual(['c', 'd', 'e']);
    expect(r.focus).toBe('e');
    r = selectByKey(r.selection, order, r.focus, 'first', true);
    expect(r.selection.ids).toEqual(['a', 'b', 'c']);
    expect(selectByKey(r.selection, order, 'e', 'next', false).focus).toBe('e');
    expect(selectByKey(EMPTY_SELECTION, order, null, 'last', false).focus).toBe('e');
    expect(selectAll(order).ids).toEqual(order);
  });

  it('drops ids that left the song and keeps the same object when nothing changed', () => {
    const s = { ids: ['b', 'x', 'd'], anchor: 'x' };
    expect(pruneSelection(s, order)).toEqual({ ids: ['b', 'd'], anchor: 'b' });
    const ok = { ids: ['b'], anchor: 'b' };
    expect(pruneSelection(ok, order)).toBe(ok);
  });

  it('actions apply to the selection, else the focused block; a menu to its block or the selection it is in', () => {
    const s = { ids: ['d', 'b'], anchor: 'b' };
    expect(actionTargets(s, order, 'a')).toEqual(['b', 'd']);
    expect(actionTargets(EMPTY_SELECTION, order, 'a')).toEqual(['a']);
    expect(actionTargets(EMPTY_SELECTION, order, null)).toEqual([]);
    expect(menuTargets(s, order, 'd')).toEqual(['b', 'd']);
    expect(menuTargets(s, order, 'e')).toEqual(['e']);
  });

  it('pastes after the block it is pasted from (after the selection when that block is in it), else after the selection, else at the end', () => {
    // From a selected block: after the selection.
    expect(pasteGap(order, { ids: ['b', 'c'], anchor: 'b' }, 'b')).toBe(3);
    // From a block outside the selection (as Ctrl+C and its menu act on it alone): after that block.
    expect(pasteGap(order, { ids: ['b', 'c'], anchor: 'b' }, 'a')).toBe(1);
    expect(pasteGap(order, EMPTY_SELECTION, 'a')).toBe(1);
    // From no block: after the selection, else at the end.
    expect(pasteGap(order, { ids: ['b', 'c'], anchor: 'b' }, null)).toBe(3);
    expect(pasteGap(order, EMPTY_SELECTION, null)).toBe(5);
  });

  it('Alt+arrows move the selection by one block (null at the edge)', () => {
    expect(nudgeGap(order, ['b'], 1)).toBe(3);
    expect(cmd.orderAfterMove(order.map((id) => ({ id })), ['b'], 3).map((x) => x.id)).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(nudgeGap(order, ['b'], -1)).toBe(0);
    expect(nudgeGap(order, ['a'], -1)).toBeNull();
    expect(nudgeGap(order, ['e'], 1)).toBeNull();
    expect(nudgeGap(order, ['b', 'c'], 1)).toBe(4);
    expect(cmd.orderAfterMove(order.map((id) => ({ id })), ['b', 'c'], 4).map((x) => x.id)).toEqual(['a', 'd', 'b', 'c', 'e']);
  });
});

/* ------------------------------------------------------------------ */
/* Scene card: insert or layer                                         */
/* ------------------------------------------------------------------ */

describe('scene card target', () => {
  // Three 200 px blocks; a new block would be 120 px.
  const blocks: CardBlock[] = [0, 200, 400].map((x) => ({ x, width: 200, layerable: true }));
  const S = 120;
  const e = cardEdge(200);
  const open = (dir: -1 | 0 | 1): OpenSlot => ({ width: S, dir });

  it('the middle of a block layers into it; its ends insert next to it', () => {
    expect(cardTarget(blocks, 100, NO_TARGET)).toEqual({ kind: 'layer', index: 0 });
    expect(cardTarget(blocks, 5, NO_TARGET)).toEqual({ kind: 'insert', gap: 0 });
    expect(cardTarget(blocks, 200 - 5, NO_TARGET)).toEqual({ kind: 'insert', gap: 1 });
    expect(cardTarget(blocks, 200 + 5, NO_TARGET)).toEqual({ kind: 'insert', gap: 1 });
    expect(cardTarget(blocks, 650, NO_TARGET)).toEqual({ kind: 'insert', gap: 3 });
    expect(cardTarget([], 10, NO_TARGET)).toEqual({ kind: 'insert', gap: 0 });
    expect(restingCardTarget(blocks, 300)).toEqual({ kind: 'layer', index: 1 });
  });

  it('an open slot is sticky over the edge zones and the slot itself, so opening it never flips the target', () => {
    let t: CardTarget = { kind: 'insert', gap: 1 };
    // Resting on the boundary opened the slot; the pointer drifts about inside it (either way): still the slot.
    for (const [x, moving] of [[200 - e + 1, -1], [205, 1], [200 + S - 1, -1], [260, -1], [200 + e, 1]] as const) {
      t = cardTarget(blocks, x, t, open(1), moving);
      expect(t).toEqual({ kind: 'insert', gap: 1 });
    }
    // With no known direction the slot holds across its whole width.
    expect(cardTarget(blocks, 200 + S, { kind: 'insert', gap: 1 }, open(0), 1)).toEqual({ kind: 'insert', gap: 1 });
    // Past the slot (and the edge zones): the resting layout decides again.
    expect(cardTarget(blocks, 200 + S + 2, { kind: 'insert', gap: 1 }, open(0), 0)).toEqual({ kind: 'layer', index: 1 });
  });

  it('going on the way it came past the next block’s resting edge zone closes the slot: the middle of that block layers', () => {
    // Came from the left, rested on the boundary of block 1 (the slot opened), then kept going right.
    expect(cardTarget(blocks, 200 + e + 1, { kind: 'insert', gap: 1 }, open(1), 1)).toEqual({ kind: 'layer', index: 1 });
    // Going back towards the boundary instead keeps the slot.
    expect(cardTarget(blocks, 200 + e + 1, { kind: 'insert', gap: 1 }, open(1), -1)).toEqual({ kind: 'insert', gap: 1 });
    // From the right, the same to the left: past block 0's resting edge zone it layers into block 0.
    expect(cardTarget(blocks, 200 - e - 1, { kind: 'insert', gap: 1 }, open(-1), -1)).toEqual({ kind: 'layer', index: 0 });
    expect(cardTarget(blocks, 200 - e + 1, { kind: 'insert', gap: 1 }, open(-1), -1)).toEqual({ kind: 'insert', gap: 1 });
  });

  it('keeps layering while the pointer stays in the middle of the target', () => {
    let t: CardTarget = { kind: 'layer', index: 1 };
    for (const x of [200 + e + 1, 300, 400 - e - 1]) {
      t = cardTarget(blocks, x, t);
      expect(t).toEqual({ kind: 'layer', index: 1 });
    }
  });

  it('a block whose scene is missing cannot be layered into', () => {
    const b = blocks.map((x, i) => ({ ...x, layerable: i !== 1 }));
    expect(cardTarget(b, 290, NO_TARGET)).toEqual({ kind: 'insert', gap: 1 });
    expect(cardTarget(b, 310, NO_TARGET)).toEqual({ kind: 'insert', gap: 2 });
  });
});

describe('resting on a boundary (Dwell)', () => {
  it('a smooth pass never counts as a rest, however slow; a still pointer does', () => {
    // 60 Hz samples of a 1.4 s, 450 px drag with an ease-in-out speed profile.
    const d = new Dwell();
    let longest = 0;
    let since = 0;
    for (let i = 0; i <= 84; i++) {
      const t = i * (1000 / 60);
      const k = i / 84;
      const x = 450 * (k * k * (3 - 2 * k));
      if (d.sample(x, 0, t)) since = t;
      longest = Math.max(longest, t - since);
    }
    // Only the very start and end of the ease are slow enough to rest, never for the slot's delay in the middle.
    const mid = new Dwell();
    let restMid = 0;
    let start = 0;
    for (let i = 10; i <= 74; i++) {
      const t = i * (1000 / 60);
      const k = i / 84;
      if (mid.sample(450 * (k * k * (3 - 2 * k)), 0, t)) start = t;
      restMid = Math.max(restMid, t - start);
    }
    expect(restMid).toBeLessThan(SLOT_DELAY_MS);
    expect(longest).toBeLessThan(400);
    // Still (or jittering under 3 px) the rest goes on.
    const still = new Dwell();
    still.sample(100, 50, 0);
    expect(still.sample(101, 51, 100)).toBe(false);
    expect(still.sample(102, 49, 260)).toBe(false);
    expect(still.since).toBe(0);
    // A move of more than 3 px, or a quick small step, starts it again.
    expect(still.sample(106, 50, 300)).toBe(true);
    expect(still.sample(107, 50, 302)).toBe(true);
    expect(still.since).toBe(302);
  });

  it('knows which way the pointer goes', () => {
    const d = new Dwell();
    d.sample(0, 0, 0);
    d.sample(10, 0, 10);
    expect(d.dir).toBe(1);
    d.sample(9, 0, 20);
    expect(d.dir).toBe(1);
    d.sample(4, 0, 40);
    expect(d.dir).toBe(-1);
  });
});

/* ------------------------------------------------------------------ */
/* What the cells show                                                 */
/* ------------------------------------------------------------------ */

/** Rows: 0 Intro (drums), 1 Groove (drums, bass), 2 Lift (drums 2 bars, lead 4 bars), 3 empty. */
function project(): Project {
  const p = createProject({ now: 0 });
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  const [drums, , bass, , lead] = p.tracks;
  drums.clips[0] = createClip('Intro kick', 1);
  drums.clips[1] = createClip('Four on the floor', 1);
  bass.clips[1] = createClip('Rolling', 2);
  drums.clips[2] = createClip('Lift kick', 2);
  lead.clips[2] = createClip('Hook', 4);
  p.scenes[0].name = 'Intro';
  p.scenes[1].name = 'Groove';
  p.scenes[2].name = 'Lift';
  p.arrangement = { tailSeconds: 2, blocks: [{ id: 'b1', sceneId: p.scenes[1].id, repeats: 4 }] };
  return p;
}

describe('part cells', () => {
  it('say what each part plays: the scene clip, a layer, off, or silent', () => {
    const p = project();
    const [drums, perc, bass, , lead] = p.tracks;
    p.arrangement.blocks[0].parts = { [lead.id]: p.scenes[2].id, [bass.id]: null };
    const v = blockView(p, p.arrangement.blocks[0], 0);
    const cell = (id: Id) => v.cells.find((c) => c.trackId === id)!;
    expect(cell(drums.id)).toMatchObject({ kind: 'scene', clipName: 'Four on the floor', sceneHasClip: true });
    expect(cell(bass.id)).toMatchObject({ kind: 'off', clipName: null, sceneHasClip: true });
    expect(cell(lead.id)).toMatchObject({ kind: 'layer', clipName: 'Hook', fromScene: 'Lift', sceneHasClip: false });
    expect(cell(perc.id)).toMatchObject({ kind: 'empty', sceneHasClip: false });
    // One pass is the longest clip it plays: the 4-bar layered lead.
    expect(v.passBars).toBe(4);
    expect(v.totalBars).toBe(16);
    expect(v.changes).toBe(2);
    expect(cellLabel(v, cell(drums.id))).toBe(`${drums.name} in Groove (block 1): plays “Four on the floor”`);
    expect(cellLabel(v, cell(bass.id))).toBe(`${bass.name} in Groove (block 1): off`);
    expect(cellLabel(v, cell(lead.id))).toBe(`${lead.name} in Groove (block 1): plays “Hook” from Lift`);
    expect(blockLabel(v, 3, { current: true })).toBe('Block 1 of 3: Groove, 4 bars × 4 = 16 bars, 2 parts changed, playing now');
  });

  it('a click switches a playing part off, an off part back on, and opens the picker when there is nothing to switch', () => {
    const p = project();
    const [drums, perc, bass] = p.tracks;
    p.arrangement.blocks[0].parts = { [bass.id]: null };
    const v = blockView(p, p.arrangement.blocks[0], 0);
    expect(cellToggle(v.cells.find((c) => c.trackId === drums.id)!)).toEqual({ choice: null });
    expect(cellToggle(v.cells.find((c) => c.trackId === bass.id)!)).toEqual({ choice: undefined });
    expect(cellToggle(v.cells.find((c) => c.trackId === perc.id)!)).toBe('picker');
  });

  it('the picker offers the scene clip (default), every other scene with a clip for the part, and Off', () => {
    const p = project();
    const drums = p.tracks[0];
    const b = p.arrangement.blocks[0];
    let c = partChoices(p, b, drums.id);
    expect(c.map((x) => x.label)).toEqual(['Groove: Four on the floor', 'Intro: Intro kick', 'Lift: Lift kick', 'Off in this block']);
    expect(c.filter((x) => x.checked).map((x) => x.key)).toEqual(['scene']);
    b.parts = { [drums.id]: p.scenes[2].id };
    c = partChoices(p, b, drums.id);
    expect(c.filter((x) => x.checked).map((x) => x.label)).toEqual(['Lift: Lift kick']);
    b.parts = { [drums.id]: null };
    expect(partChoices(p, b, drums.id).filter((x) => x.checked).map((x) => x.key)).toEqual(['off']);
  });

  it('a layer preview lists exactly the parts layerScene changes, in either mode, and says so', () => {
    for (const mode of ['fill', 'replace'] as const) {
      const p = project();
      const store = new ProjectStore(p);
      const b = p.arrangement.blocks[0];
      const preview = layerPreview(p, b, p.scenes[2].id, mode);
      // Fill: only the lead is silent in Groove. Replace: the drums too.
      expect([...preview.changes.keys()].sort()).toEqual(mode === 'fill' ? [p.tracks[4].id] : [p.tracks[0].id, p.tracks[4].id].sort());
      expect(preview.changes.get(p.tracks[4].id)).toBe('Hook');
      expect(preview.replaceCount).toBe(2);
      const r = cmd.layerScene(store, b.id, p.scenes[2].id, mode);
      expect(r.parts).toBe(preview.changes.size);
      const after = store.getState().arrangement.blocks[0];
      expect(Object.keys(after.parts ?? {}).sort()).toEqual([...preview.changes.keys()].sort());
    }
    const p = project();
    const b = p.arrangement.blocks[0];
    expect(layerText(layerPreview(p, b, p.scenes[2].id), 'Groove')).toEqual({ title: 'Layer Lift into Groove', hint: 'Fills 1 part · Shift replaces 2 parts', changes: true });
    expect(layerText(layerPreview(p, b, p.scenes[2].id, 'replace'), 'Groove').title).toBe('Replace Groove’s parts with Lift’s');
    // Intro only has drums, which Groove plays: nothing to fill, Shift would replace them.
    expect(layerText(layerPreview(p, b, p.scenes[0].id), 'Groove')).toMatchObject({ title: 'Nothing silent to fill in Groove', changes: false });
    // The block's own scene: a clear no-op, never "Layer Groove into Groove".
    const same = layerText(layerPreview(p, b, b.sceneId, 'replace'), 'Groove');
    expect(same.title).toBe('Groove already plays Groove');
    expect(same.changes).toBe(false);
    expect(same.title).not.toMatch(/^Layer/);
  });

  it('cells say what a click does; the toast names the part and the block', () => {
    const p = project();
    const [drums, perc, bass] = p.tracks;
    p.arrangement.blocks[0].parts = { [bass.id]: null };
    const v = blockView(p, p.arrangement.blocks[0], 0);
    const cell = (id: Id) => v.cells.find((c) => c.trackId === id)!;
    expect(cellTip(v, cell(drums.id))).toBe(`Click: switch ${drums.name} off in this block`);
    expect(cellTip(v, cell(bass.id))).toBe(`Click: switch ${bass.name} back on in this block`);
    expect(cellTip(v, cell(perc.id))).toBe(`Click: choose what ${perc.name} plays in Groove`);
    expect(cellToast('Drums', 'Groove', null, null)).toBe('Drums off in Groove');
    expect(cellToast('Drums', 'Groove', undefined, null)).toBe('Drums back on in Groove');
    expect(cellToast('Lead', 'Groove', 'x', 'Lift')).toBe('Lead plays Lift in Groove');
    for (const t of [cellToast('Drums', 'Groove', null, null), cellToast('Drums', 'Groove', undefined, null)]) expect(t).not.toMatch(/next bar/);
    // The edge bubble says how many times the block plays (not "passes"); the header shows the length live.
    expect(resizeText(4, 3)).toBe('3 times · 12 bars');
    expect(timesText(1)).toBe('once');
    expect(liveLengthText(4, 3)).toBe('12 bars');
    expect(liveLengthText(4, 3, true)).toBe('12 bars 4 × 3');
    expect(resizeText(4, 1, true)).toBe('once · 4 bars (4 × 1)');
  });

  it('a block whose scene was deleted is shown as skipped', () => {
    const p = project();
    p.arrangement.blocks.push({ id: 'gone', sceneId: 'no-such-scene', repeats: 2 });
    const v = laneBlocks(p)[1];
    expect(v.missing).toBe(true);
    expect(v.totalBars).toBe(0);
    expect(blockLabel(v, 2)).toContain('no longer exists');
  });
});
