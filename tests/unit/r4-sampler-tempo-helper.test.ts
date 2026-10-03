/**
 * shape-06: the sampler's tempo helper suggests a whole loop length (1, 2,
 * 4 or 8 bars) whose tempo lies in 70-180 BPM, the one nearest the project
 * tempo, with the recording's hits as the tiebreak; its arrow keys step
 * through 1/2/4/8 bars. Also the pure zoom and snap arithmetic the waveform
 * uses (shape-14).
 */
import { describe, expect, it } from 'vitest';
import {
  BAR_STEPS,
  FULL_VIEW,
  barsToBpm,
  formatBpm,
  gridMisfit,
  minViewSpan,
  nearestWithin,
  panView,
  placeView,
  revealInView,
  snapToGrid,
  stepBars,
  suggestedBars,
  suggestionNeedsHits,
  zoomView,
} from '../../src/app/views/sampler/samplerMath';

/** What the helper's key reads for a region: "Set 100 BPM". */
const setLabel = (bars: number, seconds: number) => `Set ${formatBpm(barsToBpm(bars, seconds))}`;

describe('tempo helper: the suggested loop length (shape-06)', () => {
  it('a 4.8 s region (a 2-bar loop at 100 BPM, trimmed 0.300–5.100 s) gives 2 bars → "Set 100 BPM"', () => {
    // The finding: at the House project's 124 BPM, with Original BPM 120 left over from Vocal "Oh".
    const bars = suggestedBars(4.8, 124, { originalBpm: 120 });
    expect(bars).toBe(2);
    expect(setLabel(bars, 4.8)).toBe('Set 100 BPM');
    // Not the old half-bar rounding (2.5 bars → 125 BPM), whatever the Original BPM or project tempo.
    expect(suggestedBars(4.8, 124)).toBe(2);
    expect(suggestedBars(4.8, 124, { originalBpm: 124 })).toBe(2);
    expect(suggestedBars(4.8, 90)).toBe(2);
  });

  it('only 1, 2, 4 or 8 bars whose tempo is 70–180 BPM; the one nearest the project tempo', () => {
    // 8 s: 2 bars = 60 (out), 4 bars = 120, 8 bars = 240 (out).
    expect(suggestedBars(8, 124)).toBe(4);
    // 6 s: 2 bars = 80, 4 bars = 160. Nearer 90 → 2 bars; nearer 150 → 4 bars.
    expect(suggestedBars(6, 90)).toBe(2);
    expect(suggestedBars(6, 150)).toBe(4);
    // 2.5 s (the built-in glass chord): 1 bar = 96 BPM.
    expect(suggestedBars(2.5, 124)).toBe(1);
    // 16 s: 8 bars = 120.
    expect(suggestedBars(16, 128)).toBe(8);
    for (const s of [1.4, 2, 3.3, 4.8, 7.7, 12, 20]) {
      const b = suggestedBars(s, 124);
      expect([1, 2, 4, 8], `${s} s`).toContain(b);
      const bpm = barsToBpm(b, s);
      expect(bpm, `${s} s`).toBeGreaterThanOrEqual(70);
      expect(bpm, `${s} s`).toBeLessThanOrEqual(180);
    }
  });

  it('an Original BPM that already makes the region whole bars (a recorded take) is kept', () => {
    // A 2-bar take recorded at 150 BPM: 3.2 s. Without it the suggestion would be 1 bar (75 BPM is nearer 90).
    expect(suggestedBars(3.2, 90)).toBe(1);
    expect(suggestedBars(3.2, 90, { originalBpm: 150 })).toBe(2);
  });

  it('two lengths about as near the project tempo: the hits settle it; without hits, the nearer one', () => {
    // 5.5 s: 2 bars = 87.3 BPM, 4 bars = 174.5 BPM; the project's 124 lies almost exactly between (in octaves).
    expect(suggestionNeedsHits(5.5, 124)).toBe(true);
    expect(suggestionNeedsHits(4.8, 124)).toBe(false);
    const plain = suggestedBars(5.5, 124);
    // Hits on the 16th grid of 174.5 BPM that fall between the 16ths of 87.3 BPM: 4 bars.
    const fast = 60 / 174.5 / 4;
    const hits = [1, 3, 5, 9, 11, 13, 17, 19].map((k) => k * fast);
    expect(gridMisfit(hits, 174.5)).toBeLessThan(0.01);
    expect(gridMisfit(hits, 87.3)).toBeGreaterThan(0.4);
    expect(suggestedBars(5.5, 124, { onsets: hits })).toBe(4);
    // Hits on the coarse grid fit both: the nearer tempo stays.
    const slow = 60 / 87.27 / 4;
    expect(suggestedBars(5.5, 124, { onsets: [0, 2, 4, 6, 8].map((k) => k * slow) })).toBe(plain);
  });

  it('a short hit no loop length fits gets the quarter-bar count nearest the Original BPM', () => {
    // 0.5 s: 1 bar would be 480 BPM.
    expect(suggestedBars(0.5, 124, { originalBpm: 120 })).toBe(0.25);
    expect(suggestedBars(0, 124)).toBe(1);
  });

  it('the bars field steps through 1, 2, 4, 8 (and their halves and doubles) from a whole-bar start', () => {
    expect(BAR_STEPS).toEqual([0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]);
    expect(stepBars(2, 1)).toBe(4);
    expect(stepBars(4, 1)).toBe(8);
    expect(stepBars(2, -1)).toBe(1);
    expect(stepBars(1, -1)).toBe(0.5);
    // From a typed length, to the next whole loop length that way.
    expect(stepBars(2.5, 1)).toBe(4);
    expect(stepBars(2.5, -1)).toBe(2);
    expect(stepBars(64, 1)).toBe(64);
    expect(stepBars(0.25, -1)).toBe(0.25);
  });
});

describe('waveform zoom and snap arithmetic (shape-14)', () => {
  it('zooms around a point, never past the file or the closest zoom', () => {
    const v = zoomView(FULL_VIEW, 4, 0.5, 10);
    expect(v.a).toBeCloseTo(0.375, 9);
    expect(v.b).toBeCloseTo(0.625, 9);
    // The point under the pointer stays where it is on screen.
    const at = 0.4;
    const w = zoomView(v, 2, at, 10);
    expect((at - w.a) / (w.b - w.a)).toBeCloseTo((at - v.a) / (v.b - v.a), 9);
    // Zooming out past the whole file shows the whole file.
    expect(zoomView(v, 1 / 64, 0.5, 10)).toEqual({ a: 0, b: 1 });
    // At most 40 ms across for a 10 s file.
    const close = zoomView(FULL_VIEW, 1e6, 0.5, 10);
    expect(close.b - close.a).toBeCloseTo(minViewSpan(10), 12);
    expect((close.b - close.a) * 10).toBeCloseTo(0.04, 9);
    // Near the end the window stays inside the file.
    const end = zoomView(FULL_VIEW, 8, 0.99, 10);
    expect(end.b).toBeLessThanOrEqual(1);
    expect(end.b - end.a).toBeCloseTo(0.125, 9);
  });

  it('pans inside the file and reveals a point that left the view', () => {
    const v = placeView(0.2, 0.5, 0.5, 10);
    expect(panView(v, 1)).toEqual({ a: expect.closeTo(0.8, 9), b: expect.closeTo(1, 9) });
    expect(panView(v, -1)).toEqual({ a: 0, b: expect.closeTo(0.2, 9) });
    expect(revealInView(v, 0.5)).toBe(v);
    const r = revealInView(v, 0.75);
    expect(r.b).toBeGreaterThan(0.75);
    expect(r.b - r.a).toBeCloseTo(0.2, 9);
  });

  it('snaps to the nearest hit within reach, and to whole beats from an anchor', () => {
    expect(nearestWithin(0.31, [0.1, 0.3, 0.5], 0.02)).toBe(0.3);
    expect(nearestWithin(0.35, [0.1, 0.3, 0.5], 0.02)).toBeNull();
    expect(snapToGrid(0.33, 0.1, 0.1)).toBeCloseTo(0.3, 9);
    expect(snapToGrid(0.37, 0.1, 0.1)).toBeCloseTo(0.4, 9);
  });
});
