/**
 * Clip slot edits: create, delete, rename, length, double, repeat, paste,
 * clear, copy, move between pads, replace notes, and a sampler clip's own
 * recording.
 */
import { builtinSampleInfo } from '../../content/catalog';
import { cloneClip, cloneClipWithNewIds, reIdNotes } from '../../project/clone';
import { createClip as makeClip } from '../../project/factory';
import { SAMPLER_PARAMS, clampParam, specById } from '../../project/params';
import { MAX_CLIP_BARS, TICKS_PER_BAR, type Clip, type ClipBars, type ClipSample, type Id, type Note, type Project, type Track, type VariationInfo } from '../../project/types';
import { VALIDATION_LIMITS, sanitizeClip } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clipAt, cleanName, draftClip, draftTrack, findTrack, isFiniteNumber, isSlot, refuse, run, type CommandResult } from './common';

/** Clips are 1 to MAX_CLIP_BARS (8) bars. */
export function isClipBars(bars: number): bars is ClipBars {
  return Number.isInteger(bars) && bars >= 1 && bars <= MAX_CLIP_BARS;
}

const LENGTH_MESSAGE = `Clips are 1 to ${MAX_CLIP_BARS} bars.`;

/** Default clip name: the scene (row) name. */
export function defaultClipName(p: Project, slot: number): string {
  return p.scenes[slot]?.name ?? `Clip ${slot + 1}`;
}

/** Create an empty clip in an empty slot. */
export function createClip(store: ProjectStore, trackId: Id, slot: number, bars: ClipBars = 1, name?: string): CommandResult & { clipId?: Id } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(slot, t)) return refuse('invalid', 'There is no clip slot there.');
  if (!isClipBars(bars)) return refuse('invalid', LENGTH_MESSAGE);
  if (t.clips[slot]) return refuse('occupied', 'That slot already has a clip.');
  const clip = makeClip((name !== undefined && cleanName(name)) || defaultClipName(p, slot), bars);
  const r = run(store, 'clip:Create clip', (d) => {
    draftTrack(d, trackId).clips[slot] = clip;
  });
  return { ...r, clipId: clip.id };
}

export function deleteClip(store: ProjectStore, trackId: Id, slot: number): CommandResult {
  if (!clipAt(store.getState(), trackId, slot)) return NOT_FOUND('clip');
  return run(store, 'clip:Delete clip', (d) => {
    draftTrack(d, trackId).clips[slot] = null;
  });
}

export function renameClip(store: ProjectStore, trackId: Id, slot: number, name: string): CommandResult {
  if (!clipAt(store.getState(), trackId, slot)) return NOT_FOUND('clip');
  const n = cleanName(name, 60);
  if (!n) return refuse('invalid', 'A clip needs a name.');
  return run(store, 'clip:Rename clip', (d) => {
    draftClip(d, trackId, slot).name = n;
  });
}

/** Change clip length; notes starting beyond the new end are removed. */
export function setClipBars(store: ProjectStore, trackId: Id, slot: number, bars: ClipBars): CommandResult {
  const clip = clipAt(store.getState(), trackId, slot);
  if (!clip) return NOT_FOUND('clip');
  if (!isClipBars(bars)) return refuse('invalid', LENGTH_MESSAGE);
  const len = bars * TICKS_PER_BAR;
  return run(store, 'clip:Change clip length', (d) => {
    const c = draftClip(d, trackId, slot);
    c.bars = bars;
    if (c.notes.some((n) => n.tick >= len)) c.notes = c.notes.filter((n) => n.tick < len);
  });
}

/**
 * Double the clip (up to MAX_CLIP_BARS bars) by repeating its content: 1 -> 2,
 * 2 -> 4, 4 -> 8; a clip whose double would be longer is filled up to 8 bars
 * from its start (5 -> 8 repeats bars 1-3 into bars 6-8).
 */
export function duplicateClipContent(store: ProjectStore, trackId: Id, slot: number): CommandResult {
  const clip = clipAt(store.getState(), trackId, slot);
  if (!clip) return NOT_FOUND('clip');
  if (clip.bars >= MAX_CLIP_BARS) return refuse('limit', `Clips can be at most ${MAX_CLIP_BARS} bars long.`);
  const oldLen = clip.bars * TICKS_PER_BAR;
  const newBars = Math.min(MAX_CLIP_BARS, clip.bars * 2) as ClipBars;
  const copyLen = (newBars - clip.bars) * TICKS_PER_BAR;
  const copies = reIdNotes(clip.notes.filter((n) => n.tick < copyLen)).map((n) => ({ ...n, tick: n.tick + oldLen }));
  if (clip.notes.length + copies.length > VALIDATION_LIMITS.maxNotesPerClip) return refuse('limit', 'The clip would have too many notes.');
  return run(store, 'clip:Duplicate clip content', (d) => {
    const c = draftClip(d, trackId, slot);
    c.bars = newBars;
    c.notes.push(...copies);
  });
}

/**
 * Make a clip `bars` long by repeating its bars in turn (a 3-bar clip made 8
 * bars plays bars 1 2 3 1 2 3 1 2), so a longer loop keeps playing instead of
 * falling silent. Notes keep their lengths. Shortening is Length's job
 * (setClipBars); the same length changes nothing. One undo step.
 */
export function repeatClipToBars(store: ProjectStore, trackId: Id, slot: number, bars: ClipBars): CommandResult {
  const clip = clipAt(store.getState(), trackId, slot);
  if (!clip) return NOT_FOUND('clip');
  if (!isClipBars(bars)) return refuse('invalid', LENGTH_MESSAGE);
  if (bars === clip.bars) return { changed: false };
  if (bars < clip.bars) return refuse('invalid', `The clip is already ${clip.bars} bars: choose a longer length to repeat it, or use Length to shorten it.`);
  const period = clip.bars * TICKS_PER_BAR;
  const copies: Note[] = [];
  for (let start = period; start < bars * TICKS_PER_BAR; start += period) {
    const room = bars * TICKS_PER_BAR - start;
    for (const n of reIdNotes(clip.notes.filter((x) => x.tick < room))) copies.push({ ...n, tick: n.tick + start });
  }
  if (clip.notes.length + copies.length > VALIDATION_LIMITS.maxNotesPerClip) return refuse('limit', 'The clip would have too many notes.');
  return run(store, `clip:Repeat clip to ${bars} bars`, (d) => {
    const c = draftClip(d, trackId, slot);
    c.bars = bars;
    c.notes.push(...copies);
  });
}

/**
 * Replace a clip's notes in one undo step called `label` (for example
 * Variation's "Back to original"). The notes are checked like a pasted clip
 * (inside the clip, playable by the part; ids kept when unique), and the clip
 * keeps its length. `opts.variation` sets the clip's Variation information
 * (null removes it); left out, it is kept.
 */
export function setClipNotes(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  notes: readonly Note[],
  label: string,
  opts: { variation?: VariationInfo | null } = {},
): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  const clip = clipAt(p, trackId, slot);
  if (!t || !clip) return NOT_FOUND('clip');
  const words = cleanName(label, 60);
  if (!words) return refuse('invalid', 'The change needs a name.');
  if (!Array.isArray(notes)) return refuse('invalid', 'The notes could not be read.');
  const { clip: clean } = sanitizeClip({ id: clip.id, name: clip.name, bars: clip.bars, notes }, t.instrument.kind);
  if (!clean) return refuse('invalid', `The notes could not be used: a clip holds at most ${VALIDATION_LIMITS.maxNotesPerClip} notes.`);
  const variation = opts.variation;
  if (variation && !(isFiniteNumber(variation.seed) && Number.isInteger(variation.generation) && variation.generation >= 0)) {
    return refuse('invalid', 'The Variation information is not valid.');
  }
  return run(store, `clip:${words}`, (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = clean.notes;
    if (variation === null) delete c.variation;
    else if (variation) c.variation = { seed: variation.seed, generation: variation.generation };
  });
}

/* ------------------------------------------------------------------ */
/* A sampler clip's own recording                                      */
/* ------------------------------------------------------------------ */

const ROOT_NOTE_SPEC = specById(SAMPLER_PARAMS, 'rootNote')!;

/** A recording the project can play: an imported one, or a built-in one. */
function knownRecording(p: Project, id: unknown): id is Id {
  return typeof id === 'string' && (id.startsWith('builtin:') ? !!builtinSampleInfo(id) : p.samples.some((s) => s.id === id));
}

/**
 * Change the recording a clip plays itself (Clip.sample): which recording
 * (`id`), the region (`start`, `end`: fractions of the file, 0 <= start < end
 * <= 1) and the key that plays it at its own pitch (`rootNote`, a whole MIDI
 * note 24-96). A clip without one starts from the part's recording and its
 * whole length at root 60. `null` removes it: the clip plays the part's
 * recording again. Invalid values are refused with nothing changed. A shared
 * gesture id (a handle drag) makes one undo step.
 */
export function setClipSampleRegion(store: ProjectStore, trackId: Id, slot: number, partial: Partial<ClipSample> | null, gesture?: string): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  const clip = clipAt(p, trackId, slot);
  if (!t || !clip) return NOT_FOUND('clip');
  if (partial === null) {
    if (!clip.sample) return { changed: false };
    return run(store, 'clip:Play the part’s recording', (d) => {
      delete draftClip(d, trackId, slot).sample;
    });
  }
  if (typeof partial !== 'object') return refuse('invalid', 'The recording settings could not be read.');
  const base: ClipSample | null = clip.sample ?? (t.instrument.kind === 'sampler' && t.instrument.sampleId ? { id: t.instrument.sampleId, start: 0, end: 1, rootNote: ROOT_NOTE_SPEC.default } : null);
  const id = partial.id ?? base?.id;
  if (!knownRecording(p, id)) return refuse('invalid', partial.id === undefined ? 'Choose a recording for this clip first.' : 'That recording is not in this project.');
  const start = partial.start ?? base?.start ?? 0;
  const end = partial.end ?? base?.end ?? 1;
  if (!isFiniteNumber(start) || !isFiniteNumber(end) || start < 0 || end > 1 || start >= end) return refuse('invalid', 'The start must come before the end, both inside the recording.');
  const rootIn = partial.rootNote ?? base?.rootNote ?? ROOT_NOTE_SPEC.default;
  if (!isFiniteNumber(rootIn) || rootIn < ROOT_NOTE_SPEC.min || rootIn > ROOT_NOTE_SPEC.max) return refuse('invalid', `The root note must be between ${ROOT_NOTE_SPEC.min} and ${ROOT_NOTE_SPEC.max}.`);
  const next: ClipSample = { id, start, end, rootNote: clampParam(ROOT_NOTE_SPEC, rootIn) };
  const cur = clip.sample;
  if (cur && cur.id === next.id && cur.start === next.start && cur.end === next.end && cur.rootNote === next.rootNote) return { changed: false };
  const label = cur && cur.id !== next.id ? 'clip:Change clip recording' : !cur ? 'clip:Give the clip its own recording' : cur.rootNote !== next.rootNote && cur.start === next.start && cur.end === next.end ? 'clip:Change clip root note' : 'clip:Trim clip recording';
  return run(store, label, (d) => {
    draftClip(d, trackId, slot).sample = next;
  }, gesture);
}

/** Copy a clip into another slot of the same part (replacing what is there). */
export function duplicateClipToSlot(store: ProjectStore, trackId: Id, fromSlot: number, toSlot: number): CommandResult & { clipId?: Id } {
  const clip = clipAt(store.getState(), trackId, fromSlot);
  if (!clip) return NOT_FOUND('clip');
  if (!isSlot(toSlot, findTrack(store.getState(), trackId)) || toSlot === fromSlot) return refuse('invalid', 'Choose a different slot.');
  const copy = cloneClipWithNewIds(clip);
  const r = run(store, 'clip:Duplicate clip', (d) => {
    draftTrack(d, trackId).clips[toSlot] = copy;
  });
  return { ...r, clipId: copy.id };
}

/**
 * Paste a clip (from the clipboard) into a slot, replacing its content. The
 * clip gets new ids; notes that cannot play on this part (for example melodic
 * pitches pasted onto a drum kit) are left out.
 */
export function pasteClip(store: ProjectStore, trackId: Id, slot: number, clip: Clip): CommandResult & { clipId?: Id } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(slot, t)) return refuse('invalid', 'Unknown clip slot.');
  const { clip: clean } = sanitizeClip(clip, t.instrument.kind, new Set(p.samples.map((s) => s.id)));
  if (!clean) return refuse('invalid', 'The copied clip could not be pasted.');
  const copy = cloneClipWithNewIds(clean);
  const dropped = clip.notes.length - copy.notes.length;
  const r = run(store, 'clip:Paste clip', (d) => {
    draftTrack(d, trackId).clips[slot] = copy;
  });
  return { ...r, clipId: copy.id, message: dropped > 0 ? `${dropped} note${dropped === 1 ? '' : 's'} could not be played by this part and were left out.` : undefined };
}

/** Remove all notes, keeping the clip. */
export function clearClip(store: ProjectStore, trackId: Id, slot: number): CommandResult {
  const clip = clipAt(store.getState(), trackId, slot);
  if (!clip) return NOT_FOUND('clip');
  if (clip.notes.length === 0) return { changed: false };
  return run(store, 'clip:Clear clip', (d) => {
    draftClip(d, trackId, slot).notes = [];
  });
}

/** A detached copy of a clip for the clipboard (UI state), or null for an empty slot. */
export function copyClip(project: Project, trackId: Id, slot: number): Clip | null {
  const clip = clipAt(project, trackId, slot);
  return clip ? cloneClip(clip) : null;
}

/** Remove every clip of a part in one undo step. */
export function clearTrackClips(store: ProjectStore, trackId: Id): CommandResult {
  const t = findTrack(store.getState(), trackId);
  if (!t) return NOT_FOUND('part');
  if (t.clips.every((c) => c === null)) return refuse('empty', 'This part has no clips.');
  return run(store, 'clip:Clear all clips', (d) => {
    const dt = draftTrack(d, trackId);
    dt.clips = dt.clips.map(() => null);
  });
}

/* ------------------------------------------------------------------ */
/* Move and copy between pads                                          */
/* ------------------------------------------------------------------ */

/** What a part's clips hold: drum steps (kit sounds 0-15) or melodic notes (pitches). */
export type ClipContent = 'steps' | 'notes';

export function clipContentOf(track: Pick<Track, 'instrument'>): ClipContent {
  return track.instrument.kind === 'drums' ? 'steps' : 'notes';
}

const CONTENT_WORDS: Record<ClipContent, string> = { steps: 'drum steps', notes: 'melodic notes' };

/**
 * Why a clip from `from` cannot go to `to`, or null when it can: a drum
 * pattern (kit sounds) and a melodic pattern (pitches) mean different things,
 * so clips only move or copy between parts of the same content.
 */
export function clipDropProblem(p: Project, fromTrackId: Id, toTrackId: Id): string | null {
  const from = findTrack(p, fromTrackId);
  const to = findTrack(p, toTrackId);
  if (!from || !to) return 'That part no longer exists.';
  const a = clipContentOf(from);
  const b = clipContentOf(to);
  if (a === b) return null;
  return `${from.name} plays ${CONTENT_WORDS[a]} and ${to.name} plays ${CONTENT_WORDS[b]}: a clip only moves between parts of the same kind (drum parts, or melodic parts).`;
}

export interface ClipMoveResult extends CommandResult {
  /** The clip that was on the target pad and moved to the source pad (a swap). */
  swapped?: boolean;
}

/**
 * Move a clip to another pad, in one undo step. Onto an empty pad the clip
 * moves (keeping its id); onto an occupied pad the two clips swap. Between
 * parts both must hold the same kind of clip (see clipDropProblem). The
 * launcher follows a moved clip within its part; see Session for playback.
 */
export function moveClip(store: ProjectStore, fromTrackId: Id, fromSlot: number, toTrackId: Id, toSlot: number): ClipMoveResult {
  const p = store.getState();
  const clip = clipAt(p, fromTrackId, fromSlot);
  if (!clip) return NOT_FOUND('clip');
  const to = findTrack(p, toTrackId);
  if (!to || !isSlot(toSlot, to)) return refuse('invalid', 'Unknown clip slot.');
  if (fromTrackId === toTrackId && fromSlot === toSlot) return refuse('invalid', 'The clip is already there.');
  const problem = fromTrackId === toTrackId ? null : clipDropProblem(p, fromTrackId, toTrackId);
  if (problem) return refuse('invalid', problem);
  const other = clipAt(p, toTrackId, toSlot);
  const r = run(store, other ? 'clip:Swap clips' : 'clip:Move clip', (d) => {
    const a = draftTrack(d, fromTrackId);
    const b = draftTrack(d, toTrackId);
    const moving = a.clips[fromSlot];
    a.clips[fromSlot] = b.clips[toSlot];
    b.clips[toSlot] = moving;
  });
  return { ...r, swapped: !!other };
}

export interface ClipCopyResult extends CommandResult {
  clipId?: Id;
  /** A clip was on the target pad and the copy replaced it. */
  replaced?: boolean;
}

/**
 * Copy a clip onto another pad (new ids), in one undo step. Onto an occupied
 * pad the copy replaces what was there. Between parts both must hold the same
 * kind of clip.
 */
export function copyClipTo(store: ProjectStore, fromTrackId: Id, fromSlot: number, toTrackId: Id, toSlot: number): ClipCopyResult {
  const p = store.getState();
  const clip = clipAt(p, fromTrackId, fromSlot);
  if (!clip) return NOT_FOUND('clip');
  const target = findTrack(p, toTrackId);
  if (!target || !isSlot(toSlot, target)) return refuse('invalid', 'Unknown clip slot.');
  if (fromTrackId === toTrackId && fromSlot === toSlot) return refuse('invalid', 'Choose a different pad to copy to.');
  const problem = fromTrackId === toTrackId ? null : clipDropProblem(p, fromTrackId, toTrackId);
  if (problem) return refuse('invalid', problem);
  const replaced = !!target.clips[toSlot];
  const copy = cloneClipWithNewIds(clip);
  const r = run(store, 'clip:Copy clip', (d) => {
    draftTrack(d, toTrackId).clips[toSlot] = copy;
  });
  return { ...r, clipId: copy.id, replaced };
}
