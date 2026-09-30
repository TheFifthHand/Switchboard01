/**
 * House — 124 BPM, G dorian. A solid four-on-the-floor groove under a
 * two-chord dorian vamp (Gm9 to C9): the minor tonic and the bright major IV
 * share G, Bb and D, so every bass and chord variation sits over any other.
 * Groove (row 1) is what Jump In plays: drums, congas, a bouncing bass and
 * off-beat organ stabs.
 */
import { atBar, chord, clip, defineStarter, drums, hand, line, mel, prog, stabs } from './dsl';

// Rootless voicings keep the stabs light above the bass.
const Gm9 = 'Bb3 D4 F4 A4';
const C9 = 'Bb3 D4 E4 G4';
// Lift voicings a step higher: Gm11 and C9 tops.
const Gm11_TOP = 'D4 F4 A4 C5';
const C9_TOP = 'D4 E4 G4 Bb4';

const HAT = 'o..oo..oo..oo..o';
const OPEN_HAT = '..x...x...x...x.';
const SHAKER = '4263426342634263';
// The hand kit's congas are tuned to G and D: the tonic and fifth of G dorian.
const CONGAS = {
  shaker: SHAKER,
  highConga: '...x.......x....|...x......x.....',
  lowConga: '......xo......x.|......x......x..',
  bongoLo: '...............o|..............xo',
};

export const HOUSE = defineStarter({
  id: 'house',
  name: 'House',
  description: 'A warm four-on-the-floor groove with bouncing bass and off-beat organ stabs.',
  bpm: 124,
  swing: 0.18,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 1,
  root: 7,
  scale: 'dorian',
  scenes: ['Intro', 'Groove', 'Lift', 'Break'],
  reverb: { decay: 2.2, predelay: 18, tone: 6000 },
  delay: { division: 2, feedback: 0.36, tone: 3400 },
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
      sound: 'tight-circuit',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -12.5 },
      macros: { space: 0.06 },
      clips: [
        clip('Hats & Rim', 2, drums(2, { hat: HAT, openHat: OPEN_HAT, rim: '............o...|..........o..o..' })),
        clip(
          'Four Floor',
          2,
          drums(2, {
            kick: 'X...X...X...X...',
            clap: '....x.......x...|....x.......x..o',
            hat: HAT,
            openHat: OPEN_HAT,
            rim: '................|..........o.....',
          }),
        ),
        clip(
          'Floor Rush',
          4,
          drums(4, {
            kick: 'X...X...X...X...',
            clap: '....X.......x...|....X.......x..o',
            hat: 'oo.ooo.ooo.ooo.o',
            openHat: OPEN_HAT,
            ride: 'o...o...o...o...',
          }),
          atBar(3, drums(1, { snare: '............o.ox' })),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'hand-percussion',
      level: -8,
      instrument: { level: -9.5 },
      pan: 0.18,
      macros: { space: 0.2 },
      clips: [
        clip('Shaker', 1, hand(1, { shaker: SHAKER, bongoHi: '.......4.......3' })),
        clip('Congas', 2, hand(2, CONGAS)),
        clip('Congas & Bell', 2, hand(2, { ...CONGAS, cowbell: '....5.......4...|....5.....4.4...' })),
        null,
      ],
    },
    bass: {
      sound: 'bass-rubber-pluck',
      level: -7,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Bounce',
          2,
          line(
            2,
            `. . G1 - . G2? . . . . G1 - . . Bb1 C2 |
             . . C2 - . C3? . . . . C2 - . E2 D2 .`,
          ),
        ),
        clip(
          'Rolling',
          2,
          line(
            2,
            `. G1 G1? G2? . G1 G1? F2? . G1 G1? D2 . Bb1 G1 Bb1 |
             . C2 C2? C3? . C2 C2? Bb2? . C2 C2? G2 . E2 D2 .`,
          ),
        ),
        clip('Held Roots', 4, line(4, 'G1 C2 G1 F1', { unit: 16, gate: 0.96, vel: 0.62 })),
      ],
    },
    chords: {
      sound: 'poly-house-stab',
      level: -2,
      macros: { space: 0.28, echo: 0.1, pump: 0.45 },
      clips: [
        null,
        clip(
          'Stabs',
          4,
          stabs(4, '...x..x-..X..x..|..x...x-...x.x..', [Gm9, C9]),
          // A pushed Gm9 anticipates the loop's return to bar one.
          chord(Gm9, 63, 1, 0.7),
        ),
        clip('Stabs Up', 2, stabs(2, '..X..x..x..x.x..|..X..x..x...x.x.', [Gm11_TOP, C9_TOP])),
        clip(
          'Held',
          4,
          prog(
            [
              ['G3 Bb3 D4 F4 A4', 0, 16, 0.6],
              ['G3 Bb3 D4 E4 A4', 16, 16, 0.58],
              ['G3 Bb3 D4 F4 A4', 32, 16, 0.6],
              ['F3 A3 C4 E4 G4', 48, 16, 0.58],
            ],
            0.96,
          ),
        ),
      ],
    },
    lead: {
      sound: 'poly-mallet-bell',
      level: -6.5,
      pan: -0.12,
      macros: { echo: 0.34, space: 0.25 },
      clips: [
        null,
        null,
        clip(
          'Bell Hook',
          4,
          line(
            4,
            `D5! . . Bb4 . . C5 . . D5 . . F5 - D5 . |
             E5! . . C5 . . D5 . . E5 . . G5 - E5 . |
             D5! . . Bb4 . . C5 . . A4 . . G4 - - - |
             . . . . E5 . D5 . C5 . . . Bb4 - A4 .`,
          ),
        ),
        clip(
          'Bell Echoes',
          4,
          line(
            4,
            `. . . . . . . . D5 . . . . . . . |
             . . . . . . . . E5 . . . G5 . . . |
             . . . . . . . . D5 . . . A4 . . . |
             . . . . . . . . . . . . G4 - - -`,
            { vel: 0.62 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-warm-drift',
      level: -10.5,
      macros: { space: 0.5, pump: 0.35, motion: 0.25 },
      lfo: { division: 1 },
      clips: [
        clip('Soft Bed', 4, line(4, 'G3+Bb3+D4+F4 G3+Bb3+D4+E4 A3+Bb3+D4+F4 G3+Bb3+C4+E4', { unit: 16, gate: 0.98, vel: 0.55 })),
        null,
        clip('Warm Bed', 4, line(4, 'Bb3+D4+F4+A4 Bb3+D4+E4+G4 Bb3+D4+F4+A4 C4+E4+G4+A4', { unit: 16, gate: 0.98, vel: 0.62 })),
        clip('Swell', 4, line(4, 'D4+F4+A4+C5 E4+G4+A4+D5 D4+F4+A4+D5 E4+G4+A4+C5', { unit: 16, gate: 0.98, vel: 0.66 })),
      ],
    },
    texture: {
      sound: 'poly-air-grain',
      level: -10.5,
      macros: { motion: 0.5, space: 0.6 },
      lfo: { division: 0 },
      clips: [
        clip(
          'Air',
          4,
          mel([
            ['D5', 0, 31, 0.5],
            ['A4', 32, 15, 0.45],
            ['G4', 48, 15, 0.45],
          ]),
        ),
        null,
        null,
        clip(
          'Air Drift',
          4,
          mel([
            ['A5', 0, 31, 0.45],
            ['G5', 32, 15, 0.42],
            ['E5', 48, 15, 0.42],
          ]),
        ),
      ],
    },
    sampler: {
      sound: 'builtin:vocal-oh',
      name: 'Vocal',
      level: -20.5,
      pan: 0.1,
      macros: { echo: 0.3, space: 0.3 },
      clips: [
        null,
        null,
        clip(
          'Oh Chops',
          2,
          mel([
            ['D4', 2, 2],
            ['F4', 7, 1, 0.6],
            ['D4', 10, 3],
            ['E4', 18, 2],
            ['G4', 23, 1, 0.6],
            ['E4', 26, 2],
            ['D4', 29, 2, 0.7],
          ]),
        ),
        clip(
          'Long Oh',
          4,
          // Near C4, where the built-in "oh" was recorded, so the voice keeps its natural formants.
          mel([
            ['A3', 8, 8, 0.7],
            ['G3', 40, 8, 0.65],
          ]),
        ),
      ],
    },
  },
});
