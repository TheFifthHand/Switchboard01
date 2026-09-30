/**
 * Waveshaping and lo-fi helpers: normalised soft clipping, tape-style
 * asymmetric saturation, bit-depth and sample-rate reduction. All outputs
 * are bounded for bounded input.
 */

/**
 * Normalised tanh saturation: `drive` <= 0 is clean, larger values add
 * harmonics and compress. Unity input maps to unity output, so levels are
 * roughly kept while peaks round off. Output is always within [-1, 1] for
 * |x| <= 1 and bounded by 1 / tanh(drive) otherwise.
 */
export function softClip(x: number, drive: number): number {
  if (!(drive > 1e-3)) return x;
  return Math.tanh(drive * x) / Math.tanh(drive);
}

/** Apply `softClip` to a whole buffer in place. */
export function softClipBuffer(buf: Float32Array, drive: number): void {
  if (!(drive > 1e-3)) return;
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(drive * buf[i]) * norm;
}

/**
 * Tape-like saturation with a little asymmetry (adds even harmonics).
 * The static offset it creates is removed (f(0) = 0); follow with a DC
 * blocker for signals with a strong DC component.
 */
export function asymSaturate(x: number, drive: number, bias: number): number {
  const d = Math.max(1e-3, drive);
  const b = Math.max(-0.5, Math.min(0.5, bias));
  const n = Math.tanh(d * (1 + b)) - Math.tanh(d * b);
  return (Math.tanh(d * (x + b)) - Math.tanh(d * b)) / n;
}

/** `asymSaturate` over a whole buffer in place (constants hoisted out of the loop). */
export function asymSaturateBuffer(buf: Float32Array, drive: number, bias: number): void {
  const d = Math.max(1e-3, drive);
  const b = Math.max(-0.5, Math.min(0.5, bias));
  const off = Math.tanh(d * b);
  const inv = 1 / (Math.tanh(d * (1 + b)) - off);
  const db = d * b;
  for (let i = 0; i < buf.length; i++) buf[i] = (Math.tanh(d * buf[i] + db) - off) * inv;
}

/** Quantise to `bits` of resolution (mid-tread). bits >= 24 is a no-op. */
export function bitReduce(buf: Float32Array, bits: number): void {
  if (!(bits > 0) || bits >= 24) return;
  const levels = Math.pow(2, Math.max(1, Math.round(bits)) - 1);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.round(buf[i] * levels) / levels;
}

/**
 * Sample-and-hold sample-rate reduction to `targetRate` (fractional ratios
 * allowed). A no-op when the target is at or above the source rate.
 */
export function rateReduce(buf: Float32Array, sampleRate: number, targetRate: number): void {
  if (!(targetRate > 0) || targetRate >= sampleRate) return;
  const step = targetRate / sampleRate;
  let phase = 1;
  let held = 0;
  for (let i = 0; i < buf.length; i++) {
    if (phase >= 1) {
      phase -= Math.floor(phase);
      held = buf[i];
    }
    buf[i] = held;
    phase += step;
  }
}
