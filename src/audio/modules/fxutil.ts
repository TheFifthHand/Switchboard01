/**
 * Shared building blocks for the effect modules (filter, drive, delay,
 * reverb, chorus, phaser, crusher).
 *
 * - `EffectModule`: common ModuleNode plumbing (ports, bypass crossfade,
 *   smoothed automation with change detection, timers, disposal).
 * - `BypassSwitch`: crossfades between the processed path and a direct path.
 * - `ControlBus`: an audio-rate control value (smoothed base + modulation
 *   input) that is clamped and mapped through WaveShaper curves into
 *   AudioParams. This is how modulation inputs stay bounded.
 * - Pure helpers: waveshaper transfer curves, drive gain laws and seeded
 *   impulse-response generation. These do not touch Web Audio and run in
 *   Node unit tests.
 */
import { Rng, subSeed } from '../../project/rng';
import type { Id, ModuleType, ParamValues } from '../../project/types';
import { PARAM_SMOOTHING, type ModuleEnv, type ModuleNode } from './types';

export type Curve = Float32Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* Numeric helpers                                                     */
/* ------------------------------------------------------------------ */

/** Clamp to [lo, hi]; non-finite input returns `lo`. */
export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Time constant for bypass crossfades (about 95% complete after 20 ms). */
export const BYPASS_TAU = 0.02 / 3;
/** Time constant for crossfades between discrete settings (about 95% after 25 ms). */
export const SWITCH_TAU = 0.025 / 3;
/**
 * Butterworth (maximally flat) Q in the dB units Web Audio uses for lowpass /
 * highpass biquads. Its magnitude never exceeds 1, which keeps feedback loops
 * that contain it strictly below unity gain.
 */
export const BUTTERWORTH_Q_DB = -3.0103;

/** Conventional (linear) Q to the dB resonance value Web Audio expects for lowpass/highpass. */
export function linearQToDb(q: number): number {
  return 20 * Math.log10(Math.max(1e-4, q));
}

/* ------------------------------------------------------------------ */
/* Curves                                                              */
/* ------------------------------------------------------------------ */

/** Points in the drive waveshaper curves. */
export const SHAPER_CURVE_POINTS = 4096;
/**
 * Input range covered by the drive curves: the shaper sees x / SHAPER_DOMAIN,
 * so a curve spans x in [-32, 32]. Pre-gain tops out at 31, so any input up
 * to full scale stays inside the curve (beyond it WaveShaper holds the end
 * value, which is still bounded).
 */
export const SHAPER_DOMAIN = 32;

/** 2-point identity curve: output = input on [-1, 1], held at +/-1 beyond. */
export function identityCurve(): Curve {
  return new Float32Array([-1, 1]);
}

/** Curve that clamps its input to [0, 1] (exact: piecewise linear on 3 points). */
export function clamp01Curve(): Curve {
  return new Float32Array([0, 0, 1]);
}

export const DRIVE_CHARACTERS = 3;

/** Hard-knee clipper: linear up to the knee, quadratic knee, flat at 1 from 2 - knee. */
const HARD_KNEE = 0.8;

/**
 * Drive transfer functions, all with unity small-signal gain and output
 * bounded to [-1, 1]:
 *  0 Warm — tanh (smooth, tape-like, odd harmonics rising gradually),
 *  1 Hard — linear with a short quadratic knee into a hard clip (crunchy),
 *  2 Fold — sine wavefolder: past the peak the waveform folds back (metallic).
 */
export function driveTransfer(character: number, x: number): number {
  switch (character) {
    case 1: {
      const a = Math.abs(x);
      let y: number;
      if (a <= HARD_KNEE) y = a;
      else if (a >= 2 - HARD_KNEE) y = 1;
      else {
        const u = a - HARD_KNEE;
        y = HARD_KNEE + u - (u * u) / (4 * (1 - HARD_KNEE));
      }
      return x < 0 ? -y : y;
    }
    case 2:
      return Math.sin(x);
    default:
      return Math.tanh(x);
  }
}

/** Waveshaper curve for a drive character over x in [-domain, domain]. */
export function makeDriveCurve(character: number, points = SHAPER_CURVE_POINTS, domain = SHAPER_DOMAIN): Curve {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const u = (2 * i) / (points - 1) - 1;
    c[i] = driveTransfer(character, u * domain);
  }
  return c;
}

/**
 * Curve for a ControlBus mapping: the shaper input u (base + modulation) is
 * clamped to d in [0, 1] and mapped through `fn`. 4097 points put d = 0,
 * 1/8, 1/2 ... exactly on grid points.
 */
export function makeControlCurve(fn: (d: number) => number, points = 4097): Curve {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const u = (2 * i) / (points - 1) - 1;
    const v = fn(u <= 0 ? 0 : u);
    c[i] = Number.isFinite(v) ? v : 0;
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* Drive laws                                                          */
/* ------------------------------------------------------------------ */

/** Pre-gain into the shaper for normalised drive d (0..1): 1 .. 31. */
export function driveGain(d: number): number {
  const x = clamp(d, 0, 1);
  return 1 + Math.pow(x, 1.5) * 30;
}

/**
 * Wet share for normalised drive d: rises from 0 to 1 over the first eighth
 * of the knob so Drive at zero is exactly the dry signal.
 */
export function driveWetFade(d: number): number {
  return Math.min(1, clamp(d, 0, 1) * 8);
}

/** Level the loudness compensation keeps constant through the Warm curve (about -10 dBFS peak). */
const DRIVE_REF_LEVEL = 0.3;

/**
 * Output make-up gain for normalised drive d: a sine peaking at the reference
 * level keeps its peak level through the Warm curve. Louder material is
 * compressed and quieter material lifted, as with any saturator, but turning
 * Drive up no longer adds up to +30 dB.
 */
export function driveMakeup(d: number): number {
  const g = driveGain(d);
  return DRIVE_REF_LEVEL / Math.tanh(g * DRIVE_REF_LEVEL);
}

/* ------------------------------------------------------------------ */
/* Impulse responses                                                   */
/* ------------------------------------------------------------------ */

export const IR_MAX_SECONDS = 10;
/** Total energy (sum of squares, per channel) of every generated IR, for consistent loudness. */
export const IR_ENERGY_TARGET = 0.5;
/** Early reflections are placed between these times (seconds). */
export const IR_EARLY_START = 0.004;
export const IR_EARLY_END = 0.04;

export interface ImpulseSpec {
  sampleRate: number;
  /** Time (s) at which the diffuse tail has decayed by 60 dB. */
  decay: number;
  seed: number;
  channels?: number;
}

/** IR length in frames: min(decay * 1.2, 10) seconds. */
export function impulseLengthFrames(decay: number, sampleRate: number): number {
  const d = clamp(decay, 0.01, 60);
  return Math.max(1, Math.round(Math.min(d * 1.2, IR_MAX_SECONDS) * sampleRate));
}

/** Power gain of two cascaded one-pole low-passes y = (1-a)x + a*y1 on white noise. */
function twoPolePowerGain(a: number): number {
  const a2 = a * a;
  const d = 1 - a2;
  return (Math.pow(1 - a, 4) * (1 + a2)) / (d * d * d);
}

/**
 * Deterministic stereo impulse response for the reverb.
 *
 * - Independent seeded noise per channel (decorrelated stereo).
 * - Broadband level decays exponentially: -60 dB at `decay` seconds.
 * - Seven sparse early reflections per channel between 4 and 40 ms.
 * - Frequency-dependent damping: the noise runs through a 12 dB/oct low-pass
 *   whose cutoff falls from ~15 kHz to 1.2 kHz over the decay time, so the tail
 *   darkens. The filter's power loss is compensated so the broadband envelope
 *   stays exact (low frequencies therefore ring slightly longer, as in real
 *   rooms).
 * - Normalised to IR_ENERGY_TARGET so different sizes sound equally loud on
 *   sustained material.
 */
export function generateImpulse(spec: ImpulseSpec): Curve[] {
  const sr = spec.sampleRate;
  const decay = clamp(spec.decay, 0.01, 60);
  const channels = Math.max(1, Math.floor(spec.channels ?? 2));
  const n = impulseLengthFrames(decay, sr);
  const envStep = Math.pow(10, -3 / (decay * sr));
  const fStart = Math.min(15000, sr * 0.45);
  const fEnd = Math.min(1200, fStart);
  const decayFrames = decay * sr;
  const attack = Math.max(1, Math.round(Math.min(0.006, decay * 0.02) * sr));
  const fade = Math.max(1, Math.min(n, Math.round(Math.min(0.1, (n / sr) * 0.05) * sr)));
  const out: Curve[] = [];

  for (let c = 0; c < channels; c++) {
    const rng = new Rng(subSeed(spec.seed, `ir:${c}`));
    const x = new Float32Array(n);
    // Early reflections go into the excitation so they are damped like the rest.
    const taps = 7;
    for (let k = 0; k < taps; k++) {
      const t = rng.range(IR_EARLY_START, IR_EARLY_END);
      const idx = Math.round(t * sr);
      const amp = (3 * (0.45 + 0.55 * rng.float())) / (1 + 0.25 * k);
      if (idx < n) x[idx] += rng.chance(0.5) ? amp : -amp;
    }
    let y1 = 0;
    let y2 = 0;
    let env = 1;
    let a = 0;
    let comp = 1;
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) {
        const frac = Math.min(1, i / decayFrames);
        const fc = fStart * Math.pow(fEnd / fStart, frac);
        a = Math.exp((-2 * Math.PI * fc) / sr);
        comp = 1 / Math.sqrt(twoPolePowerGain(a));
      }
      const onset = i < attack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack) : 1;
      const e = rng.noise() * onset + x[i];
      y1 = (1 - a) * e + a * y1;
      y2 = (1 - a) * y1 + a * y2;
      x[i] = y2 * comp * env;
      env *= envStep;
    }
    // The tail is already below -60 dB here; the fade just avoids a truncation step.
    for (let i = 0; i < fade; i++) {
      x[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    }
    out.push(x);
  }

  let energy = 0;
  for (const ch of out) for (let i = 0; i < ch.length; i++) energy += ch[i] * ch[i];
  energy /= channels;
  if (energy > 0) {
    const g = Math.sqrt(IR_ENERGY_TARGET / energy);
    for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }
  return out;
}

/** Stereo AudioBuffer holding `generateImpulse` for this context's sample rate. */
export function createImpulseBuffer(ctx: BaseAudioContext, decay: number, seed: number): AudioBuffer {
  const data = generateImpulse({ sampleRate: ctx.sampleRate, decay, seed, channels: 2 });
  const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) buf.copyToChannel(data[c], c);
  return buf;
}

/* ------------------------------------------------------------------ */
/* Bypass                                                              */
/* ------------------------------------------------------------------ */

/**
 * input ─┬─ (processing, owned by the module) ─> processed ─┐
 *        └──────────────── direct ──────────────────────────┴─> output
 *
 * The input is forced to stereo (mono sources are up-mixed to both sides) so
 * every processing path sees two channels. Bypass crossfades the two gains
 * with complementary exponential curves; they always sum to 1, so identical
 * signals pass at constant level.
 */
export class BypassSwitch {
  readonly input: GainNode;
  readonly output: GainNode;
  /** Connect the end of the processing path here. */
  readonly processed: GainNode;
  private readonly direct: GainNode;
  private bypassed = false;

  constructor(ctx: BaseAudioContext) {
    this.input = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.output = new GainNode(ctx);
    this.processed = new GainNode(ctx, { gain: 1 });
    this.direct = new GainNode(ctx, { gain: 0 });
    this.processed.connect(this.output);
    this.input.connect(this.direct);
    this.direct.connect(this.output);
  }

  get isBypassed(): boolean {
    return this.bypassed;
  }

  set(bypass: boolean, time: number): void {
    if (bypass === this.bypassed) return;
    this.bypassed = bypass;
    // Drop a crossfade scheduled later than `time` (a change requested out of
    // order), or it would override this newer state. A fade already running
    // continues smoothly from its current value.
    for (const [g, v] of [
      [this.processed.gain, bypass ? 0 : 1],
      [this.direct.gain, bypass ? 1 : 0],
    ] as const) {
      g.cancelScheduledValues(time);
      g.setTargetAtTime(v, time, BYPASS_TAU);
    }
  }

  nodes(): AudioNode[] {
    return [this.input, this.output, this.processed, this.direct];
  }
}

/* ------------------------------------------------------------------ */
/* Control bus                                                         */
/* ------------------------------------------------------------------ */

/**
 * Audio-rate control value u = base + modulation. `base` is a ConstantSource
 * whose offset the module smooths; `modInput` is the module's modulation port
 * (a GainNode with the port's range). Mappings clamp u and shape it through a
 * WaveShaper curve into an AudioParam, so any amount of modulation stays
 * bounded.
 */
export class ControlBus {
  readonly base: ConstantSourceNode;
  readonly modInput: GainNode;
  private readonly sum: GainNode;
  private readonly own: <T extends AudioNode>(n: T) => T;
  private readonly ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, initial: number, modGain: number, own: <T extends AudioNode>(n: T) => T) {
    this.ctx = ctx;
    this.own = own;
    this.base = own(new ConstantSourceNode(ctx, { offset: initial }));
    this.modInput = own(new GainNode(ctx, { gain: modGain, channelCount: 1, channelCountMode: 'explicit' }));
    this.sum = own(new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' }));
    this.base.connect(this.sum);
    this.modInput.connect(this.sum);
    this.base.start();
  }

  /** A WaveShaper output carrying curve(u); connect it wherever needed. */
  shape(curve: Curve): WaveShaperNode {
    const ws = this.own(new WaveShaperNode(this.ctx, { curve, oversample: 'none', channelCount: 1, channelCountMode: 'explicit' }));
    this.sum.connect(ws);
    return ws;
  }

  /** Drive `target` (whose own value should be 0, or an offset) with curve(u). */
  map(curve: Curve, target: AudioParam): WaveShaperNode {
    const ws = this.shape(curve);
    ws.connect(target);
    return ws;
  }

  /**
   * Linear dry/wet pair for insert effects: wet gain = clamp(u, 0, 1) and
   * dry gain = 1 − wet, so modulating the mix crossfades rather than adding
   * level.
   */
  blend(): { dry: GainNode; wet: GainNode } {
    const dry = this.own(new GainNode(this.ctx, { gain: 1 }));
    const wet = this.own(new GainNode(this.ctx, { gain: 0 }));
    const neg = this.own(new GainNode(this.ctx, { gain: -1, channelCount: 1, channelCountMode: 'explicit' }));
    const amount = this.shape(clamp01Curve());
    amount.connect(wet.gain);
    amount.connect(neg);
    neg.connect(dry.gain);
    return { dry, wet };
  }
}

/* ------------------------------------------------------------------ */
/* Effect module base                                                  */
/* ------------------------------------------------------------------ */

/**
 * Common ModuleNode plumbing for effect modules: audio in/out through a
 * BypassSwitch, modulation ports, smoothed automation with change detection,
 * engine timers and complete disposal.
 */
export abstract class EffectModule implements ModuleNode {
  abstract readonly type: ModuleType;
  readonly id: Id;
  protected readonly env: ModuleEnv;
  protected readonly ctx: BaseAudioContext;
  protected readonly bypass: BypassSwitch;
  protected disposed = false;
  private readonly owned = new Set<AudioNode>();
  private readonly mods = new Map<string, AudioNode>();
  /** Last target scheduled per smoothed AudioParam (skips redundant events). */
  private readonly targets = new Map<AudioParam, number>();
  private readonly timers = new Set<number>();

  protected constructor(env: ModuleEnv, id: Id) {
    this.env = env;
    this.ctx = env.ctx;
    this.id = id;
    this.bypass = new BypassSwitch(env.ctx);
    for (const n of this.bypass.nodes()) this.owned.add(n);
  }

  input(port: string): AudioNode | undefined {
    if (port === 'in') return this.bypass.input;
    return this.mods.get(port);
  }

  output(port: string): AudioNode | undefined {
    return port === 'out' ? this.bypass.output : undefined;
  }

  abstract setParams(params: ParamValues, time: number): void;

  setBypass(bypass: boolean, time: number): void {
    if (this.disposed) return;
    this.bypass.set(bypass, this.at(time));
  }

  cancelAfter(time: number): void {
    if (this.disposed) return;
    const t = Number.isFinite(time) ? Math.max(0, time) : this.ctx.currentTime;
    for (const p of this.targets.keys()) p.cancelScheduledValues(t);
    // Values we believed scheduled may be gone; re-apply everything next time.
    this.targets.clear();
    this.afterCancel(t);
  }

  /** Subclass hook after automation past `time` was cancelled. */
  protected afterCancel(_time: number): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.timers) this.env.clearTimer(id);
    this.timers.clear();
    for (const n of this.owned) {
      if (n instanceof AudioScheduledSourceNode) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      }
      n.disconnect();
    }
    this.owned.clear();
    this.mods.clear();
    this.targets.clear();
  }

  /** Track a node for disposal. */
  protected own = <T extends AudioNode>(node: T): T => {
    this.owned.add(node);
    return node;
  };

  /** Disconnect and forget nodes replaced during the module's life (see forgetParams for their params). */
  protected release(nodes: Iterable<AudioNode>): void {
    for (const n of nodes) {
      if (n instanceof AudioScheduledSourceNode) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      }
      n.disconnect();
      this.owned.delete(n);
    }
  }

  /** Stop tracking these params' last targets (their nodes are being discarded). */
  protected forgetParams(params: Iterable<AudioParam>): void {
    for (const p of params) this.targets.delete(p);
  }

  protected registerMod(port: string, node: AudioNode): void {
    this.mods.set(port, node);
  }

  /** Start time for a change requested at `time` (never in the past, always finite). */
  protected at(time: number): number {
    const now = this.ctx.currentTime;
    return Number.isFinite(time) ? Math.max(time, now) : now;
  }

  /** Smoothly move `param` to `value` from `time` (skipped when that target is already scheduled). */
  protected smooth(param: AudioParam, value: number, time: number, tau: number = PARAM_SMOOTHING): void {
    if (!Number.isFinite(value)) return;
    if (this.targets.get(param) === value) return;
    this.targets.set(param, value);
    param.setTargetAtTime(value, time, tau);
  }

  /** Engine-counted timer that is cleared on dispose. */
  protected startTimer(fn: () => void, ms: number): number {
    const id = this.env.setTimer(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  protected stopTimer(id: number): void {
    if (this.timers.delete(id)) this.env.clearTimer(id);
  }
}
