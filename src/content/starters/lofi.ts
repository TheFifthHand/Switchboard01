/**
 * Lo-fi Hip Hop — 82 BPM, A♭ major, lazily swung (0.35). A dusty, crushed
 * beat under worn electric-piano ninths: D♭maj9, Fm9, B♭m9 and E♭9sus in the
 * Groove (IV, vi, ii, V), with the Lift turning to A♭maj9. The bass only
 * plays D♭, E♭, F, A♭ and B♭: never C or G, the notes a semitone under the
 * chords' D♭ and A♭, so any bass clip sits under any chord clip. The pad
 * doubles the keys' voicings exactly, and the congas are tuned up a
 * semitone to A♭ and E♭, the key's tonic and fifth.
 */
import { clip, defineStarter, drums, hand, HAND, line, mel, stabs, strum } from './dsl';

const DBMAJ9 = 'F3 Ab3 C4 Eb4';
const FM9 = 'Ab3 C4 Eb4 G4';
const BBM9 = 'Db4 F4 Ab4 C5';
const EB9SUS = 'Db4 F4 Ab4 Bb4';
const ABMAJ9 = 'C4 Eb4 G4 Bb4';

const HAT = '6.4.6.4.6.4.6.46';
const SHAKER = '4.2.4.2.4.2.4.2.';

export const LOFI = defineStarter({
  id: 'lofi',
  name: 'Lo-fi Hip Hop',
  description: 'A lazy, swung beat with dusty electric-piano chords, soft vibes and warm tape hiss.',
  bpm: 82,
  swing: 0.35,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 1,
  root: 8,
  scale: 'major',
  scenes: ['Intro', 'Nod', 'Lift', 'Haze'],
  reverb: { decay: 2.2, predelay: 16, tone: 4200 },
  delay: { division: 2, feedback: 0.42, tone: 2400 },
  arrangement: [
    [0, 2],
    [1, 4],
    [2, 2],
    [3, 2],
    [1, 2],
  ],
  tailSeconds: 4,
  parts: {
    drums: {
      sound: 'lofi-crate',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -10 },
      macros: { tone: 0.45, space: 0.1 },
      clips: [
        clip('Rim & Hats', 2, drums(2, { hat: HAT, rim: '....5.......5...|....5.......5..3' })),
        clip(
          'Dusty Beat',
          2,
          drums(2, {
            kick: 'X.......x.X.....|X..x......X.....',
            snare: '....X.......X...',
            hat: HAT,
            rim: '................|.......o........',
          }),
        ),
        clip(
          'Lift Beat',
          2,
          drums(2, {
            kick: 'X.......x.X.....|X..x......X..x..',
            snare: '....X.......X...|....X.......X..o',
            hat: '6.4.6.4.6.4.6.4.|6.4.6.4.6.4.6...',
            openHat: '................|..............x.',
            rim: '..........o.....',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'hand-percussion',
      level: -9,
      instrument: { level: -2 },
      // Congas up a semitone: A♭ and E♭.
      drumVoices: { [HAND.lowConga]: { tune: 1 }, [HAND.highConga]: { tune: 1 } },
      pan: -0.2,
      macros: { space: 0.25 },
      clips: [
        clip('Shaker', 1, hand(1, { shaker: SHAKER })),
        clip('Shaker & Snap', 2, hand(2, { shaker: SHAKER, snap: '................|............4...' })),
        clip('Congas', 2, hand(2, { shaker: SHAKER, highConga: '......x.......o.|......x...x.....', lowConga: '...............x|..............o.' })),
        null,
      ],
    },
    bass: {
      sound: 'bass-finger',
      level: -7,
      macros: { space: 0, tone: 0.4 },
      clips: [
        null,
        clip(
          'Walk',
          4,
          line(
            4,
            `Db2 - - - - - . . . . Ab1 - Db2 - . . |
             F1 - - - - - . . . . F2? - Eb2 - . . |
             Bb1 - - - - - . . . . F1 - Bb1 - . . |
             Eb2 - - - - - . . . . Bb1 - Db2 - Eb2 -`,
          ),
        ),
        clip(
          'Lift Walk',
          4,
          line(
            4,
            `F1 - - - - - . . . . Ab1 - F2? - Eb2 - |
             Db2 - - - - - . . . . Ab1 - Db2 - F2 - |
             Eb2 - - - - - . . . . Bb1 - Eb2 - Db2 - |
             Ab1 - - - - - . . . . Eb2 - Ab1 - Bb1 -`,
          ),
        ),
        clip('Soft Roots', 4, line(4, 'Bb1 Eb2 Ab1 Ab1', { unit: 16, gate: 0.94, vel: 0.6 })),
      ],
    },
    chords: {
      sound: 'poly-dusty-keys',
      name: 'Keys',
      level: -5.5,
      pan: 0.1,
      macros: { space: 0.3, echo: 0.14 },
      clips: [
        clip(
          'Intro Keys',
          4,
          strum(DBMAJ9, 0, 30, 0.5, 0.55),
          strum(FM9, 32, 30, 0.5, 0.55),
        ),
        clip('Dusty Keys', 4, stabs(4, 'X-------...x----', [DBMAJ9, FM9, BBM9, EB9SUS], { gate: 0.94 })),
        clip('Lift Keys', 4, stabs(4, 'X-----..x-----..', [FM9, DBMAJ9, EB9SUS, ABMAJ9], { gate: 0.94 })),
        clip(
          'Haze Keys',
          4,
          strum(BBM9, 0, 15, 0.75, 0.55),
          strum(EB9SUS, 16, 15, 0.75, 0.55),
          strum(ABMAJ9, 32, 31, 0.75, 0.55),
        ),
      ],
    },
    lead: {
      sound: 'poly-vibraphone',
      name: 'Vibes',
      level: -0.5,
      pan: -0.12,
      macros: { echo: 0.32, space: 0.3 },
      clips: [
        null,
        null,
        clip(
          'Vibes',
          4,
          line(
            4,
            `C5 . . Eb5 . . F5 - - - . . G5 - - - |
             F5 - - - Eb5 . C5 . . . Ab4 - - - . . |
             Bb4 . . Db5 . . Eb5 - - - . . F5 - - - |
             Eb5 - - - . . C5 . G4 - - - - - . .`,
            { vel: 0.7 },
          ),
        ),
        clip(
          'Vibes Echo',
          4,
          line(
            4,
            `. . . . F5 - - - . . . . Ab4 . . . |
             . . . . Bb4 - - - . . . . F4 . . . |
             . . . . Eb5 - - - . . . . C5 . . . |
             . . . . G4 - - - - - - - . . . .`,
            { vel: 0.55 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-warm-drift',
      level: -10,
      macros: { space: 0.55, motion: 0.25 },
      lfo: { division: 1 },
      // The pad doubles the keys' own voicings, so the two never rub.
      clips: [
        clip('Warm Bed', 4, line(4, `${DBMAJ9.replace(/ /g, '+')} - ${FM9.replace(/ /g, '+')} -`, { unit: 16, gate: 0.98, vel: 0.5 })),
        null,
        null,
        clip('Haze Bed', 4, line(4, `${BBM9.replace(/ /g, '+')} ${EB9SUS.replace(/ /g, '+')} ${ABMAJ9.replace(/ /g, '+')} -`, { unit: 16, gate: 0.98, vel: 0.58 })),
      ],
    },
    texture: {
      sound: 'poly-warped-tape',
      name: 'Tape',
      level: -12,
      macros: { space: 0.45, motion: 0.3 },
      clips: [
        // C is in every chord of the Intro and a semitone from none of them.
        clip('Tape Hum', 4, mel([['C5', 0, 64, 0.45]])),
        null,
        null,
        clip(
          'Tape Drift',
          4,
          mel([
            ['F4', 0, 31, 0.45],
            ['Eb4', 32, 31, 0.42],
          ]),
        ),
      ],
    },
    sampler: {
      sound: 'builtin:tape-swell',
      name: 'Swell',
      level: -11,
      macros: { space: 0.4 },
      // The 2 s reversed swell peaks at its end. Pitched to E♭ it lasts about
      // 9.2 steps at 82 BPM (to A♭, about 13.8), so it lands on the downbeat.
      // Its notes and fifths (E♭ and B♭, A♭ and E♭) are tones of the chords it rises over.
      clips: [
        null,
        null,
        clip('Swell', 4, mel([['Eb4', 54.75, 9.25, 0.7]])),
        clip(
          'Swells',
          4,
          mel([
            ['Ab3', 18.25, 13.75, 0.6],
            ['Eb4', 54.75, 9.25, 0.7],
          ]),
        ),
      ],
    },
  },
});
