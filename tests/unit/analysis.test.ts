import { describe, expect, it } from 'vitest';
import {
  bandEnergy,
  crestFactor,
  detectOnsets,
  envelope,
  estimateFundamental,
  fft,
  isAllFinite,
  peak,
  rms,
  rmsDb,
  spectralCentroid,
} from '../../src/render/analysis';
import { Rng } from '../../src/project/rng';

const SR = 48000;

function sine(n: number, freq: number, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** Decaying 2 kHz clicks at the given sample positions, over low noise. */
function clickTrack(positions: number[], n: number, seed = 3): Float32Array {
  const rng = new Rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.noise() * 0.002;
  for (const p of positions) {
    for (let k = 0; k < 480 && p + k < n; k++) out[p + k] += 0.6 * Math.exp(-k / 80) * Math.sin((2 * Math.PI * 2000 * k) / SR + 0.3);
  }
  return out;
}

describe('level measurements', () => {
  it('peak, rms, dB and crest factor of a sine', () => {
    const s = sine(48000, 1000, 0.5);
    expect(peak(s)).toBeCloseTo(0.5, 3);
    expect(rms(s)).toBeCloseTo(0.5 / Math.SQRT2, 4);
    expect(rmsDb(s)).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 3);
    expect(crestFactor(s)).toBeCloseTo(Math.SQRT2, 3);
    expect(rmsDb(new Float32Array(10))).toBe(-Infinity);
    expect(crestFactor(new Float32Array(10))).toBe(0);
  });

  it('flags non-finite samples', () => {
    expect(isAllFinite(sine(100, 100))).toBe(true);
    const bad = sine(100, 100);
    bad[50] = Number.NaN;
    expect(isAllFinite(bad)).toBe(false);
  });

  it('envelope follows level per window', () => {
    const s = new Float32Array(300);
    s.fill(0.5, 100, 200);
    expect(Array.from(envelope(s, 100))).toEqual([0, 0.5, 0]);
    expect(envelope(s, 128)).toHaveLength(3);
  });
});

describe('detectOnsets', () => {
  it('finds synthetic clicks within 1 ms', () => {
    const positions = [2400, 12000, 12000 + 6000, 30017, 47999 + 9000];
    const n = 60000;
    const found = detectOnsets(clickTrack(positions, n), SR, { threshold: 0.02, minGapMs: 30 });
    expect(found).toHaveLength(positions.length);
    found.forEach((f, i) => expect(Math.abs(f - positions[i])).toBeLessThanOrEqual(SR / 1000));
  });

  it('finds single-sample impulses exactly', () => {
    const s = new Float32Array(20000);
    for (const p of [100, 5000, 5000 + 2400, 19000]) s[p] = 1;
    expect(detectOnsets(s, SR, { threshold: 0.05, minGapMs: 20 })).toEqual([100, 5000, 7400, 19000]);
  });

  it('respects the minimum gap and ignores signal below the threshold', () => {
    const s = clickTrack([1000, 1000 + 480, 10000], 20000);
    expect(detectOnsets(s, SR, { threshold: 0.02, minGapMs: 30 })).toHaveLength(2);
    expect(detectOnsets(clickTrack([], 20000), SR, { threshold: 0.02 })).toEqual([]);
  });
});

describe('spectrum', () => {
  it('fft of a pure bin sinusoid concentrates energy in that bin', () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    fft(re, im);
    expect(Math.hypot(re[5], im[5])).toBeCloseTo(n / 2, 9);
    expect(Math.hypot(re[59], im[59])).toBeCloseTo(n / 2, 9);
    for (let k = 0; k < n; k++) if (k !== 5 && k !== 59) expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-9);
  });

  it('spectral centroid orders dark and bright sounds', () => {
    const low = sine(16384, 200);
    const mid = sine(16384, 1500);
    const high = sine(16384, 6000);
    const cl = spectralCentroid(low, SR);
    const cm = spectralCentroid(mid, SR);
    const ch = spectralCentroid(high, SR);
    expect(cl).toBeLessThan(cm);
    expect(cm).toBeLessThan(ch);
    expect(cm).toBeGreaterThan(1200);
    expect(cm).toBeLessThan(1800);
    // White noise sits near the middle of the band.
    const rng = new Rng(9);
    const noise = Float32Array.from({ length: 16384 }, () => rng.noise());
    expect(spectralCentroid(noise, SR)).toBeGreaterThan(ch);
    expect(spectralCentroid(new Float32Array(1024), SR)).toBe(0);
  });

  it('band energy splits a two-tone signal and sums to the mean square', () => {
    const a = sine(32768, 300, 0.5);
    const b = sine(32768, 5000, 0.25);
    const s = a.map((v, i) => v + b[i]);
    const low = bandEnergy(s, SR, 100, 1000);
    const high = bandEnergy(s, SR, 3000, 8000);
    expect(low).toBeCloseTo(0.125, 2); // (0.5^2)/2
    expect(high).toBeCloseTo(0.03125, 3); // (0.25^2)/2
    expect(bandEnergy(s, SR, 0, SR / 2)).toBeCloseTo(rms(s) ** 2, 3);
    // Short signals (zero padded) keep the same scaling.
    const short = sine(700, 3000, 0.5);
    expect(bandEnergy(short, SR, 0, SR / 2)).toBeCloseTo(rms(short) ** 2, 2);
  });
});

describe('estimateFundamental', () => {
  it('finds the pitch of tones with harmonics within a few cents', () => {
    for (const f of [55, 110, 261.63, 440, 1318.5]) {
      const n = 8192;
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = (2 * Math.PI * f * i) / SR;
        s[i] = 0.6 * Math.sin(t) + 0.3 * Math.sin(2 * t + 0.4) + 0.15 * Math.sin(3 * t + 1);
      }
      const est = estimateFundamental(s, SR);
      expect(Math.abs(1200 * Math.log2(est / f))).toBeLessThan(5);
    }
  });

  it('returns 0 for noise and silence', () => {
    const rng = new Rng(4);
    expect(estimateFundamental(Float32Array.from({ length: 8192 }, () => rng.noise()), SR)).toBe(0);
    expect(estimateFundamental(new Float32Array(8192), SR)).toBe(0);
  });
});
