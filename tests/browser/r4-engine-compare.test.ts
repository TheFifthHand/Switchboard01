/**
 * Level-matched A/B (MIX-06) on a live engine playing House parts (held, so
 * the sound is steady and nothing depends on the scheduler keeping up): a
 * loudness tap at the mastering input runs while mastering is on
 * (loudness.preMasteringShortTerm); turning the comparison on plays the
 * un-mastered sound with the measured short-term difference, so with the
 * Loud preset both sides read within 1 dB over 3 s windows; with neutral
 * mastering the trim is about 0; with matchLevels false the levels are left
 * alone. The project never changes.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { MeterFrame } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { masteringPreset } from '../../src/content/mastering';
import { HOUSE } from '../../src/content/starters/house';
import { neutralMasteringParams } from '../../src/project/params';
import type { Project } from '../../src/project/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frame(): MeterFrame {
  return { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
}

async function playing(project: Project, run: (engine: AudioEngine, read: () => MeterFrame) => Promise<void>): Promise<void> {
  const ctx = new AudioContext();
  await ctx.resume();
  const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: project.seed, meters: true });
  engine.setProject(project);
  await engine.prepareInstruments();
  // The pad's chord and a bass note, held.
  for (const [k, p] of [55, 58, 62, 65].entries()) engine.liveNoteOn('t6', p, 0.9, `Pad${k}`);
  engine.liveNoteOn('t3', 31, 0.9, 'Bass');
  const f = frame();
  try {
    await run(engine, () => {
      engine.readMeters(f);
      return f;
    });
  } finally {
    engine.releaseLive();
    engine.dispose();
    await ctx.close();
  }
}

describe('level-matched A/B', () => {
  it('Loud: the latched comparison keeps the short-term loudness within 1 dB of the mastered sound', async () => {
    const project = HOUSE.build();
    project.mastering = { enabled: true, params: { ...masteringPreset('loud')!.params } };
    const frozen = JSON.stringify(project);
    await playing(project, async (engine, read) => {
      await sleep(3600);
      const before = read();
      const mastered = before.loudness!.shortTerm;
      const pre = before.loudness!.preMasteringShortTerm!;
      expect(Number.isFinite(pre)).toBe(true);
      expect(mastered - pre).toBeGreaterThan(3);
      engine.setMasteringBypass(true);
      const trim = read().compareTrimDb!;
      await sleep(3300);
      const bypassed = read().loudness!.shortTerm;
      console.info(`[compare] Loud: mastered S ${mastered.toFixed(1)} LUFS, pre ${pre.toFixed(1)}, trim ${trim.toFixed(1)} dB, bypassed S ${bypassed.toFixed(1)} LUFS`);
      expect(trim).toBeGreaterThan(3);
      expect(Math.abs(bypassed - mastered)).toBeLessThanOrEqual(1);
      engine.setMasteringBypass(false);
      expect(read().compareTrimDb).toBe(0);
    });
    expect(JSON.stringify(project)).toBe(frozen);
  }, 30_000);

  it('neutral mastering: the trim is about 0; matchLevels false compares as it is; mastering off has no tap', async () => {
    const project = HOUSE.build();
    project.mastering = { enabled: true, params: neutralMasteringParams() };
    await playing(project, async (engine, read) => {
      await sleep(3400);
      engine.setMasteringBypass(true);
      const trim = read().compareTrimDb!;
      console.info(`[compare] neutral: trim ${trim.toFixed(2)} dB`);
      expect(Math.abs(trim)).toBeLessThan(0.5);
      engine.setMasteringBypass(false);
      engine.setMasteringBypass(true, { matchLevels: false });
      expect(read().compareTrimDb).toBe(0);
      engine.setMasteringBypass(false);
      // Mastering switched off: the input tap stops and reads −Infinity.
      engine.setProject({ ...project, mastering: { ...project.mastering!, enabled: false } });
      await sleep(150);
      expect(read().loudness!.preMasteringShortTerm).toBe(-Infinity);
    });
  }, 30_000);

  it('with (nearly) nothing playing the levels are left alone', async () => {
    const project = HOUSE.build();
    project.mastering = { enabled: true, params: { ...masteringPreset('loud')!.params } };
    const ctx = new AudioContext();
    await ctx.resume();
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: project.seed, meters: true });
    try {
      engine.setProject(project);
      await sleep(600);
      engine.setMasteringBypass(true);
      const f = frame();
      engine.readMeters(f);
      expect(f.compareTrimDb).toBe(0);
    } finally {
      engine.dispose();
      await ctx.close();
    }
  });
});
