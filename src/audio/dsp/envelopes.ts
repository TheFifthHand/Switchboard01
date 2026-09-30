/**
 * Envelope helpers. Decay times are T60: the time for an exponential decay
 * to fall by 60 dB (to 1/1000). A per-sample multiplier avoids calling
 * `Math.exp` for every sample.
 */

/** ln(1000): an exponential with time constant T60 / T60_FACTOR falls 60 dB in T60. */
export const T60_FACTOR = Math.log(1000);

/** Per-sample multiplier for an exponential decay of `t60` seconds. */
export function decayCoefficient(t60: number, sampleRate: number): number {
  const t = Math.max(1e-5, Number.isFinite(t60) ? t60 : 1e-5);
  return Math.exp(-T60_FACTOR / (t * sampleRate));
}

/** Exponential decay value at time `t` (1 at t = 0, 0.001 at t = t60). */
export function expDecay(t: number, t60: number): number {
  if (t <= 0) return 1;
  return Math.exp((-T60_FACTOR * t) / Math.max(1e-5, t60));
}

/**
 * Attack–hold–decay envelope generator. The attack is a raised-cosine rise
 * (click-free but fast), the decay exponential.
 */
export class AhdEnvelope {
  private i = 0;
  private value = 1;
  private readonly attackN: number;
  private readonly holdEnd: number;
  private readonly coef: number;

  constructor(attack: number, hold: number, t60: number, sampleRate: number) {
    this.attackN = Math.max(0, Math.round(Math.max(0, attack) * sampleRate));
    this.holdEnd = this.attackN + Math.max(0, Math.round(Math.max(0, hold) * sampleRate));
    this.coef = decayCoefficient(t60, sampleRate);
  }

  next(): number {
    const i = this.i++;
    if (i < this.attackN) return 0.5 - 0.5 * Math.cos((Math.PI * i) / this.attackN);
    if (i < this.holdEnd) return 1;
    const v = this.value;
    this.value *= this.coef;
    return v;
  }
}

/** A single exponential decay, multiplied per sample. */
export class ExpDecay {
  private v: number;
  private readonly c: number;
  constructor(t60: number, sampleRate: number, start = 1) {
    this.c = decayCoefficient(t60, sampleRate);
    this.v = start;
  }
  next(): number {
    const v = this.v;
    this.v *= this.c;
    return v;
  }
}

export interface AdsrSpec {
  /** Seconds (linear rise). */
  attack: number;
  /** T60-style decay towards `sustain`, seconds. */
  decay: number;
  /** 0..1 */
  sustain: number;
  /** T60 of the release, seconds. */
  release: number;
}

/**
 * ADSR value at time `t` for a note held for `gate` seconds. Attack is
 * linear, decay and release exponential; the release starts from whatever
 * level the envelope reached when the gate closed.
 */
export function adsrAt(spec: AdsrSpec, t: number, gate: number): number {
  const a = Math.max(0, spec.attack);
  const s = Math.min(1, Math.max(0, spec.sustain));
  const held = (u: number): number => {
    if (u <= 0) return 0;
    if (u < a) return u / a;
    return s + (1 - s) * expDecay(u - a, spec.decay);
  };
  if (t < gate) return held(t);
  return held(gate) * expDecay(t - gate, spec.release);
}

/** Render an ADSR envelope of `length` samples. */
export function renderAdsr(spec: AdsrSpec, gate: number, length: number, sampleRate: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.max(0, Math.floor(length)));
  for (let i = 0; i < out.length; i++) out[i] = adsrAt(spec, i / sampleRate, gate);
  return out;
}
