/**
 * The Mix spectrum's band map (perf-04): the bins and weights of every band
 * are computed once per (FFT size, sample rate, bands), and a frame costs one
 * exp per bin. Wide bands read what the previous per-frame computation read;
 * narrow low bands now integrate the interpolated density instead of
 * counting whole bins (the previous reading of pink noise was up to 5 dB
 * high there). The 4096-point FFT now used reads pink noise within 0.5 dB of
 * the 8192-point one from 60 Hz, and within 1 dB below.
 */
import { describe, expect, it } from 'vitest';
import { SPECTRUM_CAL_DB, SPECTRUM_HIGH_HZ, SPECTRUM_LOW_HZ, spectrumBandMap, spectrumBands } from '../../src/audio/spectrum';
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

  it('a 4096-point FFT reads pink noise within 0.5 dB of the previous 8192-point reading (1 dB below 60 Hz), and flat down to 20 Hz', () => {
    const x = pinkNoise(1 << 20);
    const db8192 = analyserDb(x, 8192);
    const db4096 = analyserDb(x, 4096);
    const old = new Float32Array(BANDS);
    previousBands(db8192, 8192, SR, old);
    const now = new Float32Array(BANDS);
    spectrumBands(spectrumBandMap(4096, SR, BANDS), db4096, now, new Float64Array(2048));
    const now8192 = new Float32Array(BANDS);
    spectrumBands(spectrumBandMap(8192, SR, BANDS), db8192, now8192, new Float64Array(4096));
    const binHz8192 = SR / 8192;
    let worstVsOld = 0;
    let worstOldLow = 0;
    let worstSizes = 0;
    let worstLowest = 0;
    for (let b = 0; b < BANDS; b++) {
      const width = (SPECTRUM_LOW_HZ * Math.pow(1000, (b + 1) / BANDS) - SPECTRUM_LOW_HZ * Math.pow(1000, b / BANDS)) / binHz8192;
      const lowHz = SPECTRUM_LOW_HZ * Math.pow(1000, b / BANDS);
      // Below 60 Hz the 4096-point window main lobe (±35 Hz) lets the stronger lows leak in a little.
      if (lowHz < 60) worstLowest = Math.max(worstLowest, Math.abs(now[b] - now8192[b]));
      else worstSizes = Math.max(worstSizes, Math.abs(now[b] - now8192[b]));
      // Where the previous computation summed several whole bins it read pink noise correctly: match it there.
      if (width >= 4) worstVsOld = Math.max(worstVsOld, Math.abs(now[b] - old[b]));
      else worstOldLow = Math.max(worstOldLow, Math.abs(old[b] - now8192[b]));
    }
    console.info(
      `[spectrum] pink noise: 4096 vs previous 8192 (bands of 4+ bins) ${worstVsOld.toFixed(2)} dB; 4096 vs 8192 (same map) ${worstSizes.toFixed(2)} dB from 60 Hz, ${worstLowest.toFixed(2)} dB below; previous computation's error in the narrow low bands up to ${worstOldLow.toFixed(2)} dB`,
    );
    expect(worstVsOld).toBeLessThanOrEqual(0.5);
    expect(worstSizes).toBeLessThanOrEqual(0.5);
    expect(worstLowest).toBeLessThanOrEqual(1);
    // Pink noise reads flat across the whole range (the Kellet filter is pink within about ±0.5 dB).
    const mean = now.reduce((a, v) => a + v, 0) / BANDS;
    for (let b = 0; b < BANDS; b++) expect(Math.abs(now[b] - mean), `band ${b}`).toBeLessThan(1.5);
  });
});
