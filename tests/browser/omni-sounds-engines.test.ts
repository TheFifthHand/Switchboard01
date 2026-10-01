/**
 * The synth voice features behind the extended sound library, rendered on a
 * real OfflineAudioContext in Chromium and measured: FM sidebands, ratio and
 * decay; Unison level, stereo spread and phase-offset start; pitch sweep;
 * noise colour; drift (and that it repeats exactly); vibrato with its
 * fade-in; live control changes; the poly voice budget; the bass synth's
 * sub shape, unison, FM and sweep (not on legato notes); every voice freed;
 * and the processing cost of the heaviest settings.
 */
import { describe, expect, it } from 'vitest';
import type { InstrumentContext, InstrumentEngine } from '../../src/audio/contracts';
import { MonoSynthEngine } from '../../src/audio/instruments/monoSynth';
import { POLY_MAX_VOICES, POLY_MIN_VOICES, PolySynthEngine, polyVoiceLimit } from '../../src/audio/instruments/polySynth';
import { UNISON_PHASES, phasedOscillator } from '../../src/audio/instruments/synthParts';
import { midiToHz } from '../../src/audio/instruments/voice';
import { BASS_PARAMS, POLY_PARAMS, defaultParams } from '../../src/project/params';
import { Rng } from '../../src/project/rng';
import type { BassInstrument, PolyInstrument } from '../../src/project/types';

const SR = 48000;
const idx = (t: number) => Math.round(t * SR);

function makeIctx(ctx: BaseAudioContext): InstrumentContext {
  const noise = ctx.createBuffer(1, SR * 2, SR);
  const d = noise.getChannelData(0);
  const rng = new Rng(99);
  for (let i = 0; i < d.length; i++) d[i] = rng.noise();
  return { ctx, samples: { get: () => null }, noise, getBpm: () => 120 };
}

const poly = (p: Record<string, number> = {}): PolyInstrument => ({ kind: 'poly', presetId: 'test', params: { ...defaultParams(POLY_PARAMS), ...p } });
const bass = (p: Record<string, number> = {}): BassInstrument => ({ kind: 'bass', presetId: 'test', params: { ...defaultParams(BASS_PARAMS), ...p } });

/** A single clean sine voice on the poly synth. */
const SINE_POLY = { osc1Wave: 3, osc2Level: 0, noise: 0, filterEnv: 0, cutoff: 18000, resonance: 0, width: 0, velocity: 0, sustain: 1, attack: 0.002 };
/** A clean sine bass: no sub, no drive, open filter. */
const SINE_BASS = { wave: 3, sub: 0, drive: 0, envAmount: 0, cutoff: 12000, resonance: 0, sustain: 1, velocity: 0 };

async function render<E extends InstrumentEngine>(
  seconds: number,
  make: (ictx: InstrumentContext) => E,
  schedule: (engine: E, at: (time: number, fn: () => void) => void) => void,
): Promise<{ L: Float32Array; R: Float32Array; engine: E; ms: number }> {
  const ctx = new OfflineAudioContext(2, idx(seconds), SR);
  const engine = make(makeIctx(ctx));
  engine.output.connect(ctx.destination);
  const at = (time: number, fn: () => void) => {
    void ctx.suspend(time).then(() => {
      fn();
      void ctx.resume();
    });
  };
  schedule(engine, at);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 20));
  return { L: buf.getChannelData(0).slice(), R: buf.getChannelData(1).slice(), engine, ms };
}

const polyNote = (inst: PolyInstrument, pitch: number, seconds = 1.2, velocity = 1, duration = seconds - 0.3) =>
  render(seconds + 0.6, (i) => new PolySynthEngine(i, inst), (e) => void e.trigger({ pitch, velocity, time: 0.05, duration }));

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}
function peak(x: Float32Array, a = 0, b = x.length): number {
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

/** Amplitude of the component at f Hz in [a, b) (Hann-windowed single-bin DFT). */
function toneAmp(x: Float32Array, a: number, b: number, f: number): number {
  const n = b - a;
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const ph = (2 * Math.PI * f * i) / SR;
    re += w * x[a + i] * Math.cos(ph);
    im -= w * x[a + i] * Math.sin(ph);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

/** Fundamental from interpolated rising zero crossings in [a, b). */
function zcFreq(x: Float32Array, a: number, b: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      last = t;
      count++;
    }
  }
  return count > 1 ? ((count - 1) * SR) / (last - first) : 0;
}

/** Instantaneous frequencies (Hz) between successive rising zero crossings in [a, b). */
function periodFreqs(x: Float32Array, a: number, b: number): number[] {
  const crossings: number[] = [];
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  return crossings.slice(1).map((c, k) => SR / (c - crossings[k]));
}

/** Power-weighted mean frequency over [a, a + n) using single-bin DFTs on a coarse grid. */
function centroid(x: Float32Array, a: number, n: number, maxHz = 12000): number {
  let num = 0;
  let den = 0;
  for (let f = 50; f <= maxHz; f *= 1.06) {
    const amp = toneAmp(x, a, a + n, f);
    num += amp * amp * f;
    den += amp * amp;
  }
  return num / den;
}

function correlation(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = from; i < to; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb + 1e-30);
}

/* ------------------------------------------------------------------ */
/* FM                                                                  */
/* ------------------------------------------------------------------ */

describe('FM on the poly synth', () => {
  const f = midiToHz(57); // 220 Hz

  it('adds harmonic sidebands at whole-number ratios and inharmonic ones at in-between ratios', async () => {
    const clean = await polyNote(poly(SINE_POLY), 57);
    const harmonic = await polyNote(poly({ ...SINE_POLY, fmAmount: 0.5, fmRatio: 1, fmDecay: 8 }), 57);
    const bell = await polyNote(poly({ ...SINE_POLY, fmAmount: 0.5, fmRatio: 3.5, fmDecay: 8 }), 57);
    const [a, b] = [idx(0.3), idx(0.8)];
    const rel = (r: { L: Float32Array }, hz: number) => db(toneAmp(r.L, a, b, hz) / toneAmp(r.L, a, b, f));
    // A clean sine has no second harmonic; ratio 1 FM creates strong ones.
    expect(rel(clean, 2 * f)).toBeLessThan(-50);
    expect(rel(harmonic, 2 * f)).toBeGreaterThan(-15);
    expect(rel(harmonic, 3 * f)).toBeGreaterThan(-30);
    // Ratio 3.5: sidebands at |1 - 3.5| f = 2.5 f and 4.5 f, nothing at 2 f.
    expect(db(toneAmp(bell.L, a, b, 2.5 * f) / toneAmp(bell.L, a, b, 2 * f))).toBeGreaterThan(20);
    expect(db(toneAmp(bell.L, a, b, 4.5 * f) / toneAmp(bell.L, a, b, 2 * f))).toBeGreaterThan(20);
    // Whole-number FM stays in tune: nothing between the harmonics.
    expect(db(toneAmp(harmonic.L, a, b, 1.5 * f) / toneAmp(harmonic.L, a, b, 2 * f))).toBeLessThan(-40);
  });

  it('the FM strike decays (bright, then mellow) and follows velocity', async () => {
    const inst = poly({ ...SINE_POLY, fmAmount: 0.6, fmRatio: 1, fmDecay: 0.2, velocity: 1 });
    const hard = await polyNote(inst, 57, 1.4, 1);
    const soft = await polyNote(inst, 57, 1.4, 0.3);
    const early = centroid(hard.L, idx(0.06), 4096);
    const late = centroid(hard.L, idx(1.0), 4096);
    expect(early).toBeGreaterThan(late * 1.5);
    expect(late).toBeLessThan(f * 1.6);
    // A soft note barks less: weaker second harmonic relative to the fundamental.
    const h2 = (r: { L: Float32Array }) => toneAmp(r.L, idx(0.06), idx(0.16), 2 * f) / toneAmp(r.L, idx(0.06), idx(0.16), f);
    expect(h2(soft)).toBeLessThan(h2(hard) * 0.6);
  });

  it('FM Amount and FM Ratio follow the knob on a sounding note (smoothly)', async () => {
    const inst = poly({ ...SINE_POLY, fmAmount: 0.15, fmRatio: 1, fmDecay: 8 });
    const louder = { ...inst, params: { ...inst.params, fmAmount: 0.6 } };
    const moved = await render(1.6, (i) => new PolySynthEngine(i, inst), (e, at) => {
      e.trigger({ pitch: 57, velocity: 1, time: 0.05, duration: 1.3 });
      at(0.6, () => e.update(louder, 0.6));
    });
    const still = await polyNote(inst, 57, 1.3);
    const h2 = (x: Float32Array, a: number) => toneAmp(x, idx(a), idx(a + 0.25), 2 * f) / toneAmp(x, idx(a), idx(a + 0.25), f);
    expect(h2(moved.L, 0.3)).toBeCloseTo(h2(still.L, 0.3), 3);
    expect(h2(moved.L, 0.9)).toBeGreaterThan(h2(still.L, 0.9) * 3);
    // No click at the change: the largest sample step stays at the tone's own scale.
    let step = 0;
    for (let i = idx(0.59); i < idx(0.7); i++) step = Math.max(step, Math.abs(moved.L[i] - moved.L[i - 1]));
    expect(step).toBeLessThan(0.08);
  });
});

/* ------------------------------------------------------------------ */
/* Unison                                                              */
/* ------------------------------------------------------------------ */

describe('Unison on the poly synth', () => {
  const SAW = { osc1Wave: 0, osc2Level: 0, noise: 0, filterEnv: 0, cutoff: 18000, resonance: 0, velocity: 0, sustain: 1, attack: 0.002 };

  it('a phase-offset copy is the plain wave shifted in time (same shape, same level)', async () => {
    const phase = UNISON_PHASES[1];
    // A pitch where the phase offset is a whole number of samples (82), so the comparison needs no interpolation.
    const hz = (phase * SR) / 82;
    const ctx = new OfflineAudioContext(2, SR, SR);
    const shifted = phasedOscillator(ctx, 0, phase, hz, 0);
    const plain = phasedOscillator(ctx, 0, 0, hz, 0);
    const merger = ctx.createChannelMerger(2);
    shifted.connect(merger, 0, 0);
    plain.connect(merger, 0, 1);
    merger.connect(ctx.destination);
    shifted.start(0);
    plain.start(0);
    const buf = await ctx.startRendering();
    const a = buf.getChannelData(0);
    const b = buf.getChannelData(1);
    // shifted(t) = plain(t + phase / hz), i.e. 82 samples ahead (the residue is band-limiting detail at the saw's edge).
    let diff = 0;
    for (let i = 2000; i < 20000; i++) diff += (a[i] - b[i + 82]) ** 2;
    expect(Math.sqrt(diff / 18000) / rms(b, 2000, 20000)).toBeLessThan(0.03);
    expect(rms(a, 2000, 20000)).toBeCloseTo(rms(b, 2000, 20000), 3);
  });

  it('seven copies keep the level of one, start without a coherent spike, and spread across the stereo field', async () => {
    const one = await polyNote(poly({ ...SAW, unison: 1, width: 1 }), 57, 1.5);
    const seven = await polyNote(poly({ ...SAW, unison: 7, unisonDetune: 25, width: 1 }), 57, 1.5);
    const sevenMono = await polyNote(poly({ ...SAW, unison: 7, unisonDetune: 25, width: 0 }), 57, 1.5);
    const level = (r: { L: Float32Array; R: Float32Array }) => db(Math.hypot(rms(r.L, idx(0.3), idx(1.2)), rms(r.R, idx(0.3), idx(1.2))));
    expect(Math.abs(level(seven) - level(one))).toBeLessThan(1.5);
    // Phase-offset copies: the first 30 ms are no hotter than the steady sound (in-phase copies would spike to ~2.6x).
    const onset = Math.max(peak(seven.L, 0, idx(0.08)), peak(seven.R, 0, idx(0.08)));
    const steady = Math.max(peak(seven.L, idx(0.3), idx(1.2)), peak(seven.R, idx(0.3), idx(1.2)));
    expect(onset).toBeLessThan(steady * 1.35);
    // Width spreads the stack: left and right differ (one oscillator panned is still fully correlated).
    expect(correlation(seven.L, seven.R, idx(0.3), idx(1.2))).toBeLessThan(0.75);
    expect(correlation(one.L, one.R, idx(0.3), idx(1.2))).toBeGreaterThan(0.99);
    // At width 0 the stack is centred.
    let side = 0;
    for (let i = idx(0.3); i < idx(1.2); i++) side = Math.max(side, Math.abs(sevenMono.L[i] - sevenMono.R[i]));
    expect(side).toBeLessThan(1e-6);
  });

  it('Unison Detune spreads the copies in pitch (and follows the knob on a sounding note)', async () => {
    const tight = await polyNote(poly({ ...SAW, unison: 3, unisonDetune: 0, width: 0 }), 57, 2.2);
    const wide = await polyNote(poly({ ...SAW, unison: 3, unisonDetune: 30, width: 0 }), 57, 2.2);
    // Detuned copies beat: the level of the fundamental swings over time; in tune it is steady.
    const swing = (x: Float32Array) => {
      const levels: number[] = [];
      for (let t = 0.3; t < 1.8; t += 0.05) levels.push(toneAmp(x, idx(t), idx(t + 0.05), midiToHz(57)));
      return db(Math.max(...levels) / Math.min(...levels));
    };
    expect(swing(tight.L)).toBeLessThan(1);
    expect(swing(wide.L)).toBeGreaterThan(6);
    const inst = poly({ ...SAW, unison: 3, unisonDetune: 0, width: 0 });
    const moved = await render(2.4, (i) => new PolySynthEngine(i, inst), (e, at) => {
      e.trigger({ pitch: 57, velocity: 1, time: 0.05, duration: 2 });
      at(0.8, () => e.update({ ...inst, params: { ...inst.params, unisonDetune: 30 } }, 0.8));
    });
    const s = (x: Float32Array, a: number, b: number) => {
      const levels: number[] = [];
      for (let t = a; t < b; t += 0.05) levels.push(toneAmp(x, idx(t), idx(t + 0.05), midiToHz(57)));
      return db(Math.max(...levels) / Math.min(...levels));
    };
    expect(s(moved.L, 0.3, 0.75)).toBeLessThan(1);
    expect(s(moved.L, 0.9, 2.0)).toBeGreaterThan(6);
  });

  it('heavy sounds play fewer notes at once (never fewer than 6), and every voice is freed', async () => {
    expect(polyVoiceLimit({ unison: 1, fmAmount: 0, vibrato: 0, pitchEnv: 0 })).toBe(POLY_MAX_VOICES);
    expect(polyVoiceLimit({ unison: 4, fmAmount: 0, vibrato: 0, pitchEnv: 0 })).toBe(POLY_MAX_VOICES);
    expect(polyVoiceLimit({ unison: 7, fmAmount: 0, vibrato: 0, pitchEnv: 0 })).toBe(8);
    const heavy = { unison: 7, fmAmount: 0.5, vibrato: 0.2, pitchEnv: 2 };
    expect(polyVoiceLimit(heavy)).toBe(POLY_MIN_VOICES);
    const inst = poly({ ...SAW, ...heavy, release: 0.05 });
    let sounding = 0;
    const r = await render(1.6, (i) => new PolySynthEngine(i, inst), (e, at) => {
      for (let k = 0; k < 10; k++) e.trigger({ pitch: 48 + k * 3, velocity: 0.8, time: 0.05 + k * 0.02, duration: 0.6 });
      at(0.4, () => {
        sounding = e.activeVoices();
      });
    });
    expect(sounding).toBeLessThanOrEqual(POLY_MIN_VOICES + 1);
    expect(r.engine.activeVoices()).toBe(0);
    expect(peak(r.L)).toBeLessThan(1);
  });
});

/* ------------------------------------------------------------------ */
/* Pitch sweep, noise colour, drift, vibrato                           */
/* ------------------------------------------------------------------ */

describe('pitch sweep, noise colour, drift and vibrato', () => {
  const f = midiToHz(57);

  it('Pitch Sweep starts above (or below) the note and lands on it', async () => {
    const up = await polyNote(poly({ ...SINE_POLY, pitchEnv: 12, pitchDecay: 0.15 }), 57);
    const down = await polyNote(poly({ ...SINE_POLY, pitchEnv: -12, pitchDecay: 0.15 }), 57);
    expect(zcFreq(up.L, idx(0.055), idx(0.075)) / f).toBeGreaterThan(1.6);
    expect(zcFreq(down.L, idx(0.055), idx(0.085)) / f).toBeLessThan(0.65);
    for (const r of [up, down]) expect(Math.abs(zcFreq(r.L, idx(0.5), idx(0.8)) / f - 1)).toBeLessThan(0.003);
  });

  it('Noise Colour makes the noise darker or brighter at a similar level', async () => {
    const noisy = (c: number) => polyNote(poly({ ...SINE_POLY, osc1Wave: 3, noise: 1, noiseColor: c, cutoff: 18000 }), 21);
    const dark = await noisy(0.1);
    const white = await noisy(0.5);
    const bright = await noisy(0.9);
    const cen = (r: { L: Float32Array }) => centroid(r.L, idx(0.3), 8192, 16000);
    expect(cen(dark)).toBeLessThan(cen(white) * 0.5);
    expect(cen(bright)).toBeGreaterThan(cen(white) * 1.2);
    const lvl = (r: { L: Float32Array }) => db(rms(r.L, idx(0.3), idx(0.9)));
    for (const r of [dark, bright]) expect(Math.abs(lvl(r) - lvl(white))).toBeLessThan(8);
  });

  it('Drift detunes each note a little differently, and the same render repeats exactly', async () => {
    const inst = poly({ ...SINE_POLY, drift: 1 });
    const play = (e: PolySynthEngine) => {
      e.trigger({ pitch: 69, velocity: 1, time: 0.05, duration: 0.5 });
      e.trigger({ pitch: 69, velocity: 1, time: 0.75, duration: 0.5 });
    };
    const a = await render(1.6, (i) => new PolySynthEngine(i, inst), (e) => play(e));
    const b = await render(1.6, (i) => new PolySynthEngine(i, inst), (e) => play(e));
    const cents = (hz: number) => 1200 * Math.log2(hz / 440);
    const n1 = cents(zcFreq(a.L, idx(0.15), idx(0.5)));
    const n2 = cents(zcFreq(a.L, idx(0.85), idx(1.2)));
    expect(Math.abs(n1 - n2)).toBeGreaterThan(0.5);
    expect(Math.abs(n1)).toBeLessThanOrEqual(10.5);
    expect(Math.abs(n2)).toBeLessThanOrEqual(10.5);
    let d = 0;
    for (let i = 0; i < a.L.length; i++) d = Math.max(d, Math.abs(a.L[i] - b.L[i]));
    expect(d).toBeLessThan(1e-6);
    // Drift 0: perfectly in tune.
    const clean = await polyNote(poly(SINE_POLY), 69, 0.8);
    expect(Math.abs(cents(zcFreq(clean.L, idx(0.15), idx(0.6))))).toBeLessThan(0.2);
  });

  it('Vibrato fades in, then wobbles the pitch at its speed and depth', async () => {
    const r = await polyNote(poly({ ...SINE_POLY, vibrato: 1, vibratoRate: 5 }), 69, 2);
    const cents = (hz: number) => 1200 * Math.log2(hz / 440);
    const early = periodFreqs(r.L, idx(0.055), idx(0.1)).map(cents);
    const late = periodFreqs(r.L, idx(0.8), idx(1.6)).map(cents);
    expect(Math.max(...early.map(Math.abs))).toBeLessThan(12);
    // ±50 cents at full depth (period-averaging trims the extremes a little).
    expect(Math.max(...late)).toBeGreaterThan(35);
    expect(Math.min(...late)).toBeLessThan(-35);
    // Five wobbles per second: count upward crossings of the centre over 0.8 s.
    let ups = 0;
    for (let k = 1; k < late.length; k++) if (late[k - 1] < 0 && late[k] >= 0) ups++;
    expect(ups).toBeGreaterThanOrEqual(3);
    expect(ups).toBeLessThanOrEqual(5);
  });
});

/* ------------------------------------------------------------------ */
/* Bass synth                                                          */
/* ------------------------------------------------------------------ */

describe('bass synth features', () => {
  const bassNote = (inst: BassInstrument, pitch = 45, seconds = 1.2) =>
    render(seconds + 0.4, (i) => new MonoSynthEngine(i, inst), (e) => void e.trigger({ pitch, velocity: 1, time: 0.05, duration: seconds - 0.3 }));

  it('Sub Shape: a sine sub is a pure tone an octave down; the square sub has odd harmonics', async () => {
    const f = midiToHz(45);
    const square = await bassNote(bass({ ...SINE_BASS, sub: 1, subWave: 0 }));
    const sine = await bassNote(bass({ ...SINE_BASS, sub: 1, subWave: 1 }));
    const [a, b] = [idx(0.3), idx(0.8)];
    expect(toneAmp(sine.L, a, b, f / 2)).toBeGreaterThan(0.05);
    expect(db(toneAmp(square.L, a, b, 1.5 * f) / toneAmp(square.L, a, b, f / 2))).toBeGreaterThan(-15);
    expect(db(toneAmp(sine.L, a, b, 1.5 * f) / toneAmp(sine.L, a, b, f / 2))).toBeLessThan(-40);
  });

  it('Unison Detune thickens the bass (beating) at the same level', async () => {
    const plain = await bassNote(bass({ wave: 0, sub: 0, drive: 0, sustain: 1, cutoff: 3000, envAmount: 0 }), 45, 2);
    const reese = await bassNote(bass({ wave: 0, sub: 0, drive: 0, sustain: 1, cutoff: 3000, envAmount: 0, unisonDetune: 20 }), 45, 2);
    const f = midiToHz(45);
    const swing = (x: Float32Array) => {
      const levels: number[] = [];
      for (let t = 0.3; t < 1.6; t += 0.05) levels.push(toneAmp(x, idx(t), idx(t + 0.05), 2 * f));
      return db(Math.max(...levels) / Math.min(...levels));
    };
    expect(swing(plain.L)).toBeLessThan(1);
    expect(swing(reese.L)).toBeGreaterThan(6);
    expect(Math.abs(db(rms(reese.L, idx(0.3), idx(1.6))) - db(rms(plain.L, idx(0.3), idx(1.6))))).toBeLessThan(2);
  });

  it('FM adds harmonics to the bass; Pitch Sweep drops into each new note but not into a legato one', async () => {
    const f = midiToHz(45);
    const fm = await bassNote(bass({ ...SINE_BASS, fmAmount: 0.5, fmRatio: 1, fmDecay: 8 }));
    const clean = await bassNote(bass(SINE_BASS));
    const h2 = (x: Float32Array) => toneAmp(x, idx(0.3), idx(0.8), 2 * f) / toneAmp(x, idx(0.3), idx(0.8), f);
    expect(h2(fm.L)).toBeGreaterThan(h2(clean.L) * 20);
    const inst = bass({ ...SINE_BASS, pitchEnv: 12, pitchDecay: 0.1, glide: 0 });
    const r = await render(1.6, (i) => new MonoSynthEngine(i, inst), (e) => {
      e.trigger({ pitch: 45, velocity: 1, time: 0.05, duration: 0.6 });
      e.trigger({ pitch: 45, velocity: 1, time: 0.6, duration: 0.6, legato: true });
    });
    expect(zcFreq(r.L, idx(0.055), idx(0.08)) / f).toBeGreaterThan(1.5);
    // The legato note continues at pitch: no new sweep.
    expect(Math.abs(zcFreq(r.L, idx(0.62), idx(0.7)) / f - 1)).toBeLessThan(0.01);
    expect(r.engine.activeVoices()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

describe('determinism', () => {
  it('every feature together renders identically twice (poly and bass)', async () => {
    const inst = poly({ unison: 5, unisonDetune: 22, fmAmount: 0.4, fmRatio: 3.5, noise: 0.4, noiseColor: 0.8, pitchEnv: -3, vibrato: 0.3, drift: 0.7, width: 0.8 });
    const play = (e: PolySynthEngine) => {
      for (const [k, p] of [57, 61, 64, 69].entries()) e.trigger({ pitch: p, velocity: 0.7 + k * 0.05, time: 0.05 + k * 0.11, duration: 0.8 });
    };
    const a = await render(1.8, (i) => new PolySynthEngine(i, inst), (e) => play(e));
    const b = await render(1.8, (i) => new PolySynthEngine(i, inst), (e) => play(e));
    const bassInst = bass({ unisonDetune: 15, fmAmount: 0.4, subWave: 1, pitchEnv: 7, glide: 0.05 });
    const line = (e: MonoSynthEngine) => {
      e.trigger({ pitch: 40, velocity: 0.9, time: 0.05, duration: 0.3 });
      e.trigger({ pitch: 47, velocity: 0.8, time: 0.3, duration: 0.3, legato: true });
      e.trigger({ pitch: 45, velocity: 0.8, time: 0.7, duration: 0.3 });
    };
    const c = await render(1.4, (i) => new MonoSynthEngine(i, bassInst), (e) => line(e));
    const d = await render(1.4, (i) => new MonoSynthEngine(i, bassInst), (e) => line(e));
    for (const [x, y] of [
      [a, b],
      [c, d],
    ] as const) {
      let diff = 0;
      for (let i = 0; i < x.L.length; i++) diff = Math.max(diff, Math.abs(x.L[i] - y.L[i]), Math.abs(x.R[i] - y.R[i]));
      expect(diff).toBeLessThan(1e-6);
      expect(peak(x.L)).toBeGreaterThan(0.01);
      expect(x.engine.activeVoices()).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Processing cost                                                     */
/* ------------------------------------------------------------------ */

describe('processing cost', () => {
  it('the heaviest sounds render far faster than real time at their voice limit', async () => {
    const chord = (e: PolySynthEngine, n: number) => {
      for (let k = 0; k < n; k++) e.trigger({ pitch: 48 + k * 4, velocity: 0.8, time: 0.02, duration: 3.5 });
    };
    const cases: [string, PolyInstrument][] = [
      ['plain two-oscillator voices', poly({})],
      ['Unison 7 (supersaw)', poly({ unison: 7, unisonDetune: 25 })],
      ['Unison 7 + FM + vibrato + sweep', poly({ unison: 7, fmAmount: 0.5, vibrato: 0.2, pitchEnv: 2 })],
      ['FM + noise colour + vibrato', poly({ fmAmount: 0.5, noise: 0.5, noiseColor: 0.8, vibrato: 0.3 })],
    ];
    const report: string[] = [];
    for (const [name, inst] of cases) {
      const engine = (i: InstrumentContext) => new PolySynthEngine(i, inst);
      // Warm-up render (JIT, periodic waves), then the measured one.
      await render(0.5, engine, (e) => chord(e, 4));
      let limit = 0;
      const r = await render(4, engine, (e) => {
        limit = e.voiceLimit();
        chord(e, limit);
      });
      const share = r.ms / 4000;
      report.push(`${name}: ${limit} voices, ${(share * 100).toFixed(1)}% of real time`);
      // Generous bound for slow machines: a full chord of the heaviest sound stays below a quarter of real time.
      expect(share, name).toBeLessThan(0.25);
    }
    console.info(`[cost] ${report.join('; ')}`);
  });
});
