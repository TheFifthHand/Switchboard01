/**
 * The seven studio insert effects (EQ, Compressor, Gate, Auto Pan, Stereo
 * Width, Flanger, Tape), rendered offline in Chromium with known signals and
 * measured: frequency responses, gain reduction and timing, gating depth,
 * pan law and tempo sync, mid/side energy, comb notches and sweeps, harmonic
 * content, pitch drift, hiss, transparency, bypass and click-free changes.
 */
import { describe, expect, it } from 'vitest';
import { loadEngineWorklets } from '../../src/audio/engine';
import { AutoPanModule } from '../../src/audio/modules/autopan';
import { CompressorModule } from '../../src/audio/modules/compressor';
import { EqModule } from '../../src/audio/modules/eq';
import { FlangerModule } from '../../src/audio/modules/flanger';
import { GateModule } from '../../src/audio/modules/gate';
import { TapeModule } from '../../src/audio/modules/tape';
import { WidenerModule } from '../../src/audio/modules/widener';
import { MODULE_CONSTRUCTORS } from '../../src/audio/modules/index';
import type { ModuleEnv, ModuleNode } from '../../src/audio/modules/types';
import type { ParamValues } from '../../src/project/types';
import { SR, correlation, db, diffDb, energy, frames, maxStep, noise, peak, render, rms, sine, sines, thd, toneAmp } from './fx-helpers';

const prepare = (ctx: OfflineAudioContext) => loadEngineWorklets(ctx);
const A = frames(0.2);
const B = frames(0.9);

type Make<M extends ModuleNode> = (env: ModuleEnv) => M;

async function run<M extends ModuleNode>(
  make: Make<M>,
  input: Float32Array | [Float32Array, Float32Array],
  opts: { seconds?: number; mods?: Record<string, number>; at?: [number, (m: M, ctx: OfflineAudioContext) => void][]; setup?: (m: M) => void; seed?: number; bpm?: number } = {},
) {
  return render<M>({ seconds: opts.seconds ?? 1, input, prepare, create: (env) => make(env), mods: opts.mods, at: opts.at, setup: opts.setup, env: { seed: opts.seed, bpm: opts.bpm } });
}

/** Gain (dB) of a sine at `freq` through the module. */
async function gainAt(make: Make<ModuleNode>, freq: number, mods?: Record<string, number>): Promise<number> {
  const { L } = await run(make, sine(freq, 1, 0.25), { mods });
  return db(toneAmp(L, freq, A, B) / 0.25);
}

/** Envelope: RMS × √2 over consecutive windows of `win` frames. */
function env(x: Float32Array, win: number, from = 0, to = x.length): number[] {
  const out: number[] = [];
  for (let i = from; i + win <= to; i += win) out.push(rms(x, i, i + win) * Math.SQRT2);
  return out;
}

/* ------------------------------------------------------------------ */

describe('EQ', () => {
  const eq = (p: ParamValues): Make<EqModule> => (env) => new EqModule(env, 'eq', p);

  it('is transparent at its defaults (cuts off, every band at 0 dB)', async () => {
    const x = noise(1, 0.4);
    const { L, R } = await run(eq({}), x);
    expect(diffDb(L, x, 0, frames(1))).toBeLessThan(-100);
    expect(diffDb(R, x, 0, frames(1))).toBeLessThan(-100);
  });

  it('shelves and the mid band move exactly their own range', async () => {
    const lows = eq({ lowGain: 6, lowFreq: 120 });
    expect(await gainAt(lows, 40)).toBeCloseTo(6, 0);
    expect(Math.abs(await gainAt(lows, 5000))).toBeLessThan(0.2);
    const mids = eq({ midGain: -9, midFreq: 1000, midQ: 0.9 });
    expect(await gainAt(mids, 1000)).toBeCloseTo(-9, 1);
    expect(Math.abs(await gainAt(mids, 60))).toBeLessThan(0.5);
    expect(Math.abs(await gainAt(mids, 15000))).toBeLessThan(0.5);
    const highs = eq({ highGain: 6, highFreq: 4000 });
    expect(await gainAt(highs, 15000)).toBeCloseTo(6, 0);
    expect(Math.abs(await gainAt(highs, 100))).toBeLessThan(0.2);
  });

  it('Mids Width: narrow boosts a single region, wide a broad one', async () => {
    const narrow = await gainAt(eq({ midGain: 12, midFreq: 1000, midQ: 6 }), 2000);
    const wide = await gainAt(eq({ midGain: 12, midFreq: 1000, midQ: 0.3 }), 2000);
    expect(narrow).toBeLessThan(2);
    expect(wide).toBeGreaterThan(8);
  });

  it('low cut and high cut remove what is outside them (12 dB/oct)', async () => {
    const lc = eq({ lowCut: 400 });
    expect(await gainAt(lc, 100)).toBeLessThan(-20);
    expect(Math.abs(await gainAt(lc, 3000))).toBeLessThan(0.3);
    const hc = eq({ highCut: 2000 });
    expect(await gainAt(hc, 8000)).toBeLessThan(-20);
    expect(Math.abs(await gainAt(hc, 200))).toBeLessThan(0.3);
  });

  it('the Mids input sweeps the band (+1200 cents for +0.5), bounded beyond ±1', async () => {
    const make = eq({ midGain: -12, midFreq: 1000, midQ: 2 });
    expect(await gainAt(make, 2000)).toBeGreaterThan(-4);
    expect(await gainAt(make, 2000, { mid: 0.5 })).toBeCloseTo(-12, 0);
    const full = await gainAt(make, 4000, { mid: 1 });
    const over = await gainAt(make, 4000, { mid: 6 });
    expect(Math.abs(full - over)).toBeLessThan(0.05);
  });

  it('a large gain change and switching the low cut on mid-note are click-free', async () => {
    const x = sine(150, 1, 0.5);
    const { L } = await run(eq({}), x, {
      at: [
        [0.3, (m) => m.setParams({ midGain: 15, midFreq: 150 }, 0.3)],
        [0.6, (m) => m.setParams({ midGain: 15, midFreq: 150, lowCut: 300 }, 0.6)],
      ],
    });
    // A 150 Hz sine at 0.5 (+15 dB: 2.8) moves at most 2π·150/48000·2.8 ≈ 0.055 per sample.
    expect(maxStep(L, frames(0.05))).toBeLessThan(0.06);
    expect(db(toneAmp(L, 150, frames(0.4), frames(0.58)) / 0.5)).toBeCloseTo(15, 0);
    expect(db(toneAmp(L, 150, frames(0.75), frames(0.99)) / 0.5)).toBeLessThan(5);
  });
});

/* ------------------------------------------------------------------ */

describe('Compressor', () => {
  const comp = (p: ParamValues): Make<CompressorModule> => (env) => new CompressorModule(env, 'c', p);

  it('reduces a loud tone by the static curve: −6 dBFS at −18 dB, 4:1 loses 9 dB', async () => {
    const { L } = await run(comp({ threshold: -18, ratio: 4, attack: 1, release: 300, makeup: 0, mix: 1 }), sine(1000, 1, 0.5));
    const outDb = db(toneAmp(L, 1000, frames(0.4), B));
    expect(outDb).toBeGreaterThan(-6 - 9 - 0.7);
    expect(outDb).toBeLessThan(-6 - 9 + 0.7);
    // A higher ratio squeezes harder.
    const hard = await run(comp({ threshold: -18, ratio: 20, attack: 1, release: 300 }), sine(1000, 1, 0.5));
    expect(db(toneAmp(hard.L, 1000, frames(0.4), B))).toBeLessThan(outDb - 1.5);
  });

  it('leaves quiet sound untouched and adds exactly its make-up gain', async () => {
    const x = sine(440, 1, 0.02); // −34 dBFS, far below −18 dB
    const { L } = await run(comp({ threshold: -18, ratio: 4 }), x);
    expect(diffDb(L, x, 0, frames(1))).toBeLessThan(-100);
    const up = await run(comp({ threshold: -18, ratio: 4, makeup: 6 }), x);
    expect(db(toneAmp(up.L, 440, A, B) / 0.02)).toBeCloseTo(6, 2);
  });

  it('attack and release follow their time constants', async () => {
    // A square wave (constant level) steps from −40 dBFS to −6 dBFS at 0.5 s and back at 1.0 s.
    const n = frames(1.6);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const loud = i >= frames(0.5) && i < frames(1.0);
      x[i] = (Math.floor((i * 100) / SR) % 2 ? -1 : 1) * (loud ? 0.5 : 0.01);
    }
    const attack = 20;
    const release = 100;
    const { L } = await run(comp({ threshold: -30, ratio: 10, attack, release }), x, { seconds: 1.6 });
    const grAt = (t: number, level: number) => -db(Math.abs(L[frames(t)]) / level);
    const full = (-6 + 30) * (1 - 1 / 10); // 21.6 dB
    expect(grAt(0.95, 0.5)).toBeCloseTo(full, 0);
    // One attack time constant after the step: about 63 % of the way.
    expect(grAt(0.5 + attack / 1000, 0.5) / full).toBeGreaterThan(0.55);
    expect(grAt(0.5 + attack / 1000, 0.5) / full).toBeLessThan(0.72);
    // After the drop the quiet part is still held down, then recovers with the release.
    const g0 = grAt(1.0 + 0.001, 0.01);
    expect(g0).toBeGreaterThan(15);
    expect(grAt(1.0 + release / 1000, 0.01) / g0).toBeGreaterThan(0.3);
    expect(grAt(1.0 + release / 1000, 0.01) / g0).toBeLessThan(0.45);
    expect(grAt(1.55, 0.01)).toBeLessThan(0.5);
  });

  it('evens out loud and quiet passages, and Mix blends the dry sound back (parallel)', async () => {
    // A 440 Hz tone alternating every 250 ms between −6 dBFS and −30 dBFS (5 ms fades).
    const n = frames(1);
    const x = sine(440, 1, 1);
    const fade = frames(0.005);
    for (let i = 0; i < n; i++) {
      const k = i % frames(0.5);
      const loudAmt = k < frames(0.25) ? (k < fade ? 0.5 - 0.5 * Math.cos((Math.PI * k) / fade) : 1) : k < frames(0.25) + fade ? 0.5 + 0.5 * Math.cos((Math.PI * (k - frames(0.25))) / fade) : 0;
      x[i] *= 0.0316 + (0.5 - 0.0316) * loudAmt;
    }
    const spread = (y: Float32Array) => db(rms(y, frames(0.6), frames(0.74)) / rms(y, frames(0.85), frames(0.99)));
    const p = { threshold: -36, ratio: 8, attack: 5, release: 60 };
    const wet = (await run(comp({ ...p, mix: 1 }), x)).L;
    expect(spread(x)).toBeCloseTo(24, 0);
    // Both passages sit above the threshold: 24 dB in becomes 24 / 8 = 3 dB out.
    expect(spread(wet)).toBeLessThan(5);
    const dry = (await run(comp({ ...p, mix: 0 }), x)).L;
    expect(diffDb(dry, x, 0, n)).toBeLessThan(-100);
    const half = (await run(comp({ ...p, mix: 0.5 }), x)).L;
    expect(spread(half)).toBeGreaterThan(spread(wet) + 3);
    expect(spread(half)).toBeLessThan(spread(x) - 3);
  });

  it('the Mix input crossfades, bounded to 0..1', async () => {
    const x = sine(1000, 1, 0.5);
    const p = { threshold: -30, ratio: 10, attack: 1, release: 200 };
    const full = (await run(comp({ ...p, mix: 1 }), x)).L;
    const modded = (await run(comp({ ...p, mix: 0 }), x, { mods: { mix: 4 } })).L;
    expect(diffDb(modded, full, A, B)).toBeLessThan(-80);
  });
});

/* ------------------------------------------------------------------ */

describe('Gate', () => {
  const gate = (p: ParamValues): Make<GateModule> => (env) => new GateModule(env, 'g', p);

  it('passes sound above the threshold untouched and cuts the quiet tail by the Depth', async () => {
    const loud = sine(440, 0.3, 0.3);
    const tail = sine(440, 0.7, 0.001, (2 * Math.PI * 440 * frames(0.3)) / SR); // −60 dBFS
    const x = new Float32Array(frames(1));
    x.set(loud, 0);
    x.set(tail, frames(0.3));
    const { L } = await run(gate({ threshold: -40, range: 60, attack: 1, release: 20 }), x);
    expect(db(toneAmp(L, 440, frames(0.05), frames(0.28)) / 0.3)).toBeCloseTo(0, 2);
    expect(db(toneAmp(L, 440, frames(0.6), frames(0.99)) / 0.001)).toBeLessThan(-50);
    const shallow = await run(gate({ threshold: -40, range: 12, attack: 1, release: 20 }), x);
    expect(db(toneAmp(shallow.L, 440, frames(0.6), frames(0.99)) / 0.001)).toBeCloseTo(-12, 0);
  });

  it('Depth 0 changes nothing, and opening / closing never clicks', async () => {
    const x = noise(1, 0.3, 3, 0.2, 0.5);
    const { L } = await run(gate({ threshold: -20, range: 0 }), x);
    expect(diffDb(L, x, 0, frames(1))).toBeLessThan(-100);
    // 200 Hz bursts at 0.5 alternating every 100 ms with a −54 dB murmur (5 ms raised-cosine fades).
    const bursts = sine(200, 1, 0.5);
    const fade = frames(0.005);
    for (let i = 0; i < bursts.length; i++) {
      const k = i % frames(0.2);
      let level = k < frames(0.1) ? 1 : 0.002;
      if (k < fade) level = 0.002 + (1 - 0.002) * (0.5 - 0.5 * Math.cos((Math.PI * k) / fade));
      else if (k >= frames(0.1) && k < frames(0.1) + fade) level = 1 - (1 - 0.002) * (0.5 - 0.5 * Math.cos((Math.PI * (k - frames(0.1))) / fade));
      bursts[i] *= level;
    }
    const g = await run(gate({ threshold: -30, range: 80, attack: 2, release: 5 }), bursts);
    // The input's own steepest step is about 2π·200/48000·0.5 ≈ 0.013 (plus the fades).
    expect(maxStep(bursts, 1)).toBeLessThan(0.02);
    expect(maxStep(g.L, 1)).toBeLessThan(0.02);
    // And it really gates the murmur.
    expect(rms(g.L, frames(0.17), frames(0.195))).toBeLessThan(rms(bursts, frames(0.17), frames(0.195)) * 0.01);
  });

  it('the Threshold input moves the threshold by 30 dB per full-scale signal', async () => {
    const x = sine(440, 1, 0.03); // −30 dBFS
    const open = await run(gate({ threshold: -50, range: 60, release: 10 }), x);
    expect(db(toneAmp(open.L, 440, A, B) / 0.03)).toBeCloseTo(0, 1);
    const closed = await run(gate({ threshold: -50, range: 60, release: 10 }), x, { mods: { threshold: 1 } }); // −20 dB
    expect(db(toneAmp(closed.L, 440, A, B) / 0.03)).toBeLessThan(-50);
  });
});

/* ------------------------------------------------------------------ */

describe('Auto Pan', () => {
  const pan = (p: ParamValues): Make<AutoPanModule> => (env) => new AutoPanModule(env, 'ap', p);
  const QUARTER = 4; // LFO_DIVISIONS index of '1/4'
  const win = 48; // one 1 kHz cycle

  it('Pan swings a mono part from side to side at the synced rate, at constant power', async () => {
    const x = sine(1000, 2, 0.5);
    const { L, R } = await run(pan({ mode: 0, division: QUARTER, shape: 0, depth: 1 }), x, { seconds: 2, bpm: 120 });
    const eL = env(L, win, frames(0.2), frames(1.9));
    const eR = env(R, win, frames(0.2), frames(1.9));
    const power = eL.map((l, i) => l * l + eR[i] * eR[i]);
    expect(db(Math.sqrt(Math.max(...power) / Math.min(...power)))).toBeLessThan(0.5);
    // Hard left and hard right are both reached.
    const balance = eL.map((l, i) => db(eR[i] + 1e-9) - db(l + 1e-9));
    expect(Math.max(...balance)).toBeGreaterThan(25);
    expect(Math.min(...balance)).toBeLessThan(-25);
    // One full swing per beat (0.5 s at 120 BPM): count right-to-left centre crossings in 1.7 s.
    let crossings = 0;
    for (let i = 1; i < balance.length; i++) if (balance[i - 1] > 0 && balance[i] <= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(3);
    expect(crossings).toBeLessThanOrEqual(4);
  });

  it('Tremolo pulses the level between 1 − Depth and 1', async () => {
    const x = sine(1000, 2, 0.5);
    for (const depth of [1, 0.5]) {
      const { L, R } = await run(pan({ mode: 1, division: QUARTER, depth }), x, { seconds: 2 });
      const e = env(L, win, frames(0.2), frames(1.9)).map((v) => v / 0.5);
      expect(Math.max(...e)).toBeCloseTo(1, 1);
      expect(Math.min(...e)).toBeCloseTo(1 - depth, 1);
      expect(diffDb(R, L, 0, frames(2))).toBeLessThan(-100);
    }
  });

  it('Depth 0 is transparent; the Depth input adds depth, bounded', async () => {
    const x = noise(1, 0.3);
    const { L } = await run(pan({ mode: 0, depth: 0 }), x);
    expect(diffDb(L, x, 0, frames(1))).toBeLessThan(-90);
    const full = await run(pan({ mode: 1, depth: 1, division: QUARTER }), sine(1000, 2, 0.5), { seconds: 2 });
    const over = await run(pan({ mode: 1, depth: 0, division: QUARTER }), sine(1000, 2, 0.5), { seconds: 2, mods: { depth: 5 } });
    expect(diffDb(over.L, full.L, frames(0.2), frames(1.9))).toBeLessThan(-60);
  });

  it('lines up with the transport and follows tempo changes', async () => {
    const x = sine(1000, 2, 0.5);
    // Transport starts at 0.25 s on bar 1: the swing restarts there (sine phase 0, heading right).
    const { L, R } = await run(pan({ mode: 0, division: QUARTER, depth: 1 }), x, {
      seconds: 2,
      setup: (m) => m.transportStarted(0.25, 0, 120),
    });
    const bal = (t: number) => db(rms(R, frames(t - 0.004), frames(t + 0.004))) - db(rms(L, frames(t - 0.004), frames(t + 0.004)));
    expect(bal(0.25 + 0.125)).toBeGreaterThan(20); // quarter cycle: hard right
    expect(bal(0.25 + 0.375)).toBeLessThan(-20); // three quarters: hard left
    // At 60 BPM a quarter note lasts 1 s: the right-hand peak moves to 0.25 + 0.25.
    const slow = await run(pan({ mode: 0, division: QUARTER, depth: 1 }), x, {
      seconds: 2,
      setup: (m) => {
        m.transportStarted(0.25, 0, 120);
        m.setTempo(60, 0.25);
      },
    });
    const bal2 = (t: number) => db(rms(slow.R, frames(t - 0.004), frames(t + 0.004))) - db(rms(slow.L, frames(t - 0.004), frames(t + 0.004)));
    expect(bal2(0.5)).toBeGreaterThan(20);
    expect(bal2(1.0)).toBeLessThan(-20);
  });

  it('Square shape is choppy but click-free; switching mode crossfades', async () => {
    const x = sine(200, 2, 0.5);
    const { L } = await run(pan({ mode: 1, shape: 2, division: 6, depth: 1 }), x, {
      seconds: 2,
      at: [[1.0, (m) => m.setParams({ mode: 0, shape: 2, division: 6, depth: 1 }, 1.0)]],
    });
    // A hard gate on a 0.5 sine would jump by up to 0.5; the rounded edges keep steps small.
    expect(maxStep(L, frames(0.05))).toBeLessThan(0.06);
  });
});

/* ------------------------------------------------------------------ */

describe('Stereo Width', () => {
  const wide = (p: ParamValues): Make<WidenerModule> => (env) => new WidenerModule(env, 'w', p);
  const stereoNoise = (): [Float32Array, Float32Array] => [noise(1, 0.3, 11), noise(1, 0.3, 12)];
  const sideToMid = (L: Float32Array, R: Float32Array) => {
    let m = 0;
    let s = 0;
    for (let i = A; i < B; i++) {
      m += (L[i] + R[i]) ** 2;
      s += (L[i] - R[i]) ** 2;
    }
    return 10 * Math.log10(s / m);
  };

  it('Width 1 with Mono Bass off is transparent', async () => {
    const [l, r] = stereoNoise();
    const { L, R } = await run(wide({ width: 1, monoBass: 20 }), [l, r]);
    expect(diffDb(L, l, 0, frames(1))).toBeLessThan(-100);
    expect(diffDb(R, r, 0, frames(1))).toBeLessThan(-100);
  });

  it('Width 0 is mono, 2 doubles the side signal (+6 dB side-to-mid)', async () => {
    const input = stereoNoise();
    const base = sideToMid(...input);
    const mono = await run(wide({ width: 0, monoBass: 20 }), input);
    expect(correlation(mono.L, mono.R, A, B)).toBeGreaterThan(0.9999);
    const two = await run(wide({ width: 2, monoBass: 20 }), input);
    expect(sideToMid(two.L, two.R) - base).toBeCloseTo(6.02, 1);
    // Mid is untouched.
    let dm = 0;
    let m = 0;
    for (let i = A; i < B; i++) {
      dm += (two.L[i] + two.R[i] - input[0][i] - input[1][i]) ** 2;
      m += (input[0][i] + input[1][i]) ** 2;
    }
    expect(10 * Math.log10(dm / m)).toBeLessThan(-80);
  });

  it('Mono Bass keeps the lows in the centre and leaves the highs wide', async () => {
    // A pure side signal: 50 Hz and 2 kHz in opposite phase on L and R.
    const s = sines([[50, 0.3], [2000, 0.3]], 1);
    const neg = s.map((v) => -v);
    const { L } = await run(wide({ width: 1.4, monoBass: 200 }), [s, neg]);
    expect(db(toneAmp(L, 50, A, B) / 0.3)).toBeLessThan(-18);
    expect(db(toneAmp(L, 2000, A, B) / (0.3 * 1.4))).toBeCloseTo(0, 0);
  });

  it('the Width input breathes the image, bounded to 0..2', async () => {
    const input = stereoNoise();
    const two = await run(wide({ width: 2, monoBass: 20 }), input);
    const over = await run(wide({ width: 1, monoBass: 20 }), input, { mods: { width: 5 } });
    expect(diffDb(over.L, two.L, A, B)).toBeLessThan(-80);
    const under = await run(wide({ width: 1, monoBass: 20 }), input, { mods: { width: -5 } });
    expect(correlation(under.L, under.R, A, B)).toBeGreaterThan(0.9999);
  });
});

/* ------------------------------------------------------------------ */

describe('Flanger', () => {
  const fl = (p: ParamValues): Make<FlangerModule> => (env) => new FlangerModule(env, 'f', p);

  it('Mix 0 is transparent', async () => {
    const x = noise(1, 0.3);
    const { L } = await run(fl({ mix: 0, feedback: 0.85, depth: 1 }), x);
    expect(diffDb(L, x, 0, frames(1))).toBeLessThan(-100);
  });

  it('a still delay of 0.3 ms makes the comb: a notch at 1667 Hz, full level at 3333 Hz', async () => {
    const make = fl({ depth: 0, feedback: 0, mix: 0.5 });
    expect(await gainAt(make, 1 / (2 * 0.0003))).toBeLessThan(-25);
    expect(Math.abs(await gainAt(make, 1 / 0.0003))).toBeLessThan(0.5);
  });

  it('sweeps the notches across the spectrum', async () => {
    const freqs = [300, 600, 1200, 2400, 4800];
    const x = sines(freqs.map((f) => [f, 0.1] as [number, number]), 2.2);
    const { L } = await run(fl({ rate: 0.5, depth: 1, feedback: 0, mix: 0.5 }), x, { seconds: 2.2 });
    const w = frames(0.04);
    let moving = 0;
    for (const f of freqs) {
      const g: number[] = [];
      for (let i = frames(0.2); i + w < frames(2.2); i += w) g.push(db(toneAmp(L, f, i, i + w) / 0.1));
      if (Math.max(...g) - Math.min(...g) > 15) moving++;
    }
    expect(moving).toBeGreaterThanOrEqual(4);
  });

  it('feedback stays bounded (clamped at 0.85) and the stereo sides differ', async () => {
    const x = noise(1.5, 0.3);
    const max = await run(fl({ depth: 1, rate: 1, feedback: 0.85, mix: 0.5 }), x, { seconds: 1.5 });
    const over = await run(fl({ depth: 1, rate: 1, feedback: 50, mix: 0.5 }), x, { seconds: 1.5 });
    expect(diffDb(over.L, max.L, 0, frames(1.5))).toBeLessThan(-100);
    expect(peak(max.L).value).toBeLessThan(3);
    expect(Math.abs(db(rms(max.L, frames(0.2), frames(1.4)) / rms(x, frames(0.2), frames(1.4))))).toBeLessThan(6);
    expect(correlation(max.L, max.R, frames(0.2), frames(1.4))).toBeLessThan(0.95);
  });

  it('Mute All (flush) clears the ringing delay line at once', async () => {
    // Noise that stops at 0.098 s; the flush lands on the render quantum around 0.1 s.
    const x = noise(1, 0.3, 4, 0, 0.098);
    const p = { depth: 0, feedback: 0.85, mix: 1 };
    const ringing = await run(fl(p), x);
    expect(energy(ringing.L, frames(0.102), frames(0.11))).toBeGreaterThan(1e-6);
    const flushed = await run(fl(p), x, { at: [[0.1, (m) => m.flush()]] });
    expect(peak(flushed.L, frames(0.102)).value).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('Tape', () => {
  const tape = (p: ParamValues): Make<TapeModule> => (env) => new TapeModule(env, 't', p);
  const clean = { wobble: 0, tone: 1, hiss: 0, mix: 1 };

  it('saturation adds harmonics that grow with Saturation, odd and even', async () => {
    const x = sine(500, 1, 0.25); // −12 dBFS
    const values: number[] = [];
    for (const drive of [0, 0.3, 0.6, 1]) values.push(thd((await run(tape({ ...clean, drive }), x)).L, 500, A, B));
    expect(values[0]).toBeLessThan(0.002);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[3]).toBeGreaterThan(0.05);
    const { L } = await run(tape({ ...clean, drive: 0.6 }), x);
    expect(toneAmp(L, 1000, A, B) / toneAmp(L, 500, A, B)).toBeGreaterThan(0.003);
  });

  it('is level-compensated: full Saturation keeps a −12 dBFS tone within 3 dB', async () => {
    const x = sine(440, 1, 0.25);
    const { L } = await run(tape({ ...clean, drive: 1 }), x);
    expect(Math.abs(db(rms(L, A, B) / rms(x, A, B)))).toBeLessThan(3);
  });

  it('Wobble drifts the pitch by a few cents; Wobble 0 holds it steady', async () => {
    const x = sine(1000, 4, 0.3);
    const drift = async (wobble: number) => {
      const { L } = await run(tape({ ...clean, drive: 0, wobble }), x, { seconds: 4 });
      // Upward zero crossings (interpolated) → local frequency over 20-cycle windows.
      const zc: number[] = [];
      for (let i = frames(0.6); i < frames(3.9); i++) if (L[i - 1] < 0 && L[i] >= 0) zc.push(i - 1 + L[i - 1] / (L[i - 1] - L[i]));
      let worst = 0;
      for (let k = 0; k + 20 < zc.length; k += 20) worst = Math.max(worst, Math.abs(1200 * Math.log2((20 * SR) / (zc[k + 20] - zc[k]) / 1000)));
      return worst;
    };
    expect(await drift(0)).toBeLessThan(0.2);
    const wobbly = await drift(1);
    expect(wobbly).toBeGreaterThan(3);
    expect(wobbly).toBeLessThan(25);
  });

  it('Tone darkens the top end', async () => {
    const x = sines([[300, 0.2], [8000, 0.2]], 1);
    const bright = await run(tape({ ...clean, drive: 0, tone: 1 }), x);
    const dark = await run(tape({ ...clean, drive: 0, tone: 0 }), x);
    expect(db(toneAmp(dark.L, 8000, A, B) / toneAmp(bright.L, 8000, A, B))).toBeLessThan(-12);
    expect(Math.abs(db(toneAmp(dark.L, 300, A, B) / toneAmp(bright.L, 300, A, B)))).toBeLessThan(0.5);
  });

  it('hiss follows the music: audible under a tone, silence stays silent; seeded', async () => {
    const x = sine(440, 1, 0.3);
    const band = (y: Float32Array) => {
      // Energy away from the tone's harmonics: a 9–11 kHz band via a crude DFT sum.
      let s = 0;
      for (let f = 9000; f <= 11000; f += 250) s += toneAmp(y, f + 37, A, B) ** 2;
      return s;
    };
    const quiet = await run(tape({ ...clean, drive: 0, hiss: 0 }), x, { seed: 5 });
    const hissy = await run(tape({ ...clean, drive: 0, hiss: 1 }), x, { seed: 5 });
    expect(10 * Math.log10(band(hissy.L) / Math.max(band(quiet.L), 1e-30))).toBeGreaterThan(20);
    // Well below the music itself.
    let n = 0;
    for (let i = A; i < B; i++) n += (hissy.L[i] - quiet.L[i]) ** 2;
    expect(10 * Math.log10(n / energy(quiet.L, A, B))).toBeLessThan(-20);
    const again = await run(tape({ ...clean, drive: 0, hiss: 1 }), x, { seed: 5 });
    expect(diffDb(again.L, hissy.L, 0, frames(1))).toBeLessThan(-120);
    const other = await run(tape({ ...clean, drive: 0, hiss: 1 }), x, { seed: 6 });
    expect(diffDb(other.L, hissy.L, A, B)).toBeGreaterThan(-40);
    const silent = await run(tape({ drive: 1, wobble: 1, hiss: 1 }), new Float32Array(frames(1)));
    expect(peak(silent.L).value).toBe(0);
  });

  it('Mix 0 keeps the clean tone (magnitude untouched), the Saturation input pushes harder', async () => {
    const x = sines([[200, 0.2], [3000, 0.2]], 1);
    const dry = await run(tape({ drive: 1, wobble: 0.5, hiss: 1, tone: 0, mix: 0 }), x);
    for (const f of [200, 3000]) expect(Math.abs(db(toneAmp(dry.L, f, A, B) / 0.2))).toBeLessThan(0.05);
    const y = sine(500, 1, 0.25);
    const pushed = thd((await run(tape({ ...clean, drive: 0 }), y, { mods: { drive: 0.6 } })).L, 500, A, B);
    const knob = thd((await run(tape({ ...clean, drive: 0.6 }), y)).L, 500, A, B);
    expect(Math.abs(db(pushed / knob))).toBeLessThan(0.5);
  });
});

/* ------------------------------------------------------------------ */

describe('bypass and catalogue', () => {
  const cases: [string, Make<ModuleNode>][] = [
    ['eq', (env) => new EqModule(env, 'e', { lowCut: 300, midGain: 12, highCut: 3000 })],
    ['compressor', (env) => new CompressorModule(env, 'c', { threshold: -40, ratio: 20, makeup: 12 })],
    ['gate', (env) => new GateModule(env, 'g', { threshold: 0, range: 80 })],
    ['autopan', (env) => new AutoPanModule(env, 'a', { depth: 1, mode: 1 })],
    ['widener', (env) => new WidenerModule(env, 'w', { width: 2, monoBass: 300 })],
    ['flanger', (env) => new FlangerModule(env, 'f', { depth: 1, feedback: 0.85, mix: 0.7 })],
    ['tape', (env) => new TapeModule(env, 't', { drive: 1, wobble: 1, hiss: 1, tone: 0 })],
  ];
  for (const [name, make] of cases) {
    it(`${name}: bypass returns the input unchanged, and it really processes when on`, async () => {
      const x: [Float32Array, Float32Array] = [noise(1, 0.4, 7), noise(1, 0.4, 8)];
      const off = await run(make, x, { setup: (m) => m.setBypass(true, 0) });
      expect(diffDb(off.L, x[0], frames(0.2), frames(1))).toBeLessThan(-100);
      expect(diffDb(off.R, x[1], frames(0.2), frames(1))).toBeLessThan(-100);
      const on = await run(make, x);
      expect(diffDb(on.L, x[0], frames(0.2), frames(1))).toBeGreaterThan(-30);
    });
  }

  it('every effect type has a real implementation registered', () => {
    for (const t of ['eq', 'compressor', 'gate', 'autopan', 'widener', 'flanger', 'tape'] as const) {
      expect(MODULE_CONSTRUCTORS[t].name).not.toMatch(/Pending/);
    }
  });
});
