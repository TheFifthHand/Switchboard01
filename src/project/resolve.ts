/**
 * Macro resolution: turns stored module/instrument params plus macro values
 * into the effective parameter values the engine should use.
 *
 * A parameter targeted by a macro is controlled by that macro (the stored
 * base value is ignored while mapped). The UI shows such params as
 * "controlled by <Macro>".
 */
import { INSTRUMENT_PARAMS, MODULE_PARAMS, clampParam, specById, type ParamSpec } from './params';
import type { Id, MacroId, MacroTarget, ParamValues, PatchModule, Project, Track } from './types';
import { MACRO_IDS } from './types';

/** Value of a macro target for macro position m (0..1). */
export function macroTargetValue(target: MacroTarget, m: number): number {
  const from = target.macroFrom ?? 0;
  const to = target.macroTo ?? 1;
  const span = to - from;
  let t = span <= 0 ? (m >= to ? 1 : 0) : (m - from) / span;
  t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  if (target.curve === 'exp' && target.min > 0 && target.max > 0) {
    return target.min * Math.pow(target.max / target.min, t);
  }
  return target.min + (target.max - target.min) * t;
}

/** Parameter specs for a module id within a project (instrument modules use their instrument's specs). */
export function specsForModule(project: Project, moduleIdStr: Id): readonly ParamSpec[] {
  const mod = project.patch.modules.find((m) => m.id === moduleIdStr);
  if (!mod) return [];
  if (mod.type === 'instrument') {
    const track = project.tracks.find((t) => t.id === mod.trackId);
    return track ? INSTRUMENT_PARAMS[track.instrument.kind] : [];
  }
  return MODULE_PARAMS[mod.type];
}

export interface MacroControl {
  trackId: Id;
  macro: MacroId;
}

/** Map "moduleId.param" -> the macro controlling it, for UI badges. */
export function macroControlledParams(project: Project): Map<string, MacroControl> {
  const out = new Map<string, MacroControl>();
  for (const track of project.tracks) {
    for (const macro of MACRO_IDS) {
      for (const t of track.macroMap[macro] ?? []) out.set(`${t.module}.${t.param}`, { trackId: track.id, macro });
    }
  }
  return out;
}

function applyMacroOverrides(project: Project, into: Map<Id, ParamValues>, overrides?: Partial<Record<Id, Partial<Record<MacroId, number>>>>): void {
  for (const track of project.tracks) {
    for (const macro of MACRO_IDS) {
      const m = overrides?.[track.id]?.[macro] ?? track.macros[macro];
      for (const target of track.macroMap[macro] ?? []) {
        const params = into.get(target.module);
        if (!params) continue;
        const specs = specsForModule(project, target.module);
        const spec = specById(specs, target.param);
        const v = macroTargetValue(target, m);
        params[target.param] = spec ? clampParam(spec, v) : v;
      }
    }
  }
}

/**
 * Effective params for every patch module, keyed by module id. Instrument
 * modules ("<track>:inst") resolve to the instrument's params.
 */
export function resolveAllParams(project: Project, macroOverrides?: Partial<Record<Id, Partial<Record<MacroId, number>>>>): Map<Id, ParamValues> {
  const out = new Map<Id, ParamValues>();
  for (const mod of project.patch.modules) {
    if (mod.type === 'instrument') {
      const track = project.tracks.find((t) => t.id === mod.trackId);
      out.set(mod.id, { ...(track?.instrument.params ?? {}) });
    } else {
      out.set(mod.id, { ...mod.params });
    }
  }
  applyMacroOverrides(project, out, macroOverrides);
  return out;
}

/** Effective params for one module. */
export function resolveModuleParams(project: Project, mod: PatchModule): ParamValues {
  return resolveAllParams(project).get(mod.id) ?? { ...mod.params };
}

/** The targets a macro moves, with human-readable descriptions (for the Shape inspector). */
export function describeMacro(project: Project, track: Track, macro: MacroId): { target: MacroTarget; label: string; spec?: ParamSpec }[] {
  return (track.macroMap[macro] ?? []).map((target) => {
    const mod = project.patch.modules.find((m) => m.id === target.module);
    const spec = specById(specsForModule(project, target.module), target.param);
    const modName = mod ? (mod.type === 'instrument' ? 'Instrument' : mod.label ?? mod.type[0].toUpperCase() + mod.type.slice(1)) : target.module;
    return { target, spec, label: `${modName} ${spec?.label ?? target.param}` };
  });
}
