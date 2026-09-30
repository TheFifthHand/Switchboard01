import { describe, expect, it } from 'vitest';
import {
  Clock,
  MAX_SWING_TICKS,
  TempoMap,
  clampBpm,
  secondsToTicks,
  swingWarp,
  ticksToSeconds,
  unswingWarp,
} from '../../src/time/clock';

describe('tick / second conversion', () => {
  it('maps PPQ 96 ticks to beats at the given tempo', () => {
    expect(ticksToSeconds(96, 120)).toBeCloseTo(0.5, 12);
    expect(ticksToSeconds(384, 120)).toBeCloseTo(2, 12);
    expect(ticksToSeconds(24, 60)).toBeCloseTo(0.25, 12);
    expect(secondsToTicks(2, 120)).toBeCloseTo(384, 9);
    for (const bpm of [40, 97.5, 133, 220]) {
      for (const ticks of [0, 1, 23.5, 384, 10_000]) expect(secondsToTicks(ticksToSeconds(ticks, bpm), bpm)).toBeCloseTo(ticks, 9);
    }
  });

  it('clamps tempo to 40-220 BPM', () => {
    expect(clampBpm(10)).toBe(40);
    expect(clampBpm(500)).toBe(220);
    expect(clampBpm(Number.NaN)).toBe(120);
    expect(new TempoMap({ time: 0, tick: 0, bpm: 999 }).bpm).toBe(220);
  });
});

describe('TempoMap', () => {
  it('maps ticks and times through the anchor', () => {
    const c = new TempoMap({ time: 1.5, tick: -384, bpm: 120 });
    expect(c.timeAt(-384)).toBeCloseTo(1.5, 12);
    expect(c.timeAt(0)).toBeCloseTo(3.5, 12);
    expect(c.tickAt(3.5)).toBeCloseTo(0, 9);
    expect(c.tickAt(1.0)).toBeCloseTo(-480, 9);
  });

  it('a tempo change keeps earlier ticks at their times and re-times later ones', () => {
    const c = new Clock({ time: 0, tick: 0, bpm: 120 });
    const before = [0, 96, 192, 383].map((t) => c.timeAt(t));
    const anchor = c.reanchor(2, 60); // at tick 384
    expect(anchor.tick).toBeCloseTo(384, 9);
    expect([0, 96, 192, 383].map((t) => c.timeAt(t))).toEqual(before);
    expect(c.timeAt(384)).toBeCloseTo(2, 12);
    // 60 BPM: one beat per second after the change.
    expect(c.timeAt(480)).toBeCloseTo(3, 12);
    expect(c.tickAt(1)).toBeCloseTo(192, 9);
    expect(c.tickAt(4)).toBeCloseTo(576, 9);
    expect(c.bpmAtTick(100)).toBe(120);
    expect(c.bpmAtTick(400)).toBe(60);
  });

  it('is continuous and monotonic across several changes', () => {
    const c = new TempoMap({ time: 0, tick: 0, bpm: 90 });
    c.reanchor(1.3, 180);
    c.reanchor(2.1, 45);
    c.reanchor(3.7, 220);
    let prev = -Infinity;
    for (let t = 0; t < 6; t += 0.01) {
      const tick = c.tickAt(t);
      expect(tick).toBeGreaterThan(prev);
      expect(c.timeAt(tick)).toBeCloseTo(t, 9);
      prev = tick;
    }
    // Continuity at each change time.
    for (const t of [1.3, 2.1, 3.7]) expect(c.tickAt(t + 1e-9) - c.tickAt(t - 1e-9)).toBeLessThan(1e-6);
  });

  it('re-anchoring earlier replaces later segments; pruning keeps the mapping', () => {
    const c = new TempoMap({ time: 0, tick: 0, bpm: 120 });
    c.reanchor(4, 60);
    c.reanchor(2, 200);
    expect(c.segmentCount).toBe(2);
    // 200 BPM = 320 ticks per second after tick 384 (t = 2 s).
    expect(c.timeAt(384 + 192)).toBeCloseTo(2.6, 12);
    c.reanchor(5, 100);
    const t = c.timeAt(2000);
    c.prune(4.9);
    expect(c.segmentCount).toBe(2);
    expect(c.timeAt(2000)).toBeCloseTo(t, 12);
  });
});

describe('swing warp', () => {
  it('is the identity at swing 0 and on every 8th-note line', () => {
    for (let t = -96; t <= 384; t += 7) expect(swingWarp(t, 0)).toBe(t);
    for (const s of [0.25, 0.5, 1]) for (let t = -96; t <= 768; t += 48) expect(swingWarp(t, s)).toBeCloseTo(t, 9);
  });

  it('moves the off-beat 16th by swing x 8 ticks; swing 1 is the triplet position', () => {
    expect(MAX_SWING_TICKS).toBe(8);
    expect(swingWarp(24, 0.5)).toBeCloseTo(28, 12);
    expect(swingWarp(24 + 48 * 5, 0.25)).toBeCloseTo(24 + 48 * 5 + 2, 12);
    // Triplet shuffle: the off-beat 16th sits 2/3 of the way through the 8th note.
    expect(swingWarp(24, 1)).toBeCloseTo((48 * 2) / 3, 12);
    expect(swingWarp(24 - 384, 1)).toBeCloseTo(-384 + 32, 12);
  });

  it('is continuous, strictly increasing and only delays', () => {
    for (const s of [0.1, 0.5, 0.8, 1]) {
      let prev = -Infinity;
      for (let t = -100; t <= 500; t += 0.25) {
        const w = swingWarp(t, s);
        expect(w).toBeGreaterThan(prev);
        expect(w).toBeGreaterThanOrEqual(t - 1e-9);
        expect(w - t).toBeLessThanOrEqual(8 * s + 1e-9);
        // Continuity: a tiny step moves the result by a tiny amount.
        expect(swingWarp(t + 1e-7, s) - w).toBeLessThan(1e-6);
        prev = w;
      }
    }
  });

  it('unswingWarp inverts swingWarp', () => {
    for (const s of [0, 0.3, 1]) for (let t = -50; t < 400; t += 3.3) expect(unswingWarp(swingWarp(t, s), s)).toBeCloseTo(t, 9);
  });

  it('timeAtSwung = timeAt(swingWarp(tick))', () => {
    const c = new TempoMap({ time: 10, tick: 0, bpm: 120 });
    expect(c.timeAtSwung(24, 1)).toBeCloseTo(10 + 32 / 192, 12);
    expect(c.timeAtSwung(48, 1)).toBeCloseTo(10 + 48 / 192, 12);
  });
});
