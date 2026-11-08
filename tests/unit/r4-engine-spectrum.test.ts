/**
 * The Mix spectrum's band map (perf-04): the bins and weights of every band
 * are computed once per (FFT size, sample rate, bands), and a frame costs one
 * exp per bin. Wide bands read what the previous per-frame computation read;
 * narrow low bands integrate the interpolated density instead of counting
 * whole bins (the previous reading of pink noise was up to 5 dB high there).
 * The engine reads two resolutions: 8192 points above SPECTRUM_SPLIT_HZ and
 * 16384 points below, so a bass note is not smeared over several narrow
 * bands: sines read their level within about 1 dB down to 50 Hz and pink
 * noise stays flat.
 */
import { describe, expect, it } from 'vitest';
import { SPECTRUM_CAL_DB, SPECTRUM_HIGH_HZ, SPECTRUM_LOW_HZ, spectrumBandMap, spectrumBands, spectrumBandsBelow, spectrumBandsLastBin } from '../../src/audio/spectrum';
import { SPECTRUM_FFT, SPECTRUM_LOW_FFT, SPECTRUM_SPLIT_HZ } from '../../src/audio/engine';
import { fft } from '../../src/render/analysis';
import { Rng } from '../../src/project/rng';

const SR = 48000;
const BANDS = 96;

/** The band computation as readSpectrum did it before (Math.pow per bin, band edges every frame). */
function previousBands(buf: Float32Array, fftSize: number, sampleRate: number, out: Float32Array): void {
  const n = out.length;
  const binHz = sampleRate / fftSize;
  const power = (k: number): number => {
    const db = buf[Math.min(buf.length - 1, Math.max(0, k))];
    return Number.isFinite(db) ? Math.pow(10, (db + SPECTRUM_CAL_DB) / 10) : 0;
  };
  const ratio = SPECTRUM_HIGH_HZ / SPECTRUM_LOW_HZ;
  for (let b = 0; b < n; b++) {
    const lo = SPECTRUM_LOW_HZ * Math.pow(ratio, b / n);
    const hi = SPECTRUM_LOW_HZ * Math.pow(ratio, (b + 1) / n);
    const k0 = Math.ceil(lo / binHz);
    const k1 = Math.floor(hi / binHz);
    let p = 0;
    if (k1 >= k0) {
      for (let k = k0; k <= k1; k++) p += power(k);
    } else {
      const f = Math.sqrt(lo * hi) / binHz;
      const k = Math.floor(f);
      const frac = f - k;
      p = (power(k) * (1 - frac) + power(k + 1) * frac) * ((hi - lo) / binHz);
    }
    const db = p > 0 ? 10 * Math.log10(p) : -140;
    out[b] = Math.max(-140, Math.min(20, db));
  }
}

/** Seeded pink noise (Paul Kellet's refined filter on white noise). */
function pinkNoise(n: number, seed = 3): Float32Array {
  const rng = new Rng(seed);
  const x = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.noise();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.05;
    b6 = w * 0.115926;
  }
  return x;
}

/**
 * What AnalyserNode.getFloatFrequencyData reports for a steady signal: the
 * Blackman-windowed FFT magnitude / N, averaged (as its smoothing does over
 * time), in dB. Averaged over many frames, so the comparison is about the
 * FFT size, not about random fluctuation.
 */
function analyserDb(x: Float32Array, fftSize: number): Float32Array {
  const win = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const a = (2 * Math.PI * i) / fftSize;
    win[i] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
  }
  const mag = new Float64Array(fftSize / 2);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  let frames = 0;
  for (let start = 0; start + fftSize <= x.length; start += fftSize / 2) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < fftSize / 2; k++) mag[k] += Math.hypot(re[k], im[k]) / fftSize;
    frames++;
  }
  const out = new Float32Array(fftSize / 2);
  for (let k = 0; k < out.length; k++) out[k] = 20 * Math.log10(mag[k] / frames);
  return out;
}

describe('spectrum band map', () => {
  it('sums whole bins like the previous computation for wide bands (random spectra, 8192 and 4096 points, 44.1 and 48 kHz)', () => {
    const rng = new Rng(11);
    for (const [fftSize, sr] of [
      [8192, 48000],
      [4096, 48000],
      [4096, 44100],
    ] as const) {
      // A smooth random spectrum (wide bands then read the same density both ways).
      const buf = new Float32Array(fftSize / 2);
      let level = -60;
      for (let k = 0; k < buf.length; k++) {
        level += (rng.float() - 0.5) * 0.2;
        buf[k] = level;
      }
      const expected = new Float32Array(BANDS);
      previousBands(buf, fftSize, sr, expected);
      const got = new Float32Array(BANDS);
      spectrumBands(spectrumBandMap(fftSize, sr, BANDS), buf, got, new Float64Array(fftSize / 2));
      const binHz = sr / fftSize;
      for (let b = 0; b < BANDS; b++) {
        const width = (SPECTRUM_LOW_HZ * Math.pow(1000, (b + 1) / BANDS) - SPECTRUM_LOW_HZ * Math.pow(1000, b / BANDS)) / binHz;
        // Bands of 8 bins or more: within 0.6 dB (the old sum counted whole edge bins).
        if (width >= 8) expect(Math.abs(got[b] - expected[b]), `band ${b} (${fftSize}, ${sr})`).toBeLessThan(0.6);
      }
    }
  });

  it('is computed once per FFT size, rate and band count, and silence reads −140', () => {
    expect(spectrumBandMap(4096, SR, BANDS)).toBe(spectrumBandMap(4096, SR, BANDS));
    const out = new Float32Array(BANDS);
    spectrumBands(spectrumBandMap(4096, SR, BANDS), new Float32Array(2048).fill(-Infinity), out, new Float64Array(2048));
    expect(Array.from(out).every((v) => v === -140)).toBe(true);
  });

  it('reads only the bands asked for, from the bins they need', () => {
    const map = spectrumBandMap(SPECTRUM_LOW_FFT, SR, BANDS);
    const split = spectrumBandsBelow(BANDS, SPECTRUM_SPLIT_HZ);
    expect(split).toBeGreaterThan(10);
    expect(SPECTRUM_LOW_HZ * Math.pow(1000, split / BANDS)).toBeLessThanOrEqual(SPECTRUM_SPLIT_HZ * 1.000001);
    expect(SPECTRUM_LOW_HZ * Math.pow(1000, (split + 1) / BANDS)).toBeGreaterThan(SPECTRUM_SPLIT_HZ);
    const need = spectrumBandsLastBin(map, split) + 1;
    expect(need * (SR / SPECTRUM_LOW_FFT)).toBeLessThan(SPECTRUM_SPLIT_HZ + 3 * (SR / SPECTRUM_LOW_FFT));
    const out = new Float32Array(BANDS).fill(7);
    spectrumBands(map, new Float32Array(need).fill(-60), out, new Float64Array(SPECTRUM_LOW_FFT / 2), 0, split);
    for (let b = 0; b < BANDS; b++) {
      if (b < split) expect(out[b]).toBeLessThan(0);
      else expect(out[b]).toBe(7);
    }
  });

  /** The engine's reading: SPECTRUM_LOW_FFT bins below the split, SPECTRUM_FFT above. */
  function engineBands(x: Float32Array): Float32Array {
    const low = analyserDb(x, SPECTRUM_LOW_FFT);
    const main = analyserDb(x, SPECTRUM_FFT);
    const split = spectrumBandsBelow(BANDS, SPECTRUM_SPLIT_HZ);
    const out = new Float32Array(BANDS);
    const power = new Float64Array(SPECTRUM_LOW_FFT / 2);
    spectrumBands(spectrumBandMap(SPECTRUM_LOW_FFT, SR, BANDS), low, out, power, 0, split);
    spectrumBands(spectrumBandMap(SPECTRUM_FFT, SR, BANDS), main, out, power, split, BANDS);
    return out;
  }

  it('reads pink noise flat down to 20 Hz, and as the previous 8192-point reading where its bands were wide', () => {
    const x = pinkNoise(1 << 20);
    const now = engineBands(x);
    const db8192 = analyserDb(x, 8192);
    const old = new Float32Array(BANDS);
    previousBands(db8192, 8192, SR, old);
    const binHz8192 = SR / 8192;
    let worstVsOld = 0;
    let worstOldLow = 0;
    for (let b = 0; b < BANDS; b++) {
      const width = (SPECTRUM_LOW_HZ * Math.pow(1000, (b + 1) / BANDS) - SPECTRUM_LOW_HZ * Math.pow(1000, b / BANDS)) / binHz8192;
      if (width >= 4) worstVsOld = Math.max(worstVsOld, Math.abs(now[b] - old[b]));
      else worstOldLow = Math.max(worstOldLow, Math.abs(old[b] - now[b]));
    }
    const mean = now.reduce((a, v) => a + v, 0) / BANDS;
    const flat = Math.max(...Array.from(now, (v) => Math.abs(v - mean)));
    console.info(`[spectrum] pink noise: vs previous 8192 (bands of 4+ bins) ${worstVsOld.toFixed(2)} dB; previous computation off by up to ${worstOldLow.toFixed(2)} dB in the narrow low bands; flatness ±${flat.toFixed(2)} dB`);
    // Within 0.6 dB (the old sum counted whole edge bins; the bass bands now come from the finer FFT).
    expect(worstVsOld).toBeLessThanOrEqual(0.6);
    // Pink noise reads flat across the whole range (the Kellet filter is pink within about ±0.5 dB).
    for (let b = 0; b < BANDS; b++) expect(Math.abs(now[b] - mean), `band ${b}`).toBeLessThan(1.5);
  });

  it('a bass sine peaks in its band at least as high as the previous 8192-point reading less 1 dB, never above its level', () => {
    for (const hz of [50, 70, 100, 140, 1000]) {
      const n = 1 << 18;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
      const peak = Math.max(...engineBands(x));
      const old = new Float32Array(BANDS);
      previousBands(analyserDb(x, 8192), 8192, SR, old);
      const oldPeak = Math.max(...old);
      // A sine of amplitude 0.5 is −6.0 dB re. a full-scale sine.
      console.info(`[spectrum] ${hz} Hz sine at −6 dB peaks at ${peak.toFixed(2)} dB (previous 8192-point reading ${oldPeak.toFixed(2)} dB)`);
      expect(peak, `${hz} Hz`).toBeGreaterThan(oldPeak - 1);
      expect(peak, `${hz} Hz`).toBeLessThan(-5.5);
    }
  });
});
