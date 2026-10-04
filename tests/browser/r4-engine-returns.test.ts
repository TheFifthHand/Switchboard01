/**
 * Return meters (MIX-08): MeterFrame.returns reads peak and RMS after the
 * shared Reverb (fx:reverb) and Echo (fx:delay) outputs on a live engine:
 * what each return adds to the mix. A return switched off reads 0; with no
 * sends, the returns read silence while the parts play.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { MeterFrame } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { HOUSE } from '../../src/content/starters/house';
import { REVERB_ID } from '../../src/project/factory';
import type { Project } from '../../src/project/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frame(): MeterFrame {
  return { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
}

/** Largest return readings over `ms` of polling. */
async function returnsOver(engine: AudioEngine, ms: number): Promise<{ reverb: number; delay: number; reverbPeak: number }> {
  const f = frame();
  let reverb = 0;
  let delay = 0;
  let reverbPeak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    engine.readMeters(f);
    reverb = Math.max(reverb, f.returns?.reverb.rms ?? 0);
    delay = Math.max(delay, f.returns?.delay.rms ?? 0);
    reverbPeak = Math.max(reverbPeak, f.returns?.reverb.peak ?? 0);
    await sleep(15);
  }
  return { reverb, delay, reverbPeak };
}

function strike(engine: AudioEngine, keys: string): void {
  for (const [k, p] of [60, 64, 67].entries()) engine.liveNoteOn('t4', p, 0.9, `${keys}${k}`);
}

describe('return meters', () => {
  it('read what the Reverb and Echo returns add, and 0 for a return switched off', async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const project = HOUSE.build();
    // Chords send to both returns.
    const t4 = project.tracks.find((t) => t.id === 't4')!;
    t4.macros = { ...t4.macros, space: 0.6, echo: 0.6 };
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: project.seed, meters: true });
    try {
      engine.setProject(project);
      await sleep(50);
      strike(engine, 'A');
      const on = await returnsOver(engine, 700);
      console.info(`[returns] reverb rms ${on.reverb.toFixed(4)} (peak ${on.reverbPeak.toFixed(4)}), echo rms ${on.delay.toFixed(4)}`);
      expect(on.reverb).toBeGreaterThan(0.002);
      expect(on.reverbPeak).toBeGreaterThanOrEqual(on.reverb);
      expect(on.delay).toBeGreaterThan(0.002);
      engine.releaseLive();

      // The reverb return switched off: its output is muted and its meter says so.
      const off: Project = { ...project, patch: { ...project.patch, modules: project.patch.modules.map((m) => (m.id === REVERB_ID ? { ...m, bypass: true } : m)) } };
      engine.setProject(off);
      strike(engine, 'B');
      const bypassed = await returnsOver(engine, 400);
      expect(bypassed.reverb).toBe(0);
      expect(bypassed.delay).toBeGreaterThan(0.002);
      engine.releaseLive();
    } finally {
      engine.dispose();
      await ctx.close();
    }
  }, 30_000);

  it('with no sends the returns read silence while the part plays', async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const project = HOUSE.build();
    for (const t of project.tracks) t.macros = { ...t.macros, space: 0, echo: 0 };
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: project.seed, meters: true });
    try {
      engine.setProject(project);
      await sleep(50);
      strike(engine, 'C');
      const r = await returnsOver(engine, 400);
      const f = frame();
      engine.readMeters(f);
      expect(r.reverb).toBeLessThan(1e-5);
      expect(r.delay).toBeLessThan(1e-5);
      engine.releaseLive();
    } finally {
      engine.dispose();
      await ctx.close();
    }
  }, 30_000);
});
