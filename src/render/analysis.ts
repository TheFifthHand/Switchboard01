/**
 * Pure signal measurements for tests, export checks and e2e evidence
 * (no DOM, no Web Audio: plain Float32Array in, numbers out).
 */

type Samples = ArrayLike<number>;

export function peak(samples: Samples): number {
  let m = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > m) m = v;
  }
  return m;
}

export function rms(samples: Samples): number {
  if (!samples.length) return 0;
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}

/** RMS in dBFS (-Infinity for silence). */
export function rmsDb(samples: Samples): number {
  const r = rms(samples);
  return r > 0 ? 20 * Math.log10(r) : -Infinity;
}

export function isAllFinite(samples: Samples): boolean {
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) return false;
  return true;
}

/** Peak / RMS (linear). 0 for silence. */
export function crestFactor(samples: Samples): number {
  const r = rms(samples);
  return r > 0 ? peak(samples) / r : 0;
}

/** RMS of consecutive, non-overlapping windows of `windowSamples` (the last one may be shorter). */
export function envelope(samples: Samples, windowSamples: number): Float32Array {
  const w = Math.max(1, Math.floor(windowSamples));
  const n = Math.ceil(samples.length / w);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = k * w;
    const b = Math.min(samples.length, a + w);
    let s = 0;
    for (let i = a; i < b; i++) s += samples[i] * samples[i];
    out[k] = Math.sqrt(s / (b - a));
  }
  return out;
}

export interface OnsetOptions {
  /** Short-window RMS level that counts as an onset (linear, default 0.02). */
  threshold?: number;
  /** Minimum spacing between onsets in ms (default 30). */
  minGapMs?: number;
  /** Energy window in ms (default 1). */
  windowMs?: number;
}

/**
 * Energy-based onset detection. Returns sample indices where the short-window
 * RMS rises through `threshold` (after having fallen below half of it),
 * refined to the first sample in the window whose magnitude reaches the
 * threshold — accurate to a few samples for clicks and percussive attacks.
 */
export function detectOnsets(samples: Samples, sampleRate: number, opts: OnsetOptions = {}): number[] {
  const threshold = opts.threshold ?? 0.02;
  const minGap = Math.max(1, Math.round(((opts.minGapMs ?? 30) * sampleRate) / 1000));
  const w = Math.max(1, Math.round(((opts.windowMs ?? 1) * sampleRate) / 1000));
  const thr2 = threshold * threshold * w;
  const rearm2 = (threshold / 2) * (threshold / 2) * w;
  const onsets: number[] = [];
  let sum = 0;
  let armed = true;
  let last = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
    if (i >= w) sum -= samples[i - w] * samples[i - w];
    if (i % 4096 === 0) {
      // Re-sum now and then so floating error cannot accumulate.
      sum = 0;
      for (let j = Math.max(0, i - w + 1); j <= i; j++) sum += samples[j] * samples[j];
    }
    if (armed) {
      if (sum >= thr2 && i - last >= minGap) {
        let j = Math.max(0, i - w + 1);
        while (j < i && Math.abs(samples[j]) < threshold) j++;
        if (j - last >= minGap) {
          onsets.push(j);
          last = j;
          armed = false;
        }
      }
    } else if (sum < rearm2) {
      armed = true;
    }
  }
  return onsets;
}

/* ------------------------------------------------------------------ */
/* Spectrum                                                            */
/* ------------------------------------------------------------------ */

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number): { cos: Float64Array; sin: Float64Array } {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = -Math.sin((2 * Math.PI * k) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

/** In-place radix-2 FFT (length must be a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n & (n - 1)) throw new RangeError('FFT length must be a power of two');
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
  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

export interface PowerSpectrum {
  /** One-sided power per bin, scaled so the sum over all bins is the mean square of the signal. */
  power: Float64Array;
  binHz: number;
}

/** Average power spectrum over Hann-windowed frames (50% overlap), `frameSize` a power of two. */
export function powerSpectrum(samples: Samples, sampleRate: number, frameSize = 4096): PowerSpectrum {
  let n = 1;
  while (n < frameSize) n <<= 1;
  // Short signals: one frame that covers them (zero padded).
  if (samples.length < n) {
    n = 32;
    while (n < samples.length) n <<= 1;
  }
  // The window spans the real samples; a short signal is zero padded after it.
  const winLen = Math.max(1, Math.min(n, samples.length));
  const win = new Float64Array(n);
  let wsum2 = 0;
  for (let i = 0; i < winLen; i++) {
    win[i] = winLen > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / winLen) : 1;
    wsum2 += win[i] * win[i];
  }
  const power = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const hop = n / 2;
  let frames = 0;
  for (let start = 0; start === 0 || start + n <= samples.length; start += hop) {
    for (let i = 0; i < n; i++) {
      const j = start + i;
      re[i] = j < samples.length ? samples[j] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) / (n * wsum2);
      power[k] += k === 0 || k === n / 2 ? p : 2 * p;
    }
    frames++;
  }
  for (let k = 0; k < power.length; k++) power[k] /= frames;
  return { power, binHz: sampleRate / n };
}

/** Amplitude-weighted mean frequency in Hz (0 for silence). */
export function spectralCentroid(samples: Samples, sampleRate: number): number {
  const { power, binHz } = powerSpectrum(samples, sampleRate);
  let num = 0;
  let den = 0;
  for (let k = 1; k < power.length; k++) {
    const mag = Math.sqrt(power[k]);
    num += k * binHz * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Mean-square energy between `lo` and `hi` Hz (inclusive). Over the whole
 * band [0, sampleRate / 2] it approximates rms(samples)^2.
 */
export function bandEnergy(samples: Samples, sampleRate: number, lo: number, hi: number): number {
  const { power, binHz } = powerSpectrum(samples, sampleRate);
  let e = 0;
  for (let k = 0; k < power.length; k++) {
    const f = k * binHz;
    if (f >= lo && f <= hi) e += power[k];
  }
  return e;
}

/**
 * Fundamental frequency in Hz using the YIN difference function (0 when no
 * clear pitch is found). Searches 30 Hz .. 5 kHz on a frame from the middle of
 * the signal.
 */
export function estimateFundamental(samples: Samples, sampleRate: number): number {
  const maxLag = Math.floor(sampleRate / 30);
  const minLag = Math.max(2, Math.floor(sampleRate / 5000));
  const len = samples.length;
  const lagLimit = Math.min(maxLag, Math.floor(len / 2) - 1);
  if (lagLimit <= minLag) return 0;
  const w = Math.min(2048, len - lagLimit);
  const start = Math.max(0, Math.floor((len - w - lagLimit) / 2));
  const d = new Float64Array(lagLimit + 1);
  for (let tau = 1; tau <= lagLimit; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const diff = samples[start + j] - samples[start + j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  // Cumulative mean normalised difference.
  const cmnd = new Float64Array(lagLimit + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= lagLimit; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  const threshold = 0.15;
  let tau = -1;
  for (let t = minLag; t <= lagLimit; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= lagLimit && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // No lag under the threshold: accept the global minimum only if clearly periodic.
    let best = minLag;
    for (let t = minLag; t <= lagLimit; t++) if (cmnd[t] < cmnd[best]) best = t;
    if (cmnd[best] > 0.35) return 0;
    tau = best;
  }
  // Parabolic interpolation around the minimum.
  let refined = tau;
  if (tau > 1 && tau < lagLimit) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const den = a - 2 * b + c;
    if (den !== 0) refined = tau + (0.5 * (a - c)) / den;
  }
  return sampleRate / refined;
}
