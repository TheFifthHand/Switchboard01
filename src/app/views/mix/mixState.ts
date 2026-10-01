/**
 * Per-project lookups for the Mix view, computed once per project state
 * (cached by object identity) and read by narrow selectors in each strip.
 */
import { MODULE_DEFS } from '../../../project/modules';
import { trackChain } from '../../../project/graph';
import { moduleId } from '../../../project/factory';
import { CHANNEL_PARAMS, readParam } from '../../../project/params';
import { macroControlledParams, resolveAllParams, type MacroControl } from '../../../project/resolve';
import type { Id, ParamValues, PatchModule, Project } from '../../../project/types';
import { MACRO_SPECS } from '../../macros';

interface Derived {
  controlled: Map<string, MacroControl>;
  resolved: Map<Id, ParamValues>;
  /** "<module>.<port>" of every modulation input a cable from a running LFO reaches. */
  modulated: Set<string>;
}

const cache = new WeakMap<Project, Derived>();

function derived(p: Project): Derived {
  let d = cache.get(p);
  if (!d) {
    const off = new Set(p.patch.modules.filter((m) => m.type === 'lfo' && m.bypass).map((m) => m.id));
    const modulated = new Set<string>();
    for (const c of p.patch.connections) if (!off.has(c.from.module)) modulated.add(`${c.to.module}.${c.to.port}`);
    d = { controlled: macroControlledParams(p), resolved: resolveAllParams(p), modulated };
    cache.set(p, d);
  }
  return d;
}

/** The part's channel module id ("t3:ch"), or null when the patch has none. */
export function channelOf(p: Project, trackId: Id): Id | null {
  const id = moduleId.channel(trackId);
  return p.patch.modules.some((m) => m.id === id && m.type === 'channel') ? id : null;
}

/** Effective (after macros) channel parameter of a part. */
export function channelValue(p: Project, trackId: Id, param: string): number {
  const id = channelOf(p, trackId);
  if (!id) return readParam(CHANNEL_PARAMS, undefined, param);
  return readParam(CHANNEL_PARAMS, derived(p).resolved.get(id), param);
}

/** Name of the macro controlling a channel parameter ("Space", or "Bass Space" for another part's), or null. */
export function channelController(p: Project, trackId: Id, param: string): string | null {
  const id = channelOf(p, trackId);
  const c = id ? derived(p).controlled.get(`${id}.${param}`) : undefined;
  if (!c) return null;
  const macro = MACRO_SPECS[c.macro].label;
  if (c.trackId === trackId) return macro;
  const owner = p.tracks.find((t) => t.id === c.trackId);
  return owner ? `${owner.name} ${macro}` : macro;
}

/** True when a modulation cable reaches the channel input of that name (level / pan). */
export function channelModulated(p: Project, trackId: Id, port: string): boolean {
  const id = channelOf(p, trackId);
  return !!id && derived(p).modulated.has(`${id}.${port}`);
}

export interface EffectItem {
  id: Id;
  name: string;
  bypass: boolean;
}

/** A part's insert effects: in signal order when the chain is linear, then any others it owns. */
export function partEffects(p: Project, trackId: Id): EffectItem[] {
  const own = p.patch.modules.filter((m) => m.trackId === trackId && MODULE_DEFS[m.type].family === 'effect');
  const chain = trackChain(p.patch, trackId)?.slice(1, -1) ?? [];
  const ordered = [...chain.map((id) => own.find((m) => m.id === id)).filter((m): m is PatchModule => m !== undefined), ...own.filter((m) => !chain.includes(m.id))];
  return ordered.map((m) => {
    const n = /-(\d+)$/.exec(m.id);
    const base = m.label ?? MODULE_DEFS[m.type].label;
    return { id: m.id, name: !m.label && n ? `${base} ${n[1]}` : base, bypass: m.bypass };
  });
}

export function sameEffects(a: readonly EffectItem[], b: readonly EffectItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.bypass === b[i].bypass);
}
