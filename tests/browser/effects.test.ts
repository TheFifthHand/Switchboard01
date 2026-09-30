/**
 * Filter, Drive, Chorus and Phaser rendered offline with known signals and
 * measured: attenuation, resonance, shelving, modulation, harmonic content,
 * transparency at zero settings, click-free switching and bypass.
 */
import { describe, expect, it } from 'vitest';
import { ChorusModule } from '../../src/audio/modules/chorus';
import { DelayModule } from '../../src/audio/modules/delay';
import { DriveModule } from '../../src/audio/modules/drive';
import { FilterModule } from '../../src/audio/modules/filter';
import { PhaserModule } from '../../src/audio/modules/phaser';
import { ReverbModule } from '../../src/audio/modules/reverb';
import type { ModuleEnv, ModuleNode } from '../../src/audio/modules/types';
import type { ParamValues } from '../../src/project/types';
import {
  SR,
  bestLag,
  correlation,
  db,
  diffDb,
  frames,
  maxStep,
  noise,
  peak,
  render,
  rms,
  saw,
  sine,
  sines,
  squareBuffer,
  thd,
  toneAmp,
} from './fx-helpers';

const A = frames(0.2);
const B = frames(0.9);

async function filterTone(freq: number, params: ParamValues, mods?: Record<string, number>): Promise<number> {
  const { L } = await render({
    seconds: 1,
    input: sine(freq, 1, 0.5),
    create: (env, _ctx) => new FilterModule(env, 'f', params),
    mods,
  });
  return db(toneAmp(L, freq, A, B) / 0.5);
}

describe('FilterModule', () => {
  it('low-pass at 500 Hz removes more than 20 dB of a 5 kHz tone and passes 100 Hz', async () => {
    const lp = { mode: 0, cutoff: 500, resonance: 0 };
    expect(await filterTone(5000, lp)).toBeLessThan(-20);
    expect(await filterTone(100, lp)).toBeGreaterThan(-1);
  });

  it('resonance raises the level at the cutoff', async () => {
    const flat = await filterTone(1000, { mode: 0, cutoff: 1000, resonance: 0 });
    const res = await filterTone(1000, { mode: 0, cutoff: 1000, resonance: 1 });
    expect(res - flat).toBeGreaterThan(12);
    // Bounded: the peak is trimmed well below the raw +21.6 dB of Q = 12.
    expect(res).toBeLessThan(18);
  });

  it('high-pass removes lows and keeps highs', async () => {
    const hp = { mode: 1, cutoff: 2000, resonance: 0.1 };
    expect(await filterTone(100, hp)).toBeLessThan(-40);
    expect(await filterTone(10000, hp)).toBeGreaterThan(-1);
  });

  it('band-pass keeps the middle', async () => {
    const bp = { mode: 2, cutoff: 1000, resonance: 0.5 };
    expect(await filterTone(1000, bp)).toBeGreaterThan(-1);
    expect(await filterTone(100, bp)).toBeLessThan(-15);
    expect(await filterTone(10000, bp)).toBeLessThan(-15);
  });

  it('brightness shelf changes high-frequency energy only', async () => {
    const base = await filterTone(10000, { bright: 0 });
    const up = await filterTone(10000, { bright: 12 });
    const down = await filterTone(10000, { bright: -12 });
    expect(up - base).toBeGreaterThan(9);
    expect(down - base).toBeLessThan(-9);
    const lowBase = await filterTone(200, { bright: 0 });
    const lowUp = await filterTone(200, { bright: 12 });
    expect(Math.abs(lowUp - lowBase)).toBeLessThan(0.5);
  });

  it('cutoff modulation input moves the cutoff (±4800 cents, bounded)', async () => {
    const lp = { mode: 0, cutoff: 500, resonance: 0 };
    const still = await filterTone(2000, lp);
    const up = await filterTone(2000, lp, { cutoff: 0.5 }); // +2400 ct -> 2 kHz
    expect(up - still).toBeGreaterThan(12);
    const down = await filterTone(300, lp, { cutoff: -0.5 }); // -> 125 Hz
    expect(down).toBeLessThan((await filterTone(300, lp)) - 10);
    // A signal beyond full scale is clamped to +4800 ct (8 kHz), not further.
    const full = await filterTone(12000, lp, { cutoff: 1 });
    const over = await filterTone(12000, lp, { cutoff: 6 });
    expect(Math.abs(over - full)).toBeLessThan(0.1);
  });

  it('square-wave cutoff modulation at full resonance stays bounded and still sweeps', async () => {
    // A saw through a Q = 12 filter whose cutoff a square LFO throws ±4 octaves
    // at 14.7 Hz (1/16 notes at 220 BPM, depth 1). Without slew limiting,
    // Chromium's direct-form biquad rings up to peaks of 10-30 here.
    const x = saw(110, 2, 0.5);
    const lfoHz = 14.7;
    const period = 1 / lfoHz;
    for (const mode of [0, 1]) {
      const { L } = await render({
        seconds: 2,
        input: x,
        create: (env, ctx) => {
          const m = new FilterModule(env, 'f', { mode, cutoff: 1000, resonance: 1 });
          const lfo = new AudioBufferSourceNode(ctx, { buffer: squareBuffer(ctx, lfoHz) });
          lfo.connect(m.input('cutoff') as AudioNode);
          lfo.start(0);
          return m;
        },
      });
      expect(peak(L, frames(0.1)).value, `mode ${mode}`).toBeLessThan(2);
      if (mode === 1) {
        // High-pass: cutoff up (16 kHz) removes the saw, cutoff down (62 Hz) passes it.
        let up = 0;
        let down = 0;
        for (let k = 2; k < 26; k++) {
          up += rms(L, frames((k + 0.15) * period), frames((k + 0.45) * period)) ** 2;
          down += rms(L, frames((k + 0.65) * period), frames((k + 0.95) * period)) ** 2;
        }
        expect(10 * Math.log10(up / down)).toBeLessThan(-15);
      }
    }
  });

  it('switching mode mid-note is click-free', async () => {
    const x = sine(200, 1, 0.5);
    const { L } = await render({
      seconds: 1,
      input: x,
      create: (env) => new FilterModule(env, 'f', { mode: 0, cutoff: 1000, resonance: 0.3 }),
      at: [[0.5, (m) => m.setParams({ mode: 1, cutoff: 1000, resonance: 0.3 }, 0.5)]],
    });
    // The input's own largest step is 2*pi*200/48000*0.5 ~ 0.013.
    expect(maxStep(L, frames(0.05))).toBeLessThan(0.02);
    // And the switch really happened: high-pass removes most of 200 Hz.
    expect(db(toneAmp(L, 200, frames(0.6), frames(0.95)) / 0.5)).toBeLessThan(-20);
  });
});

async function driveRender(input: Float32Array, params: ParamValues, mods?: Record<string, number>, seconds = 1) {
  return render({ seconds, input, create: (env) => new DriveModule(env, 'd', params), mods });
}

describe('DriveModule', () => {
  it('adds harmonics that grow with amount', async () => {
    const f0 = 750;
    const values: number[] = [];
    for (const amount of [0.05, 0.2, 0.5, 1]) {
      const { L } = await driveRender(sine(f0, 1, 0.5), { amount, tone: 1, mix: 1 });
      values.push(thd(L, f0, A, B));
    }
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[0]).toBeLessThan(0.02);
    expect(values[3]).toBeGreaterThan(0.2);
  });

  it('amount 0 is transparent (only the fixed oversampling latency)', async () => {
    const x = sines([[220, 0.3], [1000, 0.2], [5000, 0.1]], 1);
    const { L } = await driveRender(x, { amount: 0, character: 1, tone: 0, mix: 1 });
    const lag = bestLag(L, x, frames(0.2), frames(0.4), 512);
    expect(lag).toBeLessThan(frames(0.005));
    expect(diffDb(L, x, frames(0.1), frames(0.9), lag)).toBeLessThan(-60);
  });

  it('is loudness-compensated: full drive stays within a few dB of clean', async () => {
    const x = sine(440, 1, 0.3);
    const clean = rms(x, A, B);
    for (const character of [0, 1, 2]) {
      const { L } = await driveRender(x, { amount: 1, character, tone: 0.7, mix: 1 });
      expect(Math.abs(db(rms(L, A, B) / clean)), `character ${character}`).toBeLessThan(4);
    }
  });

  it('characters sound different', async () => {
    const x = sine(440, 1, 0.4);
    const warm = (await driveRender(x, { amount: 0.6, character: 0, tone: 1 })).L;
    const hard = (await driveRender(x, { amount: 0.6, character: 1, tone: 1 })).L;
    const fold = (await driveRender(x, { amount: 0.6, character: 2, tone: 1 })).L;
    expect(diffDb(fold, warm, A, B)).toBeGreaterThan(-10);
    expect(diffDb(hard, warm, A, B)).toBeGreaterThan(-30);
    // Folding moves energy into high harmonics.
    expect(thd(fold, 440, A, B)).toBeGreaterThan(thd(warm, 440, A, B));
  });

  it('mix blends clean and driven signals', async () => {
    const x = sine(750, 1, 0.5);
    const full = thd((await driveRender(x, { amount: 0.7, mix: 1, tone: 1 })).L, 750, A, B);
    const half = thd((await driveRender(x, { amount: 0.7, mix: 0.3, tone: 1 })).L, 750, A, B);
    const none = thd((await driveRender(x, { amount: 0.7, mix: 0, tone: 1 })).L, 750, A, B);
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(none);
    expect(none).toBeLessThan(1e-3);
  });

  it('amount modulation input adds drive in normalised units, bounded', async () => {
    const x = sine(750, 1, 0.5);
    const pushed = thd((await driveRender(x, { amount: 0, tone: 1 }, { amount: 0.5 })).L, 750, A, B);
    const knob = thd((await driveRender(x, { amount: 0.5, tone: 1 })).L, 750, A, B);
    expect(pushed).toBeGreaterThan(0.1);
    expect(Math.abs(db(pushed / knob))).toBeLessThan(0.5);
    // Pulling below zero is clean; pushing far beyond full scale equals full drive.
    const pulled = thd((await driveRender(x, { amount: 0.5, tone: 1 }, { amount: -3 })).L, 750, A, B);
    expect(pulled).toBeLessThan(1e-3);
    const over = (await driveRender(x, { amount: 1, tone: 1 }, { amount: 5 })).L;
    const top = (await driveRender(x, { amount: 1, tone: 1 })).L;
    expect(diffDb(over, top, A, B)).toBeLessThan(-80);
  });

  it('switching character is click-free', async () => {
    const x = sine(110, 1, 0.4);
    const params = { amount: 0.3, character: 0, tone: 0.5 };
    const { L } = await render({
      seconds: 1,
      input: x,
      create: (env) => new DriveModule(env, 'd', params),
      at: [[0.5, (m) => m.setParams({ ...params, character: 1 }, 0.5)]],
    });
    const before = maxStep(L, frames(0.2), frames(0.48));
    const after = maxStep(L, frames(0.6), frames(0.95));
    const around = maxStep(L, frames(0.48), frames(0.6));
    expect(around).toBeLessThan(Math.max(before, after) * 1.2);
  });
});

describe('ChorusModule', () => {
  it('mix 0 is transparent', async () => {
    const x = sine(440, 1, 0.5);
    const { L, R } = await render({ seconds: 1, input: x, create: (env) => new ChorusModule(env, 'c', { mix: 0, depth: 1, rate: 2 }) });
    expect(diffDb(L, x, 0, frames(1))).toBeLessThan(-100);
    expect(diffDb(R, x, 0, frames(1))).toBeLessThan(-100);
  });

  it('depth 0 is a pure 14 ms (L) / 19 ms (R) delay', async () => {
    const x = noise(1, 0.3);
    const { L, R } = await render({ seconds: 1, input: x, create: (env) => new ChorusModule(env, 'c', { mix: 1, depth: 0, rate: 1 }) });
    expect(bestLag(L, x, frames(0.3), frames(0.4), 1200)).toBe(frames(0.014));
    expect(bestLag(R, x, frames(0.3), frames(0.4), 1200)).toBe(frames(0.019));
  });

  it('sweeps each line by up to ±3 ms with the two LFOs 90 degrees apart', async () => {
    const x = noise(1.2, 0.3);
    const { L, R } = await render({ seconds: 1.2, input: x, create: (env) => new ChorusModule(env, 'c', { mix: 1, depth: 1, rate: 1 }) });
    // Measure the local delay where each LFO is at a turning point (delay momentarily still).
    const lagAt = (y: Float32Array, t: number) => bestLag(y, x, frames(t - 0.003), frames(t + 0.003), 1200) / SR;
    expect(lagAt(L, 0.25)).toBeCloseTo(0.017, 3); // sin peak: 14 + 3 ms
    expect(lagAt(L, 0.75)).toBeCloseTo(0.011, 3); // sin trough: 14 - 3 ms
    expect(lagAt(R, 0.5)).toBeCloseTo(0.016, 3); // cos trough: 19 - 3 ms
    expect(lagAt(R, 1.0)).toBeCloseTo(0.022, 3); // cos peak: 19 + 3 ms
  });

  it('modulates over time and widens the stereo image', async () => {
    const x = sine(440, 2, 0.5);
    const { L, R } = await render({ seconds: 2, input: x, create: (env) => new ChorusModule(env, 'c', { mix: 0.5, depth: 1, rate: 2 }) });
    const win = frames(0.01);
    const levels: number[] = [];
    for (let i = frames(0.1); i + win < frames(1.9); i += win) levels.push(rms(L, i, i + win));
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    const sd = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length);
    expect(sd / mean).toBeGreaterThan(0.1);
    expect(correlation(L, R, frames(0.1), frames(1.9))).toBeLessThan(0.9);
  });

  it('mix modulation crossfades to fully wet, bounded', async () => {
    const x = noise(1, 0.3);
    const wet = (await render({ seconds: 1, input: x, create: (env) => new ChorusModule(env, 'c', { mix: 1, depth: 0.5 }) })).L;
    const modded = (await render({ seconds: 1, input: x, create: (env) => new ChorusModule(env, 'c', { mix: 0, depth: 0.5 }), mods: { mix: 4 } })).L;
    expect(diffDb(modded, wet, frames(0.1), frames(0.9))).toBeLessThan(-80);
  });
});

describe('PhaserModule', () => {
  it('mix 0 is transparent', async () => {
    const x = noise(1, 0.3);
    const { L } = await render({ seconds: 1, input: x, create: (env) => new PhaserModule(env, 'p', { mix: 0, feedback: 0.8 }) });
    expect(diffDb(L, x, 0, frames(1))).toBeLessThan(-100);
  });

  it('sweeps notches across the spectrum over time', async () => {
    const freqs = [300, 500, 800, 1200, 1800, 2700];
    const x = sines(freqs.map((f) => [f, 0.1] as [number, number]), 2.2);
    const { L } = await render({ seconds: 2.2, input: x, create: (env) => new PhaserModule(env, 'p', { mix: 0.5, depth: 1, rate: 1, feedback: 0 }) });
    const win = frames(0.04);
    let deepest = 0;
    let moving = 0;
    for (const f of freqs) {
      const g: number[] = [];
      for (let i = frames(0.2); i + win < frames(2.2); i += win) g.push(db(toneAmp(L, f, i, i + win) / 0.1));
      const range = Math.max(...g) - Math.min(...g);
      if (range > 10) moving++;
      deepest = Math.min(deepest, Math.min(...g));
    }
    expect(moving).toBeGreaterThanOrEqual(3);
    expect(deepest).toBeLessThan(-15);
  });

  it('feedback colours the sound but stays bounded (params clamp at 0.8)', async () => {
    const x = noise(1.5, 0.3);
    const noFb = (await render({ seconds: 1.5, input: x, create: (env) => new PhaserModule(env, 'p', { mix: 1, feedback: 0 }) })).L;
    const maxFb = (await render({ seconds: 1.5, input: x, create: (env) => new PhaserModule(env, 'p', { mix: 1, feedback: 0.8 }) })).L;
    const over = (await render({ seconds: 1.5, input: x, create: (env) => new PhaserModule(env, 'p', { mix: 1, feedback: 50 }) })).L;
    expect(diffDb(maxFb, noFb, frames(0.2), frames(1.4))).toBeGreaterThan(-15);
    expect(diffDb(over, maxFb, frames(0.2), frames(1.4))).toBeLessThan(-100);
    expect(peak(maxFb).value).toBeLessThan(3);
    expect(Math.abs(db(rms(maxFb, frames(0.2), frames(1.4)) / rms(x, frames(0.2), frames(1.4))))).toBeLessThan(6);
  });
});

describe('bypass', () => {
  const cases: [string, (env: ModuleEnv) => ModuleNode][] = [
    ['filter', (env) => new FilterModule(env, 'f', { cutoff: 200, resonance: 1, bright: 12 })],
    ['drive', (env) => new DriveModule(env, 'd', { amount: 1, character: 2 })],
    ['delay', (env) => new DelayModule(env, 'dl', { feedback: 0.85, mix: 0.7 })],
    ['reverb', (env) => new ReverbModule(env, 'r', { decay: 3, mix: 0.6 })],
    ['chorus', (env) => new ChorusModule(env, 'c', { mix: 0.5, depth: 1 })],
    ['phaser', (env) => new PhaserModule(env, 'p', { mix: 0.5, feedback: 0.8 })],
  ];
  for (const [name, make] of cases) {
    it(`${name}: bypass returns the input unchanged`, async () => {
      const x = noise(1, 0.4);
      const { L, R } = await render({ seconds: 1, input: x, create: (env) => make(env), setup: (m) => m.setBypass(true, 0) });
      // After the ~20 ms crossfade the output is the input.
      expect(diffDb(L, x, frames(0.2), frames(1))).toBeLessThan(-100);
      expect(diffDb(R, x, frames(0.2), frames(1))).toBeLessThan(-100);
    });
  }

  it('bypass crossfades without a click and un-bypass restores processing', async () => {
    const x = sine(300, 1, 0.5);
    const { L } = await render({
      seconds: 1,
      input: x,
      create: (env) => new FilterModule(env, 'f', { mode: 1, cutoff: 3000 }),
      at: [
        [0.3, (m, ctx) => m.setBypass(true, ctx.currentTime)],
        [0.6, (m, ctx) => m.setBypass(false, ctx.currentTime)],
      ],
    });
    expect(maxStep(L, frames(0.05))).toBeLessThan(0.02);
    expect(db(toneAmp(L, 300, frames(0.4), frames(0.58)) / 0.5)).toBeGreaterThan(-0.1);
    expect(db(toneAmp(L, 300, frames(0.7), frames(0.99)) / 0.5)).toBeLessThan(-20);
  });

  it('the latest bypass request wins, even if an earlier one was scheduled later', async () => {
    const x = sine(300, 1, 0.5);
    const { L } = await render({
      seconds: 1,
      input: x,
      create: (env) => new FilterModule(env, 'f', { mode: 1, cutoff: 3000 }),
      setup: (m) => {
        m.setBypass(true, 0.5);
        m.setBypass(false, 0.3);
      },
    });
    // Never bypassed: the high-pass keeps removing 300 Hz after 0.5 s.
    expect(db(toneAmp(L, 300, frames(0.6), frames(0.95)) / 0.5)).toBeLessThan(-20);
  });
});
