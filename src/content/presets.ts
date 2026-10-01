/**
 * Synth preset data and sound assignment.
 *
 * A preset stores: instrument params, optional macro-mapping overrides
 * (relative to the track's module slots), optional module param defaults
 * (e.g. the LFO rate that Motion uses) and suggested macro positions.
 * Applying a preset writes all of that into the project so the saved project
 * is self-contained — it never needs the preset table to sound the same.
 *
 * Sound design notes
 * ------------------
 * MONO BASS: osc (wave, optional Unison copies, optional FM) + sub one
 * octave down (square or sine) -> 24 dB low-pass with envelope ->
 * saturation -> ADSR; pitch sweep; octave transpose; glide on legato notes.
 * POLY: osc1 (optional Unison stack, optional FM) + osc2 (semitones,
 * detune, level) + coloured noise -> stereo width -> 12 dB low-pass with
 * filter envelope -> ADSR; pitch sweep, vibrato, drift; up to 12 voices.
 * The FM, Unison, pitch-sweep, noise-colour, vibrato and drift controls
 * default to "off" (FEATURES_OFF below); the 18 original presets (and so
 * the starters) use none of them and sound exactly as they always did.
 *
 * Macros for synth presets:
 * - Tone sweeps the instrument's own cutoff geometrically around the designed
 *   value (about cutoff/4 at 0, the designed sound at 0.5, cutoff*4 at 1),
 *   plus a high-shelf lift above 0.6 on brighter sounds. Sine and triangle
 *   designs have few harmonics for a filter to remove, so Tone also moves
 *   the control that carries their brightness (bell partial, octave layer,
 *   breath noise, saturation), always through the designed value at 0.5.
 * - Motion fades in the part's tempo-synced LFO (default cable: LFO -> track
 *   filter cutoff). The track filter's cutoff glides from fully open down to
 *   a preset-specific centre over the first 40% of the knob so the sweep
 *   happens where this sound actually has energy (a bass needs a much lower
 *   centre than a bell). At Motion 0 the filter is fully open and still.
 * - Space, Echo, Drive and Pump keep the default mappings.
 * Levels are matched so a typical part (bass line, chords, lead line, pad)
 * plays at a similar loudness.
 */
import { MACRO_IDS, type Id, type MacroId, type MacroMap, type MacroTarget, type MacroValues, type ModuleType, type ParamValues, type Project, type Track } from '../project/types';
import {
  BASS_PARAMS,
  DRUM_KIT_PARAMS,
  INSTRUMENT_PARAMS,
  MODULE_PARAMS,
  POLY_PARAMS,
  SAMPLER_PARAMS,
  clampParam,
  defaultParams,
  specById,
  type ParamSpec,
} from '../project/params';
import { defaultDrumVoices, defaultMacroMap, defaultMacros, moduleId } from '../project/factory';
import { builtinSampleInfo, kitInfo, presetInfo } from './catalog';

export type TrackSlot = 'inst' | 'drive' | 'filter' | 'lfo' | 'ch';

export interface PresetMacroTarget extends Omit<MacroTarget, 'module'> {
  slot: TrackSlot;
}

export interface PresetData {
  params: ParamValues;
  macroMap?: Partial<Record<MacroId, PresetMacroTarget[]>>;
  modules?: Partial<Record<Exclude<TrackSlot, 'inst'>, ParamValues>>;
  macros?: Partial<MacroValues>;
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

/** Option indices of WAVE_OPTIONS. */
const W = { saw: 0, square: 1, triangle: 2, sine: 3 } as const;
/** Option indices of LFO_WAVES. */
const LFO = { sine: 0, triangle: 1, sawUp: 2, sawDown: 3, square: 4, random: 5 } as const;
/** Option indices of LFO_DIVISIONS. */
const DIV = { bars4: 0, bars2: 1, bar1: 2, half: 3, quarter: 4, eighth: 5, sixteenth: 6 } as const;
/** Option indices of SUB_WAVE_OPTIONS. */
const SUB = { square: 0, sine: 1 } as const;
/** Option indices of the drive module's Character. */
const CHARACTER = { warm: 0, hard: 1, fold: 2 } as const;

/** How far Tone moves the cutoff either side of the designed value (factor at 0 and 1). */
export const TONE_RANGE = 4;
/** Motion reaches its filter centre at this knob position; LFO depth keeps growing to 1. */
const MOTION_CENTRE_AT = 0.4;
const FILTER_OPEN = 20000;

/**
 * Tone: exponential sweep of the instrument cutoff, symmetric in octaves
 * around `cutoff` so that 0.5 is exactly the designed sound (the range
 * narrows near the parameter limits to stay symmetric).
 */
function tone(specs: readonly ParamSpec[], cutoff: number, brightDb = 0): PresetMacroTarget[] {
  const spec = specById(specs, 'cutoff') as ParamSpec;
  const max = Math.min(spec.max, cutoff * TONE_RANGE);
  const min = Math.max(spec.min, (cutoff * cutoff) / max);
  const out: PresetMacroTarget[] = [{ slot: 'inst', param: 'cutoff', min, max, curve: 'exp' }];
  if (brightDb > 0) out.push({ slot: 'filter', param: 'bright', min: 0, max: brightDb, curve: 'lin', macroFrom: 0.6, macroTo: 1 });
  return out;
}

/** Another instrument control Tone moves: its value on the dark (Tone 0) and bright (Tone 1) side. */
interface ToneAlso {
  param: string;
  dark: number;
  bright: number;
}

/**
 * A linear Tone target that passes exactly through the designed value at
 * Tone 0.5. The side that has further to travel starts later (or finishes
 * earlier) on the knob, so the middle position is always the designed sound.
 * Used where a low-pass sweep alone barely changes the sound (sines and
 * triangles have few harmonics to filter): the bell partial, the breath
 * noise, the octave layer or the saturation carry the brightness instead.
 */
function toneThrough(param: string, designed: number, dark: number, bright: number): PresetMacroTarget {
  const k = Math.min(1, Math.max(0, (designed - dark) / (bright - dark)));
  const range = k <= 0.5 ? { macroFrom: (0.5 - k) / (1 - k), macroTo: 1 } : { macroFrom: 0, macroTo: 0.5 / k };
  return { slot: 'inst', param, min: dark, max: bright, curve: 'lin', ...range };
}

/** Motion: LFO depth 0..`depth`, track filter from open to `centre` Hz. */
function motion(centre: number, depth: number): PresetMacroTarget[] {
  return [
    { slot: 'lfo', param: 'depth', min: 0, max: depth, curve: 'lin' },
    { slot: 'filter', param: 'cutoff', min: FILTER_OPEN, max: centre, curve: 'exp', macroFrom: 0, macroTo: MOTION_CENTRE_AT },
  ];
}

/** Synth-feature controls a design may set; anything left out is off (the registry default). */
interface BassFeatures {
  subWave?: number;
  unisonDetune?: number;
  fmAmount?: number;
  fmRatio?: number;
  fmDecay?: number;
  pitchEnv?: number;
  pitchDecay?: number;
}

interface PolyFeatures {
  unison?: number;
  unisonDetune?: number;
  fmAmount?: number;
  fmRatio?: number;
  fmDecay?: number;
  noiseColor?: number;
  pitchEnv?: number;
  pitchDecay?: number;
  vibrato?: number;
  vibratoRate?: number;
  drift?: number;
}

/** The registry defaults of the feature controls: neutral, so a design that sets none sounds as before they existed. */
function featuresOff(specs: readonly ParamSpec[], ids: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (specById(specs, id) as ParamSpec).default;
  return out;
}
const BASS_FEATURES_OFF = featuresOff(BASS_PARAMS, ['subWave', 'unisonDetune', 'fmAmount', 'fmRatio', 'fmDecay', 'pitchEnv', 'pitchDecay']);
const POLY_FEATURES_OFF = featuresOff(POLY_PARAMS, ['unison', 'unisonDetune', 'fmAmount', 'fmRatio', 'fmDecay', 'noiseColor', 'pitchEnv', 'pitchDecay', 'vibrato', 'vibratoRate', 'drift']);

interface BassDesign extends BassFeatures {
  wave: number;
  sub: number;
  cutoff: number;
  resonance: number;
  envAmount: number;
  filterDecay: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  glide: number;
  drive: number;
  velocity: number;
  level: number;
  octave?: number;
}

interface PolyDesign extends PolyFeatures {
  osc1Wave: number;
  osc2Wave: number;
  osc2Semi: number;
  detune: number;
  osc2Level: number;
  noise: number;
  width: number;
  cutoff: number;
  resonance: number;
  filterEnv: number;
  filterDecay: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  velocity: number;
  level: number;
}

interface Extras {
  bright?: number;
  /** Further instrument controls Tone moves around their designed values. */
  toneAlso?: ToneAlso[];
  lfo: { wave: number; division: number; centre: number; depth: number };
  filter?: ParamValues;
  drive?: ParamValues;
  macros?: Partial<Pick<MacroValues, 'tone' | 'motion' | 'drive'>>;
}

function bass(d: BassDesign, x: Extras): PresetData {
  return build(BASS_PARAMS, { octave: 0, ...BASS_FEATURES_OFF, ...d }, x);
}

function poly(d: PolyDesign, x: Extras): PresetData {
  return build(POLY_PARAMS, { ...POLY_FEATURES_OFF, ...d }, x);
}

function build(specs: readonly ParamSpec[], params: Record<string, number>, x: Extras): PresetData {
  const modules: PresetData['modules'] = { lfo: { wave: x.lfo.wave, division: x.lfo.division } };
  if (x.filter) modules.filter = { ...x.filter };
  if (x.drive) modules.drive = { ...x.drive };
  const toneTargets = [...tone(specs, params.cutoff, x.bright), ...(x.toneAlso ?? []).map((t) => toneThrough(t.param, params[t.param], t.dark, t.bright))];
  const data: PresetData = {
    params: { ...params },
    macroMap: { tone: toneTargets, motion: motion(x.lfo.centre, x.lfo.depth) },
    modules,
  };
  if (x.macros) data.macros = { ...x.macros };
  return data;
}

/* ------------------------------------------------------------------ */
/* The library                                                         */
/* ------------------------------------------------------------------ */

/** Keyed by preset id from src/content/catalog.ts SYNTH_PRESETS. */
export const PRESETS: Record<string, PresetData> = {
  /* ---------------- Mono bass ---------------- */

  // Sine body with a quiet square sub under a low, barely moving filter:
  // weight without buzz, short release so fast lines stay clean.
  'bass-round-sub': bass(
    { wave: W.sine, sub: 0.35, cutoff: 420, resonance: 0.05, envAmount: 0.12, filterDecay: 0.18, attack: 0.005, decay: 0.4, sustain: 0.85, release: 0.07, glide: 0.03, drive: 0.1, velocity: 0.3, level: -4 },
    {
      toneAlso: [
        { param: 'drive', dark: 0, bright: 0.6 },
        { param: 'sub', dark: 0.6, bright: 0.2 },
      ],
      lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 600, depth: 0.6 },
    },
  ),

  // Hollow square with a quick, resonant filter "bow" and a low sustain: bounces.
  'bass-rubber-pluck': bass(
    { wave: W.square, sub: 0.25, cutoff: 280, resonance: 0.38, envAmount: 0.62, filterDecay: 0.13, attack: 0.002, decay: 0.22, sustain: 0.4, release: 0.06, glide: 0.02, drive: 0.2, velocity: 0.6, level: -2 },
    { bright: 3, lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 1400, depth: 0.6 } },
  ),

  // Saw into a near-self-oscillating filter with a strong, fast envelope and
  // real glide; Tone is the classic cutoff sweep, Drive adds hard grit.
  'bass-acid-line': bass(
    { wave: W.saw, sub: 0.1, cutoff: 350, resonance: 0.72, envAmount: 0.78, filterDecay: 0.16, attack: 0.002, decay: 0.3, sustain: 0.55, release: 0.05, glide: 0.08, drive: 0.4, velocity: 0.7, level: -3 },
    { bright: 3, lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 1800, depth: 0.6 }, drive: { character: CHARACTER.hard, tone: 0.6 }, macros: { drive: 0.2 } },
  ),

  // Warm saw, generous sub, gentle envelope and no glide: even, driving eighths.
  'bass-velvet-saw': bass(
    { wave: W.saw, sub: 0.45, cutoff: 620, resonance: 0.12, envAmount: 0.3, filterDecay: 0.28, attack: 0.004, decay: 0.3, sustain: 0.72, release: 0.07, glide: 0, drive: 0.22, velocity: 0.45, level: -3 },
    { bright: 2, lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 1500, depth: 0.55 } },
  ),

  // Square + square sub through an open, static filter with a fast decay:
  // the hollow click of an organ bass, tight enough for shuffled grooves.
  'bass-organ-short': bass(
    { wave: W.square, sub: 0.55, cutoff: 1150, resonance: 0.06, envAmount: 0.12, filterDecay: 0.06, attack: 0.002, decay: 0.15, sustain: 0.3, release: 0.03, glide: 0, drive: 0.15, velocity: 0.4, level: -2 },
    { bright: 3, lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 2500, depth: 0.5 } },
  ),

  // Triangle with a heavy sub, soft attack and long release; saturation after
  // the dark filter gives the growl. A slow quarter-note wobble for Motion.
  'bass-dub-pressure': bass(
    { wave: W.triangle, sub: 0.6, cutoff: 300, resonance: 0.2, envAmount: 0.2, filterDecay: 0.6, attack: 0.015, decay: 0.9, sustain: 0.9, release: 0.35, glide: 0.06, drive: 0.48, velocity: 0.3, level: -4 },
    { lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 700, depth: 0.65 }, drive: { character: CHARACTER.warm, tone: 0.45 } },
  ),

  /* ---------------- Poly: chords ---------------- */

  // Sine body with a quiet square an octave up: the filter envelope opens it
  // for a glassy, bell-like bark on each key, then it settles to a mellow
  // electric-piano tone with moderate sustain.
  'poly-glass-keys': poly(
    { osc1Wave: W.sine, osc2Wave: W.square, osc2Semi: 12, detune: 4, osc2Level: 0.2, noise: 0, width: 0.35, cutoff: 2000, resonance: 0.1, filterEnv: 0.5, filterDecay: 0.3, attack: 0.002, decay: 1.4, sustain: 0.3, release: 0.5, velocity: 0.65, level: -7 },
    { bright: 4, toneAlso: [{ param: 'osc2Level', dark: 0.03, bright: 0.55 }], lfo: { wave: LFO.sine, division: DIV.half, centre: 3000, depth: 0.45 } },
  ),

  // Two saws detuned ~12 cents, spread wide, cutoff around 2.5 kHz and a soft
  // 60 ms attack: luminous, sustained chords.
  'poly-lumen-chords': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: 0, detune: 12, osc2Level: 0.85, noise: 0.02, width: 0.8, cutoff: 2500, resonance: 0.12, filterEnv: 0.2, filterDecay: 0.9, attack: 0.06, decay: 1, sustain: 0.75, release: 0.7, velocity: 0.35, level: -8 },
    { bright: 4, lfo: { wave: LFO.sine, division: DIV.bar1, centre: 3000, depth: 0.55 } },
  ),

  // Square with a saw an octave up (organ drawbar feel), instant attack,
  // short decay and no sustain: a punchy off-beat stab.
  'poly-house-stab': poly(
    { osc1Wave: W.square, osc2Wave: W.saw, osc2Semi: 12, detune: 5, osc2Level: 0.45, noise: 0, width: 0.25, cutoff: 2300, resonance: 0.22, filterEnv: 0.45, filterDecay: 0.12, attack: 0.001, decay: 0.24, sustain: 0, release: 0.12, velocity: 0.55, level: -4 },
    { bright: 5, lfo: { wave: LFO.triangle, division: DIV.half, centre: 2500, depth: 0.55 } },
  ),

  // Saw + octave square behind a closed filter that snaps open for 100 ms:
  // the brightness is all in the attack, then it is gone.
  'poly-short-pluck': poly(
    { osc1Wave: W.saw, osc2Wave: W.square, osc2Semi: 12, detune: 8, osc2Level: 0.35, noise: 0.02, width: 0.45, cutoff: 900, resonance: 0.28, filterEnv: 0.75, filterDecay: 0.1, attack: 0.001, decay: 0.24, sustain: 0, release: 0.1, velocity: 0.6, level: -3 },
    { bright: 5, lfo: { wave: LFO.sine, division: DIV.quarter, centre: 2000, depth: 0.5 } },
  ),

  /* ---------------- Poly: leads ---------------- */

  // Saw + square an octave up, bright filter, quick attack, centred.
  'poly-neon-lead': poly(
    { osc1Wave: W.saw, osc2Wave: W.square, osc2Semi: 12, detune: 6, osc2Level: 0.4, noise: 0, width: 0.2, cutoff: 5200, resonance: 0.2, filterEnv: 0.25, filterDecay: 0.3, attack: 0.004, decay: 0.4, sustain: 0.75, release: 0.22, velocity: 0.45, level: -4 },
    { bright: 5, lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 5000, depth: 0.45 }, drive: { character: CHARACTER.hard, tone: 0.75 } },
  ),

  // A sine with a faint triangle an octave up and a breath of noise, gentle
  // 50 ms attack and very little filter movement.
  'poly-soft-whistle': poly(
    { osc1Wave: W.sine, osc2Wave: W.triangle, osc2Semi: 12, detune: 3, osc2Level: 0.12, noise: 0.15, width: 0.15, cutoff: 2200, resonance: 0.05, filterEnv: 0.08, filterDecay: 0.6, attack: 0.05, decay: 0.6, sustain: 0.85, release: 0.3, velocity: 0.35, level: -3.5 },
    {
      bright: 3,
      toneAlso: [
        { param: 'noise', dark: 0.04, bright: 0.4 },
        { param: 'osc2Level', dark: 0.02, bright: 0.35 },
      ],
      lfo: { wave: LFO.sine, division: DIV.quarter, centre: 3500, depth: 0.4 },
    },
  ),

  // Woody triangle strike plus a slightly detuned sine 19 semitones up (the
  // bell partial) and a tick of noise; no sustain, so arpeggios stay clear.
  'poly-mallet-bell': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 19, detune: 9, osc2Level: 0.4, noise: 0.03, width: 0.4, cutoff: 3600, resonance: 0.06, filterEnv: 0.45, filterDecay: 0.07, attack: 0.001, decay: 0.55, sustain: 0, release: 0.4, velocity: 0.6, level: -1 },
    { bright: 4, toneAlso: [{ param: 'osc2Level', dark: 0.12, bright: 0.75 }], lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 3000, depth: 0.45 } },
  ),

  /* ---------------- Poly: pads ---------------- */

  // Wide, well-detuned saws under a darker filter, 1.5 s swell, 2.5 s release.
  'poly-halo-pad': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: 0, detune: 16, osc2Level: 0.8, noise: 0.03, width: 0.9, cutoff: 1500, resonance: 0.15, filterEnv: 0.12, filterDecay: 1.8, attack: 1.5, decay: 2, sustain: 0.85, release: 2.5, velocity: 0.2, level: -10 },
    { bright: 3, lfo: { wave: LFO.sine, division: DIV.bars2, centre: 2400, depth: 0.7 }, drive: { character: CHARACTER.warm, tone: 0.5 }, macros: { motion: 0.2 } },
  ),

  // Triangle with a sine an octave below for warmth, slow attack and a
  // four-bar LFO so Motion makes it breathe.
  'poly-warm-drift': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: -12, detune: 7, osc2Level: 0.4, noise: 0.02, width: 0.6, cutoff: 2000, resonance: 0.05, filterEnv: 0.1, filterDecay: 2.5, attack: 0.9, decay: 1.6, sustain: 0.9, release: 1.8, velocity: 0.25, level: -10.5 },
    {
      bright: 3,
      toneAlso: [{ param: 'osc2Level', dark: 0.75, bright: 0.1 }],
      lfo: { wave: LFO.sine, division: DIV.bars4, centre: 1800, depth: 0.6 },
      drive: { character: CHARACTER.warm, tone: 0.5 },
      macros: { motion: 0.25 },
    },
  ),

  /* ---------------- Poly: textures ---------------- */

  // Noise at full through a resonant filter that slowly closes after each
  // note, over a soft, widely detuned sine pair: wind and air. (The poly
  // engine keeps osc1 at full level, so the tone stays audible under the air.)
  'poly-air-grain': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 12, detune: 20, osc2Level: 0.15, noise: 1, width: 1, cutoff: 2400, resonance: 0.45, filterEnv: 0.25, filterDecay: 3, attack: 0.8, decay: 2.5, sustain: 0.8, release: 2.2, velocity: 0.2, level: -8 },
    { bright: 4, lfo: { wave: LFO.sine, division: DIV.bar1, centre: 3000, depth: 0.7 }, macros: { motion: 0.35 } },
  ),

  // Triangle + square a fifth up through a resonant mid filter: a hollow,
  // vowel-like drone; the resonant track filter makes Motion sound vocal.
  'poly-night-choir': poly(
    { osc1Wave: W.triangle, osc2Wave: W.square, osc2Semi: 7, detune: 8, osc2Level: 0.32, noise: 0.05, width: 0.7, cutoff: 1100, resonance: 0.45, filterEnv: 0.1, filterDecay: 1.5, attack: 0.7, decay: 1.2, sustain: 0.9, release: 1.6, velocity: 0.25, level: -8 },
    {
      bright: 2,
      toneAlso: [{ param: 'osc2Level', dark: 0.12, bright: 0.55 }],
      lfo: { wave: LFO.triangle, division: DIV.bars2, centre: 1600, depth: 0.55 },
      filter: { resonance: 0.35 },
      macros: { motion: 0.2 },
    },
  ),

  // Triangle plus a detuned sine two octaves up, a hint of tape hiss, a
  // clear filter and a slow swell: a high, sparkling layer.
  'poly-tape-shimmer': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 24, detune: 14, osc2Level: 0.55, noise: 0.08, width: 0.95, cutoff: 4500, resonance: 0.1, filterEnv: 0.05, filterDecay: 2, attack: 1.2, decay: 2, sustain: 0.8, release: 2.4, velocity: 0.2, level: -9 },
    {
      bright: 4,
      toneAlso: [
        { param: 'osc2Level', dark: 0.2, bright: 0.9 },
        { param: 'noise', dark: 0.02, bright: 0.2 },
      ],
      lfo: { wave: LFO.sine, division: DIV.bar1, centre: 6000, depth: 0.6 },
      macros: { motion: 0.25 },
    },
  ),

  /* ================================================================ */
  /* The extended library (FM, Unison, pitch sweep, noise colour ...) */
  /* ================================================================ */

  /* ---------------- Bass ---------------- */

  // Sine with a sine sub, a fast +7 st drop into pitch (the "punch") and a long
  // decay to a low sustain: the 808 boom. Saturation makes it audible on small
  // speakers; Tone moves that saturation. Glide slides between tied notes.
  'bass-808-boom': bass(
    { wave: W.sine, sub: 0.15, subWave: SUB.sine, pitchEnv: 12, pitchDecay: 0.06, cutoff: 900, resonance: 0.05, envAmount: 0.1, filterDecay: 0.2, attack: 0.002, decay: 1.4, sustain: 0.3, release: 0.25, glide: 0.07, drive: 0.65, velocity: 0.3, level: -6 },
    { toneAlso: [{ param: 'drive', dark: 0.1, bright: 0.9 }], lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 500, depth: 0.6 } },
  ),

  // Saw with two copies 18 cents apart under a low filter: slow phasing that
  // makes the classic dark "reese" movement. A square sub keeps the weight.
  'bass-reese': bass(
    { wave: W.saw, sub: 0.35, unisonDetune: 18, cutoff: 520, resonance: 0.18, envAmount: 0.15, filterDecay: 0.4, attack: 0.004, decay: 0.6, sustain: 0.9, release: 0.12, glide: 0.05, drive: 0.35, velocity: 0.3, level: -2.1 },
    { bright: 2, lfo: { wave: LFO.sine, division: DIV.half, centre: 900, depth: 0.6 }, drive: { character: CHARACTER.warm, tone: 0.55 } },
  ),

  // Sine carrier with a 1:1 FM modulator that decays in 180 ms: every note
  // starts bright and "slapped", then settles to a round tone.
  'bass-fm-slap': bass(
    { wave: W.sine, sub: 0.2, subWave: SUB.sine, fmAmount: 0.55, fmRatio: 1, fmDecay: 0.18, cutoff: 3000, resonance: 0.05, envAmount: 0.1, filterDecay: 0.15, attack: 0.001, decay: 0.5, sustain: 0.5, release: 0.08, glide: 0, drive: 0.2, velocity: 0.7, level: -3.5 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.25, bright: 0.8 }], lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 1600, depth: 0.5 } },
  ),

  // Triangle with a short 2:1 FM "pluck", a quick filter envelope and a
  // falling amplitude: a round, woody, finger-played electric bass.
  'bass-finger': bass(
    { wave: W.triangle, sub: 0.2, subWave: SUB.sine, fmAmount: 0.3, fmRatio: 2, fmDecay: 0.12, cutoff: 1100, resonance: 0.1, envAmount: 0.35, filterDecay: 0.12, attack: 0.003, decay: 0.9, sustain: 0.35, release: 0.09, glide: 0, drive: 0.25, velocity: 0.6, level: -4.5 },
    { bright: 2, toneAlso: [{ param: 'fmAmount', dark: 0.08, bright: 0.6 }], lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 1200, depth: 0.5 } },
  ),

  // A clean sine with a sine sub, no filter movement and full sustain: the
  // pure sub. Tone adds saturation for small speakers.
  'bass-pure-sub': bass(
    { wave: W.sine, sub: 0.5, subWave: SUB.sine, cutoff: 250, resonance: 0, envAmount: 0, filterDecay: 0.1, attack: 0.006, decay: 0.5, sustain: 1, release: 0.06, glide: 0.02, drive: 0.05, velocity: 0.2, level: -8.5 },
    { toneAlso: [{ param: 'drive', dark: 0, bright: 0.85 }, { param: 'sub', dark: 0.8, bright: 0.15 }], lfo: { wave: LFO.sine, division: DIV.quarter, centre: 400, depth: 0.5 } },
  ),

  // Saw plus a sustained FM modulator an octave below (ratio 0.5) through a
  // resonant filter and hard drive: a snarling, vocal growl.
  'bass-growl': bass(
    { wave: W.saw, sub: 0.25, fmAmount: 0.4, fmRatio: 0.5, fmDecay: 2, cutoff: 700, resonance: 0.45, envAmount: 0.4, filterDecay: 0.25, attack: 0.003, decay: 0.4, sustain: 0.75, release: 0.08, glide: 0.04, drive: 0.7, velocity: 0.5, level: -3.6 },
    { bright: 3, lfo: { wave: LFO.sine, division: DIV.eighth, centre: 1100, depth: 0.7 }, drive: { character: CHARACTER.hard, tone: 0.55 } },
  ),

  // Square with a two-octave pitch dive in 50 ms on every note: an electro zap.
  'bass-zap': bass(
    { wave: W.square, sub: 0.3, pitchEnv: 24, pitchDecay: 0.05, cutoff: 1400, resonance: 0.25, envAmount: 0.5, filterDecay: 0.08, attack: 0.001, decay: 0.25, sustain: 0.45, release: 0.05, glide: 0, drive: 0.3, velocity: 0.5, level: -2.5 },
    { bright: 3, lfo: { wave: LFO.square, division: DIV.sixteenth, centre: 2000, depth: 0.5 } },
  ),

  // Triangle with a faint chorus of copies, a slow, resonant filter bloom
  // and long glide: a rounded, rubbery minimal-techno bass.
  'bass-deep-pulse': bass(
    { wave: W.triangle, sub: 0.45, subWave: SUB.sine, unisonDetune: 6, cutoff: 380, resonance: 0.3, envAmount: 0.55, filterDecay: 0.5, attack: 0.01, decay: 0.7, sustain: 0.6, release: 0.2, glide: 0.1, drive: 0.3, velocity: 0.4, level: 0.5 },
    { toneAlso: [{ param: 'drive', dark: 0.05, bright: 0.8 }, { param: 'sub', dark: 0.8, bright: 0.15 }], lfo: { wave: LFO.triangle, division: DIV.bar1, centre: 700, depth: 0.6 } },
  ),

  /* ---------------- Keys ---------------- */

  // Sine carrier with a 1:1 FM modulator decaying over 1.2 s, velocity-scaled:
  // soft playing is mellow, hard playing barks like a tine piano. A quiet
  // octave sine fills out the body.
  'poly-tine-piano': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 12, detune: 2, osc2Level: 0.12, noise: 0, width: 0.45, fmAmount: 0.32, fmRatio: 1, fmDecay: 1.2, cutoff: 2500, resonance: 0.05, filterEnv: 0.25, filterDecay: 0.4, attack: 0.002, decay: 2.2, sustain: 0.25, release: 0.6, velocity: 0.75, level: -8 },
    { bright: 3, toneAlso: [{ param: 'fmAmount', dark: 0.04, bright: 0.9 }, { param: 'osc2Level', dark: 0.02, bright: 0.6 }], lfo: { wave: LFO.sine, division: DIV.quarter, centre: 3000, depth: 0.45 } },
  ),

  // Sine with a very high (14:1) FM modulator that dies in 250 ms: the glassy
  // "tine" of a digital electric piano over a sine-and-octave body.
  'poly-crystal-ep': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 12, detune: 4, osc2Level: 0.2, noise: 0, width: 0.5, fmAmount: 0.22, fmRatio: 14, fmDecay: 0.25, cutoff: 4500, resonance: 0.05, filterEnv: 0.2, filterDecay: 0.6, attack: 0.002, decay: 1.8, sustain: 0.3, release: 0.5, velocity: 0.6, level: -9.5 },
    { bright: 4, toneAlso: [{ param: 'fmAmount', dark: 0.06, bright: 0.5 }], lfo: { wave: LFO.sine, division: DIV.half, centre: 3500, depth: 0.45 } },
  ),

  // Sine plus an octave sine (the 8' and 4' drawbars) with a steady 3:1 FM
  // that adds the upper harmonics, full sustain, no velocity, and a gentle
  // vibrato: a tonewheel-style organ.
  'poly-drawbar-organ': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 12, detune: 1, osc2Level: 0.6, noise: 0, width: 0.4, fmAmount: 0.12, fmRatio: 3, fmDecay: 8, vibrato: 0.12, vibratoRate: 6.5, cutoff: 3000, resonance: 0, filterEnv: 0, filterDecay: 0.1, attack: 0.004, decay: 0.1, sustain: 1, release: 0.06, velocity: 0, level: -12 },
    {
      toneAlso: [
        { param: 'fmAmount', dark: 0.02, bright: 0.45 },
        { param: 'osc2Level', dark: 0.05, bright: 1 },
      ],
      lfo: { wave: LFO.sine, division: DIV.quarter, centre: 2500, depth: 0.4 },
    },
  ),

  // Sine and a third harmonic (19 st) with a 4:1 FM blip that dies in 80 ms
  // and a breath of bright noise: the key click and percussion of a jazz organ.
  'poly-click-organ': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 19, detune: 2, osc2Level: 0.35, noise: 0.04, noiseColor: 0.85, width: 0.35, fmAmount: 0.3, fmRatio: 4, fmDecay: 0.08, cutoff: 5000, resonance: 0.05, filterEnv: 0.2, filterDecay: 0.05, attack: 0.002, decay: 0.3, sustain: 0.8, release: 0.05, velocity: 0.2, level: -10.9 },
    { toneAlso: [{ param: 'osc2Level', dark: 0.1, bright: 0.8 }, { param: 'fmAmount', dark: 0.08, bright: 0.6 }], lfo: { wave: LFO.sine, division: DIV.eighth, centre: 2500, depth: 0.45 } },
  ),

  // Square with an octave saw through a resonant filter that snaps shut in
  // 90 ms, plus a tiny FM "twang": nasal and funky.
  'poly-funky-clav': poly(
    { osc1Wave: W.square, osc2Wave: W.saw, osc2Semi: 12, detune: 3, osc2Level: 0.3, noise: 0, width: 0.2, fmAmount: 0.15, fmRatio: 1, fmDecay: 0.05, cutoff: 1800, resonance: 0.35, filterEnv: 0.6, filterDecay: 0.09, attack: 0.001, decay: 0.35, sustain: 0.15, release: 0.07, velocity: 0.7, level: -3.1 },
    { bright: 4, lfo: { wave: LFO.triangle, division: DIV.sixteenth, centre: 2200, depth: 0.55 } },
  ),

  // A square (odd harmonics: reedy) under a low filter that velocity opens,
  // a short 1:1 FM bark, a little vibrato and warm drive: a reed piano.
  'poly-reed-piano': poly(
    { osc1Wave: W.square, osc2Wave: W.sine, osc2Semi: 12, detune: 3, osc2Level: 0.1, noise: 0, width: 0.3, fmAmount: 0.25, fmRatio: 1, fmDecay: 0.4, vibrato: 0.06, vibratoRate: 5, cutoff: 1600, resonance: 0.15, filterEnv: 0.35, filterDecay: 0.25, attack: 0.002, decay: 1.4, sustain: 0.35, release: 0.3, velocity: 0.8, level: -7 },
    { bright: 3, toneAlso: [{ param: 'fmAmount', dark: 0.1, bright: 0.65 }], lfo: { wave: LFO.sine, division: DIV.quarter, centre: 2600, depth: 0.45 }, drive: { character: CHARACTER.warm, tone: 0.5 }, macros: { drive: 0.15 } },
  ),

  // Saw and an octave square, bright, plucked with no sustain and a short
  // damper release: the jangle of a harpsichord.
  'poly-harpsichord': poly(
    { osc1Wave: W.saw, osc2Wave: W.square, osc2Semi: 12, detune: 4, osc2Level: 0.45, noise: 0, width: 0.35, cutoff: 4200, resonance: 0.15, filterEnv: 0.35, filterDecay: 0.25, attack: 0.001, decay: 1.1, sustain: 0, release: 0.35, velocity: 0.15, level: -6 },
    { bright: 4, lfo: { wave: LFO.sine, division: DIV.quarter, centre: 4000, depth: 0.4 } },
  ),

  // Triangle with a soft octave and a whisper of FM through a low filter,
  // long decay and a little drift: muted, intimate felt-piano chords.
  'poly-felt-piano': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 12, detune: 3, osc2Level: 0.18, noise: 0, width: 0.5, fmAmount: 0.12, fmRatio: 1, fmDecay: 0.4, drift: 0.2, cutoff: 1400, resonance: 0.05, filterEnv: 0.25, filterDecay: 0.5, attack: 0.006, decay: 2.5, sustain: 0.15, release: 0.8, velocity: 0.6, level: -9.9 },
    { bright: 3, toneAlso: [{ param: 'osc2Level', dark: 0.04, bright: 0.6 }, { param: 'fmAmount', dark: 0.02, bright: 0.65 }], lfo: { wave: LFO.sine, division: DIV.half, centre: 1800, depth: 0.45 } },
  ),

  /* ---------------- Pads & strings ---------------- */

  // Seven saws spread over ±28 cents plus a saw an octave down, slow attack,
  // wide: the trance supersaw.
  'poly-supersaw-pad': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: -12, detune: 0, osc2Level: 0.35, noise: 0, width: 0.85, unison: 7, unisonDetune: 28, cutoff: 3000, resonance: 0.1, filterEnv: 0.1, filterDecay: 2, attack: 0.6, decay: 2, sustain: 0.85, release: 1.8, velocity: 0.2, level: -9.6 },
    { bright: 3, lfo: { wave: LFO.sine, division: DIV.bars2, centre: 3000, depth: 0.6 }, macros: { motion: 0.15 } },
  ),

  // Three saws and an octave saw, soft 250 ms attack and a light vibrato:
  // the lush ensemble of a vintage string machine.
  'poly-string-ensemble': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: 12, detune: 9, osc2Level: 0.25, noise: 0, width: 0.75, unison: 3, unisonDetune: 14, vibrato: 0.12, vibratoRate: 5.5, cutoff: 2600, resonance: 0.05, filterEnv: 0.05, filterDecay: 1, attack: 0.25, decay: 1, sustain: 0.9, release: 0.9, velocity: 0.3, level: -10.2 },
    { bright: 3, lfo: { wave: LFO.sine, division: DIV.bar1, centre: 2800, depth: 0.5 }, macros: { motion: 0.1 } },
  ),

  // Five saws with a triangle an octave below, a 0.9 s swell, vibrato and a
  // touch of drift: slow, singing orchestral strings.
  'poly-cinematic-strings': poly(
    { osc1Wave: W.saw, osc2Wave: W.triangle, osc2Semi: -12, detune: 4, osc2Level: 0.3, noise: 0, width: 0.7, unison: 5, unisonDetune: 10, vibrato: 0.18, vibratoRate: 5, drift: 0.2, cutoff: 1700, resonance: 0.12, filterEnv: 0.15, filterDecay: 2.5, attack: 0.9, decay: 2, sustain: 0.95, release: 1.6, velocity: 0.45, level: -9 },
    { bright: 3, lfo: { wave: LFO.sine, division: DIV.bars2, centre: 2200, depth: 0.55 }, macros: { motion: 0.15 } },
  ),

  // Sine with a steady 3:1 FM and a detuned octave triangle, slow in and out:
  // a cool, crystalline pad.
  'poly-glass-pad': poly(
    { osc1Wave: W.sine, osc2Wave: W.triangle, osc2Semi: 12, detune: 8, osc2Level: 0.3, noise: 0, width: 0.8, fmAmount: 0.3, fmRatio: 3, fmDecay: 4, vibrato: 0.05, vibratoRate: 4, cutoff: 5000, resonance: 0.05, filterEnv: 0.05, filterDecay: 2, attack: 1.2, decay: 3, sustain: 0.8, release: 2.5, velocity: 0.25, level: -11.4 },
    { bright: 3, toneAlso: [{ param: 'fmAmount', dark: 0.08, bright: 0.65 }], lfo: { wave: LFO.sine, division: DIV.bars2, centre: 3500, depth: 0.55 }, macros: { motion: 0.2 } },
  ),

  // Three triangles over a saw an octave down, behind a low, slightly
  // resonant filter, with drift: dark and soft.
  'poly-velvet-pad': poly(
    { osc1Wave: W.triangle, osc2Wave: W.saw, osc2Semi: -12, detune: 5, osc2Level: 0.4, noise: 0, width: 0.7, unison: 3, unisonDetune: 12, drift: 0.3, cutoff: 700, resonance: 0.2, filterEnv: 0.25, filterDecay: 3, attack: 1, decay: 2.5, sustain: 0.9, release: 2.2, velocity: 0.25, level: -12.7 },
    { bright: 2, lfo: { wave: LFO.sine, division: DIV.bars4, centre: 1000, depth: 0.6 }, drive: { character: CHARACTER.warm, tone: 0.45 }, macros: { motion: 0.2 } },
  ),

  // Three triangles with breathy, slightly bright noise through a resonant
  // mid filter and vibrato: soft synthetic "ooh" voices.
  'poly-choir-ooh': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 12, detune: 6, osc2Level: 0.2, noise: 0.1, noiseColor: 0.65, width: 0.75, unison: 3, unisonDetune: 9, vibrato: 0.2, vibratoRate: 5.2, cutoff: 1300, resonance: 0.35, filterEnv: 0.05, filterDecay: 1, attack: 0.4, decay: 1.5, sustain: 0.95, release: 1.2, velocity: 0.3, level: -13.6 },
    { bright: 2, toneAlso: [{ param: 'osc2Level', dark: 0.05, bright: 0.6 }], lfo: { wave: LFO.triangle, division: DIV.bars2, centre: 1500, depth: 0.5 }, filter: { resonance: 0.3 }, macros: { motion: 0.15 } },
  ),

  // Saw and square detuned 11 cents with strong drift: every chord note
  // sits slightly differently, like an old polysynth.
  'poly-analog-pad': poly(
    { osc1Wave: W.saw, osc2Wave: W.square, osc2Semi: 0, detune: 11, osc2Level: 0.6, noise: 0.02, width: 0.6, drift: 0.6, cutoff: 1900, resonance: 0.25, filterEnv: 0.3, filterDecay: 1.5, attack: 0.35, decay: 1.6, sustain: 0.75, release: 1.4, velocity: 0.3, level: -9.3 },
    { bright: 3, lfo: { wave: LFO.triangle, division: DIV.bar1, centre: 2000, depth: 0.6 }, macros: { motion: 0.15 } },
  ),

  // Sine and a fifth above wrapped in bright, airy noise, slow in and out.
  'poly-breath-pad': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 7, detune: 6, osc2Level: 0.3, noise: 0.45, noiseColor: 0.85, width: 0.9, vibrato: 0.04, vibratoRate: 4.5, cutoff: 4000, resonance: 0.15, filterEnv: 0, filterDecay: 1, attack: 1.5, decay: 2, sustain: 0.9, release: 2.5, velocity: 0.2, level: -11.1 },
    { bright: 3, toneAlso: [{ param: 'noise', dark: 0.1, bright: 0.85 }], lfo: { wave: LFO.sine, division: DIV.bars2, centre: 4000, depth: 0.55 }, macros: { motion: 0.2 } },
  ),

  /* ---------------- Leads ---------------- */

  // Five saws and an octave saw, bright, with vibrato: a soaring trance lead.
  'poly-supersaw-lead': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: -12, detune: 5, osc2Level: 0.35, noise: 0, width: 0.5, unison: 7, unisonDetune: 24, vibrato: 0.1, vibratoRate: 5.8, cutoff: 5000, resonance: 0.15, filterEnv: 0.15, filterDecay: 0.4, attack: 0.01, decay: 0.5, sustain: 0.85, release: 0.4, velocity: 0.4, level: -4.2 },
    { bright: 4, lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 4500, depth: 0.45 } },
  ),

  // Square with a faint octave square, no velocity, a fast "chip" vibrato.
  'poly-chip-lead': poly(
    { osc1Wave: W.square, osc2Wave: W.square, osc2Semi: 12, detune: 0, osc2Level: 0.15, noise: 0, width: 0, vibrato: 0.15, vibratoRate: 7.5, cutoff: 4500, resonance: 0, filterEnv: 0, filterDecay: 0.1, attack: 0.001, decay: 0.2, sustain: 0.8, release: 0.05, velocity: 0, level: -4.9 },
    { bright: 4, lfo: { wave: LFO.square, division: DIV.sixteenth, centre: 3000, depth: 0.45 } },
  ),

  // Saw and a fifth-up saw into a resonant filter, plus a held 1:1 FM edge
  // and hard drive: screaming rave lead.
  'poly-saw-scream': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: 7, detune: 8, osc2Level: 0.5, noise: 0, width: 0.3, fmAmount: 0.2, fmRatio: 1, fmDecay: 4, cutoff: 2400, resonance: 0.6, filterEnv: 0.4, filterDecay: 0.3, attack: 0.003, decay: 0.4, sustain: 0.8, release: 0.2, velocity: 0.4, level: -3.9 },
    { bright: 3, lfo: { wave: LFO.sawDown, division: DIV.eighth, centre: 2500, depth: 0.55 }, drive: { character: CHARACTER.hard, tone: 0.6 }, macros: { drive: 0.3 } },
  ),

  // Sine with a faint twelfth, lots of bright breath noise, a resonant
  // hollow filter, a slight scoop and a slow vibrato: wooden flute.
  'poly-wooden-flute': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 19, detune: 3, osc2Level: 0.06, noise: 0.35, noiseColor: 0.8, width: 0.1, pitchEnv: -0.5, pitchDecay: 0.08, vibrato: 0.2, vibratoRate: 4.6, cutoff: 1800, resonance: 0.3, filterEnv: 0.15, filterDecay: 0.15, attack: 0.12, decay: 0.8, sustain: 0.9, release: 0.2, velocity: 0.45, level: -5.6 },
    { toneAlso: [{ param: 'noise', dark: 0.1, bright: 0.75 }], lfo: { wave: LFO.sine, division: DIV.quarter, centre: 2500, depth: 0.4 } },
  ),

  // Square (odd harmonics only) through a soft low-pass with a gentle attack
  // and vibrato: hollow, woody, clarinet-like.
  'poly-soft-reed': poly(
    { osc1Wave: W.square, osc2Wave: W.sine, osc2Semi: 12, detune: 2, osc2Level: 0.12, noise: 0.05, noiseColor: 0.6, width: 0.15, vibrato: 0.08, vibratoRate: 5, cutoff: 1600, resonance: 0.2, filterEnv: 0.15, filterDecay: 0.15, attack: 0.05, decay: 0.5, sustain: 0.85, release: 0.15, velocity: 0.5, level: -4.2 },
    { bright: 3, lfo: { wave: LFO.sine, division: DIV.quarter, centre: 1800, depth: 0.45 } },
  ),

  // Two saws (one a detuned pair) with a strong, slower filter envelope, a
  // 40 ms swell and a one-semitone scoop: bold 80s synth brass.
  'poly-synth-brass': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: 0, detune: 7, osc2Level: 0.7, noise: 0, width: 0.5, unison: 2, unisonDetune: 10, pitchEnv: -1, pitchDecay: 0.06, cutoff: 900, resonance: 0.15, filterEnv: 0.55, filterDecay: 0.6, attack: 0.04, decay: 0.6, sustain: 0.75, release: 0.25, velocity: 0.6, level: 0.5 },
    { bright: 4, lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 2000, depth: 0.5 } },
  ),

  // Three saws and an octave saw with a fast filter snap, a two-semitone
  // scoop and a short decay: punchy brass-section stabs.
  'poly-brass-stab': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: 12, detune: 9, osc2Level: 0.4, noise: 0, width: 0.6, unison: 3, unisonDetune: 12, pitchEnv: -2, pitchDecay: 0.04, cutoff: 1500, resonance: 0.2, filterEnv: 0.6, filterDecay: 0.2, attack: 0.01, decay: 0.35, sustain: 0.2, release: 0.15, velocity: 0.5, level: -3 },
    { bright: 4, lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 2500, depth: 0.5 } },
  ),

  // Sine with a steady 2:1 FM (odd and even harmonics, hollow), a quiet
  // square an octave down and vibrato: a singing digital lead.
  'poly-fm-lead': poly(
    { osc1Wave: W.sine, osc2Wave: W.square, osc2Semi: -12, detune: 3, osc2Level: 0.15, noise: 0, width: 0.25, fmAmount: 0.4, fmRatio: 2, fmDecay: 3, vibrato: 0.12, vibratoRate: 6, cutoff: 5000, resonance: 0.05, filterEnv: 0.1, filterDecay: 0.3, attack: 0.005, decay: 0.4, sustain: 0.85, release: 0.2, velocity: 0.5, level: -6.6 },
    { bright: 3, toneAlso: [{ param: 'fmAmount', dark: 0.12, bright: 0.75 }], lfo: { wave: LFO.sine, division: DIV.quarter, centre: 3500, depth: 0.45 } },
  ),

  /* ---------------- Plucks & bells ---------------- */

  // Sine with a slightly inharmonic 5.95:1 FM tine that dies in 80 ms and a
  // 1.3 s decay: a warm thumb piano.
  'poly-kalimba': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 12, detune: 0, osc2Level: 0.05, noise: 0, width: 0.3, fmAmount: 0.25, fmRatio: 5.95, fmDecay: 0.08, pitchEnv: 0.3, pitchDecay: 0.02, cutoff: 4500, resonance: 0.05, filterEnv: 0.1, filterDecay: 0.1, attack: 0.001, decay: 1.3, sustain: 0, release: 0.6, velocity: 0.6, level: -3.5 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.06, bright: 0.6 }], lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 3000, depth: 0.45 } },
  ),

  // Sine with a two-octave partial and a 4:1 FM mallet knock that lasts 50
  // ms, plus a soft dark tick of noise: round, wooden marimba notes.
  'poly-marimba': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 24, detune: 0, osc2Level: 0.15, noise: 0.04, noiseColor: 0.35, width: 0.35, fmAmount: 0.2, fmRatio: 4, fmDecay: 0.05, cutoff: 2500, resonance: 0, filterEnv: 0.3, filterDecay: 0.06, attack: 0.001, decay: 0.8, sustain: 0, release: 0.35, velocity: 0.7, level: -1.5 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.05, bright: 0.6 }], lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 2500, depth: 0.45 } },
  ),

  // Sine with a two-octave partial, a soft 4:1 FM strike, a long 3 s ring and
  // a slow shimmer: vibraphone.
  'poly-vibraphone': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 24, detune: 2, osc2Level: 0.25, noise: 0, width: 0.5, fmAmount: 0.2, fmRatio: 4, fmDecay: 0.3, vibrato: 0.1, vibratoRate: 5.5, cutoff: 5000, resonance: 0, filterEnv: 0.05, filterDecay: 0.2, attack: 0.002, decay: 3, sustain: 0, release: 1.2, velocity: 0.6, level: -11.2 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.05, bright: 0.6 }], lfo: { wave: LFO.sine, division: DIV.quarter, centre: 3500, depth: 0.45 } },
  ),

  // Sine with a strong 3.5:1 FM decaying over 2.5 s: big, inharmonic,
  // clanging bell partials that slowly purify.
  'poly-tubular-bell': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 12, detune: 3, osc2Level: 0.2, noise: 0, width: 0.5, fmAmount: 0.6, fmRatio: 3.5, fmDecay: 2.5, cutoff: 4500, resonance: 0, filterEnv: 0.1, filterDecay: 0.5, attack: 0.001, decay: 4, sustain: 0, release: 2.5, velocity: 0.5, level: -8.9 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.25, bright: 0.85 }], lfo: { wave: LFO.sine, division: DIV.half, centre: 3000, depth: 0.45 } },
  ),

  // Sine with the bar's own inharmonic partials: one at 2.7x (17 st, tuned
  // 10 cents sharp) and a 5.4:1 FM strike. Bright, short-ringing metal bars.
  'poly-glockenspiel': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 17, detune: 10, osc2Level: 0.35, noise: 0, width: 0.25, fmAmount: 0.2, fmRatio: 5.4, fmDecay: 0.25, cutoff: 6000, resonance: 0, filterEnv: 0.2, filterDecay: 0.2, attack: 0.001, decay: 1.3, sustain: 0, release: 0.6, velocity: 0.7, level: -3.3 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.05, bright: 0.6 }], lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 5000, depth: 0.4 } },
  ),

  // Triangle with an octave sine, a tiny 7:1 FM click and drift: delicate,
  // slightly imperfect music-box tines.
  'poly-music-box': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 12, detune: 0, osc2Level: 0.3, noise: 0, width: 0.4, fmAmount: 0.15, fmRatio: 7, fmDecay: 0.05, drift: 0.15, cutoff: 3500, resonance: 0, filterEnv: 0.3, filterDecay: 0.1, attack: 0.001, decay: 1.2, sustain: 0, release: 0.4, velocity: 0.3, level: -4 },
    { toneAlso: [{ param: 'osc2Level', dark: 0.05, bright: 0.7 }, { param: 'fmAmount', dark: 0.03, bright: 0.6 }], lfo: { wave: LFO.sine, division: DIV.quarter, centre: 4000, depth: 0.4 } },
  ),

  // Triangle with an octave sine, a quick filter pluck and a small 2:1 FM
  // touch, long ring: gentle harp strings.
  'poly-harp': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 12, detune: 2, osc2Level: 0.25, noise: 0, width: 0.55, fmAmount: 0.1, fmRatio: 2, fmDecay: 0.1, cutoff: 2400, resonance: 0.1, filterEnv: 0.4, filterDecay: 0.2, attack: 0.001, decay: 2.2, sustain: 0, release: 1.2, velocity: 0.6, level: -10.3 },
    { bright: 3, toneAlso: [{ param: 'osc2Level', dark: 0.03, bright: 0.85 }, { param: 'fmAmount', dark: 0.02, bright: 0.7 }], lfo: { wave: LFO.sine, division: DIV.quarter, centre: 2500, depth: 0.45 } },
  ),

  // Triangle and a strong detuned octave with a 2:1 FM ping and a tiny pitch
  // drop: the bright, metallic attack of a steel pan.
  'poly-steel-drum': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 12, detune: 6, osc2Level: 0.5, noise: 0, width: 0.5, fmAmount: 0.35, fmRatio: 2, fmDecay: 0.3, pitchEnv: 0.5, pitchDecay: 0.03, cutoff: 3500, resonance: 0.05, filterEnv: 0.3, filterDecay: 0.15, attack: 0.001, decay: 0.9, sustain: 0, release: 0.4, velocity: 0.6, level: -3.3 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.08, bright: 0.65 }], lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 3000, depth: 0.45 } },
  ),

  // Saw with an octave triangle through a resonant, snapping filter, and a
  // one-semitone pitch snap: a twangy plucked string.
  'poly-koto-pluck': poly(
    { osc1Wave: W.saw, osc2Wave: W.triangle, osc2Semi: 12, detune: 3, osc2Level: 0.3, noise: 0, width: 0.3, pitchEnv: 1, pitchDecay: 0.03, cutoff: 1500, resonance: 0.35, filterEnv: 0.55, filterDecay: 0.12, attack: 0.001, decay: 1.4, sustain: 0, release: 0.5, velocity: 0.6, level: -1.6 },
    { bright: 4, lfo: { wave: LFO.triangle, division: DIV.eighth, centre: 2000, depth: 0.5 } },
  ),

  /* ---------------- Textures & FX ---------------- */

  // Saws and bright noise rising from two octaves below over a 6 s pitch
  // sweep, with a 4 s fade-in: a build-up riser.
  'poly-sweep-riser': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: 7, detune: 20, osc2Level: 0.5, noise: 0.8, noiseColor: 0.7, width: 1, unison: 3, unisonDetune: 30, pitchEnv: -24, pitchDecay: 6, cutoff: 1500, resonance: 0.4, filterEnv: 0, filterDecay: 1, attack: 4, decay: 4, sustain: 1, release: 1.5, velocity: 0.2, level: -4.6 },
    { bright: 3, lfo: { wave: LFO.sawUp, division: DIV.bar1, centre: 3000, depth: 0.6 } },
  ),

  // Saws and noise falling two octaves over 3 s with a closing filter: a
  // falling whoosh.
  'poly-downlifter': poly(
    { osc1Wave: W.saw, osc2Wave: W.saw, osc2Semi: -12, detune: 10, osc2Level: 0.4, noise: 0.6, noiseColor: 0.6, width: 0.9, unison: 3, unisonDetune: 25, pitchEnv: 24, pitchDecay: 3, cutoff: 3000, resonance: 0.2, filterEnv: 0.3, filterDecay: 3, attack: 0.005, decay: 3, sustain: 0, release: 1.5, velocity: 0.2, level: -2.3 },
    { bright: 3, lfo: { wave: LFO.sawDown, division: DIV.bar1, centre: 3000, depth: 0.6 } },
  ),

  // Three saws over a square an octave down behind a low, resonant filter,
  // with drift and a very slow wobble: a churning drone.
  'poly-dark-drone': poly(
    { osc1Wave: W.saw, osc2Wave: W.square, osc2Semi: -12, detune: 4, osc2Level: 0.6, noise: 0, width: 0.8, unison: 3, unisonDetune: 9, drift: 0.4, vibrato: 0.05, vibratoRate: 1.2, cutoff: 420, resonance: 0.45, filterEnv: 0, filterDecay: 1, attack: 2.5, decay: 3, sustain: 1, release: 3, velocity: 0.2, level: -8.5 },
    { bright: 2, lfo: { wave: LFO.sine, division: DIV.bars4, centre: 700, depth: 0.7 }, macros: { motion: 0.3 } },
  ),

  // Full dark noise over a faint sine, a slow swell and a long release; the
  // four-bar Motion LFO makes it surge like waves.
  'poly-ocean-wash': poly(
    { osc1Wave: W.sine, osc2Wave: W.sine, osc2Semi: 12, detune: 0, osc2Level: 0.05, noise: 1, noiseColor: 0.2, width: 1, cutoff: 1200, resonance: 0.1, filterEnv: 0.2, filterDecay: 4, attack: 2, decay: 4, sustain: 0.7, release: 3.5, velocity: 0.2, level: -7.9 },
    { bright: 3, toneAlso: [{ param: 'noiseColor', dark: 0.05, bright: 0.6 }], lfo: { wave: LFO.sine, division: DIV.bars4, centre: 900, depth: 0.75 }, macros: { motion: 0.4 } },
  ),

  // Square and an octave saw diving two octaves in 250 ms, no sustain: pew.
  'poly-laser-zap': poly(
    { osc1Wave: W.square, osc2Wave: W.saw, osc2Semi: 12, detune: 5, osc2Level: 0.3, noise: 0, width: 0.3, pitchEnv: 24, pitchDecay: 0.25, cutoff: 3000, resonance: 0.3, filterEnv: 0.3, filterDecay: 0.2, attack: 0.001, decay: 0.3, sustain: 0, release: 0.1, velocity: 0.3, level: 1.6 },
    { bright: 4, lfo: { wave: LFO.square, division: DIV.sixteenth, centre: 3000, depth: 0.5 } },
  ),

  // Sine with a heavy 1.41:1 FM (√2: maximally inharmonic), a tritone square
  // and a hiss: a harsh industrial clang.
  'poly-metal-clang': poly(
    { osc1Wave: W.sine, osc2Wave: W.square, osc2Semi: 6, detune: 0, osc2Level: 0.2, noise: 0.1, noiseColor: 0.85, width: 0.6, fmAmount: 0.8, fmRatio: 1.41, fmDecay: 0.8, cutoff: 4500, resonance: 0.1, filterEnv: 0.2, filterDecay: 0.3, attack: 0.001, decay: 1.5, sustain: 0, release: 1, velocity: 0.6, level: -1.4 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.35, bright: 0.95 }], lfo: { wave: LFO.random, division: DIV.sixteenth, centre: 3000, depth: 0.5 } },
  ),

  // Sine with a 7.1:1 FM blip, an octave pitch rise in 150 ms and a fast,
  // deep vibrato: bubbly computer chirps.
  'poly-scifi-chirp': poly(
    { osc1Wave: W.sine, osc2Wave: W.triangle, osc2Semi: 12, detune: 7, osc2Level: 0.15, noise: 0, width: 0.6, fmAmount: 0.5, fmRatio: 7.1, fmDecay: 0.15, pitchEnv: -12, pitchDecay: 0.15, vibrato: 0.6, vibratoRate: 11, cutoff: 4000, resonance: 0.1, filterEnv: 0.1, filterDecay: 0.2, attack: 0.002, decay: 0.4, sustain: 0.3, release: 0.2, velocity: 0.3, level: -1.2 },
    { toneAlso: [{ param: 'fmAmount', dark: 0.15, bright: 0.8 }], lfo: { wave: LFO.random, division: DIV.sixteenth, centre: 3500, depth: 0.55 } },
  ),

  // Triangle and a wide-detuned octave with heavy drift, a slow, deep
  // vibrato (tape wow) and hiss: worn-out tape.
  'poly-warped-tape': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 12, detune: 15, osc2Level: 0.4, noise: 0.12, noiseColor: 0.75, width: 0.5, drift: 0.9, vibrato: 0.25, vibratoRate: 1.3, cutoff: 1800, resonance: 0.05, filterEnv: 0.1, filterDecay: 1, attack: 0.3, decay: 1.5, sustain: 0.8, release: 1.2, velocity: 0.3, level: -8.9 },
    { bright: 3, toneAlso: [{ param: 'osc2Level', dark: 0.05, bright: 0.8 }], lfo: { wave: LFO.sine, division: DIV.bar1, centre: 2000, depth: 0.5 }, drive: { character: CHARACTER.warm, tone: 0.4 }, macros: { motion: 0.15 } },
  ),
};

/* ------------------------------------------------------------------ */
/* Applying sounds to a project                                        */
/* ------------------------------------------------------------------ */

const SLOT_TYPES: Record<Exclude<TrackSlot, 'inst'>, ModuleType> = { drive: 'drive', filter: 'filter', lfo: 'lfo', ch: 'channel' };

/** The patch module id of a track slot. */
export function slotModuleId(trackId: Id, slot: TrackSlot): Id {
  return slot === 'ch' ? moduleId.channel(trackId) : moduleId[slot](trackId);
}

/**
 * Module params that presets own (the union of what any preset sets). They
 * are reset to registry defaults before a preset applies its own values, so
 * one preset's LFO rate or drive character never leaks into the next.
 * Channel params (the user's mix) are never preset-owned.
 */
export const PRESET_OWNED_MODULE_PARAMS: Readonly<Record<'lfo' | 'filter' | 'drive', readonly string[]>> = (() => {
  const owned = { lfo: new Set<string>(), filter: new Set<string>(), drive: new Set<string>() };
  for (const data of Object.values(PRESETS)) {
    for (const slot of ['lfo', 'filter', 'drive'] as const) for (const p of Object.keys(data.modules?.[slot] ?? {})) owned[slot].add(p);
  }
  return { lfo: [...owned.lfo], filter: [...owned.filter], drive: [...owned.drive] };
})();

function findTrack(project: Project, trackId: Id): Track {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`There is no part with id "${trackId}" in this project.`);
  return track;
}

/** Keep only macro targets whose module exists in the patch (a removed filter must not leave a dangling mapping). */
function keepExisting(project: Project, map: MacroMap): MacroMap {
  const ids = new Set(project.patch.modules.map((m) => m.id));
  const out = {} as MacroMap;
  for (const m of MACRO_IDS) out[m] = (map[m] ?? []).filter((t) => ids.has(t.module));
  return out;
}

/** The macro map a preset gives a track: the defaults with the preset's overrides. */
export function presetMacroMap(trackId: Id, data: PresetData): MacroMap {
  const map = defaultMacroMap(trackId);
  for (const m of MACRO_IDS) {
    const over = data.macroMap?.[m];
    if (!over) continue;
    map[m] = over.map(({ slot, ...rest }): MacroTarget => ({ module: slotModuleId(trackId, slot), ...rest }));
  }
  return map;
}

function setModuleParams(project: Project, trackId: Id, slot: 'lfo' | 'filter' | 'drive', values: ParamValues | undefined, resetOwned: boolean): void {
  const mod = project.patch.modules.find((m) => m.id === slotModuleId(trackId, slot));
  if (!mod || mod.type !== SLOT_TYPES[slot]) return;
  const specs = MODULE_PARAMS[mod.type];
  if (resetOwned) {
    for (const p of PRESET_OWNED_MODULE_PARAMS[slot]) {
      const spec = specById(specs, p);
      if (spec) mod.params[p] = spec.default;
    }
  }
  for (const [p, v] of Object.entries(values ?? {})) {
    const spec = specById(specs, p);
    if (spec) mod.params[p] = clampParam(spec, v);
  }
}

/**
 * Assign a synth preset to a track (bass or poly). Changes the instrument kind
 * if needed. Mutates `project` (use inside an immer recipe).
 *
 * Writes: the instrument (registry defaults + preset params), the macro map
 * (defaults + preset overrides), the preset's LFO/filter/drive settings, and
 * the Tone/Motion/Drive positions (the preset's suggestion, else the default).
 * Space, Echo and Pump positions, channel level/pan/sends, clips and
 * connections are left as the user set them. Throws for unknown ids.
 */
export function applyPresetToProject(project: Project, trackId: Id, presetId: string): void {
  const info = presetInfo(presetId);
  const data = PRESETS[presetId];
  if (!info || !data) throw new Error(`Unknown synth preset "${presetId}".`);
  const track = findTrack(project, trackId);

  const specs = INSTRUMENT_PARAMS[info.kind];
  const params = defaultParams(specs);
  for (const [k, v] of Object.entries(data.params)) {
    const spec = specById(specs, k);
    if (spec) params[k] = clampParam(spec, v);
  }
  track.instrument = info.kind === 'bass' ? { kind: 'bass', presetId, params } : { kind: 'poly', presetId, params };
  track.macroMap = keepExisting(project, presetMacroMap(trackId, data));
  for (const slot of ['lfo', 'filter', 'drive'] as const) setModuleParams(project, trackId, slot, data.modules?.[slot], true);

  const defaults = defaultMacros();
  for (const m of ['tone', 'motion', 'drive'] as const) track.macros[m] = data.macros?.[m] ?? defaults[m];
}

/**
 * Assign a drum kit to a track; voices start from their defaults. The kit
 * Level starts at the new kit's matched level (KitInfo.level). When the
 * track already played drums, the user's trim relative to the old kit's
 * matched level is kept. Mutates `project`.
 */
export function applyKitToProject(project: Project, trackId: Id, kitId: string): void {
  const info = kitInfo(kitId);
  if (!info) throw new Error(`Unknown drum kit "${kitId}".`);
  const track = findTrack(project, trackId);
  const params = defaultParams(DRUM_KIT_PARAMS);
  const spec = specById(DRUM_KIT_PARAMS, 'level') as ParamSpec;
  let level = info.level;
  if (track.instrument.kind === 'drums') {
    const old = track.instrument.params.level;
    const oldRef = kitInfo(track.instrument.kitId)?.level;
    if (typeof old === 'number' && Number.isFinite(old)) level += old - (oldRef ?? info.level);
  }
  params.level = clampParam(spec, level);
  track.instrument = { kind: 'drums', kitId, params, voices: defaultDrumVoices() };
  track.macroMap = keepExisting(project, defaultMacroMap(trackId));
}

/** Turn a track into a sampler playing `sampleId` (imported or built-in). Mutates `project`. */
export function applySamplerToProject(project: Project, trackId: Id, sampleId: string | null): void {
  if (sampleId !== null) {
    const known = sampleId.startsWith('builtin:') ? builtinSampleInfo(sampleId) !== undefined : project.samples.some((s) => s.id === sampleId);
    if (!known) throw new Error(`Unknown recording "${sampleId}": import it into the project first.`);
  }
  const track = findTrack(project, trackId);
  track.instrument = { kind: 'sampler', sampleId, params: defaultParams(SAMPLER_PARAMS) };
  track.macroMap = keepExisting(project, defaultMacroMap(trackId));
}
