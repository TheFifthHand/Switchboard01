/**
 * Song moves (arrange-no-change-over-time, stage 1): "Shape this block…"
 * lists Fade in, Fade out, Filter rise and Echo throw as checkable items, each
 * with a one-line explanation; a block with moves draws a thin teal ramp over
 * its cells, names them in its header and in its accessible name. Each toggle
 * is one Undo. Real clicks, the running app at 1366 × 768, 1920 × 1080 and
 * 200 % (960 × 540).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { MOVE_SAYS } from '../../src/app/views/arrange/songActions';
import { blockEl, blockIds, blocks, centre, clickAt, menuItem, notice, openApp, openBlockMenu, resetArrange, settle, status, teardownArrange, undoCount } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const NAMES = ['Fade in', 'Fade out', 'Filter rise', 'Echo throw'];
const kinds = (i: number) => (blocks()[i].moves ?? []).map((m) => m.kind);
const ramps = (id: string) => blockEl(id).querySelector<SVGSVGElement>('svg[data-moves]');

/** The theme's teal, as a computed colour. */
function tealColour(): string {
  const probe = document.createElement('span');
  probe.style.color = 'var(--teal)';
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

/** A real click on a menu item, scrolled into the menu's view first (the Shape list scrolls on a small window). */
async function choose(name: string) {
  const it = menuItem(name);
  it.scrollIntoView({ block: 'nearest' });
  await settle(30);
  await clickAt(centre(it));
  await settle(60);
}

async function openShape(id: string) {
  await openBlockMenu(id);
  act(() => menuItem('Shape this block').click());
  await settle(60);
}

describe('song moves on a block', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: the Moves are checkable, explained in a line, drawn as a teal ramp and named`, async () => {
      await openApp(w, hh);
      const id = blockIds()[1];
      blockEl(id).scrollIntoView({ block: 'center', inline: 'nearest' });
      await settle(60);
      expect(ramps(id)).toBeNull();
      await openShape(id);
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
      expect(menu.textContent).toContain('Moves');
      const items = NAMES.map((n) => menuItem(n));
      for (const it of items) {
        expect(it.getAttribute('role')).toBe('menuitemcheckbox');
        expect(it.getAttribute('aria-checked')).toBe('false');
        // Its one-line explanation is right under it.
        const note = it.parentElement!.querySelector<HTMLElement>('[class*="menuNote"]')!;
        expect(note.textContent!.length).toBeGreaterThan(20);
      }
      expect(items[0].parentElement!.textContent).toContain('The song rises from silence across this block.');
      // Fade in, with a real click: on, one Undo; the menu stays open, now checked (no toast pops up over
      // the menu: its check mark says it, and the lane says it to a screen reader).
      const undo = undoCount();
      const toastBefore = notice();
      await choose('Fade in');
      expect(kinds(1)).toEqual(['fadeIn']);
      expect(undoCount()).toBe(undo + 1);
      expect(notice()).toEqual(toastBefore);
      expect(status()).toBe(`Fade in on Groove: ${MOVE_SAYS.fadeIn}.`);
      expect(menuItem('Fade in').getAttribute('aria-checked')).toBe('true');
      // Echo throw too.
      await choose('Echo throw');
      expect(kinds(1)).toEqual(['fadeIn', 'echoThrow']);
      await clickAt({ x: 4, y: 4 });
      await settle(60);

      // Drawn: a teal ramp over the cells (not over the header), rising across the block; the echo throw on its last beat.
      const svg = ramps(id)!;
      expect(svg).not.toBeNull();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(getComputedStyle(svg).stroke).toBe(tealColour());
      const block = blockEl(id).getBoundingClientRect();
      const fade = svg.querySelector<SVGPathElement>('path[data-move="fadeIn"]')!.getBoundingClientRect();
      expect(fade.width).toBeGreaterThan(block.width - 10);
      const header = blockEl(id).querySelector<HTMLElement>('[class*="bhead"]')!.getBoundingClientRect();
      expect(fade.top).toBeGreaterThanOrEqual(header.bottom - 1);
      const echo = svg.querySelector<SVGPathElement>('path[data-move="echoThrow"]')!.getBoundingClientRect();
      expect(echo.left).toBeGreaterThan(block.right - block.width * 0.1);
      // Named: the header tag and the accessible name.
      expect(blockEl(id).querySelector('[data-testid="block-moves"]')!.textContent).toContain('2 moves');
      expect(blockEl(id).getAttribute('aria-label')).toContain('moves: Fade in and Echo throw');
      // Taken off again from the menu; Undo puts it back.
      await openShape(id);
      await choose('Fade in');
      expect(kinds(1)).toEqual(['echoThrow']);
      expect(status()).toBe('Fade in taken off Groove.');
      await clickAt({ x: 4, y: 4 });
      await settle(60);
      expect(blockEl(id).querySelector('[data-testid="block-moves"]')!.textContent).toContain('Echo throw');
      act(() => session.undo());
      await settle(60);
      expect(kinds(1)).toEqual(['fadeIn', 'echoThrow']);
    });
  }

  it('both fades: the ramp rises over the first half and falls over the second (as it is heard)', async () => {
    await openApp(1366, 768);
    const id = blockIds()[2];
    await openShape(id);
    await choose('Fade in');
    await choose('Fade out');
    await clickAt({ x: 4, y: 4 });
    await settle(60);
    const svg = ramps(id)!;
    const box = svg.getBoundingClientRect();
    const up = svg.querySelector<SVGPathElement>('path[data-move="fadeIn"]')!.getBoundingClientRect();
    const down = svg.querySelector<SVGPathElement>('path[data-move="fadeOut"]')!.getBoundingClientRect();
    expect(Math.abs(up.right - (box.left + box.width / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(down.left - (box.left + box.width / 2))).toBeLessThanOrEqual(2);
    expect(blockEl(id).getAttribute('aria-label')).toContain('moves: Fade in and Fade out');
  });
});
