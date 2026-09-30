import { describe, expect, it } from 'vitest';
import {
  CHORD_QUALITIES,
  chordNotes,
  chordSymbol,
  chordVoicings,
  closeVoicings,
  diatonicChord,
  diatonicSeventh,
  diatonicTriad,
  identifyChord,
  invertChord,
  parseChord,
  parseChordSymbol,
  parseProgression,
  pitchClassSet,
  romanNumeral,
  voiceChord,
  voiceLead,
  voiceLeadProgression,
  voiceLeadingDistance,
  type ChordQuality,
} from '../../src/music/chords';
import { isInScale, parseNote } from '../../src/music/scales';
import type { ScaleId } from '../../src/project/types';

describe('chord symbols', () => {
  it('parses common authoring symbols into MIDI notes at an octave', () => {
    expect(parseChord('Am7', 3)).toEqual([57, 60, 64, 67]);
    expect(parseChord('Fmaj7', 3)).toEqual([53, 57, 60, 64]);
    expect(parseChord('G', 3)).toEqual([55, 59, 62]);
    expect(parseChord('Esus4', 3)).toEqual([52, 57, 59]);
    expect(parseChord('Dm9', 3)).toEqual([50, 53, 57, 60, 64]);
    expect(parseChord('Bb', 2)).toEqual([46, 50, 53]);
    expect(parseChord('F#m7b5', 3)).toEqual([54, 57, 60, 64]);
    expect(parseChord('C', 4)).toEqual([60, 64, 67]);
    expect(parseChord('CM7')).toEqual(parseChord('Cmaj7'));
    expect(parseChord('C-7')).toEqual(parseChord('Cm7'));
  });

  it('puts a slash bass below the chord', () => {
    expect(parseChord('C/E', 3)).toEqual([40, 48, 52, 55]);
    expect(parseChord('Am/G', 3)).toEqual([55, 57, 60, 64]);
    expect(parseChordSymbol('C/C')).toEqual({ root: 0, quality: 'maj' });
  });

  it('parses progressions', () => {
    expect(parseProgression('Am7 Fmaj7 | C, G', 3)).toEqual([parseChord('Am7'), parseChord('Fmaj7'), parseChord('C'), parseChord('G')]);
  });

  it('rejects unknown chords with a helpful message', () => {
    expect(() => parseChord('Cfoo')).toThrow(/Unknown chord type/);
    expect(() => parseChord('Xm')).toThrow(/Cannot read the chord/);
    expect(() => parseChord('C', 10)).toThrow(/MIDI range/);
  });

  it('names chords in any inversion and round-trips every quality on every root', () => {
    expect(chordSymbol(identifyChord([64, 67, 72])!)).toBe('C/E');
    expect(chordSymbol(identifyChord([57, 60, 64, 67])!)).toBe('Am7');
    expect(chordSymbol(identifyChord([48, 52, 55, 57])!)).toBe('C6');
    expect(chordSymbol(identifyChord([60, 62, 67])!)).toBe('Csus2');
    expect(identifyChord([60, 61, 62])).toBeNull();
    expect(identifyChord([])).toBeNull();
    for (const quality of Object.keys(CHORD_QUALITIES) as ChordQuality[]) {
      for (let root = 0; root < 12; root++) {
        const notes = chordNotes({ root, quality }, 3);
        expect(identifyChord(notes), `${root} ${quality}`).toEqual({ root, quality });
        expect(parseChord(chordSymbol({ root, quality }), 3)).toEqual(notes);
      }
    }
  });
});

describe('diatonic chords', () => {
  it('stacks thirds inside the key', () => {
    // A minor at octave 3: A3 = 57.
    expect(diatonicTriad(9, 'minor', 0)).toEqual([57, 60, 64]); // Am
    expect(diatonicTriad(9, 'minor', 3)).toEqual([62, 65, 69]); // Dm
    expect(diatonicTriad(9, 'minor', 5)).toEqual([65, 69, 72]); // F
    expect(diatonicSeventh(0, 'major', 4)).toEqual([55, 59, 62, 65]); // G7 (C3 = 48 is the tonic)
    expect(chordSymbol(identifyChord(diatonicTriad(0, 'major', 6))!)).toBe('Bdim');
    expect(chordSymbol(identifyChord(diatonicChord(9, 'minor', 0, 5))!)).toBe('Am9');
    // Degrees beyond the octave continue up or down.
    expect(diatonicTriad(0, 'major', 7)).toEqual([60, 64, 67]);
    expect(diatonicTriad(0, 'major', -1)).toEqual([47, 50, 53]);
  });

  it('keeps every diatonic chord tone in the key for seven-note scales', () => {
    const scales: ScaleId[] = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonicMinor'];
    for (const scale of scales) {
      for (let root = 0; root < 12; root++) {
        for (let degree = 0; degree < 7; degree++) {
          for (const size of [3, 4, 5] as const) {
            for (const p of diatonicChord(root, scale, degree, size)) expect(isInScale(p, root, scale)).toBe(true);
          }
        }
      }
    }
  });

  it('builds pentatonic and blues harmony from the parent scale', () => {
    expect(diatonicTriad(9, 'minorPentatonic', 0)).toEqual(diatonicTriad(9, 'minor', 0));
    expect(diatonicTriad(0, 'majorPentatonic', 4)).toEqual(diatonicTriad(0, 'major', 4));
    expect(diatonicTriad(4, 'blues', 3)).toEqual(diatonicTriad(4, 'minor', 3));
  });

  it('writes roman numerals', () => {
    expect(romanNumeral(0, 'major', 0)).toBe('I');
    expect(romanNumeral(0, 'major', 1)).toBe('ii');
    expect(romanNumeral(0, 'major', 6)).toBe('vii°');
    expect(romanNumeral(9, 'minor', 0)).toBe('i');
    expect(romanNumeral(9, 'minor', 5)).toBe('VI');
    expect(romanNumeral(9, 'harmonicMinor', 4, 4)).toBe('V7');
    expect(romanNumeral(0, 'major', 1, 4)).toBe('ii7');
    expect(romanNumeral(0, 'major', 1, 5)).toBe('ii9');
    // Stacks without a common chord name keep the named part and list the rest.
    expect(romanNumeral(0, 'major', 2, 5)).toBe('iii7(b9)');
    expect(romanNumeral(0, 'major', 6, 5)).toBe('viiø7(b9)');
    expect(romanNumeral(9, 'harmonicMinor', 2, 4)).toBe('III+(maj7)');
  });

  it('writes minor and diminished chords in lower case at every size, like their triads', () => {
    const scales: ScaleId[] = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonicMinor'];
    for (const scale of scales) {
      for (let degree = 0; degree < 7; degree++) {
        const triad = diatonicTriad(0, scale, degree);
        const minorThird = triad[1] - triad[0] === 3;
        for (const size of [3, 4, 5] as const) {
          const numeral = romanNumeral(0, scale, degree, size).match(/^[IViv]+/)![0];
          expect(numeral, `${scale} ${degree} ${size}`).toBe(minorThird ? numeral.toLowerCase() : numeral.toUpperCase());
          expect(numeral.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('inversions and voicings', () => {
  it('inverts up and down', () => {
    expect(invertChord([60, 64, 67], 1)).toEqual([64, 67, 72]);
    expect(invertChord([60, 64, 67], 2)).toEqual([67, 72, 76]);
    expect(invertChord([60, 64, 67], -1)).toEqual([55, 60, 64]);
    expect(pitchClassSet(invertChord([57, 60, 64, 67], 3))).toEqual(pitchClassSet([57, 60, 64, 67]));
  });

  it('lists close voicings inside a register', () => {
    const vs = closeVoicings([60, 64, 67], 55, 72);
    expect(vs).toContainEqual([55, 60, 64]);
    expect(vs).toContainEqual([60, 64, 67]);
    expect(vs).toContainEqual([64, 67, 72]);
    for (const v of vs) {
      expect(pitchClassSet(v)).toEqual([0, 4, 7]);
      expect(Math.max(...v) - Math.min(...v)).toBeLessThan(12);
      expect(Math.min(...v)).toBeGreaterThanOrEqual(55);
      expect(Math.max(...v)).toBeLessThanOrEqual(72);
    }
  });

  it('adds drop-2 open voicings for four-note chords', () => {
    const vs = chordVoicings(parseChord('Cmaj7', 4), 48, 84);
    expect(vs).toContainEqual([55, 60, 64, 71]); // C E G B close -> drop the G
    for (const v of vs) expect(pitchClassSet(v)).toEqual(pitchClassSet(parseChord('Cmaj7')));
  });

  it('centres a chord in a register', () => {
    const v = voiceChord(parseChord('Am7', 1), 60, 76);
    expect(pitchClassSet(v)).toEqual(pitchClassSet(parseChord('Am7')));
    expect(Math.min(...v)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...v)).toBeLessThanOrEqual(76);
  });

  it('finds the smoothest next voicing', () => {
    const c = [60, 64, 67];
    expect(voiceLead(c, parseChord('F', 3), 48, 84)).toEqual([60, 65, 69]);
    expect(voiceLead(c, parseChord('G', 3), 48, 84)).toEqual([59, 62, 67]);
    expect(voiceLead(null, parseChord('G', 1), 60, 72)).toEqual(voiceChord(parseChord('G'), 60, 72));
    expect(voiceLeadingDistance([60, 64, 67], [60, 65, 69])).toBe(3);
  });

  it('voice-leads a progression with less movement than root-position blocks', () => {
    const prog = parseProgression('Am7 Fmaj7 C G', 3);
    const led = voiceLeadProgression(prog, parseNote('E3'), parseNote('E5'));
    let ledMove = 0;
    let blockMove = 0;
    for (let i = 1; i < prog.length; i++) {
      ledMove += voiceLeadingDistance(led[i - 1], led[i]);
      blockMove += voiceLeadingDistance(prog[i - 1], prog[i]);
    }
    expect(ledMove).toBeLessThan(blockMove);
    led.forEach((v, i) => {
      expect(pitchClassSet(v)).toEqual(pitchClassSet(prog[i]));
      for (const p of v) {
        expect(p).toBeGreaterThanOrEqual(parseNote('E3'));
        expect(p).toBeLessThanOrEqual(parseNote('E5'));
      }
    });
  });
});
