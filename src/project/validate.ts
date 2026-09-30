/**
 * Project validation for everything that enters the app from outside the
 * store: saved projects, imported bundles, pasted clips and recorded takes.
 *
 * `validateProject` migrates first, then rebuilds a fresh Project field by
 * field, so the result never shares objects with the input and contains only
 * known fields. Structural problems (wrong track/scene/slot counts, missing
 * master, malformed tracks) are errors. Recoverable problems (out-of-range
 * values, dangling references, invalid notes or cables) are repaired and
 * reported as warnings. A valid project comes out deep-equal to what went in.
 *
 * It never throws: anything unexpected becomes an error result.
 */
import { BUILTIN_SAMPLES, KITS } from '../content/catalog';
import { DEFAULT_ROLES, MASTER_ID, ROLE_LABELS, defaultArp, defaultMacros, uid } from './factory';
import { validateConnection } from './graph';
import { migrateProject } from './migrate';
import { MODULE_DEFS, PATCH_LIMITS, portDef } from './modules';
import {
  BPM_SPEC,
  DRUM_VOICE_PARAM_SPECS,
  INSTRUMENT_PARAMS,
  MASTER_VOLUME_SPEC,
  MODULE_PARAMS,
  SWING_SPEC,
  clampParam,
  specById,
  type ParamSpec,
} from './params';
import {
  DRUM_VOICES,
  MACRO_IDS,
  MAX_TRACKS,
  PROJECT_SCHEMA,
  PROJECT_VERSION,
  SCENE_ROWS,
  TICKS_PER_BAR,
  type ArpDivision,
  type ArpMode,
  type ArpSettings,
  type Arrangement,
  type ArrangementBlock,
  type Clip,
  type ClipBars,
  type Connection,
  type DrumVoiceSettings,
  type Id,
  type Instrument,
  type InstrumentKind,
  type LauncherSnapshotEntry,
  type MacroId,
  type MacroMap,
  type MacroTarget,
  type MacroValues,
  type ModuleType,
  type Note,
  type ParamValues,
  type Patch,
  type PatchModule,
  type Performance,
  type PerformanceEvent,
  type PerformanceSnapshot,
  type Project,
  type ProjectSettings,
  type QuantizeGrid,
  type SampleMeta,
  type ScaleId,
  type Scene,
  type Track,
  type TrackRole,
  type VariationInfo,
} from './types';

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

export const VALIDATION_LIMITS = {
  maxNotesPerClip: 2048,
  maxPerformanceEvents: 200_000,
  maxPerformances: 64,
  maxBlocks: 128,
  maxSamples: 256,
  maxMacroTargets: 16,
  maxPeaks: 4096,
  maxSampleBytes: 256 * 1024 * 1024,
  maxSampleSeconds: 600,
  maxNameLength: 120,
  /** Longest note: four bars. */
  maxNoteTicks: TICKS_PER_BAR * 4,
  minNoteTicks: 1,
} as const;

export const SCALE_IDS: readonly ScaleId[] = [
  'major',
  'minor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'harmonicMinor',
  'majorPentatonic',
  'minorPentatonic',
  'blues',
  'chromatic',
];
export const QUANTIZE_GRIDS: readonly QuantizeGrid[] = ['off', '1/4', '1/8', '1/16', '1/32'];
export const ARP_DIVISIONS: readonly ArpDivision[] = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
export const ARP_MODES: readonly ArpMode[] = ['up', 'down', 'updown', 'played'];
const INSTRUMENT_KINDS: readonly InstrumentKind[] = ['drums', 'bass', 'poly', 'sampler'];
const MODULE_TYPES = Object.keys(MODULE_DEFS) as ModuleType[];

/** General ids (modules contain ':'). */
const ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
/** Track and sample ids are also used inside module ids and file names: no ':' or '.'. */
const SIMPLE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIME_RE = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/;

export type ValidateResult = { ok: true; project: Project; warnings: string[] } | { ok: false; errors: string[] };

/* ------------------------------------------------------------------ */
/* Issue collection                                                    */
/* ------------------------------------------------------------------ */

class Issues {
  readonly errors: string[] = [];
  private readonly counts = new Map<string, number>();

  error(msg: string): void {
    if (this.errors.length < 20 && !this.errors.includes(msg)) this.errors.push(msg);
  }
  /** Repeated identical warnings are merged with a count. */
  warn(msg: string): void {
    this.counts.set(msg, (this.counts.get(msg) ?? 0) + 1);
  }
  merge(other: Issues): void {
    for (const [m, n] of other.counts) this.counts.set(m, (this.counts.get(m) ?? 0) + n);
  }
  get failed(): boolean {
    return this.errors.length > 0;
  }
  warnings(): string[] {
    return [...this.counts].map(([m, n]) => (n > 1 ? `${m} (${n} times)` : m));
  }
}

/* ------------------------------------------------------------------ */
/* Primitive helpers                                                   */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}
function isSimpleId(v: unknown): v is string {
  return typeof v === 'string' && SIMPLE_ID_RE.test(v);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function has<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** Text field: trimmed to the length limit; non-strings fall back with a warning. */
function text(v: unknown, fallback: string, issues: Issues, what: string, max: number = VALIDATION_LIMITS.maxNameLength): string {
  if (typeof v !== 'string') {
    issues.warn(`Replaced a missing ${what}.`);
    return fallback;
  }
  if (v.length > max) {
    issues.warn(`Shortened a ${what} that was too long.`);
    return v.slice(0, max);
  }
  return v;
}

function bool(v: unknown, fallback: boolean, issues: Issues, what: string): boolean {
  if (typeof v === 'boolean') return v;
  issues.warn(`Reset an invalid ${what} setting.`);
  return fallback;
}

/** Number clamped through a registry spec, with a warning when repaired. */
function specNum(v: unknown, spec: ParamSpec, issues: Issues): number {
  if (!isNum(v)) {
    issues.warn(`Reset an invalid ${spec.label.toLowerCase()} value to its default.`);
    return spec.default;
  }
  const c = clampParam(spec, v);
  if (c !== v) issues.warn(`Adjusted an out-of-range ${spec.label.toLowerCase()} value.`);
  return c;
}

/** Validate a flat parameter map against registry specs: unknown params dropped, values clamped. */
function validateParams(raw: unknown, specs: readonly ParamSpec[], issues: Issues): ParamValues {
  const out: ParamValues = {};
  if (!isObj(raw)) {
    issues.warn('Reset a missing group of sound settings to defaults.');
    return out;
  }
  for (const key of Object.keys(raw)) {
    const spec = specById(specs, key);
    if (!spec) {
      issues.warn('Removed an unknown sound setting.');
      continue;
    }
    const v = raw[key];
    if (!isNum(v)) {
      issues.warn('Reset an invalid sound setting to its default.');
      out[key] = spec.default;
      continue;
    }
    const c = clampParam(spec, v);
    if (c !== v) issues.warn('Adjusted an out-of-range sound setting.');
    out[key] = c;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Samples                                                             */
/* ------------------------------------------------------------------ */

function validateSampleMeta(raw: unknown, issues: Issues): SampleMeta | null {
  const bad = (why: string): null => {
    issues.warn(`Removed an imported recording with ${why}.`);
    return null;
  };
  if (!isObj(raw)) return bad('damaged information');
  if (!isSimpleId(raw.id)) return bad('an invalid id');
  if (typeof raw.mime !== 'string' || !MIME_RE.test(raw.mime) || raw.mime.length > 100) return bad('an unknown file type');
  const byteLength = raw.byteLength;
  if (!isNum(byteLength) || byteLength < 0 || byteLength > VALIDATION_LIMITS.maxSampleBytes || !Number.isInteger(byteLength)) return bad('an invalid size');
  const duration = raw.duration;
  if (!isNum(duration) || duration < 0 || duration > VALIDATION_LIMITS.maxSampleSeconds) return bad('an invalid length');
  const sampleRate = raw.sampleRate;
  if (!isNum(sampleRate) || sampleRate < 3000 || sampleRate > 768000) return bad('an invalid sample rate');
  const channels = raw.channels;
  if (!isNum(channels) || !Number.isInteger(channels) || channels < 1 || channels > 32) return bad('an invalid channel count');
  const meta: SampleMeta = {
    id: raw.id,
    name: text(raw.name, 'Recording', issues, 'recording name'),
    mime: raw.mime,
    byteLength,
    duration,
    sampleRate,
    channels,
  };
  if (raw.peaks !== undefined) {
    const peaks = raw.peaks;
    if (Array.isArray(peaks) && peaks.length <= VALIDATION_LIMITS.maxPeaks && peaks.every(isNum)) {
      meta.peaks = peaks.map((p) => clamp(p, -1, 1));
      if (meta.peaks.some((p, i) => p !== peaks[i])) issues.warn('Adjusted an invalid waveform overview.');
    } else {
      issues.warn('Removed an invalid waveform overview (it is redrawn when the recording is used).');
    }
  }
  return meta;
}

/* ------------------------------------------------------------------ */
/* Notes & clips                                                       */
/* ------------------------------------------------------------------ */

function pitchRange(kind: InstrumentKind): [number, number] {
  return kind === 'drums' ? [0, DRUM_VOICES - 1] : [0, 127];
}

function validateNote(raw: unknown, clipTicks: number, kind: InstrumentKind, ids: Set<Id>, issues: Issues): Note | null {
  if (!isObj(raw)) {
    issues.warn('Removed a damaged note.');
    return null;
  }
  const { tick, pitch, velocity, duration } = raw;
  if (!isNum(tick) || tick < 0 || tick >= clipTicks) {
    issues.warn('Removed a note outside its clip.');
    return null;
  }
  if (!isNum(pitch) || !isNum(velocity) || !isNum(duration)) {
    issues.warn('Removed a note with invalid values.');
    return null;
  }
  const [lo, hi] = pitchRange(kind);
  const p = Math.round(pitch);
  if (p !== pitch) issues.warn('Rounded a note pitch.');
  if (p < lo || p > hi) {
    issues.warn('Removed a note with an out-of-range pitch.');
    return null;
  }
  const v = clamp(velocity, 0, 1);
  if (v !== velocity) issues.warn('Adjusted an out-of-range note velocity.');
  const d = clamp(duration, VALIDATION_LIMITS.minNoteTicks, VALIDATION_LIMITS.maxNoteTicks);
  if (d !== duration) issues.warn('Adjusted an out-of-range note length.');
  let id = raw.id;
  if (!isId(id) || ids.has(id)) {
    issues.warn('Gave a note a new id.');
    id = uid('n');
  }
  ids.add(id as string);
  return { id: id as string, tick, pitch: p, velocity: v, duration: d };
}

function validateClipInner(raw: unknown, kind: InstrumentKind, clipIds: Set<Id>, issues: Issues): Clip | null {
  if (!isObj(raw)) {
    issues.error('A clip is damaged.');
    return null;
  }
  const bars = raw.bars;
  if (!isNum(bars) || !Number.isInteger(bars) || bars < 1 || bars > 4) {
    issues.error('A clip has an invalid length (clips are 1 to 4 bars).');
    return null;
  }
  if (!Array.isArray(raw.notes)) {
    issues.error('A clip has no note list.');
    return null;
  }
  if (raw.notes.length > VALIDATION_LIMITS.maxNotesPerClip) {
    issues.error(`A clip has more than ${VALIDATION_LIMITS.maxNotesPerClip} notes.`);
    return null;
  }
  let id = raw.id;
  if (!isId(id) || clipIds.has(id)) {
    issues.warn('Gave a clip a new id.');
    id = uid('clip');
  }
  clipIds.add(id as string);
  const ticks = bars * TICKS_PER_BAR;
  const noteIds = new Set<Id>();
  const notes: Note[] = [];
  for (const n of raw.notes as unknown[]) {
    const note = validateNote(n, ticks, kind, noteIds, issues);
    if (note) notes.push(note);
  }
  const clip: Clip = { id: id as string, name: text(raw.name, 'Clip', issues, 'clip name', 60), bars: bars as ClipBars, notes };
  if (raw.variation !== undefined) {
    const v = raw.variation;
    if (isObj(v) && isNum(v.seed) && isNum(v.generation) && Number.isInteger(v.generation) && v.generation >= 0) {
      clip.variation = { seed: v.seed, generation: v.generation } satisfies VariationInfo;
    } else {
      issues.warn('Removed damaged Variation information from a clip.');
    }
  }
  return clip;
}

/**
 * Sanitize a clip from outside the store (clipboard, paste between parts).
 * Notes that cannot play on `kind` are dropped. Returns null when the clip is
 * structurally invalid. Ids are kept; callers re-id as needed.
 */
export function sanitizeClip(raw: unknown, kind: InstrumentKind): { clip: Clip | null; warnings: string[] } {
  try {
    const issues = new Issues();
    const clip = validateClipInner(raw, kind, new Set(), issues);
    return { clip: issues.failed ? null : clip, warnings: [...issues.errors, ...issues.warnings()] };
  } catch {
    return { clip: null, warnings: ['The clip could not be read.'] };
  }
}

/* ------------------------------------------------------------------ */
/* Instruments & tracks                                                */
/* ------------------------------------------------------------------ */

function validateVoice(raw: unknown, issues: Issues): DrumVoiceSettings {
  const s = DRUM_VOICE_PARAM_SPECS;
  if (!isObj(raw)) {
    issues.warn('Reset a damaged drum voice.');
    return { tune: s.tune.default, decay: s.decay.default, level: s.level.default, pan: s.pan.default };
  }
  return { tune: specNum(raw.tune, s.tune, issues), decay: specNum(raw.decay, s.decay, issues), level: specNum(raw.level, s.level, issues), pan: specNum(raw.pan, s.pan, issues) };
}

function validateInstrument(raw: unknown, sampleIds: ReadonlySet<Id>, issues: Issues): Instrument | null {
  if (!isObj(raw) || !has(INSTRUMENT_KINDS, raw.kind)) {
    issues.error('A part has a missing or unknown instrument.');
    return null;
  }
  const kind = raw.kind;
  const params = validateParams(raw.params, INSTRUMENT_PARAMS[kind], issues);
  switch (kind) {
    case 'drums': {
      let kitId = raw.kitId;
      if (typeof kitId !== 'string' || !KITS.some((k) => k.id === kitId)) {
        issues.warn('Replaced an unknown drum kit with Round Machine.');
        kitId = 'round-machine';
      }
      const rawVoices = Array.isArray(raw.voices) ? (raw.voices as unknown[]) : [];
      if (rawVoices.length !== DRUM_VOICES) issues.warn('Repaired the drum voice list.');
      const voices: DrumVoiceSettings[] = [];
      for (let i = 0; i < DRUM_VOICES; i++) voices.push(validateVoice(i < rawVoices.length ? rawVoices[i] : {}, issues));
      return { kind, kitId: kitId as string, params, voices };
    }
    case 'bass':
    case 'poly': {
      let presetId = raw.presetId;
      if (typeof presetId !== 'string' || presetId.length > 64) {
        issues.warn('Replaced a missing preset name.');
        presetId = kind === 'bass' ? 'bass-round-sub' : 'poly-glass-keys';
      }
      return { kind, presetId: presetId as string, params };
    }
    case 'sampler': {
      let sampleId: Id | null = null;
      const s = raw.sampleId;
      if (typeof s === 'string') {
        const known = s.startsWith('builtin:') ? BUILTIN_SAMPLES.some((b) => b.id === s) : sampleIds.has(s);
        if (known) sampleId = s;
        else issues.warn('A sampler part referred to a recording that is not in the project; it was cleared.');
      } else if (s !== null) {
        issues.warn('Cleared an invalid sampler recording reference.');
      }
      return { kind, sampleId, params };
    }
  }
}

function validateArp(raw: unknown, issues: Issues): ArpSettings {
  const d = defaultArp();
  if (!isObj(raw)) {
    issues.warn('Reset missing arpeggiator settings.');
    return d;
  }
  const pick = <T>(ok: boolean, v: unknown, fallback: T): T => {
    if (ok) return v as T;
    issues.warn('Reset an invalid arpeggiator setting.');
    return fallback;
  };
  const gate = isNum(raw.gate) ? clamp(raw.gate, 0.1, 1) : d.gate;
  if (gate !== raw.gate) issues.warn('Reset an invalid arpeggiator setting.');
  return {
    enabled: pick(typeof raw.enabled === 'boolean', raw.enabled, d.enabled),
    division: pick(has(ARP_DIVISIONS, raw.division), raw.division, d.division),
    mode: pick(has(ARP_MODES, raw.mode), raw.mode, d.mode),
    octaves: pick(raw.octaves === 1 || raw.octaves === 2 || raw.octaves === 3, raw.octaves, d.octaves),
    latch: pick(typeof raw.latch === 'boolean', raw.latch, d.latch),
    gate,
  };
}

function validateMacros(raw: unknown, issues: Issues): MacroValues {
  const d = defaultMacros();
  if (!isObj(raw)) {
    issues.warn('Reset missing macro positions.');
    return d;
  }
  const out = { ...d };
  for (const m of MACRO_IDS) {
    const v = raw[m];
    if (!isNum(v)) {
      issues.warn('Reset an invalid macro position.');
      continue;
    }
    out[m] = clamp(v, 0, 1);
    if (out[m] !== v) issues.warn('Adjusted an out-of-range macro position.');
  }
  return out;
}

/** Parameter specs of a module within a (partially validated) patch. */
function moduleSpecs(patch: Patch, kinds: ReadonlyMap<Id, InstrumentKind>, moduleIdStr: Id): readonly ParamSpec[] | null {
  const mod = patch.modules.find((m) => m.id === moduleIdStr);
  if (!mod) return null;
  if (mod.type === 'instrument') {
    const kind = mod.trackId ? kinds.get(mod.trackId) : undefined;
    return kind ? INSTRUMENT_PARAMS[kind] : null;
  }
  return MODULE_PARAMS[mod.type];
}

function validateMacroTarget(raw: unknown, patch: Patch, kinds: ReadonlyMap<Id, InstrumentKind>, issues: Issues): MacroTarget | null {
  const drop = (why: string): null => {
    issues.warn(`Removed a macro assignment ${why}.`);
    return null;
  };
  if (!isObj(raw)) return drop('that was damaged');
  if (typeof raw.module !== 'string') return drop('without a module');
  const specs = moduleSpecs(patch, kinds, raw.module);
  if (!specs) return drop('to a module that is not in the patch');
  const spec = typeof raw.param === 'string' ? specById(specs, raw.param) : undefined;
  if (!spec) return drop('to an unknown control');
  if (!isNum(raw.min) || !isNum(raw.max)) return drop('with an invalid range');
  const min = clampParam(spec, raw.min);
  const max = clampParam(spec, raw.max);
  if (min !== raw.min || max !== raw.max) issues.warn('Adjusted an out-of-range macro assignment.');
  let curve: 'lin' | 'exp' = raw.curve === 'exp' ? 'exp' : 'lin';
  if (raw.curve !== 'lin' && raw.curve !== 'exp') issues.warn('Reset an invalid macro curve.');
  if (curve === 'exp' && !(min > 0 && max > 0)) {
    issues.warn('Changed a macro curve that could not be exponential.');
    curve = 'lin';
  }
  const t: MacroTarget = { module: raw.module, param: spec.id, min, max, curve };
  for (const key of ['macroFrom', 'macroTo'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!isNum(v)) {
      issues.warn('Removed an invalid macro range.');
      continue;
    }
    t[key] = clamp(v, 0, 1);
    if (t[key] !== v) issues.warn('Adjusted an out-of-range macro range.');
  }
  return t;
}

function validateMacroMap(raw: unknown, patch: Patch, kinds: ReadonlyMap<Id, InstrumentKind>, issues: Issues): MacroMap {
  const out = {} as MacroMap;
  if (!isObj(raw)) issues.warn('Reset a missing macro mapping.');
  for (const m of MACRO_IDS) {
    const list = isObj(raw) ? raw[m] : undefined;
    out[m] = [];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      issues.warn('Removed a damaged macro mapping.');
      continue;
    }
    for (const item of list as unknown[]) {
      if (out[m].length >= VALIDATION_LIMITS.maxMacroTargets) {
        issues.warn('Removed extra macro assignments beyond the limit.');
        break;
      }
      const t = validateMacroTarget(item, patch, kinds, issues);
      if (t) out[m].push(t);
    }
  }
  return out;
}

interface TrackDraft {
  track: Omit<Track, 'macroMap'>;
  rawMacroMap: unknown;
}

function validateTrack(raw: unknown, index: number, trackIds: Set<Id>, clipIds: Set<Id>, sampleIds: ReadonlySet<Id>, issues: Issues): TrackDraft | null {
  if (!isObj(raw)) {
    issues.error(`Part ${index + 1} is damaged.`);
    return null;
  }
  if (!isSimpleId(raw.id) || trackIds.has(raw.id)) {
    issues.error(`Part ${index + 1} has a missing or duplicate id.`);
    return null;
  }
  const id = raw.id;
  trackIds.add(id);
  let role: TrackRole = DEFAULT_ROLES[index];
  if (has(DEFAULT_ROLES, raw.role)) role = raw.role;
  else issues.warn('Reset an unknown part role.');
  const instrument = validateInstrument(raw.instrument, sampleIds, issues);
  if (!instrument) return null;
  if (!Array.isArray(raw.clips) || raw.clips.length !== SCENE_ROWS) {
    issues.error(`Part ${index + 1} must have exactly ${SCENE_ROWS} clip slots.`);
    return null;
  }
  const clips: (Clip | null)[] = [];
  for (const c of raw.clips as unknown[]) {
    if (c === null) {
      clips.push(null);
      continue;
    }
    const clip = validateClipInner(c, instrument.kind, clipIds, issues);
    if (!clip) return null;
    clips.push(clip);
  }
  return {
    track: {
      id,
      name: text(raw.name, ROLE_LABELS[role], issues, 'part name', 60),
      role,
      instrument,
      clips,
      mute: bool(raw.mute, false, issues, 'mute'),
      solo: bool(raw.solo, false, issues, 'solo'),
      locked: bool(raw.locked, false, issues, 'lock'),
      arp: validateArp(raw.arp, issues),
      macros: validateMacros(raw.macros, issues),
    },
    rawMacroMap: raw.macroMap,
  };
}

function validateScenes(raw: unknown, issues: Issues): Scene[] | null {
  if (!Array.isArray(raw) || raw.length !== SCENE_ROWS) {
    issues.error(`The project must have exactly ${SCENE_ROWS} scenes.`);
    return null;
  }
  const ids = new Set<Id>();
  const out: Scene[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s: unknown = raw[i];
    if (!isObj(s) || !isId(s.id) || ids.has(s.id)) {
      issues.error(`Scene ${i + 1} has a missing or duplicate id.`);
      return null;
    }
    ids.add(s.id);
    out.push({ id: s.id, name: text(s.name, `Scene ${i + 1}`, issues, 'scene name', 40) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Patch                                                               */
/* ------------------------------------------------------------------ */

function validateModule(raw: unknown, trackIds: ReadonlySet<Id>, issues: Issues): PatchModule | null {
  const drop = (why: string): null => {
    issues.warn(`Removed a module ${why}.`);
    return null;
  };
  if (!isObj(raw)) return drop('that was damaged');
  if (!isId(raw.id)) return drop('with an invalid id');
  if (!has(MODULE_TYPES, raw.type)) return drop('of an unknown type');
  const type = raw.type;
  let trackId: Id | undefined;
  if (raw.trackId !== undefined) {
    if (typeof raw.trackId !== 'string' || !trackIds.has(raw.trackId)) return drop('that belonged to a missing part');
    trackId = raw.trackId;
  }
  if ((type === 'instrument' || type === 'channel') && !trackId) return drop('that did not belong to a part');
  const mod: PatchModule = { id: raw.id, type, params: validateParams(raw.params, MODULE_PARAMS[type], issues), bypass: bool(raw.bypass, false, issues, 'bypass') };
  if (trackId !== undefined) mod.trackId = trackId;
  if (raw.label !== undefined) {
    if (typeof raw.label === 'string') mod.label = raw.label.slice(0, 40);
    else issues.warn('Removed an invalid module label.');
  }
  return mod;
}

function validatePatch(raw: unknown, trackIds: ReadonlySet<Id>, issues: Issues): Patch | null {
  if (!isObj(raw) || !Array.isArray(raw.modules) || !Array.isArray(raw.connections)) {
    issues.error('The routing (patch) is missing or damaged.');
    return null;
  }
  if (raw.modules.length > PATCH_LIMITS.maxModules * 2 || raw.connections.length > PATCH_LIMITS.maxConnections * 4) {
    issues.error('The routing (patch) is far larger than this version allows.');
    return null;
  }
  const modules: PatchModule[] = [];
  const ids = new Set<Id>();
  const instOf = new Set<Id>();
  const chOf = new Set<Id>();
  for (const m of raw.modules as unknown[]) {
    const mod = validateModule(m, trackIds, issues);
    if (!mod) continue;
    if (ids.has(mod.id)) {
      issues.warn('Removed a module with a duplicate id.');
      continue;
    }
    if (mod.type === 'master' && mod.id !== MASTER_ID) {
      issues.warn('Removed an extra master output.');
      continue;
    }
    if (mod.id === MASTER_ID && mod.type !== 'master') {
      issues.warn('Removed a module that was using the master output id.');
      continue;
    }
    if (mod.type === 'instrument' || mod.type === 'channel') {
      const seen = mod.type === 'instrument' ? instOf : chOf;
      if (seen.has(mod.trackId!)) {
        issues.warn(`Removed an extra ${mod.type} module from a part.`);
        continue;
      }
      seen.add(mod.trackId!);
    }
    if (modules.length >= PATCH_LIMITS.maxModules) {
      issues.warn('Removed modules beyond the patch limit.');
      break;
    }
    ids.add(mod.id);
    modules.push(mod);
  }
  if (!ids.has(MASTER_ID)) {
    issues.error('The project has no master output.');
    return null;
  }

  // Add cables one at a time so every rule (including cycles and the cable
  // limit) is checked against the cables accepted so far.
  const patch: Patch = { modules, connections: [] };
  const connIds = new Set<Id>();
  for (const c of raw.connections as unknown[]) {
    if (!isObj(c) || !isObj(c.from) || !isObj(c.to) || typeof c.from.module !== 'string' || typeof c.from.port !== 'string' || typeof c.to.module !== 'string' || typeof c.to.port !== 'string') {
      issues.warn('Removed a damaged cable.');
      continue;
    }
    const from = { module: c.from.module, port: c.from.port };
    const to = { module: c.to.module, port: c.to.port };
    const check = validateConnection(patch, from, to);
    if (!check.ok) {
      issues.warn(`Removed a cable that was not allowed: ${check.message}`);
      continue;
    }
    let id = c.id;
    if (!isId(id) || connIds.has(id)) {
      issues.warn('Gave a cable a new id.');
      id = uid('c');
    }
    connIds.add(id as string);
    const out: Connection = { id: id as string, from, to };
    const fromMod = modules.find((m) => m.id === from.module)!;
    const kind = portDef(fromMod.type, from.port, 'out')!.kind;
    if (c.amount !== undefined) {
      if (kind === 'audio') issues.warn('Removed a modulation amount from an audio cable.');
      else if (!isNum(c.amount)) issues.warn('Reset an invalid modulation amount.');
      else {
        out.amount = clamp(c.amount, -1, 1);
        if (out.amount !== c.amount) issues.warn('Adjusted an out-of-range modulation amount.');
      }
    }
    patch.connections.push(out);
  }
  return patch;
}

/* ------------------------------------------------------------------ */
/* Shared "music" core (project and performance snapshots)             */
/* ------------------------------------------------------------------ */

interface MusicCore {
  tracks: Track[];
  scenes: Scene[];
  patch: Patch;
}

function validateMusicCore(raw: Obj, sampleIds: ReadonlySet<Id>, issues: Issues): MusicCore | null {
  const scenes = validateScenes(raw.scenes, issues);
  if (!Array.isArray(raw.tracks) || raw.tracks.length !== MAX_TRACKS) {
    issues.error(`The project must have exactly ${MAX_TRACKS} parts.`);
    return null;
  }
  const trackIds = new Set<Id>();
  const clipIds = new Set<Id>();
  const drafts: TrackDraft[] = [];
  for (let i = 0; i < raw.tracks.length; i++) {
    const d = validateTrack(raw.tracks[i], i, trackIds, clipIds, sampleIds, issues);
    if (!d) return null;
    drafts.push(d);
  }
  if (!scenes) return null;
  const patch = validatePatch(raw.patch, trackIds, issues);
  if (!patch) return null;
  const kinds = new Map<Id, InstrumentKind>(drafts.map((d) => [d.track.id, d.track.instrument.kind]));
  const tracks: Track[] = drafts.map((d) => ({ ...d.track, macroMap: validateMacroMap(d.rawMacroMap, patch, kinds, issues) }));
  return { tracks, scenes, patch };
}

/* ------------------------------------------------------------------ */
/* Arrangement                                                         */
/* ------------------------------------------------------------------ */

function validateArrangement(raw: unknown, scenes: readonly Scene[], issues: Issues): Arrangement {
  if (!isObj(raw)) {
    issues.warn('Reset a missing arrangement.');
    return { blocks: [], tailSeconds: 3 };
  }
  const sceneIds = new Set(scenes.map((s) => s.id));
  const blocks: ArrangementBlock[] = [];
  const ids = new Set<Id>();
  const rawBlocks = Array.isArray(raw.blocks) ? (raw.blocks as unknown[]) : [];
  if (!Array.isArray(raw.blocks)) issues.warn('Reset a damaged arrangement.');
  for (const b of rawBlocks) {
    if (blocks.length >= VALIDATION_LIMITS.maxBlocks) {
      issues.warn('Removed arrangement blocks beyond the limit.');
      break;
    }
    if (!isObj(b) || typeof b.sceneId !== 'string' || !sceneIds.has(b.sceneId)) {
      issues.warn('Removed an arrangement block for a missing scene.');
      continue;
    }
    let id = b.id;
    if (!isId(id) || ids.has(id)) {
      issues.warn('Gave an arrangement block a new id.');
      id = uid('blk');
    }
    ids.add(id as string);
    const repeats = isNum(b.repeats) ? clamp(Math.round(b.repeats), 1, 8) : 1;
    if (repeats !== b.repeats) issues.warn('Adjusted an invalid repeat count.');
    blocks.push({ id: id as string, sceneId: b.sceneId, repeats });
  }
  let tailSeconds = 3;
  if (isNum(raw.tailSeconds)) {
    tailSeconds = clamp(raw.tailSeconds, 0, 10);
    if (tailSeconds !== raw.tailSeconds) issues.warn('Adjusted the export tail length.');
  } else issues.warn('Reset the export tail length.');
  return { blocks, tailSeconds };
}

/* ------------------------------------------------------------------ */
/* Performances                                                        */
/* ------------------------------------------------------------------ */

function validateEvent(raw: unknown, trackIds: ReadonlySet<Id>, moduleIds: ReadonlySet<Id>): PerformanceEvent | null {
  if (!isObj(raw) || !isNum(raw.t)) return null;
  const t = raw.t;
  const track = (): Id | null => (typeof raw.trackId === 'string' && trackIds.has(raw.trackId) ? raw.trackId : null);
  switch (raw.type) {
    case 'launch': {
      const trackId = track();
      const slot = raw.slot;
      const okSlot = slot === null || (isNum(slot) && Number.isInteger(slot) && slot >= 0 && slot < SCENE_ROWS);
      if (!trackId || !okSlot || !isNum(raw.atTick)) return null;
      return { t, type: 'launch', trackId, slot: slot as number | null, atTick: raw.atTick };
    }
    case 'scene': {
      const row = raw.row;
      if (!isNum(row) || !Number.isInteger(row) || row < 0 || row >= SCENE_ROWS || !isNum(raw.atTick)) return null;
      return { t, type: 'scene', row, atTick: raw.atTick };
    }
    case 'stopAll':
      return isNum(raw.atTick) ? { t, type: 'stopAll', atTick: raw.atTick } : null;
    case 'noteOn': {
      const trackId = track();
      if (!trackId || !isNum(raw.pitch) || raw.pitch < 0 || raw.pitch > 127 || !isNum(raw.velocity) || typeof raw.key !== 'string' || raw.key.length > 64) return null;
      return { t, type: 'noteOn', trackId, pitch: Math.round(raw.pitch), velocity: clamp(raw.velocity, 0, 1), key: raw.key };
    }
    case 'noteOff': {
      const trackId = track();
      if (!trackId || !isNum(raw.pitch) || raw.pitch < 0 || raw.pitch > 127 || typeof raw.key !== 'string' || raw.key.length > 64) return null;
      return { t, type: 'noteOff', trackId, pitch: Math.round(raw.pitch), key: raw.key };
    }
    case 'macro': {
      const trackId = track();
      if (!trackId || !has(MACRO_IDS, raw.macro) || !isNum(raw.value)) return null;
      return { t, type: 'macro', trackId, macro: raw.macro as MacroId, value: clamp(raw.value, 0, 1) };
    }
    case 'param': {
      if (typeof raw.module !== 'string' || !moduleIds.has(raw.module) || typeof raw.param !== 'string' || raw.param.length > 64 || !isNum(raw.value)) return null;
      return { t, type: 'param', module: raw.module, param: raw.param, value: raw.value };
    }
    case 'mute': {
      const trackId = track();
      if (!trackId || typeof raw.mute !== 'boolean') return null;
      return { t, type: 'mute', trackId, mute: raw.mute };
    }
    case 'tempo':
      return isNum(raw.bpm) ? { t, type: 'tempo', bpm: clamp(raw.bpm, BPM_SPEC.min, BPM_SPEC.max) } : null;
    case 'swing':
      return isNum(raw.swing) ? { t, type: 'swing', swing: clamp(raw.swing, 0, 1) } : null;
    case 'master':
      return isNum(raw.volumeDb) ? { t, type: 'master', volumeDb: clamp(raw.volumeDb, MASTER_VOLUME_SPEC.min, MASTER_VOLUME_SPEC.max) } : null;
    default:
      return null;
  }
}

function validateSnapshot(raw: unknown, sampleIds: ReadonlySet<Id>, issues: Issues): PerformanceSnapshot | null {
  if (!isObj(raw)) {
    issues.error('missing snapshot');
    return null;
  }
  const core = validateMusicCore(raw, sampleIds, issues);
  if (!core) return null;
  const trackIds = new Set(core.tracks.map((t) => t.id));
  const launcher: LauncherSnapshotEntry[] = [];
  if (!Array.isArray(raw.launcher)) {
    issues.error('missing launcher state');
    return null;
  }
  for (const e of raw.launcher as unknown[]) {
    if (!isObj(e) || typeof e.trackId !== 'string' || !trackIds.has(e.trackId)) {
      issues.warn('Removed a damaged launcher entry from a performance.');
      continue;
    }
    const p = e.playing;
    if (p === null) launcher.push({ trackId: e.trackId, playing: null });
    else if (isObj(p) && isNum(p.slot) && Number.isInteger(p.slot) && p.slot >= 0 && p.slot < SCENE_ROWS && isNum(p.startTick)) {
      launcher.push({ trackId: e.trackId, playing: { slot: p.slot, startTick: p.startTick } });
    } else issues.warn('Removed a damaged launcher entry from a performance.');
  }
  if (!isNum(raw.seed)) {
    issues.error('missing seed');
    return null;
  }
  return {
    bpm: specNum(raw.bpm, BPM_SPEC, issues),
    swing: specNum(raw.swing, SWING_SPEC, issues),
    root: isNum(raw.root) ? ((Math.round(raw.root) % 12) + 12) % 12 : 0,
    scale: has(SCALE_IDS, raw.scale) ? raw.scale : 'minor',
    assist: typeof raw.assist === 'boolean' ? raw.assist : true,
    masterVolumeDb: specNum(raw.masterVolumeDb, MASTER_VOLUME_SPEC, issues),
    tracks: core.tracks,
    scenes: core.scenes,
    patch: core.patch,
    launcher,
    seed: raw.seed,
  };
}

function validatePerformanceInner(raw: unknown, sampleIds: ReadonlySet<Id>, perfIds: Set<Id>, issues: Issues): Performance | null {
  const drop = (why: string): null => {
    issues.warn(`Removed a recorded performance (${why}).`);
    return null;
  };
  if (!isObj(raw)) return drop('damaged');
  if (!Array.isArray(raw.events)) return drop('no events');
  if (raw.events.length > VALIDATION_LIMITS.maxPerformanceEvents) return drop(`more than ${VALIDATION_LIMITS.maxPerformanceEvents} events`);
  if (!isNum(raw.startTick) || !isNum(raw.endTick) || raw.endTick < raw.startTick) return drop('invalid start or end');
  const sub = new Issues();
  const snapshot = validateSnapshot(raw.snapshot, sampleIds, sub);
  if (!snapshot || sub.failed) return drop('its starting state is damaged');
  issues.merge(sub);

  const trackIds = new Set(snapshot.tracks.map((t) => t.id));
  const moduleIds = new Set(snapshot.patch.modules.map((m) => m.id));
  const events: PerformanceEvent[] = [];
  let dropped = 0;
  let sorted = true;
  for (const e of raw.events as unknown[]) {
    const ev = validateEvent(e, trackIds, moduleIds);
    if (!ev) {
      dropped++;
      continue;
    }
    if (events.length && ev.t < events[events.length - 1].t) sorted = false;
    events.push(ev);
  }
  if (dropped) issues.warn(`Removed ${dropped} damaged event${dropped === 1 ? '' : 's'} from a recorded performance.`);
  if (!sorted) {
    // Array.prototype.sort is stable, so events at the same time keep their order.
    events.sort((a, b) => a.t - b.t);
    issues.warn('Put the events of a recorded performance back in time order.');
  }
  let id = raw.id;
  if (!isId(id) || perfIds.has(id)) {
    issues.warn('Gave a recorded performance a new id.');
    id = uid('perf');
  }
  perfIds.add(id as string);
  return {
    id: id as string,
    name: text(raw.name, 'Performance', issues, 'performance name', 80),
    createdAt: isNum(raw.createdAt) ? raw.createdAt : 0,
    startTick: raw.startTick,
    endTick: raw.endTick,
    snapshot,
    events,
  };
}

/**
 * Validate one recorded performance against a project's recordings (used
 * when a take is added). Returns null with reasons when it cannot be kept.
 */
export function validatePerformance(raw: unknown, project: Pick<Project, 'samples'>): { performance: Performance | null; warnings: string[] } {
  try {
    const issues = new Issues();
    const perf = validatePerformanceInner(raw, new Set(project.samples.map((s) => s.id)), new Set(), issues);
    return { performance: perf, warnings: issues.warnings() };
  } catch {
    return { performance: null, warnings: ['The performance could not be read.'] };
  }
}

/* ------------------------------------------------------------------ */
/* Project                                                             */
/* ------------------------------------------------------------------ */

function validateSettings(raw: unknown, issues: Issues): ProjectSettings {
  const d: ProjectSettings = { metronome: false, countIn: false, recordQuantize: '1/16' };
  if (!isObj(raw)) {
    issues.warn('Reset missing project settings.');
    return d;
  }
  let recordQuantize = d.recordQuantize;
  if (has(QUANTIZE_GRIDS, raw.recordQuantize)) recordQuantize = raw.recordQuantize;
  else issues.warn('Reset an invalid record quantize setting.');
  return { metronome: bool(raw.metronome, false, issues, 'metronome'), countIn: bool(raw.countIn, false, issues, 'count-in'), recordQuantize };
}

function validateProjectInner(input: unknown, issues: Issues): Project | null {
  if (!isObj(input)) {
    issues.error('This file does not contain a SWITCHBOARD project.');
    return null;
  }
  const migrated = migrateProject(input);
  if (!migrated.ok) {
    issues.error(migrated.error);
    return null;
  }
  const raw: unknown = migrated.data;
  if (!isObj(raw) || raw.schema !== PROJECT_SCHEMA) {
    issues.error('This file is not a SWITCHBOARD project.');
    return null;
  }
  if (!isId(raw.id)) {
    issues.error('The project has no valid id.');
    return null;
  }

  // Recordings first: sampler parts and snapshots refer to them.
  const samples: SampleMeta[] = [];
  if (raw.samples !== undefined && !Array.isArray(raw.samples)) issues.warn('Reset a damaged list of imported recordings.');
  const rawSamples = Array.isArray(raw.samples) ? (raw.samples as unknown[]) : [];
  for (const s of rawSamples) {
    if (samples.length >= VALIDATION_LIMITS.maxSamples) {
      issues.warn('Removed imported recordings beyond the limit.');
      break;
    }
    const meta = validateSampleMeta(s, issues);
    if (!meta) continue;
    if (samples.some((x) => x.id === meta.id)) {
      issues.warn('Removed a duplicate imported recording.');
      continue;
    }
    samples.push(meta);
  }
  const sampleIds = new Set(samples.map((s) => s.id));

  const core = validateMusicCore(raw, sampleIds, issues);
  if (!core || issues.failed) return null;

  const performances: Performance[] = [];
  if (raw.performances !== undefined && !Array.isArray(raw.performances)) issues.warn('Reset a damaged list of recorded performances.');
  const rawPerfs = Array.isArray(raw.performances) ? (raw.performances as unknown[]) : [];
  const perfIds = new Set<Id>();
  for (const p of rawPerfs) {
    if (performances.length >= VALIDATION_LIMITS.maxPerformances) {
      issues.warn('Removed recorded performances beyond the limit.');
      break;
    }
    const perf = validatePerformanceInner(p, sampleIds, perfIds, issues);
    if (perf) performances.push(perf);
  }

  const now = Date.now();
  const time = (v: unknown, what: string): number => {
    if (isNum(v) && v >= 0) return v;
    issues.warn(`Reset the project's ${what} time.`);
    return now;
  };
  let root = 0;
  if (isNum(raw.root) && Number.isInteger(raw.root) && raw.root >= 0 && raw.root < 12) root = raw.root;
  else issues.warn('Reset an invalid key root.');
  let scale: ScaleId = 'minor';
  if (has(SCALE_IDS, raw.scale)) scale = raw.scale;
  else issues.warn('Reset an unknown scale.');
  let seed = 1;
  if (isNum(raw.seed) && Number.isInteger(raw.seed) && raw.seed >= 0 && raw.seed < 2 ** 32) seed = raw.seed;
  else if (isNum(raw.seed)) {
    seed = Math.trunc(raw.seed) >>> 0;
    issues.warn('Adjusted an invalid project seed.');
  } else issues.warn('Reset a missing project seed.');

  const project: Project = {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    id: raw.id,
    name: text(raw.name, 'Untitled', issues, 'project name'),
    createdAt: time(raw.createdAt, 'creation'),
    updatedAt: time(raw.updatedAt, 'last edit'),
    bpm: specNum(raw.bpm, BPM_SPEC, issues),
    swing: specNum(raw.swing, SWING_SPEC, issues),
    root,
    scale,
    assist: bool(raw.assist, true, issues, 'Musical Assist'),
    masterVolumeDb: specNum(raw.masterVolumeDb, MASTER_VOLUME_SPEC, issues),
    tracks: core.tracks,
    scenes: core.scenes,
    patch: core.patch,
    arrangement: validateArrangement(raw.arrangement, core.scenes, issues),
    performances,
    samples,
    seed,
    settings: validateSettings(raw.settings, issues),
  };
  if (raw.starterId !== undefined) {
    if (typeof raw.starterId === 'string' && raw.starterId.length <= 64) project.starterId = raw.starterId;
    else issues.warn('Removed an invalid starter reference.');
  }
  return project;
}

/**
 * Validate (and migrate) untrusted project data. Never throws.
 */
export function validateProject(raw: unknown): ValidateResult {
  const issues = new Issues();
  try {
    const project = validateProjectInner(raw, issues);
    if (!project || issues.failed) return { ok: false, errors: issues.errors.length ? issues.errors : ['This project could not be read.'] };
    return { ok: true, project, warnings: issues.warnings() };
  } catch (e) {
    return { ok: false, errors: [`This project could not be read (${e instanceof Error ? e.message : 'unexpected data'}).`] };
  }
}
