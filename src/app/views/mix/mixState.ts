/**
 * Per-project lookups for the Mix view, computed once per project state
 * (cached by object identity) and read by narrow selectors in each strip.
 */
import { MODULE_DEFS } from '../../../project/modules';
import { trackChain } from '../../../project/graph';
import { moduleId } from '../../../project/factory';
import { CHANNEL_PARAMS, MODULE_PARAMS, readParam } from '../../../project/params';
import { macroControlledParams, resolveAllParams, type MacroControl } from '../../../project/resolve';
import type { Id, MacroId, ParamValues, PatchModule, Project } from '../../../project/types';
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

/** Effective (after macros) parameter of any module; its default when the module is gone. */
export function moduleValue(p: Project, id: Id, param: string): number {
  const m = p.patch.modules.find((x) => x.id === id);
  const specs = m ? MODULE_PARAMS[m.type] : [];
  return readParam(specs, derived(p).resolved.get(id), param);
}

/** The macro that sets a module parameter (its part and which big knob), or null. */
export function macroFor(p: Project, id: Id, param: string): MacroControl | null {
  return derived(p).controlled.get(`${id}.${param}`) ?? null;
}

/** Name of the macro controlling a module parameter ("Space", or "Bass Space" for another part's), or null. */
export function controllerName(p: Project, ownerTrackId: Id | null, id: Id, param: string): string | null {
  const c = macroFor(p, id, param);
  if (!c) return null;
  const macro = MACRO_SPECS[c.macro].label;
  if (c.trackId === ownerTrackId) return macro;
  const owner = p.tracks.find((t) => t.id === c.trackId);
  return owner ? `${owner.name} ${macro}` : macro;
}

/** Name of the macro controlling a channel parameter ("Space", or "Bass Space" for another part's), or null. */
export function channelController(p: Project, trackId: Id, param: string): string | null {
  const id = channelOf(p, trackId);
  return id ? controllerName(p, trackId, id, param) : null;
}

/** True when a modulation cable reaches the channel input of that name (level / pan). */
export function channelModulated(p: Project, trackId: Id, port: string): boolean {
  const id = channelOf(p, trackId);
  return !!id && derived(p).modulated.has(`${id}.${port}`);
}

/**
 * The big knob a part's send amount follows in Mix: the part's own Space
 * (Reverb) or Echo macro when that macro sets the send, null when the send has
 * no macro of its own (its mapping was removed, or another part's macro sets
 * it), in which case Mix shows the send amount itself.
 */
export function sendMacro(p: Project, trackId: Id, send: 'sendA' | 'sendB'): MacroId | null {
  const id = channelOf(p, trackId);
  const c = id ? macroFor(p, id, send) : null;
  return c && c.trackId === trackId ? c.macro : null;
}

export interface EffectItem {
  id: Id;
  name: string;
  bypass: boolean;
  /**
   * Why the effect changes nothing right now, or null when it is in use:
   * switched off, or set so that nothing of it is heard (a Drive at 0, a flat
   * EQ, a Mix of 0).
   */
  idle: string | null;
}

/** Why an insert is not doing anything at its current (effective) settings, or null. */
function idleReason(m: PatchModule, v: ParamValues | undefined): string | null {
  if (m.bypass) return 'it is switched off';
  const specs = MODULE_PARAMS[m.type];
  const at = (param: string) => readParam(specs, v, param);
  if (m.type === 'drive' && at('amount') <= 0) return 'its Drive is at 0';
  if (m.type === 'eq' && at('lowCut') <= 20 && at('highCut') >= 20000 && at('lowGain') === 0 && at('midGain') === 0 && at('highGain') === 0) return 'it is flat: every band is at 0 dB';
  if (specs.some((s) => s.id === 'mix') && at('mix') <= 0) return 'its Mix is at 0';
  return null;
}

/** A part's insert effects: in signal order when the chain is linear, then any others it owns. */
export function partEffects(p: Project, trackId: Id): EffectItem[] {
  const own = p.patch.modules.filter((m) => m.trackId === trackId && MODULE_DEFS[m.type].family === 'effect');
  const chain = trackChain(p.patch, trackId)?.slice(1, -1) ?? [];
  const ordered = [...chain.map((id) => own.find((m) => m.id === id)).filter((m): m is PatchModule => m !== undefined), ...own.filter((m) => !chain.includes(m.id))];
  const resolved = derived(p).resolved;
  return ordered.map((m) => {
    const n = /-(\d+)$/.exec(m.id);
    const base = m.label ?? MODULE_DEFS[m.type].label;
    return { id: m.id, name: !m.label && n ? `${base} ${n[1]}` : base, bypass: m.bypass, idle: idleReason(m, resolved.get(m.id)) };
  });
}

export function sameEffects(a: readonly EffectItem[], b: readonly EffectItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.bypass === b[i].bypass && x.idle === b[i].idle);
}

/** How many insert effects a part's chain holds (null: custom routing, effects are placed by cable). */
export function chainEffectCount(p: Project, trackId: Id): number | null {
  const chain = trackChain(p.patch, trackId);
  return chain ? chain.length - 2 : null;
}
