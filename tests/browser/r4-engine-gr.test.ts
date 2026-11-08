/**
 * Gain-reduction readings of Compressor and Gate modules (shape-11), from
 * their worklets at up to 30 Hz. The readings themselves are checked on an
 * offline render with reporting switched on, read at suspend points after
 * steady stretches (no wall-clock timing): a compressor reports its static
 * reduction, a closed gate its Depth on quiet sound, an open gate and either
 * of them in silence 0. A live engine puts the readings in
 * MeterFrame.moduleReductionDb (waiting on audio time, not on a fixed
 * delay); a bypassed module reads 0 and offline engines report none.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine, loadEngineWorklets } from '../../src/audio/engine';
import type { MeterFrame } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { CompressorModule } from '../../src/audio/modules/compressor';
import { GateModule } from '../../src/audio/modules/gate';
import { HOUSE } from '../../src/content/starters/house';
import { conn, createModule, moduleId } from '../../src/project/factory';
import type { ModuleType, Project } from '../../src/project/types';
import { makeEnv } from './fx-helpers';

const SR = 48000;

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

/** Let the reports posted so far arrive (rendering is suspended, so nothing new is posted meanwhile). */
async function settle(read: () => number, expected: (v: number) => boolean): Promise<number> {
  let v = read();
  for (let k = 0; k < 400 && !expected(v); k++) {
    await new Promise((r) => setTimeout(r, 5));
    v = read();
  }
  return v;
}

/**
 * A 1 kHz tone through a module with reporting on: `segments` of [seconds,
 * amplitude], each read near its end (at a suspend point) once its reports
 * have arrived.
 */
async function readingsOver(make: (ctx: OfflineAudioContext) => CompressorModule | GateModule, segments: [number, number][], expect: ((v: number) => boolean)[]): Promise<number[]> {
  const total = segments.reduce((a, [s]) => a + s, 0);
  const ctx = new OfflineAudioContext(2, Math.round(total * SR), SR);
  await loadEngineWorklets(ctx);
  const mod = make(ctx);
  const buf = ctx.createBuffer(1, Math.round(total * SR), SR);
  const d = buf.getChannelData(0);
  let i = 0;
  for (const [sec, amp] of segments) for (let k = 0; k < Math.round(sec * SR); k++, i++) d[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / SR);
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  src.connect(mod.input('in')!);
  mod.output('out')!.connect(ctx.destination);
  src.start(0);
  const out: number[] = [];
  let t = 0;
  segments.forEach(([sec], k) => {
    t += sec;
    const at = Math.round((t - 0.05) * SR / 128) * 128 / SR;
    void ctx.suspend(at).then(async () => {
      out.push(await settle(() => mod.reductionDb, expect[k]));
      void ctx.resume();
    });
  });
  await ctx.startRendering();
  mod.dispose();
  return out;
}

describe('dynamics gain-reduction readings', () => {
  it('a compressor reports its reduction on a loud tone and 0 in silence (offline render, reports on)', async () => {
    // −6 dBFS peak against −40 dB at 20:1: about 30 dB of reduction.
    const readings = await readingsOver(
      (ctx) => new CompressorModule(makeEnv(ctx, { offline: false }), 'c', { threshold: -40, ratio: 20, attack: 1, release: 50, makeup: 0, mix: 1 }),
      [
        [0.5, 0],
        [0.6, 0.5],
        [1.0, 0],
      ],
      [(v) => v === 0, (v) => v > 20, (v) => v === 0],
    );
    console.info(`[gr] compressor: silence ${readings[0]}, loud ${readings[1].toFixed(1)} dB, silence again ${readings[2]}`);
    expect(readings[0]).toBe(0);
    expect(readings[1]).toBeGreaterThan(25);
    expect(readings[1]).toBeLessThan(34);
    expect(readings[2]).toBe(0);
  });

  it('a gate reports its Depth on quiet sound below the threshold, 0 while open and 0 in silence (offline render, reports on)', async () => {
    const readings = await readingsOver(
      (ctx) => new GateModule(makeEnv(ctx, { offline: false }), 'g', { threshold: -40, range: 30, attack: 1, release: 20 }),
      [
        [0.5, 0.5], // loud: open
        [0.5, 0.001], // −60 dBFS: closed, turned down by Depth
        [0.5, 0], // silence: nothing to turn down
      ],
      [(v) => v === 0, (v) => v > 29, (v) => v === 0],
    );
    console.info(`[gr] gate: open ${readings[0]}, quiet ${readings[1].toFixed(1)} dB, silence ${readings[2]}`);
    expect(readings[0]).toBe(0);
    expect(readings[1]).toBeGreaterThan(29.5);
    expect(readings[1]).toBeLessThanOrEqual(30.5);
    expect(readings[2]).toBe(0);
  });

  it('a live engine reports a working compressor in MeterFrame.moduleReductionDb; bypassed it reads 0', async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const base = HOUSE.build();
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: base.seed, meters: true });
    // Polls the reading until `done` or until `seconds` of audio time have passed (the audio clock, not the wall clock, bounds it).
    const until = async (id: string, done: (v: number) => boolean, seconds: number): Promise<number> => {
      const f = frame();
      const end = ctx.currentTime + seconds;
      for (;;) {
        engine.readMeters(f);
        const v = f.moduleReductionDb?.[id] ?? Number.NaN;
        if (done(v) || ctx.currentTime > end) return v;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    try {
      const { project, id } = withInsert(base, 't4', 'compressor', { threshold: -40, ratio: 20 });
      engine.setProject(project);
      expect(await until(id, (v) => v === 0, 0.5)).toBe(0);
      // A held chord on the part.
      for (const [k, p] of [60, 63, 67].entries()) engine.liveNoteOn('t4', p, 0.9, `Key${k}`);
      const on = await until(id, (v) => v > 6, 2);
      console.info(`[gr] live compressor: ${on.toFixed(1)} dB`);
      expect(on).toBeGreaterThan(6);
      // Bypassed: it no longer works on the sound and says so.
      engine.setProject({ ...project, patch: { ...project.patch, modules: project.patch.modules.map((m) => (m.id === id ? { ...m, bypass: true } : m)) } });
      const f = frame();
      engine.readMeters(f);
      expect(f.moduleReductionDb?.[id]).toBe(0);
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
