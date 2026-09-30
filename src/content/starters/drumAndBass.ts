/**
 * Drum and Bass — 174 BPM, C# minor. A crisp two-step with ghost-note
 * percussion, a deep sub moving every two bars and liquid electric-piano
 * chords (C#m9, Amaj9, B6). The Drop swaps the tonic for F#m9: over a C#
 * bass it reads as F#m/C#, and C#m9 over F# reads as F#13sus, so bass and
 * chord clips from any row stay consonant. Restraint: long chords, sparse
 * melody, drums doing the running.
 */
import { clip, defineStarter, drums, line, mel, stabs, strum } from './dsl';

const CSM9 = 'B3 D#4 E4 G#4';
const AMAJ9 = 'B3 C#4 E4 G#4';
const B6 = 'B3 D#4 F#4 G#4';
const FSM9 = 'A3 C#4 E4 G#4';

const TWO_STEP = {
  kick: 'X.........X.....|..X.......X.....',
  snare: '....X.......X...|....X.......X..o',
  hat: '6.4.6.4.6.4.6.44',
};

export const DRUM_AND_BASS = defineStarter({
  id: 'drumAndBass',
  name: 'Drum and Bass',
  description: 'Fast, crisp drums over a deep sub and liquid electric-piano chords.',
  bpm: 174,
  swing: 0,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: -5.5,
  root: 1,
  scale: 'minor',
  scenes: ['Intro', 'Roll', 'Drop', 'Float'],
  reverb: { decay: 2.6, predelay: 20, tone: 6000 },
  delay: { division: 4, feedback: 0.4, tone: 3000 },
  arrangement: [
    [0, 2],
    [1, 4],
    [2, 6],
    [3, 2],
    [2, 6],
    [1, 2],
  ],
  tailSeconds: 4,
  parts: {
    drums: {
      sound: 'bright-steel',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -4 },
      macros: { space: 0.1 },
      clips: [
        clip('Ride & Rim', 2, drums(2, { ride: '5.3.5.3.5.3.5.3.', rim: '....o.......o...|....o.......o..o' })),
        clip('Two-Step', 2, drums(2, TWO_STEP)),
        clip(
          'Two-Step Drive',
          2,
          drums(2, {
            ...TWO_STEP,
            snare: '....X..o..o.X...|.o..X..o....X.o.',
            openHat: '..............x.|..............x.',
            hat: '6.4.6.4.6.4.6...',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'dust-tape',
      name: 'Ghost Kit',
      level: -8,
      instrument: { level: 0.5 },
      pan: 0.15,
      macros: { space: 0.15 },
      clips: [
        clip('Dust Shaker', 1, drums(1, { shaker: '3232323232323232' })),
        clip('Ghost Break', 2, drums(2, { shaker: '3232323232323232', snare: '.......o.o......|..o....o......o.' })),
        clip(
          'Ghost Break Ride',
          2,
          drums(2, { shaker: '3232323232323232', snare: '.......o.o......|..o....o......o.', ride: '..x...x...x...x.', perc: '.............o..|...........o....' }),
        ),
        null,
      ],
    },
    bass: {
      sound: 'bass-round-sub',
      name: 'Sub',
      level: -4.5,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Sub',
          4,
          line(
            4,
            `C#2 - - - - - . . . . C#2 - - - . . |
             . . C#2 - - - - - . . E2 - - - B1 - |
             A1 - - - - - . . . . A1 - - - . . |
             . . B1 - - - - - . . B1 - - - G#1 -`,
            { gate: 0.95 },
          ),
        ),
        clip(
          'Sub Drop',
          4,
          line(
            4,
            `F#1 - - - - - . . . . F#1 - - - . . |
             . . F#1 - - - - - . . A1 - - - C#2 - |
             A1 - - - - - . . . . A1 - - - . . |
             . . B1 - - - - - . . B1 - - - C#2 -`,
            { gate: 0.95 },
          ),
        ),
        clip('Float Sub', 4, line(4, 'C#2 - A1 B1', { unit: 16, gate: 0.96, vel: 0.6 })),
      ],
    },
    chords: {
      sound: 'poly-glass-keys',
      name: 'Keys',
      level: -3.5,
      pan: -0.12,
      macros: { space: 0.45, echo: 0.18 },
      clips: [
        null,
        clip('Liquid Keys', 4, stabs(4, 'X-----...x---...', [CSM9, CSM9, AMAJ9, B6], { gate: 0.95 })),
        clip('Drop Keys', 4, stabs(4, '..x---..x---x---', [FSM9, FSM9, AMAJ9, B6], { gate: 0.92 })),
        clip(
          'Float Keys',
          4,
          strum('C#3 G#3 B3 D#4 E4', 0, 31, 0.5, 0.55),
          strum('E3 G#3 B3 C#4', 32, 15, 0.5, 0.52),
          strum('D#3 F#3 B3 C#4', 48, 15, 0.5, 0.52),
        ),
      ],
    },
    lead: {
      sound: 'poly-soft-whistle',
      level: -2,
      pan: 0.1,
      macros: { echo: 0.35, space: 0.5 },
      clips: [
        null,
        null,
        clip(
          'Whistle',
          4,
          line(
            4,
            `C#5 - - - - - E5 - G#5 - - - - - - - |
             F#5 - - - E5 - - - C#5 - - - - - - - |
             B4 - - - - - C#5 - E5 - - - - - - - |
             D#5 - - - - - - - C#5 - - - B4 - - -`,
            { gate: 0.95, vel: 0.7 },
          ),
        ),
        clip(
          'Whistle Float',
          4,
          line(
            4,
            `. . . . G#4 - - - - - - - - - - - |
             . . . . . . . . E4 - - - - - - - |
             . . . . . . . . C#5 - - - - - - - |
             . . . . B4 - - - - - - - . . . .`,
            { gate: 0.95, vel: 0.55 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-warm-drift',
      level: -3.5,
      macros: { space: 0.6, motion: 0.3 },
      lfo: { division: 1 },
      clips: [
        clip('Intro Pad', 4, line(4, 'C#3+G#3+B3+E4 - A2+E3+G#3+C#4 B2+F#3+G#3+D#4', { unit: 16, gate: 0.98, vel: 0.55 })),
        null,
        clip('Drop Pad', 4, line(4, 'A3+C#4+E4+G#4 - A3+B3+E4+G#4 B3+D#4+F#4+G#4', { unit: 16, gate: 0.98, vel: 0.6 })),
        clip('Float Pad', 4, line(4, 'E3+G#3+B3+D#4 - E3+G#3+B3+C#4 D#3+F#3+B3+C#4', { unit: 16, gate: 0.98, vel: 0.62 })),
      ],
    },
    texture: {
      sound: 'poly-tape-shimmer',
      level: -5,
      macros: { motion: 0.5, space: 0.7 },
      lfo: { division: 0 },
      clips: [
        clip(
          'Glints',
          4,
          mel([
            ['G#5', 0, 32, 0.4],
            ['E5', 32, 16, 0.36],
            ['D#5', 48, 16, 0.36],
          ]),
        ),
        null,
        null,
        clip(
          'Float Glints',
          4,
          mel([
            ['D#6', 0, 16, 0.35],
            ['B5', 16, 16, 0.35],
            ['C#6', 32, 16, 0.35],
            ['F#5', 48, 16, 0.35],
          ]),
        ),
      ],
    },
    sampler: {
      sound: 'builtin:noise-riser',
      name: 'Riser',
      level: -6,
      macros: { space: 0.4 },
      // The riser is unpitched noise: a root note of C#4 plays it at its
      // original speed from the key's tonic. Its 2 s span about 23 steps at
      // 174 BPM, so it starts at step 41 and peaks on the next downbeat.
      instrument: { rootNote: 61 },
      clips: [clip('Riser', 4, mel([['C#4', 41, 23, 0.7]])), null, null, clip('Riser', 4, mel([['C#4', 41, 23, 0.8]]))],
    },
  },
});
