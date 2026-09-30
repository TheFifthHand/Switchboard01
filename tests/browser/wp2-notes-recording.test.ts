/**
 * Live notes and recording fidelity with real Web Audio in Chromium: a key's
 * release always reaches the voice or arpeggio it started; Musical Assist
 * never re-pitches a recording; Record Notes ignores count-in warm-ups,
 * records what the arpeggiator plays and writes into the selected clip; a
 * performance take records undo, ends at Mute All, and starts with the keys
 * and latched arpeggio already sounding, so its replay matches what was heard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session, TAKE_LOCK_MESSAGE } from '../../src/app/session';
import { getStarter } from '../../src/content/starters';
import type { Id, Performance, PerformanceEvent, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { defaultUiState, selectSlot, selectTrack, uiStore } from '../../src/state/uiStore';
import { Sequencer, type NoteEvent } from '../../src/time/sequencer';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const house = (): Project => getStarter('house')!.build();
const rt = () => runtimeStore.getState();

let live: Session[] = [];
async function started(p: Project = house()): Promise<Session> {
  const s = new Session(p);
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  return s;
}

async function until(fn: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

const tickNow = (s: Session) => s.transport!.getPosition().tick;
const clipNotes = (s: Session, trackId: Id, slot: number) => [...(s.store.getState().tracks.find((t) => t.id === trackId)!.clips[slot]?.notes ?? [])].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
const lastTake = (s: Session): Performance => s.store.getState().performances.at(-1)!;

/** Every note a pure Sequencer plays for a saved take (what replay and WAV export play). */
function replayNotes(s: Session, perf: Performance, seconds: number): NoteEvent[] {
  const project = s.store.getState();
  const seq = new Sequencer({ getProject: () => project });
  seq.start(0, { mode: { kind: 'replay', performanceId: perf.id } });
  const out: NoteEvent[] = [];
  for (let t = 0.05; t < seconds; t += 0.05) for (const e of seq.process(t)) if (e.kind === 'note') out.push(e);
  return out;
}

beforeEach(() => {
  uiStore.setState({ ...defaultUiState() });
  patchRuntime({ muteAll: false, stalled: null, playing: false, mode: 'live', replayId: null, songBlock: null, recording: 'off', recordTarget: null, countingIn: false, held: {}, notice: null, tracks: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ muteAll: false, playing: false, recording: 'off', recordTarget: null, countingIn: false, held: {}, notice: null, tracks: {} });
});

describe('Live notes and the arpeggiator switch', () => {
  it('a key held while the arpeggiator is switched on still releases its own voice', async () => {
    const s = await started();
    const off = vi.spyOn(s.engine!, 'liveNoteOff');
    s.noteOn('t5', 60, 0.8, 'computer');
    expect(s.accepted(cmd.setArp(s.store, 't5', { enabled: true }))).toBe(true);
    s.noteOff('t5', 60, 'computer');
    expect(off).toHaveBeenCalledWith('t5', 'computer:t5:60');
    expect(rt().held.t5).toEqual([]);
    // The arpeggiator never got that key.
    expect(s.sequencer!.getArpInput('t5')?.held ?? []).toEqual([]);
    expect(s.sequencer!.idleActive).toBe(false);
  });

  it('a key held while the arpeggiator is switched off leaves it, so switching it on again plays nothing by itself', async () => {
    const s = await started();
    s.accepted(cmd.setArp(s.store, 't5', { enabled: true }));
    s.noteOn('t5', 60, 0.8, 'computer');
    expect(s.sequencer!.getArpInput('t5')!.held).toEqual([60]);
    s.accepted(cmd.setArp(s.store, 't5', { enabled: false }));
    s.noteOff('t5', 60, 'computer');
    expect(s.sequencer!.getArpInput('t5')!.held).toEqual([]);
    s.accepted(cmd.setArp(s.store, 't5', { enabled: true }));
    await sleep(150);
    expect(s.sequencer!.idleActive).toBe(false);
  });

  it('switching the arpeggiator (or its Latch) off ends a latched pattern: it does not come back when switched on', async () => {
    const s = await started();
    s.accepted(cmd.setArp(s.store, 't5', { enabled: true, latch: true }));
    s.noteOn('t5', 60, 0.8, 'computer');
    s.noteOff('t5', 60, 'computer');
    // Latched: the idle arpeggiator keeps playing after the release.
    await sleep(150);
    expect(s.sequencer!.idleActive).toBe(true);
    s.accepted(cmd.setArp(s.store, 't5', { enabled: false }));
    expect(s.sequencer!.getArpInput('t5')!.latched).toEqual([]);
    s.accepted(cmd.setArp(s.store, 't5', { enabled: true }));
    await until(() => !s.sequencer!.idleActive, 'the idle arpeggiator to stop');

    s.noteOn('t5', 62, 0.8, 'computer');
    s.noteOff('t5', 62, 'computer');
    expect(s.sequencer!.getArpInput('t5')!.latched).toEqual([62]);
    s.accepted(cmd.setArp(s.store, 't5', { latch: false }));
    expect(s.sequencer!.getArpInput('t5')!.latched).toEqual([]);
    s.accepted(cmd.setArp(s.store, 't5', { latch: true }));
    await until(() => !s.sequencer!.idleActive, 'the idle arpeggiator to stop');
  });
});

describe('Musical Assist and recordings', () => {
  it('a sampler part plays exactly the key pressed; a synth part is snapped into the key', async () => {
    const s = await started();
    expect(s.store.getState().tracks.find((t) => t.id === 't8')!.instrument.kind).toBe('sampler');
    // B minor: C (60) is outside the key; Musical Assist is on.
    s.accepted(cmd.setKey(s.store, 11, 'minor'));
    expect(s.store.getState().assist).toBe(true);
    const on = vi.spyOn(s.engine!, 'liveNoteOn');
    s.noteOn('t8', 60, 0.8, 'keyboard');
    s.noteOn('t4', 60, 0.8, 'keyboard');
    expect(on.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['t8', 60],
      ['t4', 59],
    ]);
    expect(rt().held.t8).toEqual([60]);
    s.releaseAllNotes();
  });
});

describe('Record Notes', () => {
  it('ignores notes played during the count-in; notes from the downbeat on are recorded', async () => {
    const s = await started();
    s.accepted(cmd.setSettings(s.store, { countIn: true, recordQuantize: '1/16' }));
    selectTrack('t5');
    selectSlot('t5', 0); // empty: a new clip is made
    await s.toggleRecordNotes();
    expect(rt()).toMatchObject({ recording: 'notes', countingIn: true, recordTarget: { trackId: 't5', slot: 0 } });
    // A warm-up note on the second click of the count-in.
    await until(() => tickNow(s) > -280, 'count-in beat 2');
    expect(tickNow(s)).toBeLessThan(-100);
    s.noteOn('t5', 67, 0.8, 'computer');
    await sleep(120);
    s.noteOff('t5', 67, 'computer');
    await until(() => tickNow(s) > 120, 'the first beat of the clip');
    s.noteOn('t5', 72, 0.8, 'computer');
    await sleep(120);
    s.noteOff('t5', 72, 'computer');
    await s.toggleRecordNotes();
    expect(rt().recording).toBe('off');
    const notes = clipNotes(s, 't5', 0);
    expect(notes.map((n) => n.pitch)).toEqual([72]);
    expect(notes[0].tick).toBeGreaterThanOrEqual(96);
    expect(notes[0].tick).toBeLessThan(384);
  });

  it('with the arpeggiator on, records the notes it plays (on its grid, gate length), not the held keys', async () => {
    const s = await started();
    s.accepted(cmd.setArp(s.store, 't5', { enabled: true, division: '1/16', mode: 'up', gate: 0.5, octaves: 1, latch: false }));
    selectTrack('t5');
    selectSlot('t5', 0);
    await s.toggleRecordNotes();
    await until(() => tickNow(s) > 30, 'playback');
    s.noteOn('t5', 60, 0.8, 'computer');
    s.noteOn('t5', 67, 0.8, 'computer');
    await sleep(650);
    s.noteOff('t5', 60, 'computer');
    s.noteOff('t5', 67, 'computer');
    await sleep(250);
    await s.toggleRecordNotes();
    const notes = clipNotes(s, 't5', 0);
    // ~650 ms at 124 BPM is five or six sixteenths.
    expect(notes.length).toBeGreaterThanOrEqual(4);
    expect(notes.length).toBeLessThanOrEqual(8);
    for (const n of notes) {
      expect(n.tick % 24).toBe(0);
      expect(n.duration).toBe(12);
    }
    // Up pattern: the two keys in turn, one per step.
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].tick - notes[i - 1].tick).toBe(24);
      expect(notes[i].pitch).not.toBe(notes[i - 1].pitch);
    }
    expect(new Set(notes.map((n) => n.pitch))).toEqual(new Set([60, 67]));
    expect(rt().notice?.text).toContain(`Recorded ${notes.length} notes`);
  });

  it('records into the clip selected on the part, not the one playing (it starts at the next bar)', async () => {
    const s = await started();
    await s.pressClip('t3', 1);
    await until(() => s.sequencer!.getTrackState('t3').playing?.slot === 1 && tickNow(s) > 0, 'the bass clip to play');
    // In Steps the user picks the empty first slot to record a fresh take.
    selectTrack('t3');
    selectSlot('t3', 0);
    await s.toggleRecordNotes();
    expect(rt().recordTarget).toEqual({ trackId: 't3', slot: 0 });
    expect(uiStore.getState().selectedSlot.t3).toBe(0);
    expect(s.store.getState().tracks.find((t) => t.id === 't3')!.clips[0]).not.toBeNull();
    expect(s.sequencer!.getTrackState('t3').queued).toMatchObject({ slot: 0, atTick: 384 });
    s.stopRecordNotes();
  });
});

describe('Record Performance', () => {
  it('records Undo and Redo of knob, macro and tempo changes, so the replay changes where the performance did', async () => {
    const s = await started();
    const tone0 = s.store.getState().tracks.find((t) => t.id === 't4')!.macros.tone;
    s.setBpm(130); // before the take
    await s.togglePerformance();
    expect(rt().recording).toBe('performance');
    await sleep(250);
    s.setMacro('t4', 'tone', 0.9, 'drag');
    s.store.endGesture();
    await sleep(120);
    s.undo(); // the macro, heard at once
    expect(s.store.getState().tracks.find((t) => t.id === 't4')!.macros.tone).toBe(tone0);
    await sleep(120);
    s.undo(); // the tempo edit from before the take
    expect(s.store.getState().bpm).toBe(124);
    await sleep(120);
    s.redo();
    expect(s.store.getState().bpm).toBe(130);
    await sleep(400);
    await s.togglePerformance();
    const perf = lastTake(s);
    expect(perf.snapshot.bpm).toBe(130);
    const controls = perf.events.filter((e) => e.type === 'macro' || e.type === 'tempo');
    expect(controls.map((e) => (e.type === 'macro' ? ['macro', e.value] : ['tempo', (e as Extract<PerformanceEvent, { type: 'tempo' }>).bpm]))).toEqual([
      ['macro', 0.9],
      ['macro', tone0],
      ['tempo', 124],
      ['tempo', 130],
    ]);
    // In order on the take's timeline.
    for (let i = 1; i < controls.length; i++) expect(controls[i].t).toBeGreaterThan(controls[i - 1].t);
  });

  it('an undo the take could not record (a clip made before it) waits until the take ends, and says why', async () => {
    const s = await started();
    s.accepted(cmd.createClip(s.store, 't5', 0, 1));
    await s.togglePerformance();
    expect(s.store.info.getState().canUndo).toBe(false);
    s.undo();
    expect(s.store.getState().tracks.find((t) => t.id === 't5')!.clips[0]).not.toBeNull();
    expect(rt().notice).toMatchObject({ tone: 'warn', text: TAKE_LOCK_MESSAGE });
    await sleep(600);
    await s.togglePerformance();
    s.undo(); // saving the take
    s.undo();
    expect(s.store.getState().tracks.find((t) => t.id === 't5')!.clips[0]).toBeNull();
  });

  it('Mute All ends the take there (keeping it), and a take cannot start while Mute All is on', async () => {
    const s = await started();
    const before = s.store.getState().performances.length;
    await s.togglePerformance();
    await sleep(700);
    s.setMuteAll(true);
    expect(rt().recording).toBe('off');
    expect(rt().muteAll).toBe(true);
    expect(s.store.getState().performances).toHaveLength(before + 1);
    expect(rt().notice?.text).toContain('Mute All ended the recording');

    await s.togglePerformance();
    expect(rt().recording).toBe('off');
    expect(s.recordingPerformance).toBe(false);
    expect(rt().notice).toMatchObject({ tone: 'warn', text: expect.stringContaining('Mute All is on') });
    s.setMuteAll(false);
    await s.togglePerformance();
    expect(rt().recording).toBe('performance');
  });

  it('a replayed arpeggio keeps playing when the window loses focus (which lets go of live keys only)', async () => {
    const s = await started();
    s.accepted(cmd.setArp(s.store, 't5', { enabled: true, latch: true, division: '1/16', mode: 'up', octaves: 1 }));
    await s.togglePerformance();
    await until(() => tickNow(s) > 30, 'playback');
    s.noteOn('t5', 60, 0.7, 'computer');
    s.noteOn('t5', 67, 0.7, 'computer');
    await sleep(100);
    s.noteOff('t5', 60, 'computer');
    s.noteOff('t5', 67, 'computer');
    await sleep(1500);
    await s.togglePerformance();
    s.stop();

    await s.replayPerformance(lastTake(s).id);
    const heard: NoteEvent[] = [];
    const off = s.transport!.on('arpNote', (e) => void heard.push(e));
    try {
      await until(() => heard.length >= 2, 'the replayed arpeggio');
      // Focus leaves the window (App calls releaseAllNotes on blur): the take's latched pattern plays on.
      s.releaseAllNotes();
      const before = heard.length;
      await sleep(500);
      expect(rt().replayId).not.toBeNull();
      expect(heard.length - before).toBeGreaterThanOrEqual(3);
    } finally {
      off();
    }
  });

  it('keys held and a latched arpeggio sounding when the take starts are in it, and replay plays them', async () => {
    const s = await started();
    s.accepted(cmd.setArp(s.store, 't5', { enabled: true, latch: true, division: '1/16', mode: 'up', octaves: 1 }));
    await s.play();
    await until(() => tickNow(s) > 50, 'playback');
    // Lead: C held, E pressed and let go (Latch keeps it). Pad: a held G. Drums: a held kick (already played).
    s.noteOn('t5', 60, 0.7, 'computer');
    s.noteOn('t5', 64, 0.7, 'computer');
    s.noteOff('t5', 64, 'computer');
    s.noteOn('t6', 55, 0.6, 'pad');
    s.noteOn('t1', 0, 0.9, 'pad');
    await sleep(200);
    await s.togglePerformance();
    await sleep(300);
    s.noteOff('t5', 60, 'computer');
    s.noteOff('t6', 55, 'pad');
    s.noteOff('t1', 0, 'pad');
    await sleep(800);
    await s.togglePerformance();
    const perf = lastTake(s);
    const atStart = perf.events.filter((e) => e.t === perf.startTick).map((e) => (e.type === 'noteOn' || e.type === 'noteOff' ? `${e.type} ${e.trackId} ${e.pitch}` : e.type));
    expect(atStart).toEqual(['noteOn t5 60', 'noteOn t5 64', 'noteOff t5 64', 'noteOn t6 55']);

    const played = replayNotes(s, perf, 3);
    const lead = played.filter((n) => n.trackId === 't5');
    expect(lead.length).toBeGreaterThan(4);
    expect(lead.every((n) => n.source === 'arp')).toBe(true);
    // The pattern plays from the take's first step to its end: both notes, the latched E after C is let go too.
    expect(lead[0].tick - perf.startTick).toBeLessThan(24);
    expect(new Set(lead.map((n) => n.pitch))).toEqual(new Set([60, 64]));
    expect(lead.at(-1)!.tick).toBeGreaterThan(perf.startTick + 150);
    const pad = played.filter((n) => n.trackId === 't6' && n.source === 'replay');
    expect(pad.map((n) => [n.tick, n.pitch])).toEqual([[perf.startTick, 55]]);
    expect(played.some((n) => n.trackId === 't1' && n.source === 'replay')).toBe(false);
  });
});
