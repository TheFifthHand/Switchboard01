/**
 * Seeded noise sources (deterministic: every generator derives from a seed
 * via src/project/rng.ts, never Math.random).
 */
import { Rng } from '../../project/rng';

/** Uniform white noise in [-1, 1). */
export class WhiteNoise {
  private readonly rng: Rng;
  constructor(seed: number) {
    this.rng = new Rng(seed >>> 0);
  }
  next(): number {
    return this.rng.noise();
  }
}

/**
 * Pink (−3 dB/oct) noise via Paul Kellet's economy filter on seeded white
 * noise. Scaled so peaks stay within about ±1 (RMS ≈ 0.19).
 */
export class PinkNoise {
  private readonly rng: Rng;
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  constructor(seed: number) {
    this.rng = new Rng(seed >>> 0);
  }
  next(): number {
    const w = this.rng.noise();
    this.b0 = 0.99765 * this.b0 + w * 0.099046;
    this.b1 = 0.963 * this.b1 + w * 0.2965164;
    this.b2 = 0.57 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.11;
  }
}

/** A buffer of seeded white noise. */
export function whiteNoiseBuffer(length: number, seed: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.max(0, Math.floor(length)));
  const n = new WhiteNoise(seed);
  for (let i = 0; i < out.length; i++) out[i] = n.next();
  return out;
}
