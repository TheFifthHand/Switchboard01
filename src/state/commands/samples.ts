/**
 * Imported recordings. The audio bytes live in IndexedDB (persistence/db.ts);
 * the project holds only metadata, so these edits are small and undoable.
 */
import { builtinSampleInfo } from '../../content/catalog';
import { applySamplerToProject } from '../../content/presets';
import { SAMPLER_PARAMS, clampParam, specById } from '../../project/params';
import type { Id, Project, SampleMeta } from '../../project/types';
import { VALIDATION_LIMITS, sanitizeSampleMeta } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, draftTrack, findTrack, isFiniteNumber, refuse, run, type CommandResult } from './common';

/** Where a recording is used: part ids now, and takes whose starting state uses it. */
export function sampleUsage(p: Project, sampleId: Id): { tracks: Id[]; performances: Id[] } {
  const uses = (tracks: Project['tracks']) => tracks.filter((t) => t.instrument.kind === 'sampler' && t.instrument.sampleId === sampleId).map((t) => t.id);
  return {
    tracks: uses(p.tracks),
    performances: p.performances.filter((perf) => uses(perf.snapshot.tracks).length > 0).map((perf) => perf.id),
  };
}

export function addSampleMeta(store: ProjectStore, meta: SampleMeta, gesture?: string): CommandResult {
  const p = store.getState();
  const clean = sanitizeSampleMeta(meta);
  if (!clean) return refuse('invalid', 'The recording information is incomplete.');
  if (p.samples.some((s) => s.id === clean.id)) return refuse('occupied', 'This recording is already in the project.');
  if (p.samples.length >= VALIDATION_LIMITS.maxSamples) return refuse('limit', 'This project already holds as many recordings as it can.');
  return run(store, 'sample:Import recording', (d) => {
    d.samples.push(clean);
  }, gesture);
}

/** Remove a recording from the project; refused while a part or a saved take uses it. */
export function removeSampleMeta(store: ProjectStore, sampleId: Id): CommandResult {
  const p = store.getState();
  if (!p.samples.some((s) => s.id === sampleId)) return NOT_FOUND('recording');
  const usage = sampleUsage(p, sampleId);
  if (usage.tracks.length) return refuse('in-use', 'This recording is used by a part. Choose another sound for that part first.');
  if (usage.performances.length) return refuse('in-use', 'This recording is used by a recorded performance. Delete that performance first.');
  return run(store, 'sample:Remove recording', (d) => {
    d.samples = d.samples.filter((s) => s.id !== sampleId);
  });
}

/** Play a recording (imported or built-in) on a part, turning it into a sampler if needed. */
export function assignSample(store: ProjectStore, trackId: Id, sampleId: Id | null, gesture?: string): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (sampleId !== null && !(sampleId.startsWith('builtin:') ? builtinSampleInfo(sampleId) : p.samples.some((s) => s.id === sampleId))) {
    return refuse('invalid', 'That recording is not in this project.');
  }
  if (t.instrument.kind === 'sampler') {
    if (t.instrument.sampleId === sampleId) return { changed: false };
    return run(store, 'sample:Assign recording', (d) => {
      const inst = draftTrack(d, trackId).instrument;
      if (inst.kind === 'sampler') inst.sampleId = sampleId;
    }, gesture);
  }
  return run(store, 'sample:Assign recording', (d) => applySamplerToProject(d, trackId, sampleId), gesture);
}

export function setSamplerParam(store: ProjectStore, trackId: Id, param: string, value: number, gesture?: string): CommandResult {
  const t = findTrack(store.getState(), trackId);
  if (!t) return NOT_FOUND('part');
  if (t.instrument.kind !== 'sampler') return refuse('invalid', 'This part is not a sampler.');
  const spec = specById(SAMPLER_PARAMS, param);
  if (!spec || !isFiniteNumber(value)) return refuse('invalid', 'The sampler has no such control.');
  const v = clampParam(spec, value);
  return run(store, `sample:Change ${spec.label}`, (d) => {
    draftTrack(d, trackId).instrument.params[param] = v;
  }, gesture);
}
