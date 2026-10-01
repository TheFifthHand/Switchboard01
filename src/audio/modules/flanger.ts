/**
 * Flanger module: a short swept delay with feedback, in an AudioWorklet
 * ('sb-flanger', see src/audio/worklets/fx.ts), blended with the dry sound.
 *
 *   in ─ flanger worklet (rate, depth, feedback, mix) ─> out
 *   mix mod ─> worklet 'mix' AudioParam (clamped to 0..1 by its range)
 *
 * Depth sweeps the delay from 0.3 ms up to 8 ms (exponentially, so the
 * notches move evenly in pitch); left and right sweep 90° apart. Feedback is
 * bounded at 0.85 and damped, so the sound never runs away; Mute All clears
 * the delay line.
 */
import { FLANGER_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { FLANGER_PROCESSOR_NAME } from '../worklets/fx';
import { EffectModule, WorkletFlush, stereoWorklet, workletParam } from './fxutil';
import type { ModuleEnv } from './types';

const IDS = ['rate', 'depth', 'feedback', 'mix'] as const;

export class FlangerModule extends EffectModule {
  readonly type = 'flanger' as const;
  private readonly params = new Map<string, AudioParam>();
  private readonly flusher: WorkletFlush;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const parameterData: Record<string, number> = {};
    for (const k of IDS) parameterData[k] = readParam(FLANGER_PARAMS, params, k);
    let node: AudioWorkletNode;
    try {
      node = this.ownWorklet(stereoWorklet(this.ctx, FLANGER_PROCESSOR_NAME, 'Flanger', { parameterData }));
    } catch (e) {
      super.dispose();
      throw e;
    }
    for (const k of IDS) this.params.set(k, workletParam(node, k, 'Flanger'));
    this.flusher = new WorkletFlush(workletParam(node, 'flush', 'Flanger'));
    this.bypass.input.connect(node);
    node.connect(this.bypass.processed);
    const modIn = this.own(new GainNode(this.ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit' }));
    modIn.connect(this.params.get('mix')!);
    this.registerMod('mix', modIn);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    for (const k of IDS) this.smooth(this.params.get(k)!, readParam(FLANGER_PARAMS, params, k), t);
  }

  /** Mute All: empty the delay line so the whoosh does not come back. */
  flush(): void {
    if (!this.disposed) this.flusher.fire(this.ctx.currentTime);
  }
}
