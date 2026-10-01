/**
 * MIDI keyboards and controllers with the real session and real Web Audio in
 * Chromium, and a fake MIDIAccess standing in for the browser's: notes reach
 * the part through the session (velocity, Musical Assist, the drum map),
 * the sustain pedal, pitch bend and mod wheel act, nothing is left hanging
 * (unplug, Stop, Pause, Mute All, blur, part change), MIDI learn maps
 * controls, Record Notes and Record Performance record MIDI like the
 * computer keyboard, and connecting explains every refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIDI_DENIED_MESSAGE, MIDI_INSECURE_MESSAGE, MIDI_SETTINGS_KEY, MIDI_SOUND_OFF_MESSAGE, MIDI_UNSUPPORTED_MESSAGE, MidiController, drumPadForNote, readMidiSettings, type MidiAccessLike, type MidiEnvironment, type MidiInputLike, type MidiMessageLike } from '../../src/app/midi';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { snapToScale } from '../../src/music/scales';
import { createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { defaultUiState, selectSlot, selectTrack, uiStore } from '../../src/state/uiStore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rt = () => runtimeStore.getState();
/** Pitches a part holds now (none: []). */
const heldOn = (trackId: string) => rt().held[trackId] ?? [];

class FakeInput implements MidiInputLike {
  onmidimessage: ((e: MidiMessageLike) => void) | null = null;
  state = 'connected';
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  send(...bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) });
  }
}

class FakeAccess implements MidiAccessLike {
  inputs = new Map<string, FakeInput>();
  onstatechange: MidiAccessLike['onstatechange'] = null;
  plug(input: FakeInput): void {
    input.state = 'connected';
    this.inputs.set(input.id, input);
    this.onstatechange?.({ port: { id: input.id, type: 'input', state: 'connected' } });
  }
  unplug(id: string): void {
    const input = this.inputs.get(id)!;
    input.state = 'disconnected';
    // Like Chrome: the port closes (its handler stops) and stays listed as disconnected.
    input.onmidimessage = null;
    this.onstatechange?.({ port: { id, type: 'input', state: 'disconnected' } });
  }
}

function env(access: FakeAccess | null, over: Partial<MidiEnvironment> = {}): () => MidiEnvironment {
  return () => ({
    requestAccess: access ? async () => access : null,
    secure: true,
    permission: async () => 'granted',
    hasUserActivation: () => true,
    ...over,
  });
}

let sessions: Session[] = [];
let controllers: MidiController[] = [];

/** A started session; Musical Assist off unless asked for, so the pitches below are the keys pressed. */
async function started(opts: { assist?: boolean; project?: Project } = {}): Promise<Session> {
  const base = opts.project ?? createProject({ name: 'MIDI test', now: 1 });
  const s = new Session({ ...base, assist: opts.assist ?? false });
  sessions.push(s);
  expect(await s.startAudio()).toBe(true);
  return s;
}

async function connected(s: Session, ...names: string[]): Promise<{ midi: MidiController; access: FakeAccess; inputs: FakeInput[] }> {
  const access = new FakeAccess();
  const inputs = (names.length ? names : ['Keys 49']).map((n, i) => new FakeInput(`in-${i}`, n));
  for (const i of inputs) access.inputs.set(i.id, i);
  const midi = new MidiController(s, env(access));
  controllers.push(midi);
  expect(await midi.connect()).toBe(true);
  return { midi, access, inputs };
}

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CC = 0xb0;
const BEND = 0xe0;

beforeEach(() => {
  localStorage.removeItem(MIDI_SETTINGS_KEY);
  uiStore.setState({ ...defaultUiState() });
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, recording: 'off', recordTarget: null, countingIn: false, held: {}, notice: null, tracks: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const c of controllers) c.dispose();
  controllers = [];
  for (const s of sessions) s.dispose();
  sessions = [];
  localStorage.removeItem(MIDI_SETTINGS_KEY);
  patchRuntime({ muteAll: false, playing: false, paused: false, recording: 'off', recordTarget: null, held: {}, notice: null, tracks: {} });
});

describe('Notes from a MIDI keyboard', () => {
  it('connect lists the inputs; a key plays the selected part through the session with its velocity and Musical Assist', async () => {
    const s = await started({ assist: true });
    const { midi, inputs } = await connected(s, 'Keys 49', 'Pad Controller');
    expect(midi.state.getState().status).toBe('connected');
    expect(midi.state.getState().inputs.map((i) => i.name)).toEqual(['Keys 49', 'Pad Controller']);
    selectTrack('t4');
    const on = vi.spyOn(s.engine!, 'liveNoteOn');
    const off = vi.spyOn(s.engine!, 'liveNoteOff');
    const p = s.store.getState();
    expect(p.assist).toBe(true);
    const snapped = snapToScale(61, p.root, p.scale);
    inputs[0].send(NOTE_ON, 61, 127);
    expect(on).toHaveBeenLastCalledWith('t4', snapped, 1, 'midi:t4:61');
    expect(heldOn('t4')).toEqual([snapped]);
    inputs[0].send(NOTE_ON | 3, 64, 32); // channel 4, soft
    expect(on).toHaveBeenLastCalledWith('t4', snapToScale(64, p.root, p.scale), 32 / 127, 'midi:t4:64');
    inputs[0].send(NOTE_OFF, 61, 0);
    expect(off).toHaveBeenCalledWith('t4', 'midi:t4:61');
    // Note-on with velocity 0 is a note-off.
    inputs[0].send(NOTE_ON | 3, 64, 0);
    expect(off).toHaveBeenCalledWith('t4', 'midi:t4:64');
    expect(heldOn('t4')).toEqual([]);
    expect(midi.heldCount()).toBe(0);
    // Activity is noted per input (the dialog's lights read it).
    expect(performance.now() - midi.lastActivity('in-0')).toBeLessThan(1000);
    expect(midi.lastActivity('in-1')).toBe(-Infinity);
    // Clock and active sensing are not activity.
    const before = midi.lastActivity('in-1');
    inputs[1].send(0xf8);
    inputs[1].send(0xfe);
    expect(midi.lastActivity('in-1')).toBe(before);
  });

  it('drum parts follow the General MIDI drum map', async () => {
    const s = await started();
    const { inputs } = await connected(s);
    selectTrack('t1');
    const on = vi.spyOn(s.engine!, 'liveNoteOn');
    inputs[0].send(NOTE_ON | 9, 36, 100);
    inputs[0].send(NOTE_ON | 9, 38, 100);
    inputs[0].send(NOTE_ON | 9, 42, 100);
    inputs[0].send(NOTE_ON | 9, 46, 100);
    expect(on.mock.calls.map((c) => c[1])).toEqual([0, 2, 4, 5]);
    expect(drumPadForNote(39)).toBe(3);
    expect(drumPadForNote(49)).toBe(12);
    // Every key plays a pad.
    for (let n = 0; n < 128; n++) expect(drumPadForNote(n)).toBeGreaterThanOrEqual(0), expect(drumPadForNote(n)).toBeLessThan(16);
  });

  it('two keyboards on the same note: the note ends when the last key lets go', async () => {
    const s = await started();
    const { inputs } = await connected(s, 'A', 'B');
    selectTrack('t4');
    const off = vi.spyOn(s.engine!, 'liveNoteOff');
    inputs[0].send(NOTE_ON, 60, 100);
    inputs[1].send(NOTE_ON, 60, 100);
    inputs[0].send(NOTE_OFF, 60, 0);
    expect(heldOn('t4')).toEqual([60]);
    inputs[1].send(NOTE_OFF, 60, 0);
    expect(heldOn('t4')).toEqual([]);
    expect(off).toHaveBeenLastCalledWith('t4', 'midi:t4:60');
  });
});

describe('Sustain pedal', () => {
  it('holds notes until it is let go of; a key still down keeps its note; a note struck again under the pedal sounds again', async () => {
    const s = await started();
    const { inputs } = await connected(s);
    selectTrack('t4');
    const kb = inputs[0];
    const on = vi.spyOn(s.engine!, 'liveNoteOn');
    kb.send(CC, 64, 127);
    kb.send(NOTE_ON, 60, 100);
    kb.send(NOTE_ON, 64, 100);
    kb.send(NOTE_OFF, 60, 0);
    kb.send(NOTE_OFF, 64, 0);
    expect(heldOn('t4')).toEqual([60, 64]);
    // Struck again under the pedal: it plays again and keeps sounding.
    kb.send(NOTE_ON, 60, 90);
    expect(on).toHaveBeenLastCalledWith('t4', 60, 90 / 127, 'midi:t4:60');
    kb.send(NOTE_ON, 67, 100); // still held down when the pedal lifts
    kb.send(NOTE_OFF, 60, 0);
    kb.send(CC, 64, 0);
    expect(heldOn('t4')).toEqual([67]);
    kb.send(NOTE_OFF, 67, 0);
    expect(heldOn('t4')).toEqual([]);
    // A pedal on another channel does not hold this channel's notes.
    kb.send(CC | 1, 64, 127);
    kb.send(NOTE_ON, 72, 100);
    kb.send(NOTE_OFF, 72, 0);
    expect(heldOn('t4')).toEqual([]);
    kb.send(CC | 1, 64, 0);
  });

  it('All Notes Off and Reset All Controllers from the device let go of everything on that channel', async () => {
    const s = await started();
    const { inputs } = await connected(s);
    selectTrack('t4');
    const kb = inputs[0];
    kb.send(CC, 64, 127);
    kb.send(NOTE_ON, 60, 100);
    kb.send(NOTE_OFF, 60, 0);
    kb.send(NOTE_ON, 62, 100);
    kb.send(CC, 123, 0);
    expect(heldOn('t4')).toEqual([]);
    kb.send(NOTE_ON, 65, 100);
    kb.send(CC, 121, 0); // pedal up, wheel centred: the key is still down, its note stays
    expect(heldOn('t4')).toEqual([65]);
    kb.send(NOTE_OFF, 65, 0);
    expect(heldOn('t4')).toEqual([]);
  });
});

describe('Pitch bend and mod wheel', () => {
  it('pitch bend bends the part by ±2 semitones, or the range chosen up to ±12, and centres again', async () => {
    const s = await started();
    const { midi, inputs } = await connected(s);
    selectTrack('t4');
    const bend = vi.spyOn(s.engine!, 'setPitchBend');
    inputs[0].send(BEND, 0x7f, 0x7f);
    expect(bend).toHaveBeenLastCalledWith('t4', 200, expect.any(Number));
    inputs[0].send(BEND, 0, 0);
    expect(bend).toHaveBeenLastCalledWith('t4', -200, expect.any(Number));
    midi.setBendRange(12);
    // A wheel held off-centre follows the new range at once.
    expect(bend).toHaveBeenLastCalledWith('t4', -1200, expect.any(Number));
    inputs[0].send(BEND, 0, 0x60); // 12288: half way up
    expect(bend.mock.lastCall![1]).toBeCloseTo(600.07, 1);
    inputs[0].send(BEND, 0, 0x40);
    expect(bend).toHaveBeenLastCalledWith('t4', 0, expect.any(Number));
    expect(readMidiSettings().bendRange).toBe(12);
    midi.setBendRange(99);
    expect(midi.state.getState().settings.bendRange).toBe(12);
  });

  it('the mod wheel moves the part’s Motion macro, one undo step per movement', async () => {
    const s = await started();
    const { inputs } = await connected(s);
    selectTrack('t4');
    const was = s.store.getState().tracks[3].macros.motion;
    for (const v of [10, 40, 80, 127]) inputs[0].send(CC, 1, v);
    expect(s.store.getState().tracks[3].macros.motion).toBe(1);
    s.undo();
    expect(s.store.getState().tracks[3].macros.motion).toBe(was);
  });
});

describe('No stuck notes', () => {
  it('unplugging the keyboard lets go of its notes, pedal-held ones and its bend; plugging it back in plays again', async () => {
    const s = await started();
    const { midi, access, inputs } = await connected(s);
    selectTrack('t4');
    const bend = vi.spyOn(s.engine!, 'setPitchBend');
    const kb = inputs[0];
    kb.send(CC, 64, 127);
    kb.send(NOTE_ON, 60, 100);
    kb.send(NOTE_OFF, 60, 0);
    kb.send(NOTE_ON, 62, 100);
    kb.send(BEND, 0x7f, 0x7f);
    access.unplug('in-0');
    expect(heldOn('t4')).toEqual([]);
    expect(midi.heldCount()).toBe(0);
    expect(bend).toHaveBeenLastCalledWith('t4', 0, expect.any(Number));
    expect(midi.state.getState().inputs).toEqual([]);
    access.plug(kb);
    expect(midi.state.getState().inputs.map((i) => i.id)).toEqual(['in-0']);
    kb.send(NOTE_ON, 64, 100);
    // The old pedal state went with the unplug: the key alone holds the note now.
    kb.send(NOTE_OFF, 64, 0);
    expect(heldOn('t4')).toEqual([]);
  });

  it('Stop, Pause, Mute All and window blur let go of MIDI notes and pedal-held notes; the pedal still works afterwards', async () => {
    const s = await started();
    const { midi, inputs } = await connected(s);
    selectTrack('t4');
    const kb = inputs[0];
    const bend = vi.spyOn(s.engine!, 'setPitchBend');
    const press = () => {
      kb.send(CC, 64, 127);
      kb.send(NOTE_ON, 60, 100);
      kb.send(NOTE_OFF, 60, 0);
      kb.send(NOTE_ON, 62, 100);
      expect(heldOn('t4')).toEqual([60, 62]);
    };
    // Stop
    await s.play();
    press();
    kb.send(BEND, 0x7f, 0x7f);
    s.stop();
    expect(heldOn('t4')).toEqual([]);
    expect(midi.heldCount()).toBe(0);
    expect(bend).toHaveBeenLastCalledWith('t4', 0, expect.any(Number));
    // The key still down after Stop: its release does nothing; the pedal is still down for new notes.
    kb.send(NOTE_OFF, 62, 0);
    kb.send(CC, 64, 0);
    // Pause
    await s.play();
    press();
    s.pause();
    expect(heldOn('t4')).toEqual([]);
    expect(midi.heldCount()).toBe(0);
    kb.send(NOTE_OFF, 62, 0);
    kb.send(CC, 64, 0);
    s.stop();
    // Mute All
    press();
    s.setMuteAll(true);
    expect(heldOn('t4')).toEqual([]);
    s.setMuteAll(false);
    kb.send(NOTE_OFF, 62, 0);
    kb.send(CC, 64, 0);
    // Window blur (the app calls releaseAllNotes)
    press();
    s.releaseAllNotes();
    expect(heldOn('t4')).toEqual([]);
    expect(midi.heldCount()).toBe(0);
    kb.send(NOTE_OFF, 62, 0);
    kb.send(CC, 64, 0);
    // Afterwards everything works as before.
    kb.send(NOTE_ON, 67, 100);
    expect(heldOn('t4')).toEqual([67]);
    kb.send(NOTE_OFF, 67, 0);
    expect(heldOn('t4')).toEqual([]);
  });

  it('changing the selected part lets go of what the old part held (pedal too); the wheel moves over', async () => {
    const s = await started();
    const { inputs } = await connected(s);
    selectTrack('t4');
    const bend = vi.spyOn(s.engine!, 'setPitchBend');
    const kb = inputs[0];
    kb.send(CC, 64, 127);
    kb.send(NOTE_ON, 60, 100);
    kb.send(NOTE_OFF, 60, 0);
    kb.send(NOTE_ON, 62, 100);
    kb.send(BEND, 0x7f, 0x7f);
    selectTrack('t6');
    expect(heldOn('t4')).toEqual([]);
    expect(bend).toHaveBeenCalledWith('t4', 0, expect.any(Number));
    expect(bend).toHaveBeenLastCalledWith('t6', 200, expect.any(Number));
    // The key let go of later does nothing on either part.
    kb.send(NOTE_OFF, 62, 0);
    expect(heldOn('t6')).toEqual([]);
    kb.send(NOTE_ON, 64, 100);
    expect(heldOn('t6')).toEqual([64]);
    kb.send(NOTE_OFF, 64, 0);
    kb.send(CC, 64, 0);
    expect(heldOn('t6')).toEqual([]);
  });

  it('a fixed part plays whatever is selected; changing the route lets go of its keys', async () => {
    const s = await started();
    const { midi, inputs } = await connected(s, 'Bass keys', 'Lead keys');
    midi.setRoute('in-0', 't3');
    selectTrack('t4');
    inputs[0].send(NOTE_ON, 40, 100);
    inputs[1].send(NOTE_ON, 72, 100);
    expect(heldOn('t3')).toEqual([40]);
    expect(heldOn('t4')).toEqual([72]);
    selectTrack('t6');
    // The fixed route keeps sounding; the selected-part input was let go of.
    expect(heldOn('t3').length).toBe(1);
    expect(heldOn('t4')).toEqual([]);
    midi.setRoute('in-0', 'selected');
    expect(heldOn('t3')).toEqual([]);
    expect(readMidiSettings().routes).toEqual({});
    midi.setRoute('in-1', 't5');
    expect(readMidiSettings().routes).toEqual({ 'in-1': 't5' });
    expect(midi.routeOf('in-1')).toBe('t5');
  });
});

describe('MIDI learn', () => {
  it('maps a knob to a macro, part volume, master volume and tempo; remembered, replaced by a relearn, and removable', async () => {
    const s = await started();
    const { midi, inputs } = await connected(s);
    selectTrack('t4');
    const kb = inputs[0];
    midi.startLearn({ kind: 'macro', macro: 'tone' });
    // The sustain pedal is never learned.
    kb.send(CC, 64, 127);
    kb.send(CC, 64, 0);
    expect(midi.state.getState().learning).not.toBeNull();
    kb.send(CC, 74, 5);
    expect(midi.state.getState().learning).toBeNull();
    expect(midi.state.getState().learned).toMatchObject({ cc: 74, channel: 0, inputId: 'in-0', inputName: 'Keys 49', target: { kind: 'macro', macro: 'tone' } });
    kb.send(CC, 74, 127);
    expect(s.store.getState().tracks[3].macros.tone).toBe(1);
    kb.send(CC, 74, 0);
    expect(s.store.getState().tracks[3].macros.tone).toBe(0);
    // Macros follow the selected part.
    selectTrack('t6');
    kb.send(CC, 74, 127);
    expect(s.store.getState().tracks[5].macros.tone).toBe(1);

    midi.startLearn({ kind: 'volume' });
    kb.send(CC | 2, 7, 64);
    kb.send(CC | 2, 7, 127);
    expect(s.store.getState().patch.modules.find((m) => m.id === 't6:ch')!.params.level).toBe(6);
    midi.startLearn({ kind: 'master' });
    kb.send(CC, 20, 0);
    kb.send(CC, 20, 0);
    expect(s.store.getState().masterVolumeDb).toBe(-60);
    midi.startLearn({ kind: 'tempo' });
    kb.send(CC, 21, 1);
    kb.send(CC, 21, 60);
    expect(s.store.getState().bpm).toBe(120);

    // Remembered in this browser.
    expect(readMidiSettings().mappings.map((m) => `${m.cc}:${m.target.kind}`)).toEqual(['74:macro', '7:volume', '20:master', '21:tempo']);
    // Learning the same control again replaces its mapping.
    midi.startLearn({ kind: 'macro', macro: 'space' });
    kb.send(CC, 74, 3);
    expect(readMidiSettings().mappings.filter((m) => m.cc === 74).map((m) => m.target)).toEqual([{ kind: 'macro', macro: 'space' }]);
    const id = midi.state.getState().settings.mappings.find((m) => m.cc === 21)!.id;
    midi.removeMapping(id);
    expect(readMidiSettings().mappings.some((m) => m.cc === 21)).toBe(false);
    const bpm = s.store.getState().bpm;
    kb.send(CC, 21, 100);
    expect(s.store.getState().bpm).toBe(bpm);
    // A mapped CC 1 wins over the mod wheel's Motion.
    midi.startLearn({ kind: 'macro', macro: 'drive' });
    kb.send(CC, 1, 0);
    const motion = s.store.getState().tracks[5].macros.motion;
    kb.send(CC, 1, 127);
    expect(s.store.getState().tracks[5].macros.drive).toBe(1);
    expect(s.store.getState().tracks[5].macros.motion).toBe(motion);
  });
});

describe('Recording MIDI', () => {
  it('Record Notes records MIDI notes into the selected clip, like the computer keyboard', async () => {
    const s = await started();
    const { inputs } = await connected(s);
    selectTrack('t4');
    selectSlot('t4', 3);
    s.store.replace({ ...s.store.getState(), settings: { ...s.store.getState().settings, countIn: false } });
    await s.toggleRecordNotes();
    await sleep(250);
    inputs[0].send(NOTE_ON, 60, 100);
    await sleep(120);
    inputs[0].send(NOTE_OFF, 60, 0);
    s.stopRecordNotes();
    const clip = s.store.getState().tracks[3].clips[3]!;
    expect(clip.notes.length).toBe(1);
    expect(clip.notes[0].pitch).toBe(60);
    expect(clip.notes[0].velocity).toBeCloseTo(100 / 127, 5);
    s.stop();
  });

  it('Record Performance records MIDI notes and mod wheel moves', async () => {
    const s = await started();
    const { inputs } = await connected(s);
    selectTrack('t4');
    await s.togglePerformance();
    inputs[0].send(NOTE_ON, 62, 100);
    inputs[0].send(CC, 1, 90);
    await sleep(700);
    inputs[0].send(NOTE_OFF, 62, 0);
    await s.togglePerformance();
    const perf = s.store.getState().performances.at(-1)!;
    expect(perf.events.some((e) => e.type === 'noteOn' && e.key === 'midi:t4:62')).toBe(true);
    expect(perf.events.some((e) => e.type === 'noteOff' && e.key === 'midi:t4:62')).toBe(true);
    expect(perf.events.some((e) => e.type === 'macro' && e.macro === 'motion' && Math.abs(e.value - 90 / 127) < 1e-6)).toBe(true);
    s.stop();
  });
});

describe('Connecting', () => {
  it('denied, unsupported and insecure pages explain themselves in words', async () => {
    const s = new Session(createProject({ name: 'x', now: 1 }));
    sessions.push(s);
    const denied = new MidiController(s, env(null, { requestAccess: () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })) }));
    controllers.push(denied);
    expect(await denied.connect()).toBe(false);
    expect(denied.state.getState()).toMatchObject({ status: 'denied', message: MIDI_DENIED_MESSAGE });
    const none = new MidiController(s, env(null));
    controllers.push(none);
    expect(await none.connect()).toBe(false);
    expect(none.state.getState()).toMatchObject({ status: 'unsupported', message: MIDI_UNSUPPORTED_MESSAGE });
    const insecure = new MidiController(s, env(new FakeAccess(), { secure: false }));
    controllers.push(insecure);
    expect(await insecure.connect()).toBe(false);
    expect(insecure.state.getState().message).toBe(MIDI_INSECURE_MESSAGE);
  });

  it('reconnects by itself only when the user connected before and the browser already allows MIDI', async () => {
    const s = new Session(createProject({ name: 'x', now: 1 }));
    sessions.push(s);
    const access = new FakeAccess();
    const request = vi.fn(async () => access);
    // Never connected: nothing is asked.
    const first = new MidiController(s, env(access, { requestAccess: request }));
    controllers.push(first);
    expect(await first.autoConnect()).toBe(false);
    expect(request).not.toHaveBeenCalled();
    // Connected once (remembered), but the permission is only "prompt": still nothing is asked.
    expect(await first.connect()).toBe(true);
    expect(readMidiSettings().remember).toBe(true);
    const prompt = new MidiController(s, env(access, { requestAccess: request, permission: async () => 'prompt' }));
    controllers.push(prompt);
    request.mockClear();
    expect(await prompt.autoConnect()).toBe(false);
    expect(request).not.toHaveBeenCalled();
    // Remembered and granted: it reconnects.
    const granted = new MidiController(s, env(access, { requestAccess: request }));
    controllers.push(granted);
    expect(await granted.autoConnect()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    // Turned off: not remembered any more.
    granted.disconnect();
    expect(readMidiSettings().remember).toBe(false);
  });

  it('before any click, a note does not start sound behind the browser’s back: it says to click once', async () => {
    const s = new Session(createProject({ name: 'x', now: 1 }));
    sessions.push(s);
    const access = new FakeAccess();
    const kb = new FakeInput('in-0', 'Keys');
    access.inputs.set(kb.id, kb);
    const midi = new MidiController(s, env(access, { hasUserActivation: () => false }));
    controllers.push(midi);
    await midi.connect();
    const start = vi.spyOn(s, 'startAudio');
    kb.send(NOTE_ON, 60, 100);
    expect(start).not.toHaveBeenCalled();
    expect(rt().notice?.text).toBe(MIDI_SOUND_OFF_MESSAGE);
    expect(midi.heldCount()).toBe(0);
  });
});
