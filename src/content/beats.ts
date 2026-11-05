/**
 * Beat presets: named drum beats across styles, for "Start from a beat…"
 * (pure data, architecture layer 1). Every beat is original, written as
 * drum grids with the starter DSL's characters (see starters/dsl.ts
 * `parseGrid`): 'X' accent, 'x' normal, 'o' ghost, '1'..'9' velocity in
 * tenths, '.' rest, '-' longer, '|' and spaces only separate bars.
 *
 * A beat may carry 32nd-note `rolls` (trap hi-hats) and a one-bar `fill`
 * that `realizeBeat` can write into the last bar of a clip of two or more
 * bars. The beats are also the library's drum loops (loops/index.ts).
 */
import { clip, gridNotes, type DrumGrid } from './starters/dsl';
import { kitLayout, layoutSlots, mapDrumGrid, type LibraryLoop, type LoopBars, type LoopFeel, type LoopGenre, type RealizedLoop } from './loops/model';
import { STEPS_PER_BAR, TICKS_PER_BAR } from '../project/types';

export interface BeatDef {
  /** Stable kebab-case id. */
  readonly id: string;
  readonly name: string;
  /** Main style (the gallery groups by it). */
  readonly genre: LoopGenre;
  /** Other styles it suits. */
  readonly also?: readonly LoopGenre[];
  /** Tempo it was written at (a hint; any tempo plays it). */
  readonly bpm: number;
  /** Swing it was written with (0..1), when it wants one. */
  readonly swing?: number;
  readonly bars: LoopBars;
  readonly feel: LoopFeel;
  /** The kit it was written for. */
  readonly kit: string;
  readonly grid: DrumGrid;
  /** 32nd-note grids (32 characters per bar), layered on top. */
  readonly rolls?: DrumGrid;
  /** A one-bar fill for the last bar of a longer clip. */
  readonly fill?: DrumGrid;
}

const beat = (b: BeatDef): BeatDef => b;

/* Shared hat lines (one bar). */
const EIGHTHS = 'x.x.x.x.x.x.x.x.';
const EIGHTHS_SOFT = '7.5.7.5.7.5.7.5.';
const SIXTEENTHS = 'x5x5x5x5x5x5x5x5';
const OFFBEAT_OPEN = '..x...x...x...x.';

export const BEATS: readonly BeatDef[] = [
  /* ---------------- Boom Bap ---------------- */
  beat({
    id: 'beat-dusty-boom',
    name: 'Dusty Boom',
    genre: 'boom-bap',
    also: ['lofi'],
    bpm: 90,
    swing: 0.2,
    bars: 2,
    feel: 'chill',
    kit: 'break-crate',
    grid: {
      kick: 'X.........X..x..|X......x..X.....',
      snare: '....X.......X...',
      hat: '7.5.7.5.7.5.7.56',
    },
    fill: { kick: 'X.........X.....', snare: '....X.......X.xX', hat: '7.5.7.5.7.5.....' },
  }),
  beat({
    id: 'beat-head-nod',
    name: 'Head Nod',
    genre: 'boom-bap',
    bpm: 92,
    swing: 0.15,
    bars: 2,
    feel: 'bouncy',
    kit: 'break-crate',
    grid: {
      kick: 'X......x.xX.....|X.x.......X.....',
      snare: '....X.......X..o|....X..o....X...',
      hat: 'x.xox.x.x.xox.x.',
    },
    fill: { kick: 'X......x.xX.....', snare: '....X.......XoXX', hat: 'x.xox.x.x.......' },
  }),
  beat({
    id: 'beat-crate-knock',
    name: 'Crate Knock',
    genre: 'boom-bap',
    bpm: 88,
    swing: 0.25,
    bars: 2,
    feel: 'dark',
    kit: 'dust-tape',
    grid: {
      kick: 'X..x......X.....|X..x....x.X.....',
      snare: '....X.......X...',
      hat: '6.4.6.4.6.4.6.4.',
      openHat: '..............x.|................',
    },
  }),
  beat({
    id: 'beat-lazy-snap',
    name: 'Lazy Snap',
    genre: 'boom-bap',
    also: ['lofi'],
    bpm: 86,
    swing: 0.3,
    bars: 2,
    feel: 'chill',
    kit: 'dust-tape',
    grid: {
      kick: 'X.......X.x.....|X.......X.....x.',
      clap: '....X.......X...',
      snare: '...........o....',
      hat: '8.5.8.5.8.5.8.5.',
    },
  }),

  /* ---------------- Trap ---------------- */
  beat({
    id: 'beat-night-rolls',
    name: 'Night Rolls',
    genre: 'trap',
    bpm: 140,
    bars: 2,
    feel: 'dark',
    kit: 'trap-night',
    grid: {
      kick: 'X.....x...X.....|X......x..x..x..',
      clap: '........X.......',
      hat: 'x.x.x.x.x.x.....|x.x.x.x.x.x.x.x.',
    },
    rolls: { hat: '........................75757575|................................' },
  }),
  beat({
    id: 'beat-hat-rain',
    name: 'Hat Rain',
    genre: 'trap',
    bpm: 145,
    bars: 2,
    feel: 'driving',
    kit: 'trap-night',
    grid: {
      kick: 'X......x.x......|X.....x...x.....',
      snare: '........X.......',
      hat: 'x.xxx.x.x.x.x.xx',
      openHat: '................|..............x.',
    },
    rolls: { hat: '................................|................86868686........' },
  }),
  beat({
    id: 'beat-cold-bounce',
    name: 'Cold Bounce',
    genre: 'trap',
    bpm: 140,
    bars: 2,
    feel: 'bouncy',
    kit: 'trap-night',
    grid: {
      kick: 'X..x......X..x..|X.......x.......',
      clap: '........X.......',
      rim: '.....o.....o....|...o.......o..o.',
      hat: 'x.x.x.x.x.x.x.x.',
    },
  }),
  beat({
    id: 'beat-slow-drift',
    name: 'Slow Drift',
    genre: 'trap',
    also: ['lofi'],
    bpm: 130,
    bars: 2,
    feel: 'chill',
    kit: 'trap-night',
    grid: {
      kick: 'X...........x...|X.........X.....',
      snare: '........X.......',
      hat: 'x...x...x...x...|x...x...x.x.x.x.',
      shaker: '..o...o...o...o.',
    },
  }),
  beat({
    id: 'beat-sliding-hats',
    name: 'Sliding Hats',
    genre: 'trap',
    bpm: 142,
    bars: 2,
    feel: 'dark',
    kit: 'trap-night',
    grid: {
      kick: 'X.......x..x....|X......x....x...',
      snare: '........X.......|........X.....o.',
      hat: 'x..x..x.x..x..x.',
    },
    rolls: { hat: '................................|....................767676767676' },
  }),

  /* ---------------- Lo-fi ---------------- */
  beat({
    id: 'beat-tape-nod',
    name: 'Tape Nod',
    genre: 'lofi',
    bpm: 82,
    swing: 0.35,
    bars: 2,
    feel: 'chill',
    kit: 'lofi-crate',
    grid: {
      kick: 'X.......x.X.....|X..x......X.....',
      snare: '....X.......X...',
      hat: '6.4.6.4.6.4.6.4.',
      rim: '..........o.....|.......o........',
    },
  }),
  beat({
    id: 'beat-soft-knock',
    name: 'Soft Knock',
    genre: 'lofi',
    bpm: 78,
    swing: 0.3,
    bars: 1,
    feel: 'chill',
    kit: 'lofi-crate',
    grid: {
      kick: 'X......x..X.....',
      snare: '....x.......x...',
      hat: '5.3.5.3.5.3.5.3.',
    },
  }),
  beat({
    id: 'beat-sleepy-swing',
    name: 'Sleepy Swing',
    genre: 'lofi',
    bpm: 75,
    swing: 0.4,
    bars: 2,
    feel: 'chill',
    kit: 'lofi-crate',
    grid: {
      kick: 'X.........x.....|X.....x.........',
      snare: '....X.......X...|....X.......X..o',
      hat: '5.4.5.4.5.4.5.4.',
      shaker: '..3...3...3...3.',
    },
  }),
  beat({
    id: 'beat-rain-brush',
    name: 'Rain Brush',
    genre: 'lofi',
    also: ['boom-bap'],
    bpm: 84,
    swing: 0.32,
    bars: 2,
    feel: 'dark',
    kit: 'lofi-crate',
    grid: {
      kick: 'X..x.....xX.....|X.......x.......',
      rim: '....X.......X...',
      snare: '...............o|......o.........',
      hat: '4.3.4.3.4.3.4.3.',
      ride: 'x...x...x...x...',
    },
  }),

  /* ---------------- House ---------------- */
  beat({
    id: 'beat-steady-four',
    name: 'Steady Four',
    genre: 'house',
    bpm: 124,
    bars: 1,
    feel: 'driving',
    kit: 'tight-circuit',
    grid: { kick: 'X...X...X...X...', clap: '....x.......x...', hat: 'o.x.o.x.o.x.o.x.' },
  }),
  beat({
    id: 'beat-open-hats',
    name: 'Open Hats',
    genre: 'house',
    bpm: 124,
    swing: 0.15,
    bars: 2,
    feel: 'bright',
    kit: 'punch-909',
    grid: {
      kick: 'X...X...X...X...',
      clap: '....x.......x...',
      hat: 'oo.ooo.ooo.ooo.o',
      openHat: OFFBEAT_OPEN,
    },
    fill: { kick: 'X...X...X...X...', clap: '....x.......x.xx', hat: 'oo.ooo.ooo.o....', openHat: '..x...x.........' },
  }),
  beat({
    id: 'beat-deep-shuffle',
    name: 'Deep Shuffle',
    genre: 'house',
    bpm: 120,
    swing: 0.3,
    bars: 2,
    feel: 'chill',
    kit: 'round-machine',
    grid: {
      kick: 'X...X...X...X...',
      rim: '..o.......o..o..|..o...o...o.....',
      clap: '....x.......x...',
      shaker: 'x3x3x3x3x3x3x3x3',
    },
  }),
  beat({
    id: 'beat-disco-floor',
    name: 'Disco Floor',
    genre: 'house',
    also: ['funk'],
    bpm: 122,
    bars: 2,
    feel: 'bright',
    kit: 'punch-909',
    grid: {
      kick: 'X...X...X...X...',
      snare: '....X.......X...',
      openHat: OFFBEAT_OPEN,
      hat: 'x.o.x.o.x.o.x.o.',
      bell: '................|..........o.o...',
    },
  }),

  /* ---------------- Techno ---------------- */
  beat({
    id: 'beat-warehouse-pulse',
    name: 'Warehouse Pulse',
    genre: 'techno',
    bpm: 128,
    bars: 1,
    feel: 'driving',
    kit: 'punch-909',
    grid: { kick: 'X...X...X...X...', hat: '..x...x...x...x.', clap: '....o.......o...', ride: 'o.o.o.o.o.o.o.o.' },
  }),
  beat({
    id: 'beat-rumble-drive',
    name: 'Rumble Drive',
    genre: 'techno',
    bpm: 132,
    bars: 2,
    feel: 'dark',
    kit: 'iron-forge',
    grid: {
      kick: 'X...X...X...X...',
      kick2: '..o...o...o...o.|..o...o...o.o.o.',
      hat: '.xx..xx..xx..xx.',
      clap: '....x.......x...',
    },
  }),
  beat({
    id: 'beat-minimal-tick',
    name: 'Minimal Tick',
    genre: 'techno',
    also: ['house'],
    bpm: 125,
    bars: 2,
    feel: 'chill',
    kit: 'minimal-click',
    grid: {
      kick: 'X...X...X...X...',
      rim: '...o..o....o....|..o....o..o..o..',
      hat: '..x...x...x...x.',
      perc: '.......o........|...........o....',
    },
  }),
  beat({
    id: 'beat-iron-stomp',
    name: 'Iron Stomp',
    genre: 'techno',
    bpm: 134,
    bars: 1,
    feel: 'dark',
    kit: 'iron-forge',
    grid: { kick: 'X...X...X...X...', snare: '....x.......x...', hat: 'x5x5x5x5x5x5x5x5', openHat: '..o...o...o...o.' },
  }),

  /* ---------------- Pop ---------------- */
  beat({
    id: 'beat-pop-steady',
    name: 'Pop Steady',
    genre: 'pop',
    bpm: 110,
    bars: 2,
    feel: 'bright',
    kit: 'studio-acoustic',
    grid: {
      kick: 'X.......X.X.....|X.......X.......',
      snare: '....X.......X...',
      hat: EIGHTHS,
    },
    fill: { kick: 'X.......X.......', snare: '....X.......XxXx', hat: 'x.x.x.x.........', highTom: '........x.......', midTom: '..........x.....' },
  }),
  beat({
    id: 'beat-clap-along',
    name: 'Clap Along',
    genre: 'pop',
    bpm: 104,
    bars: 2,
    feel: 'bouncy',
    kit: 'round-machine',
    grid: {
      kick: 'X..x..X...X.....|X..x..X...X..x..',
      clap: '....X.......X...',
      hat: '..x...x...x...x.',
      shaker: 'x5x5x5x5x5x5x5x5',
    },
  }),
  beat({
    id: 'beat-bright-bounce',
    name: 'Bright Bounce',
    genre: 'pop',
    also: ['house'],
    bpm: 116,
    bars: 1,
    feel: 'bright',
    kit: 'round-machine',
    grid: { kick: 'X...X...X...X...', clap: '....X.......X...', hat: 'x.xxx.xxx.xxx.xx', openHat: '..............x.' },
  }),
  beat({
    id: 'beat-ballad-pulse',
    name: 'Ballad Pulse',
    genre: 'pop',
    bpm: 76,
    bars: 2,
    feel: 'chill',
    kit: 'studio-acoustic',
    grid: {
      kick: 'X.........X.....|X.....x.........',
      snare: '....X.......X...',
      hat: EIGHTHS_SOFT,
      crash: 'x...............|................',
    },
  }),

  /* ---------------- Rock ---------------- */
  beat({
    id: 'beat-straight-eights',
    name: 'Straight Eights',
    genre: 'rock',
    also: ['pop'],
    bpm: 120,
    bars: 2,
    feel: 'driving',
    kit: 'studio-acoustic',
    grid: {
      kick: 'X.......X.X.....|X.X.....X.......',
      snare: '....X.......X...',
      hat: EIGHTHS,
      crash: 'x...............|................',
    },
    fill: { kick: 'X...............', snare: '....X...XxXx....', highTom: '............xx..', midTom: '..............x.', lowTom: '...............x' },
  }),
  beat({
    id: 'beat-ride-driver',
    name: 'Ride Driver',
    genre: 'rock',
    bpm: 132,
    bars: 1,
    feel: 'driving',
    kit: 'studio-acoustic',
    grid: { kick: 'X.....X.X.......', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.' },
  }),
  beat({
    id: 'beat-half-time-stomp',
    name: 'Half-Time Stomp',
    genre: 'rock',
    bpm: 140,
    bars: 2,
    feel: 'dark',
    kit: 'studio-acoustic',
    grid: {
      kick: 'X.....X.........|X.....X...X.....',
      snare: '........X.......',
      hat: 'x.x.x.x.x.x.x.x.',
      crash: 'x...............|................',
    },
  }),

  /* ---------------- Funk ---------------- */
  beat({
    id: 'beat-pocket-groove',
    name: 'Pocket Groove',
    genre: 'funk',
    bpm: 100,
    swing: 0.1,
    bars: 2,
    feel: 'bouncy',
    kit: 'studio-acoustic',
    grid: {
      kick: 'X.x.......X..x..|X.x.....x.X.....',
      snare: '....X..o.o..X...|....X..o....X..o',
      hat: SIXTEENTHS,
      openHat: '................|..............x.',
    },
  }),
  beat({
    id: 'beat-ghost-notes',
    name: 'Ghost Notes',
    genre: 'funk',
    also: ['breakbeat'],
    bpm: 96,
    swing: 0.12,
    bars: 2,
    feel: 'bouncy',
    kit: 'break-crate',
    grid: {
      kick: 'X......x..X.....|X..x......X..x..',
      snare: '.o..X.o..o.oX.o.|.o..X.o..o..X.oo',
      hat: EIGHTHS,
    },
  }),
  beat({
    id: 'beat-tight-sixteens',
    name: 'Tight Sixteens',
    genre: 'funk',
    also: ['pop'],
    bpm: 108,
    bars: 1,
    feel: 'bright',
    kit: 'round-machine',
    grid: { kick: 'X..x..x...X.....', snare: '....X.......X...', hat: 'x6x6x6x6x6x6x6x6', bell: '......o.......o.' },
  }),

  /* ---------------- Reggaeton ---------------- */
  beat({
    id: 'beat-island-bounce',
    name: 'Island Bounce',
    genre: 'reggaeton',
    bpm: 95,
    bars: 1,
    feel: 'bouncy',
    kit: 'round-machine',
    grid: { kick: 'X...X...X...X...', snare: '...x..x....x..x.', hat: EIGHTHS },
  }),
  beat({
    id: 'beat-tresillo-kick',
    name: 'Tresillo Kick',
    genre: 'reggaeton',
    also: ['afrobeats'],
    bpm: 98,
    bars: 2,
    feel: 'driving',
    kit: 'boom-808',
    grid: {
      kick: 'X..x..x.X..x..x.',
      clap: '...x..x....x..x.',
      hat: 'x.x.x.x.x.x.x.x.',
      rim: '................|...........o.o..',
    },
  }),
  beat({
    id: 'beat-dembow-roll',
    name: 'Dembow Roll',
    genre: 'reggaeton',
    bpm: 92,
    bars: 2,
    feel: 'dark',
    kit: 'boom-808',
    grid: {
      kick: 'X...X...X...X...',
      snare: '...x..x....x..x.|...x..x....x.xxx',
      hat: '..x...x...x...x.',
      shaker: 'x.xxx.xxx.xxx.xx',
    },
  }),

  /* ---------------- Afrobeats ---------------- */
  beat({
    id: 'beat-sunny-shuffle',
    name: 'Sunny Shuffle',
    genre: 'afrobeats',
    bpm: 105,
    swing: 0.2,
    bars: 2,
    feel: 'bouncy',
    kit: 'round-machine',
    grid: {
      kick: 'X......X..X.....|X......X..X..x..',
      rim: '...x..x....x..x.',
      clap: '....x.......x...',
      shaker: 'x5x5x5x5x5x5x5x5',
    },
  }),
  beat({
    id: 'beat-afro-sway',
    name: 'Afro Sway',
    genre: 'afrobeats',
    bpm: 102,
    swing: 0.25,
    bars: 2,
    feel: 'chill',
    kit: 'round-machine',
    grid: {
      kick: 'X..x...X..X.....|X..x......X.....',
      snare: '.......x.......x',
      hat: 'x.xxx.xxx.xxx.xx',
      lowTom: '..........o.....|......o.....o...',
    },
  }),
  beat({
    id: 'beat-warm-step',
    name: 'Warm Step',
    genre: 'afrobeats',
    also: ['pop'],
    bpm: 108,
    swing: 0.18,
    bars: 2,
    feel: 'bright',
    kit: 'studio-acoustic',
    grid: {
      kick: 'X......x..X.....',
      rim: '...x..x.....x...|...x..x...x.....',
      snare: '....o.......o...',
      shaker: 'x4x4x4x4x4x4x4x4',
      bell: '..x.......x.....|..x...x...x.....',
    },
  }),

  /* ---------------- Drum & Bass ---------------- */
  beat({
    id: 'beat-two-step-roller',
    name: 'Two-Step Roller',
    genre: 'dnb',
    bpm: 174,
    bars: 2,
    feel: 'driving',
    kit: 'bright-steel',
    grid: {
      kick: 'X.........X.....|X.........x.....',
      snare: '....X.......X...',
      hat: 'x.xxx.xxx.xxx.xx',
      ride: '..x...x...x...x.',
    },
  }),
  beat({
    id: 'beat-choppy-break',
    name: 'Choppy Break',
    genre: 'dnb',
    also: ['breakbeat'],
    bpm: 172,
    bars: 2,
    feel: 'dark',
    kit: 'break-crate',
    grid: {
      kick: 'X.x.......X.....|..x.......X..x..',
      snare: '....X..o.o..X..o|.o..X..o....X...',
      hat: EIGHTHS,
    },
    fill: { kick: 'X.x.......x.....', snare: '....X..oXoX.XxXX', hat: 'x.x.x.x.........' },
  }),
  beat({
    id: 'beat-liquid-roll',
    name: 'Liquid Roll',
    genre: 'dnb',
    bpm: 174,
    bars: 2,
    feel: 'chill',
    kit: 'bright-steel',
    grid: {
      kick: 'X.........x.....|X.....x...x.....',
      snare: '....X.......X...',
      shaker: 'x4x4x4x4x4x4x4x4',
      ride: 'x...x...x...x...',
    },
  }),
  beat({
    id: 'beat-jungle-run',
    name: 'Jungle Run',
    genre: 'dnb',
    bpm: 168,
    bars: 2,
    feel: 'bouncy',
    kit: 'break-crate',
    grid: {
      kick: 'X.x.....x.......|X.x.......x.....',
      snare: '....X..o.oX..X..|....X..o....X.oo',
      hat: 'x.x.x.x.x.x.x.x.',
      openHat: '................|..............x.',
    },
  }),

  /* ---------------- Breakbeat ---------------- */
  beat({
    id: 'beat-funky-break',
    name: 'Funky Break',
    genre: 'breakbeat',
    also: ['funk'],
    bpm: 128,
    swing: 0.1,
    bars: 2,
    feel: 'bouncy',
    kit: 'break-crate',
    grid: {
      kick: 'X.X.......X.....|X.........X..x..',
      snare: '....X..o.o..X...|....X..o.o..X..o',
      hat: EIGHTHS,
    },
  }),
  beat({
    id: 'beat-big-beat',
    name: 'Big Beat',
    genre: 'breakbeat',
    bpm: 132,
    bars: 2,
    feel: 'driving',
    kit: 'break-crate',
    grid: {
      kick: 'X.....X...X.....|X.....X.X.......',
      snare: '....X.......X...',
      openHat: OFFBEAT_OPEN,
      hat: 'x...x...x...x...',
      crash: 'x...............|................',
    },
  }),
  beat({
    id: 'beat-skippy-break',
    name: 'Skippy Break',
    genre: 'breakbeat',
    also: ['garage'],
    bpm: 134,
    swing: 0.2,
    bars: 2,
    feel: 'bright',
    kit: 'dust-tape',
    grid: {
      kick: 'X......x..X.....|..x....x..X.....',
      snare: '....X.......X..o',
      hat: 'x.xox.xox.xox.xo',
    },
  }),

  /* ---------------- Garage ---------------- */
  beat({
    id: 'beat-two-step-skip',
    name: 'Two-Step Skip',
    genre: 'garage',
    bpm: 136,
    swing: 0.45,
    bars: 2,
    feel: 'bouncy',
    kit: 'bright-steel',
    grid: {
      kick: 'X.........X..x..|X......x..X.....',
      snare: '....X.......X...',
      hat: 'x.xox.xox.xox.xo',
      shaker: '..x...x...x...x.',
    },
  }),
  beat({
    id: 'beat-swung-shuffle',
    name: 'Swung Shuffle',
    genre: 'garage',
    also: ['house'],
    bpm: 132,
    swing: 0.5,
    bars: 1,
    feel: 'chill',
    kit: 'bright-steel',
    grid: { kick: 'X.......X.......', clap: '....X.......X...', hat: '..x...x...x...x.', rim: '.o..o..o.o..o..o' },
  }),
  beat({
    id: 'beat-bumpy-two-step',
    name: 'Bumpy Two-Step',
    genre: 'garage',
    bpm: 138,
    swing: 0.4,
    bars: 2,
    feel: 'dark',
    kit: 'tight-circuit',
    grid: {
      kick: 'X......x..X.....|X.........X..x..',
      snare: '....X.......X...|....X.......X.o.',
      hat: 'oxoxoxoxoxoxoxox',
      openHat: '................|..........x.....',
    },
  }),

  /* ---------------- Synthwave ---------------- */
  beat({
    id: 'beat-neon-drive',
    name: 'Neon Drive',
    genre: 'synthwave',
    bpm: 100,
    bars: 1,
    feel: 'driving',
    kit: 'round-machine',
    grid: { kick: 'X...X...X...X...', snare: '....X.......X...', hat: SIXTEENTHS },
  }),
  beat({
    id: 'beat-big-gate',
    name: 'Big Gate',
    genre: 'synthwave',
    also: ['pop'],
    bpm: 96,
    bars: 2,
    feel: 'bright',
    kit: 'electro-wire',
    grid: {
      kick: 'X.......X.X.....',
      snare: '....X-......X-..',
      hat: EIGHTHS,
      crash: 'x...............|................',
    },
    fill: { kick: 'X.......X.......', snare: '....X-......X...', highTom: '........X.X.....', midTom: '............X.X.', lowTom: '..............X.' },
  }),
  beat({
    id: 'beat-night-cruise',
    name: 'Night Cruise',
    genre: 'synthwave',
    bpm: 88,
    bars: 2,
    feel: 'chill',
    kit: 'electro-wire',
    grid: {
      kick: 'X.........X.....|X.....X...X.....',
      clap: '....X.......X...',
      hat: '..x...x...x...x.',
      perc: '...o.......o....',
    },
  }),

  /* ---------------- Ambient ---------------- */
  beat({
    id: 'beat-soft-steps',
    name: 'Soft Steps',
    genre: 'ambient',
    also: ['lofi'],
    bpm: 72,
    bars: 2,
    feel: 'chill',
    kit: 'round-machine',
    grid: {
      kick: 'x...............|x.........o.....',
      rim: '........4.......',
      shaker: '3.2.3.2.3.2.3.2.',
    },
  }),
  beat({
    id: 'beat-far-pulse',
    name: 'Far Pulse',
    genre: 'ambient',
    also: ['techno'],
    bpm: 110,
    bars: 2,
    feel: 'dark',
    kit: 'minimal-click',
    grid: {
      kick: 'x.......x.......',
      perc: '......o.......o.|..o...o.......o.',
      hat: '..4...4...4...4.',
    },
  }),
];

const byId = new Map(BEATS.map((b) => [b.id, b]));

/** A beat by id. */
export function getBeat(id: string): BeatDef | undefined {
  return byId.get(id);
}

export interface RealizeBeatOptions {
  /** Clip length: a whole multiple of the beat's own length (default its length). */
  bars?: LoopBars;
  /** Write the beat's fill into the last bar (clips of two bars or more with a fill). */
  fill?: boolean;
  /** The part's kit: on Hand Percussion or Afro Latin each voice moves to the pad doing that job. */
  kitId?: string;
}

/** The notes of a beat as a clip for a drum part. */
export function realizeBeat(b: BeatDef, opts: RealizeBeatOptions = {}): RealizedLoop {
  const bars = opts.bars ?? b.bars;
  if (bars % b.bars !== 0) throw new Error(`"${b.name}" is ${b.bars} bars long: a clip from it is a multiple of that.`);
  const layout = kitLayout(opts.kitId) ?? 'kit';
  const voices = (grid: DrumGrid, perBar = STEPS_PER_BAR, n = bars) => gridNotes(n, layoutSlots(layout), mapDrumGrid(grid as Record<string, string>, 'kit', layout), perBar);
  let notes = voices(b.grid);
  if (b.rolls) notes.push(...voices(b.rolls, 2 * STEPS_PER_BAR));
  if (opts.fill && b.fill && bars >= 2) {
    const last = (bars - 1) * TICKS_PER_BAR;
    notes = notes.filter((n) => n.tick < last);
    notes.push(...voices(b.fill, STEPS_PER_BAR, 1).map((n) => ({ ...n, tick: n.tick + last })));
  }
  const def = clip(b.name, bars, notes);
  return { name: def.name, bars, notes: def.notes.map((n) => ({ ...n })) };
}

/** A beat as a library loop (the library's drum loops). */
export function beatLoop(b: BeatDef): LibraryLoop {
  return {
    id: b.id,
    name: b.name,
    role: 'drums',
    genres: [b.genre, ...(b.also ?? [])],
    bars: b.bars,
    feel: b.feel,
    sound: b.kit,
    part: { kind: 'drums', layout: 'kit', grid: b.grid as Record<string, string>, ...(b.rolls ? { fine: b.rolls as Record<string, string> } : {}) },
  };
}
