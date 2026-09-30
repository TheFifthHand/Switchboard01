/**
 * Phaser module: six all-pass stages swept by a sine LFO, with bounded
 * feedback, blended with the dry signal.
 *
 *   in ─┬─ dry ──────────────────────────────────────────┐
 *       └─ inScale ─> chainIn ─ AP×6 ─ chainOut ─ wet ─┴─> out
 *                       ^                 │
 *                       └─ fbDelay ─ fb ──┘   (fb <= 0.8)
 *   lfo ─ sweep (cents) ─> detune of every stage
 *
 * The stages sit at 935 Hz (geometric centre of 250 Hz..3.5 kHz); depth 1
 * sweeps them across that whole range. Web Audio needs a DelayNode in every
 * cycle; it is set to its minimum (one render quantum). Loop gain is at most
 * fb (all-passes have unit gain), so it cannot run away; the input is scaled
 * by sqrt(1 − fb²) so broadband level stays even as feedback rises.
 */
import { PHASER_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { ControlBus, EffectModule } from './fxutil';
import type { ModuleEnv } from './types';

const STAGES = 6;
const LOW = 250;
const HIGH = 3500;
const CENTER = Math.sqrt(LOW * HIGH);
/** Sweep half-range in cents at depth 1 (centre to either edge). */
export const PHASER_SWEEP_CENTS = (1200 * Math.log2(HIGH / LOW)) / 2;
const STAGE_Q = 0.7;

function inputScale(feedback: number): number {
  return Math.sqrt(1 - feedback * feedback);
}

export class PhaserModule extends EffectModule {
  readonly type = 'phaser' as const;
  private readonly ctl: ControlBus;
  private readonly lfo: OscillatorNode;
  private readonly sweep: GainNode;
  private readonly fb: GainNode;
  private readonly inScale: GainNode;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const rate = readParam(PHASER_PARAMS, params, 'rate');
    const depth = readParam(PHASER_PARAMS, params, 'depth');
    const feedback = readParam(PHASER_PARAMS, params, 'feedback');
    const mix = readParam(PHASER_PARAMS, params, 'mix');

    const sum = this.own(new GainNode(ctx));
    sum.connect(this.bypass.processed);
    this.ctl = new ControlBus(ctx, mix, 1, this.own);
    this.registerMod('mix', this.ctl.modInput);
    const { dry, wet } = this.ctl.blend();
    this.bypass.input.connect(dry);
    dry.connect(sum);
    wet.connect(sum);

    this.inScale = this.own(new GainNode(ctx, { gain: inputScale(feedback) }));
    const chainIn = this.own(new GainNode(ctx));
    this.bypass.input.connect(this.inScale);
    this.inScale.connect(chainIn);
    this.lfo = this.own(new OscillatorNode(ctx, { type: 'sine', frequency: rate }));
    this.sweep = this.own(new GainNode(ctx, { gain: depth * PHASER_SWEEP_CENTS }));
    this.lfo.connect(this.sweep);
    let node: AudioNode = chainIn;
    for (let i = 0; i < STAGES; i++) {
      const ap = this.own(new BiquadFilterNode(ctx, { type: 'allpass', frequency: CENTER, Q: STAGE_Q }));
      node.connect(ap);
      this.sweep.connect(ap.detune);
      node = ap;
    }
    const chainOut = node;
    chainOut.connect(wet);

    this.fb = this.own(new GainNode(ctx, { gain: feedback }));
    // delayTime 0 is raised to one render quantum inside a cycle.
    const fbDelay = this.own(new DelayNode(ctx, { maxDelayTime: 0.01, delayTime: 0 }));
    chainOut.connect(this.fb);
    this.fb.connect(fbDelay);
    fbDelay.connect(chainIn);
    this.lfo.start(ctx.currentTime);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const feedback = readParam(PHASER_PARAMS, params, 'feedback');
    this.smooth(this.lfo.frequency, readParam(PHASER_PARAMS, params, 'rate'), t);
    this.smooth(this.sweep.gain, readParam(PHASER_PARAMS, params, 'depth') * PHASER_SWEEP_CENTS, t);
    this.smooth(this.fb.gain, feedback, t);
    this.smooth(this.inScale.gain, inputScale(feedback), t);
    this.smooth(this.ctl.base.offset, readParam(PHASER_PARAMS, params, 'mix'), t);
  }
}
