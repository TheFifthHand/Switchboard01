/**
 * Variation: deterministic, bounded pattern generation for one clip.
 * The seed is stored on the clip so saved projects and exports reproduce it,
 * and each application is one undo step. Locked parts are never changed.
 */
import { varyClip } from '../../music/variation';
import { uniqueNoteIds } from '../../project/clone';
import { uid } from '../../project/factory';
import type { Id, Note } from '../../project/types';
import { VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, clipTicks, draftClip, findTrack, isSlot, refuse, type CommandResult } from './common';
import { pitchRangeFor } from './notes';

export function applyVariation(store: ProjectStore, trackId: Id, slot: number, seed: number, intensity?: number): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (t.locked) return refuse('locked', 'This part is locked, so Variation leaves it unchanged.');
  if (!isSlot(slot)) return refuse('invalid', 'Unknown clip slot.');
  const clip = t.clips[slot];
  if (!clip) return refuse('empty', 'There is no clip here to vary.');
  if (clip.notes.length === 0) return refuse('empty', 'Add some notes first; Variation reshapes an existing pattern.');
  const s = Math.trunc(Number.isFinite(seed) ? seed : 0) >>> 0;

  const generated: Note[] = varyClip(clip, { seed: s, role: t.role, kind: t.instrument.kind, root: p.root, scale: p.scale, ...(intensity !== undefined ? { intensity } : {}) });
  // Keep the result inside the clip and the part's pitch range whatever the generator returns.
  const len = clipTicks(clip);
  const [lo, hi] = pitchRangeFor(t.instrument.kind);
  const notes: Note[] = uniqueNoteIds(
    generated
      .filter((n) => Number.isFinite(n.tick) && n.tick >= 0 && n.tick < len && Number.isFinite(n.pitch) && Number.isFinite(n.velocity) && Number.isFinite(n.duration))
      .map((n) => ({
        id: typeof n.id === 'string' && n.id ? n.id : uid('n'),
        tick: n.tick,
        pitch: clamp(Math.round(n.pitch), lo, hi),
        velocity: clamp(n.velocity, 0, 1),
        duration: clamp(n.duration, VALIDATION_LIMITS.minNoteTicks, len),
      })),
  ).slice(0, VALIDATION_LIMITS.maxNotesPerClip);
  const generation = (clip.variation?.generation ?? 0) + 1;
  return store.apply('variation:Variation', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = notes;
    c.variation = { seed: s, generation };
  });
}
