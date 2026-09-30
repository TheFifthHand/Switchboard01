/**
 * Synthwave — 100 BPM, D minor. A night-drive progression (Dm, Bb, F, C) with
 * a rounded eighth-note bass, luminous detuned chords and a singing lead.
 * The Chorus row borrows Gm for the third bar; every part keeps one chord per
 * bar so any bass or chord clip sits over any other.
 */
import { DRUM, atBar, clip, defineStarter, drums, line, mel, prog, stabs } from './dsl';

const BACKBEAT = {
  kick: 'X.......X.x.....|X.......X.......',
  snare: '....X.......X...',
  hat: '7.5.7.5.7.5.7.5.',
};
const SHAKER = '4253425342534253';

export const SYNTHWAVE = defineStarter({
  id: 'synthwave',
  name: 'Synthwave',
  description: 'A night-drive groove with a rounded bass, luminous chords and a singing lead.',
  bpm: 100,
  swing: 0,
  // Master set by measured loudness so every starter plays at a similar, comfortable level.
  masterVolumeDb: -1,
  root: 2,
  scale: 'minor',
  scenes: ['Intro', 'Cruise', 'Chorus', 'Breakdown'],
  reverb: { decay: 3.2, predelay: 28, tone: 7000 },
  delay: { division: 2, feedback: 0.42, tone: 3600, width: 0.75 },
  arrangement: [
    [0, 2],
    [1, 4],
    [2, 4],
    [3, 2],
    [2, 4],
    [0, 1],
  ],
  tailSeconds: 5,
  parts: {
    drums: {
      sound: 'round-machine',
      level: -3,
      // Kit output trim: the synthesized kits play far hotter than the synths, so the
      // kit is trimmed at the source and the faders stay a readable mix (measured by render).
      instrument: { level: -12 },
      macros: { space: 0.18 },
      // Toms up three semitones (F#, B, E to A, D, G) so the fill sings in D minor.
      drumVoices: { [DRUM.lowTom]: { tune: 3 }, [DRUM.midTom]: { tune: 3 }, [DRUM.highTom]: { tune: 3 } },
      clips: [
        null,
        clip('Backbeat', 2, drums(2, BACKBEAT)),
        clip(
          'Backbeat Fill',
          4,
          drums(4, BACKBEAT),
          drums(4, { crash: 'x...............|................|................|................' }),
          drums(4, { openHat: '..............x.|..............x.|..............x.|................' }),
          atBar(3, drums(1, { highTom: '............xx..', midTom: '..............x.', lowTom: '...............X' })),
        ),
        null,
      ],
    },
    percussion: {
      // A second standard kit: its crisp shaker and clap double the backbeat like an 80s tambourine and clap layer.
      sound: 'bright-steel',
      name: 'Percussion',
      level: -8,
      instrument: { level: -6 },
      pan: -0.15,
      macros: { space: 0.25 },
      clips: [
        clip('Shaker', 1, drums(1, { shaker: SHAKER })),
        clip('Shaker & Clap', 2, drums(2, { shaker: SHAKER, clap: '....x.......x...', perc: '..........o.....|..........o...o.' })),
        clip('Shaker & Clap Up', 2, drums(2, { shaker: '5363536353635363', clap: '....x.......x...', perc: '..........o.....|..........o...o.', rim: '...o............|...o.......o....' })),
        null,
      ],
    },
    bass: {
      sound: 'bass-velvet-saw',
      level: -6.5,
      macros: { space: 0 },
      clips: [
        null,
        clip(
          'Drive',
          4,
          line(
            4,
            `D2! D2 D3? D2 D2 D2 D3? D2 |
             Bb1! Bb1 Bb2? Bb1 Bb1 Bb1 Bb2? Bb1 |
             F1! F1 F2? F1 F1 F1 F2? F1 |
             C2! C2 C3? C2 C2 A1 Bb1 C2`,
            { unit: 2, gate: 0.75 },
          ),
        ),
        clip(
          'Gallop',
          4,
          line(
            4,
            `D2! . D2? D2? D2 . D2? D2? D2 . D2? D2? D3 . C3? A2? |
             Bb1! . Bb1? Bb1? Bb1 . Bb1? Bb1? Bb1 . Bb1? Bb1? Bb2 . F2? D2? |
             G1! . G1? G1? G1 . G1? G1? G1 . G1? G1? G2 . F2? D2? |
             C2! . C2? C2? C2 . C2? C2? C2 . C2? C2? C3 . G2? E2?`,
            { gate: 0.8 },
          ),
        ),
        clip('Long Roots', 4, line(4, 'D2 Bb1 F1 C2', { unit: 16, gate: 0.95, vel: 0.6 })),
      ],
    },
    chords: {
      sound: 'poly-lumen-chords',
      level: -4,
      macros: { space: 0.35, echo: 0.12 },
      clips: [
        clip(
          'Arpeggio',
          4,
          line(
            4,
            `D4 A4 F4 A4 D5 A4 F4 A4 D4 A4 F4 A4 D5 A4 F4 C5 |
             Bb3 F4 D4 F4 Bb4 F4 D4 F4 Bb3 F4 D4 F4 Bb4 F4 D4 A4 |
             A3 F4 C4 F4 A4 F4 C4 F4 A3 F4 C4 F4 A4 F4 C4 E4 |
             C4 G4 E4 G4 C5 G4 E4 G4 C4 G4 E4 G4 Bb4 G4 E4 G4`,
            { vel: 0.6, gate: 0.7 },
          ),
        ),
        clip('Glow', 4, stabs(4, 'X-----x-----x---', ['A3 C4 D4 F4', 'A3 Bb3 D4 F4', 'A3 C4 E4 G4', 'G3 C4 D4 E4'], { gate: 0.95 })),
        clip('Wide', 4, stabs(4, 'X---x--x--x-x---', ['D4 F4 A4 D5', 'D4 F4 Bb4 D5', 'D4 G4 Bb4 D5', 'E4 G4 C5 E5'], { gate: 0.92 })),
        clip(
          'Held',
          4,
          // Dm7 without its ninth (the Breakdown pad holds F4) and Bb(add9) without its major
          // seventh (the pad holds Bb4), so no voice sits a semitone under the pad.
          prog([
            ['D3 F3 A3 C4', 0, 16, 0.6],
            ['D3 F3 Bb3 C4', 16, 16, 0.58],
            ['F3 A3 C4 G4', 32, 16, 0.6],
            ['E3 G3 C4 D4', 48, 16, 0.58],
          ]),
        ),
      ],
    },
    lead: {
      sound: 'poly-neon-lead',
      level: -2,
      pan: 0.08,
      macros: { echo: 0.38, space: 0.3 },
      clips: [
        null,
        null,
        clip(
          'Hook',
          4,
          line(
            4,
            `A4! - - - - - F4 G4 A4 - - - C5 - A4 - |
             Bb4! - - - - - A4 G4 F4 - - - D4 - F4 - |
             G4! - - - - - Bb4 C5 D5 - - - C5 - Bb4 - |
             C5! - - - - - - - E5 - - - D5 - C5 -`,
            { gate: 0.95 },
          ),
        ),
        clip(
          'Echo',
          4,
          line(
            4,
            `. . . . A4 - - - . . . . . . . . |
             . . . . D5 - - - . . . . . . . . |
             . . . . C5 - - - . . . . A4 - - - |
             . . . . G4 - - - - - - - . . . .`,
            { vel: 0.6, gate: 0.95 },
          ),
        ),
      ],
    },
    pad: {
      sound: 'poly-halo-pad',
      level: -5.5,
      macros: { space: 0.55, motion: 0.2 },
      lfo: { division: 1 },
      clips: [
        // F/A with F4 on top: the Intro arpeggio keeps striking F4, which a held E4 would rub against.
        clip('Glow Low', 4, line(4, 'D3+A3+D4+F4 Bb2+F3+D4+F4 A2+F3+C4+F4 C3+G3+C4+E4', { unit: 16, gate: 0.98, vel: 0.6 })),
        null,
        // Top line A4, Bb4, G4: the Bb bar doubles the chords' Bb4 instead of holding A4 against it.
        clip('Glow Up', 4, line(4, 'A3+D4+F4+A4 Bb3+D4+F4+Bb4 G3+Bb3+D4+G4 G3+C4+E4+G4', { unit: 16, gate: 0.98, vel: 0.62 })),
        clip('Glow High', 4, line(4, 'D4+F4+A4+D5 D4+F4+Bb4+D5 C4+F4+A4+C5 C4+E4+G4+C5', { unit: 16, gate: 0.98, vel: 0.64 })),
      ],
    },
    texture: {
      sound: 'poly-tape-shimmer',
      level: -10,
      macros: { motion: 0.45, space: 0.65 },
      lfo: { division: 0 },
      clips: [
        clip(
          'Stars',
          4,
          mel([
            ['A5', 0, 32, 0.45],
            ['C6', 32, 16, 0.4],
            ['G5', 48, 16, 0.4],
          ]),
        ),
        null,
        null,
        clip(
          'Stars Drift',
          4,
          mel([
            ['F5', 0, 16, 0.42],
            ['D5', 16, 16, 0.4],
            ['A5', 32, 16, 0.42],
            ['E5', 48, 16, 0.4],
          ]),
        ),
      ],
    },
    sampler: {
      sound: 'builtin:tape-swell',
      name: 'Swell',
      level: -13.5,
      macros: { space: 0.4 },
      // The 2 s reversed swell (open fifths) peaks at its end. Pitched to D it
      // lasts about 12 steps at 100 BPM (to F, about 10), so these starts land
      // it on the next downbeat. F and C sit over both the Bb it rises through
      // and the F it lands on; D and A over the C and Dm around the loop point.
      clips: [
        null,
        null,
        clip('Swell In', 4, mel([['D4', 52, 12, 0.75]])),
        clip(
          'Swell Twice',
          4,
          mel([
            ['F4', 22, 10, 0.6],
            ['D4', 52, 12, 0.75],
          ]),
        ),
      ],
    },
  },
});
