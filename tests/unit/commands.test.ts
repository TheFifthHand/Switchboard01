import { describe, expect, it } from 'vitest';
import { applyKitToProject } from '../../src/content/presets';
import { createClip as makeClip, createProject, defaultTrackPatch } from '../../src/project/factory';
import { endpointKey, hasCycle, hasPathToMaster, trackChain } from '../../src/project/graph';
import { PATCH_LIMITS } from '../../src/project/modules';
import { mulberry32 } from '../../src/project/rng';
import { validateProject } from '../../src/project/validate';
import type { Patch, Performance, PortRef, Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { addBlock, moveBlock, removeBlock, setBlockRepeats, setTailSeconds } from '../../src/state/commands/arrangement';
import { clipDropProblem, copyClip, copyClipTo, createClip, duplicateClipContent, duplicateClipToSlot, moveClip, pasteClip, setClipBars } from '../../src/state/commands/clips';
import { moveScene } from '../../src/state/commands/scenes';
import {
  addNote,
  addRecordedNotes,
  clearPage,
  duplicatePage,
  moveNote,
  quantizeTick,
  setNoteVelocity,
  toggleStep,
  transposeClip,
} from '../../src/state/commands/notes';
import {
  addLfo,
  connect,
  disconnect,
  insertEffect,
  moveEffect,
  removeEffect,
  restoreDefaultPatch,
  restoreTrackPatch,
  setBypass,
  setConnectionAmount,
  setModuleParam,
} from '../../src/state/commands/patch';
import { addPerformance, deletePerformanceEvent, trimPerformance } from '../../src/state/commands/performances';
import { setBpm, setKey, setSwing } from '../../src/state/commands/project';
import { addSampleMeta, assignSample, removeSampleMeta } from '../../src/state/commands/samples';
import { changeInstrumentSound, resetMacroMap, setArp, setDrumVoice, setInstrumentParam, setLocked, setMacro, setMacroTarget } from '../../src/state/commands/tracks';

const ref = (module: string, port: string): PortRef => ({ module, port });
const fresh = () => new ProjectStore(createProject({ now: 0 }));
const keys = (p: Patch, filter: (id: string) => boolean = () => true) =>
  new Set(p.connections.filter((c) => filter(c.from.module) || filter(c.to.module)).map((c) => endpointKey(c.from, c.to)));

// Concurrently developed modules: detect whether they are implemented yet.
const presetsReady = (() => {
  try {
    applyKitToProject(createProject({ now: 0 }), 't1', 'tight-circuit');
    return true;
  } catch {
    return false;
  }
})();
const variationModule = await import('../../src/state/commands/variation').catch(() => null);

describe('patch commands with undo/redo', () => {
  it('connect and disconnect are single undo steps', () => {
    const store = fresh();
    const original = store.getState().patch;
    const r = connect(store, ref('t1:lfo', 'out'), ref('t1:inst', 'pitch'), 0.5);
    expect(r.ok).toBe(true);
    const added = store.getState().patch.connections.find((c) => c.id === r.connectionId)!;
    expect(added).toMatchObject({ from: ref('t1:lfo', 'out'), to: ref('t1:inst', 'pitch'), amount: 0.5 });
    expect(store.undoLabel()).toBe('Connect cable');
    store.undo();
    expect(store.getState().patch).toEqual(original);
    store.redo();
    expect(store.getState().patch.connections).toContainEqual(added);

    expect(connect(store, ref('t1:lfo', 'out'), ref('t1:inst', 'pitch')).ok).toBe(false); // duplicate
    expect(setConnectionAmount(store, added.id, -3).changed).toBe(true);
    expect(store.getState().patch.connections.find((c) => c.id === added.id)!.amount).toBe(-1);

    const master = original.connections.find((c) => c.from.module === 't1:ch' && c.to.module === 'master')!;
    expect(disconnect(store, master.id).changed).toBe(true);
    expect(hasPathToMaster(store.getState().patch, 't1')).toBe(false);
    store.undo();
    expect(store.getState().patch.connections).toContainEqual(master);
    expect(hasPathToMaster(store.getState().patch, 't1')).toBe(true);
  });

  it('inserts, moves and removes effects in a linear chain, all undoable', () => {
    const store = fresh();
    const before = store.getState();
    const ins = insertEffect(store, 't2', 'chorus');
    expect(ins).toMatchObject({ changed: true, moduleId: 't2:chorus' });
    expect(trackChain(store.getState().patch, 't2')).toEqual(['t2:inst', 't2:drive', 't2:filter', 't2:chorus', 't2:ch']);

    expect(moveEffect(store, 't2:chorus', 0).changed).toBe(true);
    expect(trackChain(store.getState().patch, 't2')).toEqual(['t2:inst', 't2:chorus', 't2:drive', 't2:filter', 't2:ch']);

    expect(removeEffect(store, 't2:drive').changed).toBe(true);
    const afterRemove = store.getState();
    expect(trackChain(afterRemove.patch, 't2')).toEqual(['t2:inst', 't2:chorus', 't2:filter', 't2:ch']);
    expect(afterRemove.tracks[1].macroMap.drive).toEqual([]); // its target module is gone
    expect(hasPathToMaster(afterRemove.patch, 't2')).toBe(true);

    expect(removeEffect(store, 't2:ch')).toMatchObject({ changed: false, reason: 'protected' });
    expect(removeEffect(store, 'master')).toMatchObject({ changed: false, reason: 'protected' });

    store.undo();
    store.undo();
    store.undo();
    expect(store.getState().patch).toEqual(before.patch);
    expect(store.getState().tracks).toEqual(before.tracks);
  });

  it('respects the per-part effect limit and refuses custom routing', () => {
    const store = fresh();
    const types = ['chorus', 'phaser', 'crusher', 'delay'] as const;
    for (const t of types) expect(insertEffect(store, 't4', t).changed).toBe(true);
    expect(trackChain(store.getState().patch, 't4')!.length - 2).toBe(PATCH_LIMITS.maxEffectsPerTrack);
    expect(insertEffect(store, 't4', 'reverb')).toMatchObject({ changed: false, reason: 'limit' });
    // An inserted delay starts partly wet so the dry sound is not lost.
    expect(store.getState().patch.modules.find((m) => m.id === 't4:delay')!.params.mix).toBe(0.3);

    connect(store, ref('t5:inst', 'out'), ref('master', 'in')); // branch: t5 no longer linear
    expect(insertEffect(store, 't5', 'chorus')).toMatchObject({ changed: false, reason: 'not-linear' });
    expect(insertEffect(store, 't5', 'lfo')).toMatchObject({ changed: false, reason: 'invalid' });
    // The rack only reorders effects; an LFO is not in the chain.
    expect(moveEffect(store, 't4:lfo', 0)).toMatchObject({ changed: false, reason: 'invalid' });
  });

  it('restores a messed-up part to its default routing, keeping channel settings', () => {
    // t2 is a drum part, so its macro map is the plain default one.
    const store = fresh();
    const defaults = keys(defaultTrackPatch('t2'));
    removeEffect(store, 't2:filter');
    const out = store.getState().patch.connections.find((c) => c.from.module === 't2:ch' && c.from.port === 'out')!;
    disconnect(store, out.id);
    insertEffect(store, 't2', 'crusher');
    connect(store, ref('t4:ch', 'sendB'), ref('t2:drive', 'in'));
    setModuleParam(store, 't2:ch', 'level', -10);
    setModuleParam(store, 't2:drive', 'amount', 0.6);
    const messy = store.getState();
    expect(hasPathToMaster(messy.patch, 't2')).toBe(false);
    expect(messy.tracks[1].macroMap.tone).toEqual([]);

    expect(restoreTrackPatch(store, 't2').changed).toBe(true);
    const p = store.getState();
    expect(trackChain(p.patch, 't2')).toEqual(['t2:inst', 't2:drive', 't2:filter', 't2:ch']);
    expect(keys(p.patch, (id) => id.startsWith('t2:'))).toEqual(defaults);
    expect(p.patch.modules.some((m) => m.id === 't2:crusher')).toBe(false);
    expect(p.patch.modules.find((m) => m.id === 't2:ch')!.params.level).toBe(-10);
    expect(p.patch.modules.find((m) => m.id === 't2:drive')!.params.amount).toBe(0.6);
    // The Tone macro lost its targets with the filter; restoring the filter brings them back.
    expect(p.tracks[1].macroMap.tone.map((t) => t.module)).toEqual(['t2:filter', 't2:filter']);
    expect(hasPathToMaster(p.patch, 't2')).toBe(true);
    expect(hasCycle(p.patch)).toBe(false);
    // Other parts are untouched.
    expect(keys(p.patch, (id) => id.startsWith('t1:'))).toEqual(keys(messy.patch, (id) => id.startsWith('t1:')));
    expect(restoreTrackPatch(store, 't2').changed).toBe(false);

    store.undo();
    expect(store.getState().patch).toEqual(messy.patch);
    expect(store.getState().tracks).toEqual(messy.tracks);
  });

  it('restoring a synth part gives re-created modules their macro targets back', () => {
    const store = fresh();
    expect(changeInstrumentSound(store, 't4', 'poly', 'poly-lumen-chords').changed).toBe(true);
    const designed = store.getState().tracks[3].macroMap;
    // The preset maps Tone to the instrument cutoff and the filter's brightness,
    // and Motion to the LFO depth and the filter cutoff.
    expect(designed.tone.map((t) => t.module)).toEqual(['t4:inst', 't4:filter']);
    expect(designed.motion.map((t) => t.module)).toEqual(['t4:lfo', 't4:filter']);

    removeEffect(store, 't4:filter');
    expect(store.getState().tracks[3].macroMap.tone.map((t) => t.module)).toEqual(['t4:inst']);
    expect(store.getState().tracks[3].macroMap.motion.map((t) => t.module)).toEqual(['t4:lfo']);
    // A target removed on purpose from a module that survives stays removed.
    setMacroTarget(store, 't4', 'space', 0, { max: 0.5 });
    expect(restoreTrackPatch(store, 't4').changed).toBe(true);
    const restored = store.getState().tracks[3].macroMap;
    expect(restored.tone).toEqual(designed.tone);
    expect(restored.motion).toEqual(designed.motion);
    expect(restored.space[0].max).toBe(0.5);
    // Motion is audible again: the LFO drives the re-created filter.
    expect(store.getState().patch.connections.some((c) => c.from.module === 't4:lfo' && c.to.module === 't4:filter' && c.to.port === 'cutoff')).toBe(true);
  });

  it('restores the whole default patch', () => {
    const store = fresh();
    const original = store.getState().patch;
    removeEffect(store, 'fx:reverb');
    insertEffect(store, 't6', 'phaser');
    addLfo(store, 't6');
    setModuleParam(store, 't7:filter', 'resonance', 0.8);
    expect(restoreDefaultPatch(store).changed).toBe(true);
    const p = store.getState().patch;
    expect(keys(p)).toEqual(keys(original));
    expect(p.modules.map((m) => m.id).sort()).toEqual(original.modules.map((m) => m.id).sort());
    expect(p.modules.find((m) => m.id === 't7:filter')!.params.resonance).toBe(0.8);
    // Unchanged cables keep their ids, so the engine does not rebuild them.
    const kept = original.connections.find((c) => c.from.module === 't1:inst')!;
    expect(p.connections.find((c) => c.id === kept.id)).toEqual(kept);
    expect(restoreDefaultPatch(store).changed).toBe(false);
  });

  it('the edit lock refuses routing edits but allows knob moves', () => {
    const store = fresh();
    store.setLock('Recording a performance');
    const before = store.getState().patch;
    expect(connect(store, ref('t1:lfo', 'out'), ref('t1:inst', 'pitch'))).toMatchObject({ ok: false, code: 'locked' });
    expect(disconnect(store, before.connections[0].id)).toMatchObject({ changed: false, reason: 'locked' });
    expect(insertEffect(store, 't1', 'chorus')).toMatchObject({ changed: false, reason: 'locked' });
    expect(removeEffect(store, 't1:drive').changed).toBe(false);
    expect(setBypass(store, 't1:drive', true).changed).toBe(false);
    expect(restoreDefaultPatch(store).changed).toBe(false);
    expect(store.getState().patch).toBe(before);
    // Knob movements are recorded by a take, so they stay available.
    expect(setModuleParam(store, 't1:filter', 'resonance', 0.5).changed).toBe(true);
    store.setLock(null);
    expect(connect(store, ref('t1:lfo', 'out'), ref('t1:inst', 'pitch')).ok).toBe(true);
  });

  it('clamps module params and routes instrument-module params to the instrument', () => {
    const store = fresh();
    setModuleParam(store, 't1:filter', 'resonance', 7);
    expect(store.getState().patch.modules.find((m) => m.id === 't1:filter')!.params.resonance).toBe(1);
    setModuleParam(store, 't3:inst', 'cutoff', 5);
    expect(store.getState().tracks[2].instrument.params.cutoff).toBe(40);
    expect(setModuleParam(store, 't1:filter', 'nope', 1)).toMatchObject({ changed: false, reason: 'invalid' });
    // A drag is one undo step.
    for (let i = 0; i < 10; i++) setModuleParam(store, 't2:drive', 'amount', i / 10, 'drag');
    store.undo();
    expect(store.getState().patch.modules.find((m) => m.id === 't2:drive')!.params.amount).toBe(0);
  });
});

describe('step and note editing', () => {
  it('toggles steps on and off, creating a clip when needed', () => {
    const store = fresh();
    const r = toggleStep(store, 't1', 0, 20, 2);
    expect(r).toMatchObject({ changed: true, added: true });
    const clip = store.getState().tracks[0].clips[0]!;
    expect(clip.bars).toBe(2);
    expect(clip.notes).toEqual([{ id: expect.any(String), tick: 480, pitch: 2, velocity: 0.8, duration: 24 }]);
    expect(toggleStep(store, 't1', 0, 3, 2, 0.5).added).toBe(true);
    expect(toggleStep(store, 't1', 0, 20, 2)).toMatchObject({ changed: true, added: false });
    expect(store.getState().tracks[0].clips[0]!.notes.map((n) => n.tick)).toEqual([72]);
    expect(toggleStep(store, 't1', 0, 3, 16)).toMatchObject({ changed: false, reason: 'invalid' }); // drums have 16 voices
    expect(toggleStep(store, 't1', 0, 40, 2)).toMatchObject({ changed: false, reason: 'invalid' }); // past 2 bars
    store.undo();
    store.undo();
    store.undo();
    expect(store.getState().tracks[0].clips[0]).toBeNull();
  });

  it('quantizes, wraps and merges recorded notes', () => {
    expect(quantizeTick(30, '1/16')).toBe(24);
    expect(quantizeTick(37, '1/16')).toBe(48);
    expect(quantizeTick(37.5, 'off')).toBe(37.5);
    const store = fresh();
    createClip(store, 't4', 0, 1);
    addNote(store, 't4', 0, { tick: 24, pitch: 60, velocity: 0.2, duration: 24 });
    addNote(store, 't4', 0, { tick: 48, pitch: 62, velocity: 0.4, duration: 24 });
    const r = addRecordedNotes(
      store,
      't4',
      0,
      [
        { tick: 30, pitch: 60, velocity: 0.9, duration: 20 }, // -> 24, replaces the existing note
        { tick: 380, pitch: 64, velocity: 0.7, duration: 30 }, // -> 384 -> wraps to 0
        { tick: 400.2, pitch: 67, velocity: 0.6, duration: 10 }, // second pass -> 408 -> 24
        { tick: 101, pitch: 300, velocity: 1, duration: 10 }, // invalid pitch
      ],
      { quantize: '1/16', mode: 'overdub' },
    );
    expect(r).toMatchObject({ changed: true, added: 3 });
    const notes = store.getState().tracks[3].clips[0]!.notes.map((n) => [n.tick, n.pitch, n.velocity]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(notes).toEqual([
      [0, 64, 0.7],
      [24, 60, 0.9],
      [24, 67, 0.6],
      [48, 62, 0.4],
    ]);
    addRecordedNotes(store, 't4', 0, [{ tick: 10.25, pitch: 72, velocity: 0.5, duration: 5 }], { quantize: 'off', mode: 'replace' });
    expect(store.getState().tracks[3].clips[0]!.notes.map((n) => [n.tick, n.pitch])).toEqual([[10.25, 72]]);
    store.undo();
    expect(store.getState().tracks[3].clips[0]!.notes).toHaveLength(4);
    // Recording into an empty slot makes a clip long enough for the take.
    addRecordedNotes(store, 't4', 2, [{ tick: 800, pitch: 60, velocity: 0.5, duration: 24 }], { quantize: '1/8', mode: 'overdub' });
    expect(store.getState().tracks[3].clips[2]).toMatchObject({ bars: 3, notes: [{ tick: 816, pitch: 60 }] });
  });

  it('wraps notes played just before the downbeat and respects the clip limit', () => {
    const store = fresh();
    createClip(store, 't6', 0, 1);
    addRecordedNotes(store, 't6', 0, [{ tick: -3, pitch: 65, velocity: 0.5, duration: 24 }, { tick: -30, pitch: 67, velocity: 0.5, duration: 24 }], { quantize: '1/16', mode: 'overdub' });
    expect(store.getState().tracks[5].clips[0]!.notes.map((n) => [n.tick, n.pitch])).toEqual([[0, 65], [360, 67]]);
    // Fill the clip to the limit; a later take may still replace notes but not add new ones.
    const many = Array.from({ length: 2046 }, (_, i) => ({ tick: (i % 384) + 0.5, pitch: 40 + Math.floor(i / 384), velocity: 0.5, duration: 1 }));
    addRecordedNotes(store, 't6', 0, many, { quantize: 'off', mode: 'overdub' });
    expect(store.getState().tracks[5].clips[0]!.notes).toHaveLength(2048);
    const r = addRecordedNotes(store, 't6', 0, [{ tick: 0, pitch: 65, velocity: 1, duration: 24 }, { tick: 100, pitch: 100, velocity: 1, duration: 24 }], { quantize: 'off', mode: 'overdub' });
    expect(r).toMatchObject({ changed: true, added: 1, message: expect.stringMatching(/full/) });
    const notes = store.getState().tracks[5].clips[0]!.notes;
    expect(notes).toHaveLength(2048);
    expect(notes.find((n) => n.tick === 0 && n.pitch === 65)!.velocity).toBe(1);
    expect(notes.some((n) => n.pitch === 100)).toBe(false);
  });

  it('edits single notes, pages and transposition', () => {
    const store = fresh();
    createClip(store, 't5', 1, 1);
    const a = addNote(store, 't5', 1, { tick: 0, pitch: 60, velocity: 0.5, duration: 24 });
    const b = addNote(store, 't5', 1, { tick: 96, pitch: 64, velocity: 0.5, duration: 24 });
    setNoteVelocity(store, 't5', 1, a.noteId!, 5);
    moveNote(store, 't5', 1, b.noteId!, { tick: 0, pitch: 60 }); // lands on a: replaces it
    let notes = store.getState().tracks[4].clips[1]!.notes;
    expect(notes).toEqual([{ id: b.noteId, tick: 0, pitch: 60, velocity: 0.5, duration: 24 }]);
    transposeClip(store, 't5', 1, 70);
    expect(store.getState().tracks[4].clips[1]!.notes[0].pitch).toBe(118);
    duplicatePage(store, 't5', 1, 0);
    const clip = store.getState().tracks[4].clips[1]!;
    expect(clip.bars).toBe(2);
    expect(clip.notes.map((n) => n.tick)).toEqual([0, 384]);
    expect(new Set(clip.notes.map((n) => n.id)).size).toBe(2);
    clearPage(store, 't5', 1, 0);
    notes = store.getState().tracks[4].clips[1]!.notes;
    expect(notes.map((n) => n.tick)).toEqual([384]);
    expect(transposeClip(store, 't1', 0, 2).changed).toBe(false);
  });

  it('dragging a note across others never deletes them', () => {
    const store = fresh();
    createClip(store, 't5', 0, 1);
    const dragged = addNote(store, 't5', 0, { tick: 0, pitch: 60, velocity: 0.5, duration: 24 }).noteId!;
    addNote(store, 't5', 0, { tick: 24, pitch: 60, velocity: 0.9, duration: 24 });
    const steps = [24, 48, 72];
    const results = steps.map((tick) => moveNote(store, 't5', 0, dragged, { tick }, 'drag-1'));
    // Passing over the occupied step is refused; the drag carries on past it.
    expect(results.map((r) => r.changed)).toEqual([false, true, true]);
    expect(results[0]).toMatchObject({ reason: 'occupied' });
    const notes = store.getState().tracks[4].clips[0]!.notes;
    expect(notes.map((n) => [n.tick, n.velocity]).sort((a, b) => a[0] - b[0])).toEqual([[24, 0.9], [72, 0.5]]);
    // The whole drag is one undo step.
    store.undo();
    expect(store.getState().tracks[4].clips[0]!.notes.map((n) => n.tick).sort((a, b) => a - b)).toEqual([0, 24]);
  });
});

describe('clip commands', () => {
  it('setClipBars drops notes past the end and duplicateClipContent doubles', () => {
    const store = fresh();
    createClip(store, 't3', 0, 2);
    for (const tick of [0, 200, 400, 700]) addNote(store, 't3', 0, { tick, pitch: 40, velocity: 1, duration: 24 });
    setClipBars(store, 't3', 0, 1);
    expect(store.getState().tracks[2].clips[0]!.notes.map((n) => n.tick)).toEqual([0, 200]);
    duplicateClipContent(store, 't3', 0);
    const doubled = store.getState().tracks[2].clips[0]!;
    expect(doubled.bars).toBe(2);
    expect(doubled.notes.map((n) => n.tick)).toEqual([0, 200, 384, 584]);
    setClipBars(store, 't3', 0, 3);
    duplicateClipContent(store, 't3', 0); // 3 -> 4: bar 1 repeats into bar 4
    expect(store.getState().tracks[2].clips[0]!.notes.map((n) => n.tick)).toEqual([0, 200, 384, 584, 1152, 1352]);
    expect(duplicateClipContent(store, 't3', 0)).toMatchObject({ changed: false, reason: 'limit' });
    store.undo();
    store.undo();
    store.undo();
    store.undo();
    expect(store.getState().tracks[2].clips[0]!.notes.map((n) => n.tick)).toEqual([0, 200, 400, 700]);
  });

  it('duplicates, pastes and copies with fresh ids', () => {
    const store = fresh();
    createClip(store, 't1', 0, 1);
    toggleStep(store, 't1', 0, 0, 0);
    toggleStep(store, 't1', 0, 4, 64 % 16);
    expect(createClip(store, 't1', 0, 1)).toMatchObject({ changed: false, reason: 'occupied' });
    const d = duplicateClipToSlot(store, 't1', 0, 2);
    const src = store.getState().tracks[0].clips[0]!;
    const dup = store.getState().tracks[0].clips[2]!;
    expect(dup.id).toBe(d.clipId);
    expect(dup.id).not.toBe(src.id);
    expect(dup.notes.map((n) => [n.tick, n.pitch])).toEqual(src.notes.map((n) => [n.tick, n.pitch]));
    expect(dup.notes.some((n) => src.notes.some((m) => m.id === n.id))).toBe(false);

    const copied = copyClip(store.getState(), 't1', 0)!;
    expect(Object.isFrozen(copied)).toBe(false);
    const melodic = makeClip('Mel', 1, [{ tick: 0, pitch: 3, velocity: 1, duration: 24 }, { tick: 24, pitch: 70, velocity: 1, duration: 24 }]);
    const pasted = pasteClip(store, 't1', 3, melodic); // onto drums: pitch 70 cannot play
    expect(pasted.changed).toBe(true);
    expect(pasted.message).toMatch(/1 note/);
    expect(store.getState().tracks[0].clips[3]!.notes.map((n) => n.pitch)).toEqual([3]);
    pasteClip(store, 't4', 0, copied);
    expect(store.getState().tracks[3].clips[0]!.id).not.toBe(copied.id);
  });
});

describe('moving and copying clips between pads', () => {
  /** t1 = drums; t3 = bass, t4 = chords, t8 = sampler (all melodic). */
  function withClips() {
    const store = fresh();
    createClip(store, 't3', 0, 1, 'Bass A');
    addNote(store, 't3', 0, { tick: 0, pitch: 36, velocity: 1, duration: 48 });
    createClip(store, 't3', 1, 2, 'Bass B');
    createClip(store, 't4', 2, 1, 'Chords');
    createClip(store, 't1', 0, 1, 'Beat');
    toggleStep(store, 't1', 0, 0, 0);
    store.clearHistory();
    return store;
  }
  const names = (store: ProjectStore, i: number) => store.getState().tracks[i].clips.map((c) => c?.name ?? null);

  it('moves a clip onto an empty pad (same id, one undo step), across parts of the same kind', () => {
    const store = withClips();
    const id = store.getState().tracks[2].clips[0]!.id;
    expect(moveClip(store, 't3', 0, 't3', 3)).toMatchObject({ changed: true, swapped: false });
    expect(names(store, 2)).toEqual([null, 'Bass B', null, 'Bass A']);
    expect(store.getState().tracks[2].clips[3]!.id).toBe(id);
    expect(store.undoLabel()).toBe('Move clip');
    // Bass to chords: both melodic.
    expect(moveClip(store, 't3', 3, 't4', 0).changed).toBe(true);
    expect(store.getState().tracks[3].clips[0]!.id).toBe(id);
    expect(store.getState().tracks[3].clips[0]!.notes.map((n) => n.pitch)).toEqual([36]);
    store.undo();
    store.undo();
    expect(names(store, 2)).toEqual(['Bass A', 'Bass B', null, null]);
    expect(store.getState().tracks[3].clips[0]).toBeNull();
    expect(store.canUndo()).toBe(false);
  });

  it('dropping onto an occupied pad swaps the two clips', () => {
    const store = withClips();
    expect(moveClip(store, 't3', 0, 't3', 1)).toMatchObject({ changed: true, swapped: true });
    expect(names(store, 2)).toEqual(['Bass B', 'Bass A', null, null]);
    expect(store.undoLabel()).toBe('Swap clips');
    expect(moveClip(store, 't3', 1, 't4', 2)).toMatchObject({ swapped: true });
    expect(names(store, 2)).toEqual(['Bass B', 'Chords', null, null]);
    expect(names(store, 3)).toEqual([null, null, 'Bass A', null]);
    store.undo();
    store.undo();
    expect(names(store, 2)).toEqual(['Bass A', 'Bass B', null, null]);
    expect(names(store, 3)).toEqual([null, null, 'Chords', null]);
  });

  it('copies onto an empty pad, or replaces an occupied one (one undo step), with fresh ids', () => {
    const store = withClips();
    const src = store.getState().tracks[2].clips[0]!;
    const r = copyClipTo(store, 't3', 0, 't3', 2);
    expect(r).toMatchObject({ changed: true, replaced: false });
    const copy = store.getState().tracks[2].clips[2]!;
    expect(copy.id).toBe(r.clipId);
    expect(copy.id).not.toBe(src.id);
    expect(copy.notes.map((n) => [n.tick, n.pitch])).toEqual([[0, 36]]);
    expect(copy.notes[0].id).not.toBe(src.notes[0].id);
    expect(copyClipTo(store, 't3', 0, 't4', 2)).toMatchObject({ changed: true, replaced: true });
    expect(names(store, 3)).toEqual([null, null, 'Bass A', null]);
    expect(store.undoLabel()).toBe('Copy clip');
    store.undo();
    expect(names(store, 3)).toEqual([null, null, 'Chords', null]);
    expect(names(store, 2)).toEqual(['Bass A', 'Bass B', 'Bass A', null]);
  });

  it('refuses drum steps onto a melodic part (and back) with an explanation, and changes nothing', () => {
    const store = withClips();
    const before = store.getState();
    const m = moveClip(store, 't1', 0, 't3', 3);
    expect(m).toMatchObject({ changed: false, reason: 'invalid' });
    expect(m.message).toMatch(/Drums plays drum steps and Bass plays melodic notes/);
    expect(copyClipTo(store, 't4', 2, 't1', 1)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(clipDropProblem(before, 't3', 't8')).toBeNull();
    expect(clipDropProblem(before, 't1', 't2')).toBeNull();
    expect(moveClip(store, 't3', 0, 't3', 0)).toMatchObject({ changed: false });
    expect(moveClip(store, 't3', 2, 't3', 0)).toMatchObject({ changed: false, reason: 'not-found' });
    expect(store.getState()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('is refused while a performance take locks clip edits', () => {
    const store = withClips();
    // Like a take: only the edits it records go through.
    store.setLock('Recording a performance', (label) => label.startsWith('track:Change'));
    expect(moveClip(store, 't3', 0, 't3', 3).refused).toBe('Recording a performance');
    expect(copyClipTo(store, 't3', 0, 't3', 3).refused).toBe('Recording a performance');
    expect(moveScene(store, 0, 2).refused).toBe('Recording a performance');
  });
});

describe('scene rows', () => {
  it('moving a scene moves every part’s clip in the row with it; song blocks keep their scenes (one undo step)', () => {
    const store = fresh();
    createClip(store, 't1', 0, 1, 'Beat 1');
    createClip(store, 't3', 0, 1, 'Bass 1');
    createClip(store, 't3', 2, 1, 'Bass 3');
    createClip(store, 't5', 3, 1, 'Lead 4');
    addBlock(store, store.getState().scenes[0].id, 0);
    store.clearHistory();
    const before = store.getState();
    const sceneIds = before.scenes.map((s) => s.id);
    const blocks = before.arrangement.blocks;
    expect(moveScene(store, 0, 2).changed).toBe(true);
    const p = store.getState();
    expect(p.scenes.map((s) => s.id)).toEqual([sceneIds[1], sceneIds[2], sceneIds[0], sceneIds[3]]);
    expect(p.tracks[0].clips.map((c) => c?.name ?? null)).toEqual([null, null, 'Beat 1', null]);
    expect(p.tracks[2].clips.map((c) => c?.name ?? null)).toEqual([null, 'Bass 3', 'Bass 1', null]);
    expect(p.tracks[4].clips.map((c) => c?.name ?? null)).toEqual([null, null, null, 'Lead 4']);
    expect(p.arrangement.blocks).toBe(blocks);
    expect(validateProject(structuredClone(p)).ok).toBe(true);
    expect(store.undoLabel()).toBe('Move scene');
    expect(moveScene(store, 3, 0).changed).toBe(true);
    expect(store.getState().scenes[0].id).toBe(sceneIds[3]);
    expect(moveScene(store, 1, 1).changed).toBe(false);
    expect(moveScene(store, 0, 4)).toMatchObject({ changed: false, reason: 'invalid' });
    store.undo();
    store.undo();
    expect(store.getState().scenes).toEqual(before.scenes);
    expect(store.getState().tracks).toEqual(before.tracks);
  });
});

describe('arrangement commands', () => {
  it('adds, moves, repeats and removes blocks with undo', () => {
    const store = fresh();
    const original = store.getState().arrangement;
    const scenes = store.getState().scenes;
    const add = addBlock(store, scenes[2].id, 1);
    expect(store.getState().arrangement.blocks[1]).toMatchObject({ id: add.blockId, sceneId: scenes[2].id, repeats: 2 });
    moveBlock(store, 0, 4);
    expect(store.getState().arrangement.blocks[4].sceneId).toBe(scenes[0].id);
    setBlockRepeats(store, add.blockId!, 99);
    expect(store.getState().arrangement.blocks.find((b) => b.id === add.blockId)!.repeats).toBe(16);
    setBlockRepeats(store, add.blockId!, 0);
    expect(store.getState().arrangement.blocks.find((b) => b.id === add.blockId)!.repeats).toBe(1);
    setTailSeconds(store, 25);
    expect(store.getState().arrangement.tailSeconds).toBe(10);
    removeBlock(store, add.blockId!);
    expect(store.getState().arrangement.blocks).toHaveLength(4);
    expect(addBlock(store, 'missing')).toMatchObject({ changed: false, reason: 'not-found' });
    for (let i = 0; i < 6; i++) store.undo();
    expect(store.getState().arrangement).toEqual(original);
  });
});

describe('project, track and sample commands', () => {
  it('clamps tempo, swing and key', () => {
    const store = fresh();
    setBpm(store, 300);
    expect(store.getState().bpm).toBe(220);
    setBpm(store, 10);
    expect(store.getState().bpm).toBe(40);
    setSwing(store, 2);
    expect(store.getState().swing).toBe(1);
    setKey(store, -1, 'dorian');
    expect(store.getState()).toMatchObject({ root: 11, scale: 'dorian' });
    expect(setKey(store, 0, 'nonsense' as never).changed).toBe(false);
  });

  it('edits instrument params, drum voices, arp and macros', () => {
    const store = fresh();
    setInstrumentParam(store, 't3', 'cutoff', 1e6);
    expect(store.getState().tracks[2].instrument.params.cutoff).toBe(12000);
    setDrumVoice(store, 't1', 5, { tune: 30, pan: -0.5 });
    const voices = (store.getState().tracks[0].instrument as { voices: { tune: number; pan: number }[] }).voices;
    expect(voices[5]).toMatchObject({ tune: 12, pan: -0.5 });
    expect(setDrumVoice(store, 't3', 0, { tune: 1 }).changed).toBe(false);
    expect(setArp(store, 't5', { enabled: true, division: '1/8', octaves: 2 }).changed).toBe(true);
    expect(setArp(store, 't5', { octaves: 5 as never }).changed).toBe(false);
    for (let i = 0; i <= 10; i++) setMacro(store, 't2', 'space', i / 10, 'knob');
    expect(store.getState().tracks[1].macros.space).toBe(1);
    store.undo();
    expect(store.getState().tracks[1].macros.space).toBe(0.15);

    const add = setMacroTarget(store, 't2', 'motion', 1, { module: 't2:ch', param: 'pan', min: -1, max: 1, curve: 'lin' });
    expect(add.changed).toBe(true);
    expect(store.getState().tracks[1].macroMap.motion).toHaveLength(2);
    expect(setMacroTarget(store, 't2', 'motion', 0, { max: 5 }).changed).toBe(true);
    expect(store.getState().tracks[1].macroMap.motion[0].max).toBe(1); // LFO depth max
    expect(setMacroTarget(store, 't2', 'motion', 0, { module: 'nowhere' })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(resetMacroMap(store, 't2').changed).toBe(true);
    expect(store.getState().tracks[1].macroMap.motion).toEqual([{ module: 't2:lfo', param: 'depth', min: 0, max: 0.8, curve: 'lin' }]);
  });

  it('imports, assigns and protects recordings in use', () => {
    const store = fresh();
    const meta = { id: 'smp_one', name: 'One', mime: 'audio/wav', byteLength: 100, duration: 1, sampleRate: 48000, channels: 1 };
    expect(addSampleMeta(store, meta).changed).toBe(true);
    expect(addSampleMeta(store, { ...meta, sampleRate: 5 }).changed).toBe(false);
    expect(assignSample(store, 't8', 'smp_one').changed).toBe(true);
    expect(store.getState().tracks[7].instrument).toMatchObject({ kind: 'sampler', sampleId: 'smp_one' });
    expect(removeSampleMeta(store, 'smp_one')).toMatchObject({ changed: false, reason: 'in-use' });
    assignSample(store, 't8', 'builtin:bell-hit');
    expect(removeSampleMeta(store, 'smp_one').changed).toBe(true);
    expect(assignSample(store, 't8', 'smp_one')).toMatchObject({ changed: false, reason: 'invalid' });
  });

  it.skipIf(!presetsReady)('changes a drum kit and undoes it (presets implemented)', () => {
    const store = fresh();
    expect(changeInstrumentSound(store, 't1', 'drums', 'tight-circuit').changed).toBe(true);
    expect(store.getState().tracks[0].instrument).toMatchObject({ kind: 'drums', kitId: 'tight-circuit' });
    store.undo();
    expect(store.getState().tracks[0].instrument).toMatchObject({ kind: 'drums', kitId: 'round-machine' });
    expect(changeInstrumentSound(store, 't1', 'drums', 'no-such-kit').changed).toBe(false);
  });
});

describe('performances', () => {
  function take(p: Project): Performance {
    return {
      id: 'perf_a',
      name: 'Take',
      createdAt: 1,
      startTick: 0,
      endTick: 768,
      snapshot: { bpm: p.bpm, swing: p.swing, root: p.root, scale: p.scale, assist: p.assist, masterVolumeDb: p.masterVolumeDb, tracks: p.tracks, scenes: p.scenes, patch: p.patch, launcher: [], seed: p.seed },
      events: [
        { t: 0, type: 'scene', row: 1, atTick: 0 },
        { t: 100, type: 'macro', trackId: 't1', macro: 'tone', value: 0.2 },
        { t: 500, type: 'mute', trackId: 't2', mute: true },
      ],
    };
  }

  it('adds, edits and trims takes', () => {
    const store = fresh();
    const r = addPerformance(store, take(store.getState()));
    expect(r).toMatchObject({ changed: true, performanceId: 'perf_a' });
    deletePerformanceEvent(store, 'perf_a', 1);
    expect(store.getState().performances[0].events.map((e) => e.type)).toEqual(['scene', 'mute']);
    trimPerformance(store, 'perf_a', 400);
    expect(store.getState().performances[0]).toMatchObject({ endTick: 400, events: [{ type: 'scene' }] });
    const broken = { ...take(store.getState()), id: 'perf_b', snapshot: { ...take(store.getState()).snapshot, tracks: [] } };
    expect(addPerformance(store, broken).changed).toBe(false);
  });

  it('deletes a played note as a unit so nothing is left hanging', () => {
    const store = fresh();
    const perf = take(store.getState());
    perf.events = [
      { t: 0, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 1, key: 'KeyA' },
      { t: 10, type: 'noteOn', trackId: 't5', pitch: 64, velocity: 1, key: 'KeyS' },
      { t: 20, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyA' },
      { t: 30, type: 'macro', trackId: 't1', macro: 'tone', value: 0.5 },
      { t: 40, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 1, key: 'KeyA' },
      { t: 50, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyA' },
      { t: 60, type: 'noteOff', trackId: 't5', pitch: 64, key: 'KeyS' },
    ];
    addPerformance(store, perf);
    const events = () => store.getState().performances[0].events.map((e) => `${e.type}@${e.t}`);
    // Deleting the first KeyA note-off removes its note-on too (not the second KeyA note).
    expect(deletePerformanceEvent(store, 'perf_a', 2)).toMatchObject({ changed: true });
    expect(events()).toEqual(['noteOn@10', 'macro@30', 'noteOn@40', 'noteOff@50', 'noteOff@60']);
    expect(store.undoLabel()).toBe('Delete note');
    // Deleting a note-on removes the matching note-off.
    deletePerformanceEvent(store, 'perf_a', 0);
    expect(events()).toEqual(['macro@30', 'noteOn@40', 'noteOff@50']);
    // Other events go alone.
    deletePerformanceEvent(store, 'perf_a', 0);
    expect(events()).toEqual(['noteOn@40', 'noteOff@50']);
    store.undo();
    store.undo();
    store.undo();
    expect(store.getState().performances[0].events).toHaveLength(7);
  });
});

describe('undo and redo over random edits', () => {
  it('walks back and forth through every intermediate state exactly, and every state validates cleanly', () => {
    const strip = (p: Project) => ({ ...JSON.parse(JSON.stringify(p)), updatedAt: 0 });
    for (let seed = 1; seed <= 6; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
      const int = (n: number) => Math.floor(rnd() * n);
      const store = fresh();
      const states: unknown[] = [strip(store.getState())];
      const done: string[] = [];
      for (let i = 0; i < 90; i++) {
        const t = pick(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
        const p = store.getState();
        const mods = p.patch.modules.map((m) => m.id);
        const cables = p.patch.connections.map((c) => c.id);
        const ops: [string, () => unknown][] = [
          ['step', () => toggleStep(store, t, int(4), int(64), int(16))],
          ['note', () => addNote(store, t, int(4), { tick: int(400), pitch: int(16), velocity: rnd(), duration: 24 })],
          ['bars', () => setClipBars(store, t, int(4), pick([1, 2, 3, 4] as const))],
          ['double', () => duplicateClipContent(store, t, int(4))],
          ['record', () => addRecordedNotes(store, t, int(4), [{ tick: rnd() * 2000 - 100, pitch: int(16), velocity: rnd(), duration: 30 }], { quantize: pick(['off', '1/16'] as const), mode: pick(['overdub', 'replace'] as const) })],
          ['connect', () => connect(store, ref(pick(mods), 'out'), ref(pick(mods), pick(['in', 'cutoff', 'pan'])), rnd())],
          ['disconnect', () => disconnect(store, pick(cables))],
          ['insert', () => insertEffect(store, t, pick(['chorus', 'phaser', 'crusher', 'delay'] as const), int(4))],
          ['remove', () => removeEffect(store, pick(mods))],
          ['moveFx', () => moveEffect(store, pick(mods), int(4))],
          ['restore', () => restoreTrackPatch(store, t)],
          ['lfo', () => addLfo(store, t)],
          ['param', () => setModuleParam(store, pick(mods), pick(['cutoff', 'level', 'amount', 'depth']), rnd() * 2000, pick(['drag', undefined]))],
          ['macro', () => setMacro(store, t, pick(['tone', 'motion'] as const), rnd(), pick(['knob', undefined]))],
          ['block', () => addBlock(store, pick(p.scenes).id, int(5))],
          ['moveBlock', () => moveBlock(store, int(4), int(6))],
          ['sound', () => changeInstrumentSound(store, t, pick(['drums', 'poly'] as const), pick(['tight-circuit', 'poly-halo-pad']))],
          ['transpose', () => transposeClip(store, t, int(4), int(30) - 15)],
          ['page', () => duplicatePage(store, t, int(4), int(4))],
        ];
        const [name, op] = pick(ops);
        const before = store.historySize().undo;
        op();
        const now = store.getState();
        if (store.historySize().undo > before) {
          states.push(strip(now));
          done.push(name);
        } else {
          // A continued gesture merges into the last step.
          states[states.length - 1] = strip(now);
        }
        const v = validateProject(JSON.parse(JSON.stringify(now)));
        expect(v.ok && v.warnings, `seed ${seed}, ${name}`).toEqual([]);
      }
      expect(done.length).toBeGreaterThan(30);
      for (let k = states.length - 1; k > 0; k--) {
        expect(strip(store.getState()), `seed ${seed}: before undoing ${done[k - 1]}`).toEqual(states[k]);
        store.undo();
      }
      expect(strip(store.getState())).toEqual(states[0]);
      expect(store.canUndo()).toBe(false);
      for (let k = 1; k < states.length; k++) {
        store.redo();
        expect(strip(store.getState()), `seed ${seed}: redo ${done[k - 1]}`).toEqual(states[k]);
      }
    }
  });
});

describe('variation', () => {
  it.skipIf(!variationModule)('leaves locked parts unchanged (src/music/variation.ts present)', () => {
    const { applyVariation } = variationModule!;
    const store = fresh();
    toggleStep(store, 't5', 0, 0, 60);
    setLocked(store, 't5', true);
    const before = store.getState();
    expect(applyVariation(store, 't5', 0, 1234)).toMatchObject({ changed: false, reason: 'locked' });
    expect(store.getState()).toBe(before);
    expect(applyVariation(store, 't6', 0, 1)).toMatchObject({ changed: false, reason: 'empty' });
  });

  it.skipIf(!variationModule)('stores the seed, counts generations and is deterministic', () => {
    const { applyVariation } = variationModule!;
    const make = () => {
      const s = new ProjectStore(createProject({ now: 0 }));
      for (const [step, pitch] of [[0, 60], [4, 63], [8, 67], [12, 70]]) toggleStep(s, 't5', 0, step, pitch);
      return s;
    };
    const a = make();
    const b = make();
    applyVariation(a, 't5', 0, 42);
    applyVariation(b, 't5', 0, 42);
    const ca = a.getState().tracks[4].clips[0]!;
    const cb = b.getState().tracks[4].clips[0]!;
    expect(ca.variation).toEqual({ seed: 42, generation: 1 });
    expect(ca.notes.map((n) => [n.tick, n.pitch, n.velocity, n.duration])).toEqual(cb.notes.map((n) => [n.tick, n.pitch, n.velocity, n.duration]));
    for (const n of ca.notes) expect(n.tick).toBeLessThan(ca.bars * 384);
    applyVariation(a, 't5', 0, 43);
    expect(a.getState().tracks[4].clips[0]!.variation).toEqual({ seed: 43, generation: 2 });
    a.undo();
    expect(a.getState().tracks[4].clips[0]).toEqual(ca);
  });
});
