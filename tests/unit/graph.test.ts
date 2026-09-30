import { describe, expect, it } from 'vitest';
import { createProject, conn, moduleId, MASTER_ID, REVERB_ID } from '../../src/project/factory';
import {
  MOD_TO_AUDIO_MESSAGE,
  applyChain,
  compatibleSources,
  compatibleTargets,
  defaultConnectionsForTrack,
  describePathProblem,
  hasCycle,
  hasPathToMaster,
  removeModuleFromPatch,
  trackChain,
  validateConnection,
  wouldCreateCycle,
} from '../../src/project/graph';
import { MODULE_DEFS, PATCH_LIMITS } from '../../src/project/modules';
import type { Patch, PortRef } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { connect, disconnect, insertEffect, moveConnection } from '../../src/state/commands/patch';

const ref = (module: string, port: string): PortRef => ({ module, port });
const copyPatch = (p: Patch): Patch => structuredClone(p);

describe('validateConnection on the default patch', () => {
  const project = createProject({ now: 0 });
  const patch = project.patch;

  it('accepts every default connection and has no cycles', () => {
    for (const c of patch.connections) {
      expect(validateConnection(patch, c.from, c.to, { ignoreConnectionId: c.id })).toEqual({ ok: true });
    }
    expect(hasCycle(patch)).toBe(false);
    for (const t of project.tracks) {
      expect(hasPathToMaster(patch, t.id)).toBe(true);
      expect(describePathProblem(patch, t.id)).toBeNull();
    }
  });

  it('rejects modulation into audio and audio into modulation with plain messages', () => {
    const modToAudio = validateConnection(patch, ref('t1:lfo', 'out'), ref('t1:filter', 'in'));
    expect(modToAudio).toEqual({ ok: false, code: 'incompatible', message: MOD_TO_AUDIO_MESSAGE });
    expect(MOD_TO_AUDIO_MESSAGE).toBe('A modulation output can only go to a teal modulation input.');
    const audioToMod = validateConnection(patch, ref('t1:drive', 'out'), ref('t2:filter', 'cutoff'));
    expect(audioToMod.ok).toBe(false);
    if (!audioToMod.ok) {
      expect(audioToMod.code).toBe('incompatible');
      expect(audioToMod.message).toMatch(/audio input/);
    }
  });

  it('rejects wrong direction, unknown ports and unknown modules', () => {
    expect(validateConnection(patch, ref('t1:filter', 'in'), ref('t1:ch', 'in'))).toMatchObject({ ok: false, code: 'direction' });
    expect(validateConnection(patch, ref('t1:inst', 'out'), ref('t2:drive', 'out'))).toMatchObject({ ok: false, code: 'direction' });
    expect(validateConnection(patch, ref('t1:inst', 'nope'), ref('t2:drive', 'in'))).toMatchObject({ ok: false, code: 'unknown-port' });
    expect(validateConnection(patch, ref('t9:inst', 'out'), ref('t2:drive', 'in'))).toMatchObject({ ok: false, code: 'unknown-module' });
  });

  it('rejects duplicates and self connections', () => {
    expect(validateConnection(patch, ref('t1:inst', 'out'), ref('t1:drive', 'in'))).toMatchObject({ ok: false, code: 'duplicate' });
    expect(validateConnection(patch, ref('t1:filter', 'out'), ref('t1:filter', 'in'))).toMatchObject({ ok: false, code: 'self' });
  });

  it('rejects a cable that closes a loop through a chain of effects', () => {
    // t1: inst -> drive -> filter -> ch. Feeding the channel back into the drive closes a loop.
    const r = validateConnection(patch, ref('t1:ch', 'out'), ref('t1:drive', 'in'));
    expect(r).toMatchObject({ ok: false, code: 'cycle' });
    expect(wouldCreateCycle(patch, 't1:ch', 't1:drive')).toBe(true);
    // Through a shared effect: t1 sends into the reverb, so the reverb cannot feed t1's filter.
    expect(validateConnection(patch, ref(REVERB_ID, 'out'), ref('t1:filter', 'in'))).toMatchObject({ ok: false, code: 'cycle' });
    // The same reverb may feed a part that does not send into it.
    const p2 = copyPatch(patch);
    p2.connections = p2.connections.filter((c) => !(c.from.module === 't2:ch' && c.from.port === 'sendA'));
    expect(validateConnection(p2, ref(REVERB_ID, 'out'), ref('t2:filter', 'in'))).toEqual({ ok: true });
  });

  it('enforces the cable limit', () => {
    const p = copyPatch(patch);
    let i = 0;
    while (p.connections.length < PATCH_LIMITS.maxConnections) p.connections.push({ ...conn('t1:lfo', 'out', 't1:ch', 'level'), id: `x${i++}` });
    expect(validateConnection(p, ref('t2:lfo', 'out'), ref('t2:inst', 'pitch'))).toMatchObject({ ok: false, code: 'limit' });
    // Moving an existing cable does not add one, so it is allowed at the limit.
    const lfo = p.connections.find((c) => c.from.module === 't2:lfo')!;
    expect(validateConnection(p, lfo.from, ref('t2:inst', 'pitch'), { ignoreConnectionId: lfo.id })).toEqual({ ok: true });
  });

  it('detects a loop that is already in a patch', () => {
    const p = copyPatch(patch);
    expect(hasCycle(p)).toBe(false);
    // Bypass validation on purpose: reverb -> t1 drive closes t1 -> channel -> send -> reverb.
    p.connections.push(conn(REVERB_ID, 'out', 't1:drive', 'in'));
    expect(hasCycle(p)).toBe(true);
    // A cable t1 channel -> reverb closes a loop only while the reverb feeds t1 back.
    const loop = p.connections[p.connections.length - 1];
    expect(wouldCreateCycle(p, 't1:ch', REVERB_ID)).toBe(true);
    expect(wouldCreateCycle(p, 't1:ch', REVERB_ID, { ignoreConnectionId: loop.id })).toBe(false);
  });
});

describe('moveConnection', () => {
  it('keeps the old route when the move is rejected, and moves it when valid', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const before = store.getState().patch;
    const lfoCable = before.connections.find((c) => c.from.module === 't1:lfo')!;
    // Moving the LFO cable onto an audio input is rejected.
    const bad = moveConnection(store, lfoCable.id, { to: ref('t1:ch', 'in') });
    expect(bad).toMatchObject({ ok: false, code: 'incompatible' });
    expect(store.getState().patch).toBe(before);
    expect(store.canUndo()).toBe(false);

    // Moving the channel output onto its own drive would loop; rejected, route intact.
    const out = before.connections.find((c) => c.from.module === 't1:ch' && c.to.module === MASTER_ID)!;
    expect(moveConnection(store, out.id, { to: ref('t1:drive', 'in') })).toMatchObject({ ok: false, code: 'cycle' });
    expect(store.getState().patch.connections.find((c) => c.id === out.id)).toEqual(out);

    // A valid move keeps the cable id and changes only its destination.
    const ok = moveConnection(store, lfoCable.id, { to: ref('t1:ch', 'pan') });
    expect(ok).toEqual({ ok: true, connectionId: lfoCable.id });
    const moved = store.getState().patch.connections.find((c) => c.id === lfoCable.id)!;
    expect(moved.from).toEqual(lfoCable.from);
    expect(moved.to).toEqual(ref('t1:ch', 'pan'));
    store.undo();
    expect(store.getState().patch.connections.find((c) => c.id === lfoCable.id)).toEqual(lfoCable);
  });
});

describe('track chains and paths', () => {
  it('reads the default chain and detects branching', () => {
    const p = createProject({ now: 0 }).patch;
    expect(trackChain(p, 't1')).toEqual(['t1:inst', 't1:drive', 't1:filter', 't1:ch']);
    const branched = copyPatch(p);
    branched.connections.push(conn('t1:inst', 'out', 't1:ch', 'in'));
    expect(trackChain(branched, 't1')).toBeNull();
    // Other parts are unaffected.
    expect(trackChain(branched, 't2')).toEqual(['t2:inst', 't2:drive', 't2:filter', 't2:ch']);
  });

  it('includes inserted effects in order', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const r = insertEffect(store, 't3', 'chorus', 1);
    expect(r.changed).toBe(true);
    expect(trackChain(store.getState().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:chorus', 't3:filter', 't3:ch']);
  });

  it('reports no path to the output after the channel output is removed', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const out = store.getState().patch.connections.find((c) => c.from.module === 't2:ch' && c.from.port === 'out')!;
    expect(disconnect(store, out.id).changed).toBe(true);
    const patch = store.getState().patch;
    // The sends to the reverb and delay still exist, but they are not the part's output.
    expect(patch.connections.some((c) => c.from.module === 't2:ch' && c.from.port === 'sendA')).toBe(true);
    expect(hasPathToMaster(patch, 't2')).toBe(false);
    expect(describePathProblem(patch, 't2')).toEqual({ message: 'This part has no path to the output.', fix: 'restore' });
    expect(hasPathToMaster(patch, 't1')).toBe(true);
    // A route through another module counts: t2 channel -> t1 filter -> t1 channel -> master.
    expect(connect(store, ref('t2:ch', 'out'), ref('t1:filter', 'in')).ok).toBe(true);
    expect(hasPathToMaster(store.getState().patch, 't2')).toBe(true);
  });
});

describe('compatibleTargets', () => {
  const patch = createProject({ now: 0 }).patch;

  it('offers only modulation inputs for an LFO plug, minus existing cables', () => {
    const targets = compatibleTargets(patch, ref('t1:lfo', 'out'));
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      const mod = patch.modules.find((m) => m.id === t.module)!;
      expect(MODULE_DEFS[mod.type].ports.find((p) => p.id === t.port && p.direction === 'in')!.kind).toBe('mod');
    }
    expect(targets).toContainEqual(ref('t1:inst', 'pitch'));
    expect(targets).toContainEqual(ref('t1:ch', 'level'));
    expect(targets).not.toContainEqual(ref('t1:filter', 'cutoff')); // already connected
  });

  it('offers audio inputs that do not loop back', () => {
    const targets = compatibleTargets(patch, ref('t1:filter', 'out'));
    expect(targets).toContainEqual(ref(MASTER_ID, 'in'));
    expect(targets).toContainEqual(ref('t2:drive', 'in'));
    expect(targets).not.toContainEqual(ref('t1:drive', 'in')); // cycle
    expect(targets).not.toContainEqual(ref('t1:ch', 'in')); // duplicate
    expect(targets).not.toContainEqual(ref('t1:filter', 'in')); // self
    expect(targets.every((t) => validateConnection(patch, ref('t1:filter', 'out'), t).ok)).toBe(true);
    const sources = compatibleSources(patch, ref('t1:ch', 'pan'));
    expect(sources.every((s) => s.port === 'out' && s.module.endsWith('lfo'))).toBe(true);
  });
});

describe('patch helpers', () => {
  it('defaultConnectionsForTrack rebuilds a valid track route', () => {
    const p = createProject({ now: 0 }).patch;
    const stripped = copyPatch(p);
    const t3 = new Set(['t3:inst', 't3:drive', 't3:filter', 't3:lfo', 't3:ch']);
    stripped.connections = stripped.connections.filter((c) => !t3.has(c.from.module) && !t3.has(c.to.module));
    expect(hasPathToMaster(stripped, 't3')).toBe(false);
    for (const c of defaultConnectionsForTrack('t3')) {
      expect(validateConnection(stripped, c.from, c.to)).toEqual({ ok: true });
      stripped.connections.push(c);
    }
    expect(trackChain(stripped, 't3')).toEqual(['t3:inst', 't3:drive', 't3:filter', 't3:ch']);
    expect(hasPathToMaster(stripped, 't3')).toBe(true);
  });

  it('removeModuleFromPatch splices a chain and applyChain keeps unchanged cable ids', () => {
    const p = copyPatch(createProject({ now: 0 }).patch);
    const keep = p.connections.find((c) => c.from.module === 't1:inst')!;
    removeModuleFromPatch(p, 't1:filter');
    expect(trackChain(p, 't1')).toEqual(['t1:inst', 't1:drive', 't1:ch']);
    expect(p.connections.some((c) => c.to.module === 't1:filter' || c.from.module === 't1:filter')).toBe(false);
    expect(p.connections.find((c) => c.id === keep.id)).toEqual(keep);

    const before = trackChain(p, 't1')!;
    applyChain(p, before, ['t1:inst', moduleId.channel('t1')]);
    expect(p.connections.find((c) => c.id === keep.id)).toBeUndefined();
    expect(p.connections.filter((c) => c.from.module === 't1:inst' && c.to.module === 't1:ch')).toHaveLength(1);
  });
});
