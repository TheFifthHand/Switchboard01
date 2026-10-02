/**
 * Compressor module: stereo-linked feed-forward compressor in an AudioWorklet
 * ('sb-compressor', see src/audio/worklets/dynamics.ts) with soft knee,
 * attack / release ballistics, make-up gain and a parallel Mix (Mix below
 * 100 % blends the untouched sound back in: parallel compression).
 *
 *   in ─ compressor worklet (threshold, ratio, attack, release, makeup, mix) ─> out
 *   mix mod ─> worklet 'mix' AudioParam (clamped to 0..1 by its range)
 *
 * No look-ahead, so no latency: the part stays in time with the others.
 */
import { COMPRESSOR_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { COMPRESSOR_PROCESSOR_NAME } from '../worklets/dynamics';
import { EffectModule, WorkletFlush, stereoWorklet, workletParam } from './fxutil';
import type { ModuleEnv } from './types';

const IDS = ['threshold', 'ratio', 'attack', 'release', 'makeup', 'mix'] as const;

export class CompressorModule extends EffectModule {
  readonly type = 'compressor' as const;
  private readonly params = new Map<string, AudioParam>();
  private readonly flusher: WorkletFlush;
  private reduction = 0;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const parameterData: Record<string, number> = {};
    for (const k of IDS) parameterData[k] = readParam(COMPRESSOR_PARAMS, params, k);
    let node: AudioWorkletNode;
    try {
      node = this.ownWorklet(stereoWorklet(this.ctx, COMPRESSOR_PROCESSOR_NAME, 'Compressor', { parameterData, processorOptions: { report: !env.offline } }));
    } catch (e) {
      super.dispose();
      throw e;
    }
    for (const k of IDS) this.params.set(k, workletParam(node, k, 'Compressor'));
    if (!env.offline) {
      node.port.onmessage = (e: MessageEvent) => {
        this.reduction = typeof e.data === 'number' && Number.isFinite(e.data) ? Math.max(0, e.data) : 0;
      };
    }
    this.flusher = new WorkletFlush(workletParam(node, 'flush', 'Compressor'));
    this.bypass.input.connect(node);
    node.connect(this.bypass.processed);
    const modIn = this.own(new GainNode(this.ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit' }));
    modIn.connect(this.params.get('mix')!);
    this.registerMod('mix', modIn);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    for (const k of IDS) this.smooth(this.params.get(k)!, readParam(COMPRESSOR_PARAMS, params, k), t);
  }

  /** Gain reduction in dB (>= 0) last reported by the worklet (live engines; 0 offline). */
  get reductionDb(): number {
    return this.disposed ? 0 : this.reduction;
  }

  /** Mute All: forget the gain reduction in progress. */
  flush(): void {
    if (!this.disposed) this.flusher.fire(this.ctx.currentTime);
  }
}
