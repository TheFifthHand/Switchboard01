import { describe, expect, it } from 'vitest';
import type { ScaleId } from '../../src/project/types';
import {
  ROOT_NAMES,
  SCALES,
  isInScale,
  keyLabel,
  noteName,
  parseNote,
  scaleDegreeOf,
  scaleDegreesInRange,
  scaleMask,
  snapToScale,
  transposeInScale,
} from '../../src/music/scales';

// A Record over ScaleId makes the compiler reject this list if a scale id is added to the schema and forgotten here.
const ALL: Record<ScaleId, true> = {
  major: true,
  minor: true,
  dorian: true,
  phrygian: true,
  lydian: true,
  mixolydian: true,
  harmonicMinor: true,
  majorPentatonic: true,
  minorPentatonic: true,
  blues: true,
  chromatic: true,
};
const SCALE_IDS = Object.keys(ALL) as ScaleId[];

describe('scale table', () => {
  it('defines every project scale with ascending intervals from the root', () => {
    for (const id of SCALE_IDS) {
      const s = SCALES[id];
      expect(s, id).toBeDefined();
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.intervals[0]).toBe(0);
      for (let i = 1; i < s.intervals.length; i++) expect(s.intervals[i]).toBeGreaterThan(s.intervals[i - 1]);
      expect(Math.max(...s.intervals)).toBeLessThan(12);
    }
    expect(SCALES.chromatic.intervals).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(SCALES.major.intervals).toHaveLength(7);
    expect(SCALES.minorPentatonic.intervals).toHaveLength(5);
  });

  it('uses sharps for root names', () => {
    expect(ROOT_NAMES).toEqual(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
  });
});

describe('note names', () => {
  it('names notes with C4 = 60', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(58)).toBe('A#3');
    expect(noteName(69)).toBe('A4');
    expect(noteName(21)).toBe('A0');
    expect(noteName(0)).toBe('C-1');
    expect(noteName(127)).toBe('G9');
  });

  it('parses names, flats and sharps', () => {
    expect(parseNote('A3')).toBe(57);
    expect(parseNote('C4')).toBe(60);
    expect(parseNote('C#4')).toBe(61);
    expect(parseNote('Db4')).toBe(61);
    expect(parseNote('Bb2')).toBe(46);
    expect(parseNote('e5')).toBe(76);
    expect(parseNote('C-1')).toBe(0);
    expect(parseNote(' G9 ')).toBe(127);
  });

  it('round-trips every MIDI note', () => {
    for (let m = 0; m <= 127; m++) expect(parseNote(noteName(m))).toBe(m);
  });

  it('rejects malformed or out-of-range names with a readable error', () => {
    expect(() => parseNote('H2')).toThrow(/Cannot read/);
    expect(() => parseNote('A')).toThrow(/Cannot read/);
    expect(() => parseNote('G#9')).toThrow(/outside the MIDI range/);
    expect(() => parseNote('Cb-1')).toThrow(/outside the MIDI range/);
  });
});

describe('scale membership and masks', () => {
  it('knows which notes belong to A minor', () => {
    const inKey = ['A3', 'B3', 'C4', 'D4', 'E4', 'F4', 'G4'].map(parseNote);
    const outKey = ['A#3', 'C#4', 'D#4', 'F#4', 'G#4'].map(parseNote);
    for (const m of inKey) expect(isInScale(m, 9, 'minor')).toBe(true);
    for (const m of outKey) expect(isInScale(m, 9, 'minor')).toBe(false);
  });

  it('builds 12-entry masks indexed by pitch class', () => {
    const cMajor = [true, false, true, false, true, true, false, true, false, true, false, true];
    expect(scaleMask(0, 'major')).toEqual(cMajor);
    // Relative keys share their notes.
    expect(scaleMask(9, 'minor')).toEqual(cMajor);
    expect(scaleMask(4, 'chromatic').every(Boolean)).toBe(true);
    for (const id of SCALE_IDS) {
      for (let root = 0; root < 12; root++) {
        const mask = scaleMask(root, id);
        expect(mask).toHaveLength(12);
        expect(mask.filter(Boolean)).toHaveLength(SCALES[id].intervals.length);
        expect(mask[root]).toBe(true);
      }
    }
  });

  it('reports scale degrees', () => {
    expect(scaleDegreeOf(parseNote('A2'), 9, 'minor')).toBe(0);
    expect(scaleDegreeOf(parseNote('E4'), 9, 'minor')).toBe(4);
    expect(scaleDegreeOf(parseNote('F#4'), 9, 'minor')).toBe(-1);
  });
});

describe('snapToScale', () => {
  it('moves out-of-key notes to the nearest key note, ties going down', () => {
    expect(snapToScale(61, 0, 'major')).toBe(60); // C#4: C and D equally near -> C
    expect(snapToScale(66, 0, 'major')).toBe(65); // F#4 -> F
    expect(snapToScale(70, 9, 'minorPentatonic')).toBe(69); // A#4 -> A (A C D E G)
    expect(snapToScale(71, 9, 'minorPentatonic')).toBe(72); // B4 -> C5 (nearer than A)
    expect(snapToScale(64, 0, 'major')).toBe(64);
  });

  it('leaves the chromatic scale alone', () => {
    for (let m = 0; m <= 127; m++) expect(snapToScale(m, 5, 'chromatic')).toBe(m);
  });

  it('always lands on the nearest in-scale note inside the MIDI range', () => {
    for (const id of SCALE_IDS) {
      for (let root = 0; root < 12; root++) {
        for (let m = 0; m <= 127; m++) {
          const s = snapToScale(m, root, id);
          expect(isInScale(s, root, id)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(127);
          const d = Math.abs(s - m);
          for (let k = Math.max(0, m - d + 1); k <= Math.min(127, m + d - 1); k++) {
            expect(isInScale(k, root, id), `${m} ${root} ${id}`).toBe(false);
          }
          // Ties resolve downward: an equally near lower key note is always chosen.
          if (s > m && m - d >= 0) expect(isInScale(m - d, root, id)).toBe(false);
        }
      }
    }
  });
});

describe('Notes pad layout', () => {
  it('lays out 16 consecutive scale notes from the first key note at or above the start', () => {
    expect(scaleDegreesInRange(0, 'major', 60, 16)).toEqual([60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86]);
    expect(scaleDegreesInRange(0, 'major', 61, 3)).toEqual([62, 64, 65]);
    expect(scaleDegreesInRange(9, 'minorPentatonic', 57, 6)).toEqual([57, 60, 62, 64, 67, 69]);
    expect(scaleDegreesInRange(3, 'chromatic', 48, 16)).toEqual(Array.from({ length: 16 }, (_, i) => 48 + i));
  });

  it('gives 16 ascending in-key pads for every key in a normal register', () => {
    for (const id of SCALE_IDS) {
      for (let root = 0; root < 12; root++) {
        const pads = scaleDegreesInRange(root, id, 48, 16);
        expect(pads).toHaveLength(16);
        expect(pads[0]).toBeGreaterThanOrEqual(48);
        for (let i = 0; i < pads.length; i++) {
          expect(isInScale(pads[i], root, id)).toBe(true);
          if (i > 0) {
            expect(pads[i]).toBeGreaterThan(pads[i - 1]);
            // No key note is skipped between neighbouring pads.
            for (let k = pads[i - 1] + 1; k < pads[i]; k++) expect(isInScale(k, root, id)).toBe(false);
          }
        }
      }
    }
  });

  it('stops at the top of the MIDI range', () => {
    const pads = scaleDegreesInRange(0, 'major', 120, 16);
    expect(pads).toEqual([120, 122, 124, 125, 127]);
  });
});

describe('scale steps and labels', () => {
  it('transposes by scale steps', () => {
    expect(transposeInScale(60, 2, 0, 'major')).toBe(64);
    expect(transposeInScale(64, -1, 0, 'major')).toBe(62);
    expect(transposeInScale(71, 1, 0, 'major')).toBe(72);
    expect(transposeInScale(69, 1, 9, 'minorPentatonic')).toBe(72);
    expect(transposeInScale(61, 0, 0, 'major')).toBe(60);
    expect(transposeInScale(127, 3, 0, 'major')).toBe(127);
  });

  it('labels keys the way musicians say them', () => {
    expect(keyLabel(9, 'minor')).toBe('A minor');
    expect(keyLabel(0, 'major')).toBe('C major');
    expect(keyLabel(1, 'major')).toBe('C# major');
    expect(keyLabel(2, 'dorian')).toBe('D Dorian');
    expect(keyLabel(4, 'minorPentatonic')).toBe('E minor pentatonic');
    expect(keyLabel(9, 'harmonicMinor')).toBe('A harmonic minor');
    expect(keyLabel(7, 'chromatic')).toBe('Chromatic');
  });
});
