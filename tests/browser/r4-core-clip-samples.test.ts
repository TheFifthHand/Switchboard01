/**
 * capability-01: per-clip recordings. A sampler clip with its own recording
 * (Clip.sample) plays that recording; a clip without one plays the part's.
 * The sequencer hands the clip's recording to the engine with each note
 * (NoteTrigger.sample), live and in exports alike, and the session loads
 * clip recordings ahead (engine.preloadSamples) when a project loads and
 * whenever new ones appear.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoteTrigger } from '../../src/audio/contracts';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { patchRuntime } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { createClip, createProject } from '../../src/project/factory';
import { applySamplerToProject } from '../../src/content/presets';
import type { ClipSample, Project } from '../../src/project/types';
import { renderOffline } from '../../src/render/offline';
import { rms } from '../../src/render/analysis';
import { deleteDb } from '../../src/persistence/db';

const SR = 48000;
const BELL: ClipSample = { id: 'builtin:bell-hit', start: 0, end: 1, rootNote: 60 };

/** t8 is a sampler playing builtin:vocal-oh; row 0's clip plays the bell itself, row 1's plays the part's recording. */
function project(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  p.seed = 5;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  applySamplerToProject(p, 't8', 'builtin:vocal-oh');
  const t8 = p.tracks.find((t) => t.id === 't8')!;
  t8.instrument.params.mode = 0;
  t8.instrument.params.rootNote = 60;
  const own = createClip('own', 1, [{ tick: 0, pitch: 60, velocity: 1, duration: 384 }]);
  own.sample = { ...BELL };
  t8.clips[0] = own;
  t8.clips[1] = createClip('part', 1, [{ tick: 0, pitch: 60, velocity: 1, duration: 384 }]);
  // A drum part keeps a clip recording but ignores it.
  const kick = createClip('kick', 1, [{ tick: 0, pitch: 0, velocity: 1, duration: 24 }]);
  kick.sample = { ...BELL };
  p.tracks[0].clips[0] = kick;
  return p;
}

async function render(p: Project, row: number): Promise<Float32Array> {
  const bank = new SampleBank(SR);
  const buf = await renderOffline({
    project: p,
    source: { kind: 'scene', row, bars: 1 },
    sampleRate: SR,
    tailSeconds: 0.5,
    align: true,
    createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: p.seed, meters: false }),
  });
  return buf.getChannelData(0);
}

/** The project with only t8 sounding, its part recording `id` and no clip recording. */
function partPlays(id: string): Project {
  const p = project();
  p.tracks[0].clips[0] = null;
  const t8 = p.tracks.find((t) => t.id === 't8')!;
  if (t8.instrument.kind === 'sampler') t8.instrument.sampleId = id;
  for (const c of t8.clips) if (c) delete c.sample;
  return p;
}

const diff = (a: Float32Array, b: Float32Array) => {
  const d = new Float32Array(Math.min(a.length, b.length));
  for (let i = 0; i < d.length; i++) d[i] = a[i] - b[i];
  return rms(d) / Math.max(1e-9, rms(b));
};

let live: Session[] = [];
beforeEach(async () => {
  await deleteDb();
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null });
});
afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null });
  await deleteDb();
});

describe('per-clip recordings (capability-01)', () => {
  it('rendered: a clip with its own recording plays it; a clip without plays the part’s', async () => {
    const p = project();
    p.tracks[0].clips[0] = null;
    const own = await render(p, 0);
    const part = await render(p, 1);
    const bell = await render(partPlays('builtin:bell-hit'), 0);
    const oh = await render(partPlays('builtin:vocal-oh'), 1);
    console.info(`[clip-samples] own clip vs bell ${diff(own, bell).toExponential(2)}, vs oh ${diff(own, oh).toFixed(3)}; part clip vs oh ${diff(part, oh).toExponential(2)}`);
    expect(rms(own)).toBeGreaterThan(0.005);
    expect(diff(own, bell)).toBeLessThan(1e-3);
    expect(diff(part, oh)).toBeLessThan(1e-3);
    expect(diff(own, oh)).toBeGreaterThan(0.5);
  });

  it('live: notes of a sampler clip carry its recording; other clips and other kinds of part do not', async () => {
    const s = new Session(project());
    live.push(s);
    expect(await s.startAudio()).toBe(true);
    const got: { trackId: string; n: NoteTrigger }[] = [];
    const engine = s.engine!;
    const schedule = engine.scheduleNote.bind(engine);
    engine.scheduleNote = (trackId, n) => {
      got.push({ trackId, n });
      return schedule(trackId, n);
    };
    await s.launchScene(0);
    await new Promise((r) => setTimeout(r, 600));
    s.stop();
    const t8 = got.filter((g) => g.trackId === 't8');
    expect(t8.length).toBeGreaterThan(0);
    expect(t8.every((g) => g.n.sample?.id === 'builtin:bell-hit')).toBe(true);
    const t1 = got.filter((g) => g.trackId === 't1');
    expect(t1.length).toBeGreaterThan(0);
    expect(t1.every((g) => g.n.sample === undefined)).toBe(true);
    got.length = 0;
    await s.launchScene(1);
    await new Promise((r) => setTimeout(r, 600));
    s.stop();
    expect(got.filter((g) => g.trackId === 't8').every((g) => g.n.sample === undefined)).toBe(true);
    expect(engine.getStats().skippedSampleNotes ?? 0).toBe(0);
  });

  it('clip recordings are loaded ahead when audio starts and whenever a new one appears', async () => {
    const calls: string[][] = [];
    const proto = AudioEngine.prototype as unknown as { preloadSamples: (ids: readonly string[]) => Promise<void> };
    const original = proto.preloadSamples;
    proto.preloadSamples = function (this: AudioEngine, ids: readonly string[]) {
      calls.push([...ids]);
      return original.call(this, ids);
    };
    try {
      const s = new Session(project());
      live.push(s);
      expect(await s.startAudio()).toBe(true);
      expect(calls).toEqual([['builtin:bell-hit']]);
      // A new clip recording appears (an edit): loaded ahead once; one already loaded is not asked again.
      s.store.apply('clip:Test clip recording', (d) => {
        const t8 = d.tracks.find((t) => t.id === 't8')!;
        t8.clips[2] = createClip('glass', 1, [{ tick: 0, pitch: 60, velocity: 1, duration: 96 }]);
        t8.clips[2].sample = { id: 'builtin:glass-chord', start: 0, end: 1, rootNote: 60 };
      });
      expect(calls).toEqual([['builtin:bell-hit'], ['builtin:glass-chord']]);
      s.store.apply('clip:Rename', (d) => {
        d.tracks.find((t) => t.id === 't8')!.clips[2]!.name = 'glass 2';
      });
      expect(calls).toHaveLength(2);
    } finally {
      proto.preloadSamples = original;
    }
  });
});
