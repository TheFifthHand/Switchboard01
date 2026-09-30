/**
 * Mono bass synth, poly synth and the shared voice helpers, rendered on a
 * real OfflineAudioContext(2, n, 48000) in Chromium and measured
 * numerically: level, pitch, spectrum, click-free envelopes, voice limits
 * and cleanup, mono/legato behaviour and the modulation buses.
 */
import { describe, expect, it } from 'vitest';
import type { InstrumentContext, InstrumentEngine } from '../../src/audio/contracts';
import { MonoSynthEngine } from '../../src/audio/instruments/monoSynth';
import { POLY_MAX_VOICES, PolySynthEngine } from '../../src/audio/instruments/polySynth';
import { GainEnvelope, midiToHz, velocityGain } from '../../src/audio/instruments/voice';
import { createInstrumentEngine } from '../../src/audio/instruments/index';
import { BASS_PARAMS, POLY_PARAMS, defaultParams } from '../../src/project/params';
import { Rng } from '../../src/project/rng';
import type { BassInstrument, PolyInstrument } from '../../src/project/types';

const SR = 48000;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeIctx(ctx: BaseAudioContext, bpm = 120): InstrumentContext {
  const noise = ctx.createBuffer(1, SR * 2, SR);
  const d = noise.getChannelData(0);
  const rng = new Rng(99);
  for (let i = 0; i < d.length; i++) d[i] = rng.noise();
  return { ctx, samples: { get: () => null }, noise, getBpm: () => bpm };
}

function bass(p: Record<string, number> = {}): BassInstrument {
  return { kind: 'bass', presetId: 'test', params: { ...defaultParams(BASS_PARAMS), ...p } };
}

function poly(p: Record<string, number> = {}): PolyInstrument {
  return { kind: 'poly', presetId: 'test', params: { ...defaultParams(POLY_PARAMS), ...p } };
}

/** A clean sine bass: no sub, no drive, open filter, no filter envelope. */
const SINE_BASS = { wave: 3, sub: 0, drive: 0, envAmount: 0, cutoff: 12000, resonance: 0 };
/** A single clean sine voice on the poly synth. */
const SINE_POLY = { osc1Wave: 3, osc2Level: 0, noise: 0, filterEnv: 0, cutoff: 18000, resonance: 0, width: 0 };

interface Rendered {
  L: Float32Array;
  R: Float32Array;
}

/**
 * Render `seconds` with an engine built by `make`; `schedule` triggers notes
 * before rendering and may register suspend points via `at(time, fn)`.
 */
async function render<E extends InstrumentEngine>(
  seconds: number,
  make: (ictx: InstrumentContext) => E,
  schedule: (engine: E, ctx: OfflineAudioContext, at: (time: number, fn: () => void) => void) => void,
): Promise<Rendered & { engine: E }> {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const engine = make(makeIctx(ctx));
  engine.output.connect(ctx.destination);
  const at = (time: number, fn: () => void) => {
    void ctx.suspend(time).then(() => {
      fn();
      void ctx.resume();
    });
  };
  schedule(engine, ctx, at);
  const buf = await ctx.startRendering();
  // Let any queued 'ended' events run.
  await new Promise((r) => setTimeout(r, 10));
  return { L: buf.getChannelData(0), R: buf.getChannelData(1), engine };
}

/* ------------------------------------------------------------------ */
/* Measurements                                                        */
/* ------------------------------------------------------------------ */

const idx = (t: number) => Math.round(t * SR);

function peak(x: Float32Array, a = 0, b = x.length): number {
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

function allFinite(x: Float32Array): boolean {
  for (const v of x) if (!Number.isFinite(v)) return false;
  return true;
}

/** Largest sample-to-sample jump in [a, b). */
function maxStep(x: Float32Array, a = 1, b = x.length): number {
  let m = 0;
  for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

/** Fundamental from rising zero crossings (interpolated), for sine/triangle-like signals. */
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

/** Amplitude of the component at `f` Hz in [a, b) (Hann-windowed single-bin DFT). */
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

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
      }
    }
  }
}

/** Magnitude-weighted mean frequency of an 8192-sample Hann window starting at `a`. */
function centroid(x: Float32Array, a: number, n = 8192): number {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  let num = 0;
  let den = 0;
  for (let k = 1; k < n / 2; k++) {
    const m = Math.hypot(re[k], im[k]);
    num += m * ((k * SR) / n);
    den += m;
  }
  return num / den;
}

/** RMS over one period of `f` (phase-independent level of a steady tone), sliding from a to b. */
function periodRmsRange(x: Float32Array, a: number, b: number, f: number): { min: number; max: number } {
  const w = Math.round(SR / f);
  let min = Infinity;
  let max = 0;
  for (let i = a; i + w <= b; i += 24) {
    const r = rms(x, i, i + w);
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  return { min, max };
}

/* ------------------------------------------------------------------ */
/* Voice helpers                                                       */
/* ------------------------------------------------------------------ */

describe('voice helpers', () => {
  it('converts MIDI to Hz and maps velocity monotonically', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 9);
    expect(midiToHz(57)).toBeCloseTo(220, 9);
    expect(velocityGain(1, 1)).toBeCloseTo(1, 9);
    expect(velocityGain(0.2, 0)).toBeCloseTo(1, 9);
    expect(velocityGain(0.5, 1)).toBeLessThan(velocityGain(0.8, 1));
    expect(velocityGain(Number.NaN, 1)).toBe(0);
  });

  for (const useHold of [true, false]) {
    it(`envelope releases during attack and decay start from the current level (${useHold ? 'cancelAndHold' : 'model fallback'})`, async () => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const src = new ConstantSourceNode(ctx, { offset: 1 });
      const gA = new GainNode(ctx, { gain: 0 });
      const gB = new GainNode(ctx, { gain: 0 });
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      src.connect(gA).connect(merger, 0, 0);
      src.connect(gB).connect(merger, 0, 1);
      merger.connect(ctx.destination);
      src.start(0);
      const envA = new GainEnvelope(gA.gain, useHold);
      const envB = new GainEnvelope(gB.gain, useHold);
      // A: released half-way through a 200 ms attack. B: released during the decay.
      envA.start(0.01, 0, 1, 0.2, 0.4, 0.3);
      envB.start(0.01, 0, 1, 0.05, 0.4, 0.3);
      const endA = envA.release(0.11, 0.2);
      const endB = envB.release(0.2, 0.2);
      const buf = await ctx.startRendering();
      const A = buf.getChannelData(0);
      const B = buf.getChannelData(1);
      // The model predicts the rendered curve, and the release starts where the envelope was.
      for (const [env, x] of [
        [envA, A],
        [envB, B],
      ] as const) {
        for (let t = 0.02; t < 0.5; t += 0.013) expect(Math.abs(x[idx(t)] - env.valueAt(t))).toBeLessThan(2e-3);
      }
      expect(A[idx(0.11)]).toBeCloseTo(0.5, 2);
      expect(B[idx(0.2)]).toBeGreaterThan(0.45);
      // No jumps anywhere (the steepest intended slope is the 50 ms attack: 1/2400 per sample).
      expect(maxStep(A)).toBeLessThan(1e-3);
      expect(maxStep(B)).toBeLessThan(1e-3);
      // Exact silence after the release.
      expect(peak(A, idx(endA) + 2)).toBe(0);
      expect(peak(B, idx(endB) + 2)).toBe(0);
    });
  }
});

/* ------------------------------------------------------------------ */
/* Mono bass synth                                                     */
/* ------------------------------------------------------------------ */

describe('MonoSynthEngine', () => {
  it('plays an audible, finite, well-levelled note that ends in exact silence and frees its voice', async () => {
    const r = await render(
      1,
      (ictx) => new MonoSynthEngine(ictx, bass()),
      (e) => {
        e.trigger({ pitch: 36, velocity: 1, time: 0.05, duration: 0.4 });
        expect(e.activeVoices()).toBe(1);
      },
    );
    expect(allFinite(r.L) && allFinite(r.R)).toBe(true);
    const p = peak(r.L);
    expect(p).toBeGreaterThan(0.2);
    expect(p).toBeLessThan(0.9);
    expect(rms(r.L, idx(0.1), idx(0.4))).toBeGreaterThan(0.05);
    // Release 80 ms after 0.45 s: silent from 0.54 s.
    expect(peak(r.L, idx(0.54))).toBe(0);
    expect(peak(r.R, idx(0.54))).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('plays in tune with sine and triangle waves, and transposes by octave', async () => {
    for (const [wave, octave, expected] of [
      [3, 0, 110],
      [2, 0, 110],
      [3, 1, 220],
      [2, -1, 55],
    ] as const) {
      const r = await render(
        0.7,
        (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, wave, octave })),
        (e) => void e.trigger({ pitch: 45, velocity: 0.9, time: 0.05, duration: 0.6 }),
      );
      const f = zcFreq(r.L, idx(0.2), idx(0.6));
      expect(Math.abs(f / expected - 1), `wave ${wave} octave ${octave}: ${f} Hz`).toBeLessThan(0.01);
    }
  });

  it('a lower cutoff lowers the spectral centroid; the filter envelope brightens the attack', async () => {
    const centroidFor = async (p: Record<string, number>, from: number) => {
      const r = await render(
        0.8,
        (ictx) => new MonoSynthEngine(ictx, bass({ wave: 0, sub: 0, drive: 0, envAmount: 0, resonance: 0, sustain: 1, ...p })),
        (e) => void e.trigger({ pitch: 36, velocity: 1, time: 0.02, duration: 0.7 }),
      );
      return centroid(r.L, idx(from));
    };
    const c300 = await centroidFor({ cutoff: 300 }, 0.3);
    const c1200 = await centroidFor({ cutoff: 1200 }, 0.3);
    const c4000 = await centroidFor({ cutoff: 4000 }, 0.3);
    expect(c300).toBeLessThan(c1200 * 0.8);
    expect(c1200).toBeLessThan(c4000 * 0.8);
    // Filter envelope: bright at the start, back to the base cutoff later.
    const early = await centroidFor({ cutoff: 300, envAmount: 0.8, filterDecay: 0.3 }, 0.02);
    const late = await centroidFor({ cutoff: 300, envAmount: 0.8, filterDecay: 0.3 }, 0.5);
    expect(early).toBeGreaterThan(late * 1.5);
  });

  it('the sub oscillator is a square one octave below', async () => {
    const measure = async (sub: number) => {
      const r = await render(
        0.6,
        (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sub, sustain: 1 })),
        (e) => void e.trigger({ pitch: 45, velocity: 1, time: 0.02, duration: 0.5 }),
      );
      const a = idx(0.1);
      const b = idx(0.5);
      return { f: toneAmp(r.L, a, b, 110), half: toneAmp(r.L, a, b, 55), third: toneAmp(r.L, a, b, 165) };
    };
    const without = await measure(0);
    const withSub = await measure(1);
    expect(without.half / without.f).toBeLessThan(0.01);
    expect(withSub.half / withSub.f).toBeGreaterThan(0.3);
    // A square has odd harmonics at 1/3 of the fundamental: 165 Hz relative to 55 Hz.
    expect(withSub.third / withSub.half).toBeGreaterThan(0.2);
    expect(withSub.third / withSub.half).toBeLessThan(0.45);
  });

  it('velocity sensitivity scales loudness and the filter envelope; 0 ignores velocity', async () => {
    const level = async (velocity: number, sens: number) => {
      const r = await render(
        0.5,
        (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sustain: 1, velocity: sens })),
        (e) => void e.trigger({ pitch: 45, velocity, time: 0.02, duration: 0.4 }),
      );
      return rms(r.L, idx(0.1), idx(0.35));
    };
    expect((await level(0.3, 1)) / (await level(1, 1))).toBeCloseTo(Math.pow(0.3, 1.6), 2);
    expect((await level(0.3, 0)) / (await level(1, 0))).toBeCloseTo(1, 4);

    const brightness = async (velocity: number, sens: number) => {
      const r = await render(
        0.5,
        (ictx) => new MonoSynthEngine(ictx, bass({ wave: 0, sub: 0, drive: 0, resonance: 0, cutoff: 150, envAmount: 1, filterDecay: 1, velocity: sens })),
        (e) => void e.trigger({ pitch: 36, velocity, time: 0.02, duration: 0.4 }),
      );
      return centroid(r.L, idx(0.03));
    };
    expect(await brightness(1, 1)).toBeGreaterThan((await brightness(0.3, 1)) * 1.5);
    expect(Math.abs((await brightness(0.3, 0)) / (await brightness(1, 0)) - 1)).toBeLessThan(0.02);
  });

  it('resonance emphasises the cutoff, and extreme settings stay finite and bounded', async () => {
    // Saw at 55 Hz, cutoff on its 8th harmonic.
    const harmonic = async (resonance: number) => {
      const r = await render(
        0.5,
        (ictx) => new MonoSynthEngine(ictx, bass({ wave: 0, sub: 0, drive: 0, envAmount: 0, cutoff: 440, resonance, sustain: 1 })),
        (e) => void e.trigger({ pitch: 33, velocity: 1, time: 0.02, duration: 0.4 }),
      );
      return toneAmp(r.L, idx(0.1), idx(0.4), 440) / toneAmp(r.L, idx(0.1), idx(0.4), 55);
    };
    expect((await harmonic(1)) / (await harmonic(0))).toBeGreaterThan(3);

    let worst = 0;
    for (const wave of [0, 1]) {
      for (const cutoff of [150, 700]) {
        for (const drive of [0, 1]) {
          for (const pitch of [24, 40]) {
            const r = await render(
              0.4,
              (ictx) => new MonoSynthEngine(ictx, bass({ wave, cutoff, drive, resonance: 1, sub: 1, envAmount: 1, sustain: 1 })),
              (e) => void e.trigger({ pitch, velocity: 1, time: 0.02, duration: 0.3 }),
            );
            expect(allFinite(r.L)).toBe(true);
            worst = Math.max(worst, peak(r.L));
          }
        }
      }
    }
    // Level 0 dB: no runaway resonance (the downstream limiter handles the rest).
    expect(worst).toBeLessThan(1.5);
  });

  it('saturation adds harmonics without changing loudness much (level compensated)', async () => {
    const measure = async (drive: number) => {
      const r = await render(
        0.6,
        (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, drive, sustain: 1 })),
        (e) => void e.trigger({ pitch: 40, velocity: 1, time: 0.02, duration: 0.5 }),
      );
      return { level: rms(r.L, idx(0.1), idx(0.45)), bright: centroid(r.L, idx(0.1)), peak: peak(r.L) };
    };
    const clean = await measure(0);
    const driven = await measure(1);
    const db = 20 * Math.log10(driven.level / clean.level);
    expect(Math.abs(db)).toBeLessThan(3);
    expect(driven.bright).toBeGreaterThan(clean.bright * 2);
    expect(driven.peak).toBeLessThan(1);
  });

  it('releases during attack, decay and sustain without clicks, each ending in silence', async () => {
    const r = await render(
      2,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, attack: 0.15, decay: 0.2, sustain: 0.5, release: 0.12, glide: 0 })),
      (e) => {
        e.trigger({ pitch: 45, velocity: 1, time: 0.05, duration: 0.06 }); // release during the attack
        e.trigger({ pitch: 45, velocity: 1, time: 0.6, duration: 0.24 }); // release during the decay
        e.trigger({ pitch: 45, velocity: 1, time: 1.2, duration: 0.5 }); // release from sustain
      },
    );
    const p = peak(r.L);
    expect(p).toBeGreaterThan(0.1);
    // A 110 Hz sine of amplitude p moves at most 2*pi*110*p/SR per sample; allow a small margin.
    const natural = (2 * Math.PI * 110 * p) / SR;
    expect(maxStep(r.L)).toBeLessThan(natural * 1.3);
    // Silence after each release tail (release 120 ms + 3 ms end ramp).
    expect(peak(r.L, idx(0.11 + 0.125), idx(0.6))).toBe(0);
    expect(peak(r.L, idx(0.84 + 0.125), idx(1.2))).toBe(0);
    expect(peak(r.L, idx(1.7 + 0.125))).toBe(0);
    // The first note was released half-way up its attack: it never reached full level.
    expect(peak(r.L, 0, idx(0.6))).toBeLessThan(peak(r.L, idx(0.6), idx(1.2)) * 0.6);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('overlapping notes never sound two pitches at once', async () => {
    const pitches = [45, 52, 57, 49];
    const starts = [0.05, 0.35, 0.65, 0.95];
    const counts: number[] = [];
    const r = await render(
      1.6,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sustain: 1, glide: 0 })),
      (e, _ctx, at) => {
        pitches.forEach((pitch, i) => e.trigger({ pitch, velocity: 0.9, time: starts[i], duration: 0.5 }));
        for (const s of starts) at(s + 0.02, () => counts.push(e.activeVoices()));
      },
    );
    for (let i = 0; i < pitches.length; i++) {
      const a = idx(starts[i] + 0.02);
      const b = idx(i + 1 < starts.length ? starts[i + 1] - 0.005 : starts[i] + 0.45);
      const own = toneAmp(r.L, a, b, midiToHz(pitches[i]));
      expect(own).toBeGreaterThan(0.1);
      for (let j = 0; j < pitches.length; j++) {
        if (j === i) continue;
        const other = toneAmp(r.L, a, b, midiToHz(pitches[j]));
        expect(other / own, `note ${i}: pitch ${pitches[j]} still audible`).toBeLessThan(0.01);
      }
    }
    // Each cut voice is freed within a few milliseconds of the next note (the rest are still scheduled).
    expect(counts).toEqual([4, 3, 2, 1]);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('legato glides through intermediate pitches and keeps the level continuous', async () => {
    const legato = await render(
      1.2,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, glide: 0.25 })),
      (e) => {
        e.trigger({ pitch: 45, velocity: 0.9, time: 0.05, duration: 0.5 });
        e.trigger({ pitch: 57, velocity: 0.9, time: 0.3, duration: 0.6, legato: true });
      },
    );
    expect(zcFreq(legato.L, idx(0.15), idx(0.29)) / 110 - 1).toBeLessThan(0.01);
    const freqs: number[] = [];
    for (let t = 0.3; t < 0.55; t += 0.04) freqs.push(zcFreq(legato.L, idx(t), idx(t + 0.04)));
    for (let i = 1; i < freqs.length; i++) expect(freqs[i]).toBeGreaterThan(freqs[i - 1]);
    expect(freqs.filter((f) => f > 125 && f < 205).length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(zcFreq(legato.L, idx(0.6), idx(0.85)) / 220 - 1)).toBeLessThan(0.01);
    // Exponential glide (linear in semitones): half-way it is at the geometric mean (155.6 Hz), not 165 Hz.
    const mid = zcFreq(legato.L, idx(0.3 + 0.125 - 0.02), idx(0.3 + 0.125 + 0.02));
    expect(Math.abs(mid / Math.sqrt(110 * 220) - 1)).toBeLessThan(0.02);
    // No retriggered attack: the level stays at the held level through the note change.
    const before = rms(legato.L, idx(0.2), idx(0.29));
    const across = periodRmsRange(legato.L, idx(0.28), idx(0.4), 110);
    expect(across.max / before).toBeLessThan(1.1);
    expect(across.min / before).toBeGreaterThan(0.85);

    // The same notes without legato retrigger the envelope (attack peak above the held level) and jump in pitch.
    const retrig = await render(
      1.2,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, glide: 0.25 })),
      (e) => {
        e.trigger({ pitch: 45, velocity: 0.9, time: 0.05, duration: 0.5 });
        e.trigger({ pitch: 57, velocity: 0.9, time: 0.3, duration: 0.6 });
      },
    );
    expect(peak(retrig.L, idx(0.3), idx(0.4)) / peak(retrig.L, idx(0.2), idx(0.29))).toBeGreaterThan(1.25);
    expect(Math.abs(zcFreq(retrig.L, idx(0.32), idx(0.36)) / 220 - 1)).toBeLessThan(0.01);
  });

  it('a repeated or legato note at the same pitch continues without a level dip', async () => {
    for (const isLegato of [true, false]) {
      // The second note starts where the first oscillator is exactly half a cycle in: the worst case for a crossfade.
      const r = await render(
        0.8,
        (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sustain: 1, glide: 0.05 })),
        (e) => {
          e.trigger({ pitch: 45, velocity: 1, time: 0.05, duration: 0.3 });
          e.trigger({ pitch: 45, velocity: 1, time: 0.05 + 27.5 / 110, duration: 0.3, legato: isLegato });
        },
      );
      const before = rms(r.L, idx(0.15), idx(0.29));
      const across = periodRmsRange(r.L, idx(0.28), idx(0.33), 110);
      expect(across.min / before, isLegato ? 'legato' : 'repeat').toBeGreaterThan(0.95);
      expect(across.max / before, isLegato ? 'legato' : 'repeat').toBeLessThan(1.05);
    }
  });

  it('a cancelled successor does not cut the note it would have replaced', async () => {
    const r = await render(
      1,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sustain: 1 })),
      (e) => {
        e.trigger({ pitch: 45, velocity: 1, time: 0.05, duration: 0.7 });
        const next = e.trigger({ pitch: 52, velocity: 1, time: 0.4, duration: 0.3 });
        next?.cancel();
        expect(next?.ended).toBe(true);
      },
    );
    const before = rms(r.L, idx(0.2), idx(0.39));
    expect(rms(r.L, idx(0.42), idx(0.7)) / before).toBeGreaterThan(0.97);
    expect(toneAmp(r.L, idx(0.42), idx(0.7), midiToHz(52))).toBeLessThan(0.001);
  });

  it('pitchMod: a constant +1200 cents raises the pitch an octave; cutoffMod moves the filter', async () => {
    const r = await render(
      0.6,
      (ictx) => new MonoSynthEngine(ictx, bass(SINE_BASS)),
      (e, ctx) => {
        const c = new ConstantSourceNode(ctx, { offset: 1200 });
        c.connect(e.pitchMod);
        c.start(0);
        e.trigger({ pitch: 45, velocity: 1, time: 0.05, duration: 0.5 });
      },
    );
    expect(Math.abs(zcFreq(r.L, idx(0.15), idx(0.5)) / 220 - 1)).toBeLessThan(0.01);

    const withCutoffMod = async (cents: number) => {
      const out = await render(
        0.6,
        (ictx) => new MonoSynthEngine(ictx, bass({ wave: 0, sub: 0, drive: 0, envAmount: 0, cutoff: 1500 })),
        (e, ctx) => {
          const c = new ConstantSourceNode(ctx, { offset: cents });
          c.connect(e.cutoffMod);
          c.start(0);
          e.trigger({ pitch: 36, velocity: 1, time: 0.02, duration: 0.5 });
        },
      );
      return centroid(out.L, idx(0.2));
    };
    expect(await withCutoffMod(-2400)).toBeLessThan((await withCutoffMod(0)) * 0.8);
  });

  it('update() changes level and cutoff of a sounding note smoothly', async () => {
    const r = await render(
      0.9,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sustain: 1 })),
      (e, ctx, at) => {
        e.trigger({ pitch: 45, velocity: 1, time: 0.05, duration: 0.8 });
        at(0.4, () => e.update(bass({ ...SINE_BASS, sustain: 1, level: -12 }), ctx.currentTime));
      },
    );
    const before = rms(r.L, idx(0.2), idx(0.39));
    const after = rms(r.L, idx(0.55), idx(0.8));
    expect(20 * Math.log10(after / before)).toBeCloseTo(-12, 0);
    const natural = (2 * Math.PI * 110 * peak(r.L, idx(0.2), idx(0.39))) / SR;
    expect(maxStep(r.L, idx(0.39), idx(0.5))).toBeLessThan(natural * 1.3);

    const saw = { wave: 0, sub: 0, drive: 0, envAmount: 0, sustain: 1 };
    const c = await render(
      0.9,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...saw, cutoff: 4000 })),
      (e, ctx, at) => {
        e.trigger({ pitch: 36, velocity: 1, time: 0.02, duration: 0.85 });
        at(0.3, () => e.update(bass({ ...saw, cutoff: 300 }), ctx.currentTime));
      },
    );
    expect(centroid(c.L, idx(0.5))).toBeLessThan(centroid(c.L, idx(0.1)) * 0.6);
  });

  it('kill() silences a sounding note within 5 ms without a click and frees it', async () => {
    const r = await render(
      0.8,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sustain: 1 })),
      (e, _ctx, at) => {
        e.trigger({ pitch: 45, velocity: 1, time: 0.05 });
        at(0.3, () => e.kill());
      },
    );
    expect(rms(r.L, idx(0.2), idx(0.29))).toBeGreaterThan(0.1);
    expect(peak(r.L, idx(0.3 + 0.005) + 128)).toBe(0);
    // A 4 ms fade: at most (level / 192 samples) + the sine's own motion per sample.
    const p = peak(r.L, idx(0.2), idx(0.29));
    expect(maxStep(r.L, idx(0.29), idx(0.32))).toBeLessThan((2 * Math.PI * 110 * p) / SR + p / 150);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('a release requested for a time already past starts from the current level (no jump)', async () => {
    const r = await render(
      0.8,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sustain: 1 })),
      (e, _ctx, at) => {
        const h = e.trigger({ pitch: 45, velocity: 1, time: 0.05 });
        // A stale time (30 ms behind the clock) must not make the envelope jump to where the release would be now.
        at(0.4, () => h?.release(0.37));
      },
    );
    const p = peak(r.L, idx(0.2), idx(0.39));
    expect(p).toBeGreaterThan(0.1);
    expect(maxStep(r.L, idx(0.39), idx(0.5))).toBeLessThan(((2 * Math.PI * 110 * p) / SR) * 1.3);
    expect(peak(r.L, idx(0.4 + 0.08 + 0.003) + 128)).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('held notes sound until handle.release(), releaseAll() ends everything', async () => {
    const r = await render(
      1.2,
      (ictx) => new MonoSynthEngine(ictx, bass({ ...SINE_BASS, sustain: 1 })),
      (e, _ctx, at) => {
        const h = e.trigger({ pitch: 45, velocity: 1, time: 0.05 });
        at(0.5, () => h?.release(0.55));
        e.trigger({ pitch: 52, velocity: 1, time: 0.8 });
        at(0.9, () => e.releaseAll(0.95));
      },
    );
    expect(rms(r.L, idx(0.4), idx(0.54))).toBeGreaterThan(0.1);
    expect(peak(r.L, idx(0.55 + 0.1), idx(0.8))).toBe(0);
    expect(rms(r.L, idx(0.85), idx(0.94))).toBeGreaterThan(0.1);
    expect(peak(r.L, idx(0.95 + 0.1))).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Poly synth                                                          */
/* ------------------------------------------------------------------ */

describe('PolySynthEngine', () => {
  it('a 4-note chord at velocity 1 is audible, finite, peaks below 0.7 and releases to silence', async () => {
    const cases: Record<string, number>[] = [{}, { osc2Level: 1, resonance: 0.8, sustain: 1, cutoff: 6000 }];
    for (const params of cases) {
      const r = await render(
        1.4,
        (ictx) => new PolySynthEngine(ictx, poly(params)),
        (e) => {
          for (const pitch of [60, 64, 67, 71]) e.trigger({ pitch, velocity: 1, time: 0.05, duration: 0.6 });
          expect(e.activeVoices()).toBe(4);
        },
      );
      expect(allFinite(r.L) && allFinite(r.R)).toBe(true);
      const p = Math.max(peak(r.L), peak(r.R));
      expect(p).toBeGreaterThan(0.1);
      expect(p).toBeLessThan(0.7);
      // Default release 0.35 s after 0.65 s.
      expect(peak(r.L, idx(1.01)) + peak(r.R, idx(1.01))).toBe(0);
      expect(r.engine.activeVoices()).toBe(0);
    }
  });

  it('releases during attack, decay and sustain without clicks and frees the voices', async () => {
    const r = await render(
      2,
      (ictx) => new PolySynthEngine(ictx, poly({ ...SINE_POLY, attack: 0.15, decay: 0.2, sustain: 0.5, release: 0.12 })),
      (e) => {
        e.trigger({ pitch: 57, velocity: 1, time: 0.05, duration: 0.06 }); // release during the attack
        e.trigger({ pitch: 57, velocity: 1, time: 0.6, duration: 0.24 }); // release during the decay
        e.trigger({ pitch: 57, velocity: 1, time: 1.2, duration: 0.5 }); // release from sustain
      },
    );
    const p = peak(r.L);
    expect(p).toBeGreaterThan(0.05);
    expect(maxStep(r.L)).toBeLessThan(((2 * Math.PI * 220 * p) / SR) * 1.3);
    expect(peak(r.L, idx(0.11 + 0.125), idx(0.6))).toBe(0);
    expect(peak(r.L, idx(0.84 + 0.125), idx(1.2))).toBe(0);
    expect(peak(r.L, idx(1.7 + 0.125))).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('plays in tune; osc 2 is transposed by its semitones', async () => {
    const r = await render(
      0.5,
      (ictx) => new PolySynthEngine(ictx, poly(SINE_POLY)),
      (e) => void e.trigger({ pitch: 69, velocity: 0.9, time: 0.02, duration: 0.4 }),
    );
    expect(Math.abs(zcFreq(r.L, idx(0.1), idx(0.4)) / 440 - 1)).toBeLessThan(0.01);

    const two = await render(
      0.5,
      (ictx) => new PolySynthEngine(ictx, poly({ ...SINE_POLY, osc2Wave: 3, osc2Level: 1, osc2Semi: 12, detune: 0 })),
      (e) => void e.trigger({ pitch: 69, velocity: 0.9, time: 0.02, duration: 0.4 }),
    );
    const a440 = toneAmp(two.L, idx(0.1), idx(0.4), 440);
    const a880 = toneAmp(two.L, idx(0.1), idx(0.4), 880);
    expect(a880 / a440).toBeGreaterThan(0.8);
    expect(a880 / a440).toBeLessThan(1.25);
  });

  it('a lower cutoff lowers the spectral centroid', async () => {
    const c = async (cutoff: number) => {
      const r = await render(
        0.6,
        (ictx) => new PolySynthEngine(ictx, poly({ filterEnv: 0, resonance: 0, sustain: 1, cutoff })),
        (e) => void e.trigger({ pitch: 48, velocity: 1, time: 0.02, duration: 0.5 }),
      );
      return centroid(r.L, idx(0.2));
    };
    const low = await c(400);
    const mid = await c(1600);
    const high = await c(8000);
    expect(low).toBeLessThan(mid * 0.8);
    expect(mid).toBeLessThan(high * 0.8);
  });

  it('the filter envelope brightens the attack; velocity scales level', async () => {
    const r = await render(
      1,
      (ictx) => new PolySynthEngine(ictx, poly({ cutoff: 300, resonance: 0, filterEnv: 1, filterDecay: 0.3, sustain: 1 })),
      (e) => void e.trigger({ pitch: 48, velocity: 1, time: 0.02, duration: 0.9 }),
    );
    expect(centroid(r.L, idx(0.02))).toBeGreaterThan(centroid(r.L, idx(0.6)) * 1.5);

    const level = async (velocity: number, sens: number) => {
      const out = await render(
        0.5,
        (ictx) => new PolySynthEngine(ictx, poly({ ...SINE_POLY, sustain: 1, velocity: sens })),
        (e) => void e.trigger({ pitch: 57, velocity, time: 0.02, duration: 0.4 }),
      );
      return rms(out.L, idx(0.1), idx(0.35));
    };
    expect((await level(0.3, 1)) / (await level(1, 1))).toBeCloseTo(Math.pow(0.3, 1.6), 2);
    expect((await level(0.3, 0)) / (await level(1, 0))).toBeCloseTo(1, 4);
  });

  it('never allocates more than 12 voices and frees them all after release', async () => {
    const counts: number[] = [];
    let immediate = -1;
    const r = await render(
      2.1,
      (ictx) => new PolySynthEngine(ictx, poly()),
      (e, _ctx, at) => {
        for (let i = 0; i < 20; i++) e.trigger({ pitch: 48 + i, velocity: 0.7, time: 0.1, duration: 0.4 });
        immediate = e.activeVoices();
        at(0.3, () => counts.push(e.activeVoices()));
        // Staggered notes, each scheduled 10 ms ahead like the transport's look-ahead: each steals the oldest.
        for (let i = 0; i < 20; i++) {
          const t = 0.6 + i * 0.03;
          at(t - 0.01, () => void e.trigger({ pitch: 50 + i, velocity: 0.7, time: t, duration: 0.4 }));
          at(t + 0.01, () => counts.push(e.activeVoices()));
        }
      },
    );
    expect(immediate).toBe(POLY_MAX_VOICES);
    for (const c of counts) expect(c).toBeLessThanOrEqual(POLY_MAX_VOICES);
    expect(Math.max(...counts)).toBe(POLY_MAX_VOICES);
    expect(allFinite(r.L)).toBe(true);
    // Last note: 1.17 s + 0.4 s, then the 0.35 s release.
    expect(peak(r.L, idx(1.93)) + peak(r.R, idx(1.93))).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('stealing fades the oldest voice instead of cutting it', async () => {
    // Twelve identical in-phase sines; a 13th note steals one exactly at a waveform peak.
    const f = midiToHz(45);
    const t0 = 0.05;
    const tSteal = t0 + (20 + 0.25) / f;
    const r = await render(
      0.6,
      (ictx) => new PolySynthEngine(ictx, poly({ ...SINE_POLY, sustain: 1, attack: 0.001, release: 0.05 })),
      (e) => {
        for (let i = 0; i < 12; i++) e.trigger({ pitch: 45, velocity: 0.3, time: t0, duration: 0.45 });
        e.trigger({ pitch: 45, velocity: 0.3, time: tSteal, duration: 0.3 });
      },
    );
    const p = peak(r.L, idx(t0 + 0.05), idx(tSteal - 0.001));
    const perVoice = p / 12;
    // Natural motion of the full sum is 2*pi*f*p/SR per sample; a hard cut would add a step of ~perVoice.
    const natural = (2 * Math.PI * f * p) / SR;
    expect(maxStep(r.L, idx(tSteal - 0.002), idx(tSteal + 0.01))).toBeLessThan(natural + perVoice * 0.2);
  });

  it('steals the oldest voice and leaves the others sounding', async () => {
    // Twelve held sines a whole tone apart, started 10 ms apart; a 13th note must remove only the first.
    const pitches = Array.from({ length: 12 }, (_, i) => 48 + 2 * i);
    const r = await render(
      0.9,
      (ictx) => new PolySynthEngine(ictx, poly({ ...SINE_POLY, sustain: 1 })),
      (e) => {
        pitches.forEach((pitch, i) => e.trigger({ pitch, velocity: 0.5, time: 0.02 + i * 0.01 }));
        e.trigger({ pitch: 84, velocity: 0.5, time: 0.3 });
      },
    );
    const amp = (pitch: number, a: number, b: number) => toneAmp(r.L, idx(a), idx(b), midiToHz(pitch));
    expect(amp(48, 0.1, 0.29) / amp(50, 0.1, 0.29)).toBeGreaterThan(0.8);
    expect(amp(48, 0.35, 0.75) / amp(50, 0.35, 0.75)).toBeLessThan(0.01);
    for (const pitch of pitches.slice(1)) expect(amp(pitch, 0.35, 0.75) / amp(pitch, 0.1, 0.29), `pitch ${pitch}`).toBeGreaterThan(0.9);
    expect(amp(84, 0.35, 0.75)).toBeGreaterThan(0.5 * amp(50, 0.35, 0.75));
    expect(r.engine.activeVoices()).toBe(POLY_MAX_VOICES);
  });

  it('pitchMod: a constant +1200 cents raises the pitch an octave', async () => {
    const r = await render(
      0.5,
      (ictx) => new PolySynthEngine(ictx, poly(SINE_POLY)),
      (e, ctx) => {
        const c = new ConstantSourceNode(ctx, { offset: 1200 });
        c.connect(e.pitchMod);
        c.start(0);
        e.trigger({ pitch: 57, velocity: 1, time: 0.02, duration: 0.4 });
      },
    );
    expect(Math.abs(zcFreq(r.L, idx(0.1), idx(0.4)) / 440 - 1)).toBeLessThan(0.01);
  });

  it('width spreads the two oscillators across the stereo field (and follows update smoothly)', async () => {
    const spread = { ...SINE_POLY, osc2Wave: 3, osc2Level: 1, osc2Semi: 12, detune: 0, sustain: 1 };
    const r = await render(
      1,
      (ictx) => new PolySynthEngine(ictx, poly({ ...spread, width: 1 })),
      (e, ctx, at) => {
        e.trigger({ pitch: 69, velocity: 1, time: 0.02, duration: 0.9 });
        at(0.5, () => e.update(poly({ ...spread, width: 0 }), ctx.currentTime));
      },
    );
    const lo = (x: Float32Array, a: number, b: number) => toneAmp(x, idx(a), idx(b), 440);
    const hi = (x: Float32Array, a: number, b: number) => toneAmp(x, idx(a), idx(b), 880);
    // Wide: osc 1 (440 Hz) left, osc 2 (880 Hz) right.
    expect(lo(r.L, 0.1, 0.45) / lo(r.R, 0.1, 0.45)).toBeGreaterThan(5);
    expect(hi(r.R, 0.1, 0.45) / hi(r.L, 0.1, 0.45)).toBeGreaterThan(5);
    // Narrow after the update: both centred.
    expect(Math.abs(lo(r.L, 0.6, 0.9) / lo(r.R, 0.6, 0.9) - 1)).toBeLessThan(0.05);
    expect(allFinite(r.L) && allFinite(r.R)).toBe(true);
  });

  it('noise adds broadband air and renders deterministically', async () => {
    const run = (noise: number) =>
      render(
        0.6,
        (ictx) => new PolySynthEngine(ictx, poly({ ...SINE_POLY, noise, sustain: 1, cutoff: 12000 })),
        (e) => void e.trigger({ pitch: 57, velocity: 1, time: 0.02, duration: 0.5 }),
      );
    const a = await run(1);
    const b = await run(1);
    const clean = await run(0);
    let diff = 0;
    for (let i = 0; i < a.L.length; i++) diff = Math.max(diff, Math.abs(a.L[i] - b.L[i]));
    expect(diff).toBe(0);
    expect(centroid(a.L, idx(0.2))).toBeGreaterThan(centroid(clean.L, idx(0.2)) * 5);
  });

  it('kill() and releaseAll() stop everything and free every node', async () => {
    const r = await render(
      1.2,
      (ictx) => new PolySynthEngine(ictx, poly({ sustain: 1, release: 2 })),
      (e, _ctx, at) => {
        for (const pitch of [48, 55, 60, 64]) e.trigger({ pitch, velocity: 1, time: 0.05 });
        e.trigger({ pitch: 67, velocity: 1, time: 0.35 }); // scheduled after the kill: never sounds
        at(0.3, () => e.kill());
        at(0.4, () => {
          for (const pitch of [50, 57]) e.trigger({ pitch, velocity: 1, time: 0.5 });
          e.trigger({ pitch: 62, velocity: 1, time: 0.9 }); // scheduled after releaseAll's time: never sounds
        });
        at(0.6, () => e.releaseAll(0.7));
      },
    );
    expect(rms(r.L, idx(0.1), idx(0.29))).toBeGreaterThan(0.01);
    expect(peak(r.L, idx(0.31), idx(0.5))).toBe(0);
    expect(rms(r.L, idx(0.55), idx(0.69))).toBeGreaterThan(0.01);
    // Release 2 s: still ringing at 0.8 s, and the note at 0.9 s was cancelled (nothing new starts).
    expect(rms(r.L, idx(0.75), idx(0.85))).toBeGreaterThan(0.001);
    expect(r.engine.activeVoices()).toBe(2);
    r.engine.dispose();
    expect(r.engine.activeVoices()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

describe('createInstrumentEngine', () => {
  it('builds the engine that matches the instrument kind', () => {
    const ctx = new OfflineAudioContext(2, 128, SR);
    const ictx = makeIctx(ctx);
    expect(createInstrumentEngine(ictx, bass()).kind).toBe('bass');
    expect(createInstrumentEngine(ictx, poly()).kind).toBe('poly');
    expect(createInstrumentEngine(ictx, { kind: 'sampler', sampleId: null, params: {} }).kind).toBe('sampler');
    expect(createInstrumentEngine(ictx, { kind: 'drums', kitId: 'round-machine', params: {}, voices: [] }).kind).toBe('drums');
  });
});
