/**
 * Gain-reduction readings of Compressor and Gate modules (shape-11), from
 * their worklets at up to 30 Hz, in MeterFrame.moduleReductionDb on a live
 * engine: a hard-working compressor on the House chords reports its
 * reduction within half a second, a bypassed one 0; a gate shows how far it
 * turns a quiet part down.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { MeterFrame } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { HOUSE } from '../../src/content/starters/house';
import { conn, createModule, moduleId } from '../../src/project/factory';
import type { ModuleType, Project } from '../../src/project/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withInsert(p: Project, trackId: string, type: ModuleType, params: Record<string, number>, bypass = false): { project: Project; id: string } {
  const id = `${trackId}:gr-${type}`;
  const f = moduleId.filter(trackId);
  const ch = moduleId.channel(trackId);
  const modules = [...p.patch.modules, { ...createModule(id, type, trackId, params), bypass }];
  const connections = [...p.patch.connections.filter((c) => !(c.from.module === f && c.to.module === ch)), conn(f, 'out', id, 'in'), conn(id, 'out', ch, 'in')];
  return { project: { ...p, patch: { modules, connections } }, id };
}

function frame(): MeterFrame {
  return { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
}

/** Poll the module's reading for `ms`; returns the first time (ms) it exceeded `over` and the largest value. */
async function watch(engine: AudioEngine, id: string, ms: number, over: number): Promise<{ firstOver: number | null; max: number; last: number }> {
  const f = frame();
  const t0 = performance.now();
  let firstOver: number | null = null;
  let max = 0;
  let last = 0;
  while (performance.now() - t0 < ms) {
    engine.readMeters(f);
    last = f.moduleReductionDb?.[id] ?? Number.NaN;
    max = Math.max(max, last);
    if (firstOver === null && last > over) firstOver = performance.now() - t0;
    await sleep(10);
  }
  return { firstOver, max, last };
}

describe('dynamics gain-reduction readings', () => {
  it('a compressor at −40 dB, 20:1 on Chords reports more than 6 dB within 0.5 s; bypassed it reports 0', async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const base = HOUSE.build();
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: base.seed, meters: true });
    try {
      const { project, id } = withInsert(base, 't4', 'compressor', { threshold: -40, ratio: 20 });
      engine.setProject(project);
      await sleep(100);
      const f = frame();
      engine.readMeters(f);
      expect(f.moduleReductionDb?.[id]).toBe(0);
      // A held chord on the part.
      for (const [k, p] of [60, 63, 67].entries()) engine.liveNoteOn('t4', p, 0.9, `Key${k}`);
      const on = await watch(engine, id, 600, 6);
      console.info(`[gr] compressor: over 6 dB after ${on.firstOver?.toFixed(0)} ms, max ${on.max.toFixed(1)} dB`);
      expect(on.firstOver).not.toBeNull();
      expect(on.firstOver!).toBeLessThan(500);
      // Bypassed: it no longer works on the sound and says so.
      const bypassed = { ...project, patch: { ...project.patch, modules: project.patch.modules.map((m) => (m.id === id ? { ...m, bypass: true } : m)) } };
      engine.setProject(bypassed);
      const off = await watch(engine, id, 200, 0);
      expect(off.max).toBe(0);
      engine.releaseLive();
    } finally {
      engine.dispose();
      await ctx.close();
    }
  }, 30_000);

  it('a gate shows how far it turns a quiet part down, and nothing while the part plays loud', async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const base = HOUSE.build();
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: base.seed, meters: true });
    try {
      // Threshold above anything the part plays: the gate stays closed, Depth 30 dB.
      const { project, id } = withInsert(base, 't4', 'gate', { threshold: 0, range: 30, attack: 1, release: 20 });
      engine.setProject(project);
      for (const [k, p] of [60, 63, 67].entries()) engine.liveNoteOn('t4', p, 0.9, `Key${k}`);
      const closed = await watch(engine, id, 500, 20);
      expect(closed.firstOver).not.toBeNull();
      expect(closed.max).toBeLessThanOrEqual(30.5);
      // Threshold far below the part: open while it plays (the stab is struck again: it decays fast).
      engine.releaseLive();
      engine.setProject({ ...project, patch: { ...project.patch, modules: project.patch.modules.map((m) => (m.id === id ? { ...m, params: { ...m.params, threshold: -80 } } : m)) } });
      await sleep(100);
      for (const [k, p] of [62, 65, 69].entries()) engine.liveNoteOn('t4', p, 0.9, `Again${k}`);
      await sleep(60);
      const open = await watch(engine, id, 60, 0.5);
      console.info(`[gr] gate: closed ${closed.max.toFixed(1)} dB, open ${open.last.toFixed(2)} dB`);
      expect(open.last).toBeLessThan(0.5);
      engine.releaseLive();
    } finally {
      engine.dispose();
      await ctx.close();
    }
  }, 30_000);

  it('offline engines report no readings', async () => {
    const { project } = withInsert(HOUSE.build(), 't4', 'compressor', { threshold: -40, ratio: 20 });
    const ctx = new OfflineAudioContext(2, 4800, 48000);
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(48000), seed: project.seed, meters: false });
    engine.setProject(project);
    const f = frame();
    engine.readMeters(f);
    expect(f.moduleReductionDb).toBeUndefined();
    engine.dispose();
  });
});
