/**
 * Fixtures and measurements for effect-module browser tests: build a module
 * on an OfflineAudioContext(2, n, 48000), feed a known signal, optionally
 * drive modulation ports with constants and apply changes mid-render, then
 * measure the rendered audio numerically.
 */
import { expect } from 'vitest';
import type { InstrumentContext, InstrumentFactory } from '../../src/audio/contracts';
import type { ModuleEnv, ModuleNode } from '../../src/audio/modules/types';
import { Rng } from '../../src/project/rng';

export const SR = 48000;

export function makeEnv(ctx: BaseAudioContext, opts: { seed?: number; bpm?: number; offline?: boolean } = {}): ModuleEnv {
  const bpm = opts.bpm ?? 120;
  return {
    ctx,
    seed: opts.seed ?? 1234,
    getBpm: () => bpm,
    instrumentFactory: (() => {
      throw new Error('effects do not build instruments');
    }) as InstrumentFactory,
    instrumentContext: {} as InstrumentContext,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    offline: opts.offline ?? true,
  };
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

export function frames(seconds: number): number {
  return Math.round(seconds * SR);
}

export function sine(freq: number, seconds: number, amp = 0.5, phase = 0): Float32Array {
  const n = frames(seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return x;
}

export function sines(parts: [freq: number, amp: number][], seconds: number): Float32Array {
  const n = frames(seconds);
  const x = new Float32Array(n);
  for (const [f, a] of parts) for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f * i) / SR);
  return x;
}

/** Seeded white noise between `start` and `end` seconds (silence elsewhere). */
export function noise(seconds: number, amp: number, seed = 7, start = 0, end = seconds): Float32Array {
  const n = frames(seconds);
  const x = new Float32Array(n);
  const rng = new Rng(seed);
  const a = frames(start);
  const b = Math.min(n, frames(end));
  for (let i = a; i < b; i++) x[i] = amp * rng.noise();
  return x;
}

/** Single-sample impulses at the given times. */
export function impulses(seconds: number, at: number[], amp = 1): Float32Array {
  const x = new Float32Array(frames(seconds));
  for (const t of at) x[frames(t)] = amp;
  return x;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export interface RenderSpec<M extends ModuleNode> {
  seconds: number;
  /** Mono (sent to both channels) or [L, R]. */
  input: Float32Array | [Float32Array, Float32Array];
  create: (env: ModuleEnv, ctx: OfflineAudioContext) => M;
  env?: { seed?: number; bpm?: number };
  /** Before construction (e.g. load a worklet). */
  prepare?: (ctx: OfflineAudioContext) => Promise<void>;
  /** After construction, before rendering (time 0). */
  setup?: (m: M, ctx: OfflineAudioContext) => void;
  /** Constant signals into modulation ports. */
  mods?: Record<string, number>;
  /** Changes applied mid-render at the given context times (quantised to 128 frames). */
  at?: [time: number, fn: (m: M, ctx: OfflineAudioContext) => void][];
}

export interface Rendered<M> {
  L: Float32Array;
  R: Float32Array;
  module: M;
}

export async function render<M extends ModuleNode>(spec: RenderSpec<M>): Promise<Rendered<M>> {
  const n = frames(spec.seconds);
  const ctx = new OfflineAudioContext(2, n, SR);
  if (spec.prepare) await spec.prepare(ctx);
  const env = makeEnv(ctx, { ...spec.env, offline: true });
  const m = spec.create(env, ctx);
  const buf = ctx.createBuffer(2, n, SR);
  const [inL, inR] = Array.isArray(spec.input) ? spec.input : [spec.input, spec.input];
  buf.copyToChannel(fit(inL, n), 0);
  buf.copyToChannel(fit(inR, n), 1);
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  const input = m.input('in');
  const output = m.output('out');
  if (!input || !output) throw new Error('module has no audio ports');
  src.connect(input);
  output.connect(ctx.destination);
  for (const [port, value] of Object.entries(spec.mods ?? {})) {
    const target = m.input(port);
    if (!target) throw new Error(`no mod port ${port}`);
    const c = new ConstantSourceNode(ctx, { offset: value });
    c.connect(target);
    c.start(0);
  }
  spec.setup?.(m, ctx);
  for (const [time, fn] of spec.at ?? []) {
    void ctx.suspend(time).then(() => {
      fn(m, ctx);
      void ctx.resume();
    });
  }
  src.start(0);
  const out = await ctx.startRendering();
  const L = out.getChannelData(0).slice();
  const R = out.getChannelData(1).slice();
  expectFinite(L);
  expectFinite(R);
  m.dispose();
  return { L, R, module: m };
}

function fit(x: Float32Array, n: number): Float32Array<ArrayBuffer> {
  const y = new Float32Array(n);
  y.set(x.subarray(0, n));
  return y;
}

/* ------------------------------------------------------------------ */
/* Measurements                                                        */
/* ------------------------------------------------------------------ */

export function expectFinite(x: Float32Array): void {
  let bad = -1;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) {
      bad = i;
      break;
    }
  }
  expect(bad, 'first non-finite sample').toBe(-1);
}

export function db(v: number): number {
  return 20 * Math.log10(Math.max(v, 1e-12));
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function energy(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) s += x[i] * x[i];
  return s;
}

export function peak(x: Float32Array, from = 0, to = x.length): { value: number; index: number } {
  let value = 0;
  let index = from;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) {
    const a = Math.abs(x[i]);
    if (a > value) {
      value = a;
      index = i;
    }
  }
  return { value, index };
}

/** Largest sample-to-sample jump. */
export function maxStep(x: Float32Array, from = 1, to = x.length): number {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

/** Largest second difference (curvature spike: a click shows up here). */
export function maxCurvature(x: Float32Array, from = 2, to = x.length): number {
  let m = 0;
  for (let i = Math.max(2, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
  return m;
}

/** Amplitude of a sinusoid at `freq` in x[from, to) (Hann-windowed DFT bin). */
export function toneAmp(x: Float32Array, freq: number, from: number, to: number): number {
  const n = to - from;
  const w0 = (2 * Math.PI * freq) / SR;
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const v = x[from + i] * w;
    re += v * Math.cos(w0 * i);
    im -= v * Math.sin(w0 * i);
    wsum += w;
  }
  return (2 * Math.sqrt(re * re + im * im)) / wsum;
}

/** Total harmonic distortion (harmonics 2..10 relative to the fundamental). */
export function thd(x: Float32Array, f0: number, from: number, to: number): number {
  const a1 = toneAmp(x, f0, from, to);
  let h = 0;
  for (let k = 2; k <= 10; k++) {
    if (k * f0 >= SR / 2) break;
    h += toneAmp(x, k * f0, from, to) ** 2;
  }
  return Math.sqrt(h) / Math.max(a1, 1e-12);
}

/** RMS of (a[i] - b[i - lag]) over [from, to), relative to rms(b) in dB. */
export function diffDb(a: Float32Array, b: Float32Array, from: number, to: number, lag = 0): number {
  let s = 0;
  let r = 0;
  for (let i = from; i < to; i++) {
    const d = a[i] - b[i - lag];
    s += d * d;
    r += b[i - lag] * b[i - lag];
  }
  return db(Math.sqrt(s / Math.max(r, 1e-24)));
}

/** Lag in [0, maxLag] that best aligns a (delayed) with b. */
export function bestLag(a: Float32Array, b: Float32Array, from: number, to: number, maxLag: number): number {
  let best = 0;
  let bestErr = Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = from; i < to; i++) {
      const d = a[i] - b[i - lag];
      s += d * d;
    }
    if (s < bestErr) {
      bestErr = s;
      best = lag;
    }
  }
  return best;
}

export function correlation(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = from; i < to; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(Math.max(aa * bb, 1e-30));
}
