/**
 * The lane keeps its zoom and scroll (shell-17, perf-07, zoom-steps): a zoom
 * key press moves two steps of the ladder, the level reads "Fit" while fitted
 * and a percentage otherwise; the zoom step and scroll are remembered per
 * project for the session (uiStore.laneView), so leaving Arrange and coming
 * back, or an edit, never re-fits it; only Fit song or a window resize does.
 * Opening Arrange measures once (no second long frame). Real clicks, the
 * running app at 1366 × 768, 1920 × 1080 and 200 % (960 × 540).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { ZOOM_BUTTON_STEPS, ZOOM_STEPS, zoomIndex } from '../../src/app/views/arrange/songLayout';
import { getStarter } from '../../src/content/starters';
import { blockBars } from '../../src/project/arrangement';
import { laneViewFor, setView, uiStore } from '../../src/state/uiStore';
import { blockEl, blockIds, blocks, byLabel, centre, clickAt, openApp, project, resetArrange, scroller, settle, teardownArrange } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const level = () => document.querySelector<HTMLButtonElement>('[data-testid="zoom-level"]')!;
/** The lane's px per bar, measured on Groove (block 2). */
const ppb = () => {
  const b = blocks()[1];
  return Math.round(blockEl(b.id).getBoundingClientRect().width / (blockBars(project(), b) * b.repeats));
};

async function goTo(view: 'play' | 'arrange') {
  act(() => setView(view));
  await settle(300);
}

describe('zoom steps and the remembered view', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: two ladder steps a press; Fit while fitted; zoom and scroll survive a trip to Play and an edit`, async () => {
      await openApp(w, hh);
      const open = ppb();
      // Fitted where the whole song shows at a readable size; at 200 % it opens readable and scrolls, and says how
      // much bigger than Fit that is.
      const opened = level().textContent!;
      if (w >= 1366) {
        expect(opened).toBe('Fit');
        expect(level().disabled).toBe(true);
      } else expect(opened).toMatch(/^\d+%$/);
      // Zoom in: two steps of the ladder (about ×1.25–1.6), the level says how far from Fit.
      await clickAt(centre(byLabel('Zoom in')));
      await settle(300);
      const zoomed = ppb();
      expect(zoomed).toBe(ZOOM_STEPS[zoomIndex(open) + ZOOM_BUTTON_STEPS]);
      expect(zoomed / open).toBeGreaterThanOrEqual(1.15);
      expect(zoomed / open).toBeLessThanOrEqual(1.7);
      expect(level().textContent).toMatch(/^\d+%$/);
      if (w >= 1366) expect(level().textContent).toBe(`${Math.round((zoomed / open) * 100)}%`);
      expect(level().disabled).toBe(false);
      // Scrolled along.
      const sc = scroller();
      const max = sc.scrollWidth - sc.clientWidth;
      expect(max).toBeGreaterThan(40);
      const left = Math.min(max, 260);
      sc.scrollLeft = left;
      await settle(400);
      expect(laneViewFor(uiStore.getState(), project().id)).toEqual({ zoomStep: zoomIndex(zoomed), scrollLeft: Math.round(left) });
      // To Play and back: the same zoom and scroll.
      await goTo('play');
      expect(document.querySelector('[data-testid="song-lane"]')).toBeNull();
      await goTo('arrange');
      expect(ppb()).toBe(zoomed);
      expect(Math.abs(scroller().scrollLeft - left)).toBeLessThanOrEqual(1);
      // An edit (a scene added at the end) does not re-fit.
      const n = blocks().length;
      const add = document.querySelector<HTMLElement>('button[aria-label="Add Intro to the end of the song"]')!;
      add.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await settle(30);
      await clickAt(centre(add));
      await settle(300);
      expect(blocks().length).toBe(n + 1);
      expect(ppb()).toBe(zoomed);
      // Fit song (the level) fits again.
      level().scrollIntoView({ block: 'nearest' });
      await clickAt(centre(level()));
      await settle(400);
      expect(level().textContent === 'Fit' || level().textContent === 'Smallest').toBe(true);
      expect(ppb()).toBeLessThanOrEqual(open);
    });
  }

  it('a window resize fits the song again; another project has its own view; the first comes back as it was', async () => {
    await openApp(1366, 768);
    const a = project();
    await clickAt(centre(byLabel('Zoom in')));
    await clickAt(centre(byLabel('Zoom in')));
    await settle(300);
    const zoomed = ppb();
    scroller().scrollLeft = 200;
    await settle(400);
    // Another project (the Garage starter): it opens fitted, from its start.
    act(() => session.store.replace(getStarter('garage')!.build(), { resetHistory: true }));
    await settle(400);
    expect(level().textContent).toBe('Fit');
    expect(scroller().scrollLeft).toBe(0);
    // Back to the first: its zoom and scroll.
    act(() => session.store.replace(a, { resetHistory: true }));
    await settle(400);
    expect(ppb()).toBe(zoomed);
    expect(Math.abs(scroller().scrollLeft - 200)).toBeLessThanOrEqual(1);
    // A resize fits it again.
    await page.viewport(1500, 800);
    await settle(600);
    expect(level().textContent).toBe('Fit');
    expect(ppb()).toBeLessThan(zoomed);
  });

  it('the lane as it opened is remembered as "fit": back on Arrange after a resize elsewhere, it fits the new size', async () => {
    await openApp(1366, 768);
    const fit = ppb();
    await settle(400);
    expect(laneViewFor(uiStore.getState(), project().id)).toEqual({ zoomStep: 'fit', scrollLeft: 0 });
    await goTo('play');
    await page.viewport(1920, 1080);
    await settle(300);
    await goTo('arrange');
    expect(level().textContent).toBe('Fit');
    expect(ppb()).toBeGreaterThan(fit);
  });

  it('opening Arrange measures once: after the first frame nothing in the lane changes again (no re-measure, no re-layout)', async () => {
    await openApp(1366, 768);
    await goTo('play');
    await settle(300);
    // Every change to the lane's elements after its first frame on screen (with no input, a lane that measured once is still).
    const changes: string[] = [];
    let mo: MutationObserver | null = null;
    await act(async () => {
      setView('arrange');
      await new Promise((r) => requestAnimationFrame(r));
      const lane = document.querySelector<HTMLElement>('[data-testid="song-lane"]')!;
      mo = new MutationObserver((records) => {
        for (const r of records) changes.push(`${r.type} ${(r.target as Element).className ?? r.target.nodeName} ${r.attributeName ?? ''}`);
      });
      mo.observe(lane, { subtree: true, attributes: true, childList: true, characterData: true });
      await new Promise((r) => setTimeout(r, 900));
    });
    mo!.disconnect();
    expect(blockIds().length).toBeGreaterThan(0);
    expect(changes, changes.slice(0, 8).join(' | ')).toEqual([]);
  });
});
