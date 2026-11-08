/**
 * Loudness meter ('sb-loudness'): ITU-R BS.1770-4 / EBU R128 measurement of
 * the final output, in an AudioWorklet (live contexts only).
 *
 *  - K-weighting: the BS.1770 pre-filter (high shelf, +4 dB) and RLB
 *    high-pass, recomputed for the context's sample rate from their analog
 *    prototypes (the 48 kHz coefficients match the standard's table).
 *  - Mean squares are summed over 100 ms sub-blocks (channel weights 1.0 for
 *    left and right). Momentary = last 4 sub-blocks (400 ms), short-term =
 *    last 30 (3 s). Loudness = −0.691 + 10·log10(Σ channel mean squares).
 *  - Integrated: 400 ms gating blocks every 100 ms (75 % overlap), absolute
 *    gate −70 LUFS, relative gate −10 LU below the absolute-gated mean. Block
 *    powers are kept in a 0.01 LU histogram, so memory stays constant over
 *    any session length.
 *  - True peak: 4x oversampling — the samples themselves plus windowed-sinc
 *    (Kaiser) interpolation at ¼, ½ and ¾ between them — max since reset,
 *    in dBTP.
 *
 * The coefficients are computed in TypeScript (`kWeightingCoefs`,
 * `truePeakKernels`) and passed in processorOptions, so the offline
 * analysis in src/render/loudness.ts uses exactly the same filters.
 * Readings are posted every sub-block (10 per second) as
 * { m, s, i, tp, pk } (LUFS / dBTP, −Infinity for silence; pk = the highest
 * sample |x| of the last 3 s, linear); posting 'reset' restarts the
 * integrated and true-peak measurement.
 */

export const LOUDNESS_PROCESSOR_NAME = 'sb-loudness';

/** Sub-block length (s): the gating hop and the reporting period. */
export const LOUDNESS_SUBBLOCK_S = 0.1;
export const LOUDNESS_ABS_GATE = -70;
export const LOUDNESS_REL_GATE = -10;
/** Histogram range for gated blocks (LUFS). */
export const LOUDNESS_HIST_MIN = -70;
export const LOUDNESS_HIST_MAX = 10;
export const LOUDNESS_HIST_STEP = 0.01;
/** Half-length (taps on each side) of the true-peak interpolators. */
export const TRUE_PEAK_HALF_TAPS = 16;

/** Biquad as [b0, b1, b2, a1, a2] (a0 = 1). */
export type Biquad = [number, number, number, number, number];

/** BS.1770 K-weighting at `sampleRate`: [pre-filter (shelf), RLB high-pass]. */
export function kWeightingCoefs(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf (prototype from libebur128, matching the standard at 48 kHz).
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  ];
  // Stage 2: RLB high-pass.
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, hp];
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Interpolation kernels for the true-peak meter: for each fraction ¼, ½, ¾
 * a windowed sinc over 2·half taps, applied to x[n−2·half+1 .. n] to give the
 * value at (n − half + fraction). Each kernel sums to 1.
 */
export function truePeakKernels(half: number = TRUE_PEAK_HALF_TAPS, beta = 6): number[][] {
  const out: number[][] = [];
  const len = 2 * half;
  const i0b = besselI0(beta);
  for (const frac of [0.25, 0.5, 0.75]) {
    const k: number[] = [];
    let sum = 0;
    for (let j = 0; j < len; j++) {
      // Tap j multiplies x[n − len + 1 + j]; its time relative to the target point.
      const t = j - (half - 1) - frac;
      const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = t / half;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      k.push(s * w);
      sum += s * w;
    }
    out.push(k.map((v) => v / sum));
  }
  return out;
}

/** Loudness (LUFS) of a summed channel mean square; −Infinity for silence. */
export function lufs(power: number): number {
  return power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;
}

export interface LoudnessProcessorOptions {
  kw: [Biquad, Biquad];
  tp: number[][];
  /** Post readings to the main thread. */
  report: boolean;
}

export function loudnessProcessorOptions(sampleRate: number, report: boolean): LoudnessProcessorOptions {
  return { kw: kWeightingCoefs(sampleRate), tp: truePeakKernels(), report };
}

export const LOUDNESS_WORKLET_SOURCE = /* js */ `
const SB_LU_SUB = ${LOUDNESS_SUBBLOCK_S};
const SB_LU_ABS = ${LOUDNESS_ABS_GATE};
const SB_LU_REL = ${LOUDNESS_REL_GATE};
const SB_LU_HMIN = ${LOUDNESS_HIST_MIN};
const SB_LU_HMAX = ${LOUDNESS_HIST_MAX};
const SB_LU_HSTEP = ${LOUDNESS_HIST_STEP};

function sbLufs(power) {
  return power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;
}

class SbLoudnessProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.kw = o.kw;
    this.tp = (o.tp || []).map((k) => Float64Array.from(k));
    this.tpLen = this.tp.length ? this.tp[0].length : 0;
    // |interpolated value| <= l1 · max |samples in its window|: blocks that cannot beat the
    // current true peak skip the interpolation (the window spans this block and the last).
    this.tpL1 = 0;
    for (const k of this.tp) {
      let s = 0;
      for (let j = 0; j < k.length; j++) s += Math.abs(k[j]);
      if (s > this.tpL1) this.tpL1 = s;
    }
    this.prevMax = 0;
    this.report = !!o.report;
    this.subLen = Math.max(1, Math.round(SB_LU_SUB * sampleRate));
    this.bins = Math.ceil((SB_LU_HMAX - SB_LU_HMIN) / SB_LU_HSTEP) + 1;
    this.histCount = new Float64Array(this.bins);
    this.histSum = new Float64Array(this.bins);
    this.ring = new Float64Array(30);
    // Highest |sample| per sub-block over the short-term window.
    this.pkRing = new Float64Array(30);
    this.subMax = 0;
    // Filter states: [x1, x2, y1, y2] per stage per channel.
    this.st = [new Float64Array(8), new Float64Array(8)];
    // True-peak history per channel (ring of tpLen, doubled for contiguous reads).
    this.hist = [new Float64Array(this.tpLen * 2), new Float64Array(this.tpLen * 2)];
    this.hpos = 0;
    this.resetAll();
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'reset') this.resetMeasure();
      else if (e.data === 'stop') this.alive = false;
    };
  }

  resetAll() {
    this.ring.fill(0);
    this.pkRing.fill(0);
    this.subMax = 0;
    this.ringCount = 0;
    this.ringPos = 0;
    this.acc = 0;
    this.accN = 0;
    this.resetMeasure();
  }

  /** Integrated and true peak start again; momentary / short-term keep their windows. */
  resetMeasure() {
    this.histCount.fill(0);
    this.histSum.fill(0);
    this.blocks = 0;
    this.truePeak = 0;
    this.sinceReset = 0;
  }

  integrated() {
    let n = 0, sum = 0;
    for (let b = 0; b < this.bins; b++) {
      n += this.histCount[b];
      sum += this.histSum[b];
    }
    if (n === 0) return -Infinity;
    const rel = sbLufs(sum / n) + SB_LU_REL;
    let n2 = 0, sum2 = 0;
    for (let b = 0; b < this.bins; b++) {
      const c = this.histCount[b];
      if (c === 0) continue;
      if (sbLufs(this.histSum[b] / c) > rel) {
        n2 += c;
        sum2 += this.histSum[b];
      }
    }
    return n2 > 0 ? sbLufs(sum2 / n2) : -Infinity;
  }

  endSubBlock() {
    const power = this.acc / this.accN;
    this.acc = 0;
    this.accN = 0;
    this.ring[this.ringPos] = power;
    this.pkRing[this.ringPos] = this.subMax;
    this.subMax = 0;
    this.ringPos = (this.ringPos + 1) % 30;
    if (this.ringCount < 30) this.ringCount++;
    this.sinceReset++;
    const mean = (count) => {
      let s = 0;
      for (let k = 1; k <= count; k++) s += this.ring[(this.ringPos - k + 30) % 30];
      return s / count;
    };
    const m = mean(Math.min(4, this.ringCount));
    if (this.ringCount >= 4 && this.sinceReset >= 4) {
      const l = sbLufs(m);
      if (l > SB_LU_ABS) {
        let b = Math.floor((l - SB_LU_HMIN) / SB_LU_HSTEP);
        if (b < 0) b = 0;
        if (b >= this.bins) b = this.bins - 1;
        this.histCount[b] += 1;
        this.histSum[b] += m;
      }
    }
    if (this.report) {
      const tp = this.truePeak > 0 ? 20 * Math.log10(this.truePeak) : -Infinity;
      let pk = 0;
      for (let k = 0; k < this.ringCount; k++) if (this.pkRing[k] > pk) pk = this.pkRing[k];
      this.port.postMessage({ m: sbLufs(m), s: sbLufs(mean(this.ringCount)), i: this.integrated(), tp, pk });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
    const input = inputs[0] || [];
    const frames = output && output[0] ? output[0].length : 128;
    const kw = this.kw;
    const s1 = kw[0], s2 = kw[1];
    const len = this.tpLen;
    let tPeak = this.truePeak;
    let hpos = this.hpos;
    let blockMax = 0;
    for (let c = 0; c < Math.min(2, input.length); c++) {
      const chan = input[c];
      for (let i = 0; i < frames; i++) {
        const v = chan[i];
        const a = v < 0 ? -v : v;
        if (a > blockMax && a < 1e6) blockMax = a;
      }
    }
    const interpolate = len > 0 && Math.max(blockMax, this.prevMax) * this.tpL1 > tPeak;
    this.prevMax = blockMax;
    for (let i = 0; i < frames; i++) {
      let sq = 0;
      for (let c = 0; c < 2; c++) {
        const chan = input.length > c ? input[c] : input.length === 1 ? input[0] : null;
        let x = chan ? chan[i] : 0;
        if (!(x > -1e6 && x < 1e6)) x = 0;
        // K-weighting, direct form I.
        const st = this.st[c];
        const y1 = s1[0] * x + s1[1] * st[0] + s1[2] * st[1] - s1[3] * st[2] - s1[4] * st[3];
        st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y1;
        const y2 = s2[0] * y1 + s2[1] * st[4] + s2[2] * st[5] - s2[3] * st[6] - s2[4] * st[7];
        st[5] = st[4]; st[4] = y1; st[7] = st[6]; st[6] = y2;
        sq += y2 * y2;
        // True peak.
        const ax = x < 0 ? -x : x;
        if (ax > tPeak) tPeak = ax;
        if (ax > this.subMax) this.subMax = ax;
        if (len > 0) {
          const h = this.hist[c];
          h[hpos] = x;
          h[hpos + len] = x;
          if (!interpolate) continue;
          const base = hpos + 1;
          for (let f = 0; f < 3; f++) {
            const k = this.tp[f];
            let v = 0;
            for (let j = 0; j < len; j++) v += k[j] * h[base + j];
            const av = v < 0 ? -v : v;
            if (av > tPeak) tPeak = av;
          }
        }
      }
      if (len > 0) hpos = (hpos + 1) % len;
      this.acc += sq;
      this.accN++;
      if (this.accN >= this.subLen) {
        this.truePeak = tPeak;
        this.endSubBlock();
        tPeak = this.truePeak;
      }
    }
    this.hpos = hpos;
    this.truePeak = tPeak;
    for (const st of this.st) for (let k = 0; k < 8; k++) if (st[k] < 1e-20 && st[k] > -1e-20) st[k] = 0;
    return this.alive;
  }
}

try {
  registerProcessor('${LOUDNESS_PROCESSOR_NAME}', SbLoudnessProcessor);
} catch (err) {
  if (!err || err.name !== 'NotSupportedError') throw err;
}
`;
