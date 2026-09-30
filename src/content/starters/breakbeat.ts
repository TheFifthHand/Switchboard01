/**
 * Breakbeat — 132 BPM, B minor. A syncopated, ghost-note-heavy break under a
 * funky two-chord bass (Bm9 to Em9). The Drop moves to Gmaj7 and A: those
 * chords share their tones with the Groove chords (Bm over G is Gmaj9, Em
 * over A is A9sus), so bass and chord clips from either row mix freely. The
 * bass never plays C# or F# (a semitone under D and G), so that holds on
 * whichever bar a tapped clip starts.
 */
import { DRUM, atBar, clip, defineStarter, drums, hand, line, mel, stabs } from './dsl';

// Snare ghosts drag into each backbeat (steps 7 and 11) rather than following a famous sampled break.
const BREAK_HAT = '6.5.6.546.5.6.5.|6.5.6.546.5.6...';
const BREAK_OPEN = '................|..............x.';
// Bongos (G and D) and agogos (E and B) are all chord tones of the B minor progression.
const BONGOS = {
  shaker: '4242424242424242',
  bongoHi: '..x..o...x...o..|..x..o...x..x...',
  bongoLo: '.......x......x.|.......x.....o.x',
};

export const BREAKBEAT = defineStarter({
  id: 'breakbeat',
  name: 'Breakbeat',
  description: 'A syncopated, ghost-note break with a funky bass line and bright plucked chords.',
  bpm: 132,
  swing: 0.12,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: 0.5,
  root: 11,
  scale: 'minor',
  scenes: ['Intro', 'Groove', 'Drop', 'Break'],
  reverb: { decay: 1.8, predelay: 10, tone: 6500 },
  delay: { division: 1, feedback: 0.3, tone: 4200 },
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
      sound: 'dust-tape',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -14 },
      macros: { space: 0.12, drive: 0.15 },
      // Toms up a semitone (F, Bb, Eb to F#, B, E) so the fill sits in B minor.
      drumVoices: { [DRUM.lowTom]: { tune: 1 }, [DRUM.midTom]: { tune: 1 }, [DRUM.highTom]: { tune: 1 } },
      clips: [
        clip('Break Tease', 2, drums(2, { hat: BREAK_HAT, openHat: BREAK_OPEN, rim: '....x.......x...', snare: '.......o...o...o|.o.....o.......o' })),
        clip(
          'Break',
          2,
          drums(2, {
            kick: 'X.........x.....|X.x.......x..x..',
            snare: '....X..o...oX..o|.o..X..o....X.o.',
            hat: BREAK_HAT,
            openHat: BREAK_OPEN,
          }),
        ),
        clip(
          'Heavy Break',
          4,
          drums(4, {
            kick: 'X.........X..x..|X.x.......X..x..',
            snare: '....X..o...oX..o|.o..X..o....X.oo',
            clap: '....x.......x...',
            hat: BREAK_HAT,
            openHat: BREAK_OPEN,
          }),
          drums(4, { crash: 'x...............|................|................|................' }),
          atBar(3, drums(1, { midTom: '..........o.....', lowTom: '...........o....' })),
        ),
        null,
      ],
    },
    percussion: {
      sound: 'hand-percussion',
      level: -8,
      instrument: { level: -5.5 },
      pan: 0.2,
      macros: { space: 0.18 },
      clips: [
        clip('Bongos', 1, hand(1, { bongoHi: '..x..o...x...o..', bongoLo: '.......x......x.' })),
        clip('Bongo Groove', 2, hand(2, BONGOS)),
        clip(
          'Bongos & Agogo',
          2,
          hand(2, {
            ...BONGOS,
            agogoHi: 'x.....x.........|........x.......',
            agogoLo: '............x...|..x.............',
          }),
        ),
        null,
      ],
    },
    bass: {
      sound: 'bass-velvet-saw',
      level: -7.5,
      macros: { space: 0, drive: 0.1 },
      clips: [
        null,
        clip(
          'Funk',
          2,
          line(
            2,
            `B1! - - B1 . . B2? . . A1 - B1 . . D2 . |
             E2! - - E2 . . E1? . . D2 - E2 . . G2 E2`,
            { gate: 0.85 },
          ),
        ),
        clip(
          'Drop Line',
          2,
          line(
            2,
            `G1! - . G1 . G2? . G1 . . G1 - . D2 . B1~ |
             A1! - . A1 . A2? . A1 . . A1 - . B1 D2 E2?`,
            { gate: 0.85 },
          ),
        ),
        clip('Break Roots', 4, line(4, 'B1 E2 G1 A1', { unit: 16, gate: 0.95, vel: 0.6 })),
      ],
    },
    chords: {
      sound: 'poly-short-pluck',
      level: -2,
      pan: -0.1,
      macros: { space: 0.3, echo: 0.2 },
      clips: [
        null,
        clip('Plucks', 2, stabs(2, '..x..x-...x..x..|..x..x-..x...x..', ['D4 F#4 A4 C#5', 'D4 F#4 G4 B4'])),
        clip('Drop Plucks', 2, stabs(2, 'x..x..x...x..x..|x..x..x...x.x.x.', ['D4 F#4 G4 B4', 'C#4 E4 A4 B4'])),
        clip(
          'Plucked Arps',
          4,
          line(
            4,
            `B3 D4 F#4 A4 C#5 A4 F#4 D4 |
             E3 G3 B3 D4 F#4 D4 B3 G3 |
             G3 B3 D4 F#4 B4 F#4 D4 B3 |
             A3 C#4 E4 A4 B4 A4 E4 C#4`,
            { unit: 2, gate: 0.9, vel: 0.55 },
          ),
        ),
      ],
    },
    lead: {
      sound: 'poly-neon-lead',
      level: -3.5,
      pan: 0.12,
      macros: { echo: 0.3, space: 0.25 },
      clips: [
        null,
        null,
        clip(
          'Drop Lead',
          2,
          line(
            2,
            `. . B4 - . D5 . . F#5 - . . E5 . D5 . |
             . . C#5 - . E5 . . B4 - - - A4 - . .`,
          ),
        ),
        clip(
          'Break Lead',
          4,
          mel([
            ['F#5', 4, 8, 0.62],
            ['B4', 24, 8, 0.58],
            ['D5', 36, 8, 0.62],
            ['C#5', 56, 8, 0.58],
          ]),
        ),
      ],
    },
    pad: {
      sound: 'poly-halo-pad',
      level: -8,
      macros: { space: 0.55, motion: 0.25 },
      lfo: { division: 1 },
      clips: [
        clip('Dusk', 4, line(4, 'B2+F#3+A3+D4 E3+G3+B3+D4 B2+F#3+C#4+D4 E3+G3+B3+F#4', { unit: 16, gate: 0.98, vel: 0.55 })),
        null,
        // Gadd9 rather than Gmaj7: the rave stab's Em7 puts G4 right above where F#4 would sit.
        clip('Drop Pad', 2, line(2, 'G3+B3+D4+A4 A3+C#4+E4+B4', { unit: 16, gate: 0.98, vel: 0.6 })),
        clip('Break Pad', 4, line(4, 'B3+D4+F#4+C#5 B3+D4+E4+G4 B3+D4+F#4+G4 A3+C#4+E4+A4', { unit: 16, gate: 0.98, vel: 0.62 })),
      ],
    },
    texture: {
      sound: 'poly-tape-shimmer',
      level: -11,
      macros: { motion: 0.45, space: 0.65 },
      lfo: { division: 0 },
      clips: [
        clip(
          'Shimmer In',
          4,
          mel([
            ['F#5', 0, 32, 0.4],
            ['D5', 32, 32, 0.38],
          ]),
        ),
        null,
        null,
        clip('Shimmer', 4, line(4, 'F#5 E5 D5 C#5', { unit: 16, gate: 0.97, vel: 0.4 })),
      ],
    },
    sampler: {
      sound: 'builtin:glass-chord',
      name: 'Rave Stab',
      level: -10.5,
      macros: { space: 0.3, echo: 0.15 },
      clips: [
        null,
        null,
        clip(
          'Rave Stabs',
          2,
          // Minor-seventh stabs: Bm7 and Em7 over G, then only F#m7 over A (Bm7 or Em7 there
          // would put a D right above the plucks' and pad's C#4).
          mel([
            ['B3', 0, 2],
            ['B3', 3, 2, 0.7],
            ['E4', 6, 3],
            ['F#4', 16, 2],
            ['F#4', 19, 2, 0.7],
            ['F#4', 22, 3],
            ['F#4', 28, 2, 0.6],
          ]),
        ),
        clip(
          'Stab Echo',
          4,
          mel([
            ['B3', 0, 8, 0.75],
            ['B3', 32, 8, 0.65],
          ]),
        ),
      ],
    },
  },
});
