/**
 * Pure DSP helpers: filter responses measured on real signals, band-limited
 * oscillators, envelope timing, shapers, buffer utilities, seeded noise and
 * the analysis functions the audio tests rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  AhdEnvelope,
  Biquad,
  DcBlocker,
  OnePoleLowpass,
  Oscillator,
  PinkNoise,
  WhiteNoise,
  addDampedSine,
  addSquareWave,
  adsrAt,
  asymSaturate,
  biquadCoefficients,
  biquadMagnitude,
  bitReduce,
  decayCoefficient,
  expDecay,
  fadeIn,
  fadeOut,
  fractionAbove,
  normalizePeak,
  peakAbs,
  peakFrequency,
  powerSpectrum,
  rateReduce,
  rms,
  softClip,
  trimTail,
  whiteNoiseBuffer,
  zeroCrossingFrequency,
  type BiquadType,
} from '../../src/audio/dsp';

const SR = 48000;

function sine(freq: number, seconds: number, amp = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

/** Steady-state gain of a biquad for a sine at `freq` (RMS ratio after the transient). */
function measuredGain(type: BiquadType, fc: number, q: number, freq: number, gainDb = 0): number {
  const x = sine(freq, 0.25);
  const y = x.slice();
  new Biquad(type, fc, q, SR, gainDb).processBuffer(y);
  const from = Math.round(0.1 * SR);
  return rms(y, from) / rms(x, from);
}

const db = (g: number) => 20 * Math.log10(g);

describe('Biquad (RBJ)', () => {
  it('low-pass passes lows, is -3 dB at a Butterworth cutoff and rejects highs', () => {
    expect(measuredGain('lowpass', 1000, Math.SQRT1_2, 100)).toBeCloseTo(1, 2);
    expect(db(measuredGain('lowpass', 1000, Math.SQRT1_2, 1000))).toBeCloseTo(-3.01, 1);
    expect(db(measuredGain('lowpass', 1000, Math.SQRT1_2, 10000))).toBeLessThan(-38);
  });

  it('high-pass mirrors the low-pass', () => {
    expect(measuredGain('highpass', 1000, Math.SQRT1_2, 10000)).toBeCloseTo(1, 2);
    expect(db(measuredGain('highpass', 1000, Math.SQRT1_2, 1000))).toBeCloseTo(-3.01, 1);
    expect(db(measuredGain('highpass', 1000, Math.SQRT1_2, 100))).toBeLessThan(-38);
  });

  it('band-pass has 0 dB at the centre and falls away either side', () => {
    expect(measuredGain('bandpass', 2000, 4, 2000)).toBeCloseTo(1, 2);
    expect(db(measuredGain('bandpass', 2000, 4, 500))).toBeLessThan(-20);
    expect(db(measuredGain('bandpass', 2000, 4, 8000))).toBeLessThan(-20);
  });

  it('peaking and shelves apply their gain where they should', () => {
    expect(db(measuredGain('peaking', 1000, 1, 1000, 6))).toBeCloseTo(6, 1);
    expect(db(measuredGain('peaking', 1000, 1, 100, 6))).toBeLessThan(0.5);
    expect(db(measuredGain('highshelf', 3000, Math.SQRT1_2, 15000, -9))).toBeCloseTo(-9, 0);
    expect(db(measuredGain('highshelf', 3000, Math.SQRT1_2, 100, -9))).toBeGreaterThan(-0.3);
    expect(db(measuredGain('lowshelf', 300, Math.SQRT1_2, 40, 6))).toBeCloseTo(6, 0);
  });

  it('biquadMagnitude predicts the measured response', () => {
    for (const [type, f] of [
      ['lowpass', 3000],
      ['highpass', 3000],
      ['bandpass', 1500],
    ] as const) {
      const c = biquadCoefficients(type, 2000, 1.2, SR);
      expect(biquadMagnitude(c, f, SR)).toBeCloseTo(measuredGain(type, 2000, 1.2, f), 2);
    }
  });

  it('stays finite and bounded for out-of-range settings', () => {
    const x = whiteNoiseBuffer(SR / 4, 3);
    for (const [f, q] of [
      [1e9, 0],
      [-5, 1e6],
      [Number.NaN, Number.NaN],
      [SR, 0.001],
    ]) {
      for (const type of ['lowpass', 'highpass', 'bandpass', 'peaking'] as const) {
        const y = x.slice();
        new Biquad(type, f, q, SR, 12).processBuffer(y);
        expect(y.every(Number.isFinite)).toBe(true);
        expect(peakAbs(y)).toBeLessThan(100);
      }
    }
    // A bad sample rate falls back to a usable one instead of producing NaN coefficients.
    for (const sr of [0, -1, Number.NaN, Infinity]) {
      const y = x.slice();
      new Biquad('lowpass', 1000, 0.7, sr).processBuffer(y);
      new DcBlocker(Number.NaN, sr).processBuffer(y);
      const lp = new OnePoleLowpass(100, sr);
      for (let i = 0; i < y.length; i++) y[i] = lp.process(y[i]);
      expect(y.every(Number.isFinite), `sr ${sr}`).toBe(true);
      expect(rms(y), `sr ${sr}`).toBeGreaterThan(0);
    }
  });
});

describe('one-pole filters and DC blocker', () => {
  it('one-pole low-pass smooths towards the input', () => {
    const lp = new OnePoleLowpass(50, SR);
    let y = 0;
    for (let i = 0; i < SR / 10; i++) y = lp.process(1);
    expect(y).toBeGreaterThan(0.99);
  });

  it('DC blocker removes an offset but passes audio', () => {
    const x = sine(440, 1, 0.5).map((v) => v + 0.5);
    new DcBlocker(10, SR).processBuffer(x);
    let mean = 0;
    for (let i = SR / 2; i < SR; i++) mean += x[i];
    expect(Math.abs(mean / (SR / 2))).toBeLessThan(1e-3);
    expect(rms(x, SR / 2)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });
});

describe('oscillators', () => {
  it('produce the requested frequency', () => {
    for (const wave of ['sine', 'square', 'saw', 'triangle'] as const) {
      const osc = new Oscillator(wave, SR);
      const x = new Float32Array(SR / 2);
      for (let i = 0; i < x.length; i++) x[i] = osc.next(220);
      expect(zeroCrossingFrequency(x, SR)).toBeCloseTo(220, 0);
      expect(peakAbs(x)).toBeLessThanOrEqual(1.1);
    }
  });

  it('polyBLEP saw and square have far less aliasing than naive ones', () => {
    const f0 = 2950;
    const n = SR;
    // Energy that is not near a harmonic of f0 is aliasing.
    const alias = (x: Float32Array) => {
      const spec = powerSpectrum(x, SR, 8192);
      let a = 0;
      let t = 0;
      for (let k = 1; k < spec.power.length; k++) {
        const f = k * spec.binHz;
        const h = f / f0;
        t += spec.power[k];
        if (Math.abs(h - Math.round(h)) * f0 > 60) a += spec.power[k];
      }
      return a / t;
    };
    for (const wave of ['saw', 'square'] as const) {
      const blep = new Float32Array(n);
      const naive = new Float32Array(n);
      const osc = new Oscillator(wave, SR);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        blep[i] = osc.next(f0);
        naive[i] = wave === 'saw' ? 2 * ph - 1 : ph < 0.5 ? 1 : -1;
        ph = (ph + f0 / SR) % 1;
      }
      // About 16 dB better in practice; a wrong-signed or misplaced correction makes it worse, not better.
      expect(db(alias(blep) / alias(naive)) / 2, wave).toBeLessThan(-12);
    }
  });

  it('addSquareWave matches the square oscillator', () => {
    const a = new Float32Array(4800);
    addSquareWave(a, 800, SR, 0.3);
    const osc = new Oscillator('square', SR, 0.3);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(osc.next(800), 5);
  });

  it('addDampedSine rings at its frequency and falls 60 dB in T60', () => {
    const x = new Float32Array(SR);
    addDampedSine(x, 1000, 0.5, SR, 1, 0);
    expect(x[0]).toBe(0);
    expect(zeroCrossingFrequency(x, SR, 0, SR / 10)).toBeCloseTo(1000, 0);
    // Windows centred 0.5 s apart (5 ms and 505 ms).
    const early = rms(x, 0, 480);
    const at = rms(x, Math.round(0.505 * SR) - 240, Math.round(0.505 * SR) + 240);
    expect(db(at / early)).toBeCloseTo(-60, 0);
    // Undamped with offset: silent before the offset, full level after.
    const y = new Float32Array(4800);
    addDampedSine(y, 500, 0, SR, 0.5, 0.25, 1000);
    expect(peakAbs(y, 0, 1000)).toBe(0);
    expect(peakAbs(y, 1000)).toBeCloseTo(0.5, 3);
  });
});

describe('envelopes', () => {
  it('decay coefficient and expDecay agree on T60', () => {
    const c = decayCoefficient(0.3, SR);
    expect(Math.pow(c, 0.3 * SR)).toBeCloseTo(0.001, 5);
    expect(expDecay(0.3, 0.3)).toBeCloseTo(0.001, 6);
  });

  it('AHD starts at 0, reaches 1 after the attack, holds, then decays 60 dB in T60', () => {
    const e = new AhdEnvelope(0.002, 0.01, 0.2, SR);
    const v = Array.from({ length: Math.round(0.3 * SR) }, () => e.next());
    expect(v[0]).toBe(0);
    expect(v[Math.round(0.002 * SR)]).toBeCloseTo(1, 6);
    expect(v[Math.round(0.011 * SR)]).toBe(1);
    expect(v[Math.round(0.212 * SR)]).toBeCloseTo(0.001, 4);
  });

  it('ADSR attack, sustain and release', () => {
    const spec = { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2 };
    expect(adsrAt(spec, 0.005, 1)).toBeCloseTo(0.5, 6);
    expect(adsrAt(spec, 0.5, 1)).toBeCloseTo(0.5, 3);
    expect(adsrAt(spec, 1.2, 1)).toBeCloseTo(0.5 * 0.001, 5);
  });
});

describe('shapers', () => {
  it('softClip is bounded, monotonic and keeps unity', () => {
    let prev = -Infinity;
    for (let x = -1; x <= 1; x += 0.01) {
      const y = softClip(x, 3);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(Math.abs(y)).toBeLessThanOrEqual(1 + 1e-12);
      prev = y;
    }
    expect(softClip(1, 3)).toBeCloseTo(1, 12);
    expect(softClip(0.3, 0)).toBe(0.3);
  });

  it('asymSaturate keeps zero at zero and unity at one, with asymmetric halves', () => {
    expect(asymSaturate(0, 2, 0.2)).toBeCloseTo(0, 12);
    expect(asymSaturate(1, 2, 0.2)).toBeCloseTo(1, 12);
    expect(Math.abs(asymSaturate(-0.8, 2, 0.2))).not.toBeCloseTo(asymSaturate(0.8, 2, 0.2), 2);
  });

  it('bit and rate reduction quantise level and time', () => {
    const x = sine(100, 0.05, 0.9);
    const b = x.slice();
    bitReduce(b, 4);
    expect(new Set(b).size).toBeLessThanOrEqual(17);
    const r = x.slice();
    rateReduce(r, SR, SR / 4);
    for (let i = 0; i + 3 < r.length; i += 4) expect(r[i + 1]).toBe(r[i]);
  });
});

describe('buffer utilities', () => {
  it('normalise, fade and trim', () => {
    const x = sine(440, 0.5, 0.3);
    normalizePeak(x, 0.8);
    expect(peakAbs(x)).toBeCloseTo(0.8, 6);
    fadeIn(x, 100);
    fadeOut(x, 200);
    expect(x[0]).toBe(0);
    expect(x[x.length - 1]).toBe(0);
    const tail = new Float32Array(1000);
    tail.set([1, 0.5, 0.25, 0.001]);
    expect(trimTail(tail, -40, 2).length).toBe(5);
  });
});

describe('seeded noise', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = whiteNoiseBuffer(1000, 42);
    const b = whiteNoiseBuffer(1000, 42);
    const c = whiteNoiseBuffer(1000, 43);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(peakAbs(a)).toBeLessThanOrEqual(1);
  });

  it('white noise is flat, pink noise tilts towards the lows', () => {
    const w = new WhiteNoise(1);
    const p = new PinkNoise(1);
    const wx = new Float32Array(SR);
    const px = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      wx[i] = w.next();
      px[i] = p.next();
    }
    expect(fractionAbove(powerSpectrum(wx, SR), 12000)).toBeCloseTo(0.5, 1);
    expect(fractionAbove(powerSpectrum(px, SR), 12000)).toBeLessThan(0.15);
    expect(peakAbs(px)).toBeLessThan(1.2);
  });
});

describe('analysis', () => {
  it('peakFrequency and zeroCrossingFrequency locate a tone', () => {
    const x = sine(1234.5, 0.5);
    expect(peakFrequency(powerSpectrum(x, SR, 8192))).toBeCloseTo(1234.5, 0);
    expect(zeroCrossingFrequency(x, SR)).toBeCloseTo(1234.5, 0);
  });
});
