/**
 * The song lane's loop, as pure logic: the looped span in the current order
 * (a loop whose blocks are gone is no loop), a drag across the ruler (every
 * block from the one under the press to the one under the pointer, snapped to
 * block edges), dragging one end of the band (nearest block edge, never past
 * the other end), what the Loop button acts on (the user's selection, else
 * the loop that is on, else the playing block, else the first) and what
 * pressing it does (on, off, or move the loop), its name, and what the lane
 * says.
 */
import { describe, expect, it } from 'vitest';
import { blockIndexAt, loopButtonPress, loopButtonTarget, loopButtonText, loopEdgeDrag, loopFromDrag, loopName, loopRange, loopSpan, loopStatus, loopTarget, loopTargetName, sameSpan, spanX } from '../../src/app/views/arrange/laneLoop';
import { layoutSong } from '../../src/app/views/arrange/songLayout';

// Five blocks at 10 px per bar: widths 112 (min), 160, 320, 112 (min), 160.
const layout = layoutSong(
  [
    { id: 'a', bars: 4, repeats: 1 },
    { id: 'b', bars: 4, repeats: 4 },
    { id: 'c', bars: 4, repeats: 8 },
    { id: 'd', bars: 2, repeats: 1 },
    { id: 'e', bars: 4, repeats: 4 },
  ],
  0,
  { pxPerBar: 10 },
);
const order = ['a', 'b', 'c', 'd', 'e'];
const names = ['Intro', 'Groove', 'Lift', 'Break', 'Groove'];
const edges = layout.blocks.map((b) => [b.x, b.x + b.width]);

describe('loop span', () => {
  it('is the blocks from..to in the current order, either way round; a missing block means no loop', () => {
    expect(edges).toEqual([
      [0, 112],
      [112, 272],
      [272, 592],
      [592, 704],
      [704, 864],
    ]);
    expect(loopSpan(order, { fromBlockId: 'b', toBlockId: 'd' })).toEqual({ from: 1, to: 3 });
    // Blocks moved so the loop's ends swapped: still the blocks between them.
    expect(loopSpan(['d', 'a', 'b', 'c', 'e'], { fromBlockId: 'b', toBlockId: 'd' })).toEqual({ from: 0, to: 2 });
    expect(loopSpan(order, { fromBlockId: 'c', toBlockId: 'c' })).toEqual({ from: 2, to: 2 });
    expect(loopSpan(order, { fromBlockId: 'b', toBlockId: 'gone' })).toBeNull();
    expect(loopSpan(order, null)).toBeNull();
    expect(loopRange(order, { from: 1, to: 3 })).toEqual({ fromBlockId: 'b', toBlockId: 'd' });
    expect(loopRange(order, { from: 1, to: 9 })).toBeNull();
    expect(sameSpan({ from: 1, to: 2 }, { from: 1, to: 2 })).toBe(true);
    expect(sameSpan({ from: 1, to: 2 }, null)).toBe(false);
    expect(spanX(layout, { from: 1, to: 3 })).toEqual({ left: 112, right: 704 });
  });
});

describe('ruler drag', () => {
  it('covers every block from the one under the press to the one under the pointer (snapped to their edges)', () => {
    expect(blockIndexAt(layout, -40)).toBe(0);
    expect(blockIndexAt(layout, 111.5)).toBe(0);
    expect(blockIndexAt(layout, 112)).toBe(1);
    expect(blockIndexAt(layout, 2000)).toBe(4);
    // Inside one block: that block.
    expect(loopFromDrag(layout, 300, 500)).toEqual({ from: 2, to: 2 });
    // From the middle of Groove to the middle of Break, or back.
    expect(loopFromDrag(layout, 190, 650)).toEqual({ from: 1, to: 3 });
    expect(loopFromDrag(layout, 650, 190)).toEqual({ from: 1, to: 3 });
    // Past either end of the song: the first or last block.
    expect(loopFromDrag(layout, 400, 5000)).toEqual({ from: 2, to: 4 });
    expect(loopFromDrag(layout, 400, -100)).toEqual({ from: 0, to: 2 });
    expect(loopFromDrag(layoutSong([], 500), 0, 10)).toBeNull();
  });

  it("dragging the band's start or end goes to the nearest block edge, never past the other end", () => {
    const span = { from: 1, to: 3 };
    // Start: nearest start edge (0, 112, 272, 592).
    expect(loopEdgeDrag(layout, span, 'start', 40)).toEqual({ from: 0, to: 3 });
    expect(loopEdgeDrag(layout, span, 'start', 180)).toEqual({ from: 1, to: 3 });
    expect(loopEdgeDrag(layout, span, 'start', 200)).toEqual({ from: 2, to: 3 });
    expect(loopEdgeDrag(layout, span, 'start', 400)).toEqual({ from: 2, to: 3 });
    expect(loopEdgeDrag(layout, span, 'start', 440)).toEqual({ from: 3, to: 3 });
    // Past the end: the loop keeps at least its last block.
    expect(loopEdgeDrag(layout, span, 'start', 900)).toEqual({ from: 3, to: 3 });
    // End: nearest end edge (272, 592, 704, 864).
    expect(loopEdgeDrag(layout, span, 'end', 840)).toEqual({ from: 1, to: 4 });
    expect(loopEdgeDrag(layout, span, 'end', 420)).toEqual({ from: 1, to: 1 });
    expect(loopEdgeDrag(layout, span, 'end', 450)).toEqual({ from: 1, to: 2 });
    expect(loopEdgeDrag(layout, span, 'end', -50)).toEqual({ from: 1, to: 1 });
  });
});

describe('the Loop toggle and what the lane says', () => {
  it('loops the selection (first to last selected), else the playing block, else the first block', () => {
    expect(loopTarget(order, ['d', 'b'], 'e')).toEqual({ from: 1, to: 3 });
    expect(loopTarget(order, ['gone'], 'c')).toEqual({ from: 2, to: 2 });
    expect(loopTarget(order, [], null)).toEqual({ from: 0, to: 0 });
    expect(loopTarget([], [], null)).toBeNull();
  });

  it("the Loop button: the user's selection, else the loop that is on, else the playing block, else the first", () => {
    const loop = { from: 1, to: 2 };
    // A selection the user made wins (even with a loop elsewhere): pressing moves the loop there.
    expect(loopButtonTarget(order, ['d', 'e'], 'c', loop)).toEqual({ from: 3, to: 4 });
    expect(loopButtonPress(loop, { from: 3, to: 4 })).toEqual({ from: 3, to: 4 });
    // No selection of the user's (an action's selection is passed as none): the loop that is on, so pressing turns it off.
    expect(loopButtonTarget(order, [], 'e', loop)).toEqual(loop);
    expect(loopButtonPress(loop, loop)).toBeNull();
    // No loop: the playing block, else the first.
    expect(loopButtonTarget(order, [], 'e', null)).toEqual({ from: 4, to: 4 });
    expect(loopButtonTarget(order, ['gone'], null, null)).toEqual({ from: 0, to: 0 });
    expect(loopButtonPress(null, { from: 4, to: 4 })).toEqual({ from: 4, to: 4 });
    expect(loopButtonTarget([], [], null, null)).toBeNull();
    expect(loopButtonPress(null, null)).toBeNull();
  });

  it('the Loop button names its target and says what pressing it does', () => {
    expect(loopTargetName(names, { from: 2, to: 2 })).toBe('Lift (block 3)');
    expect(loopTargetName(names, { from: 1, to: 3 })).toBe('blocks 2–4');
    expect(loopButtonText(names, null, { from: 2, to: 2 })).toEqual({ label: 'Loop Lift (block 3)', tip: 'Repeat Lift (block 3) while the song plays.' });
    expect(loopButtonText(names, { from: 1, to: 3 }, { from: 1, to: 3 })).toEqual({ label: 'Loop blocks 2–4', tip: 'Loop on: Groove to Break (blocks 2–4). Press to play the song through.' });
    expect(loopButtonText(names, { from: 1, to: 1 }, { from: 2, to: 4 }).tip).toBe('Loop on: Groove (block 2). Press to move the loop to blocks 3–5.');
    expect(loopButtonText(names, null, null).label).toBe('Loop');
  });

  it('names the looped blocks', () => {
    expect(loopName(names, { from: 1, to: 3 })).toBe('Groove to Break (blocks 2–4)');
    expect(loopStatus(names, { from: 1, to: 3 })).toBe('Loop on: Groove to Break (blocks 2–4).');
    expect(loopStatus(names, { from: 2, to: 2 })).toBe('Loop on: Lift (block 3).');
    expect(loopStatus(names, null)).toBe('Loop off: the song plays through.');
  });
});
