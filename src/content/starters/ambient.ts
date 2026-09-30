/**
 * Ambient — 72 BPM, E lydian. Slow, spacious layers over Emaj9, F#/E, C#m9
 * and Badd9: the raised fourth (A#) of the second chord gives the lydian glow.
 * Texture loops are three bars long against four-bar harmony, so the layers
 * drift into new combinations each time round. Texture notes come from the
 * B major pentatonic set, which sits over every chord.
 */
import { HAND, chord, clip, defineStarter, drums, hand, line, mel, strum } from './dsl';

export const AMBIENT = defineStarter({
  id: 'ambient',
  name: 'Ambient',
  description: 'Slow, glowing layers that drift and overlap, with a soft heartbeat underneath.',
  bpm: 72,
  swing: 0,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 0,
  root: 4,
  scale: 'lydian',
  scenes: ['Float', 'Pulse', 'Bloom', 'Drift'],
  reverb: { decay: 7, predelay: 45, tone: 5500 },
  delay: { division: 4, feedback: 0.55, tone: 2800, width: 0.8 },
  arrangement: [
    [0, 2],
    [1, 2],
    [2, 4],
    [3, 2],
    [2, 2],
    [0, 1],
  ],
  tailSeconds: 5,
  parts: {
    drums: {
      sound: 'round-machine',
      level: -4,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -10.5 },
      macros: { space: 0.25, tone: 0.42 },
      clips: [
        null,
        clip(
          'Heartbeat',
          2,
          drums(2, {
            kick: '7.........5.....|7.......4.....5.',
            rim: '....5.......5..3|....5.......5...',
            hat: '..3...3...3...3.',
          }),
        ),
        clip(
          'Heartbeat Ride',
          2,
          drums(2, {
            kick: '7.........5.....|7.......4.....5.',
            rim: '....6.......6..3|....6.....3.6...',
            hat: '..3...3...3...3.',
            ride: '4...3...4...3...',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'hand-percussion',
      level: -9,
      instrument: { level: -3 },
      pan: 0.22,
      macros: { space: 0.35 },
      // The hand drums are tuned to G and D; a semitone up puts them on G# and D#, inside E lydian.
      drumVoices: {
        [HAND.lowConga]: { tune: 1 },
        [HAND.highConga]: { tune: 1 },
        [HAND.bongoLo]: { tune: 1 },
        [HAND.bongoHi]: { tune: 1 },
      },
      clips: [
        null,
        clip('Shakers', 2, hand(2, { shaker: '3.2.3.2.3.2.3.2.', bongoHi: '...........3....|......3.........', lowConga: '................|..............3.' })),
        clip(
          'Shakers & Agogo',
          2,
          hand(2, { shaker: '3232323232323232', bongoHi: '...........3....|......3.........', lowConga: '................|..............3.', agogoLo: '4...............|........3.......' }),
        ),
        null,
      ],
    },
    bass: {
      sound: 'bass-round-sub',
      level: -12.5,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Roots',
          4,
          mel([
            ['E2', 0, 31, 0.7],
            ['C#2', 32, 15, 0.7],
            ['B1', 48, 15, 0.7],
          ]),
        ),
        clip(
          'Moving Roots',
          4,
          line(
            4,
            `E2 - - - - - - - - - E2? - - - - - |
             E2 - - - - - - - F#2 - - - G#2 - - - |
             C#2 - - - - - - - - - C#2? - - - - - |
             B1 - - - - - - - - - C#2 - D#2 - - -`,
            { gate: 0.95, vel: 0.7 },
          ),
        ),
        clip('Drone', 4, mel([['E1', 0, 64, 0.5]])),
      ],
    },
    chords: {
      sound: 'poly-glass-keys',
      level: -2,
      pan: -0.1,
      macros: { space: 0.5, echo: 0.25 },
      clips: [
        null,
        clip(
          'Keys',
          4,
          strum('G#3 B3 D#4 F#4', 0, 10, 0.5, 0.6),
          chord('B3 D#4', 10, 5, 0.42),
          strum('A#3 C#4 E4 F#4', 16, 10, 0.5, 0.6),
          chord('C#4 E4', 26, 5, 0.42),
          strum('G#3 B3 D#4 E4', 32, 10, 0.5, 0.6),
          chord('B3 E4', 42, 5, 0.42),
          strum('F#3 B3 C#4 D#4', 48, 14, 0.5, 0.6),
        ),
        clip(
          'Ostinato',
          4,
          line(
            4,
            `B4 F#4 D#5 F#4 B4 . G#4 . |
             C#5 F#4 E5 F#4 C#5 . A#4 . |
             B4 E4 D#5 E4 B4 . G#4 . |
             C#5 F#4 D#5 F#4 B4 . F#4 .`,
            { unit: 2, gate: 1.5, vel: 0.52 },
          ),
        ),
        clip(
          'Rolled',
          4,
          strum('E3 B3 D#4 G#4', 0, 16, 1, 0.5),
          strum('E3 A#3 C#4 F#4', 16, 16, 1, 0.5),
          strum('C#3 G#3 B3 E4', 32, 16, 1, 0.5),
          strum('D#3 F#3 B3 C#4', 48, 16, 1, 0.5),
        ),
      ],
    },
    lead: {
      sound: 'poly-soft-whistle',
      level: -7,
      pan: 0.1,
      macros: { echo: 0.45, space: 0.55 },
      clips: [
        null,
        null,
        clip(
          'Whistle',
          4,
          line(
            4,
            `B4 - - - - - - - G#4 - - - F#4 - - - |
             A#4 - - - - - - - C#5 - - - - - - - |
             B4 - - - - - - - G#4 - - - E4 - - - |
             D#4 - - - F#4 - - - - - - - . . . .`,
            { gate: 0.95, vel: 0.7 },
          ),
        ),
        clip(
          'Far Whistle',
          4,
          line(
            4,
            `. . . . . . . . F#5 - - - - - - - |
             . . . . . . . . . . . . . . . . |
             . . . . E5 - - - - - - - - - - - |
             . . . . . . . . D#5 - - - - - - -`,
            { gate: 0.95, vel: 0.55 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-halo-pad',
      level: -3,
      macros: { space: 0.7, motion: 0.35 },
      lfo: { division: 0 },
      clips: [
        clip('Float', 4, line(4, 'E3+B3+F#4+G#4 E3+A#3+C#4+F#4 C#3+G#3+B3+E4 B2+F#3+C#4+D#4', { unit: 16, gate: 0.99, vel: 0.55 })),
        clip('Pulse Bed', 4, line(4, 'G#3+B3+D#4+F#4 A#3+C#4+E4+F#4 G#3+B3+E4+G#4 F#3+B3+C#4+D#4', { unit: 16, gate: 0.99, vel: 0.55 })),
        clip('Bloom Bed', 4, line(4, 'B3+D#4+F#4+B4 C#4+F#4+A#4+C#5 B3+E4+G#4+B4 B3+D#4+F#4+C#5', { unit: 16, gate: 0.99, vel: 0.6 })),
        clip('Drift Bed', 4, line(4, 'E3+B3+D#4+G#4 E3+A#3+C#4+G#4 E3+G#3+B3+C#4 D#3+F#3+B3+C#4', { unit: 16, gate: 0.99, vel: 0.58 })),
      ],
    },
    texture: {
      sound: 'poly-night-choir',
      name: 'Choir',
      level: -9.5,
      macros: { motion: 0.5, space: 0.75 },
      lfo: { division: 1 },
      clips: [
        clip(
          'Choir Glints',
          3,
          mel([
            ['F#4', 0, 22, 0.42],
            ['C#5', 24, 22, 0.38],
          ]),
        ),
        null,
        clip(
          'Choir Bloom',
          3,
          mel([
            ['B4', 0, 14, 0.42],
            ['G#4', 16, 14, 0.38],
            ['D#5', 32, 14, 0.4],
          ]),
        ),
        clip(
          'Choir Drift',
          3,
          mel([
            ['F#4', 0, 46, 0.4],
            ['B4', 8, 38, 0.36],
          ]),
        ),
      ],
    },
    sampler: {
      sound: 'builtin:bell-hit',
      name: 'Bells',
      level: -8.5,
      pan: 0.15,
      macros: { space: 0.6, echo: 0.3 },
      clips: [
        // The bell's strongest overtones are a minor third and a fifth above
        // its note; on G#, C# and D# both stay inside E lydian.
        clip(
          'Bells',
          4,
          mel([
            ['G#4', 0, 12, 0.6],
            ['D#4', 22, 12, 0.5],
            ['C#5', 40, 12, 0.55],
            ['G#4', 54, 10, 0.45],
          ]),
        ),
        null,
        null,
        clip(
          'Bells Far',
          4,
          mel([
            ['C#5', 8, 12, 0.5],
            ['D#4', 36, 12, 0.5],
          ]),
        ),
      ],
    },
  },
});
