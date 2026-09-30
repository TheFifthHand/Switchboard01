/**
 * Garage — 136 BPM, A minor, shuffled (swing 0.45). A skippy two-step beat,
 * hollow organ bass and short plucked minor-ninth stabs (Am9 to Dm9). The
 * Lift moves to Fmaj9 and G6/9: Am9 over an F bass is Fmaj9#11 and Dm9 over
 * G is G13sus, so every bass and chord clip fits every other row. Swing
 * pushes the off-beat sixteenths of hats, stabs and vocal chops.
 */
import { clip, defineStarter, drums, hand, line, mel, stabs } from './dsl';

const AM9 = 'C4 E4 G4 B4';
const DM9 = 'C4 E4 F4 A4';
const FMAJ9 = 'C4 E4 G4 A4';
const G69 = 'B3 D4 E4 A4';

const HAT = '.4x4.4x4.4x4.4x4';
const SHAKER = '4262426242624262';
// Clave and bongo answers on the swung sixteenths.
const SHUFFLE = {
  shaker: SHAKER,
  clave: '...x......x..x..|......x...x.....',
  bongoHi: '.......o........|...o.......o....',
};

export const GARAGE = defineStarter({
  id: 'garage',
  name: 'Garage',
  description: 'A skippy, shuffled two-step with organ bass, short plucked chords and vocal chops.',
  bpm: 136,
  swing: 0.45,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 3.5,
  root: 9,
  scale: 'minor',
  scenes: ['Intro', 'Two-Step', 'Lift', 'Break'],
  reverb: { decay: 1.9, predelay: 12, tone: 7000 },
  delay: { division: 2, feedback: 0.35, tone: 3800 },
  arrangement: [
    [0, 2],
    [1, 8],
    [2, 4],
    [3, 2],
    [2, 4],
    [1, 4],
  ],
  tailSeconds: 3,
  parts: {
    drums: {
      sound: 'bright-steel',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -13 },
      macros: { space: 0.06 },
      clips: [
        clip('Hats & Rims', 2, drums(2, { hat: HAT, rim: '....x.......x...|....x.......x..o' })),
        clip(
          'Two-Step',
          2,
          drums(2, {
            kick: 'X.........X.....|X.......o.x..o..',
            snare: '....X.......X...',
            hat: HAT,
          }),
        ),
        clip(
          'Skippy',
          2,
          drums(2, {
            kick: 'X.........X.....|X......X..X...o.',
            snare: '....X.......X...|....X.......X..o',
            clap: '....x.......x...',
            hat: '.4x4.4x4.4x4.4.4',
            openHat: '..............x.',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'hand-percussion',
      level: -8,
      instrument: { level: -7 },
      pan: 0.2,
      macros: { space: 0.15 },
      clips: [
        clip('Shaker', 1, hand(1, { shaker: SHAKER })),
        clip('Shuffle Perc', 2, hand(2, SHUFFLE)),
        clip(
          'Shuffle Perc Up',
          2,
          hand(2, {
            ...SHUFFLE,
            lowConga: '.............x..|.........x...x..',
            cowbell: '..........4.....',
          }),
        ),
        null,
      ],
    },
    bass: {
      sound: 'bass-organ-short',
      level: -9,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Organ Bass',
          2,
          line(
            2,
            `A1! - . . . . . A1 . . A1 - . C2 . D2 |
             D2! - . . . . . D2 . . D2 - . F2 . E2`,
            { gate: 0.75 },
          ),
        ),
        clip(
          'Lift Bass',
          2,
          line(
            2,
            `F1! - . . . . . F2? . . F1 - . A1 . C2 |
             G1! - . . . . . G2? . . G1 - . A1 . D2`,
            { gate: 0.75 },
          ),
        ),
        clip('Break Bass', 4, line(4, 'A1 D2 F1 G1', { unit: 16, gate: 0.95, vel: 0.6 })),
      ],
    },
    chords: {
      sound: 'poly-short-pluck',
      name: 'Stabs',
      level: -2,
      macros: { space: 0.25, echo: 0.15, pump: 0.3 },
      clips: [
        null,
        clip('Short Stabs', 2, stabs(2, '...x...x..x...x.|.x....x...x..x..', [AM9, DM9], { gate: 0.6 })),
        clip('Lift Stabs', 2, stabs(2, '.x..x..x..x.x...|.x..x..x...x.x..', [FMAJ9, G69], { gate: 0.6 })),
        clip('Break Stabs', 4, stabs(4, 'x.....o.....o...', [AM9, DM9, FMAJ9, G69], { gate: 0.7 })),
      ],
    },
    lead: {
      sound: 'poly-glass-keys',
      name: 'Keys',
      level: -6.5,
      pan: -0.12,
      macros: { echo: 0.3, space: 0.3 },
      clips: [
        null,
        null,
        clip(
          'Keys Hook',
          4,
          line(
            4,
            `. . E5 . . C5 . A4 - . . G4 . A4 . . |
             . . D5 . . B4 . G4 - . . E4 . G4 . . |
             . . E5 . . C5 . A4 - . . C5 . E5 . G5 |
             - - D5 . . B4 . A4 - - - . . . . .`,
          ),
        ),
        clip(
          'Keys Echo',
          4,
          line(
            4,
            `. . . . E5 . . . . . . . B4 . . . |
             . . . . F5 . . . . . . . . . . . |
             . . . . E5 . . . C5 . . . . . . . |
             . . . . D5 - - - B4 - - - . . . .`,
            { vel: 0.58 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-lumen-chords',
      name: 'Pad',
      level: -11.5,
      macros: { space: 0.45, pump: 0.4, motion: 0.2 },
      lfo: { division: 1 },
      clips: [
        clip('Intro Pad', 4, line(4, 'A3+C4+E4+G4 A3+C4+D4+F4 A3+C4+E4+B4 A3+D4+E4+F4', { unit: 16, gate: 0.98, vel: 0.55 })),
        null,
        clip('Lift Pad', 2, line(2, 'A3+C4+E4+G4 B3+D4+E4+A4', { unit: 16, gate: 0.98, vel: 0.58 })),
        clip('Break Pad', 4, line(4, 'E3+A3+C4+G4 F3+A3+C4+E4 F3+A3+C4+G4 E3+G3+B3+D4', { unit: 16, gate: 0.98, vel: 0.62 })),
      ],
    },
    texture: {
      sound: 'poly-night-choir',
      name: 'Choir',
      level: -14.5,
      macros: { motion: 0.45, space: 0.6 },
      lfo: { division: 0 },
      clips: [
        clip(
          'Choir In',
          4,
          mel([
            ['E4', 0, 32, 0.4],
            ['A4', 32, 32, 0.38],
          ]),
        ),
        null,
        null,
        clip(
          'Choir Break',
          4,
          mel([
            ['A4', 0, 32, 0.4],
            ['G4', 32, 16, 0.38],
            ['B4', 48, 16, 0.38],
          ]),
        ),
      ],
    },
    sampler: {
      sound: 'builtin:vocal-oh',
      name: 'Vocal',
      level: -22,
      pan: 0.1,
      macros: { echo: 0.3, space: 0.25 },
      clips: [
        null,
        null,
        clip(
          'Oh Chops',
          2,
          // Kept within a fifth of C4, where the built-in "oh" was recorded.
          mel([
            ['A3', 3, 2],
            ['C4', 7, 1, 0.6],
            ['A3', 10, 2],
            ['E4', 14, 2, 0.7],
            ['B3', 19, 2],
            ['D4', 23, 1, 0.6],
            ['B3', 26, 2],
            ['G3', 30, 2, 0.7],
          ]),
        ),
        clip(
          'Oh Break',
          4,
          mel([
            ['A3', 8, 8, 0.65],
            ['G3', 40, 8, 0.6],
          ]),
        ),
      ],
    },
  },
});
