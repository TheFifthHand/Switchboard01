/**
 * Modulation and colour processors for the insert effects (AudioWorklet):
 *
 * 'sb-flanger' — a short delay line swept by a sine LFO, read with 4-point
 *   Hermite interpolation, with feedback inside the processor (a native
 *   Web Audio feedback cycle cannot be shorter than one 128-frame render
 *   quantum, far too long for a flanger). The sweep is exponential between
 *   FLANGER_MIN_MS and FLANGER_MIN_MS + depth·(FLANGER_MAX_MS − FLANGER_MIN_MS)
 *   so the notches move evenly in pitch; the right channel's LFO runs 90°
 *   ahead for a wide image. Loop gain is feedback (≤ 0.85) times a 12 kHz
 *   damping pole, so it always decays; the input is scaled by √(1 − fb²) to
 *   keep the broadband level even as feedback rises.
 *       y = cos(mix·π/2)·x + sin(mix·π/2)·line(t − d(t))
 *   (an equal-power blend: the swept line is decorrelated from the dry
 *   sound, so switching the flanger in keeps the part's energy where a linear
 *   50/50 blend lost about 3 dB; Mix 0 is exactly dry, 1 exactly wet).
 *
 * 'sb-tape' — tape colour:
 *   1. saturation at 2x (polyphase IIR half-bands, see halfband.ts): a soft,
 *      slightly asymmetric tanh curve (odd and even harmonics) whose pre-gain
 *      rises with Saturation; level-compensated so a sine peaking at −12 dBFS
 *      keeps its RMS level (quieter material gets denser, peaks round off).
 *      The make-up gains come from a table computed once per processor. A
 *      5 Hz DC blocker removes the offset the asymmetry creates.
 *   2. wow and flutter: the saturated signal is read from a delay line whose
 *      time is modulated by two slow "wow" sines (0.55 and 0.31 Hz) and a
 *      6.5 Hz "flutter" sine with seeded phases. The mean delay rises with
 *      Wobble (smoothed over 0.25 s, so turning the knob is a gentle drift,
 *      not a pitch jump); at Wobble 0 only a 3-sample base delay remains.
 *   3. hiss: seeded white noise scaled by an envelope follower on the input,
 *      so it rises and falls with the music and silence stays silent.
 *   4. tone: a 12 dB/oct low-pass from 3 kHz (Tone 0) to 20 kHz (Tone 1).
 *   The dry path for Mix runs through the same half-band all-pass and the
 *   same mean delay, so blending never comb-filters (only the wobble itself
 *   differs).
 *
 * 'sb-level-match' — the Drive's level compensation in practice. Input 0 is
 *   the driven (wet) sound, input 1 the same part before the drive, both
 *   already scaled by the wet share. Their mean squares are averaged over
 *   LEVEL_MATCH_TAU and the wet sound leaves multiplied by
 *   sqrt(reference / wet), glided over LEVEL_MATCH_GLIDE and bounded to
 *   ±LEVEL_MATCH_MAX_DB: whatever level and shape a part reaches its Drive
 *   with, turning Drive up keeps its RMS level. In silence the gain holds.
 *   A block of silence on both inputs costs almost nothing.
 */
import { FLUSH_PARAM_JS, WORKLET_COMMON_JS } from './common';
import { HALFBAND_JS } from './halfband';

export const FLANGER_PROCESSOR_NAME = 'sb-flanger';
export const TAPE_PROCESSOR_NAME = 'sb-tape';
export const LEVEL_MATCH_PROCESSOR_NAME = 'sb-level-match';

/** Averaging time of the level match's mean squares (seconds). */
export const LEVEL_MATCH_TAU = 0.4;
/** Glide of its gain toward the measured ratio (seconds). */
export const LEVEL_MATCH_GLIDE = 0.05;
/** Largest correction the level match applies, either way (dB). */
export const LEVEL_MATCH_MAX_DB = 6;
/** Below this mean square (about −80 dBFS) the level match holds its gain (silence says nothing). */
export const LEVEL_MATCH_FLOOR = 1e-8;

export const FLANGER_MIN_MS = 0.3;
export const FLANGER_MAX_MS = 8;
/** Peak delay excursion of the main wow component at Wobble 1 (ms). */
export const TAPE_WOW_MS = 1.5;
export const TAPE_WOW_HZ = 0.55;
export const TAPE_WOW2_HZ = 0.31;
export const TAPE_FLUTTER_MS = 0.04;
export const TAPE_FLUTTER_HZ = 6.5;
/** Constant base delay of the wobble line (frames): keeps the Hermite read in the past. */
export const TAPE_BASE_FRAMES = 3;
/** Saturation reference: a sine peaking here keeps its RMS level. */
export const TAPE_REF_LEVEL = 0.25;
/** Hiss level relative to the input's RMS envelope at Hiss 1 (noise is uniform, RMS 1/√3). */
export const TAPE_HISS_GAIN = 0.08;

/** Tape tone low-pass corner: 3 kHz at 0, 20 kHz at 1 (exponential). */
export function tapeToneHz(tone: number): number {
  const t = Math.min(1, Math.max(0, tone));
  return 3000 * Math.pow(20000 / 3000, t);
}

export const FX_WORKLET_SOURCE = /* js */ `
${WORKLET_COMMON_JS}
${HALFBAND_JS}

const SB_FL_MIN = ${FLANGER_MIN_MS} * 0.001;
const SB_FL_MAX = ${FLANGER_MAX_MS} * 0.001;

/** Equal-power blend gain for mix m (0..1): sin for the wet side, cos for the dry side; exact at the ends. */
function sbEqualPower(m, wet) {
  const x = m <= 0 ? 0 : m >= 1 ? 1 : m;
  if (x === 0) return wet ? 0 : 1;
  if (x === 1) return wet ? 1 : 0;
  const th = x * Math.PI * 0.5;
  return wet ? Math.sin(th) : Math.cos(th);
}

function sbPow2(n) {
  let s = 1;
  while (s < n) s <<= 1;
  return s;
}

class SbFlangerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.15, minValue: 0.02, maxValue: 5, automationRate: 'a-rate' },
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 0.85, automationRate: 'a-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      ${FLUSH_PARAM_JS},
    ];
  }

  constructor() {
    super();
    const size = sbPow2(Math.ceil(SB_FL_MAX * sampleRate) + 16);
    this.mask = size - 1;
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.w = 0;
    this.phase = 0;
    this.dampL = 0;
    this.dampR = 0;
    this.aDamp = 1 - Math.exp((-2 * Math.PI * Math.min(12000, sampleRate * 0.4)) / sampleRate);
    this.minFrames = Math.max(3, SB_FL_MIN * sampleRate);
    this.logRange = Math.log(SB_FL_MAX / SB_FL_MIN);
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
      this.bufL.fill(0);
      this.bufR.fill(0);
      this.dampL = 0;
      this.dampR = 0;
    }
    const input = inputs[0];
    const iL = input && input.length > 0 ? input[0] : null;
    const iR = input && input.length > 1 ? input[1] : iL;
    const bufL = this.bufL, bufR = this.bufR, mask = this.mask;
    const rateA = p.rate, depthA = p.depth, fbA = p.feedback, mixA = p.mix;
    const minF = this.minFrames, logRange = this.logRange, aDamp = this.aDamp;
    let w = this.w, phase = this.phase, dampL = this.dampL, dampR = this.dampR;
    const twoPi = 2 * Math.PI;
    const mixConst = mixA.length === 1;
    let gDry = sbEqualPower(mixA[0], false);
    let gWet = sbEqualPower(mixA[0], true);
    for (let i = 0; i < n; i++) {
      const l = iL ? sbIn(iL[i]) : 0;
      const r = iR ? sbIn(iR[i]) : 0;
      const depth = sbAt(depthA, i);
      const fb = sbAt(fbA, i);
      if (!mixConst) {
        gDry = sbEqualPower(mixA[i], false);
        gWet = sbEqualPower(mixA[i], true);
      }
      phase += sbAt(rateA, i) / sampleRate;
      if (phase >= 1) phase -= 1;
      const sweepL = 0.5 - 0.5 * Math.cos(twoPi * phase);
      const sweepR = 0.5 + 0.5 * Math.sin(twoPi * phase);
      const dL = minF * Math.exp(depth * sweepL * logRange);
      const dR = minF * Math.exp(depth * sweepR * logRange);
      const yl = sbHermite(bufL, mask, w - dL);
      const yr = sbHermite(bufR, mask, w - dR);
      dampL += (yl - dampL) * aDamp;
      dampR += (yr - dampR) * aDamp;
      const k = Math.sqrt(1 - fb * fb);
      // Tidied on the way in: the decaying loop ends in exact zeros, never float denormals.
      bufL[w] = sbTidy(l * k + fb * dampL);
      bufR[w] = sbTidy(r * k + fb * dampR);
      w = (w + 1) & mask;
      oL[i] = l * gDry + yl * gWet;
      if (oR) oR[i] = r * gDry + yr * gWet;
    }
    this.w = w;
    this.phase = phase;
    this.dampL = sbTidy(dampL);
    this.dampR = sbTidy(dampR);
    for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);
    return this.alive;
  }
}

const SB_TAPE_WOW = ${TAPE_WOW_MS} * 0.001;
const SB_TAPE_WOW_HZ = ${TAPE_WOW_HZ};
const SB_TAPE_WOW2_HZ = ${TAPE_WOW2_HZ};
const SB_TAPE_FL = ${TAPE_FLUTTER_MS} * 0.001;
const SB_TAPE_FL_HZ = ${TAPE_FLUTTER_HZ};
const SB_TAPE_BASE = ${TAPE_BASE_FRAMES};
const SB_TAPE_REF = ${TAPE_REF_LEVEL};
const SB_TAPE_HISS = ${TAPE_HISS_GAIN};
/** Asymmetry of the tape curve (bias): small even harmonics. */
const SB_TAPE_BIAS = 0.15;

const SB_TAPE_TABLE = 256;

function sbTapeCurve(u, g, m, tb) {
  return m * (Math.tanh(g * u + SB_TAPE_BIAS) - tb);
}

function sbTapeGain(drive) {
  return 1 + 7 * Math.pow(drive, 1.3);
}

/** Make-up gain per drive step: keeps the AC RMS of a sine peaking at SB_TAPE_REF. */
function sbTapeMakeupTable() {
  const out = new Float64Array(SB_TAPE_TABLE + 1);
  const tb = Math.tanh(SB_TAPE_BIAS);
  const N = 256;
  for (let k = 0; k <= SB_TAPE_TABLE; k++) {
    const g = sbTapeGain(k / SB_TAPE_TABLE);
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const y = Math.tanh(g * SB_TAPE_REF * Math.sin((2 * Math.PI * i) / N) + SB_TAPE_BIAS) - tb;
      sum += y;
      sq += y * y;
    }
    const mean = sum / N;
    const acRms = Math.sqrt(Math.max(1e-30, sq / N - mean * mean));
    out[k] = SB_TAPE_REF / Math.SQRT2 / acRms;
  }
  return out;
}

class SbTapeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'wobble', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'tone', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'hiss', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      ${FLUSH_PARAM_JS},
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const seed = typeof o.seed === 'number' && Number.isFinite(o.seed) ? o.seed >>> 0 : 1;
    this.seed = seed;
    this.upL = new SbHalfband(SB_HB_STEEP);
    this.upR = new SbHalfband(SB_HB_STEEP);
    this.dnL = new SbHalfband(SB_HB_STEEP);
    this.dnR = new SbHalfband(SB_HB_STEEP);
    this.linL = new SbHalfband(SB_HB_STEEP);
    this.linR = new SbHalfband(SB_HB_STEEP);
    // Longest read: base + 1.5·wow + flutter = 3·wow + 2·flutter (+ base frames).
    const size = sbPow2(Math.ceil((3 * SB_TAPE_WOW + 2 * SB_TAPE_FL) * sampleRate) + SB_TAPE_BASE + 16);
    this.mask = size - 1;
    this.wetL = new Float32Array(size);
    this.wetR = new Float32Array(size);
    this.dryL = new Float32Array(size);
    this.dryR = new Float32Array(size);
    this.w = 0;
    this.wob = -1;
    this.aWob = sbPole(0.25);
    const ph = sbRng(seed ^ 0x5eed);
    this.ph1 = ph() * 2 * Math.PI;
    this.ph2 = ph() * 2 * Math.PI;
    this.ph3 = ph() * 2 * Math.PI;
    this.dcR = Math.exp((-2 * Math.PI * 5) / sampleRate);
    this.makeup = sbTapeMakeupTable();
    this.reset();
    this.flushSeen = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'dispose') this.alive = false;
    };
  }

  reset() {
    for (const h of [this.upL, this.upR, this.dnL, this.dnR, this.linL, this.linR]) h.reset();
    this.wetL.fill(0);
    this.wetR.fill(0);
    this.dryL.fill(0);
    this.dryR.fill(0);
    this.dcxL = 0;
    this.dcyL = 0;
    this.dcxR = 0;
    this.dcyR = 0;
    this.tL1 = 0;
    this.tL2 = 0;
    this.tR1 = 0;
    this.tR2 = 0;
    this.env = 0;
    this.rng = sbRng(this.seed);
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
    const driveA = p.drive, wobA = p.wobble, mixA = p.mix, hissA = p.hiss;
    // Tone: one set of coefficients per render quantum (the AudioParam is smoothed).
    const fc = 3000 * Math.pow(20000 / 3000, Math.min(1, Math.max(0, p.tone[0])));
    const [b0, b1, b2, a1, a2] = sbBiquad('lp', fc, Math.SQRT1_2);
    const mask = this.mask, wetL = this.wetL, wetR = this.wetR, dryL = this.dryL, dryR = this.dryR;
    const upL = this.upL, upR = this.upR, dnL = this.dnL, dnR = this.dnR, linL = this.linL, linR = this.linR;
    const dcR = this.dcR, aWob = this.aWob;
    const envUp = sbPole(0.02), envDn = sbPole(0.3);
    const w1 = (2 * Math.PI * SB_TAPE_WOW_HZ) / sampleRate;
    const w2 = (2 * Math.PI * SB_TAPE_WOW2_HZ) / sampleRate;
    const w3 = (2 * Math.PI * SB_TAPE_FL_HZ) / sampleRate;
    const rng = this.rng;
    let w = this.w;
    let wob = this.wob < 0 ? wobA[0] : this.wob;
    let ph1 = this.ph1, ph2 = this.ph2, ph3 = this.ph3, env = this.env;
    let dcxL = this.dcxL, dcyL = this.dcyL, dcxR = this.dcxR, dcyR = this.dcyR;
    let tL1 = this.tL1, tL2 = this.tL2, tR1 = this.tR1, tR2 = this.tR2;
    let lastDrive = -1, g = 1, m = 1, tb = 0, a = 0;
    for (let i = 0; i < n; i++) {
      const l = iL ? sbIn(iL[i]) : 0;
      const r = iR ? sbIn(iR[i]) : 0;
      const drive = sbAt(driveA, i);
      if (drive !== lastDrive) {
        lastDrive = drive;
        g = sbTapeGain(drive);
        tb = Math.tanh(SB_TAPE_BIAS);
        const pos = Math.min(1, Math.max(0, drive)) * SB_TAPE_TABLE;
        const k = Math.min(SB_TAPE_TABLE - 1, Math.floor(pos));
        m = this.makeup[k] + (pos - k) * (this.makeup[k + 1] - this.makeup[k]);
        a = Math.min(1, drive * 4);
      }
      // 1. Saturation at 2x; the linear path gives the phase-matched dry signal.
      upL.up(l);
      const uL0 = upL.o0, uL1 = upL.o1;
      upR.up(r);
      const uR0 = upR.o0, uR1 = upR.o1;
      const sL0 = uL0 + a * (sbTapeCurve(uL0, g, m, tb) - uL0);
      const sL1 = uL1 + a * (sbTapeCurve(uL1, g, m, tb) - uL1);
      const sR0 = uR0 + a * (sbTapeCurve(uR0, g, m, tb) - uR0);
      const sR1 = uR1 + a * (sbTapeCurve(uR1, g, m, tb) - uR1);
      const xL = dnL.down(sL0, sL1);
      const xR = dnR.down(sR0, sR1);
      const lnL = linL.down(uL0, uL1);
      const lnR = linR.down(uR0, uR1);
      // DC blocker on the saturated path.
      const yL = xL - dcxL + dcR * dcyL;
      dcxL = xL;
      dcyL = yL;
      const yR = xR - dcxR + dcR * dcyR;
      dcxR = xR;
      dcyR = yR;
      wetL[w] = sbTidy(yL);
      wetR[w] = sbTidy(yR);
      dryL[w] = sbTidy(lnL);
      dryR[w] = sbTidy(lnR);
      // 2. Wow and flutter.
      wob += (sbAt(wobA, i) - wob) * (1 - aWob);
      const wowF = wob * SB_TAPE_WOW * sampleRate;
      const flF = wob * SB_TAPE_FL * sampleRate;
      const base = SB_TAPE_BASE + 1.5 * wowF + flF;
      const d = base + wowF * Math.sin(ph1) + 0.5 * wowF * Math.sin(ph2) + flF * Math.sin(ph3);
      ph1 += w1;
      ph2 += w2;
      ph3 += w3;
      let vL = sbHermite(wetL, mask, w - d);
      let vR = sbHermite(wetR, mask, w - d);
      const dl = sbHermite(dryL, mask, w - base);
      const dr = sbHermite(dryR, mask, w - base);
      w = (w + 1) & mask;
      // 3. Hiss that follows the music.
      const ms = 0.5 * (l * l + r * r);
      env = ms > env ? ms + (env - ms) * envUp : ms + (env - ms) * envDn;
      // Below −90 dB the follower lets go entirely: the hiss (then under −110 dBFS) stops for good.
      if (env < 1e-9) env = 0;
      const hiss = sbAt(hissA, i);
      if (hiss > 0 && env > 0) {
        const lvl = hiss * SB_TAPE_HISS * Math.sqrt(env);
        vL += lvl * (2 * rng() - 1);
        vR += lvl * (2 * rng() - 1);
      }
      // 4. Tone.
      const zL = b0 * vL + tL1;
      tL1 = b1 * vL - a1 * zL + tL2;
      tL2 = b2 * vL - a2 * zL;
      const zR = b0 * vR + tR1;
      tR1 = b1 * vR - a1 * zR + tR2;
      tR2 = b2 * vR - a2 * zR;
      const mix = sbAt(mixA, i);
      oL[i] = dl + mix * (zL - dl);
      if (oR) oR[i] = dr + mix * (zR - dr);
    }
    const tp = 2 * Math.PI;
    this.ph1 = ph1 % tp;
    this.ph2 = ph2 % tp;
    this.ph3 = ph3 % tp;
    this.w = w;
    this.wob = wob;
    this.env = sbTidy(env);
    this.dcxL = dcxL;
    this.dcyL = sbTidy(dcyL);
    this.dcxR = dcxR;
    this.dcyR = sbTidy(dcyR);
    this.tL1 = sbTidy(tL1);
    this.tL2 = sbTidy(tL2);
    this.tR1 = sbTidy(tR1);
    this.tR2 = sbTidy(tR2);
    for (const h of [upL, upR, dnL, dnR, linL, linR]) h.tidy();
    for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);
    return this.alive;
  }
}

const SB_LM_TAU = ${LEVEL_MATCH_TAU};
const SB_LM_GLIDE = ${LEVEL_MATCH_GLIDE};
const SB_LM_MAX = Math.pow(10, ${LEVEL_MATCH_MAX_DB} / 20);
const SB_LM_FLOOR = ${LEVEL_MATCH_FLOOR};

class SbLevelMatchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [${FLUSH_PARAM_JS}];
  }

  constructor() {
    super();
    this.a = 1 - sbPole(SB_LM_TAU);
    this.b = 1 - sbPole(SB_LM_GLIDE);
    this.eWet = 0;
    this.eRef = 0;
    this.g = 1;
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
      this.eWet = 0;
      this.eRef = 0;
      this.g = 1;
    }
    const wet = inputs[0] || [];
    const ref = inputs[1] || [];
    const wL = wet.length > 0 ? wet[0] : null;
    const wR = wet.length > 1 ? wet[1] : wL;
    const rL = ref.length > 0 ? ref[0] : null;
    const rR = ref.length > 1 ? ref[1] : rL;
    let silent = true;
    for (let i = 0; i < n && silent; i++) {
      if ((wL && wL[i] !== 0) || (wR && wR[i] !== 0) || (rL && rL[i] !== 0) || (rR && rR[i] !== 0)) silent = false;
    }
    if (silent) {
      // Nothing to measure (Drive at zero gates both inputs): the averages decay, the gain holds.
      const k = Math.pow(1 - this.a, n);
      this.eWet = sbTidy(this.eWet * k);
      this.eRef = sbTidy(this.eRef * k);
      oL.fill(0);
      if (oR) oR.fill(0);
      for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);
      return this.alive;
    }
    const a = this.a, b = this.b;
    let eWet = this.eWet, eRef = this.eRef, g = this.g;
    for (let i = 0; i < n; i++) {
      const l = wL ? sbIn(wL[i]) : 0;
      const r = wR ? sbIn(wR[i]) : 0;
      const x = rL ? sbIn(rL[i]) : 0;
      const y = rR ? sbIn(rR[i]) : 0;
      eWet += a * (0.5 * (l * l + r * r) - eWet);
      eRef += a * (0.5 * (x * x + y * y) - eRef);
      if (eWet > SB_LM_FLOOR && eRef > SB_LM_FLOOR) {
        let target = Math.sqrt(eRef / eWet);
        if (target > SB_LM_MAX) target = SB_LM_MAX;
        else if (target < 1 / SB_LM_MAX) target = 1 / SB_LM_MAX;
        g += b * (target - g);
      }
      oL[i] = l * g;
      if (oR) oR[i] = r * g;
    }
    this.eWet = sbTidy(eWet);
    this.eRef = sbTidy(eRef);
    this.g = g;
    for (let ch = 2; ch < output.length; ch++) output[ch].fill(0);
    return this.alive;
  }
}

sbRegister('${FLANGER_PROCESSOR_NAME}', SbFlangerProcessor);
sbRegister('${TAPE_PROCESSOR_NAME}', SbTapeProcessor);
sbRegister('${LEVEL_MATCH_PROCESSOR_NAME}', SbLevelMatchProcessor);
`;
