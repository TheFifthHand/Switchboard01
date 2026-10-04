/**
 * Serializable, versioned project data (architecture layer 1).
 *
 * Everything in this file is plain JSON-compatible data. No audio nodes, DOM
 * objects, class instances, functions or Maps may appear in a Project.
 * Every entity that the user can address (track, clip, note, scene, module,
 * connection, region, section, performance, sample) has a stable string id.
 */

export const PROJECT_SCHEMA = 'switchboard01.project' as const;
export const PROJECT_VERSION = 4 as const;

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
/** Fewest and most scenes (clip rows) a project can have (schema v3). Every part has one clip slot per scene. */
export const MIN_SCENES = 1;
export const MAX_SCENES = 8;
/** Scenes a new project starts with. */
export const DEFAULT_SCENE_ROWS = 4;
/**
 * @deprecated The scene count is per project now: use `sceneCount(project)`
 * (or `project.scenes.length`), MAX_SCENES for bounds, DEFAULT_SCENE_ROWS for
 * new projects. Kept so older view code compiles until it reads the count.
 */
export const SCENE_ROWS = DEFAULT_SCENE_ROWS;
export const DRUM_VOICES = 16;

/** Clip length in bars (schema v3: up to 8). */
export type ClipBars = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** Longest clip, in bars. */
export const MAX_CLIP_BARS = 8;
/** The lengths offered when a clip is made or its length is picked. */
export const CLIP_BAR_CHOICES: readonly ClipBars[] = [1, 2, 3, 4, 8];

/** How many scenes (clip rows) a project has. */
export function sceneCount(p: { readonly scenes: readonly unknown[] }): number {
  return p.scenes.length;
}

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

/**
 * The recording a sampler clip plays itself (schema v3), instead of its
 * part's recording: a take or an import placed in its own clip. `start` and
 * `end` are fractions of the file (0 <= start < end <= 1); `rootNote` is the
 * key that plays it at its own pitch. Only sampler parts use it; on other
 * parts it is kept (switching back to a sampler plays it again) but ignored.
 * The part's other sampler settings (mode, pitch, tempo sync, fades, level)
 * still apply.
 */
export interface ClipSample {
  /** Project.samples[].id, or a built-in sample id beginning with "builtin:". */
  id: Id;
  start: number;
  end: number;
  rootNote: number;
}

export interface Clip {
  id: Id;
  name: string;
  bars: ClipBars;
  notes: Note[];
  variation?: VariationInfo;
  /** Sampler parts: the clip's own recording (see ClipSample). Absent: it plays the part's recording. */
  sample?: ClipSample;
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
  /** One entry per scene (project.scenes.length); null = empty slot. Row index == scene index. */
  clips: (Clip | null)[];
  mute: boolean;
  solo: boolean;
  /** Locked parts are never modified by Variation. */
  locked: boolean;
  arp: ArpSettings;
  macros: MacroValues;
  macroMap: MacroMap;
  /**
   * The macro positions the part's sound or starter was designed with (schema
   * v3): where double-click or Delete on a big knob returns it. Written when a
   * synth preset is chosen and by the starter builder; a macro not listed
   * returns to its default (see macroHomeFor).
   */
  macroHome?: Partial<Record<MacroId, number>>;
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
  | 'eq'
  | 'compressor'
  | 'gate'
  | 'autopan'
  | 'widener'
  | 'flanger'
  | 'tape'
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

/** Longest song, in bars: every loop and section on the song timeline ends by here. */
export const MAX_SONG_BARS = 512;
/** Longest section name, in characters. */
export const MAX_SECTION_NAME = 40;

/** The song moves a section can carry. */
export const SONG_MOVE_KINDS = ['fadeIn', 'fadeOut', 'filterRise', 'echoThrow'] as const;
export type SongMoveKind = (typeof SONG_MOVE_KINDS)[number];

/**
 * A change of sound over one song section, played from the audio clock and
 * rendered identically by exports. A section holds at most one move of each
 * kind. What playback does:
 * - fadeIn: the song's gain (after the master volume, before mastering) rises
 *   from 0 to 1 across the whole section.
 * - fadeOut: the song's gain falls from 1 to 0 across the whole section.
 * - filterRise: the Tone big knob of each part it applies to rises from 0.15
 *   to that part's own Tone value across the section, and is back at the
 *   part's own value when the section ends.
 * - echoThrow: the Echo big knob of each part it applies to goes to 0.85 over
 *   the section's last beat and returns to the part's own value one bar later.
 * `parts` lists the parts filterRise and echoThrow act on; without it they act
 * on every melodic part (bass, chords, lead, pad, texture and sampler roles).
 * Fades act on the whole song and never carry `parts`.
 */
export interface SongMove {
  id: Id;
  kind: SongMoveKind;
  parts?: Id[];
}

/**
 * One loop placed on a part's row of the song (schema v4), like a region in
 * GarageBand: it plays one of the part's clips from bar `start` for `bars`
 * bars, the clip repeating to fill it, beginning `offset` bars into the clip
 * (a region trimmed at its left edge starts later in its clip). Regions on
 * one part never overlap. Positions are whole bars.
 */
export interface SongRegion {
  id: Id;
  trackId: Id;
  /** The clip it plays: one of its track's clips (Track.clips[i].id). */
  clipId: Id;
  /** First bar on the song timeline (0-based integer). */
  start: number;
  /** Length in bars (integer ≥ 1); start + bars ≤ MAX_SONG_BARS. */
  bars: number;
  /** Bars into the clip where the region begins: integer, 0 ≤ offset < the clip's bars. */
  offset: number;
}

/**
 * A named stretch of the song timeline (Intro, Verse, Drop …) shown above
 * the rows. A section is a label with optional song moves: it does not own
 * regions, and sections never overlap. Moving or copying "a section" moves
 * or copies the regions that start inside it (see project/arrangement.ts).
 */
export interface SongSection {
  id: Id;
  name: string;
  /** First bar (0-based integer). */
  start: number;
  /** Length in bars (integer ≥ 1). */
  bars: number;
  /** Song moves over this section (at most one per kind). */
  moves?: SongMove[];
}

/** The song: what each part plays where (regions), named sections, and the export tail. */
export interface Arrangement {
  regions: SongRegion[];
  sections: SongSection[];
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
  /** Mastering chain on the master bus (schema v2). Neutral settings leave the sound unchanged. */
  mastering: Mastering;
}

/**
 * Mastering on the master bus, after the master volume and before the
 * protected output limiter (ceiling −1 dBFS): low cut, three-band EQ, glue
 * compressor, saturation, stereo width with mono bass, and a loudness drive
 * into the limiter. Values follow MASTERING_PARAMS in params.ts.
 */
export interface Mastering {
  /** Off = the chain is bypassed (crossfaded). */
  enabled: boolean;
  params: ParamValues;
  /** Preset the values came from, if unchanged since ("clean", "warm" …). */
  presetId?: string;
}
