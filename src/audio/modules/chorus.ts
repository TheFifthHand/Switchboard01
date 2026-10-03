/**
 * Chorus module: two modulated delay lines (14 ms left, 19 ms right) swept by
 * sine LFOs 90 degrees apart, blended with the dry signal.
 *
 *   in ─┬─ dry ────────────────────────────────┐
 *       └─ split ─ lineL (14 ms ± swing) ─┐     │
 *                ─ lineR (19 ms ± swing) ─┴─ merge ─ wet ─┴─> out
 *   lfoL (sin) ─ depthL ─> lineL.delayTime
 *   lfoR (cos) ─ depthR ─> lineR.delayTime
 *
 * Depth 1 swings each line by ±3 ms (6 ms peak to peak). Mix (plus its
 * modulation, clamped to 0..1) crossfades dry and wet with an equal-power
 * law (dry cos, wet sin): the swept lines are decorrelated from the dry
 * sound, so switching the chorus in keeps the part's energy (a linear 50/50
 * blend lost about 3 dB).
 */
import { CHORUS_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { ControlBus, EffectModule } from './fxutil';
import type { ModuleEnv } from './types';

const BASE_DELAY = [0.014, 0.019] as const;
/** Peak delay deviation at depth 1 (seconds). */
export const CHORUS_MAX_SWING = 0.003;

export class ChorusModule extends EffectModule {
  readonly type = 'chorus' as const;
  private readonly ctl: ControlBus;
  private readonly lfos: OscillatorNode[] = [];
  private readonly depths: GainNode[] = [];

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const rate = readParam(CHORUS_PARAMS, params, 'rate');
    const depth = readParam(CHORUS_PARAMS, params, 'depth');
    const mix = readParam(CHORUS_PARAMS, params, 'mix');

    const sum = this.own(new GainNode(ctx));
    sum.connect(this.bypass.processed);
    this.ctl = new ControlBus(ctx, mix, 1, this.own);
    this.registerMod('mix', this.ctl.modInput);
    const { dry, wet } = this.ctl.blendEqualPower();
    this.bypass.input.connect(dry);
    dry.connect(sum);
    wet.connect(sum);

    const split = this.own(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
    const merge = this.own(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    this.bypass.input.connect(split);
    merge.connect(wet);
    // Quadrature LFOs: a plain sine and a cosine built as a one-partial PeriodicWave.
    const cosine = new PeriodicWave(ctx, { real: [0, 1], imag: [0, 0], disableNormalization: true });
    const start = ctx.currentTime;
    for (let c = 0; c < 2; c++) {
      const line = this.own(new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: BASE_DELAY[c] }));
      const lfo = this.own(
        c === 0 ? new OscillatorNode(ctx, { type: 'sine', frequency: rate }) : new OscillatorNode(ctx, { periodicWave: cosine, frequency: rate }),
      );
      const d = this.own(new GainNode(ctx, { gain: depth * CHORUS_MAX_SWING }));
      split.connect(line, c);
      line.connect(merge, 0, c);
      lfo.connect(d);
      d.connect(line.delayTime);
      lfo.start(start);
      this.lfos.push(lfo);
      this.depths.push(d);
    }
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const rate = readParam(CHORUS_PARAMS, params, 'rate');
    const swing = readParam(CHORUS_PARAMS, params, 'depth') * CHORUS_MAX_SWING;
    for (const lfo of this.lfos) this.smooth(lfo.frequency, rate, t);
    for (const d of this.depths) this.smooth(d.gain, swing, t);
    this.smooth(this.ctl.base.offset, readParam(CHORUS_PARAMS, params, 'mix'), t);
  }
}
