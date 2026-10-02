/**
 * The idle-time work queue behind incremental instrument preparation: work
 * runs in slices of at most IDLE_SLICE_MS (each slice does at least one
 * unit, so it always progresses), tasks finish in the order they were
 * queued, and each task's promise resolves when it reports nothing left.
 */
import { describe, expect, it } from 'vitest';
import { IDLE_SLICE_MS, idleStats, runWhenIdle } from '../../src/audio/idle';

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* work */
  }
}

describe('idle work queue', () => {
  it('runs units in slices of at most the budget and resolves each task when done, in order', async () => {
    const slices0 = idleStats().slices;
    const done: string[] = [];
    let a = 6;
    let b = 3;
    const pa = runWhenIdle(() => {
      busy(3);
      return --a > 0;
    }).then(() => done.push('a'));
    const pb = runWhenIdle(() => {
      busy(3);
      return --b > 0;
    }).then(() => done.push('b'));
    await Promise.all([pa, pb]);
    expect(done).toEqual(['a', 'b']);
    expect(a).toBe(0);
    expect(b).toBe(0);
    // 9 units of 3 ms in slices of at most 8 ms: at least 3 slices (at most 3 units each).
    expect(idleStats().slices - slices0).toBeGreaterThanOrEqual(Math.ceil(9 / Math.floor(IDLE_SLICE_MS / 3 + 1)));
    expect(idleStats().queued).toBe(0);
  });

  it('a unit longer than the budget still runs, one per slice; a throwing task ends without stopping others', async () => {
    let long = 2;
    const order: string[] = [];
    const p1 = runWhenIdle(() => {
      busy(IDLE_SLICE_MS + 2);
      order.push('long');
      return --long > 0;
    });
    const p2 = runWhenIdle(() => {
      throw new Error('broken unit');
    });
    const p3 = runWhenIdle(() => {
      order.push('after');
      return false;
    });
    const errors = console.error;
    console.error = () => undefined;
    try {
      await Promise.all([p1, p2, p3]);
    } finally {
      console.error = errors;
    }
    expect(order).toEqual(['long', 'long', 'after']);
  });
});
