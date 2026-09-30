/**
 * Step and note edits inside a clip, plus recorded-note merging.
 *
 * Steps are 16ths (24 ticks). A note "is on" step s when floor(tick / 24) === s,
 * so slightly early/late unquantized notes still show on the step they start in.
 */
import { uid } from '../../project/factory';
import {
  DRUM_VOICES,
  STEPS_PER_BAR,
  TICKS_PER_BAR,
  TICKS_PER_STEP,
  type Clip,
  type ClipBars,
  type Id,
  type InstrumentKind,
  type Note,
  type Project,
  type QuantizeGrid,
} from '../../project/types';
import { VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { defaultClipName } from './clips';
import { NOT_FOUND, clamp, clipAt, clipTicks, draftClip, draftTrack, findTrack, isFiniteNumber, isSlot, refuse, run, type CommandResult } from './common';

export const DEFAULT_STEP_VELOCITY = 0.8;
const MAX_NOTES = VALIDATION_LIMITS.maxNotesPerClip;

export const QUANTIZE_TICKS: Record<QuantizeGrid, number> = { off: 0, '1/4': 96, '1/8': 48, '1/16': 24, '1/32': 12 };

export function stepOfTick(tick: number): number {
  return Math.floor(tick / TICKS_PER_STEP);
}

/** Snap a tick to the grid (nearest line); 'off' leaves it unchanged. */
export function quantizeTick(tick: number, grid: QuantizeGrid): number {
  const g = QUANTIZE_TICKS[grid];
  return g ? Math.round(tick / g) * g : tick;
}

export function pitchRangeFor(kind: InstrumentKind): [number, number] {
  return kind === 'drums' ? [0, DRUM_VOICES - 1] : [0, 127];
}

function validPitch(kind: InstrumentKind, pitch: number): boolean {
  const [lo, hi] = pitchRangeFor(kind);
  return Number.isInteger(pitch) && pitch >= lo && pitch <= hi;
}

function noteKey(tick: number, pitch: number): string {
  return `${tick}|${pitch}`;
}

function findNote(p: Project, trackId: Id, slot: number, noteId: Id): { clip: Clip; note: Note } | null {
  const clip = clipAt(p, trackId, slot);
  const note = clip?.notes.find((n) => n.id === noteId);
  return clip && note ? { clip, note } : null;
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

/** Notes of a pitch on a step (for rendering the step grid). */
export function notesAtStep(clip: Clip, stepIndex: number, pitch: number): Note[] {
  return clip.notes.filter((n) => n.pitch === pitch && stepOfTick(n.tick) === stepIndex);
}

/**
 * Toggle a step for a pitch (drum voice index for kits). Adds a one-step note
 * at stepIndex * 24, or removes the notes of that pitch on that step. An empty
 * slot gets a new clip long enough for the step.
 */
export function toggleStep(store: ProjectStore, trackId: Id, slot: number, stepIndex: number, pitch: number, velocity = DEFAULT_STEP_VELOCITY): CommandResult & { added?: boolean } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(slot)) return refuse('invalid', 'Unknown clip slot.');
  if (!validPitch(t.instrument.kind, pitch)) return refuse('invalid', 'That pitch cannot be played by this part.');
  if (!isFiniteNumber(velocity)) return refuse('invalid', 'Velocity must be a number.');
  const clip = t.clips[slot];
  const maxSteps = clip ? clip.bars * STEPS_PER_BAR : 4 * STEPS_PER_BAR;
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= maxSteps) return refuse('invalid', 'That step is outside the clip.');

  const tick = stepIndex * TICKS_PER_STEP;
  const note: Note = { id: uid('n'), tick, pitch, velocity: clamp(velocity, 0, 1), duration: TICKS_PER_STEP };
  if (!clip) {
    const bars = Math.max(1, Math.ceil((stepIndex + 1) / STEPS_PER_BAR)) as ClipBars;
    const fresh: Clip = { id: uid('clip'), name: defaultClipName(p, slot), bars, notes: [note] };
    const r = run(store, 'notes:Add step', (d) => {
      draftTrack(d, trackId).clips[slot] = fresh;
    });
    return { ...r, added: true };
  }
  const existing = notesAtStep(clip, stepIndex, pitch);
  if (existing.length) {
    const ids = new Set(existing.map((n) => n.id));
    const r = run(store, 'notes:Remove step', (d) => {
      const c = draftClip(d, trackId, slot);
      c.notes = c.notes.filter((n) => !ids.has(n.id));
    });
    return { ...r, added: false };
  }
  if (clip.notes.length >= MAX_NOTES) return refuse('limit', 'This clip is full.');
  const r = run(store, 'notes:Add step', (d) => {
    draftClip(d, trackId, slot).notes.push(note);
  });
  return { ...r, added: true };
}

/* ------------------------------------------------------------------ */
/* Single notes                                                        */
/* ------------------------------------------------------------------ */

export function setNoteVelocity(store: ProjectStore, trackId: Id, slot: number, noteId: Id, velocity: number, gesture?: string): CommandResult {
  if (!findNote(store.getState(), trackId, slot, noteId)) return NOT_FOUND('note');
  if (!isFiniteNumber(velocity)) return refuse('invalid', 'Velocity must be a number.');
  const v = clamp(velocity, 0, 1);
  return run(store, 'notes:Change velocity', (d) => {
    const n = draftClip(d, trackId, slot).notes.find((x) => x.id === noteId);
    if (n) n.velocity = v;
  }, gesture);
}

/** Note length in ticks, clamped to 1 tick .. the clip length. */
export function setNoteDuration(store: ProjectStore, trackId: Id, slot: number, noteId: Id, ticks: number, gesture?: string): CommandResult {
  const found = findNote(store.getState(), trackId, slot, noteId);
  if (!found) return NOT_FOUND('note');
  if (!isFiniteNumber(ticks)) return refuse('invalid', 'Length must be a number.');
  const v = clamp(ticks, VALIDATION_LIMITS.minNoteTicks, clipTicks(found.clip));
  return run(store, 'notes:Change note length', (d) => {
    const n = draftClip(d, trackId, slot).notes.find((x) => x.id === noteId);
    if (n) n.duration = v;
  }, gesture);
}

/** Add one note (tick within the clip, pitch valid for the part). A note already at the same tick and pitch is replaced. */
export function addNote(store: ProjectStore, trackId: Id, slot: number, note: Omit<Note, 'id'>): CommandResult & { noteId?: Id } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  const clip = clipAt(p, trackId, slot);
  if (!t || !clip) return NOT_FOUND('clip');
  const len = clipTicks(clip);
  if (![note.tick, note.pitch, note.velocity, note.duration].every(isFiniteNumber) || note.tick < 0 || note.tick >= len) return refuse('invalid', 'That note is outside the clip.');
  const pitch = Math.round(note.pitch);
  if (!validPitch(t.instrument.kind, pitch)) return refuse('invalid', 'That pitch cannot be played by this part.');
  const replaced = clip.notes.filter((n) => n.tick === note.tick && n.pitch === pitch).map((n) => n.id);
  if (clip.notes.length - replaced.length >= MAX_NOTES) return refuse('limit', 'This clip is full.');
  const n: Note = { id: uid('n'), tick: note.tick, pitch, velocity: clamp(note.velocity, 0, 1), duration: clamp(note.duration, VALIDATION_LIMITS.minNoteTicks, len) };
  const r = run(store, 'notes:Add note', (d) => {
    const c = draftClip(d, trackId, slot);
    if (replaced.length) c.notes = c.notes.filter((x) => !replaced.includes(x.id));
    c.notes.push(n);
  });
  return { ...r, noteId: n.id };
}

export function removeNote(store: ProjectStore, trackId: Id, slot: number, noteId: Id): CommandResult {
  if (!findNote(store.getState(), trackId, slot, noteId)) return NOT_FOUND('note');
  return run(store, 'notes:Remove note', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = c.notes.filter((n) => n.id !== noteId);
  });
}

/**
 * Move a note in time and/or pitch (clamped into the clip). A single move
 * that lands exactly on another note replaces it. During a drag (`gesture`)
 * an occupied position is refused ('occupied') instead, so dragging across
 * other notes never deletes the ones merely passed over.
 */
export function moveNote(store: ProjectStore, trackId: Id, slot: number, noteId: Id, to: { tick?: number; pitch?: number }, gesture?: string): CommandResult {
  const p = store.getState();
  const found = findNote(p, trackId, slot, noteId);
  const t = findTrack(p, trackId);
  if (!found || !t) return NOT_FOUND('note');
  const len = clipTicks(found.clip);
  let tick = found.note.tick;
  let pitch = found.note.pitch;
  if (to.tick !== undefined) {
    if (!isFiniteNumber(to.tick)) return refuse('invalid', 'Position must be a number.');
    tick = to.tick < 0 ? 0 : to.tick >= len ? len - 1 : to.tick;
  }
  if (to.pitch !== undefined) {
    if (!isFiniteNumber(to.pitch)) return refuse('invalid', 'Pitch must be a number.');
    const [lo, hi] = pitchRangeFor(t.instrument.kind);
    pitch = clamp(Math.round(to.pitch), lo, hi);
  }
  if (gesture !== undefined && found.clip.notes.some((x) => x.id !== noteId && x.tick === tick && x.pitch === pitch)) {
    return refuse('occupied', 'There is already a note there.');
  }
  return run(store, 'notes:Move note', (d) => {
    const c = draftClip(d, trackId, slot);
    const n = c.notes.find((x) => x.id === noteId);
    if (!n) return;
    n.tick = tick;
    n.pitch = pitch;
    if (c.notes.some((x) => x.id !== noteId && x.tick === tick && x.pitch === pitch)) {
      c.notes = c.notes.filter((x) => x.id === noteId || x.tick !== tick || x.pitch !== pitch);
    }
  }, gesture);
}

export function clearNotesForPitch(store: ProjectStore, trackId: Id, slot: number, pitch: number): CommandResult {
  const clip = clipAt(store.getState(), trackId, slot);
  if (!clip) return NOT_FOUND('clip');
  if (!clip.notes.some((n) => n.pitch === pitch)) return { changed: false };
  return run(store, 'notes:Clear row', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = c.notes.filter((n) => n.pitch !== pitch);
  });
}

/* ------------------------------------------------------------------ */
/* Pages (one bar = 16 steps)                                          */
/* ------------------------------------------------------------------ */

function pageRange(page: number): [number, number] {
  return [page * TICKS_PER_BAR, (page + 1) * TICKS_PER_BAR];
}

export function clearPage(store: ProjectStore, trackId: Id, slot: number, page: number): CommandResult {
  const clip = clipAt(store.getState(), trackId, slot);
  if (!clip) return NOT_FOUND('clip');
  if (!Number.isInteger(page) || page < 0 || page >= clip.bars) return refuse('invalid', 'That page is outside the clip.');
  const [a, b] = pageRange(page);
  if (!clip.notes.some((n) => n.tick >= a && n.tick < b)) return { changed: false };
  return run(store, 'notes:Clear page', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = c.notes.filter((n) => n.tick < a || n.tick >= b);
  });
}

/** Notes of one page with ticks relative to the page start (for a page clipboard). */
export function copyPage(project: Project, trackId: Id, slot: number, page: number): Omit<Note, 'id'>[] {
  const clip = clipAt(project, trackId, slot);
  if (!clip) return [];
  const [a, b] = pageRange(page);
  return clip.notes.filter((n) => n.tick >= a && n.tick < b).map((n) => ({ tick: n.tick - a, pitch: n.pitch, velocity: n.velocity, duration: n.duration }));
}

/**
 * Replace a page's notes with `notes` (ticks relative to the page). Pasting
 * onto a page past the end lengthens the clip (up to 4 bars).
 */
export function pastePage(store: ProjectStore, trackId: Id, slot: number, page: number, notes: readonly Omit<Note, 'id'>[]): CommandResult {
  return writePage(store, 'notes:Paste page', trackId, slot, page, notes);
}

function writePage(store: ProjectStore, label: string, trackId: Id, slot: number, page: number, notes: readonly Omit<Note, 'id'>[]): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  const clip = clipAt(p, trackId, slot);
  if (!t || !clip) return NOT_FOUND('clip');
  if (!Number.isInteger(page) || page < 0 || page > 3) return refuse('invalid', 'Clips have at most 4 pages.');
  const [a, b] = pageRange(page);
  const placed: Note[] = [];
  for (const n of notes) {
    if (![n.tick, n.pitch, n.velocity, n.duration].every(isFiniteNumber) || n.tick < 0 || n.tick >= TICKS_PER_BAR) continue;
    if (!validPitch(t.instrument.kind, Math.round(n.pitch))) continue;
    placed.push({ id: uid('n'), tick: n.tick + a, pitch: Math.round(n.pitch), velocity: clamp(n.velocity, 0, 1), duration: clamp(n.duration, VALIDATION_LIMITS.minNoteTicks, VALIDATION_LIMITS.maxNoteTicks) });
  }
  const kept = clip.notes.filter((n) => n.tick < a || n.tick >= b);
  if (kept.length + placed.length > MAX_NOTES) return refuse('limit', 'The clip would have too many notes.');
  const bars = Math.max(clip.bars, page + 1) as ClipBars;
  return run(store, label, (d) => {
    const c = draftClip(d, trackId, slot);
    c.bars = bars;
    c.notes = [...c.notes.filter((n) => n.tick < a || n.tick >= b), ...placed];
  });
}

/** Copy one page onto another (default: the next page, lengthening the clip if needed). */
export function duplicatePage(store: ProjectStore, trackId: Id, slot: number, fromPage: number, toPage = fromPage + 1): CommandResult {
  const p = store.getState();
  const clip = clipAt(p, trackId, slot);
  if (!clip) return NOT_FOUND('clip');
  if (!Number.isInteger(fromPage) || fromPage < 0 || fromPage >= clip.bars) return refuse('invalid', 'That page is outside the clip.');
  if (!Number.isInteger(toPage) || toPage < 0 || toPage > 3 || toPage === fromPage) return refuse('invalid', 'Clips have at most 4 pages.');
  return writePage(store, 'notes:Duplicate page', trackId, slot, toPage, copyPage(p, trackId, slot, fromPage));
}

/** Transpose a melodic clip; notes leaving 0..127 are folded back by octaves. */
export function transposeClip(store: ProjectStore, trackId: Id, slot: number, semitones: number): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  const clip = clipAt(p, trackId, slot);
  if (!t || !clip) return NOT_FOUND('clip');
  if (t.instrument.kind === 'drums') return refuse('invalid', 'Drum clips cannot be transposed.');
  if (!Number.isInteger(semitones) || semitones === 0) return { changed: false };
  const fold = (x: number) => {
    let v = x;
    while (v > 127) v -= 12;
    while (v < 0) v += 12;
    return v;
  };
  return run(store, 'notes:Transpose clip', (d) => {
    for (const n of draftClip(d, trackId, slot).notes) n.pitch = fold(n.pitch + semitones);
  });
}

/* ------------------------------------------------------------------ */
/* Record Notes                                                        */
/* ------------------------------------------------------------------ */

export interface RecordOptions {
  quantize: QuantizeGrid;
  /** overdub: merge with the existing notes; replace: the take replaces the clip's notes. */
  mode: 'overdub' | 'replace';
  /** Edits with the same gesture id form one undo step (one Record Notes pass). */
  gesture?: string;
}

/**
 * Merge recorded notes into a clip. Ticks are snapped to the grid and wrapped
 * into the clip length (a note snapped onto the loop end lands on tick 0).
 * A recorded note at exactly the same tick and pitch as an existing note
 * replaces it. An empty slot gets a clip long enough for the take (max 4 bars).
 */
export function addRecordedNotes(store: ProjectStore, trackId: Id, slot: number, notes: readonly Omit<Note, 'id'>[], opts: RecordOptions): CommandResult & { added?: number } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(slot)) return refuse('invalid', 'Unknown clip slot.');
  if (!(opts.quantize in QUANTIZE_TICKS)) return refuse('invalid', 'Unknown quantize setting.');
  // Negative ticks (played just before the downbeat) wrap into the loop like any other position.
  const valid = notes.filter((n) => [n.tick, n.pitch, n.velocity, n.duration].every(isFiniteNumber) && validPitch(t.instrument.kind, Math.round(n.pitch)));
  if (valid.length === 0) return { changed: false, added: 0 };

  const existingClip = t.clips[slot];
  let lastTick = 0;
  for (const n of valid) lastTick = Math.max(lastTick, quantizeTick(n.tick, opts.quantize));
  const bars = existingClip ? existingClip.bars : (clamp(Math.ceil((lastTick + 1) / TICKS_PER_BAR), 1, 4) as ClipBars);
  const len = bars * TICKS_PER_BAR;

  // Last write wins for identical positions within the take.
  const incoming = new Map<string, Note>();
  for (const n of valid) {
    const q = quantizeTick(n.tick, opts.quantize);
    const tick = ((q % len) + len) % len || 0; // `|| 0` turns -0 into 0
    const pitch = Math.round(n.pitch);
    incoming.set(noteKey(tick, pitch), { id: uid('n'), tick, pitch, velocity: clamp(n.velocity, 0, 1), duration: clamp(n.duration, VALIDATION_LIMITS.minNoteTicks, len) });
  }
  // Replacements keep the note count; only genuinely new notes can hit the clip limit.
  const keyOf = (n: Note) => noteKey(n.tick, n.pitch);
  const existingNotes = opts.mode === 'replace' || !existingClip ? [] : existingClip.notes;
  const existingKeys = new Set(existingNotes.map(keyOf));
  const replacing = [...incoming.values()].filter((n) => existingKeys.has(keyOf(n)));
  let fresh = [...incoming.values()].filter((n) => !existingKeys.has(keyOf(n)));
  let message: string | undefined;
  if (existingNotes.length + fresh.length > MAX_NOTES) {
    fresh = fresh.slice(0, Math.max(0, MAX_NOTES - existingNotes.length));
    message = 'The clip is full; some recorded notes were not kept.';
  }
  const added = [...replacing, ...fresh];
  const addedKeys = new Set(added.map(keyOf));
  const label = 'notes:Record notes';
  const r = existingClip
    ? run(store, label, (d) => {
        const c = draftClip(d, trackId, slot);
        c.notes = opts.mode === 'replace' ? added : [...c.notes.filter((n) => !addedKeys.has(keyOf(n))), ...added];
      }, opts.gesture)
    : run(store, label, (d) => {
        draftTrack(d, trackId).clips[slot] = { id: uid('clip'), name: defaultClipName(p, slot), bars, notes: added };
      }, opts.gesture);
  return { ...r, added: added.length, message };
}
