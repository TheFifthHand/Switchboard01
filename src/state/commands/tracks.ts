/** Per-part edits: name, mute/solo/lock, sound, instrument params, drum voices, arp, macros. */
import { builtinSampleInfo, kitInfo, presetInfo } from '../../content/catalog';
import { PRESETS, applyKitToProject, applyPresetToProject, applySamplerToProject } from '../../content/presets';
import { defaultMacroMap } from '../../project/factory';
import { DRUM_VOICE_PARAM_SPECS, INSTRUMENT_PARAMS, clampParam, specById } from '../../project/params';
import { specsForModule } from '../../project/resolve';
import {
  DRUM_VOICES,
  MACRO_IDS,
  type ArpSettings,
  type DrumVoiceSettings,
  type Id,
  type InstrumentKind,
  type MacroId,
  type MacroMap,
  type MacroTarget,
  type Project,
  type Track,
} from '../../project/types';
import { ARP_DIVISIONS, ARP_MODES, VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, cleanName, draftTrack, findTrack, isFiniteNumber, refuse, run, type CommandResult } from './common';

export function renameTrack(store: ProjectStore, trackId: Id, name: string): CommandResult {
  if (!findTrack(store.getState(), trackId)) return NOT_FOUND('part');
  const n = cleanName(name, 60);
  if (!n) return refuse('invalid', 'A part needs a name.');
  return run(store, 'track:Rename part', (d) => {
    draftTrack(d, trackId).name = n;
  });
}

export function setMute(store: ProjectStore, trackId: Id, mute: boolean): CommandResult {
  if (!findTrack(store.getState(), trackId)) return NOT_FOUND('part');
  return run(store, mute ? 'track:Mute part' : 'track:Unmute part', (d) => {
    draftTrack(d, trackId).mute = !!mute;
  });
}

export function setSolo(store: ProjectStore, trackId: Id, solo: boolean): CommandResult {
  if (!findTrack(store.getState(), trackId)) return NOT_FOUND('part');
  return run(store, solo ? 'track:Solo part' : 'track:Unsolo part', (d) => {
    draftTrack(d, trackId).solo = !!solo;
  });
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

export function setArp(store: ProjectStore, trackId: Id, partial: Partial<ArpSettings>): CommandResult {
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
  });
}

export function setMacro(store: ProjectStore, trackId: Id, macro: MacroId, value: number, gesture?: string): CommandResult {
  if (!findTrack(store.getState(), trackId)) return NOT_FOUND('part');
  if (!MACRO_IDS.includes(macro) || !isFiniteNumber(value)) return refuse('invalid', 'Unknown macro.');
  const v = clamp(value, 0, 1);
  return run(store, `track:Change ${macro[0].toUpperCase()}${macro.slice(1)}`, (d) => {
    draftTrack(d, trackId).macros[macro] = v;
  }, gesture);
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
export function setMacroTarget(store: ProjectStore, trackId: Id, macro: MacroId, index: number, partial: Partial<MacroTarget>): CommandResult {
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
  });
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
  const map = defaultMacroMap(track.id);
  const inst = track.instrument;
  if (inst.kind === 'bass' || inst.kind === 'poly') {
    const preset = PRESETS[inst.presetId];
    for (const macro of MACRO_IDS) {
      const targets = preset?.macroMap?.[macro];
      if (!targets) continue;
      map[macro] = targets.map(({ slot, ...rest }) => ({ ...rest, module: `${track.id}:${slot}` }));
    }
  }
  return map;
}

/** Restore the macro mapping of the part's current sound, keeping only targets whose module exists. */
export function resetMacroMap(store: ProjectStore, trackId: Id): CommandResult {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  const map = soundMacroMap(t);
  const modules = new Set(p.patch.modules.map((m) => m.id));
  for (const macro of MACRO_IDS) map[macro] = map[macro].filter((x) => modules.has(x.module));
  return run(store, 'track:Reset macro assignments', (d) => {
    draftTrack(d, trackId).macroMap = map;
  });
}
