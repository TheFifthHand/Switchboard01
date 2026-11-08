/**
 * Derived, per-project lookups shared by every knob in the Shape view.
 *
 * `resolveAllParams` / `macroControlledParams` are computed once per project
 * state (cached by object identity) and then read by many narrow selectors,
 * so a knob drag costs one resolution per change instead of one per knob.
 */
import { MODULE_DEFS } from '../../../project/modules';
import { clampParam, formatParam, gateOpen, type ParamSpec } from '../../../project/params';
import { macroControlledParams, resolveAllParams, specsForModule, type MacroControl } from '../../../project/resolve';
import type { Id, MacroTarget, ModuleType, ParamValues, PatchModule, Project } from '../../../project/types';
import { INSERT_DEFAULTS, paramHomeFor } from '../../../state/commands';
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

/** The macro target that sets a parameter (the one `controllerName` names), with its owner and index, or null. */
export function controllingTarget(p: Project, moduleIdStr: Id, param: string): (MacroTarget & { trackId: Id; macro: MacroControl['macro']; index: number }) | null {
  const c = derived(p).controlled.get(`${moduleIdStr}.${param}`);
  if (!c) return null;
  const list = p.tracks.find((t) => t.id === c.trackId)?.macroMap[c.macro] ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].module === moduleIdStr && list[i].param === param) return { ...list[i], trackId: c.trackId, macro: c.macro, index: i };
  }
  return null;
}

/** A part's default module slots, by the suffix of their id ("t3:filter" → 'filter'). */
const DEFAULT_SLOTS = { inst: 'instrument', drive: 'drive', filter: 'filter', lfo: 'lfo', ch: 'channel' } as const;

/** Where a knob's double-click takes it, and why that value. */
export interface KnobHome {
  /** The value double-click (and Delete) returns to. */
  home: number;
  /** 'sound': as the part's sound (preset, kit) designed it; 'effect': where an added effect starts; 'plain': the registry default. */
  kind: 'sound' | 'effect' | 'plain';
}

/**
 * The value a knob returns to (double-click, Delete): what the part's sound
 * was designed with (paramHomeFor: a preset's own value, a kit's matched
 * level) for its instrument and its default Drive, Filter, LFO and channel;
 * where an added effect starts (the value Add effect gives it); otherwise the
 * registry default.
 */
export function knobHome(p: Project, moduleIdStr: Id, param: string, spec: ParamSpec): KnobHome {
  const mod = p.patch.modules.find((m) => m.id === moduleIdStr);
  const plain: KnobHome = { home: spec.default, kind: 'plain' };
  if (!mod) return plain;
  const colon = moduleIdStr.indexOf(':');
  const slot = colon > 0 ? moduleIdStr.slice(colon + 1) : '';
  const track = mod.trackId ? p.tracks.find((t) => t.id === mod.trackId) : undefined;
  if (track && slot in DEFAULT_SLOTS && DEFAULT_SLOTS[slot as keyof typeof DEFAULT_SLOTS] === mod.type) {
    const v = paramHomeFor(track, param, slot as keyof typeof DEFAULT_SLOTS);
    return v === undefined || v === spec.default ? plain : { home: v, kind: 'sound' };
  }
  // A part's added effect starts where Add effect put it; shared returns (no part) have only the plain default.
  const start = track && MODULE_DEFS[mod.type].insertable ? INSERT_DEFAULTS[mod.type]?.[param] : undefined;
  return start === undefined || start === spec.default ? plain : { home: clampParam(spec, start), kind: 'effect' };
}

/** "Double-click returns it to this sound’s 38%; Alt+double-click to the plain default, 25%." (empty when they agree). */
export function homeNote(spec: ParamSpec, h: KnobHome, plain: number = spec.default): string {
  if (h.kind === 'plain' || h.home === plain) return '';
  const at = formatParam(spec, h.home);
  const where = h.kind === 'sound' ? `this sound’s ${at}` : `${at}, where this effect starts`;
  return `Double-click returns it to ${where}; Alt+double-click to the plain default, ${formatParam(spec, plain)}.`;
}

/**
 * Why a gated control does nothing right now (ParamSpec.gate, read against
 * the module's effective values with big knobs applied), or null while it acts.
 */
export function gateReason(p: Project, moduleIdStr: Id, spec: ParamSpec): string | null {
  if (!spec.gate) return null;
  const values = derived(p).resolved.get(moduleIdStr);
  return gateOpen(spec, values, specsForModule(p, moduleIdStr)) ? null : spec.gate.reason;
}

/**
 * A React key for a part's module that is the same for the same role on
 * every part ("t3:drive" and "t4:drive" → "drive", "t4:eq-2" → "eq-2"), so a
 * part switch re-renders a card instead of remounting it. Unique within a part.
 */
export function partKey(moduleIdStr: Id): string {
  const i = moduleIdStr.indexOf(':');
  return i >= 0 ? moduleIdStr.slice(i + 1) : moduleIdStr;
}

/** Array equality by element identity (for selectors that build arrays). */
export function sameItems<T>(a: readonly T[] | null, b: readonly T[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
