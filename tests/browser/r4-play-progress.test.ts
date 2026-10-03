/**
 * PLAY-11 / design-12 with the real Jump In and the audio clock:
 * - the playing pads and the playing scene's button show their place in the
 *   loop with a 3 px bar run by a browser animation (scaleX over the clip's
 *   length, in steps of a sixteenth), in line with what is heard; it moves
 *   while nothing is written to the pads per frame and it changes once a
 *   sixteenth, not every frame (M1: a bar that changed every frame would
 *   restyle the page every frame); Pause holds it, Stop takes it away;
 * - a pad tapped to start shows a beat countdown ("Next bar · 3") that counts
 *   down to the bar line;
 * - with reduced motion the progress moves once a beat;
 * - clip pads show a picture of their notes where there is room.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { TICKS_PER_BAR, TICKS_PER_BEAT, TICKS_PER_STEP } from '../../src/project/types';
import { reducedMotion } from './r4-uikit-input';
import { SIZES, clickEl, clipsOf, openApp, pad, setUp, tearDown, until } from './r4-play-helpers';
import { wait } from './ui-harness';

beforeEach(setUp);
afterEach(async () => {
  await reducedMotion(false);
  await tearDown();
});

/** A bar's animation (on the ::after of the pad's strip, or of the scene button). */
const barOf = (host: Element | null): Animation | null =>
  (host as HTMLElement | null)?.getAnimations({ subtree: true }).find((a) => (a.effect as KeyframeEffect | null)?.pseudoElement === '::after') ?? null;
/** Where the bar is in its loop (0..1), as drawn (after its easing), or null without one. */
const progressOf = (host: Element | null): number | null => {
  const p = barOf(host)?.effect?.getComputedTiming().progress;
  return p === undefined || p === null ? null : p;
};
/** Where the clip is in its loop by the audio clock, on the bars' grid (the sixteenth it is in). */
const heardOf = (trackId: string): number => {
  const ph = session.transport!.clipPhase(trackId)!;
  const pos = (((session.transport!.audibleTick() - ph.startTick) % ph.lengthTicks) + ph.lengthTicks) % ph.lengthTicks;
  const steps = Math.round(ph.lengthTicks / TICKS_PER_STEP);
  return Math.floor((pos / ph.lengthTicks) * steps) / steps;
};
const circular = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
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
      const strip = drums.querySelector<HTMLElement>('[class*="progress"]')!;
      const drawn = () => new DOMMatrixReadOnly(getComputedStyle(strip, '::after').transform).a;
      const a = progressOf(drums)!;
      const da = drawn();
      await frames(12);
      await act(async () => {
        await wait(150);
      });
      const b = progressOf(drums)!;
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      expect(b).not.toBe(a);
      // The fill is drawn at that place (scaleX), and it moved.
      expect(Math.abs(drawn() - b)).toBeLessThan(0.05);
      expect(drawn()).not.toBe(da);
      // It follows the audio clock: it shows the sixteenth that is heard, ((heard tick − loop start) mod length) / length.
      // (Sampled a few times: near a step a frame can be on either side of the clock read in the same task.)
      let best = 1;
      for (let i = 0; i < 8; i++) {
        best = Math.min(best, circular(progressOf(drums)!, heardOf('t1')));
        await frames(2);
      }
      expect(best).toBeLessThan(0.002);
      // The bar is drawn: the pad's progress strip is visible.
      expect(Number(getComputedStyle(strip).opacity)).toBeGreaterThan(0.9);
      // The lit scene button too.
      const lit = document.querySelector<HTMLElement>('button[data-scene][data-lit]')!;
      expect(lit).not.toBeNull();
      await until(() => progressOf(lit) !== null, 'progress on the playing scene');
      // Only sounding clips carry it.
      const carriers = [...document.querySelectorAll<HTMLElement>('[data-pad-cell] button[id^="pad-"]')].filter((p) => progressOf(p) !== null).map((p) => p.id);
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
    // It counts down.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]);
    // The spoken state stays plain.
    await until(() => runtimeStore.getState().tracks.t3?.playingSlot === next, 'the clip to start');
  });

  it('with reduced motion the progress moves once a beat', async () => {
    await reducedMotion(true);
    await openApp(1366, 768, { play: true });
    const slot = runtimeStore.getState().tracks.t1!.playingSlot!;
    const drums = pad('t1', slot);
    const bars = clipsOf('t1')[slot]!.bars;
    await until(() => progressOf(drums) !== null, 'the bar');
    const values = new Set<number>();
    const tick0 = session.transport!.audibleTick();
    const t0 = performance.now();
    while (performance.now() < t0 + 1500) {
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
    // At 124 BPM 1.5 s is about three beats: a few values, not one per frame. (Counted by the page's clock and by the
    // audio clock, whichever went further: a busy test machine can starve the audio clock and the bar follows it.)
    const beatsHeard = (session.transport!.audibleTick() - tick0) / TICKS_PER_BEAT;
    const beatsSeen = ((performance.now() - t0) / 1000) * (124 / 60);
    expect(values.size).toBeLessThanOrEqual(Math.ceil(Math.max(beatsHeard, beatsSeen)) + 2);
  });

  it('nothing is written to the pads or scene buttons per frame while playing, and the bars change once a sixteenth, not every frame (M1)', async () => {
    await openApp(1366, 768, { play: true });
    const slot = runtimeStore.getState().tracks.t1!.playingSlot!;
    await until(() => progressOf(pad('t1', slot)) !== null, 'the bars');
    await act(async () => {
      await wait(300);
    });
    const grid = document.querySelector<HTMLElement>('[aria-label^="Clip pads"]')!;
    let styleWrites = 0;
    const mo = new MutationObserver((ms) => {
      for (const m of ms) if (m.attributeName === 'style') styleWrites++;
    });
    mo.observe(grid, { subtree: true, attributes: true, attributeFilter: ['style'] });
    const a = progressOf(pad('t1', slot))!;
    // What each frame draws, for every bar on the page.
    const drawn = new Set<string>();
    let frameCount = 0;
    const tick0 = session.transport!.audibleTick();
    const start = performance.now();
    while (performance.now() < start + 1500) {
      await frames(1);
      frameCount++;
      const hosts = [...document.querySelectorAll<HTMLElement>('[data-pad-cell] button[id^="pad-"], button[data-scene]')].filter((h) => barOf(h));
      drawn.add(hosts.map((h) => progressOf(h)!.toFixed(4)).join(' '));
    }
    const secs = (performance.now() - start) / 1000;
    mo.disconnect();
    const b = progressOf(pad('t1', slot))!;
    // The bars moved over many frames, with (almost) no style writes: only a clip starting may write, never one a frame.
    expect(b).not.toBe(a);
    expect(frameCount).toBeGreaterThan(10);
    expect(styleWrites).toBeLessThanOrEqual(2);
    // They move together, once a sixteenth (124 BPM: about 8 a second), not once a frame: a running animation
    // restyles the page on every frame it changes. (Sixteenths counted by the page's clock and by the audio clock,
    // whichever went further: a busy test machine can starve the audio clock, and the bars follow it.)
    const sixteenths = Math.max((secs * 124 * 4) / 60, (session.transport!.audibleTick() - tick0) / TICKS_PER_STEP);
    expect(drawn.size).toBeLessThanOrEqual(Math.ceil(sixteenths) + 3);
    // Each bar is a transform of the strip's ::after (not a custom property), stepped on the sixteenth grid.
    const anim = barOf(pad('t1', slot))!;
    const effect = anim.effect as KeyframeEffect;
    expect(effect.getKeyframes().map((k) => k.transform)).toEqual(['scaleX(0)', 'scaleX(1)']);
    const ticks = clipsOf('t1')[slot]!.bars * TICKS_PER_BAR;
    // (Chromium writes steps(n, end) as steps(n).)
    expect(effect.getTiming().easing).toMatch(new RegExp(`^steps\\(${ticks / TICKS_PER_STEP}(, ?end)?\\)$`));
    expect(anim.playState).toBe('running');
  });
});
