/**
 * Filter module: low-pass / high-pass / band-pass with bounded resonance,
 * followed by a 3.5 kHz high-shelf ("Brightness").
 *
 *   in ─┬─ selLP ─ LP ─┐
 *       ├─ selHP ─ HP ─┼─ sum ─ shelf ─> out
 *       └─ selBP ─ BP ─┘
 *   cutoff mod ─ clamp(±1) ─ one-pole 50 Hz ─ ×4800 ct ─> detune of all three filters
 *
 * Each mode has its own biquad, so switching mode is a short crossfade of
 * their inputs instead of changing a live filter's type (which clicks); the
 * old mode's filter rings out naturally. Resonance maps to a conventional Q of 0.5..12; low/high-pass use
 * Web Audio's dB form of that Q, and their output is trimmed as Q rises so
 * the resonant peak stays musical rather than jumping +21 dB.
 *
 * The modulation is slew-limited because BiquadFilterNode is a direct-form
 * structure: when a square or saw LFO drops the cutoff several octaves within
 * a few samples at high Q, the filter's stored slope turns into a huge
 * oscillation at the new cutoff (peaks near 30 were measured from a saw of
 * amplitude 0.5; about 1.5 with the smoother). A 3 ms one-pole
 * removes that while leaving tempo-synced LFO sweeps essentially untouched
 * (-0.4 dB, about 3 ms of lag at 15 Hz). Its output is a weighted average of
 * clamped values, so the ±4800 cent bound still holds.
 */
import { FILTER_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { EffectModule, SWITCH_TAU, identityCurve, linearQToDb } from './fxutil';
import type { ModuleEnv } from './types';

const MODE_TYPES: readonly BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass'];
const BANDPASS = 2;
/** Full-scale cutoff modulation in cents (matches the port's modRange). */
const CUTOFF_MOD_CENTS = 4800;
/** Corner of the one-pole smoother on the cutoff modulation (Hz). */
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

export class FilterModule extends EffectModule {
  readonly type = 'filter' as const;
  private readonly filters: BiquadFilterNode[] = [];
  private readonly sels: GainNode[] = [];
  private readonly shelf: BiquadFilterNode;

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
    const modClamp = this.own(new WaveShaperNode(ctx, { curve: identityCurve(), ...mono }));
    const a = Math.exp((-2 * Math.PI * CUTOFF_MOD_SMOOTH_HZ) / ctx.sampleRate);
    const modSmooth = this.own(new IIRFilterNode(ctx, { feedforward: [1 - a], feedback: [1, -a], ...mono }));
    const modScale = this.own(new GainNode(ctx, { gain: CUTOFF_MOD_CENTS, ...mono }));
    modIn.connect(modClamp);
    modClamp.connect(modSmooth);
    modSmooth.connect(modScale);
    this.registerMod('cutoff', modIn);

    for (let i = 0; i < MODE_TYPES.length; i++) {
      const f = this.own(
        new BiquadFilterNode(ctx, {
          type: MODE_TYPES[i],
          frequency: cutoff,
          Q: i === BANDPASS ? q : linearQToDb(q),
        }),
      );
      const sel = this.own(new GainNode(ctx, { gain: i === mode ? (i === BANDPASS ? 1 : resonanceMakeup(q)) : 0 }));
      // Gate before the filter: an idle mode's filter gets silence, which lets
      // the browser skip it once its tail has died away.
      this.bypass.input.connect(sel);
      sel.connect(f);
      f.connect(sum);
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
      const level = i === mode ? (i === BANDPASS ? 1 : resonanceMakeup(q)) : 0;
      this.smooth(this.sels[i].gain, level, t, SWITCH_TAU);
    }
    this.smooth(this.shelf.gain, bright, t);
  }
}
