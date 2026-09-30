/**
 * Reverb rendered offline with bursts and impulses: tail length follows Size,
 * mix and pre-delay behave, the stereo tail is decorrelated, Size changes are
 * click-free and audible, flush removes the tail, and renders are seeded.
 */
import { describe, expect, it } from 'vitest';
import { ReverbModule } from '../../src/audio/modules/reverb';
import type { ParamValues } from '../../src/project/types';
import { correlation, energy, frames, impulses, maxCurvature, noise, peak, render, sine } from './fx-helpers';

const BURST_END = 0.1;

async function burst(params: ParamValues, seconds = 2.5, seed = 99) {
  return render({
    seconds,
    input: noise(seconds, 0.5, 5, 0.05, BURST_END),
    env: { seed },
    create: (env) => new ReverbModule(env, 'r', params),
  });
}

function onset(x: Float32Array, from: number, rel = 0.01): number {
  const p = peak(x, from).value;
  for (let i = from; i < x.length; i++) if (Math.abs(x[i]) > p * rel) return i;
  return -1;
}

describe('ReverbModule', () => {
  it('tail energy after a burst grows with Size', async () => {
    const tails: number[] = [];
    for (const decay of [0.5, 1.5, 4]) {
      const { L, R } = await burst({ decay, predelay: 0, mix: 1 });
      tails.push(energy(L, frames(BURST_END + 0.15)) + energy(R, frames(BURST_END + 0.15)));
    }
    expect(tails[1]).toBeGreaterThan(tails[0] * 2);
    expect(tails[2]).toBeGreaterThan(tails[1] * 2);
  });

  it('the tail decays by about 60 dB over the Size time', async () => {
    const decay = 1.2;
    const { L, R } = await render({
      seconds: 2,
      input: impulses(2, [0.05]),
      create: (env) => new ReverbModule(env, 'r', { decay, predelay: 0, mix: 1, tone: 16000 }),
    });
    const win = (t: number) => energy(L, frames(t - 0.02), frames(t + 0.02)) + energy(R, frames(t - 0.02), frames(t + 0.02));
    const early = win(0.05 + 0.1);
    const late = win(0.05 + 0.1 + decay / 2);
    const dropDb = 10 * Math.log10(early / late);
    // Half the Size time is ~30 dB of decay (low frequencies ring a little longer).
    expect(dropDb).toBeGreaterThan(24);
    expect(dropDb).toBeLessThan(34);
  });

  it('mix 0 leaves no tail; mix modulation cannot push the wet level past its bounds', async () => {
    const dry = await burst({ decay: 3, mix: 0 });
    expect(peak(dry.L, frames(BURST_END)).value).toBe(0);
    expect(peak(dry.R, frames(BURST_END)).value).toBe(0);

    const full = await burst({ decay: 1, mix: 1 });
    const pushed = await render({
      seconds: 2.5,
      input: noise(2.5, 0.5, 5, 0.05, BURST_END),
      env: { seed: 99 },
      create: (env) => new ReverbModule(env, 'r', { decay: 1, mix: 0.2 }),
      mods: { mix: 5 },
    });
    const pulled = await render({
      seconds: 2.5,
      input: noise(2.5, 0.5, 5, 0.05, BURST_END),
      env: { seed: 99 },
      create: (env) => new ReverbModule(env, 'r', { decay: 1, mix: 1 }),
      mods: { mix: -5 },
    });
    const tail = (x: Float32Array) => energy(x, frames(BURST_END + 0.05));
    expect(Math.abs(tail(pushed.L) / tail(full.L) - 1)).toBeLessThan(1e-3);
    expect(tail(pulled.L)).toBeLessThan(1e-12);
  });

  it('pre-delay postpones the room by the set time', async () => {
    const make = (predelay: number) =>
      render({ seconds: 1, input: impulses(1, [0.1]), create: (env) => new ReverbModule(env, 'r', { decay: 1, predelay, mix: 1 }) });
    const a = onset((await make(0)).L, frames(0.1));
    const b = onset((await make(100)).L, frames(0.1));
    expect(Math.abs(b - a - frames(0.1))).toBeLessThanOrEqual(frames(0.002));
  });

  it('answers in decorrelated stereo, deterministically per seed', async () => {
    const a = await burst({ decay: 2, mix: 1 }, 1.5, 42);
    const b = await burst({ decay: 2, mix: 1 }, 1.5, 42);
    const c = await burst({ decay: 2, mix: 1 }, 1.5, 43);
    const from = frames(BURST_END + 0.05);
    expect(Math.abs(correlation(a.L, a.R, from, a.L.length))).toBeLessThan(0.3);
    let same = 0;
    for (let i = 0; i < a.L.length; i++) same = Math.max(same, Math.abs(a.L[i] - b.L[i]));
    expect(same).toBe(0);
    expect(Math.abs(correlation(a.L, c.L, from, a.L.length))).toBeLessThan(0.5);
  });

  it('a Size change crossfades without clicks and the new size is heard', async () => {
    const x = sine(220, 3, 0.3);
    for (let i = frames(1.5); i < x.length; i++) x[i] = 0;
    // Hard stop at 1.5 s is itself a discontinuity; fade it over 20 ms.
    for (let i = 0; i < frames(0.02); i++) x[frames(1.48) + i] *= 1 - i / frames(0.02);
    const make = (change: boolean) =>
      render({
        seconds: 3,
        input: x,
        create: (env) => new ReverbModule(env, 'r', { decay: 0.6, predelay: 0, mix: 1 }),
        at: change ? [[0.8, (m, ctx) => m.setParams({ decay: 5, predelay: 0, mix: 1 }, ctx.currentTime)]] : [],
      });
    const changed = await make(true);
    const steady = await make(false);
    // No curvature spike at the switch compared with the steady wash before it.
    const before = maxCurvature(changed.L, frames(0.5), frames(0.78));
    const around = maxCurvature(changed.L, frames(0.78), frames(1.0));
    expect(around).toBeLessThan(before * 2);
    // The bigger room rings much longer after the note ends.
    const tail = (y: Float32Array) => energy(y, frames(1.7));
    expect(tail(changed.L)).toBeGreaterThan(tail(steady.L) * 20);
  });

  it('flush removes the tail at once and the room still answers new sound', async () => {
    const x = noise(2, 0.5, 5, 0.05, BURST_END);
    const later = noise(2, 0.5, 6, 1.0, 1.05);
    for (let i = 0; i < x.length; i++) x[i] += later[i];
    const { L, R } = await render({
      seconds: 2,
      input: x,
      create: (env) => new ReverbModule(env, 'r', { decay: 6, mix: 1 }),
      at: [[0.3, (m) => m.flush?.()]],
    });
    expect(peak(L, frames(0.2), frames(0.3)).value).toBeGreaterThan(0.01);
    expect(peak(L, frames(0.305), frames(1.0)).value).toBeLessThan(1e-7);
    expect(peak(R, frames(0.305), frames(1.0)).value).toBeLessThan(1e-7);
    expect(energy(L, frames(1.1))).toBeGreaterThan(0.1);
  });

  it('cancelAfter undoes a scheduled Size change', async () => {
    const { L } = await render({
      seconds: 2,
      input: noise(2, 0.5, 5, 0.05, BURST_END),
      env: { seed: 99 },
      create: (env) => new ReverbModule(env, 'r', { decay: 0.4, mix: 1 }),
      setup: (m) => {
        m.setParams({ decay: 8, mix: 1 }, 0.08);
        m.cancelAfter?.(0.02);
      },
    });
    const ref = await burst({ decay: 0.4, mix: 1 }, 2);
    expect(Math.abs(energy(L, frames(0.3)) / energy(ref.L, frames(0.3)) - 1)).toBeLessThan(1e-3);
  });
});
