import { afterEach, describe, expect, it } from 'vitest';
import type { AudioEngineApi, EngineStats, MeterFrame, NoteTrigger, VoiceHandle } from '../../src/audio/contracts';
import { createClip, createProject } from '../../src/project/factory';
import type { Id, Project } from '../../src/project/types';
import { Sequencer } from '../../src/time/sequencer';
import { RealtimeTransport, type TransportEventMap } from '../../src/time/transport';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class FakeHandle implements VoiceHandle {
  released: number | null = null;
  cancelled = false;
  constructor(
    private readonly ctx: BaseAudioContext,
    readonly startTime: number,
    private readonly gateEnd: number,
  ) {}
  release(time: number): void {
    if (this.released === null && !this.cancelled) this.released = time;
  }
  cancel(): void {
    this.cancelled = true;
  }
  get ended(): boolean {
    return this.cancelled || this.ctx.currentTime > Math.min(this.gateEnd, this.released ?? Infinity) + 0.05;
  }
}

interface NoteCall {
  run: number;
  trackId: Id;
  pitch: number;
  time: number;
  duration: number;
  calledAt: number;
  handle: FakeHandle;
}

/**
 * Records what the transport asks of the engine; voices are fake handles on
 * the context's clock. Like the real engine, cancelling automation or
 * stopping the transport drops the pump ducks and clicks scheduled at or
 * after that time (the sequencer is expected to send regenerated ones again).
 */
class FakeEngine implements AudioEngineApi {
  readonly output: GainNode;
  readonly notes: NoteCall[] = [];
  readonly startedAt: number[] = [];
  readonly stoppedAt: number[] = [];
  clicks: { time: number; accent: boolean }[] = [];
  pumpTimes: number[] = [];
  automationCancels = 0;

  constructor(readonly ctx: BaseAudioContext) {
    this.output = ctx.createGain();
  }
  get pumps(): number {
    return this.pumpTimes.length;
  }
  private dropAfter(time: number): void {
    const t = Math.max(time, this.ctx.currentTime);
    this.clicks = this.clicks.filter((c) => c.time < t);
    this.pumpTimes = this.pumpTimes.filter((p) => p < t);
  }
  setProject(): void {}
  scheduleNote(trackId: Id, note: NoteTrigger): VoiceHandle | null {
    const start = Math.max(note.time, this.ctx.currentTime);
    const handle = new FakeHandle(this.ctx, start, note.time + (note.duration ?? 0));
    this.notes.push({ run: this.startedAt.length, trackId, pitch: note.pitch, time: note.time, duration: note.duration ?? 0, calledAt: this.ctx.currentTime, handle });
    return handle;
  }
  schedulePump(time: number): void {
    this.pumpTimes.push(time);
  }
  scheduleClick(time: number, accent: boolean): void {
    this.clicks.push({ time, accent });
  }
  scheduleParam(): void {}
  scheduleMacro(): void {}
  scheduleMute(): void {}
  scheduleMasterVolume(): void {}
  cancelScheduledAutomation(time: number): void {
    this.automationCancels++;
    this.dropAfter(time);
  }
  transportStarted(time: number): void {
    this.startedAt.push(time);
  }
  transportStopped(time: number): void {
    this.stoppedAt.push(time);
    this.dropAfter(time);
  }
  tempoChanged(): void {}
  liveNoteOn(): void {}
  liveNoteOff(): void {}
  releaseLive(): void {}
  setMasterVolume(): void {}
  setMuteAll(): void {}
  panic(): void {}
  readMeters(_out: MeterFrame): void {}
  getStats(): EngineStats {
    return { voices: 0, modules: 0, connections: 0, pendingTimers: 0 };
  }
  dispose(): void {}
}

function project(bpm: number): Project {
  const p = createProject({ bpm, now: 0 });
  const sixteenths = (pitch: number) => createClip('16ths', 1, Array.from({ length: 16 }, (_, i) => ({ tick: i * 24, pitch, velocity: 0.8, duration: 20 })));
  p.tracks[0].clips[0] = sixteenths(60);
  p.tracks[0].clips[1] = sixteenths(72);
  // A long note, sounding when Stop comes.
  p.tracks[5].clips[0] = createClip('pad', 1, [{ tick: 0, pitch: 48, velocity: 0.5, duration: 384 }]);
  return p;
}

interface Rig {
  ctx: AudioContext;
  engine: FakeEngine;
  seq: Sequencer;
  tr: RealtimeTransport;
}

const rigs: Rig[] = [];

async function rig(p: Project): Promise<Rig> {
  const ctx = new AudioContext();
  await ctx.resume();
  const engine = new FakeEngine(ctx);
  const seq = new Sequencer({ getProject: () => p });
  const tr = new RealtimeTransport({ ctx, engine, sequencer: seq });
  const r = { ctx, engine, seq, tr };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.tr.dispose();
    await r.ctx.close();
  }
});

describe('RealtimeTransport', () => {
  it('start/stop 30 times leaves no handles, listeners or timers behind', async () => {
    const { ctx, engine, seq, tr } = await rig(project(120));
    seq.launchClip('t1', 0, 0);
    seq.launchClip('t6', 0, 0);
    const keep = tr.on('launch', () => {});
    const baseline = tr.getStats().listeners;
    expect(baseline).toBe(1);
    for (let i = 0; i < 30; i++) {
      tr.start();
      expect(tr.playing).toBe(true);
      const off = tr.on('beat', () => {});
      await sleep(15 + (i % 5) * 20);
      off();
      tr.stop();
      const s = tr.getStats();
      expect(s.pendingHandles).toBe(0);
      expect(s.soundingHandles).toBe(0);
      expect(s.queuedEvents).toBe(0);
    }
    expect(tr.getStats()).toMatchObject({ pendingHandles: 0, soundingHandles: 0, listeners: baseline, tickerRunning: false });
    expect(engine.startedAt).toHaveLength(30);
    expect(engine.stoppedAt).toHaveLength(30);
    expect(engine.notes.length).toBeGreaterThan(30);
    for (const n of engine.notes) {
      const stop = engine.stoppedAt[n.run - 1];
      if (n.handle.startTime > stop) expect(n.handle.cancelled).toBe(true); // never sounds
      else if (n.time + n.duration > stop) expect(n.handle.released).toBe(stop); // released gracefully at Stop
    }
    // Runs long enough for the pad to start: its note was released at Stop, not cut off.
    expect(engine.notes.filter((n) => n.trackId === 't6' && n.handle.released !== null).length).toBeGreaterThanOrEqual(12);
    keep();
    expect(tr.getStats().listeners).toBe(0);
    expect(ctx.state).toBe('running');
  });

  it('stops without a backlog when the ticker stalls, then resumes cleanly', async () => {
    const { ctx, engine, seq, tr } = await rig(project(120));
    seq.launchClip('t1', 0, 0);
    tr.start();
    await sleep(300);
    const stalls: TransportEventMap['stalled'][] = [];
    tr.on('stalled', (s) => stalls.push(s));
    const before = engine.notes.length;
    expect(before).toBeGreaterThan(0);
    tr.simulateStall(700);
    await sleep(1000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].reason).toBe('throttled');
    expect(stalls[0].lateBy).toBeGreaterThan(0.25);
    expect(tr.playing).toBe(false);
    // Nothing missed during the stall was played late.
    expect(engine.notes.length).toBe(before);
    expect(tr.getStats()).toMatchObject({ pendingHandles: 0, soundingHandles: 0, tickerRunning: false });
    expect(engine.stoppedAt).toHaveLength(1);

    tr.start();
    await sleep(250);
    const resumed = engine.notes.slice(before);
    expect(resumed.length).toBeGreaterThan(0);
    for (const n of resumed) expect(n.time).toBeGreaterThanOrEqual(n.calledAt - 0.002);
    tr.stop();
    expect(ctx.state).toBe('running');
  });

  it('delivers launch and beat events no earlier than their audio time and switches exactly at the bar', async () => {
    const { ctx, engine, seq, tr } = await rig(project(200)); // 1 bar = 1.2 s
    seq.launchClip('t1', 0, 0);
    const launches: { e: TransportEventMap['launch']; now: number }[] = [];
    const beats: { e: TransportEventMap['beat']; now: number }[] = [];
    tr.on('launch', (e) => launches.push({ e, now: ctx.currentTime }));
    tr.on('beat', (e) => beats.push({ e, now: ctx.currentTime }));
    tr.start();
    // Launch just before the bar line, inside the already-scheduled look-ahead.
    const barTime = seq.timeAt(384);
    while (barTime - ctx.currentTime > 0.06) await sleep(4);
    const r = tr.launchClip('t1', 1);
    expect(r.slot).toBe(1);
    expect(r.atTime).toBeCloseTo(seq.timeAt(r.atTick), 9);
    while (ctx.currentTime < r.atTime + 0.3) await sleep(10);

    expect(launches).toHaveLength(1);
    expect(launches[0].e).toMatchObject({ tick: r.atTick, trackId: 't1', slot: 1 });
    expect(launches[0].e.time).toBeCloseTo(r.atTime, 9);
    expect(launches[0].now).toBeGreaterThanOrEqual(launches[0].e.time);
    expect(beats.length).toBeGreaterThan(3);
    for (const b of beats) expect(b.now).toBeGreaterThanOrEqual(b.e.time);

    // The clips switch exactly at the bar: of the voices that were not cancelled,
    // the old clip's end before it and the new clip's start at it.
    const kept = engine.notes.filter((n) => n.trackId === 't1' && !n.handle.cancelled);
    for (const n of kept) expect(n.pitch).toBe(n.time < r.atTime - 1e-9 ? 60 : 72);
    expect(kept.some((n) => n.pitch === 72 && Math.abs(n.time - r.atTime) < 1e-9)).toBe(true);
    if (r.atTick === 384) {
      // The launch fell inside the scheduled window: old-clip voices from the bar on were cancelled.
      expect(engine.notes.some((n) => n.pitch === 60 && n.handle.cancelled && n.time >= r.atTime - 1e-9)).toBe(true);
    }
    tr.stop();
  });

  it('clicks the count-in, reports context state changes and follows the audio clock', async () => {
    const { ctx, engine, seq, tr } = await rig(project(220));
    seq.launchClip('t1', 0, 0);
    const states: TransportEventMap['state'][] = [];
    tr.on('state', (s) => states.push(s));
    tr.start({ countInBars: 1 });
    const start = engine.startedAt[0];
    await sleep(400);
    const pos = tr.getPosition();
    expect(pos.playing).toBe(true);
    expect(pos.tick).toBeLessThan(0);
    await ctx.suspend();
    await sleep(60);
    expect(states).toContainEqual({ state: 'suspended', playing: true });
    await ctx.resume();
    while (ctx.currentTime < start + 1.3) await sleep(10);
    expect(states.at(-1)).toEqual({ state: 'running', playing: true });
    expect(tr.playing).toBe(true); // a suspended clock is not a stall
    // Four count-in clicks, accent on the first, one beat (60/220 s) apart; metronome off afterwards.
    const beat = 60 / 220;
    expect(engine.clicks).toHaveLength(4);
    engine.clicks.forEach((c, i) => {
      expect(c.time).toBeCloseTo(start + i * beat, 9);
      expect(c.accent).toBe(i === 0);
    });
    expect(engine.notes.every((n) => n.time >= start + 4 * beat - 1e-9)).toBe(true);
    tr.stop();
    expect(tr.getPosition().playing).toBe(false);
  });

  it('stops by itself at the end of a song', async () => {
    const p = project(220);
    // One bar of each part's first clip.
    p.arrangement = { tailSeconds: 1, sections: [], regions: p.tracks.flatMap((t) => (t.clips[0] ? [{ id: t.id, trackId: t.id, clipId: t.clips[0].id, start: 0, bars: 1, offset: 0 }] : [])) };
    const { ctx, tr } = await rig(p);
    const ends: { e: TransportEventMap['end']; now: number }[] = [];
    tr.on('end', (e) => ends.push({ e, now: ctx.currentTime }));
    tr.start({ mode: { kind: 'song', fromBar: 0 } });
    await sleep(1500); // one bar at 220 BPM = 1.09 s
    expect(ends).toHaveLength(1);
    expect(ends[0].e.tick).toBe(384);
    expect(ends[0].now).toBeGreaterThanOrEqual(ends[0].e.time);
    expect(tr.playing).toBe(false);
    expect(tr.getStats()).toMatchObject({ pendingHandles: 0, soundingHandles: 0, tickerRunning: false });
  });

  it('refuses to start an unknown performance without disturbing current playback', async () => {
    const { engine, seq, tr } = await rig(project(120));
    seq.launchClip('t1', 0, 0);
    tr.start();
    await sleep(50);
    expect(() => tr.start({ mode: { kind: 'replay', performanceId: 'missing' } })).toThrow(/not found/);
    expect(tr.playing).toBe(true);
    expect(engine.stoppedAt).toHaveLength(0);
    expect(engine.notes.every((n) => !n.handle.cancelled)).toBe(true);
    tr.stop();
  });

  it('dispose releases the worker and listeners', async () => {
    const { tr, seq } = await rig(project(120));
    seq.launchClip('t1', 0, 0);
    tr.on('beat', () => {});
    tr.start();
    await sleep(50);
    tr.dispose();
    expect(tr.getStats()).toMatchObject({ pendingHandles: 0, soundingHandles: 0, listeners: 0, tickerRunning: false });
    expect(() => tr.start()).toThrow(/disposed/);
  });
});

/* ------------------------------------------------------------------ */
/* Deterministic scenarios on a hand-moved clock                       */
/* ------------------------------------------------------------------ */

/** A context whose clock the test moves; the transport only reads currentTime and state. */
class ManualContext extends EventTarget {
  currentTime = 1;
  state: AudioContextState = 'running';
  readonly sampleRate = 48000;
  createGain(): GainNode {
    return {} as GainNode;
  }
}

interface ManualRig {
  ctx: ManualContext;
  engine: FakeEngine;
  seq: Sequencer;
  tr: RealtimeTransport;
}

const manualRigs: ManualRig[] = [];

function manualRig(p: Project): ManualRig {
  const ctx = new ManualContext();
  const bctx = ctx as unknown as BaseAudioContext;
  const engine = new FakeEngine(bctx);
  const seq = new Sequencer({ getProject: () => p });
  const tr = new RealtimeTransport({ ctx: bctx, engine, sequencer: seq });
  const r = { ctx, engine, seq, tr };
  manualRigs.push(r);
  return r;
}

afterEach(() => {
  for (const r of manualRigs.splice(0)) r.tr.dispose();
});

/** Move the clock to `time`, ticking every `step` seconds like the 25 ms ticker. */
function runTo(r: ManualRig, time: number, step = 0.02): void {
  // The ticker's callback; the worker keeps ticking too, harmlessly, at whatever time the clock shows.
  const tick = (r.tr as unknown as { onTick: () => void }).onTick;
  while (r.ctx.currentTime + step < time - 1e-9) {
    r.ctx.currentTime += step;
    tick();
  }
  r.ctx.currentTime = time;
  tick();
}

function arpProject(latch = false): Project {
  const p = createProject({ bpm: 120, now: 0 });
  for (const i of [4, 5]) p.tracks[i].arp = { enabled: true, division: '1/16', mode: 'up', octaves: 1, latch, gate: 0.5 };
  return p;
}

/** Notes that were not cancelled (they sound), for a track. */
function sounding(engine: FakeEngine, trackId: Id): NoteCall[] {
  return engine.notes.filter((n) => n.trackId === trackId && !n.handle.cancelled);
}

const STEP16 = 0.125; // a 16th at 120 BPM

describe('RealtimeTransport on a hand-moved clock', () => {
  it('re-sends every pump duck and metronome click the engine drops when it invalidates', () => {
    const p = project(120);
    p.settings.metronome = true;
    const { ctx, engine, seq, tr } = manualRig(p);
    seq.launchClip('t1', 0, 0);
    tr.start();
    const t0 = engine.startedAt[0];
    // Edits while playing: each one invalidates the look-ahead (tempo stays 120).
    for (let t = 1.02; t < 4; t += 0.03) {
      runTo({ ctx, engine, seq, tr }, t, 0.01);
      tr.invalidate();
    }
    tr.stop();
    const stop = engine.stoppedAt[0];
    const beats = Array.from({ length: Math.ceil((stop - t0) / 0.5) }, (_, k) => t0 + k * 0.5).filter((t) => t < stop);
    expect(beats.length).toBeGreaterThanOrEqual(6);
    // Exactly one click and one duck per beat, at its time: none lost, none doubled.
    expect(engine.clicks.map((c) => c.time)).toEqual(beats.map((b) => expect.closeTo(b, 9)));
    expect(engine.clicks.map((c) => c.accent)).toEqual(beats.map((_, k) => k % 4 === 0));
    expect(engine.pumpTimes).toEqual(beats.map((b) => expect.closeTo(b, 9)));
    expect(engine.automationCancels).toBeGreaterThan(50);
  });

  it('keeps an arpeggio of held keys going without a gap when Stop is pressed while stopped', () => {
    const r = manualRig(arpProject());
    r.tr.setArpHeld('t5', [60, 64]);
    const first = r.ctx.currentTime + 0.01;
    runTo(r, 1.3);
    r.tr.stop(); // transport already stopped: only a latched arp would end
    runTo(r, 1.8);
    r.tr.setArpHeld('t5', []);
    const release = r.ctx.currentTime + 0.01;
    runTo(r, 2.2);
    const notes = sounding(r.engine, 't5');
    const steps = Math.ceil((release - first) / STEP16);
    expect(notes.map((n) => n.time)).toEqual(Array.from({ length: steps }, (_, k) => expect.closeTo(first + k * STEP16, 9)));
    expect(notes.map((n) => n.pitch)).toEqual(notes.map((_, k) => (k % 2 ? 64 : 60)));
  });

  it('Stop while stopped ends a latched arpeggio at once', () => {
    const r = manualRig(arpProject(true));
    r.tr.setArpHeld('t5', [60]);
    runTo(r, 1.2);
    r.tr.setArpHeld('t5', []); // latched: keeps playing
    runTo(r, 1.5);
    expect(sounding(r.engine, 't5').some((n) => n.time > 1.3)).toBe(true);
    r.tr.stop();
    const stop = r.ctx.currentTime;
    runTo(r, 2);
    expect(sounding(r.engine, 't5').every((n) => n.time <= stop)).toBe(true);
    expect(r.seq.idleActive).toBe(false);
    expect(r.tr.getStats()).toMatchObject({ pendingHandles: 0, tickerRunning: false });
  });

  it('a new arp press while stopped starts on its first pattern note', () => {
    const r = manualRig(arpProject());
    // t6 keeps the idle clock running (anchored at 1.01).
    r.tr.setArpHeld('t6', [48]);
    runTo(r, 1.3);
    // Press 5 ms before a step of the idle grid (1.01 + 3 x 0.125 = 1.385).
    r.ctx.currentTime = 1.38;
    r.tr.setArpHeld('t5', [60, 67]);
    runTo(r, 1.9);
    const t5 = sounding(r.engine, 't5');
    // The first step at/after the press (+10 ms) plays the first note of the pattern.
    expect(t5[0].time).toBeCloseTo(1.01 + 4 * STEP16, 9);
    expect(t5.map((n) => n.pitch).slice(0, 4)).toEqual([60, 67, 60, 67]);
  });

  it('dispose cancels an idle arpeggio that is still scheduled', () => {
    const r = manualRig(arpProject());
    r.tr.setArpHeld('t5', [60, 64]);
    runTo(r, 1.4);
    const at = r.ctx.currentTime;
    r.tr.dispose();
    const after = r.engine.notes.filter((n) => n.handle.startTime > at);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((n) => n.handle.cancelled)).toBe(true);
    expect(r.tr.getStats()).toMatchObject({ pendingHandles: 0, soundingHandles: 0, tickerRunning: false });
  });
});
