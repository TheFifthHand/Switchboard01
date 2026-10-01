/** Clip slot edits: create, delete, rename, length, duplicate, paste, clear, copy, move between pads. */
import { cloneClip, cloneClipWithNewIds, reIdNotes } from '../../project/clone';
import { createClip as makeClip } from '../../project/factory';
import { TICKS_PER_BAR, type Clip, type ClipBars, type Id, type Project, type Track } from '../../project/types';
import { VALIDATION_LIMITS, sanitizeClip } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clipAt, cleanName, draftClip, draftTrack, findTrack, isSlot, refuse, run, type CommandResult } from './common';

export function isClipBars(bars: number): bars is ClipBars {
  return bars === 1 || bars === 2 || bars === 3 || bars === 4;
}

/** Default clip name: the scene (row) name. */
export function defaultClipName(p: Project, slot: number): string {
  return p.scenes[slot]?.name ?? `Clip ${slot + 1}`;
}

/** Create an empty clip in an empty slot. */
export function createClip(store: ProjectStore, trackId: Id, slot: number, bars: ClipBars = 1, name?: string): CommandResult & { clipId?: Id } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(slot) || !isClipBars(bars)) return refuse('invalid', 'Clips are 1 to 4 bars in one of four slots.');
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
  if (!isClipBars(bars)) return refuse('invalid', 'Clips are 1 to 4 bars.');
  const len = bars * TICKS_PER_BAR;
  return run(store, 'clip:Change clip length', (d) => {
    const c = draftClip(d, trackId, slot);
    c.bars = bars;
    if (c.notes.some((n) => n.tick >= len)) c.notes = c.notes.filter((n) => n.tick < len);
  });
}

/**
 * Double the clip (up to 4 bars) by repeating its content: 1 -> 2, 2 -> 4,
 * 3 -> 4 (the first bar is repeated into bar 4).
 */
export function duplicateClipContent(store: ProjectStore, trackId: Id, slot: number): CommandResult {
  const clip = clipAt(store.getState(), trackId, slot);
  if (!clip) return NOT_FOUND('clip');
  if (clip.bars >= 4) return refuse('limit', 'Clips can be at most 4 bars long.');
  const oldLen = clip.bars * TICKS_PER_BAR;
  const newBars = Math.min(4, clip.bars * 2) as ClipBars;
  const copyLen = (newBars - clip.bars) * TICKS_PER_BAR;
  const copies = reIdNotes(clip.notes.filter((n) => n.tick < copyLen)).map((n) => ({ ...n, tick: n.tick + oldLen }));
  if (clip.notes.length + copies.length > VALIDATION_LIMITS.maxNotesPerClip) return refuse('limit', 'The clip would have too many notes.');
  return run(store, 'clip:Duplicate clip content', (d) => {
    const c = draftClip(d, trackId, slot);
    c.bars = newBars;
    c.notes.push(...copies);
  });
}

/** Copy a clip into another slot of the same part (replacing what is there). */
export function duplicateClipToSlot(store: ProjectStore, trackId: Id, fromSlot: number, toSlot: number): CommandResult & { clipId?: Id } {
  const clip = clipAt(store.getState(), trackId, fromSlot);
  if (!clip) return NOT_FOUND('clip');
  if (!isSlot(toSlot) || toSlot === fromSlot) return refuse('invalid', 'Choose a different slot.');
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
  const t = findTrack(store.getState(), trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(slot)) return refuse('invalid', 'Unknown clip slot.');
  const { clip: clean } = sanitizeClip(clip, t.instrument.kind);
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
  if (!findTrack(p, toTrackId) || !isSlot(toSlot)) return refuse('invalid', 'Unknown clip slot.');
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
  if (!target || !isSlot(toSlot)) return refuse('invalid', 'Unknown clip slot.');
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
