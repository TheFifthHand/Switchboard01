/**
 * The right-edge grip works next to a selected block (perf-11): the whole
 * 12 px grip lies inside its block (right: 0), and the block under the pointer
 * sits above a selected neighbour, so pressing the right half of Intro's grip
 * with Groove selected resizes Intro (not Groove, not a move). Real mouse,
 * the running app at 1366 × 768, 1920 × 1080 and 200 % (960 × 540).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockBars } from '../../src/project/arrangement';
import { blockEl, blockIds, blocks, clickAt, mouse, nameAt, openApp, project, resetArrange, settle, teardownArrange } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

describe('the right-edge grip beside a selected neighbour', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: the grip is inside the block; its right half, pressed with the neighbour selected, resizes the block`, async () => {
      await openApp(w, hh);
      const ids = blockIds();
      const intro = blockEl(ids[0]);
      intro.scrollIntoView({ block: 'center', inline: 'nearest' });
      await settle(60);
      // Groove selected.
      await clickAt(nameAt(ids[1]));
      expect(blockEl(ids[1]).hasAttribute('data-selected')).toBe(true);
      const grip = intro.querySelector<HTMLElement>('[data-edge]')!;
      const g = grip.getBoundingClientRect();
      const b = intro.getBoundingClientRect();
      // Inside the block: 12 px (20 px for a finger), ending at its right edge.
      expect(g.width).toBeGreaterThanOrEqual(12);
      expect(g.right).toBeLessThanOrEqual(b.right + 0.5);
      expect(g.left).toBeGreaterThanOrEqual(b.left);
      // The right half of the grip, just left of the seam, over the cells.
      const y = g.top + Math.min(60, g.height / 2);
      const p = { x: g.right - 3, y };
      await mouse('mouseMoved', { x: p.x - 30, y });
      await mouse('mouseMoved', p);
      await settle(40);
      // Hovered: Intro sits above the selected Groove, and the point is Intro's grip.
      expect(Number(getComputedStyle(intro).zIndex)).toBeGreaterThan(Number(getComputedStyle(blockEl(ids[1])).zIndex));
      expect(document.elementFromPoint(p.x, p.y)).toBe(grip);
      // Pressed and dragged right by one pass: Intro plays once more.
      const pass = blockBars(project(), blocks()[0]);
      const ppb = b.width / (pass * blocks()[0].repeats);
      const before = blocks()[0].repeats;
      await mouse('mousePressed', p);
      for (let i = 1; i <= 10; i++) await mouse('mouseMoved', { x: p.x + (pass * ppb * 1.1 * i) / 10, y }, { buttons: 1 });
      await mouse('mouseReleased', { x: p.x + pass * ppb * 1.1, y });
      await settle(150);
      expect(blocks()[0].repeats).toBe(before + 1);
      expect(blocks()[1].repeats).toBe(4);
      expect(blockIds()).toEqual(ids);
    });
  }
});
