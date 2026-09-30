/**
 * AudioEngine timing-driven behaviour: Pump, the tempo-synced LFO (tremolo,
 * vibrato, transport phase alignment, tempo changes, wave swaps, seeded
 * Random), automation (scheduleParam / scheduleMacro / cancel) and live
 * input — measured on offline-rendered audio.
 */
import { describe, expect, it } from 'vitest';
import { conn } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { PUMP_ATTACK } from '../../src/audio/modules/channel';
import {
  LATENCY,
  SR,
  argMin,
  clone,
  coreProject,
  cycleEnvelope,
  harness,
  modulation,
  moduleParams,
  peak,
  pitchForHz,
  toneAmp,
} from './engine-harness';

/** 1 kHz = exactly 48 samples per cycle at 48 kHz, for clean envelopes. */
const TONE_HZ = 1000;
const TONE = pitchForHz(TONE_HZ);
const CYCLE = SR / TONE_HZ;

function env(d: Float32Array, t0: number, t1: number) {
  return cycleEnvelope(d, CYCLE, t0, t1);
}

describe('Pump', () => {
  function pumpProject(pumpDiv: number): Project {
    const p = coreProject(120);
    p.tracks[2].macros = { ...p.tracks[2].macros, pump: 1 }; // -> t3:ch pump 0.9
    moduleParams(p, 't3:ch').pumpDiv = pumpDiv;
    return p;
  }
  const beats = [0.25, 0.75, 1.25, 1.75];

  it('ducks at every beat (1/4) and recovers before the next beat', async () => {
    const h = await harness(2.4, pumpProject(0));
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.5, time: 0.01 });
    beats.forEach((t, i) => h.engine.schedulePump(t, 0.5, i));
    const { L } = await h.render();
    const e = env(L, 0.05, 2.35);
    const steady = peak(L, 0.1, 0.24);
    expect(steady).toBeCloseTo(0.5, 2);
    for (const t of beats) {
      // Deepest point at the end of the 6 ms duck (plus the limiter's look-ahead latency).
      const dip = argMin(e, t - 0.02, t + 0.06);
      expect(Math.abs(dip.t - (t + LATENCY + PUMP_ATTACK))).toBeLessThan(0.0015);
      expect(dip.v / steady).toBeLessThan(0.15); // floor = 1 - 0.9
      expect(argMin(e, t + 0.4, t + 0.48).v / steady).toBeGreaterThan(0.95);
    }
  });

  it('1/8 ducks twice per beat, 1/2 only on every second beat', async () => {
    const h8 = await harness(2.4, pumpProject(2));
    h8.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.5, time: 0.01 });
    beats.forEach((t, i) => h8.engine.schedulePump(t, 0.5, i));
    const r8 = await h8.render();
    const e8 = env(r8.L, 0.05, 2.35);
    for (const t of beats) {
      expect(argMin(e8, t - 0.01, t + 0.03).v).toBeLessThan(0.1);
      expect(argMin(e8, t + 0.24, t + 0.28).v).toBeLessThan(0.1);
    }

    const h2 = await harness(2.4, pumpProject(1));
    h2.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.5, time: 0.01 });
    beats.forEach((t, i) => h2.engine.schedulePump(t, 0.5, i));
    const r2 = await h2.render();
    const e2 = env(r2.L, 0.05, 2.35);
    expect(argMin(e2, 0.24, 0.3).v).toBeLessThan(0.1); // beat 0
    expect(argMin(e2, 0.74, 0.8).v).toBeGreaterThan(0.4); // beat 1: no duck
    expect(argMin(e2, 1.24, 1.3).v).toBeLessThan(0.1); // beat 2
    expect(argMin(e2, 1.74, 1.8).v).toBeGreaterThan(0.4); // beat 3: no duck
  });

  it('pump 0 leaves the level alone and transportStopped cancels scheduled ducks', async () => {
    const flat = await harness(1.2, coreProject(120));
    flat.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.5, time: 0.01 });
    [0.25, 0.75].forEach((t, i) => flat.engine.schedulePump(t, 0.5, i));
    const rf = await flat.render();
    const ef = env(rf.L, 0.05, 1.15);
    expect(argMin(ef, 0.05, 1.15).v).toBeGreaterThan(0.499);

    const h = await harness(2.4, pumpProject(0));
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.5, time: 0.01 });
    beats.forEach((t, i) => h.engine.schedulePump(t, 0.5, i));
    h.at(0.9, () => h.engine.transportStopped(0.9));
    const { L } = await h.render();
    const e = env(L, 0.05, 2.35);
    expect(argMin(e, 0.74, 0.8).v).toBeLessThan(0.1); // before the stop
    expect(argMin(e, 1.1, 2.3).v).toBeGreaterThan(0.49); // ducks at 1.25 / 1.75 cancelled
  });
});

describe('Sequencer invalidation', () => {
  it('cancelScheduledAutomation drops pump ducks and clicks scheduled after the cut', async () => {
    const p = coreProject(120);
    p.tracks[2].macros = { ...p.tracks[2].macros, pump: 1 };
    const h = await harness(2, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.4, time: 0.01 });
    [0.25, 0.75, 1.25].forEach((t, i) => h.engine.schedulePump(t, 0.5, i));
    h.engine.scheduleClick(0.5, true);
    h.engine.scheduleClick(1.0, true);
    h.at(0.6, () => {
      h.engine.cancelScheduledAutomation(0.6);
      // The sequencer regenerates its events on the new grid.
      h.engine.schedulePump(1.5, 0.5, 0);
    });
    const { L } = await h.render();
    const e = env(L, 0.05, 1.95);
    expect(argMin(e, 0.24, 0.3).v).toBeLessThan(0.08); // before the cut
    expect(argMin(e, 0.7, 1.45).v).toBeGreaterThan(0.39); // 0.75 / 1.25 dropped
    expect(argMin(e, 1.49, 1.55).v).toBeLessThan(0.08); // regenerated duck
    const click = (t: number) => toneAmp(L, 1600, t + LATENCY, t + LATENCY + 0.03);
    expect(click(0.5)).toBeGreaterThan(0.02);
    expect(click(1.0)).toBeLessThan(1e-4);
  });
});

describe('LFO', () => {
  function tremoloProject(bpm: number, division: number, wave = 0): Project {
    const p = coreProject(bpm);
    p.patch.connections.push(conn('t3:lfo', 'out', 't3:ch', 'level', 1));
    const lfo = moduleParams(p, 't3:lfo');
    lfo.division = division;
    lfo.wave = wave;
    // Motion macro controls LFO depth (0..0.8): 0.625 -> depth 0.5.
    p.tracks[2].macros = { ...p.tracks[2].macros, motion: 0.625 };
    return p;
  }

  for (const c of [
    { bpm: 120, division: 4, label: '1/4 at 120 BPM', period: 0.5 },
    { bpm: 100, division: 5, label: '1/8 at 100 BPM', period: 0.3 },
    { bpm: 90, division: 7, label: '1/4 triplet at 90 BPM', period: (2 / 3) * (60 / 90) },
  ]) {
    it(`tremolo on channel level has the tempo-synced period (${c.label})`, async () => {
      const h = await harness(2.2, tremoloProject(c.bpm, c.division));
      h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.4, time: 0.01 });
      const { L } = await h.render();
      const e = env(L, 0.05, 2.15);
      // Free-running from t = 0 at phase 0: sine minima at phase 0.75.
      for (let k = 0; ; k++) {
        const tk = 0.75 * c.period + k * c.period + LATENCY;
        if (tk > 2.1 - c.period / 4) break;
        if (tk < 0.1) continue;
        const m = argMin(e, tk - c.period / 4, tk + c.period / 4);
        expect(Math.abs(m.t - tk)).toBeLessThan(0.002);
      }
      // Depth 0.5 around unity gain: 0.4 x (1 +/- 0.5).
      const whole = Math.floor(2 / c.period) * c.period;
      const mod = modulation(env(L, 0.1, 0.1 + whole), 1 / c.period);
      expect(mod.depth).toBeCloseTo(0.5, 1);
      expect(mod.mean).toBeCloseTo(0.4, 2);
    });
  }

  it('the connection amount scales and inverts the modulation', async () => {
    const p = tremoloProject(120, 4);
    p.patch.connections[p.patch.connections.length - 1].amount = -1;
    const half = clone(p);
    half.patch.connections[half.patch.connections.length - 1].amount = -0.5;
    const h = await harness(2.2, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.4, time: 0.01 });
    h.at(1.1, () => h.engine.setProject(half));
    const { L } = await h.render();
    // Inverted: minima move to phase 0.25.
    for (const tk of [0.125, 0.625].map((t) => t + LATENCY)) {
      expect(Math.abs(argMin(env(L, 0.05, 1.05), tk - 0.12, tk + 0.12).t - tk)).toBeLessThan(0.002);
    }
    expect(modulation(env(L, 0.05, 1.05), 2).depth).toBeCloseTo(0.5, 1);
    expect(modulation(env(L, 1.2, 2.2), 2).depth).toBeCloseTo(0.25, 1);
  });

  it('transportStarted aligns the LFO phase to the transport tick', async () => {
    const h = await harness(2.2, tremoloProject(120, 4));
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.4, time: 0.01 });
    // At 0.3 s the transport is at tick 48 = half a beat: phase 0.5.
    h.at(0.2, () => h.engine.transportStarted(0.3, 48, 120));
    const { L } = await h.render();
    const e = env(L, 0.35, 2.15);
    for (const tk of [0.425, 0.925, 1.425, 1.925].map((t) => t + LATENCY)) {
      const m = argMin(e, tk - 0.12, tk + 0.12);
      expect(Math.abs(m.t - tk)).toBeLessThan(0.002);
    }
  });

  it('follows tempo changes and keeps its phase across a wave change', async () => {
    const p = tremoloProject(120, 4);
    const tri = clone(p);
    moduleParams(tri, 't3:lfo').wave = 1; // Triangle
    const h = await harness(3.2, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.4, time: 0.01 });
    h.at(0.6, () => h.engine.setProject(tri));
    // At 1.0 s the phase is 0 again; from here one cycle lasts 1 s (60 BPM).
    h.at(0.9, () => h.engine.tempoChanged(60, 1.0));
    const { L } = await h.render();
    const e = env(L, 0.05, 3.15);
    // Sine before 0.6, triangle after: minima stay on phase 0.75.
    for (const tk of [0.375, 0.875, 1.75, 2.75].map((t) => t + LATENCY)) {
      const m = argMin(e, tk - 0.1, tk + 0.1);
      expect(Math.abs(m.t - tk)).toBeLessThan(0.002);
    }
    // No minimum where the old tempo would have put one (0.4 x 0.5 = 0.2 there).
    expect(argMin(e, 1.33, 1.42).v).toBeGreaterThan(0.45);
    // The wave swap is seamless: no jump between consecutive 1 ms cycles.
    let maxStep = 0;
    for (let i = 1; i < e.length; i++) maxStep = Math.max(maxStep, Math.abs(e[i].v - e[i - 1].v));
    expect(maxStep).toBeLessThan(0.02);
  });

  it('Random shape is seeded: same project seed renders identically, another seed differs', async () => {
    async function run(seed: number): Promise<Float32Array> {
      const p = tremoloProject(120, 4, 5);
      p.seed = seed;
      const h = await harness(1.2, p);
      h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.4, time: 0.01 });
      return (await h.render()).L;
    }
    const a = await run(11);
    const b = await run(11);
    const c = await run(12);
    let diffAB = 0;
    let diffAC = 0;
    for (let i = 0; i < a.length; i++) {
      diffAB = Math.max(diffAB, Math.abs(a[i] - b[i]));
      diffAC = Math.max(diffAC, Math.abs(a[i] - c[i]));
    }
    expect(diffAB).toBe(0);
    expect(diffAC).toBeGreaterThan(0.01);
    // Steps: the envelope holds within each 1/16 of the cycle (step 7 of the
    // first cycle spans 0.21875..0.25 s), and moves between steps.
    const step = 0.5 / 16;
    const e = env(a, 7 * step + LATENCY + 0.002, 8 * step + LATENCY - 0.002);
    const spread = Math.max(...e.map((x) => x.v)) - Math.min(...e.map((x) => x.v));
    expect(spread).toBeLessThan(0.005);
    const levels = Array.from({ length: 16 }, (_, k) => env(a, k * step + LATENCY + 0.002, (k + 1) * step + LATENCY - 0.002)[0].v);
    expect(new Set(levels.map((v) => v.toFixed(3))).size).toBeGreaterThan(8);
  });

  it('LFO -> instrument pitch bends by +/-200 cents per full-scale signal', async () => {
    const p = coreProject(120);
    p.patch.connections.push(conn('t3:lfo', 'out', 't3:inst', 'pitch', 1));
    const lfo = moduleParams(p, 't3:lfo');
    lfo.division = 2; // 1 bar = 2 s
    lfo.wave = 4; // Square: +1 for the first half, -1 for the second
    p.tracks[2].macros = { ...p.tracks[2].macros, motion: 0.625 }; // depth 0.5 -> +/-100 cents
    const h = await harness(2.1, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.4, time: 0.01 });
    const { L } = await h.render();
    const up = TONE_HZ * Math.pow(2, 100 / 1200);
    const down = TONE_HZ * Math.pow(2, -100 / 1200);
    expect(toneAmp(L, up, 0.2, 0.8)).toBeCloseTo(0.4, 2);
    expect(toneAmp(L, TONE_HZ, 0.2, 0.8)).toBeLessThan(0.01);
    expect(toneAmp(L, down, 1.2, 1.8)).toBeCloseTo(0.4, 2);
  });
});

describe('Automation and live input', () => {
  it('scheduleParam overrides the project value until the project changes that param', async () => {
    const p = coreProject();
    const renamed = clone(p);
    renamed.tracks[4].name = 'Other';
    moduleParams(renamed, 't5:ch').level = -3;
    const edited = clone(renamed);
    moduleParams(edited, 't3:ch').level = -6;
    const h = await harness(1.6, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.5, time: 0.01 });
    h.engine.scheduleParam('t3:ch', 'level', -12, 0.5);
    h.engine.scheduleParam('t3:ch', 'nonexistent', 1, 0.5);
    h.engine.scheduleParam('nowhere', 'level', 1, 0.5);
    h.at(0.7, () => h.engine.setProject(renamed));
    h.at(1.0, () => h.engine.setProject(edited));
    const { L } = await h.render();
    const db = (t0: number, t1: number) => 20 * Math.log10(toneAmp(L, TONE_HZ, t0, t1) / 0.5);
    expect(db(0.1, 0.45)).toBeCloseTo(0, 1);
    expect(db(0.6, 0.95)).toBeCloseTo(-12, 1); // survives an unrelated project change at 0.7
    expect(db(1.1, 1.5)).toBeCloseTo(-6, 1); // a real edit of the param takes over
  });

  it('scheduleMacro moves mapped targets; cancel and transport stop restore project values', async () => {
    const p = coreProject();
    p.tracks[2].macroMap = { ...p.tracks[2].macroMap, motion: [{ module: 't3:ch', param: 'level', min: -24, max: 0, curve: 'lin' }] };
    p.tracks[2].macros = { ...p.tracks[2].macros, motion: 1 };
    const h = await harness(2.4, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: 0.5, time: 0.01 });
    h.engine.scheduleMacro('t3', 'motion', 0.5, 0.5); // -12 dB
    h.engine.scheduleMacro('t3', 'motion', 0, 1.5); // -24 dB, cancelled below
    h.at(1.0, () => h.engine.cancelScheduledAutomation(1.2));
    h.at(1.8, () => h.engine.transportStopped(1.8));
    const { L } = await h.render();
    const db = (t0: number, t1: number) => 20 * Math.log10(toneAmp(L, TONE_HZ, t0, t1) / 0.5);
    expect(db(0.1, 0.45)).toBeCloseTo(0, 1);
    expect(db(0.6, 1.4)).toBeCloseTo(-12, 1);
    expect(db(1.55, 1.78)).toBeCloseTo(-12, 1); // the 1.5 s point never happened
    expect(db(1.95, 2.35)).toBeCloseTo(0, 1); // project value after stop
  });

  it('live notes: retriggering a key releases the old voice; note off and releaseLive release', async () => {
    const h = await harness(1.4, coreProject());
    const voices: number[] = [];
    h.at(0.1, () => h.engine.liveNoteOn('t3', 69, 0.4, 'KeyA'));
    h.at(0.3, () => {
      h.engine.liveNoteOn('t3', 76, 0.4, 'KeyA'); // same key: replaces
      h.engine.liveNoteOn('t4', 72, 0.4, 'KeyS'); // two tones stay under the limiter ceiling
    });
    h.at(0.4, () => voices.push(h.engine.getStats().voices));
    h.at(0.6, () => h.engine.liveNoteOff('t3', 'KeyA'));
    h.at(0.8, () => voices.push(h.engine.getStats().voices));
    h.at(0.9, () => h.engine.releaseLive());
    h.at(1.2, () => voices.push(h.engine.getStats().voices));
    const { L } = await h.render();
    expect(voices).toEqual([2, 1, 0]);
    expect(toneAmp(L, 440, 0.15, 0.28)).toBeCloseTo(0.4, 2);
    expect(toneAmp(L, 440, 0.35, 0.55)).toBeLessThan(1e-3);
    expect(toneAmp(L, 659.255, 0.35, 0.55)).toBeCloseTo(0.4, 2);
    expect(toneAmp(L, 659.255, 0.65, 0.85)).toBeLessThan(1e-3);
    expect(peak(L, 0.95, 1.4)).toBeLessThan(1e-6);
  });
});
