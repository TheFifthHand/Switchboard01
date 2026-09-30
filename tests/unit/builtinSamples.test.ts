/**
 * Built-in samples: every catalogue id renders finite, non-silent,
 * deterministic stereo audio of the expected length at -3 dBFS that ends in
 * silence, and each one has the character its name promises (measured).
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PEAK,
  generateBuiltinSample,
  getBuiltinSample,
  listBuiltinSampleIds,
  type GeneratedSample,
} from '../../src/audio/instruments/builtinSamples';
import { Biquad, fractionAbove, peakAbs, powerSpectrum, rms, spectralCentroid, zeroCrossingFrequency } from '../../src/audio/dsp';
import { BUILTIN_SAMPLES } from '../../src/content/catalog';

const SR = 48000;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

const cache = new Map<string, GeneratedSample>();
function sample(id: string): GeneratedSample {
  let s = cache.get(id);
  if (!s) {
    const g = generateBuiltinSample(id, SR);
    if (!g) throw new Error(`no sample ${id}`);
    s = g;
    cache.set(id, s);
  }
  return s;
}
const mid = (s: GeneratedSample) => s.channels[0].map((v, i) => 0.5 * (v + s.channels[1][i]));
const sec = (t: number) => Math.round(t * SR);

/** Linear amplitude of a sinusoid at `freq` in x[from, to) (Hann-windowed single DFT bin). */
function toneAmp(x: Float32Array, freq: number, from: number, to: number): number {
  let re = 0;
  let im = 0;
  let wsum = 0;
  const n = to - from;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const ph = (2 * Math.PI * freq * i) / SR;
    re += x[from + i] * w * Math.cos(ph);
    im -= x[from + i] * w * Math.sin(ph);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

/** Autocorrelation pitch estimate within [lo, hi] Hz. */
function acfPitch(x: Float32Array, from: number, to: number, lo: number, hi: number): number {
  const minLag = Math.floor(SR / hi);
  const maxLag = Math.ceil(SR / lo);
  let best = minLag;
  let bestV = -Infinity;
  const vals: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = from; i < to - lag; i++) s += x[i] * x[i + lag];
    vals[lag] = s;
    if (s > bestV) {
      bestV = s;
      best = lag;
    }
  }
  const l = vals[best - 1] ?? bestV;
  const r = vals[best + 1] ?? bestV;
  const d = l - 2 * bestV + r;
  const off = d !== 0 ? (0.5 * (l - r)) / d : 0;
  return SR / (best + off);
}

describe('built-in sample catalogue', () => {
  it('lists every catalogue id and nothing else', () => {
    expect(listBuiltinSampleIds().sort()).toEqual(BUILTIN_SAMPLES.map((s) => s.id).sort());
  });

  it('returns null for unknown ids', () => {
    expect(generateBuiltinSample('builtin:nope', SR)).toBeNull();
    expect(generateBuiltinSample('constructor', SR)).toBeNull();
  });
});

describe.each(listBuiltinSampleIds())('%s', (id) => {
  it('is finite, stereo, -3 dBFS, audible and ends in silence', () => {
    const s = sample(id);
    expect(s.sampleRate).toBe(SR);
    expect(s.channels).toHaveLength(2);
    const [L, R] = s.channels;
    expect(L.length).toBe(R.length);
    for (const c of s.channels) {
      expect(c.every(Number.isFinite)).toBe(true);
      expect(c[0]).toBe(0);
      expect(c[c.length - 1]).toBe(0);
      // The final millisecond is essentially silent.
      expect(db(rms(c, c.length - sec(0.001)) / BUILTIN_PEAK)).toBeLessThan(-40);
      expect(rms(c)).toBeGreaterThan(0.005);
    }
    expect(Math.max(peakAbs(L), peakAbs(R))).toBeCloseTo(BUILTIN_PEAK, 5);
  });

  it('is deterministic and scales with the sample rate', () => {
    const again = generateBuiltinSample(id, SR)!;
    expect(Array.from(again.channels[0])).toEqual(Array.from(sample(id).channels[0]));
    expect(Array.from(again.channels[1])).toEqual(Array.from(sample(id).channels[1]));
    const s44 = generateBuiltinSample(id, 44100)!;
    expect(s44.sampleRate).toBe(44100);
    expect(s44.channels[0].length / 44100).toBeCloseTo(sample(id).channels[0].length / SR, 2);
  });
});

describe('sample character', () => {
  it('have the expected durations (the riser is exactly two seconds)', () => {
    const d = (id: string) => sample(id).channels[0].length / SR;
    expect(d('builtin:glass-chord')).toBeCloseTo(2.5, 1);
    expect(d('builtin:tape-swell')).toBeCloseTo(2.0, 1);
    expect(d('builtin:bell-hit')).toBeCloseTo(3.0, 1);
    expect(d('builtin:vocal-oh')).toBeCloseTo(1.0, 1);
    expect(sample('builtin:noise-riser').channels[0].length).toBe(2 * SR);
    expect(generateBuiltinSample('builtin:noise-riser', 44100)!.channels[0].length).toBe(88200);
  });

  it('glass chord: a C minor 7 hit with a soft attack that decays', () => {
    const x = mid(sample('builtin:glass-chord'));
    const a = sec(0.05);
    const b = sec(0.45);
    // Chord tones C4 Eb4 G4 Bb4 clearly present, a non-chord tone (E4) absent.
    const e4 = toneAmp(x, 329.63, a, b);
    for (const f of [261.63, 311.13, 392.0, 466.16]) expect(db(toneAmp(x, f, a, b) / e4), `${f} Hz`).toBeGreaterThan(20);
    // Soft attack: the loudest point is not in the first 5 ms, and it rises without a step.
    let pi = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[pi])) pi = i;
    expect(pi).toBeGreaterThan(sec(0.005));
    expect(rms(x, 0, sec(0.002))).toBeLessThan(rms(x, sec(0.02), sec(0.03)) * 0.3);
    // Decays: last half second far below the first.
    expect(db(rms(x, sec(2.0), sec(2.5)) / rms(x, 0, sec(0.5)))).toBeLessThan(-30);
    // Bell-like brightness: the inharmonic 2.76 partial of C4 rings early on, and there is real energy above 2 kHz.
    const early = [sec(0.02), sec(0.3)] as const;
    expect(db(toneAmp(x, 261.63 * 2.76, ...early) / toneAmp(x, 261.63, ...early))).toBeGreaterThan(-25);
    expect(fractionAbove(powerSpectrum(x, SR, 4096, 0, sec(0.3)), 2000)).toBeGreaterThan(0.001);
  });

  it('tape swell: rises into its end with a gently drifting pitch', () => {
    const s = sample('builtin:tape-swell');
    const x = mid(s);
    expect(db(rms(x, sec(1.5), sec(1.95)) / rms(x, 0, sec(0.45)))).toBeGreaterThan(20);
    // Isolate the lowest note (C3) and track its frequency in 100 ms windows.
    const y = x.slice();
    const bp = new Biquad('bandpass', 130.81, 8, SR);
    bp.processBuffer(y);
    const freqs: number[] = [];
    for (let t = 0.9; t < 1.9; t += 0.1) freqs.push(zeroCrossingFrequency(y, SR, sec(t), sec(t + 0.1)));
    const mean = freqs.reduce((p, q) => p + q, 0) / freqs.length;
    expect(mean).toBeGreaterThan(130.81 * 0.98);
    expect(mean).toBeLessThan(130.81 * 1.02);
    const spreadCents = 1200 * Math.log2(Math.max(...freqs) / Math.min(...freqs));
    expect(spreadCents).toBeGreaterThan(3);
    expect(spreadCents).toBeLessThan(60);
    // Stereo but mono-compatible.
    const [L, R] = s.channels;
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < L.length; i++) {
      lr += L[i] * R[i];
      ll += L[i] * L[i];
      rr += R[i] * R[i];
    }
    const corr = lr / Math.sqrt(ll * rr);
    expect(corr).toBeGreaterThan(0.3);
    expect(corr).toBeLessThan(0.999);
  });

  it('bell hit: inharmonic partials around a C4 strike note and a long tail', () => {
    const x = mid(sample('builtin:bell-hit'));
    const a = sec(0.05);
    const b = sec(1.05);
    const prime = toneAmp(x, 261.63, a, b);
    // Hum (0.5), minor-third tierce (1.183) and nominal (2.0) are all present...
    for (const r of [0.5, 1.183, 2.0]) expect(db(toneAmp(x, 261.63 * r, a, b) / prime), `ratio ${r}`).toBeGreaterThan(-20);
    // ...while a harmonic that a plain tone would have (3rd harmonic, 784.9 Hz) is not.
    expect(db(toneAmp(x, 784.9, a, b) / prime)).toBeLessThan(-20);
    expect(db(rms(x, sec(2.0), sec(2.5)) / rms(x, 0, sec(0.5)))).toBeGreaterThan(-45);
  });

  it('noise riser: level and brightness both rise across the two seconds', () => {
    const s = sample('builtin:noise-riser');
    const x = mid(s);
    expect(db(rms(x, sec(1.5), sec(1.98)) / rms(x, 0, sec(0.5)))).toBeGreaterThan(15);
    const c0 = spectralCentroid(powerSpectrum(x, SR, 2048, 0, sec(0.4)));
    const c1 = spectralCentroid(powerSpectrum(x, SR, 2048, sec(1.6), sec(1.98)));
    expect(c1).toBeGreaterThan(c0 * 4);
    // Wide: the two sides are independent noise.
    const [L, R] = s.channels;
    let lr = 0;
    for (let i = 0; i < L.length; i++) lr += L[i] * R[i];
    expect(Math.abs(lr) / Math.sqrt(rms(L) ** 2 * rms(R) ** 2 * L.length ** 2)).toBeLessThan(0.1);
  });

  it('vocal "oh": pitched at C4 with an "oh" formant shape', () => {
    const x = mid(sample('builtin:vocal-oh'));
    const f0 = acfPitch(x, sec(0.1), sec(0.3), 150, 500);
    expect(f0).toBeGreaterThan(261.63 * 0.99);
    expect(f0).toBeLessThan(261.63 * 1.01);
    // Formant regions (F1 ~450, F2 ~800) carry more energy than the valley between F2 and F3.
    const spec = powerSpectrum(x, SR, 8192, sec(0.1), sec(0.7));
    const band = (lo: number, hi: number) => {
      let e = 0;
      for (let k = 1; k < spec.power.length; k++) {
        const f = k * spec.binHz;
        if (f >= lo && f < hi) e += spec.power[k];
      }
      return e / (hi - lo);
    };
    const valley = band(1400, 2200);
    expect(db(band(380, 560) / valley) / 2).toBeGreaterThan(15);
    expect(db(band(700, 900) / valley) / 2).toBeGreaterThan(10);
    expect(db(band(2650, 3000) / valley) / 2).toBeGreaterThan(0);
    // Sustained body, then a release to silence.
    expect(db(rms(x, sec(0.3), sec(0.6)) / BUILTIN_PEAK)).toBeGreaterThan(-20);
    expect(db(rms(x, sec(0.95), sec(1.0)) / BUILTIN_PEAK)).toBeLessThan(-40);
  });

  it('getBuiltinSample memoises per id and rate', () => {
    const a = getBuiltinSample('builtin:bell-hit', SR);
    expect(getBuiltinSample('builtin:bell-hit', SR)).toBe(a);
    expect(getBuiltinSample('builtin:nope', SR)).toBeNull();
  });
});
