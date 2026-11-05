/**
 * Pop — 110 BPM, B♭ major. A bright, steady band beat under piano chords:
 * B♭, F, Gm and E♭ in the Groove (I, V, vi, IV), Gm, E♭, B♭ and F in the
 * Lift, where a plucked hook comes in. The bass never plays A or D, the
 * notes a semitone under the chords' B♭ and E♭, so any bass clip sits under
 * any chord clip; the strings double the piano's voicings exactly.
 */
import { clip, defineStarter, drums, hand, line, mel, stabs } from './dsl';

const BB = 'Bb3 D4 F4';
const F = 'A3 C4 F4';
const GM = 'Bb3 D4 G4';
const EB = 'Bb3 Eb4 G4';

const plus = (v: string) => v.replace(/ /g, '+');

export const POP = defineStarter({
  id: 'pop',
  name: 'Pop',
  description: 'A bright, steady pop groove with piano chords, a plucked hook and soft strings.',
  bpm: 110,
  swing: 0,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 0.5,
  root: 10,
  scale: 'major',
  scenes: ['Intro', 'Verse', 'Chorus', 'Break'],
  reverb: { decay: 2, predelay: 18, tone: 6000 },
  delay: { division: 3, feedback: 0.32, tone: 3600 },
  arrangement: [
    [0, 2],
    [1, 4],
    [2, 4],
    [3, 2],
    [2, 4],
    [1, 2],
  ],
  tailSeconds: 4,
  parts: {
    drums: {
      sound: 'studio-acoustic',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -10 },
      macros: { space: 0.12 },
      clips: [
        clip('Hats & Rim', 2, drums(2, { hat: '7.5.7.5.7.5.7.5.', rim: '....x.......x...|....x.......x..o' })),
        clip(
          'Pop Beat',
          2,
          drums(2, {
            kick: 'X.......X.X.....|X.......X.......',
            snare: '....X.......X...',
            hat: 'x.x.x.x.x.x.x.x.',
          }),
        ),
        clip(
          'Big Chorus',
          4,
          drums(4, {
            kick: 'X.......X.X.....|X.......X...x...',
            snare: '....X.......X...',
            clap: '....x.......x...',
            hat: 'x.x.x.x.x.x.x.x.',
            openHat: '..............x.|................',
            crash: 'x...............|................|................|................',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'hand-percussion',
      level: -9,
      instrument: { level: -4.5 },
      pan: 0.25,
      macros: { space: 0.2 },
      clips: [
        clip('Shaker', 1, hand(1, { shaker: '5353535353535353' })),
        clip('Tambourine', 1, hand(1, { shaker: '5353535353535353', tambourine: '....x.......x...' })),
        clip('Tambourine Drive', 2, hand(2, { shaker: 'x5x5x5x5x5x5x5x5', tambourine: '..x...x...x...x.|..x...x...x.x.x.' })),
        null,
      ],
    },
    bass: {
      sound: 'bass-finger',
      level: -7,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Verse Bass',
          4,
          line(
            4,
            `Bb1 - - . Bb1 - . . Bb1 - - . F1 - Bb1 - |
             F1 - - . F1 - . . F1 - - . C2 - F1 - |
             G1 - - . G1 - . . G1 - - . F1 - G1 - |
             Eb2 - - . Eb2 - . . Eb2 - - . Bb1 - C2 -`,
          ),
        ),
        clip(
          'Chorus Bass',
          4,
          line(
            4,
            `G1 . G1 . G1 . G2 . G1 . G1 . F2 . G1 . |
             Eb2 . Eb2 . Eb2 . Bb1 . Eb2 . Eb2 . F2 . G2 . |
             Bb1 . Bb1 . Bb1 . Bb2 . Bb1 . Bb1 . C2 . Bb1 . |
             F1 . F1 . F1 . F2 . F1 . F1 . G1 . C2 .`,
            { gate: 0.8 },
          ),
        ),
        clip('Long Notes', 4, line(4, 'Eb2 F1 G1 G1', { unit: 16, gate: 0.94, vel: 0.62 })),
      ],
    },
    chords: {
      sound: 'poly-bright-piano',
      name: 'Piano',
      level: -5,
      macros: { space: 0.25, echo: 0.12 },
      clips: [
        clip('Intro Piano', 4, stabs(4, 'x-------x-------', [BB, BB, EB, EB], { gate: 0.95 })),
        clip('Verse Piano', 4, stabs(4, 'X--x--x---x-x---', [BB, F, GM, EB], { gate: 0.9 })),
        clip('Chorus Piano', 4, stabs(4, 'X-x-x-x-X-x-x-x-', [GM, EB, BB, F], { gate: 0.85 })),
        clip('Break Piano', 4, stabs(4, 'x---------------', [EB, F, GM, GM], { gate: 0.97 })),
      ],
    },
    lead: {
      sound: 'poly-soft-pluck',
      name: 'Hook',
      level: -2,
      pan: 0.08,
      macros: { echo: 0.3, space: 0.22 },
      clips: [
        null,
        null,
        clip(
          'Hook',
          4,
          line(
            4,
            `D5 . D5 . Bb4 . G4 . . . Bb4 . C5 - - - |
             Bb4 . Bb4 . G4 . Eb4 . . . G4 . Bb4 - - - |
             D5 . D5 . F5 . D5 . . . Bb4 . C5 . D5 - |
             C5 - - - A4 . C5 . F5 - - - - - . .`,
          ),
        ),
        clip(
          'Hook Echo',
          4,
          line(
            4,
            `. . . . G4 - - - . . . . Bb4 . . . |
             . . . . C5 - - - . . . . A4 . . . |
             . . . . D5 - - - . . . . Bb4 . . . |
             . . . . G4 - - - - - - - . . . .`,
            { vel: 0.6 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-string-ensemble',
      name: 'Strings',
      level: -8,
      macros: { space: 0.5 },
      // The strings double the piano's own voicings, so the two never rub.
      clips: [
        clip('Intro Strings', 4, line(4, `${plus(BB)} - ${plus(EB)} -`, { unit: 16, gate: 0.98, vel: 0.5 })),
        null,
        clip('Chorus Strings', 4, line(4, `${plus(GM)} ${plus(EB)} ${plus(BB)} ${plus(F)}`, { unit: 16, gate: 0.98, vel: 0.55 })),
        clip('Break Strings', 4, line(4, `${plus(EB)} ${plus(F)} ${plus(GM)} -`, { unit: 16, gate: 0.98, vel: 0.6 })),
      ],
    },
    texture: {
      sound: 'poly-tape-shimmer',
      name: 'Shimmer',
      level: -13,
      macros: { space: 0.6 },
      clips: [
        // B♭ is in both Intro chords; G in all three Break chords, and a semitone from none.
        clip('Shimmer', 4, mel([['Bb5', 0, 64, 0.45]])),
        null,
        null,
        clip('Break Shimmer', 4, mel([['G5', 0, 64, 0.45]])),
      ],
    },
    sampler: {
      sound: 'builtin:vocal-oh',
      name: 'Vocal',
      level: -20,
      pan: -0.1,
      macros: { echo: 0.3, space: 0.3 },
      // Loop mode: each chop lasts as long as its note (see House).
      instrument: { mode: 1 },
      clips: [
        null,
        null,
        clip(
          'Oh Chops',
          4,
          mel([
            ['D4', 2, 2],
            ['Bb3', 7, 1, 0.6],
            ['D4', 10, 3],
            ['Eb4', 18, 2],
            ['G3', 23, 1, 0.6],
            ['Eb4', 26, 3],
            ['F4', 34, 2],
            ['D4', 39, 1, 0.6],
            ['Bb3', 42, 3],
            ['C4', 50, 2],
            ['F4', 55, 1, 0.6],
            ['C4', 58, 3],
          ]),
        ),
        clip(
          'Long Oh',
          4,
          mel([
            ['Eb4', 8, 5, 0.7],
            ['D4', 40, 6, 0.65],
          ]),
        ),
      ],
    },
  },
});
