/**
 * Review M1/M2: a sound edit while music plays is heard on the next note,
 * however far ahead notes were scheduled (the 0.3 s look-ahead, or a second
 * while braced). A note takes its instrument's settings when it is
 * scheduled, so what was scheduled for the edited part is scheduled again
 * once the engine has the edited project: every note that starts after the
 * edit was handed to the engine after it got the edit. Drum tune, poly
 * attack, a new kit, a new preset; Pump and the metronome reschedule the
 * beats' ducks and clicks. A knob drag reschedules at most every 80 ms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchRuntime } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { createClip, createProject } from '../../src/project/factory';
import type { Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { defaultUiState, uiStore } from '../../src/state/uiStore';
import { BRACE_AHEAD, DEFAULT_LOOKAHEAD, type RealtimeTransport } from '../../src/time/transport';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** 120 BPM: t1 (drums) plays 16ths, t4 (chords, poly) 8th-note chords, in row 0. */
function project(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  p.seed = 4;
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  p.tracks[0].clips[0] = createClip('beat', 1, Array.from({ length: 16 }, (_, i) => ({ tick: i * 24, pitch: i % 4 === 0 ? 0 : 2, velocity: 0.8, duration: 12 })));
  p.tracks[3].clips[0] = createClip('chords', 1, Array.from({ length: 8 }, (_, i) => ({ tick: i * 48, pitch: 60 + (i % 2) * 3, velocity: 0.7, duration: 24 })));
  p.arrangement = { ...p.arrangement, regions: [], sections: [] };
  return p;
}

interface Logged {
  trackId: Id;
  time: number;
  seq: number;
  cancelled: boolean;
}

let live: Session[] = [];
beforeEach(() => {
  uiStore.setState({ ...defaultUiState() });
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null, tracks: {} });
});
afterEach(() => {
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null, tracks: {} });
});

/** A playing session whose engine calls are logged in order (seq): notes (and whether they were cancelled), setProject, pump ducks, clicks. */
async function playing() {
  const s = new Session(project());
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  const engine = s.engine!;
  const log = { seq: 0, notes: [] as Logged[], setProject: 0, pumps: [] as { time: number; seq: number }[], clicks: [] as { time: number; seq: number }[] };
  const scheduleNote = engine.scheduleNote.bind(engine);
  engine.scheduleNote = (trackId, n) => {
    const entry: Logged = { trackId, time: n.time, seq: ++log.seq, cancelled: false };
    log.notes.push(entry);
    const h = scheduleNote(trackId, n);
    if (h) {
      const cancel = h.cancel.bind(h);
      Object.defineProperty(h, 'cancel', {
        value: () => {
          entry.cancelled = true;
          cancel();
        },
      });
    }
    return h;
  };
  const setProject = engine.setProject.bind(engine);
  engine.setProject = (p) => {
    log.setProject = ++log.seq;
    setProject(p);
  };
  const schedulePump = engine.schedulePump.bind(engine);
  engine.schedulePump = (time, beatSeconds, beatIndex) => {
    log.pumps.push({ time, seq: ++log.seq });
    schedulePump(time, beatSeconds, beatIndex);
  };
  const scheduleClick = engine.scheduleClick.bind(engine);
  engine.scheduleClick = (time, accent) => {
    log.clicks.push({ time, seq: ++log.seq });
    scheduleClick(time, accent);
  };
  await s.launchScene(0);
  await until(() => s.transport!.getPosition().tick > 96, 'the groove');
  return { s, log };
}

/**
 * Make the edit `edit` braced (a second scheduled ahead) or not, and return
 * the audio time once it was handled and the seq of the engine's setProject
 * for it. Waits until what was scheduled ahead at the edit has played.
 */
async function editWhilePlaying(s: Session, log: { seq: number; setProject: number }, braced: boolean, edit: () => boolean) {
  const t = s.transport!;
  if (braced) {
    s.brace();
    expect(t.getStats().ahead).toBe(BRACE_AHEAD);
  } else {
    noBraces(t);
    // What was scheduled further ahead before has played out.
    await sleep(800);
    expect(t.getStats().ahead).toBe(DEFAULT_LOOKAHEAD);
  }
  const before = log.seq;
  expect(edit()).toBe(true);
  const doneAt = s.ctx!.currentTime;
  const applied = log.setProject;
  expect(applied).toBeGreaterThan(before);
  await sleep(braced ? 1300 : 600);
  return { doneAt, applied };
}

/**
 * The plain look-ahead only: a brace starts whenever the page is busy (a tick
 * late by 60 ms, a long frame), which a loaded test machine often is, so this
 * transport stops bracing (test plumbing: its private brace step is stubbed).
 */
function noBraces(t: RealtimeTransport): void {
  const x = t as unknown as { extendBrace: (seconds: number, forMs: number) => void; braceUntil: number; braceAhead: number; updateAhead: () => void };
  x.extendBrace = () => undefined;
  x.braceUntil = 0;
  x.braceAhead = 0;
  x.updateAhead();
}

/** Notes of `trackId` that sound after the edit (not cancelled, starting a moment after it was handled). */
const soundingAfter = (log: { notes: Logged[] }, trackId: Id, doneAt: number) => log.notes.filter((n) => n.trackId === trackId && !n.cancelled && n.time > doneAt + 0.015);

describe('sound edits while playing are heard on the next note (review M1, M2)', () => {
  for (const braced of [false, true]) {
    const how = braced ? 'braced (a second ahead)' : 'with the plain look-ahead';
    it(`drum tune and poly attack, ${how}`, async () => {
      const { s, log } = await playing();
      for (const [trackId, edit] of [
        ['t1', () => s.accepted(cmd.setDrumVoice(s.store, 't1', 0, { tune: 7 }))],
        ['t4', () => s.accepted(cmd.setInstrumentParam(s.store, 't4', 'attack', 0.4))],
      ] as const) {
        const { doneAt, applied } = await editWhilePlaying(s, log, braced, edit);
        const after = soundingAfter(log, trackId, doneAt);
        expect(after.length, `${trackId}: notes after the edit`).toBeGreaterThan(2);
        expect(after.filter((n) => n.seq < applied), `${trackId}: notes on the old sound`).toEqual([]);
      }
      s.stop();
    });

    it(`a new kit and a new preset, ${how}`, async () => {
      const { s, log } = await playing();
      const t4 = s.store.getState().tracks[3].instrument;
      const preset = t4.kind === 'poly' && t4.presetId === 'poly-house-stab' ? 'poly-short-pluck' : 'poly-house-stab';
      for (const [trackId, edit] of [
        ['t1', () => s.accepted(cmd.changeInstrumentSound(s.store, 't1', 'drums', 'tight-circuit'))],
        ['t4', () => s.accepted(cmd.changeInstrumentSound(s.store, 't4', 'poly', preset))],
      ] as const) {
        const { doneAt, applied } = await editWhilePlaying(s, log, braced, edit);
        const after = soundingAfter(log, trackId, doneAt);
        expect(after.length, `${trackId}: notes after the change`).toBeGreaterThan(2);
        expect(after.filter((n) => n.seq < applied), `${trackId}: notes on the old sound`).toEqual([]);
      }
      s.stop();
    });

    it(`Pump and the metronome, ${how}: every later beat's duck and click is scheduled after the change`, async () => {
      const { s, log } = await playing();
      const pump = await editWhilePlaying(s, log, braced, () => s.accepted(cmd.setMacro(s.store, 't3', 'pump', 0.9)));
      const beats = [...new Set(log.pumps.filter((b) => b.time > pump.doneAt + 0.015).map((b) => b.time))];
      expect(beats.length).toBeGreaterThan(0);
      for (const time of beats) expect(Math.max(...log.pumps.filter((b) => b.time === time).map((b) => b.seq)), `duck at ${time.toFixed(3)}`).toBeGreaterThan(pump.applied);
      const click = await editWhilePlaying(s, log, braced, () => s.accepted(cmd.setSettings(s.store, { metronome: true })));
      const later = [...new Set(log.pumps.filter((b) => b.time > click.doneAt + 0.015 && b.time < click.doneAt + 0.5).map((b) => b.time))];
      expect(later.length).toBeGreaterThan(0);
      for (const time of later) expect(log.clicks.some((c) => Math.abs(c.time - time) < 1e-6), `click at ${time.toFixed(3)}`).toBe(true);
      s.stop();
    });
  }

  it('a knob drag reschedules at most every 80 ms, and its last value reaches what is scheduled', async () => {
    const { s, log } = await playing();
    s.brace();
    const revoice = vi.spyOn(s.transport!, 'revoice');
    const started = performance.now();
    for (let i = 0; i < 40; i++) {
      s.accepted(cmd.setInstrumentParam(s.store, 't4', 'attack', 0.01 + i * 0.01, 'drag-attack'));
      await sleep(10);
    }
    const dragMs = performance.now() - started;
    const lastEdit = log.setProject;
    const doneAt = s.ctx!.currentTime;
    await sleep(200);
    expect(revoice.mock.calls.length).toBeGreaterThan(1);
    expect(revoice.mock.calls.length).toBeLessThanOrEqual(Math.ceil(dragMs / 80) + 2);
    // The batch after the last change went too: nothing from before it sounds later.
    await sleep(1100);
    expect(soundingAfter(log, 't4', doneAt + 0.08).filter((n) => n.seq < lastEdit)).toEqual([]);
    s.stop();
  });
});
