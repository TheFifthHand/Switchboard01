/**
 * Pure patch (routing) logic: connection validation, cycle checks, track
 * signal chains and path diagnostics.
 *
 * Every connection is treated as a directed edge module -> module. Version one
 * forbids cycles entirely; the delay module's feedback is internal to the
 * module and never appears as a connection.
 *
 * Functions that change a patch (`applyChain`, `removeModuleFromPatch`) mutate
 * the patch they are given so they work on immer drafts as well as on plain
 * copies. Everything else is read-only.
 */
import { conn, defaultTrackPatch, moduleId, MASTER_ID } from './factory';
import { MODULE_DEFS, PATCH_LIMITS, portDef, type PortDef } from './modules';
import type { Connection, Id, Patch, PatchModule, PortKind, PortRef } from './types';

export type ConnectionErrorCode =
  | 'unknown-module'
  | 'unknown-port'
  | 'direction'
  | 'incompatible'
  | 'duplicate'
  | 'self'
  | 'cycle'
  | 'limit'
  | 'locked';

export type ConnectionCheck = { ok: true } | { ok: false; code: ConnectionErrorCode; message: string };

export interface ValidateOptions {
  /** Validate as if this connection were not in the patch (used when moving it). */
  ignoreConnectionId?: Id;
}

export const CONNECTION_MESSAGES: Record<ConnectionErrorCode, string> = {
  'unknown-module': 'That module is no longer in the patch.',
  'unknown-port': 'That socket does not exist on this module.',
  direction: 'A cable goes from an output to an input.',
  incompatible: 'An audio output can only go to an audio input.',
  duplicate: 'These two sockets are already connected.',
  self: 'A module cannot be patched into itself.',
  cycle: 'That cable would feed the sound back into itself. Feedback loops are not allowed.',
  limit: `The patch already has the maximum of ${PATCH_LIMITS.maxConnections} cables. Remove one first.`,
  locked: 'Patching is locked while a performance is being recorded.',
};

export const MOD_TO_AUDIO_MESSAGE = 'A modulation output can only go to a teal modulation input.';

function fail(code: ConnectionErrorCode, message = CONNECTION_MESSAGES[code]): ConnectionCheck {
  return { ok: false, code, message };
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

export function findModule(patch: Patch, id: Id): PatchModule | undefined {
  return patch.modules.find((m) => m.id === id);
}

/** Output port definition for a reference, if it exists. */
export function outputPortDef(patch: Patch, ref: PortRef): PortDef | undefined {
  const mod = findModule(patch, ref.module);
  return mod ? portDef(mod.type, ref.port, 'out') : undefined;
}

/** Input port definition for a reference, if it exists. */
export function inputPortDef(patch: Patch, ref: PortRef): PortDef | undefined {
  const mod = findModule(patch, ref.module);
  return mod ? portDef(mod.type, ref.port, 'in') : undefined;
}

/** Signal kind of a connection (by its source port), or null when the source port is unknown. */
export function connectionKind(patch: Patch, c: Connection): PortKind | null {
  return outputPortDef(patch, c.from)?.kind ?? null;
}

export function sameRef(a: PortRef, b: PortRef): boolean {
  return a.module === b.module && a.port === b.port;
}

/** Stable key for a from/to pair (duplicate detection). */
export function endpointKey(from: PortRef, to: PortRef): string {
  return `${from.module}\u0000${from.port}\u0000${to.module}\u0000${to.port}`;
}

function activeConnections(patch: Patch, ignoreId?: Id): Connection[] {
  return ignoreId === undefined ? patch.connections : patch.connections.filter((c) => c.id !== ignoreId);
}

/* ------------------------------------------------------------------ */
/* Cycles                                                              */
/* ------------------------------------------------------------------ */

function adjacency(connections: readonly Connection[]): Map<Id, Id[]> {
  const adj = new Map<Id, Id[]>();
  for (const c of connections) {
    const list = adj.get(c.from.module);
    if (list) list.push(c.to.module);
    else adj.set(c.from.module, [c.to.module]);
  }
  return adj;
}

function reaches(adj: Map<Id, Id[]>, start: Id, goal: Id): boolean {
  if (start === goal) return true;
  const seen = new Set<Id>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (next === goal) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/** True when an edge fromModule -> toModule would close a loop in the patch. */
export function wouldCreateCycle(patch: Patch, fromModule: Id, toModule: Id, opts: ValidateOptions = {}): boolean {
  return reaches(adjacency(activeConnections(patch, opts.ignoreConnectionId)), toModule, fromModule);
}

/** True when the patch's connections contain a directed cycle. */
export function hasCycle(patch: Patch): boolean {
  const adj = adjacency(patch.connections);
  const state = new Map<Id, 1 | 2>(); // 1 = on stack, 2 = done
  for (const start of adj.keys()) {
    if (state.has(start)) continue;
    const stack: { id: Id; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nexts = adj.get(top.id) ?? [];
      if (top.i < nexts.length) {
        const n = nexts[top.i++];
        const s = state.get(n);
        if (s === 1) return true;
        if (s === undefined) {
          state.set(n, 1);
          stack.push({ id: n, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Check whether a cable from `from` (an output) to `to` (an input) may be
 * added. Never changes the patch.
 */
export function validateConnection(patch: Patch, from: PortRef, to: PortRef, opts: ValidateOptions = {}): ConnectionCheck {
  const fromMod = findModule(patch, from.module);
  const toMod = findModule(patch, to.module);
  if (!fromMod || !toMod) return fail('unknown-module');

  const out = portDef(fromMod.type, from.port, 'out');
  if (!out) return portDef(fromMod.type, from.port, 'in') ? fail('direction') : fail('unknown-port');
  const inp = portDef(toMod.type, to.port, 'in');
  if (!inp) return portDef(toMod.type, to.port, 'out') ? fail('direction') : fail('unknown-port');

  if (out.kind !== inp.kind) {
    return fail('incompatible', out.kind === 'mod' ? MOD_TO_AUDIO_MESSAGE : CONNECTION_MESSAGES.incompatible);
  }
  if (from.module === to.module) return fail('self');

  const conns = activeConnections(patch, opts.ignoreConnectionId);
  if (conns.some((c) => sameRef(c.from, from) && sameRef(c.to, to))) return fail('duplicate');
  if (conns.length >= PATCH_LIMITS.maxConnections) return fail('limit');
  if (reaches(adjacency(conns), to.module, from.module)) return fail('cycle');
  return { ok: true };
}

/** Every input socket a plug from `from` could be connected to (for highlighting while dragging). */
export function compatibleTargets(patch: Patch, from: PortRef, opts: ValidateOptions = {}): PortRef[] {
  const out: PortRef[] = [];
  for (const m of patch.modules) {
    for (const p of MODULE_DEFS[m.type].ports) {
      if (p.direction !== 'in') continue;
      const to = { module: m.id, port: p.id };
      if (validateConnection(patch, from, to, opts).ok) out.push(to);
    }
  }
  return out;
}

/** Every output socket that could feed `to` (for picking up the other end of a cable). */
export function compatibleSources(patch: Patch, to: PortRef, opts: ValidateOptions = {}): PortRef[] {
  const out: PortRef[] = [];
  for (const m of patch.modules) {
    for (const p of MODULE_DEFS[m.type].ports) {
      if (p.direction !== 'out') continue;
      const from = { module: m.id, port: p.id };
      if (validateConnection(patch, from, to, opts).ok) out.push(from);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Track chains                                                        */
/* ------------------------------------------------------------------ */

function audioOutgoing(patch: Patch, id: Id): Connection[] {
  return patch.connections.filter((c) => c.from.module === id && outputPortDef(patch, c.from)?.kind === 'audio');
}

function audioIncoming(patch: Patch, id: Id): Connection[] {
  return patch.connections.filter((c) => c.to.module === id && inputPortDef(patch, c.to)?.kind === 'audio');
}

/**
 * Ordered module ids from "<t>:inst" to "<t>:ch" when the track's audio path
 * is a simple linear chain of this track's own effects (each link a single
 * out -> in cable, no branches or merges). Null for custom or broken routing,
 * in which case the effects rack cannot insert/move/reorder automatically.
 */
export function trackChain(patch: Patch, trackId: Id): Id[] | null {
  const instId = moduleId.inst(trackId);
  const chId = moduleId.channel(trackId);
  const inst = findModule(patch, instId);
  const ch = findModule(patch, chId);
  if (!inst || inst.type !== 'instrument' || !ch || ch.type !== 'channel') return null;

  const chain: Id[] = [instId];
  const seen = new Set<Id>(chain);
  let cur = instId;
  for (;;) {
    const outs = audioOutgoing(patch, cur);
    if (outs.length !== 1) return null;
    const link = outs[0];
    if (link.from.port !== 'out' || link.to.port !== 'in') return null;
    const next = link.to.module;
    if (seen.has(next)) return null;
    if (audioIncoming(patch, next).length !== 1) return null;
    if (next === chId) {
      chain.push(chId);
      return chain;
    }
    const mod = findModule(patch, next);
    if (!mod || MODULE_DEFS[mod.type].family !== 'effect' || mod.trackId !== trackId) return null;
    chain.push(next);
    seen.add(next);
    cur = next;
  }
}

/** The insert effects of a linear track chain (between instrument and channel), or null. */
export function trackEffects(patch: Patch, trackId: Id): Id[] | null {
  const chain = trackChain(patch, trackId);
  return chain ? chain.slice(1, -1) : null;
}

/**
 * True when the instrument's sound reaches the master output through primary
 * ("out") audio outputs. Channel sends do not count: they carry only a
 * send-level copy (often zero), so a part heard only through a send is
 * effectively missing from the mix.
 */
export function hasPathToMaster(patch: Patch, trackId: Id): boolean {
  const start = moduleId.inst(trackId);
  if (!findModule(patch, start) || !findModule(patch, MASTER_ID)) return false;
  const seen = new Set<Id>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of patch.connections) {
      if (c.from.module !== cur || c.from.port !== 'out') continue;
      if (inputPortDef(patch, c.to)?.kind !== 'audio' || outputPortDef(patch, c.from)?.kind !== 'audio') continue;
      const next = c.to.module;
      if (next === MASTER_ID) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

export interface PathProblem {
  message: 'This part has no path to the output.';
  fix: 'restore';
}

/** Null when the part can be heard; otherwise an explanation with the Restore fix. */
export function describePathProblem(patch: Patch, trackId: Id): PathProblem | null {
  if (hasPathToMaster(patch, trackId)) return null;
  return { message: 'This part has no path to the output.', fix: 'restore' };
}

/** Fresh default connections for one track (new connection ids each call). */
export function defaultConnectionsForTrack(trackId: Id): Connection[] {
  return defaultTrackPatch(trackId).connections;
}

/* ------------------------------------------------------------------ */
/* Mutating helpers (drafts or plain copies)                           */
/* ------------------------------------------------------------------ */

/**
 * Rewire a linear chain: replace the out -> in links between consecutive
 * modules of `oldChain` with links for `newChain`. Links present in both are
 * kept with their ids (so the audio engine does not re-create them).
 */
export function applyChain(patch: Patch, oldChain: readonly Id[], newChain: readonly Id[]): void {
  const pairKey = (a: Id, b: Id) => `${a}\u0000${b}`;
  const oldPairs = new Set<string>();
  for (let i = 0; i + 1 < oldChain.length; i++) oldPairs.add(pairKey(oldChain[i], oldChain[i + 1]));
  const newPairs: [Id, Id][] = [];
  for (let i = 0; i + 1 < newChain.length; i++) newPairs.push([newChain[i], newChain[i + 1]]);
  const wanted = new Set(newPairs.map(([a, b]) => pairKey(a, b)));

  const isChainLink = (c: Connection) => c.from.port === 'out' && c.to.port === 'in';
  for (let i = patch.connections.length - 1; i >= 0; i--) {
    const c = patch.connections[i];
    if (!isChainLink(c)) continue;
    const k = pairKey(c.from.module, c.to.module);
    if (oldPairs.has(k) && !wanted.has(k)) patch.connections.splice(i, 1);
  }
  for (const [a, b] of newPairs) {
    const exists = patch.connections.some((c) => isChainLink(c) && c.from.module === a && c.to.module === b);
    if (!exists) patch.connections.push(conn(a, 'out', b, 'in'));
  }
}

/**
 * Remove a module and its cables. Sources that fed its audio input through a
 * primary "out" are reconnected to every destination of its audio output, so
 * removing an effect from the middle of a chain keeps the sound flowing.
 * Channel sends into a removed send effect are not reconnected (that would
 * route a send straight to the output). Reconnections that would be invalid
 * are skipped. Returns the ids of new connections.
 */
export function removeModuleFromPatch(patch: Patch, id: Id): Id[] {
  const sources = patch.connections
    .filter((c) => c.to.module === id && c.from.port === 'out' && inputPortDef(patch, c.to)?.kind === 'audio')
    .map((c) => c.from);
  const destinations = patch.connections
    .filter((c) => c.from.module === id && outputPortDef(patch, c.from)?.kind === 'audio')
    .map((c) => c.to);

  for (let i = patch.connections.length - 1; i >= 0; i--) {
    const c = patch.connections[i];
    if (c.from.module === id || c.to.module === id) patch.connections.splice(i, 1);
  }
  const mi = patch.modules.findIndex((m) => m.id === id);
  if (mi >= 0) patch.modules.splice(mi, 1);

  const added: Id[] = [];
  for (const from of sources) {
    for (const to of destinations) {
      if (!validateConnection(patch, from, to).ok) continue;
      const c = conn(from.module, from.port, to.module, to.port);
      patch.connections.push(c);
      added.push(c.id);
    }
  }
  return added;
}

/** A module id for a new module of `type` on a track: the canonical "<t>:<type>" when free, else "<t>:<type>-N". */
export function freeModuleId(patch: Patch, trackId: Id, type: string): Id {
  const base = `${trackId}:${type}`;
  if (!findModule(patch, base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!findModule(patch, id)) return id;
  }
}
