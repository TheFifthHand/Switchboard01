/**
 * Tape module: saturation, wow and flutter, tape hiss and a tone low-pass,
 * in an AudioWorklet ('sb-tape', see src/audio/worklets/fx.ts).
 *
 *   in ─ tape worklet (drive, wobble, tone, hiss, mix; seeded) ─> out
 *   drive mod ─> worklet 'drive' AudioParam (clamped to 0..1 by its range)
 *
 * The hiss noise is seeded from the project seed and the module id, so
 * exports are reproducible. The saturation runs at 2x with half-band
 * filters that add no latency; the wobble adds a small delay that grows with
 * Wobble (about 0.5 ms at the default, 2.4 ms at most) — the dry path for
 * Mix is delayed to match.
 */
import { TAPE_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { TAPE_PROCESSOR_NAME } from '../worklets/fx';
import { EffectModule, WorkletFlush, stereoWorklet, workletParam } from './fxutil';
import type { ModuleEnv } from './types';

const IDS = ['drive', 'wobble', 'tone', 'hiss', 'mix'] as const;

export class TapeModule extends EffectModule {
  readonly type = 'tape' as const;
  private readonly params = new Map<string, AudioParam>();
  private readonly flusher: WorkletFlush;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const parameterData: Record<string, number> = {};
    for (const k of IDS) parameterData[k] = readParam(TAPE_PARAMS, params, k);
    let node: AudioWorkletNode;
    try {
      node = this.ownWorklet(stereoWorklet(this.ctx, TAPE_PROCESSOR_NAME, 'Tape', { parameterData, processorOptions: { seed: env.seed >>> 0 } }));
    } catch (e) {
      super.dispose();
      throw e;
    }
    for (const k of IDS) this.params.set(k, workletParam(node, k, 'Tape'));
    this.flusher = new WorkletFlush(workletParam(node, 'flush', 'Tape'));
    this.bypass.input.connect(node);
    node.connect(this.bypass.processed);
    const modIn = this.own(new GainNode(this.ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit' }));
    modIn.connect(this.params.get('drive')!);
    this.registerMod('drive', modIn);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    for (const k of IDS) this.smooth(this.params.get(k)!, readParam(TAPE_PARAMS, params, k), t);
  }

  /** Mute All: clear the wobble line, filters and hiss follower. */
  flush(): void {
    if (!this.disposed) this.flusher.fire(this.ctx.currentTime);
  }
}
