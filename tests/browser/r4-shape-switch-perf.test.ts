/**
 * shape-18: switching parts in Advanced Shape is about as quick as in Simple.
 *
 * The columns are no longer remounted per part (they re-render with the new
 * part). Measured with the browser's Event Timing API (input to the next
 * paint) for real clicks on the part buttons, with the House starter playing:
 * the median Advanced switch takes at most 1.5 times the median Simple one.
 * The machine may be busy, so the two modes are measured interleaved: each
 * switch (from one part to the next) is clicked once in Simple and once in
 * Advanced, one right after the other, and the ratio of medians is compared.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { selectTrack, setUiMode, setView } from '../../src/state/uiStore';
import { openApp, setUp, tearDown } from './r4-play-helpers';
import { centre, click, settleFrames } from './r4-uikit-input';

beforeEach(setUp);
afterEach(tearDown);

const ORDER = ['t1', 't3', 't4', 't8', 't2', 't6', 't5', 't7'];

/** Event Timing duration of one real click on a part button (16 ms when the browser reports nothing: below its threshold). */
async function switchTime(id: string): Promise<number> {
  const el = document.getElementById(`shape-part-${id}`)!;
  const seen: number[] = [];
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceEventTiming[]) if (['pointerdown', 'pointerup', 'click', 'mousedown', 'mouseup'].includes(e.name)) seen.push(e.duration);
  });
  po.observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  await click(centre(el));
  await settleFrames(3);
  await new Promise((r) => setTimeout(r, 120));
  for (const e of po.takeRecords() as PerformanceEventTiming[]) if (['pointerdown', 'pointerup', 'click', 'mousedown', 'mouseup'].includes(e.name)) seen.push(e.duration);
  po.disconnect();
  return seen.length ? Math.max(...seen) : 16;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

describe('part switches: Advanced is about as quick as Simple (Event Timing, music playing)', () => {
  for (const [w, h] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`${w} × ${h}: median Advanced ≤ 1.5 × median Simple`, async () => {
      await openApp(w, h, { play: true });
      act(() => setView('shape'));
      await settleFrames(4);
      const simple: number[] = [];
      const advanced: number[] = [];
      // Round 0 warms up (first mounts of each instrument's controls) and is not counted.
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < ORDER.length; i++) {
          const from = ORDER[i];
          const to = ORDER[(i + 1) % ORDER.length];
          for (const [mode, out] of [
            ['simple', simple],
            ['advanced', advanced],
          ] as const) {
            act(() => {
              selectTrack(from);
              setUiMode(mode);
            });
            await settleFrames(4);
            await new Promise((r) => setTimeout(r, 60));
            const t = await switchTime(to);
            if (round > 0) out.push(t);
          }
        }
      }
      const s = median(simple);
      const a = median(advanced);
      console.info(`[switch-perf] ${w}x${h}: Simple median ${s.toFixed(0)} ms (max ${Math.max(...simple).toFixed(0)}), Advanced median ${a.toFixed(0)} ms (max ${Math.max(...advanced).toFixed(0)}), ratio ${(a / s).toFixed(2)}`);
      expect(a, `Simple ${simple.map((x) => x.toFixed(0)).join(' ')} | Advanced ${advanced.map((x) => x.toFixed(0)).join(' ')}`).toBeLessThanOrEqual(1.5 * s);
      // 48 measured clicks with the music playing: several minutes on a busy machine.
    }, 600_000);
  }
});
