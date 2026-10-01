/**
 * EQ module: low cut, low shelf, peaking mid with width, high shelf, high cut.
 *
 *   in ─ [low cut] ─ low shelf ─ mid (peaking) ─ high shelf ─ [high cut] ─> out
 *   mid mod ─ clamp(±1) ─ one-pole 50 Hz ─ ×2400 ct ─> mid band detune
 *
 * Low and high cut are 12 dB/oct Butterworth filters. All the way down
 * (Low Cut 20 Hz) or up (High Cut 20 kHz) they are off: each cut stage
 * crossfades between its filter and a straight path, so switching it on or
 * off is click-free and "off" really is untouched sound. Shelves and the mid
 * band at 0 dB are exactly flat, so the default EQ changes nothing.
 * The mid band's modulation sweeps its centre ±2 octaves per full-scale
 * signal (a wah-like motion), clamped and slew-limited like the Filter's
 * cutoff input so a square LFO cannot make the band ring.
 */
import { EQ_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { BUTTERWORTH_Q_DB, EffectModule, SWITCH_TAU, identityCurve } from './fxutil';
import type { ModuleEnv } from './types';

/** Mid-band modulation per full-scale signal (matches the port's modRange). */
export const EQ_MID_MOD_CENTS = 2400;
const MOD_SMOOTH_HZ = 50;
/** Low Cut at or below this is off. */
export const EQ_LOW_CUT_OFF = 20;
/** High Cut at or above this is off. */
export const EQ_HIGH_CUT_OFF = 20000;

interface CutStage {
  filter: BiquadFilterNode;
  dry: GainNode;
  wet: GainNode;
  out: GainNode;
}

export class EqModule extends EffectModule {
  readonly type = 'eq' as const;
  private readonly lowCut: CutStage;
  private readonly highCut: CutStage;
  private readonly lowShelf: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;
  private readonly highShelf: BiquadFilterNode;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const v = (k: string) => readParam(EQ_PARAMS, params, k);
    const nyq = ctx.sampleRate / 2;

    this.lowCut = this.cutStage('highpass', v('lowCut'), v('lowCut') > EQ_LOW_CUT_OFF);
    this.highCut = this.cutStage('lowpass', Math.min(v('highCut'), nyq * 0.95), v('highCut') < EQ_HIGH_CUT_OFF);
    this.lowShelf = this.own(new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: v('lowFreq'), gain: v('lowGain') }));
    this.mid = this.own(new BiquadFilterNode(ctx, { type: 'peaking', frequency: v('midFreq'), Q: v('midQ'), gain: v('midGain') }));
    this.highShelf = this.own(new BiquadFilterNode(ctx, { type: 'highshelf', frequency: Math.min(v('highFreq'), nyq * 0.95), gain: v('highGain') }));

    this.bypass.input.connect(this.lowCut.dry);
    this.bypass.input.connect(this.lowCut.filter);
    this.lowCut.out.connect(this.lowShelf);
    this.lowShelf.connect(this.mid);
    this.mid.connect(this.highShelf);
    this.highShelf.connect(this.highCut.dry);
    this.highShelf.connect(this.highCut.filter);
    this.highCut.out.connect(this.bypass.processed);

    // Mid-band modulation: clamp to ±1, slew-limit, scale to cents.
    const mono = { channelCount: 1, channelCountMode: 'explicit' } as const;
    const modIn = this.own(new GainNode(ctx, { gain: 1, ...mono }));
    const clampNode = this.own(new WaveShaperNode(ctx, { curve: identityCurve(), ...mono }));
    const a = Math.exp((-2 * Math.PI * MOD_SMOOTH_HZ) / ctx.sampleRate);
    const smoothNode = this.own(new IIRFilterNode(ctx, { feedforward: [1 - a], feedback: [1, -a], ...mono }));
    const scale = this.own(new GainNode(ctx, { gain: EQ_MID_MOD_CENTS, ...mono }));
    modIn.connect(clampNode);
    clampNode.connect(smoothNode);
    smoothNode.connect(scale);
    scale.connect(this.mid.detune);
    this.registerMod('mid', modIn);
  }

  private cutStage(type: 'highpass' | 'lowpass', freq: number, on: boolean): CutStage {
    const ctx = this.ctx;
    const filter = this.own(new BiquadFilterNode(ctx, { type, frequency: freq, Q: BUTTERWORTH_Q_DB }));
    const dry = this.own(new GainNode(ctx, { gain: on ? 0 : 1 }));
    const wet = this.own(new GainNode(ctx, { gain: on ? 1 : 0 }));
    const out = this.own(new GainNode(ctx));
    filter.connect(wet);
    wet.connect(out);
    dry.connect(out);
    return { filter, dry, wet, out };
  }

  private setCut(stage: CutStage, freq: number, on: boolean, t: number): void {
    // While off the filter keeps its last corner, so switching on starts from there.
    if (on) this.smooth(stage.filter.frequency, freq, t);
    this.smooth(stage.wet.gain, on ? 1 : 0, t, SWITCH_TAU);
    this.smooth(stage.dry.gain, on ? 0 : 1, t, SWITCH_TAU);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const v = (k: string) => readParam(EQ_PARAMS, params, k);
    const nyq = this.ctx.sampleRate / 2;
    this.setCut(this.lowCut, v('lowCut'), v('lowCut') > EQ_LOW_CUT_OFF, t);
    this.setCut(this.highCut, Math.min(v('highCut'), nyq * 0.95), v('highCut') < EQ_HIGH_CUT_OFF, t);
    this.smooth(this.lowShelf.frequency, v('lowFreq'), t);
    this.smooth(this.lowShelf.gain, v('lowGain'), t);
    this.smooth(this.mid.frequency, v('midFreq'), t);
    this.smooth(this.mid.Q, v('midQ'), t);
    this.smooth(this.mid.gain, v('midGain'), t);
    this.smooth(this.highShelf.frequency, Math.min(v('highFreq'), nyq * 0.95), t);
    this.smooth(this.highShelf.gain, v('highGain'), t);
  }
}
