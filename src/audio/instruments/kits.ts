/**
 * Drum kit recipes: the sound design for the five kits in
 * src/content/catalog.ts (KITS) across the 16-slot DRUM_SLOTS layout.
 *
 * Recipes are pure data. src/audio/instruments/drumSynth.ts turns a recipe
 * into samples. All times are seconds, decays are T60 (time to fall 60 dB),
 * frequencies Hz, and layer levels are relative (each layer is normalised
 * before mixing, so 0.5 means "half as loud as a unit layer").
 *
 * Kit character:
 * - Round Machine — warm, round and long; analog-style, gently saturated.
 * - Tight Circuit — short, clicky, dry and punchy.
 * - Dust Tape — soft, saturated, darker top, lightly bit/rate reduced.
 * - Bright Steel — crisp and bright with a tight low end.
 * - Hand Percussion — congas, bongos, shakers, woods and bells.
 *
 * Slots 4/5/6 are the choke family in every kit (CHOKE_GROUPS): closed /
 * open / pedal hat, or shaker / tambourine / cabasa in Hand Percussion.
 */
import { DRUM_SLOTS } from '../../content/catalog';

/* ------------------------------------------------------------------ */
/* Synthesis models                                                    */
/* ------------------------------------------------------------------ */

/** Sine with an exponential pitch sweep, click transient and saturation. */
export interface KickModel {
  model: 'kick';
  /** Pitch at the strike (Hz). */
  startHz: number;
  /** Settled body pitch (Hz). */
  endHz: number;
  /** Time constant of the main pitch sweep. */
  sweep: number;
  /** Extra, very fast pitch drop added at the strike (Hz) for knock. */
  punchHz: number;
  punchTime: number;
  /** Full-level hold before the body decays. */
  hold: number;
  /** T60 of the body after the hold. */
  decay: number;
  /** Band-passed noise click level. */
  click: number;
  clickHz: number;
  /** tanh saturation amount (0 = clean). */
  drive: number;
  /** Optional low-pass on the whole kick (Hz), 0 = none. */
  tone: number;
}

/** Two tuned body partials plus band-limited noise (snare wires) and a snap. */
export interface SnareModel {
  model: 'snare';
  bodyHz: readonly [number, number];
  bodyLevel: readonly [number, number];
  bodyDecay: number;
  /** Fractional pitch drop of the body at the strike (0.3 = starts 30% sharp). */
  bend: number;
  bendTime: number;
  noise: number;
  noiseDecay: number;
  noiseLow: number;
  noiseHigh: number;
  presenceHz: number;
  presenceDb: number;
  snap: number;
  drive: number;
}

/** Several band-passed noise bursts ~10 ms apart and a diffuse tail. */
export interface ClapModel {
  model: 'clap';
  bursts: number;
  spacing: number;
  burstDecay: number;
  tail: number;
  tailDecay: number;
  bandHz: number;
  q: number;
  highpass: number;
  drive: number;
}

/** Inharmonic square-wave cluster through band/high-pass filters (hats, cymbals, ride). */
export interface MetalModel {
  model: 'metal';
  freqs: readonly number[];
  band: number;
  bandQ: number;
  highpass: number;
  attack: number;
  decay: number;
  /** Noise share (0 = pure metal, 1 = pure noise). */
  noise: number;
  /** Fast initial stage: share of the level and its T60. */
  splash?: { level: number; decay: number };
  /** Low-pass that closes over time (cymbal wash darkening). */
  darken?: { from: number; to: number; time: number };
  /** Ride bell ping: modal partials [ratio, level] around `hz`. */
  bell?: { hz: number; partials: readonly (readonly [number, number])[]; level: number; decay: number };
  /** Stick click level. */
  stick?: number;
}

/** Tuned membrane with a pitch bend, extra modes and slap noise (toms, congas, bongos, cajon). */
export interface MembraneModel {
  model: 'membrane';
  hz: number;
  bend: number;
  bendTime: number;
  decay: number;
  /** Extra modes: [frequency ratio, level, decay scale]. */
  modes: readonly (readonly [number, number, number])[];
  noise: number;
  noiseHz: number;
  noiseQ: number;
  noiseDecay: number;
  click: number;
  drive: number;
}

/** Sum of decaying sinusoidal partials plus a strike (rims, woods, bells, triangle). */
export interface ModalModel {
  model: 'modal';
  hz: number;
  /** [frequency ratio, level, T60]. */
  partials: readonly (readonly [number, number, number])[];
  noise: number;
  noiseHz: number;
  noiseQ: number;
  noiseDecay: number;
  highpass: number;
}

/** Two square oscillators through a band-pass with a two-stage envelope. */
export interface CowbellModel {
  model: 'cowbell';
  hz: readonly [number, number];
  band: number;
  bandQ: number;
  decay: number;
  fast: number;
  fastDecay: number;
  lowpass: number;
}

/** Filtered noise with a swelling attack and bead-like grain. */
export interface ShakerModel {
  model: 'shaker';
  attack: number;
  decay: number;
  band: number;
  bandQ: number;
  highpass: number;
  /** 0 = smooth noise, 1 = sparse bead impacts. */
  grain: number;
  /** Bead impacts per second. */
  density: number;
}

/** Tambourine: jingle partials re-excited by a few clashes, noise and a skin tap. */
export interface JingleModel {
  model: 'jingle';
  freqs: readonly number[];
  hits: number;
  spread: number;
  decay: number;
  noise: number;
  noiseDecay: number;
  highpass: number;
  skin: number;
  skinHz: number;
}

/** Fast downward pitch sweep "zap". */
export interface ZapModel {
  model: 'zap';
  startHz: number;
  endHz: number;
  sweep: number;
  decay: number;
  wave: 'sine' | 'triangle';
  drive: number;
}

/** Finger snap: resonant band-passed noise crack plus a short tone. */
export interface SnapModel {
  model: 'snap';
  band: number;
  q: number;
  decay: number;
  tone: number;
  toneLevel: number;
  toneDecay: number;
}

/** Guiro: a train of resonant scrape ticks. */
export interface GuiroModel {
  model: 'guiro';
  ticks: number;
  duration: number;
  /** Tick placement exponent (< 1 accelerates, > 1 slows down). */
  accel: number;
  band: number;
  q: number;
  tickDecay: number;
}

export type DrumModel =
  | KickModel
  | SnareModel
  | ClapModel
  | MetalModel
  | MembraneModel
  | ModalModel
  | CowbellModel
  | ShakerModel
  | JingleModel
  | ZapModel
  | SnapModel
  | GuiroModel;

/** Post-processing applied to every voice of a kit (overridable per voice). */
export interface KitCharacter {
  /** Saturation amount (0 = clean). */
  drive: number;
  /** Tape-style asymmetry of the saturation (0 = symmetric). */
  asym: number;
  /** Low-pass corner (Hz); >= 20000 disables. */
  lowpass: number;
  /** High-pass corner (Hz); <= 0 disables. */
  highpass: number;
  /** High-shelf gain at 6 kHz (dB). */
  shelfDb: number;
  /** Bit depth; >= 24 disables. */
  bits: number;
  /** Sample-and-hold rate (Hz); 0 disables. */
  rate: number;
}

export interface VoiceRecipe {
  name: string;
  /** Peak level after normalisation (level matching across kits and roles). */
  peak: number;
  /** Fade-in in ms, used only where the attack would otherwise step out of silence. */
  fadeInMs: number;
  model: DrumModel;
  character?: Partial<KitCharacter>;
}

export interface KitRecipe {
  id: string;
  character: KitCharacter;
  /** Exactly 16 voices in DRUM_SLOTS order. */
  voices: readonly VoiceRecipe[];
}

/* ------------------------------------------------------------------ */
/* Shared tunings                                                      */
/* ------------------------------------------------------------------ */

/** The classic six-oscillator metallic cluster (inharmonic square frequencies). */
const HAT_FREQS = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0] as const;

const scaled = (freqs: readonly number[], k: number): number[] => freqs.map((f) => Math.round(f * k * 10) / 10);
/** Crash: two interleaved clusters for a denser wash. */
const CRASH_FREQS = [...HAT_FREQS, ...scaled(HAT_FREQS, 1.4712)];
/** Ride: a higher, sparser cluster so the ping stays defined. */
const RIDE_FREQS = scaled(HAT_FREQS, 1.85);
/** Ride-bell partial ratios (bell-like, slightly inharmonic). */
const BELL_PARTIALS: readonly (readonly [number, number])[] = [
  [1, 1],
  [2.02, 0.5],
  [2.93, 0.35],
  [4.1, 0.2],
];

const CLEAN: KitCharacter = { drive: 0, asym: 0, lowpass: 20000, highpass: 25, shelfDb: 0, bits: 24, rate: 0 };

/* ------------------------------------------------------------------ */
/* Voice builders (keep the kit tables readable)                       */
/* ------------------------------------------------------------------ */

const v = (name: string, peak: number, model: DrumModel, fadeInMs = 0, character?: Partial<KitCharacter>): VoiceRecipe => ({
  name,
  peak,
  fadeInMs,
  model,
  ...(character ? { character } : {}),
});

function toms(
  hz: readonly [number, number, number],
  decays: readonly [number, number, number],
  base: Omit<MembraneModel, 'model' | 'hz' | 'decay'>,
): VoiceRecipe[] {
  const names = ['Low Tom', 'Mid Tom', 'High Tom'];
  return hz.map((f, i) => v(names[i], 0.75, { model: 'membrane', hz: f, decay: decays[i], ...base }));
}

function hats(closed: Omit<MetalModel, 'model'>, open: Partial<MetalModel>, pedal: Partial<MetalModel> | null, character?: Partial<KitCharacter>): VoiceRecipe[] {
  const c: MetalModel = { model: 'metal', ...closed };
  return [
    v('Closed Hat', 0.5, c, 0, character),
    v('Open Hat', 0.46, { ...c, ...open, model: 'metal' }, 0, character),
    ...(pedal ? [v('Pedal Hat', 0.36, { ...c, ...pedal, model: 'metal' }, 0, character)] : []),
  ];
}

/* ------------------------------------------------------------------ */
/* Kits                                                                */
/* ------------------------------------------------------------------ */

const ROUND_MACHINE: KitRecipe = {
  id: 'round-machine',
  character: { ...CLEAN, drive: 0.6, lowpass: 16000, highpass: 20 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 165, endHz: 47, sweep: 0.03, punchHz: 160, punchTime: 0.005, hold: 0.04, decay: 0.68, click: 0.12, clickHz: 2800, drive: 1.4, tone: 5000 }),
    v('Kick 2', 0.95, { model: 'kick', startHz: 125, endHz: 43, sweep: 0.045, punchHz: 70, punchTime: 0.008, hold: 0.06, decay: 0.9, click: 0.05, clickHz: 2000, drive: 1.1, tone: 2500 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [182, 331], bodyLevel: [1, 0.5], bodyDecay: 0.17, bend: 0.28, bendTime: 0.014, noise: 0.42, noiseDecay: 0.25, noiseLow: 1400, noiseHigh: 7500, presenceHz: 4200, presenceDb: 2, snap: 0.15, drive: 1.2 }, 0.5),
    v('Clap', 0.8, { model: 'clap', bursts: 4, spacing: 0.0105, burstDecay: 0.028, tail: 0.5, tailDecay: 0.28, bandHz: 1150, q: 1.1, highpass: 650, drive: 0.8 }),
    ...hats(
      { freqs: HAT_FREQS, band: 9200, bandQ: 0.9, highpass: 6800, attack: 0.0005, decay: 0.085, noise: 0.35 },
      { decay: 0.6, splash: { level: 0.35, decay: 0.12 } },
      null,
    ),
    v('Shaker', 0.4, { model: 'shaker', attack: 0.014, decay: 0.1, band: 7200, bandQ: 0.8, highpass: 4800, grain: 0.5, density: 1600 }),
    v('Rim', 0.7, { model: 'modal', hz: 455, partials: [[1, 0.55, 0.03], [3.74, 1, 0.045], [5.9, 0.2, 0.02]], noise: 0.25, noiseHz: 3000, noiseQ: 1, noiseDecay: 0.012, highpass: 250 }),
    ...toms([92.5, 123.5, 164.8], [0.65, 0.58, 0.5], { bend: 0.22, bendTime: 0.05, modes: [[1.59, 0.12, 0.6]], noise: 0.06, noiseHz: 1200, noiseQ: 0.8, noiseDecay: 0.05, click: 0.04, drive: 1.0 }),
    v('Cowbell', 0.6, { model: 'cowbell', hz: [540, 800], band: 1150, bandQ: 1.3, decay: 0.34, fast: 0.6, fastDecay: 0.045, lowpass: 5000 }),
    v('Crash', 0.5, { model: 'metal', freqs: CRASH_FREQS, band: 7500, bandQ: 0.45, highpass: 3800, attack: 0.001, decay: 2.1, noise: 0.5, splash: { level: 0.45, decay: 0.35 }, darken: { from: 16000, to: 6500, time: 0.6 } }),
    v('Ride', 0.5, { model: 'metal', freqs: RIDE_FREQS, band: 8500, bandQ: 0.6, highpass: 4500, attack: 0.0005, decay: 2.0, noise: 0.15, splash: { level: 0.3, decay: 0.15 }, bell: { hz: 1180, partials: BELL_PARTIALS, level: 0.35, decay: 1.1 }, stick: 0.25, darken: { from: 14000, to: 8000, time: 0.8 } }),
    v('Conga', 0.7, { model: 'membrane', hz: 311.1, bend: 0.05, bendTime: 0.015, decay: 0.32, modes: [[1.5, 0.15, 0.5]], noise: 0.18, noiseHz: 2200, noiseQ: 1.2, noiseDecay: 0.03, click: 0.08, drive: 0.6 }),
    v('Zap', 0.45, { model: 'zap', startHz: 2600, endHz: 95, sweep: 0.02, decay: 0.24, wave: 'sine', drive: 1.5 }),
  ],
};

const TIGHT_CIRCUIT: KitRecipe = {
  id: 'tight-circuit',
  character: { ...CLEAN, drive: 0.3, highpass: 30 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 250, endHz: 52, sweep: 0.018, punchHz: 380, punchTime: 0.0025, hold: 0.025, decay: 0.44, click: 0.3, clickHz: 4500, drive: 2.4, tone: 0 }),
    // Driven techno kick: heavier saturation, fizz tamed by a low-pass.
    v('Kick 2', 0.95, { model: 'kick', startHz: 190, endHz: 49, sweep: 0.022, punchHz: 250, punchTime: 0.003, hold: 0.03, decay: 0.52, click: 0.18, clickHz: 3500, drive: 4.5, tone: 6000 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [215, 338], bodyLevel: [1, 0.75], bodyDecay: 0.1, bend: 0.35, bendTime: 0.008, noise: 0.4, noiseDecay: 0.14, noiseLow: 1500, noiseHigh: 8000, presenceHz: 4000, presenceDb: 3, snap: 0.35, drive: 1.8 }, 0.5),
    v('Clap', 0.8, { model: 'clap', bursts: 3, spacing: 0.009, burstDecay: 0.022, tail: 0.35, tailDecay: 0.12, bandHz: 1300, q: 1.5, highpass: 850, drive: 1.0 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.12), band: 9000, bandQ: 1.1, highpass: 7200, attack: 0.0003, decay: 0.05, noise: 0.18 },
      { decay: 0.3, splash: { level: 0.4, decay: 0.06 } },
      { decay: 0.03, attack: 0.0015, band: 8800, bandQ: 1, highpass: 7400, noise: 0.15 },
    ),
    v('Rim', 0.7, { model: 'modal', hz: 510, partials: [[1, 0.35, 0.018], [3.3, 1, 0.028], [5.2, 0.3, 0.015]], noise: 0.4, noiseHz: 4000, noiseQ: 0.9, noiseDecay: 0.006, highpass: 300 }),
    ...toms([110, 146.8, 196], [0.3, 0.26, 0.22], { bend: 0.16, bendTime: 0.03, modes: [[1.59, 0.08, 0.5]], noise: 0.1, noiseHz: 1800, noiseQ: 0.8, noiseDecay: 0.03, click: 0.12, drive: 1.3 }),
    v('Cowbell', 0.6, { model: 'cowbell', hz: [560, 835], band: 1600, bandQ: 1.6, decay: 0.22, fast: 0.75, fastDecay: 0.03, lowpass: 0 }),
    v('Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.1), band: 8500, bandQ: 0.5, highpass: 4500, attack: 0.0008, decay: 1.2, noise: 0.6, splash: { level: 0.5, decay: 0.25 }, darken: { from: 18000, to: 8000, time: 0.5 } }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 1.05), band: 9000, bandQ: 0.6, highpass: 5000, attack: 0.0005, decay: 1.3, noise: 0.15, splash: { level: 0.3, decay: 0.12 }, bell: { hz: 1320, partials: BELL_PARTIALS, level: 0.25, decay: 0.8 }, stick: 0.3 }),
    v('Blip', 0.7, { model: 'membrane', hz: 587.3, bend: 0.45, bendTime: 0.004, decay: 0.14, modes: [], noise: 0, noiseHz: 3000, noiseQ: 1, noiseDecay: 0.01, click: 0.05, drive: 0.8 }),
    v('Zap', 0.65, { model: 'zap', startHz: 4200, endHz: 140, sweep: 0.011, decay: 0.13, wave: 'triangle', drive: 1.2 }),
  ],
};

/** Dust Tape hats/cymbals keep a little more top than the kit's dark tape roll-off. */
const DUST_METAL: Partial<KitCharacter> = { lowpass: 11500 };

const DUST_TAPE: KitRecipe = {
  id: 'dust-tape',
  character: { ...CLEAN, drive: 1.4, asym: 0.12, lowpass: 8500, highpass: 28, shelfDb: -1.5, bits: 11, rate: 26000 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 140, endHz: 50, sweep: 0.034, punchHz: 90, punchTime: 0.005, hold: 0.03, decay: 0.5, click: 0.08, clickHz: 2200, drive: 2.2, tone: 3200 }),
    v('Kick 2', 0.95, { model: 'kick', startHz: 105, endHz: 46, sweep: 0.05, punchHz: 40, punchTime: 0.008, hold: 0.045, decay: 0.62, click: 0.03, clickHz: 1500, drive: 3.0, tone: 1600 }),
    v('Snare', 0.74, { model: 'snare', bodyHz: [176, 294], bodyLevel: [1, 0.45], bodyDecay: 0.2, bend: 0.18, bendTime: 0.016, noise: 0.36, noiseDecay: 0.27, noiseLow: 1100, noiseHigh: 5200, presenceHz: 2500, presenceDb: 2.5, snap: 0.06, drive: 1.7 }, 0.8),
    v('Clap', 0.7, { model: 'clap', bursts: 4, spacing: 0.012, burstDecay: 0.032, tail: 0.55, tailDecay: 0.3, bandHz: 950, q: 0.9, highpass: 450, drive: 0.8 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 0.92), band: 7600, bandQ: 0.8, highpass: 5600, attack: 0.0006, decay: 0.07, noise: 0.45 },
      { decay: 0.48, splash: { level: 0.3, decay: 0.1 } },
      null,
      DUST_METAL,
    ),
    v('Shaker', 0.4, { model: 'shaker', attack: 0.02, decay: 0.13, band: 6000, bandQ: 0.7, highpass: 3600, grain: 0.65, density: 1300 }, 0, { lowpass: 11000 }),
    v('Side Stick', 0.68, { model: 'modal', hz: 420, partials: [[1, 1, 0.045], [2.61, 0.55, 0.03], [4.3, 0.2, 0.02]], noise: 0.3, noiseHz: 1800, noiseQ: 1.2, noiseDecay: 0.01, highpass: 200 }),
    ...toms([87.3, 116.5, 155.6], [0.58, 0.52, 0.46], { bend: 0.12, bendTime: 0.06, modes: [[1.59, 0.1, 0.6], [2.14, 0.05, 0.4]], noise: 0.12, noiseHz: 900, noiseQ: 0.7, noiseDecay: 0.06, click: 0.02, drive: 1.6 }),
    v('Bell', 0.32, { model: 'modal', hz: 740, partials: [[1, 1, 0.6], [2.76, 0.4, 0.3], [5.4, 0.18, 0.14], [8.93, 0.06, 0.08]], noise: 0.08, noiseHz: 3000, noiseQ: 1, noiseDecay: 0.01, highpass: 150 }),
    v('Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 0.9), band: 6200, bandQ: 0.45, highpass: 3200, attack: 0.0012, decay: 1.7, noise: 0.55, splash: { level: 0.4, decay: 0.3 }, darken: { from: 11000, to: 5000, time: 0.5 } }, 0, DUST_METAL),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 0.92), band: 7000, bandQ: 0.6, highpass: 3800, attack: 0.0006, decay: 1.6, noise: 0.2, splash: { level: 0.25, decay: 0.15 }, bell: { hz: 1050, partials: BELL_PARTIALS, level: 0.3, decay: 1.0 }, stick: 0.2, darken: { from: 10000, to: 6500, time: 0.8 } }, 0, DUST_METAL),
    v('Perc', 0.7, { model: 'membrane', hz: 370, bend: 0.08, bendTime: 0.012, decay: 0.24, modes: [[1.47, 0.2, 0.5]], noise: 0.25, noiseHz: 1700, noiseQ: 1.1, noiseDecay: 0.025, click: 0.05, drive: 1.2 }),
    v('Snap', 0.65, { model: 'snap', band: 2100, q: 2.2, decay: 0.075, tone: 1750, toneLevel: 0.35, toneDecay: 0.03 }, 0.3),
  ],
};

const BRIGHT_STEEL: KitRecipe = {
  id: 'bright-steel',
  character: { ...CLEAN, drive: 0.4, highpass: 38, shelfDb: 2.5 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 240, endHz: 60, sweep: 0.013, punchHz: 520, punchTime: 0.0018, hold: 0.018, decay: 0.28, click: 0.3, clickHz: 6500, drive: 2.0, tone: 0 }),
    v('Kick 2', 0.95, { model: 'kick', startHz: 300, endHz: 66, sweep: 0.01, punchHz: 600, punchTime: 0.0015, hold: 0.014, decay: 0.22, click: 0.42, clickHz: 7000, drive: 2.6, tone: 0 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [238, 405], bodyLevel: [1, 0.7], bodyDecay: 0.11, bend: 0.4, bendTime: 0.007, noise: 0.55, noiseDecay: 0.24, noiseLow: 2600, noiseHigh: 12000, presenceHz: 6500, presenceDb: 4, snap: 0.5, drive: 1.5 }, 0.4),
    v('Clap', 0.8, { model: 'clap', bursts: 3, spacing: 0.0085, burstDecay: 0.02, tail: 0.5, tailDecay: 0.24, bandHz: 2000, q: 1.3, highpass: 1200, drive: 0.8 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.42), band: 12500, bandQ: 1.3, highpass: 9500, attack: 0.0003, decay: 0.035, noise: 0.3 },
      { decay: 0.46, splash: { level: 0.45, decay: 0.05 } },
      null,
    ),
    // Garage shaker in the pedal slot (still in the hat choke group).
    v('Shaker', 0.4, { model: 'shaker', attack: 0.008, decay: 0.08, band: 9500, bandQ: 1, highpass: 6500, grain: 0.4, density: 2600 }),
    v('Rim', 0.7, { model: 'modal', hz: 560, partials: [[1, 0.4, 0.016], [3.1, 1, 0.034], [5.9, 0.45, 0.02]], noise: 0.5, noiseHz: 5000, noiseQ: 0.9, noiseDecay: 0.006, highpass: 350 }),
    ...toms([130.8, 174.6, 233.1], [0.46, 0.41, 0.36], { bend: 0.25, bendTime: 0.028, modes: [[1.59, 0.1, 0.45]], noise: 0.1, noiseHz: 2500, noiseQ: 0.9, noiseDecay: 0.025, click: 0.18, drive: 1.2 }),
    v('Cowbell', 0.58, { model: 'cowbell', hz: [587, 880], band: 2000, bandQ: 1.8, decay: 0.26, fast: 0.6, fastDecay: 0.03, lowpass: 0 }),
    v('Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.25), band: 9500, bandQ: 0.5, highpass: 5200, attack: 0.0006, decay: 2.0, noise: 0.4, splash: { level: 0.45, decay: 0.25 }, darken: { from: 20000, to: 9500, time: 0.7 } }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 1.15), band: 10000, bandQ: 0.6, highpass: 6000, attack: 0.0004, decay: 1.9, noise: 0.1, splash: { level: 0.3, decay: 0.1 }, bell: { hz: 1480, partials: BELL_PARTIALS, level: 0.45, decay: 1.2 }, stick: 0.35 }),
    v('Perc', 0.7, { model: 'membrane', hz: 494, bend: 0.14, bendTime: 0.006, decay: 0.18, modes: [[1.5, 0.18, 0.5]], noise: 0.3, noiseHz: 3200, noiseQ: 1.4, noiseDecay: 0.02, click: 0.1, drive: 1.0 }),
    v('Snap', 0.65, { model: 'snap', band: 2900, q: 2.6, decay: 0.06, tone: 2300, toneLevel: 0.3, toneDecay: 0.025 }, 0.2),
  ],
};

/** Conga/bongo family: same membrane, different sizes. */
function handDrum(name: string, hz: number, decay: number, noise: number, noiseHz: number, noiseDecay: number): VoiceRecipe {
  return v(name, 0.75, {
    model: 'membrane',
    hz,
    bend: 0.045,
    bendTime: 0.02,
    decay,
    modes: [
      [1.47, 0.18, 0.55],
      [2.09, 0.07, 0.35],
    ],
    noise,
    noiseHz,
    noiseQ: 1.0,
    noiseDecay,
    click: 0.06,
    drive: 0.5,
  });
}

const AGOGO_PARTIALS: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.75],
  [1.51, 0.12, 0.4],
  [2.76, 0.35, 0.32],
  [4.12, 0.14, 0.18],
];

const HAND_PERCUSSION: KitRecipe = {
  id: 'hand-percussion',
  character: { ...CLEAN, drive: 0.2, highpass: 35 },
  voices: [
    handDrum('Low Conga', 196, 0.45, 0.22, 1400, 0.03),
    handDrum('High Conga', 293.7, 0.36, 0.25, 1800, 0.028),
    handDrum('Bongo Lo', 392, 0.22, 0.3, 2400, 0.02),
    handDrum('Bongo Hi', 587.3, 0.17, 0.34, 3000, 0.018),
    v('Shaker', 0.45, { model: 'shaker', attack: 0.009, decay: 0.075, band: 8000, bandQ: 0.9, highpass: 5500, grain: 0.75, density: 2600 }),
    v('Tambourine', 0.5, { model: 'jingle', freqs: [5200, 6340, 7710, 8830, 10150, 11700], hits: 4, spread: 0.02, decay: 0.42, noise: 0.4, noiseDecay: 0.06, highpass: 4000, skin: 0.12, skinHz: 260 }),
    v('Cabasa', 0.42, { model: 'shaker', attack: 0.004, decay: 0.055, band: 9500, bandQ: 1.0, highpass: 6500, grain: 0.25, density: 5000 }),
    v('Clave', 0.6, { model: 'modal', hz: 2480, partials: [[1, 1, 0.09], [3.9, 0.06, 0.03]], noise: 0.05, noiseHz: 5000, noiseQ: 1, noiseDecay: 0.003, highpass: 400 }),
    v('Woodblock', 0.65, { model: 'modal', hz: 880, partials: [[1, 1, 0.07], [2.31, 0.45, 0.045], [3.92, 0.2, 0.03]], noise: 0.2, noiseHz: 2200, noiseQ: 1.2, noiseDecay: 0.006, highpass: 200 }),
    v('Agogo Lo', 0.55, { model: 'modal', hz: 659.3, partials: AGOGO_PARTIALS, noise: 0.1, noiseHz: 3500, noiseQ: 1, noiseDecay: 0.006, highpass: 200 }),
    v('Agogo Hi', 0.55, { model: 'modal', hz: 987.8, partials: AGOGO_PARTIALS, noise: 0.1, noiseHz: 4500, noiseQ: 1, noiseDecay: 0.005, highpass: 300 }),
    v('Cowbell', 0.6, { model: 'cowbell', hz: [548, 812], band: 1250, bandQ: 1.1, decay: 0.3, fast: 0.55, fastDecay: 0.04, lowpass: 6000 }),
    v('Triangle', 0.45, {
      model: 'modal',
      hz: 1180,
      partials: [
        [1, 0.55, 1.5],
        [2.02, 0.3, 1.3],
        [2.97, 0.5, 1.2],
        [4.08, 0.45, 1.0],
        [5.17, 0.35, 0.85],
        [6.36, 0.3, 0.7],
        [7.88, 0.22, 0.55],
      ],
      noise: 0.05,
      noiseHz: 7000,
      noiseQ: 1,
      noiseDecay: 0.004,
      highpass: 800,
    }),
    v('Guiro', 0.65, { model: 'guiro', ticks: 18, duration: 0.2, accel: 0.9, band: 3200, q: 3.5, tickDecay: 0.004 }),
    v('Cajon', 0.9, { model: 'membrane', hz: 82.4, bend: 0.14, bendTime: 0.025, decay: 0.34, modes: [[1.59, 0.1, 0.5]], noise: 0.3, noiseHz: 3200, noiseQ: 0.7, noiseDecay: 0.09, click: 0.12, drive: 1.0 }),
    v('Finger Snap', 0.65, { model: 'snap', band: 2400, q: 2.4, decay: 0.065, tone: 1950, toneLevel: 0.3, toneDecay: 0.03 }, 0.2),
  ],
};

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

export const KIT_RECIPES: Readonly<Record<string, KitRecipe>> = {
  [ROUND_MACHINE.id]: ROUND_MACHINE,
  [TIGHT_CIRCUIT.id]: TIGHT_CIRCUIT,
  [DUST_TAPE.id]: DUST_TAPE,
  [BRIGHT_STEEL.id]: BRIGHT_STEEL,
  [HAND_PERCUSSION.id]: HAND_PERCUSSION,
};

/** Kit used for unknown ids (e.g. a project from a newer version). */
export const DEFAULT_KIT_ID = 'round-machine';

/** The known kit id for `kitId`, or the default kit. */
export function resolveKitId(kitId: string): string {
  return Object.prototype.hasOwnProperty.call(KIT_RECIPES, kitId) ? kitId : DEFAULT_KIT_ID;
}

export function getKitRecipe(kitId: string): KitRecipe {
  return KIT_RECIPES[resolveKitId(kitId)];
}

/** Clamp/round any number to a valid slot index 0..15. */
export function clampSlot(slot: number): number {
  const s = Number.isFinite(slot) ? Math.round(slot) : 0;
  return Math.min(DRUM_SLOTS.length - 1, Math.max(0, s));
}

export function getVoiceRecipe(kitId: string, slot: number): VoiceRecipe {
  return getKitRecipe(kitId).voices[clampSlot(slot)];
}

/** Effective post-processing for one voice (kit character with the voice's overrides). */
export function voiceCharacter(kitId: string, slot: number): KitCharacter {
  const kit = getKitRecipe(kitId);
  return { ...kit.character, ...(kit.voices[clampSlot(slot)].character ?? {}) };
}

/** The 16 pad names of a kit, in slot order. Unknown kits fall back to the default kit. */
export function getKitVoiceNames(kitId: string): string[] {
  return getKitRecipe(kitId).voices.map((r) => r.name);
}
