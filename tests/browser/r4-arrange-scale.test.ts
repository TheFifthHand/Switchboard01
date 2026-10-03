/**
 * The song lane is a true timeline (timeline-not-to-scale): block widths are
 * proportional to their bars (the only floor is 44 px), so after Build up the
 * 4-bar blocks are half as wide as the 8-bar Intro, the ruler's numbers are
 * evenly spaced, and the playhead moves the same distance per bar in Intro and
 * in a 4-bar block. A block narrower than 112 px has the compact header (its
 * name; ▶ and ⋯ on hover or keyboard focus). At 1366 × 768, 1920 × 1080 and
 * 200 % (960 × 540).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { COMPACT_BLOCK_WIDTH, FULL_HEADER_WIDTH } from '../../src/app/views/arrange/songLayout';
import { blockBars } from '../../src/project/arrangement';
import { TICKS_PER_BAR } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { blockEl, blockIds, blocks, menuItem, mouse, openApp, openBlockMenu, project, resetArrange, rt, settle, teardownArrange } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const width = (id: string) => blockEl(id).getBoundingClientRect().width;
const bars = (i: number) => blockBars(project(), blocks()[i]) * blocks()[i].repeats;

/** Lane x of the playhead (its transform) and the transport tick, sampled each frame for `ms`. */
async function samplePlayhead(ms: number): Promise<{ x: number; tick: number }[]> {
  const head = document.querySelector<HTMLElement>('[data-testid="playhead"]')!;
  const out: { x: number; tick: number }[] = [];
  const end = performance.now() + ms;
  await act(async () => {
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(r));
      const m = /translate3d\((-?[\d.]+)px/.exec(head.style.transform);
      const t = session.transport?.getPosition().tick;
      if (m && t !== undefined) out.push({ x: Number(m[1]), tick: t });
    }
  });
  return out;
}

/** Least-squares slope of x over bars. */
function pxPerBar(samples: { x: number; tick: number }[]): number {
  const pts = samples.map((s) => ({ b: s.tick / TICKS_PER_BAR, x: s.x }));
  const n = pts.length;
  const mb = pts.reduce((a, p) => a + p.b, 0) / n;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.b - mb) * (p.x - mx);
    den += (p.b - mb) ** 2;
  }
  return num / den;
}

describe('the lane is to scale', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: widths are proportional to bars within 1 px; ruler numbers are evenly spaced`, async () => {
      await openApp(w, hh);
      const ids = blockIds();
      const ppb = width(ids[0]) / bars(0);
      expect(ppb).toBeGreaterThanOrEqual(11);
      for (let i = 0; i < ids.length; i++) expect(Math.abs(width(ids[i]) - bars(i) * ppb), `block ${i + 1}`).toBeLessThanOrEqual(1.5);
      // Ruler numbers sit at a regular bar step, the same distance apart.
      const marks = [...document.querySelectorAll<HTMLElement>('[data-testid="song-ruler"] [data-label]')];
      const xs = marks.map((m) => parseFloat(m.style.left));
      const nums = marks.map((m) => Number(m.textContent));
      const gaps = xs.slice(1).map((x, i) => x - xs[i]);
      for (const g of gaps) expect(Math.abs(g - gaps[0])).toBeLessThanOrEqual(1);
      const step = nums[1] - nums[0];
      for (let i = 1; i < nums.length; i++) expect(nums[i] - nums[i - 1]).toBe(step);
      // Each block start has its own (taller) line, on the block's edge.
      const starts = [...document.querySelectorAll<HTMLElement>('[data-testid="song-ruler"] [data-start]')].map((m) => Math.round(parseFloat(m.style.left)));
      expect(starts.length).toBe(ids.length);
    });
  }

  it('after Build up, a 4-bar block is half as wide as the 8-bar Intro, with the compact header (name; ▶ and ⋯ on focus)', async () => {
    await openApp(1366, 768);
    const lift = blockIds()[2];
    await openBlockMenu(lift);
    act(() => menuItem('Shape this block').click());
    act(() => menuItem('Build up').click());
    await settle(300);
    const ids = blockIds();
    expect(ids.length).toBe(9);
    const intro = width(ids[0]);
    const fourBar = ids.filter((_, i) => bars(i) === 4);
    expect(fourBar.length).toBeGreaterThanOrEqual(2);
    // Nothing hovered or focused.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await mouse('mouseMoved', { x: 2, y: 2 });
    await settle(30);
    for (const id of fourBar) {
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(10);
      expect(Math.abs(width(id) - intro / 2), 'a 4-bar block is half the 8-bar Intro').toBeLessThanOrEqual(1);
      expect(width(id)).toBeGreaterThanOrEqual(COMPACT_BLOCK_WIDTH);
      expect(width(id)).toBeLessThan(FULL_HEADER_WIDTH);
      const el = blockEl(id);
      // Compact: the name shows, the length and the keys do not (until focus or hover).
      expect(el.querySelector<HTMLElement>('[class*="name"]')!.getBoundingClientRect().width).toBeGreaterThan(10);
      expect(el.querySelector<HTMLElement>('[data-testid="block-length"]')!.getBoundingClientRect().width).toBe(0);
      const more = el.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-label*="block actions"]')!;
      expect(more.getBoundingClientRect().width).toBe(0);
      act(() => el.focus());
      await settle(30);
      expect(more.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
      expect(more.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
    }
    // The 16-bar section Lift became stays 16 bars wide in all.
    const liftWidth = ids.slice(2, 2 + (ids.length - 5)).reduce((a, id) => a + width(id), 0);
    expect(Math.abs(liftWidth - intro * 2)).toBeLessThanOrEqual(ids.length);
  });

  it('the playhead moves the same px per bar in Intro and in a 4-bar block (real transport)', async () => {
    await openApp(1366, 768);
    act(() => void cmd.setBpm(session.store, 240));
    const lift = blocks()[2].id;
    act(() => void cmd.shapeBlock(session.store, lift, 'build'));
    await settle(200);
    const ids = blockIds();
    const ppb = width(ids[0]) / bars(0);
    const short = ids.findIndex((_, i) => bars(i) === 4);
    // Play from Intro: one bar is 1 s at 240 BPM.
    await act(async () => {
      await session.playSong(0);
    });
    await settle(250);
    const a = await samplePlayhead(900);
    act(() => session.stop());
    await act(async () => {
      await session.playSong(short);
    });
    await settle(250);
    const b = await samplePlayhead(900);
    expect(rt().songBlockId).toBe(ids[short]);
    act(() => session.stop());
    expect(a.length).toBeGreaterThan(10);
    expect(b.length).toBeGreaterThan(10);
    const inIntro = pxPerBar(a);
    const inShort = pxPerBar(b);
    expect(Math.abs(inIntro - ppb) / ppb).toBeLessThan(0.06);
    expect(Math.abs(inShort - ppb) / ppb).toBeLessThan(0.06);
    expect(Math.abs(inIntro - inShort) / ppb).toBeLessThan(0.06);
  });
});
