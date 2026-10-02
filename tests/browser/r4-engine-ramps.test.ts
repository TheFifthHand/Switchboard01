/**
 * Song automation (arrange moves, capability-09): scheduleSongGain on the
 * song-gain stage and scheduleMacroRamp through a part's macro map, measured
 * on rendered audio. Ramps reach their values at t0, half way and t1, own
 * their params until they end (a project edit meanwhile does not move
 * them), and a cancel holds the value reached. The live engine follows the
 * same schedule within the meters' tolerance.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { MeterFrame } from '../../src/audio/contracts';
import { LATENCY, SR, baseProject, clone, coreProject, harness, makeFactory, pitchForHz, toneAmp } from './engine-harness';
import { DRIVE_LATENCY_FRAMES } from '../../src/audio/modules/drive';
import { filterQ } from '../../src/audio/modules/filter';
import type { Project } from '../../src/project/types';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { applyPresetToProject } from '../../src/content/presets';
import { spectralCentroid } from '../../src/render/analysis';

const HZ = 1000;
const TONE = pitchForHz(HZ);
/** Note level: low enough that a hard pan of the stereo voice (×2 on one side) stays under the limiter. */
const VEL = 0.25;

/** Level of the tone (dB re. the note's own level) in a 40 ms window at `t` (output latency included). */
function levelDb(d: Float32Array, t: number): number {
  return 20 * Math.log10(toneAmp(d, HZ, t + LATENCY - 0.02, t + LATENCY + 0.02) / VEL);
}

/**
 * StereoPannerNode on a stereo source (the test instrument copies its voice to
 * both sides): pan −1 puts both sides on the left (L 2, R 0), 0 leaves them
 * (1, 1), +1 puts them on the right (0, 2).
 */
function panGains(p: number): [number, number] {
  if (p <= 0) {
    const x = ((p + 1) * Math.PI) / 2;
    return [1 + Math.cos(x), Math.sin(x)];
  }
  const x = (p * Math.PI) / 2;
  return [Math.cos(x), 1 + Math.sin(x)];
}

/** Track t3 (tone) with Space on its Pan and Echo on its Level, both linear maps. */
function rampProject(): Project {
  const p = coreProject();
  const t3 = p.tracks[2];
  t3.macroMap = {
    ...t3.macroMap,
    space: [{ module: 't3:ch', param: 'pan', min: -1, max: 1, curve: 'lin' }],
    echo: [{ module: 't3:ch', param: 'level', min: -24, max: 0, curve: 'lin' }],
  };
  t3.macros = { ...t3.macros, space: 0.5, echo: 1 };
  return p;
}

describe('song gain', () => {
  it('ramps between its values at t0, half way and t1, steps with a short glide, holds on cancel and on Stop, unity at the next start', async () => {
    const h = await harness(5.6, coreProject());
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 5.5 });
    h.engine.scheduleSongGain(0.5, 1.0, 2.0);
    h.engine.scheduleSongGain(1, 2.6);
    h.engine.scheduleSongGain(0, 3.0, 4.0);
    h.at(3.5, () => h.engine.cancelScheduledAutomation(3.5));
    h.at(4.4, () => h.engine.transportStopped(4.4));
    h.at(4.9, () => h.engine.transportStarted(4.9, 0, 120));
    const { L } = await h.render();
    const lin = (t: number) => Math.pow(10, levelDb(L, t) / 20);
    expect(lin(0.5)).toBeCloseTo(1, 1); // unity before anything
    expect(lin(1.0)).toBeCloseTo(1, 1);
    expect(lin(1.5)).toBeCloseTo(0.75, 2);
    expect(lin(1.98)).toBeCloseTo(0.51, 1);
    expect(lin(2.3)).toBeCloseTo(0.5, 2);
    expect(lin(2.8)).toBeCloseTo(1, 2); // the step, glided over 5 ms
    // The fade from 3.0 to 4.0 was cancelled at 3.5: it holds at half way.
    expect(lin(3.5)).toBeCloseTo(0.5, 1);
    expect(lin(4.0)).toBeCloseTo(0.5, 2);
    expect(lin(4.3)).toBeCloseTo(0.5, 2);
    // Stop holds it (a fade-out's tail stays faded); the next start is at unity.
    expect(lin(4.7)).toBeCloseTo(0.5, 2);
    expect(lin(5.2)).toBeCloseTo(1, 2);
  });

  it('is unity and bit-transparent when unused', async () => {
    const render = async (touch: boolean) => {
      const h = await harness(1, coreProject());
      h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 0.8 });
      // Cancelling with no song automation leaves the stage untouched.
      if (touch) h.at(0.5, () => h.engine.cancelScheduledAutomation(0.5));
      return (await h.render()).L;
    };
    const a = await render(false);
    const b = await render(true);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBe(0);
    expect(levelDb(a, 0.5)).toBeCloseTo(0, 1);
  });
});

describe('macro ramps', () => {
  it('a linear map ramps exactly (Space on Pan), a curved one in fine steps (Echo on Level in dB); both reach their targets', async () => {
    const p = rampProject();
    const h = await harness(4.2, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 4 });
    // Space 0 -> 1 over 1..2 s: Pan −1 -> +1.
    h.engine.scheduleMacroRamp('t3', 'space', 0, 1, 1.0, 2.0);
    // Echo 0 -> 1 over 2.5..3.5 s: Level −24 -> 0 dB.
    h.engine.scheduleMacroRamp('t3', 'echo', 0, 1, 2.5, 3.5);
    const { L, R } = await h.render();
    const amp = (d: Float32Array, t: number) => toneAmp(d, HZ, t + LATENCY - 0.01, t + LATENCY + 0.01) / VEL;
    // Pan −1 at t0, a quarter of the way −0.5, half way 0, t1 +1: the pan follows the ramp linearly.
    for (const [t, pan] of [
      [1.02, -0.96],
      [1.25, -0.5],
      [1.5, 0],
      [1.75, 0.5],
      [2.2, 1],
    ] as const) {
      const [gl, gr] = panGains(pan);
      expect(amp(L, t), `L at ${t}`).toBeCloseTo(gl, 1);
      expect(amp(R, t), `R at ${t}`).toBeCloseTo(gr, 1);
    }
    // Level −24 dB at t0, −12 dB half way, 0 dB at t1 (dB-linear: steps every 10 ms). Pan is +1 now (R × 2).
    const dbR = (t: number) => 20 * Math.log10(amp(R, t) / 2);
    expect(dbR(2.52)).toBeCloseTo(-24 + 0.48, 0);
    expect(dbR(3.0)).toBeCloseTo(-12, 0);
    expect(dbR(3.7)).toBeCloseTo(0, 1);
  });

  it('a curved map on an effect (Tone: the part filter’s cutoff, exponential) follows the ramp in steps', async () => {
    // Default chain inst -> drive -> filter -> channel; Tone 0 -> 0.5 over 1..2 s sweeps the cutoff 260 Hz -> 20 kHz.
    const hz = 4000;
    const p = baseProject();
    const h = await harness(2.6, p);
    h.engine.scheduleNote('t3', { pitch: pitchForHz(hz), velocity: VEL, time: 0.02, duration: 2.5 });
    h.engine.scheduleMacroRamp('t3', 'tone', 0, 0.5, 1.0, 2.0);
    const { L } = await h.render();
    const lat = LATENCY + DRIVE_LATENCY_FRAMES / SR;
    const db = (t: number) => 20 * Math.log10(toneAmp(L, hz, t + lat - 0.01, t + lat + 0.01) / VEL);
    // 12 dB/oct low-pass at the part's Q (Resonance 0.1).
    const q = filterQ(0.1);
    const expected = (cutoff: number) => {
      const r = hz / cutoff;
      return -10 * Math.log10((1 - r * r) ** 2 + (r / q) ** 2);
    };
    const cutoffAt = (t: number) => 260 * Math.pow(20000 / 260, Math.min(1, Math.max(0, t - 1)));
    for (const t of [1.25, 1.5, 1.75]) expect(db(t), `at ${t} s (cutoff ${cutoffAt(t).toFixed(0)} Hz)`).toBeCloseTo(expected(cutoffAt(t)), 0);
    expect(db(1.03)).toBeLessThan(-30);
    expect(db(2.3)).toBeGreaterThan(-0.5);
  });

  it('a ramp on an instrument param (a synth preset’s Tone on its own cutoff): each note starts with the value the ramp has then', async () => {
    const p = baseProject();
    applyPresetToProject(p, 't4', 'poly-lumen-chords');
    p.tracks[3].macros = { ...p.tracks[3].macros, tone: 0, space: 0, echo: 0 };
    const ctx = new OfflineAudioContext(2, Math.round(4 * SR), SR);
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(SR), seed: 3, meters: false });
    engine.setProject(p);
    // Tone 0 -> 1 over 1..3 s.
    engine.scheduleMacroRamp('t4', 'tone', 0, 1, 1.0, 3.0);
    // The dispatcher hands notes over in time order, about a look-ahead before they sound.
    const notes = [0.3, 1.2, 2.0, 3.2];
    for (const t of notes) {
      void ctx.suspend(Math.max(0, Math.round((t - 0.12) * SR) / SR)).then(() => {
        engine.scheduleNote('t4', { pitch: 57, velocity: 0.8, time: t, duration: 0.4 });
        void ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0);
    const centroid = (t: number) => spectralCentroid(L.subarray(Math.round((t + 0.05) * SR), Math.round((t + 0.35) * SR)), SR);
    const c = notes.map(centroid);
    console.info(`[ramps] Tone ramp on a synth's cutoff, note centroids: ${c.map((x) => x.toFixed(0)).join(', ')} Hz`);
    // Each later note is brighter: a note mid-ramp did not start at the ramp's end value.
    for (let k = 1; k < c.length; k++) expect(c[k]).toBeGreaterThan(c[k - 1] * 1.1);
    engine.dispose();
  });

  it('Pump follows a ramp beat by beat (its amount is read when each beat is scheduled)', async () => {
    const p = coreProject();
    p.tracks[2].macroMap = { ...p.tracks[2].macroMap, pump: [{ module: 't3:ch', param: 'pump', min: 0, max: 0.9, curve: 'lin' }] };
    p.tracks[2].macros = { ...p.tracks[2].macros, pump: 0 };
    const h = await harness(3.3, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 3.2 });
    // Pump 0 -> 1 over 0.5..2.5 s; beats every 0.5 s, handed over just ahead like the sequencer does.
    h.engine.scheduleMacroRamp('t3', 'pump', 0, 1, 0.5, 2.5);
    for (let k = 1; k <= 5; k++) h.at(k * 0.5 - 0.1, () => h.engine.schedulePump(k * 0.5, 0.5, k));
    const { L } = await h.render();
    // The deepest point of each duck (a few ms after its beat), relative to the level before the beat.
    const duckDb = (beat: number) => {
      const before = toneAmp(L, HZ, beat + LATENCY - 0.06, beat + LATENCY - 0.02);
      const at = toneAmp(L, HZ, beat + LATENCY + 0.004, beat + LATENCY + 0.024);
      return 20 * Math.log10(at / before);
    };
    const ducks = [1.0, 1.5, 2.0, 2.5].map(duckDb);
    console.info(`[ramps] pump ducks at 1.0/1.5/2.0/2.5 s: ${ducks.map((d) => d.toFixed(1)).join(' / ')} dB`);
    expect(duckDb(0.5)).toBeGreaterThan(-0.5); // amount 0 at the ramp start
    for (let k = 1; k < ducks.length; k++) expect(ducks[k]).toBeLessThan(ducks[k - 1] - 1);
  });

  it('owns its params until it ends: a project edit of the macro meanwhile does not move them', async () => {
    const p = rampProject();
    const edited = clone(p);
    edited.tracks[2].macros = { ...edited.tracks[2].macros, space: 0 };
    const h = await harness(2.6, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 2.5 });
    h.engine.scheduleMacroRamp('t3', 'space', 0, 1, 1.0, 2.0);
    h.at(1.25, () => h.engine.setProject(edited));
    const { L, R } = await h.render();
    const amp = (d: Float32Array, t: number) => toneAmp(d, HZ, t + LATENCY - 0.01, t + LATENCY + 0.01) / VEL;
    // Still on the ramp after the edit (centred half way), at its end at t1.
    expect(amp(L, 1.5)).toBeCloseTo(1, 1);
    expect(amp(R, 1.5)).toBeCloseTo(1, 1);
    expect(amp(R, 2.0)).toBeCloseTo(2, 1);
  });

  it('a cancel during a ramp holds the value it has reached; ramps that had not started are dropped', async () => {
    const p = rampProject();
    const h = await harness(3.2, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 3.1 });
    h.engine.scheduleMacroRamp('t3', 'space', 0, 1, 1.0, 3.0);
    h.engine.scheduleMacroRamp('t3', 'echo', 1, 0, 2.5, 3.0);
    h.at(2.0, () => h.engine.cancelScheduledAutomation(2.0));
    const { L, R } = await h.render();
    const amp = (d: Float32Array, t: number) => toneAmp(d, HZ, t + LATENCY - 0.01, t + LATENCY + 0.01) / VEL;
    // Half way through the pan ramp at the cancel: centred, and it stays there; the Level ramp
    // that had not started never happens (the level stays at 0 dB).
    for (const t of [2.0, 2.4, 2.9]) {
      expect(amp(L, t), `L at ${t}`).toBeCloseTo(1, 1);
      expect(amp(R, t), `R at ${t}`).toBeCloseTo(1, 1);
    }
  });

  it('the live engine follows the same song-gain fade within the meter tolerance', async () => {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    try {
      const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: 1, meters: true, instrumentFactory: makeFactory().factory });
      engine.setProject(coreProject());
      const t = ctx.currentTime + 0.1;
      engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: t, duration: 2 });
      engine.scheduleSongGain(0.25, t + 0.5, t + 1.0);
      const f: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
      const at = async (when: number) => {
        while (ctx.currentTime < when) await new Promise((r) => setTimeout(r, 5));
        engine.readMeters(f);
        return f.masterRms / (VEL * Math.SQRT1_2);
      };
      const before = await at(t + 0.4);
      const after = await at(t + 1.3);
      console.info(`[ramps] live song gain: before ${before.toFixed(3)}, after the fade ${after.toFixed(3)} (offline: 1 and 0.25)`);
      expect(before).toBeGreaterThan(0.9);
      expect(before).toBeLessThan(1.1);
      expect(after).toBeGreaterThan(0.22);
      expect(after).toBeLessThan(0.28);
      engine.dispose();
    } finally {
      await ctx.close();
    }
  });
});
