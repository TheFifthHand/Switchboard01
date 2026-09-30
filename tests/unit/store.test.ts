import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/project/factory';
import { HISTORY_LIMIT, ProjectStore, displayLabel } from '../../src/state/projectStore';
import { createStore, shallowEqual, useStore } from '../../src/state/store';
import { createUiStore, selectSlot, setClipboard, setKeyboardOctave, setPadMode, setTipsEnabled, shiftKeyboardOctave, UI_STORAGE_KEY, type KeyValueStorage } from '../../src/state/uiStore';

function clockFrom(start: number) {
  let t = start;
  return () => ++t;
}

describe('createStore', () => {
  it('notifies subscribers with state and previous state, and skips identical states', () => {
    const s = createStore({ n: 1 });
    const seen: [number, number][] = [];
    const off = s.subscribe((next, prev) => seen.push([next.n, prev.n]));
    s.setState({ n: 2 });
    s.setState((prev) => ({ n: prev.n + 1 }));
    const same = s.getState();
    s.setState(same);
    off();
    s.setState({ n: 10 });
    expect(seen).toEqual([
      [2, 1],
      [3, 2],
    ]);
    expect(s.getState().n).toBe(10);
  });

  it('lets a listener unsubscribe while being notified', () => {
    const s = createStore(0);
    const calls: string[] = [];
    const offA = s.subscribe(() => {
      calls.push('a');
      offA();
    });
    s.subscribe(() => calls.push('b'));
    s.setState(1);
    s.setState(2);
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('useStore renders the selected slice', () => {
    const s = createStore({ a: 1, b: { c: 'x' } });
    const View = () => createElement('span', null, useStore(s, (st) => `${st.a}-${st.b.c}`));
    expect(renderToString(createElement(View))).toContain('1-x');
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
  });
});

describe('ProjectStore history', () => {
  it('undoes and redoes named edits and stamps updatedAt outside the history', () => {
    const store = new ProjectStore(createProject({ now: 0 }), { now: clockFrom(100) });
    const original = store.getState();
    expect(store.apply('project:Rename project', (d) => void (d.name = 'A')).changed).toBe(true);
    expect(store.apply('project:Change tempo', (d) => void (d.bpm = 90)).changed).toBe(true);
    expect(store.getState()).toMatchObject({ name: 'A', bpm: 90 });
    expect(store.getState().updatedAt).toBeGreaterThan(original.updatedAt);
    expect(store.undoLabel()).toBe('Change tempo');

    store.undo();
    expect(store.getState()).toMatchObject({ name: 'A', bpm: 120 });
    expect(store.redoLabel()).toBe('Change tempo');
    store.undo();
    expect(store.getState().name).toBe(original.name);
    // Undo is a fresh edit for autosave: the clock moves forward, it is not rewound.
    expect(store.getState().updatedAt).toBeGreaterThan(102);
    expect(store.canUndo()).toBe(false);

    store.redo();
    store.redo();
    expect(store.getState()).toMatchObject({ name: 'A', bpm: 90 });
    expect(store.canRedo()).toBe(false);
  });

  it('ignores edits that change nothing', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const before = store.getState();
    expect(store.apply('project:Change tempo', (d) => void (d.bpm = before.bpm))).toEqual({ changed: false });
    expect(store.getState()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('merges a gesture into one undo step', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const start = store.getState().tracks[0].macros.tone;
    for (let i = 1; i <= 25; i++) store.apply('track:Change Tone', (d) => void (d.tracks[0].macros.tone = i / 100), { gesture: 'drag-1' });
    expect(store.getState().tracks[0].macros.tone).toBe(0.25);
    expect(store.historySize().undo).toBe(1);
    store.undo();
    expect(store.getState().tracks[0].macros.tone).toBe(start);
    store.redo();
    expect(store.getState().tracks[0].macros.tone).toBe(0.25);
  });

  it('starts a new step when the gesture changes or is interrupted', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const set = (v: number, gesture?: string) => store.apply('track:Change Tone', (d) => void (d.tracks[0].macros.tone = v), gesture ? { gesture } : {});
    set(0.1, 'g1');
    set(0.2, 'g1');
    set(0.3, 'g2');
    store.apply('project:Change tempo', (d) => void (d.bpm = 100));
    set(0.4, 'g2'); // same id as before, but not consecutive: new step
    expect(store.historySize().undo).toBe(4);
    store.undo();
    expect(store.getState().tracks[0].macros.tone).toBe(0.3);
    store.undo();
    store.undo();
    expect(store.getState().tracks[0].macros.tone).toBe(0.2);
    // endGesture closes an open gesture explicitly.
    const s2 = new ProjectStore(createProject({ now: 0 }));
    s2.apply('a:x', (d) => void (d.bpm = 100), { gesture: 'g' });
    s2.endGesture();
    s2.apply('a:x', (d) => void (d.bpm = 101), { gesture: 'g' });
    expect(s2.historySize().undo).toBe(2);
  });

  it('an undo group (one Record Notes pass) is one undo step, even with knob moves in between', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    store.apply('project:Change tempo', (d) => void (d.bpm = 100));
    store.beginGroup('Record notes');
    store.apply('clip:Record notes', (d) => void (d.tracks[0].clips[0] = createClip('Take', 1)), { gesture: 'rec' });
    store.apply('track:Change Tone', (d) => void (d.tracks[0].macros.tone = 0.9), { gesture: 'knob' });
    store.apply('clip:Record notes', (d) => void (d.tracks[0].clips[0]!.name = 'Take 2'), { gesture: 'rec' });
    store.endGroup();
    expect(store.historySize().undo).toBe(2);
    expect(store.undoLabel()).toBe('Record notes');
    store.undo();
    expect(store.getState().tracks[0].clips[0]).toBeNull();
    expect(store.getState().tracks[0].macros.tone).not.toBe(0.9);
    expect(store.getState().bpm).toBe(100);
    store.redo();
    expect(store.getState().tracks[0].clips[0]!.name).toBe('Take 2');
    // After the group, edits are separate steps again.
    store.apply('track:Change Tone', (d) => void (d.tracks[0].macros.tone = 0.2), { gesture: 'knob' });
    expect(store.historySize().undo).toBe(3);
    // Undo inside an open group removes what was recorded so far; later edits start the group's step again.
    store.beginGroup('Record notes');
    store.apply('project:Change tempo', (d) => void (d.bpm = 120));
    store.undo();
    expect(store.getState().bpm).toBe(100);
    store.apply('project:Change tempo', (d) => void (d.bpm = 130));
    store.apply('project:Change swing', (d) => void (d.swing = 0.5));
    store.endGroup();
    expect(store.historySize().undo).toBe(4);
    store.undo();
    expect(store.getState().bpm).toBe(100);
    expect(store.getState().swing).not.toBe(0.5);
  });

  it('keeps at most HISTORY_LIMIT steps and clears redo on a new edit', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) store.apply('project:Change tempo', (d) => void (d.bpm = 40 + (i % 150)));
    expect(store.historySize().undo).toBe(HISTORY_LIMIT);
    store.undo();
    expect(store.canRedo()).toBe(true);
    store.apply('project:Rename project', (d) => void (d.name = 'x'));
    expect(store.canRedo()).toBe(false);
  });

  it('replace resets history, or records one undoable step when asked', () => {
    const a = createProject({ name: 'A', now: 0 });
    const b = createProject({ name: 'B', now: 0 });
    const store = new ProjectStore(a);
    store.apply('project:Change tempo', (d) => void (d.bpm = 99));
    store.replace(b);
    expect(store.getState()).toBe(b);
    expect(store.canUndo()).toBe(false);
    store.replace(a, { resetHistory: false, label: 'project:Load starter' });
    expect(store.undoLabel()).toBe('Load starter');
    store.undo();
    expect(store.getState().name).toBe('B');
    store.redo();
    expect(store.getState().name).toBe('A');
  });

  it('skipHistory changes the state without an undo step', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    store.apply('project:Change tempo', (d) => void (d.bpm = 99), { skipHistory: true });
    expect(store.getState().bpm).toBe(99);
    expect(store.canUndo()).toBe(false);
    // A value change elsewhere leaves earlier steps undoable.
    store.apply('project:Rename project', (d) => void (d.name = 'Kept'));
    store.apply('track:Change Tone', (d) => void (d.tracks[0].macros.tone = 0.9), { skipHistory: true });
    expect(store.undoLabel()).toBe('Rename project');
    store.undo();
    expect(store.getState()).toMatchObject({ name: 'Untitled', bpm: 99 });
    expect(store.getState().tracks[0].macros.tone).toBe(0.9);
  });

  it('skipHistory drops undo steps whose recorded positions it invalidates', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const note = (id: string, tick: number) => ({ id, tick, pitch: 1, velocity: 0.5, duration: 24 });
    store.apply('clip:Create clip', (d) => void (d.tracks[0].clips[0] = { id: 'c', name: 'A', bars: 1, notes: [note('a', 0), note('b', 24), note('c', 48)] }));
    store.apply('notes:Change velocity', (d) => void (d.tracks[0].clips[0]!.notes[1].velocity = 0.1)); // note b
    store.apply('project:Change tempo', (d) => void (d.bpm = 90));
    // An unrecorded edit removes note a, so note b now sits at index 0 and c at 1.
    store.apply('notes:Remove', (d) => void d.tracks[0].clips[0]!.notes.splice(0, 1), { skipHistory: true });
    // The newer, unrelated step survives; the velocity step (pointing at notes[1]) and everything older are gone,
    // otherwise undoing it would set note c's velocity.
    expect(store.historySize().undo).toBe(1);
    expect(store.undo().changed).toBe(true);
    expect(store.getState().bpm).toBe(120);
    expect(store.canUndo()).toBe(false);
    expect(store.getState().tracks[0].clips[0]!.notes).toEqual([{ ...note('b', 24), velocity: 0.1 }, note('c', 48)]);
  });

  it('the edit lock refuses routing edits and their undo, but not other edits', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    store.apply('patch:Bypass effect', (d) => void (d.patch.modules[1].bypass = true));
    store.setLock('Recording a performance');
    expect(store.info.getState().lock).toBe('Recording a performance');
    const r = store.apply('patch:Bypass effect', (d) => void (d.patch.modules[2].bypass = true));
    expect(r).toEqual({ changed: false, refused: 'Recording a performance' });
    expect(store.getState().patch.modules[2].bypass).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toEqual({ changed: false, refused: 'Recording a performance' });
    expect(store.getState().patch.modules[1].bypass).toBe(true);
    expect(store.apply('track:Change Tone', (d) => void (d.tracks[0].macros.tone = 0.9)).changed).toBe(true);
    store.setLock(null);
    expect(store.apply('patch:Bypass effect', (d) => void (d.patch.modules[2].bypass = true)).changed).toBe(true);
  });

  it('the edit lock also holds back undoing a whole-project swap, which would replace the patch', () => {
    const a = createProject({ name: 'A', now: 0 });
    const b = createProject({ name: 'B', now: 0 });
    const store = new ProjectStore(a);
    store.replace(b, { resetHistory: false, label: 'project:Load starter' });
    store.setLock('Recording a performance');
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toEqual({ changed: false, refused: 'Recording a performance' });
    expect(store.getState().name).toBe('B');
    store.setLock(null);
    expect(store.undo().changed).toBe(true);
    expect(store.getState().name).toBe('A');
  });

  it('a lock with a path filter lets through only undo steps that change allowed paths, whatever their label', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const valuesOnly = (path: readonly (string | number)[]) => path[0] === 'bpm' || (path[0] === 'tracks' && path[2] === 'macros');
    // Before the lock: a tempo change, and a gesture that moved a macro and (same gesture) renamed the part.
    store.apply('project:Change tempo', (d) => void (d.bpm = 99));
    store.apply('track:Change Tone', (d) => void (d.tracks[0].macros.tone = 0.9), { gesture: 'g' });
    store.apply('track:Change Tone', (d) => void (d.tracks[0].name = 'Renamed'), { gesture: 'g' });
    store.setLock('Recording a performance', (label) => label === 'track:Change Tone' || label === 'project:Change tempo', valuesOnly);
    // The label is allowed, but undoing it would also rename the part: held back, and Undo shows as unavailable.
    expect(store.canUndo()).toBe(false);
    expect(store.info.getState().canUndo).toBe(false);
    expect(store.undo()).toEqual({ changed: false, refused: 'Recording a performance' });
    expect(store.getState().tracks[0].name).toBe('Renamed');
    // An allowed edit made during the lock applies, and its undo only changes a macro: it goes through.
    expect(store.apply('track:Change Tone', (d) => void (d.tracks[0].macros.tone = 0.2)).changed).toBe(true);
    expect(store.canUndo()).toBe(true);
    expect(store.undo()).toEqual({ changed: true });
    expect(store.getState().tracks[0].macros.tone).toBe(0.9);
    expect(store.redo()).toEqual({ changed: true });
    expect(store.getState().tracks[0].macros.tone).toBe(0.2);
    // Unlocked, everything can be undone again.
    const original = createProject({ now: 0 });
    store.setLock(null);
    store.undo();
    expect(store.undo().changed).toBe(true);
    expect(store.getState().tracks[0].name).toBe(original.tracks[0].name);
    expect(store.undo().changed).toBe(true);
    expect(store.getState().bpm).toBe(original.bpm);
  });

  it('publishes history info and freezes states', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const infos: boolean[] = [];
    store.info.subscribe((i) => infos.push(i.canUndo));
    store.apply('project:Change tempo', (d) => void (d.bpm = 99));
    store.undo();
    expect(infos).toEqual([true, false]);
    expect(Object.isFrozen(store.getState())).toBe(true);
    expect(Object.isFrozen(store.getState().tracks[0])).toBe(true);
    expect(displayLabel('patch:Connect cable')).toBe('Connect cable');
    expect(displayLabel('Plain')).toBe('Plain');
  });
});

describe('UI store', () => {
  function memoryStorage(initial?: Record<string, string>): KeyValueStorage & { data: Record<string, string> } {
    const data: Record<string, string> = { ...initial };
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
  }

  it('has first-run defaults and remembers preferences', () => {
    const storage = memoryStorage();
    const ui = createUiStore(storage);
    expect(ui.getState()).toMatchObject({ selectedTrackId: 't1', view: 'play', padMode: 'loops', keyboardOctave: 4, tipsEnabled: true, cablesOpen: false, guideDone: false, clipboard: null });
    setTipsEnabled(false, ui);
    setPadMode('steps', ui);
    shiftKeyboardOctave(10, ui);
    expect(ui.getState().keyboardOctave).toBe(7);
    setKeyboardOctave(Number.NaN, ui);
    expect(ui.getState().keyboardOctave).toBe(7);
    selectSlot('t2', 3, ui);
    selectSlot('t2', 9, ui);
    expect(ui.getState().selectedSlot).toEqual({ t2: 3 });

    const again = createUiStore(storage);
    expect(again.getState()).toMatchObject({ tipsEnabled: false, padMode: 'steps', keyboardOctave: 7 });
    // Selections per clip are not remembered.
    expect(again.getState().selectedSlot).toEqual({});
  });

  it('survives broken or throwing storage', () => {
    const broken = memoryStorage({ [UI_STORAGE_KEY]: '{not json' });
    expect(createUiStore(broken).getState().view).toBe('play');
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    const ui = createUiStore(throwing);
    expect(() => setTipsEnabled(false, ui)).not.toThrow();
    expect(ui.getState().tipsEnabled).toBe(false);
    const hostile = memoryStorage({ [UI_STORAGE_KEY]: JSON.stringify({ view: 'evil', keyboardOctave: 99, selectedTrackId: '<script>' }) });
    expect(createUiStore(hostile).getState()).toMatchObject({ view: 'play', keyboardOctave: 7, selectedTrackId: 't1' });
  });

  it('keeps a detached clipboard copy', () => {
    const ui = createUiStore(null);
    const clip = createClip('A', 1, [{ tick: 0, pitch: 60, velocity: 1, duration: 24 }]);
    setClipboard(clip, ui);
    clip.notes[0].pitch = 10;
    expect(ui.getState().clipboard!.notes[0].pitch).toBe(60);
  });
});
