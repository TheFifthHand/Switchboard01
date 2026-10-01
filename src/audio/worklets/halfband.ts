/**
 * Polyphase IIR half-band filters for 2x oversampling inside AudioWorklets
 * (Tape saturation, mastering Warmth).
 *
 * The half-band low-pass is H(z) = ½·[A0(z²) + z⁻¹·A1(z²)], where A0 and A1
 * are cascades of first-order all-pass sections (c + z⁻¹)/(1 + c·z⁻¹) running
 * at the base rate (coefficients with even index form A0, odd index A1).
 *
 *  - Upsampling: the two output samples of each input sample are A0(x) and
 *    A1(x) (no zero stuffing, no multiplications wasted on zeros).
 *  - Downsampling: y = ½·[A0(odd samples) + A1(even samples)].
 *  - Up then straight down is exactly the all-pass A0·A1: magnitude 1 at
 *    every frequency, a group delay of about 2.6 samples at low frequencies.
 *    That is why these filters, unlike linear-phase FIR half-bands, add no
 *    latency that the rest of a mix would have to be delayed by.
 *
 * Coefficients come from the elliptic half-band design used by Laurent de
 * Soras' "hiir" library (closed-form from the number of coefficients and the
 * transition bandwidth). `halfbandCoefs` is pure and unit-tested against the
 * analytic frequency response.
 */

function ipow(x: number, n: number): number {
  let r = 1;
  let b = x;
  let e = n;
  while (e > 0) {
    if (e & 1) r *= b;
    b *= b;
    e >>= 1;
  }
  return r;
}

/**
 * Coefficients of a half-band filter with `count` all-pass sections and a
 * transition band of `transition` (fraction of the oversampled rate on each
 * side of a quarter of it: pass band up to 0.25 − t, stop band from 0.25 + t).
 */
export function halfbandCoefs(count: number, transition: number): number[] {
  const n = Math.max(1, Math.floor(count));
  const t = Math.min(0.249, Math.max(1e-4, transition));
  let k = Math.tan(((1 - t * 2) * Math.PI) / 4);
  k *= k;
  const kk = Math.pow(1 - k * k, 0.25);
  const e = (0.5 * (1 - kk)) / (1 + kk);
  const e2 = e * e;
  const e4 = e2 * e2;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  const order = n * 2 + 1;
  const out: number[] = [];
  for (let index = 0; index < n; index++) {
    const c = index + 1;
    let num = 0;
    for (let i = 0, j = 1; ; i++, j = -j) {
      const v = ipow(q, i * (i + 1)) * Math.sin(((i * 2 + 1) * c * Math.PI) / order) * j;
      num += v;
      if (Math.abs(v) <= 1e-100) break;
    }
    let den = 0;
    for (let i = 1, j = -1; ; i++, j = -j) {
      const v = ipow(q, i * i) * Math.cos((i * 2 * c * Math.PI) / order) * j;
      den += v;
      if (Math.abs(v) <= 1e-100) break;
    }
    const ww = (num * Math.pow(q, 0.25)) / (den + 0.5);
    const w2 = ww * ww;
    const x = Math.sqrt((1 - w2 * k) * (1 - w2 / k)) / (1 + w2);
    out.push((1 - x) / (1 + x));
  }
  return out;
}

/** Magnitude of the half-band low-pass at normalised frequency f (cycles per oversampled sample, 0..0.5). */
export function halfbandMagnitude(coefs: readonly number[], f: number): number {
  const w = 2 * Math.PI * f;
  const allpass = (cs: number[], w2: number): [number, number] => {
    let re = 1;
    let im = 0;
    for (const a of cs) {
      const nr = a + Math.cos(w2);
      const ni = -Math.sin(w2);
      const dr = 1 + a * Math.cos(w2);
      const di = -a * Math.sin(w2);
      const d = dr * dr + di * di;
      const r = (nr * dr + ni * di) / d;
      const i = (ni * dr - nr * di) / d;
      const tr = re * r - im * i;
      im = re * i + im * r;
      re = tr;
    }
    return [re, im];
  };
  const a0 = allpass(coefs.filter((_, i) => i % 2 === 0), 2 * w);
  const a1 = allpass(coefs.filter((_, i) => i % 2 === 1), 2 * w);
  const zr = Math.cos(w);
  const zi = -Math.sin(w);
  const br = a1[0] * zr - a1[1] * zi;
  const bi = a1[0] * zi + a1[1] * zr;
  return Math.hypot(0.5 * (a0[0] + br), 0.5 * (a0[1] + bi));
}

/** Base → 2x stage: about −82 dB image/alias rejection, flat to 0.23 of the 2x rate (22 kHz at 48 kHz). */
export const HALFBAND_STEEP = halfbandCoefs(8, 0.02);
/** 2x → 4x stage: the signal is already band-limited, so a wide transition (−76 dB) is enough. */
export const HALFBAND_WIDE = halfbandCoefs(4, 0.12);

/**
 * Worklet-side implementation (plain JS, included in processor sources).
 * `SbHalfband` holds the state of one direction (up or down) for one channel.
 */
export const HALFBAND_JS = /* js */ `
class SbHalfband {
  constructor(coefs) {
    this.c = Float64Array.from(coefs);
    this.n = this.c.length;
    this.x = new Float64Array(this.n);
    this.y = new Float64Array(this.n);
  }
  run(s0, s1) {
    const c = this.c, x = this.x, y = this.y, n = this.n;
    for (let i = 0; i < n; i += 2) {
      const t0 = (s0 - y[i]) * c[i] + x[i];
      x[i] = s0;
      y[i] = t0;
      s0 = t0;
      if (i + 1 < n) {
        const t1 = (s1 - y[i + 1]) * c[i + 1] + x[i + 1];
        x[i + 1] = s1;
        y[i + 1] = t1;
        s1 = t1;
      }
    }
    this.o0 = s0;
    this.o1 = s1;
  }
  /** Upsample one sample: the two outputs land in this.o0 (earlier) and this.o1 (later). */
  up(v) {
    this.run(v, v);
  }
  /** Downsample a pair (a earlier, b later) to one sample. */
  down(a, b) {
    this.run(b, a);
    return 0.5 * (this.o0 + this.o1);
  }
  /** Flush denormals / reset. */
  tidy() {
    const x = this.x, y = this.y;
    for (let i = 0; i < this.n; i++) {
      if (x[i] < 1e-20 && x[i] > -1e-20) x[i] = 0;
      if (y[i] < 1e-20 && y[i] > -1e-20) y[i] = 0;
    }
  }
  reset() {
    this.x.fill(0);
    this.y.fill(0);
  }
}
const SB_HB_STEEP = ${JSON.stringify(HALFBAND_STEEP)};
const SB_HB_WIDE = ${JSON.stringify(HALFBAND_WIDE)};
`;
