/**
 * Studio worklet processors run in Node (their real source strings) and the
 * mastering presets as data: bit-exact neutrality, robustness to extreme
 * settings and non-finite input, denormal-free decay to exact silence, the
 * flush counter, and preset completeness.
 */
import { describe, expect, it } from 'vitest';
import { MASTERING_PRESETS, masteringPreset } from '../../src/content/mastering';
import { COMPRESSOR_PROCESSOR_NAME, DYNAMICS_WORKLET_SOURCE, GATE_PROCESSOR_NAME } from '../../src/audio/worklets/dynamics';
import { FLANGER_PROCESSOR_NAME, FX_WORKLET_SOURCE, TAPE_PROCESSOR_NAME, tapeToneHz } from '../../src/audio/worklets/fx';
import { MASTERING_PROCESSOR_NAME, MASTERING_WORKLET_SOURCE, glueAttackMs, glueStaticReduction } from '../../src/audio/worklets/mastering';
import { MASTERING_PARAMS, neutralMasteringParams, readParam } from '../../src/project/params';
import { Rng } from '../../src/project/rng';
import { loadProcessors, runProcessor, sine } from './omni-fx-harness';

const SR = 48000;
const registry = new Map([
  ...loadProcessors(DYNAMICS_WORKLET_SOURCE, SR),
  ...loadProcessors(FX_WORKLET_SOURCE, SR),
  ...loadProcessors(MASTERING_WORKLET_SOURCE, SR),
]);
const proc = (name: string) => {
  const p = registry.get(name);
  if (!p) throw new Error(`no processor ${name}`);
  return p;
};

function noise(n: number, amp: number, seed: number): Float32Array {
  const rng = new Rng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (2 * rng.float() - 1);
  return x;
}

describe('worklet processors (Node)', () => {
  it('neutral mastering passes its input bit for bit; ratio 1 and Depth 0 likewise', () => {
    const l = noise(SR, 0.9, 1);
    const r = noise(SR, 0.9, 2);
    const m = runProcessor(proc(MASTERING_PROCESSOR_NAME), l, r, { params: { glue: 0, warmth: 0, width: 1, monoBass: 20 } });
    expect(m.L).toEqual(l);
    expect(m.R).toEqual(r);
    const c = runProcessor(proc(COMPRESSOR_PROCESSOR_NAME), l, r, { params: { ratio: 1, threshold: -60, makeup: 0 } });
    expect(c.L).toEqual(l);
    const g = runProcessor(proc(GATE_PROCESSOR_NAME), l, r, { params: { range: 0, threshold: 0 } });
    expect(g.L).toEqual(l);
  });

  it('every processor stays finite and bounded at extreme settings with absurd and non-finite input', () => {
    const n = SR / 2;
    const x = noise(n, 4, 3);
    x[100] = NaN;
    x[200] = Infinity;
    x[300] = -1e30;
    const cases: [string, Record<string, number>[]][] = [
      [COMPRESSOR_PROCESSOR_NAME, [{ threshold: -60, ratio: 20, attack: 0.1, release: 10, makeup: 24, mix: 1 }, { threshold: 0, ratio: 1, mix: 0 }]],
      [GATE_PROCESSOR_NAME, [{ threshold: -80, range: 80, attack: 0.1, release: 5 }, { threshold: 0, range: 80, attack: 50, release: 1000 }]],
      [FLANGER_PROCESSOR_NAME, [{ rate: 5, depth: 1, feedback: 0.85, mix: 1 }, { rate: 0.02, depth: 0, feedback: 0, mix: 0.5 }]],
      [TAPE_PROCESSOR_NAME, [{ drive: 1, wobble: 1, tone: 0, hiss: 1, mix: 1 }, { drive: 0, wobble: 0, tone: 1, hiss: 0, mix: 0 }]],
      [MASTERING_PROCESSOR_NAME, [{ glue: 1, punch: 0, warmth: 1, width: 2, monoBass: 400 }, { glue: 1, punch: 1, warmth: 0.01, width: 0, monoBass: 21 }]],
    ];
    for (const [name, settings] of cases) {
      for (const params of settings) {
        const { L, R } = runProcessor(proc(name), x, x, { params, options: { processorOptions: { seed: 9 } } });
        for (const y of [L, R]) {
          let worst = 0;
          for (const v of y) {
            expect(Number.isFinite(v), `${name} ${JSON.stringify(params)}`).toBe(true);
            worst = Math.max(worst, Math.abs(v));
          }
          // Inputs reach ±4; the largest legitimate gain is the compressor's +24 dB make-up below threshold.
          expect(worst, name).toBeLessThan(name === COMPRESSOR_PROCESSOR_NAME ? 70 : 20);
        }
      }
    }
  });

  it('after the sound stops, internal state decays to exact zero (no denormals) and output is silent', () => {
    // Half a second of sound, then 7.5 s of silence (the tape hiss follows the music down over seconds).
    const n = 8 * SR;
    const x = new Float32Array(n);
    x.set(sine(SR / 2, 220, 0.8, SR), 0);
    const silentTail = (y: Float32Array) => {
      let m = 0;
      for (let i = Math.round(7.5 * SR); i < n; i++) m = Math.max(m, Math.abs(y[i]));
      return m;
    };
    const comp = runProcessor(proc(COMPRESSOR_PROCESSOR_NAME), x, x, { params: { threshold: -40, ratio: 10, release: 50 } });
    expect((comp.processor as unknown as { gr: number }).gr).toBe(0);
    expect(silentTail(comp.L)).toBe(0);
    const fl = runProcessor(proc(FLANGER_PROCESSOR_NAME), x, x, { params: { feedback: 0.85, depth: 1, mix: 1 } });
    expect(silentTail(fl.L)).toBe(0);
    expect((fl.processor as unknown as { dampL: number }).dampL).toBe(0);
    const tape = runProcessor(proc(TAPE_PROCESSOR_NAME), x, x, { params: { drive: 1, wobble: 1, hiss: 1, tone: 0.3 }, options: { processorOptions: { seed: 1 } } });
    const t = tape.processor as unknown as Record<string, number>;
    for (const k of ['env', 'tL1', 'tL2', 'dcyL']) expect(t[k], k).toBe(0);
    expect(silentTail(tape.L)).toBe(0);
    const mst = runProcessor(proc(MASTERING_PROCESSOR_NAME), x, x, { params: { glue: 1, warmth: 1, width: 1.5, monoBass: 200 } });
    const ms = mst.processor as unknown as { det: number; env1: number; env2: number; hp: number[] };
    expect(ms.det).toBe(0);
    expect(ms.hp.every((v) => v === 0)).toBe(true);
    expect(silentTail(mst.L)).toBe(0);
  });

  it('the flush counter resets state at once (Mute All)', () => {
    const x = sine(SR, 300, 0.8, SR);
    for (let i = SR / 2; i < SR; i++) x[i] = 0;
    const flushAt = Math.round((0.5 * SR) / 128) * 128;
    const fl = runProcessor(proc(FLANGER_PROCESSOR_NAME), x, x, {
      params: { feedback: 0.85, depth: 1, rate: 0.05, mix: 1 },
      onBlock: (f, _p, params) => {
        if (f === flushAt) params.flush = 1;
      },
    });
    let after = 0;
    for (let i = flushAt; i < SR; i++) after = Math.max(after, Math.abs(fl.L[i]));
    expect(after).toBe(0);
  });
});

describe('mastering presets', () => {
  it('include Clean (neutral), Gentle, Warm, Punchy, Bright, Wide, Loud and Lo-fi', () => {
    for (const id of ['clean', 'gentle', 'warm', 'punchy', 'bright', 'wide', 'loud', 'lofi']) expect(masteringPreset(id), id).toBeDefined();
    expect(masteringPreset('clean')!.params).toEqual(neutralMasteringParams());
    expect(new Set(MASTERING_PRESETS.map((p) => p.id)).size).toBe(MASTERING_PRESETS.length);
    expect(new Set(MASTERING_PRESETS.map((p) => p.name)).size).toBe(MASTERING_PRESETS.length);
  });

  it('each sets every parameter within its range and has one plain sentence', () => {
    for (const p of MASTERING_PRESETS) {
      expect(p.id).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(Object.keys(p.params).sort()).toEqual(MASTERING_PARAMS.map((s) => s.id).sort());
      for (const s of MASTERING_PARAMS) expect(readParam(MASTERING_PARAMS, p.params, s.id), `${p.id}.${s.id}`).toBe(p.params[s.id]);
      expect(p.description).toMatch(/^[A-Z].*\.$/);
      expect(p.description.slice(0, -1)).not.toMatch(/\.\s/);
      expect(p.description.length).toBeLessThan(140);
    }
  });

  it('Glue curve helpers: neutral at 0, −24 dB / 4:1 at full, Punch maps to 1..30 ms', () => {
    expect(glueStaticReduction(0, 0)).toBe(0);
    expect(glueStaticReduction(1, -40)).toBe(0);
    expect(glueStaticReduction(1, 0)).toBeCloseTo(24 * 0.75, 6);
    expect(glueAttackMs(0)).toBeCloseTo(1, 6);
    expect(glueAttackMs(1)).toBeCloseTo(30, 6);
    expect(tapeToneHz(0)).toBeCloseTo(3000, 3);
    expect(tapeToneHz(1)).toBeCloseTo(20000, 3);
  });
});
