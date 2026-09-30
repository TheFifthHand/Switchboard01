/**
 * Built-in samples (catalog BUILTIN_SAMPLES), generated on the device by
 * original DSP code — nothing is downloaded or bundled as audio.
 *
 * Every sample is stereo, deterministic (seeded from hashString(id)),
 * peak-normalised to -3 dBFS and ends in exact silence. Pitched samples are
 * tuned so that MIDI note 60 (C4, the sampler's default root note) plays
 * them at their original pitch.
 *
 * - builtin:glass-chord  bright C minor 7 chord hit (~2.5 s), bell-ish partials, soft attack
 * - builtin:tape-swell   reversed swell (~2 s) with gentle wow/flutter pitch drift
 * - builtin:bell-hit     inharmonic struck bell (~3 s)
 * - builtin:noise-riser  exactly 2 s rising filtered noise sweep with increasing level
 * - builtin:vocal-oh     formant-synthesised "oh" (~1 s) at C4
 */
import { BUILTIN_SAMPLES } from '../../content/catalog';
import { Rng, hashString } from '../../project/rng';
import {
  Biquad,
  OnePoleLowpass,
  PinkNoise,
  WhiteNoise,
  addDampedSine,
  applyBiquads,
  fadeIn,
  fadeOut,
  midiToHz,
  normalizePeakChannels,
  polyBlep,
  sanitize,
  softClipBuffer,
} from '../dsp';

export interface GeneratedSample {
  channels: Float32Array[];
  sampleRate: number;
}

/** Peak level of every built-in sample: -3 dBFS. */
export const BUILTIN_PEAK = Math.pow(10, -3 / 20);
/** MIDI note at which pitched built-ins play at their original pitch. */
export const BUILTIN_ROOT_NOTE = 60;

/** Nominal lengths in seconds (the riser is exact). */
export const BUILTIN_DURATIONS: Readonly<Record<string, number>> = {
  'builtin:glass-chord': 2.5,
  'builtin:tape-swell': 2.0,
  'builtin:bell-hit': 3.0,
  'builtin:noise-riser': 2.0,
  'builtin:vocal-oh': 1.0,
};

const TAU = 2 * Math.PI;
const C4 = midiToHz(BUILTIN_ROOT_NOTE);

type Buf = Float32Array<ArrayBuffer>;

function cents(c: number): number {
  return Math.pow(2, c / 1200);
}

function stereo(n: number): [Buf, Buf] {
  return [new Float32Array(n), new Float32Array(n)];
}

/** Smooth seeded random drift in [-1, 1]: a few slow sinusoids with random rates and phases. */
function driftFn(rng: Rng, rates: readonly [number, number]): (t: number) => number {
  const parts = Array.from({ length: 3 }, () => ({
    f: rates[0] + (rates[1] - rates[0]) * rng.float(),
    p: rng.float() * TAU,
  }));
  return (t) => parts.reduce((s, q) => s + Math.sin(TAU * q.f * t + q.p), 0) / parts.length;
}

/* ------------------------------------------------------------------ */
/* Glass chord                                                         */
/* ------------------------------------------------------------------ */

function glassChord(sr: number, rng: Rng): [Buf, Buf] {
  const n = Math.round(2.5 * sr);
  const ch = stereo(n);
  // C minor 7 voiced bright: C4 Eb4 G4 Bb4 C5 Eb5.
  const notes = [0, 3, 7, 10, 12, 15].map((s) => C4 * Math.pow(2, s / 12));
  const noteLevel = [1, 0.8, 0.85, 0.75, 0.7, 0.45];
  // [ratio, level, T60]: soft harmonic body plus glassy inharmonic partials that fade first.
  const partials: readonly (readonly [number, number, number])[] = [
    [1, 1, 2.3],
    [2, 0.35, 1.5],
    [3, 0.12, 0.9],
    [4, 0.06, 0.6],
    [2.76, 0.32, 0.9],
    [5.4, 0.2, 0.5],
    [8.93, 0.12, 0.3],
    [13.3, 0.05, 0.18],
  ];
  notes.forEach((f0, k) => {
    // Width: the two sides are detuned by a couple of cents in opposite directions from a shared
    // starting phase, so the attack is centred (mono-safe) and the tail slowly spreads.
    const spread = 1.2 + 1.2 * rng.float();
    for (const [ratio, level, t60] of partials) {
      const phase = rng.float();
      for (let c = 0; c < 2; c++) {
        const f = f0 * ratio * cents(c === 0 ? -spread : spread);
        if (f >= sr * 0.45) continue;
        addDampedSine(ch[c], f, t60, sr, level * noteLevel[k], phase);
      }
    }
  });
  // Soft attack (~12 ms) and a gentle top roll-off.
  const attack = Math.round(0.012 * sr);
  for (const c of ch) {
    fadeIn(c, attack);
    applyBiquads(c, sr, [{ type: 'lowpass', freq: 12000 }]);
    fadeOut(c, Math.round(0.25 * sr));
  }
  return ch;
}

/* ------------------------------------------------------------------ */
/* Tape swell                                                          */
/* ------------------------------------------------------------------ */

function tapeSwell(sr: number, rng: Rng): [Buf, Buf] {
  const out = Math.round(2.0 * sr);
  // Forward source: a warm open-fifth chord (C3 G3 C4 G4) that decays; reversed it swells.
  const srcLen = Math.round(2.15 * sr);
  const fwd = stereo(srcLen);
  const roots = [-12, -5, 0, 7].map((s) => C4 * Math.pow(2, s / 12));
  roots.forEach((f0, k) => {
    const spread = 0.8 + 0.8 * rng.float();
    for (let h = 1; h <= 10; h++) {
      const phase = rng.float();
      for (let c = 0; c < 2; c++) {
        const f = f0 * h * cents(c === 0 ? -spread : spread);
        if (f >= sr * 0.45) continue;
        // Saw-like spectrum; upper harmonics die sooner.
        addDampedSine(fwd[c], f, 2.6 / Math.pow(h, 0.45), sr, (0.9 - 0.12 * k) / Math.pow(h, 1.25), phase);
      }
    }
  });
  for (const c of fwd) {
    applyBiquads(c, sr, [{ type: 'lowpass', freq: 3800, q: 0.6 }]);
    c.reverse();
  }
  // Tape playback: read the reversed source at a wobbling speed (wow ~0.6 Hz, flutter ~6.5 Hz, slow drift).
  const ch = stereo(out);
  const wowRate = 0.55 + 0.1 * rng.float();
  const flutterRate = 6.2 + 0.6 * rng.float();
  const drift = driftFn(rng, [0.15, 0.4]);
  const hiss = [new PinkNoise(rng.int(0, 0x7fffffff)), new PinkNoise(rng.int(0, 0x7fffffff))];
  const wowPhase = rng.float() * TAU;
  for (let c = 0; c < 2; c++) {
    const src = fwd[c];
    // The two tape tracks wobble almost together (a small phase offset keeps a little movement between them).
    const phase = wowPhase + c * 0.15;
    let pos = srcLen - out - Math.round(0.08 * sr);
    for (let i = 0; i < out; i++) {
      const t = i / sr;
      // Speed deviation: about +-12 cents of wow, +-3 cents flutter, +-5 cents drift.
      const dev = 0.007 * Math.sin(TAU * wowRate * t + phase) + 0.0017 * Math.sin(TAU * flutterRate * t + phase * 1.7) + 0.003 * drift(t);
      const j = Math.floor(pos);
      const fr = pos - j;
      const a = src[Math.max(0, Math.min(srcLen - 1, j))];
      const b = src[Math.max(0, Math.min(srcLen - 1, j + 1))];
      ch[c][i] = a + (b - a) * fr + hiss[c].next() * 0.004;
      pos += 1 + dev;
    }
    softClipBuffer(ch[c], 1.2);
    applyBiquads(ch[c], sr, [
      { type: 'highpass', freq: 40 },
      { type: 'lowpass', freq: 6500, q: 0.6 },
    ]);
    fadeIn(ch[c], Math.round(0.06 * sr));
    // The swell arrives and cuts into the downbeat with a short fade to silence.
    fadeOut(ch[c], Math.round(0.035 * sr));
  }
  return ch;
}

/* ------------------------------------------------------------------ */
/* Bell hit                                                            */
/* ------------------------------------------------------------------ */

function bellHit(sr: number, rng: Rng): [Buf, Buf] {
  const n = Math.round(3.0 * sr);
  const ch = stereo(n);
  // Church-bell partial family relative to the prime (strike note = C4): hum, prime, tierce, quint, nominal, upper partials.
  const partials: readonly (readonly [number, number, number])[] = [
    [0.5, 0.35, 4.5],
    [1.0, 0.8, 3.6],
    [1.183, 0.5, 2.8],
    [1.506, 0.25, 2.0],
    [2.0, 0.6, 2.6],
    [2.514, 0.25, 1.1],
    [2.662, 0.2, 0.95],
    [3.011, 0.18, 0.8],
    [4.166, 0.12, 0.5],
    [5.433, 0.08, 0.35],
    [6.796, 0.05, 0.25],
  ];
  for (const [ratio, level, t60] of partials) {
    const f = C4 * ratio;
    if (f * 1.01 >= sr * 0.45) continue;
    // Each partial is a slightly split doublet (bell asymmetry) whose beating differs left and right.
    // Unequal halves keep the warble gentle (at most ~8 dB of beating).
    const beat = 0.4 + 1.4 * rng.float();
    const pa = rng.float();
    const pb = rng.float();
    for (let c = 0; c < 2; c++) {
      const split = beat * (c === 0 ? 1 : 1.3);
      addDampedSine(ch[c], f - split / 2, t60, sr, level * 0.7, pa);
      addDampedSine(ch[c], f + split / 2, t60, sr, level * 0.3, pb);
    }
  }
  // Strike: a very short band-passed noise tick.
  const strikeN = Math.round(0.02 * sr);
  for (let c = 0; c < 2; c++) {
    const noise = new WhiteNoise(rng.int(0, 0x7fffffff));
    const bp = new Biquad('bandpass', 3200, 1.2, sr);
    for (let i = 0; i < strikeN; i++) ch[c][i] += bp.process(noise.next()) * 0.35 * Math.exp(-i / (0.003 * sr));
    fadeIn(ch[c], Math.round(0.0008 * sr));
    fadeOut(ch[c], Math.round(0.3 * sr));
  }
  return ch;
}

/* ------------------------------------------------------------------ */
/* Noise riser                                                         */
/* ------------------------------------------------------------------ */

function noiseRiser(sr: number, rng: Rng): [Buf, Buf] {
  const n = Math.round(2.0 * sr);
  const ch = stereo(n);
  const f0 = 220;
  const f1 = 11000;
  for (let c = 0; c < 2; c++) {
    // Independent noise per side keeps the riser wide.
    const noise = new WhiteNoise(rng.int(0, 0x7fffffff));
    const bp = new Biquad('bandpass', f0, 2.2, sr);
    const hp = new Biquad('highpass', f0 * 0.5, Math.SQRT1_2, sr);
    const air = new Biquad('highpass', 4000, Math.SQRT1_2, sr);
    for (let i = 0; i < n; i++) {
      const x = i / n;
      if ((i & 15) === 0) {
        // Exponential sweep, slightly accelerating towards the end.
        const fc = f0 * Math.pow(f1 / f0, Math.pow(x, 1.3));
        bp.tune(fc, 2.2);
        hp.tune(fc * 0.5, Math.SQRT1_2);
      }
      const w = noise.next();
      const swept = bp.process(hp.process(w));
      // Air rises with the sweep so the top stays bright.
      const y = swept * 2.2 + air.process(w) * 0.25 * x * x;
      // The widening band adds ~17 dB by itself; the gain ramp adds ~16 dB more (curved so the rise accelerates).
      ch[c][i] = y * Math.pow(10, (-16 * (1 - x * x)) / 20);
    }
    fadeIn(ch[c], Math.round(0.005 * sr));
    fadeOut(ch[c], Math.round(0.012 * sr));
  }
  return ch;
}

/* ------------------------------------------------------------------ */
/* Vocal "oh"                                                          */
/* ------------------------------------------------------------------ */

function vocalOh(sr: number, rng: Rng): [Buf, Buf] {
  const n = Math.round(1.0 * sr);
  // Glottal source: band-limited saw at C4 with delayed vibrato and slight seeded jitter, tilted by a one-pole low-pass.
  const src = new Float32Array(n);
  const drift = driftFn(rng, [2.5, 5]);
  const tilt = new OnePoleLowpass(900, sr);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const vibDepth = 0.0045 * Math.min(1, Math.max(0, (t - 0.25) / 0.25));
    const f = C4 * (1 + vibDepth * Math.sin(TAU * 5.3 * t) + 0.0012 * drift(t));
    const dt = f / sr;
    // Falling saw (a crude glottal flow derivative) with polyBLEP.
    const saw = 1 - 2 * phase + polyBlep(phase, dt);
    phase += dt;
    if (phase >= 1) phase -= 1;
    src[i] = tilt.process(saw);
  }
  // Formants for "oh": F1 ~450 Hz, F2 ~800 Hz, F3 ~2830 Hz (+ a weak F4 for presence).
  const formants: readonly (readonly [number, number, number])[] = [
    [450, 70, 1.0],
    [800, 80, 0.6],
    [2830, 110, 0.12],
    [3500, 160, 0.05],
  ];
  const voiced = new Float32Array(n);
  for (const [f, bw, g] of formants) {
    const bp = new Biquad('bandpass', f, f / bw, sr);
    for (let i = 0; i < n; i++) voiced[i] += bp.process(src[i]) * g;
  }
  // Chest body: the fundamental region, low-passed.
  const chest = new Biquad('lowpass', 320, 0.8, sr);
  for (let i = 0; i < n; i++) voiced[i] += chest.process(src[i]) * 0.35;

  // Envelope: soft onset, sustain, gentle release.
  const attack = 0.06;
  const releaseAt = 0.78;
  const env = (t: number): number => {
    const a = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1;
    const r = t > releaseAt ? Math.exp((-(t - releaseAt) * 6.9) / 0.2) : 1;
    return a * r;
  };
  const ch = stereo(n);
  const delay = Math.round(0.00025 * sr);
  for (let c = 0; c < 2; c++) {
    // Breath: decorrelated noise through the first two formants, very low.
    const breath = new WhiteNoise(rng.int(0, 0x7fffffff));
    const b1 = new Biquad('bandpass', 800, 3, sr);
    const b2 = new Biquad('bandpass', 2830, 4, sr);
    const d = c === 0 ? 0 : delay;
    for (let i = 0; i < n; i++) {
      const w = breath.next();
      const v = i - d >= 0 ? voiced[i - d] : 0;
      ch[c][i] = (v + (b1.process(w) * 0.02 + b2.process(w) * 0.012)) * env(i / sr);
    }
    fadeOut(ch[c], Math.round(0.02 * sr));
    fadeIn(ch[c], 4);
  }
  return ch;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const GENERATORS: Readonly<Record<string, (sr: number, rng: Rng) => [Buf, Buf]>> = {
  'builtin:glass-chord': glassChord,
  'builtin:tape-swell': tapeSwell,
  'builtin:bell-hit': bellHit,
  'builtin:noise-riser': noiseRiser,
  'builtin:vocal-oh': vocalOh,
};

export function listBuiltinSampleIds(): string[] {
  return BUILTIN_SAMPLES.map((s) => s.id).filter((id) => id in GENERATORS);
}

/**
 * Generate a built-in sample at `sampleRate` (clamped to 8 kHz..192 kHz).
 * Returns null for unknown ids. Deterministic for a given id and rate.
 */
export function generateBuiltinSample(id: string, sampleRate: number): GeneratedSample | null {
  const gen = Object.prototype.hasOwnProperty.call(GENERATORS, id) ? GENERATORS[id] : undefined;
  if (!gen) return null;
  const sr = Number.isFinite(sampleRate) ? Math.min(192000, Math.max(8000, Math.round(sampleRate))) : 48000;
  const channels = gen(sr, new Rng(hashString(id)));
  for (const c of channels) sanitize(c, 8);
  normalizePeakChannels(channels, BUILTIN_PEAK);
  for (const c of channels) {
    sanitize(c, 1);
    // Exact silence at both ends (normalisation cannot move a zero).
    c[0] = 0;
    c[c.length - 1] = 0;
  }
  return { channels, sampleRate: sr };
}

const cache = new Map<string, GeneratedSample>();

/** Memoised `generateBuiltinSample` (per id and rate). The returned arrays are shared: treat as read-only. */
export function getBuiltinSample(id: string, sampleRate: number): GeneratedSample | null {
  const key = `${id}|${Math.round(sampleRate)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = generateBuiltinSample(id, sampleRate);
  if (s) cache.set(key, s);
  return s;
}
