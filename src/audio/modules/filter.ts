/**
 * Filter module: low-pass / high-pass / band-pass with bounded resonance,
 * followed by a 3.5 kHz high-shelf ("Brightness").
 *
 *   in ─┬─ selLP ─ LP ─ lpMakeup ─┐
 *       ├─ selHP ─ HP ────────────┼─ sum ─ shelf ─> out
 *       └─ selBP ─ BP ────────────┘
 *   cutoff mod ─ clamp(±1) ─ smoother (50 Hz) ─ ×4800 ct ─> detune of all three filters
 *
 * Each mode has its own biquad, so switching mode is a short crossfade of
 * their inputs instead of changing a live filter's type (which clicks); the
 * old mode's filter rings out naturally. Resonance maps to a conventional Q of 0.5..12; low/high-pass use
 * Web Audio's dB form of that Q, and their output is trimmed as Q rises so
 * the resonant peak stays musical rather than jumping +21 dB.
 *
 * The low-pass trim follows where its (modulated) cutoff sits: a peak well
 * inside the audible band (below about 8 kHz) gets the full trim, one at or
 * above about 16 kHz none, with a smooth raised-cosine step between. A
 * wide-open low-pass therefore no longer just gets quieter as Resonance goes
 * up (its peak sits above nearly everything a part plays), while a closed
 * one still rings at the same level as before. The trim is computed at audio
 * rate from the cutoff knob plus the smoothed modulation:
 *   u = (cents of cutoff above 16 kHz + modulation cents) / 4800
 *   ─ weight shaper w(u) ─ × (−0.3·ln Q) ─ exp shaper ─> lpMakeup gain = Q^(−0.3·w)
 *
 * The modulation is slew-limited because BiquadFilterNode is a direct-form
 * structure: when a square or saw LFO drops the cutoff several octaves within
 * a few samples at high Q, the filter's stored slope turns into a huge
 * oscillation at the new cutoff (peaks near 30 were measured from a saw of
 * amplitude 0.5; about 1.5 with the smoother). A critically damped two-pole
 * low-pass with its −3 dB corner at 50 Hz (10–90 % rise in about 7 ms)
 * removes that while leaving tempo-synced LFO sweeps essentially untouched.
 * It never overshoots, so its output is a weighted average of clamped values
 * and the ±4800 cent bound still holds.
 */
import { FILTER_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { EffectModule, SWITCH_TAU, controlSmoother, identityCurve, linearQToDb, shaperNode } from './fxutil';
import type { ModuleEnv } from './types';

const MODE_TYPES: readonly BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass'];
const LOWPASS = 0;
const HIGHPASS = 1;
const BANDPASS = 2;
/** Full-scale cutoff modulation in cents (matches the port's modRange). */
const CUTOFF_MOD_CENTS = 4800;
/** −3 dB corner of the (critically damped) smoother on the cutoff modulation (Hz). */
export const CUTOFF_MOD_SMOOTH_HZ = 50;
const SHELF_FREQ = 3500;

/** Conventional Q for resonance 0..1: 0.5 .. 12. */
export function filterQ(resonance: number): number {
  const r = Math.min(1, Math.max(0, resonance));
  return 0.5 + r * r * 11.5;
}

/** Output trim for low/high-pass at conventional Q `q` (peak at Q=12 is about +15 dB). */
export function resonanceMakeup(q: number): number {
  return q > 1 ? Math.pow(q, -0.3) : 1;
}

/** Below this cutoff the low-pass gets its full resonance trim (Hz). */
export const MAKEUP_FULL_HZ = 8000;
/** At or above this cutoff the low-pass gets no resonance trim (Hz). */
export const MAKEUP_NONE_HZ = 16000;
/** Cents per unit of the trim's control signal (the weight shaper spans ±4 octaves around 16 kHz). */
const MAKEUP_SPAN_CENTS = 4800;
const MAKEUP_FULL_CENTS = 1200 * Math.log2(MAKEUP_FULL_HZ / MAKEUP_NONE_HZ);

/**
 * Share (0..1) of the resonance trim the low-pass gets with its cutoff at
 * `hz`: 1 up to MAKEUP_FULL_HZ, 0 from MAKEUP_NONE_HZ, a raised cosine (in
 * pitch) between.
 */
export function makeupWeight(hz: number): number {
  if (!(hz > 0)) return 1;
  const c = 1200 * Math.log2(hz / MAKEUP_NONE_HZ);
  if (c <= MAKEUP_FULL_CENTS) return 1;
  if (c >= 0) return 0;
  return 0.5 + 0.5 * Math.cos((Math.PI * (c - MAKEUP_FULL_CENTS)) / -MAKEUP_FULL_CENTS);
}

/** Low-pass output trim at conventional Q `q` with the cutoff at `hz` (modulation included). */
export function lowpassMakeup(q: number, hz: number): number {
  return q > 1 ? Math.pow(q, -0.3 * makeupWeight(hz)) : 1;
}

/** Control-signal value (u) for a cutoff in Hz: cents relative to MAKEUP_NONE_HZ / MAKEUP_SPAN_CENTS. */
function makeupPosition(hz: number): number {
  return (1200 * Math.log2(Math.max(1, hz) / MAKEUP_NONE_HZ)) / MAKEUP_SPAN_CENTS;
}

let weightCurve: Float32Array<ArrayBuffer> | null = null;
let expCurve: Float32Array<ArrayBuffer> | null = null;

/** u (−1..1, held beyond) -> makeupWeight of the cutoff it stands for. */
function makeupWeightCurve(): Float32Array<ArrayBuffer> {
  if (!weightCurve) {
    const n = 4097;
    weightCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = (2 * i) / (n - 1) - 1;
      weightCurve[i] = makeupWeight(MAKEUP_NONE_HZ * Math.pow(2, (u * MAKEUP_SPAN_CENTS) / 1200));
    }
  }
  return weightCurve;
}

/** e (−1..1) -> exp(e): the trim exponent becomes a gain (only e in −0.75..0 occurs). */
function makeupExpCurve(): Float32Array<ArrayBuffer> {
  if (!expCurve) {
    const n = 4097;
    expCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) expCurve[i] = Math.exp((2 * i) / (n - 1) - 1);
    // Exactly 1 for exponent 0 (no trim).
    expCurve[(n - 1) / 2] = 1;
  }
  return expCurve;
}

/** Gain of the trim exponent stage for conventional Q `q`: −0.3·ln(Q), 0 without resonance. */
function makeupExponent(q: number): number {
  return q > 1 ? -0.3 * Math.log(q) : 0;
}


export class FilterModule extends EffectModule {
  readonly type = 'filter' as const;
  private readonly filters: BiquadFilterNode[] = [];
  private readonly sels: GainNode[] = [];
  private readonly shelf: BiquadFilterNode;
  /** Control-signal base of the low-pass trim (the cutoff knob's position). */
  private readonly makeupPos: ConstantSourceNode;
  /** −0.3·ln(Q): scales the weight into the trim exponent. */
  private readonly makeupExp: GainNode;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const mode = readParam(FILTER_PARAMS, params, 'mode');
    const cutoff = readParam(FILTER_PARAMS, params, 'cutoff');
    const q = filterQ(readParam(FILTER_PARAMS, params, 'resonance'));
    const bright = readParam(FILTER_PARAMS, params, 'bright');

    const sum = this.own(new GainNode(ctx));
    this.shelf = this.own(new BiquadFilterNode(ctx, { type: 'highshelf', frequency: SHELF_FREQ, gain: bright }));
    sum.connect(this.shelf);
    this.shelf.connect(this.bypass.processed);

    // Modulation: clamp the summed signal to ±1, slew-limit it, then scale to cents.
    const mono = { channelCount: 1, channelCountMode: 'explicit' } as const;
    const modIn = this.own(new GainNode(ctx, { gain: 1, ...mono }));
    const modClamp = this.own(shaperNode(ctx, identityCurve(), mono));
    const modSmooth = this.own(controlSmoother(ctx, CUTOFF_MOD_SMOOTH_HZ));
    const modScale = this.own(new GainNode(ctx, { gain: CUTOFF_MOD_CENTS, ...mono }));
    modIn.connect(modClamp);
    modClamp.connect(modSmooth);
    modSmooth.connect(modScale);
    this.registerMod('cutoff', modIn);

    // Low-pass resonance trim, following the modulated cutoff (see the file comment).
    this.makeupPos = this.own(new ConstantSourceNode(ctx, { offset: makeupPosition(cutoff) }));
    const posSum = this.own(new GainNode(ctx, { gain: 1, ...mono }));
    const posMod = this.own(new GainNode(ctx, { gain: 1 / MAKEUP_SPAN_CENTS, ...mono }));
    const weight = this.own(shaperNode(ctx, makeupWeightCurve(), { oversample: 'none', ...mono }));
    this.makeupExp = this.own(new GainNode(ctx, { gain: makeupExponent(q), ...mono }));
    const trim = this.own(shaperNode(ctx, makeupExpCurve(), { oversample: 'none', ...mono }));
    const lpMakeup = this.own(new GainNode(ctx, { gain: 0 }));
    this.makeupPos.connect(posSum);
    modScale.connect(posMod);
    posMod.connect(posSum);
    posSum.connect(weight);
    weight.connect(this.makeupExp);
    this.makeupExp.connect(trim);
    trim.connect(lpMakeup.gain);
    lpMakeup.connect(sum);
    this.makeupPos.start();

    for (let i = 0; i < MODE_TYPES.length; i++) {
      const f = this.own(
        new BiquadFilterNode(ctx, {
          type: MODE_TYPES[i],
          frequency: cutoff,
          Q: i === BANDPASS ? q : linearQToDb(q),
        }),
      );
      const sel = this.own(new GainNode(ctx, { gain: selLevel(i, mode, q) }));
      // Gate before the filter: an idle mode's filter gets silence, which lets
      // the browser skip it once its tail has died away.
      this.bypass.input.connect(sel);
      sel.connect(f);
      f.connect(i === LOWPASS ? lpMakeup : sum);
      modScale.connect(f.detune);
      this.filters.push(f);
      this.sels.push(sel);
    }
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const mode = readParam(FILTER_PARAMS, params, 'mode');
    const cutoff = readParam(FILTER_PARAMS, params, 'cutoff');
    const q = filterQ(readParam(FILTER_PARAMS, params, 'resonance'));
    const bright = readParam(FILTER_PARAMS, params, 'bright');
    const qDb = linearQToDb(q);
    for (let i = 0; i < this.filters.length; i++) {
      const f = this.filters[i];
      this.smooth(f.frequency, cutoff, t);
      this.smooth(f.Q, i === BANDPASS ? q : qDb, t);
      this.smooth(this.sels[i].gain, selLevel(i, mode, q), t, SWITCH_TAU);
    }
    this.smooth(this.makeupPos.offset, makeupPosition(cutoff), t);
    this.smooth(this.makeupExp.gain, makeupExponent(q), t);
    this.smooth(this.shelf.gain, bright, t);
  }
}

/** Input gate of mode `i`: 0 unless selected; the high-pass carries its resonance trim here (the low-pass has its own stage). */
function selLevel(i: number, mode: number, q: number): number {
  if (i !== mode) return 0;
  return i === HIGHPASS ? resonanceMakeup(q) : 1;
}
