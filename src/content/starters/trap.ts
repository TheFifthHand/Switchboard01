/**
 * Trap — 140 BPM, C minor, half-time feel: the snare and clap land on beat
 * three, hi-hats run in eighths with 32nd-note rolls, and a long 808 slides
 * between roots. Dark felt-piano chords and a choir hold Cm and A♭ (Groove),
 * Fm, A♭ and B♭ (Lift). The 808 only plays C, E♭, F, A♭ and B♭: never G or D,
 * the notes a semitone under the chords' A♭ and E♭, so every bass clip sits
 * under every chord clip from any bar.
 */
import { clip, defineStarter, drums, drums32, line, mel, stabs } from './dsl';

const CM = 'G3 C4 Eb4';
const AB = 'Ab3 C4 Eb4';
const FM = 'F3 Ab3 C4';
const BB = 'F3 Bb3 D4';

/** One bar of eighth hats and the 32nd rolls that answer them (two bars). */
const HATS = 'x.x.x.x.x.x.x.x.|x.x.x.x.x.x.....';
const ROLL = '................................|........................75757575';

export const TRAP = defineStarter({
  id: 'trap',
  name: 'Trap',
  description: 'A dark half-time beat with rolling hi-hats, a sliding 808 and moody piano chords.',
  bpm: 140,
  swing: 0,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 0,
  root: 0,
  scale: 'minor',
  scenes: ['Intro', 'Groove', 'Lift', 'Break'],
  reverb: { decay: 2.6, predelay: 20, tone: 5000 },
  delay: { division: 2, feedback: 0.4, tone: 3000 },
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
      sound: 'trap-night',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -11 },
      macros: { space: 0.06 },
      clips: [
        clip('Hats & Snaps', 2, drums(2, { hat: HATS, rim: '........x.......|........x.....o.' }), drums32(2, { hat: ROLL })),
        clip(
          'Half-Time',
          2,
          drums(2, {
            kick: 'X.........X.....|X......X......x.',
            clap: '........X.......',
            snare: '........x.......',
            hat: HATS,
          }),
          drums32(2, { hat: ROLL }),
        ),
        clip(
          'Rolling',
          2,
          drums(2, {
            kick: 'X.........X..x..|X......X..x...x.',
            clap: '........X.......',
            snare: '........x.......|........x.....o.',
            hat: 'x.x.x.x.x.x.....|x.x.x...x.x.....',
            openHat: '..............x.|................',
          }),
          drums32(2, { hat: '........................86868686|........86868686........75757575' }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'boom-808',
      name: 'Perc',
      level: -8,
      instrument: { level: -5 },
      pan: 0.2,
      macros: { space: 0.2 },
      clips: [
        clip('Rim Ticks', 2, drums(2, { rim: '...o......o..o..|......o.....o...' })),
        clip('Cowbell', 2, drums(2, { bell: '..........x.....|..........x...x.', rim: '...o......o.....' })),
        clip('Toms & Bell', 2, drums(2, { bell: '..........x.....|..........x...x.', highTom: '...o.........o..', midTom: '................|......o.........' })),
        null,
      ],
    },
    bass: {
      sound: 'bass-808-boom',
      name: '808',
      level: -5,
      // A longer glide than the preset: the slides are the hook.
      instrument: { glide: 0.11 },
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Slide',
          4,
          line(
            4,
            `C2 - - - - - - - . . C2 - - - . . |
             C2 - - - - - . C2~ Eb2 - - - - . C2 - |
             Ab1 - - - - - - - . . Ab1 - - - . . |
             Ab1 - - - - - . Ab1~ Bb1 - - - - - C2 -`,
          ),
        ),
        clip(
          'Climb',
          4,
          line(
            4,
            `F1 - - - - - - - . . F1 - - - . . |
             F1 - - - - - . F1~ Ab1 - - - - . F1 - |
             Ab1 - - - - - - - . . Ab1 - - - . . |
             Bb1 - - - - - . Bb1~ C2 - - - Bb1 - - -`,
          ),
        ),
        clip('Long Roots', 4, line(4, 'Ab1 F1 C2 C2', { unit: 16, gate: 0.94, vel: 0.62 })),
      ],
    },
    chords: {
      sound: 'poly-felt-piano',
      name: 'Piano',
      level: -4.5,
      pan: -0.08,
      macros: { space: 0.3, echo: 0.15 },
      clips: [
        clip('Soft Keys', 4, stabs(4, 'x---------------', [CM, CM, AB, AB], { gate: 0.95 })),
        clip('Dark Keys', 4, stabs(4, 'X-----x-----x---', [CM, CM, AB, AB], { gate: 0.92 })),
        clip('Lift Keys', 4, stabs(4, 'X-----x-----x---', [FM, FM, AB, BB], { gate: 0.92 })),
        clip('Break Keys', 4, stabs(4, 'x-------x-------', [AB, FM, CM, CM], { gate: 0.95 })),
      ],
    },
    lead: {
      sound: 'poly-glockenspiel',
      name: 'Bells',
      level: -7,
      pan: 0.12,
      macros: { echo: 0.3, space: 0.3 },
      clips: [
        null,
        null,
        clip(
          'Bells',
          4,
          line(
            4,
            `C6 . Ab5 . F5 . Ab5 . C6 . Ab5 . Eb6 . C6 . |
             C6 . Ab5 . F5 . Ab5 . Bb5 . Ab5 . F5 - - - |
             Eb6 . C6 . Ab5 . C6 . Eb6 . C6 . Ab5 . G5 . |
             D6 . Bb5 . F5 . Bb5 . D6 . Bb5 . F5 - - -`,
            { gate: 0.7, vel: 0.72 },
          ),
        ),
        clip(
          'Bell Echo',
          4,
          line(
            4,
            `. . . . Eb5 - - - . . . . C5 . . . |
             . . . . F5 - - - . . . . Ab5 . . . |
             . . . . G5 - - - . . . . Eb5 . . . |
             . . . . C5 - - - - - - - . . . .`,
            { vel: 0.6 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-choir-ooh',
      name: 'Choir',
      level: -6.5,
      macros: { space: 0.55, motion: 0.15 },
      clips: [
        clip('Choir', 4, line(4, 'G3+C4+Eb4 G3+C4+Eb4 Ab3+C4+Eb4 Ab3+C4+Eb4', { unit: 16, gate: 0.98, vel: 0.55 })),
        null,
        clip('Lift Choir', 4, line(4, 'F3+Ab3+C4 F3+Ab3+C4 Ab3+C4+Eb4 F3+Bb3+D4', { unit: 16, gate: 0.98, vel: 0.58 })),
        clip('Break Choir', 4, line(4, 'Ab3+C4+Eb4 F3+Ab3+C4 G3+C4+Eb4 G3+C4+Eb4', { unit: 16, gate: 0.98, vel: 0.62 })),
      ],
    },
    texture: {
      sound: 'poly-dark-drone',
      name: 'Drone',
      level: -12,
      macros: { space: 0.5, motion: 0.3 },
      // C sits in every chord of the song (and nowhere a semitone from one), so the drone holds it throughout.
      clips: [clip('Low Drone', 4, mel([['C3', 0, 64, 0.5]])), null, null, clip('Drone', 4, mel([['C3', 0, 64, 0.5], ['C4', 32, 32, 0.35]]))],
    },
    sampler: {
      sound: 'builtin:vocal-oh',
      name: 'Vocal',
      level: -18.5,
      pan: -0.12,
      macros: { echo: 0.32, space: 0.35 },
      // Loop mode: each chop lasts as long as its note (see House).
      instrument: { mode: 1 },
      clips: [
        null,
        null,
        clip(
          'Oh Chops',
          4,
          mel([
            ['C4', 2, 2],
            ['Ab3', 7, 1, 0.6],
            ['C4', 10, 3],
            ['F4', 18, 2],
            ['Eb4', 23, 1, 0.6],
            ['Eb4', 34, 2],
            ['C4', 39, 1, 0.6],
            ['Ab3', 42, 3],
            ['D4', 50, 2],
            ['F4', 55, 1, 0.6],
            ['Bb3', 58, 3],
          ]),
        ),
        clip(
          'Long Oh',
          4,
          mel([
            ['Eb4', 8, 7, 0.7],
            ['C4', 40, 8, 0.65],
          ]),
        ),
      ],
    },
  },
});
