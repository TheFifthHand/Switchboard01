/**
 * An ordinary mouse wheel scrolls the song lane (mouse-wheel): over a lane
 * longer than its view, a vertical wheel scrolls it sideways, unless something
 * around it can still scroll that way (a zoomed-in page scrolls first). It is
 * the user's own scroll: following the playhead waits. Ctrl+wheel still zooms,
 * one fine step a notch. Real wheel events (CDP), the running app.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { ZOOM_STEPS } from '../../src/app/views/arrange/songLayout';
import * as cmd from '../../src/state/commands';
import { blockEl, blockIds, blocks, byLabel, centre, clickAt, mouse, openApp, resetArrange, scroller, settle, teardownArrange, wheelAt } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

/** The starter's song four times over (24 blocks), in the running app. */
async function longSong() {
  act(() => {
    const four = blocks().map((b) => cmd.blockTemplate(b));
    for (let i = 0; i < 3; i++) cmd.insertBlocks(session.store, four);
  });
  await settle(300);
  expect(blockIds().length).toBe(24);
}

describe('the mouse wheel over the lane', () => {
  it('scrolls a lane longer than its view sideways; Ctrl+wheel zooms one fine step; the page stays put (1366 x 768)', async () => {
    await openApp(1366, 768);
    await longSong();
    // Zoomed in twice (the song no longer fits): it scrolls. From the song's start.
    await clickAt(centre(byLabel('Zoom in')));
    await clickAt(centre(byLabel('Zoom in')));
    await settle(300);
    const sc = scroller();
    expect(sc.scrollWidth).toBeGreaterThan(sc.clientWidth + 400);
    sc.scrollLeft = 0;
    await settle(60);
    const over = centre(blockEl(blockIds()[1]));
    const before = sc.scrollLeft;
    await wheelAt(over, 100);
    await wheelAt(over, 100);
    await settle(250);
    expect(sc.scrollLeft).toBeGreaterThan(before + 150);
    expect(document.scrollingElement!.scrollTop).toBe(0);
    // And back.
    await wheelAt(over, -100);
    await settle(250);
    expect(sc.scrollLeft).toBeLessThan(before + 150);
    // Ctrl+wheel zooms by one step of the ladder (the zoom keys move two).
    const w = blockEl(blockIds()[1]).getBoundingClientRect().width;
    const bars = 16;
    const ppb = Math.round(w / bars);
    await wheelAt(centre(blockEl(blockIds()[1])), -120, 2);
    await settle(300);
    const next = ZOOM_STEPS.find((s) => s > ppb)!;
    expect(Math.round(blockEl(blockIds()[1]).getBoundingClientRect().width / bars)).toBe(next);
  });

  it('counts as the user’s own scroll: the playhead does not pull the lane back for a while', async () => {
    await openApp(1366, 768);
    await longSong();
    await clickAt(centre(byLabel('Zoom in')));
    await clickAt(centre(byLabel('Zoom in')));
    await settle(300);
    act(() => void cmd.setBpm(session.store, 220));
    await act(async () => {
      await session.playSong(0);
    });
    await settle(300);
    const sc = scroller();
    // Follow turned off and on catches up with the playhead at once (the zoom's own pause is over).
    const follow = byLabel('Follow playhead');
    await clickAt(centre(follow));
    await clickAt(centre(follow));
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    await mouse('mouseMoved', { x: 2, y: 2 });
    await settle(900);
    expect(sc.scrollLeft).toBeLessThan(200);
    // Six notches over the blocks take the lane well past the playhead.
    const view = sc.getBoundingClientRect();
    const over = { x: view.left + view.width / 2, y: view.top + 120 };
    for (let i = 0; i < 6; i++) await wheelAt(over, 120);
    await mouse('mouseMoved', { x: 2, y: 2 });
    await settle(300);
    const left = sc.scrollLeft;
    expect(left).toBeGreaterThan(500);
    // Following would glide back to the playhead now; it waits (8 s) instead.
    await settle(2500);
    expect(Math.abs(sc.scrollLeft - left)).toBeLessThan(2);
  });

  it('at 200 % (the page scrolls) the page scrolls first, then the lane', async () => {
    await openApp(960, 540);
    const sc = scroller();
    expect(sc.scrollWidth).toBeGreaterThan(sc.clientWidth + 200);
    const page = document.scrollingElement!;
    expect(page.scrollHeight).toBeGreaterThan(page.clientHeight + 100);
    page.scrollTop = 0;
    sc.scrollLeft = 200;
    await settle(60);
    // The lane is in view below the transport; a wheel down over it scrolls the page down, not the lane.
    const b = blockEl(blockIds()[1]).getBoundingClientRect();
    const over = { x: Math.max(b.left + 40, sc.getBoundingClientRect().left + 40), y: Math.min(b.top + 60, window.innerHeight - 20) };
    expect(sc.contains(document.elementFromPoint(over.x, over.y))).toBe(true);
    await wheelAt(over, 100);
    await settle(250);
    expect(page.scrollTop).toBeGreaterThan(0);
    expect(sc.scrollLeft).toBe(200);
    // At the top of the page a wheel up has nowhere to take the page: it scrolls the lane back.
    page.scrollTop = 0;
    await settle(60);
    expect(sc.contains(document.elementFromPoint(over.x, over.y))).toBe(true);
    await wheelAt(over, -100);
    await settle(250);
    expect(sc.scrollLeft).toBeLessThan(150);
    expect(page.scrollTop).toBe(0);
  });
});
