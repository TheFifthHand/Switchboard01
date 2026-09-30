/**
 * Output limiter: a stereo-linked look-ahead peak limiter that runs as an
 * AudioWorkletProcessor, plus the curve for the safety clipper that follows it.
 *
 * Algorithm (per sample frame n, all channels linked):
 *   need[n] = |x[n]| > ceiling ? ceiling / |x[n]| : 1       (required gain)
 *   hold[n] = min(need[n-L+1 .. n])                         (sliding-window minimum)
 *   env[n]  = hold[n] if it is lower (instant attack), else a one-pole release toward hold[n]
 *   gain[n] = mean(env[n-L+1 .. n])                         (box filter = linear attack ramp)
 *   y[n]    = x[n-L+1] * gain[n]                            (L-1 samples of look-ahead delay)
 *
 * Every env value averaged into gain[n] is <= need[n-L+1] because each hold
 * window contains sample n-L+1, so |y[n]| <= ceiling holds by construction:
 * the gain reduction is fully in place before the peak leaves the delay line,
 * and it arrives as a smooth ramp over the look-ahead time instead of a jump.
 * The gain never exceeds 1.
 *
 * The processor source is a plain JS string so the engine can load it through
 * a Blob URL on any (Offline)AudioContext without a separate build step.
 */
import { OUTPUT_CEILING } from '../contracts';

export const LIMITER_PROCESSOR_NAME = 'sb-limiter';

/** Look-ahead / attack time. */
export const LIMITER_LOOKAHEAD_MS = 5;
/** Release time constant. */
export const LIMITER_RELEASE_MS = 100;
/** Gain-reduction reports per second sent to the main thread (live contexts only). */
export const LIMITER_REPORT_HZ = 20;

/** Options passed as `processorOptions` when creating the AudioWorkletNode. */
export interface LimiterProcessorOptions {
  ceiling: number;
  lookaheadMs: number;
  releaseMs: number;
  /** Offline renders skip the gain-reduction messages. */
  offline: boolean;
}

/**
 * Output latency the limiter adds (its look-ahead delay), in sample frames.
 * Everything leaving the engine is late by this amount (~5 ms).
 */
/**
 * Constant output latency of a part in the default patch, in frames: the
 * master limiter's look-ahead plus the Drive module's 2x-oversampling delay
 * (128 frames in Chromium; the Drive keeps dry and wet aligned so it is the
 * same at every setting). Measured in tests/browser/realEngine.test.ts. Every
 * part with a Drive in its chain is delayed by exactly this much, live and in
 * exports; a part patched without its Drive is 128 frames (~2.7 ms) earlier.
 */
export function engineLatencyFrames(sampleRate: number): number {
  return limiterLatencyFrames(sampleRate) + 128;
}

export function limiterLatencyFrames(sampleRate: number): number {
  return Math.max(1, Math.round(LIMITER_LOOKAHEAD_MS * 0.001 * sampleRate)) - 1;
}

export function limiterProcessorOptions(offline: boolean): LimiterProcessorOptions {
  return { ceiling: OUTPUT_CEILING, lookaheadMs: LIMITER_LOOKAHEAD_MS, releaseMs: LIMITER_RELEASE_MS, offline };
}

export const LIMITER_WORKLET_SOURCE = /* js */ `
const SB_LIMITER_NAME = ${JSON.stringify(LIMITER_PROCESSOR_NAME)};
const SB_LIMITER_REPORT_HZ = ${LIMITER_REPORT_HZ};

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
    // Look-ahead delay lines (stereo).
    this.delayL = new Float32Array(L);
    this.delayR = new Float32Array(L);
    this.pos = 0;
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
    const cap = L + 1;
    const dqVal = this.dqVal;
    const dqIdx = this.dqIdx;
    const box = this.box;
    const delayL = this.delayL;
    const delayR = this.delayR;
    const rel = this.release;
    let pos = this.pos;
    let n = this.n;
    let head = this.dqHead;
    let count = this.dqCount;
    let env = this.env;
    let boxSum = this.boxSum;
    let minGain = this.minGain;

    for (let i = 0; i < frames; i++) {
      let l = inL ? inL[i] : 0;
      let r = inR ? inR[i] : 0;
      // Non-finite input (a misbehaving upstream node) must never reach the output.
      if (!(l > -1e9 && l < 1e9)) l = 0;
      if (!(r > -1e9 && r < 1e9)) r = 0;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      const peak = al > ar ? al : ar;
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
      boxSum += env - box[pos];
      box[pos] = env;

      // Delay line: write x[n], read x[n-L+1] (the oldest entry after the write).
      delayL[pos] = l;
      delayR[pos] = r;
      pos++;
      if (pos === L) {
        pos = 0;
        // Re-sum once per wrap so floating-point drift cannot accumulate.
        let s = 0;
        for (let k = 0; k < L; k++) s += box[k];
        boxSum = s;
      }
      let g = boxSum / L;
      if (g > 1) g = 1;
      if (g < minGain) minGain = g;

      let yl = delayL[pos] * g;
      let yr = delayR[pos] * g;
      // Guard against float rounding only; the gain already keeps |y| <= c.
      if (yl > c) yl = c; else if (yl < -c) yl = -c;
      if (yr > c) yr = c; else if (yr < -c) yr = -c;
      outL[i] = yl;
      if (outR) outR[i] = yr;
      n++;
    }
    for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);

    this.pos = pos;
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
