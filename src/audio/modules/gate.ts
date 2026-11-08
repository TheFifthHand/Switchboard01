/**
 * Gate module: stereo-linked noise gate in an AudioWorklet ('sb-gate', see
 * src/audio/worklets/dynamics.ts). Below the threshold the sound is turned
 * down by Depth dB; Attack and Release set how fast it opens and closes.
 * Hysteresis and a short hold keep it from chattering on decaying notes.
 *
 *   in ─ gate worklet (threshold, range, attack, release) ─> out
 *   threshold mod ─ ×30 dB ─> worklet 'threshold' AudioParam (clamped to −80..0 dB)
 */
import { MODULE_DEFS } from '../../project/modules';
import { GATE_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { GATE_PROCESSOR_NAME } from '../worklets/dynamics';
import { EffectModule, WorkletFlush, stereoWorklet, workletParam } from './fxutil';
import type { ModuleEnv } from './types';

const IDS = ['threshold', 'range', 'attack', 'release'] as const;
/** dB of threshold movement per full-scale modulation signal (the port's modRange). */
export const GATE_THRESHOLD_MOD_DB = MODULE_DEFS.gate.ports.find((p) => p.id === 'threshold')?.modRange?.amount ?? 30;

export class GateModule extends EffectModule {
  readonly type = 'gate' as const;
  private readonly params = new Map<string, AudioParam>();
  private readonly flusher: WorkletFlush;
  private reduction = 0;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const parameterData: Record<string, number> = {};
    for (const k of IDS) parameterData[k] = readParam(GATE_PARAMS, params, k);
    let node: AudioWorkletNode;
    try {
      node = this.ownWorklet(stereoWorklet(this.ctx, GATE_PROCESSOR_NAME, 'Gate', { parameterData, processorOptions: { report: !env.offline } }));
    } catch (e) {
      super.dispose();
      throw e;
    }
    for (const k of IDS) this.params.set(k, workletParam(node, k, 'Gate'));
    if (!env.offline) {
      node.port.onmessage = (e: MessageEvent) => {
        this.reduction = typeof e.data === 'number' && Number.isFinite(e.data) ? Math.max(0, e.data) : 0;
      };
    }
    this.flusher = new WorkletFlush(workletParam(node, 'flush', 'Gate'));
    this.bypass.input.connect(node);
    node.connect(this.bypass.processed);
    const modIn = this.own(new GainNode(this.ctx, { gain: GATE_THRESHOLD_MOD_DB, channelCount: 1, channelCountMode: 'explicit' }));
    modIn.connect(this.params.get('threshold')!);
    this.registerMod('threshold', modIn);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    for (const k of IDS) this.smooth(this.params.get(k)!, readParam(GATE_PARAMS, params, k), t);
  }

  /** Gain reduction in dB (>= 0) last reported by the worklet (live engines; 0 offline). */
  get reductionDb(): number {
    return this.disposed ? 0 : this.reduction;
  }

  /** Mute All: the gate closes and forgets the level it was following. */
  flush(): void {
    if (!this.disposed) this.flusher.fire(this.ctx.currentTime);
  }
}
