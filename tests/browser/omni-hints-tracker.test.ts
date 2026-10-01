/**
 * What counts as doing a "Try this" step, read from the real stores (the
 * project with its undo history, and the runtime): only the action itself,
 * never a side effect of something else (opening another project, the
 * scheduler starting a queued clip, a new sound bringing its own macro
 * settings, Stop all, recording notes). Plus the remembered hint state.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeState } from '../../src/app/runtime';
import { HINTS_STORAGE_KEY, INITIAL_HINTS, createHintsStore, hideHints, markHintDone, readHints, showHintsAgain, startHints, type HintId } from '../../src/app/views/hints/hintsState';
import { HINT_STEPS, bassPart, currentHint, drumsPart, type HintContext } from '../../src/app/views/hints/steps';
import { watchHints } from '../../src/app/views/hints/tracker';
import { SYNTH_PRESETS } from '../../src/content/catalog';
import { getStarter } from '../../src/content/starters';
import { createProject } from '../../src/project/factory';
import { applyMasteringPreset, changeInstrumentSound, copyClipTo, moveClip, setMasteringEnabled } from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { createStore } from '../../src/state/store';
import type { KeyValueStorage } from '../../src/state/uiStore';

function runtime(): RuntimeState {
  return {
    audio: 'running', audioMessage: null, playing: true, paused: false, mode: 'live', replayId: null, songBlock: null,
    tracks: {}, recording: 'off', recordTarget: null, countingIn: false, stalled: null, muteAll: false, preview: false, held: {}, notice: null,
  };
}

function setup() {
  const store = new ProjectStore(getStarter('house')!.build());
  const rt = createStore<RuntimeState>(runtime());
  const seen: HintId[] = [];
  const stop = watchHints({ project: store, history: store.info, runtime: rt }, (id) => seen.push(id));
  const p = store.getState();
  return { store, rt, seen, stop, bass: bassPart(p)!, drums: drumsPart(p)! };
}

const setTrack = (rt: ReturnType<typeof createStore<RuntimeState>>, id: string, playingSlot: number | null, queued: { slot: number | null; atTick: number } | null) =>
  rt.setState((s) => ({ ...s, tracks: { ...s.tracks, [id]: { playingSlot, queued } } }));

describe('what counts as doing a step', () => {
  it('a pad: a clip launch queued on the bass part; not the scheduler starting it, not Stop all, not another part', () => {
    const { rt, seen, bass, drums } = setup();
    setTrack(rt, drums.id, 1, { slot: 2, atTick: 384 });
    setTrack(rt, bass.id, null, null);
    // The scheduler starts what Jump In queued: no tap.
    setTrack(rt, bass.id, 1, null);
    // Stop all queues a stop.
    setTrack(rt, bass.id, 1, { slot: null, atTick: 384 });
    expect(seen).toEqual([]);
    // A tap on another Bass pad.
    setTrack(rt, bass.id, 1, { slot: 3, atTick: 768 });
    expect(seen).toEqual(['pad']);
  });

  it('Mute: the drums part muted and then back on; muting alone is half of it', () => {
    const { store, seen, drums, bass } = setup();
    const mute = (id: string, on: boolean) => store.apply('track:Mute', (d) => void (d.tracks.find((t) => t.id === id)!.mute = on));
    mute(bass.id, true);
    mute(bass.id, false);
    mute(drums.id, true);
    expect(seen).toEqual([]);
    mute(drums.id, false);
    expect(seen).toEqual(['mute']);
  });

  it('dragging a clip: move, swap or copy onto another pad; other edits do not count', () => {
    const { store, seen, bass } = setup();
    store.apply('track:Rename', (d) => void (d.tracks.find((t) => t.id === bass.id)!.name = 'Low'));
    expect(seen).toEqual([]);
    const from = bass.clips.findIndex((c) => c !== null);
    const empty = bass.clips.findIndex((c) => c === null);
    expect(moveClip(store, bass.id, from, bass.id, empty).changed).toBe(true);
    expect(seen).toEqual(['drag']);
    expect(copyClipTo(store, bass.id, empty, bass.id, from).changed).toBe(true);
    expect(seen).toEqual(['drag', 'drag']);
  });

  it('Tone: the Tone macro of any part; a new sound with its own macro settings counts as the instrument, not Tone', () => {
    const { store, seen, bass } = setup();
    const inst = bass.instrument;
    if (inst.kind !== 'bass') throw new Error('fixture: the bass part plays a bass synth');
    const other = SYNTH_PRESETS.find((p) => p.kind === 'bass' && p.id !== inst.presetId)!;
    expect(changeInstrumentSound(store, bass.id, 'bass', other.id).changed).toBe(true);
    expect(seen).toEqual(['instrument']);
    store.apply('track:Tone', (d) => void (d.tracks.find((t) => t.id === bass.id)!.macros.tone = 0.9));
    expect(seen).toEqual(['instrument', 'tone']);
  });

  it('mastering: a preset or a mastering setting; switching mastering off and on alone does not count', () => {
    const { store, seen } = setup();
    expect(setMasteringEnabled(store, false).changed).toBe(true);
    expect(setMasteringEnabled(store, true).changed).toBe(true);
    expect(seen).toEqual([]);
    expect(applyMasteringPreset(store, 'punchy').changed).toBe(true);
    expect(seen).toEqual(['master']);
  });

  it('recording: a performance take started and stopped; recording notes does not count', () => {
    const { rt, seen } = setup();
    rt.setState((s) => ({ ...s, recording: 'notes' }));
    rt.setState((s) => ({ ...s, recording: 'off' }));
    rt.setState((s) => ({ ...s, recording: 'performance' }));
    expect(seen).toEqual([]);
    rt.setState((s) => ({ ...s, recording: 'off' }));
    expect(seen).toEqual(['record']);
  });

  it('opening another project changes everything at once, and counts as nothing', () => {
    const { store, seen, stop } = setup();
    const other = getStarter('techno')!.build();
    other.tracks[0].mute = true;
    store.replace(other, { resetHistory: true });
    store.replace(createProject({ name: 'Blank' }), { resetHistory: true });
    expect(seen).toEqual([]);
    stop();
    // After unsubscribing nothing is reported.
    store.apply('track:Tone', (d) => void (d.tracks[2].macros.tone = 0.1));
    expect(seen).toEqual([]);
  });
});

describe('which hint comes next', () => {
  const ctx = (over: Partial<HintContext> = {}): HintContext => ({ view: 'play', padMode: 'loops', bassName: 'Bass', drumsName: 'Drums', drumsMuted: false, recording: false, ...over });

  it('goes in order, one at a time, and ends when all are done', () => {
    expect(currentHint([], ctx())?.step.id).toBe('pad');
    expect(currentHint(['pad'], ctx())?.step.id).toBe('mute');
    // Done out of order (the person found Mix early): that one is not suggested again.
    expect(currentHint(['pad', 'master'], ctx())?.step.id).toBe('mute');
    expect(currentHint(HINT_STEPS.map((s) => s.id), ctx())).toBeNull();
  });

  it('passes over a step the project has nothing for', () => {
    expect(currentHint([], ctx({ bassName: null }))?.step.id).toBe('mute');
  });

  it('says where to go when the step is done elsewhere', () => {
    const master = HINT_STEPS.find((s) => s.id === 'master')!;
    expect(master.here(ctx())).toBe(false);
    expect(master.go).toMatchObject({ label: 'Open Mix', view: 'mix' });
    expect(master.text(ctx())).toBe('Open Mix and try a mastering preset.');
    expect(master.text(ctx({ view: 'mix' }))).toBe('Pick a mastering preset, like Warm or Punchy.');
    const pad = HINT_STEPS.find((s) => s.id === 'pad')!;
    expect(pad.here(ctx({ padMode: 'steps' }))).toBe(false);
    expect(pad.go).toMatchObject({ label: 'Show the pads', view: 'play', padMode: 'loops' });
  });
});

describe('remembered hint state', () => {
  function memory(): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }

  it('starts once, remembers what was done and hidden, and starts over on request', () => {
    const storage = memory();
    const s = createHintsStore(storage);
    expect(s.getState()).toEqual(INITIAL_HINTS);
    startHints(s);
    markHintDone('mute', s);
    markHintDone('pad', s);
    markHintDone('pad', s);
    expect(s.getState().done).toEqual(['pad', 'mute']);
    hideHints(s);
    // Jump In again does not bring hidden hints back.
    startHints(s);
    expect(s.getState()).toMatchObject({ started: true, hidden: true });
    // A new page load reads the same.
    expect(createHintsStore(storage).getState()).toEqual(s.getState());
    showHintsAgain(s);
    expect(s.getState()).toEqual({ started: true, hidden: false, done: [], finished: false });
  });

  it('ignores damaged or unknown stored values', () => {
    const storage = memory();
    storage.setItem(HINTS_STORAGE_KEY, '{not json');
    expect(readHints(storage)).toEqual(INITIAL_HINTS);
    storage.setItem(HINTS_STORAGE_KEY, JSON.stringify({ started: 'yes', hidden: true, done: ['pad', 'fly', 3], finished: 1 }));
    expect(readHints(storage)).toEqual({ started: false, hidden: true, done: ['pad'], finished: false });
    expect(readHints(null)).toEqual(INITIAL_HINTS);
    // Storage that throws: hints still work, they are just not remembered.
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const s = createHintsStore(broken);
    startHints(s);
    expect(s.getState().started).toBe(true);
  });
});
