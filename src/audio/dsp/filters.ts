/**
 * Pure-TypeScript filters for offline synthesis (no Web Audio).
 *
 * - `Biquad`: RBJ "Audio EQ Cookbook" second-order sections (low-pass,
 *   high-pass, constant-peak band-pass, peaking, low/high shelf, notch),
 *   run as transposed direct form II. Frequencies are clamped below Nyquist
 *   and Q to a sane range, so any recipe value yields a stable filter.
 * - One-pole low/high-pass smoothers and a DC blocker.
 */

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf' | 'notch';

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Highest usable centre/cutoff as a fraction of the sample rate. */
const MAX_FREQ_RATIO = 0.49;

/** A usable sample rate (non-finite or non-positive rates fall back to 48 kHz so coefficients stay finite). */
function validRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
}

function clampFreq(freq: number, sampleRate: number): number {
  const f = Number.isFinite(freq) ? freq : 1000;
  return Math.min(sampleRate * MAX_FREQ_RATIO, Math.max(1, f));
}

function clampQ(q: number): number {
  const v = Number.isFinite(q) ? q : Math.SQRT1_2;
  return Math.min(100, Math.max(0.05, v));
}

/**
 * RBJ cookbook coefficients, normalised by a0. `q` is the conventional
 * (linear) quality factor; for shelves it is used as the shelf slope Q.
 * Band-pass has 0 dB gain at the centre frequency.
 */
export function biquadCoefficients(type: BiquadType, freq: number, q: number, sampleRate: number, gainDb = 0): BiquadCoefficients {
  const sr = validRate(sampleRate);
  const f = clampFreq(freq, sr);
  const Q = clampQ(q);
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  const A = Math.pow(10, (Number.isFinite(gainDb) ? gainDb : 0) / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1;
      b1 = -2 * cos;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Magnitude response |H(f)| of a coefficient set (linear). */
export function biquadMagnitude(c: BiquadCoefficients, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = -(c.a1 * s1 + c.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / Math.max(dr * dr + di * di, 1e-300));
}

/** A second-order section with its own state (transposed direct form II). */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(
    private type: BiquadType,
    freq: number,
    q: number,
    private readonly sampleRate: number,
    gainDb = 0,
  ) {
    this.set(type, freq, q, gainDb);
  }

  /** Recompute coefficients; state is kept so the filter can be swept. */
  set(type: BiquadType, freq: number, q: number, gainDb = 0): void {
    this.type = type;
    const c = biquadCoefficients(type, freq, q, this.sampleRate, gainDb);
    this.b0 = c.b0;
    this.b1 = c.b1;
    this.b2 = c.b2;
    this.a1 = c.a1;
    this.a2 = c.a2;
  }

  /** Change only the frequency/Q of the current type (for sweeps). */
  tune(freq: number, q: number, gainDb = 0): void {
    this.set(this.type, freq, q, gainDb);
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Filter `buf[from, to)` in place. */
  processBuffer(buf: Float32Array, from = 0, to = buf.length): void {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1;
    let z2 = this.z2;
    for (let i = from; i < to; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    // Flush denormal-range state so long silent tails stay cheap and exact.
    this.z1 = Math.abs(z1) < 1e-30 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-30 ? 0 : z2;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/** Filter a whole buffer in place through a cascade of fresh sections. */
export function applyBiquads(buf: Float32Array, sampleRate: number, sections: readonly { type: BiquadType; freq: number; q?: number; gainDb?: number }[]): void {
  for (const s of sections) new Biquad(s.type, s.freq, s.q ?? Math.SQRT1_2, sampleRate, s.gainDb ?? 0).processBuffer(buf);
}

/** One-pole coefficient for a -3 dB corner at `freq`. */
export function onePoleCoefficient(freq: number, sampleRate: number): number {
  const sr = validRate(sampleRate);
  const f = clampFreq(freq, sr);
  return 1 - Math.exp((-2 * Math.PI * f) / sr);
}

/** 6 dB/oct low-pass (also a parameter smoother). */
export class OnePoleLowpass {
  private a: number;
  private y = 0;
  constructor(freq: number, private readonly sampleRate: number, initial = 0) {
    this.a = onePoleCoefficient(freq, sampleRate);
    this.y = initial;
  }
  setFrequency(freq: number): void {
    this.a = onePoleCoefficient(freq, this.sampleRate);
  }
  process(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
  reset(value = 0): void {
    this.y = value;
  }
}

/** 6 dB/oct high-pass (input minus its one-pole low-pass). */
export class OnePoleHighpass {
  private readonly lp: OnePoleLowpass;
  constructor(freq: number, sampleRate: number) {
    this.lp = new OnePoleLowpass(freq, sampleRate);
  }
  setFrequency(freq: number): void {
    this.lp.setFrequency(freq);
  }
  process(x: number): number {
    return x - this.lp.process(x);
  }
  reset(): void {
    this.lp.reset(0);
  }
}

/** Classic DC blocker y[n] = x[n] - x[n-1] + R y[n-1] with a corner near `freq`. */
export class DcBlocker {
  private readonly r: number;
  private x1 = 0;
  private y1 = 0;
  constructor(freq: number, sampleRate: number) {
    const sr = validRate(sampleRate);
    const f = Number.isFinite(freq) ? freq : 10;
    this.r = Math.exp((-2 * Math.PI * Math.max(0.1, Math.min(f, sr * 0.1))) / sr);
  }
  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
  processBuffer(buf: Float32Array): void {
    for (let i = 0; i < buf.length; i++) buf[i] = this.process(buf[i]);
  }
}
