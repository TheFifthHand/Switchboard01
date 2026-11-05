/**
 * Afrobeats — 105 BPM, F# minor, lightly swung (0.15). A rolling kick and
 * rim pattern with djembe, shekere and agogo on the Afro Latin kit, a
 * log-drum bass, marimba off-beat chords (F#m7, Bm7, E, D) and a kalimba
 * melody in the Lift (Bm7, D, E, F#m7). The bass only plays F#, A, B, D and
 * E: never G# or C#, the notes a semitone under the chords' A and D, so any
 * bass clip sits under any chord clip. The pad doubles the marimba's
 * voicings exactly.
 */
import { afro, clip, defineStarter, drums, line, mel, stabs } from './dsl';

const FSM7 = 'F#3 A3 C#4 E4';
const BM7 = 'F#3 A3 B3 D4';
const E = 'G#3 B3 E4';
const D = 'F#3 A3 D4';

const plus = (v: string) => v.replace(/ /g, '+');
const SKANK = '..x..x.x..x..x..';

export const AFROBEATS = defineStarter({
  id: 'afrobeats',
  name: 'Afrobeats',
  description: 'A sunny, swaying groove with hand drums, a woody log-drum bass, marimba and kalimba.',
  bpm: 105,
  swing: 0.15,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: -2,
  root: 6,
  scale: 'minor',
  scenes: ['Intro', 'Groove', 'Lift', 'Break'],
  reverb: { decay: 1.9, predelay: 14, tone: 5500 },
  delay: { division: 3, feedback: 0.34, tone: 3200 },
  arrangement: [
    [0, 2],
    [1, 4],
    [2, 4],
    [3, 2],
    [2, 2],
    [1, 2],
  ],
  tailSeconds: 4,
  parts: {
    drums: {
      sound: 'round-machine',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -12 },
      macros: { space: 0.1 },
      clips: [
        clip('Rim & Shaker', 2, drums(2, { rim: '...x..x....x..x.', shaker: 'x5x5x5x5x5x5x5x5' })),
        clip(
          'Afro Groove',
          2,
          drums(2, {
            kick: 'X......X..X.....|X......X..X..x..',
            rim: '...x..x....x..x.',
            clap: '....x.......x...',
            shaker: 'x5x5x5x5x5x5x5x5',
          }),
        ),
        clip(
          'Afro Lift',
          2,
          drums(2, {
            kick: 'X......X..X.....|X......X..X..x..',
            rim: '...x..x....x..x.|...x..x....x.xx.',
            clap: '....x.......x...',
            hat: '..x...x...x...x.',
            shaker: 'x5x5x5x5x5x5x5x5',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'afro-latin',
      name: 'Hand Drums',
      level: -8,
      instrument: { level: -9 },
      pan: -0.2,
      macros: { space: 0.18 },
      clips: [
        clip('Shekere', 1, afro(1, { shekere: 'x..4x..4x..4x..4' })),
        clip(
          'Djembe Talk',
          2,
          afro(2, {
            djembeBass: 'X.........x.....|X.....x...x.....',
            djembeTone: '...x..x....x....|...x..x.......x.',
            djembeSlap: '.......X.......X|.......X..X.....',
            shekere: '4.4.4.4.4.4.4.4.',
          }),
        ),
        clip(
          'Market Day',
          2,
          afro(2, {
            agogo: 'x.x..x.x..x.x...|x.x..x.x..x..x..',
            djembeSlap: '.......X.......X',
            talkingDrum: '..........x..x..|..........x.....',
            shekere: '4.4.4.4.4.4.4.4.',
          }),
        ),
        null,
      ],
    },
    bass: {
      sound: 'bass-log-drum',
      name: 'Log Drum',
      level: -3,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Log Bass',
          4,
          line(
            4,
            `F#1 . . F#1 . . A1 . . . F#1 . E2 . . . |
             B1 . . B1 . . D2 . . . B1 . A1 . . . |
             E1 . . E2 . . B1 . . . E2 . B1 . . . |
             D2 . . D2 . . A1 . . . D2 . E2 . F#2 .`,
          ),
        ),
        clip(
          'Lift Log',
          4,
          line(
            4,
            `B1 . . B1 . . F#1 . . . B1 . D2 . . . |
             D2 . . D2 . . A1 . . . D2 . F#2 . . . |
             E2 . . E2 . . B1 . . . E2 . E1 . . . |
             F#1 . . F#1 . . A1 . . . F#2 . E2 . D2 .`,
          ),
        ),
        clip('Soft Roots', 4, line(4, 'D2 E2 B1 B1', { unit: 16, gate: 0.9, vel: 0.6 })),
      ],
    },
    chords: {
      sound: 'poly-marimba',
      name: 'Marimba',
      level: -5.5,
      pan: 0.15,
      macros: { space: 0.22, echo: 0.15 },
      clips: [
        clip('Soft Marimba', 4, stabs(4, 'x.......x.......', [FSM7, FSM7, BM7, BM7], { gate: 0.9 })),
        clip('Skank', 4, stabs(4, SKANK, [FSM7, BM7, E, D], { gate: 0.6 })),
        clip('Lift Skank', 4, stabs(4, 'x.x..x.x..x..x.x', [BM7, D, E, FSM7], { gate: 0.6 })),
        clip('Break Marimba', 4, stabs(4, 'x.....x.....x...', [D, E, BM7, BM7], { gate: 0.9 })),
      ],
    },
    lead: {
      sound: 'poly-kalimba',
      name: 'Kalimba',
      level: -5,
      pan: -0.1,
      macros: { echo: 0.3, space: 0.25 },
      clips: [
        null,
        null,
        clip(
          'Kalimba',
          4,
          line(
            4,
            `F#5 . D5 . B4 . D5 . F#5 . E5 . D5 - - - |
             A4 . D5 . F#5 . A5 . F#5 . E5 . D5 - - - |
             G#4 . B4 . E5 . B4 . G#5 . F#5 . E5 - - - |
             C#5 . E5 . F#5 . A5 . F#5 . E5 . C#5 - - -`,
            { vel: 0.75 },
          ),
        ),
        clip(
          'Kalimba Echo',
          4,
          line(
            4,
            `. . . . F#5 - - - . . . . A4 . . . |
             . . . . E5 - - - . . . . B4 . . . |
             . . . . D5 - - - . . . . F#4 . . . |
             . . . . B4 - - - - - - - . . . .`,
            { vel: 0.6 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-warm-drift',
      level: -8,
      macros: { space: 0.5, motion: 0.2 },
      lfo: { division: 1 },
      // The pad doubles the marimba's own voicings, so the two never rub.
      clips: [
        clip('Warm Bed', 4, line(4, `${plus(FSM7)} - ${plus(BM7)} -`, { unit: 16, gate: 0.98, vel: 0.5 })),
        null,
        clip('Lift Bed', 4, line(4, `${plus(BM7)} ${plus(D)} ${plus(E)} ${plus(FSM7)}`, { unit: 16, gate: 0.98, vel: 0.5 })),
        clip('Break Bed', 4, line(4, `${plus(D)} ${plus(E)} ${plus(BM7)} -`, { unit: 16, gate: 0.98, vel: 0.58 })),
      ],
    },
    texture: {
      sound: 'poly-air-grain',
      name: 'Air',
      level: -12,
      macros: { motion: 0.4, space: 0.55 },
      lfo: { division: 0 },
      // A is in both Intro chords and E sits in every Break chord's key without a semitone neighbour there.
      clips: [clip('Warm Air', 4, mel([['A4', 0, 64, 0.45]])), null, null, clip('High Air', 4, mel([['E5', 0, 64, 0.42]]))],
    },
    sampler: {
      sound: 'builtin:vocal-oh',
      name: 'Vocal',
      level: -20,
      pan: 0.12,
      macros: { echo: 0.28, space: 0.3 },
      // Loop mode: each chop lasts as long as its note (see House).
      instrument: { mode: 1 },
      clips: [
        null,
        null,
        clip(
          'Oh Chops',
          4,
          mel([
            ['B3', 2, 2],
            ['D4', 7, 1, 0.6],
            ['F#3', 10, 3],
            ['D4', 18, 2],
            ['A3', 23, 1, 0.6],
            ['D4', 26, 3],
            ['E4', 34, 2],
            ['G#3', 39, 1, 0.6],
            ['B3', 42, 3],
            ['C#4', 50, 2],
            ['A3', 55, 1, 0.6],
            ['F#3', 58, 3],
          ]),
        ),
        clip(
          'Long Oh',
          4,
          mel([
            ['D4', 8, 5, 0.7],
            ['B3', 40, 6, 0.65],
          ]),
        ),
      ],
    },
  },
});
