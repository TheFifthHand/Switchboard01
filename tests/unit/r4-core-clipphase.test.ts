/**
 * PLAY-11 / design-12 / PLAY-20: read-only hooks for loop progress and
 * countdowns, and the audible position. Clip phase and the queued tick are
 * read at the position you hear (behind what is scheduled), in live, song and
 * replay playback, without allocating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngineApi, NoteTrigger } from '../../src/audio/contracts';
import type { Performance, Project } from '../../src/project/types';
import type { ClipPhase } from '../../src/time/contracts';
import { Sequencer } from '../../src/time/sequencer';
import { makeSnapshot } from '../../src/time/snapshot';
import { RealtimeTransport, outputDelaySeconds } from '../../src/time/transport';
import { makeClip, makeProject, runTo, sec, setClip } from './sequencer-fixtures';

function twoClips(): Project {
  let p = makeProject(120);
  p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [192, 1]]));
  p = setClip(p, 't1', 1, makeClip(2, [[0, 2]]));
  return p;
}

const phase = (): ClipPhase => ({ slot: -1, startTick: -1, lengthTicks: -1 });

describe('Sequencer.clipPhaseAt / queuedAtTick', () => {
  it('live pads: the clip heard at a tick, its loop start and length; a queued launch lands at the next bar, also once generated ahead', () => {
    const p = twoClips();
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    runTo(seq, 0, sec(500) + 0.3);
    const out = phase();
    expect(seq.clipPhaseAt('t1', 500, out)).toBe(out);
    expect(out).toEqual({ slot: 0, startTick: 0, lengthTicks: 384 });
    expect(seq.queuedAtTick('t1', 500)).toBeNull();
    seq.launchClip('t1', 1, sec(500));
    expect(seq.queuedAtTick('t1', 500)).toBe(768);
    // Generation goes past the switch before it is heard: still slot 0 at 760, the switch still "queued".
    runTo(seq, sec(500), sec(760) + 0.3);
    expect(seq.generatedTick).toBeGreaterThan(768);
    expect(seq.clipPhaseAt('t1', 760, out)).toEqual({ slot: 0, startTick: 0, lengthTicks: 384 });
    expect(seq.queuedAtTick('t1', 760)).toBe(768);
    expect(seq.clipPhaseAt('t1', 800, out)).toEqual({ slot: 1, startTick: 768, lengthTicks: 768 });
    expect(seq.queuedAtTick('t1', 800)).toBeNull();
    // A stop queued: lands at the next bar; afterwards silent.
    seq.stopTrack('t1', sec(900));
    expect(seq.queuedAtTick('t1', 900)).toBe(1152);
    runTo(seq, sec(900), sec(1200) + 0.3);
    expect(seq.clipPhaseAt('t1', 1200, out)).toBeNull();
    expect(seq.clipPhaseAt('t1', 1100, out)).toEqual({ slot: 1, startTick: 768, lengthTicks: 768 });
  });

  it('song mode: the clip loops in phase with its region; a region that plays on in the clip is not a queued change, one that switches it is', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0]]));
    p = setClip(p, 't1', 1, makeClip(2, [[0, 1]]));
    const [a, b] = [p.tracks[0].clips[0]!.id, p.tracks[0].clips[1]!.id];
    p.arrangement = {
      tailSeconds: 1,
      sections: [],
      regions: [
        { id: 'A', trackId: 't1', clipId: a, start: 0, bars: 2, offset: 0 },
        { id: 'A2', trackId: 't1', clipId: a, start: 2, bars: 1, offset: 0 },
        { id: 'B', trackId: 't1', clipId: b, start: 3, bars: 2, offset: 0 },
      ],
    };
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBar: 0 } });
    runTo(seq, 0, sec(700) + 0.3);
    const out = phase();
    expect(seq.clipPhaseAt('t1', 700, out)).toEqual({ slot: 0, startTick: 0, lengthTicks: 384 });
    // A2 (from 768) plays on in the same clip: not a queued change.
    expect(seq.queuedAtTick('t1', 700)).toBeNull();
    runTo(seq, sec(700), sec(800) + 0.3);
    // The loop start is any tick of the clip's phase (one value per phase: at or before 0).
    expect(seq.clipPhaseAt('t1', 800, out)).toEqual({ slot: 0, startTick: 0, lengthTicks: 384 });
    // B (at 1152) switches to the 2-bar clip; visible a bar ahead.
    expect(seq.queuedAtTick('t1', 800)).toBe(1152);
    runTo(seq, sec(800), sec(1300) + 0.3);
    expect(seq.clipPhaseAt('t1', 1300, out)).toEqual({ slot: 1, startTick: 1152 - 2 * 768, lengthTicks: 768 });
    expect((1300 - out.startTick) % 768).toBe(1300 - 1152);
  });

  it('replay: the take plays its own snapshot; a different scene count is no problem', () => {
    const p = twoClips();
    // The take was recorded when the project had 3 scenes; the project has 4 now.
    const old: Project = { ...p, scenes: p.scenes.slice(0, 3), tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.slice(0, 3) })) };
    const perf: Performance = {
      id: 'take',
      name: 'Take 1',
      createdAt: 0,
      startTick: 0,
      endTick: 1536,
      snapshot: makeSnapshot(old, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], 0),
      events: [{ t: 300, type: 'launch', trackId: 't1', slot: 1, atTick: 384 }],
    };
    const live: Project = { ...p, performances: [perf] };
    const seq = new Sequencer({ getProject: () => live });
    seq.start(0, { mode: { kind: 'replay', performanceId: 'take' } });
    runTo(seq, 0, sec(600) + 0.3);
    const out = phase();
    expect(seq.clipPhaseAt('t1', 200, out)).toEqual({ slot: 0, startTick: 0, lengthTicks: 384 });
    expect(seq.clipPhaseAt('t1', 600, out)).toEqual({ slot: 1, startTick: 384, lengthTicks: 768 });
  });

  it('paused: the clip holding at the pause, and a launch queued after it', () => {
    const p = twoClips();
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    runTo(seq, 0, sec(500) + 0.3);
    seq.pause(sec(500));
    const out = phase();
    expect(seq.clipPhaseAt('t1', seq.playheadTick(99), out)).toEqual({ slot: 0, startTick: 0, lengthTicks: 384 });
    seq.launchClip('t1', 1, 99);
    expect(seq.queuedAtTick('t1', seq.playheadTick(99))).toBe(768);
  });
});

/* ------------------------------------------------------------------ */
/* Through the transport: the audible position                          */
/* ------------------------------------------------------------------ */

class FakeCtx {
  currentTime = 0;
  state = 'running';
  sampleRate = 48000;
  outputLatency = 0.1;
  baseLatency = 0.01;
  addEventListener(): void {}
  removeEventListener(): void {}
}

function transportOn(p: Project, latencyFrames = 480) {
  const ctx = new FakeCtx();
  const handle = (time: number) => ({ startTime: time, release() {}, cancel() {}, ended: false });
  const engine = new Proxy(
    { ctx, scheduleNote: (_t: string, n: NoteTrigger) => handle(n.time), outputLatencyFrames: () => latencyFrames, getStats: () => ({}) },
    { get: (o, k) => (k in o ? (o as Record<string | symbol, unknown>)[k] : () => undefined) },
  ) as unknown as AudioEngineApi;
  const seq = new Sequencer({ getProject: () => p });
  let wall = 0;
  const transport = new RealtimeTransport({ ctx: ctx as unknown as BaseAudioContext, engine, sequencer: seq, isHidden: () => false, wallClock: () => wall });
  return {
    ctx,
    seq,
    transport,
    run(ms: number) {
      for (let t = 0; t < ms; t += 25) {
        ctx.currentTime += 0.025;
        wall += 25;
        vi.advanceTimersByTime(25);
      }
    },
  };
}

describe('RealtimeTransport: audible position, clip phase and queued tick', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('outputDelaySeconds: device output and base latency plus the engine’s own', () => {
    const ctx = new FakeCtx() as unknown as BaseAudioContext;
    expect(outputDelaySeconds(ctx, { outputLatencyFrames: () => 480 })).toBeCloseTo(0.12, 9);
    expect(outputDelaySeconds(ctx, null)).toBeCloseTo(0.11, 9);
  });

  it('the audible position lags the scheduled one by the output delay, and waits at the start', () => {
    const r = transportOn(twoClips());
    r.transport.launchClip('t1', 0);
    r.transport.start();
    // Started 50 ms ahead; heard 120 ms later still.
    expect(r.transport.audibleTick()).toBe(0);
    expect(r.transport.getAudiblePosition()).toMatchObject({ tick: 0, playing: true, paused: false });
    r.run(1000);
    const scheduled = r.transport.getPosition().tick;
    const heard = r.transport.getAudiblePosition().tick;
    expect(scheduled - heard).toBeCloseTo(0.12 * 192, 0);
    expect(r.transport.audibleTick()).toBe(heard);
    r.transport.dispose();
  });

  it('clipPhase and queuedAt read at what is heard; null while stopped; `out` is reused', () => {
    const r = transportOn(twoClips());
    expect(r.transport.clipPhase('t1')).toBeNull();
    r.transport.launchClip('t1', 0);
    r.transport.start();
    r.run(2600);
    // Heard: 2.6 − 0.05 − 0.12 s = 2.43 s → tick ≈ 466.
    const out = phase();
    expect(r.transport.clipPhase('t1', out)).toBe(out);
    expect(out).toEqual({ slot: 0, startTick: 0, lengthTicks: 384 });
    r.transport.launchClip('t1', 1);
    expect(r.transport.queuedAt('t1')).toBe(768);
    // At 3.95 s the scheduler is past bar 3 (tick 768 at 4.05 s) but it is not heard yet.
    r.run(1350);
    expect(r.seq.generatedTick).toBeGreaterThan(768);
    expect(r.transport.clipPhase('t1', out)?.slot).toBe(0);
    expect(r.transport.queuedAt('t1')).toBe(768);
    r.run(500);
    expect(r.transport.clipPhase('t1', out)).toEqual({ slot: 1, startTick: 768, lengthTicks: 768 });
    expect(r.transport.queuedAt('t1')).toBeNull();
    r.transport.stop();
    expect(r.transport.clipPhase('t1')).toBeNull();
    expect(r.transport.queuedAt('t1')).toBeNull();
    r.transport.dispose();
  });
});
