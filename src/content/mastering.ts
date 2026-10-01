/**
 * Mastering presets: starting points for the master-bus chain
 * (MASTERING_PARAMS). Each sets every parameter; "clean" is neutral.
 */
import { neutralMasteringParams } from '../project/params';
import type { ParamValues } from '../project/types';

export interface MasteringPreset {
  id: string;
  name: string;
  /** One plain sentence about what it does to the sound. */
  description: string;
  params: ParamValues;
}

export const MASTERING_PRESETS: readonly MasteringPreset[] = [
  { id: 'clean', name: 'Clean', description: 'No processing: the mix exactly as you made it.', params: neutralMasteringParams() },
];

export function masteringPreset(id: string): MasteringPreset | undefined {
  return MASTERING_PRESETS.find((p) => p.id === id);
}
