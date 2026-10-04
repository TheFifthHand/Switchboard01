/**
 * Downtempo — 84 BPM, E♭ major, swung. A lazy, dusty beat with electric-piano
 * chords (Ebmaj9, Cm9, Abmaj9, Bb13sus) over a warm bass. The Lift climbs
 * Fm9, Abmaj9, Bb9, Cm9. No bass line in any row plays D or G, the two notes
 * a semitone under Eb and Ab, so every bass clip sits under every chord clip
 * even when a tapped clip starts mid-phrase (clips launch on the next bar,
 * not the next four-bar phrase). Soft air and tape swells keep the texture warm.
 */
import { clip, defineStarter, drums, hand, line, mel, stabs, strum } from './dsl';

const EBMAJ9 = 'G3 Bb3 D4 F4';
const CM9 = 'G3 Bb3 D4 Eb4';
const ABMAJ9 = 'G3 Bb3 C4 Eb4';
const BB13SUS = 'Ab3 C4 Eb4 G4';
const FM9 = 'Ab3 C4 Eb4 G4';
const BB9 = 'Ab3 C4 D4 F4';

const HAT = '6.3.6.346.3.6.34';
const SHAKER = '4232423242324232';
const CONGAS = {
  shaker: SHAKER,
  highConga: '......x.......o.|......x...x.....',
  lowConga: '...............x|..............o.',
};

export const DOWNTEMPO = defineStarter({
  id: 'downtempo',
  name: 'Downtempo',
  description: 'A relaxed, swung beat with warm electric-piano chords and a soft, dusty haze.',
  bpm: 84,
  swing: 0.3,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: -2.5,
  root: 3,
  scale: 'major',
  scenes: ['Intro', 'Sway', 'Lift', 'Haze'],
  reverb: { decay: 2.4, predelay: 20, tone: 4500 },
  delay: { division: 2, feedback: 0.45, tone: 2500 },
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
      sound: 'dust-tape',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -11.5 },
      macros: { tone: 0.4, drive: 0.2, space: 0.15 },
      clips: [
        clip('Rim & Hat', 2, drums(2, { hat: HAT, rim: '....6.......6...|....6.......6..3' })),
        clip(
          'Lazy Beat',
          2,
          drums(2, {
            kick: 'X......o..X.....|X.........X..o..',
            snare: '....X..o....X...|....X......oX...',
            hat: HAT,
          }),
        ),
        clip(
          'Lift Beat',
          2,
          drums(2, {
            kick: 'X......o..X.....|X.........X..x..',
            snare: '....X..o....X...|....X......oX..o',
            clap: '....o.......o...',
            hat: '6.3.6.346.3.6.34|6.3.6.346.3.6...',
            openHat: '................|..............x.',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'hand-percussion',
      level: -8,
      instrument: { level: -4 },
      pan: -0.2,
      macros: { space: 0.25 },
      // Congas sit on G and D (the third and seventh of Eb); the clave rings near Eb.
      clips: [
        clip('Shaker', 1, hand(1, { shaker: SHAKER })),
        clip('Congas', 2, hand(2, CONGAS)),
        clip('Congas & Clave', 2, hand(2, { ...CONGAS, clave: '..4.............|..4.......3.....' })),
        null,
      ],
    },
    bass: {
      sound: 'bass-dub-pressure',
      level: -8.5,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Warm Line',
          4,
          line(
            4,
            `Eb2 - - - - - - . . . Bb1 - Eb2 - . . |
             C2 - - - - - - . . . Bb1 - C2 - . . |
             Ab1 - - - - - - . . . Eb2 - Ab1 - . . |
             Bb1 - - - - - - . . . F1 - Bb1 - C2 -`,
            { gate: 0.9 },
          ),
        ),
        clip(
          'Lift Line',
          4,
          line(
            4,
            `F1 - - - - - . . . . C2 - F2? - Eb2 - |
             Ab1 - - - - - . . . . Eb2 - Ab2? - F2 - |
             Bb1 - - - - - . . . . F2 - Bb1 - Ab1 - |
             C2 - - - - - . . . . Bb1 - C3? - Eb2 -`,
            { gate: 0.9 },
          ),
        ),
        clip('Haze Roots', 4, line(4, 'Eb2 C2 Ab1 Bb1', { unit: 16, gate: 0.95, vel: 0.6 })),
      ],
    },
    chords: {
      sound: 'poly-glass-keys',
      name: 'Keys',
      level: -4,
      pan: 0.1,
      macros: { space: 0.35, echo: 0.12, motion: 0.15 },
      clips: [
        clip(
          'Intro Keys',
          4,
          strum('Bb3 D4 F4', 0, 14, 0.5, 0.5),
          strum('Bb3 D4 Eb4', 16, 14, 0.5, 0.5),
          strum('Bb3 C4 Eb4', 32, 14, 0.5, 0.5),
          strum('Ab3 C4 Eb4', 48, 14, 0.5, 0.5),
        ),
        clip('Rhodes', 4, stabs(4, 'X------..x---...', [EBMAJ9, CM9, ABMAJ9, BB13SUS], { gate: 0.95 })),
        clip('Lift Rhodes', 4, stabs(4, '..X-----..x-----', [FM9, ABMAJ9, BB9, CM9], { gate: 0.95 })),
        clip(
          'Haze Rhodes',
          4,
          strum('Eb3 G3 Bb3 D4 F4', 0, 15, 0.75, 0.55),
          strum('C3 G3 Bb3 D4 Eb4', 16, 15, 0.75, 0.55),
          strum('Ab3 C4 Eb4 G4 Bb4', 32, 15, 0.75, 0.55),
          strum('Bb3 C4 Eb4 F4 Ab4', 48, 15, 0.75, 0.55),
        ),
      ],
    },
    lead: {
      sound: 'poly-mallet-bell',
      name: 'Mallets',
      level: -2,
      pan: -0.1,
      macros: { echo: 0.35, space: 0.3 },
      clips: [
        null,
        null,
        clip(
          'Mallets',
          4,
          line(
            4,
            `C5 . . Ab4 . . Bb4 . C5 - - - . . Eb5 . |
             Eb5 . . C5 . . D5 . Eb5 - - - . . G5 . |
             F5 . . D5 . . Eb5 . F5 - - - . . Ab5 . |
             G5 - - - Eb5 - - - C5 - - - . . . .`,
          ),
        ),
        clip(
          'Mallet Echo',
          4,
          line(
            4,
            `. . . . G5 . . . . . . . . . . . |
             . . . . Eb5 . . . . . . . . . . . |
             . . . . C5 . . . Eb5 . . . . . . . |
             . . . . D5 - - - - - - - . . . .`,
            { vel: 0.55 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-warm-drift',
      level: -8,
      macros: { space: 0.55, motion: 0.3 },
      lfo: { division: 1 },
      clips: [
        null,
        null,
        // Under the keys' Abmaj9 (G3 on the bottom) the pad leaves out Ab, so the two never rub a semitone apart.
        clip('Lift Pad', 4, line(4, 'F3+Ab3+C4+Eb4 C4+Eb4+G4+C5 Bb3+D4+F4+Ab4 G3+C4+Eb4+G4', { unit: 16, gate: 0.98, vel: 0.58 })),
        // The last chord stays suspended (no D) under the keys' Bb11.
        clip('Haze Pad', 4, line(4, 'Eb3+Bb3+D4+G4 C3+G3+Bb3+Eb4 Eb3+Ab3+C4+G4 Bb2+F3+Ab3+C4', { unit: 16, gate: 0.98, vel: 0.62 })),
      ],
    },
    texture: {
      sound: 'poly-air-grain',
      name: 'Air',
      level: -6.5,
      macros: { motion: 0.4, space: 0.5, tone: 0.4 },
      lfo: { division: 0 },
      clips: [
        clip(
          'Vinyl Air',
          4,
          mel([
            ['Bb4', 0, 31, 0.45],
            ['G4', 32, 31, 0.42],
          ]),
        ),
        clip('Warm Air', 4, mel([['G4', 0, 64, 0.35]])),
        null,
        clip('Haze Air', 4, line(4, 'D5 Eb5 C5 F5', { unit: 16, gate: 0.95, vel: 0.4 })),
      ],
    },
    sampler: {
      sound: 'builtin:tape-swell',
      name: 'Swell',
      level: -11,
      macros: { space: 0.4 },
      // The 2 s reversed swell peaks at its end. Pitched to Eb it lasts about
      // 9.4 steps at 84 BPM (to Bb, about 12.6), so it lands on the downbeat.
      // Its Eb and Bb fit the chord it rises out of (Cm9 in the Lift, Bb11 in the Haze) and the one it lands on.
      clips: [
        null,
        null,
        clip('Swell', 4, mel([['Eb4', 54.5, 9.5, 0.7]])),
        clip(
          'Swells',
          4,
          mel([
            ['Bb3', 19.5, 12.5, 0.6],
            ['Eb4', 54.5, 9.5, 0.7],
          ]),
        ),
      ],
    },
  },
});
