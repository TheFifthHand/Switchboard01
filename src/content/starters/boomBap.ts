/**
 * Boom Bap — 90 BPM, D Dorian, lightly swung (0.18). A hard, dusty break
 * beat under a two-chord soul loop on electric piano: Dm9 to G13, where only
 * one voice moves (C down to B). The Lift climbs Fmaj9, G13, Am7, Dm9 under
 * short horn stabs. The bass only plays D, F, G, A and C: never E or B, the
 * notes a semitone under the chords' F and C, so any bass clip sits under
 * any chord clip. A glass-chord stab (a minor-seventh chord on every note)
 * answers on D, where all four of its notes are tones of Dm9.
 */
import { clip, defineStarter, drums, hand, line, mel, stabs, strum } from './dsl';

const DM9 = 'F3 A3 C4 E4';
const G13 = 'F3 A3 B3 E4';
const FMAJ9 = 'A3 C4 E4 G4';
const AM7 = 'G3 A3 C4 E4';
const CMAJ9 = 'E3 G3 B3 D4';

const plus = (v: string) => v.replace(/ /g, '+');

export const BOOM_BAP = defineStarter({
  id: 'boomBap',
  name: 'Boom Bap',
  description: 'A hard, dusty head-nod beat with soulful electric piano, horn stabs and a sampled chord hit.',
  bpm: 90,
  swing: 0.18,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 0.5,
  root: 2,
  scale: 'dorian',
  scenes: ['Intro', 'Verse', 'Hook', 'Break'],
  reverb: { decay: 1.8, predelay: 12, tone: 4800 },
  delay: { division: 2, feedback: 0.35, tone: 2600 },
  arrangement: [
    [0, 2],
    [1, 4],
    [2, 2],
    [3, 2],
    [1, 2],
    [2, 2],
  ],
  tailSeconds: 4,
  parts: {
    drums: {
      sound: 'break-crate',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -11 },
      macros: { space: 0.08 },
      clips: [
        clip('Hats & Rim', 2, drums(2, { hat: '7.5.7.5.7.5.7.56', rim: '....6.......6...|....6.......6..4' })),
        clip(
          'Head Nod',
          2,
          drums(2, {
            kick: 'X.........X..x..|X......x..X.....',
            snare: '....X.......X...',
            hat: '7.5.7.5.7.5.7.56',
          }),
        ),
        clip(
          'Hook Beat',
          2,
          drums(2, {
            kick: 'X......x.xX.....|X.x.......X..x..',
            snare: '....X.......X..o|....X..o....X...',
            hat: 'x.xox.x.x.xox.x.',
            openHat: '................|..............x.',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'hand-percussion',
      level: -9,
      instrument: { level: -4.5 },
      pan: 0.22,
      macros: { space: 0.18 },
      // The hand kit's congas are tuned to G and D: the fourth and the tonic of D Dorian.
      clips: [
        clip('Shaker', 1, hand(1, { shaker: '4.3.4.3.4.3.4.3.' })),
        clip('Tambourine', 2, hand(2, { tambourine: '....x.......x...', shaker: '4.3.4.3.4.3.4.3.' })),
        clip('Bongos', 2, hand(2, { tambourine: '....x.......x...', bongoHi: '..o...o...o..o..|..o...o.o.o.....', highConga: '.......x........|.......x......x.' })),
        null,
      ],
    },
    bass: {
      sound: 'bass-finger',
      level: -7,
      macros: { space: 0, tone: 0.42 },
      clips: [
        null,
        clip(
          'Thump',
          4,
          line(
            4,
            `D2 - - - - - . . . . D2 - A1 - . . |
             D2 - - - - - . . . . F2 - D2 - C2 - |
             G1 - - - - - . . . . G1 - D2 - . . |
             G1 - - - - - . . . . A1 - C2 - . .`,
          ),
        ),
        clip(
          'Hook Thump',
          4,
          line(
            4,
            `F1 - - - - - . . . . F1 - C2 - . . |
             G1 - - - - - . . . . G1 - D2 - . . |
             A1 - - - - - . . . . A1 - G1 - . . |
             D2 - - - - - . . . . A1 - C2 - D2 -`,
          ),
        ),
        clip('Slow Roots', 4, line(4, 'F1 C2 D2 D2', { unit: 16, gate: 0.94, vel: 0.6 })),
      ],
    },
    chords: {
      sound: 'poly-tine-piano',
      name: 'Keys',
      level: -5,
      pan: -0.1,
      macros: { space: 0.25, echo: 0.12 },
      clips: [
        clip('Intro Keys', 4, strum(DM9, 0, 30, 0.5, 0.55), strum(G13, 32, 30, 0.5, 0.55)),
        clip('Soul Loop', 4, stabs(4, 'X-------..x-----', [DM9, DM9, G13, G13], { gate: 0.94 })),
        clip('Hook Keys', 4, stabs(4, 'X-----x---..x---', [FMAJ9, G13, AM7, DM9], { gate: 0.92 })),
        clip('Break Keys', 4, strum(FMAJ9, 0, 15, 0.6, 0.55), strum(CMAJ9, 16, 15, 0.6, 0.55), strum(DM9, 32, 31, 0.6, 0.55)),
      ],
    },
    lead: {
      sound: 'poly-brass-stab',
      name: 'Horns',
      level: -2,
      pan: 0.1,
      macros: { echo: 0.22, space: 0.25 },
      clips: [
        null,
        null,
        clip(
          'Horn Stabs',
          4,
          line(
            4,
            `. . A4! . . A4 . C5 - . A4 . G4 . . . |
             . . B4! . . B4 . D5 - . B4 . A4 . . . |
             . . C5! . . C5 . E5 - . C5 . A4 . . . |
             . . F5! . . E5 . D5 - . C5 . A4 . . .`,
            { gate: 0.6 },
          ),
        ),
        clip(
          'Horn Echo',
          4,
          line(
            4,
            `. . . . A4 - - - . . . . E5 . . . |
             . . . . G4 - - - . . . . D5 . . . |
             . . . . D5 - - - . . . . A4 . . . |
             . . . . A4 - - - - - - - . . . .`,
            { vel: 0.6, gate: 0.9 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-string-ensemble',
      name: 'Strings',
      level: -9.5,
      macros: { space: 0.5 },
      // The strings double the keys' own voicings, so the two never rub.
      clips: [
        clip('Intro Strings', 4, line(4, `${plus(DM9)} - ${plus(G13)} -`, { unit: 16, gate: 0.98, vel: 0.5 })),
        null,
        clip('Hook Strings', 4, line(4, `${plus(FMAJ9)} ${plus(G13)} ${plus(AM7)} ${plus(DM9)}`, { unit: 16, gate: 0.98, vel: 0.5 })),
        clip('Break Strings', 4, line(4, `${plus(FMAJ9)} ${plus(CMAJ9)} ${plus(DM9)} -`, { unit: 16, gate: 0.98, vel: 0.58 })),
      ],
    },
    texture: {
      sound: 'poly-air-grain',
      name: 'Vinyl Air',
      level: -12,
      macros: { motion: 0.35, space: 0.5, tone: 0.4 },
      lfo: { division: 0 },
      // A is a tone of Dm9 and G13 and a semitone from neither.
      clips: [clip('Vinyl Air', 4, mel([['A4', 0, 64, 0.45]])), null, null, clip('Break Air', 4, mel([['A4', 0, 31, 0.42], ['D5', 32, 31, 0.4]]))],
    },
    sampler: {
      sound: 'builtin:glass-chord',
      name: 'Chord Hit',
      level: -9,
      pan: 0.15,
      macros: { echo: 0.2, space: 0.25 },
      // On D3 the hit plays D, F, A and C: Dm9 without its ninth, so it only answers over the Dm9 bars.
      clips: [
        null,
        clip(
          'Chord Hits',
          4,
          mel([
            ['D3', 0, 2, 0.8],
            ['D3', 11, 2, 0.6],
            ['D3', 22, 2, 0.7],
          ]),
        ),
        null,
        clip('Last Hit', 4, mel([['D3', 32, 4, 0.7]])),
      ],
    },
  },
});
