/**
 * Serializable, versioned project data (architecture layer 1).
 *
 * Everything in this file is plain JSON-compatible data. No audio nodes, DOM
 * objects, class instances, functions or Maps may appear in a Project.
 * Every entity that the user can address (track, clip, note, scene, module,
 * connection, block, performance, sample) has a stable string id.
 */

export const PROJECT_SCHEMA = 'switchboard01.project' as const;
export const PROJECT_VERSION = 1 as const;

export type Id = string;

/* ------------------------------------------------------------------ */
/* Musical time                                                        */
/* ------------------------------------------------------------------ */

/** Ticks per quarter note. All musical positions are expressed in ticks. */
export const PPQ = 96;
/** One 16th-note step. */
export const TICKS_PER_STEP = 24;
export const STEPS_PER_BAR = 16;
/** 4/4 only in version one. */
export const BEATS_PER_BAR = 4;
export const TICKS_PER_BEAT = PPQ;
export const TICKS_PER_BAR = PPQ * BEATS_PER_BAR; // 384

export const MIN_BPM = 40;
export const MAX_BPM = 220;
export const MAX_TRACKS = 8;
/** Clip rows == scenes. */
export const SCENE_ROWS = 4;
export const DRUM_VOICES = 16;

export type ClipBars = 1 | 2 | 3 | 4;

/* ------------------------------------------------------------------ */
/* Notes & clips                                                       */
/* ------------------------------------------------------------------ */

export interface Note {
  id: Id;
  /** Start position within the clip in ticks, 0 <= tick < clip length. May be fractional for unquantized recordings. */
  tick: number;
  /** MIDI note number for melodic instruments; drum voice index 0..15 for drum kits. */
  pitch: number;
  /** 0..1 */
  velocity: number;
  /** Length in ticks (> 0). Drums ignore it except for choke/gate-aware voices. */
  duration: number;
}

export interface VariationInfo {
  /** Seed used for the most recent Variation of this clip. */
  seed: number;
  /** How many times Variation has been applied since the clip was authored. */
  generation: number;
}

export interface Clip {
  id: Id;
  name: string;
  bars: ClipBars;
  notes: Note[];
  variation?: VariationInfo;
}

/* ------------------------------------------------------------------ */
/* Instruments                                                         */
/* ------------------------------------------------------------------ */

export type TrackRole = 'drums' | 'percussion' | 'bass' | 'chords' | 'lead' | 'pad' | 'texture' | 'sampler';
export type InstrumentKind = 'drums' | 'bass' | 'poly' | 'sampler';

/**
 * All instrument/module parameters are stored as flat numeric maps. Enum
 * parameters store the option index. Ranges, defaults, units and curves live
 * in the parameter registry (src/project/params.ts), which is the single
 * source of truth for clamping, knob display and macro mapping.
 */
export type ParamValues = Record<string, number>;

export interface DrumVoiceSettings {
  /** semitones, -12..12 */
  tune: number;
  /** decay multiplier, 0.25..2 */
  decay: number;
  /** linear gain 0..1.5 */
  level: number;
  /** -1..1 */
  pan: number;
}

export interface DrumsInstrument {
  kind: 'drums';
  kitId: string;
  /** Kit-wide parameters (see params.ts DRUM_KIT_PARAMS). */
  params: ParamValues;
  /** Exactly DRUM_VOICES entries. */
  voices: DrumVoiceSettings[];
}

export interface BassInstrument {
  kind: 'bass';
  presetId: string;
  params: ParamValues;
}

export interface PolyInstrument {
  kind: 'poly';
  presetId: string;
  params: ParamValues;
}

export interface SamplerInstrument {
  kind: 'sampler';
  /** References Project.samples[].id, or a built-in sample id beginning with "builtin:". */
  sampleId: Id | null;
  params: ParamValues;
}

export type Instrument = DrumsInstrument | BassInstrument | PolyInstrument | SamplerInstrument;

/* ------------------------------------------------------------------ */
/* Arpeggiator                                                         */
/* ------------------------------------------------------------------ */

export type ArpDivision = '1/4' | '1/8' | '1/8T' | '1/16' | '1/16T' | '1/32';
export type ArpMode = 'up' | 'down' | 'updown' | 'played';

export interface ArpSettings {
  enabled: boolean;
  division: ArpDivision;
  mode: ArpMode;
  octaves: 1 | 2 | 3;
  latch: boolean;
  /** Fraction of the division each arp note sounds, 0.1..1. */
  gate: number;
}

/* ------------------------------------------------------------------ */
/* Macros                                                              */
/* ------------------------------------------------------------------ */

export const MACRO_IDS = ['tone', 'space', 'echo', 'motion', 'drive', 'pump'] as const;
export type MacroId = (typeof MACRO_IDS)[number];
export type MacroValues = Record<MacroId, number>;

/**
 * One macro can move several underlying parameters. For macro value m in
 * [macroFrom, macroTo] the target moves from `min` to `max` (clamped outside
 * that sub-range) following `curve`. 'exp' interpolates geometrically and
 * requires min and max > 0 (used for frequencies).
 */
export interface MacroTarget {
  /** Patch module id, e.g. "t3:filter" or "t3:inst" for the instrument itself. */
  module: Id;
  param: string;
  min: number;
  max: number;
  curve: 'lin' | 'exp';
  macroFrom?: number;
  macroTo?: number;
}
export type MacroMap = Record<MacroId, MacroTarget[]>;

/* ------------------------------------------------------------------ */
/* Tracks & scenes                                                     */
/* ------------------------------------------------------------------ */

export interface Track {
  id: Id;
  name: string;
  role: TrackRole;
  instrument: Instrument;
  /** Exactly SCENE_ROWS entries; null = empty slot. Row index == scene index. */
  clips: (Clip | null)[];
  mute: boolean;
  solo: boolean;
  /** Locked parts are never modified by Variation. */
  locked: boolean;
  arp: ArpSettings;
  macros: MacroValues;
  macroMap: MacroMap;
}

/**
 * A scene is a clip row. Launching scene i launches clip slot i on every
 * track; tracks whose slot i is empty are stopped. This makes a scene a
 * complete, predictable set of clip selections and stopped parts.
 */
export interface Scene {
  id: Id;
  name: string;
}

/* ------------------------------------------------------------------ */
/* Patch (routing) — the effects rack and cable panel both edit this   */
/* ------------------------------------------------------------------ */

export type ModuleType =
  | 'instrument'
  | 'channel'
  | 'filter'
  | 'drive'
  | 'delay'
  | 'reverb'
  | 'chorus'
  | 'phaser'
  | 'crusher'
  | 'lfo'
  | 'master';

export type PortKind = 'audio' | 'mod';

export interface PatchModule {
  /** Stable id. Per-track modules use "<trackId>:<slot>", e.g. "t1:filter". Shared: "fx:reverb", "fx:delay", "master". */
  id: Id;
  type: ModuleType;
  /** Owning track for per-track modules; undefined for shared modules. */
  trackId?: Id;
  /** Optional user label. */
  label?: string;
  params: ParamValues;
  bypass: boolean;
}

export interface PortRef {
  module: Id;
  port: string;
}

export interface Connection {
  id: Id;
  from: PortRef;
  to: PortRef;
  /** Modulation connections only: attenuation -1..1 (default 1). */
  amount?: number;
}

export interface Patch {
  modules: PatchModule[];
  connections: Connection[];
}

/* ------------------------------------------------------------------ */
/* Arrangement & performances                                          */
/* ------------------------------------------------------------------ */

export interface ArrangementBlock {
  id: Id;
  sceneId: Id;
  /** 1..8 */
  repeats: number;
}

export interface Arrangement {
  blocks: ArrangementBlock[];
  /** Seconds of effect tail appended to exports. */
  tailSeconds: number;
}

/**
 * Performance events are timestamped in absolute transport ticks (fractional
 * allowed). A take starts at `startTick` with the launcher state captured in
 * the snapshot, so replay reproduces it exactly.
 */
export type PerformanceEvent =
  | { t: number; type: 'launch'; trackId: Id; slot: number | null; atTick: number }
  | { t: number; type: 'scene'; row: number; atTick: number }
  | { t: number; type: 'stopAll'; atTick: number }
  | { t: number; type: 'noteOn'; trackId: Id; pitch: number; velocity: number; key: string }
  | { t: number; type: 'noteOff'; trackId: Id; pitch: number; key: string }
  | { t: number; type: 'macro'; trackId: Id; macro: MacroId; value: number }
  | { t: number; type: 'param'; module: Id; param: string; value: number }
  | { t: number; type: 'mute'; trackId: Id; mute: boolean }
  | { t: number; type: 'tempo'; bpm: number }
  | { t: number; type: 'swing'; swing: number }
  | { t: number; type: 'master'; volumeDb: number };

export interface LauncherSnapshotEntry {
  trackId: Id;
  /** Playing slot and the tick its loop started at, or null when stopped. */
  playing: { slot: number; startTick: number } | null;
}

/** The musical state a take needs in order to replay faithfully. */
export interface PerformanceSnapshot {
  bpm: number;
  swing: number;
  root: number;
  scale: ScaleId;
  assist: boolean;
  masterVolumeDb: number;
  tracks: Track[];
  scenes: Scene[];
  patch: Patch;
  launcher: LauncherSnapshotEntry[];
  seed: number;
}

export interface Performance {
  id: Id;
  name: string;
  createdAt: number;
  startTick: number;
  endTick: number;
  snapshot: PerformanceSnapshot;
  events: PerformanceEvent[];
}

/* ------------------------------------------------------------------ */
/* Samples                                                             */
/* ------------------------------------------------------------------ */

export interface SampleMeta {
  id: Id;
  name: string;
  /** Original file MIME type, e.g. audio/wav, audio/mpeg. */
  mime: string;
  byteLength: number;
  duration: number;
  sampleRate: number;
  channels: number;
  /** Optional waveform overview (min/max pairs normalised to -1..1), for display only. */
  peaks?: number[];
}

/* ------------------------------------------------------------------ */
/* Project                                                             */
/* ------------------------------------------------------------------ */

export type ScaleId =
  | 'major'
  | 'minor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'harmonicMinor'
  | 'majorPentatonic'
  | 'minorPentatonic'
  | 'blues'
  | 'chromatic';

export type QuantizeGrid = 'off' | '1/4' | '1/8' | '1/16' | '1/32';

export interface ProjectSettings {
  metronome: boolean;
  countIn: boolean;
  /** Quantization applied by Record Notes. */
  recordQuantize: QuantizeGrid;
}

export interface Project {
  schema: typeof PROJECT_SCHEMA;
  version: number;
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Starter this project was created from, if any. */
  starterId?: string;
  bpm: number;
  /** 0..1 — 0 straight, 1 = full triplet shuffle of off-beat 16ths. */
  swing: number;
  /** Pitch class 0..11 (0 = C). */
  root: number;
  scale: ScaleId;
  /** Musical Assist: keep played notes in root/scale. */
  assist: boolean;
  masterVolumeDb: number;
  tracks: Track[];
  scenes: Scene[];
  patch: Patch;
  arrangement: Arrangement;
  performances: Performance[];
  samples: SampleMeta[];
  /** Project-level seed for deterministic generation. */
  seed: number;
  settings: ProjectSettings;
}
