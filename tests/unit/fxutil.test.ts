/**
 * Pure effect helpers: seeded impulse-response generation (determinism,
 * length, -60 dB at the decay time, early reflections, darkening, loudness
 * normalisation, stereo decorrelation) and the drive/control curves.
 */
import { describe, expect, it } from 'vitest';
import {
  IR_ENERGY_TARGET,
  SHAPER_CURVE_POINTS,
  SHAPER_DOMAIN,
  driveGain,
  driveMakeup,
  driveTransfer,
  driveWetFade,
  generateImpulse,
  impulseLengthFrames,
  makeControlCurve,
  makeDriveCurve,
} from '../../src/audio/modules/fxutil';

const SR = 48000;

/** Mean-square level in dB over [t - w/2, t + w/2] seconds, both channels. */
function levelDb(ir: Float32Array[], t: number, w = 0.04): number {
  const a = Math.max(0, Math.round((t - w / 2) * SR));
  const b = Math.min(ir[0].length, Math.round((t + w / 2) * SR));
  let s = 0;
  for (const ch of ir) for (let i = a; i < b; i++) s += ch[i] * ch[i];
  return 10 * Math.log10(s / (ir.length * (b - a)));
}

function energy(x: Float32Array, a = 0, b = x.length): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return s;
}

describe('generateImpulse', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = generateImpulse({ sampleRate: SR, decay: 1.5, seed: 42 });
    const b = generateImpulse({ sampleRate: SR, decay: 1.5, seed: 42 });
    const c = generateImpulse({ sampleRate: SR, decay: 1.5, seed: 43 });
    expect(a).toHaveLength(2);
    for (let ch = 0; ch < 2; ch++) expect(Array.from(a[ch])).toEqual(Array.from(b[ch]));
    let diff = 0;
    for (let i = 0; i < a[0].length; i++) diff += Math.abs(a[0][i] - c[0][i]);
    expect(diff).toBeGreaterThan(1);
  });

  it('lasts min(decay * 1.2, 10) seconds', () => {
    expect(impulseLengthFrames(2, SR)).toBe(2.4 * SR);
    expect(impulseLengthFrames(9, SR)).toBe(10 * SR);
    expect(generateImpulse({ sampleRate: SR, decay: 0.3, seed: 1 })[0].length).toBe(Math.round(0.36 * SR));
  });

  it.each([0.8, 2.4, 6])('decays by 60 dB at the decay time (decay %s s)', (decay) => {
    const ir = generateImpulse({ sampleRate: SR, decay, seed: 7 });
    const start = 0.06; // after the early reflections
    const drop = levelDb(ir, start) - levelDb(ir, decay, 0.06);
    const expected = 60 * (1 - start / decay);
    expect(Math.abs(drop - expected)).toBeLessThan(3);
    // Straight-line (exponential) decay in between: the midpoint is half-way in dB.
    const mid = levelDb(ir, start) - levelDb(ir, (start + decay) / 2, 0.06);
    expect(Math.abs(mid - expected / 2)).toBeLessThan(2.5);
  });

  it('has sparse early reflections in the first 40 ms', () => {
    const [L] = generateImpulse({ sampleRate: SR, decay: 2, seed: 3 });
    const crest = (a: number, b: number) => {
      let pk = 0;
      for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(L[i]));
      return pk / Math.sqrt(energy(L, a, b) / (b - a));
    };
    const early = crest(Math.round(0.004 * SR), Math.round(0.042 * SR));
    const late = crest(Math.round(0.1 * SR), Math.round(0.138 * SR));
    expect(early).toBeGreaterThan(late * 1.5);
  });

  it('gets darker over time', () => {
    const ir = generateImpulse({ sampleRate: SR, decay: 3, seed: 5 });
    // Brightness proxy: energy of the first difference relative to the energy.
    const brightness = (t: number) => {
      const a = Math.round(t * SR);
      const b = a + Math.round(0.05 * SR);
      let d = 0;
      let e = 0;
      for (const ch of ir) {
        for (let i = a + 1; i < b; i++) {
          d += (ch[i] - ch[i - 1]) ** 2;
          e += ch[i] * ch[i];
        }
      }
      return d / e;
    };
    const early = brightness(0.05);
    const mid = brightness(1.5);
    const late = brightness(2.9);
    expect(mid).toBeLessThan(early * 0.5);
    expect(late).toBeLessThan(mid * 0.7);
  });

  it('is normalised to the same energy for every size', () => {
    for (const decay of [0.3, 2.4, 9]) {
      const ir = generateImpulse({ sampleRate: SR, decay, seed: 11 });
      const e = (energy(ir[0]) + energy(ir[1])) / 2;
      expect(e).toBeCloseTo(IR_ENERGY_TARGET, 6);
    }
  });

  it('is stereo-decorrelated and finite', () => {
    const [L, R] = generateImpulse({ sampleRate: SR, decay: 2, seed: 9 });
    let lr = 0;
    for (let i = 0; i < L.length; i++) {
      expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
      lr += L[i] * R[i];
    }
    expect(Math.abs(lr / Math.sqrt(energy(L) * energy(R)))).toBeLessThan(0.1);
  });

  it('survives out-of-range input', () => {
    const ir = generateImpulse({ sampleRate: SR, decay: Number.NaN, seed: 1 });
    expect(ir[0].length).toBeGreaterThan(0);
    for (const v of ir[0]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('drive curves', () => {
  it('are odd-symmetric, bounded and unity-gain for small signals', () => {
    for (const character of [0, 1, 2]) {
      const c = makeDriveCurve(character);
      expect(c.length).toBe(SHAPER_CURVE_POINTS);
      for (let i = 0; i < c.length; i++) {
        expect(Math.abs(c[i])).toBeLessThanOrEqual(1);
        expect(c[i]).toBeCloseTo(-c[c.length - 1 - i], 6);
      }
      expect(driveTransfer(character, 0.01) / 0.01).toBeCloseTo(1, 3);
    }
  });

  it('have the intended characters', () => {
    // Warm saturates smoothly, Hard clips flat past its knee, Fold turns back down.
    expect(driveTransfer(0, 3)).toBeCloseTo(Math.tanh(3), 12);
    expect(driveTransfer(1, 0.5)).toBe(0.5);
    expect(driveTransfer(1, 1.5)).toBe(1);
    expect(driveTransfer(1, 1.0)).toBeGreaterThan(0.9);
    expect(driveTransfer(2, Math.PI)).toBeCloseTo(0, 12);
    expect(makeDriveCurve(0)[SHAPER_CURVE_POINTS - 1]).toBeCloseTo(Math.tanh(SHAPER_DOMAIN), 6);
  });

  it('drive gain, wet fade and make-up follow their laws', () => {
    expect(driveGain(0)).toBe(1);
    expect(driveGain(1)).toBe(31);
    expect(driveGain(5)).toBe(31);
    expect(driveWetFade(0)).toBe(0);
    expect(driveWetFade(1 / 16)).toBeCloseTo(0.5, 12);
    expect(driveWetFade(0.5)).toBe(1);
    expect(driveMakeup(0)).toBeCloseTo(1.03, 2);
    expect(driveMakeup(1)).toBeCloseTo(0.3, 3);
  });

  it('control curves clamp their input to 0..1 before mapping', () => {
    const c = makeControlCurve((d) => 10 * d);
    expect(c.length).toBe(4097);
    expect(c[0]).toBe(0); // u = -1 -> d = 0
    expect(c[2048]).toBe(0); // u = 0
    expect(c[4096]).toBe(10); // u = 1
    expect(c[2048 + 256]).toBeCloseTo(1.25, 6); // u = 1/8
    expect(makeControlCurve(() => Number.NaN)[100]).toBe(0);
  });
});
