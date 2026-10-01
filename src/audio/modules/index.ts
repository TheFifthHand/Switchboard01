/**
 * Module registry: one ModuleNode implementation per patch ModuleType.
 */
import type { ModuleType, PatchModule } from '../../project/types';
import type { ModuleConstructor, ModuleEnv, ModuleNode } from './types';
import { InstrumentModule } from './instrument';
import { ChannelModule } from './channel';
import { LfoModule } from './lfo';
import { MasterModule } from './master';
import { FilterModule } from './filter';
import { DriveModule } from './drive';
import { DelayModule } from './delay';
import { ReverbModule } from './reverb';
import { ChorusModule } from './chorus';
import { PhaserModule } from './phaser';
import { CrusherModule } from './crusher';
import { pendingEffect } from './pending';

export const MODULE_CONSTRUCTORS: Readonly<Record<ModuleType, ModuleConstructor>> = {
  instrument: InstrumentModule,
  channel: ChannelModule,
  filter: FilterModule,
  drive: DriveModule,
  delay: DelayModule,
  reverb: ReverbModule,
  chorus: ChorusModule,
  phaser: PhaserModule,
  crusher: CrusherModule,
  // TEMPORARY until the wave-1 studio-engine work implements them (see pending.ts).
  eq: pendingEffect('eq'),
  compressor: pendingEffect('compressor'),
  gate: pendingEffect('gate'),
  autopan: pendingEffect('autopan'),
  widener: pendingEffect('widener'),
  flanger: pendingEffect('flanger'),
  tape: pendingEffect('tape'),
  lfo: LfoModule,
  master: MasterModule,
};

/**
 * Build the audio node for a patch module. `mod.params` should already be the
 * resolved (macro-applied) values. Throws for an unknown module type.
 */
export function createModuleNode(env: ModuleEnv, mod: PatchModule): ModuleNode {
  const Ctor = MODULE_CONSTRUCTORS[mod.type];
  if (!Ctor) throw new Error(`Unknown module type "${String(mod.type)}"`);
  return new Ctor(env, mod.id, { ...mod.params });
}

export { InstrumentModule, ChannelModule, LfoModule, MasterModule };
