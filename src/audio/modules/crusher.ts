/**
 * Bit crusher module: bit-depth and sample-rate reduction in an AudioWorklet
 * ('sb-crusher', see src/audio/worklets/crusher.ts). The processor does the
 * dry/wet blend itself; the module adds bypass and parameter smoothing.
 *
 *   in ─ crusher worklet (bits, downsample, mix) ─> out
 *   mix mod ─> worklet 'mix' AudioParam (clamped to 0..1 by its range)
 *
 * The engine loads the worklet source before constructing modules.
 */
import { CRUSHER_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { CRUSHER_PROCESSOR_NAME } from '../worklets/crusher';
import { EffectModule } from './fxutil';
import type { ModuleEnv } from './types';

export class CrusherModule extends EffectModule {
  readonly type = 'crusher' as const;
  private readonly node: AudioWorkletNode;
  private readonly bits: AudioParam;
  private readonly downsample: AudioParam;
  private readonly mix: AudioParam;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const bits = readParam(CRUSHER_PARAMS, params, 'bits');
    const downsample = readParam(CRUSHER_PARAMS, params, 'downsample');
    const mix = readParam(CRUSHER_PARAMS, params, 'mix');
    let node: AudioWorkletNode;
    try {
      node = new AudioWorkletNode(ctx, CRUSHER_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        parameterData: { bits, downsample, mix },
      });
    } catch (e) {
      super.dispose();
      throw new Error(`Bit Crusher needs the '${CRUSHER_PROCESSOR_NAME}' worklet loaded into the audio context first (${String(e)})`);
    }
    this.node = this.own(node);
    const p = (name: string): AudioParam => {
      const param = node.parameters.get(name);
      if (!param) throw new Error(`Bit Crusher worklet is missing its '${name}' parameter`);
      return param;
    };
    this.bits = p('bits');
    this.downsample = p('downsample');
    this.mix = p('mix');

    this.bypass.input.connect(node);
    node.connect(this.bypass.processed);
    const modIn = this.own(new GainNode(ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit' }));
    modIn.connect(this.mix);
    this.registerMod('mix', modIn);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    this.smooth(this.bits, readParam(CRUSHER_PARAMS, params, 'bits'), t);
    this.smooth(this.downsample, readParam(CRUSHER_PARAMS, params, 'downsample'), t);
    this.smooth(this.mix, readParam(CRUSHER_PARAMS, params, 'mix'), t);
  }

  dispose(): void {
    if (this.disposed) return;
    // Let the processor stop and be collected once disconnected.
    this.node.port.postMessage('dispose');
    super.dispose();
  }
}
