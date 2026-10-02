/**
 * Piano-roll selection commands (PLAY-08, capability-12): move across bars,
 * delete, per-note velocity, transpose, duplicate, copy and paste, nudge and
 * finer grids. Each is one undo step and refused during a performance take.
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/factory';
import type { Note } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { createClip } from '../../src/state/commands/clips';
import {
  GRID_TICKS,
  NUDGE_TICKS,
  addNote,
  copyNotes,
  deleteNotes,
  duplicateNotes,
  moveNote,
  moveNotes,
  pasteNotes,
  setNotesVelocity,
  transposeNotes,
} from '../../src/state/commands/notes';

const CHORDS = 't4';

/** A 2-bar Chords clip: a four-note chord on step 4 of bar 1, two notes later in bar 1 and one in bar 2. */
function setup() {
  const p = createProject({ now: 0 });
  p.root = 7;
  p.scale = 'dorian';
  const store = new ProjectStore(p);
  createClip(store, CHORDS, 0, 2, 'Chords');
  const rows: [string, number, number][] = [
    ['c1', 72, 58],
    ['c2', 72, 62],
    ['c3', 72, 65],
    ['c4', 72, 69],
    ['a', 192, 67],
    ['b', 240, 70],
    ['z', 400, 62],
  ];
  store.apply('notes:Write', (d) => {
    d.tracks[3].clips[0]!.notes = rows.map(([id, tick, pitch]) => ({ id, tick, pitch, velocity: 0.8, duration: 24 }));
  });
  return store;
}

const notes = (store: ProjectStore) => store.getState().tracks[3].clips[0]!.notes;
const byId = (store: ProjectStore, id: string) => notes(store).find((n) => n.id === id);
const valid = (store: ProjectStore) => {
  const r = validateProject(JSON.parse(JSON.stringify(store.getState())));
  return r.ok && r.warnings.length === 0;
};

describe('moving a selection', () => {
  it('moves two notes from bar 1 into bar 2 in one undo step', () => {
    const store = setup();
    const before = notes(store);
    const r = moveNotes(store, CHORDS, 0, ['a', 'b'], 384, 0);
    expect(r).toMatchObject({ changed: true, moved: 2, dTick: 384, dPitch: 0 });
    expect(byId(store, 'a')!.tick).toBe(576);
    expect(byId(store, 'b')!.tick).toBe(624);
    expect(byId(store, 'z')!.tick).toBe(400);
    expect(store.undoLabel()).toBe('Move 2 notes');
    expect(valid(store)).toBe(true);
    store.undo();
    expect(notes(store)).toEqual(before);
  });

  it('stops the selection at the clip end and the part range, keeping its shape', () => {
    const store = setup();
    const r = moveNotes(store, CHORDS, 0, ['a', 'b'], 10_000, 0);
    expect(r).toMatchObject({ changed: true, dTick: 767 - 240 });
    expect(byId(store, 'b')!.tick).toBe(767);
    expect(byId(store, 'b')!.tick - byId(store, 'a')!.tick).toBe(48);
    // Already at the edge: refused with a reason, nothing changes.
    const at = store.getState();
    expect(moveNotes(store, CHORDS, 0, ['a', 'b'], 24, 0)).toMatchObject({ changed: false, reason: 'limit' });
    expect(store.getState()).toBe(at);
    // Pitch stops at 127 for the highest note.
    expect(moveNotes(store, CHORDS, 0, ['c1', 'c4'], 0, 100)).toMatchObject({ changed: true, dPitch: 127 - 69 });
    expect(byId(store, 'c4')!.pitch).toBe(127);
    expect(byId(store, 'c1')!.pitch).toBe(58 + 58);
  });

  it('moves earlier and into the first tick, and nudges by 1/96 of a bar', () => {
    const store = setup();
    expect(NUDGE_TICKS).toBe(4);
    expect(moveNotes(store, CHORDS, 0, ['z'], -NUDGE_TICKS, 0)).toMatchObject({ changed: true, dTick: -4 });
    expect(byId(store, 'z')!.tick).toBe(396);
    expect(moveNotes(store, CHORDS, 0, ['a', 'z'], -1000, 0)).toMatchObject({ changed: true, dTick: -192 });
    expect(byId(store, 'a')!.tick).toBe(0);
  });

  it('replaces a note it lands on, but a drag (gesture) refuses instead of deleting notes passed over', () => {
    const store = setup();
    // 'a' (192, 67) dragged onto 'b' (240, 70): refused while dragging.
    const at = store.getState();
    expect(moveNotes(store, CHORDS, 0, ['a'], 48, 3, 'drag-1')).toMatchObject({ changed: false, reason: 'occupied' });
    expect(store.getState()).toBe(at);
    // A single move replaces it.
    expect(moveNotes(store, CHORDS, 0, ['a'], 48, 3)).toMatchObject({ changed: true, moved: 1 });
    expect(byId(store, 'b')).toBeUndefined();
    expect(notes(store)).toHaveLength(6);
  });

  it('joins a drag into one undo step', () => {
    const store = setup();
    const before = notes(store);
    for (let i = 0; i < 5; i++) moveNotes(store, CHORDS, 0, ['z'], 24, 0, 'drag-2');
    expect(byId(store, 'z')!.tick).toBe(400 + 120);
    store.undo();
    expect(notes(store)).toEqual(before);
  });

  it('refuses unknown notes, bad numbers and a slot the part does not have, changing nothing', () => {
    const store = setup();
    const at = store.getState();
    expect(moveNotes(store, CHORDS, 0, ['nope'], 24, 0)).toMatchObject({ changed: false, reason: 'not-found' });
    expect(moveNotes(store, CHORDS, 0, ['a'], Number.NaN, 0)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(moveNotes(store, CHORDS, 7, ['a'], 24, 0)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(moveNotes(store, CHORDS, 0, 'a' as never, 24, 0)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState()).toBe(at);
    // Stale ids are skipped while the rest move.
    expect(moveNotes(store, CHORDS, 0, ['gone', 'z'], 24, 0)).toMatchObject({ changed: true, moved: 1 });
  });
});

describe('deleting, velocity and transpose', () => {
  it('deletes the selection in one undo step', () => {
    const store = setup();
    const r = deleteNotes(store, CHORDS, 0, ['a', 'b', 'a']);
    expect(r).toMatchObject({ changed: true, deleted: 2 });
    expect(notes(store).map((n) => n.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'z']);
    expect(store.undoLabel()).toBe('Delete 2 notes');
    store.undo();
    expect(notes(store)).toHaveLength(7);
  });

  it('changes one chord voice’s velocity alone, or a selection by a delta', () => {
    const store = setup();
    expect(setNotesVelocity(store, CHORDS, 0, ['c4'], 0.4)).toMatchObject({ changed: true, notes: 1 });
    expect(notes(store).filter((n) => n.tick === 72).map((n) => n.velocity)).toEqual([0.8, 0.8, 0.8, 0.4]);
    expect(store.undoLabel()).toBe('Change velocity of 1 note');
    expect(setNotesVelocity(store, CHORDS, 0, ['c3', 'c4'], { delta: 0.3 })).toMatchObject({ changed: true, notes: 2 });
    expect(byId(store, 'c3')!.velocity).toBe(1);
    expect(byId(store, 'c4')!.velocity).toBeCloseTo(0.7);
    const at = store.getState();
    expect(setNotesVelocity(store, CHORDS, 0, ['c3'], { delta: Number.NaN })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(setNotesVelocity(store, CHORDS, 0, ['c3'], 1)).toMatchObject({ changed: false });
    expect(store.getState()).toBe(at);
    store.undo();
    store.undo();
    expect(notes(store).every((n) => n.velocity === 0.8)).toBe(true);
  });

  it('transposes a selection by semitones or by steps of the key', () => {
    const store = setup();
    const key = { root: 7, scale: 'dorian' as const };
    // B♭ D F A up one scale step in G Dorian: C E G B♭.
    expect(transposeNotes(store, CHORDS, 0, ['c1', 'c2', 'c3', 'c4'], 1, { inScale: key })).toMatchObject({ changed: true, moved: 4 });
    expect(notes(store).filter((n) => n.tick === 72).map((n) => n.pitch)).toEqual([60, 64, 67, 70]);
    expect(store.undoLabel()).toBe('Transpose 4 notes up 1 scale step');
    // Seven scale steps are an octave.
    transposeNotes(store, CHORDS, 0, ['c1'], -7, { inScale: key });
    expect(byId(store, 'c1')!.pitch).toBe(48);
    // Semitones keep the shape.
    expect(transposeNotes(store, CHORDS, 0, ['a', 'b'], -2)).toMatchObject({ changed: true, moved: 2 });
    expect([byId(store, 'a')!.pitch, byId(store, 'b')!.pitch]).toEqual([65, 68]);
    // Drums refuse: their notes are sounds.
    const drums = new ProjectStore(createProject({ now: 0 }));
    createClip(drums, 't1', 0, 1);
    const id = addNote(drums, 't1', 0, { tick: 0, pitch: 2, velocity: 0.8, duration: 24 }).noteId!;
    expect(transposeNotes(drums, 't1', 0, [id], 1)).toMatchObject({ changed: false, reason: 'invalid' });
  });
});

describe('duplicate, copy and paste', () => {
  it('duplicates a selection right after itself, returning the new ids', () => {
    const store = setup();
    const r = duplicateNotes(store, CHORDS, 0, ['a', 'b']);
    expect(r).toMatchObject({ changed: true, added: 2, skipped: 0 });
    expect(r.ids).toHaveLength(2);
    const copies = r.ids.map((id) => byId(store, id)!);
    // Selection spans 192..264, so the copy starts 72 later.
    expect(copies.map((n) => [n.tick, n.pitch])).toEqual([
      [264, 67],
      [312, 70],
    ]);
    expect(store.undoLabel()).toBe('Duplicate 2 notes');
    expect(valid(store)).toBe(true);
    // With an offset past the end: refused, nothing changes.
    const at = store.getState();
    expect(duplicateNotes(store, CHORDS, 0, ['z'], { offsetTicks: 768 })).toMatchObject({ changed: false, reason: 'limit' });
    expect(store.getState()).toBe(at);
  });

  it('copies notes relative to the earliest and pastes them anywhere in the clip, in one undo step', () => {
    const store = setup();
    const clip = copyNotes(store.getState(), CHORDS, 0, ['c1', 'c2', 'a']);
    expect(clip.map((n) => n.tick)).toEqual([0, 0, 120]);
    const r = pasteNotes(store, CHORDS, 0, clip, 384 + 96);
    expect(r).toMatchObject({ changed: true, added: 3, skipped: 0 });
    expect(r.ids).toHaveLength(3);
    expect(r.ids.map((id) => byId(store, id)!.tick)).toEqual([480, 480, 600]);
    expect(store.undoLabel()).toBe('Paste 3 notes');
    store.undo();
    expect(notes(store)).toHaveLength(7);
    // Notes that would start past the end are left out and counted.
    const late = pasteNotes(store, CHORDS, 0, clip, 700);
    expect(late).toMatchObject({ changed: true, added: 2, skipped: 1 });
    // A position outside the clip is refused.
    expect(pasteNotes(store, CHORDS, 0, clip, 768)).toMatchObject({ changed: false, reason: 'invalid' });
    // Melodic pitches pasted onto drums do not fit.
    const drums = new ProjectStore(createProject({ now: 0 }));
    createClip(drums, 't1', 0, 1);
    expect(pasteNotes(drums, 't1', 0, clip, 0)).toMatchObject({ changed: false, reason: 'limit' });
  });
});

describe('finer grids', () => {
  it('exports the grid sizes and lets notes sit on any tick', () => {
    expect(GRID_TICKS).toEqual({ '1/16': 24, '1/32': 12, '1/8T': 32, '1/16T': 16 });
    const store = setup();
    const id = addNote(store, CHORDS, 0, { tick: GRID_TICKS['1/8T'] * 5, pitch: 62, velocity: 0.7, duration: GRID_TICKS['1/8T'] }).noteId!;
    expect(byId(store, id)!.tick).toBe(160);
    expect(moveNote(store, CHORDS, 0, id, { tick: GRID_TICKS['1/32'] * 3 }).changed).toBe(true);
    expect(byId(store, id)!.tick).toBe(36);
    expect(moveNote(store, CHORDS, 0, id, { tick: 37.5 }).changed).toBe(true);
    expect(byId(store, id)!.tick).toBe(37.5);
    expect(valid(store)).toBe(true);
  });
});

describe('during a performance take', () => {
  it('refuses every selection edit like other clip edits', () => {
    const store = setup();
    store.setLock('Recording a performance', (label) => label.startsWith('module:'));
    const at = store.getState();
    const results = [
      moveNotes(store, CHORDS, 0, ['a'], 24, 0),
      deleteNotes(store, CHORDS, 0, ['a']),
      setNotesVelocity(store, CHORDS, 0, ['a'], 0.2),
      transposeNotes(store, CHORDS, 0, ['a'], 1),
      duplicateNotes(store, CHORDS, 0, ['a']),
      pasteNotes(store, CHORDS, 0, [{ tick: 0, pitch: 60, velocity: 1, duration: 24 } as Omit<Note, 'id'>], 0),
    ];
    for (const r of results) expect(r).toMatchObject({ changed: false, refused: 'Recording a performance' });
    expect(results.map((r) => ('moved' in r ? r.moved : 'deleted' in r ? r.deleted : 'notes' in r ? r.notes : r.added))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(store.getState()).toBe(at);
  });
});
