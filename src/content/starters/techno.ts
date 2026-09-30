/**
 * Techno — 128 BPM, F phrygian. A tight kick and a rolling sub stay on the F
 * pedal, so the low end is focused and every chord change is heard as colour
 * above it (Fm7, Dbmaj7/F, Ebsus/F, Bbm/F). The phrygian flat second (Gb)
 * appears only as a passing note in the bass and acid lines, falling back to
 * F. No bass note is a C, which would sit a semitone under the Db chords.
 * Rhythmic movement comes from dotted-eighth rim and stab patterns against
 * the four-on-the-floor, a triplet-rate filter LFO on the dub stab (Motion)
 * and Pump on the pad.
 */
import { chord, clip, defineStarter, drums, line, mel, stabs } from './dsl';

const FM7 = 'F3 Ab3 C4 Eb4';
const DBMAJ7_F = 'Db3 F3 Ab3 C4';
const EBSUS_F = 'Eb3 Bb3 Eb4 F4';
const BBM_F = 'F3 Bb3 Db4';
const DB_F = 'Db3 F3 Ab3 Db4';

const HAT = '3474347434743474';

export const TECHNO = defineStarter({
  id: 'techno',
  name: 'Techno',
  description: 'A driving, hypnotic groove with a rolling sub, a pulsing dub stab and an acid line.',
  bpm: 128,
  swing: 0.08,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 0.5,
  root: 5,
  scale: 'phrygian',
  scenes: ['Intro', 'Groove', 'Peak', 'Breakdown'],
  reverb: { decay: 3, predelay: 20, tone: 5200 },
  delay: { division: 2, feedback: 0.5, tone: 2600, width: 0.7 },
  arrangement: [
    [0, 2],
    [1, 8],
    [2, 4],
    [3, 2],
    [2, 4],
    [1, 4],
  ],
  tailSeconds: 4,
  parts: {
    drums: {
      sound: 'tight-circuit',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -11 },
      macros: { space: 0.05 },
      clips: [
        clip('Hats & Clap', 2, drums(2, { hat: HAT, clap: '....o.......x...|....o.......x..o' })),
        clip('Pulse', 2, drums(2, { kick: 'X...X...X...X...', clap: '....x.......x...', hat: HAT })),
        clip(
          'Peak Pulse',
          2,
          drums(2, {
            kick: 'X...X...X...X...',
            clap: '....x.......x...|....x.......x.o.',
            hat: '34.434.434.434.4',
            openHat: '..x...x...x...x.',
          }),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'bright-steel',
      name: 'Percussion',
      level: -8,
      instrument: { level: -4 },
      pan: -0.2,
      macros: { space: 0.2, echo: 0.12 },
      clips: [
        clip('Metal Ticks', 1, drums(1, { rim: '..x..o..x..o..x.', perc: '...o...........o' })),
        clip('Poly Rims', 2, drums(2, { rim: '..x..o..x..o..x.|..x..o..x..o.o..', shaker: '2323232323232323' })),
        clip('Rims & Ride', 2, drums(2, { rim: '..x..o..x..o..x.|..x..o..x..o.o..', ride: '..x...x...x...x.', perc: 'o.....o.........|o.....o.....o...' })),
        null,
      ],
    },
    bass: {
      sound: 'bass-round-sub',
      level: -7,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Rumble',
          2,
          line(
            2,
            `. . F1 F1? . . F1 F1? . . F1 F1? . . F1 F2? |
             . . F1 F1? . . F1 F1? . . F1 F1? . F2? Eb2 Ab1`,
            { gate: 0.6 },
          ),
        ),
        clip(
          'Pulse Low',
          2,
          line(
            2,
            `. . F1! - . . F1 - . . F1! - . F2? F1 - |
             . . F1! - . . F1 - . . Ab1 - . . Gb1 -`,
            { gate: 0.7 },
          ),
        ),
        clip(
          'Held Low',
          4,
          mel([
            ['F1', 0, 32, 0.5],
            ['F1', 32, 32, 0.44],
          ]),
        ),
      ],
    },
    chords: {
      sound: 'poly-house-stab',
      name: 'Dub Stab',
      level: -2,
      macros: { tone: 0.38, space: 0.35, echo: 0.42, pump: 0.35, motion: 0.45 },
      // A quarter-note-triplet filter sweep runs three against the four-on-the-floor.
      lfo: { division: 7, wave: 1 },
      clips: [
        clip('Stab Tease', 2, chord(FM7, 3, 1, 0.62)),
        clip('Dub Stab', 2, stabs(2, '...x.....x......|..x.....x..x....', [FM7], { gate: 0.7 })),
        clip('Stab Shift', 4, stabs(4, '..x..x..x..x..x.', [FM7, FM7, DBMAJ7_F, EBSUS_F], { gate: 0.65 })),
        clip(
          'Dub Tails',
          4,
          chord(FM7, 3, 1.5, 0.75),
          chord(BBM_F, 16 + 3, 1.5, 0.7),
          chord(FM7, 32 + 3, 1.5, 0.75),
          // A plain Db triad here: the choir holds Db4, and the maj7's C4 would rub a semitone under it.
          chord(DB_F, 48 + 3, 1.5, 0.7),
        ),
      ],
    },
    lead: {
      sound: 'bass-acid-line',
      name: 'Acid',
      level: -10.5,
      pan: 0.1,
      macros: { echo: 0.2, space: 0.12, motion: 0.3 },
      lfo: { division: 1, wave: 1 },
      clips: [
        null,
        null,
        clip(
          'Acid',
          2,
          line(
            2,
            `F4 F4? F5! F4 . Ab4~ Bb4 F4 . Gb4 F4 . C5! F4 Eb4~ F4 |
             F4 F4? F5! F4 . Ab4~ Bb4 F4 . C5 Db5~ C5 Ab4 F4 Eb4 .`,
            { gate: 0.55 },
          ),
        ),
        clip(
          'Acid Drift',
          2,
          line(
            2,
            `F4 . . F4? . . Ab4~ Bb4 . . F4 . . . Eb4 . |
             F4 . . F4? . . C5~ Bb4 . . Ab4 . . . Gb4 .`,
            { gate: 0.6, vel: 0.62 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-night-choir',
      level: -11,
      macros: { space: 0.6, pump: 0.4, motion: 0.3 },
      lfo: { division: 1 },
      clips: [
        null,
        null,
        clip('Choir Peak', 4, line(4, 'F3+Ab3+C4+Eb4 - Db3+F3+Ab3+C4 Eb3+Bb3+Eb4+F4', { unit: 16, gate: 0.98, vel: 0.58 })),
        clip('Choir Break', 4, line(4, 'F3+C4+Ab4 F3+Db4+Bb4 F3+C4+Ab4 F3+Db4+Ab4', { unit: 16, gate: 0.98, vel: 0.62 })),
      ],
    },
    texture: {
      sound: 'poly-air-grain',
      name: 'Wind',
      level: -11,
      macros: { motion: 0.55, space: 0.6 },
      lfo: { division: 0 },
      clips: [
        null,
        null,
        null,
        clip(
          'Wind',
          4,
          mel([
            ['C5', 0, 31, 0.45],
            ['Ab4', 32, 31, 0.4],
          ]),
        ),
      ],
    },
    sampler: {
      sound: 'builtin:noise-riser',
      name: 'Riser',
      level: -7.5,
      macros: { space: 0.35 },
      // The 2 s riser (original speed at C4) spans about 17 steps at 128 BPM,
      // so it starts one step before the last bar and peaks on the next downbeat.
      clips: [clip('Riser', 4, mel([['C4', 47, 17, 0.7]])), null, null, clip('Riser', 4, mel([['C4', 47, 17, 0.8]]))],
    },
  },
});
