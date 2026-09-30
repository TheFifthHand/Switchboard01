/**
 * Phase-accumulator oscillators for offline synthesis.
 *
 * Phase is kept in cycles (0..1). Saw and square are band-limited with a
 * two-sample polynomial BLEP, which removes most of the aliasing a naive
 * discontinuous waveform produces; the triangle's harmonics already fall at
 * 12 dB/oct, so it is generated directly. `Sinusoid` is a fixed-frequency
 * sine by complex rotation (no per-sample trig), used for modal partials.
 */

export type Waveform = 'sine' | 'square' | 'saw' | 'triangle';

const TAU = 2 * Math.PI;

/**
 * Polynomial band-limited step residual for phase `t` (cycles, 0..1) and
 * per-sample increment `dt`. Subtracting it at a falling discontinuity (or
 * adding it at a rising one) smooths the step over two samples.
 */
export function polyBlep(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export class Oscillator {
  /** Current phase in cycles, 0 <= phase < 1. */
  phase: number;

  constructor(
    public waveform: Waveform,
    private readonly sampleRate: number,
    phase = 0,
  ) {
    this.phase = ((phase % 1) + 1) % 1;
  }

  /** Output the sample at the current phase, then advance by `freq` Hz. */
  next(freq: number): number {
    const dt = Math.min(0.5, Math.max(0, freq / this.sampleRate));
    const t = this.phase;
    let y: number;
    switch (this.waveform) {
      case 'sine':
        y = Math.sin(TAU * t);
        break;
      case 'saw':
        y = 2 * t - 1 - polyBlep(t, dt);
        break;
      case 'square': {
        y = t < 0.5 ? 1 : -1;
        y += polyBlep(t, dt);
        let t2 = t + 0.5;
        if (t2 >= 1) t2 -= 1;
        y -= polyBlep(t2, dt);
        break;
      }
      case 'triangle':
        y = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
        break;
    }
    let p = t + dt;
    if (p >= 1) p -= Math.floor(p);
    this.phase = p;
    return y;
  }
}

/**
 * Add a fixed-frequency polyBLEP square wave to `out` (in place). Same
 * waveform as `Oscillator('square')`, written as one tight loop because
 * metallic clusters sum many of them over seconds of audio.
 * Returns the phase after the last sample.
 */
export function addSquareWave(out: Float32Array, freq: number, sampleRate: number, phase = 0, gain = 1): number {
  const dt = Math.min(0.5, Math.max(0, freq / sampleRate));
  let t = ((phase % 1) + 1) % 1;
  if (dt === 0) return t;
  const inv = 1 / dt;
  for (let i = 0; i < out.length; i++) {
    let y = t < 0.5 ? 1 : -1;
    if (t < dt) {
      const x = t * inv;
      y += x + x - x * x - 1;
    } else if (t > 1 - dt) {
      const x = (t - 1) * inv;
      y += x * x + x + x + 1;
    }
    let t2 = t + 0.5;
    if (t2 >= 1) t2 -= 1;
    if (t2 < dt) {
      const x = t2 * inv;
      y -= x + x - x * x - 1;
    } else if (t2 > 1 - dt) {
      const x = (t2 - 1) * inv;
      y -= x * x + x + x + 1;
    }
    out[i] += y * gain;
    t += dt;
    if (t >= 1) t -= 1;
  }
  return t;
}

/**
 * Add amp · r^n · sin(2π f n / sr + 2π phase) to `out`, where r gives a
 * T60 of `t60` seconds (t60 <= 0 or non-finite: undamped). Uses the
 * two-term recursion s[n+1] = 2 r cos(w) s[n] - r² s[n-1]; stops once the
 * partial has decayed below -140 dB. `offset` delays the start.
 */
export function addDampedSine(out: Float32Array, freq: number, t60: number, sampleRate: number, amp = 1, phase = 0, offset = 0): void {
  const f = Math.min(sampleRate * 0.4999, Math.max(0, Number.isFinite(freq) ? freq : 0));
  const w = (TAU * f) / sampleRate;
  const r = t60 > 0 && Number.isFinite(t60) ? Math.exp(-Math.log(1000) / (t60 * sampleRate)) : 1;
  const c = 2 * r * Math.cos(w);
  const r2 = r * r;
  const p = TAU * phase;
  let y0 = amp * Math.sin(p);
  let y1 = amp * r * Math.sin(w + p);
  const start = Math.max(0, Math.round(offset));
  // Samples until r^n < 1e-7 (-140 dB).
  const life = r < 1 ? Math.ceil(Math.log(1e-7) / Math.log(r)) : Infinity;
  const end = Math.min(out.length, start + life);
  for (let i = start; i < end; i++) {
    out[i] += y0;
    const y2 = c * y1 - r2 * y0;
    y0 = y1;
    y1 = y2;
  }
}

/** Fixed-frequency sine by complex rotation; amplitude-stable for many seconds in double precision. */
export class Sinusoid {
  private re: number;
  private im: number;
  private readonly cr: number;
  private readonly ci: number;

  /** `phase` in cycles; output starts at sin(2π·phase). */
  constructor(freq: number, sampleRate: number, phase = 0) {
    const f = Math.min(sampleRate * 0.4999, Math.max(0, Number.isFinite(freq) ? freq : 0));
    const w = (TAU * f) / sampleRate;
    this.cr = Math.cos(w);
    this.ci = Math.sin(w);
    this.re = Math.cos(TAU * phase);
    this.im = Math.sin(TAU * phase);
  }

  next(): number {
    const y = this.im;
    const re = this.re * this.cr - this.im * this.ci;
    this.im = this.re * this.ci + this.im * this.cr;
    this.re = re;
    return y;
  }
}

/** MIDI note number to frequency (A4 = 69 = 440 Hz). */
export function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}
