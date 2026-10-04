/**
 * Project validation for everything that enters the app from outside the
 * store: saved projects, imported bundles, pasted clips and recorded takes.
 *
 * `validateProject` migrates first, then rebuilds a fresh Project field by
 * field, so the result never shares objects with the input and contains only
 * known fields. Structural problems (wrong track or scene counts, a part
 * whose clip slots do not match the scenes, a missing master, malformed
 * tracks) are errors. Recoverable problems (out-of-range values, dangling
 * references such as a clip's recording that is gone, invalid notes, cables
 * or song moves) are repaired and reported as warnings. A valid project
 * comes out deep-equal to what went in.
 *
 * It never throws: anything unexpected becomes an error result.
 */
import { BUILTIN_SAMPLES, KITS } from '../content/catalog';
import { tidyRegions, tidySections } from './arrangement';
import { DEFAULT_ROLES, MASTER_ID, ROLE_LABELS, defaultArp, defaultMacros, uid } from './factory';
import { validateConnection } from './graph';
import { migrateProject } from './migrate';
import { MODULE_DEFS, PATCH_LIMITS, portDef } from './modules';
import {
  BPM_SPEC,
  DRUM_VOICE_PARAM_SPECS,
  INSTRUMENT_PARAMS,
  MASTER_VOLUME_SPEC,
  MASTERING_PARAMS,
  MODULE_PARAMS,
  SAMPLER_PARAMS,
  SWING_SPEC,
  clampParam,
  specById,
  type ParamSpec,
} from './params';
import {
  DRUM_VOICES,
  MACRO_IDS,
  MAX_CLIP_BARS,
  MAX_SCENES,
  MAX_SECTION_NAME,
  MAX_SONG_BARS,
  MAX_TRACKS,
  MIN_SCENES,
  PROJECT_SCHEMA,
  PROJECT_VERSION,
  SONG_MOVE_KINDS,
  TICKS_PER_BAR,
  type ArpDivision,
  type ArpMode,
  type ArpSettings,
  type Arrangement,
  type Clip,
  type ClipBars,
  type ClipSample,
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
  type Mastering,
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
  type SongMove,
  type SongMoveKind,
  type SongRegion,
  type SongSection,
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
  /** Loops on the song timeline (all parts together). */
  maxRegions: 4000,
  /** Named sections on the song timeline. */
  maxSections: 256,
  maxSamples: 256,
  maxMacroTargets: 16,
  maxPeaks: 4096,
  maxSampleBytes: 256 * 1024 * 1024,
  maxSampleSeconds: 600,
  maxNameLength: 120,
  /** Longest note: as long as the longest clip (eight bars). */
  maxNoteTicks: TICKS_PER_BAR * MAX_CLIP_BARS,
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

/** Check imported-recording metadata (e.g. before adding it to a project). Null when unusable. */
export function sanitizeSampleMeta(raw: unknown): SampleMeta | null {
  try {
    return validateSampleMeta(raw, new Issues());
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Notes & clips                                                       */
/* ------------------------------------------------------------------ */

type PitchRange = readonly [number, number];
const MIDI_RANGE: PitchRange = [0, 127];

/** Pitches a part can play: drum voice indices for kits, MIDI notes otherwise. */
function playableRange(kind: InstrumentKind): PitchRange {
  return kind === 'drums' ? [0, DRUM_VOICES - 1] : MIDI_RANGE;
}

function validateNote(raw: unknown, clipTicks: number, range: PitchRange, ids: Set<Id>, issues: Issues): Note | null {
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
  const [lo, hi] = range;
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

/** A recording id a project can play: one of its imported recordings, or a built-in one. */
function knownSampleId(id: string, sampleIds: ReadonlySet<Id>): boolean {
  return id.startsWith('builtin:') ? BUILTIN_SAMPLES.some((b) => b.id === id) : sampleIds.has(id);
}

const ROOT_NOTE_SPEC = specById(SAMPLER_PARAMS, 'rootNote')!;

/**
 * A clip's own recording reference. `sampleIds` null: the project's
 * recordings are not known here (a clip from the clipboard), so any
 * well-formed id is kept. An unknown recording, or a region that is not
 * valid, never fails the clip: the reference is dropped or the region reset.
 */
function validateClipSample(raw: unknown, sampleIds: ReadonlySet<Id> | null, issues: Issues): ClipSample | null {
  if (!isObj(raw) || typeof raw.id !== 'string') {
    issues.warn('Removed a damaged recording reference from a clip (it plays its part’s recording).');
    return null;
  }
  const id = raw.id;
  const wellFormed = id.startsWith('builtin:') ? BUILTIN_SAMPLES.some((b) => b.id === id) : isSimpleId(id);
  if (!wellFormed || (sampleIds !== null && !knownSampleId(id, sampleIds))) {
    issues.warn('A clip referred to a recording that is not in the project; it plays its part’s recording instead.');
    return null;
  }
  let start = isNum(raw.start) ? clamp(raw.start, 0, 1) : NaN;
  let end = isNum(raw.end) ? clamp(raw.end, 0, 1) : NaN;
  if (!(start < end)) {
    issues.warn('Reset a clip’s recording region that was not valid (it plays the whole recording).');
    start = 0;
    end = 1;
  } else if (start !== raw.start || end !== raw.end) issues.warn('Adjusted a clip’s recording region.');
  return { id, start, end, rootNote: specNum(raw.rootNote, ROOT_NOTE_SPEC, issues) };
}

function validateClipInner(raw: unknown, range: PitchRange, clipIds: Set<Id>, sampleIds: ReadonlySet<Id> | null, issues: Issues): Clip | null {
  if (!isObj(raw)) {
    issues.error('A clip is damaged.');
    return null;
  }
  const bars = raw.bars;
  if (!isNum(bars) || !Number.isInteger(bars) || bars < 1 || bars > MAX_CLIP_BARS) {
    issues.error(`A clip has an invalid length (clips are 1 to ${MAX_CLIP_BARS} bars).`);
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
    const note = validateNote(n, ticks, range, noteIds, issues);
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
  if (raw.sample !== undefined) {
    const sample = validateClipSample(raw.sample, sampleIds, issues);
    if (sample) clip.sample = sample;
  }
  return clip;
}

/**
 * Sanitize a clip from outside the store (clipboard, paste between parts).
 * Notes that cannot play on `kind` are dropped. Returns null when the clip is
 * structurally invalid. Ids are kept; callers re-id as needed. With
 * `sampleIds` (the target project's recordings), a reference to a recording
 * the project does not have is dropped (the clip plays its part's recording).
 */
export function sanitizeClip(raw: unknown, kind: InstrumentKind, sampleIds?: ReadonlySet<Id>): { clip: Clip | null; warnings: string[] } {
  try {
    const issues = new Issues();
    const clip = validateClipInner(raw, playableRange(kind), new Set(), sampleIds ?? null, issues);
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

/** Designed macro positions: known macros only, each 0..1; nothing usable leaves it out. */
function validateMacroHome(raw: unknown, issues: Issues): Partial<Record<MacroId, number>> | undefined {
  if (!isObj(raw)) {
    issues.warn('Removed damaged designed big-knob positions (double-click returns knobs to their defaults).');
    return undefined;
  }
  const out: Partial<Record<MacroId, number>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!has(MACRO_IDS, k) || !isNum(v)) {
      issues.warn('Removed an invalid designed big-knob position.');
      continue;
    }
    out[k] = clamp(v, 0, 1);
    if (out[k] !== v) issues.warn('Adjusted an out-of-range designed big-knob position.');
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * One part. `rows` is the number of scenes (its clip slots must match it), or
 * null when the scenes themselves are damaged (the project fails anyway; the
 * part is still checked so every problem is reported).
 */
function validateTrack(raw: unknown, index: number, rows: number | null, trackIds: Set<Id>, clipIds: Set<Id>, sampleIds: ReadonlySet<Id>, issues: Issues): TrackDraft | null {
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
  if (!Array.isArray(raw.clips) || raw.clips.length < MIN_SCENES || raw.clips.length > MAX_SCENES) {
    issues.error(`Part ${index + 1} must have ${MIN_SCENES} to ${MAX_SCENES} clip slots, one per scene.`);
    return null;
  }
  if (rows !== null && raw.clips.length !== rows) {
    issues.error(`Part ${index + 1} has ${raw.clips.length} clip slots but the project has ${rows} scenes: every part needs one slot per scene.`);
    return null;
  }
  const clips: (Clip | null)[] = [];
  for (const c of raw.clips as unknown[]) {
    if (c === null) {
      clips.push(null);
      continue;
    }
    // Any MIDI pitch is kept on load: a part whose instrument changed (for example
    // bass -> drums) keeps notes it cannot play, so switching back restores them.
    const clip = validateClipInner(c, MIDI_RANGE, clipIds, sampleIds, issues);
    if (!clip) return null;
    clips.push(clip);
  }
  const macroHome = raw.macroHome === undefined ? undefined : validateMacroHome(raw.macroHome, issues);
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
      ...(macroHome ? { macroHome } : {}),
    },
    rawMacroMap: raw.macroMap,
  };
}

function validateScenes(raw: unknown, issues: Issues): Scene[] | null {
  if (!Array.isArray(raw) || raw.length < MIN_SCENES || raw.length > MAX_SCENES) {
    issues.error(`The project must have ${MIN_SCENES} to ${MAX_SCENES} scenes.`);
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
    const d = validateTrack(raw.tracks[i], i, scenes ? scenes.length : null, trackIds, clipIds, sampleIds, issues);
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
/* Song (arrangement)                                                  */
/* ------------------------------------------------------------------ */

/**
 * A section's song moves: known kinds only, at most one of each (the first
 * is kept), ids unique across the song, `parts` limited to existing parts
 * (fades never carry parts; an empty list is removed, so the move acts on
 * every melodic part, as the commands store it). Nothing usable (an empty
 * list included) leaves the field out. Every change is reported, so stored
 * data comes back exactly as it went in or with a warning.
 */
function validateMoves(raw: unknown, trackIds: ReadonlySet<Id>, moveIds: Set<Id>, issues: Issues): SongMove[] | undefined {
  if (!Array.isArray(raw)) {
    issues.warn('Removed damaged song moves from a section.');
    return undefined;
  }
  const out: SongMove[] = [];
  const kinds = new Set<SongMoveKind>();
  for (const m of raw as unknown[]) {
    if (!isObj(m) || !has(SONG_MOVE_KINDS, m.kind)) {
      issues.warn('Removed an unknown song move from a section.');
      continue;
    }
    if (kinds.has(m.kind)) {
      issues.warn('Removed a repeated song move from a section (one of each kind per section).');
      continue;
    }
    kinds.add(m.kind);
    let id = m.id;
    if (!isId(id) || moveIds.has(id)) {
      issues.warn('Gave a song move a new id.');
      id = uid('mv');
    }
    moveIds.add(id as string);
    const move: SongMove = { id: id as string, kind: m.kind };
    if (m.parts !== undefined) {
      const fade = m.kind === 'fadeIn' || m.kind === 'fadeOut';
      const list = Array.isArray(m.parts) ? (m.parts as unknown[]) : [];
      const parts: Id[] = [];
      for (const t of list) if (typeof t === 'string' && trackIds.has(t) && !parts.includes(t)) parts.push(t);
      if (fade || !Array.isArray(m.parts) || parts.length !== list.length || !parts.length) issues.warn('Adjusted the parts a song move acts on.');
      if (!fade && parts.length) move.parts = parts;
    }
    out.push(move);
  }
  if (!out.length && !(raw as unknown[]).length) issues.warn('Removed an empty list of song moves from a section.');
  return out.length ? out : undefined;
}

const SONG_TOO_LONG = `Shortened the song to ${MAX_SONG_BARS} bars, the longest a song can be.`;

/**
 * A stretch of the song timeline in whole bars, kept inside [0, MAX_SONG_BARS):
 * `cut` is how many bars were cut off its start (null when nothing is left).
 * Non-numbers are damaged (undefined); fractions are rounded with a warning.
 */
function songSpan(start: unknown, bars: unknown, what: string, issues: Issues): { start: number; bars: number; cut: number } | null | undefined {
  if (!isNum(start) || !isNum(bars)) return undefined;
  let s = Math.round(start);
  let e = Math.round(start + bars);
  if (s !== start || e - s !== bars) issues.warn(`Moved ${what} onto the bar lines.`);
  let cut = 0;
  if (s < 0) {
    issues.warn(`Cut ${what} that started before the song.`);
    cut = -s;
    s = 0;
  }
  if (e > MAX_SONG_BARS) {
    issues.warn(SONG_TOO_LONG);
    e = MAX_SONG_BARS;
  }
  if (e - s < 1) return null;
  return { start: s, bars: e - s, cut };
}

/** One loop on the song timeline (overlaps are fixed afterwards, for the whole song). */
function validateRegion(raw: unknown, tracks: readonly Track[], ids: Set<Id>, issues: Issues): SongRegion | null {
  if (!isObj(raw)) {
    issues.warn('Removed a damaged loop from the song.');
    return null;
  }
  const track = tracks.find((t) => t.id === raw.trackId);
  const clip = track ? track.clips.find((c) => c !== null && c.id === raw.clipId) : undefined;
  if (!track || !clip) {
    issues.warn('Removed a loop whose clip no longer exists from the song.');
    return null;
  }
  const span = songSpan(raw.start, raw.bars, 'a loop', issues);
  if (span === undefined || !isNum(raw.offset)) {
    issues.warn('Removed a damaged loop from the song.');
    return null;
  }
  if (span === null) {
    if (isNum(raw.bars) && Math.round(raw.bars) < 1) issues.warn('Removed a loop with no length from the song.');
    return null;
  }
  // Bars cut off the start: the music stays where it was, later in the clip.
  const want = Math.round(raw.offset) + span.cut;
  const offset = ((want % clip.bars) + clip.bars) % clip.bars;
  if (offset !== raw.offset && span.cut === 0) issues.warn('Adjusted where a loop starts in its clip.');
  let id = raw.id;
  if (!isId(id) || ids.has(id)) {
    issues.warn('Gave a loop in the song a new id.');
    id = uid('rg');
  }
  ids.add(id as string);
  return { id: id as string, trackId: track.id, clipId: clip.id, start: span.start, bars: span.bars, offset };
}

function validateSection(raw: unknown, trackIds: ReadonlySet<Id>, ids: Set<Id>, moveIds: Set<Id>, issues: Issues): SongSection | null {
  if (!isObj(raw)) {
    issues.warn('Removed a damaged section from the song.');
    return null;
  }
  const span = songSpan(raw.start, raw.bars, 'a section', issues);
  if (span === undefined) {
    issues.warn('Removed a damaged section from the song.');
    return null;
  }
  if (span === null) {
    if (isNum(raw.bars) && Math.round(raw.bars) < 1) issues.warn('Removed a section with no length from the song.');
    return null;
  }
  let name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, MAX_SECTION_NAME).trimEnd() : '';
  if (!name) {
    issues.warn('Named a song section that had no name.');
    name = 'Section';
  } else if (name !== raw.name) issues.warn('Adjusted a song section name.');
  let id = raw.id;
  if (!isId(id) || ids.has(id)) {
    issues.warn('Gave a song section a new id.');
    id = uid('sec');
  }
  ids.add(id as string);
  const section: SongSection = { id: id as string, name, start: span.start, bars: span.bars };
  if (raw.moves !== undefined) {
    const moves = validateMoves(raw.moves, trackIds, moveIds, issues);
    if (moves) section.moves = moves;
  }
  return section;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The song: loops (regions) whose part and clip exist, in whole bars inside
 * the song's range, with their offset inside their clip and never
 * overlapping on a part (the earlier keeps its bars; see tidyRegions), and
 * sections that never overlap (tidySections). Both lists come out in time
 * order. Every repair is said in plain words.
 */
function validateArrangement(raw: unknown, tracks: Track[], issues: Issues): Arrangement {
  if (!isObj(raw)) {
    issues.warn('Reset a missing song.');
    return { regions: [], sections: [], tailSeconds: 3 };
  }
  if (!Array.isArray(raw.regions) || !Array.isArray(raw.sections)) issues.warn('Reset a damaged song.');
  const trackIds = new Set(tracks.map((t) => t.id));

  const regionIds = new Set<Id>();
  const regions: SongRegion[] = [];
  for (const r of Array.isArray(raw.regions) ? (raw.regions as unknown[]) : []) {
    if (regions.length >= VALIDATION_LIMITS.maxRegions) {
      issues.warn(`Removed loops beyond the limit of ${VALIDATION_LIMITS.maxRegions} from the song.`);
      break;
    }
    const region = validateRegion(r, tracks, regionIds, issues);
    if (region) regions.push(region);
  }
  // Every region is inside the song and its clip now: what tidying fixes are overlaps.
  const tidy = tidyRegions({ tracks }, regions);
  if (tidy.fixed) issues.warn(`Fixed ${plural(tidy.fixed, 'overlapping loop', 'overlapping loops')} in the song.`);
  else if (tidy.regions.some((r, i) => r.id !== regions[i].id)) issues.warn('Put the song’s loops back in time order.');

  const sectionIds = new Set<Id>();
  const moveIds = new Set<Id>();
  const sections: SongSection[] = [];
  for (const s of Array.isArray(raw.sections) ? (raw.sections as unknown[]) : []) {
    if (sections.length >= VALIDATION_LIMITS.maxSections) {
      issues.warn(`Removed sections beyond the limit of ${VALIDATION_LIMITS.maxSections} from the song.`);
      break;
    }
    const section = validateSection(s, trackIds, sectionIds, moveIds, issues);
    if (section) sections.push(section);
  }
  const tidySecs = tidySections(sections);
  if (tidySecs.fixed) issues.warn(`Fixed ${plural(tidySecs.fixed, 'overlapping section', 'overlapping sections')} in the song.`);
  else if (tidySecs.sections.some((s, i) => s.id !== sections[i].id)) issues.warn('Put the song’s sections back in time order.');

  let tailSeconds = 3;
  if (isNum(raw.tailSeconds)) {
    tailSeconds = clamp(raw.tailSeconds, 0, 10);
    if (tailSeconds !== raw.tailSeconds) issues.warn('Adjusted the export tail length.');
  } else issues.warn('Reset the export tail length.');
  return { regions: tidy.regions, sections: tidySecs.sections, tailSeconds };
}

/* ------------------------------------------------------------------ */
/* Performances                                                        */
/* ------------------------------------------------------------------ */

/** One recorded event; `rows` is the number of scenes in the take's own snapshot. */
function validateEvent(raw: unknown, trackIds: ReadonlySet<Id>, moduleIds: ReadonlySet<Id>, rows: number): PerformanceEvent | null {
  if (!isObj(raw) || !isNum(raw.t)) return null;
  const t = raw.t;
  const track = (): Id | null => (typeof raw.trackId === 'string' && trackIds.has(raw.trackId) ? raw.trackId : null);
  switch (raw.type) {
    case 'launch': {
      const trackId = track();
      const slot = raw.slot;
      const okSlot = slot === null || (isNum(slot) && Number.isInteger(slot) && slot >= 0 && slot < rows);
      if (!trackId || !okSlot || !isNum(raw.atTick)) return null;
      return { t, type: 'launch', trackId, slot: slot as number | null, atTick: raw.atTick };
    }
    case 'scene': {
      const row = raw.row;
      if (!isNum(row) || !Number.isInteger(row) || row < 0 || row >= rows || !isNum(raw.atTick)) return null;
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
    else if (isObj(p) && isNum(p.slot) && Number.isInteger(p.slot) && p.slot >= 0 && p.slot < core.scenes.length && isNum(p.startTick)) {
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
    const ev = validateEvent(e, trackIds, moduleIds, snapshot.scenes.length);
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

const MASTERING_PRESET_ID = /^[a-z0-9-]{1,32}$/;

function validateMastering(raw: unknown, issues: Issues): Mastering {
  if (!isObj(raw)) {
    issues.warn('Reset missing mastering settings to neutral.');
    return { enabled: true, params: validateParams(undefined, MASTERING_PARAMS, issues), presetId: 'clean' };
  }
  const out: Mastering = { enabled: bool(raw.enabled, true, issues, 'mastering on/off'), params: validateParams(raw.params, MASTERING_PARAMS, issues) };
  if (raw.presetId !== undefined) {
    if (typeof raw.presetId === 'string' && MASTERING_PRESET_ID.test(raw.presetId)) out.presetId = raw.presetId;
    else issues.warn('Removed an invalid mastering preset reference.');
  }
  return out;
}

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
    issues.error('This file does not contain an Omni Song project.');
    return null;
  }
  const migrated = migrateProject(input);
  if (!migrated.ok) {
    issues.error(migrated.error);
    return null;
  }
  const raw: unknown = migrated.data;
  if (!isObj(raw) || raw.schema !== PROJECT_SCHEMA) {
    issues.error('This file is not an Omni Song project.');
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
    arrangement: validateArrangement(raw.arrangement, core.tracks, issues),
    performances,
    samples,
    seed,
    settings: validateSettings(raw.settings, issues),
    mastering: validateMastering(raw.mastering, issues),
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
