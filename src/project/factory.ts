/**
 * Factories for well-formed project data. Every project always has exactly
 * MAX_TRACKS (8) tracks and SCENE_ROWS (4) scenes, and a complete default
 * patch so a fresh project is never silent because of routing.
 */
import {
  DRUM_VOICES,
  MACRO_IDS,
  MAX_TRACKS,
  PROJECT_SCHEMA,
  PROJECT_VERSION,
  SCENE_ROWS,
  type ArpSettings,
  type Clip,
  type ClipBars,
  type Connection,
  type DrumVoiceSettings,
  type Id,
  type Instrument,
  type InstrumentKind,
  type MacroMap,
  type MacroValues,
  type ModuleType,
  type Note,
  type Patch,
  type Mastering,
  type PatchModule,
  type Project,
  type Scene,
  type Track,
  type TrackRole,
} from './types';
import { INSTRUMENT_PARAMS, MODULE_PARAMS, defaultParams, neutralMasteringParams } from './params';

/* ------------------------------------------------------------------ */
/* Ids                                                                 */
/* ------------------------------------------------------------------ */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random, collision-resistant short id with a readable prefix. */
export function uid(prefix: string): Id {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

/* ------------------------------------------------------------------ */
/* Track layout                                                        */
/* ------------------------------------------------------------------ */

export const TRACK_IDS: readonly Id[] = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];

export const DEFAULT_ROLES: readonly TrackRole[] = ['drums', 'percussion', 'bass', 'chords', 'lead', 'pad', 'texture', 'sampler'];

export const ROLE_LABELS: Record<TrackRole, string> = {
  drums: 'Drums',
  percussion: 'Percussion',
  bass: 'Bass',
  chords: 'Chords',
  lead: 'Lead',
  pad: 'Pad',
  texture: 'Texture',
  sampler: 'Sampler',
};

export const ROLE_INSTRUMENT: Record<TrackRole, InstrumentKind> = {
  drums: 'drums',
  percussion: 'drums',
  bass: 'bass',
  chords: 'poly',
  lead: 'poly',
  pad: 'poly',
  texture: 'poly',
  sampler: 'sampler',
};

/** Default sound for each role (ids from src/content/catalog.ts). */
export const ROLE_DEFAULT_SOUND: Record<TrackRole, string> = {
  drums: 'round-machine',
  percussion: 'hand-percussion',
  bass: 'bass-round-sub',
  chords: 'poly-glass-keys',
  lead: 'poly-neon-lead',
  pad: 'poly-halo-pad',
  texture: 'poly-air-grain',
  sampler: 'builtin:glass-chord',
};

export const DEFAULT_SCENE_NAMES = ['Intro', 'Groove', 'Lift', 'Break'] as const;

/* ------------------------------------------------------------------ */
/* Module ids                                                          */
/* ------------------------------------------------------------------ */

export const MASTER_ID = 'master';
export const REVERB_ID = 'fx:reverb';
export const DELAY_ID = 'fx:delay';

export const moduleId = {
  inst: (trackId: Id) => `${trackId}:inst`,
  drive: (trackId: Id) => `${trackId}:drive`,
  filter: (trackId: Id) => `${trackId}:filter`,
  lfo: (trackId: Id) => `${trackId}:lfo`,
  channel: (trackId: Id) => `${trackId}:ch`,
};

/* ------------------------------------------------------------------ */
/* Instruments                                                         */
/* ------------------------------------------------------------------ */

export function defaultDrumVoices(): DrumVoiceSettings[] {
  return Array.from({ length: DRUM_VOICES }, () => ({ tune: 0, decay: 1, level: 1, pan: 0 }));
}

/** An instrument with registry-default parameters. Apply a preset afterwards for designed sounds. */
export function createInstrument(kind: InstrumentKind, soundId?: string): Instrument {
  const params = defaultParams(INSTRUMENT_PARAMS[kind]);
  switch (kind) {
    case 'drums':
      return { kind, kitId: soundId ?? 'round-machine', params, voices: defaultDrumVoices() };
    case 'bass':
      return { kind, presetId: soundId ?? 'bass-round-sub', params };
    case 'poly':
      return { kind, presetId: soundId ?? 'poly-glass-keys', params };
    case 'sampler':
      return { kind, sampleId: soundId ?? null, params };
  }
}

export function defaultArp(): ArpSettings {
  return { enabled: false, division: '1/16', mode: 'up', octaves: 1, latch: false, gate: 0.6 };
}

export function defaultMacros(): MacroValues {
  return { tone: 0.5, space: 0.15, echo: 0, motion: 0, drive: 0, pump: 0 };
}

/**
 * Default macro mappings. Tone is neutral at 0.5: turning down closes the
 * part's low-pass filter, turning up opens a high-shelf for extra sparkle.
 */
export function defaultMacroMap(trackId: Id): MacroMap {
  const f = moduleId.filter(trackId);
  const ch = moduleId.channel(trackId);
  return {
    tone: [
      { module: f, param: 'cutoff', min: 260, max: 20000, curve: 'exp', macroFrom: 0, macroTo: 0.5 },
      { module: f, param: 'bright', min: 0, max: 9, curve: 'lin', macroFrom: 0.5, macroTo: 1 },
    ],
    space: [{ module: ch, param: 'sendA', min: 0, max: 0.85, curve: 'lin' }],
    echo: [{ module: ch, param: 'sendB', min: 0, max: 0.7, curve: 'lin' }],
    motion: [{ module: moduleId.lfo(trackId), param: 'depth', min: 0, max: 0.8, curve: 'lin' }],
    drive: [{ module: moduleId.drive(trackId), param: 'amount', min: 0, max: 1, curve: 'lin' }],
    pump: [{ module: ch, param: 'pump', min: 0, max: 0.9, curve: 'lin' }],
  };
}

export function emptyClipSlots(): (Clip | null)[] {
  return Array.from({ length: SCENE_ROWS }, () => null);
}

export function createTrack(id: Id, role: TrackRole, name?: string, soundId?: string): Track {
  const kind = ROLE_INSTRUMENT[role];
  return {
    id,
    name: name ?? ROLE_LABELS[role],
    role,
    instrument: createInstrument(kind, soundId ?? ROLE_DEFAULT_SOUND[role]),
    clips: emptyClipSlots(),
    mute: false,
    solo: false,
    locked: false,
    arp: defaultArp(),
    macros: defaultMacros(),
    macroMap: defaultMacroMap(id),
  };
}

export function createClip(name: string, bars: ClipBars, notes: Omit<Note, 'id'>[] = []): Clip {
  return { id: uid('clip'), name, bars, notes: notes.map((n) => ({ ...n, id: uid('n') })) };
}

export function createNote(n: Omit<Note, 'id'>): Note {
  return { ...n, id: uid('n') };
}

/* ------------------------------------------------------------------ */
/* Patch                                                               */
/* ------------------------------------------------------------------ */

export function createModule(id: Id, type: ModuleType, trackId?: Id, params?: Record<string, number>): PatchModule {
  return { id, type, trackId, params: { ...defaultParams(MODULE_PARAMS[type]), ...(params ?? {}) }, bypass: false };
}

export function connectionId(): Id {
  return uid('c');
}

export function conn(fromModule: Id, fromPort: string, toModule: Id, toPort: string, amount?: number): Connection {
  const c: Connection = { id: connectionId(), from: { module: fromModule, port: fromPort }, to: { module: toModule, port: toPort } };
  if (amount !== undefined) c.amount = amount;
  return c;
}

/** Modules + connections that make up one track's default signal path. */
export function defaultTrackPatch(trackId: Id): Patch {
  const inst = moduleId.inst(trackId);
  const drive = moduleId.drive(trackId);
  const filter = moduleId.filter(trackId);
  const lfo = moduleId.lfo(trackId);
  const ch = moduleId.channel(trackId);
  return {
    modules: [
      createModule(inst, 'instrument', trackId),
      createModule(drive, 'drive', trackId),
      createModule(filter, 'filter', trackId),
      createModule(lfo, 'lfo', trackId),
      createModule(ch, 'channel', trackId),
    ],
    connections: [
      conn(inst, 'out', drive, 'in'),
      conn(drive, 'out', filter, 'in'),
      conn(filter, 'out', ch, 'in'),
      conn(ch, 'out', MASTER_ID, 'in'),
      conn(ch, 'sendA', REVERB_ID, 'in'),
      conn(ch, 'sendB', DELAY_ID, 'in'),
      conn(lfo, 'out', filter, 'cutoff', 1),
    ],
  };
}

export function defaultSharedModules(): PatchModule[] {
  return [createModule(REVERB_ID, 'reverb'), createModule(DELAY_ID, 'delay'), createModule(MASTER_ID, 'master')];
}

export function defaultSharedConnections(): Connection[] {
  return [conn(REVERB_ID, 'out', MASTER_ID, 'in'), conn(DELAY_ID, 'out', MASTER_ID, 'in')];
}

/** The complete default patch for a set of tracks. */
export function defaultPatch(trackIds: readonly Id[]): Patch {
  const modules: PatchModule[] = [];
  const connections: Connection[] = [];
  for (const id of trackIds) {
    const p = defaultTrackPatch(id);
    modules.push(...p.modules);
    connections.push(...p.connections);
  }
  modules.push(...defaultSharedModules());
  connections.push(...defaultSharedConnections());
  return { modules, connections };
}

/* ------------------------------------------------------------------ */
/* Project                                                             */
/* ------------------------------------------------------------------ */

export function createScenes(names: readonly string[] = DEFAULT_SCENE_NAMES): Scene[] {
  return Array.from({ length: SCENE_ROWS }, (_, i) => ({ id: uid('scene'), name: names[i] ?? `Scene ${i + 1}` }));
}

export function createProject(opts: { name?: string; bpm?: number; roles?: readonly TrackRole[]; now?: number } = {}): Project {
  const now = opts.now ?? Date.now();
  const roles = opts.roles ?? DEFAULT_ROLES;
  const tracks = TRACK_IDS.slice(0, MAX_TRACKS).map((id, i) => createTrack(id, roles[i] ?? DEFAULT_ROLES[i]));
  const scenes = createScenes();
  return {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    id: uid('proj'),
    name: opts.name ?? 'Untitled',
    createdAt: now,
    updatedAt: now,
    bpm: opts.bpm ?? 120,
    swing: 0,
    root: 0,
    scale: 'minor',
    assist: true,
    masterVolumeDb: -3,
    tracks,
    scenes,
    patch: defaultPatch(tracks.map((t) => t.id)),
    arrangement: {
      blocks: scenes.map((s) => ({ id: uid('blk'), sceneId: s.id, repeats: 2 })),
      tailSeconds: 3,
    },
    performances: [],
    samples: [],
    seed: Math.floor(Math.random() * 2 ** 31),
    settings: { metronome: false, countIn: false, recordQuantize: '1/16' },
    mastering: defaultMastering(),
  };
}

/** Mastering for a new project: on, with neutral settings (sounds exactly like no mastering). */
export function defaultMastering(): Mastering {
  return { enabled: true, params: neutralMasteringParams(), presetId: 'clean' };
}

export const ALL_MACROS = MACRO_IDS;
