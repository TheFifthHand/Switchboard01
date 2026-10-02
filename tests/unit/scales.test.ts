import { describe, expect, it } from 'vitest';
import type { ScaleId } from '../../src/project/types';
import {
  FLAT_NAMES,
  ROOT_NAMES,
  SCALES,
  isInScale,
  keyInterval,
  keyLabel,
  keyNoteNames,
  keyRootName,
  keyShortName,
  keyUsesFlats,
  moveToKey,
  noteName,
  parseNote,
  scaleDegreeOf,
  scaleDegreesInRange,
  scaleMask,
  snapToScale,
  stepsPerOctave,
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
    // The root is spelled as the key writes it: D♭ major (five flats), not C# major (seven sharps).
    expect(keyLabel(1, 'major')).toBe('D♭ major');
    expect(keyLabel(1, 'minor')).toBe('C# minor');
    expect(keyLabel(10, 'major')).toBe('B♭ major');
    expect(keyLabel(3, 'major')).toBe('E♭ major');
    expect(keyLabel(2, 'dorian')).toBe('D Dorian');
    expect(keyLabel(4, 'minorPentatonic')).toBe('E minor pentatonic');
    expect(keyLabel(9, 'harmonicMinor')).toBe('A harmonic minor');
    expect(keyLabel(7, 'chromatic')).toBe('Chromatic');
  });
});

describe('spelling by key (PLAY-23)', () => {
  const G_DORIAN = { root: 7, scale: 'dorian' as const };

  it('spells flat keys and their modes with flats: G Dorian reads B♭', () => {
    expect(noteName(58, G_DORIAN)).toBe('B♭3');
    expect(noteName(70, G_DORIAN)).toBe('B♭4');
    expect(noteName(63, G_DORIAN)).toBe('E♭4'); // outside the key, still written the flat way
    expect(noteName(58)).toBe('A#3'); // without a key: sharps, as before
    expect(keyUsesFlats(7, 'dorian')).toBe(true);
    expect(keyUsesFlats(5, 'phrygian')).toBe(true); // F Phrygian shares D♭ major's notes
    expect(keyUsesFlats(2, 'minor')).toBe(true);
    expect(keyUsesFlats(9, 'dorian')).toBe(false);
    expect(keyUsesFlats(9, 'minor')).toBe(false);
  });

  it('writes the leading tone of a minor-type key as a raised seventh, and the blues ♭5 as a flat', () => {
    expect(noteName(66, { root: 7, scale: 'dorian' })).toBe('F#4');
    expect(noteName(66, { root: 7, scale: 'minor' })).toBe('F#4');
    expect(noteName(61, { root: 2, scale: 'minor' })).toBe('C#4');
    expect(noteName(61, { root: 2, scale: 'dorian' })).toBe('C#4');
    expect(noteName(64, { root: 5, scale: 'minor' })).toBe('E4');
    expect(noteName(71, { root: 0, scale: 'minorPentatonic' })).toBe('B4');
    // The rest of a flat key's outside notes stay flat.
    expect(noteName(61, { root: 7, scale: 'minor' })).toBe('D♭4');
    // Blues: the ♭5 is a flattened fifth.
    expect(noteName(63, { root: 9, scale: 'blues' })).toBe('E♭4');
    expect(noteName(70, { root: 4, scale: 'blues' })).toBe('B♭4');
    expect(noteName(61, { root: 7, scale: 'blues' })).toBe('D♭4');
    // Major keys are unchanged: their leading tone is in the key.
    expect(noteName(66, { root: 7, scale: 'major' })).toBe('F#4');
    expect(noteName(64, { root: 5, scale: 'major' })).toBe('E4');
  });

  it('keeps sharp keys sharp and gives every scale note its own letter', () => {
    expect([0, 2, 3, 5, 7, 8, 11].map((iv) => noteName(60 + iv, { root: 0, scale: 'harmonicMinor' }))).toEqual(['C4', 'D4', 'E♭4', 'F4', 'G4', 'A♭4', 'B4']);
    // G harmonic minor: B♭ and E♭ beside F#; D harmonic minor: B♭ beside C#; A minor keeps G#.
    expect(keyNoteNames(7, 'harmonicMinor')[6]).toBe('F#');
    expect(keyNoteNames(7, 'harmonicMinor')[10]).toBe('B♭');
    expect(keyNoteNames(2, 'harmonicMinor')[1]).toBe('C#');
    expect(keyNoteNames(9, 'harmonicMinor')[8]).toBe('G#');
    expect(keyNoteNames(4, 'lydian')[10]).toBe('A#');
    expect(keyNoteNames(5, 'phrygian').filter((_, pc) => isInScale(pc, 5, 'phrygian'))).toEqual(['D♭', 'E♭', 'F', 'G♭', 'A♭', 'B♭', 'C'].sort((a, b) => FLAT_NAMES.indexOf(a as never) - FLAT_NAMES.indexOf(b as never)));
  });

  it('writes every scale note of a seven-note key with seven different letters, and round-trips through parseNote', () => {
    const sharedLetter: string[] = [];
    const sevens: ScaleId[] = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonicMinor'];
    for (let root = 0; root < 12; root++) {
      for (const scale of SCALE_IDS) {
        const key = { root, scale };
        for (let m = 0; m <= 127; m++) expect(parseNote(noteName(m, key)), `${noteName(m, key)} in ${keyLabel(root, scale)}`).toBe(m);
        if (!sevens.includes(scale)) continue;
        const letters = SCALES[scale].intervals.map((iv) => keyNoteNames(root, scale)[(root + iv) % 12][0]);
        if (new Set(letters).size < 7) sharedLetter.push(keyLabel(root, scale));
      }
    }
    // Only keys that would need E#, B# or a double sharp (never written) share a letter.
    expect(sharedLetter).toEqual([
      'C# Mixolydian',
      'C# harmonic minor',
      'D# minor',
      'D# harmonic minor',
      'F# major',
      'F# harmonic minor',
      'G# Dorian',
      'G# harmonic minor',
      'A# Phrygian',
      'B Lydian',
    ]);
  });

  it('gives a short key name for tight spaces', () => {
    expect(keyShortName(7, 'dorian')).toBe('G Dor');
    expect(keyShortName(9, 'minor')).toBe('A min');
    expect(keyShortName(10, 'major')).toBe('B♭ maj');
    expect(keyShortName(4, 'minorPentatonic')).toBe('E min pent');
    expect(keyShortName(0, 'chromatic')).toBe('Chrom');
    for (let root = 0; root < 12; root++) for (const scale of SCALE_IDS) expect(keyShortName(root, scale).length).toBeLessThanOrEqual(11);
    expect(keyRootName(1, 'major')).toBe('D♭');
    expect(keyRootName(1, 'minor')).toBe('C#');
  });
});

describe('moving music between keys', () => {
  it('takes the shortest way between roots (a tritone goes up)', () => {
    expect(keyInterval(7, 9)).toBe(2);
    expect(keyInterval(7, 5)).toBe(-2);
    expect(keyInterval(0, 6)).toBe(6);
    expect(keyInterval(0, 7)).toBe(-5);
    expect(keyInterval(11, 0)).toBe(1);
  });

  it('maps scale degrees when the scale changes and moves outside notes by the interval', () => {
    const gDor = { root: 7, scale: 'dorian' as const };
    // G Dorian -> G minor: E (the major sixth) becomes E♭; the other degrees stay.
    expect(moveToKey(64, gDor, { root: 7, scale: 'minor' })).toBe(63);
    expect(moveToKey(70, gDor, { root: 7, scale: 'minor' })).toBe(70);
    // G Dorian -> A Dorian: everything up two.
    expect([55, 58, 62, 64].map((m) => moveToKey(m, gDor, { root: 9, scale: 'dorian' }))).toEqual([57, 60, 64, 66]);
    // A Dorian -> A minor (Aeolian): F# -> F.
    expect(moveToKey(66, { root: 9, scale: 'dorian' }, { root: 9, scale: 'minor' })).toBe(65);
    // C# is outside G Dorian: it only moves by the interval.
    expect(moveToKey(61, gDor, { root: 9, scale: 'minor' })).toBe(63);
    // Seven notes to five: scale notes land on the nearest note of the new key.
    expect(isInScale(moveToKey(65, { root: 0, scale: 'major' }, { root: 0, scale: 'majorPentatonic' }), 0, 'majorPentatonic')).toBe(true);
    // Pentatonic and blues keys count degrees in their parent scale: C minor pentatonic to C major
    // turns C E♭ F G B♭ into C E F G B (♭3 -> 3, ♭7 -> 7), not a tie snapped downward.
    expect([60, 63, 65, 67, 70].map((m) => moveToKey(m, { root: 0, scale: 'minorPentatonic' }, { root: 0, scale: 'major' }))).toEqual([60, 64, 65, 67, 71]);
    expect([60, 63, 65, 67, 70].map((m) => moveToKey(m, { root: 0, scale: 'blues' }, { root: 2, scale: 'dorian' }))).toEqual([62, 65, 67, 69, 72]);
    // The blues ♭5 is outside the parent scale: it moves by the interval only.
    expect(moveToKey(66, { root: 0, scale: 'blues' }, { root: 0, scale: 'major' })).toBe(66);
    // C major pentatonic to C minor pentatonic: E -> E♭; A -> A♭, which the five-note key lacks, lands on G.
    expect(moveToKey(64, { root: 0, scale: 'majorPentatonic' }, { root: 0, scale: 'minorPentatonic' })).toBe(63);
    expect(moveToKey(69, { root: 0, scale: 'majorPentatonic' }, { root: 0, scale: 'minorPentatonic' })).toBe(67);
    // To or from chromatic: interval only.
    expect(moveToKey(61, { root: 0, scale: 'chromatic' }, { root: 2, scale: 'minor' })).toBe(63);
  });

  it('keeps every scale note in the new key for every pair of seven-note keys', () => {
    const sevens: ScaleId[] = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonicMinor'];
    for (const a of sevens) for (const b of sevens) for (let ra = 0; ra < 12; ra += 5) for (let rb = 0; rb < 12; rb += 3) {
      for (let m = 36; m < 84; m++) {
        if (!isInScale(m, ra, a)) continue;
        const q = moveToKey(m, { root: ra, scale: a }, { root: rb, scale: b });
        expect(isInScale(q, rb, b)).toBe(true);
        expect(Math.abs(q - m)).toBeLessThanOrEqual(8);
      }
    }
  });

  it('counts scale steps per octave', () => {
    expect(stepsPerOctave('dorian')).toBe(7);
    expect(stepsPerOctave('minorPentatonic')).toBe(5);
    expect(stepsPerOctave('chromatic')).toBe(12);
  });
});
