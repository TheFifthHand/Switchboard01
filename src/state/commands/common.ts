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
 */
import type { Clip, Id, Project, Track } from '../../project/types';
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
 * should say more than the label ("Mute Lead" for "track:Mute part").
 */
export function run(store: ProjectStore, label: string, recipe: (d: Project) => void, gesture?: string, opts: { display?: string } = {}): CommandResult {
  const o: ApplyOptions = {};
  if (gesture !== undefined) o.gesture = gesture;
  if (opts.display !== undefined) o.display = opts.display;
  return store.apply(label, recipe, o);
}

/** A plain-text name of one part for messages and undo steps (its name, else "Part N"). */
export function partName(p: Project, trackId: Id): string {
  const i = p.tracks.findIndex((t) => t.id === trackId);
  return i < 0 ? 'part' : p.tracks[i].name || `Part ${i + 1}`;
}
