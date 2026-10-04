/** Per-part edits: name, mute/solo/lock, sound, instrument params, drum voices, arp, macros; a part's sound saved and restored. */
import { builtinSampleInfo, kitInfo, presetInfo } from '../../content/catalog';
import { PRESETS, applyKitToProject, applyPresetToProject, applySamplerToProject, presetMacroMap, type TrackSlot } from '../../content/presets';
import { defaultMacroMap, defaultMacros } from '../../project/factory';
import { DRUM_VOICE_PARAM_SPECS, INSTRUMENT_PARAMS, MODULE_PARAMS, clampParam, specById } from '../../project/params';
import { specsForModule } from '../../project/resolve';
import {
  DRUM_VOICES,
  MACRO_IDS,
  type ArpSettings,
  type DrumVoiceSettings,
  type Id,
  type Instrument,
  type InstrumentKind,
  type MacroId,
  type MacroMap,
  type MacroTarget,
  type MacroValues,
  type ModuleType,
  type ParamValues,
  type Project,
  type Track,
} from '../../project/types';
import { ARP_DIVISIONS, ARP_MODES, VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, cleanName, deepEqual, draftTrack, findTrack, isFiniteNumber, partName, refuse, run, type CommandResult } from './common';

export function renameTrack(store: ProjectStore, trackId: Id, name: string): CommandResult {
  if (!findTrack(store.getState(), trackId)) return NOT_FOUND('part');
  const n = cleanName(name, 60);
  if (!n) return refuse('invalid', 'A part needs a name.');
  return run(store, 'track:Rename part', (d) => {
    draftTrack(d, trackId).name = n;
  });
}

/** Mute or unmute a part; the undo step names it ("Mute Lead"). */
export function setMute(store: ProjectStore, trackId: Id, mute: boolean): CommandResult {
  const p = store.getState();
  if (!findTrack(p, trackId)) return NOT_FOUND('part');
  // The label stays "track:Mute part": a performance take allows (and records) exactly that edit.
  return run(store, mute ? 'track:Mute part' : 'track:Unmute part', (d) => {
    draftTrack(d, trackId).mute = !!mute;
  }, undefined, { display: `${mute ? 'Mute' : 'Unmute'} ${partName(p, trackId)}` });
}

/** Solo or unsolo a part; the undo step names it ("Solo Lead"). */
export function setSolo(store: ProjectStore, trackId: Id, solo: boolean): CommandResult {
  const p = store.getState();
  if (!findTrack(p, trackId)) return NOT_FOUND('part');
  return run(store, solo ? 'track:Solo part' : 'track:Unsolo part', (d) => {
    draftTrack(d, trackId).solo = !!solo;
  }, undefined, { display: `${solo ? 'Solo' : 'Unsolo'} ${partName(p, trackId)}` });
}

/** Locked parts are never changed by Variation. */
export function setLocked(store: ProjectStore, trackId: Id, locked: boolean): CommandResult {
  if (!findTrack(store.getState(), trackId)) return NOT_FOUND('part');
  return run(store, locked ? 'track:Lock part' : 'track:Unlock part', (d) => {
    draftTrack(d, trackId).locked = !!locked;
  });
}

/**
 * Change a part's sound: a drum kit, a bass/poly preset or a sampler
 * recording. The preset functions write params, macro mappings and module
 * settings into the project, so the saved project stays self-contained.
 */
export function changeInstrumentSound(store: ProjectStore, trackId: Id, kind: InstrumentKind, soundId: string | null): CommandResult {
  const p = store.getState();
  if (!findTrack(p, trackId)) return NOT_FOUND('part');
  switch (kind) {
    case 'drums':
      if (!soundId || !kitInfo(soundId)) return refuse('invalid', 'Unknown drum kit.');
      return run(store, 'track:Change kit', (d) => applyKitToProject(d, trackId, soundId));
    case 'bass':
    case 'poly': {
      const info = soundId ? presetInfo(soundId) : undefined;
      if (!soundId || !info || info.kind !== kind) return refuse('invalid', 'Unknown preset.');
      return run(store, 'track:Change sound', (d) => applyPresetToProject(d, trackId, soundId));
    }
    case 'sampler': {
      if (soundId !== null && !(soundId.startsWith('builtin:') ? builtinSampleInfo(soundId) : p.samples.some((s) => s.id === soundId))) {
        return refuse('invalid', 'That recording is not in this project.');
      }
      return run(store, 'track:Change recording', (d) => applySamplerToProject(d, trackId, soundId));
    }
    default:
      return refuse('invalid', 'Unknown instrument.');
  }
}

/** Set an instrument parameter (clamped through the registry). */
export function setInstrumentParam(store: ProjectStore, trackId: Id, param: string, value: number, gesture?: string): CommandResult {
  const t = findTrack(store.getState(), trackId);
  if (!t) return NOT_FOUND('part');
  const spec = specById(INSTRUMENT_PARAMS[t.instrument.kind], param);
  if (!spec || !isFiniteNumber(value)) return refuse('invalid', 'This instrument has no such control.');
  const v = clampParam(spec, value);
  return run(store, `track:Change ${spec.label}`, (d) => {
    draftTrack(d, trackId).instrument.params[param] = v;
  }, gesture);
}

/** Change one drum voice's tune/decay/level/pan. */
export function setDrumVoice(store: ProjectStore, trackId: Id, slot: number, partial: Partial<DrumVoiceSettings>, gesture?: string): CommandResult {
  const t = findTrack(store.getState(), trackId);
  if (!t) return NOT_FOUND('part');
  if (t.instrument.kind !== 'drums') return refuse('invalid', 'This part is not a drum kit.');
  if (!Number.isInteger(slot) || slot < 0 || slot >= DRUM_VOICES) return refuse('invalid', 'Unknown drum voice.');
  const next: Partial<DrumVoiceSettings> = {};
  for (const key of ['tune', 'decay', 'level', 'pan'] as const) {
    const v = partial[key];
    if (v === undefined) continue;
    if (!isFiniteNumber(v)) return refuse('invalid', 'Drum settings must be numbers.');
    next[key] = clampParam(DRUM_VOICE_PARAM_SPECS[key], v);
  }
  return run(store, 'track:Change drum voice', (d) => {
    const inst = draftTrack(d, trackId).instrument;
    if (inst.kind === 'drums') Object.assign(inst.voices[slot], next);
  }, gesture);
}

export function setArp(store: ProjectStore, trackId: Id, partial: Partial<ArpSettings>, gesture?: string): CommandResult {
  if (!findTrack(store.getState(), trackId)) return NOT_FOUND('part');
  const next: Partial<ArpSettings> = {};
  if (partial.enabled !== undefined) next.enabled = !!partial.enabled;
  if (partial.latch !== undefined) next.latch = !!partial.latch;
  if (partial.division !== undefined) {
    if (!ARP_DIVISIONS.includes(partial.division)) return refuse('invalid', 'Unknown arpeggiator rate.');
    next.division = partial.division;
  }
  if (partial.mode !== undefined) {
    if (!ARP_MODES.includes(partial.mode)) return refuse('invalid', 'Unknown arpeggiator mode.');
    next.mode = partial.mode;
  }
  if (partial.octaves !== undefined) {
    if (partial.octaves !== 1 && partial.octaves !== 2 && partial.octaves !== 3) return refuse('invalid', 'The arpeggiator spans 1 to 3 octaves.');
    next.octaves = partial.octaves;
  }
  if (partial.gate !== undefined) {
    if (!isFiniteNumber(partial.gate)) return refuse('invalid', 'Gate must be a number.');
    next.gate = clamp(partial.gate, 0.1, 1);
  }
  return run(store, 'track:Change arpeggiator', (d) => {
    Object.assign(draftTrack(d, trackId).arp, next);
  }, gesture);
}

/** Set a big knob (0..1). `opts.display` names the undo step in the calling view's words ("Drums reverb"). */
export function setMacro(store: ProjectStore, trackId: Id, macro: MacroId, value: number, gesture?: string, opts: { display?: string } = {}): CommandResult {
  if (!findTrack(store.getState(), trackId)) return NOT_FOUND('part');
  if (!MACRO_IDS.includes(macro) || !isFiniteNumber(value)) return refuse('invalid', 'Unknown macro.');
  const v = clamp(value, 0, 1);
  return run(store, `track:Change ${macro[0].toUpperCase()}${macro.slice(1)}`, (d) => {
    draftTrack(d, trackId).macros[macro] = v;
  }, gesture, opts.display !== undefined ? { display: opts.display } : {});
}

/** Validate a complete macro target against the project; returns an error message or the cleaned target. */
function cleanTarget(p: Project, t: Partial<MacroTarget>): MacroTarget | string {
  if (typeof t.module !== 'string' || !p.patch.modules.some((m) => m.id === t.module)) return 'That module is not in the patch.';
  const spec = typeof t.param === 'string' ? specById(specsForModule(p, t.module), t.param) : undefined;
  if (!spec) return 'That module has no such control.';
  if (!isFiniteNumber(t.min) || !isFiniteNumber(t.max)) return 'The range must be numbers.';
  const curve = t.curve === 'exp' ? 'exp' : 'lin';
  const min = clampParam(spec, t.min);
  const max = clampParam(spec, t.max);
  if (curve === 'exp' && !(min > 0 && max > 0)) return 'An exponential range must stay above zero.';
  const out: MacroTarget = { module: t.module, param: spec.id, min, max, curve };
  if (t.macroFrom !== undefined) {
    if (!isFiniteNumber(t.macroFrom)) return 'The macro range must be numbers.';
    out.macroFrom = clamp(t.macroFrom, 0, 1);
  }
  if (t.macroTo !== undefined) {
    if (!isFiniteNumber(t.macroTo)) return 'The macro range must be numbers.';
    out.macroTo = clamp(t.macroTo, 0, 1);
  }
  return out;
}

/**
 * Change (index < length) or add (index === length) one target of a macro.
 * A partial update is merged over the existing target and re-validated.
 */
export function setMacroTarget(store: ProjectStore, trackId: Id, macro: MacroId, index: number, partial: Partial<MacroTarget>, gesture?: string): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!MACRO_IDS.includes(macro)) return refuse('invalid', 'Unknown macro.');
  const list = t.macroMap[macro];
  if (!Number.isInteger(index) || index < 0 || index > list.length) return refuse('invalid', 'Unknown macro assignment.');
  if (index === list.length && list.length >= VALIDATION_LIMITS.maxMacroTargets) return refuse('limit', 'This macro already controls as many settings as it can.');
  const cleaned = cleanTarget(p, { ...(list[index] ?? {}), ...partial });
  if (typeof cleaned === 'string') return refuse('invalid', cleaned);
  return run(store, 'track:Change macro assignment', (d) => {
    draftTrack(d, trackId).macroMap[macro][index] = cleaned;
  }, gesture);
}

export function removeMacroTarget(store: ProjectStore, trackId: Id, macro: MacroId, index: number): CommandResult {
  const t = findTrack(store.getState(), trackId);
  if (!t) return NOT_FOUND('part');
  if (!MACRO_IDS.includes(macro) || !Number.isInteger(index) || index < 0 || index >= t.macroMap[macro].length) return refuse('invalid', 'Unknown macro assignment.');
  return run(store, 'track:Remove macro assignment', (d) => {
    draftTrack(d, trackId).macroMap[macro].splice(index, 1);
  });
}

/**
 * The mapping a part's current sound ships with: the default per-slot map,
 * with the preset's own overrides for bass/poly presets.
 */
export function soundMacroMap(track: Track): MacroMap {
  const inst = track.instrument;
  const preset = inst.kind === 'bass' || inst.kind === 'poly' ? PRESETS[inst.presetId] : undefined;
  // Same construction applyPresetToProject uses, so "reset" matches what choosing the sound gives.
  return preset ? presetMacroMap(track.id, preset) : defaultMacroMap(track.id);
}

/* ------------------------------------------------------------------ */
/* Designed values: where double-click returns a knob                  */
/* ------------------------------------------------------------------ */

/** Where a big knob returns to: the position the part's sound or starter was designed with, else the default. */
export function macroHomeFor(track: Pick<Track, 'macroHome'>, macro: MacroId): number {
  const v = track.macroHome?.[macro];
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : defaultMacros()[macro];
}

/**
 * Where a sound knob returns to: the value the part's sound was designed with.
 * `slot` 'inst' (default): an instrument control: a synth preset's own value,
 * a drum kit's matched Level; 'drive', 'filter', 'lfo': the preset's setting
 * of that module. Anything a sound does not set returns to the registry
 * default. Undefined for a control the part's instrument or module does not
 * have.
 */
export function paramHomeFor(track: Pick<Track, 'instrument'>, param: string, slot: TrackSlot = 'inst'): number | undefined {
  const inst = track.instrument;
  if (slot !== 'inst') {
    const type = slot === 'ch' ? 'channel' : slot;
    const spec = specById(MODULE_PARAMS[type], param);
    if (!spec) return undefined;
    const designed = slot === 'ch' || (inst.kind !== 'bass' && inst.kind !== 'poly') ? undefined : PRESETS[inst.presetId]?.modules?.[slot]?.[param];
    return designed === undefined ? spec.default : clampParam(spec, designed);
  }
  const spec = specById(INSTRUMENT_PARAMS[inst.kind], param);
  if (!spec) return undefined;
  let designed: number | undefined;
  if (inst.kind === 'bass' || inst.kind === 'poly') designed = PRESETS[inst.presetId]?.params[param];
  else if (inst.kind === 'drums' && param === 'level') designed = kitInfo(inst.kitId)?.level;
  return designed === undefined ? spec.default : clampParam(spec, designed);
}

/* ------------------------------------------------------------------ */
/* A part's sound, saved and restored                                  */
/* ------------------------------------------------------------------ */

/** A part's sound: its instrument, big knobs (positions, mappings, designed positions) and its modules' settings. */
export interface TrackSound {
  trackId: Id;
  instrument: Instrument;
  macros: MacroValues;
  macroMap: MacroMap;
  macroHome?: Partial<Record<MacroId, number>>;
  /** The part's modules (effects, LFOs, channel) by id: type, settings, on/off. */
  modules: { id: Id; type: ModuleType; params: ParamValues; bypass: boolean }[];
}

/**
 * A detached copy of a part's sound (pure): what the sound browser keeps when
 * it opens, so Cancel can bring the part back exactly as it was. Null when
 * there is no such part.
 */
export function snapshotTrackSound(p: Project, trackId: Id): TrackSound | null {
  const t = findTrack(p, trackId);
  if (!t) return null;
  const snap: TrackSound = {
    trackId,
    instrument: structuredClone(t.instrument),
    macros: { ...t.macros },
    macroMap: structuredClone(t.macroMap),
    modules: p.patch.modules.filter((m) => m.trackId === trackId && m.type !== 'instrument').map((m) => ({ id: m.id, type: m.type, params: { ...m.params }, bypass: m.bypass })),
  };
  if (t.macroHome) snap.macroHome = { ...t.macroHome };
  return snap;
}

/**
 * Put a part's sound back as `snap` captured it, in one undo step: the
 * instrument, the big knobs (positions, mappings to modules that still
 * exist, designed positions) and the settings and on/off of its modules that
 * still exist. The routing is not changed: a module removed since stays
 * removed (`missing` counts them). Nothing to do when the part already
 * sounds like that.
 */
export function restoreTrackSound(store: ProjectStore, trackId: Id, snap: TrackSound): CommandResult & { missing?: number } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!snap || snap.trackId !== trackId || !snap.instrument || !INSTRUMENT_PARAMS[snap.instrument.kind]) return refuse('invalid', 'That saved sound belongs to another part.');
  const ids = new Set(p.patch.modules.map((m) => m.id));
  const macroMap = {} as MacroMap;
  for (const m of MACRO_IDS) macroMap[m] = (snap.macroMap[m] ?? []).filter((x) => ids.has(x.module)).map((x) => ({ ...x }));
  const modules = snap.modules.filter((m) => p.patch.modules.some((x) => x.id === m.id && x.type === m.type && x.trackId === trackId));
  const missing = snap.modules.length - modules.length;
  const unchanged =
    deepEqual(t.instrument, snap.instrument) &&
    deepEqual(t.macros, snap.macros) &&
    deepEqual(t.macroMap, macroMap) &&
    deepEqual(t.macroHome ?? null, snap.macroHome ?? null) &&
    modules.every((m) => {
      const x = p.patch.modules.find((y) => y.id === m.id)!;
      return x.bypass === m.bypass && deepEqual(x.params, m.params);
    });
  if (unchanged) return { changed: false, missing };
  const r = run(store, 'track:Restore sound', (d) => {
    const x = draftTrack(d, trackId);
    x.instrument = structuredClone(snap.instrument);
    x.macros = { ...snap.macros };
    x.macroMap = macroMap;
    if (snap.macroHome) x.macroHome = { ...snap.macroHome };
    else delete x.macroHome;
    for (const m of modules) {
      const mod = d.patch.modules.find((y) => y.id === m.id);
      if (!mod) continue;
      mod.params = { ...m.params };
      mod.bypass = m.bypass;
    }
  });
  return { ...r, missing };
}

/** Restore the macro mapping of the part's current sound, keeping only targets whose module exists. */
export function resetMacroMap(store: ProjectStore, trackId: Id): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  const map = soundMacroMap(t);
  const modules = new Set(p.patch.modules.map((m) => m.id));
  for (const macro of MACRO_IDS) map[macro] = map[macro].filter((x) => modules.has(x.module));
  if (deepEqual(map, t.macroMap)) return { changed: false };
  return run(store, 'track:Reset macro assignments', (d) => {
    draftTrack(d, trackId).macroMap = map;
  });
}
