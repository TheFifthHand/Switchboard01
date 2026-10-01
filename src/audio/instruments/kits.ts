/**
 * Drum kit recipes: the sound design for the kits in
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
 * - 808 Machine — long sine boom, snappy two-tone snare, classic six-square
 *   hats and cowbell, sine toms and conga, clave.
 * - 909 Punch — clicky punchy kick, noisy snare, noise-heavy hats, bright
 *   cymbals.
 * - Trap Night — hard short kick, a long distorted 808 on Kick 2, crisp
 *   snare, very short hats for rolls, a melodic bell.
 * - Lo-fi Crate — heavily crushed (8-bit, 12 kHz) and saturated, dark top;
 *   the metals keep a little more air; a vinyl crackle pad.
 * - Studio Acoustic — beater click, ringing wired snare, noisy natural hats
 *   with a pedal hat, many-mode toms, long cymbals, tambourine.
 * - Electro Wire — zappy kick, laser toms, thin metallic hats, blips.
 * - Iron Forge — heavy drive, metallic snare, anvil, pipe and sheet-metal
 *   hits, a grinding scrape.
 * - Minimal Click — tiny, short and dry: clicks, ticks and blips.
 * - Breakbeat Crate — punchy, saturated funk-break kit with a cracking
 *   snare, ghost snare, tambourine and a scratch.
 * - Afro Latin — djembe (bass, tone, slap), talking drum, surdo, timbales,
 *   shekere, caxixi, ganza, agogo, cuica, bell and udu.
 *
 * Each kit lists its own choke groups (KitRecipe.chokeGroups): the closed
 * hat chokes the open hat, and the pedal hat does too where slot 6 is one
 * (Tight Circuit, 909 Punch, Trap Night, Studio Acoustic, Electro Wire). In
 * Afro Latin the djembe's bass, tone and slap are one drum and cut each
 * other. Shakers, tambourines and the like choke nothing else; a new hit on
 * slot 4, 5 or 6 still cuts that slot's own previous hit (see drumKit.ts).
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
  /** Slots that cut each other off (the later hit wins), e.g. closed and open hat. */
  chokeGroups: readonly (readonly number[])[];
}

/** Closed hat (slot 4) chokes the open hat (slot 5). */
const HAT_CHOKE: readonly (readonly number[])[] = [[4, 5]];

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
  chokeGroups: HAT_CHOKE,
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
  // The pedal hat on slot 6 chokes the open hat as well.
  chokeGroups: [[4, 5, 6]],
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
  chokeGroups: HAT_CHOKE,
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
    // Garage shaker in the pedal slot (it does not choke the hats).
    v('Shaker', 0.4, { model: 'shaker', attack: 0.008, decay: 0.08, band: 9500, bandQ: 1, highpass: 6500, grain: 0.4, density: 2600 }),
    v('Rim', 0.7, { model: 'modal', hz: 560, partials: [[1, 0.4, 0.016], [3.1, 1, 0.034], [5.9, 0.45, 0.02]], noise: 0.5, noiseHz: 5000, noiseQ: 0.9, noiseDecay: 0.006, highpass: 350 }),
    ...toms([130.8, 174.6, 233.1], [0.46, 0.41, 0.36], { bend: 0.25, bendTime: 0.028, modes: [[1.59, 0.1, 0.45]], noise: 0.1, noiseHz: 2500, noiseQ: 0.9, noiseDecay: 0.025, click: 0.18, drive: 1.2 }),
    v('Cowbell', 0.58, { model: 'cowbell', hz: [587, 880], band: 2000, bandQ: 1.8, decay: 0.26, fast: 0.6, fastDecay: 0.03, lowpass: 0 }),
    v('Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.25), band: 9500, bandQ: 0.5, highpass: 5200, attack: 0.0006, decay: 2.0, noise: 0.4, splash: { level: 0.45, decay: 0.25 }, darken: { from: 20000, to: 9500, time: 0.7 } }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 1.15), band: 10000, bandQ: 0.6, highpass: 6000, attack: 0.0004, decay: 1.9, noise: 0.1, splash: { level: 0.3, decay: 0.1 }, bell: { hz: 1480, partials: BELL_PARTIALS, level: 0.45, decay: 1.2 }, stick: 0.35 }),
    v('Perc', 0.7, { model: 'membrane', hz: 494, bend: 0.14, bendTime: 0.006, decay: 0.18, modes: [[1.5, 0.18, 0.5]], noise: 0.3, noiseHz: 3200, noiseQ: 1.4, noiseDecay: 0.02, click: 0.1, drive: 1.0 }),
    v('Snap', 0.65, { model: 'snap', band: 2900, q: 2.6, decay: 0.06, tone: 2300, toneLevel: 0.3, toneDecay: 0.025 }, 0.2),
  ],
  chokeGroups: HAT_CHOKE,
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
  // Shaker, tambourine and cabasa are separate instruments: none cuts another.
  chokeGroups: [],
};

/* ------------------------------------------------------------------ */
/* The extended kits                                                   */
/* ------------------------------------------------------------------ */

/** Closed hat, open hat and pedal hat on slot 6 all cut each other. */
const PEDAL_HAT_CHOKE: readonly (readonly number[])[] = [[4, 5, 6]];

const BOOM_808: KitRecipe = {
  id: 'boom-808',
  character: { ...CLEAN, drive: 0.15, highpass: 20 },
  voices: [
    // A slow, shallow sweep into a long, pure sine boom.
    v('Kick', 0.95, { model: 'kick', startHz: 95, endHz: 49, sweep: 0.05, punchHz: 60, punchTime: 0.004, hold: 0.02, decay: 1.3, click: 0.02, clickHz: 1800, drive: 0.6, tone: 0 }),
    v('Kick 2', 0.95, { model: 'kick', startHz: 130, endHz: 56, sweep: 0.03, punchHz: 100, punchTime: 0.004, hold: 0.01, decay: 0.45, click: 0.06, clickHz: 2500, drive: 1.0, tone: 0 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [238, 476], bodyLevel: [1, 0.6], bodyDecay: 0.16, bend: 0.12, bendTime: 0.01, noise: 0.6, noiseDecay: 0.2, noiseLow: 1800, noiseHigh: 9000, presenceHz: 5000, presenceDb: 2, snap: 0.2, drive: 0.5 }, 0.5),
    v('Clap', 0.8, { model: 'clap', bursts: 4, spacing: 0.011, burstDecay: 0.025, tail: 0.6, tailDecay: 0.35, bandHz: 1100, q: 1.2, highpass: 700, drive: 0.4 }),
    ...hats({ freqs: HAT_FREQS, band: 10000, bandQ: 0.9, highpass: 7500, attack: 0.0004, decay: 0.06, noise: 0.2 }, { decay: 0.38, splash: { level: 0.25, decay: 0.08 } }, null),
    v('Maracas', 0.4, { model: 'shaker', attack: 0.003, decay: 0.05, band: 8500, bandQ: 1, highpass: 6000, grain: 0.2, density: 4000 }),
    v('Rimshot', 0.7, { model: 'modal', hz: 1650, partials: [[1, 1, 0.025], [0.29, 0.5, 0.02]], noise: 0.15, noiseHz: 3000, noiseQ: 1, noiseDecay: 0.006, highpass: 200 }),
    ...toms([98, 130.8, 174.6], [0.9, 0.75, 0.6], { bend: 0.1, bendTime: 0.04, modes: [], noise: 0.03, noiseHz: 1200, noiseQ: 0.8, noiseDecay: 0.02, click: 0.02, drive: 0.3 }),
    v('Cowbell', 0.6, { model: 'cowbell', hz: [540, 800], band: 1700, bandQ: 1.4, decay: 0.45, fast: 0.7, fastDecay: 0.03, lowpass: 0 }),
    v('Cymbal', 0.5, { model: 'metal', freqs: HAT_FREQS, band: 8000, bandQ: 0.35, highpass: 3000, attack: 0.001, decay: 2.0, noise: 0.5, splash: { level: 0.45, decay: 0.35 }, darken: { from: 14000, to: 5500, time: 0.5 } }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 0.95), band: 7500, bandQ: 0.7, highpass: 4200, attack: 0.0005, decay: 1.8, noise: 0.15, splash: { level: 0.3, decay: 0.2 }, bell: { hz: 1100, partials: BELL_PARTIALS, level: 0.25, decay: 0.9 }, stick: 0.15 }),
    v('Conga', 0.7, { model: 'membrane', hz: 330, bend: 0.06, bendTime: 0.008, decay: 0.25, modes: [], noise: 0, noiseHz: 2000, noiseQ: 1, noiseDecay: 0.01, click: 0.03, drive: 0.2 }),
    v('Clave', 0.55, { model: 'modal', hz: 2500, partials: [[1, 1, 0.06]], noise: 0.02, noiseHz: 5000, noiseQ: 1, noiseDecay: 0.003, highpass: 400 }),
  ],
  chokeGroups: HAT_CHOKE,
};

const PUNCH_909: KitRecipe = {
  id: 'punch-909',
  character: { ...CLEAN, drive: 0.5, highpass: 30, shelfDb: 1 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 280, endHz: 52, sweep: 0.016, punchHz: 400, punchTime: 0.002, hold: 0.02, decay: 0.5, click: 0.35, clickHz: 5000, drive: 2.0, tone: 8000 }),
    v('Long Kick', 0.95, { model: 'kick', startHz: 220, endHz: 47, sweep: 0.025, punchHz: 300, punchTime: 0.003, hold: 0.04, decay: 0.8, click: 0.2, clickHz: 4000, drive: 3.0, tone: 5000 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [180, 330], bodyLevel: [1, 0.55], bodyDecay: 0.11, bend: 0.3, bendTime: 0.008, noise: 0.6, noiseDecay: 0.22, noiseLow: 1200, noiseHigh: 11000, presenceHz: 6000, presenceDb: 3, snap: 0.4, drive: 1.4 }, 0.4),
    v('Clap', 0.8, { model: 'clap', bursts: 4, spacing: 0.009, burstDecay: 0.018, tail: 0.45, tailDecay: 0.2, bandHz: 1500, q: 1.4, highpass: 900, drive: 0.9 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.25), band: 11000, bandQ: 0.7, highpass: 8000, attack: 0.0003, decay: 0.045, noise: 0.55 },
      { decay: 0.42, splash: { level: 0.4, decay: 0.07 } },
      { decay: 0.028, attack: 0.0012, noise: 0.5 },
    ),
    v('Rim', 0.7, { model: 'modal', hz: 520, partials: [[1, 0.5, 0.025], [2.94, 1, 0.045], [5.6, 0.3, 0.02]], noise: 0.45, noiseHz: 4500, noiseQ: 1, noiseDecay: 0.005, highpass: 300 }),
    ...toms([116.5, 146.8, 185], [0.45, 0.4, 0.34], { bend: 0.25, bendTime: 0.03, modes: [[1.5, 0.08, 0.5]], noise: 0.04, noiseHz: 1400, noiseQ: 0.8, noiseDecay: 0.03, click: 0.04, drive: 1.4 }),
    v('Cowbell', 0.6, { model: 'cowbell', hz: [587, 845], band: 1400, bandQ: 1.5, decay: 0.28, fast: 0.65, fastDecay: 0.035, lowpass: 7000 }),
    v('Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.15), band: 9000, bandQ: 0.45, highpass: 5000, attack: 0.0006, decay: 1.4, noise: 0.7, splash: { level: 0.5, decay: 0.2 }, darken: { from: 20000, to: 9000, time: 0.6 } }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 1.1), band: 9500, bandQ: 0.7, highpass: 5500, attack: 0.0004, decay: 2.2, noise: 0.2, splash: { level: 0.25, decay: 0.1 }, bell: { hz: 1400, partials: BELL_PARTIALS, level: 0.3, decay: 1.0 }, stick: 0.3 }),
    v('Shaker', 0.42, { model: 'shaker', attack: 0.006, decay: 0.07, band: 9000, bandQ: 1, highpass: 6000, grain: 0.3, density: 3000 }),
    v('Zap', 0.6, { model: 'zap', startHz: 3000, endHz: 200, sweep: 0.015, decay: 0.15, wave: 'sine', drive: 1.0 }),
  ],
  chokeGroups: PEDAL_HAT_CHOKE,
};

const TRAP_NIGHT: KitRecipe = {
  id: 'trap-night',
  character: { ...CLEAN, drive: 0.3, highpass: 25, shelfDb: 1.5 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 200, endHz: 55, sweep: 0.015, punchHz: 350, punchTime: 0.002, hold: 0.015, decay: 0.32, click: 0.3, clickHz: 5500, drive: 2.2, tone: 9000 }),
    // The long, distorted 808 that carries trap bass lines (tune it per note with the voice Tune).
    v('808', 0.95, { model: 'kick', startHz: 120, endHz: 46, sweep: 0.06, punchHz: 80, punchTime: 0.004, hold: 0.05, decay: 1.8, click: 0.03, clickHz: 2000, drive: 2.5, tone: 2400 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [210, 390], bodyLevel: [1, 0.6], bodyDecay: 0.1, bend: 0.4, bendTime: 0.006, noise: 0.6, noiseDecay: 0.18, noiseLow: 2000, noiseHigh: 12000, presenceHz: 7000, presenceDb: 4, snap: 0.6, drive: 1.6 }, 0.3),
    v('Clap', 0.8, { model: 'clap', bursts: 4, spacing: 0.012, burstDecay: 0.022, tail: 0.7, tailDecay: 0.4, bandHz: 1250, q: 1.0, highpass: 800, drive: 0.7 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.55), band: 12000, bandQ: 1.4, highpass: 9000, attack: 0.0002, decay: 0.03, noise: 0.25 },
      { decay: 0.3, splash: { level: 0.3, decay: 0.05 } },
      { decay: 0.022, attack: 0.0008 },
    ),
    v('Rim', 0.7, { model: 'modal', hz: 600, partials: [[1, 0.4, 0.02], [3.3, 1, 0.035], [5.9, 0.4, 0.02]], noise: 0.5, noiseHz: 5500, noiseQ: 0.9, noiseDecay: 0.005, highpass: 350 }),
    ...toms([110, 146.8, 196], [0.7, 0.6, 0.5], { bend: 0.15, bendTime: 0.03, modes: [], noise: 0.05, noiseHz: 1500, noiseQ: 0.8, noiseDecay: 0.02, click: 0.05, drive: 0.8 }),
    v('Bell', 0.45, { model: 'modal', hz: 1046.5, partials: [[1, 1, 0.5], [2, 0.3, 0.25], [3, 0.15, 0.12], [4.2, 0.08, 0.08]], noise: 0.05, noiseHz: 4000, noiseQ: 1, noiseDecay: 0.004, highpass: 300 }),
    v('Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.3), band: 10000, bandQ: 0.5, highpass: 6000, attack: 0.0006, decay: 2.2, noise: 0.65, splash: { level: 0.5, decay: 0.2 }, darken: { from: 20000, to: 10000, time: 0.5 } }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 1.2), band: 10500, bandQ: 0.6, highpass: 6500, attack: 0.0004, decay: 1.3, noise: 0.1, splash: { level: 0.3, decay: 0.1 }, bell: { hz: 1600, partials: BELL_PARTIALS, level: 0.4, decay: 0.9 }, stick: 0.3 }),
    v('Snap', 0.6, { model: 'snap', band: 2600, q: 2.4, decay: 0.05, tone: 2000, toneLevel: 0.25, toneDecay: 0.02 }, 0.2),
    v('Laser', 0.55, { model: 'zap', startHz: 1500, endHz: 300, sweep: 0.04, decay: 0.2, wave: 'triangle', drive: 2 }),
  ],
  chokeGroups: PEDAL_HAT_CHOKE,
};

/** Lo-fi Crate metals keep more air than the crushed drums. */
const LOFI_METAL: Partial<KitCharacter> = { lowpass: 13000, rate: 0, bits: 12, drive: 1.2 };

const LOFI_CRATE: KitRecipe = {
  id: 'lofi-crate',
  character: { drive: 2.2, asym: 0.25, lowpass: 5000, highpass: 55, shelfDb: -2.5, bits: 10, rate: 11025 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 120, endHz: 52, sweep: 0.04, punchHz: 60, punchTime: 0.006, hold: 0.04, decay: 0.36, click: 0.05, clickHz: 1500, drive: 2.5, tone: 1800 }),
    v('Thump', 0.95, { model: 'kick', startHz: 95, endHz: 48, sweep: 0.05, punchHz: 30, punchTime: 0.01, hold: 0.05, decay: 0.8, click: 0.1, clickHz: 900, drive: 1.5, tone: 1200 }),
    v('Snare', 0.76, { model: 'snare', bodyHz: [165, 280], bodyLevel: [1, 0.6], bodyDecay: 0.26, bend: 0.15, bendTime: 0.015, noise: 0.45, noiseDecay: 0.36, noiseLow: 900, noiseHigh: 4500, presenceHz: 2000, presenceDb: 3, snap: 0.08, drive: 2 }, 0.8),
    v('Clap', 0.72, { model: 'clap', bursts: 3, spacing: 0.013, burstDecay: 0.03, tail: 0.5, tailDecay: 0.4, bandHz: 900, q: 0.8, highpass: 400, drive: 1.0 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 0.85), band: 7000, bandQ: 0.7, highpass: 5200, attack: 0.0008, decay: 0.045, noise: 0.6 },
      { decay: 0.32, splash: { level: 0.3, decay: 0.1 } },
      null,
      LOFI_METAL,
    ),
    v('Shaker', 0.4, { model: 'shaker', attack: 0.025, decay: 0.08, band: 6500, bandQ: 0.6, highpass: 4500, grain: 0.8, density: 900 }, 0, LOFI_METAL),
    v('Side Stick', 0.68, { model: 'modal', hz: 380, partials: [[1, 1, 0.08], [2.4, 0.5, 0.05], [4.1, 0.2, 0.03]], noise: 0.35, noiseHz: 1500, noiseQ: 1, noiseDecay: 0.012, highpass: 180 }),
    ...toms([82.4, 110, 146.8], [0.4, 0.36, 0.32], { bend: 0.1, bendTime: 0.05, modes: [[1.59, 0.15, 0.5]], noise: 0.15, noiseHz: 800, noiseQ: 0.7, noiseDecay: 0.05, click: 0.03, drive: 2 }),
    v('Cowbell', 0.55, { model: 'cowbell', hz: [520, 780], band: 1000, bandQ: 1, decay: 0.3, fast: 0.5, fastDecay: 0.05, lowpass: 3500 }),
    v('Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 0.85), band: 6000, bandQ: 0.4, highpass: 3000, attack: 0.0012, decay: 1.2, noise: 0.6, splash: { level: 0.4, decay: 0.3 }, darken: { from: 9000, to: 4000, time: 0.4 } }, 0, { lowpass: 10000, rate: 0 }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 0.85), band: 6500, bandQ: 0.6, highpass: 3500, attack: 0.0006, decay: 1.1, noise: 0.25, splash: { level: 0.25, decay: 0.15 }, bell: { hz: 950, partials: BELL_PARTIALS, level: 0.3, decay: 0.8 }, stick: 0.15, darken: { from: 9000, to: 6000, time: 0.6 } }, 0, { lowpass: 10000, rate: 0 }),
    // Sparse, random dust clicks: the surface noise of an old record.
    v('Crackle', 0.5, { model: 'shaker', attack: 0.001, decay: 0.6, band: 3000, bandQ: 0.5, highpass: 1500, grain: 1, density: 60 }),
    v('Snap', 0.62, { model: 'snap', band: 1800, q: 2, decay: 0.11, tone: 1500, toneLevel: 0.4, toneDecay: 0.035 }, 0.3),
  ],
  chokeGroups: HAT_CHOKE,
};

const STUDIO_ACOUSTIC: KitRecipe = {
  id: 'studio-acoustic',
  character: { ...CLEAN, drive: 0.2, highpass: 30, shelfDb: 0.5 },
  voices: [
    // A beater click on a short, woody body.
    v('Kick', 0.95, { model: 'kick', startHz: 110, endHz: 56, sweep: 0.012, punchHz: 140, punchTime: 0.002, hold: 0.03, decay: 0.32, click: 0.4, clickHz: 3500, drive: 0.8, tone: 6000 }),
    v('Muffled Kick', 0.95, { model: 'kick', startHz: 95, endHz: 50, sweep: 0.015, punchHz: 90, punchTime: 0.003, hold: 0.035, decay: 0.3, click: 0.25, clickHz: 2500, drive: 0.6, tone: 2500 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [195, 360], bodyLevel: [1, 0.55], bodyDecay: 0.2, bend: 0.12, bendTime: 0.01, noise: 0.6, noiseDecay: 0.42, noiseLow: 1500, noiseHigh: 10000, presenceHz: 4500, presenceDb: 2.5, snap: 0.3, drive: 0.6 }, 0.3),
    v('Hand Clap', 0.78, { model: 'clap', bursts: 4, spacing: 0.0115, burstDecay: 0.02, tail: 0.45, tailDecay: 0.22, bandHz: 1250, q: 0.9, highpass: 600, drive: 0.6 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.3), band: 9500, bandQ: 0.5, highpass: 6500, attack: 0.0008, decay: 0.11, noise: 0.6 },
      { decay: 0.85, splash: { level: 0.3, decay: 0.12 } },
      { decay: 0.04, attack: 0.002, noise: 0.5 },
    ),
    v('Cross Stick', 0.68, { model: 'modal', hz: 500, partials: [[1, 1, 0.04], [2.2, 0.6, 0.025], [3.7, 0.3, 0.015]], noise: 0.3, noiseHz: 2500, noiseQ: 1.1, noiseDecay: 0.008, highpass: 250 }),
    ...toms([98, 123.5, 155.6], [0.85, 0.75, 0.65], { bend: 0.1, bendTime: 0.06, modes: [[1.59, 0.1, 0.5], [2.14, 0.04, 0.35]], noise: 0.06, noiseHz: 1500, noiseQ: 0.6, noiseDecay: 0.06, click: 0.06, drive: 0.4 }),
    v('Tambourine', 0.48, { model: 'jingle', freqs: [5400, 6600, 7900, 9100, 10400], hits: 3, spread: 0.015, decay: 0.3, noise: 0.35, noiseDecay: 0.05, highpass: 4500, skin: 0.1, skinHz: 300 }),
    v('Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.05), band: 7000, bandQ: 0.35, highpass: 3500, attack: 0.001, decay: 3.0, noise: 0.6, splash: { level: 0.45, decay: 0.4 }, darken: { from: 16000, to: 6000, time: 0.9 } }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 0.9), band: 8000, bandQ: 0.5, highpass: 4000, attack: 0.0005, decay: 2.6, noise: 0.25, splash: { level: 0.2, decay: 0.15 }, bell: { hz: 1250, partials: BELL_PARTIALS, level: 0.4, decay: 1.4 }, stick: 0.4, darken: { from: 13000, to: 7500, time: 1.0 } }),
    v('Shaker', 0.42, { model: 'shaker', attack: 0.012, decay: 0.09, band: 7500, bandQ: 0.8, highpass: 5000, grain: 0.6, density: 2000 }),
    v('Splash', 0.45, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.4), band: 10000, bandQ: 0.5, highpass: 6000, attack: 0.0006, decay: 0.9, noise: 0.5, splash: { level: 0.5, decay: 0.15 } }),
  ],
  chokeGroups: PEDAL_HAT_CHOKE,
};

const ELECTRO_WIRE: KitRecipe = {
  id: 'electro-wire',
  character: { ...CLEAN, drive: 0.6, highpass: 30, shelfDb: 2 },
  voices: [
    // A steep 400 Hz dive with a hard punch: the zappy electro kick.
    v('Kick', 0.95, { model: 'kick', startHz: 400, endHz: 55, sweep: 0.012, punchHz: 900, punchTime: 0.0015, hold: 0.03, decay: 0.4, click: 0.1, clickHz: 3000, drive: 2.0, tone: 7000 }),
    v('Boom Kick', 0.95, { model: 'kick', startHz: 150, endHz: 45, sweep: 0.04, punchHz: 200, punchTime: 0.004, hold: 0.08, decay: 0.7, click: 0, clickHz: 1000, drive: 1.5, tone: 3000 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [260, 520], bodyLevel: [1, 0.4], bodyDecay: 0.12, bend: 0.6, bendTime: 0.005, noise: 0.4, noiseDecay: 0.22, noiseLow: 2500, noiseHigh: 10000, presenceHz: 6000, presenceDb: 4, snap: 0.3, drive: 2.0 }, 0.3),
    v('Clap', 0.8, { model: 'clap', bursts: 3, spacing: 0.0085, burstDecay: 0.015, tail: 0.4, tailDecay: 0.28, bandHz: 1800, q: 2.0, highpass: 1100, drive: 1.2 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.8), band: 13000, bandQ: 2.0, highpass: 10000, attack: 0.0002, decay: 0.055, noise: 0.1 },
      { decay: 0.45, splash: { level: 0.2, decay: 0.05 } },
      { decay: 0.032, attack: 0.001 },
    ),
    v('Rim Blip', 0.65, { model: 'modal', hz: 1800, partials: [[1, 1, 0.04], [2, 0.3, 0.02]], noise: 0.05, noiseHz: 4000, noiseQ: 1, noiseDecay: 0.003, highpass: 400 }),
    // Big, fast pitch bends: laser toms.
    ...toms([130.8, 174.6, 233.1], [0.35, 0.3, 0.25], { bend: 0.28, bendTime: 0.02, modes: [], noise: 0, noiseHz: 2000, noiseQ: 1, noiseDecay: 0.01, click: 0.05, drive: 1.2 }),
    v('Metal Bell', 0.5, { model: 'cowbell', hz: [800, 1160], band: 2400, bandQ: 2.5, decay: 0.2, fast: 0.8, fastDecay: 0.02, lowpass: 0 }),
    v('Noise Crash', 0.5, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.6), band: 9000, bandQ: 0.4, highpass: 5000, attack: 0.0006, decay: 1.3, noise: 0.85, splash: { level: 0.6, decay: 0.15 }, darken: { from: 20000, to: 7000, time: 0.3 } }),
    v('Ping Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 1.3), band: 11000, bandQ: 1.0, highpass: 7000, attack: 0.0004, decay: 1.2, noise: 0.05, splash: { level: 0.3, decay: 0.08 }, bell: { hz: 2000, partials: BELL_PARTIALS, level: 0.5, decay: 0.6 }, stick: 0.2 }),
    v('Laser', 0.55, { model: 'zap', startHz: 5000, endHz: 400, sweep: 0.03, decay: 0.25, wave: 'sine', drive: 1.5 }),
    // An upward chirp (the zap model sweeps toward endHz in either direction).
    v('Bloop', 0.55, { model: 'zap', startHz: 200, endHz: 900, sweep: 0.03, decay: 0.15, wave: 'triangle', drive: 0.5 }),
  ],
  chokeGroups: PEDAL_HAT_CHOKE,
};

const IRON_FORGE: KitRecipe = {
  id: 'iron-forge',
  character: { drive: 1.2, asym: 0.05, lowpass: 14000, highpass: 35, shelfDb: 1, bits: 24, rate: 0 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 180, endHz: 50, sweep: 0.02, punchHz: 250, punchTime: 0.003, hold: 0.04, decay: 0.6, click: 0.2, clickHz: 3000, drive: 6, tone: 3500 }),
    v('Pound', 0.95, { model: 'kick', startHz: 140, endHz: 44, sweep: 0.03, punchHz: 120, punchTime: 0.006, hold: 0.06, decay: 0.9, click: 0.1, clickHz: 1500, drive: 4, tone: 1500 }),
    // A tuned, ringing metal body with heavy noise: clang more than crack.
    v('Snare', 0.8, { model: 'snare', bodyHz: [300, 523], bodyLevel: [1, 0.9], bodyDecay: 0.14, bend: 0.2, bendTime: 0.01, noise: 0.7, noiseDecay: 0.25, noiseLow: 1200, noiseHigh: 9000, presenceHz: 3000, presenceDb: 6, snap: 0.5, drive: 1.5 }, 0.3),
    v('Clap', 0.8, { model: 'clap', bursts: 4, spacing: 0.01, burstDecay: 0.025, tail: 0.5, tailDecay: 0.3, bandHz: 1000, q: 0.7, highpass: 500, drive: 1.2 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.2), band: 8500, bandQ: 0.6, highpass: 6000, attack: 0.0003, decay: 0.06, noise: 0.4 },
      { decay: 0.5, splash: { level: 0.4, decay: 0.1 } },
      null,
    ),
    v('Chain', 0.4, { model: 'shaker', attack: 0.002, decay: 0.08, band: 7000, bandQ: 0.6, highpass: 5200, grain: 0.8, density: 1200 }),
    v('Pipe', 0.62, { model: 'modal', hz: 620, partials: [[1, 1, 0.15], [2.76, 0.6, 0.1], [5.4, 0.4, 0.06], [8.9, 0.2, 0.04]], noise: 0.2, noiseHz: 3000, noiseQ: 1, noiseDecay: 0.01, highpass: 300 }),
    ...toms([87.3, 116.5, 155.6], [0.55, 0.48, 0.42], { bend: 0.2, bendTime: 0.03, modes: [[1.59, 0.1, 0.5], [2.3, 0.04, 0.3]], noise: 0.1, noiseHz: 1200, noiseQ: 0.6, noiseDecay: 0.05, click: 0.08, drive: 2 }),
    v('Anvil', 0.5, { model: 'modal', hz: 880, partials: [[1, 1, 0.8], [2.76, 0.7, 0.5], [5.4, 0.5, 0.3], [8.93, 0.3, 0.2], [13.3, 0.15, 0.12]], noise: 0.3, noiseHz: 4000, noiseQ: 0.8, noiseDecay: 0.01, highpass: 200 }),
    v('Noise Crash', 0.42, { model: 'metal', freqs: scaled(CRASH_FREQS, 0.95), band: 6000, bandQ: 0.3, highpass: 2500, attack: 0.001, decay: 2.0, noise: 0.8, splash: { level: 0.5, decay: 0.3 }, darken: { from: 12000, to: 4000, time: 0.6 } }),
    v('Sheet Metal', 0.42, { model: 'metal', freqs: scaled(RIDE_FREQS, 0.8), band: 5000, bandQ: 0.8, highpass: 2500, attack: 0.0005, decay: 1.8, noise: 0.2, splash: { level: 0.3, decay: 0.15 }, bell: { hz: 700, partials: BELL_PARTIALS, level: 0.5, decay: 1.2 }, stick: 0.4 }),
    v('Clank', 0.6, { model: 'modal', hz: 1480, partials: [[1, 1, 0.08], [1.41, 0.8, 0.06], [2.83, 0.4, 0.04]], noise: 0.4, noiseHz: 5000, noiseQ: 1, noiseDecay: 0.008, highpass: 400 }),
    v('Grind', 0.6, { model: 'guiro', ticks: 30, duration: 0.35, accel: 1.1, band: 1800, q: 2.5, tickDecay: 0.006 }),
  ],
  chokeGroups: HAT_CHOKE,
};

const MINIMAL_CLICK: KitRecipe = {
  id: 'minimal-click',
  character: { ...CLEAN, drive: 0.1, highpass: 40 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 160, endHz: 58, sweep: 0.01, punchHz: 300, punchTime: 0.0015, hold: 0.03, decay: 0.22, click: 0.25, clickHz: 6000, drive: 1.2, tone: 0 }),
    v('Soft Kick', 0.95, { model: 'kick', startHz: 120, endHz: 54, sweep: 0.012, punchHz: 100, punchTime: 0.002, hold: 0.03, decay: 0.3, click: 0.05, clickHz: 3000, drive: 0.6, tone: 2000 }),
    v('Snare', 0.78, { model: 'snare', bodyHz: [330, 610], bodyLevel: [1, 0.4], bodyDecay: 0.08, bend: 0.25, bendTime: 0.005, noise: 0.45, noiseDecay: 0.1, noiseLow: 2500, noiseHigh: 9000, presenceHz: 5500, presenceDb: 3, snap: 0.5, drive: 2 }, 0.3),
    v('Clap', 0.78, { model: 'clap', bursts: 3, spacing: 0.0085, burstDecay: 0.02, tail: 0.7, tailDecay: 0.18, bandHz: 2200, q: 1.6, highpass: 1400, drive: 1.0 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.6), band: 12500, bandQ: 1.6, highpass: 9500, attack: 0.0002, decay: 0.035, noise: 0.15 },
      { decay: 0.3, splash: { level: 0.2, decay: 0.04 } },
      null,
    ),
    v('Tick', 0.36, { model: 'shaker', attack: 0.0005, decay: 0.015, band: 12000, bandQ: 1.5, highpass: 9000, grain: 0, density: 1000 }),
    v('Click', 0.6, { model: 'modal', hz: 3200, partials: [[1, 1, 0.01], [1.7, 0.5, 0.008]], noise: 0.3, noiseHz: 6000, noiseQ: 1, noiseDecay: 0.002, highpass: 1000 }),
    ...toms([146.8, 185, 233.1], [0.34, 0.3, 0.27], { bend: 0.2, bendTime: 0.015, modes: [], noise: 0.05, noiseHz: 2000, noiseQ: 1, noiseDecay: 0.01, click: 0.1, drive: 0.5 }),
    v('Wood', 0.6, { model: 'modal', hz: 1250, partials: [[1, 1, 0.05], [2.4, 0.4, 0.03]], noise: 0.15, noiseHz: 3000, noiseQ: 1.2, noiseDecay: 0.004, highpass: 300 }),
    v('Crash', 0.45, { model: 'metal', freqs: scaled(CRASH_FREQS, 1.5), band: 11000, bandQ: 0.6, highpass: 7000, attack: 0.0005, decay: 1.4, noise: 0.5, splash: { level: 0.35, decay: 0.2 } }),
    v('Ping', 0.45, { model: 'metal', freqs: scaled(RIDE_FREQS, 1.4), band: 12000, bandQ: 1.2, highpass: 8000, attack: 0.0004, decay: 1.8, noise: 0.05, splash: { level: 0.35, decay: 0.2 }, bell: { hz: 2200, partials: BELL_PARTIALS, level: 0.6, decay: 0.7 }, stick: 0.2 }),
    v('Blip', 0.6, { model: 'membrane', hz: 880, bend: 0.3, bendTime: 0.003, decay: 0.08, modes: [], noise: 0, noiseHz: 3000, noiseQ: 1, noiseDecay: 0.01, click: 0.05, drive: 0.3 }),
    v('Dot', 0.55, { model: 'zap', startHz: 1200, endHz: 800, sweep: 0.01, decay: 0.06, wave: 'sine', drive: 0 }),
  ],
  chokeGroups: HAT_CHOKE,
};

const BREAK_CRATE: KitRecipe = {
  id: 'break-crate',
  character: { drive: 1.0, asym: 0.08, lowpass: 12000, highpass: 35, shelfDb: 1.5, bits: 12, rate: 0 },
  voices: [
    v('Kick', 0.95, { model: 'kick', startHz: 130, endHz: 60, sweep: 0.012, punchHz: 180, punchTime: 0.002, hold: 0.015, decay: 0.3, click: 0.35, clickHz: 2800, drive: 2.2, tone: 4500 }),
    v('Ghost Kick', 0.95, { model: 'kick', startHz: 110, endHz: 56, sweep: 0.015, punchHz: 120, punchTime: 0.002, hold: 0.01, decay: 0.24, click: 0.2, clickHz: 2000, drive: 1.6, tone: 3000 }),
    v('Snare', 0.8, { model: 'snare', bodyHz: [205, 375], bodyLevel: [1, 0.6], bodyDecay: 0.18, bend: 0.2, bendTime: 0.008, noise: 0.65, noiseDecay: 0.32, noiseLow: 1400, noiseHigh: 9000, presenceHz: 3500, presenceDb: 4, snap: 0.45, drive: 1.8 }, 0.4),
    v('Clap', 0.78, { model: 'clap', bursts: 4, spacing: 0.01, burstDecay: 0.024, tail: 0.55, tailDecay: 0.32, bandHz: 1050, q: 1, highpass: 600, drive: 0.8 }),
    ...hats(
      { freqs: scaled(HAT_FREQS, 1.05), band: 8800, bandQ: 0.6, highpass: 6200, attack: 0.0006, decay: 0.07, noise: 0.5 },
      { decay: 0.55, splash: { level: 0.3, decay: 0.1 } },
      null,
    ),
    v('Tambourine', 0.3, { model: 'jingle', freqs: [5600, 6900, 8200, 9600, 11000], hits: 3, spread: 0.012, decay: 0.15, noise: 0.4, noiseDecay: 0.05, highpass: 4800, skin: 0.05, skinHz: 280 }),
    v('Rim', 0.68, { model: 'modal', hz: 470, partials: [[1, 0.6, 0.025], [3.5, 1, 0.04], [5.8, 0.3, 0.02]], noise: 0.3, noiseHz: 3500, noiseQ: 1, noiseDecay: 0.008, highpass: 250 }),
    ...toms([92.5, 116.5, 146.8], [0.5, 0.45, 0.38], { bend: 0.12, bendTime: 0.04, modes: [[1.59, 0.1, 0.55], [2.14, 0.05, 0.4]], noise: 0.05, noiseHz: 1300, noiseQ: 0.7, noiseDecay: 0.05, click: 0.06, drive: 1.2 }),
    v('Cowbell', 0.58, { model: 'cowbell', hz: [600, 900], band: 1600, bandQ: 1.2, decay: 0.25, fast: 0.6, fastDecay: 0.04, lowpass: 5000 }),
    v('Crash', 0.5, { model: 'metal', freqs: CRASH_FREQS, band: 7000, bandQ: 0.4, highpass: 3800, attack: 0.001, decay: 2.0, noise: 0.65, splash: { level: 0.45, decay: 0.35 }, darken: { from: 13000, to: 5500, time: 0.7 } }),
    v('Ride', 0.5, { model: 'metal', freqs: scaled(RIDE_FREQS, 0.97), band: 8000, bandQ: 0.55, highpass: 4200, attack: 0.0005, decay: 2.1, noise: 0.3, splash: { level: 0.25, decay: 0.12 }, bell: { hz: 1150, partials: BELL_PARTIALS, level: 0.35, decay: 1.0 }, stick: 0.35, darken: { from: 12000, to: 7000, time: 0.9 } }),
    v('Ghost Snare', 0.55, { model: 'snare', bodyHz: [215, 390], bodyLevel: [1, 0.5], bodyDecay: 0.08, bend: 0.15, bendTime: 0.006, noise: 0.5, noiseDecay: 0.12, noiseLow: 1800, noiseHigh: 8000, presenceHz: 4000, presenceDb: 2, snap: 0.2, drive: 1.5 }, 0.4),
    v('Scratch', 0.6, { model: 'guiro', ticks: 12, duration: 0.12, accel: 0.7, band: 1200, q: 1.5, tickDecay: 0.01 }),
  ],
  chokeGroups: HAT_CHOKE,
};

const AFRO_LATIN: KitRecipe = {
  id: 'afro-latin',
  character: { ...CLEAN, drive: 0.25, highpass: 30 },
  voices: [
    // One djembe, three strokes: bass (low, open), tone (ringing) and slap (sharp, noisy).
    v('Djembe Bass', 0.9, { model: 'membrane', hz: 75, bend: 0.15, bendTime: 0.02, decay: 0.35, modes: [[1.6, 0.2, 0.4]], noise: 0.15, noiseHz: 900, noiseQ: 0.8, noiseDecay: 0.03, click: 0.1, drive: 0.6 }),
    v('Djembe Tone', 0.75, { model: 'membrane', hz: 220, bend: 0.05, bendTime: 0.015, decay: 0.3, modes: [[1.5, 0.2, 0.5], [2.1, 0.08, 0.3]], noise: 0.2, noiseHz: 1800, noiseQ: 1, noiseDecay: 0.02, click: 0.08, drive: 0.5 }),
    v('Djembe Slap', 0.75, { model: 'membrane', hz: 340, bend: 0.08, bendTime: 0.006, decay: 0.12, modes: [[1.47, 0.3, 0.5], [2.3, 0.2, 0.3]], noise: 0.7, noiseHz: 3500, noiseQ: 0.8, noiseDecay: 0.04, click: 0.3, drive: 0.8 }),
    // A negative bend starts flat and rises: the talking drum's squeeze.
    v('Talking Drum', 0.75, { model: 'membrane', hz: 180, bend: -0.25, bendTime: 0.12, decay: 0.5, modes: [[1.5, 0.15, 0.5]], noise: 0.1, noiseHz: 1500, noiseQ: 1, noiseDecay: 0.02, click: 0.05, drive: 0.4 }),
    v('Shekere', 0.45, { model: 'shaker', attack: 0.008, decay: 0.12, band: 7500, bandQ: 0.8, highpass: 5200, grain: 0.6, density: 1500 }),
    v('Caxixi', 0.45, { model: 'shaker', attack: 0.002, decay: 0.09, band: 6000, bandQ: 1.4, highpass: 5200, grain: 0.85, density: 700 }),
    v('Ganza', 0.42, { model: 'shaker', attack: 0.015, decay: 0.15, band: 10000, bandQ: 1.2, highpass: 7000, grain: 0.15, density: 6000 }),
    v('Claves', 0.6, { model: 'modal', hz: 2650, partials: [[1, 1, 0.1], [3.8, 0.05, 0.03]], noise: 0.04, noiseHz: 5000, noiseQ: 1, noiseDecay: 0.003, highpass: 500 }),
    v('Surdo', 0.9, { model: 'membrane', hz: 65.4, bend: 0.08, bendTime: 0.05, decay: 0.8, modes: [[1.59, 0.15, 0.6]], noise: 0.1, noiseHz: 600, noiseQ: 0.7, noiseDecay: 0.06, click: 0.15, drive: 0.6 }),
    v('Timbale Lo', 0.7, { model: 'membrane', hz: 330, bend: 0.04, bendTime: 0.01, decay: 0.4, modes: [[1.6, 0.35, 0.6], [2.3, 0.25, 0.5], [3.1, 0.15, 0.4]], noise: 0.25, noiseHz: 4000, noiseQ: 0.8, noiseDecay: 0.03, click: 0.25, drive: 0.5 }),
    v('Timbale Hi', 0.7, { model: 'membrane', hz: 440, bend: 0.04, bendTime: 0.01, decay: 0.35, modes: [[1.6, 0.35, 0.6], [2.3, 0.25, 0.5], [3.1, 0.15, 0.4]], noise: 0.25, noiseHz: 4500, noiseQ: 0.8, noiseDecay: 0.03, click: 0.25, drive: 0.5 }),
    v('Agogo', 0.55, { model: 'modal', hz: 784, partials: [[1, 1, 0.6], [2.6, 0.3, 0.3], [4.3, 0.12, 0.15]], noise: 0.12, noiseHz: 4000, noiseQ: 1, noiseDecay: 0.005, highpass: 250 }),
    // The cuica's squeak: an upward friction glide.
    v('Cuica', 0.55, { model: 'zap', startHz: 400, endHz: 900, sweep: 0.08, decay: 0.25, wave: 'triangle', drive: 0.8 }),
    v('Bell', 0.5, { model: 'modal', hz: 1175, partials: [[1, 1, 0.5], [2.4, 0.4, 0.25], [4.0, 0.2, 0.12]], noise: 0.08, noiseHz: 4000, noiseQ: 1, noiseDecay: 0.004, highpass: 300 }),
    v('Udu', 0.75, { model: 'membrane', hz: 150, bend: -0.1, bendTime: 0.05, decay: 0.35, modes: [[2.0, 0.1, 0.4]], noise: 0, noiseHz: 1000, noiseQ: 1, noiseDecay: 0.01, click: 0.02, drive: 0.3 }),
    v('Hand Clap', 0.7, { model: 'clap', bursts: 3, spacing: 0.012, burstDecay: 0.022, tail: 0.3, tailDecay: 0.12, bandHz: 1300, q: 1, highpass: 700, drive: 0.3 }),
  ],
  // Bass, tone and slap are strokes on one djembe: a new stroke cuts the last.
  chokeGroups: [[0, 1, 2]],
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
  [BOOM_808.id]: BOOM_808,
  [PUNCH_909.id]: PUNCH_909,
  [TRAP_NIGHT.id]: TRAP_NIGHT,
  [LOFI_CRATE.id]: LOFI_CRATE,
  [STUDIO_ACOUSTIC.id]: STUDIO_ACOUSTIC,
  [ELECTRO_WIRE.id]: ELECTRO_WIRE,
  [IRON_FORGE.id]: IRON_FORGE,
  [MINIMAL_CLICK.id]: MINIMAL_CLICK,
  [BREAK_CRATE.id]: BREAK_CRATE,
  [AFRO_LATIN.id]: AFRO_LATIN,
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
