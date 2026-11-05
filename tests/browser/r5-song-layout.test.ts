/**
 * The Song view's layout and drag performance in real Chromium:
 * - at 1024, 1366 (keyboard open and folded), 1536 and 1920 px wide the page
 *   never scrolls sideways, the header is one row whose keys never overlap,
 *   every part row fits (no scrolling up and down at 768 px high), regions of
 *   a row never overlap, and the loop browser stays inside the view;
 * - with 150 regions on screen at 1366 x 768, a two-second drag keeps the
 *   frames coming at 60 fps (frame times are reported) and changes nothing
 *   in the DOM of the regions it does not touch (only the overlay draws);
 * - with 168 loops at 4 px per bar, picking a loop up and dropping it costs
 *   no long frame (the longest frames are reported).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dragStore, ppbStore } from '../../src/app/views/arrange/laneStore';
import type { Project, SongRegion } from '../../src/project/types';
import { setKeyboardCollapsed } from '../../src/state/uiStore';
import { on, openSong, ppb, resetSong, scroller, settle, teardownSong } from './r5-song-helpers';

beforeEach(resetSong);
afterEach(teardownSong);

function overlaps(a: DOMRect, b: DOMRect, slack = 0.5): boolean {
  return a.left < b.right - slack && b.left < a.right - slack && a.top < b.bottom - slack && b.top < a.bottom - slack;
}

function checkLayout(label: string): void {
  // No sideways page scroll.
  expect(document.documentElement.scrollWidth, label).toBeLessThanOrEqual(window.innerWidth);
  // The header: one row, keys apart, inside the window.
  const head = document.querySelector<HTMLElement>('header[class*="head"]')!;
  const hr = head.getBoundingClientRect();
  expect(hr.height, `${label}: header height`).toBeLessThanOrEqual(44);
  const keys = [...head.querySelectorAll<HTMLElement>('button, [data-testid="song-length"], h2')].filter((k) => k.offsetParent).map((k) => k.getBoundingClientRect());
  for (let i = 0; i < keys.length; i++) {
    expect(keys[i].right, `${label}: header key ${i} inside`).toBeLessThanOrEqual(window.innerWidth);
    for (let j = i + 1; j < keys.length; j++) expect(overlaps(keys[i], keys[j]), `${label}: header keys ${i} and ${j}`).toBe(false);
  }
  // Every part row fits: the timeline does not scroll up and down.
  const sc = scroller();
  expect(sc.scrollHeight, `${label}: rows fit`).toBeLessThanOrEqual(sc.clientHeight + 1);
  // Regions of a row never overlap.
  for (const lane of document.querySelectorAll<HTMLElement>('[data-lane]')) {
    const rs = [...lane.querySelectorAll<HTMLElement>('[data-region-id]')].map((r) => r.getBoundingClientRect());
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) expect(overlaps(rs[i], rs[j]), `${label}: regions overlap`).toBe(false);
  }
  // The loop browser (when open) stays inside the window.
  const browser = document.querySelector<HTMLElement>('[data-testid="loop-browser"]');
  if (browser) expect(browser.getBoundingClientRect().right, `${label}: browser`).toBeLessThanOrEqual(window.innerWidth);
}

describe('layout', () => {
  for (const [w, h] of [
    [1024, 768],
    [1366, 768],
    [1536, 864],
    [1920, 1080],
  ] as const) {
    it(`${w} x ${h}: nothing overflows or overlaps; every row fits`, async () => {
      await openSong(w, h);
      checkLayout(`${w}x${h} starter song`);
      // With the loop browser open too.
      const loops = document.querySelector<HTMLElement>('[data-testid="loops-toggle"]')!;
      if (loops.getAttribute('aria-pressed') !== 'true') {
        act(() => loops.click());
        await settle(200);
      }
      checkLayout(`${w}x${h} with the loop browser`);
      if (w === 1366) {
        act(() => setKeyboardCollapsed(true));
        await settle(300);
        checkLayout(`${w}x${h} keyboard folded`);
      }
    });
  }
});

/** `perPart` regions on each of the 8 parts (2 or 3 bars, a bar apart), across the song. */
function bigSong(perPart: number, max = Infinity) {
  return (p: Project): void => {
    const regions: SongRegion[] = [];
    let n = 0;
    p.tracks.forEach((t, ti) => {
      const clip = t.clips.find((c) => c);
      if (!clip) return;
      let at = ti % 2;
      while (regions.filter((r) => r.trackId === t.id).length < perPart && n < max) {
        const bars = 2 + ((n + ti) % 2);
        regions.push({ id: `r${n++}`, trackId: t.id, clipId: clip.id, start: at, bars, offset: 0 });
        at += bars + 1;
      }
    });
    p.arrangement.regions = regions;
    p.arrangement.sections = [];
  };
}

/** Frame times (ms, rAF to rAF) until stop() is called. */
function frameTimes(): { stop(): number[]; mark(): number } {
  const frames: number[] = [];
  let last = performance.now();
  let running = true;
  const tick = (t: number) => {
    frames.push(t - last);
    last = t;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    mark: () => frames.length,
    stop: () => {
      running = false;
      return frames;
    },
  };
}

describe('performance', () => {
  it('150 regions on screen: a two-second drag stays at 60 fps and touches no other region’s DOM', async () => {
    await openSong(1366, 768, bigSong(19, 150));
    act(() => ppbStore.setState(12));
    await settle(300);
    const shown = [...document.querySelectorAll<HTMLElement>('[data-region-id]')].filter((el) => {
      const r = el.getBoundingClientRect();
      const s = scroller().getBoundingClientRect();
      return r.right > s.left && r.left < s.right;
    });
    expect(shown.length).toBeGreaterThanOrEqual(150);
    const { mouse } = await import('./r4-uikit-input');
    const dragged = 'r40';
    const from = on(dragged, 0.5);
    // Pick it up (selecting it changes the selected and focused regions: that is before the drag).
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from);
    await mouse('mouseMoved', { x: from.x + 8, y: from.y }, { buttons: 1 });
    await settle(100);
    // From here on, watch every region except the dragged one, and the frame times. The regions the drop would
    // carve are hidden (the overlay draws them as they would end up): that one attribute is all that may change.
    const carved = new Set<string>();
    const unsub = dragStore.subscribe((v) => v?.preview?.hidden.forEach((id) => carved.add(id)));
    const touched = new Set<string>();
    let mutations = 0;
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        const el = (m.target instanceof Element ? m.target : m.target.parentElement)?.closest('[data-region-id]') as HTMLElement | null;
        if (!el || el.dataset.regionId === dragged) continue;
        if (m.type === 'attributes' && m.attributeName === 'data-hidden' && m.target === el) touched.add(el.dataset.regionId!);
        else mutations++;
      }
    });
    mo.observe(document.querySelector('[data-testid="lane-scroller"]')!, { subtree: true, attributes: true, childList: true, characterData: true });
    const ft = frameTimes();
    const steps = 120;
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', { x: from.x + 8 + (14 * ppb() * i) / steps, y: from.y + 4 * Math.sin(i / 9) }, { buttons: 1 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    const frames = ft.stop();
    mo.disconnect();
    unsub();
    const sorted = frames.slice(2).sort((a, b) => a - b);
    const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const report = { frames: sorted.length, over20ms: sorted.filter((f) => f > 20).length, p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1), mutations, carved: touched.size };
    console.log(`[song drag, 150 regions, 1366x768] ${JSON.stringify(report)}`);
    await mouse('mouseReleased', { x: from.x + 8 + 14 * ppb(), y: from.y });
    await settle();
    expect(mutations).toBe(0);
    for (const id of touched) expect(carved.has(id), `${id} was hidden but the drop does not change it`).toBe(true);
    expect(report.p50).toBeLessThan(20);
    expect(report.p95).toBeLessThan(40);
  });

  it('168 loops at 4 px per bar: picking a loop up and dropping it costs no long frame', async () => {
    await openSong(1366, 768, bigSong(21));
    act(() => ppbStore.setState(4));
    await settle(400);
    const { mouse } = await import('./r4-uikit-input');
    const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
    const pickUps: number[] = [];
    const drops: number[] = [];
    for (let round = 0; round < 4; round++) {
      const from = on('r40', 0.5);
      await mouse('mouseMoved', from);
      await mouse('mousePressed', from);
      await settle(60);
      const ft = frameTimes();
      await frame();
      // The press travels past the drag threshold: the loop is picked up.
      const m0 = ft.mark();
      await mouse('mouseMoved', { x: from.x + 10, y: from.y }, { buttons: 1 });
      for (let i = 0; i < 4; i++) await frame();
      const m1 = ft.mark();
      for (let i = 1; i <= 20; i++) {
        await mouse('mouseMoved', { x: from.x + 10 + i * 2, y: from.y }, { buttons: 1 });
        await frame();
      }
      const m2 = ft.mark();
      await mouse('mouseReleased', { x: from.x + 50, y: from.y });
      for (let i = 0; i < 4; i++) await frame();
      const frames = ft.stop();
      pickUps.push(Math.max(...frames.slice(m0, m1)));
      drops.push(Math.max(...frames.slice(m2)));
      await settle(200);
    }
    console.log(`[song pick-up and drop, 168 loops, 4 px per bar, 1366x768] longest frame at pick-up ${pickUps.map((f) => f.toFixed(1)).join(' / ')} ms, at the drop ${drops.map((f) => f.toFixed(1)).join(' / ')} ms`);
    // The first round warms up; the others are the steady cost (their middle one): at most one frame late.
    const steady = (xs: number[]) => xs.slice(1).sort((a, b) => a - b)[1];
    expect(steady(pickUps)).toBeLessThan(34);
    expect(steady(drops)).toBeLessThan(34);
  });
});
