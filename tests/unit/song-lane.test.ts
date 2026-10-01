/**
 * The song lane's pure logic: geometry (edge to edge, proportional, zoom
 * steps), where a dragged group lands (with hysteresis) and where every other
 * block sits meanwhile, edge-drag passes, auto-scroll speed, selection, the
 * paste position, the scene-card target (insert vs layer, stable while the
 * slot opens), and what each part cell shows.
 */
import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/project/factory';
import type { Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import {
  AUTOSCROLL_MAX_PX_S,
  EMPTY_SELECTION,
  GAP_HYSTERESIS_PX,
  MIN_PASS_STEP_PX,
  NO_TARGET,
  actionTargets,
  autoScrollVelocity,
  cardEdge,
  cardTarget,
  currentOthersGap,
  edgeStepPx,
  fullGap,
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
} from '../../src/app/views/arrange/songDrag';
import { MIN_BLOCK_WIDTH, ZOOM_STEPS, barToX, blockAtBar, gapX, layoutSong, passDividers, rulerMarks, xToBar } from '../../src/app/views/arrange/songLayout';
import { blockLabel, blockView, cellLabel, cellToggle, laneBlocks, layerPreview, partChoices } from '../../src/app/views/arrange/songModel';

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

describe('lane geometry', () => {
  const song = [
    { id: 'a', bars: 4, repeats: 2 },
    { id: 'b', bars: 4, repeats: 4 },
    { id: 'c', bars: 4, repeats: 2 },
  ];

  it('places blocks edge to edge, proportional, at a zoom step that fits', () => {
    const l = layoutSong(song, 1000);
    expect(ZOOM_STEPS).toContain(l.pxPerBar);
    expect(l.contentWidth).toBeLessThanOrEqual(1000);
    // The next step up would not fit.
    const bigger = ZOOM_STEPS.find((s) => s > l.pxPerBar)!;
    expect(32 * bigger).toBeGreaterThan(1000);
    expect(l.blocks.map((b) => b.x)).toEqual([0, l.blocks[0].width, l.blocks[0].width + l.blocks[1].width]);
    expect(l.blocks[1].width).toBe(2 * l.blocks[0].width);
    expect(l.blocks.map((b) => b.startBar)).toEqual([0, 8, 24]);
    expect(l.totalBars).toBe(32);
  });

  it('keeps the scale for small edits (zoom steps), and holds a given scale', () => {
    // 30 bars fit at 32 px per bar (960 px): one more bar still fits at the same step.
    const thirty = [song[0], song[1], { id: 'c', bars: 6, repeats: 1 }];
    const before = layoutSong(thirty, 1000);
    expect(before.pxPerBar).toBe(32);
    const after = layoutSong([song[0], song[1], { id: 'c', bars: 7, repeats: 1 }], 1000);
    expect(after.pxPerBar).toBe(before.pxPerBar);
    expect(after.blocks[1].width).toBe(before.blocks[1].width);
    const held = layoutSong([...song, { id: 'd', bars: 4, repeats: 16 }], 1000, { pxPerBar: before.pxPerBar });
    expect(held.pxPerBar).toBe(before.pxPerBar);
    expect(held.contentWidth).toBeGreaterThan(1000);
  });

  it('widens a short block to the minimum and keeps the ruler on its edges', () => {
    const l = layoutSong([{ id: 'a', bars: 1, repeats: 1 }, ...song], 600);
    expect(l.blocks[0].width).toBe(MIN_BLOCK_WIDTH);
    const starts = rulerMarks(l).filter((m) => m.blockStart);
    expect(starts.map((m) => m.bar)).toEqual([0, 1, 9, 25]);
    expect(starts.map((m) => m.x)).toEqual(l.blocks.map((b) => b.x));
    expect(starts.every((m) => m.label)).toBe(true);
  });

  it('a song that does not fit scrolls at a step where its shortest block is about the minimum width', () => {
    const bars = [16, 16, 12, 8, 16, 8, 8, 8, 8, 8, 8, 8, 8, 8];
    const l = layoutSong(bars.map((b, i) => ({ id: String(i), bars: b, repeats: 1 })), 1200);
    expect(l.contentWidth).toBeGreaterThan(1200);
    expect(ZOOM_STEPS).toContain(l.pxPerBar);
    expect(8 * l.pxPerBar).toBeLessThanOrEqual(MIN_BLOCK_WIDTH);
    for (const b of l.blocks) expect(b.width).toBe(Math.max(MIN_BLOCK_WIDTH, Math.floor(b.totalBars * l.pxPerBar)));
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
    expect(l.blocks[1].width).toBe(MIN_BLOCK_WIDTH);
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

  it('pastes after the selection, else after the focused block, else at the end', () => {
    expect(pasteGap(order, { ids: ['b', 'c'], anchor: 'b' }, 'a')).toBe(3);
    expect(pasteGap(order, EMPTY_SELECTION, 'a')).toBe(1);
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

  it('the middle of a block layers into it; its ends insert next to it', () => {
    expect(cardTarget(blocks, 100, NO_TARGET, S)).toEqual({ kind: 'layer', index: 0 });
    expect(cardTarget(blocks, 5, NO_TARGET, S)).toEqual({ kind: 'insert', gap: 0 });
    expect(cardTarget(blocks, 200 - 5, NO_TARGET, S)).toEqual({ kind: 'insert', gap: 1 });
    expect(cardTarget(blocks, 200 + 5, NO_TARGET, S)).toEqual({ kind: 'insert', gap: 1 });
    expect(cardTarget(blocks, 650, NO_TARGET, S)).toEqual({ kind: 'insert', gap: 3 });
    expect(cardTarget([], 10, NO_TARGET, S)).toEqual({ kind: 'insert', gap: 0 });
  });

  it('stays on an open slot across its whole width, so the slot opening never flips the target', () => {
    let t: CardTarget = cardTarget(blocks, 200 + 5, NO_TARGET, S);
    expect(t).toEqual({ kind: 'insert', gap: 1 });
    // Walk right through the open slot (blocks after it are drawn 120 px further right).
    for (let x = 205; x <= 200 + S + e; x += 7) {
      t = cardTarget(blocks, x, t, S);
      expect(t).toEqual({ kind: 'insert', gap: 1 });
    }
    // Past the slot and the edge of the shifted block: the target comes from the resting layout again.
    t = cardTarget(blocks, 200 + S + e + 10, t, S);
    expect(t.kind).not.toBe('none');
    // Going back left passes each target once, in order, never alternating between two.
    const runs: string[] = [];
    for (let x = 360; x >= 150; x -= 3) {
      t = cardTarget(blocks, x, t, S);
      const k = JSON.stringify(t);
      if (runs[runs.length - 1] !== k) runs.push(k);
    }
    expect(new Set(runs).size).toBe(runs.length);
    expect(runs.map((r) => JSON.parse(r) as CardTarget)).toEqual([
      { kind: 'insert', gap: 2 },
      { kind: 'layer', index: 1 },
      { kind: 'insert', gap: 1 },
      { kind: 'layer', index: 0 },
    ]);
  });

  it('keeps layering while the pointer stays in the middle of the target', () => {
    let t: CardTarget = { kind: 'layer', index: 1 };
    for (const x of [200 + e + 1, 300, 400 - e - 1]) {
      t = cardTarget(blocks, x, t, S);
      expect(t).toEqual({ kind: 'layer', index: 1 });
    }
  });

  it('a block whose scene is missing cannot be layered into', () => {
    const b = blocks.map((x, i) => ({ ...x, layerable: i !== 1 }));
    expect(cardTarget(b, 290, NO_TARGET, S)).toEqual({ kind: 'insert', gap: 1 });
    expect(cardTarget(b, 310, NO_TARGET, S)).toEqual({ kind: 'insert', gap: 2 });
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

  it('a layer preview lists exactly the parts layerScene changes', () => {
    const p = project();
    const store = new ProjectStore(p);
    const b = p.arrangement.blocks[0];
    const preview = layerPreview(p, b, p.scenes[2].id);
    expect([...preview.changes.keys()].sort()).toEqual([p.tracks[0].id, p.tracks[4].id].sort());
    const r = cmd.layerScene(store, b.id, p.scenes[2].id);
    expect(r.parts).toBe(preview.changes.size);
    const after = store.getState().arrangement.blocks[0];
    expect(Object.keys(after.parts ?? {}).sort()).toEqual([...preview.changes.keys()].sort());
    // Layering the block's own scene changes nothing.
    expect(layerPreview(p, b, b.sceneId).changes.size).toBe(0);
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
