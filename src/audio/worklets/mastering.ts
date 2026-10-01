/**
 * Mastering processor ('sb-mastering'): the dynamic and non-linear stages of
 * the master-bus chain, in signal order (the EQ and low cut before it, and
 * the Loudness gain after it, are native nodes, see modules/mastering.ts):
 *
 * 1. Glue — stereo-linked, peak-sensing bus compressor in the log domain
 *    (soft knee of 10 dB, smooth decoupled ballistics on the gain reduction,
 *    no look-ahead). The level detector holds peaks (instant rise, 50 ms
 *    fall) so the curve sees a waveform's peak level rather than its ripple:
 *    the amount of reduction then does not depend on the attack time, which
 *    only shapes the hits. Glue g sets threshold = −24·g dB and ratio = 1 + 3·g
 *    together; Punch sets the attack from 1 ms (0: hits are held down) to
 *    30 ms (1: the front of each hit gets through before the compressor
 *    reacts). Release is automatic: a fast (80 ms) envelope handles single
 *    hits, a slow follower (rises over 0.4 s, falls over 0.8 s) takes over on
 *    sustained compression, so long passages do not pump. Automatic make-up
 *    adds back the reduction the curve applies at GLUE_MAKEUP_REF_DB, which
 *    keeps a typical mix within about ±1.5 LU of its loudness at any Glue /
 *    Punch setting (measured on the starters). Glue 0 is exactly unity gain.
 *    Warmth's oversampling filters are all-pass when engaged: about 3.5
 *    samples of extra delay at low frequencies, nothing at Warmth 0.
 * 2. Warmth — saturation at 4x (two polyphase IIR half-band stages, see
 *    halfband.ts): a tanh curve whose pre-gain and blend rise with Warmth,
 *    level-compensated so a sine peaking at WARMTH_REF_LEVEL keeps its peak.
 *    The stage engages with a 10 ms crossfade when Warmth leaves 0 and
 *    disengages the same way when it returns to 0; at 0 the signal is not
 *    touched at all.
 * 3. Width and Mono Bass — mid/side: S' = S high-passed (12 dB/oct) at Mono
 *    Bass when that is above 20 Hz (crossfaded in), L' = L + (w·S' − S),
 *    R' = R − (w·S' − S). Width 1 with Mono Bass off is exactly the input.
 *
 * With every control neutral the processor outputs its input bit for bit,
 * so a project with neutral mastering renders exactly as without mastering.
 * Gain reduction is reported to the main thread (live contexts only).
 */
import { FLUSH_PARAM_JS, WORKLET_COMMON_JS } from './common';
import { HALFBAND_JS } from './halfband';

export const MASTERING_PROCESSOR_NAME = 'sb-mastering';

export const GLUE_MAX_THRESHOLD_DB = -24;
export const GLUE_MAX_RATIO = 4;
export const GLUE_KNEE_DB = 10;
/** Level at which the automatic make-up gain equals the static gain reduction. */
export const GLUE_MAKEUP_REF_DB = -11;
export const GLUE_RELEASE_MS = 80;
/** Fall time of the Glue's peak-hold level detector. */
export const GLUE_DETECTOR_MS = 50;
export const GLUE_SLOW_RISE_MS = 400;
export const GLUE_SLOW_FALL_MS = 800;
/** Warmth: a sine peaking here keeps its peak level. */
export const WARMTH_REF_LEVEL = 0.3;
/** Glue reports per second (live). */
export const MASTERING_REPORT_HZ = 20;

/** Glue attack for Punch 0..1: 1 ms .. 30 ms (exponential). */
export function glueAttackMs(punch: number): number {
  return Math.pow(30, Math.min(1, Math.max(0, punch)));
}

/** Static gain reduction (dB, >= 0) of the Glue curve for a detector level `levelDb`. */
export function glueStaticReduction(glue: number, levelDb: number): number {
  const g = Math.min(1, Math.max(0, glue));
  const thr = GLUE_MAX_THRESHOLD_DB * g;
  const slope = 1 - 1 / (1 + (GLUE_MAX_RATIO - 1) * g);
  const over = levelDb - thr;
  const half = GLUE_KNEE_DB / 2;
  if (slope <= 0 || over <= -half) return 0;
  if (over >= half) return slope * over;
  const t = over + half;
  return (slope * t * t) / (2 * GLUE_KNEE_DB);
}

export interface MasteringProcessorOptions {
  /** Post gain reduction to the main thread (live contexts). */
  report: boolean;
}

export const MASTERING_WORKLET_SOURCE = /* js */ `
${WORKLET_COMMON_JS}
${HALFBAND_JS}

const SB_GLUE_THR = ${GLUE_MAX_THRESHOLD_DB};
const SB_GLUE_RATIO = ${GLUE_MAX_RATIO};
const SB_GLUE_KNEE = ${GLUE_KNEE_DB};
const SB_GLUE_REF = ${GLUE_MAKEUP_REF_DB};
const SB_WARM_REF = ${WARMTH_REF_LEVEL};
const SB_REPORT_HZ = ${MASTERING_REPORT_HZ};

function sbGlueCurve(levelDb, thr, slope) {
  const over = levelDb - thr;
  const half = SB_GLUE_KNEE / 2;
  if (slope <= 0 || over <= -half) return 0;
  if (over >= half) return slope * over;
  const t = over + half;
  return (slope * t * t) / (2 * SB_GLUE_KNEE);
}

class SbMasteringProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'glue', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'punch', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'warmth', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'width', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' },
      { name: 'monoBass', defaultValue: 20, minValue: 20, maxValue: 400, automationRate: 'a-rate' },
      ${FLUSH_PARAM_JS},
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.report = !!o.report;
    this.reportEvery = Math.max(128, Math.round(sampleRate / SB_REPORT_HZ));
    this.reportCount = 0;
    this.maxGr = 0;
    this.aRel = sbPole(${GLUE_RELEASE_MS} * 0.001);
    this.aDet = sbPole(${GLUE_DETECTOR_MS} * 0.001);
    this.aSlowUp = sbPole(${GLUE_SLOW_RISE_MS} * 0.001);
    this.aSlowDn = sbPole(${GLUE_SLOW_FALL_MS} * 0.001);
    this.aFade = sbPole(0.01);
    this.os = [0, 1].map(() => ({
      up1: new SbHalfband(SB_HB_STEEP),
      up2: new SbHalfband(SB_HB_WIDE),
      dn2: new SbHalfband(SB_HB_WIDE),
      dn1: new SbHalfband(SB_HB_STEEP),
    }));
    this.reset();
    this.flushSeen = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'dispose') this.alive = false;
    };
  }

  reset() {
    this.det = 0;
    this.env1 = 0;
    this.env2 = 0;
    this.eng = 0;
    this.hpOn = 0;
    this.hp = [0, 0, 0, 0];
    for (const s of this.os) for (const k of ['up1', 'up2', 'dn2', 'dn1']) s[k].reset();
  }

  /** One sample through the 4x warmth stage for channel c. */
  warm(c, x, g, m, a) {
    const s = this.os[c];
    s.up1.up(x);
    const h0 = s.up1.o0, h1 = s.up1.o1;
    s.up2.up(h0);
    const q0 = s.up2.o0, q1 = s.up2.o1;
    s.up2.up(h1);
    const q2 = s.up2.o0, q3 = s.up2.o1;
    const t0 = q0 + a * (m * Math.tanh(g * q0) - q0);
    const t1 = q1 + a * (m * Math.tanh(g * q1) - q1);
    const t2 = q2 + a * (m * Math.tanh(g * q2) - q2);
    const t3 = q3 + a * (m * Math.tanh(g * q3) - q3);
    const b0 = s.dn2.down(t0, t1);
    const b1 = s.dn2.down(t2, t3);
    return s.dn1.down(b0, b1);
  }

  process(inputs, outputs, p) {
    const output = outputs[0];
    if (!output || output.length === 0) return this.alive;
    const oL = output[0];
    const oR = output.length > 1 ? output[1] : null;
    const n = oL.length;
    if (p.flush[0] !== this.flushSeen) {
      this.flushSeen = p.flush[0];
      this.reset();
    }
    const input = inputs[0];
    const iL = input && input.length > 0 ? input[0] : null;
    const iR = input && input.length > 1 ? input[1] : iL;
    const glueA = p.glue, punchA = p.punch, warmA = p.warmth, widthA = p.width, monoA = p.monoBass;

    // Mono Bass high-pass: one set of coefficients per render quantum (the AudioParam is smoothed).
    const monoHz = monoA[0];
    const hpTarget = monoHz > 20.5 ? 1 : 0;
    const [h0, h1, h2, ha1, ha2] = sbBiquad('hp', Math.max(20, monoHz), Math.SQRT1_2);

    const aRel = this.aRel, aDet = this.aDet, aSlowUp = this.aSlowUp, aSlowDn = this.aSlowDn, aFade = this.aFade;
    let det = this.det, env1 = this.env1, env2 = this.env2, eng = this.eng, hpOn = this.hpOn;
    let hz1 = this.hp[0], hz2 = this.hp[1], hz3 = this.hp[2], hz4 = this.hp[3];
    let maxGr = this.maxGr;
    let lastGlue = -1, lastPunch = -1, thr = 0, slope = 0, mk = 0, aAtt = 0;
    let lastWarm = -1, wg = 1, wm = 1, wa = 0;

    for (let i = 0; i < n; i++) {
      let l = iL ? sbIn(iL[i]) : 0;
      let r = iR ? sbIn(iR[i]) : 0;

      // 1. Glue: peak-hold level detector (runs always, so it is ready when Glue comes up from 0).
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      const pk = al > ar ? al : ar;
      det = pk > det ? pk : det * aDet;
      const glue = sbAt(glueA, i);
      if (glue > 0 || env1 > 0 || env2 > 0) {
        if (glue !== lastGlue) {
          lastGlue = glue;
          thr = SB_GLUE_THR * glue;
          slope = 1 - 1 / (1 + (SB_GLUE_RATIO - 1) * glue);
          mk = sbGlueCurve(SB_GLUE_REF, thr, slope);
        }
        const punch = sbAt(punchA, i);
        if (punch !== lastPunch) {
          lastPunch = punch;
          aAtt = sbPole(Math.pow(30, Math.min(1, Math.max(0, punch))) * 0.001);
        }
        const lv = det > 1e-6 ? 20 * Math.log10(det) : -120;
        const target = sbGlueCurve(lv, thr, slope);
        env1 = target > env1 ? target + (env1 - target) * aAtt : target + (env1 - target) * aRel;
        env2 = env1 > env2 ? env1 + (env2 - env1) * aSlowUp : env1 + (env2 - env1) * aSlowDn;
        if (glue === 0 && env1 < 1e-9 && env2 < 1e-9) {
          env1 = 0;
          env2 = 0;
        }
        const gr = env1 > env2 ? env1 : env2;
        if (gr > maxGr) maxGr = gr;
        if (gr !== 0 || mk !== 0) {
          const k = sbDbToGain(mk - gr);
          l *= k;
          r *= k;
        }
      }

      // 2. Warmth.
      const warmth = sbAt(warmA, i);
      const engTarget = warmth > 0 ? 1 : 0;
      if (eng > 0 || engTarget > 0) {
        eng = engTarget + (eng - engTarget) * aFade;
        if (engTarget === 0 && eng < 1e-5) {
          eng = 0;
          for (const s of this.os) for (const k of ['up1', 'up2', 'dn2', 'dn1']) s[k].reset();
        } else {
          if (warmth !== lastWarm) {
            lastWarm = warmth;
            wg = 1 + 1.5 * warmth;
            wm = SB_WARM_REF / Math.tanh(wg * SB_WARM_REF);
            wa = Math.min(1, 3 * warmth);
          }
          const wl = this.warm(0, l, wg, wm, wa);
          const wr = this.warm(1, r, wg, wm, wa);
          l += eng * (wl - l);
          r += eng * (wr - r);
        }
      }

      // 3. Width and Mono Bass (mid/side).
      const width = sbAt(widthA, i);
      if (hpOn > 0 || hpTarget > 0) {
        hpOn = hpTarget + (hpOn - hpTarget) * aFade;
        if (hpTarget === 0 && hpOn < 1e-5) {
          hpOn = 0;
          hz1 = hz2 = hz3 = hz4 = 0;
        }
      }
      if (width !== 1 || hpOn > 0) {
        const s = 0.5 * (l - r);
        let s2 = s;
        if (hpOn > 0) {
          const y = h0 * s + h1 * hz1 + h2 * hz2 - ha1 * hz3 - ha2 * hz4;
          hz2 = hz1;
          hz1 = s;
          hz4 = hz3;
          hz3 = y;
          s2 = s + hpOn * (y - s);
        }
        const d = width * s2 - s;
        l += d;
        r -= d;
      }

      oL[i] = l;
      if (oR) oR[i] = r;
    }

    this.det = sbTidy(det);
    this.env1 = sbTidy(env1);
    this.env2 = sbTidy(env2);
    this.eng = eng;
    this.hpOn = hpOn;
    this.hp[0] = sbTidy(hz1);
    this.hp[1] = sbTidy(hz2);
    this.hp[2] = sbTidy(hz3);
    this.hp[3] = sbTidy(hz4);
    if (eng > 0) for (const s of this.os) for (const k of ['up1', 'up2', 'dn2', 'dn1']) s[k].tidy();
    for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);

    this.reportCount += n;
    if (this.reportCount >= this.reportEvery) {
      this.reportCount = 0;
      if (this.report) this.port.postMessage(maxGr);
      maxGr = 0;
    }
    this.maxGr = maxGr;
    return this.alive;
  }
}

sbRegister('${MASTERING_PROCESSOR_NAME}', SbMasteringProcessor);
`;
