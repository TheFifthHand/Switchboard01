/**
 * Two MIDI controls moved at the same time (the mod wheel and a learned knob)
 * make one undo step together, not one per message, so they never push the
 * user's earlier edits out of the history. A pause with no control moving
 * starts the next step.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MidiController, type MidiEnvironment, type MidiSessionApi } from '../../src/app/midi';
import { createProject } from '../../src/project/factory';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { selectTrack } from '../../src/state/uiStore';

function fakeSession(store: ProjectStore): MidiSessionApi {
  return {
    store,
    engine: {},
    noteOn() {},
    noteOff() {},
    setPitchBend() {},
    setMacro: (t, m, v, g) => void cmd.setMacro(store, t, m, v, g),
    setModuleParam: (mod, p, v, g) => void cmd.setModuleParam(store, mod, p, v, g),
    setMasterVolume: (db, g) => void cmd.setMasterVolume(store, db, g),
    setBpm: (b, g) => void cmd.setBpm(store, b, g),
    onAllNotesReleased: () => () => {},
  };
}
const env = (): MidiEnvironment => ({ requestAccess: null, secure: true, permission: async () => 'granted', hasUserActivation: () => true });

let controllers: MidiController[] = [];

/** A project, its store and a controller with CC 74 learned as the master volume. */
function setup() {
  const p = createProject({ name: 'midi undo', now: 1 });
  const store = new ProjectStore(p);
  selectTrack(p.tracks[0].id);
  const midi = new MidiController(fakeSession(store), env);
  controllers.push(midi);
  midi.startLearn({ kind: 'master' });
  midi.handleMessage('in-0', [0xb0, 74, 10]);
  return { p, store, midi };
}

afterEach(() => {
  for (const c of controllers) c.dispose();
  controllers = [];
  vi.useRealTimers();
});

describe('MIDI controls moved together', () => {
  it('make one undo step, and Undo puts both back', () => {
    const { p, store, midi } = setup();
    expect(store.historySize().undo).toBe(0);
    for (let i = 0; i < 20; i++) {
      midi.handleMessage('in-0', [0xb0, 1, 10 + i * 5]); // mod wheel → Motion
      midi.handleMessage('in-0', [0xb0, 74, 20 + i * 4]); // learned knob → master volume
    }
    expect(store.getState().tracks[0].macros.motion).not.toBe(p.tracks[0].macros.motion);
    expect(store.getState().masterVolumeDb).not.toBe(p.masterVolumeDb);
    expect(store.historySize().undo).toBe(1);
    expect(store.undo().changed).toBe(true);
    expect(store.getState().tracks[0].macros.motion).toBe(p.tracks[0].macros.motion);
    expect(store.getState().masterVolumeDb).toBe(p.masterVolumeDb);
  });

  it('keep the edits made before them undoable', () => {
    const { p, store, midi } = setup();
    cmd.setBpm(store, 133); // the user's earlier edit
    // About 3 s of two controls at ~35 messages a second each.
    for (let i = 0; i < 110; i++) {
      midi.handleMessage('in-0', [0xb0, 1, (i * 7) % 128]);
      midi.handleMessage('in-0', [0xb0, 74, (i * 5) % 128]);
    }
    expect(store.historySize().undo).toBe(2);
    while (store.undo().changed);
    expect(store.getState().bpm).toBe(p.bpm);
  });

  it('a pause with no control moving starts the next undo step', () => {
    vi.useFakeTimers();
    const { store, midi } = setup();
    midi.handleMessage('in-0', [0xb0, 1, 20]);
    vi.advanceTimersByTime(300);
    // Still moving (the knob keeps the movement going).
    midi.handleMessage('in-0', [0xb0, 74, 40]);
    vi.advanceTimersByTime(300);
    midi.handleMessage('in-0', [0xb0, 1, 30]);
    expect(store.historySize().undo).toBe(1);
    vi.advanceTimersByTime(1000);
    midi.handleMessage('in-0', [0xb0, 74, 90]);
    expect(store.historySize().undo).toBe(2);
  });
});
