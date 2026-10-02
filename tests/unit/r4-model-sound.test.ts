/**
 * Safer sound edits: a part's sound saved and restored in one step (and a
 * whole sound-browser session as one undo step), designed values to return
 * to, big knobs that come back with a re-added effect and say when they
 * reach nothing, effects copied between parts, room for 8 effects per part,
 * and undo steps that name the part.
 */
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/content/presets';
import { kitInfo } from '../../src/content/catalog';
import { HOUSE } from '../../src/content/starters/house';
import { createProject, defaultMacros } from '../../src/project/factory';
import { trackChain } from '../../src/project/graph';
import { PATCH_LIMITS } from '../../src/project/modules';
import { MACRO_IDS, MAX_TRACKS, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import {
  MAX_EXTRA_LFOS,
  addLfo,
  connect,
  copyEffectChain,
  disconnect,
  insertEffect,
  macroReach,
  pasteEffectChain,
  removeEffect,
  setBypass,
  setModuleParam,
} from '../../src/state/commands/patch';
import { changeInstrumentSound, macroHomeFor, paramHomeFor, restoreTrackSound, setInstrumentParam, setMacro, setMute, setSolo, snapshotTrackSound } from '../../src/state/commands/tracks';

function valid(p: Project): void {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  expect(r.ok && r.warnings).toEqual([]);
}

const chords = (p: Project) => p.tracks[3];

describe('a part’s sound, saved and restored', () => {
  it('restores the instrument, big knobs, mappings and module settings as they were, in one step', () => {
    const store = new ProjectStore(HOUSE.build());
    setMacro(store, 't4', 'tone', 0.7);
    setInstrumentParam(store, 't4', 'release', 1.5);
    setModuleParam(store, 't4:drive', 'character', 1);
    const tweaked = store.getState();
    const snap = snapshotTrackSound(tweaked, 't4')!;
    changeInstrumentSound(store, 't4', 'poly', 'poly-glass-keys');
    changeInstrumentSound(store, 't4', 'poly', 'poly-tine-piano');
    changeInstrumentSound(store, 't4', 'poly', 'poly-house-stab');
    // Choosing the original again loads its preset, not the tweaks.
    expect(chords(store.getState()).macros.tone).toBe(0.5);
    const steps = store.historySize().undo;
    const r = restoreTrackSound(store, 't4', snap);
    expect(r).toMatchObject({ changed: true, missing: 0 });
    expect(store.historySize().undo).toBe(steps + 1);
    expect(store.undoLabel()).toBe('Restore sound');
    const p = store.getState();
    expect(chords(p)).toEqual(chords(tweaked));
    expect(p.patch.modules.filter((m) => m.trackId === 't4')).toEqual(tweaked.patch.modules.filter((m) => m.trackId === 't4'));
    expect(restoreTrackSound(store, 't4', snap)).toMatchObject({ changed: false });
    expect(restoreTrackSound(store, 't5', snap)).toMatchObject({ changed: false, reason: 'invalid' });
    // The snapshot is detached: later edits do not change it.
    setMacro(store, 't4', 'tone', 0.1);
    expect(snap.macros.tone).toBe(0.7);
  });

  it('a whole browse session is one undo step; Cancel (restore) inside it leaves no step at all', () => {
    const store = new ProjectStore(HOUSE.build());
    setMacro(store, 't4', 'tone', 0.7);
    const tweaked = store.getState();
    const steps = store.historySize().undo;

    // Browse three sounds, keep the last: one step, and one Undo returns the tweaked sound.
    store.beginGroup('Change sound');
    changeInstrumentSound(store, 't4', 'poly', 'poly-glass-keys');
    changeInstrumentSound(store, 't4', 'poly', 'poly-tine-piano');
    expect(store.endGroup()).toEqual({ step: true });
    expect(store.historySize().undo).toBe(steps + 1);
    expect(store.undoLabel()).toBe('Change sound');
    store.undo();
    expect(chords(store.getState())).toEqual(chords(tweaked));

    // Browse, then Cancel: back to the tweaked sound, and Undo still undoes the Tone move.
    const snap = snapshotTrackSound(store.getState(), 't4')!;
    store.beginGroup('Change sound');
    changeInstrumentSound(store, 't4', 'poly', 'poly-glass-keys');
    changeInstrumentSound(store, 't4', 'poly', 'poly-house-stab');
    restoreTrackSound(store, 't4', snap);
    expect(store.endGroup()).toEqual({ step: false });
    expect(chords(store.getState())).toEqual(chords(tweaked));
    expect(store.historySize().undo).toBe(steps);
    expect(store.undoLabel()).toBe('Change Tone');
  });
});

describe('designed values (where double-click returns)', () => {
  it('a synth sound records its Tone, Motion and Drive; a starter records every big knob', () => {
    const house = HOUSE.build();
    expect(macroHomeFor(chords(house), 'space')).toBe(0.28);
    expect(macroHomeFor(chords(house), 'pump')).toBe(0.45);
    const store = new ProjectStore(house);
    setMacro(store, 't4', 'space', 0.6);
    changeInstrumentSound(store, 't4', 'poly', 'poly-glass-keys');
    const t = chords(store.getState());
    for (const m of ['tone', 'motion', 'drive'] as const) expect(macroHomeFor(t, m)).toBe(t.macros[m]);
    // Space is the part's mix, not the sound: its designed place stays the starter's.
    expect(macroHomeFor(t, 'space')).toBe(0.28);
    const plain = createProject({ now: 0 }).tracks[0];
    for (const m of MACRO_IDS) expect(macroHomeFor(plain, m)).toBe(defaultMacros()[m]);
  });

  it('a knob returns to the preset’s value, a kit’s matched level, else the registry default', () => {
    const house = HOUSE.build();
    const bass = house.tracks[2];
    if (bass.instrument.kind !== 'bass') throw new Error('bass');
    expect(paramHomeFor(bass, 'resonance')).toBe(PRESETS[bass.instrument.presetId].params.resonance);
    expect(paramHomeFor(bass, 'nonsense')).toBeUndefined();
    const drums = house.tracks[0];
    expect(paramHomeFor(drums, 'level')).toBe(kitInfo('tight-circuit')!.level);
    expect(paramHomeFor(drums, 'tune')).toBe(0);
    if (chords(house).instrument.kind !== 'poly') throw new Error('poly');
    expect(paramHomeFor(chords(house), 'division', 'lfo')).toBe(PRESETS['poly-house-stab'].modules!.lfo!.division);
    expect(paramHomeFor(house.tracks[7], 'rootNote')).toBe(60);
  });
});

describe('big knobs after effects are removed and added back (shape-02)', () => {
  it('a removed Drive leaves the Drive big knob with nothing to move; adding a Drive back reconnects it', () => {
    const store = new ProjectStore(HOUSE.build());
    expect(macroReach(store.getState(), 't4', 'drive')).toBe('audible');
    const r = removeEffect(store, 't4:drive');
    expect(r.affectedMacros).toEqual(['drive']);
    expect(macroReach(store.getState(), 't4', 'drive')).toBe('none');
    expect(chords(store.getState()).macroMap.drive).toEqual([]);
    const added = insertEffect(store, 't4', 'drive');
    expect(added.moduleId).toBe('t4:drive');
    expect(chords(store.getState()).macroMap.drive).toEqual([{ module: 't4:drive', param: 'amount', min: 0, max: 1, curve: 'lin' }]);
    expect(macroReach(store.getState(), 't4', 'drive')).toBe('audible');
    // A second drive is the user's own: no mapping.
    insertEffect(store, 't4', 'drive');
    expect(chords(store.getState()).macroMap.drive).toHaveLength(1);
    valid(store.getState());
  });

  it('a removed Filter takes the LFO’s only cable, so Motion moves nothing; a Filter added back is cabled and mapped again', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = chords(store.getState()).macroMap;
    const r = removeEffect(store, 't4:filter');
    expect(r.affectedMacros).toEqual(['motion']);
    const p = store.getState();
    expect(p.patch.connections.some((c) => c.from.module === 't4:lfo')).toBe(false);
    // The LFO-depth target is still mapped, but its LFO reaches nothing heard.
    expect(chords(p).macroMap.motion.map((x) => x.module)).toEqual(['t4:lfo']);
    expect(macroReach(p, 't4', 'motion')).toBe('none');
    insertEffect(store, 't4', 'filter');
    const q = store.getState();
    const cable = q.patch.connections.find((c) => c.from.module === 't4:lfo')!;
    expect(cable).toMatchObject({ from: { module: 't4:lfo', port: 'out' }, to: { module: 't4:filter', port: 'cutoff' }, amount: 1 });
    expect(chords(q).macroMap).toEqual(before);
    expect(macroReach(q, 't4', 'motion')).toBe('audible');
    valid(q);
  });

  it('macroReach treats switched-off LFOs and sends cabled nowhere as inert', () => {
    const store = new ProjectStore(HOUSE.build());
    // Drums: Motion only sets the LFO's depth.
    expect(macroReach(store.getState(), 't1', 'motion')).toBe('audible');
    setBypass(store, 't1:lfo', true);
    expect(macroReach(store.getState(), 't1', 'motion')).toBe('none');
    // Chords: Motion also moves the filter's centre, which is heard with the LFO off.
    setBypass(store, 't4:lfo', true);
    expect(macroReach(store.getState(), 't4', 'motion')).toBe('audible');
    const send = store.getState().patch.connections.find((c) => c.from.module === 't4:ch' && c.from.port === 'sendA')!;
    expect(macroReach(store.getState(), 't4', 'space')).toBe('audible');
    disconnect(store, send.id);
    expect(macroReach(store.getState(), 't4', 'space')).toBe('none');
    expect(macroReach(store.getState(), 't4', 'pump')).toBe('audible');
  });
});

describe('copy and paste a part’s effects (shape-15)', () => {
  function setup() {
    const store = new ProjectStore(HOUSE.build());
    insertEffect(store, 't4', 'eq');
    setModuleParam(store, 't4:eq', 'lowGain', -4);
    insertEffect(store, 't4', 'reverb');
    setBypass(store, 't4:reverb', true);
    return store;
  }

  it('copies the effects as they play, leaving out the default Drive and Filter while they do nothing', () => {
    const store = setup();
    const clip = copyEffectChain(store.getState(), 't4')!;
    expect(clip.from).toBe('Chords');
    expect(clip.effects.map((e) => [e.type, e.bypass])).toEqual([['eq', false], ['reverb', true]]);
    expect(clip.effects[0].params.lowGain).toBe(-4);
    // Turned up, the default Drive is copied too, with the amount it plays at.
    setMacro(store, 't4', 'drive', 0.5);
    expect(copyEffectChain(store.getState(), 't4')!.effects.map((e) => e.type)).toEqual(['drive', 'eq', 'reverb']);
    expect(copyEffectChain(store.getState(), 't4')!.effects[0].params.amount).toBe(0.5);
  });

  it('pastes after the part’s effects or instead of them (keeping its default Drive and Filter), in one step', () => {
    const store = setup();
    const clip = copyEffectChain(store.getState(), 't4')!;
    insertEffect(store, 't5', 'chorus');
    const steps = store.historySize().undo;
    const r = pasteEffectChain(store, 't5', clip);
    expect(r).toMatchObject({ changed: true, moduleIds: ['t5:eq', 't5:reverb'], removed: 0 });
    expect(store.historySize().undo).toBe(steps + 1);
    expect(trackChain(store.getState().patch, 't5')).toEqual(['t5:inst', 't5:drive', 't5:filter', 't5:chorus', 't5:eq', 't5:reverb', 't5:ch']);
    expect(store.getState().patch.modules.find((m) => m.id === 't5:reverb')!.bypass).toBe(true);
    store.undo();
    const replaced = pasteEffectChain(store, 't5', clip, { replace: true });
    expect(replaced).toMatchObject({ changed: true, removed: 1 });
    expect(trackChain(store.getState().patch, 't5')).toEqual(['t5:inst', 't5:drive', 't5:filter', 't5:eq', 't5:reverb', 't5:ch']);
    // The Lead's big knobs still drive its default modules.
    expect(macroReach(store.getState(), 't5', 'drive')).toBe('audible');
    expect(macroReach(store.getState(), 't5', 'motion')).toBe('audible');
    valid(store.getState());
  });

  it('refuses past 8 effects, unknown effects and the take lock, with nothing changed', () => {
    const store = setup();
    for (const t of ['chorus', 'phaser', 'flanger', 'tape', 'crusher'] as const) insertEffect(store, 't5', t);
    const before = store.getState();
    const clip = copyEffectChain(before, 't4')!;
    expect(pasteEffectChain(store, 't5', clip)).toMatchObject({ changed: false, reason: 'limit' });
    expect(pasteEffectChain(store, 't5', { from: 'x', effects: [{ type: 'lfo', params: {}, bypass: false }] })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(pasteEffectChain(store, 't5', { from: 'x', effects: [] })).toMatchObject({ changed: false, reason: 'empty' });
    store.setLock('Recording a performance');
    expect(pasteEffectChain(store, 't6', clip)).toMatchObject({ changed: false, reason: 'locked' });
    expect(store.getState()).toBe(before);
  });
});

describe('room for effects (shape-16)', () => {
  it('a part holds 8 effects, counting its default Drive and Filter', () => {
    expect(PATCH_LIMITS.maxEffectsPerTrack).toBe(8);
    const store = new ProjectStore(createProject({ now: 0 }));
    for (const t of ['eq', 'compressor', 'gate', 'reverb', 'delay', 'chorus'] as const) expect(insertEffect(store, 't4', t).changed).toBe(true);
    expect(trackChain(store.getState().patch, 't4')!.length - 2).toBe(8);
    expect(insertEffect(store, 't4', 'tape')).toMatchObject({ changed: false, reason: 'limit', message: 'A part can have up to 8 effects.' });
  });

  it('every part at its fullest at once (8 effects and 3 extra LFOs, each cabled) fits the patch limits', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const types = ['eq', 'compressor', 'gate', 'reverb', 'delay', 'chorus'] as const;
    for (let i = 1; i <= MAX_TRACKS; i++) {
      const t = `t${i}`;
      for (const type of types) expect(insertEffect(store, t, type).changed, `${t} ${type}`).toBe(true);
      for (let k = 0; k < MAX_EXTRA_LFOS; k++) {
        const r = addLfo(store, t);
        expect(r.changed, `${t} LFO ${k}`).toBe(true);
        expect(connect(store, { module: r.moduleId!, port: 'out' }, { module: `${t}:ch`, port: k === 0 ? 'pan' : 'level' }).ok, `${t} LFO cable ${k}`).toBe(true);
      }
    }
    const p = store.getState();
    expect(p.patch.modules.length).toBeLessThanOrEqual(PATCH_LIMITS.maxModules);
    expect(p.patch.connections.length).toBeLessThanOrEqual(PATCH_LIMITS.maxConnections);
    valid(p);
  });
});

describe('undo steps name the part (MIX-15)', () => {
  it('channel moves and mutes say which part', () => {
    const store = new ProjectStore(HOUSE.build());
    setModuleParam(store, 't3:ch', 'level', -6, 'fader');
    setModuleParam(store, 't3:ch', 'level', -5, 'fader');
    expect(store.undoLabel()).toBe('Bass level');
    setModuleParam(store, 't1:ch', 'pan', 0.2);
    expect(store.undoLabel()).toBe('Drums pan');
    setModuleParam(store, 't4:ch', 'sendA', 0.3);
    expect(store.undoLabel()).toBe('Chords reverb amount');
    setMute(store, 't5', true);
    expect(store.undoLabel()).toBe('Mute Lead');
    setSolo(store, 't5', true);
    expect(store.undoLabel()).toBe('Solo Lead');
    store.undo();
    expect(store.redoLabel()).toBe('Solo Lead');
    // Effect knobs keep their own words.
    setModuleParam(store, 't4:filter', 'resonance', 0.3);
    expect(store.undoLabel()).toBe('Change Filter Resonance');
  });

  it('a performance take still records mutes and channel moves (the kind of edit is unchanged)', () => {
    const store = new ProjectStore(HOUSE.build());
    // The take's allow-list, as the session sets it.
    store.setLock('Recording a performance', (label) => label.startsWith('module:') || label === 'track:Mute part' || label === 'track:Unmute part');
    expect(setMute(store, 't5', true).changed).toBe(true);
    expect(setModuleParam(store, 't3:ch', 'level', -9).changed).toBe(true);
    expect(setSolo(store, 't5', true).refused).toBe('Recording a performance');
  });
});
