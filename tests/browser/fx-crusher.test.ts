/**
 * Bit crusher (AudioWorklet 'sb-crusher') rendered offline: quantisation
 * error of the expected size, sample-and-hold stair-steps, transparency at
 * default / zero-mix settings, bounded mix modulation and bypass.
 */
import { describe, expect, it } from 'vitest';
import { CrusherModule } from '../../src/audio/modules/crusher';
import { CRUSHER_PROCESSOR_NAME, CRUSHER_WORKLET_SOURCE, loadCrusherWorklet } from '../../src/audio/worklets/crusher';
import type { ParamValues } from '../../src/project/types';
import { diffDb, frames, makeEnv, noise, render, sine } from './fx-helpers';

const prepare = (ctx: OfflineAudioContext) => loadCrusherWorklet(ctx);

async function crush(input: Float32Array, params: ParamValues, mods?: Record<string, number>, seconds = 1) {
  return render({ seconds, input, prepare, create: (env) => new CrusherModule(env, 'x', params), mods });
}

describe('crusher worklet', () => {
  it('exports its processor name and source', () => {
    expect(CRUSHER_PROCESSOR_NAME).toBe('sb-crusher');
    expect(CRUSHER_WORKLET_SOURCE).toContain(`registerProcessor('sb-crusher'`);
  });

  it('can be loaded twice into one context without error', async () => {
    const ctx = new OfflineAudioContext(2, 128, 48000);
    const url = URL.createObjectURL(new Blob([CRUSHER_WORKLET_SOURCE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    expect(() => new CrusherModule(makeEnv(ctx), 'x', {})).not.toThrow();
  });

  it('explains a missing worklet', () => {
    const ctx = new OfflineAudioContext(2, 128, 48000);
    expect(() => new CrusherModule(makeEnv(ctx), 'x', {})).toThrow(/sb-crusher/);
  });
});

describe('CrusherModule', () => {
  it('default settings (16 bits, no downsampling) are transparent', async () => {
    const x = sine(441, 1, 0.8);
    const { L, R } = await crush(x, {});
    expect(diffDb(L, x, 0, frames(1))).toBeLessThan(-80);
    expect(diffDb(R, x, 0, frames(1))).toBeLessThan(-80);
  });

  it('4 bits adds quantisation error of the expected magnitude', async () => {
    const x = sine(441, 1, 0.8);
    const { L } = await crush(x, { bits: 4, mix: 1 });
    // Step 1/8: uniform error of RMS step/sqrt(12), never more than half a step.
    let s = 0;
    let worst = 0;
    const from = frames(0.1);
    const to = frames(0.9);
    for (let i = from; i < to; i++) {
      const e = L[i] - x[i];
      s += e * e;
      worst = Math.max(worst, Math.abs(e));
    }
    const errRms = Math.sqrt(s / (to - from));
    expect(errRms).toBeGreaterThan((0.125 / Math.sqrt(12)) * 0.8);
    expect(errRms).toBeLessThan((0.125 / Math.sqrt(12)) * 1.2);
    expect(worst).toBeLessThanOrEqual(0.0625 + 1e-6);
    // Output only takes values on the 1/8 grid.
    for (let i = from; i < from + 2000; i++) expect(Math.abs(L[i] * 8 - Math.round(L[i] * 8))).toBeLessThan(1e-5);
  });

  it('fewer bits means more error', async () => {
    const x = sine(441, 1, 0.8);
    const errs: number[] = [];
    for (const bits of [12, 8, 4, 2]) {
      const { L } = await crush(x, { bits });
      errs.push(diffDb(L, x, frames(0.1), frames(0.9)));
    }
    for (let i = 1; i < errs.length; i++) expect(errs[i]).toBeGreaterThan(errs[i - 1] + 10);
  });

  it('downsample 8 produces stair-steps of 8 samples', async () => {
    const x = sine(441, 1, 0.8);
    const { L } = await crush(x, { downsample: 8, bits: 16, mix: 1 });
    const from = frames(0.1);
    const to = frames(0.9);
    const runs: number[] = [];
    let run = 1;
    for (let i = from + 1; i < to; i++) {
      if (L[i] === L[i - 1]) run++;
      else {
        runs.push(run);
        run = 1;
      }
    }
    runs.shift(); // partial first run
    const eights = runs.filter((r) => r === 8).length;
    expect(eights / runs.length).toBeGreaterThan(0.99);
    // Each step holds a real input sample.
    let matched = 0;
    for (let i = from; i < from + 800; i++) {
      if (Math.abs(L[i] - x[i]) < 1e-4) matched++;
    }
    expect(matched).toBeGreaterThanOrEqual(99);
    expect(matched).toBeLessThanOrEqual(101);
  });

  it('mix 0 is exactly the dry signal and mix modulation is bounded to 0..1', async () => {
    const x = noise(1, 0.5);
    const dry = await crush(x, { bits: 2, downsample: 16, mix: 0 });
    expect(diffDb(dry.L, x, 0, frames(1))).toBeLessThan(-120);
    const pulled = await crush(x, { bits: 2, downsample: 16, mix: 1 }, { mix: -4 });
    expect(diffDb(pulled.L, x, 0, frames(1))).toBeLessThan(-120);
    const full = await crush(x, { bits: 2, downsample: 16, mix: 1 });
    const pushed = await crush(x, { bits: 2, downsample: 16, mix: 0.2 }, { mix: 4 });
    expect(diffDb(pushed.L, full.L, 0, frames(1))).toBeLessThan(-120);
    const half = await crush(x, { bits: 2, downsample: 16, mix: 1 }, { mix: -0.5 });
    const expected = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) expected[i] = 0.5 * x[i] + 0.5 * full.L[i];
    expect(diffDb(half.L, expected, 0, frames(1))).toBeLessThan(-100);
  });

  it('bypass returns the input unchanged', async () => {
    const x = noise(1, 0.4);
    const { L } = await render({
      seconds: 1,
      input: x,
      prepare,
      create: (env) => new CrusherModule(env, 'x', { bits: 3, downsample: 12 }),
      setup: (m) => m.setBypass(true, 0),
    });
    expect(diffDb(L, x, frames(0.2), frames(1))).toBeLessThan(-100);
  });
});
