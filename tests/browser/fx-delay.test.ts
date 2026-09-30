/**
 * Delay rendered offline with impulses: echo timing against the tempo grid,
 * decaying repeats, ping-pong width, mix, modulation, flush and tempo changes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DelayModule, delaySeconds, measureFeedbackCycleLatency } from '../../src/audio/modules/delay';
import type { ParamValues } from '../../src/project/types';
import { energy, frames, impulses, noise, peak, render, diffDb } from './fx-helpers';

beforeAll(async () => {
  await measureFeedbackCycleLatency();
});

/** Index of the largest |sample| within ±20 ms of `t` (seconds). */
function echoAt(x: Float32Array, t: number): { index: number; value: number } {
  return peak(x, frames(t - 0.02), frames(t + 0.02));
}

async function delayImpulse(params: ParamValues, seconds: number, opts: { bpm?: number; at0?: number } = {}) {
  const t0 = opts.at0 ?? 0.1;
  return render({
    seconds,
    input: impulses(seconds, [t0]),
    env: { bpm: opts.bpm ?? 120 },
    create: (env) => new DelayModule(env, 'dl', params),
  });
}

describe('DelayModule', () => {
  it('echoes land exactly on the synced time, repeat after repeat', async () => {
    for (const [bpm, division] of [
      [120, 1],
      [97, 2],
      [174, 0],
      [60, 5],
    ] as const) {
      const T = delaySeconds(division, bpm);
      expect(T).toBeCloseTo(([0.25, 0.5, 0.75, 1, 1.5, 2][division] * 60) / bpm, 12);
      const seconds = Math.min(4, 0.2 + 3.2 * T);
      const { L, R } = await delayImpulse({ division, feedback: 0.5, tone: 12000, width: 0, mix: 1 }, seconds, { bpm });
      for (let k = 1; 0.1 + k * T + 0.03 < seconds; k++) {
        const expected = frames(0.1 + k * T);
        for (const ch of [L, R]) {
          const e = echoAt(ch, 0.1 + k * T);
          expect(Math.abs(e.index - expected), `bpm ${bpm} div ${division} echo ${k}`).toBeLessThanOrEqual(frames(0.001));
          // A real echo, well above anything between repeats.
          expect(e.value).toBeGreaterThan(0.01);
          expect(e.value).toBeGreaterThan(peak(ch, expected + frames(0.03), expected + frames(T - 0.03)).value * 20);
        }
      }
    }
  });

  it('does not drift: the 12th repeat is still on the grid to a fraction of a sample', async () => {
    const T = delaySeconds(0, 120);
    for (const tone of [12000, 3800, 500]) {
      const { L } = await delayImpulse({ division: 0, feedback: 0.8, tone, width: 0, mix: 1 }, 2);
      for (const k of [1, 6, 12]) {
        // Echo centroid: the filtered echo's mean arrival time.
        const from = frames(0.1 + k * T - 0.06);
        const to = frames(0.1 + k * T + 0.06);
        let s = 0;
        let w = 0;
        for (let i = from; i < to; i++) {
          s += i * L[i];
          w += L[i];
        }
        expect(Math.abs(s / w - frames(0.1 + k * T)), `tone ${tone} repeat ${k}`).toBeLessThan(0.5);
      }
    }
  });

  it('repeats decay with feedback and never grow, even at the maximum', async () => {
    for (const feedback of [0.3, 0.85, 5 /* clamped to 0.85 */]) {
      const T = delaySeconds(0, 220);
      const seconds = 4;
      const { L, R } = await delayImpulse({ division: 0, feedback, tone: 12000, width: 0.6, mix: 1 }, seconds, { bpm: 220 });
      const energies: number[] = [];
      for (let k = 1; 0.1 + (k + 0.5) * T < seconds; k++) {
        const a = frames(0.1 + (k - 0.5) * T);
        const b = frames(0.1 + (k + 0.5) * T);
        energies.push(energy(L, a, b) + energy(R, a, b));
      }
      for (let k = 1; k < energies.length; k++) {
        if (energies[k - 1] < 1e-14) break;
        expect(energies[k], `fb ${feedback} repeat ${k + 1}`).toBeLessThan(energies[k - 1]);
      }
      const fb = Math.min(feedback, 0.85);
      // Energy per repeat falls by about fb^2 (the tone filter only removes more).
      expect(energies[5] / energies[4]).toBeLessThan(fb * fb * 1.05);
      expect(energies[energies.length - 1]).toBeLessThan(energies[0] * 1e-4);
    }
  });

  it('feedback 0 gives exactly one echo', async () => {
    const { L } = await delayImpulse({ division: 1, feedback: 0, tone: 12000, width: 0, mix: 1 }, 1.2);
    expect(echoAt(L, 0.35).value).toBeGreaterThan(0.3);
    expect(peak(L, frames(0.45), frames(1.2)).value).toBeLessThan(1e-6);
  });

  it('width 1 ping-pongs between left and right; width 0 echoes both sides', async () => {
    const pp = await delayImpulse({ division: 1, feedback: 0.6, tone: 12000, width: 1, mix: 1 }, 1.2);
    const e1L = echoAt(pp.L, 0.35).value;
    const e1R = echoAt(pp.R, 0.35).value;
    const e2L = echoAt(pp.L, 0.6).value;
    const e2R = echoAt(pp.R, 0.6).value;
    const e3L = echoAt(pp.L, 0.85).value;
    const e3R = echoAt(pp.R, 0.85).value;
    expect(e1L).toBeGreaterThan(e1R * 100);
    expect(e2R).toBeGreaterThan(e2L * 100);
    expect(e3L).toBeGreaterThan(e3R * 100);
    const mono = await delayImpulse({ division: 1, feedback: 0.6, tone: 12000, width: 0, mix: 1 }, 1.2);
    expect(Math.abs(echoAt(mono.L, 0.6).value - echoAt(mono.R, 0.6).value)).toBeLessThan(1e-4);
  });

  it('tone darkens the repeats', async () => {
    const bright = await delayImpulse({ division: 1, feedback: 0.6, tone: 12000, width: 0, mix: 1 }, 1);
    const dark = await delayImpulse({ division: 1, feedback: 0.6, tone: 600, width: 0, mix: 1 }, 1);
    // A darker echo is smeared: lower peak for the same repeat.
    expect(echoAt(dark.L, 0.6).value).toBeLessThan(echoAt(bright.L, 0.6).value * 0.5);
  });

  it('mix 0 passes only the dry signal; mix modulation adds to the wet level, bounded', async () => {
    const x = noise(1, 0.3, 3, 0, 0.1);
    const dry = await render({ seconds: 1, input: x, create: (env) => new DelayModule(env, 'dl', { mix: 0, feedback: 0.8 }) });
    expect(diffDb(dry.L, x, 0, frames(1))).toBeLessThan(-100);

    const silentWet = await delayImpulse({ division: 1, feedback: 0.5, mix: 1, tone: 12000 }, 1);
    const wetDown = await render({
      seconds: 1,
      input: impulses(1, [0.1]),
      create: (env) => new DelayModule(env, 'dl', { division: 1, feedback: 0.5, mix: 1, tone: 12000 }),
      mods: { mix: -1 },
    });
    expect(echoAt(silentWet.L, 0.35).value).toBeGreaterThan(0.3);
    expect(peak(wetDown.L).value).toBeLessThan(1e-6);

    const full = await delayImpulse({ division: 1, feedback: 0.5, mix: 1, width: 0 }, 1);
    const over = await render({
      seconds: 1,
      input: impulses(1, [0.1]),
      create: (env) => new DelayModule(env, 'dl', { division: 1, feedback: 0.5, mix: 0.5, width: 0 }),
      mods: { mix: 3 },
    });
    // Wet is clamped at 1: the echo equals the mix = 1 echo; dry stays at 1 - mix.
    expect(Math.abs(echoAt(over.L, 0.35).value - echoAt(full.L, 0.35).value)).toBeLessThan(1e-4);
    expect(over.L[frames(0.1)]).toBeCloseTo(0.5, 4);
  });

  it('flush clears the echoes immediately and new input echoes again', async () => {
    const { L, R } = await render({
      seconds: 2,
      input: impulses(2, [0.1, 1.2]),
      create: (env) => new DelayModule(env, 'dl', { division: 1, feedback: 0.85, width: 0.5, mix: 1, tone: 12000 }),
      at: [[0.5, (m) => m.flush?.()]],
    });
    expect(echoAt(L, 0.35).value).toBeGreaterThan(0.3);
    expect(peak(L, frames(0.5), frames(1.2)).value).toBeLessThan(1e-7);
    expect(peak(R, frames(0.5), frames(1.2)).value).toBeLessThan(1e-7);
    const again = echoAt(L, 1.45);
    expect(Math.abs(again.index - frames(1.45))).toBeLessThanOrEqual(frames(0.001));
    expect(again.value).toBeGreaterThan(0.3);
  });

  it('setTempo moves the echo time', async () => {
    const { L } = await render({
      seconds: 1.2,
      input: impulses(1.2, [0.2]),
      env: { bpm: 120 },
      create: (env) => new DelayModule(env, 'dl', { division: 1, feedback: 0, width: 0, mix: 1 }),
      setup: (m) => m.setTempo?.(60, 0),
    });
    // 1/8 at 60 BPM = 0.5 s.
    const e = echoAt(L, 0.7);
    expect(Math.abs(e.index - frames(0.7))).toBeLessThanOrEqual(frames(0.001));
    expect(peak(L, frames(0.4), frames(0.5)).value).toBeLessThan(1e-4);
  });

  it('changing division mid-render glides without clicks or runaway', async () => {
    const x = noise(3, 0.2, 11, 0, 2);
    const { L } = await render({
      seconds: 3,
      input: x,
      create: (env) => new DelayModule(env, 'dl', { division: 1, feedback: 0.7, mix: 0.5 }),
      at: [[1, (m) => m.setParams({ division: 4, feedback: 0.7, mix: 0.5 }, 1)]],
    });
    expect(peak(L).value).toBeLessThan(2);
  });
});
