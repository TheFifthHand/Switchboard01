/**
 * TEMPORARY (Omni Song wave 1): pass-through stand-in for the effect types
 * added in schema v2 (eq, compressor, gate, autopan, widener, flanger, tape)
 * until their real implementations land. The studio-engine work replaces
 * every use of this class and deletes this file; nothing ships with it.
 */
import type { Id, ModuleType, ParamValues } from '../../project/types';
import type { ModuleEnv, ModuleNode } from './types';

export function pendingEffect(type: ModuleType) {
  return class PendingEffectModule implements ModuleNode {
    readonly type = type;
    private readonly io: GainNode;
    private readonly mod: GainNode;
    constructor(
      env: ModuleEnv,
      readonly id: Id,
      _params: ParamValues,
    ) {
      this.io = env.ctx.createGain();
      this.mod = env.ctx.createGain();
    }
    input(port: string): AudioNode | undefined {
      return port === 'in' ? this.io : this.mod;
    }
    output(port: string): AudioNode | undefined {
      return port === 'out' ? this.io : undefined;
    }
    setParams(): void {}
    setBypass(): void {}
    dispose(): void {
      this.io.disconnect();
      this.mod.disconnect();
    }
  };
}
