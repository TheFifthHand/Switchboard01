/**
 * Variation: deterministic, bounded pattern generation for one clip.
 * The seed is stored on the clip so saved projects and exports reproduce it,
 * and each application is one undo step. Locked parts are never changed.
 */
import { describeVariation, diffNotes, varyClip, type NoteDiff } from '../../music/variation';
import { uniqueNoteIds } from '../../project/clone';
import { uid } from '../../project/factory';
import type { Id, Note } from '../../project/types';
import { VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, clipTicks, draftClip, findTrack, isFiniteNumber, isSlot, refuse, run, type CommandResult } from './common';
import { pitchRangeFor } from './notes';

/** How much one press changes: Subtle or Bold (pass as `intensity`; the default, 0.5, sits between). */
export const INTENSITY = { subtle: 0.35, bold: 0.85 } as const;

/** One press never changes the note count by more than this fraction of the notes it varies. */
export const VARIATION_MAX_COUNT_CHANGE = 0.3;

/**
 * Hold a varied note list within ±30% of the count it was made from, never
 * past it (the bounds round inward): drop the quietest added notes when it
 * grew too much, or bring back the source's own notes (in their order) when
 * it shrank too much. Clips of three notes or fewer keep their note count
 * (30% of three is less than one note); their notes can still move, change
 * pitch, length or level. Works in place.
 */
function keepCountNear(notes: Note[], source: readonly Note[]): void {
  const most = Math.floor(source.length * (1 + VARIATION_MAX_COUNT_CHANGE) + 1e-9);
  const least = Math.ceil(source.length * (1 - VARIATION_MAX_COUNT_CHANGE) - 1e-9);
  const sourceIds = new Set(source.map((n) => n.id));
  if (notes.length > most) {
    const added = notes.filter((n) => !sourceIds.has(n.id)).sort((a, b) => a.velocity - b.velocity || b.tick - a.tick);
    const drop = new Set(added.slice(0, notes.length - most).map((n) => n.id));
    const kept = notes.filter((n) => !drop.has(n.id));
    notes.splice(0, notes.length, ...kept);
  }
  if (notes.length < least) {
    const ids = new Set(notes.map((n) => n.id));
    const taken = new Set(notes.map((n) => `${n.tick}|${n.pitch}`));
    for (const n of source) {
      if (notes.length >= least) break;
      if (ids.has(n.id) || taken.has(`${n.tick}|${n.pitch}`)) continue;
      notes.push({ ...n });
      taken.add(`${n.tick}|${n.pitch}`);
    }
  }
  // Every removed note was blocked by a moved one: keep the source as it was rather than break the bound.
  if (notes.length < least) notes.splice(0, notes.length, ...source.map((n) => ({ ...n })));
}

export interface VariationResult extends CommandResult {
  /** How the clip's notes changed (by id) against what it held before this press. */
  diff?: NoteDiff;
  /** Short words for a toast: "5 notes changed, 2 added". */
  summary?: string;
}

/**
 * Vary a clip with `seed` (store the n-th press's seed from variationSeed).
 * `intensity` 0..1 scales how much changes (INTENSITY.subtle / .bold).
 * `opts.from` varies those notes instead of the clip's current ones (the
 * view keeps the clip's notes from before its first Variation), so repeated
 * presses explore different variations of one original instead of piling
 * changes on changes. Notes in `from` that do not fit the clip or the part
 * are left out. A press never changes the note count by more than 30% of
 * the notes it varies (VARIATION_MAX_COUNT_CHANGE; clips of three notes or
 * fewer keep their count). One undo step; a locked part is refused.
 */
export function applyVariation(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  seed: number,
  intensity?: number,
  opts: { from?: readonly Note[] } = {},
): VariationResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (t.locked) return refuse('locked', 'This part is locked, so Variation leaves it unchanged.');
  if (!isSlot(slot, t)) return refuse('invalid', 'There is no clip slot there.');
  const clip = t.clips[slot];
  if (!clip) return refuse('empty', 'There is no clip here to vary.');
  if (intensity !== undefined && !isFiniteNumber(intensity)) return refuse('invalid', 'Variation strength must be a number.');
  const len = clipTicks(clip);
  const [lo, hi] = pitchRangeFor(t.instrument.kind);
  let base: Note[] = clip.notes;
  if (opts.from !== undefined) {
    if (!Array.isArray(opts.from)) return refuse('invalid', 'The original notes could not be read.');
    base = uniqueNoteIds(
      opts.from
        .filter((n) => n && [n.tick, n.pitch, n.velocity, n.duration].every(isFiniteNumber) && n.tick >= 0 && n.tick < len && Math.round(n.pitch) >= lo && Math.round(n.pitch) <= hi)
        .map((n) => ({ id: typeof n.id === 'string' && n.id ? n.id : uid('n'), tick: n.tick, pitch: Math.round(n.pitch), velocity: clamp(n.velocity, 0, 1), duration: clamp(n.duration, VALIDATION_LIMITS.minNoteTicks, len) })),
    ).slice(0, VALIDATION_LIMITS.maxNotesPerClip);
    if (base.length === 0) return refuse('empty', 'The original notes do not fit this clip any more.');
  }
  if (base.length === 0) return refuse('empty', 'Add some notes first; Variation reshapes an existing pattern.');
  const s = Math.trunc(Number.isFinite(seed) ? seed : 0) >>> 0;

  const generated: Note[] = varyClip({ ...clip, notes: base }, { seed: s, role: t.role, kind: t.instrument.kind, root: p.root, scale: p.scale, ...(intensity !== undefined ? { intensity } : {}) });
  // Keep the result inside the clip and the part's pitch range whatever the generator returns.
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
  keepCountNear(notes, base);
  const generation = (clip.variation?.generation ?? 0) + 1;
  const words = intensity === INTENSITY.subtle ? 'Subtle variation' : intensity === INTENSITY.bold ? 'Bold variation' : 'Variation';
  const r = run(store, 'variation:Variation', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = notes;
    c.variation = { seed: s, generation };
  }, undefined, { display: words });
  return r.changed ? { ...r, diff: diffNotes(clip.notes, notes), summary: describeVariation(clip.notes, notes) } : r;
}
