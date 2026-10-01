/**
 * Imported recordings. The audio bytes live in IndexedDB (persistence/db.ts);
 * the project holds only metadata, so these edits are small and undoable.
 */
import { builtinSampleInfo } from '../../content/catalog';
import { applySamplerToProject } from '../../content/presets';
import { createClip as makeClip } from '../../project/factory';
import { SAMPLER_PARAMS, clampParam, specById } from '../../project/params';
import { TICKS_PER_BAR, type ClipBars, type Id, type Project, type SampleMeta } from '../../project/types';
import { VALIDATION_LIMITS, sanitizeSampleMeta } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, cleanName, draftTrack, findTrack, isFiniteNumber, isSlot, refuse, run, type CommandResult } from './common';

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

/** Key a recorded take is played on: it plays at its own pitch there (Root Note). */
export const RECORDED_TAKE_ROOT = 60;

export interface RecordedTake {
  trackId: Id;
  meta: SampleMeta;
  /** Clip slot that gets the take's clip (a clip already there is replaced; Undo brings it back). */
  slot: number;
  bars: ClipBars;
  /** Project tempo the take was played at (becomes Original BPM). */
  bpm: number;
  clipName: string;
}

/**
 * A recorded take becomes the part's recording in one undo step: the
 * recording is added to the project and played by the part (a sampler) as a
 * one-shot of the whole take at its own pitch and speed (default fades and
 * attack), Original BPM = the tempo it was played at (Tempo Sync stays off,
 * so its pitch never changes by itself), and a clip in `slot` plays it from
 * the downbeat.
 */
export function addRecordedTake(store: ProjectStore, take: RecordedTake): CommandResult & { clipId?: Id } {
  const p = store.getState();
  const t = findTrack(p, take.trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(take.slot) || ![1, 2, 3, 4].includes(take.bars)) return refuse('invalid', 'A recorded take fills a clip of 1 to 4 bars in one of four slots.');
  const clean = sanitizeSampleMeta(take.meta);
  if (!clean) return refuse('invalid', 'The recording information is incomplete.');
  if (p.samples.some((s) => s.id === clean.id)) return refuse('occupied', 'This recording is already in the project.');
  if (p.samples.length >= VALIDATION_LIMITS.maxSamples) return refuse('limit', 'This project already holds as many recordings as it can.');
  const spec = (id: string) => specById(SAMPLER_PARAMS, id)!;
  const clip = makeClip(cleanName(take.clipName) ?? 'Recording', take.bars, [
    { tick: 0, pitch: RECORDED_TAKE_ROOT, velocity: 1, duration: take.bars * TICKS_PER_BAR },
  ]);
  const r = run(store, 'sample:Record audio', (d) => {
    d.samples.push(clean);
    const track = draftTrack(d, take.trackId);
    if (track.instrument.kind === 'sampler') track.instrument.sampleId = clean.id;
    else applySamplerToProject(d, take.trackId, clean.id);
    const params = track.instrument.params;
    // It plays as it was recorded: the whole take, once per note, at its own pitch and speed,
    // with the usual click-free edges (the part keeps its level, release and tone).
    params.start = 0;
    params.end = 1;
    params.mode = 0;
    params.pitch = 0;
    params.fine = 0;
    params.sync = 0;
    params.fadeIn = spec('fadeIn').default;
    params.fadeOut = spec('fadeOut').default;
    params.attack = spec('attack').default;
    params.rootNote = RECORDED_TAKE_ROOT;
    params.originalBpm = clampParam(spec('originalBpm'), take.bpm);
    track.clips[take.slot] = clip;
  });
  return { ...r, clipId: clip.id };
}

/**
 * A new version of a part's recording (normalized, reversed, cropped, faded,
 * louder or quieter) replaces it on the part in one undo step. `region` sets
 * Start and End for the new file (a crop plays all of it); left out, the
 * trim stays. The version it replaces leaves the project's list once nothing
 * uses it any more (no other part, no saved take); Undo brings it back.
 */
export function addSampleVersion(
  store: ProjectStore,
  trackId: Id,
  fromSampleId: Id,
  meta: SampleMeta,
  opts: { label: string; region?: { start: number; end: number } },
): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (t.instrument.kind !== 'sampler' || t.instrument.sampleId !== fromSampleId) return refuse('invalid', 'The part plays another recording now, so the edit was not applied. Try again.');
  const clean = sanitizeSampleMeta(meta);
  if (!clean) return refuse('invalid', 'The recording information is incomplete.');
  if (p.samples.some((s) => s.id === clean.id)) return refuse('occupied', 'This recording is already in the project.');
  const replaces = p.samples.some((s) => s.id === fromSampleId);
  if (!replaces && p.samples.length >= VALIDATION_LIMITS.maxSamples) return refuse('limit', 'This project already holds as many recordings as it can.');
  const region = opts.region;
  if (region && !(isFiniteNumber(region.start) && isFiniteNumber(region.end) && region.start >= 0 && region.end <= 1 && region.end > region.start)) {
    return refuse('invalid', 'The region to keep is not valid.');
  }
  return run(store, `sample:${opts.label}`, (d) => {
    d.samples.push(clean);
    const inst = draftTrack(d, trackId).instrument;
    if (inst.kind !== 'sampler') return;
    inst.sampleId = clean.id;
    if (region) {
      inst.params.start = region.start;
      inst.params.end = region.end;
    }
    const usage = sampleUsage(d, fromSampleId);
    if (replaces && usage.tracks.length === 0 && usage.performances.length === 0) d.samples = d.samples.filter((s) => s.id !== fromSampleId);
  });
}
