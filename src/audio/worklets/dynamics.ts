/**
 * Dynamics processors for the insert effects (AudioWorklet, loaded from a
 * Blob URL like the limiter and crusher):
 *
 * 'sb-compressor' — feed-forward, stereo-linked peak compressor in the log
 *   domain (Giannoulis, Massberg & Reiss, "Digital Dynamic Range Compressor
 *   Design", 2012: soft-knee gain computer, smooth decoupled attack/release
 *   on the gain reduction). No look-ahead, so no latency. Make-up gain and a
 *   parallel dry/wet mix are applied inside the processor:
 *     y = x · [(1 − mix) + mix · 10^((makeup − GR)/20)]
 *   Ratio 1 (or a signal below threshold − knee/2) gives GR = 0 exactly.
 *
 * 'sb-gate' — stereo-linked noise gate: a peak envelope follower (instant
 *   attack, 5 ms decay) opens the gate above the threshold; it closes once
 *   the level has stayed HYSTERESIS dB below the threshold for HOLD ms. The
 *   gain glides to 1 with the Attack time constant and down to −Depth dB with
 *   the Release time constant, so it never clicks. Depth 0 leaves the sound
 *   untouched.
 *
 * Every parameter is an a-rate AudioParam (smoothed from the main thread);
 * the threshold of the gate takes modulation in dB directly. A k-rate
 * "flush" counter resets the processor state (Mute All) sample-accurately,
 * live and offline. The processors keep themselves alive until the node
 * posts 'dispose'.
 *
 * With processorOptions { report: true } (live engines) each processor posts
 * its gain reduction in dB (the most of the last report period, >= 0) at
 * DYNAMICS_REPORT_HZ, for the meters: the compressor's computed reduction
 * (before make-up and Mix), the gate's attenuation. A processor that has
 * nothing to reduce posts one 0 and then stays quiet until it does.
 */
import { FLUSH_PARAM_JS, WORKLET_COMMON_JS } from './common';

export const COMPRESSOR_PROCESSOR_NAME = 'sb-compressor';
export const GATE_PROCESSOR_NAME = 'sb-gate';

/** Soft-knee width of the insert compressor (dB). */
export const COMPRESSOR_KNEE_DB = 6;
/** The gate closes this far below the threshold (dB). */
export const GATE_HYSTERESIS_DB = 4;
/** The gate stays open this long after the level drops (ms). */
export const GATE_HOLD_MS = 15;
/** Decay of the gate's peak detector (seconds). */
export const GATE_DETECTOR_DECAY = 0.005;
/** Gain-reduction reports per second (live engines). */
export const DYNAMICS_REPORT_HZ = 30;

export interface DynamicsProcessorOptions {
  /** Post gain-reduction readings to the main thread. */
  report: boolean;
}

export const DYNAMICS_WORKLET_SOURCE = /* js */ `
${WORKLET_COMMON_JS}
const SB_COMP_KNEE = ${COMPRESSOR_KNEE_DB};
const SB_DYN_REPORT_HZ = ${DYNAMICS_REPORT_HZ};

/** Gain-reduction reporting shared by the dynamics processors. */
class SbReporter {
  constructor(port, options) {
    const o = (options && options.processorOptions) || {};
    this.port = port;
    this.on = !!o.report;
    this.every = Math.max(128, Math.round(sampleRate / SB_DYN_REPORT_HZ));
    this.count = 0;
    this.max = 0;
    this.last = -1;
  }
  /** Account for a block of n frames whose largest reduction was db. */
  block(n, db) {
    if (!this.on) return;
    if (db > this.max) this.max = db;
    this.count += n;
    if (this.count < this.every) return;
    this.count = 0;
    const v = this.max > 1e-3 ? this.max : 0;
    this.max = 0;
    if (v === 0 && this.last === 0) return;
    this.last = v;
    this.port.postMessage(v);
  }
}

class SbCompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -60, maxValue: 0, automationRate: 'a-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 20, automationRate: 'a-rate' },
      { name: 'attack', defaultValue: 10, minValue: 0.1, maxValue: 100, automationRate: 'a-rate' },
      { name: 'release', defaultValue: 150, minValue: 10, maxValue: 1000, automationRate: 'a-rate' },
      { name: 'makeup', defaultValue: 0, minValue: 0, maxValue: 24, automationRate: 'a-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      ${FLUSH_PARAM_JS},
    ];
  }

  constructor(options) {
    super();
    this.gr = 0;
    this.reporter = new SbReporter(this.port, options);
    this.flushSeen = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'dispose') this.alive = false;
    };
  }

  process(inputs, outputs, p) {
    const output = outputs[0];
    if (!output || output.length === 0) return this.alive;
    const oL = output[0];
    const oR = output.length > 1 ? output[1] : null;
    const n = oL.length;
    if (p.flush[0] !== this.flushSeen) {
      this.flushSeen = p.flush[0];
      this.gr = 0;
    }
    const input = inputs[0];
    const iL = input && input.length > 0 ? input[0] : null;
    const iR = input && input.length > 1 ? input[1] : iL;
    const thrA = p.threshold, ratA = p.ratio, attA = p.attack, relA = p.release, mkA = p.makeup, mixA = p.mix;
    const varying = thrA.length > 1 || ratA.length > 1 || attA.length > 1 || relA.length > 1 || mkA.length > 1;
    let thr = 0, slope = 0, aA = 0, aR = 0, mk = 0;
    const setup = (i) => {
      thr = sbAt(thrA, i);
      const ratio = Math.max(1, sbAt(ratA, i));
      slope = 1 - 1 / ratio;
      aA = sbPole(Math.max(1e-4, sbAt(attA, i)) * 0.001);
      aR = sbPole(Math.max(1e-3, sbAt(relA, i)) * 0.001);
      mk = sbAt(mkA, i);
    };
    setup(0);
    let gr = this.gr;
    let grMax = 0;
    const halfKnee = SB_COMP_KNEE / 2;
    for (let i = 0; i < n; i++) {
      if (varying && i > 0) setup(i);
      const l = iL ? sbIn(iL[i]) : 0;
      const r = iR ? sbIn(iR[i]) : 0;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      const pk = al > ar ? al : ar;
      let target = 0;
      if (slope > 0 && pk > 1e-6) {
        const over = 20 * Math.log10(pk) - thr;
        if (over >= halfKnee) target = slope * over;
        else if (over > -halfKnee) {
          const t = over + halfKnee;
          target = (slope * t * t) / (2 * SB_COMP_KNEE);
        }
      }
      gr = target > gr ? target + (gr - target) * aA : target + (gr - target) * aR;
      if (gr > grMax) grMax = gr;
      const mix = sbAt(mixA, i);
      const g = mk === 0 && gr === 0 ? 1 : sbDbToGain(mk - gr);
      const w = mix === 1 ? g : 1 - mix + mix * g;
      oL[i] = l * w;
      if (oR) oR[i] = r * w;
    }
    this.gr = gr < 1e-9 ? 0 : gr;
    this.reporter.block(n, grMax);
    for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);
    return this.alive;
  }
}

const SB_GATE_HYST = ${GATE_HYSTERESIS_DB};
const SB_GATE_HOLD = ${GATE_HOLD_MS} * 0.001;
const SB_GATE_DETECTOR = ${GATE_DETECTOR_DECAY};

class SbGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -80, maxValue: 0, automationRate: 'a-rate' },
      { name: 'range', defaultValue: 60, minValue: 0, maxValue: 80, automationRate: 'a-rate' },
      { name: 'attack', defaultValue: 1, minValue: 0.1, maxValue: 50, automationRate: 'a-rate' },
      { name: 'release', defaultValue: 80, minValue: 5, maxValue: 1000, automationRate: 'a-rate' },
      ${FLUSH_PARAM_JS},
    ];
  }

  constructor(options) {
    super();
    this.reporter = new SbReporter(this.port, options);
    this.env = 0;
    this.open = false;
    this.hold = 0;
    this.g = 1;
    this.holdFrames = Math.max(1, Math.round(SB_GATE_HOLD * sampleRate));
    this.aDet = sbPole(SB_GATE_DETECTOR);
    this.flushSeen = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'dispose') this.alive = false;
    };
  }

  process(inputs, outputs, p) {
    const output = outputs[0];
    if (!output || output.length === 0) return this.alive;
    const oL = output[0];
    const oR = output.length > 1 ? output[1] : null;
    const n = oL.length;
    if (p.flush[0] !== this.flushSeen) {
      this.flushSeen = p.flush[0];
      this.env = 0;
      this.open = false;
      this.hold = 0;
    }
    const input = inputs[0];
    const iL = input && input.length > 0 ? input[0] : null;
    const iR = input && input.length > 1 ? input[1] : iL;
    const thrA = p.threshold, rangeA = p.range, attA = p.attack, relA = p.release;
    const varying = rangeA.length > 1 || attA.length > 1 || relA.length > 1;
    let floor = 1, aA = 0, aR = 0;
    const setup = (i) => {
      floor = sbDbToGain(-sbAt(rangeA, i));
      aA = sbPole(Math.max(1e-4, sbAt(attA, i)) * 0.001);
      aR = sbPole(Math.max(1e-3, sbAt(relA, i)) * 0.001);
    };
    setup(0);
    let env = this.env, open = this.open, hold = this.hold, g = this.g;
    let gMin = 1;
    const aDet = this.aDet;
    for (let i = 0; i < n; i++) {
      if (varying && i > 0) setup(i);
      const l = iL ? sbIn(iL[i]) : 0;
      const r = iR ? sbIn(iR[i]) : 0;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      const pk = al > ar ? al : ar;
      env = pk > env ? pk : env * aDet;
      const lv = env > 1e-7 ? 20 * Math.log10(env) : -140;
      const thr = sbAt(thrA, i);
      if (lv > thr) {
        open = true;
        hold = this.holdFrames;
      } else if (open && lv < thr - SB_GATE_HYST) {
        if (hold > 0) hold--;
        else open = false;
      }
      const target = open ? 1 : floor;
      g = target > g ? target + (g - target) * aA : target + (g - target) * aR;
      if (g < gMin) gMin = g;
      oL[i] = l * g;
      if (oR) oR[i] = r * g;
    }
    this.env = sbTidy(env);
    this.open = open;
    this.hold = hold;
    this.g = g;
    this.reporter.block(n, gMin < 1 ? -20 * Math.log10(Math.max(1e-6, gMin)) : 0);
    for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);
    return this.alive;
  }
}

sbRegister('${COMPRESSOR_PROCESSOR_NAME}', SbCompressorProcessor);
sbRegister('${GATE_PROCESSOR_NAME}', SbGateProcessor);
`;
