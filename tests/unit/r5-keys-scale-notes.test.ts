/**
 * The scale keyboard's notes: the root at or below the strip's base note, then consecutive in-key
 * notes upward, each a different pitch, never past MIDI 127.
 */
import { describe, expect, it } from 'vitest';
import { SCALES, SCALE_ORDER, isInScale, noteName, rootAtOrBelow, scaleKeyboardNotes } from '../../src/music/scales';

describe('rootAtOrBelow', () => {
  it('finds the root at or below a note: G3 under C4, C4 on C4, B3 under C4', () => {
    expect(rootAtOrBelow(7, 60)).toBe(55);
    expect(rootAtOrBelow(0, 60)).toBe(60);
    expect(rootAtOrBelow(11, 60)).toBe(59);
    expect(rootAtOrBelow(1, 60)).toBe(49);
    // Any integer root works (read modulo 12).
    expect(rootAtOrBelow(-5, 60)).toBe(55);
  });

  it('never goes below MIDI 0', () => {
    expect(rootAtOrBelow(7, 3)).toBe(7);
    expect(rootAtOrBelow(0, 0)).toBe(0);
  });
});

describe('scaleKeyboardNotes', () => {
  it('G Dorian from C4: G3 A3 B♭3 C4 D4 E4 F4 G4 …, spelled in the key', () => {
    const notes = scaleKeyboardNotes(7, 'dorian', 60, 15);
    expect(notes.map((m) => noteName(m, { root: 7, scale: 'dorian' }))).toEqual(['G3', 'A3', 'B♭3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B♭4', 'C5', 'D5', 'E5', 'F5', 'G5']);
  });

  it('every key is a different in-key note, ascending, in every scale and root', () => {
    for (const scale of SCALE_ORDER) {
      for (let root = 0; root < 12; root++) {
        const per = SCALES[scale].intervals.length;
        const notes = scaleKeyboardNotes(root, scale, 60, 3 * per + 1);
        expect(notes).toHaveLength(3 * per + 1);
        expect(notes[0] % 12).toBe(root);
        expect(notes[0]).toBeLessThanOrEqual(60);
        expect(notes[0]).toBeGreaterThan(48);
        for (let i = 1; i < notes.length; i++) expect(notes[i], `${scale} ${root}`).toBeGreaterThan(notes[i - 1]);
        for (const m of notes) expect(isInScale(m, root, scale)).toBe(true);
        // Three octaves and the root above.
        expect(notes[notes.length - 1] - notes[0]).toBe(36);
      }
    }
  });

  it('stops at MIDI 127', () => {
    const notes = scaleKeyboardNotes(11, 'major', 108, 22);
    expect(notes[0]).toBe(107);
    expect(notes[notes.length - 1]).toBeLessThanOrEqual(127);
    expect(notes.length).toBeLessThan(22);
  });
});
