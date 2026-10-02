/**
 * Song automation (arrange moves, capability-09): scheduleSongGain on the
 * song-gain stage and scheduleMacroRamp through a part's macro map, measured
 * on rendered audio. Ramps reach their values at t0, half way and t1, own
 * their params until they end (a project edit meanwhile does not move
 * them), and a cancel holds the value reached; a ramp re-scheduled after a
 * cancel rejoins without a jump. Stop ends song automation: every target
 * returns to the project's value (the song gain holds until the next start,
 * which can fade in from silence). Curved and dB maps move linearly between
 * points 10 ms apart (no zipper). The live engine follows the same schedules
 * within the meters' tolerance.
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
import { fft, spectralCentroid } from '../../src/render/analysis';

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

  it('after a fade-out and Stop, a new start can fade in from silence: no jump to full level', async () => {
    const h = await harness(4.0, coreProject());
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 3.9 });
    h.engine.transportStarted(0, 0, 120);
    h.engine.scheduleSongGain(0, 0.5, 1.0);
    h.at(1.5, () => h.engine.transportStopped(1.5));
    h.at(2.0, () => {
      h.engine.transportStarted(2.0, 0, 120);
      // A fade-in move: 0 at the start, then up to 1 over a second.
      h.engine.scheduleSongGain(0, 2.0);
      h.engine.scheduleSongGain(1, 2.0, 3.0);
    });
    const { L } = await h.render();
    const lin = (t: number) => toneAmp(L, HZ, t + LATENCY - 0.002, t + LATENCY + 0.002) / VEL;
    let mx = 0;
    for (let i = Math.round((1.99 + LATENCY) * SR); i < Math.round((2.03 + LATENCY) * SR); i++) mx = Math.max(mx, Math.abs(L[i]) / VEL);
    console.info(`[ramps] fade-in after restart: peak 1.99..2.03 s ${mx.toFixed(3)}, at 2.5 ${lin(2.5).toFixed(3)}, 3.2 ${lin(3.2).toFixed(3)}`);
    expect(lin(1.8)).toBeLessThan(0.01);
    expect(mx).toBeLessThan(0.05);
    expect(lin(2.5)).toBeCloseTo(0.5, 1);
    expect(lin(3.2)).toBeCloseTo(1, 1);
  });

  it('resuming a paused fade from the value it had stays there (no jump to unity in between)', async () => {
    const h = await harness(4.0, coreProject());
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 3.9 });
    h.engine.transportStarted(0, 0, 120);
    h.engine.scheduleSongGain(0, 0.5, 1.5);
    h.at(1.0, () => h.engine.transportStopped(1.0));
    h.at(2.0, () => {
      h.engine.transportStarted(2.0, 0, 120);
      h.engine.scheduleSongGain(0.5, 2.0);
      h.engine.scheduleSongGain(0, 2.0, 2.5);
    });
    const { L } = await h.render();
    let mx = 0;
    for (let i = Math.round((1.99 + LATENCY) * SR); i < Math.round((2.03 + LATENCY) * SR); i++) mx = Math.max(mx, Math.abs(L[i]) / VEL);
    const lin = (t: number) => toneAmp(L, HZ, t + LATENCY - 0.002, t + LATENCY + 0.002) / VEL;
    expect(lin(1.5)).toBeCloseTo(0.5, 1); // held over the pause
    expect(mx).toBeLessThan(0.52);
    expect(lin(2.25)).toBeCloseTo(0.25, 1);
    expect(lin(2.8)).toBeLessThan(0.01);
  });
});

describe('macro ramps', () => {
  it('a linear map ramps exactly (Space on Pan), a curved one piecewise linearly every 10 ms (Echo on Level in dB); both reach their targets', async () => {
    const p = rampProject();
    const h = await harness(4.2, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 4 });
    // Space 0 -> 1 over 1..2 s: Pan −1 -> +1.
    h.engine.scheduleMacroRamp('t3', 'space', 0, 1, 1.0, 2.0);
    // Echo 0 -> 1 over 2.5..3.5 s: Level −24 -> 0 dB.
    h.engine.scheduleMacroRamp('t3', 'echo', 0, 1, 2.5, 3.5);
    const { L, R } = await h.render();
    const amp = (d: Float32Array, t: number) => toneAmp(d, HZ, t + LATENCY - 0.01, t + LATENCY + 0.01) / VEL;
    // Pan −1 at t0 (reached within MACRO_RAMP_JOIN: the project had it centred), a quarter of
    // the way −0.5, half way 0, t1 +1: the pan follows the ramp linearly.
    for (const [t, pan] of [
      [1.05, -0.9],
      [1.25, -0.5],
      [1.5, 0],
      [1.75, 0.5],
      [2.2, 1],
    ] as const) {
      const [gl, gr] = panGains(pan);
      expect(amp(L, t), `L at ${t}`).toBeCloseTo(gl, 1);
      expect(amp(R, t), `R at ${t}`).toBeCloseTo(gr, 1);
    }
    // Level −24 dB at t0, −12 dB half way, 0 dB at t1 (dB-linear: points every 10 ms). Pan is +1 now (R × 2).
    const dbR = (t: number) => 20 * Math.log10(amp(R, t) / 2);
    expect(dbR(2.55)).toBeCloseTo(-24 + 1.2, 0); // after the 20 ms join from the project's 0 dB
    expect(dbR(3.0)).toBeCloseTo(-12, 0);
    expect(dbR(3.7)).toBeCloseTo(0, 1);
  });

  it('a curved map on an effect (Tone: the part filter’s cutoff, exponential) follows the ramp', async () => {
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

  it('a dB ramp has no zipper: away from the tone it adds nothing measurable', async () => {
    const render = async (ramp: boolean) => {
      const h = await harness(2.0, rampProject());
      h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 1.9 });
      if (ramp) h.engine.scheduleMacroRamp('t3', 'echo', 1, 0, 1.0, 1.5); // 0 -> −24 dB in 0.5 s
      return (await h.render()).L;
    };
    const ramped = await render(true);
    const steady = await render(false);
    // Energy more than 60 Hz away from the tone, relative to the tone, over the fade.
    const side = (d: Float32Array) => {
      const n = 16384;
      const a = Math.round((1.0 + LATENCY) * SR);
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      for (let i = 0; i < n; i++) re[i] = d[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      fft(re, im);
      let tone = 0;
      let rest = 0;
      for (let k = 1; k < n / 2; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        if (Math.abs((k * SR) / n - HZ) <= 60) tone += p;
        else rest += p;
      }
      return 10 * Math.log10(rest / tone);
    };
    const r = side(ramped);
    const s0 = side(steady);
    console.info(`[ramps] 0 -> −24 dB Level ramp on a 1 kHz tone: energy away from the tone ${r.toFixed(1)} dB (steady tone ${s0.toFixed(1)} dB)`);
    expect(r).toBeLessThan(-65);
  });

  it('a target with a macro window holds until its corner, then moves (no early creep)', async () => {
    const p = coreProject();
    const t3 = p.tracks[2];
    // Level moves only over the upper half of the macro: flat at −24 dB until Echo 0.5.
    t3.macroMap = { ...t3.macroMap, echo: [{ module: 't3:ch', param: 'level', min: -24, max: 0, curve: 'lin', macroFrom: 0.5, macroTo: 1 }] };
    t3.macros = { ...t3.macros, echo: 0 };
    const h = await harness(3.0, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 2.9 });
    h.engine.scheduleMacroRamp('t3', 'echo', 0, 1, 1.0, 2.0);
    const { L } = await h.render();
    // Corner at 1.5 s: −24 dB until then, −12 dB at 1.75, 0 dB at 2.0.
    expect(levelDb(L, 1.3)).toBeCloseTo(-24, 0);
    expect(levelDb(L, 1.45)).toBeCloseTo(-24, 0);
    expect(levelDb(L, 1.75)).toBeCloseTo(-12, 0);
    expect(levelDb(L, 2.3)).toBeCloseTo(0, 0);
  });

  it('a ramp re-scheduled after its cancel time rejoins from where it was held, without a jump', async () => {
    const h = await harness(3.5, rampProject());
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 3.4 });
    h.engine.scheduleMacroRamp('t3', 'space', 0, 1, 1.0, 3.0);
    h.at(1.9, () => h.engine.cancelScheduledAutomation(2.0));
    // The sequencer regenerates late: the ramp is under way again from 2.2 s.
    h.at(2.2, () => h.engine.scheduleMacroRamp('t3', 'space', 0, 1, 1.0, 3.0));
    const { L } = await h.render();
    const amp = (t: number) => toneAmp(L, HZ, t + LATENCY - 0.01, t + LATENCY + 0.01) / VEL;
    // Largest change between half cycles of the tone around the rejoin.
    let worst = 0;
    let prev = -1;
    const half = Math.round(SR / HZ / 2);
    for (let i = Math.round((2.1 + LATENCY) * SR); i + half <= Math.round((2.4 + LATENCY) * SR); i += half) {
      let pk = 0;
      for (let k = i; k < i + half; k++) pk = Math.max(pk, Math.abs(L[k]));
      if (prev > 0) worst = Math.max(worst, Math.abs(20 * Math.log10(pk / prev)));
      prev = pk;
    }
    console.info(`[ramps] rejoin after a cancel: largest half-cycle step ${worst.toFixed(3)} dB`);
    expect(amp(2.1)).toBeCloseTo(1, 1); // held centred
    expect(worst).toBeLessThan(0.1);
    const [gl] = panGains(0.5);
    expect(amp(2.5)).toBeCloseTo(gl, 1); // back on the ramp
  });

  it('Stop mid-ramp returns every target (level, pan, pump, effect and instrument params) to the project value', async () => {
    // Level and Pan on the channel: Echo fades in to the project's 0 dB, Space pans back to the centre.
    {
      const h = await harness(3.0, rampProject());
      h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 2.9 });
      h.engine.transportStarted(0, 0, 120);
      h.engine.scheduleMacroRamp('t3', 'echo', 0, 1, 1.0, 2.0);
      h.engine.scheduleMacroRamp('t3', 'space', 0, 0.5, 1.0, 2.0);
      h.at(1.5, () => h.engine.transportStopped(1.5));
      const { L, R } = await h.render();
      const amp = (d: Float32Array, t: number) => toneAmp(d, HZ, t + LATENCY - 0.01, t + LATENCY + 0.01) / VEL;
      // Mid-ramp at the stop (−12 dB, half way left); the project's values after it.
      expect(20 * Math.log10(amp(L, 1.45) / panGains(-0.55)[0])).toBeCloseTo(-13.2, 0);
      for (const t of [1.7, 2.5]) {
        expect(levelDb(L, t), `level at ${t}`).toBeCloseTo(0, 1);
        expect(amp(R, t), `R at ${t}`).toBeCloseTo(1, 1);
      }
      // A glide back, not a click.
      let worst = 0;
      let prev = -1;
      const half = Math.round(SR / HZ / 2);
      for (let i = Math.round((1.45 + LATENCY) * SR); i + half <= Math.round((1.8 + LATENCY) * SR); i += half) {
        let pk = 0;
        for (let k = i; k < i + half; k++) pk = Math.max(pk, Math.abs(L[k]));
        if (prev > 0) worst = Math.max(worst, Math.abs(20 * Math.log10(pk / prev)));
        prev = pk;
      }
      expect(worst).toBeLessThan(1.5);
    }
    // Pump: the ramp's amounts end with the take; after Stop and Play the project's Pump 0 ducks nothing.
    {
      const p = coreProject();
      p.tracks[2].macroMap = { ...p.tracks[2].macroMap, pump: [{ module: 't3:ch', param: 'pump', min: 0, max: 0.9, curve: 'lin' }] };
      p.tracks[2].macros = { ...p.tracks[2].macros, pump: 0 };
      const h = await harness(4.0, p);
      h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.02, duration: 3.9 });
      h.engine.transportStarted(0, 0, 120);
      h.engine.scheduleMacroRamp('t3', 'pump', 0, 1, 0.5, 2.5);
      for (let k = 1; k <= 2; k++) h.at(k * 0.5 - 0.1, () => h.engine.schedulePump(k * 0.5, 0.5, k));
      h.at(1.3, () => h.engine.transportStopped(1.3));
      h.at(2.0, () => h.engine.transportStarted(2.0, 0, 120));
      for (let k = 5; k <= 7; k++) h.at(k * 0.5 - 0.1, () => h.engine.schedulePump(k * 0.5, 0.5, k));
      const { L } = await h.render();
      const duck = (beat: number) => 20 * Math.log10(toneAmp(L, HZ, beat + LATENCY + 0.004, beat + LATENCY + 0.024) / toneAmp(L, HZ, beat + LATENCY - 0.06, beat + LATENCY - 0.02));
      expect(duck(1.0)).toBeLessThan(-1); // during the ramp
      for (const b of [2.5, 3.0, 3.5]) expect(Math.abs(duck(b)), `duck at ${b}`).toBeLessThan(0.2);
    }
    // An effect param (Tone on the part filter's cutoff) and an instrument param (a synth's own Tone).
    {
      const p = baseProject();
      applyPresetToProject(p, 't4', 'poly-lumen-chords');
      p.tracks[3].macros = { ...p.tracks[3].macros, tone: 0, space: 0, echo: 0 };
      const ctx = new OfflineAudioContext(2, Math.round(4 * SR), SR);
      const engine = await AudioEngine.create(ctx, { samples: new SampleBank(SR), seed: 3, meters: false });
      engine.setProject(p);
      engine.transportStarted(0, 0, 120);
      engine.scheduleMacroRamp('t4', 'tone', 0, 1, 1.0, 3.0);
      const notes = [0.3, 1.5, 2.5];
      void ctx.suspend(1.6).then(() => {
        engine.transportStopped(1.6);
        void ctx.resume();
      });
      for (const t of notes) {
        void ctx.suspend(Math.round((t - 0.12) * SR) / SR).then(() => {
          engine.scheduleNote('t4', { pitch: 57, velocity: 0.8, time: t, duration: 0.4 });
          void ctx.resume();
        });
      }
      const buf = await ctx.startRendering();
      const L = buf.getChannelData(0);
      const c = notes.map((t) => spectralCentroid(L.subarray(Math.round((t + 0.05) * SR), Math.round((t + 0.35) * SR)), SR));
      console.info(`[ramps] Tone ramp stopped at 1.6 s: note centroids ${c.map((x) => x.toFixed(0)).join(', ')} Hz`);
      expect(c[1]).toBeGreaterThan(c[0] * 1.1); // mid-ramp brighter
      expect(Math.abs(c[2] - c[0]) / c[0]).toBeLessThan(0.03); // after Stop: the project's sound again
      engine.dispose();
    }
  });

  it('the live engine follows a macro ramp (Echo on Level in dB) like the offline render, within the meter tolerance', async () => {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    try {
      const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: 1, meters: true, instrumentFactory: makeFactory().factory });
      engine.setProject(rampProject());
      const t = ctx.currentTime + 0.1;
      engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: t, duration: 2 });
      // Echo 1 -> 0: Level 0 -> −24 dB over 0.5 s.
      engine.scheduleMacroRamp('t3', 'echo', 1, 0, t + 0.5, t + 1.0);
      const f: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
      const at = async (when: number): Promise<{ db: number; time: number }> => {
        while (ctx.currentTime < when) await new Promise((r) => setTimeout(r, 2));
        engine.readMeters(f);
        return { db: 20 * Math.log10(f.masterRms / (VEL * Math.SQRT1_2)), time: ctx.currentTime };
      };
      // The meter reads the last ~21 ms of output, which lags by the limiter's look-ahead.
      const expected = (time: number) => {
        const x = Math.min(1, Math.max(0, (time - 0.0107 - LATENCY - (t + 0.5)) / 0.5));
        return -24 * x;
      };
      const before = await at(t + 0.4);
      const mid = await at(t + 0.75);
      const after = await at(t + 1.3);
      console.info(`[ramps] live Level ramp: ${before.db.toFixed(1)} / ${mid.db.toFixed(1)} (expected ${expected(mid.time).toFixed(1)}) / ${after.db.toFixed(1)} dB (offline: 0, −12, −24)`);
      expect(Math.abs(before.db)).toBeLessThan(0.5);
      expect(Math.abs(mid.db - expected(mid.time))).toBeLessThan(2);
      expect(Math.abs(after.db + 24)).toBeLessThan(0.5);
      engine.dispose();
    } finally {
      await ctx.close();
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
