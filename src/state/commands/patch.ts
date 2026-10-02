/**
 * Routing edits shared by the effects rack and the cable panel, what a big
 * knob reaches, and copying a part's effects to another part.
 *
 * Every routing edit is labelled "patch:..." so the edit lock refuses it
 * during a performance take. Module parameter changes are labelled
 * "module:..." instead: they are knob movements, which a take records as
 * param events, so they stay available while recording.
 *
 * Validation always runs against the current patch before anything changes;
 * a rejected connect/move leaves the patch exactly as it was.
 */
import { PRESETS, type TrackSlot } from '../../content/presets';
import { MASTER_ID, conn, createModule, defaultPatch, defaultSharedConnections, defaultSharedModules, defaultTrackPatch, moduleId } from '../../project/factory';
import {
  CONNECTION_MESSAGES,
  applyChain,
  endpointKey,
  findModule,
  freeModuleId,
  outputPortDef,
  removeModuleFromPatch,
  sameRef,
  trackChain,
  validateConnection,
  type ConnectionCheck,
} from '../../project/graph';
import { MODULE_DEFS, PATCH_LIMITS, portDef } from '../../project/modules';
import { INSTRUMENT_PARAMS, MODULE_PARAMS, clampParam, specById } from '../../project/params';
import { resolveModuleParams } from '../../project/resolve';
import { MACRO_IDS, type Connection, type Id, type MacroId, type MacroTarget, type ModuleType, type ParamValues, type Patch, type PatchModule, type PortRef, type Project, type Track } from '../../project/types';
import { VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, deepEqual, draftTrack, findTrack, isFiniteNumber, partName, refuse, run, type CommandResult } from './common';
import { soundMacroMap } from './tracks';

export type PatchResult = ConnectionCheck & { connectionId?: Id };

/** Extra LFOs per part (besides the default one). */
export const MAX_EXTRA_LFOS = PATCH_LIMITS.maxExtraLfosPerTrack;

/**
 * Starting params for effects inserted into a chain. Delay and reverb default
 * to 100% wet (right for a send return); as inserts they start partly wet so
 * the dry sound is kept. Effects whose registry defaults are transparent
 * (drive at 0, an open filter, a 16-bit crusher) start with a moderate
 * setting instead, so adding one is heard straight away; the EQ starts flat
 * on purpose (it is a tool for the user's own changes).
 */
export const INSERT_DEFAULTS: Partial<Record<ModuleType, ParamValues>> = {
  delay: { mix: 0.3 },
  reverb: { mix: 0.25 },
  drive: { amount: 0.35 },
  filter: { cutoff: 2400 },
  crusher: { bits: 8, downsample: 3 },
};

const LOCKED: ConnectionCheck = { ok: false, code: 'locked', message: CONNECTION_MESSAGES.locked };

function lockedResult(store: ProjectStore): CommandResult | null {
  const lock = store.getLock();
  return lock === null ? null : { changed: false, refused: lock, reason: 'locked', message: CONNECTION_MESSAGES.locked };
}

/* ------------------------------------------------------------------ */
/* Cables                                                              */
/* ------------------------------------------------------------------ */

/** Connect an output to an input. Returns the validation result; the patch changes only when ok. */
export function connect(store: ProjectStore, from: PortRef, to: PortRef, amount?: number): PatchResult {
  if (store.getLock() !== null) return LOCKED;
  const patch = store.getState().patch;
  const check = validateConnection(patch, from, to);
  if (!check.ok) return check;
  const kind = outputPortDef(patch, from)!.kind;
  const c = conn(from.module, from.port, to.module, to.port, kind === 'mod' ? clamp(isFiniteNumber(amount) ? amount : 1, -1, 1) : undefined);
  const r = store.apply('patch:Connect cable', (d) => {
    d.patch.connections.push(c);
  });
  if (r.refused) return LOCKED;
  return { ok: true, connectionId: c.id };
}

export function disconnect(store: ProjectStore, connectionId: Id): CommandResult {
  const locked = lockedResult(store);
  if (locked) return locked;
  if (!store.getState().patch.connections.some((c) => c.id === connectionId)) return NOT_FOUND('cable');
  return run(store, 'patch:Disconnect cable', (d) => {
    d.patch.connections = d.patch.connections.filter((c) => c.id !== connectionId);
  });
}

/**
 * Move one or both ends of a cable. The new route is validated against the
 * patch without the old cable; on failure the old cable stays untouched.
 * The cable keeps its id.
 */
export function moveConnection(store: ProjectStore, connectionId: Id, ends: { from?: PortRef; to?: PortRef }): PatchResult {
  if (store.getLock() !== null) return LOCKED;
  const patch = store.getState().patch;
  const existing = patch.connections.find((c) => c.id === connectionId);
  if (!existing) return { ok: false, code: 'unknown-module', message: 'That cable no longer exists.' };
  const from = ends.from ?? existing.from;
  const to = ends.to ?? existing.to;
  if (sameRef(from, existing.from) && sameRef(to, existing.to)) return { ok: true, connectionId };
  const check = validateConnection(patch, from, to, { ignoreConnectionId: connectionId });
  if (!check.ok) return check;
  const kind = outputPortDef(patch, from)!.kind;
  const r = store.apply('patch:Move cable', (d) => {
    const c = d.patch.connections.find((x) => x.id === connectionId);
    if (!c) return;
    c.from = { module: from.module, port: from.port };
    c.to = { module: to.module, port: to.port };
    if (kind === 'mod') c.amount = c.amount ?? 1;
    else delete c.amount;
  });
  if (r.refused) return LOCKED;
  return { ok: true, connectionId };
}

/** Modulation depth of a cable, -1..1. */
export function setConnectionAmount(store: ProjectStore, connectionId: Id, amount: number, gesture?: string): CommandResult {
  const locked = lockedResult(store);
  if (locked) return locked;
  const patch = store.getState().patch;
  const c = patch.connections.find((x) => x.id === connectionId);
  if (!c) return NOT_FOUND('cable');
  if (outputPortDef(patch, c.from)?.kind !== 'mod') return refuse('invalid', 'Only modulation cables have an amount.');
  if (!isFiniteNumber(amount)) return refuse('invalid', 'The amount must be a number.');
  const v = clamp(amount, -1, 1);
  return run(store, 'patch:Change modulation amount', (d) => {
    const x = d.patch.connections.find((q) => q.id === connectionId);
    if (x) x.amount = v;
  }, gesture);
}

/* ------------------------------------------------------------------ */
/* Module settings                                                     */
/* ------------------------------------------------------------------ */

/**
 * Set a module parameter (clamped through the registry). Instrument modules
 * ("<t>:inst") set the part's instrument parameters.
 */
export function setModuleParam(store: ProjectStore, moduleIdStr: Id, param: string, value: number, gesture?: string): CommandResult {
  const p = store.getState();
  const mod = findModule(p.patch, moduleIdStr);
  if (!mod) return NOT_FOUND('module');
  if (!isFiniteNumber(value)) return refuse('invalid', 'The value must be a number.');
  if (mod.type === 'instrument') {
    const track = mod.trackId ? findTrack(p, mod.trackId) : undefined;
    const spec = track ? specById(INSTRUMENT_PARAMS[track.instrument.kind], param) : undefined;
    if (!track || !spec) return refuse('invalid', 'This module has no such control.');
    const v = clampParam(spec, value);
    return run(store, `module:Change ${spec.label}`, (d) => {
      draftTrack(d, track.id).instrument.params[param] = v;
    }, gesture);
  }
  const spec = specById(MODULE_PARAMS[mod.type], param);
  if (!spec) return refuse('invalid', 'This module has no such control.');
  const v = clampParam(spec, value);
  // A part's channel (the Mix view's fader, pan and sends): the undo step names the part ("Bass level").
  const display = mod.type === 'channel' && mod.trackId ? `${partName(p, mod.trackId)} ${spec.label.toLowerCase()}` : undefined;
  return run(store, `module:Change ${MODULE_DEFS[mod.type].label} ${spec.label}`, (d) => {
    const m = d.patch.modules.find((x) => x.id === moduleIdStr);
    if (m) m.params[param] = v;
  }, gesture, display !== undefined ? { display } : {});
}

/** Bypass an effect or LFO (sound passes through unprocessed / no movement). */
export function setBypass(store: ProjectStore, moduleIdStr: Id, bypass: boolean): CommandResult {
  const locked = lockedResult(store);
  if (locked) return locked;
  const mod = findModule(store.getState().patch, moduleIdStr);
  if (!mod) return NOT_FOUND('module');
  if (MODULE_DEFS[mod.type].protected) return refuse('protected', 'This module cannot be bypassed.');
  return run(store, bypass ? 'patch:Bypass effect' : 'patch:Turn effect back on', (d) => {
    const m = d.patch.modules.find((x) => x.id === moduleIdStr);
    if (m) m.bypass = !!bypass;
  });
}

/* ------------------------------------------------------------------ */
/* Effects rack                                                        */
/* ------------------------------------------------------------------ */

const NOT_LINEAR_MESSAGE = "This part has custom routing, so the rack can't place effects automatically. Use the cable panel, or restore the part's default routing.";

/** Insert position among the modules array: after the part's last module, for a tidy order. */
function moduleInsertIndex(patch: Patch, trackId: Id): number {
  let idx = -1;
  patch.modules.forEach((m, i) => {
    if (m.trackId === trackId) idx = i;
  });
  return idx >= 0 ? idx + 1 : patch.modules.length;
}

/** Remove macro targets that point at modules no longer in the patch. */
function dropDanglingMacroTargets(d: Project): void {
  const ids = new Set(d.patch.modules.map((m) => m.id));
  for (const t of d.tracks) {
    for (const macro of MACRO_IDS) {
      if (t.macroMap[macro].some((x) => !ids.has(x.module))) t.macroMap[macro] = t.macroMap[macro].filter((x) => ids.has(x.module));
    }
  }
}

/**
 * The cable from a part's default LFO to a new filter's cutoff, exactly as the
 * default patch has it, when that LFO exists and has no outgoing cable (its
 * only cable went with a removed filter): so Motion moves the filter again.
 */
function lfoCableFor(patch: Patch, trackId: Id, filterId: Id): Connection | null {
  const lfo = moduleId.lfo(trackId);
  const m = findModule(patch, lfo);
  if (!m || m.type !== 'lfo' || patch.connections.some((c) => c.from.module === lfo)) return null;
  return validateConnection(patch, { module: lfo, port: 'out' }, { module: filterId, port: 'cutoff' }).ok ? conn(lfo, 'out', filterId, 'cutoff', 1) : null;
}

/** A module id a part's sound designs big-knob mappings for (its default Drive or Filter slot). */
function isDesignSlot(trackId: Id, id: Id): boolean {
  return id === moduleId.drive(trackId) || id === moduleId.filter(trackId);
}

/**
 * Insert a new effect into a part's linear chain at `index` among its
 * effects (default: last, just before the channel). An effect that takes
 * back the part's default Drive or Filter slot (the default one was removed)
 * gets the big-knob mappings the part's sound designs for it again (the
 * Drive big knob drives a re-added Drive; Tone and Motion move a re-added
 * Filter). A filter added to a part whose LFO has no cable left is cabled
 * to it as in the default patch.
 */
export function insertEffect(store: ProjectStore, trackId: Id, type: ModuleType, index?: number): CommandResult & { moduleId?: Id } {
  const locked = lockedResult(store);
  if (locked) return locked;
  const p = store.getState();
  if (!findTrack(p, trackId)) return NOT_FOUND('part');
  if (!MODULE_DEFS[type]?.insertable) return refuse('invalid', 'That is not an effect.');
  const chain = trackChain(p.patch, trackId);
  if (!chain) return refuse('not-linear', NOT_LINEAR_MESSAGE);
  const effects = chain.slice(1, -1);
  if (effects.length >= PATCH_LIMITS.maxEffectsPerTrack) return refuse('limit', `A part can have up to ${PATCH_LIMITS.maxEffectsPerTrack} effects.`);
  if (p.patch.modules.length >= PATCH_LIMITS.maxModules) return refuse('limit', 'The patch already has as many modules as it can hold.');
  const at = index === undefined || !Number.isFinite(index) ? effects.length : clamp(Math.round(index), 0, effects.length);
  const id = freeModuleId(p.patch, trackId, type);
  const mod = createModule(id, type, trackId, INSERT_DEFAULTS[type]);
  const lfoCable = type === 'filter' ? lfoCableFor({ modules: [...p.patch.modules, mod], connections: p.patch.connections }, trackId, id) : null;
  if (p.patch.connections.length + 1 + (lfoCable ? 1 : 0) > PATCH_LIMITS.maxConnections) return refuse('limit', CONNECTION_MESSAGES.limit);
  const newChain = [chain[0], ...effects.slice(0, at), id, ...effects.slice(at), chain[chain.length - 1]];
  const r = run(store, `patch:Add ${MODULE_DEFS[type].label}`, (d) => {
    d.patch.modules.splice(moduleInsertIndex(d.patch, trackId), 0, mod);
    applyChain(d.patch, chain, newChain);
    if (lfoCable) d.patch.connections.push(lfoCable);
    if (isDesignSlot(trackId, id)) refillMacros(d, [trackId], new Set([id]));
  });
  return { ...r, moduleId: id };
}

/**
 * Remove an effect or LFO. The sound that fed it is reconnected to where it
 * went, so removing an effect from a chain keeps the part audible. Macro
 * targets on the module are removed with it. Protected modules stay.
 * `affectedMacros`: the owning part's big knobs that moved something heard
 * before and move nothing now (a removed Drive leaves the Drive big knob
 * with nothing to drive; a removed Filter takes the LFO's only cable, so
 * Motion moves nothing), for the message to name.
 */
export function removeEffect(store: ProjectStore, moduleIdStr: Id): CommandResult & { affectedMacros?: MacroId[] } {
  const locked = lockedResult(store);
  if (locked) return locked;
  const p = store.getState();
  const mod = findModule(p.patch, moduleIdStr);
  if (!mod) return NOT_FOUND('module');
  if (MODULE_DEFS[mod.type].protected) return refuse('protected', 'The instrument, channel and master output are always part of the patch.');
  const recipe = (d: Project) => {
    removeModuleFromPatch(d.patch, moduleIdStr);
    dropDanglingMacroTargets(d);
  };
  const before = mod.trackId ? MACRO_IDS.filter((m) => macroReach(p, mod.trackId!, m) === 'audible') : [];
  const r = run(store, `patch:Remove ${MODULE_DEFS[mod.type].label}`, recipe);
  if (!r.changed || !mod.trackId) return r;
  const after = store.getState();
  return { ...r, affectedMacros: before.filter((m) => macroReach(after, mod.trackId!, m) === 'none') };
}

/* ------------------------------------------------------------------ */
/* What a big knob reaches                                             */
/* ------------------------------------------------------------------ */

/** Modules whose sound reaches the master output through audio cables (the master included). */
function audibleModules(patch: Patch): Set<Id> {
  const audible = new Set<Id>([MASTER_ID]);
  const audio = patch.connections.filter((c) => {
    const from = findModule(patch, c.from.module);
    return !!from && portDef(from.type, c.from.port, 'out')?.kind === 'audio';
  });
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of audio) {
      if (audible.has(c.to.module) && !audible.has(c.from.module)) {
        audible.add(c.from.module);
        grew = true;
      }
    }
  }
  return audible;
}

/** Whether moving `target` changes what is heard (see macroReach). */
function targetReaches(patch: Patch, audible: ReadonlySet<Id>, target: MacroTarget): boolean {
  if (target.min === target.max) return false;
  const mod = findModule(patch, target.module);
  if (!mod) return false;
  if (mod.type === 'lfo') {
    // An LFO is heard only through a cable into a module that is heard (and not switched off).
    if (mod.bypass) return false;
    return patch.connections.some((c) => {
      if (c.from.module !== mod.id || (c.amount ?? 1) === 0) return false;
      const to = findModule(patch, c.to.module);
      return !!to && !to.bypass && audible.has(to.id);
    });
  }
  if (mod.bypass || !audible.has(mod.id)) return false;
  if (mod.type === 'channel' && (target.param === 'sendA' || target.param === 'sendB')) {
    // A send is heard only when its output is cabled to something heard.
    return patch.connections.some((c) => c.from.module === mod.id && c.from.port === target.param && audible.has(c.to.module));
  }
  return true;
}

/**
 * Whether a part's big knob changes what is heard: 'audible' when at least
 * one of its targets does, 'none' when it has no targets, or every target is
 * inert: its module is gone, switched off or not heard (no path to the
 * output), its range does not move, it is an LFO whose cables reach nothing
 * heard (an LFO-depth target whose LFO lost its cable), or a send cabled
 * nowhere. Pure.
 */
export function macroReach(p: Project, trackId: Id, macro: MacroId): 'audible' | 'none' {
  const t = findTrack(p, trackId);
  const targets = t?.macroMap[macro] ?? [];
  if (!targets.length) return 'none';
  const audible = audibleModules(p.patch);
  return targets.some((x) => targetReaches(p.patch, audible, x)) ? 'audible' : 'none';
}

/** Move an effect to a new position (index among the part's effects) in its linear chain. */
export function moveEffect(store: ProjectStore, moduleIdStr: Id, newIndex: number): CommandResult {
  const locked = lockedResult(store);
  if (locked) return locked;
  const p = store.getState();
  const mod = findModule(p.patch, moduleIdStr);
  if (!mod || !mod.trackId) return NOT_FOUND('effect');
  if (MODULE_DEFS[mod.type].family !== 'effect') return refuse('invalid', 'Only effects in the rack can be moved.');
  const chain = trackChain(p.patch, mod.trackId);
  if (!chain) return refuse('not-linear', NOT_LINEAR_MESSAGE);
  const effects = chain.slice(1, -1);
  const from = effects.indexOf(moduleIdStr);
  if (from < 0) return refuse('not-linear', NOT_LINEAR_MESSAGE);
  if (!Number.isFinite(newIndex)) return refuse('invalid', 'Unknown position.');
  const to = clamp(Math.round(newIndex), 0, effects.length - 1);
  if (to === from) return { changed: false };
  const reordered = effects.filter((e) => e !== moduleIdStr);
  reordered.splice(to, 0, moduleIdStr);
  const newChain = [chain[0], ...reordered, chain[chain.length - 1]];
  return run(store, `patch:Move ${MODULE_DEFS[mod.type].label}`, (d) => {
    applyChain(d.patch, chain, newChain);
  });
}

/** Add an extra LFO to a part (not connected; patch it in the cable panel). */
export function addLfo(store: ProjectStore, trackId: Id): CommandResult & { moduleId?: Id } {
  const locked = lockedResult(store);
  if (locked) return locked;
  const p = store.getState();
  if (!findTrack(p, trackId)) return NOT_FOUND('part');
  const extra = p.patch.modules.filter((m) => m.type === 'lfo' && m.trackId === trackId && m.id !== moduleId.lfo(trackId)).length;
  if (extra >= MAX_EXTRA_LFOS) return refuse('limit', `A part can have up to ${MAX_EXTRA_LFOS} extra LFOs.`);
  if (p.patch.modules.length >= PATCH_LIMITS.maxModules) return refuse('limit', 'The patch already has as many modules as it can hold.');
  const id = freeModuleId(p.patch, trackId, 'lfo');
  // Unlike the default LFO (driven by the Motion macro), an extra LFO starts
  // with audible depth so patching it has an immediate effect.
  const mod = createModule(id, 'lfo', trackId, { depth: 0.5 });
  const r = run(store, 'patch:Add LFO', (d) => {
    d.patch.modules.splice(moduleInsertIndex(d.patch, trackId), 0, mod);
  });
  return { ...r, moduleId: id };
}

/* ------------------------------------------------------------------ */
/* Restore                                                             */
/* ------------------------------------------------------------------ */

const SLOT_OF: Record<string, TrackSlot> = { inst: 'inst', drive: 'drive', filter: 'filter', lfo: 'lfo', ch: 'ch' };

/** Module params a part's preset designs for a re-created default module, if any. */
function presetModuleParams(track: Track | undefined, id: Id): ParamValues | undefined {
  if (!track || (track.instrument.kind !== 'bass' && track.instrument.kind !== 'poly')) return undefined;
  const slot = SLOT_OF[id.slice(id.indexOf(':') + 1)];
  if (!slot || slot === 'inst') return undefined;
  return PRESETS[track.instrument.presetId]?.modules?.[slot];
}

/**
 * Merge a desired default module with the current patch: an existing module
 * with the same id and type keeps its params (bypass is reset), otherwise a
 * fresh module is used.
 */
function mergeModule(existing: PatchModule | undefined, fresh: PatchModule, preset?: ParamValues): PatchModule {
  if (existing && existing.type === fresh.type) {
    const m: PatchModule = { ...existing, params: { ...existing.params }, bypass: false };
    if (fresh.trackId !== undefined) m.trackId = fresh.trackId;
    return m;
  }
  return preset ? { ...fresh, params: { ...fresh.params, ...preset } } : fresh;
}

/** Default connections, reusing ids of identical existing cables so the engine keeps them. */
function reuseIds(desired: Connection[], existing: readonly Connection[]): Connection[] {
  const byKey = new Map(existing.map((c) => [endpointKey(c.from, c.to), c]));
  return desired.map((c) => {
    const old = byKey.get(endpointKey(c.from, c.to));
    return old ? { ...c, id: old.id } : c;
  });
}

const targetKey = (x: Pick<MacroTarget, 'module' | 'param'>): string => `${x.module}\u0000${x.param}`;

/**
 * Give re-created modules back the macro targets the part's sound maps onto
 * them. Removing a module drops its targets, so without this a restored
 * filter would no longer follow Tone/Motion (a synth preset maps Tone to the
 * instrument cutoff *and* the filter's brightness). Targets on modules that
 * survived the restore are left as the user set them, so a target removed on
 * purpose stays removed. Refilled macros keep the sound's target order.
 */
function refillMacros(d: Project, trackIds: readonly Id[], recreated: ReadonlySet<Id>): void {
  const ids = new Set(d.patch.modules.map((m) => m.id));
  for (const trackId of trackIds) {
    const t = d.tracks.find((x) => x.id === trackId);
    if (!t) continue;
    const sound = soundMacroMap(t);
    for (const macro of MACRO_IDS) {
      const current = t.macroMap[macro];
      const have = new Set(current.map(targetKey));
      const missing = sound[macro].filter((x) => recreated.has(x.module) && ids.has(x.module) && !have.has(targetKey(x)));
      if (!missing.length) continue;
      const order = new Map(sound[macro].map((x, i) => [targetKey(x), i]));
      const rank = (x: MacroTarget, i: number) => order.get(targetKey(x)) ?? sound[macro].length + i;
      t.macroMap[macro] = [...current, ...missing]
        .map((x, i) => ({ x, r: rank(x, i) }))
        .sort((a, b) => a.r - b.r)
        .map(({ x }) => x)
        .slice(0, VALIDATION_LIMITS.maxMacroTargets);
    }
  }
}

interface RestorePlan {
  modules: PatchModule[];
  connections: Connection[];
  recreated: Set<Id>;
}

function planTrackRestore(p: Project, trackId: Id): RestorePlan {
  const track = findTrack(p, trackId);
  const defaults = defaultTrackPatch(trackId);
  const defaultIds = new Set(defaults.modules.map((m) => m.id));
  const trackModuleIds = new Set([...p.patch.modules.filter((m) => m.trackId === trackId).map((m) => m.id), ...defaultIds]);
  const recreated = new Set<Id>();

  const modules: PatchModule[] = [];
  const restored = defaults.modules.map((fresh) => {
    const existing = findModule(p.patch, fresh.id);
    if (!existing || existing.type !== fresh.type) recreated.add(fresh.id);
    return mergeModule(existing, fresh, presetModuleParams(track, fresh.id));
  });
  let placed = false;
  for (const m of p.patch.modules) {
    if (trackModuleIds.has(m.id)) {
      if (!placed) {
        modules.push(...restored);
        placed = true;
      }
      continue;
    }
    modules.push(m);
  }
  if (!placed) modules.push(...restored);

  // Shared modules the defaults connect to must exist; a re-created one also gets its return cable.
  const connections = p.patch.connections.filter((c) => !trackModuleIds.has(c.from.module) && !trackModuleIds.has(c.to.module));
  const sharedConns = defaultSharedConnections();
  for (const shared of defaultSharedModules()) {
    if (modules.some((m) => m.id === shared.id)) continue;
    modules.push(shared);
    recreated.add(shared.id);
    connections.push(...sharedConns.filter((c) => c.from.module === shared.id));
  }
  connections.push(...reuseIds(defaults.connections, p.patch.connections));
  return { modules, connections, recreated };
}

/** Same modules and cables (by id and content), ignoring order. */
function samePatch(a: Patch, b: Pick<Patch, 'modules' | 'connections'>): boolean {
  if (a.modules.length !== b.modules.length || a.connections.length !== b.connections.length) return false;
  const mods = new Map(b.modules.map((m) => [m.id, m]));
  const conns = new Map(b.connections.map((c) => [c.id, c]));
  return a.modules.every((m) => deepEqual(m, mods.get(m.id))) && a.connections.every((c) => deepEqual(c, conns.get(c.id)));
}

function checkLimits(plan: RestorePlan): CommandResult | null {
  if (plan.modules.length > PATCH_LIMITS.maxModules) return refuse('limit', 'The patch has too many modules to restore this part. Remove some modules first.');
  if (plan.connections.length > PATCH_LIMITS.maxConnections) return refuse('limit', 'The patch has too many cables to restore this part. Remove some cables first.');
  return null;
}

/**
 * Restore a part's default routing: default modules (extra effects/LFOs
 * removed) and default cables. Existing modules keep their settings, so the
 * channel keeps its level, pan and sends. Cables from or to other parts'
 * modules that touched this part are removed. Re-created modules get their
 * sound's macro targets back.
 */
export function restoreTrackPatch(store: ProjectStore, trackId: Id): CommandResult {
  const locked = lockedResult(store);
  if (locked) return locked;
  const p = store.getState();
  if (!findTrack(p, trackId)) return NOT_FOUND('part');
  const plan = planTrackRestore(p, trackId);
  if (samePatch(p.patch, plan)) return { changed: false };
  const bad = checkLimits(plan);
  if (bad) return bad;
  return run(store, 'patch:Restore part routing', (d) => {
    d.patch.modules = plan.modules;
    d.patch.connections = plan.connections;
    dropDanglingMacroTargets(d);
    refillMacros(d, [trackId], plan.recreated);
  });
}

/** Restore the whole default patch, keeping the settings of modules that still exist. */
export function restoreDefaultPatch(store: ProjectStore): CommandResult {
  const locked = lockedResult(store);
  if (locked) return locked;
  const p = store.getState();
  const trackIds = p.tracks.map((t) => t.id);
  const defaults = defaultPatch(trackIds);
  const recreated = new Set<Id>();
  const modules = defaults.modules.map((fresh) => {
    const existing = findModule(p.patch, fresh.id);
    if (!existing || existing.type !== fresh.type) recreated.add(fresh.id);
    const track = fresh.trackId ? findTrack(p, fresh.trackId) : undefined;
    return mergeModule(existing, fresh, presetModuleParams(track, fresh.id));
  });
  const connections = reuseIds(defaults.connections, p.patch.connections);
  if (samePatch(p.patch, { modules, connections })) return { changed: false };
  return run(store, 'patch:Restore default routing', (d) => {
    d.patch.modules = modules;
    d.patch.connections = connections;
    dropDanglingMacroTargets(d);
    refillMacros(d, trackIds, recreated);
  });
}

/* ------------------------------------------------------------------ */
/* Copy and paste a part's effects                                     */
/* ------------------------------------------------------------------ */

/** One copied effect: its type, settings and on/off. */
export interface EffectClipItem {
  type: ModuleType;
  params: ParamValues;
  bypass: boolean;
}

/** A part's effects, copied (what "Copy effects" keeps for "Paste effects"). */
export interface EffectChainClip {
  /** The part they were copied from ("Paste effects from Chords"). */
  from: string;
  /** In signal order. */
  effects: EffectClipItem[];
}

/** A part's default Drive or Filter doing nothing: drive at 0, or an open low-pass with no brightness change. */
function neutralDefault(trackId: Id, mod: PatchModule, values: ParamValues): boolean {
  if (mod.id === moduleId.drive(trackId) && mod.type === 'drive') return (values.amount ?? 0) === 0;
  if (mod.id === moduleId.filter(trackId) && mod.type === 'filter') {
    const cutoff = specById(MODULE_PARAMS.filter, 'cutoff')!;
    return (values.mode ?? 0) === 0 && (values.cutoff ?? cutoff.default) >= cutoff.max && (values.bright ?? 0) === 0;
  }
  return false;
}

/**
 * Copy a part's effects in signal order (pure): each effect's type, the
 * settings it plays with now (big knobs applied, since they do not travel
 * with the copy) and on/off. The part's default Drive and Filter are left
 * out while they do nothing. Null when the part has custom routing (no
 * simple chain) or does not exist.
 */
export function copyEffectChain(p: Project, trackId: Id): EffectChainClip | null {
  const t = findTrack(p, trackId);
  const chain = t ? trackChain(p.patch, trackId) : null;
  if (!t || !chain) return null;
  const effects: EffectClipItem[] = [];
  for (const id of chain.slice(1, -1)) {
    const mod = findModule(p.patch, id);
    if (!mod) continue;
    const values = resolveModuleParams(p, mod);
    if (neutralDefault(trackId, mod, values)) continue;
    effects.push({ type: mod.type, params: { ...values }, bypass: mod.bypass });
  }
  return { from: t.name, effects };
}

/** A pasted clip's effects, checked: insertable types only, known settings clamped. */
function cleanClipEffects(clip: EffectChainClip): EffectClipItem[] | null {
  if (!clip || !Array.isArray(clip.effects)) return null;
  const out: EffectClipItem[] = [];
  for (const e of clip.effects) {
    if (!e || !MODULE_DEFS[e.type]?.insertable) return null;
    const params: ParamValues = {};
    for (const [k, v] of Object.entries(e.params ?? {})) {
      const spec = specById(MODULE_PARAMS[e.type], k);
      if (spec && isFiniteNumber(v)) params[k] = clampParam(spec, v);
    }
    out.push({ type: e.type, params, bypass: !!e.bypass });
  }
  return out;
}

/**
 * Paste copied effects onto a part, in one undo step: after its effects, or
 * (`replace`) instead of them. Replacing keeps the part's default Drive and
 * Filter (its big knobs drive them); the pasted effects follow them. An
 * effect that takes back a default slot gets its big-knob mappings again,
 * and a pasted filter is cabled to an LFO that has no cable left, as in
 * insertEffect. Refused, with nothing changed, when the part would hold more
 * than PATCH_LIMITS.maxEffectsPerTrack effects or the patch would be too
 * big, or the part has custom routing.
 */
export function pasteEffectChain(store: ProjectStore, trackId: Id, clip: EffectChainClip, opts: { replace?: boolean } = {}): CommandResult & { moduleIds?: Id[]; removed?: number } {
  const locked = lockedResult(store);
  if (locked) return locked;
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  const effects = cleanClipEffects(clip);
  if (!effects) return refuse('invalid', 'The copied effects could not be read.');
  if (!effects.length) return refuse('empty', 'There are no effects to paste.');
  const chain = trackChain(p.patch, trackId);
  if (!chain) return refuse('not-linear', NOT_LINEAR_MESSAGE);
  const current = chain.slice(1, -1);
  const removed = opts.replace ? current.filter((id) => !isDesignSlot(trackId, id)) : [];
  const total = current.length - removed.length + effects.length;
  if (total > PATCH_LIMITS.maxEffectsPerTrack) {
    return refuse('limit', `Pasting would give ${t.name} ${total} effects; a part can have up to ${PATCH_LIMITS.maxEffectsPerTrack}.${opts.replace ? '' : ' Paste them instead of its effects, or remove some first.'}`);
  }

  // Plan on a copy of the patch, so the limits are checked against the exact result.
  const patch: Patch = structuredClone(p.patch);
  for (const id of removed) removeModuleFromPatch(patch, id);
  const base = trackChain(patch, trackId);
  if (!base) return refuse('not-linear', NOT_LINEAR_MESSAGE);
  const added: Id[] = [];
  for (const e of effects) {
    const id = freeModuleId(patch, trackId, e.type);
    const mod = createModule(id, e.type, trackId, e.params);
    mod.bypass = e.bypass;
    patch.modules.splice(moduleInsertIndex(patch, trackId), 0, mod);
    added.push(id);
  }
  applyChain(patch, base, [base[0], ...base.slice(1, -1), ...added, base[base.length - 1]]);
  const filter = added.find((id) => findModule(patch, id)?.type === 'filter');
  const lfoCable = filter ? lfoCableFor(patch, trackId, filter) : null;
  if (lfoCable) patch.connections.push(lfoCable);
  if (patch.modules.length > PATCH_LIMITS.maxModules) return refuse('limit', 'The patch already has as many modules as it can hold.');
  if (patch.connections.length > PATCH_LIMITS.maxConnections) return refuse('limit', CONNECTION_MESSAGES.limit);
  const designed = new Set(added.filter((id) => isDesignSlot(trackId, id)));
  const r = run(store, opts.replace ? 'patch:Replace effects' : 'patch:Paste effects', (d) => {
    d.patch.modules = patch.modules;
    d.patch.connections = patch.connections;
    dropDanglingMacroTargets(d);
    if (designed.size) refillMacros(d, [trackId], designed);
  });
  return { ...r, moduleIds: added, removed: removed.length };
}
