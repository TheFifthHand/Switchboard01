/**
 * Offline loudness measurement (ITU-R BS.1770-4 / EBU R128) of rendered
 * audio: integrated loudness with the absolute (−70 LUFS) and relative
 * (−10 LU) gates, maximum momentary (400 ms) and short-term (3 s) loudness,
 * and true peak (4x oversampled). Pure: Float32Arrays in, numbers out.
 *
 * It uses the same K-weighting and true-peak kernels as the live meter
 * worklet (src/audio/worklets/loudness.ts); the tests check that both agree
 * and that both read the EBU Tech 3341 reference signals correctly.
 */
import { kWeightingCoefs, lufs, truePeakKernels, type Biquad } from '../audio/worklets/loudness';

type Samples = ArrayLike<number>;

export interface LoudnessResult {
  /** Gated integrated loudness, LUFS (−Infinity when everything is below the gates). */
  integrated: number;
  /** Highest momentary (400 ms) loudness, LUFS. */
  momentaryMax: number;
  /** Highest short-term (3 s) loudness, LUFS (over the available audio when shorter than 3 s). */
  shortTermMax: number;
  /** Highest true peak, dBTP. */
  truePeakDb: number;
  /** Highest sample peak, dBFS. */
  samplePeakDb: number;
}

function kWeighted(x: Samples, stages: [Biquad, Biquad]): Float64Array {
  const out = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, w1 = 0, w2 = 0;
  const [a, b] = stages;
  for (let i = 0; i < x.length; i++) {
    const v = Number.isFinite(x[i]) ? x[i] : 0;
    const y = a[0] * v + a[1] * x1 + a[2] * x2 - a[3] * y1 - a[4] * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    const z = b[0] * y + b[1] * z1 + b[2] * z2 - b[3] * w1 - b[4] * w2;
    z2 = z1;
    z1 = y;
    w2 = w1;
    w1 = z;
    out[i] = z;
  }
  return out;
}

/** True peak (linear) of one channel: samples plus interpolation at ¼, ½ and ¾ between them. */
export function truePeak(x: Samples): number {
  const kernels = truePeakKernels();
  const len = kernels[0].length;
  const half = len / 2;
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  // Interpolated points between every pair of neighbours (zero padded at the ends).
  const padded = new Float64Array(x.length + 2 * len);
  for (let i = 0; i < x.length; i++) padded[len + i] = x[i];
  const ks = kernels.map((k) => Float64Array.from(k));
  // Window [first, first + len) puts the interpolated point between padded[first + half - 1] and padded[first + half].
  for (let first = len - half; first + half <= len + x.length; first++) {
    for (const k of ks) {
      let v = 0;
      for (let j = 0; j < len; j++) v += k[j] * padded[first + j];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/**
 * BS.1770 loudness of a stereo signal (R = null: mono, one channel).
 * `truePeak: false` skips the (slower) oversampled peak search.
 */
export function measureLoudness(L: Samples, R: Samples | null, sampleRate: number, opts: { truePeak?: boolean } = {}): LoudnessResult {
  const stages = kWeightingCoefs(sampleRate);
  const chans = R ? [L, R] : [L];
  const weighted = chans.map((c) => kWeighted(c, stages));
  const n = L.length;
  const sub = Math.max(1, Math.round(0.1 * sampleRate));
  const subCount = Math.floor(n / sub);
  const subPower = new Float64Array(subCount);
  for (let s = 0; s < subCount; s++) {
    let acc = 0;
    for (const w of weighted) for (let i = s * sub; i < (s + 1) * sub; i++) acc += w[i] * w[i];
    subPower[s] = acc / sub;
  }
  const windowMean = (end: number, count: number): number => {
    let acc = 0;
    for (let k = end - count + 1; k <= end; k++) acc += subPower[k];
    return acc / count;
  };
  const blocks: number[] = [];
  let momentaryMax = -Infinity;
  let shortTermMax = -Infinity;
  for (let s = 0; s < subCount; s++) {
    if (s >= 3) {
      const m = windowMean(s, 4);
      blocks.push(m);
      momentaryMax = Math.max(momentaryMax, lufs(m));
    }
    if (s >= 29 || (subCount < 30 && s === subCount - 1)) shortTermMax = Math.max(shortTermMax, lufs(windowMean(s, Math.min(30, s + 1))));
  }
  const gated = blocks.filter((p) => lufs(p) > -70);
  let integrated = -Infinity;
  if (gated.length) {
    const rel = lufs(gated.reduce((a, b) => a + b, 0) / gated.length) - 10;
    const kept = gated.filter((p) => lufs(p) > rel);
    if (kept.length) integrated = lufs(kept.reduce((a, b) => a + b, 0) / kept.length);
  }
  let tp = 0;
  let sp = 0;
  for (const c of chans) {
    for (let i = 0; i < c.length; i++) sp = Math.max(sp, Math.abs(c[i]));
    tp = Math.max(tp, opts.truePeak === false ? sp : truePeak(c));
  }
  return {
    integrated,
    momentaryMax,
    shortTermMax,
    truePeakDb: tp > 0 ? 20 * Math.log10(tp) : -Infinity,
    samplePeakDb: sp > 0 ? 20 * Math.log10(sp) : -Infinity,
  };
}

/** Energy ratio (dB) of the side signal (L − R)/2 to the mid (L + R)/2, optionally within a band. */
export function sideToMidDb(L: Samples, R: Samples): number {
  let m = 0;
  let s = 0;
  for (let i = 0; i < L.length; i++) {
    const a = 0.5 * (L[i] + R[i]);
    const b = 0.5 * (L[i] - R[i]);
    m += a * a;
    s += b * b;
  }
  return 10 * Math.log10(Math.max(s, 1e-30) / Math.max(m, 1e-30));
}
