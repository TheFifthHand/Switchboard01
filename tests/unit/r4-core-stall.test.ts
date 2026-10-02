/**
 * perf-01: the audio clock stays the timing authority when the app's own
 * main thread is busy. A fake audio clock and a fake wall clock drive the
 * real RealtimeTransport (its main-thread ticker under fake timers): a block
 * of the main thread is time passing without ticks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngineApi, NoteTrigger, VoiceHandle } from '../../src/audio/contracts';
import type { Project } from '../../src/project/types';
import type { SeqEvent } from '../../src/time/contracts';
import { Sequencer } from '../../src/time/sequencer';
import { BRACE_AHEAD, DEFAULT_LOOKAHEAD, RealtimeTransport, type TransportEventMap } from '../../src/time/transport';
import { makeClip, makeProject, setClip } from './sequencer-fixtures';

const SIXTEENTHS = Array.from({ length: 16 }, (_, i) => [i * 24, 60] as [number, number]);

interface Scheduled {
  trackId: string;
  time: number;
  /** Audio clock when it was handed to the engine. */
  at: number;
  pitch: number;
}

class FakeCtx {
  currentTime = 0;
  state: 'running' | 'suspended' = 'running';
  sampleRate = 48000;
  outputLatency = 0;
  baseLatency = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
}

function fakeEngine(ctx: FakeCtx) {
  const notes: Scheduled[] = [];
  const events: { kind: string; time: number; at: number; args: unknown[] }[] = [];
  const handle = (time: number): VoiceHandle => ({ startTime: time, release() {}, cancel() {}, ended: false });
  const log = (kind: string) => (...args: unknown[]) => events.push({ kind, time: Number(args[args.length - 1]), at: ctx.currentTime, args });
  const engine = {
    ctx: ctx as unknown as BaseAudioContext,
    setProject() {},
    scheduleNote(trackId: string, n: NoteTrigger) {
      notes.push({ trackId, time: n.time, at: ctx.currentTime, pitch: n.pitch });
      return handle(n.time);
    },
    schedulePump: log('pump'),
    scheduleClick: log('click'),
    scheduleParam: log('param'),
    scheduleMacro: log('macro'),
    scheduleMute: log('mute'),
    scheduleMasterVolume: log('master'),
    scheduleSongGain: (...args: unknown[]) => events.push({ kind: 'songGain', time: Number(args[1]), at: ctx.currentTime, args }),
    scheduleMacroRamp: (...args: unknown[]) => events.push({ kind: 'macroRamp', time: Number(args[4]), at: ctx.currentTime, args }),
    cancelScheduledAutomation() {},
    transportStarted() {},
    transportStopped() {},
    tempoChanged() {},
    liveNoteOn() {},
    liveNoteOff() {},
    releaseLive() {},
    setMasterVolume() {},
    setMuteAll() {},
    panic() {},
    output: null as unknown as AudioNode,
    readMeters() {},
    getStats: () => ({ voices: 0, modules: 0, connections: 0, pendingTimers: 0 }),
    dispose() {},
  };
  return { engine: engine as unknown as AudioEngineApi, notes, events };
}

/** A transport on fake clocks; `run(ms)` lets time pass with the ticker running, `block(ms)` without. */
function rig(project: Project, opts: { hidden?: () => boolean } = {}) {
  const ctx = new FakeCtx();
  const { engine, notes, events } = fakeEngine(ctx);
  let wall = 1000;
  const seq = new Sequencer({ getProject: () => project });
  const transport = new RealtimeTransport({
    ctx: ctx as unknown as BaseAudioContext,
    engine,
    sequencer: seq,
    isHidden: opts.hidden ?? (() => false),
    wallClock: () => wall,
  });
  const got: { [K in keyof TransportEventMap]?: TransportEventMap[K][] } = {};
  for (const name of ['stalled', 'skipped', 'block', 'launch'] as const) {
    got[name] = [];
    transport.on(name, (e) => (got[name] as unknown[]).push(e));
  }
  const step = (ms: number) => {
    ctx.currentTime += ms / 1000;
    wall += ms;
  };
  return {
    ctx,
    seq,
    transport,
    notes,
    events,
    got,
    /** Time passes with the ticker running every 25 ms. */
    run(ms: number) {
      for (let t = 0; t < ms; t += 25) {
        step(25);
        vi.advanceTimersByTime(25);
      }
    },
    /** The main thread is blocked for `ms`: the clocks run, no tick happens. */
    block(ms: number) {
      step(ms);
    },
  };
}

function groove(): Project {
  let p = makeProject(120);
  p = setClip(p, 't1', 0, makeClip(1, SIXTEENTHS));
  return p;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('perf-01: a busy main thread never stops or delays playback in a visible tab', () => {
  it('schedules 300 ms ahead by default', () => {
    expect(DEFAULT_LOOKAHEAD).toBe(0.3);
    const r = rig(groove());
    r.transport.launchClip('t1', 0);
    r.transport.start();
    r.run(500);
    const ahead = Math.max(...r.notes.map((n) => n.time - n.at));
    expect(ahead).toBeGreaterThan(0.25);
    expect(ahead).toBeLessThanOrEqual(DEFAULT_LOOKAHEAD + 0.03);
    r.transport.dispose();
  });

  it('a 450 ms block while visible and running: no stop, the position goes on, no event dispatched late', () => {
    const r = rig(groove());
    r.transport.launchClip('t1', 0);
    r.transport.start();
    r.run(1000);
    const before = r.notes.length;
    r.block(450);
    r.run(1500);
    expect(r.got.stalled).toEqual([]);
    expect(r.transport.playing).toBe(true);
    // The playhead follows the audio clock (120 BPM: 192 ticks per second, started 50 ms in).
    const tick = r.transport.getPosition().tick;
    expect(tick).toBeCloseTo((r.ctx.currentTime - 0.05) * 192, 0);
    // No note and no timed event was handed over more than 10 ms after its time.
    expect(r.notes.filter((n) => n.time < n.at - 0.01)).toEqual([]);
    expect(r.events.filter((e) => e.time < e.at - 0.01)).toEqual([]);
    // Notes go on after the block, on the clip's grid, in time.
    const after = r.notes.slice(before).filter((n) => n.time > r.ctx.currentTime - 1.4);
    expect(after.length).toBeGreaterThan(15);
    for (const n of after) expect(Math.abs(((n.time - 0.05) * 192) / 24 - Math.round(((n.time - 0.05) * 192) / 24))).toBeLessThan(1e-6);
    // The missed stretch was skipped (and said so), and the margin grew.
    expect(r.got.skipped!.length).toBe(1);
    expect(r.got.skipped![0].lateBy).toBeGreaterThan(0.1);
    expect(r.transport.getStats().skips).toBe(1);
    r.transport.dispose();
  });

  it('a block shorter than the margin loses nothing: every note is handed over in time', () => {
    const r = rig(groove());
    r.transport.launchClip('t1', 0);
    r.transport.start();
    r.run(1000);
    r.block(250);
    r.run(1000);
    expect(r.got.skipped).toEqual([]);
    expect(r.got.stalled).toEqual([]);
    expect(r.notes.filter((n) => n.time < n.at)).toEqual([]);
    // 16 notes a bar, 2 s = a bar: every 16th from the start was scheduled, none missing.
    const ticks = r.notes.map((n) => Math.round((n.time - 0.05) * 192));
    for (let t = 0; t <= 384; t += 24) expect(ticks).toContain(t);
    expect(r.transport.getStats().lateDropped).toBe(0);
    r.transport.dispose();
  });

  it('hidden tab: the same block stops playback (stalled)', () => {
    let hidden = false;
    const r = rig(groove(), { hidden: () => hidden });
    r.transport.launchClip('t1', 0);
    r.transport.start();
    r.run(1000);
    hidden = true;
    r.block(700);
    r.run(100);
    expect(r.got.stalled!.length).toBe(1);
    expect(r.got.stalled![0].reason).toBe('throttled');
    expect(r.transport.playing).toBe(false);
    expect(r.notes.filter((n) => n.time < n.at - 0.01)).toEqual([]);
    r.transport.dispose();
  });

  it('a suspended audio device stops playback (stalled, suspended)', () => {
    const r = rig(groove());
    r.transport.launchClip('t1', 0);
    r.transport.start();
    r.run(1000);
    r.ctx.state = 'suspended';
    r.block(700);
    r.run(100);
    expect(r.got.stalled!.map((s) => s.reason)).toEqual(['suspended']);
    expect(r.transport.playing).toBe(false);
    r.transport.dispose();
  });

  it('a gap between ticks braces: a second ahead for 3 s, then back to 300 ms', () => {
    const r = rig(groove());
    r.transport.launchClip('t1', 0);
    r.transport.start();
    r.run(500);
    expect(r.transport.getStats().ahead).toBe(DEFAULT_LOOKAHEAD);
    r.block(100);
    r.run(25);
    expect(r.transport.getStats().ahead).toBe(BRACE_AHEAD);
    const horizon = Math.max(...r.notes.map((n) => n.time));
    expect(horizon - r.ctx.currentTime).toBeGreaterThan(0.9);
    r.run(3100);
    expect(r.transport.getStats().ahead).toBe(DEFAULT_LOOKAHEAD);
    r.transport.dispose();
  });

  it('brace() schedules a second ahead at once', () => {
    const r = rig(groove());
    r.transport.launchClip('t1', 0);
    r.transport.start();
    r.run(200);
    r.transport.brace();
    expect(Math.max(...r.notes.map((n) => n.time)) - r.ctx.currentTime).toBeGreaterThan(0.9);
    // A block of most of a second passes without a skip or a late note.
    r.block(800);
    r.run(500);
    expect(r.got.skipped).toEqual([]);
    expect(r.notes.filter((n) => n.time < n.at)).toEqual([]);
    r.transport.dispose();
  });

  it('a skip keeps launches and the song position: a block event and a queued launch in the missed stretch still apply', () => {
    let p = groove();
    p = setClip(p, 't1', 1, makeClip(1, [[0, 72]]));
    p = setClip(p, 't2', 0, makeClip(1, [[0, 40], [192, 41]]));
    p = setClip(p, 't2', 1, makeClip(1, [[0, 50], [192, 51]]));
    p.arrangement = { tailSeconds: 1, blocks: [{ id: 'A', sceneId: p.scenes[0].id, repeats: 1 }, { id: 'B', sceneId: p.scenes[1].id, repeats: 2 }] };
    const r = rig(p);
    r.transport.start({ mode: { kind: 'song', fromBlock: 0 } });
    r.run(1700);
    // Block A ends at 2.05 s: the block is missed entirely.
    r.block(600);
    r.run(1000);
    expect(r.got.stalled).toEqual([]);
    expect(r.got.block!.map((b) => b.blockId)).toEqual(['A', 'B']);
    expect(r.seq.getTrackState('t2').playing).toMatchObject({ slot: 1, startTick: 384 });
    // B's notes after the skip are on its loop, in time.
    const late = r.notes.filter((n) => n.time > 2.75);
    expect(late.length).toBeGreaterThan(0);
    expect(late.filter((n) => n.trackId === 't2').every((n) => n.pitch === 50 || n.pitch === 51)).toBe(true);
    expect(r.notes.filter((n) => n.time < n.at - 0.01)).toEqual([]);
    r.transport.dispose();
  });
});

describe('perf-01: events whose time has passed are dropped, never played late', () => {
  it('the dispatcher drops late notes but lets their control events through', async () => {
    const { EngineDispatcher } = await import('../../src/time/transport');
    const ctx = new FakeCtx();
    const { engine, notes, events } = fakeEngine(ctx);
    ctx.currentTime = 1;
    const d = new EngineDispatcher({
      engine,
      getProject: groove,
      metronome: () => true,
      countInClicks: true,
      at: () => undefined,
      onEvent: () => undefined,
      lateBefore: () => ctx.currentTime - 0.01,
    });
    const ev: SeqEvent[] = [
      { kind: 'note', tick: 0, time: 0.95, trackId: 't1', pitch: 60, velocity: 1, duration: 0.1, durationTicks: 12, legato: false, source: 'clip' },
      { kind: 'note', tick: 10, time: 0.995, trackId: 't1', pitch: 61, velocity: 1, duration: 0.1, durationTicks: 12, legato: false, source: 'clip' },
      { kind: 'beat', tick: 0, time: 0.9, bar: 0, beat: 0, beatSeconds: 0.5, countIn: false },
      { kind: 'macro', tick: 0, time: 0.9, trackId: 't1', macro: 'tone', value: 0.3 },
    ];
    d.dispatch(ev);
    expect(notes.map((n) => n.pitch)).toEqual([61]);
    expect(d.droppedLate).toBe(1);
    expect(events.map((e) => e.kind)).toEqual(['macro']);
  });
});

describe('perf-01: with the 300 ms look-ahead, live edits still sound at the next event', () => {
  it('a note added just ahead of the playhead (inside what is already scheduled) plays at its time; one removed there does not', async () => {
    const { Rig } = await import('./song-live-rig');
    const cmd = await import('../../src/state/commands');
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [192, 1]]));
    const r = new Rig(p);
    r.seq.launchClip('t1', 0, 0);
    r.play({ mode: { kind: 'live' } }).to(400);
    // Already generated up to ~460 (300 ms = 58 ticks ahead): the edit lands inside it.
    expect(r.seq.generatedTick).toBeGreaterThan(450);
    expect(r.edit((s) => cmd.addNote(s, 't1', 0, { tick: 48, pitch: 2, velocity: 0.9, duration: 12 }))).toBe(false);
    expect(r.project.tracks[0].clips[0]!.notes).toHaveLength(3);
    r.edit((s) => {
      const clip = s.getState().tracks[0].clips[0]!;
      return cmd.removeNote(s, 't1', 0, clip.notes.find((n) => n.pitch === 1)!.id);
    });
    r.to(1100);
    // The new note (tick 432 = 384 + 48) sounds in this very bar; the removed one (576) never does.
    expect(r.notes('t1').filter(([t]) => t < 1100)).toEqual([[0, 0], [192, 1], [384, 0], [432, 2], [768, 0], [816, 2]]);
  });
});
