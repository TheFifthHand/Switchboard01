/**
 * Deterministic pseudo-random numbers. Everything "random" in the product
 * (noise buffers, impulse responses, random LFO steps, drum synthesis,
 * Variation) derives from a seed so renders and saved projects reproduce.
 */

/** mulberry32: small, fast, good-enough 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string, for deriving sub-seeds from ids. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combine a seed with a label into a new seed. */
export function subSeed(seed: number, label: string): number {
  return (hashString(label) ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0;
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** [0, 1) */
  float(): number {
    return this.next();
  }
  /** [min, max) */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  /** Approximately normal (Irwin–Hall, 4 terms), mean 0, sd ~1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
  /** Bipolar white noise sample in [-1, 1). */
  noise(): number {
    return this.next() * 2 - 1;
  }
}
