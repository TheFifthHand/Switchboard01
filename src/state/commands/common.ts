/**
 * Shared helpers for edit commands.
 *
 * Commands are plain functions `(store, ...args) => result`. They validate
 * their inputs against the current state first (so an invalid request never
 * creates an undo step), then run one named recipe through the store.
 *
 * Labels are "<area>:<Human text>". The area prefix groups edits; "patch:" is
 * special because the edit lock refuses it during a performance take. A label
 * names the kind of edit (a take's allow-list matches it), so words that name
 * a part ("Mute Lead", "Bass level") go in `display` instead (see run()).
 *
 * The song follows the clips in the same step: whatever a recipe does to the
 * clips, run() keeps the song's regions playable (see keepSongWithClips).
 */
import { current, isDraft, original } from 'immer';
import { placeRegions, tidyRegions } from '../../project/arrangement';
import { uid } from '../../project/factory';
import type { Clip, Id, Project, SongRegion, Track } from '../../project/types';
import { MAX_SCENES, TICKS_PER_BAR } from '../../project/types';
import type { ApplyOptions, ApplyResult, ProjectStore } from '../projectStore';

export type RefuseReason =
  | 'not-found'
  | 'invalid'
  | 'locked'
  | 'occupied'
  | 'empty'
  | 'limit'
  | 'not-linear'
  | 'protected'
  | 'in-use'
  | 'unavailable';

export interface CommandResult extends ApplyResult {
  /** Why the command did nothing (input problem, not the edit lock). */
  reason?: RefuseReason;
  /** Plain-language explanation for the UI. */
  message?: string;
}

export function refuse(reason: RefuseReason, message: string): CommandResult {
  return { changed: false, reason, message };
}

export const NOT_FOUND = (what: string): CommandResult => refuse('not-found', `That ${what} no longer exists.`);

export function findTrack(p: Project, trackId: Id): Track | undefined {
  return p.tracks.find((t) => t.id === trackId);
}

/** A clip slot index: below MAX_SCENES and, given a part, one of its slots (one per scene). */
export function isSlot(slot: number, track?: Pick<Track, 'clips'>): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < MAX_SCENES && (!track || slot < track.clips.length);
}

export function clipAt(p: Project, trackId: Id, slot: number): Clip | null {
  const t = findTrack(p, trackId);
  if (!t || !isSlot(slot, t)) return null;
  return t.clips[slot] ?? null;
}

/** Draft-side lookup inside recipes (inputs are validated before apply). */
export function draftTrack(d: Project, trackId: Id): Track {
  const t = d.tracks.find((x) => x.id === trackId);
  if (!t) throw new Error(`Track ${trackId} not found`);
  return t;
}

export function draftClip(d: Project, trackId: Id, slot: number): Clip {
  const c = draftTrack(d, trackId).clips[slot];
  if (!c) throw new Error(`No clip in ${trackId} slot ${slot}`);
  return c;
}

export function clipTicks(clip: Pick<Clip, 'bars'>): number {
  return clip.bars * TICKS_PER_BAR;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Trim a user-entered name; null when nothing usable remains. */
export function cleanName(name: string, max = 60): string | null {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s.length ? s : null;
}

/** Structural equality for JSON-like data (key order ignored; undefined-valued keys count as absent). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(ra[k], rb[k]));
}

/**
 * Run one named edit. `display` gives the words Undo and Redo show when they
 * should say more than the label ("Mute Lead" for "track:Mute part"). The
 * song is kept consistent with the clips in the same undo step (see
 * keepSongWithClips).
 */
export function run(store: ProjectStore, label: string, recipe: (d: Project) => void, gesture?: string, opts: { display?: string } = {}): CommandResult {
  const o: ApplyOptions = {};
  if (gesture !== undefined) o.gesture = gesture;
  if (opts.display !== undefined) o.display = opts.display;
  return store.apply(
    label,
    (d) => {
      recipe(d);
      keepSongWithClips(d);
    },
    o,
  );
}

/* ------------------------------------------------------------------ */
/* The song follows the clips                                          */
/* ------------------------------------------------------------------ */

interface ClipPlace {
  trackId: Id;
  slot: number;
  bars: number;
}

/** Where every clip is (part and pad) and how long it is: all the song's regions depend on. */
function clipPlaces(tracks: readonly Pick<Track, 'id' | 'clips'>[]): Map<Id, ClipPlace> {
  const out = new Map<Id, ClipPlace>();
  for (const t of tracks) {
    t.clips.forEach((c, slot) => {
      if (c && !out.has(c.id)) out.set(c.id, { trackId: t.id, slot, bars: c.bars });
    });
  }
  return out;
}

function samePlaces(a: ReadonlyMap<Id, ClipPlace>, b: ReadonlyMap<Id, ClipPlace>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y || y.trackId !== x.trackId || y.slot !== x.slot || y.bars !== x.bars) return false;
  }
  return true;
}

/**
 * The song's regions after an edit to the clips (pure). `before` and `after`
 * are where the clips were and are; `tracks` the parts as they are now.
 * - A clip that moved to another part takes its regions to that part's row,
 *   placed like moved regions: they win where they land (see placeRegions).
 * - A clip that is gone takes its regions with it, except when a new clip
 *   took its place on the same pad in the same edit (a clip pasted or
 *   recorded over it): its regions then play the new clip.
 * - A clip whose length changed keeps its regions' bars; their offsets wrap
 *   into the new length.
 * Returns the regions unchanged (the same array) when nothing applies.
 */
function songAfterClipEdit(
  tracks: readonly Pick<Track, 'id' | 'clips'>[],
  before: ReadonlyMap<Id, ClipPlace>,
  after: ReadonlyMap<Id, ClipPlace>,
  regions: readonly SongRegion[],
): SongRegion[] {
  const view = { tracks: tracks as Track[] };
  const kept: SongRegion[] = [];
  const moved: SongRegion[] = [];
  for (const r of regions) {
    const now = after.get(r.clipId);
    if (now) {
      if (now.trackId === r.trackId) kept.push(r);
      else moved.push({ ...r, trackId: now.trackId });
      continue;
    }
    const was = before.get(r.clipId);
    const there = was ? tracks.find((t) => t.id === was.trackId)?.clips[was.slot] : null;
    if (there && !before.has(there.id)) kept.push({ ...r, clipId: there.id });
  }
  const placed = moved.length ? placeRegions(view, kept, moved, { newId: () => uid('rg') }).regions : kept;
  const next = tidyRegions(view, placed).regions;
  return deepEqual(next, regions) ? (regions as SongRegion[]) : next;
}

/**
 * Keep the song playable after a recipe changed clips (run() calls it on
 * every edit, inside the edit's own undo step, so Undo brings both back):
 * deleting a clip, clearing a part or deleting a scene row takes their
 * regions out of the song; moving a clip to another part moves its regions
 * there; a new length wraps the regions' offsets (see songAfterClipEdit).
 * A copy never adds loops to the song (one copied or pasted over a clip the
 * song plays takes over that clip's loops). Edits that leave every clip where
 * it was and as long as it was cost a quick look at the clips.
 */
export function keepSongWithClips(d: Project): void {
  if (!isDraft(d)) return;
  const regions = d.arrangement.regions;
  if (!regions.length) return;
  const base = original(d) as Project;
  const before = clipPlaces(base.tracks);
  const after = clipPlaces(d.tracks);
  if (samePlaces(before, after)) return;
  const tracks = d.tracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => (c ? ({ id: c.id, bars: c.bars } as Clip) : null)) }));
  const plain = isDraft(regions) ? (current(regions) as SongRegion[]) : regions;
  const next = songAfterClipEdit(tracks, before, after, plain);
  if (next !== plain) d.arrangement.regions = next;
}

/** A plain-text name of one part for messages and undo steps (its name, else "Part N"). */
export function partName(p: Project, trackId: Id): string {
  const i = p.tracks.findIndex((t) => t.id === trackId);
  return i < 0 ? 'part' : p.tracks[i].name || `Part ${i + 1}`;
}
