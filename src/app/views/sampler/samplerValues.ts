/**
 * Narrow reads of a sampler part's parameters for the editor.
 *
 * Values are the effective ones (after macros), clamped to the registry, so
 * the display always matches what the engine plays. Each component selects
 * only the parameters it draws, compared shallowly, so a knob drag re-renders
 * just the controls that depend on that knob.
 */
import { moduleId } from '../../../project/factory';
import { SAMPLER_PARAMS, clampParam, specById } from '../../../project/params';
import type { Id, Project } from '../../../project/types';
import { shallowEqual } from '../../../state/store';
import { useProject } from '../../instance';
import { controllerName, effectiveValue } from '../shape/paramState';

export type SamplerParamId =
  | 'start'
  | 'end'
  | 'gain'
  | 'pitch'
  | 'fine'
  | 'mode'
  | 'fadeIn'
  | 'fadeOut'
  | 'sync'
  | 'originalBpm'
  | 'rootNote'
  | 'attack'
  | 'release'
  | 'cutoff';

export function samplerSpec(id: SamplerParamId) {
  const spec = specById(SAMPLER_PARAMS, id);
  if (!spec) throw new Error(`Unknown sampler parameter "${id}"`);
  return spec;
}

/** Effective values of the given sampler parameters (defaults when the part is not a sampler). */
export function readSamplerValues<K extends SamplerParamId>(p: Project, trackId: Id, ids: readonly K[]): Record<K, number> {
  const inst = p.tracks.find((t) => t.id === trackId)?.instrument;
  const mod = moduleId.inst(trackId);
  const out = {} as Record<K, number>;
  for (const id of ids) {
    const spec = samplerSpec(id);
    const stored = inst?.kind === 'sampler' ? inst.params[id] : undefined;
    const raw = inst?.kind === 'sampler' ? (effectiveValue(p, mod, id) ?? stored) : undefined;
    out[id] = raw === undefined ? spec.default : clampParam(spec, raw);
  }
  return out;
}

export function useSamplerValues<K extends SamplerParamId>(trackId: Id, ids: readonly K[]): Record<K, number> {
  return useProject((p) => readSamplerValues(p, trackId, ids), shallowEqual);
}

/** Name of the macro that moves a sampler parameter (it is then read-only here), or null. */
export function useSamplerController(trackId: Id, id: SamplerParamId): string | null {
  return useProject((p) => controllerName(p, moduleId.inst(trackId), id, trackId));
}
