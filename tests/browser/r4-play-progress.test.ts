/**
 * PLAY-11 / design-12 with the real Jump In and the audio clock:
 * - the playing pads and the playing scene's button carry --loop-progress
 *   (0..1), which advances between frames while the music plays, and the
 *   pad's 3 px bar shows it; Pause holds it, Stop takes it away;
 * - a pad tapped to start shows a beat countdown ("Next bar · 3") that counts
 *   down to the bar line;
 * - with reduced motion the progress moves once a beat;
 * - clip pads show a picture of their notes where there is room.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { TICKS_PER_BAR, TICKS_PER_BEAT } from '../../src/project/types';
import { reducedMotion } from './r4-uikit-input';
import { SIZES, clickEl, clipsOf, openApp, pad, setUp, tearDown, until } from './r4-play-helpers';
import { wait } from './ui-harness';

beforeEach(setUp);
afterEach(async () => {
  await reducedMotion(false);
  await tearDown();
});

const progressOf = (el: Element | null) => {
  const v = (el as HTMLElement | null)?.style.getPropertyValue('--loop-progress') ?? '';
  return v === '' ? null : Number(v);
};
const frames = (n: number) =>
  act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  });

describe('loop progress (PLAY-11, design-12)', () => {
  for (const s of SIZES) {
    it(`at ${s.name}: playing pads and the playing scene show their place in the loop, and it advances between frames`, async () => {
      await openApp(s.w, s.h, { play: true });
      const slot = runtimeStore.getState().tracks.t1!.playingSlot!;
      const drums = pad('t1', slot);
      await until(() => progressOf(drums) !== null, 'progress on the playing pad');
      const a = progressOf(drums)!;
      await frames(12);
      await act(async () => {
        await wait(150);
      });
      const b = progressOf(drums)!;
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      expect(b).not.toBe(a);
      // It follows the audio clock: ((heard tick − loop start) mod length) / length.
      const ph = session.transport!.clipPhase('t1')!;
      const expected = ((((session.transport!.audibleTick() - ph.startTick) % ph.lengthTicks) + ph.lengthTicks) % ph.lengthTicks) / ph.lengthTicks;
      const now = progressOf(drums)!;
      const d = Math.abs(now - expected);
      expect(Math.min(d, 1 - d)).toBeLessThan(0.08);
      // The bar is drawn: the pad's progress strip is visible.
      const strip = drums.querySelector<HTMLElement>('[class*="progress"]')!;
      expect(Number(getComputedStyle(strip).opacity)).toBeGreaterThan(0.9);
      // The lit scene button too.
      const lit = document.querySelector<HTMLElement>('button[data-scene][data-lit]')!;
      expect(lit).not.toBeNull();
      await until(() => progressOf(lit) !== null, 'progress on the playing scene');
      // Only sounding clips carry it.
      const carriers = [...document.querySelectorAll<HTMLElement>('[data-pad-cell] button')].filter((p) => progressOf(p) !== null).map((p) => p.id);
      const sounding = Object.entries(runtimeStore.getState().tracks)
        .filter(([, t]) => t?.playingSlot != null)
        .map(([id, t]) => `pad-${id}-${t!.playingSlot}`);
      expect(carriers.sort()).toEqual(sounding.sort());
      // A clip pad with room shows a picture of its notes.
      if (s.w === 1920) expect(drums.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

      // Pause holds it; Stop takes it away.
      act(() => session.pause());
      await frames(3);
      const held = progressOf(drums);
      await act(async () => {
        await wait(200);
      });
      expect(progressOf(drums)).toBe(held);
      act(() => session.stop());
      await frames(3);
      expect([...document.querySelectorAll<HTMLElement>('[data-pad-cell] button, button[data-scene]')].some((p) => progressOf(p) !== null)).toBe(false);
    });
  }

  it('a pad tapped to start counts down the beats to the bar line ("Next bar · 3")', async () => {
    await openApp(1366, 768, { play: true });
    const playing = runtimeStore.getState().tracks.t3!.playingSlot!;
    const next = clipsOf('t3').findIndex((c, i) => !!c && i !== playing);
    await clickEl(pad('t3', next));
    await until(() => runtimeStore.getState().tracks.t3?.queued?.slot === next, 'the tap to queue');
    const seen: number[] = [];
    const end = performance.now() + 2 * ((60 / 124) * 4 * 1000);
    while (performance.now() < end && runtimeStore.getState().tracks.t3?.playingSlot !== next) {
      const m = /^Next bar · (\d)$/.exec(pad('t3', next).querySelector('[class*="caption"]')?.textContent ?? '');
      if (m && seen.at(-1) !== Number(m[1])) seen.push(Number(m[1]));
      await act(async () => {
        await wait(40);
      });
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const n of seen) expect(n).toBeGreaterThanOrEqual(1);
    for (const n of seen) expect(n).toBeLessThanOrEqual(4);
    // It counts down, one beat at a time.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1] - 1);
    // The spoken state stays plain.
    await until(() => runtimeStore.getState().tracks.t3?.playingSlot === next, 'the clip to start');
  });

  it('with reduced motion the progress moves once a beat', async () => {
    await reducedMotion(true);
    await openApp(1366, 768, { play: true });
    const slot = runtimeStore.getState().tracks.t1!.playingSlot!;
    const drums = pad('t1', slot);
    const bars = clipsOf('t1')[slot]!.bars;
    const values = new Set<number>();
    const end = performance.now() + 1500;
    while (performance.now() < end) {
      const v = progressOf(drums);
      if (v !== null) values.add(v);
      await frames(1);
    }
    expect(values.size).toBeGreaterThan(0);
    const ticks = bars * TICKS_PER_BAR;
    for (const v of values) {
      const beats = (v * ticks) / TICKS_PER_BEAT;
      expect(Math.abs(beats - Math.round(beats)), `${v}`).toBeLessThan(0.01);
    }
    // At 124 BPM 1.5 s is about three beats: a few values, not one per frame.
    expect(values.size).toBeLessThanOrEqual(5);
  });
});
