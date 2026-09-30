/**
 * Deep copies of project data and re-identification helpers.
 *
 * Store states are frozen (immer auto-freeze); everything returned here is a
 * fresh, mutable, detached copy that shares nothing with its source.
 */
import { uid } from './factory';
import type { Clip, Id, Note, Project } from './types';

/** Detached deep copy of a project (same ids). */
export function cloneProject(p: Project): Project {
  return structuredClone(p);
}

/**
 * A new project with the same musical content under a new project id.
 * Inner ids (tracks, clips, modules, samples...) are kept: they only need to
 * be unique within a project, and keeping sample ids lets both projects share
 * the stored recordings.
 */
export function duplicateProject(p: Project, name: string, now: number = Date.now()): Project {
  const copy = cloneProject(p);
  copy.id = uid('proj');
  copy.name = name;
  copy.createdAt = now;
  copy.updatedAt = now;
  return copy;
}

/** Copy of notes with fresh ids. */
export function reIdNotes(notes: readonly Note[]): Note[] {
  return notes.map((n) => ({ id: uid('n'), tick: n.tick, pitch: n.pitch, velocity: n.velocity, duration: n.duration }));
}

/** Detached copy of a clip with a new clip id and new note ids (for paste / duplicate). */
export function cloneClipWithNewIds(clip: Clip): Clip {
  const out: Clip = { id: uid('clip'), name: clip.name, bars: clip.bars, notes: reIdNotes(clip.notes) };
  if (clip.variation) out.variation = { seed: clip.variation.seed, generation: clip.variation.generation };
  return out;
}

/** Detached copy of a clip keeping its ids (for the clipboard). */
export function cloneClip(clip: Clip): Clip {
  return structuredClone(clip);
}

/** Ensure note ids are unique within a list; returns the list with duplicates re-identified. */
export function uniqueNoteIds(notes: Note[]): Note[] {
  const seen = new Set<Id>();
  return notes.map((n) => {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      return n;
    }
    const id = uid('n');
    seen.add(id);
    return { ...n, id };
  });
}
