/**
 * Studio engine features through the whole AudioEngine:
 *  - pitch bend (MIDI wheel) on bass, poly and sampler parts; drums ignore it,
 *  - Mute All flushes the new effects' tails (Tape hiss follower, Flanger line),
 *  - Auto Pan follows the engine's transport and tempo,
 *  - live meters: K-weighted loudness (momentary / short-term / integrated),
 *    true peak, Glue gain reduction, the output spectrum, resetLoudness,
 *  - no resource growth across repeated setProject / Play / Stop with every
 *    new effect and the mastering chain in use.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { OUTPUT_CEILING, type InstrumentFactory, type MeterFrame } from '../../src/audio/contracts';
import { createInstrumentEngine } from '../../src/audio/instruments/index';
import { SampleBank, audioBufferFromChannels } from '../../src/audio/instruments/sampleBank';
import { masteringPreset } from '../../src/content/mastering';
import { createInstrument, moduleId } from '../../src/project/factory';
import { SAMPLER_PARAMS, defaultParams, neutralMasteringParams } from '../../src/project/params';
import type { Instrument, ModuleType, ParamValues, Project } from '../../src/project/types';
import { estimateFundamental } from '../../src/render/analysis';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { LATENCY, SR, baseProject, coreProject, harness, makeFactory, pitchForHz, rms } from './engine-harness';

const slice = (x: Float32Array, t0: number, t1: number) => x.subarray(Math.round(t0 * SR), Math.round(t1 * SR));
const cents = (ratio: number) => 1200 * Math.log2(ratio);

/** A project with real instruments: t1 drums, t3 bass, t4 poly, t8 a 480 Hz sampled tone. */
function realInstruments(): { project: Project; factory: InstrumentFactory } {
  const bank = new SampleBank(SR);
  const x = new Float32Array(Math.round(2 * SR));
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 480 * i) / SR);
  bank.add('tone', audioBufferFromChannels([x], SR));
  const p = coreProject(120);
  p.tracks[7].instrument = { ...createInstrument('sampler', 'tone'), params: { ...defaultParams(SAMPLER_PARAMS) } } as Instrument;
  const factory: InstrumentFactory = (ictx, inst) => createInstrumentEngine({ ...ictx, samples: bank }, inst);
  return { project: p, factory };
}

/** Insert effects into a part's chain (through the real commands) and set their params. */
function withEffects(p: Project, trackId: string, effects: [ModuleType, ParamValues][]): Project {
  const store = new ProjectStore(p);
  for (const [type, params] of effects) {
    const r = cmd.insertEffect(store, trackId, type);
    expect(r.changed, `insert ${type}`).toBe(true);
    for (const [k, v] of Object.entries(params)) cmd.setModuleParam(store, r.moduleId!, k, v);
  }
  return store.getState();
}

describe('pitch bend', () => {
  it('bends bass, poly and sampler parts (playing notes too), smoothly; drums ignore it', async () => {
    const { project, factory } = realInstruments();
    const h = await harness(2.2, project, factory);
    h.engine.scheduleNote('t3', { pitch: 45, velocity: 0.8, time: 0.05, duration: 2 });
    h.engine.scheduleNote('t4', { pitch: 81, velocity: 0.6, time: 0.05, duration: 2 });
    h.engine.scheduleNote('t8', { pitch: 60, velocity: 0.8, time: 0.05, duration: 2 });
    h.at(0.75, () => {
      h.engine.setPitchBend!('t3', 200, 0.75);
      h.engine.setPitchBend!('t4', -100, 0.75);
      h.engine.setPitchBend!('t8', 1200, 0.75);
    });
    const all = await h.render();
    expect(rms(all.L, 0.9, 1.3)).toBeGreaterThan(0.01);
    // Each part rendered alone, for clean pitch estimates.
    const solo = async (track: string, pitch: number, bend: number, at = 0.75, withRebuild = false) => {
      const r = realInstruments();
      const hh = await harness(2.2, r.project, r.factory);
      hh.engine.scheduleNote(track, { pitch, velocity: 0.8, time: 0.05, duration: 2 });
      hh.at(at, () => hh.engine.setPitchBend!(track, bend, at));
      // Rebuilding the modules ends the note; a new note on the new module is still bent.
      if (withRebuild)
        hh.at(1.4, () => {
          hh.engine.setProject({ ...r.project, seed: r.project.seed + 1 });
          hh.engine.scheduleNote(track, { pitch, velocity: 0.8, time: 1.45, duration: 0.7 });
        });
      return (await hh.render()).L;
    };
    for (const [track, pitch, bend] of [['t3', 45, 200], ['t4', 81, -100], ['t8', 60, 1200]] as const) {
      const L = await solo(track, pitch, bend, 0.75, track === 't4');
      const before = estimateFundamental(slice(L, 0.3, 0.7), SR);
      const after = estimateFundamental(slice(L, 0.9, 1.3), SR);
      expect(before, track).toBeGreaterThan(0);
      expect(cents(after / before), track).toBeCloseTo(bend, -1);
      if (track === 't4') expect(cents(estimateFundamental(slice(L, 1.6, 2.0), SR) / before)).toBeCloseTo(bend, -1);
    }
  });

  it('drum kits are not bent', async () => {
    const run = async (bend: number) => {
      const p = baseProject();
      const h = await harness(1, p, (ictx, inst) => createInstrumentEngine(ictx, inst));
      h.engine.setPitchBend!('t1', bend, 0);
      for (let k = 0; k < 4; k++) h.engine.scheduleNote('t1', { pitch: k % 2 ? 2 : 0, velocity: 1, time: 0.05 + k * 0.2, duration: 0.1 });
      return (await h.render()).L;
    };
    const plain = await run(0);
    const bent = await run(700);
    expect(rms(plain, 0, 1)).toBeGreaterThan(0.01);
    // Identical but for the engine's summation rounding (a 700-cent bend would change everything).
    let d = 0;
    for (let i = 0; i < plain.length; i++) d = Math.max(d, Math.abs(plain[i] - bent[i]));
    expect(d).toBeLessThan(1e-5);
  });
});

describe('effects inside the engine', () => {
  it('Mute All flushes the Tape hiss follower and the Flanger line: nothing comes back on unmute', async () => {
    const p = withEffects(coreProject(), 't3', [
      ['flanger', { depth: 1, rate: 0.05, feedback: 0.85, mix: 1 }],
      ['tape', { drive: 0, wobble: 0, tone: 1, hiss: 1, mix: 1 }],
    ]);
    const run = async (mute: boolean) => {
      const h = await harness(1, p, makeFactory().factory);
      h.engine.scheduleNote('t3', { pitch: pitchForHz(300), velocity: 0.8, time: 0.05, duration: 0.2 });
      if (mute) {
        h.at(0.3, () => h.engine.setMuteAll(true));
        h.at(0.5, () => h.engine.setMuteAll(false));
      }
      return (await h.render()).L;
    };
    const free = await run(false);
    // Without Mute All the hiss (and flanger tail) still sound well after the note.
    expect(rms(free, 0.55, 0.9)).toBeGreaterThan(1e-4);
    const muted = await run(true);
    expect(rms(muted, 0.32, 0.49)).toBeLessThan(1e-6);
    expect(rms(muted, 0.55, 0.9)).toBeLessThan(1e-6);
  });

  it('Auto Pan lines up with the engine transport, also when patched in during playback', async () => {
    const p = withEffects(coreProject(), 't3', [['autopan', { mode: 0, division: 4, shape: 0, depth: 1 }]]);
    const h = await harness(1.6, coreProject(), makeFactory().factory);
    h.engine.transportStarted(0.1, 0, 120);
    h.engine.scheduleNote('t3', { pitch: pitchForHz(1000), velocity: 0.5, time: 0.05, duration: 1.5 });
    // Patched in while the transport runs: it must join on the transport's phase.
    h.at(0.3, () => h.engine.setProject(p));
    const { L, R } = await h.render();
    const bal = (t: number) => 20 * Math.log10(rms(R, t + LATENCY - 0.004, t + LATENCY + 0.004) / rms(L, t + LATENCY - 0.004, t + LATENCY + 0.004));
    // Beat phase from the start at 0.1 s: a quarter cycle after every beat is hard right, three quarters hard left.
    expect(bal(0.1 + 1.0 + 0.125)).toBeGreaterThan(20);
    expect(bal(0.1 + 1.0 + 0.375)).toBeLessThan(-20);
  });
});

describe('live meters and resources', () => {
  const frame = (): MeterFrame => ({ masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] });

  it('reports K-weighted loudness, true peak, Glue reduction and the output spectrum', async () => {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    try {
      const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: 1, meters: true, instrumentFactory: makeFactory().factory });
      const p = coreProject();
      engine.setProject(p);
      // A 1 kHz tone at −20 dBFS on both channels: −20 LUFS, −20 dBTP.
      engine.liveNoteOn('t3', pitchForHz(1000), 0.1, 'KeyA');
      await new Promise((r) => setTimeout(r, 1300));
      const f = frame();
      engine.readMeters(f);
      expect(f.loudness).toBeDefined();
      expect(f.loudness!.momentary).toBeCloseTo(-20, 0);
      expect(f.loudness!.integrated).toBeGreaterThan(-21);
      expect(f.loudness!.integrated).toBeLessThan(-19.5);
      expect(f.loudness!.truePeakDb).toBeCloseTo(-20, 0);
      expect(f.glueReductionDb).toBe(0);
      const bands = new Float32Array(64);
      // The analyser smooths between reads (as the Mix view's display does at its frame rate).
      for (let k = 0; k < 24; k++) {
        engine.readSpectrum!(bands);
        await new Promise((r) => setTimeout(r, 20));
      }
      let best = 0;
      for (let b = 1; b < bands.length; b++) if (bands[b] > bands[best]) best = b;
      const expected = Math.floor((64 * Math.log(1000 / 20)) / Math.log(1000));
      expect(Math.abs(best - expected)).toBeLessThanOrEqual(1);
      // Band energy, calibrated so a sine reads its own level.
      expect(bands[best]).toBeGreaterThan(-23);
      expect(bands[best]).toBeLessThan(-17);
      expect(bands[best] - bands[Math.floor((64 * Math.log(100 / 20)) / Math.log(1000))]).toBeGreaterThan(40);
      expect(bands.every((v) => Number.isFinite(v) && v >= -140 && v <= 20)).toBe(true);

      // resetLoudness restarts the integrated value; full Glue on a loud tone shows its reduction.
      engine.resetLoudness!();
      engine.readMeters(f);
      expect(f.loudness!.integrated).toBe(-Infinity);
      engine.setProject({ ...p, mastering: { enabled: true, params: { ...neutralMasteringParams(), glue: 1, punch: 0 } } });
      engine.liveNoteOff('t3', 'KeyA');
      engine.liveNoteOn('t3', pitchForHz(1000), 0.5, 'KeyB');
      await new Promise((r) => setTimeout(r, 900));
      engine.readMeters(f);
      expect(f.glueReductionDb).toBeGreaterThan(11);
      expect(f.glueReductionDb).toBeLessThan(15);
      expect(f.loudness!.integrated).toBeGreaterThan(-20);
      expect(f.masterPeakL).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
      engine.dispose();
    } finally {
      await ctx.close();
    }
  });

  it('repeated setProject / Play / Stop with every new effect and mastering leaves nothing behind', async () => {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    try {
      const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: 1, meters: true, instrumentFactory: makeFactory().factory });
      const plain = baseProject();
      let studio = withEffects(baseProject(), 't3', [
        ['eq', { midGain: 6 }],
        ['compressor', { threshold: -30 }],
        ['gate', { threshold: -60 }],
        ['autopan', { depth: 0.5 }],
      ]);
      studio = withEffects(studio, 't4', [
        ['widener', { width: 1.6 }],
        ['flanger', { feedback: 0.8 }],
        ['tape', { hiss: 0.5 }],
      ]);
      studio = { ...studio, mastering: { enabled: true, params: { ...masteringPreset('loud')!.params } } };
      const settle = () => new Promise((r) => setTimeout(r, 250));
      engine.setProject(plain);
      await settle();
      const baseline = engine.getStats();
      for (let k = 0; k < 4; k++) {
        engine.setProject(studio);
        engine.transportStarted(ctx.currentTime + 0.05, 0, 120);
        engine.liveNoteOn('t3', 60, 0.8, 'KeyA');
        engine.liveNoteOn('t4', 64, 0.8, 'KeyB');
        await new Promise((r) => setTimeout(r, 120));
        engine.liveNoteOff('t3', 'KeyA');
        engine.liveNoteOff('t4', 'KeyB');
        engine.transportStopped(ctx.currentTime);
        engine.setProject(plain);
        await settle();
        const s = engine.getStats();
        expect(s.modules).toBe(baseline.modules);
        expect(s.connections).toBe(baseline.connections);
        expect(s.pendingTimers).toBe(0);
        expect(s.voices).toBe(0);
      }
      expect(studio.patch.modules.length).toBe(plain.patch.modules.length + 7);
      engine.dispose();
      expect(engine.getStats().modules).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('every new effect module is created and disposed by the engine (offline, immediate)', async () => {
    // A part holds up to six effects (two are there by default).
    const p = withEffects(baseProject(), 't4', [
      ['eq', {}],
      ['compressor', {}],
      ['gate', {}],
      ['autopan', {}],
    ]);
    const q = withEffects(p, 't5', [
      ['widener', {}],
      ['flanger', {}],
      ['tape', {}],
    ]);
    const h = await harness(0.3, q);
    expect(h.engine.getStats().modules).toBe(q.patch.modules.length);
    h.at(0.1, () => h.engine.setProject(baseProject()));
    const { stats } = await h.render();
    expect(stats.modules).toBe(baseProject().patch.modules.length);
    void moduleId;
  });
});
