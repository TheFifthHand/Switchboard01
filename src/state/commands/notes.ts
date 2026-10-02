/**
 * Step and note edits inside a clip, plus recorded-note merging.
 *
 * Steps are 16ths (24 ticks). A note "is on" step s when floor(tick / 24) === s,
 * so slightly early/late unquantized notes still show on the step they start in.
 * Notes may start on any tick (finer grids: GRID_TICKS); the step grid is only
 * how the 1/16 view reads them.
 *
 * Selection commands (moveNotes, deleteNotes, setNotesVelocity,
 * transposeNotes, duplicateNotes, pasteNotes) act on note ids. Ids that no
 * longer exist are skipped; a call with none left is refused. Every command
 * is one undo step (a shared gesture id joins a drag into one), refuses
 * invalid input with nothing changed, and is refused during a performance
 * take like every other clip edit (its "notes:" label is not on the take's
 * allow-list). Each returns counts for a toast.
 */
import { chordAt, getProgression, resolveProgression, voiceLeadLoop } from '../../music/chords';
import { pitchClass, snapToScale, transposeInScale, type MusicalKey } from '../../music/scales';
import { uid } from '../../project/factory';
import { Rng, subSeed } from '../../project/rng';
import {
  DRUM_VOICES,
  MAX_CLIP_BARS,
  STEPS_PER_BAR,
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  TICKS_PER_STEP,
  type Clip,
  type ClipBars,
  type Id,
  type InstrumentKind,
  type Note,
  type Project,
  type QuantizeGrid,
  type Track,
} from '../../project/types';
import { SCALE_IDS, VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import type { StepGrid } from '../uiStore';
import { defaultClipName } from './clips';
import { NOT_FOUND, clamp, clipAt, clipTicks, draftClip, draftTrack, findTrack, isFiniteNumber, isSlot, refuse, run, type CommandResult } from './common';

export const DEFAULT_STEP_VELOCITY = 0.8;
const MAX_NOTES = VALIDATION_LIMITS.maxNotesPerClip;

export const QUANTIZE_TICKS: Record<QuantizeGrid, number> = { off: 0, '1/4': 96, '1/8': 48, '1/16': 24, '1/32': 12 };

/** Ticks per cell of each editing grid (uiStore.stepGrid): 1/16 = 24, 1/32 = 12, 1/8 triplet = 32, 1/16 triplet = 16. */
export const GRID_TICKS: Readonly<Record<StepGrid, number>> = { '1/16': 24, '1/32': 12, '1/8T': 32, '1/16T': 16 };

/** Grids Quantize can snap to: the editing grids plus quarters and eighths. */
export type QuantizeTo = StepGrid | '1/4' | '1/8';
export const QUANTIZE_TO_TICKS: Readonly<Record<QuantizeTo, number>> = { '1/4': 96, '1/8': 48, ...GRID_TICKS };

/** A nudge moves notes this many ticks (1/96 of a bar): moveNotes(..., ±NUDGE_TICKS, 0). */
export const NUDGE_TICKS = 4;

/** Most scale or semitone steps one transpose may move. */
const MAX_TRANSPOSE_STEPS = 48;

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Drop notes that share a tick and pitch with an earlier one, keeping the louder of each pair (stable order). */
function dedupeNotes(notes: readonly Note[]): Note[] {
  const byKey = new Map<string, number>();
  const out: Note[] = [];
  for (const n of notes) {
    const k = noteKey(n.tick, n.pitch);
    const at = byKey.get(k);
    if (at === undefined) {
      byKey.set(k, out.length);
      out.push(n);
    } else if (n.velocity > out[at].velocity) {
      out[at] = n;
    }
  }
  return out;
}

/** Fold a pitch into [lo, hi] by octaves (keeps its pitch class); a range under an octave clamps. */
function foldPitch(p: number, lo: number, hi: number): number {
  let v = p;
  if (hi - lo >= 11) {
    while (v > hi) v -= 12;
    while (v < lo) v += 12;
  }
  return clamp(v, lo, hi);
}

interface Target {
  track: Track;
  clip: Clip;
  len: number;
}

/** The part and clip a note edit works on (the slot checked against the part's own slots). */
function target(p: Project, trackId: Id, slot: number): Target | CommandResult {
  const track = findTrack(p, trackId);
  if (!track) return NOT_FOUND('part');
  if (!isSlot(slot, track)) return refuse('invalid', 'There is no clip slot there.');
  const clip = track.clips[slot];
  if (!clip) return NOT_FOUND('clip');
  return { track, clip, len: clipTicks(clip) };
}

const isTarget = (x: Target | CommandResult): x is Target => 'clip' in x;

/** The clip's notes whose ids are listed (clip order, each once). */
function selectedNotes(clip: Clip, ids: readonly Id[]): Note[] {
  const want = new Set(ids);
  return clip.notes.filter((n) => want.has(n.id));
}

/** Refusal for a selection that is not a list of ids. */
function noSelection(ids: unknown): CommandResult | null {
  return Array.isArray(ids) ? null : refuse('invalid', 'Choose some notes first.');
}

const GONE = (): CommandResult => refuse('not-found', 'Those notes no longer exist.');

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
  if (!isSlot(slot, t)) return refuse('invalid', 'There is no clip slot there.');
  if (!validPitch(t.instrument.kind, pitch)) return refuse('invalid', 'That pitch cannot be played by this part.');
  if (!isFiniteNumber(velocity)) return refuse('invalid', 'Velocity must be a number.');
  const clip = t.clips[slot];
  const maxSteps = clip ? clip.bars * STEPS_PER_BAR : MAX_CLIP_BARS * STEPS_PER_BAR;
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
  // A note ends at the clip's end at the latest (the loop point).
  const v = clamp(ticks, VALIDATION_LIMITS.minNoteTicks, Math.max(VALIDATION_LIMITS.minNoteTicks, clipTicks(found.clip) - found.note.tick));
  return run(store, 'notes:Change note length', (d) => {
    const n = draftClip(d, trackId, slot).notes.find((x) => x.id === noteId);
    if (n) n.duration = v;
  }, gesture);
}

/**
 * Add one note (tick within the clip, pitch valid for the part). Any tick is
 * accepted, so notes can sit on finer grids (GRID_TICKS) or off the grid. A
 * note already at the same tick and pitch is replaced.
 */
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
 * Move a note in time and/or pitch (clamped into the clip; any tick, so finer
 * grids and nudges work). A single move
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

/** Remove every note of one pitch (a drum sound's row) from the clip. Returns how many went. */
export function clearNotesForPitch(store: ProjectStore, trackId: Id, slot: number, pitch: number): CommandResult & { removed: number } {
  const clip = clipAt(store.getState(), trackId, slot);
  if (!clip) return { ...NOT_FOUND('clip'), removed: 0 };
  const removed = clip.notes.filter((n) => n.pitch === pitch).length;
  if (removed === 0) return { changed: false, removed: 0 };
  const r = run(store, 'notes:Clear row', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = c.notes.filter((n) => n.pitch !== pitch);
  });
  return { ...r, removed: r.changed ? removed : 0 };
}

/* ------------------------------------------------------------------ */
/* Pages (one bar = 16 steps)                                          */
/* ------------------------------------------------------------------ */

const PAGES_MESSAGE = `Clips have at most ${MAX_CLIP_BARS} bars.`;

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
 * onto a page past the end lengthens the clip (up to MAX_CLIP_BARS bars).
 */
export function pastePage(store: ProjectStore, trackId: Id, slot: number, page: number, notes: readonly Omit<Note, 'id'>[]): CommandResult {
  return writePage(store, 'notes:Paste page', trackId, slot, page, notes);
}

function writePage(store: ProjectStore, label: string, trackId: Id, slot: number, page: number, notes: readonly Omit<Note, 'id'>[]): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  const clip = clipAt(p, trackId, slot);
  if (!t || !clip) return NOT_FOUND('clip');
  if (!Number.isInteger(page) || page < 0 || page >= MAX_CLIP_BARS) return refuse('invalid', PAGES_MESSAGE);
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
  if (!Number.isInteger(toPage) || toPage < 0 || toPage >= MAX_CLIP_BARS || toPage === fromPage) return refuse('invalid', PAGES_MESSAGE);
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
 * replaces it. An empty slot gets a clip long enough for the take (at most
 * MAX_CLIP_BARS bars).
 */
export function addRecordedNotes(store: ProjectStore, trackId: Id, slot: number, notes: readonly Omit<Note, 'id'>[], opts: RecordOptions): CommandResult & { added?: number } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSlot(slot, t)) return refuse('invalid', 'There is no clip slot there.');
  if (!(opts.quantize in QUANTIZE_TICKS)) return refuse('invalid', 'Unknown quantize setting.');
  // Negative ticks (played just before the downbeat) wrap into the loop like any other position.
  const valid = notes.filter((n) => [n.tick, n.pitch, n.velocity, n.duration].every(isFiniteNumber) && validPitch(t.instrument.kind, Math.round(n.pitch)));
  if (valid.length === 0) return { changed: false, added: 0 };

  const existingClip = t.clips[slot];
  let lastTick = 0;
  for (const n of valid) lastTick = Math.max(lastTick, quantizeTick(n.tick, opts.quantize));
  const bars = existingClip ? existingClip.bars : (clamp(Math.ceil((lastTick + 1) / TICKS_PER_BAR), 1, MAX_CLIP_BARS) as ClipBars);
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

/* ------------------------------------------------------------------ */
/* Selections (piano roll)                                             */
/* ------------------------------------------------------------------ */

/**
 * Move selected notes by `dTick` ticks and `dPitch` semitones (drum rows for
 * kits) anywhere in the clip, across bars. The selection moves as one shape:
 * the move is shortened so every note stays inside 0..clip length and the
 * part's pitch range (`dTick`/`dPitch` in the result say how far it went).
 * A nudge is dTick ±NUDGE_TICKS. A moved note that lands exactly on an
 * unselected note replaces it; during a drag (`gesture`) that is refused
 * ('occupied') instead, so notes passed over are never deleted.
 */
export function moveNotes(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  ids: readonly Id[],
  dTick: number,
  dPitch: number,
  gesture?: string,
): CommandResult & { moved: number; dTick: number; dPitch: number } {
  const none = { moved: 0, dTick: 0, dPitch: 0 };
  const t = target(store.getState(), trackId, slot);
  if (!isTarget(t)) return { ...t, ...none };
  const bad = noSelection(ids);
  if (bad) return { ...bad, ...none };
  if (!isFiniteNumber(dTick) || !isFiniteNumber(dPitch)) return { ...refuse('invalid', 'A move must be a number of ticks and semitones.'), ...none };
  const sel = selectedNotes(t.clip, ids);
  if (sel.length === 0) return { ...GONE(), ...none };
  const [lo, hi] = pitchRangeFor(t.track.instrument.kind);
  const minTick = Math.min(...sel.map((n) => n.tick));
  const maxTick = Math.max(...sel.map((n) => n.tick));
  const minPitch = Math.min(...sel.map((n) => n.pitch));
  const maxPitch = Math.max(...sel.map((n) => n.pitch));
  const dt = clamp(dTick, -minTick, Math.max(0, t.len - 1 - maxTick)) || 0;
  const dp = clamp(Math.round(dPitch), lo - minPitch, hi - maxPitch) || 0;
  if (dt === 0 && dp === 0) {
    return dTick === 0 && Math.round(dPitch) === 0 ? { changed: false, ...none } : { ...refuse('limit', 'The notes are already at the edge of the clip.'), ...none };
  }
  const selIds = new Set(sel.map((n) => n.id));
  const landing = new Set(sel.map((n) => noteKey(n.tick + dt, n.pitch + dp)));
  const hit = t.clip.notes.filter((n) => !selIds.has(n.id) && landing.has(noteKey(n.tick, n.pitch)));
  if (gesture !== undefined && hit.length) return { ...refuse('occupied', 'There is already a note there.'), ...none };
  const hitIds = new Set(hit.map((n) => n.id));
  const r = run(store, 'notes:Move notes', (d) => {
    const c = draftClip(d, trackId, slot);
    if (hitIds.size) c.notes = c.notes.filter((n) => !hitIds.has(n.id));
    for (const n of c.notes) {
      if (!selIds.has(n.id)) continue;
      n.tick += dt;
      n.pitch += dp;
    }
  }, gesture, { display: `Move ${plural(sel.length, 'note')}` });
  return r.changed ? { ...r, moved: sel.length, dTick: dt, dPitch: dp } : { ...r, ...none };
}

/** Delete the selected notes. */
export function deleteNotes(store: ProjectStore, trackId: Id, slot: number, ids: readonly Id[]): CommandResult & { deleted: number } {
  const t = target(store.getState(), trackId, slot);
  if (!isTarget(t)) return { ...t, deleted: 0 };
  const bad = noSelection(ids);
  if (bad) return { ...bad, deleted: 0 };
  const sel = new Set(selectedNotes(t.clip, ids).map((n) => n.id));
  if (sel.size === 0) return { ...GONE(), deleted: 0 };
  const r = run(store, 'notes:Delete notes', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = c.notes.filter((n) => !sel.has(n.id));
  }, undefined, { display: `Delete ${plural(sel.size, 'note')}` });
  return { ...r, deleted: r.changed ? sel.size : 0 };
}

/**
 * Set the velocity (0..1) of the selected notes, or change it by
 * `{ delta }` (each note keeps its own level relative to the others). One
 * voice of a chord can be set alone. A shared gesture id joins a drag into
 * one undo step.
 */
export function setNotesVelocity(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  ids: readonly Id[],
  value: number | { delta: number },
  gesture?: string,
): CommandResult & { notes: number } {
  const t = target(store.getState(), trackId, slot);
  if (!isTarget(t)) return { ...t, notes: 0 };
  const bad = noSelection(ids);
  if (bad) return { ...bad, notes: 0 };
  const delta = typeof value === 'object' && value !== null ? value.delta : undefined;
  if (typeof value === 'number' ? !isFiniteNumber(value) : !isFiniteNumber(delta)) return { ...refuse('invalid', 'Velocity must be a number.'), notes: 0 };
  const sel = selectedNotes(t.clip, ids);
  if (sel.length === 0) return { ...GONE(), notes: 0 };
  const next = new Map(sel.map((n) => [n.id, clamp(typeof value === 'number' ? value : n.velocity + (delta as number), 0, 1)]));
  const changedCount = sel.filter((n) => next.get(n.id) !== n.velocity).length;
  if (changedCount === 0) return { changed: false, notes: 0 };
  const r = run(store, 'notes:Change velocity', (d) => {
    for (const n of draftClip(d, trackId, slot).notes) {
      const v = next.get(n.id);
      if (v !== undefined) n.velocity = v;
    }
  }, gesture, { display: `Change velocity of ${plural(sel.length, 'note')}` });
  return { ...r, notes: r.changed ? changedCount : 0 };
}

/**
 * Where a note goes when its key moves by `steps` scale steps. Scale notes
 * use transposeInScale; a note outside the key moves as far as the scale
 * note it sits nearest, so chromatic colour notes keep their colour.
 */
function scaleShift(pitch: number, steps: number, key: MusicalKey): number {
  const base = snapToScale(pitch, key.root, key.scale);
  return pitch + (transposeInScale(base, steps, key.root, key.scale) - base);
}

/**
 * Transpose the selected notes by `steps` semitones, or by scale steps of
 * `inScale` (Musical Assist; ±7 is an octave in a seven-note scale). In
 * semitones the selection keeps its shape and stops at the part's range; in
 * scale steps each note follows the key and folds back by an octave at the
 * range's edge. A transposed note landing on another note's tick and pitch
 * replaces it. Drum notes are sounds, not pitches, so they are refused (move
 * them to another row with moveNotes).
 */
export function transposeNotes(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  ids: readonly Id[],
  steps: number,
  opts: { inScale?: MusicalKey } = {},
): CommandResult & { moved: number } {
  const t = target(store.getState(), trackId, slot);
  if (!isTarget(t)) return { ...t, moved: 0 };
  if (t.track.instrument.kind === 'drums') return { ...refuse('invalid', 'Drum notes are sounds, not pitches: move them to another sound instead.'), moved: 0 };
  const bad = noSelection(ids);
  if (bad) return { ...bad, moved: 0 };
  if (!Number.isInteger(steps) || Math.abs(steps) > MAX_TRANSPOSE_STEPS) return { ...refuse('invalid', 'Transpose by a whole number of steps.'), moved: 0 };
  const key = opts.inScale;
  if (key && !(isFiniteNumber(key.root) && SCALE_IDS.includes(key.scale))) return { ...refuse('invalid', 'Unknown key or scale.'), moved: 0 };
  const sel = selectedNotes(t.clip, ids);
  if (sel.length === 0) return { ...GONE(), moved: 0 };
  if (steps === 0) return { changed: false, moved: 0 };
  const [lo, hi] = pitchRangeFor(t.track.instrument.kind);
  let to: Map<Id, number>;
  if (key) {
    to = new Map(sel.map((n) => [n.id, foldPitch(scaleShift(n.pitch, steps, key), lo, hi)]));
  } else {
    const minPitch = Math.min(...sel.map((n) => n.pitch));
    const maxPitch = Math.max(...sel.map((n) => n.pitch));
    const dp = clamp(steps, lo - minPitch, hi - maxPitch);
    if (dp === 0) return { ...refuse('limit', 'The notes are already at the edge of the range.'), moved: 0 };
    to = new Map(sel.map((n) => [n.id, n.pitch + dp]));
  }
  const moved = sel.filter((n) => to.get(n.id) !== n.pitch).length;
  if (moved === 0) return { changed: false, moved: 0 };
  const words = key ? plural(Math.abs(steps), 'scale step') : plural(Math.abs(steps), 'semitone');
  const r = run(store, 'notes:Transpose notes', (d) => {
    const c = draftClip(d, trackId, slot);
    const landing = new Set(sel.map((n) => noteKey(n.tick, to.get(n.id) as number)));
    const kept = c.notes.filter((n) => to.has(n.id) || !landing.has(noteKey(n.tick, n.pitch)));
    for (const n of kept) {
      const v = to.get(n.id);
      if (v !== undefined) n.pitch = v;
    }
    c.notes = dedupeNotes(kept);
  }, undefined, { display: `Transpose ${plural(sel.length, 'note')} ${steps > 0 ? 'up' : 'down'} ${words}` });
  return { ...r, moved: r.changed ? moved : 0 };
}

/**
 * The selected notes as a clipboard: ticks relative to the earliest one,
 * ids left out (pasteNotes gives new ones).
 */
export function copyNotes(project: Project, trackId: Id, slot: number, ids: readonly Id[]): Omit<Note, 'id'>[] {
  const clip = clipAt(project, trackId, slot);
  if (!clip || !Array.isArray(ids)) return [];
  const sel = selectedNotes(clip, ids);
  if (sel.length === 0) return [];
  const start = Math.min(...sel.map((n) => n.tick));
  return sel.map((n) => ({ tick: n.tick - start, pitch: n.pitch, velocity: n.velocity, duration: n.duration }));
}

/**
 * Place notes in the clip with their earliest note at `atTick`, as new notes
 * (new ids, returned so the view can select them). Notes that would start
 * past the clip's end or that the part cannot play are left out (`skipped`).
 * A pasted note replaces a note at the same tick and pitch.
 */
function placeNotes(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  t: Target,
  notes: readonly Omit<Note, 'id'>[],
  atTick: number,
  label: string,
  verb: string,
): CommandResult & { ids: Id[]; added: number; skipped: number } {
  const none = { ids: [] as Id[], added: 0, skipped: 0 };
  const finite = notes.filter((n) => n && [n.tick, n.pitch, n.velocity, n.duration].every(isFiniteNumber));
  if (finite.length === 0) return { ...refuse('empty', 'There are no notes to place.'), ...none };
  const start = Math.min(...finite.map((n) => n.tick));
  const placed: Note[] = [];
  for (const n of finite) {
    const tick = n.tick - start + atTick;
    const pitch = Math.round(n.pitch);
    if (tick < 0 || tick >= t.len || !validPitch(t.track.instrument.kind, pitch)) continue;
    placed.push({ id: uid('n'), tick, pitch, velocity: clamp(n.velocity, 0, 1), duration: clamp(n.duration, VALIDATION_LIMITS.minNoteTicks, VALIDATION_LIMITS.maxNoteTicks) });
  }
  const skipped = notes.length - placed.length;
  if (placed.length === 0) return { ...refuse('limit', 'None of those notes fit here: they would start past the end of the clip or outside what this part can play.'), ...none, skipped };
  const unique = dedupeNotes(placed);
  const landing = new Set(unique.map((n) => noteKey(n.tick, n.pitch)));
  const kept = t.clip.notes.filter((n) => !landing.has(noteKey(n.tick, n.pitch)));
  if (kept.length + unique.length > MAX_NOTES) return { ...refuse('limit', 'The clip would have too many notes.'), ...none };
  const r = run(store, label, (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = [...c.notes.filter((n) => !landing.has(noteKey(n.tick, n.pitch))), ...unique];
  }, undefined, { display: `${verb} ${plural(unique.length, 'note')}` });
  return r.changed ? { ...r, ids: unique.map((n) => n.id), added: unique.length, skipped: notes.length - unique.length } : { ...r, ...none };
}

/** Paste a clipboard (copyNotes) with its earliest note at `atTick`. Returns the new note ids. */
export function pasteNotes(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  notes: readonly Omit<Note, 'id'>[],
  atTick: number,
): CommandResult & { ids: Id[]; added: number; skipped: number } {
  const none = { ids: [] as Id[], added: 0, skipped: 0 };
  const t = target(store.getState(), trackId, slot);
  if (!isTarget(t)) return { ...t, ...none };
  if (!Array.isArray(notes)) return { ...refuse('invalid', 'The notes could not be read.'), ...none };
  if (!isFiniteNumber(atTick) || atTick < 0 || atTick >= t.len) return { ...refuse('invalid', 'That position is outside the clip.'), ...none };
  return placeNotes(store, trackId, slot, t, notes, atTick, 'notes:Paste notes', 'Paste');
}

/**
 * Copy the selected notes `offsetTicks` later (default: right after the
 * selection, rounded up to a whole 16th). Copies that would start past the
 * clip's end are left out (`skipped`). Returns the new ids.
 */
export function duplicateNotes(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  ids: readonly Id[],
  opts: { offsetTicks?: number } = {},
): CommandResult & { ids: Id[]; added: number; skipped: number } {
  const none = { ids: [] as Id[], added: 0, skipped: 0 };
  const t = target(store.getState(), trackId, slot);
  if (!isTarget(t)) return { ...t, ...none };
  const bad = noSelection(ids);
  if (bad) return { ...bad, ...none };
  const sel = selectedNotes(t.clip, ids);
  if (sel.length === 0) return { ...GONE(), ...none };
  const start = Math.min(...sel.map((n) => n.tick));
  const end = Math.max(...sel.map((n) => n.tick + n.duration));
  const offset = opts.offsetTicks ?? Math.max(TICKS_PER_STEP, Math.ceil((end - start) / TICKS_PER_STEP) * TICKS_PER_STEP);
  if (!isFiniteNumber(offset) || offset === 0) return { ...refuse('invalid', 'A copy needs a distance to move.'), ...none };
  if (start + offset < 0 || start + offset >= t.len) return { ...refuse('limit', 'There is no room for a copy there in this clip.'), ...none };
  return placeNotes(store, trackId, slot, t, copyNotes(store.getState(), trackId, slot, ids), start + offset, 'notes:Duplicate notes', 'Duplicate');
}

/* ------------------------------------------------------------------ */
/* Quantize and humanize                                               */
/* ------------------------------------------------------------------ */

export interface QuantizeOptions {
  /** The grid to pull notes towards. */
  grid: QuantizeTo;
  /** 0..1: 1 snaps onto the grid, 0.5 halves each note's distance to it (default 1). */
  strength?: number;
  /** Also pull note ends onto the grid (default false: lengths are kept). */
  ends?: boolean;
}

/**
 * Tighten timing: pull each note's start towards the nearest grid line by
 * `strength`. A note pulled onto the loop's end moves to its start. Two
 * notes of one pitch that land on the same tick become one (the louder).
 * One undo step; returns how many notes moved.
 */
export function quantizeClip(store: ProjectStore, trackId: Id, slot: number, opts: QuantizeOptions): CommandResult & { moved: number } {
  const t = target(store.getState(), trackId, slot);
  if (!isTarget(t)) return { ...t, moved: 0 };
  const g = opts && Object.prototype.hasOwnProperty.call(QUANTIZE_TO_TICKS, opts.grid) ? QUANTIZE_TO_TICKS[opts.grid] : 0;
  if (!g) return { ...refuse('invalid', 'Unknown grid.'), moved: 0 };
  const strength = opts.strength ?? 1;
  if (!isFiniteNumber(strength) || strength < 0 || strength > 1) return { ...refuse('invalid', 'Strength must be between 0 and 100%.'), moved: 0 };
  const len = t.len;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  let moved = 0;
  let touched = 0;
  const next = t.clip.notes.map((n) => {
    const snapped = Math.round(n.tick / g) * g;
    let tick = round(n.tick + (snapped - n.tick) * strength);
    if (tick >= len) tick = 0;
    let duration = n.duration;
    if (opts.ends) {
      const end = n.tick + n.duration;
      const endSnap = Math.round(end / g) * g;
      const newEnd = round(end + (endSnap - end) * strength);
      duration = clamp(newEnd - tick > 0 ? newEnd - tick : g, VALIDATION_LIMITS.minNoteTicks, VALIDATION_LIMITS.maxNoteTicks);
    }
    if (tick === n.tick && duration === n.duration) return n;
    if (tick !== n.tick) moved++;
    touched++;
    return { ...n, tick, duration };
  });
  if (touched === 0) return { changed: false, moved: 0 };
  const notes = dedupeNotes(next);
  const r = run(store, 'notes:Quantize clip', (d) => {
    draftClip(d, trackId, slot).notes = notes;
  }, undefined, { display: `Quantize ${plural(touched, 'note')} to ${opts.grid}` });
  return { ...r, moved: r.changed ? moved : 0 };
}

export interface HumanizeOptions {
  /** Largest timing shift either way, in ticks (0..48; 4 is 1/96 of a bar). */
  timingTicks: number;
  /** Largest velocity change either way, in percent of each note's level (0..100). */
  velocityPct: number;
  /** Which roll of the dice (a press counter): the same seed gives the same result. */
  seed: number;
}

/**
 * Loosen a programmed part: shift each note's start by up to ±timingTicks
 * and its level by up to ±velocityPct. Deterministic: the random numbers come
 * from subSeed(project.seed, clip id and `seed`), and the result is stored in
 * the notes, so live playback and every export play the same thing. Notes
 * stay inside the clip (the downbeat is never pushed before tick 0).
 */
export function humanizeClip(store: ProjectStore, trackId: Id, slot: number, opts: HumanizeOptions): CommandResult & { moved: number; notes: number } {
  const p = store.getState();
  const t = target(p, trackId, slot);
  if (!isTarget(t)) return { ...t, moved: 0, notes: 0 };
  if (!opts || !isFiniteNumber(opts.timingTicks) || !isFiniteNumber(opts.velocityPct) || !isFiniteNumber(opts.seed)) return { ...refuse('invalid', 'Humanize needs a timing amount, a velocity amount and a seed.'), moved: 0, notes: 0 };
  const timing = clamp(opts.timingTicks, 0, 48);
  const vel = clamp(opts.velocityPct, 0, 100) / 100;
  if (t.clip.notes.length === 0) return { ...refuse('empty', 'Add some notes first.'), moved: 0, notes: 0 };
  const rng = new Rng(subSeed(p.seed >>> 0, `humanize:${t.clip.id}:${Math.trunc(opts.seed) >>> 0}`));
  let moved = 0;
  let touched = 0;
  const next = t.clip.notes.map((n) => {
    const dt = Math.round(rng.range(-timing, timing));
    const dv = rng.range(-vel, vel);
    const tick = clamp(n.tick + dt, 0, t.len - 1);
    const velocity = Math.round(clamp(n.velocity * (1 + dv), 0.02, 1) * 1000) / 1000;
    if (tick === n.tick && velocity === n.velocity) return n;
    if (tick !== n.tick) moved++;
    touched++;
    return { ...n, tick, velocity };
  });
  if (touched === 0) return { changed: false, moved: 0, notes: 0 };
  const notes = dedupeNotes(next);
  const r = run(store, 'notes:Humanize clip', (d) => {
    draftClip(d, trackId, slot).notes = notes;
  }, undefined, { display: `Humanize ${plural(notes.length, 'note')}` });
  return r.changed ? { ...r, moved, notes: touched } : { ...r, moved: 0, notes: 0 };
}

/* ------------------------------------------------------------------ */
/* Drum sounds (one row of the step grid)                              */
/* ------------------------------------------------------------------ */

function stepCount(clip: Clip | null): number {
  return (clip ? clip.bars : MAX_CLIP_BARS) * STEPS_PER_BAR;
}

/**
 * Paint a drag across a sound's steps: `on` adds a one-step hit on every
 * listed step that has none; off removes the sound's hits on them. Calls
 * that share a `gesture` id (one drag) form one undo step. An empty slot
 * gets a clip long enough when painting on.
 */
export function paintSteps(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  pitch: number,
  steps: readonly number[],
  on: boolean,
  gesture?: string,
  opts: { velocity?: number } = {},
): CommandResult & { painted: number } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return { ...NOT_FOUND('part'), painted: 0 };
  if (!isSlot(slot, t)) return { ...refuse('invalid', 'There is no clip slot there.'), painted: 0 };
  if (!validPitch(t.instrument.kind, pitch)) return { ...refuse('invalid', 'That pitch cannot be played by this part.'), painted: 0 };
  const velocity = opts.velocity ?? DEFAULT_STEP_VELOCITY;
  if (!isFiniteNumber(velocity)) return { ...refuse('invalid', 'Velocity must be a number.'), painted: 0 };
  const clip = t.clips[slot];
  const max = stepCount(clip);
  if (!Array.isArray(steps) || steps.some((s) => !Number.isInteger(s) || s < 0 || s >= max)) return { ...refuse('invalid', 'That step is outside the clip.'), painted: 0 };
  const wanted = [...new Set(steps)].sort((a, b) => a - b);
  const display = { display: on ? 'Paint steps' : 'Erase steps' };
  if (on) {
    const add = wanted.filter((s) => !clip || notesAtStep(clip, s, pitch).length === 0);
    if (add.length === 0) return { changed: false, painted: 0 };
    if ((clip?.notes.length ?? 0) + add.length > MAX_NOTES) return { ...refuse('limit', 'This clip is full.'), painted: 0 };
    const fresh = add.map((s): Note => ({ id: uid('n'), tick: s * TICKS_PER_STEP, pitch, velocity: clamp(velocity, 0, 1), duration: TICKS_PER_STEP }));
    const r = clip
      ? run(store, 'notes:Paint steps', (d) => {
          draftClip(d, trackId, slot).notes.push(...fresh);
        }, gesture, display)
      : run(store, 'notes:Paint steps', (d) => {
          const bars = clamp(Math.ceil((add[add.length - 1] + 1) / STEPS_PER_BAR), 1, MAX_CLIP_BARS) as ClipBars;
          draftTrack(d, trackId).clips[slot] = { id: uid('clip'), name: defaultClipName(p, slot), bars, notes: fresh };
        }, gesture, display);
    return { ...r, painted: r.changed ? add.length : 0 };
  }
  if (!clip) return { changed: false, painted: 0 };
  const off = new Set(wanted);
  const gone = clip.notes.filter((n) => n.pitch === pitch && off.has(stepOfTick(n.tick)));
  if (gone.length === 0) return { changed: false, painted: 0 };
  const goneIds = new Set(gone.map((n) => n.id));
  const painted = new Set(gone.map((n) => stepOfTick(n.tick))).size;
  const r = run(store, 'notes:Paint steps', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = c.notes.filter((n) => !goneIds.has(n.id));
  }, gesture, display);
  return { ...r, painted: r.changed ? painted : 0 };
}

const FILL_WORDS: Record<1 | 2 | 4, string> = { 1: '16th', 2: '8th', 4: 'beat' };

/**
 * Fill a sound across the whole clip: a hit every `every` steps (4 = every
 * beat, 2 = every 8th, 1 = every 16th) where it has none. Hits it already
 * has stay as they are. An empty slot gets a one-bar clip.
 */
export function fillSound(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  pitch: number,
  every: 1 | 2 | 4,
  opts: { velocity?: number } = {},
): CommandResult & { added: number } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return { ...NOT_FOUND('part'), added: 0 };
  if (!isSlot(slot, t)) return { ...refuse('invalid', 'There is no clip slot there.'), added: 0 };
  if (!validPitch(t.instrument.kind, pitch)) return { ...refuse('invalid', 'That pitch cannot be played by this part.'), added: 0 };
  if (every !== 1 && every !== 2 && every !== 4) return { ...refuse('invalid', 'Fill every beat, 8th or 16th.'), added: 0 };
  const velocity = opts.velocity ?? DEFAULT_STEP_VELOCITY;
  if (!isFiniteNumber(velocity)) return { ...refuse('invalid', 'Velocity must be a number.'), added: 0 };
  const clip = t.clips[slot];
  const total = (clip ? clip.bars : 1) * STEPS_PER_BAR;
  const add: number[] = [];
  for (let s = 0; s < total; s += every) if (!clip || notesAtStep(clip, s, pitch).length === 0) add.push(s);
  if (add.length === 0) return { changed: false, added: 0 };
  if ((clip?.notes.length ?? 0) + add.length > MAX_NOTES) return { ...refuse('limit', 'This clip is full.'), added: 0 };
  const fresh = add.map((s): Note => ({ id: uid('n'), tick: s * TICKS_PER_STEP, pitch, velocity: clamp(velocity, 0, 1), duration: TICKS_PER_STEP }));
  const display = { display: `Fill every ${FILL_WORDS[every]}` };
  const r = clip
    ? run(store, 'notes:Fill sound', (d) => {
        draftClip(d, trackId, slot).notes.push(...fresh);
      }, undefined, display)
    : run(store, 'notes:Fill sound', (d) => {
        draftTrack(d, trackId).clips[slot] = { id: uid('clip'), name: defaultClipName(p, slot), bars: 1, notes: fresh };
      }, undefined, display);
  return { ...r, added: r.changed ? add.length : 0 };
}

/**
 * Shift every hit of one sound a step later (+1) or earlier (-1). With
 * `wrap` (default) hits leaving one end come back in at the other, so the
 * pattern rotates; without it they are removed (`dropped`).
 */
export function shiftSound(store: ProjectStore, trackId: Id, slot: number, pitch: number, dir: 1 | -1, wrap = true): CommandResult & { moved: number; dropped: number } {
  const none = { moved: 0, dropped: 0 };
  const t = target(store.getState(), trackId, slot);
  if (!isTarget(t)) return { ...t, ...none };
  if (dir !== 1 && dir !== -1) return { ...refuse('invalid', 'Shift by one step, later or earlier.'), ...none };
  const row = t.clip.notes.filter((n) => n.pitch === pitch);
  if (row.length === 0) return { ...refuse('empty', 'This sound has no hits in the clip.'), ...none };
  const len = t.len;
  const to = new Map<Id, number | null>();
  for (const n of row) {
    const tick = n.tick + dir * TICKS_PER_STEP;
    to.set(n.id, tick >= 0 && tick < len ? tick : wrap ? ((tick % len) + len) % len : null);
  }
  const dropped = [...to.values()].filter((v) => v === null).length;
  const r = run(store, 'notes:Shift sound', (d) => {
    const c = draftClip(d, trackId, slot);
    c.notes = c.notes.filter((n) => to.get(n.id) !== null);
    for (const n of c.notes) {
      const v = to.get(n.id);
      if (v !== undefined && v !== null) n.tick = v;
    }
  }, undefined, { display: dir > 0 ? 'Shift sound later' : 'Shift sound earlier' });
  return r.changed ? { ...r, moved: row.length - dropped, dropped } : { ...r, ...none };
}

/* ------------------------------------------------------------------ */
/* Keys and scale steps                                                */
/* ------------------------------------------------------------------ */

/**
 * Transpose a melodic clip by scale steps of the project's key (Musical
 * Assist's transpose): +1 moves every scale note to the next scale note, ±7
 * is an octave in a seven-note scale (stepsPerOctave(scale) in general).
 * Notes outside the key move as far as their nearest scale note. Notes that
 * would leave 0..127 fold back an octave. Drums are refused.
 */
export function transposeClipInScale(store: ProjectStore, trackId: Id, slot: number, steps: number): CommandResult & { moved: number } {
  const p = store.getState();
  const t = target(p, trackId, slot);
  if (!isTarget(t)) return { ...t, moved: 0 };
  if (t.track.instrument.kind === 'drums') return { ...refuse('invalid', 'Drum clips cannot be transposed.'), moved: 0 };
  if (!Number.isInteger(steps) || Math.abs(steps) > MAX_TRANSPOSE_STEPS) return { ...refuse('invalid', 'Transpose by a whole number of steps.'), moved: 0 };
  if (steps === 0 || t.clip.notes.length === 0) return { changed: false, moved: 0 };
  const key: MusicalKey = { root: p.root, scale: p.scale };
  const [lo, hi] = pitchRangeFor(t.track.instrument.kind);
  let moved = 0;
  const next = t.clip.notes.map((n) => {
    const pitch = foldPitch(scaleShift(n.pitch, steps, key), lo, hi);
    if (pitch === n.pitch) return n;
    moved++;
    return { ...n, pitch };
  });
  if (moved === 0) return { changed: false, moved: 0 };
  const notes = dedupeNotes(next);
  const r = run(store, 'notes:Transpose clip', (d) => {
    draftClip(d, trackId, slot).notes = notes;
  }, undefined, { display: `Transpose clip ${steps > 0 ? 'up' : 'down'} ${plural(Math.abs(steps), 'scale step')}` });
  return { ...r, moved: r.changed ? moved : 0 };
}

/* ------------------------------------------------------------------ */
/* Progressions                                                        */
/* ------------------------------------------------------------------ */

export type ProgressionRhythm = 'held' | 'stabs' | 'offbeats';
const RHYTHMS: readonly ProgressionRhythm[] = ['held', 'stabs', 'offbeats'];

export interface ProgressionOptions {
  /** PROGRESSIONS[].id from music/chords. */
  progressionId: string;
  /** held: one chord per change, held; stabs: a short chord on every beat; offbeats: short chords on the off-beat 8ths. */
  rhythm: ProgressionRhythm;
  /** Clip length, 1..MAX_CLIP_BARS. Four bars give one chord per bar; longer clips repeat the loop, shorter ones change chords faster. */
  bars: number;
  /** 3 = triads, 4 = seventh chords. */
  size: 3 | 4;
}

/** Middle of the register a part plays in: the median of its notes, else a default for its role. */
function partCentre(track: Track): number {
  const pitches = track.clips.flatMap((c) => (c ? c.notes.map((n) => n.pitch) : [])).sort((a, b) => a - b);
  if (track.instrument.kind === 'bass') {
    return pitches.length ? clamp(pitches[Math.floor(pitches.length / 2)], 28, 52) : 40;
  }
  if (pitches.length) return clamp(pitches[Math.floor(pitches.length / 2)], 48, 84);
  return track.role === 'lead' ? 70 : track.role === 'texture' ? 66 : 62;
}

/** Hits of one chord change: [offset in ticks, length in ticks, velocity]. */
function rhythmHits(rhythm: ProgressionRhythm, span: number): [number, number, number][] {
  if (rhythm === 'held') return [[0, span, 0.72]];
  const hits: [number, number, number][] = [];
  for (let beat = 0; beat < span; beat += TICKS_PER_BEAT) {
    if (rhythm === 'stabs') hits.push([beat, TICKS_PER_STEP * 2, beat === 0 ? 0.86 : 0.74]);
    else hits.push([beat + TICKS_PER_BEAT / 2, Math.round(TICKS_PER_STEP * 1.5), 0.78]);
  }
  return hits;
}

/**
 * Write a chord progression into a clip ("Write a progression…"): the chords
 * of PROGRESSIONS[progressionId] in the project's key (music/chords
 * resolveProgression), voice-led so each change moves as little as possible,
 * around the register the part already plays in. A bass part (one note at a
 * time) gets each chord's root instead. One chord per bar for four bars or
 * more (the loop repeats), faster changes in shorter clips. An empty slot
 * gets a new clip named after the progression; an existing clip gets the new
 * notes and length and keeps its name. Drum and sampler parts are refused
 * with a reason. Deterministic, made from fixed rules (no AI).
 */
export function createProgressionClip(
  store: ProjectStore,
  trackId: Id,
  slot: number,
  opts: ProgressionOptions,
): CommandResult & { clipId?: Id; notes: number; chords: string[] } {
  const none = { notes: 0, chords: [] as string[] };
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return { ...NOT_FOUND('part'), ...none };
  if (t.instrument.kind === 'drums') return { ...refuse('invalid', 'Drum parts play sounds, not chords: choose a melodic part for a progression.'), ...none };
  if (t.instrument.kind === 'sampler') return { ...refuse('invalid', 'Sampler parts play a recording, which keeps its own pitch: choose a synth part for a progression.'), ...none };
  if (!isSlot(slot, t)) return { ...refuse('invalid', 'There is no clip slot there.'), ...none };
  const prog = opts ? getProgression(opts.progressionId) : undefined;
  if (!prog) return { ...refuse('invalid', 'Unknown progression.'), ...none };
  if (!RHYTHMS.includes(opts.rhythm)) return { ...refuse('invalid', 'Choose held, stabs or off-beats.'), ...none };
  if (!Number.isInteger(opts.bars) || opts.bars < 1 || opts.bars > MAX_CLIP_BARS) return { ...refuse('invalid', `Clips are 1 to ${MAX_CLIP_BARS} bars.`), ...none };
  if (opts.size !== 3 && opts.size !== 4) return { ...refuse('invalid', 'Choose three-note or four-note chords.'), ...none };

  const resolved = resolveProgression(p.root, p.scale, prog, opts.size);
  const bars = opts.bars as ClipBars;
  const len = bars * TICKS_PER_BAR;
  // Four bars or more: one chord per bar. Fewer: the four changes share the clip (2 bars: two beats each).
  const span = bars >= 4 ? TICKS_PER_BAR : bars * TICKS_PER_BEAT;
  const centre = partCentre(t);
  const bass = t.instrument.kind === 'bass';
  const voicings: number[][] = bass ? [] : voiceLeadLoop(resolved.chords, centre - 12, centre + 12);
  // A bass plays each root, every one in the octave nearest the one before (the first nearest the part's centre).
  const roots: number[] = [];
  if (bass) {
    for (const chord of resolved.chords) {
      const prev = roots.length ? roots[roots.length - 1] : centre;
      const pc = pitchClass(chord[0]);
      let best = -1;
      for (let m = 24; m <= 60; m++) if (pitchClass(m) === pc && (best < 0 || Math.abs(m - prev) < Math.abs(best - prev))) best = m;
      roots.push(best);
    }
  }
  const notes: Note[] = [];
  for (let k = 0; k * span < len; k++) {
    const i = k % resolved.chords.length;
    const pitches = bass ? [roots[i]] : voicings[i];
    for (const [offset, dur, vel] of rhythmHits(opts.rhythm, span)) {
      const tick = k * span + offset;
      if (tick >= len) continue;
      for (const pitch of pitches) notes.push({ id: uid('n'), tick, pitch, velocity: vel, duration: Math.min(dur, len - tick) });
    }
  }
  const display = { display: `Write the ${prog.name} progression` };
  const existing = t.clips[slot];
  const clipId = existing?.id ?? uid('clip');
  const r = existing
    ? run(store, 'notes:Write progression', (d) => {
        const c = draftClip(d, trackId, slot);
        c.bars = bars;
        c.notes = notes;
        delete c.variation;
      }, undefined, display)
    : run(store, 'notes:Write progression', (d) => {
        draftTrack(d, trackId).clips[slot] = { id: clipId, name: prog.name, bars, notes };
      }, undefined, display);
  return r.changed ? { ...r, clipId, notes: notes.length, chords: resolved.names } : { ...r, ...none };
}

/** The chord a chord pad plays: chordAt in the project's key around a part's register (re-exported for views next to the commands). */
export function chordForPad(project: Project, trackId: Id, degree: number, size: 3 | 4 = 3, from?: readonly number[]): number[] {
  const t = findTrack(project, trackId);
  const near = t && t.instrument.kind !== 'drums' ? partCentre(t) : 60;
  return chordAt(project.root, project.scale, degree, { size, near, ...(from ? { from } : {}) });
}
