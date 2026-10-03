/**
 * The Steps editor's pure model: grids and columns, the cells a note covers, and the previews
 * a drag or a menu shows, checked against the commands that then make the edit (what the roll
 * shows while dragging is what the drop does; the Tighten count is what quantize moves).
 */
import { describe, expect, it } from 'vitest';
import {
  cellColumn,
  cellLabel,
  clampMovePitch,
  clampMoveTicks,
  gridSpec,
  isTap,
  notesInBox,
  pageNoteViews,
  plannedPitches,
  previewMovedNotes,
  quantizeMoves,
  scaleShiftPitch,
  scaleStepsBetween,
  touchIntent,
  velocityVoices,
} from '../../src/app/views/steps/model';
import { createProject } from '../../src/project/factory';
import type { Note, ScaleId } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { createClip } from '../../src/state/commands/clips';
import { GRID_TICKS, addNote, moveNotes, quantizeClip, transposeNotes } from '../../src/state/commands/notes';
import { Rng } from '../../src/project/rng';

const T = 't4';

function store(notes: [number, number, number?][], key: { root: number; scale: ScaleId } = { root: 7, scale: 'dorian' }, bars: 1 | 2 | 4 | 8 = 2) {
  const p = createProject({ now: 0 });
  p.root = key.root;
  p.scale = key.scale;
  const s = new ProjectStore(p);
  createClip(s, T, 0, bars, 'Test');
  for (const [tick, pitch, duration] of notes) addNote(s, T, 0, { tick, pitch, velocity: 0.8, duration: duration ?? 24 });
  return s;
}
const clipNotes = (s: ProjectStore): Note[] => s.getState().tracks.find((t) => t.id === T)!.clips[0]!.notes;

describe('grids and columns', () => {
  it('each grid has its cells a bar and a beat', () => {
    expect(gridSpec('1/16')).toEqual({ grid: '1/16', ticks: 24, perBeat: 4, cells: 16 });
    expect(gridSpec('1/32')).toEqual({ grid: '1/32', ticks: 12, perBeat: 8, cells: 32 });
    expect(gridSpec('1/8T')).toEqual({ grid: '1/8T', ticks: 32, perBeat: 3, cells: 12 });
    expect(gridSpec('1/16T')).toEqual({ grid: '1/16T', ticks: 16, perBeat: 6, cells: 24 });
    for (const g of ['1/16', '1/32', '1/8T', '1/16T'] as const) expect(gridSpec(g).ticks).toBe(GRID_TICKS[g]);
  });

  it('columns leave a spacer track between beats', () => {
    // Label column 1; 1/16: steps 0-3 in 2-5, a spacer at 6, step 4 at 7.
    expect([0, 3, 4, 15].map((c) => cellColumn(c, 4))).toEqual([2, 5, 7, 20]);
    // 1/8T: three a beat.
    expect([0, 2, 3, 11].map((c) => cellColumn(c, 3))).toEqual([2, 4, 6, 16]);
  });

  it('the ruler counts 16ths on the 1/32 grid and cells on the others', () => {
    const g32 = gridSpec('1/32');
    expect([0, 1, 2, 3, 8].map((c) => cellLabel(c, g32))).toEqual([
      { text: '1', beat: true },
      { text: '·', beat: false },
      { text: '2', beat: false },
      { text: '·', beat: false },
      { text: '5', beat: true },
    ]);
    expect(cellLabel(3, gridSpec('1/8T'))).toEqual({ text: '4', beat: true });
  });

  it('a note covers the cells of the shown grid (a 32nd at tick 12 is the second 1/32 cell)', () => {
    const notes: Note[] = [{ id: 'a', tick: 12, pitch: 60, velocity: 1, duration: 12 }];
    expect(pageNoteViews(notes, 0, 384, 12)[0]).toMatchObject({ first: 1, last: 1, fillFrom: 0, fillTo: 1 });
    // On the 1/16 grid it fills the second half of the first step.
    expect(pageNoteViews(notes, 0, 384)[0]).toMatchObject({ first: 0, last: 0, fillFrom: 0.5, fillTo: 1 });
  });

  it('velocity voices: one per note starting in a cell, lowest first, selected marked', () => {
    const notes: Note[] = [
      { id: 'top', tick: 72, pitch: 69, velocity: 0.8, duration: 19 },
      { id: 'low', tick: 72, pitch: 58, velocity: 0.7, duration: 19 },
      { id: 'next', tick: 400, pitch: 60, velocity: 1, duration: 19 },
    ];
    const cols = velocityVoices(notes, 0, gridSpec('1/16'), new Set(['top']));
    expect(cols[3].map((v) => [v.id, v.selected])).toEqual([
      ['low', false],
      ['top', true],
    ]);
    expect(cols.flat()).toHaveLength(2);
  });
});

describe('drag previews match the commands', () => {
  it('scale steps between rows, as Musical Assist moves notes', () => {
    const g = { root: 7, scale: 'dorian' as ScaleId };
    expect(scaleStepsBetween(55, 57, g)).toBe(1); // G3 -> A3
    expect(scaleStepsBetween(67, 79, g)).toBe(7); // an octave
    expect(scaleStepsBetween(67, 65, g)).toBe(-1); // G4 -> F4
    expect(scaleStepsBetween(60, 72, { root: 0, scale: 'minorPentatonic' })).toBe(5);
  });

  it('a scale-step preview lands where transposeNotes puts each note (random chords, several keys)', () => {
    const rng = new Rng(7);
    const keys: { root: number; scale: ScaleId }[] = [
      { root: 7, scale: 'dorian' },
      { root: 9, scale: 'minor' },
      { root: 2, scale: 'majorPentatonic' },
      { root: 4, scale: 'harmonicMinor' },
    ];
    for (const key of keys) {
      for (let trial = 0; trial < 20; trial++) {
        const pitches = [...new Set(Array.from({ length: 4 }, () => 40 + Math.floor(rng.range(0, 40))))];
        const s = store(pitches.map((p) => [96, p]), key);
        const notes = clipNotes(s);
        const steps = Math.round(rng.range(-9, 9)) || 1;
        const want = plannedPitches(notes, { dTick: 0, dPitch: 0, steps, key });
        transposeNotes(s, T, 0, notes.map((n) => n.id), steps, { inScale: key, collide: 'replace' });
        for (const n of clipNotes(s)) expect(n.pitch, `${key.scale} ${steps}`).toBe(want.get(n.id));
        for (const n of notes) expect(scaleShiftPitch(n.pitch, steps, key)).toBe(want.get(n.id));
      }
    }
  });

  it('a time and semitone preview is clamped like moveNotes and lands where it puts the notes', () => {
    const s = store([
      [24, 60],
      [700, 64],
      [300, 120],
    ]);
    const notes = clipNotes(s);
    const ids = new Set(notes.map((n) => n.id));
    const dTick = clampMoveTicks(notes, 500, 768);
    const dPitch = clampMovePitch(notes, 12);
    expect(dTick).toBe(767 - 700);
    // On a grid the move is held to whole steps: never one tick before the end, off the grid.
    expect(clampMoveTicks(notes, 500, 768, 24)).toBe(48);
    expect(clampMoveTicks(notes, -500, 768, 24)).toBe(-24);
    expect(clampMoveTicks([{ id: 'x', tick: 1512, pitch: 60, velocity: 1, duration: 24 }], 24, 1536, 24)).toBe(0);
    expect(dPitch).toBe(7);
    const preview = previewMovedNotes(notes, ids, { dTick, dPitch, steps: 0, key: null });
    const r = moveNotes(s, T, 0, [...ids], 500, 12);
    expect(r.dTick).toBe(dTick);
    expect(r.dPitch).toBe(dPitch);
    const after = new Map(clipNotes(s).map((n) => [n.id, n]));
    for (const p of preview) expect(after.get(p.id)).toMatchObject({ tick: p.tick, pitch: p.pitch });
  });

  it('a selection box takes the notes that sound inside it on its rows', () => {
    const notes: Note[] = [
      { id: 'in', tick: 72, pitch: 62, velocity: 1, duration: 19 },
      { id: 'held', tick: 0, pitch: 62, velocity: 1, duration: 100 },
      { id: 'late', tick: 200, pitch: 62, velocity: 1, duration: 10 },
      { id: 'row', tick: 72, pitch: 64, velocity: 1, duration: 19 },
    ];
    expect(notesInBox(notes, 48, 192, new Set([60, 62]))).toEqual(['in', 'held']);
  });
});

describe('the Tighten timing count', () => {
  it('counts a pair of notes that meet on one tick as merged', () => {
    const s = store([
      [94, 43],
      [100, 43],
      [150, 43],
    ]);
    expect(quantizeMoves(clipNotes(s), 24, 1, 768)).toEqual({ moved: 3, merged: 1 });
    quantizeClip(s, T, 0, { grid: '1/16' });
    expect(clipNotes(s)).toHaveLength(2);
  });

  it('is the number of notes quantizeClip moves (and merges), for each grid and strength', () => {
    const rng = new Rng(3);
    for (const grid of ['1/16', '1/8', '1/32', '1/8T', '1/16T', '1/4'] as const) {
      for (const strength of [0.25, 0.5, 0.75, 1]) {
        const ticks = [...new Set(Array.from({ length: 10 }, () => Math.floor(rng.range(0, 760))))];
        const s = store(ticks.map((t, i) => [t, 50 + i]));
        const g = { '1/16': 24, '1/8': 48, '1/32': 12, '1/8T': 32, '1/16T': 16, '1/4': 96 }[grid];
        const before = clipNotes(s).length;
        const want = quantizeMoves(clipNotes(s), g, strength, 768);
        const r = quantizeClip(s, T, 0, { grid, strength });
        expect(r.moved, `${grid} ${strength}`).toBe(want.moved);
        expect(before - clipNotes(s).length, `${grid} ${strength} merged`).toBe(want.merged);
      }
    }
  });
});

describe('touch decisions', () => {
  it('a still touch lifted before the hold is a tap; up, down or slanted first scrolls; clearly sideways first edits', () => {
    expect(isTap(3, 2, 120)).toBe(true);
    // No gap between a tap and the 300 ms hold.
    expect(isTap(3, 2, 290)).toBe(true);
    expect(isTap(3, 2, 300)).toBe(false);
    expect(isTap(12, 0, 100)).toBe(false);
    expect(touchIntent(2, 5)).toBe('pending');
    expect(touchIntent(2, 20)).toBe('scroll');
    // Slanted (8 across, 6 down): a scroll, not a stray note.
    expect(touchIntent(8, 6)).toBe('scroll');
    expect(touchIntent(-20, 6)).toBe('drag');
  });
});
