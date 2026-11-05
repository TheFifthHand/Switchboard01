/**
 * 16-bit WAV exports are dithered (TPDF, seeded): the same audio always gives
 * the same bytes, the added noise floor is the expected half an LSB RMS, a
 * tone below one LSB survives instead of vanishing, digital silence stays
 * silent, and 24-bit encoding is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { WAV_DITHER_SEED, encodeWav, parseWav } from '../../src/render/wav';

const SR = 48000;
const LSB = 1 / 32768;

function sine(n: number, freq: number, amp: number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

/** The 16-bit sample values of a mono encode. */
function ints16(buf: ArrayBuffer): Int16Array {
  return new Int16Array(buf.slice(44));
}

describe('16-bit TPDF dither', () => {
  it('is deterministic: the same buffer always gives the same bytes (and the seed is what makes them)', () => {
    const x = sine(48000, 440, 0.3);
    const a = new Uint8Array(encodeWav([x, x], SR, 16));
    const b = new Uint8Array(encodeWav([x, x], SR, 16));
    expect(a).toEqual(b);
    const other = new Uint8Array(encodeWav([x, x], SR, 16, { seed: WAV_DITHER_SEED + 1 }));
    expect(other).not.toEqual(a);
    const plain = new Uint8Array(encodeWav([x, x], SR, 16, { dither: false }));
    expect(plain).not.toEqual(a);
  });

  it('adds a noise floor of about half an LSB RMS, without offset', () => {
    // A slow ramp through many LSBs: error = dither + rounding, independent of the signal.
    const n = 96000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = -0.01 + (0.02 * i) / n + 1e-9;
    const q = ints16(encodeWav([x], SR, 16));
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const e = q[i] - (v < 0 ? v * 32768 : v * 32767);
      sum += e;
      sq += e * e;
    }
    const mean = sum / n;
    const rms = Math.sqrt(sq / n);
    // TPDF (variance 1/6) plus rounding (1/12): 0.5 LSB RMS, i.e. about −96 dBFS.
    expect(rms).toBeGreaterThan(0.45);
    expect(rms).toBeLessThan(0.55);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    // Never more than 1.5 LSB away (±1 LSB of dither + rounding).
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(q[i] - x[i] * (x[i] < 0 ? 32768 : 32767)));
    expect(worst).toBeLessThanOrEqual(1.5 + 1e-6);
  });

  it('keeps a tone below one LSB (a fading reverb tail) instead of truncating it to silence', () => {
    const n = 48000;
    const amp = 0.35 * LSB;
    const x = sine(n, 1000, amp);
    const plain = ints16(encodeWav([x], SR, 16, { dither: false }));
    expect(plain.every((v) => v === 0)).toBe(true);
    const dithered = ints16(encodeWav([x], SR, 16));
    // The tone is still there, at its own level, under the noise.
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const ph = (2 * Math.PI * 1000 * i) / SR;
      re += (dithered[i] / 32768) * Math.cos(ph);
      im += (dithered[i] / 32768) * Math.sin(ph);
    }
    const found = (2 * Math.hypot(re, im)) / n;
    expect(found / amp).toBeGreaterThan(0.8);
    expect(found / amp).toBeLessThan(1.2);
  });

  it('leaves exact digital silence silent and keeps full scale in range', () => {
    const silent = ints16(encodeWav([new Float32Array(2000)], SR, 16));
    expect(silent.every((v) => v === 0)).toBe(true);
    const full = new Float32Array(1000);
    for (let i = 0; i < full.length; i++) full[i] = i % 2 ? 1 : -1;
    const q = ints16(encodeWav([full], SR, 16));
    for (let i = 0; i < q.length; i++) {
      expect(q[i]).toBeLessThanOrEqual(32767);
      expect(q[i]).toBeGreaterThanOrEqual(-32768);
      expect(Math.abs(q[i])).toBeGreaterThan(32765);
    }
  });

  it('24-bit encoding is unchanged: rounded, no dither', () => {
    const x = sine(4800, 300, 0.4);
    const a = new Uint8Array(encodeWav([x], SR, 24));
    const b = new Uint8Array(encodeWav([x], SR, 24, { dither: true }));
    expect(b).toEqual(a);
    const back = parseWav(a.buffer as ArrayBuffer).channels[0];
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(back[i] - x[i]));
    expect(err).toBeLessThanOrEqual(0.5 / 8388607 + 1e-7);
  });
});
