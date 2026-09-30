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
 * MONO BASS: osc (wave) + square sub one octave down -> 24 dB low-pass with
 * envelope -> saturation -> ADSR; octave transpose; glide on legato notes.
 * POLY: osc1 + osc2 (semitones, detune, level) + noise -> stereo width ->
 * 12 dB low-pass with filter envelope -> ADSR, 12 voices.
 *
 * Macros for synth presets:
 * - Tone sweeps the instrument's own cutoff geometrically around the designed
 *   value (about cutoff/4 at 0, the designed sound at 0.5, cutoff*4 at 1),
 *   plus a high-shelf lift above 0.6 on brighter sounds.
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

/** Motion: LFO depth 0..`depth`, track filter from open to `centre` Hz. */
function motion(centre: number, depth: number): PresetMacroTarget[] {
  return [
    { slot: 'lfo', param: 'depth', min: 0, max: depth, curve: 'lin' },
    { slot: 'filter', param: 'cutoff', min: FILTER_OPEN, max: centre, curve: 'exp', macroFrom: 0, macroTo: MOTION_CENTRE_AT },
  ];
}

interface BassDesign {
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

interface PolyDesign {
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
  lfo: { wave: number; division: number; centre: number; depth: number };
  filter?: ParamValues;
  drive?: ParamValues;
  macros?: Partial<Pick<MacroValues, 'tone' | 'motion' | 'drive'>>;
}

function bass(d: BassDesign, x: Extras): PresetData {
  return build(BASS_PARAMS, { octave: 0, ...d }, x);
}

function poly(d: PolyDesign, x: Extras): PresetData {
  return build(POLY_PARAMS, { ...d }, x);
}

function build(specs: readonly ParamSpec[], params: Record<string, number>, x: Extras): PresetData {
  const modules: PresetData['modules'] = { lfo: { wave: x.lfo.wave, division: x.lfo.division } };
  if (x.filter) modules.filter = { ...x.filter };
  if (x.drive) modules.drive = { ...x.drive };
  const data: PresetData = {
    params: { ...params },
    macroMap: { tone: tone(specs, params.cutoff, x.bright), motion: motion(x.lfo.centre, x.lfo.depth) },
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
    { lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 600, depth: 0.6 } },
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
    { bright: 4, lfo: { wave: LFO.sine, division: DIV.half, centre: 3000, depth: 0.45 } },
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
    { bright: 3, lfo: { wave: LFO.sine, division: DIV.quarter, centre: 3500, depth: 0.4 } },
  ),

  // Woody triangle strike plus a slightly detuned sine 19 semitones up (the
  // bell partial) and a tick of noise; no sustain, so arpeggios stay clear.
  'poly-mallet-bell': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 19, detune: 9, osc2Level: 0.4, noise: 0.03, width: 0.4, cutoff: 3600, resonance: 0.06, filterEnv: 0.45, filterDecay: 0.07, attack: 0.001, decay: 0.55, sustain: 0, release: 0.4, velocity: 0.6, level: -1 },
    { bright: 4, lfo: { wave: LFO.triangle, division: DIV.quarter, centre: 3000, depth: 0.45 } },
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
    { bright: 3, lfo: { wave: LFO.sine, division: DIV.bars4, centre: 1800, depth: 0.6 }, drive: { character: CHARACTER.warm, tone: 0.5 }, macros: { motion: 0.25 } },
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
    { bright: 2, lfo: { wave: LFO.triangle, division: DIV.bars2, centre: 1600, depth: 0.55 }, filter: { resonance: 0.35 }, macros: { motion: 0.2 } },
  ),

  // Triangle plus a detuned sine two octaves up, a hint of tape hiss, a
  // clear filter and a slow swell: a high, sparkling layer.
  'poly-tape-shimmer': poly(
    { osc1Wave: W.triangle, osc2Wave: W.sine, osc2Semi: 24, detune: 14, osc2Level: 0.55, noise: 0.08, width: 0.95, cutoff: 4500, resonance: 0.1, filterEnv: 0.05, filterDecay: 2, attack: 1.2, decay: 2, sustain: 0.8, release: 2.4, velocity: 0.2, level: -9 },
    { bright: 4, lfo: { wave: LFO.sine, division: DIV.bar1, centre: 6000, depth: 0.6 }, macros: { motion: 0.25 } },
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
 * Assign a drum kit to a track. Keeps the previous kit level when the track
 * already played drums; voices start from their defaults. Mutates `project`.
 */
export function applyKitToProject(project: Project, trackId: Id, kitId: string): void {
  if (!kitInfo(kitId)) throw new Error(`Unknown drum kit "${kitId}".`);
  const track = findTrack(project, trackId);
  const params = defaultParams(DRUM_KIT_PARAMS);
  if (track.instrument.kind === 'drums') {
    const level = track.instrument.params.level;
    const spec = specById(DRUM_KIT_PARAMS, 'level') as ParamSpec;
    if (typeof level === 'number') params.level = clampParam(spec, level);
  }
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
