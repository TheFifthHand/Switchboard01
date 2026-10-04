/**
 * The Song view's mouse gestures in real Chromium with a real mouse (CDP):
 * moving a loop along its row snaps to whole bars at every zoom, Alt (or
 * Ctrl) at the drop copies, the right edge stretches (the clip repeats), the
 * left edge trims, the preview of what a drop carves is exactly what the drop
 * makes, a marquee selects across rows and the selection moves together,
 * Escape cancels, leaving the row says "not allowed" and still lands on the
 * row, and edges that meet flash. Each gesture is one undo step.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import type { Project } from '../../src/project/types';
import {
  barX,
  clickAt,
  dragTo,
  dragView,
  drawnShape,
  edge,
  on,
  openSong,
  ppb,
  press,
  project,
  region,
  regionEl,
  regions,
  release,
  resetSong,
  rowY,
  settle,
  shapeOf,
  teardownSong,
  undoCount,
} from './r5-song-helpers';

/** Drums (row 1): A over bars 1–8 and B over 13–16; Bass (row 3): C over 1–16. */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  const dc = drums.clips.find((c) => c)!;
  const bc = bass.clips.find((c) => c)!;
  p.arrangement.regions = [region('A', drums.id, dc.id, 0, 8), region('B', drums.id, dc.id, 12, 4), region('C', bass.id, bc.id, 0, 16)];
  p.arrangement.sections = [];
}

const get = (id: string) => regions().find((r) => r.id === id)!;

/** The song at a scale where every drag here stays clear of the view's auto-scroll edges. */
async function open(): Promise<void> {
  await openSong(1366, 768, song);
  act(() => ppbStore.setState(24));
  await settle();
}

beforeEach(resetSong);
afterEach(teardownSong);

describe('moving a loop', () => {
  for (const scale of [12, 32, 64]) {
    it(`snaps to whole bars at ${scale} px per bar, along its own row, one undo step`, async () => {
      await open();
      act(() => ppbStore.setState(scale));
      await settle();
      const before = undoCount();
      const from = on('A', 0.3);
      await dragTo(from, { x: from.x + 3.4 * scale, y: from.y + 6 });
      expect(get('A')).toMatchObject({ start: 3, bars: 8, trackId: project().tracks[0].id });
      expect(undoCount()).toBe(before + 1);
      // Drawn on the bar line.
      expect(Math.abs(regionEl('A').getBoundingClientRect().left - barX(3))).toBeLessThanOrEqual(2);
    });
  }

  it('clicks onto each bar line on the way (a short eased slide), with a “Bar N” badge', async () => {
    await open();
    const from = on('A', 0.3);
    const k = ppb();
    await dragTo(from, { x: from.x + 2.2 * k, y: from.y }, { release: false });
    expect(dragView()?.badge?.text).toBe('Bar 3');
    const ghost = document.querySelector<HTMLElement>('[data-ghost][data-lifted]')!;
    expect(ghost).toBeTruthy();
    expect(getComputedStyle(ghost).transitionProperty).toContain('transform');
    await release({ x: from.x + 2.2 * k, y: from.y });
    expect(get('A').start).toBe(2);
  });

  it('Alt at the drop copies: “+ Copy” shows while it is held, the original stays', async () => {
    await open();
    const from = on('B', 0.5);
    const k = ppb();
    const to = { x: from.x + 6 * k, y: from.y };
    await dragTo(from, to, { release: false, modifiers: 1 });
    expect(dragView()?.badge?.text).toBe('+ Copy · Bar 19');
    await release(to, 1);
    const drums = regions().filter((r) => r.trackId === project().tracks[0].id);
    expect(drums.map((r) => [r.start, r.bars])).toEqual([
      [0, 8],
      [12, 4],
      [18, 4],
    ]);
  });

  it('Ctrl at the drop copies too', async () => {
    await open();
    const from = on('B', 0.5);
    const to = { x: from.x + 5 * ppb(), y: from.y };
    await dragTo(from, to, { modifiers: 2 });
    expect(regions().filter((r) => r.trackId === project().tracks[0].id)).toHaveLength(3);
    expect(get('B').start).toBe(12);
  });

  it('leaving the row by more than a row’s height says “not allowed”, and the drop still lands on its own row', async () => {
    await open();
    const from = on('B', 0.5);
    const far = { x: from.x + 2 * ppb(), y: rowY(project().tracks[4].id) };
    await dragTo(from, far, { release: false });
    expect(dragView()?.notAllowed).toBe(true);
    expect(document.querySelector('[data-testid="lane-scroller"]')!.hasAttribute('data-not-allowed')).toBe(true);
    await release(far);
    expect(get('B')).toMatchObject({ trackId: project().tracks[0].id, start: 14 });
  });

  it('Escape cancels: nothing changes and no undo step is made', async () => {
    await open();
    const before = undoCount();
    const shape = shapeOf(regions());
    const from = on('A', 0.4);
    const to = { x: from.x + 5 * ppb(), y: from.y };
    await dragTo(from, to, { release: false });
    await press('Escape');
    await release(to);
    expect(shapeOf(regions())).toEqual(shape);
    expect(undoCount()).toBe(before);
    expect(dragView()).toBeNull();
  });
});

describe('edges', () => {
  it('the right edge stretches: “8 bars · plays …” while dragging, the clip repeats to fill it', async () => {
    await open();
    const k = ppb();
    const cb = project().tracks[0].clips.find((c) => c)!.bars;
    const grip = edge('B', 'end');
    await dragTo(grip, { x: grip.x + 4 * k, y: grip.y }, { release: false });
    expect(dragView()?.badge?.text).toMatch(/^8 bars · plays \S+×$/);
    if (8 % cb === 0) expect(dragView()?.badge?.text).toBe(`8 bars · plays ${8 / cb}×`);
    await release({ x: grip.x + 4 * k, y: grip.y });
    expect(get('B')).toMatchObject({ start: 12, bars: 8, offset: 0 });
  });

  it('the left edge trims the start (“starts at bar 5”); the music stays where it was', async () => {
    await open();
    const k = ppb();
    const cb = project().tracks[2].clips.find((c) => c)!.bars;
    const grip = edge('C', 'start');
    await dragTo(grip, { x: grip.x + 4 * k, y: grip.y }, { release: false });
    expect(dragView()?.badge?.text).toBe('starts at bar 5');
    await release({ x: grip.x + 4 * k, y: grip.y });
    expect(get('C')).toMatchObject({ start: 4, bars: 12, offset: 4 % cb });
  });

  it('an edge that lands on a neighbour’s edge flashes them (snapped together)', async () => {
    await open();
    const k = ppb();
    const grip = edge('A', 'end');
    await dragTo(grip, { x: grip.x + 4 * k, y: grip.y }, { release: false });
    expect(dragView()?.touches).toEqual([{ trackId: project().tracks[0].id, bar: 12 }]);
    expect(document.querySelector('[class*="touch"]')).toBeTruthy();
    await release({ x: grip.x + 4 * k, y: grip.y });
    expect(get('A').bars).toBe(12);
  });
});

describe('the preview is the result', () => {
  it('a loop dropped over others: what the drag draws is what the drop makes', async () => {
    await open();
    const from = on('B', 0.5);
    const to = { x: from.x - 9 * ppb(), y: from.y };
    await dragTo(from, to, { release: false });
    await settle(150);
    const during = drawnShape();
    await release(to);
    await settle(150);
    expect(drawnShape()).toEqual(during);
    // A was split around B: 0–3, B at 3–7, the rest of A from bar 7 on.
    const drums = regions().filter((r) => r.trackId === project().tracks[0].id).map((r) => [r.start, r.bars]);
    expect(drums).toEqual([
      [0, 3],
      [3, 4],
      [7, 1],
    ]);
  });
});

describe('selecting', () => {
  it('a marquee over empty rows selects what it touches; dragging one moves them all together', async () => {
    await open();
    const k = ppb();
    const y0 = rowY(project().tracks[0].id) - 14;
    const y1 = rowY(project().tracks[2].id) + 6;
    // From the empty stretch between A and B (bars 9–12) down to the Bass row.
    await dragTo({ x: barX(9.5), y: y0 }, { x: barX(10.5), y: y1 });
    const sel = [...document.querySelectorAll('[data-region-id][data-selected]')].map((e) => (e as HTMLElement).dataset.regionId).sort();
    expect(sel).toEqual(['C']);
    // Shift+click adds A; dragging A moves both.
    await clickAt(on('A', 0.5), 8);
    expect([...document.querySelectorAll('[data-region-id][data-selected]')].length).toBe(2);
    const from = on('A', 0.5);
    await dragTo(from, { x: from.x + 2 * k, y: from.y });
    expect(get('A').start).toBe(2);
    expect(get('C').start).toBe(2);
  });

  it('a click selects one; a click on an empty spot clears; Ctrl+A selects every loop', async () => {
    await open();
    await clickAt(on('A'));
    expect(regionEl('A').hasAttribute('data-selected')).toBe(true);
    await clickAt({ x: barX(10), y: rowY(project().tracks[0].id) });
    expect(document.querySelectorAll('[data-region-id][data-selected]').length).toBe(0);
    await clickAt(on('A'));
    await press('a', 2);
    expect(document.querySelectorAll('[data-region-id][data-selected]').length).toBe(3);
  });
});
