/**
 * Derived, per-project lookups shared by every knob in the Shape view.
 *
 * `resolveAllParams` / `macroControlledParams` are computed once per project
 * state (cached by object identity) and then read by many narrow selectors,
 * so a knob drag costs one resolution per change instead of one per knob.
 */
import { MODULE_DEFS } from '../../../project/modules';
import { macroControlledParams, resolveAllParams, type MacroControl } from '../../../project/resolve';
import type { Id, ModuleType, ParamValues, PatchModule, Project } from '../../../project/types';
import { MACRO_SPECS } from '../../macros';

interface Derived {
  controlled: Map<string, MacroControl>;
  resolved: Map<Id, ParamValues>;
  /** "<module>.<port>" of every modulation input a cable from a running (not bypassed) LFO reaches. */
  modulated: Set<string>;
}

const cache = new WeakMap<Project, Derived>();

/**
 * Modulation inputs named differently from the knob they move. Every other
 * input has the id of its parameter ("cutoff", "mix", "width"…).
 */
const PORT_PARAM: Partial<Record<ModuleType, Record<string, string>>> = {
  // The EQ's "Mids" input sweeps the middle band's pitch.
  eq: { mid: 'midFreq' },
};

export function derived(p: Project): Derived {
  let d = cache.get(p);
  if (!d) {
    const modulated = new Set<string>();
    // An LFO switched Off moves nothing (the engine silences its cables).
    const off = new Set(p.patch.modules.filter((m) => m.type === 'lfo' && m.bypass).map((m) => m.id));
    const typeOf = new Map(p.patch.modules.map((m) => [m.id, m.type]));
    for (const c of p.patch.connections) {
      if (off.has(c.from.module)) continue;
      const type = typeOf.get(c.to.module);
      modulated.add(`${c.to.module}.${(type && PORT_PARAM[type]?.[c.to.port]) ?? c.to.port}`);
    }
    d = { controlled: macroControlledParams(p), resolved: resolveAllParams(p), modulated };
    cache.set(p, d);
  }
  return d;
}

/** Name of the macro that controls a parameter ("Tone", or "Bass Tone" for another part's macro), or null. */
export function controllerName(p: Project, moduleIdStr: Id, param: string, ownerTrackId?: Id): string | null {
  const c = derived(p).controlled.get(`${moduleIdStr}.${param}`);
  if (!c) return null;
  const macro = MACRO_SPECS[c.macro].label;
  if (ownerTrackId !== undefined && c.trackId !== ownerTrackId) {
    const other = p.tracks.find((t) => t.id === c.trackId);
    return other ? `${other.name} ${macro}` : macro;
  }
  return macro;
}

/** Effective value (after macros) of a module parameter; undefined when not stored. */
export function effectiveValue(p: Project, moduleIdStr: Id, param: string): number | undefined {
  return derived(p).resolved.get(moduleIdStr)?.[param];
}

/** True when a modulation cable reaches the input that moves this parameter. */
export function isModulated(p: Project, moduleIdStr: Id, param: string): boolean {
  return derived(p).modulated.has(`${moduleIdStr}.${param}`);
}

/** Readable module name: "Drive", "Drive 2", "Reverb (shared)", with a part prefix for other parts' modules. */
export function moduleName(p: Project, mod: PatchModule | undefined, fromTrackId?: Id): string {
  if (!mod) return 'Missing module';
  const def = MODULE_DEFS[mod.type];
  let base = mod.label ?? def.label;
  if (mod.type === 'instrument') base = 'Instrument';
  const suffix = /-(\d+)$/.exec(mod.id);
  if (!mod.label && suffix) base = `${base} ${suffix[1]}`;
  if (!mod.trackId) return mod.type === 'master' ? base : `${base} (shared)`;
  if (fromTrackId !== undefined && mod.trackId !== fromTrackId) {
    const t = p.tracks.find((x) => x.id === mod.trackId);
    return t ? `${t.name} ${base}` : base;
  }
  return base;
}

/** Array equality by element identity (for selectors that build arrays). */
export function sameItems<T>(a: readonly T[] | null, b: readonly T[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
