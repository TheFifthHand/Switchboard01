/**
 * Stereo Width module: mid/side width with mono bass.
 *
 *   in ─ split ─ M = (L+R)/2 ──────────────────────────────┬─ L = M + w·S'
 *              └ S = (L−R)/2 ─┬─ high-pass (Mono Bass) ─┐   └─ R = M − w·S'
 *                             └──── (when off) ─────────┴─ S' ─ ×w
 *
 * Width w = 0 is mono, 1 unchanged, 2 twice the side signal. Mono Bass
 * high-passes the side signal (12 dB/oct) so everything below it stays in
 * the centre: wide pads, solid bass. All the way down (20 Hz) it is off,
 * crossfaded like the EQ's cut stages. Width is an audio-rate control
 * (ControlBus: knob + 'width' modulation, clamped to 0..2).
 */
import { WIDENER_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { BUTTERWORTH_Q_DB, ControlBus, EffectModule, SWITCH_TAU, makeControlCurve } from './fxutil';
import type { ModuleEnv } from './types';

/** Mono Bass at or below this is off. */
export const WIDENER_MONO_OFF = 20;

export class WidenerModule extends EffectModule {
  readonly type = 'widener' as const;
  private readonly ctl: ControlBus;
  private readonly hp: BiquadFilterNode;
  private readonly hpWet: GainNode;
  private readonly hpDry: GainNode;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const mono = { channelCount: 1, channelCountMode: 'explicit' } as const;
    const width = readParam(WIDENER_PARAMS, params, 'width');
    const monoBass = readParam(WIDENER_PARAMS, params, 'monoBass');
    const on = monoBass > WIDENER_MONO_OFF;

    const split = this.own(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
    const merge = this.own(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    this.bypass.input.connect(split);
    const mid = this.own(new GainNode(ctx, mono));
    const side = this.own(new GainNode(ctx, mono));
    const half = (from: number, to: GainNode, g: number) => {
      const n = this.own(new GainNode(ctx, { gain: g, ...mono }));
      split.connect(n, from);
      n.connect(to);
    };
    half(0, mid, 0.5);
    half(1, mid, 0.5);
    half(0, side, 0.5);
    half(1, side, -0.5);

    this.hp = this.own(new BiquadFilterNode(ctx, { type: 'highpass', frequency: monoBass, Q: BUTTERWORTH_Q_DB, ...mono }));
    this.hpWet = this.own(new GainNode(ctx, { gain: on ? 1 : 0, ...mono }));
    this.hpDry = this.own(new GainNode(ctx, { gain: on ? 0 : 1, ...mono }));
    const sideOut = this.own(new GainNode(ctx, mono));
    side.connect(this.hp);
    this.hp.connect(this.hpWet);
    side.connect(this.hpDry);
    this.hpWet.connect(sideOut);
    this.hpDry.connect(sideOut);

    // Width: u = width/2 + mod/2, clamped to 0..1, curve 2u -> side gain 0..2.
    this.ctl = new ControlBus(ctx, width / 2, 0.5, this.own);
    this.registerMod('width', this.ctl.modInput);
    const widthGain = this.own(new GainNode(ctx, { gain: 0, ...mono }));
    sideOut.connect(widthGain);
    this.ctl.map(makeControlCurve((d) => 2 * d), widthGain.gain);

    const outL = this.own(new GainNode(ctx, mono));
    const outR = this.own(new GainNode(ctx, mono));
    const neg = this.own(new GainNode(ctx, { gain: -1, ...mono }));
    mid.connect(outL);
    mid.connect(outR);
    widthGain.connect(outL);
    widthGain.connect(neg);
    neg.connect(outR);
    outL.connect(merge, 0, 0);
    outR.connect(merge, 0, 1);
    merge.connect(this.bypass.processed);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const monoBass = readParam(WIDENER_PARAMS, params, 'monoBass');
    const on = monoBass > WIDENER_MONO_OFF;
    this.smooth(this.ctl.base.offset, readParam(WIDENER_PARAMS, params, 'width') / 2, t);
    if (on) this.smooth(this.hp.frequency, monoBass, t);
    this.smooth(this.hpWet.gain, on ? 1 : 0, t, SWITCH_TAU);
    this.smooth(this.hpDry.gain, on ? 0 : 1, t, SWITCH_TAU);
  }
}
