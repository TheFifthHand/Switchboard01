/**
 * Pure helpers for the Steps editor: the shared step-column layout (16 steps
 * a bar for drums, the chosen grid for the piano roll), what a page (one bar)
 * of a clip contains, the rows of the pitch lane, and the arithmetic behind
 * selections, moves, quantize previews and touch gestures. No DOM, no audio.
 */
import { MAX_CLIP_BARS, STEPS_PER_BAR, TICKS_PER_BAR, TICKS_PER_BEAT, TICKS_PER_STEP, type Id, type Note, type ScaleId } from '../../../project/types';
import { isInScale, noteName, pitchClass, scaleDegreeOf, snapToScale, stepsPerOctave, transposeInScale, type MusicalKey } from '../../../music/scales';
import { GRID_TICKS } from '../../../state/commands/notes';
import type { StepGrid } from '../../../state/uiStore';

export const STEPS = STEPS_PER_BAR;
export const STEP_INDICES: readonly number[] = Array.from({ length: STEPS }, (_, i) => i);

/** Lowest velocity the editor sets (0 would be a silent note). */
export const MIN_VELOCITY = 0.05;

/* ------------------------------------------------------------------ */
/* Columns and grids                                                   */
/* ------------------------------------------------------------------ */

/**
 * The editing grid of the piano roll: ticks per cell, cells per beat and per
 * bar. 1/16 = 24 ticks (16 a bar), 1/32 = 12 (32), 1/8T = 32 (12), 1/16T = 16 (24).
 */
export interface GridSpec {
  grid: StepGrid;
  ticks: number;
  perBeat: number;
  cells: number;
}

export function gridSpec(grid: StepGrid = '1/16'): GridSpec {
  const ticks = GRID_TICKS[grid] ?? TICKS_PER_STEP;
  return { grid, ticks, perBeat: TICKS_PER_BEAT / ticks, cells: TICKS_PER_BAR / ticks };
}

/** The drum grid (and the roll's default): 16 steps a bar. */
export const STEP_GRID: GridSpec = gridSpec('1/16');

const INDICES = new Map<number, readonly number[]>();
/** 0..cells-1 (cached per length, so lists keep their identity across renders). */
export function cellIndices(cells: number): readonly number[] {
  let list = INDICES.get(cells);
  if (!list) {
    list = Array.from({ length: cells }, (_, i) => i);
    INDICES.set(cells, list);
  }
  return list;
}

/**
 * CSS grid column of a cell. Every step row uses the same template: a label
 * column, then four beats of `perBeat` cells with a spacer track between beats.
 */
export function cellColumn(cell: number, perBeat = 4): number {
  return 2 + cell + Math.floor(cell / perBeat);
}

/** grid-column value spanning cells first..last (inclusive). */
export function cellSpan(first: number, last: number, perBeat = 4): string {
  return `${cellColumn(first, perBeat)} / ${cellColumn(last, perBeat) + 1}`;
}

/** CSS grid column of a 1/16 step (the drum lanes). */
export function stepColumn(step: number): number {
  return cellColumn(step, 4);
}

/** grid-column value spanning steps first..last (inclusive). */
export function stepSpan(first: number, last: number): string {
  return cellSpan(first, last, 4);
}

/**
 * The number over a cell of the step ruler. 1/16 and the triplet grids count
 * their cells (1..16, 1..12, 1..24); 1/32 counts 16ths (1 · 2 · 3 …), so its
 * numbers line up with the 1/16 view. `beat` marks the first cell of a beat.
 */
export function cellLabel(cell: number, spec: GridSpec): { text: string; beat: boolean } {
  const beat = cell % spec.perBeat === 0;
  if (spec.grid === '1/32') return { text: cell % 2 === 0 ? String(cell / 2 + 1) : '·', beat };
  return { text: String(cell + 1), beat };
}

/** A cell for words: "step 5" on the 1/16 grid, "32nd 9 of 32" on finer ones. */
export function cellWords(cell: number, spec: GridSpec): string {
  if (spec.grid === '1/16') return `step ${cell + 1}`;
  const unit = spec.grid === '1/32' ? '32nd' : spec.grid === '1/8T' ? 'triplet 8th' : 'triplet 16th';
  return `${unit} ${cell + 1} of ${spec.cells}`;
}

export function pageStartTick(page: number): number {
  return page * TICKS_PER_BAR;
}

/** The page (bar) a clip tick sits on. */
export function pageOfTick(tick: number): number {
  return Math.max(0, Math.min(MAX_CLIP_BARS - 1, Math.floor(tick / TICKS_PER_BAR)));
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

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
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
  /** Cells of this page the note covers (inclusive). */
  first: number;
  last: number;
  /** Starts on an earlier page / continues onto a later page. */
  fromPrev: boolean;
  toNext: boolean;
  /** The note's sounding part inside its cell span, as fractions 0..1. */
  fillFrom: number;
  fillTo: number;
}

/**
 * Notes that sound during `page` (a note longer than a page continues onto
 * the next ones), placed on cells of `cellTicks` ticks (default 1/16).
 */
export function pageNoteViews(notes: readonly Note[], page: number, clipTicks: number, cellTicks = TICKS_PER_STEP): NoteView[] {
  const cells = Math.round(TICKS_PER_BAR / cellTicks);
  const a = pageStartTick(page);
  const b = Math.min(a + TICKS_PER_BAR, clipTicks);
  const out: NoteView[] = [];
  for (const n of notes) {
    const end = Math.min(n.tick + n.duration, clipTicks);
    if (n.tick >= b || end <= a) continue;
    const visFrom = Math.max(n.tick, a);
    const visTo = Math.min(end, b);
    const first = Math.min(cells - 1, Math.max(0, Math.floor((visFrom - a) / cellTicks)));
    const last = Math.min(cells - 1, Math.max(first, Math.ceil((visTo - a) / cellTicks) - 1));
    const spanFrom = a + first * cellTicks;
    const spanTicks = (last - first + 1) * cellTicks;
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

/** One note starting in a cell, for the velocity lane (lowest pitch first). */
export interface VelocityVoice {
  id: Id;
  pitch: number;
  velocity: number;
  selected: boolean;
}

/** Per cell of `page`: the notes starting in it, lowest pitch first, marked when selected. */
export function velocityVoices(notes: readonly Note[], page: number, spec: GridSpec, selected: ReadonlySet<Id>): VelocityVoice[][] {
  const cols: VelocityVoice[][] = Array.from({ length: spec.cells }, () => []);
  const a = pageStartTick(page);
  for (const n of notes) {
    if (n.tick < a || n.tick >= a + TICKS_PER_BAR) continue;
    const c = Math.min(spec.cells - 1, Math.floor((n.tick - a) / spec.ticks));
    cols[c].push({ id: n.id, pitch: n.pitch, velocity: n.velocity, selected: selected.has(n.id) });
  }
  for (const c of cols) c.sort((x, y) => x.pitch - y.pitch);
  return cols;
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
 * Names are spelled by the key (B♭ in G Dorian).
 */
export function pitchRows(opts: { assist: boolean; root: number; scale: ScaleId; used: readonly number[] }): PitchRow[] {
  const { assist, root, scale, used } = opts;
  const inKeyOnly = assist && scale !== 'chromatic';
  const key: MusicalKey = { root, scale };
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
    rows.push({ pitch: p, name: noteName(p, key), root: pitchClass(p) === pitchClass(root), black: !inKeyOnly && BLACK[pitchClass(p)], outOfKey: inKeyOnly && !inKey });
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

/* ------------------------------------------------------------------ */
/* Selections and moves                                                */
/* ------------------------------------------------------------------ */

/** Ids of the notes that sound inside [t0, t1) on one of `pitches` (a selection box). */
export function notesInBox(notes: readonly Note[], t0: number, t1: number, pitches: ReadonlySet<number>): Id[] {
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  return notes.filter((n) => pitches.has(n.pitch) && n.tick < b && n.tick + n.duration > a).map((n) => n.id);
}

/** The selected notes that still exist, in clip order. */
export function selectedNotes(notes: readonly Note[], ids: ReadonlySet<Id>): Note[] {
  return notes.filter((n) => ids.has(n.id));
}

/** The note a selection is anchored on (where the cursor goes after a move): the earliest, then the lowest. */
export function anchorNote(notes: readonly Note[]): Note | undefined {
  let best: Note | undefined;
  for (const n of notes) if (!best || n.tick < best.tick || (n.tick === best.tick && n.pitch < best.pitch)) best = n;
  return best;
}

function foldPitch(p: number, lo = 0, hi = 127): number {
  let v = p;
  while (v > hi) v -= 12;
  while (v < lo) v += 12;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Where a note goes when its key moves `steps` scale steps: as transposeNotes
 * with `inScale` does it (a note outside the key moves as far as the scale
 * note it sits nearest; a note leaving 0..127 folds back an octave).
 */
export function scaleShiftPitch(pitch: number, steps: number, key: MusicalKey): number {
  const base = snapToScale(pitch, key.root, key.scale);
  return foldPitch(pitch + (transposeInScale(base, steps, key.root, key.scale) - base));
}

/** Scale steps from one pitch to another (each snapped into the key first). */
export function scaleStepsBetween(from: number, to: number, key: MusicalKey): number {
  const per = stepsPerOctave(key.scale);
  const index = (p: number) => {
    const s = snapToScale(p, key.root, key.scale);
    const rel = s - pitchClass(key.root);
    const octave = Math.floor(rel / 12);
    return octave * per + Math.max(0, scaleDegreeOf(s, key.root, key.scale));
  };
  return index(to) - index(from);
}

/**
 * How far a move of the selected notes can go: as moveNotes clamps it, the
 * whole selection stays inside the clip (0..clipTicks-1) as one shape.
 */
export function clampMoveTicks(sel: readonly Note[], dTick: number, clipTicks: number): number {
  if (sel.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const n of sel) {
    min = Math.min(min, n.tick);
    max = Math.max(max, n.tick);
  }
  return Math.min(Math.max(0, clipTicks - 1 - max), Math.max(-min, dTick)) || 0;
}

/** Semitones a selection can move and stay inside 0..127 (as moveNotes clamps it). */
export function clampMovePitch(sel: readonly Note[], dPitch: number): number {
  if (sel.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const n of sel) {
    min = Math.min(min, n.pitch);
    max = Math.max(max, n.pitch);
  }
  return Math.min(127 - max, Math.max(-min, dPitch)) || 0;
}

/** A drag of selected notes: ticks, and either semitones or scale steps of `key`. */
export interface MovePlan {
  dTick: number;
  /** Semitones (Musical Assist off, or a chromatic key). */
  dPitch: number;
  /** Scale steps of the key (Musical Assist on): each note follows the key. */
  steps: number;
  key: MusicalKey | null;
}

/** Where each selected note lands under `plan` (pitch per note id). */
export function plannedPitches(sel: readonly Note[], plan: MovePlan): Map<Id, number> {
  const out = new Map<Id, number>();
  for (const n of sel) out.set(n.id, plan.key && plan.steps ? scaleShiftPitch(n.pitch, plan.steps, plan.key) : n.pitch + plan.dPitch);
  return out;
}

/**
 * The clip's notes as they look with the selection moved by `plan` (for the
 * drag preview); notes landed on stay in the picture until the drop replaces them.
 */
export function previewMovedNotes(notes: readonly Note[], ids: ReadonlySet<Id>, plan: MovePlan): Note[] {
  if (plan.dTick === 0 && plan.dPitch === 0 && plan.steps === 0) return notes as Note[];
  const pitches = plannedPitches(
    notes.filter((n) => ids.has(n.id)),
    plan,
  );
  return notes.map((n) => (ids.has(n.id) ? { ...n, tick: n.tick + plan.dTick, pitch: pitches.get(n.id) ?? n.pitch } : n));
}

/** True when no two notes share a tick and pitch after placing `moved` among the unmoved notes. */
export function landsFree(notes: readonly Note[], moved: ReadonlyMap<Id, { tick: number; pitch: number }>): boolean {
  const taken = new Set<string>();
  for (const n of notes) if (!moved.has(n.id)) taken.add(`${n.tick}:${n.pitch}`);
  for (const m of moved.values()) if (taken.has(`${m.tick}:${m.pitch}`)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Quantize preview                                                    */
/* ------------------------------------------------------------------ */

/**
 * How many notes "Tighten timing" would move with this grid and strength
 * (0..1): the same arithmetic as quantizeClip, so the preview sentence and
 * the toast agree.
 */
export function quantizeMoves(notes: readonly Note[], gridTicks: number, strength: number, clipTicks: number): number {
  if (!(gridTicks > 0)) return 0;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  let moved = 0;
  for (const n of notes) {
    const snapped = Math.round(n.tick / gridTicks) * gridTicks;
    const start = round(n.tick + (snapped - n.tick) * strength);
    const tick = start >= clipTicks ? start - clipTicks : start;
    if (tick !== n.tick) moved++;
  }
  return moved;
}

/* ------------------------------------------------------------------ */
/* Touch                                                               */
/* ------------------------------------------------------------------ */

/** A finger that lifts within this time (ms) and distance is a tap. */
export const TAP_MS = 250;
/** Movement (px) that ends a tap or a pending hold. */
export const TOUCH_SLOP = 8;
/** A finger resting this long (ms) starts a draw, move or resize (the song lane's hold). */
export const TOUCH_HOLD = 300;

/**
 * What a finger on the roll is doing so far: still deciding ('pending'), a
 * swipe that scrolls the roll ('scroll': it moved up or down first), or a
 * sideways press that draws or moves at once ('drag').
 */
export function touchIntent(dx: number, dy: number): 'pending' | 'scroll' | 'drag' {
  if (Math.hypot(dx, dy) < TOUCH_SLOP) return 'pending';
  return Math.abs(dy) >= Math.abs(dx) ? 'scroll' : 'drag';
}

/** True when a finger that went up after `ms`, `dx`/`dy` from where it landed, was a tap. */
export function isTap(dx: number, dy: number, ms: number): boolean {
  return ms < TAP_MS && Math.hypot(dx, dy) < TOUCH_SLOP;
}
