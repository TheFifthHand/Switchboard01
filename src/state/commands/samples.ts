/**
 * Imported recordings. The audio bytes live in IndexedDB (persistence/db.ts);
 * the project holds only metadata, so these edits are small and undoable.
 */
import { builtinSampleInfo } from '../../content/catalog';
import { applySamplerToProject } from '../../content/presets';
import { createClip as makeClip } from '../../project/factory';
import { SAMPLER_PARAMS, clampParam, readParam, specById } from '../../project/params';
import { MAX_CLIP_BARS, TICKS_PER_BAR, type ClipBars, type Id, type Project, type SampleMeta, type Track } from '../../project/types';
import { VALIDATION_LIMITS, sanitizeSampleMeta } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { isClipBars } from './clips';
import { NOT_FOUND, clamp, cleanName, draftTrack, findTrack, isFiniteNumber, isSlot, partName, refuse, run, type CommandResult } from './common';

/** A clip that plays a recording itself (Clip.sample). */
export interface ClipUse {
  trackId: Id;
  slot: number;
  clipId: Id;
}

/**
 * Where a recording is used: parts that play it (their recording), clips that
 * play it themselves, and takes whose starting state uses it either way.
 */
export function sampleUsage(p: Project, sampleId: Id): { tracks: Id[]; clips: ClipUse[]; performances: Id[] } {
  const parts = (tracks: Project['tracks']) => tracks.filter((t) => t.instrument.kind === 'sampler' && t.instrument.sampleId === sampleId).map((t) => t.id);
  const clips = (tracks: Project['tracks']) => {
    const out: ClipUse[] = [];
    for (const t of tracks) t.clips.forEach((c, slot) => {
      if (c?.sample?.id === sampleId) out.push({ trackId: t.id, slot, clipId: c.id });
    });
    return out;
  };
  return {
    tracks: parts(p.tracks),
    clips: clips(p.tracks),
    performances: p.performances.filter((perf) => parts(perf.snapshot.tracks).length > 0 || clips(perf.snapshot.tracks).length > 0).map((perf) => perf.id),
  };
}

/** Every recording id clips refer to (Clip.sample), in the project and in its takes' starting states. */
export function clipSampleIds(p: Pick<Project, 'tracks' | 'performances'>): Set<Id> {
  const ids = new Set<Id>();
  const add = (tracks: readonly Track[]) => {
    for (const t of tracks) for (const c of t.clips) if (c?.sample) ids.add(c.sample.id);
  };
  add(p.tracks);
  for (const perf of p.performances) add(perf.snapshot.tracks);
  return ids;
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
  if (usage.clips.length) {
    const c = usage.clips[0];
    const clip = findTrack(p, c.trackId)?.clips[c.slot];
    const more = usage.clips.length > 1 ? ` and ${usage.clips.length - 1} more` : '';
    return refuse('in-use', `This recording plays in a clip (${clip?.name ?? 'a clip'} on ${partName(p, c.trackId)}${more}). Delete that clip or give it another recording first.`);
  }
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
  /** 1 to MAX_CLIP_BARS. */
  bars: ClipBars;
  /** Project tempo the take was played at (becomes Original BPM when the take becomes the part's recording). */
  bpm: number;
  clipName: string;
}

/**
 * Whether a new recording placed in `slot` also becomes the part's own
 * recording (and the part's sampler settings are reset to play it as
 * recorded): when the part is not a sampler yet, has no recording, or has no
 * other clip with notes. The part's settings (mode, pitch, tempo sync,
 * fades) apply to every clip of the part, its own recordings included, so
 * as soon as another clip plays on the part, its recording and settings are
 * left exactly as they are.
 */
function recordingBecomesPart(t: Track, slot: number): boolean {
  if (t.instrument.kind !== 'sampler' || !t.instrument.sampleId) return true;
  return !t.clips.some((c, i) => i !== slot && !!c && c.notes.length > 0);
}

/**
 * Make a part (a sampler, or about to become one) play `sampleId` as its own
 * recording, as recorded: the whole file once per note at its own pitch and
 * speed, with the usual click-free edges. The part keeps its level, release
 * and tone. `originalBpm`: the tempo it was played at (Tempo Sync stays off,
 * so its pitch never changes by itself); left out, the default.
 */
function playAsRecorded(d: Project, trackId: Id, sampleId: Id, originalBpm?: number): void {
  const track = draftTrack(d, trackId);
  if (track.instrument.kind === 'sampler') track.instrument.sampleId = sampleId;
  else applySamplerToProject(d, trackId, sampleId);
  const spec = (id: string) => specById(SAMPLER_PARAMS, id)!;
  const params = track.instrument.params;
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
  params.originalBpm = originalBpm === undefined ? spec('originalBpm').default : clampParam(spec('originalBpm'), originalBpm);
}

/** A clip of `bars` bars that plays recording `sampleId` itself, whole, once from the downbeat at its own pitch. */
function recordingClip(name: string, bars: ClipBars, sampleId: Id) {
  const clip = makeClip(name, bars, [{ tick: 0, pitch: RECORDED_TAKE_ROOT, velocity: 1, duration: bars * TICKS_PER_BAR }]);
  clip.sample = { id: sampleId, start: 0, end: 1, rootNote: RECORDED_TAKE_ROOT };
  return clip;
}

export interface RecordingClipResult extends CommandResult {
  clipId?: Id;
  /** Slot of the new clip. */
  slot?: number;
  /**
   * The recording also became the part's own recording (the part had nothing
   * else to play). False: the part kept its recording and settings.
   */
  partRecording?: boolean;
}

/**
 * A recorded take goes into its own clip in one undo step: the recording is
 * added to the project and a clip in `slot` plays it itself (Clip.sample: the
 * whole take at root 60) from the downbeat. Other clips keep their
 * recordings: only a part with nothing else to play (not a sampler yet, no
 * recording, or no other clip with notes; see recordingBecomesPart) takes
 * the take as its own and is set to play it as recorded (one-shot, no
 * transposition, Original BPM = the tempo it was played at, Tempo Sync off).
 * Otherwise the part keeps its recording and settings, and the take plays
 * with them: at its own pitch unless the part is transposed or tempo-synced.
 */
export function addRecordedTake(store: ProjectStore, take: RecordedTake): RecordingClipResult {
  const p = store.getState();
  const t = findTrack(p, take.trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(take.slot, t) || !isClipBars(take.bars)) return refuse('invalid', `A recorded take fills a clip of 1 to ${MAX_CLIP_BARS} bars in one of the part’s slots.`);
  const clean = sanitizeSampleMeta(take.meta);
  if (!clean) return refuse('invalid', 'The recording information is incomplete.');
  if (p.samples.some((s) => s.id === clean.id)) return refuse('occupied', 'This recording is already in the project.');
  if (p.samples.length >= VALIDATION_LIMITS.maxSamples) return refuse('limit', 'This project already holds as many recordings as it can.');
  const clip = recordingClip(cleanName(take.clipName) ?? 'Recording', take.bars, clean.id);
  const partRecording = recordingBecomesPart(t, take.slot);
  const r = run(store, 'sample:Record audio', (d) => {
    d.samples.push(clean);
    if (partRecording) playAsRecorded(d, take.trackId, clean.id, take.bpm);
    draftTrack(d, take.trackId).clips[take.slot] = clip;
  });
  return { ...r, clipId: clip.id, slot: take.slot, partRecording };
}

/**
 * An imported recording goes into its own clip on a part, in one undo step
 * (shape-05): the part becomes a sampler if it is not one; a clip plays the
 * recording itself (region 0-1, root 60: its own pitch) once from the
 * downbeat, `bars` = its length rounded to whole bars at the project tempo
 * (1 to 8). The clip goes into `opts.slot` (the selected slot) when it is
 * empty, else into the next empty slot (wrapping round); with no empty slot
 * it is refused. `opts.meta` adds the recording to the project in the same
 * step when it is not there yet. The part's own recording changes as for a
 * recorded take (see addRecordedTake).
 */
export function importRecordingAsClip(
  store: ProjectStore,
  trackId: Id,
  sampleId: Id,
  opts: { durationSeconds: number; slot?: number; meta?: SampleMeta },
): RecordingClipResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  let meta: SampleMeta | null = null;
  if (opts.meta && !p.samples.some((s) => s.id === sampleId)) {
    meta = sanitizeSampleMeta(opts.meta);
    if (!meta || meta.id !== sampleId) return refuse('invalid', 'The recording information is incomplete.');
    if (p.samples.length >= VALIDATION_LIMITS.maxSamples) return refuse('limit', 'This project already holds as many recordings as it can.');
  }
  const known = meta !== null || (sampleId.startsWith('builtin:') ? !!builtinSampleInfo(sampleId) : p.samples.some((s) => s.id === sampleId));
  if (!known) return refuse('invalid', 'That recording is not in this project.');
  if (!isFiniteNumber(opts.durationSeconds) || opts.durationSeconds <= 0) return refuse('invalid', 'The recording has no length.');
  const from = opts.slot ?? 0;
  if (!isSlot(from, t)) return refuse('invalid', 'Unknown clip slot.');
  const rows = t.clips.length;
  let slot = -1;
  for (let k = 0; k < rows && slot < 0; k++) if (!t.clips[(from + k) % rows]) slot = (from + k) % rows;
  if (slot < 0) return refuse('occupied', `No empty pad on ${partName(p, trackId)}: delete or move a clip first.`);
  const barSeconds = 240 / p.bpm;
  const bars = Math.min(MAX_CLIP_BARS, Math.max(1, Math.round(opts.durationSeconds / barSeconds))) as ClipBars;
  const name = meta?.name ?? p.samples.find((s) => s.id === sampleId)?.name ?? builtinSampleInfo(sampleId)?.name ?? 'Recording';
  const clip = recordingClip(cleanName(name) ?? 'Recording', bars, sampleId);
  const partRecording = recordingBecomesPart(t, slot);
  const r = run(store, 'sample:Import recording as a clip', (d) => {
    if (meta) d.samples.push(meta);
    if (partRecording) playAsRecorded(d, trackId, sampleId);
    draftTrack(d, trackId).clips[slot] = clip;
  });
  return { ...r, clipId: clip.id, slot, partRecording };
}

/**
 * A new version of a part's recording (normalized, reversed, cropped, faded,
 * louder or quieter) replaces it on the part in one undo step. `region` sets
 * Start and End for the new file (a crop plays all of it); left out, the
 * trim stays. The part's clips that play that recording themselves
 * (Clip.sample) move to the new version too, so the edit is heard in them:
 * with `region`, the new file is the part's old trim (as Crop makes it), so
 * a clip's own region is mapped into it, and a clip whose region lies wholly
 * outside the kept part keeps the old recording. With `slot`, the version
 * replaces only the recording that clip plays itself, and `region` sets that
 * clip's region. The version it replaces leaves the project's list once
 * nothing uses it any more (no part, no clip, no saved take); Undo brings it
 * back.
 */
export function addSampleVersion(
  store: ProjectStore,
  trackId: Id,
  fromSampleId: Id,
  meta: SampleMeta,
  opts: { label: string; region?: { start: number; end: number }; slot?: number },
): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  const slot = opts.slot;
  if (slot !== undefined) {
    const c = isSlot(slot, t) ? t.clips[slot] : null;
    if (!c?.sample || c.sample.id !== fromSampleId) return refuse('invalid', 'The clip plays another recording now, so the edit was not applied. Try again.');
  } else if (t.instrument.kind !== 'sampler' || t.instrument.sampleId !== fromSampleId) return refuse('invalid', 'The part plays another recording now, so the edit was not applied. Try again.');
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
    const track = draftTrack(d, trackId);
    const own = slot !== undefined ? track.clips[slot]?.sample : undefined;
    if (own) {
      own.id = clean.id;
      if (region) {
        own.start = region.start;
        own.end = region.end;
      }
    } else {
      const inst = track.instrument;
      if (inst.kind !== 'sampler') return;
      // The part's old trim: what a crop kept.
      const a = readParam(SAMPLER_PARAMS, inst.params, 'start');
      const b = readParam(SAMPLER_PARAMS, inst.params, 'end');
      inst.sampleId = clean.id;
      if (region) {
        inst.params.start = region.start;
        inst.params.end = region.end;
      }
      for (const c of track.clips) {
        if (c?.sample?.id !== fromSampleId) continue;
        if (!region) {
          c.sample.id = clean.id;
          continue;
        }
        const map = (x: number) => clamp(region.start + ((x - a) / Math.max(1e-9, b - a)) * (region.end - region.start), region.start, region.end);
        const start = map(c.sample.start);
        const end = map(c.sample.end);
        if (!(start < end)) continue;
        c.sample.id = clean.id;
        c.sample.start = start;
        c.sample.end = end;
      }
    }
    const usage = sampleUsage(d, fromSampleId);
    if (replaces && usage.tracks.length === 0 && usage.clips.length === 0 && usage.performances.length === 0) d.samples = d.samples.filter((s) => s.id !== fromSampleId);
  });
}
