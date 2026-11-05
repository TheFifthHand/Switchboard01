/**
 * The Steps playhead uses the audible position (PLAY-20), with the real Jump In: with the
 * device's output latency stubbed at 0.4 s, the lit step is the one heard (the transport's
 * audibleTick), about three steps behind what is scheduled (getPosition).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { TICKS_PER_BAR, TICKS_PER_STEP } from '../../src/project/types';
import { setStepsFollow } from '../../src/state/uiStore';
import { setUp, tearDown } from './r4-play-helpers';
import { settleFrames } from './r4-uikit-input';
import { CHORDS, openSteps, page } from './r4-steps-helpers';

const LATENCY = 0.4;
let restore: (() => void) | null = null;

beforeEach(setUp);
afterEach(async () => {
  restore?.();
  restore = null;
  act(() => setStepsFollow(false));
  await tearDown();
});

const mod = (v: number, n: number) => ((v % n) + n) % n;

/** Step (0..15) and bar of the edited clip at transport tick `tick`. */
function stepAt(tick: number): { bar: number; step: number } {
  const ph = session.transport!.clipPhase(CHORDS)!;
  const rel = mod(tick - ph.startTick, ph.lengthTicks);
  return { bar: Math.floor(rel / TICKS_PER_BAR), step: Math.floor((rel % TICKS_PER_BAR) / TICKS_PER_STEP) };
}

/** Steps between two (with the wrap of a bar). */
const apart = (a: number, b: number) => Math.min(mod(a - b, 16), mod(b - a, 16));

describe('playhead (PLAY-20)', () => {
  it('lights the step that is heard (output latency taken off), not the one scheduled', async () => {
    await openSteps(CHORDS, 1, { play: true });
    const ctx = session.ctx!;
    Object.defineProperty(ctx, 'outputLatency', { configurable: true, get: () => LATENCY });
    restore = () => delete (ctx as unknown as { outputLatency?: number }).outputLatency;
    // Follow keeps the heard bar on screen, so its step lights.
    act(() => setStepsFollow(true));
    // The transport looks the latency up twice a second.
    await new Promise((r) => setTimeout(r, 700));
    expect(session.transport!.outputDelay()).toBeGreaterThanOrEqual(LATENCY);

    let samples = 0;
    let heard = 0;
    let scheduled = 0;
    const end = performance.now() + 2500;
    while (performance.now() < end) {
      await settleFrames(1);
      const lit = document.querySelector<HTMLElement>('[data-cells] [data-ph-step][data-playhead]');
      if (!lit) continue;
      const t = session.transport!;
      const a = stepAt(t.audibleTick());
      const s = stepAt(t.getPosition().tick);
      if (a.bar !== page(CHORDS)) continue;
      const step = Number(lit.dataset.phStep);
      samples++;
      if (apart(step, a.step) <= 1) heard++;
      if (apart(step, s.step) >= 2) scheduled++;
    }
    expect(samples).toBeGreaterThan(20);
    // 0.4 s at 124 BPM is about 3.3 steps: the light sits on the heard step, well behind the scheduled one.
    expect(heard / samples).toBeGreaterThan(0.85);
    expect(scheduled / samples).toBeGreaterThan(0.85);
  });
});
