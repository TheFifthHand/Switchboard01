/**
 * Building blocks shared by the bass and poly synth voices for the sound
 * families beyond plain subtractive synthesis:
 *
 * - FM: a hidden sine modulator at `ratio` x the note frequency drives the
 *   main oscillator's frequency (audio-rate), with its own depth envelope.
 *   Index = 8 x amount^2 (velocity-scaled), from its peak toward
 *   FM_SUSTAIN of it over `fmDecay`.
 * - Unison: copies of a waveform, each starting at a different phase (built
 *   from the same Fourier series as the browser's own oscillator types, so a
 *   copy sounds exactly like the plain wave, only shifted), tuned apart
 *   symmetrically. Different phases keep a stack from starting with one
 *   coherent spike and a flanging swoosh.
 * - Pitch sweep: one ConstantSourceNode per voice adds a decaying offset (in
 *   cents) to every oscillator's detune.
 * - Noise colour: low-pass / high-pass pair on the noise source.
 * - Drift: seeded per-note random detune and filter offsets.
 *
 * All of it is deterministic: phases and drift come from fixed tables and
 * seeds derived from the note, never from Math.random or wall-clock time.
 */
import { Rng, hashString, subSeed } from '../../project/rng';
import { fft } from '../dsp/analysis';
import { clamp } from './voice';

/* ------------------------------------------------------------------ */
/* FM                                                                  */
/* ------------------------------------------------------------------ */

/** Modulation index at FM Amount = 100 %. */
export const FM_MAX_INDEX = 8;
/** The FM depth settles toward this fraction of its peak. */
export const FM_SUSTAIN = 0.2;

/** Peak modulation index for an FM Amount (quadratic: fine control over the gentle range). */
export function fmIndex(amount: number): number {
  const a = clamp(amount, 0, 1);
  return FM_MAX_INDEX * a * a;
}

/** Modulator detune (cents) for a frequency ratio. */
export function fmRatioCents(ratio: number): number {
  return 1200 * Math.log2(clamp(ratio, 0.01, 64));
}

/**
 * Peak frequency deviation (Hz) for a note: index x modulator frequency,
 * bounded so the sidebands stay within a sane range at high notes.
 */
export function fmDeviationHz(amount: number, ratio: number, noteHz: number, sampleRate: number): number {
  const dev = fmIndex(amount) * clamp(ratio, 0.01, 64) * noteHz;
  return Math.min(dev, sampleRate * 0.25);
}

/* ------------------------------------------------------------------ */
/* Unison                                                              */
/* ------------------------------------------------------------------ */

const BUILTIN_TYPES: readonly OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];

/** Start phases (fractions of a cycle) of the unison copies; copy i uses UNISON_PHASES[i % 4]. */
export const UNISON_PHASES = [0, 0.41, 0.73, 0.19] as const;

/**
 * Fourier sine coefficient of harmonic n for a WAVE_OPTIONS index, exactly
 * as the browser defines its built-in oscillator types (Web Audio spec).
 */
export function waveCoefficient(wave: number, n: number): number {
  const pf = 2 / (n * Math.PI);
  switch (wave) {
    case 0: // saw
      return pf * (n & 1 ? 1 : -1);
    case 1: // square
      return n & 1 ? 2 * pf : 0;
    case 2: // triangle
      return n & 1 ? 4 * pf * pf * (((n - 1) >> 1) & 1 ? -1 : 1) : 0;
    default: // sine
      return n === 1 ? 1 : 0;
  }
}

/** Harmonics in a phase-shifted wave (the browser band-limits per pitch from these). */
const WAVE_HARMONICS = 2048;
const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
const peakCache = new Map<number, number>();

/**
 * Peak of the full-band table of the plain (phase 0) wave: the browser
 * divides its built-in types by exactly this. A phase-shifted copy is scaled
 * by the same factor instead of its own peak (the band-limited ripple peaks
 * differently once the edge moves), so every copy plays at the built-in level.
 */
function builtinPeak(wave: number): number {
  let p = peakCache.get(wave);
  if (p === undefined) {
    const n = 2 * WAVE_HARMONICS;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let k = 1; k < WAVE_HARMONICS; k++) re[k] = waveCoefficient(wave, k);
    // x[t] = sum b_k sin(2 pi k t / n) = -Im(FFT(b))[t].
    fft(re, im);
    p = 0;
    for (let t = 0; t < n; t++) p = Math.max(p, Math.abs(im[t]));
    peakCache.set(wave, p);
  }
  return p;
}

/**
 * The wave `wave` started `phase` cycles in, as a PeriodicWave at the level
 * of the built-in type. Cached per context; null for phase 0, which is the
 * built-in oscillator type itself.
 */
export function phasedWave(ctx: BaseAudioContext, wave: number, phase: number): PeriodicWave | null {
  if (phase === 0) return null;
  let byCtx = waveCache.get(ctx);
  if (!byCtx) {
    byCtx = new Map();
    waveCache.set(ctx, byCtx);
  }
  const key = `${wave}:${phase}`;
  let pw = byCtx.get(key);
  if (!pw) {
    const real = new Float32Array(WAVE_HARMONICS);
    const imag = new Float32Array(WAVE_HARMONICS);
    const scale = 1 / builtinPeak(wave);
    for (let n = 1; n < WAVE_HARMONICS; n++) {
      const b = waveCoefficient(wave, n) * scale;
      if (b === 0) continue;
      const a = 2 * Math.PI * n * phase;
      real[n] = b * Math.sin(a);
      imag[n] = b * Math.cos(a);
    }
    pw = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
    byCtx.set(key, pw);
  }
  return pw;
}

/** An oscillator of WAVE_OPTIONS `wave` that starts `phase` cycles into its waveform. */
export function phasedOscillator(ctx: BaseAudioContext, wave: number, phase: number, frequency: number, detune: number): OscillatorNode {
  const pw = phasedWave(ctx, wave, phase);
  if (pw) return new OscillatorNode(ctx, { type: 'custom', periodicWave: pw, frequency, detune });
  return new OscillatorNode(ctx, { type: BUILTIN_TYPES[wave] ?? 'sawtooth', frequency, detune });
}

/** Symmetric detune positions in [-1, 1] for `n` unison copies (n = 1: [0]). */
export function unisonPositions(n: number): number[] {
  const count = Math.max(1, Math.round(n));
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, i) => -1 + (2 * i) / (count - 1));
}

/* ------------------------------------------------------------------ */
/* Noise colour                                                        */
/* ------------------------------------------------------------------ */

/** Neutral noise colour (plain white noise, no filters). */
export const NOISE_WHITE = 0.5;
const NOISE_DARKEST = 300;
const NOISE_BRIGHTEST = 8000;

/** Low-pass and high-pass corners for a noise colour, plus the level compensation. */
export function noiseColorFilter(color: number, sampleRate: number): { lowpass: number; highpass: number; gain: number } {
  const c = clamp(color, 0, 1);
  const nyquist = sampleRate / 2;
  const top = Math.min(20000, nyquist * 0.95);
  let lowpass = top;
  let highpass = 20;
  if (c < NOISE_WHITE) lowpass = top * Math.pow(NOISE_DARKEST / top, (NOISE_WHITE - c) / NOISE_WHITE);
  else if (c > NOISE_WHITE) highpass = 20 * Math.pow(NOISE_BRIGHTEST / 20, (c - NOISE_WHITE) / (1 - NOISE_WHITE));
  // White noise power is proportional to the band kept; compensate half of the loss (in dB),
  // relative to the band at 50 % so the neutral setting has exactly unity gain.
  const band = (lo: number, hi: number) => Math.max(1e-3, Math.min(hi, nyquist) - Math.min(lo, nyquist));
  return { lowpass, highpass, gain: Math.pow(band(highpass, lowpass) / band(20, top), -0.25) };
}

/* ------------------------------------------------------------------ */
/* Drift                                                               */
/* ------------------------------------------------------------------ */

/** Maximum per-oscillator detune at Drift = 100 % (cents). */
export const DRIFT_MAX_CENTS = 10;
/** Maximum filter offset at Drift = 100 % (cents: a quarter octave). */
export const DRIFT_MAX_FILTER_CENTS = 300;

/**
 * Seeded per-note offsets: `count` oscillator detunes (cents) and one filter
 * offset (cents). The same note at the same time always drifts the same way.
 */
export function driftOffsets(drift: number, midi: number, frame: number, count: number): { osc: number[]; filter: number } {
  const d = clamp(drift, 0, 1);
  if (d === 0) return { osc: Array.from({ length: count }, () => 0), filter: 0 };
  const rng = new Rng(subSeed(hashString('synth-drift'), `${Math.round(midi * 100)}:${frame}`));
  const osc = Array.from({ length: count }, () => (rng.float() * 2 - 1) * DRIFT_MAX_CENTS * d);
  const filter = (rng.float() * 2 - 1) * DRIFT_MAX_FILTER_CENTS * d;
  return { osc, filter };
}

/* ------------------------------------------------------------------ */
/* Vibrato                                                             */
/* ------------------------------------------------------------------ */

/** Vibrato depth at 100 % (cents). */
export const VIBRATO_MAX_CENTS = 50;
/** Vibrato fades in over this time after the note starts. */
export const VIBRATO_FADE_IN = 0.35;
