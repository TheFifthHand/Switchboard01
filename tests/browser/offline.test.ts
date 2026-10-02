import { describe, expect, it } from 'vitest';
import type { AudioEngineApi, EngineStats, MeterFrame, NoteTrigger, VoiceHandle } from '../../src/audio/contracts';
import { createClip, createProject } from '../../src/project/factory';
import type { ClipBars, Id, MacroId, Performance, Project } from '../../src/project/types';
import { detectOnsets, peak } from '../../src/render/analysis';
import { RENDER_START_OFFSET, computeRenderPlan, renderOffline, type RenderRequest } from '../../src/render/offline';
import { makeSnapshot } from '../../src/time/snapshot';

const SR = 48000;
/** Sample position of a tick at 120 BPM (1 tick = 1/192 s = 250 samples). */
const at120 = (tick: number) => Math.round((RENDER_START_OFFSET + tick / 192) * SR);

/**
 * Minimal engine: every note is a short decaying click scaled by velocity,
 * straight to the destination. Master volume scales the output.
 */
class ClickEngine implements AudioEngineApi {
  readonly output: GainNode;
  readonly notes: { trackId: Id; time: number; pitch: number }[] = [];
  readonly params: { module: Id; param: string; value: number; time: number }[] = [];
  readonly macros: { trackId: Id; macro: MacroId; value: number; time: number }[] = [];
  masterAt: { db: number; time: number }[] = [];
  started: { time: number; tick: number; bpm: number } | null = null;
  tempos: { bpm: number; time: number }[] = [];
  pumps = 0;
  clicks = 0;
  disposed = false;
  private readonly click: AudioBuffer;

  constructor(readonly ctx: BaseAudioContext) {
    this.output = ctx.createGain();
    this.output.connect(ctx.destination);
    this.click = ctx.createBuffer(1, 96, ctx.sampleRate);
    const d = this.click.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.exp(-i / 12);
  }

  setProject(): void {}

  scheduleNote(trackId: Id, note: NoteTrigger): VoiceHandle | null {
    const src = this.ctx.createBufferSource();
    src.buffer = this.click;
    const g = this.ctx.createGain();
    g.gain.value = note.velocity;
    src.connect(g).connect(this.output);
    src.start(note.time);
    this.notes.push({ trackId, time: note.time, pitch: note.pitch });
    let ended = false;
    src.onended = () => {
      ended = true;
      src.disconnect();
      g.disconnect();
    };
    return {
      startTime: note.time,
      release: () => {},
      cancel: () => {
        try {
          src.stop();
        } catch {
          // not started
        }
      },
      get ended() {
        return ended;
      },
    };
  }

  schedulePump(): void {
    this.pumps++;
  }
  scheduleClick(): void {
    this.clicks++;
  }
  scheduleParam(module: Id, param: string, value: number, time: number): void {
    this.params.push({ module, param, value, time });
  }
  scheduleMacro(trackId: Id, macro: MacroId, value: number, time: number): void {
    this.macros.push({ trackId, macro, value, time });
  }
  readonly mutes: { trackId: Id; mute: boolean; time: number }[] = [];
  scheduleMute(trackId: Id, mute: boolean, time: number): void {
    this.mutes.push({ trackId, mute, time });
  }
  scheduleMasterVolume(db: number, time: number): void {
    this.masterAt.push({ db, time });
    // Sample-accurate, like the real engine.
    this.output.gain.setValueAtTime(10 ** (db / 20), time);
  }
  cancelScheduledAutomation(): void {}
  transportStarted(time: number, tick: number, bpm: number): void {
    this.started = { time, tick, bpm };
  }
  readonly stops: number[] = [];
  transportStopped(time: number): void {
    this.stops.push(time);
  }
  tempoChanged(bpm: number, time: number): void {
    this.tempos.push({ bpm, time });
  }
  liveNoteOn(): void {}
  liveNoteOff(): void {}
  releaseLive(): void {}
  setMasterVolume(db: number): void {
    this.masterAt.push({ db, time: this.ctx.currentTime });
    this.output.gain.setValueAtTime(10 ** (db / 20), this.ctx.currentTime);
  }
  setMuteAll(): void {}
  panic(): void {}
  readMeters(_out: MeterFrame): void {}
  getStats(): EngineStats {
    return { voices: 0, modules: 0, connections: 0, pendingTimers: 0 };
  }
  dispose(): void {
    this.disposed = true;
    this.output.disconnect();
  }
}

function factory(): { createEngine: RenderRequest['createEngine']; engines: ClickEngine[] } {
  const engines: ClickEngine[] = [];
  return {
    engines,
    createEngine: async (ctx) => {
      const e = new ClickEngine(ctx);
      engines.push(e);
      return e;
    },
  };
}

function withClip(p: Project, trackId: Id, slot: number, bars: ClipBars, notes: [number, number, number?][]): Project {
  const clip = createClip('c', bars, notes.map(([tick, pitch, velocity = 0.8]) => ({ tick, pitch, velocity, duration: 12 })));
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, clips: t.clips.map((c, i) => (i === slot ? clip : c)) } : t)) };
}

function onsets(buf: AudioBuffer): number[] {
  return detectOnsets(buf.getChannelData(0), SR, { threshold: 0.05, minGapMs: 30 });
}

const MS = SR / 1000;

describe('renderOffline', () => {
  it('renders a 4-bar scene loop with onsets at exact sample positions', async () => {
    let p = createProject({ bpm: 120, now: 0 });
    p = withClip(p, 't1', 0, 1, [[0, 0], [96, 1], [192, 2], [288, 3], [336, 4]]);
    p = withClip(p, 't2', 0, 2, [[48, 0]]);
    const f = factory();
    const progress: number[] = [];
    const buf = await renderOffline({ project: p, source: { kind: 'scene', row: 0, bars: 4 }, sampleRate: SR, tailSeconds: 0.5, createEngine: f.createEngine, onProgress: (x) => progress.push(x) });

    const plan = computeRenderPlan(p, { kind: 'scene', row: 0, bars: 4 }, 0.5);
    expect(plan).toMatchObject({ startTick: 0, endTick: 1536 });
    expect(plan.musicSeconds).toBeCloseTo(8, 12);
    expect(buf.length).toBe(Math.ceil(plan.totalSeconds * SR));
    expect(buf.numberOfChannels).toBe(2);

    const expected: number[] = [];
    for (let bar = 0; bar < 4; bar++) {
      for (const t of [0, 96, 192, 288, 336]) expected.push(at120(bar * 384 + t));
      if (bar % 2 === 0) expected.push(at120(bar * 384 + 48));
    }
    expected.sort((a, b) => a - b);
    const found = onsets(buf);
    expect(found).toHaveLength(expected.length);
    found.forEach((s, i) => expect(Math.abs(s - expected[i])).toBeLessThanOrEqual(MS));
    // Looping repeats: every bar has the same onset pattern relative to its start.
    const rel = (bar: number) => found.filter((s) => s >= at120(bar * 384) - MS && s < at120((bar + 1) * 384) - MS).map((s) => s - at120(bar * 384));
    expect(rel(2)).toEqual(rel(0));
    expect(rel(3)).toEqual(rel(1));

    // Progress: increasing, one report per chunk, ends at 1; engine released.
    expect(progress.length).toBeGreaterThanOrEqual(Math.floor(plan.totalSeconds));
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    expect(progress.at(-1)).toBe(1);
    expect(f.engines[0].disposed).toBe(true);
    expect(f.engines[0].started).toEqual({ time: RENDER_START_OFFSET, tick: 0, bpm: 120 });
    // Exports never contain the metronome.
    expect(f.engines[0].clicks).toBe(0);
    expect(f.engines[0].pumps).toBe(16);
  });

  it('swing moves the off-beat 16ths later and leaves on-beats in place', async () => {
    let p = createProject({ bpm: 120, now: 0 });
    p.swing = 1;
    p = withClip(p, 't1', 0, 1, Array.from({ length: 8 }, (_, i) => [i * 24, 0] as [number, number]));
    const buf = await renderOffline({ project: p, source: { kind: 'scene', row: 0, bars: 2 }, sampleRate: SR, tailSeconds: 0.2, ...factory() });
    const found = onsets(buf);
    const expected: number[] = [];
    for (let bar = 0; bar < 2; bar++) for (let i = 0; i < 8; i++) {
      const tick = bar * 384 + i * 24;
      expected.push(at120(tick + (i % 2 ? 8 : 0)));
    }
    expect(found).toHaveLength(expected.length);
    found.forEach((s, i) => expect(Math.abs(s - expected[i])).toBeLessThanOrEqual(MS));
    // The off-beat shift is the triplet position: 8 ticks = 2000 samples.
    expect(found[1] - found[0]).toBeGreaterThan(at120(32) - at120(0) - MS);
  });

  it('renders the arrangement and ends the music at the song end', async () => {
    let p = createProject({ bpm: 120, now: 0 });
    p = withClip(p, 't1', 0, 1, [[0, 0]]);
    p = withClip(p, 't1', 1, 1, [[192, 1]]);
    p.arrangement = { tailSeconds: 1, blocks: [{ id: 'a', sceneId: p.scenes[0].id, repeats: 2 }, { id: 'b', sceneId: p.scenes[1].id, repeats: 1 }] };
    const f = factory();
    const buf = await renderOffline({ project: p, source: { kind: 'song' }, sampleRate: SR, tailSeconds: 1, ...f });
    expect(buf.length).toBe(Math.ceil((RENDER_START_OFFSET + 6 + 1) * SR));
    const found = onsets(buf);
    const expected = [0, 384, 768 + 192].map(at120);
    expect(found).toHaveLength(3);
    found.forEach((s, i) => expect(Math.abs(s - expected[i])).toBeLessThanOrEqual(MS));
    // Like live playback, the transport stops when the music ends (one-shots end, automation hands back); the tail rings on.
    expect(f.engines[0].stops).toHaveLength(1);
    expect(f.engines[0].stops[0]).toBeCloseTo(RENDER_START_OFFSET + 6, 6);
  });

  it('replays a performance with its tempo change, automation and master volume', async () => {
    let base = createProject({ bpm: 120, now: 0 });
    base = withClip(base, 't1', 0, 1, [[0, 0, 1], [96, 0, 1], [192, 0, 1], [288, 0, 1]]);
    const perf: Performance = {
      id: 'take',
      name: 'Take',
      createdAt: 0,
      startTick: 0,
      endTick: 768,
      snapshot: makeSnapshot(base, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], 0),
      events: [
        { t: 150, type: 'macro', trackId: 't1', macro: 'tone', value: 0.25 },
        { t: 192, type: 'master', volumeDb: -6 },
        { t: 384, type: 'tempo', bpm: 60 },
      ],
    };
    // The live project has moved on: 90 BPM and no clips. The render uses the take's snapshot.
    const live: Project = { ...createProject({ bpm: 90, now: 0 }), performances: [perf] };
    const plan = computeRenderPlan(live, { kind: 'performance', performanceId: 'take' }, 0.5);
    expect(plan.musicSeconds).toBeCloseTo(2 + 4, 12);
    const f = factory();
    const buf = await renderOffline({ project: live, source: { kind: 'performance', performanceId: 'take' }, sampleRate: SR, tailSeconds: 0.5, ...f });
    expect(buf.length).toBe(Math.ceil(plan.totalSeconds * SR));
    const found = onsets(buf);
    const expectedSec = [0, 0.5, 1, 1.5, 2, 3, 4, 5].map((s) => Math.round((RENDER_START_OFFSET + s) * SR));
    expect(found).toHaveLength(8);
    found.forEach((s, i) => expect(Math.abs(s - expectedSec[i])).toBeLessThanOrEqual(MS));
    // Master -6 dB from tick 192 (1 s): later clicks are half as loud.
    const d = buf.getChannelData(0);
    const hit = (s: number) => peak(d.subarray(s - 5, s + 20));
    expect(hit(found[1])).toBeCloseTo(1, 2);
    expect(hit(found[2]) / hit(found[1])).toBeCloseTo(10 ** (-6 / 20), 2);
    const e = f.engines[0];
    expect(e.macros).toEqual([{ trackId: 't1', macro: 'tone', value: 0.25, time: RENDER_START_OFFSET + 150 / 192 }]);
    expect(e.tempos).toEqual([{ bpm: 60, time: RENDER_START_OFFSET + 2 }]);
    expect(e.masterAt).toHaveLength(1);
    expect(Math.abs(e.masterAt[0].time - (RENDER_START_OFFSET + 1))).toBeLessThan(128 / SR);
  });

  it('renders a launcher snapshot taken later on the timeline from its first bar, in loop phase', async () => {
    let p = createProject({ bpm: 120, now: 0 });
    p = withClip(p, 't1', 0, 1, [[0, 0]]);
    p = withClip(p, 't2', 0, 2, [[0, 0, 0.5], [384, 0]]);
    // As getLauncherSnapshot() reports it at bar 9: t1 entered at bar 6, the 2-bar t2 clip at bar 7.
    const launcher = [
      { trackId: 't1', playing: { slot: 0, startTick: 6 * 384 } },
      { trackId: 't2', playing: { slot: 0, startTick: 7 * 384 } },
    ];
    const buf = await renderOffline({ project: p, source: { kind: 'launcher', launcher, bars: 2 }, sampleRate: SR, tailSeconds: 0.2, ...factory() });
    const d = buf.getChannelData(0);
    const hit = (tick: number) => peak(d.subarray(at120(tick), at120(tick) + 40));
    // Bar 0: t1 plus t2 in its second bar (full velocity); bar 1: t1 plus t2's first bar (half velocity).
    expect(onsets(buf)).toHaveLength(2);
    expect(hit(0)).toBeCloseTo(0.8 + 0.8, 2);
    expect(hit(384)).toBeCloseTo(0.8 + 0.5, 2);
  });

  it('replays recorded mutes as timed mute automation at their times', async () => {
    let base = createProject({ bpm: 120, now: 0 });
    base = withClip(base, 't2', 0, 1, [[0, 0]]);
    base.patch.modules.find((m) => m.id === 't2:ch')!.params.level = -4;
    const perf: Performance = {
      id: 'take',
      name: 'Take',
      createdAt: 0,
      startTick: 0,
      endTick: 768,
      snapshot: makeSnapshot(base, [{ trackId: 't2', playing: { slot: 0, startTick: 0 } }], 0),
      events: [
        { t: 96, type: 'mute', trackId: 't2', mute: true },
        { t: 480, type: 'mute', trackId: 't2', mute: false },
      ],
    };
    const f = factory();
    await renderOffline({ project: { ...base, performances: [perf] }, source: { kind: 'performance', performanceId: 'take' }, sampleRate: SR, tailSeconds: 0.1, ...f });
    expect(f.engines[0].mutes).toEqual([
      { trackId: 't2', mute: true, time: RENDER_START_OFFSET + 0.5 },
      { trackId: 't2', mute: false, time: RENDER_START_OFFSET + 2.5 },
    ]);
    // Mutes never touch the channel level (the fader keeps the take's mix).
    expect(f.engines[0].params).toEqual([]);
  });

  it('is deterministic: two renders of the same request are bit-identical', async () => {
    let p = createProject({ bpm: 133, now: 0 });
    p.swing = 0.4;
    p = withClip(p, 't1', 0, 1, [[0, 0], [30, 1, 0.5], [100, 2], [250, 3, 0.3]]);
    p = withClip(p, 't4', 0, 2, [[13, 60], [400, 64, 0.6]]);
    const req = (): RenderRequest => ({ project: p, source: { kind: 'scene', row: 0, bars: 3 }, sampleRate: 44100, tailSeconds: 0.3, chunkSeconds: 0.37, ...factory() });
    const a = await renderOffline(req());
    const b = await renderOffline(req());
    expect(a.length).toBe(b.length);
    for (let c = 0; c < 2; c++) {
      const x = a.getChannelData(c);
      const y = b.getChannelData(c);
      let same = true;
      for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) same = false;
      expect(same).toBe(true);
    }
    expect(peak(a.getChannelData(0))).toBeGreaterThan(0.2);
  });

  it('rejects with an AbortError when cancelled, and stops scheduling', async () => {
    let p = createProject({ bpm: 120, now: 0 });
    p = withClip(p, 't1', 0, 1, [[0, 0], [192, 0]]);
    const ctrl = new AbortController();
    const f = factory();
    let reports = 0;
    const run = renderOffline({
      project: p,
      source: { kind: 'scene', row: 0, bars: 32 },
      sampleRate: SR,
      tailSeconds: 0,
      chunkSeconds: 1,
      signal: ctrl.signal,
      createEngine: f.createEngine,
      onProgress: () => {
        reports++;
        if (reports === 2) ctrl.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const scheduled = f.engines[0].notes.length;
    // Only the first couple of seconds were ever scheduled (32 bars would be 64 notes).
    expect(scheduled).toBeLessThan(8);

    const pre = new AbortController();
    pre.abort();
    await expect(renderOffline({ project: p, source: { kind: 'song' }, sampleRate: SR, tailSeconds: 0, signal: pre.signal, ...factory() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('renderOffline: part of the song (songRange, a loop exported once)', () => {
  /** Four blocks: a (row 0 x2), b (row 1), c (row 2 x2, chords layered from row 0), d (row 3); t1 marks each bar by pitch. */
  function fourBlocks(): Project {
    let p = createProject({ bpm: 120, now: 0 });
    for (let row = 0; row < 4; row++) p = withClip(p, 't1', row, 1, [[0, 40 + row, 1], [192, 40 + row, 0.5]]);
    p = withClip(p, 't4', 0, 1, [[96, 60, 0.7]]);
    const [s0, s1, s2, s3] = p.scenes;
    p.arrangement = {
      tailSeconds: 1,
      blocks: [
        { id: 'a', sceneId: s0.id, repeats: 2 },
        { id: 'b', sceneId: s1.id, repeats: 1 },
        { id: 'c', sceneId: s2.id, repeats: 2, parts: { t4: s0.id } },
        { id: 'd', sceneId: s3.id, repeats: 1 },
      ],
    };
    return p;
  }

  it('plans the blocks from the first to the last (either way round); blocks no longer in the song cannot be exported', () => {
    const p = fourBlocks();
    const plan = computeRenderPlan(p, { kind: 'songRange', fromBlockId: 'b', toBlockId: 'c' }, 0.5);
    expect(plan).toMatchObject({ startTick: 2 * 384, endTick: 5 * 384 });
    // 3 bars at 120 BPM.
    expect(plan.musicSeconds).toBeCloseTo(6, 9);
    expect(plan.totalSeconds).toBeCloseTo(RENDER_START_OFFSET + 6 + 0.5, 9);
    expect(computeRenderPlan(p, { kind: 'songRange', fromBlockId: 'c', toBlockId: 'b' }, 0.5)).toEqual(plan);
    expect(() => computeRenderPlan(p, { kind: 'songRange', fromBlockId: 'b', toBlockId: 'gone' }, 0.5)).toThrow();
  });

  it('renders exactly what the song plays over those blocks, once, then the tail', async () => {
    const p = fourBlocks();
    const song = await renderOffline({ project: p, source: { kind: 'song' }, sampleRate: SR, tailSeconds: 1, ...factory() });
    const f = factory();
    const part = await renderOffline({ project: p, source: { kind: 'songRange', fromBlockId: 'b', toBlockId: 'c' }, sampleRate: SR, tailSeconds: 1, ...f });
    // Length: the three bars plus the tail.
    expect(part.length).toBe(Math.ceil((RENDER_START_OFFSET + 6 + 1) * SR));
    // Sample for sample what the song render has from b's start (4 s in) to c's end.
    const from = Math.round(4 * SR);
    const n = Math.round(6 * SR);
    for (const ch of [0, 1]) {
      const a = part.getChannelData(ch).subarray(0, n);
      const b = song.getChannelData(ch).subarray(from, from + n);
      let diff = 0;
      for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
      expect(diff).toBe(0);
    }
    // The layered chords in c are there; nothing of a or d.
    const pitches = f.engines[0].notes.map((x) => x.pitch);
    expect(new Set(pitches)).toEqual(new Set([41, 42, 60]));
    expect(f.engines[0].notes).toHaveLength(2 + 2 * 3);
    // The music ends with c: the transport stop comes there, the tail rings on.
    expect(f.engines[0].stops).toHaveLength(1);
    expect(f.engines[0].stops[0]).toBeCloseTo(RENDER_START_OFFSET + 6, 6);
  });
});
