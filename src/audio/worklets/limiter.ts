/**
 * Output limiter: a stereo-linked look-ahead true-peak limiter that runs as
 * an AudioWorkletProcessor, plus the curve for the safety clipper that
 * follows it.
 *
 * Detection is true peak (ITU-R BS.1770, 4× oversampled): the peak of frame
 * m is the largest of |x[m]| and the windowed-sinc interpolations at m + ¼,
 * ½ and ¾ (the kernels of the loudness meter, `truePeakKernels`), on every
 * channel. The interpolator looks H = LIMITER_TP_HALF_TAPS frames ahead, so
 * the peak of frame m is known at frame m + H.
 *
 * Algorithm (per sample frame n, all channels linked; m = n − H):
 *   need[n] = peak(m) > ceiling ? ceiling / peak(m) : 1     (required gain)
 *   hold[n] = min(need[n-L+1 .. n])                         (sliding-window minimum)
 *   env[n]  = hold[n] if it is lower (instant attack), else a one-pole release toward hold[n]
 *   gain[n] = mean(env[n-L+1 .. n])                         (box filter = linear attack ramp)
 *   y[n]    = x[n-H-L+1] * gain[n]                          (H+L-1 samples of look-ahead delay)
 *
 * Every env value averaged into gain[n] is <= need[n-L+1] because each hold
 * window contains frame n-L+1, whose need covers x[n-H-L+1] and the points
 * between it and the next sample, so |y[n]| <= ceiling holds by
 * construction, between samples too (to within the slow change of the gain
 * from one sample to the next): the gain reduction is fully in place before
 * the peak leaves the delay line, and it arrives as a smooth ramp over the
 * look-ahead time instead of a jump. The gain never exceeds 1.
 *
 * Interpolation only runs for blocks that could hold a peak over the
 * ceiling (max |x| over the block and the one before, times the kernels'
 * L1 norm, above it); quieter blocks cost what a sample-peak limiter costs.
 *
 * The processor source is a plain JS string so the engine can load it through
 * a Blob URL on any (Offline)AudioContext without a separate build step.
 */
import { OUTPUT_CEILING } from '../contracts';
import { truePeakKernels } from './loudness';

export const LIMITER_PROCESSOR_NAME = 'sb-limiter';

/** Look-ahead / attack time. */
export const LIMITER_LOOKAHEAD_MS = 5;
/** Release time constant. */
export const LIMITER_RELEASE_MS = 100;
/** Gain-reduction reports per second sent to the main thread (live contexts only). */
export const LIMITER_REPORT_HZ = 20;
/** Half-length of the true-peak interpolators (frames): their look-ahead, added to the limiter's delay. */
export const LIMITER_TP_HALF_TAPS = 16;
/**
 * Interpolated points are taken this much (0.02 dB) higher than computed, so
 * the ceiling holds against any other good 4× estimator (their kernels
 * differ by a few thousandths of a dB); sample peaks are exact.
 */
export const LIMITER_TP_MARGIN = Math.pow(10, 0.02 / 20);

/** Options passed as `processorOptions` when creating the AudioWorkletNode. */
export interface LimiterProcessorOptions {
  ceiling: number;
  lookaheadMs: number;
  releaseMs: number;
  /** Offline renders skip the gain-reduction messages. */
  offline: boolean;
  /** True-peak interpolation kernels (¼, ½, ¾; 2·LIMITER_TP_HALF_TAPS taps each); empty = sample peak. */
  tp: number[][];
}

/**
 * Constant output latency of a part in the default patch, in frames: the
 * master limiter's look-ahead (true-peak interpolators included) plus the
 * Drive module's 2x-oversampling delay (128 frames in Chromium; the Drive
 * keeps dry and wet aligned so it is the same at every setting). Measured in
 * tests/browser/realEngine.test.ts. Every part with a Drive in its chain is
 * delayed by exactly this much, live and in exports; a part patched without
 * its Drive is 128 frames (~2.7 ms) earlier. For the latency of a given
 * project (what an export may trim) use AudioEngine.outputLatencyFrames().
 */
export function engineLatencyFrames(sampleRate: number): number {
  return limiterLatencyFrames(sampleRate) + 128;
}

/**
 * Output latency the limiter adds, in sample frames: its look-ahead plus the
 * true-peak interpolators' half length. Everything leaving the engine is
 * late by this amount (~5.3 ms).
 */
export function limiterLatencyFrames(sampleRate: number): number {
  return Math.max(1, Math.round(LIMITER_LOOKAHEAD_MS * 0.001 * sampleRate)) - 1 + LIMITER_TP_HALF_TAPS;
}

let tpKernels: number[][] | null = null;

/** Processor options for the output limiter (true-peak detection, live and offline alike). */
export function limiterProcessorOptions(offline: boolean): LimiterProcessorOptions {
  tpKernels ??= truePeakKernels(LIMITER_TP_HALF_TAPS);
  return { ceiling: OUTPUT_CEILING, lookaheadMs: LIMITER_LOOKAHEAD_MS, releaseMs: LIMITER_RELEASE_MS, offline, tp: tpKernels };
}

export const LIMITER_WORKLET_SOURCE = /* js */ `
const SB_LIMITER_NAME = ${JSON.stringify(LIMITER_PROCESSOR_NAME)};
const SB_LIMITER_REPORT_HZ = ${LIMITER_REPORT_HZ};
const SB_LIMITER_TP_MARGIN = ${LIMITER_TP_MARGIN};

function sbNum(v, fallback, lo, hi) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

class SbLimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ceiling = sbNum(o.ceiling, ${OUTPUT_CEILING}, 0.01, 1);
    const lookaheadMs = sbNum(o.lookaheadMs, ${LIMITER_LOOKAHEAD_MS}, 0.5, 50);
    const releaseMs = sbNum(o.releaseMs, ${LIMITER_RELEASE_MS}, 5, 2000);
    this.offline = !!o.offline;
    const L = Math.max(1, Math.round(lookaheadMs * 0.001 * sampleRate));
    this.L = L;
    this.release = 1 - Math.exp(-1 / (releaseMs * 0.001 * sampleRate));
    // True-peak interpolators (empty: sample-peak detection).
    const tp = Array.isArray(o.tp) ? o.tp.filter((k) => Array.isArray(k) && k.length > 0 && k.length % 2 === 0) : [];
    this.tp = tp.map((k) => Float64Array.from(k));
    this.tpLen = this.tp.length ? this.tp[0].length : 0;
    if (this.tp.some((k) => k.length !== this.tpLen)) {
      this.tp = [];
      this.tpLen = 0;
    }
    this.half = this.tpLen / 2;
    // |interpolated value| <= l1 · max |samples in its window|.
    this.l1 = 0;
    for (const k of this.tp) {
      let s = 0;
      for (let j = 0; j < k.length; j++) s += Math.abs(k[j]);
      if (s > this.l1) this.l1 = s;
    }
    // History for the interpolators (ring of tpLen per channel, doubled for contiguous reads).
    this.histL = new Float64Array(Math.max(1, this.tpLen * 2));
    this.histR = new Float64Array(Math.max(1, this.tpLen * 2));
    this.hpos = 0;
    this.prevMax = 0;
    // Look-ahead delay lines (stereo): the interpolators' half length plus L.
    const D = L + this.half;
    this.D = D;
    this.delayL = new Float32Array(D);
    this.delayR = new Float32Array(D);
    this.dpos = 0;
    // Monotonic deque for the sliding-window minimum of the required gain.
    this.dqVal = new Float64Array(L + 1);
    this.dqIdx = new Float64Array(L + 1);
    this.dqHead = 0;
    this.dqCount = 0;
    this.n = 0;
    // Release envelope and its box-filter history.
    this.env = 1;
    this.box = new Float64Array(L).fill(1);
    this.boxSum = L;
    this.bpos = 0;
    // Metering.
    this.reportEvery = Math.max(128, Math.round(sampleRate / SB_LIMITER_REPORT_HZ));
    this.reportCount = 0;
    this.minGain = 1;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.alive = false;
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return this.alive;
    const input = inputs[0] || [];
    const frames = output[0].length;
    const inL = input.length > 0 ? input[0] : null;
    const inR = input.length > 1 ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const c = this.ceiling;
    const L = this.L;
    const D = this.D;
    const cap = L + 1;
    const dqVal = this.dqVal;
    const dqIdx = this.dqIdx;
    const box = this.box;
    const delayL = this.delayL;
    const delayR = this.delayR;
    const rel = this.release;
    const len = this.tpLen;
    const half = this.half;
    const hL = this.histL;
    const hR = this.histR;
    const kernels = this.tp;
    let dpos = this.dpos;
    let bpos = this.bpos;
    let hpos = this.hpos;
    let n = this.n;
    let head = this.dqHead;
    let count = this.dqCount;
    let env = this.env;
    let boxSum = this.boxSum;
    let minGain = this.minGain;

    // Interpolate only when a point between samples could exceed the ceiling.
    let blockMax = 0;
    for (let i = 0; i < frames; i++) {
      const a = inL ? Math.abs(inL[i]) : 0;
      const b = inR ? Math.abs(inR[i]) : 0;
      if (a > blockMax && a < 1e9) blockMax = a;
      if (b > blockMax && b < 1e9) blockMax = b;
    }
    const interpolate = len > 0 && Math.max(blockMax, this.prevMax) * this.l1 * SB_LIMITER_TP_MARGIN > c;
    this.prevMax = blockMax;

    for (let i = 0; i < frames; i++) {
      let l = inL ? inL[i] : 0;
      let r = inR ? inR[i] : 0;
      // Non-finite input (a misbehaving upstream node) must never reach the output.
      if (!(l > -1e9 && l < 1e9)) l = 0;
      if (!(r > -1e9 && r < 1e9)) r = 0;

      // Peak of frame m = n - half: its samples and the points between it and the next.
      let peak;
      if (len > 0) {
        hL[hpos] = l;
        hL[hpos + len] = l;
        hR[hpos] = r;
        hR[hpos + len] = r;
        const sl = hL[hpos + half];
        const sr = hR[hpos + half];
        const al = sl < 0 ? -sl : sl;
        const ar = sr < 0 ? -sr : sr;
        peak = al > ar ? al : ar;
        if (interpolate) {
          const base = hpos + 1;
          for (let f = 0; f < kernels.length; f++) {
            const k = kernels[f];
            let vl = 0;
            let vr = 0;
            for (let j = 0; j < len; j++) {
              vl += k[j] * hL[base + j];
              vr += k[j] * hR[base + j];
            }
            if (vl < 0) vl = -vl;
            if (vr < 0) vr = -vr;
            const v = (vl > vr ? vl : vr) * SB_LIMITER_TP_MARGIN;
            if (v > peak) peak = v;
          }
        }
        hpos++;
        if (hpos === len) hpos = 0;
      } else {
        const al = l < 0 ? -l : l;
        const ar = r < 0 ? -r : r;
        peak = al > ar ? al : ar;
      }
      const need = peak > c ? c / peak : 1;

      // Sliding-window minimum over the last L required gains.
      while (count > 0) {
        const back = (head + count - 1) % cap;
        if (dqVal[back] >= need) count--;
        else break;
      }
      const slot = (head + count) % cap;
      dqVal[slot] = need;
      dqIdx[slot] = n;
      count++;
      while (dqIdx[head] <= n - L) {
        head = (head + 1) % cap;
        count--;
      }
      const hold = dqVal[head];

      // Instant attack, smooth release (env never rises above hold).
      if (hold < env) env = hold;
      else env += (hold - env) * rel;

      // Box filter over the last L envelope values.
      boxSum += env - box[bpos];
      box[bpos] = env;
      bpos++;
      if (bpos === L) {
        bpos = 0;
        // Re-sum once per wrap so floating-point drift cannot accumulate.
        let s = 0;
        for (let k = 0; k < L; k++) s += box[k];
        boxSum = s;
      }
      let g = boxSum / L;
      if (g > 1) g = 1;
      if (g < minGain) minGain = g;

      // Delay line: write x[n], read x[n-D+1] (the oldest entry after the write).
      delayL[dpos] = l;
      delayR[dpos] = r;
      dpos++;
      if (dpos === D) dpos = 0;
      let yl = delayL[dpos] * g;
      let yr = delayR[dpos] * g;
      // Guard against float rounding only; the gain already keeps |y| <= c.
      if (yl > c) yl = c; else if (yl < -c) yl = -c;
      if (yr > c) yr = c; else if (yr < -c) yr = -c;
      outL[i] = yl;
      if (outR) outR[i] = yr;
      n++;
    }
    for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);

    this.dpos = dpos;
    this.bpos = bpos;
    this.hpos = hpos;
    this.n = n;
    this.dqHead = head;
    this.dqCount = count;
    this.env = env;
    this.boxSum = boxSum;

    this.reportCount += frames;
    if (this.reportCount >= this.reportEvery) {
      this.reportCount = 0;
      if (!this.offline) this.port.postMessage(minGain < 1 ? -20 * Math.log10(minGain) : 0);
      minGain = 1;
    }
    this.minGain = minGain;
    return this.alive;
  }
}

try {
  registerProcessor(SB_LIMITER_NAME, SbLimiterProcessor);
} catch (err) {
  // Already registered in this context (a second load): keep the first definition.
  if (!err || err.name !== 'NotSupportedError') throw err;
}
`;

/** Number of points in the safety clipper curve (odd, so 0 maps exactly to 0). */
export const SAFETY_CURVE_POINTS = 8193;

/**
 * Transfer curve for the final WaveShaperNode: identity inside
 * +/-ceiling, flat beyond it. The WaveShaper interpolates linearly between
 * points and holds the end values for |x| > 1, so |output| <= ceiling for any
 * input, and signals already under the ceiling pass unchanged.
 */
export function safetyClipperCurve(ceiling: number = OUTPUT_CEILING, points: number = SAFETY_CURVE_POINTS): Float32Array<ArrayBuffer> {
  const n = Math.max(4097, points | 1);
  const curve = new Float32Array(n);
  const half = (n - 1) / 2;
  const c = Math.fround(ceiling) > ceiling ? ceiling * (1 - 1e-7) : ceiling;
  for (let i = 0; i < n; i++) {
    const x = (i - half) / half;
    curve[i] = x > c ? c : x < -c ? -c : x;
  }
  return curve;
}
