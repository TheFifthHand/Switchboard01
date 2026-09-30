/**
 * Signal measurements used by tests and by offline checks: zero-crossing
 * pitch estimates, windowed power spectra (radix-2 FFT), spectral centroid,
 * band energies and short-time energy envelopes.
 */

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface PowerSpectrum {
  /** Power per bin, bins 0..size/2. */
  power: Float64Array;
  /** Hz per bin. */
  binHz: number;
}

/**
 * Averaged Hann-windowed power spectrum of x[from, to) (Welch, 50% overlap).
 * Segments shorter than `size` are zero-padded.
 */
export function powerSpectrum(x: ArrayLike<number>, sampleRate: number, size = 4096, from = 0, to = x.length): PowerSpectrum {
  const n = size;
  const power = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  const hop = n / 2;
  let segments = 0;
  for (let start = a; start < b; start += hop) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < n && start + i < b; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      re[i] = x[start + i] * w;
    }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    segments++;
    if (start + n >= b) break;
  }
  if (segments > 1) for (let k = 0; k < power.length; k++) power[k] /= segments;
  return { power, binHz: sampleRate / n };
}

/** Fraction of spectral power at or above `hz` (0..1). */
export function fractionAbove(spec: PowerSpectrum, hz: number): number {
  let total = 0;
  let above = 0;
  for (let k = 1; k < spec.power.length; k++) {
    total += spec.power[k];
    if (k * spec.binHz >= hz) above += spec.power[k];
  }
  return total > 0 ? above / total : 0;
}

/** Power-weighted mean frequency. */
export function spectralCentroid(spec: PowerSpectrum): number {
  let num = 0;
  let den = 0;
  for (let k = 1; k < spec.power.length; k++) {
    num += k * spec.binHz * spec.power[k];
    den += spec.power[k];
  }
  return den > 0 ? num / den : 0;
}

/** Frequency of the strongest bin within [lo, hi] Hz, refined by parabolic interpolation. */
export function peakFrequency(spec: PowerSpectrum, lo = 0, hi = Infinity): number {
  let best = -1;
  let bestP = -1;
  for (let k = 1; k < spec.power.length - 1; k++) {
    const f = k * spec.binHz;
    if (f < lo || f > hi) continue;
    if (spec.power[k] > bestP) {
      bestP = spec.power[k];
      best = k;
    }
  }
  if (best < 1) return 0;
  const l = Math.log(spec.power[best - 1] + 1e-300);
  const c = Math.log(spec.power[best] + 1e-300);
  const r = Math.log(spec.power[best + 1] + 1e-300);
  const d = l - 2 * c + r;
  const off = d !== 0 ? (0.5 * (l - r)) / d : 0;
  return (best + Math.max(-0.5, Math.min(0.5, off))) * spec.binHz;
}

/**
 * Relative power (dB) in octave-ish bands with the given edges; used as a
 * compact timbre fingerprint. Returns one value per band.
 */
export function bandProfileDb(spec: PowerSpectrum, edges: readonly number[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (let k = 1; k < spec.power.length; k++) total += spec.power[k];
  for (let e = 0; e < edges.length - 1; e++) {
    let s = 0;
    for (let k = 1; k < spec.power.length; k++) {
      const f = k * spec.binHz;
      if (f >= edges[e] && f < edges[e + 1]) s += spec.power[k];
    }
    out.push(10 * Math.log10(Math.max(s / Math.max(total, 1e-300), 1e-9)));
  }
  return out;
}

/**
 * Mean frequency from rising zero crossings in x[from, to): counts crossings
 * and divides by the time between the first and last one.
 */
export function zeroCrossingFrequency(x: ArrayLike<number>, sampleRate: number, from = 0, to = x.length): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = Math.max(1, from); i < Math.min(x.length, to); i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      // Sub-sample crossing position.
      const pos = i - 1 + x[i - 1] / (x[i - 1] - x[i]);
      if (first < 0) first = pos;
      last = pos;
      count++;
    }
  }
  if (count < 2 || last <= first) return 0;
  return ((count - 1) * sampleRate) / (last - first);
}

/** Energy (sum of squares) of x[from, to). */
export function energy(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) s += x[i] * x[i];
  return s;
}

/** RMS envelope in consecutive windows of `win` samples. */
export function rmsEnvelope(x: ArrayLike<number>, win: number): Float64Array {
  const w = Math.max(1, Math.floor(win));
  const n = Math.ceil(x.length / w);
  const out = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    const a = j * w;
    const b = Math.min(x.length, a + w);
    for (let i = a; i < b; i++) s += x[i] * x[i];
    out[j] = Math.sqrt(s / Math.max(1, b - a));
  }
  return out;
}
