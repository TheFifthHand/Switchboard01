/**
 * Authoring helpers for the curated starter projects.
 *
 * Starters are written as readable musical text: drum grids as one string per
 * voice, melodic lines as whitespace-separated step tokens, chords as note
 * names. Everything here is pure data manipulation (architecture layer 1) and
 * produces plain JSON project data through the project factory.
 *
 * Clip definitions (`ClipDef`) are immutable templates. `buildStarter`
 * instantiates them with fresh ids on every build, so two projects built from
 * the same starter never share objects.
 */
import { BUILTIN_SAMPLES, KITS, SYNTH_PRESETS } from '../catalog';
import { applyKitToProject, applyPresetToProject, applySamplerToProject } from '../presets';
import { DELAY_ID, REVERB_ID, createClip, createProject, moduleId, uid } from '../../project/factory';
import { DRUM_VOICE_PARAM_SPECS, INSTRUMENT_PARAMS, MODULE_PARAMS, clampParam, specById } from '../../project/params';
import { hashString } from '../../project/rng';
import {
  DRUM_VOICES,
  MACRO_IDS,
  SCENE_ROWS,
  STEPS_PER_BAR,
  TICKS_PER_BAR,
  TICKS_PER_STEP,
  type ArpSettings,
  type ClipBars,
  type DrumVoiceSettings,
  type Id,
  type MacroValues,
  type Note,
  type ParamValues,
  type Project,
  type ScaleId,
  type TrackRole,
} from '../../project/types';
import type { StarterDef } from './index';

/** A note before it receives an id. */
export type NoteData = Omit<Note, 'id'>;

/* ------------------------------------------------------------------ */
/* Velocity vocabulary                                                 */
/* ------------------------------------------------------------------ */

/** Velocities used by grid characters and note suffixes. */
export const VEL = {
  /** 'X' in grids, '!' after a note. */
  accent: 1,
  /** 'x' in grids, a plain note. */
  normal: 0.8,
  /** '?' after a note: a softer melodic note. */
  soft: 0.5,
  /** 'o' in grids: a ghost note. */
  ghost: 0.42,
} as const;

/* ------------------------------------------------------------------ */
/* Pitch names                                                         */
/* ------------------------------------------------------------------ */

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_RE = /^([A-Ga-g])(#|b)?(-?\d)$/;

/** MIDI number of a note name, with C4 = 60. Accepts sharps and flats: 'F#2', 'Bb1', 'Eb3'. */
export function midi(name: string): number {
  const m = NOTE_RE.exec(name.trim());
  if (!m) throw new Error(`Starter DSL: "${name}" is not a note name (e.g. C4, F#2, Bb1).`);
  const pc = PITCH_CLASS[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const value = (Number(m[3]) + 1) * 12 + pc;
  if (value < 0 || value > 127) throw new Error(`Starter DSL: "${name}" is outside the MIDI range.`);
  return value;
}

function toPitch(p: string | number): number {
  return typeof p === 'number' ? p : midi(p);
}

/** Space- or '+'-separated note names ("G3 Bb3 D4" or "G3+Bb3+D4") as MIDI numbers. */
export function voicing(names: string): number[] {
  const parts = names.split(/[\s+]+/).filter(Boolean);
  if (parts.length === 0) throw new Error('Starter DSL: empty chord voicing.');
  return parts.map(midi);
}

const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALE_LABELS: Record<ScaleId, string> = {
  major: 'major',
  minor: 'minor',
  dorian: 'dorian',
  phrygian: 'phrygian',
  lydian: 'lydian',
  mixolydian: 'mixolydian',
  harmonicMinor: 'harmonic minor',
  majorPentatonic: 'major pentatonic',
  minorPentatonic: 'minor pentatonic',
  blues: 'blues',
  chromatic: 'chromatic',
};

/** Human-readable key, e.g. keyLabel(9, 'minor') === 'A minor'. */
export function keyLabel(root: number, scale: ScaleId): string {
  return `${KEY_NAMES[((root % 12) + 12) % 12]} ${SCALE_LABELS[scale]}`;
}

/* ------------------------------------------------------------------ */
/* Grids (drums, rhythms)                                              */
/* ------------------------------------------------------------------ */

/**
 * Standard kit voice names mapped to DRUM_SLOTS indices (src/content/catalog.ts).
 * Slot 6 is a shaker in most kits and a pedal hat in 'tight-circuit'; it
 * chokes the open hat like the closed hat does.
 */
export const DRUM = {
  kick: 0,
  kick2: 1,
  snare: 2,
  clap: 3,
  hat: 4,
  openHat: 5,
  shaker: 6,
  rim: 7,
  lowTom: 8,
  midTom: 9,
  highTom: 10,
  bell: 11,
  crash: 12,
  ride: 13,
  perc: 14,
  fx: 15,
} as const;
export type DrumVoice = keyof typeof DRUM;

export interface GridHit {
  step: number;
  /** Length in steps (1 + following '-' characters). */
  len: number;
  velocity: number;
}

/**
 * Parse a step grid: one character per 16th step.
 *   'x' normal, 'X' accent, 'o' ghost, '1'..'9' explicit velocity (tenths),
 *   '.' rest, '-' extends the previous hit by one step.
 * Spaces and '|' are ignored so bars can be separated visually.
 * Returns the hits and the grid length in steps.
 */
export function parseGrid(pattern: string): { hits: GridHit[]; steps: number } {
  const chars = pattern.replace(/[\s|]/g, '');
  const hits: GridHit[] = [];
  let last: GridHit | null = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    let velocity: number | null = null;
    if (c === 'x') velocity = VEL.normal;
    else if (c === 'X') velocity = VEL.accent;
    else if (c === 'o') velocity = VEL.ghost;
    else if (c >= '1' && c <= '9') velocity = Number(c) / 10;
    else if (c === '.') {
      last = null;
      continue;
    } else if (c === '-') {
      if (last) last.len += 1;
      continue;
    } else throw new Error(`Starter DSL: unknown grid character "${c}" in "${pattern}".`);
    last = { step: i, len: 1, velocity };
    hits.push(last);
  }
  return { hits, steps: chars.length };
}

/** Repeat a grid's hits to fill `totalSteps` (the grid length must divide it). */
function tileHits(pattern: string, totalSteps: number): GridHit[] {
  const { hits, steps } = parseGrid(pattern);
  if (steps === 0 || totalSteps % steps !== 0) {
    throw new Error(`Starter DSL: grid "${pattern}" (${steps} steps) does not fit ${totalSteps} steps.`);
  }
  const out: GridHit[] = [];
  for (let offset = 0; offset < totalSteps; offset += steps) {
    for (const h of hits) out.push({ ...h, step: h.step + offset });
  }
  return out;
}

/**
 * Slot names of the 'hand-percussion' kit, which puts hand drums and small
 * percussion on the standard slots (congas on the kick slots, and so on).
 * Congas and bongos are tuned to G and D; agogos to E and B.
 */
export const HAND = {
  lowConga: 0,
  highConga: 1,
  bongoLo: 2,
  bongoHi: 3,
  shaker: 4,
  tambourine: 5,
  cabasa: 6,
  clave: 7,
  woodblock: 8,
  agogoLo: 9,
  agogoHi: 10,
  cowbell: 11,
  triangle: 12,
  guiro: 13,
  cajon: 14,
  snap: 15,
} as const;
export type HandVoice = keyof typeof HAND;

export type DrumGrid = Partial<Record<DrumVoice, string>>;
export type HandGrid = Partial<Record<HandVoice, string>>;

function gridNotes(bars: number, slots: Readonly<Record<string, number>>, grid: Readonly<Record<string, string | undefined>>): NoteData[] {
  const total = bars * STEPS_PER_BAR;
  const out: NoteData[] = [];
  for (const voice of Object.keys(grid)) {
    const pattern = grid[voice];
    if (pattern === undefined) continue;
    const slot = slots[voice];
    if (slot === undefined) throw new Error(`Starter DSL: unknown drum voice "${voice}".`);
    for (const h of tileHits(pattern, total)) {
      out.push({ tick: h.step * TICKS_PER_STEP, pitch: slot, velocity: h.velocity, duration: h.len * TICKS_PER_STEP });
    }
  }
  return out;
}

/**
 * Drum notes from one grid string per voice (standard kit slot names).
 * Grids shorter than `bars` are tiled, so a one-bar hat line can run under a
 * two-bar kick pattern.
 */
export function drums(bars: number, grid: DrumGrid): NoteData[] {
  return gridNotes(bars, DRUM, grid);
}

/** Like `drums`, with the hand-percussion kit's slot names. */
export function hand(bars: number, grid: HandGrid): NoteData[] {
  return gridNotes(bars, HAND, grid);
}

/* ------------------------------------------------------------------ */
/* Melodic lines                                                       */
/* ------------------------------------------------------------------ */

/** [pitch, startStep, lengthSteps, velocity?] — steps are 16ths and may be fractional. */
export type MelEvent = [pitch: string | number, step: number, len: number, vel?: number];

/** Notes from explicit events. `gate` scales every length (1 = exactly as written). */
export function mel(events: readonly MelEvent[], opts: { gate?: number; vel?: number } = {}): NoteData[] {
  const gate = opts.gate ?? 1;
  return events.map(([p, step, len, vel]) => ({
    tick: step * TICKS_PER_STEP,
    pitch: toPitch(p),
    velocity: vel ?? opts.vel ?? VEL.normal,
    duration: len * TICKS_PER_STEP * gate,
  }));
}

export interface SeqOptions {
  /** Steps per token (default 1 = 16ths; 4 = quarter notes, 16 = whole bars). */
  unit?: number;
  /** Fraction of the written length that sounds (default 0.9, detached). */
  gate?: number;
  /** Velocity of a plain note (default VEL.normal). */
  vel?: number;
  /** Velocity of a '!' note (default VEL.accent). */
  accent?: number;
  /** Velocity of a '?' note (default VEL.soft). */
  soft?: number;
}

/**
 * A line in compact text form. Whitespace-separated tokens, one per `unit`
 * steps ('|' tokens are ignored and can mark bars):
 *   'G2'        a note (several notes joined with '+' form a chord: 'G3+Bb3+D4')
 *   '.'         rest
 *   '-'         tie: the previous note sounds one token longer
 * Note suffixes: '!' accent, '?' soft, '~' slide (the note overlaps the next
 * one, so a mono bass glides into it).
 *
 *   seq('G1 - . G2? G1 . . . D2 - . F2 G2 . . .')
 */
export function seq(src: string, opts: SeqOptions = {}): NoteData[] {
  const unit = opts.unit ?? 1;
  const gate = opts.gate ?? 0.9;
  const tokens = src.split(/\s+/).filter((t) => t && t !== '|');
  const out: NoteData[] = [];
  let current: { notes: NoteData[]; steps: number; slide: boolean } | null = null;
  const flush = () => {
    if (!current) return;
    const written = current.steps * unit * TICKS_PER_STEP;
    // A slide holds for the full length plus a third of a step so it overlaps the next note.
    const dur = current.slide ? written + TICKS_PER_STEP / 3 : written * gate;
    for (const n of current.notes) n.duration = dur;
    out.push(...current.notes);
    current = null;
  };
  tokens.forEach((tok, i) => {
    if (tok === '-') {
      if (current) current.steps += 1;
      return;
    }
    flush();
    if (tok === '.') return;
    const m = /^([^!?~]+)([!?~]*)$/.exec(tok);
    if (!m) throw new Error(`Starter DSL: cannot read token "${tok}".`);
    const suffix = m[2];
    const velocity = suffix.includes('!') ? opts.accent ?? VEL.accent : suffix.includes('?') ? opts.soft ?? VEL.soft : opts.vel ?? VEL.normal;
    const tick = i * unit * TICKS_PER_STEP;
    current = {
      notes: voicing(m[1]).map((pitch) => ({ tick, pitch, velocity, duration: 0 })),
      steps: 1,
      slide: suffix.includes('~'),
    };
  });
  flush();
  return out;
}

/**
 * `seq` with a length check: the line must cover exactly `bars` bars
 * (tokens × unit = bars × 16), which catches miscounted steps when authoring.
 */
export function line(bars: number, src: string, opts: SeqOptions = {}): NoteData[] {
  const unit = opts.unit ?? 1;
  const tokens = src.split(/\s+/).filter((t) => t && t !== '|').length;
  if (tokens * unit !== bars * STEPS_PER_BAR) {
    throw new Error(`Starter DSL: line covers ${(tokens * unit) / STEPS_PER_BAR} bar(s), expected ${bars}: "${src}"`);
  }
  return seq(src, opts);
}

/** One chord: voicing names, start step, length in steps. */
export function chord(names: string, step: number, len: number, vel: number = VEL.normal): NoteData[] {
  return voicing(names).map((pitch) => ({ tick: step * TICKS_PER_STEP, pitch, velocity: vel, duration: len * TICKS_PER_STEP }));
}

/**
 * A rolled chord: each note enters `spread` steps after the one below it
 * (0.5 = a 32nd) and all notes end together, like a strummed or rolled keyboard chord.
 */
export function strum(names: string, step: number, len: number, spread = 0.5, vel: number = VEL.normal): NoteData[] {
  return voicing(names).map((pitch, i) => ({
    tick: (step + i * spread) * TICKS_PER_STEP,
    pitch,
    // Upper notes of a roll land slightly softer, as a hand would play them.
    velocity: vel * (1 - i * 0.04),
    duration: (len - i * spread) * TICKS_PER_STEP,
  }));
}

/** A chord progression: [voicing, startStep, lengthSteps, velocity?][]. `gate` < 1 leaves a breath between chords. */
export function prog(items: readonly [names: string, step: number, len: number, vel?: number][], gate = 0.97): NoteData[] {
  return items.flatMap(([names, step, len, vel]) => chord(names, step, len * gate, vel ?? VEL.normal));
}

export interface StabOptions {
  /** How the voicing list advances: one voicing per bar (default), half bar, beat, or per hit. */
  per?: 'bar' | 'half' | 'beat' | 'hit';
  /** Fraction of each hit's written length that sounds (default 0.8). */
  gate?: number;
}

/**
 * Repeated chord hits on a grid rhythm (same characters as drum grids; '-'
 * lengthens a hit). The grid is tiled to `bars`.
 *
 *   stabs(2, '..x...x-..X..x..', ['Bb3 D4 F4 A4', 'Bb3 D4 E4 G4'])
 */
export function stabs(bars: number, rhythm: string, voicings: readonly string[], opts: StabOptions = {}): NoteData[] {
  const per = opts.per ?? 'bar';
  const gate = opts.gate ?? 0.8;
  const parsed = voicings.map(voicing);
  const out: NoteData[] = [];
  tileHits(rhythm, bars * STEPS_PER_BAR).forEach((h, i) => {
    const index = per === 'hit' ? i : per === 'beat' ? Math.floor(h.step / 4) : per === 'half' ? Math.floor(h.step / 8) : Math.floor(h.step / STEPS_PER_BAR);
    for (const pitch of parsed[index % parsed.length]) {
      out.push({ tick: h.step * TICKS_PER_STEP, pitch, velocity: h.velocity, duration: h.len * TICKS_PER_STEP * gate });
    }
  });
  return out;
}

/** Move notes later by whole bars (e.g. a fill in the last bar of a four-bar clip). */
export function atBar(bar: number, notes: readonly NoteData[]): NoteData[] {
  return notes.map((n) => ({ ...n, tick: n.tick + bar * TICKS_PER_BAR }));
}

/* ------------------------------------------------------------------ */
/* Clips                                                               */
/* ------------------------------------------------------------------ */

/** An immutable clip template. */
export interface ClipDef {
  readonly name: string;
  readonly bars: ClipBars;
  readonly notes: readonly NoteData[];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * A clip template from note lists. Validates that every note starts inside
 * the clip, trims note tails at the clip end, rounds velocities, merges exact
 * duplicates (keeping the louder hit) and sorts notes by time then pitch.
 */
export function clip(name: string, bars: number, ...parts: readonly (readonly NoteData[])[]): ClipDef {
  if (!Number.isInteger(bars) || bars < 1 || bars > 4) throw new Error(`Starter DSL: clip "${name}" must be 1 to 4 bars.`);
  const length = bars * TICKS_PER_BAR;
  const byKey = new Map<string, NoteData>();
  for (const n of parts.flat()) {
    if (!(n.tick >= 0 && n.tick < length)) throw new Error(`Starter DSL: clip "${name}" has a note at tick ${n.tick}, outside its ${bars} bar(s).`);
    if (!(n.duration > 0)) throw new Error(`Starter DSL: clip "${name}" has a note without length.`);
    const note: NoteData = {
      tick: n.tick,
      pitch: n.pitch,
      velocity: round3(Math.min(1, Math.max(0.05, n.velocity))),
      duration: Math.max(1, Math.round(Math.min(n.duration, length - n.tick))),
    };
    const key = `${note.tick}:${note.pitch}`;
    const prev = byKey.get(key);
    if (!prev || prev.velocity < note.velocity) byKey.set(key, note);
  }
  const notes = [...byKey.values()].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  return Object.freeze({ name, bars: bars as ClipBars, notes: Object.freeze(notes.map((n) => Object.freeze(n))) });
}

/* ------------------------------------------------------------------ */
/* Project mutation helpers (use on a freshly built project)           */
/* ------------------------------------------------------------------ */

function trackById(project: Project, trackId: Id) {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Starter DSL: no track "${trackId}".`);
  return track;
}

/** Assign a kit, synth preset or built-in sample by id, through the preset functions. */
export function assignSound(project: Project, trackId: Id, soundId: string): void {
  if (KITS.some((k) => k.id === soundId)) applyKitToProject(project, trackId, soundId);
  else if (SYNTH_PRESETS.some((p) => p.id === soundId)) applyPresetToProject(project, trackId, soundId);
  else if (BUILTIN_SAMPLES.some((s) => s.id === soundId)) applySamplerToProject(project, trackId, soundId);
  else throw new Error(`Starter DSL: unknown sound "${soundId}".`);
}

/** Set (clamped) params on a patch module, e.g. setModuleParams(p, 'fx:reverb', { decay: 3 }). */
export function setModuleParams(project: Project, id: Id, params: ParamValues): void {
  const mod = project.patch.modules.find((m) => m.id === id);
  if (!mod) throw new Error(`Starter DSL: no module "${id}".`);
  const specs = MODULE_PARAMS[mod.type];
  for (const [key, value] of Object.entries(params)) {
    const spec = specById(specs, key);
    if (!spec) throw new Error(`Starter DSL: module "${id}" has no param "${key}".`);
    mod.params[key] = clampParam(spec, value);
  }
}

/** Channel fader (dB) and pan for a track. */
export function setChannel(project: Project, trackId: Id, v: { level?: number; pan?: number }): void {
  const params: ParamValues = {};
  if (v.level !== undefined) params.level = v.level;
  if (v.pan !== undefined) params.pan = v.pan;
  setModuleParams(project, moduleId.channel(trackId), params);
}

/** Macro positions (0..1) for a track; unspecified macros keep their current value. */
export function setMacros(project: Project, trackId: Id, macros: Partial<MacroValues>): void {
  const track = trackById(project, trackId);
  for (const id of MACRO_IDS) {
    const v = macros[id];
    if (v !== undefined) track.macros[id] = Math.min(1, Math.max(0, v));
  }
}

/** Override instrument params (clamped through the instrument's registry). */
export function setInstrumentParams(project: Project, trackId: Id, params: ParamValues): void {
  const track = trackById(project, trackId);
  const specs = INSTRUMENT_PARAMS[track.instrument.kind];
  for (const [key, value] of Object.entries(params)) {
    const spec = specById(specs, key);
    if (!spec) throw new Error(`Starter DSL: ${track.instrument.kind} instrument has no param "${key}".`);
    track.instrument.params[key] = clampParam(spec, value);
  }
}

/** Per-voice drum adjustments keyed by slot index (use DRUM.x or HAND.x). */
export type DrumVoiceTweaks = Partial<Record<number, Partial<DrumVoiceSettings>>>;

/** Adjust individual drum voices (level, tune, decay, pan) of a drum track. */
export function setDrumVoices(project: Project, trackId: Id, voices: DrumVoiceTweaks): void {
  const track = trackById(project, trackId);
  if (track.instrument.kind !== 'drums') throw new Error(`Starter DSL: track "${trackId}" is not a drum track.`);
  for (const key of Object.keys(voices)) {
    const slot = Number(key);
    const settings = voices[slot];
    const voice = track.instrument.voices[slot];
    if (!Number.isInteger(slot) || !voice) throw new Error(`Starter DSL: no drum voice ${key}.`);
    if (!settings) continue;
    for (const field of ['tune', 'decay', 'level', 'pan'] as const) {
      const v = settings[field];
      if (v !== undefined) voice[field] = clampParam(DRUM_VOICE_PARAM_SPECS[field], v);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Starter builder                                                     */
/* ------------------------------------------------------------------ */

export interface PartDef {
  /** Kit id, synth preset id or built-in sample id from src/content/catalog.ts. */
  sound: string;
  /** Track name (defaults to the role label). */
  name?: string;
  /**
   * Channel fader in dB. The shipped starters set these (and drum kit trims)
   * from offline renders: each part's K-weighted momentary loudness measured
   * against the drums. Re-measure if kit or preset output levels change.
   */
  level: number;
  pan?: number;
  macros?: Partial<MacroValues>;
  /** Instrument param overrides applied after the sound. */
  instrument?: ParamValues;
  /** Per-voice drum tweaks keyed by slot index, e.g. { [HAND.lowConga]: { tune: 1 } }. */
  drumVoices?: DrumVoiceTweaks;
  /** Per-track module params applied after the sound (e.g. LFO rate for Motion). */
  lfo?: ParamValues;
  filter?: ParamValues;
  drive?: ParamValues;
  /** Channel params other than level/pan (e.g. pumpDiv). */
  channel?: ParamValues;
  arp?: Partial<ArpSettings>;
  /** Clip per scene row (row index == scene index); missing entries are empty slots. */
  clips: readonly (ClipDef | null)[];
}

export interface StarterSpec {
  id: string;
  /** Display name, e.g. 'House'. The project is named '<name> Starter'. */
  name: string;
  description: string;
  bpm: number;
  swing?: number;
  /** Pitch class 0..11. */
  root: number;
  scale: ScaleId;
  masterVolumeDb?: number;
  scenes: readonly [string, string, string, string];
  parts: Record<TrackRole, PartDef>;
  reverb?: ParamValues;
  delay?: ParamValues;
  /** Song order as [sceneRow, repeats]. */
  arrangement: readonly (readonly [row: number, repeats: number])[];
  tailSeconds: number;
}

/**
 * Every starter's mix is balanced against the others by its master volume;
 * this trim then lifts all of them together so the grooves play at a healthy
 * level (about -20 dBFS RMS) with the limiter barely touching the peaks.
 */
export const STARTER_OUTPUT_TRIM_DB = 4;
const MASTER_MAX_DB = 6;

/** Deterministic, per-starter project seed so Variation results reproduce. */
export function starterSeed(id: string): number {
  return hashString(`starter:${id}`) & 0x7fffffff;
}

/** Build a complete project from a starter spec. Every call returns fresh ids and objects. */
export function buildStarter(spec: StarterSpec): Project {
  const project = createProject({ name: `${spec.name} Starter`, bpm: spec.bpm });
  project.starterId = spec.id;
  project.seed = starterSeed(spec.id);
  project.swing = spec.swing ?? 0;
  project.root = spec.root;
  project.scale = spec.scale;
  const master = (spec.masterVolumeDb ?? project.masterVolumeDb) + STARTER_OUTPUT_TRIM_DB;
  project.masterVolumeDb = Math.min(MASTER_MAX_DB, master);
  // Whatever the master cannot take goes onto every channel equally, keeping the balance.
  const channelLift = Math.max(0, master - MASTER_MAX_DB);
  spec.scenes.forEach((name, i) => {
    project.scenes[i].name = name;
  });

  for (const track of project.tracks) {
    const part = spec.parts[track.role];
    const id = track.id;
    // Sound first: presets may write their own macro maps, suggested macros and module defaults.
    assignSound(project, id, part.sound);
    const t = trackById(project, id);
    if (part.name) t.name = part.name;
    if (part.instrument) setInstrumentParams(project, id, part.instrument);
    if (part.drumVoices) setDrumVoices(project, id, part.drumVoices);
    if (part.lfo) setModuleParams(project, moduleId.lfo(id), part.lfo);
    if (part.filter) setModuleParams(project, moduleId.filter(id), part.filter);
    if (part.drive) setModuleParams(project, moduleId.drive(id), part.drive);
    if (part.channel) setModuleParams(project, moduleId.channel(id), part.channel);
    setChannel(project, id, { level: part.level + channelLift, pan: part.pan ?? 0 });
    if (part.macros) setMacros(project, id, part.macros);
    if (part.arp) t.arp = { ...t.arp, ...part.arp };
    if (part.clips.length > SCENE_ROWS) throw new Error(`Starter DSL: ${spec.id} ${track.role} has more than ${SCENE_ROWS} clips.`);
    t.clips = Array.from({ length: SCENE_ROWS }, (_, row) => {
      const def = part.clips[row];
      if (!def) return null;
      if (t.instrument.kind === 'drums' && def.notes.some((n) => n.pitch < 0 || n.pitch >= DRUM_VOICES)) {
        throw new Error(`Starter DSL: ${spec.id} clip "${def.name}" uses a drum voice outside 0..${DRUM_VOICES - 1}.`);
      }
      return createClip(def.name, def.bars, def.notes.map((n) => ({ ...n })));
    });
  }

  if (spec.reverb) setModuleParams(project, REVERB_ID, spec.reverb);
  if (spec.delay) setModuleParams(project, DELAY_ID, spec.delay);

  project.arrangement = {
    blocks: spec.arrangement.map(([row, repeats]) => {
      const scene = project.scenes[row];
      if (!scene) throw new Error(`Starter DSL: ${spec.id} arrangement refers to scene row ${row}.`);
      return { id: uid('blk'), sceneId: scene.id, repeats };
    }),
    tailSeconds: spec.tailSeconds,
  };
  return project;
}

/** Wrap a spec as a StarterDef for the starter list. */
export function defineStarter(spec: StarterSpec): StarterDef {
  return {
    id: spec.id,
    name: spec.name,
    bpm: spec.bpm,
    key: keyLabel(spec.root, spec.scale),
    description: spec.description,
    build: () => buildStarter(spec),
  };
}
