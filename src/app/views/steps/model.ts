/**
 * Pure helpers for the Steps editor: the shared 16-step column layout, what
 * a page (one bar) of a clip contains, and the rows of the pitch lane.
 */
import { STEPS_PER_BAR, TICKS_PER_BAR, TICKS_PER_STEP, type Note, type ScaleId } from '../../../project/types';
import { isInScale, noteName, pitchClass } from '../../../music/scales';

export const STEPS = STEPS_PER_BAR;
export const STEP_INDICES: readonly number[] = Array.from({ length: STEPS }, (_, i) => i);

/** Lowest velocity the editor sets (0 would be a silent note). */
export const MIN_VELOCITY = 0.05;

/**
 * CSS grid column of a step. Every step row uses the same template: a label
 * column, then four beats of four steps with a spacer track between beats.
 */
export function stepColumn(step: number): number {
  return 2 + step + Math.floor(step / 4);
}

/** grid-column value spanning steps first..last (inclusive). */
export function stepSpan(first: number, last: number): string {
  return `${stepColumn(first)} / ${stepColumn(last) + 1}`;
}

export function pageStartTick(page: number): number {
  return page * TICKS_PER_BAR;
}

export function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function clampVelocity(v: number): number {
  const x = Math.min(1, Math.max(MIN_VELOCITY, v));
  return Math.round(x * 100) / 100;
}

export function stepsLabel(ticks: number): string {
  const steps = ticks / TICKS_PER_STEP;
  const r = Math.round(steps * 4) / 4;
  return `${r} step${r === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* Drums                                                               */
/* ------------------------------------------------------------------ */

/**
 * hits[voice][step] = the loudest velocity of that voice on that step of the
 * page, or -1 when the step is off. A note is on the step it starts in.
 */
export function drumPageGrid(notes: readonly Note[], page: number, voices = 16): number[][] {
  const grid = Array.from({ length: voices }, () => Array.from({ length: STEPS }, () => -1));
  const a = pageStartTick(page);
  const b = a + TICKS_PER_BAR;
  for (const n of notes) {
    if (n.tick < a || n.tick >= b) continue;
    const v = Math.round(n.pitch);
    if (v < 0 || v >= voices) continue;
    const s = Math.floor((n.tick - a) / TICKS_PER_STEP);
    if (n.velocity > grid[v][s]) grid[v][s] = n.velocity;
  }
  return grid;
}

/** Ids of the notes of `pitch` starting on `step` of `page`. */
export function noteIdsAt(notes: readonly Note[], page: number, step: number, pitch?: number): string[] {
  const a = pageStartTick(page) + step * TICKS_PER_STEP;
  const b = a + TICKS_PER_STEP;
  const out: string[] = [];
  for (const n of notes) if (n.tick >= a && n.tick < b && (pitch === undefined || n.pitch === pitch)) out.push(n.id);
  return out;
}

/** Velocity bucket for small overview cells: 0 off, 1 soft, 2 normal, 3 accent. */
export function velocityBucket(v: number): number {
  if (v < 0) return 0;
  if (v < 0.5) return 1;
  if (v < 0.9) return 2;
  return 3;
}

/* ------------------------------------------------------------------ */
/* Melodic                                                             */
/* ------------------------------------------------------------------ */

/** A note as drawn on one page. */
export interface NoteView {
  id: string;
  pitch: number;
  velocity: number;
  tick: number;
  duration: number;
  /** Steps of this page the note covers (inclusive). */
  first: number;
  last: number;
  /** Starts on an earlier page / continues onto a later page. */
  fromPrev: boolean;
  toNext: boolean;
  /** The note's sounding part inside its step span, as fractions 0..1. */
  fillFrom: number;
  fillTo: number;
}

/** Notes that sound during `page` (a note longer than a page continues onto the next ones). */
export function pageNoteViews(notes: readonly Note[], page: number, clipTicks: number): NoteView[] {
  const a = pageStartTick(page);
  const b = Math.min(a + TICKS_PER_BAR, clipTicks);
  const out: NoteView[] = [];
  for (const n of notes) {
    const end = Math.min(n.tick + n.duration, clipTicks);
    if (n.tick >= b || end <= a) continue;
    const visFrom = Math.max(n.tick, a);
    const visTo = Math.min(end, b);
    const first = Math.min(STEPS - 1, Math.max(0, Math.floor((visFrom - a) / TICKS_PER_STEP)));
    const last = Math.min(STEPS - 1, Math.max(first, Math.ceil((visTo - a) / TICKS_PER_STEP) - 1));
    const spanFrom = a + first * TICKS_PER_STEP;
    const spanTicks = (last - first + 1) * TICKS_PER_STEP;
    out.push({
      id: n.id,
      pitch: n.pitch,
      velocity: n.velocity,
      tick: n.tick,
      duration: n.duration,
      first,
      last,
      fromPrev: n.tick < a,
      toNext: end > b,
      fillFrom: Math.max(0, (visFrom - spanFrom) / spanTicks),
      fillTo: Math.min(1, (visTo - spanFrom) / spanTicks),
    });
  }
  return out;
}

export interface PitchRow {
  pitch: number;
  name: string;
  root: boolean;
  /** A black key, shaded when every semitone has a row. */
  black: boolean;
  /** Only shown because a note uses it while Musical Assist hides out-of-key rows. */
  outOfKey: boolean;
}

const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
export const PITCH_RANGE = { lo: 24, hi: 96 } as const;

/**
 * Rows of the pitch lane, highest first. With Musical Assist on, only in-key
 * pitches get rows (plus any pitch a note already uses); otherwise every
 * semitone. The range covers C1..C7 and stretches to include every note.
 */
export function pitchRows(opts: { assist: boolean; root: number; scale: ScaleId; used: readonly number[] }): PitchRow[] {
  const { assist, root, scale, used } = opts;
  const inKeyOnly = assist && scale !== 'chromatic';
  const usedSet = new Set(used);
  let lo: number = PITCH_RANGE.lo;
  let hi: number = PITCH_RANGE.hi;
  for (const p of used) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  lo = Math.max(0, lo);
  hi = Math.min(127, hi);
  const rows: PitchRow[] = [];
  for (let p = hi; p >= lo; p--) {
    const inKey = isInScale(p, root, scale);
    if (inKeyOnly && !inKey && !usedSet.has(p)) continue;
    rows.push({ pitch: p, name: noteName(p), root: pitchClass(p) === pitchClass(root), black: !inKeyOnly && BLACK[pitchClass(p)], outOfKey: inKeyOnly && !inKey });
  }
  return rows;
}

/** Index of the row nearest to `pitch` (rows are sorted high to low). */
export function nearestRow(rows: readonly PitchRow[], pitch: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const d = Math.abs(rows[i].pitch - pitch);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Where the lane should centre when a clip opens: the middle of its notes, else a register that suits the part. */
export function focusPitch(notes: readonly Note[], kind: 'bass' | 'poly' | 'sampler'): number {
  if (notes.length) {
    let lo = 127;
    let hi = 0;
    for (const n of notes) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    return Math.round((lo + hi) / 2);
  }
  return kind === 'bass' ? 40 : 62;
}
