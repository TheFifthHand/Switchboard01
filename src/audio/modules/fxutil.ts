/**
 * Shared building blocks for the effect modules (filter, drive, delay,
 * reverb, chorus, phaser, crusher, EQ, compressor, gate, auto pan, stereo
 * width, flanger, tape).
 *
 * - `EffectModule`: common ModuleNode plumbing (ports, bypass crossfade,
 *   smoothed automation with change detection, timers, disposal, worklet
 *   processors told to stop).
 * - `stereoWorklet` / `workletParam` / `WorkletFlush`: worklet-backed stages
 *   and their sample-accurate state reset (Mute All).
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
import { PARAM_SMOOTHING, type AutomationMode, type ModuleEnv, type ModuleNode } from './types';

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
/* Node construction                                                   */
/* ------------------------------------------------------------------ */

/**
 * A WaveShaperNode with `curve`. The curve is assigned after construction:
 * passing it in the constructor options converts it element by element as an
 * IDL sequence, which costs about 1.2 ms for a 4097-point curve in Chromium
 * (45 times more than assigning the Float32Array afterwards). Assigning copies
 * the data, so one curve array can be shared by any number of shapers.
 */
export function shaperNode(ctx: BaseAudioContext, curve: Float32Array<ArrayBuffer>, opts: Omit<WaveShaperOptions, 'curve'> = {}): WaveShaperNode {
  const node = new WaveShaperNode(ctx, opts);
  node.curve = curve;
  return node;
}

/**
 * Q (in the dB units Web Audio uses for low-pass biquads) of a critically
 * damped second-order low-pass: linear Q 0.5, i.e. two coincident real
 * poles, so a step never overshoots and the output stays a weighted average
 * of the input (bounded inputs stay bounded).
 */
export const CRITICAL_Q_DB = 20 * Math.log10(0.5);
/**
 * A critically damped two-pole low-pass has its −3 dB point at 0.6436 times
 * its pole frequency; this factor puts that point at the requested corner.
 */
export const CRITICAL_CORNER_RATIO = 1 / Math.sqrt(Math.SQRT2 - 1);

/**
 * Smoother for a control (modulation) signal: a critically damped low-pass
 * BiquadFilterNode whose −3 dB corner is `cornerHz`, mono. It replaces the
 * one-pole IIRFilterNode these paths used before: creating an IIRFilterNode
 * costs about 17 ms in Chromium (a BiquadFilterNode about 0.04 ms), and the
 * two-pole has the same rise time (10–90 %: 0.35 / corner) with a steeper
 * roll-off, so square-wave edges are rounded at least as well.
 */
export function controlSmoother(ctx: BaseAudioContext, cornerHz: number): BiquadFilterNode {
  return new BiquadFilterNode(ctx, {
    type: 'lowpass',
    frequency: Math.min(cornerHz * CRITICAL_CORNER_RATIO, ctx.sampleRate * 0.45),
    Q: CRITICAL_Q_DB,
    channelCount: 1,
    channelCountMode: 'explicit',
  });
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

/**
 * RMS level (linear) of the reference input the drive's level compensation
 * is tuned for: −20 dBFS RMS, about where a part's sound reaches its Drive.
 */
export const DRIVE_REF_RMS = 0.1;
/** Integration points for driveRmsGain (trapezoid over ±DRIVE_REF_SPAN standard deviations). */
const DRIVE_REF_POINTS = 96;
const DRIVE_REF_SPAN = 4.5;

/**
 * RMS gain of the drive curve for character `character` at normalised drive
 * d, for a Gaussian-distributed input at DRIVE_REF_RMS (music is much closer
 * to that than to a sine): sqrt(E[f(g·x)²]) / DRIVE_REF_RMS. It is 1 at
 * d = 0 (every curve has unity small-signal gain) and grows with d as the
 * curve's pre-gain pushes the sound up before it saturates.
 */
export function driveRmsGain(character: number, d: number): number {
  const g = driveGain(d);
  const s = DRIVE_REF_RMS;
  let num = 0;
  let den = 0;
  for (let i = 0; i <= DRIVE_REF_POINTS; i++) {
    const z = -DRIVE_REF_SPAN + (2 * DRIVE_REF_SPAN * i) / DRIVE_REF_POINTS;
    const w = Math.exp(-0.5 * z * z) * (i === 0 || i === DRIVE_REF_POINTS ? 0.5 : 1);
    const y = driveTransfer(character, g * s * z);
    num += w * y * y;
    den += w * s * s * z * z;
  }
  return den > 0 && num > 0 ? Math.sqrt(num / den) : 1;
}

/**
 * Output make-up gain (an RMS trim per character) for normalised drive d:
 * the reference input (DRIVE_REF_RMS, Gaussian) leaves the wet path at the
 * level it came in with, so turning Drive up changes the character, not the
 * loudness. Louder material is compressed and quieter material lifted, as
 * with any saturator; at the reference level the trim is exact.
 */
export function driveMakeup(d: number, character = 0): number {
  return 1 / driveRmsGain(character, d);
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

/** Memory budget of the shared impulse-response cache (bytes of sample data). */
const IR_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const irCache = new Map<string, AudioBuffer>();
let irCacheBytes = 0;
let irBuilds = 0;

function irBytes(buf: AudioBuffer): number {
  return buf.length * buf.numberOfChannels * 4;
}

/**
 * Stereo AudioBuffer holding `generateImpulse` for this context's sample
 * rate. Impulse responses are cached by (size, seed, sample rate) and shared
 * by every engine of the page (an AudioBuffer is not tied to a context and
 * nothing writes to it), so loading the same project or sound again, or
 * exporting it, never rebuilds a room it has built before; they are built
 * on first use only. The generation is deterministic, so a cached room is
 * exactly the one a fresh build would give.
 */
export function createImpulseBuffer(ctx: BaseAudioContext, decay: number, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const key = `${clamp(decay, 0.01, 60)}|${seed >>> 0}|${sr}`;
  const hit = irCache.get(key);
  if (hit) {
    irCache.delete(key);
    irCache.set(key, hit);
    return hit;
  }
  const data = generateImpulse({ sampleRate: sr, decay, seed, channels: 2 });
  const buf = new AudioBuffer({ numberOfChannels: 2, length: data[0].length, sampleRate: sr });
  for (let c = 0; c < 2; c++) buf.copyToChannel(data[c], c);
  irBuilds++;
  irCache.set(key, buf);
  irCacheBytes += irBytes(buf);
  for (const [k, old] of irCache) {
    if (irCacheBytes <= IR_CACHE_BUDGET_BYTES || k === key) break;
    irCache.delete(k);
    irCacheBytes -= irBytes(old);
  }
  return buf;
}

/** Shared impulse-response cache: entries, bytes and how many rooms were built so far (tests, diagnostics). */
export function impulseCacheStats(): { entries: number; bytes: number; builds: number } {
  return { entries: irCache.size, bytes: irCacheBytes, builds: irBuilds };
}

export function clearImpulseCache(): void {
  irCache.clear();
  irCacheBytes = 0;
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
    const ws = this.own(shaperNode(this.ctx, curve, { oversample: 'none', channelCount: 1, channelCountMode: 'explicit' }));
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

  /**
   * Equal-power dry/wet pair for modulation effects (Chorus, Phaser): with
   * w = clamp(u, 0, 1), wet gain = sin(w·π/2) and dry gain = cos(w·π/2).
   * Their squares sum to 1, so a wet signal that is decorrelated from the
   * dry one (a swept delay or an all-pass chain) keeps the total energy as
   * the mix moves, where a linear crossfade dips about 3 dB in the middle.
   * Mix 0 is exactly dry and 1 exactly wet.
   */
  blendEqualPower(): { dry: GainNode; wet: GainNode } {
    const dry = this.own(new GainNode(this.ctx, { gain: 0 }));
    const wet = this.own(new GainNode(this.ctx, { gain: 0 }));
    this.shape(equalPowerCurve('wet')).connect(wet.gain);
    this.shape(equalPowerCurve('dry')).connect(dry.gain);
    return { dry, wet };
  }
}

const equalPowerCurves = new Map<'dry' | 'wet', Curve>();

/** Control curve of the equal-power mix law (shared: assigning a curve copies it). */
export function equalPowerCurve(side: 'dry' | 'wet'): Curve {
  let c = equalPowerCurves.get(side);
  if (!c) {
    c = makeControlCurve((w) => equalPowerGain(w, side));
    equalPowerCurves.set(side, c);
  }
  return c;
}

/** Equal-power mix law: the wet (sin) or dry (cos) gain for mix w in 0..1 (exact 0 and 1 at the ends). */
export function equalPowerGain(w: number, side: 'dry' | 'wet'): number {
  const x = clamp(w, 0, 1);
  if (x === 0) return side === 'dry' ? 1 : 0;
  if (x === 1) return side === 'dry' ? 0 : 1;
  const th = (x * Math.PI) / 2;
  return side === 'dry' ? Math.cos(th) : Math.sin(th);
}

/* ------------------------------------------------------------------ */
/* Worklet-backed stages                                               */
/* ------------------------------------------------------------------ */

/**
 * A stereo AudioWorkletNode for one of the engine's processors, with an
 * error that names the missing processor (the engine loads every processor
 * source before it builds modules, see loadEngineWorklets).
 */
export function stereoWorklet(
  ctx: BaseAudioContext,
  processor: string,
  label: string,
  opts: { parameterData?: Record<string, number>; processorOptions?: unknown } = {},
): AudioWorkletNode {
  try {
    return new AudioWorkletNode(ctx, processor, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      parameterData: opts.parameterData,
      processorOptions: opts.processorOptions,
    });
  } catch (e) {
    throw new Error(`${label} needs the '${processor}' worklet loaded into the audio context first (${String(e)})`);
  }
}

/** A named AudioParam of a worklet node (throws a clear error if the processor lacks it). */
export function workletParam(node: AudioWorkletNode, name: string, label: string): AudioParam {
  const param = node.parameters.get(name);
  if (!param) throw new Error(`${label} worklet is missing its '${name}' parameter`);
  return param;
}

/**
 * Resets a studio processor's internal state (envelopes, delay lines,
 * filter memories) sample-accurately: every processor watches a k-rate
 * "flush" counter. Works the same live and offline (a port message would
 * arrive at an unpredictable render quantum).
 */
export class WorkletFlush {
  private count = 0;
  constructor(private readonly param: AudioParam) {}
  fire(time: number): void {
    this.count += 1;
    this.param.setValueAtTime(this.count, time);
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
  /** Song automation in progress (automate): how smooth() writes, else null, and the point's time. */
  private autoMode: AutomationMode | null = null;
  private autoTime = 0;
  /** Per AudioParam: end of the song automation that owns it (an anchor leaves it alone until then). */
  private readonly autoUntil = new Map<AudioParam, number>();
  /** Time of the previous automation point, and per AudioParam the time automation last wrote it. */
  private autoPrev = 0;
  private readonly autoLast = new Map<AudioParam, number>();
  private readonly timers = new Set<number>();
  private readonly worklets: AudioWorkletNode[] = [];

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

  cancelAfter(time: number, hold = false): void {
    if (this.disposed) return;
    const t = Number.isFinite(time) ? Math.max(0, time) : this.ctx.currentTime;
    for (const p of this.targets.keys()) {
      if (hold) p.cancelAndHoldAtTime(t);
      else p.cancelScheduledValues(t);
    }
    for (const [p, until] of [...this.autoUntil]) if (until >= t) this.autoUntil.delete(p);
    // Values we believed scheduled may be gone; re-apply everything next time.
    this.targets.clear();
    this.afterCancel(t);
  }

  /** Stop: no param stays owned by a ramp; cancelAfter already made the next setParams write everything. */
  endAutomation(_time: number): void {
    this.autoUntil.clear();
    this.autoLast.clear();
    this.targets.clear();
  }

  /** Song automation: apply params at `time` as an anchor, a step or the end of a linear ramp (see ModuleNode.automate). */
  automate(params: ParamValues, time: number, mode: AutomationMode): void {
    if (this.disposed) return;
    this.autoMode = mode;
    this.autoTime = Number.isFinite(time) ? time : this.ctx.currentTime;
    try {
      this.setParams(params, time);
    } finally {
      this.autoMode = null;
      this.autoPrev = this.autoTime;
    }
  }

  /** Subclass hook after automation past `time` was cancelled. */
  protected afterCancel(_time: number): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.timers) this.env.clearTimer(id);
    this.timers.clear();
    // Let worklet processors stop and be collected once disconnected.
    for (const w of this.worklets) w.port.postMessage('dispose');
    this.worklets.length = 0;
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

  /** Track a worklet node: disconnected and told to stop on dispose. */
  protected ownWorklet(node: AudioWorkletNode): AudioWorkletNode {
    this.worklets.push(node);
    return this.own(node);
  }

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
    const mode = this.autoMode;
    if (mode) {
      const t = Math.max(time, this.autoTime);
      const prev = this.targets.get(param);
      if (mode === 'anchor') {
        // Every value starts exactly here, except params another ramp still owns.
        if ((this.autoUntil.get(param) ?? -Infinity) > t) return;
      } else if (prev === value) {
        return;
      } else if (mode === 'ramp') {
        // Held unchanged over the points before (a flat stretch): the move starts at the previous point.
        const last = this.autoLast.get(param);
        if (prev !== undefined && last !== undefined && last < this.autoPrev - 1e-9 && this.autoPrev < t) param.setValueAtTime(prev, this.autoPrev);
      }
      this.targets.set(param, value);
      if (mode === 'ramp') param.linearRampToValueAtTime(value, t);
      else param.setValueAtTime(value, t);
      this.autoLast.set(param, t);
      if (mode !== 'anchor') this.autoUntil.set(param, t);
      return;
    }
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
