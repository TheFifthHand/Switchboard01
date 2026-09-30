/**
 * Buffer utilities: peak/RMS, normalisation, raised-cosine fades, tail
 * trimming and sanitising. All operate in place unless they return a copy.
 */

export function peakAbs(buf: ArrayLike<number>, from = 0, to = buf.length): number {
  let p = 0;
  for (let i = Math.max(0, from); i < Math.min(buf.length, to); i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

/** Peak across several channels. */
export function peakAbsChannels(channels: readonly ArrayLike<number>[]): number {
  let p = 0;
  for (const c of channels) p = Math.max(p, peakAbs(c));
  return p;
}

export function rms(buf: ArrayLike<number>, from = 0, to = buf.length): number {
  const a = Math.max(0, from);
  const b = Math.min(buf.length, to);
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / (b - a));
}

/** Replace non-finite samples with 0 and clamp to ±limit. Returns how many samples were non-finite. */
export function sanitize(buf: Float32Array, limit = 1): number {
  let bad = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (!Number.isFinite(v)) {
      buf[i] = 0;
      bad++;
    } else if (v > limit) buf[i] = limit;
    else if (v < -limit) buf[i] = -limit;
  }
  return bad;
}

/** Scale so the peak equals `target`. Silent buffers are left untouched. Returns the gain applied. */
export function normalizePeak(buf: Float32Array, target: number): number {
  const p = peakAbs(buf);
  if (p < 1e-12) return 1;
  const g = target / p;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return g;
}

/** Scale several channels together so their joint peak equals `target`. */
export function normalizePeakChannels(channels: readonly Float32Array[], target: number): number {
  const p = peakAbsChannels(channels);
  if (p < 1e-12) return 1;
  const g = target / p;
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= g;
  return g;
}

/** Raised-cosine fade-in over the first `samples` samples (sample 0 becomes exactly 0). */
export function fadeIn(buf: Float32Array, samples: number): void {
  const n = Math.min(buf.length, Math.max(0, Math.round(samples)));
  for (let i = 1; i < n; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  if (n > 0) buf[0] = 0;
}

/** Raised-cosine fade-out over the last `samples` samples (the last sample becomes exactly 0). */
export function fadeOut(buf: Float32Array, samples: number): void {
  const n = Math.min(buf.length, Math.max(0, Math.round(samples)));
  if (n === 0) return;
  const start = buf.length - n;
  for (let i = 0; i < n - 1; i++) buf[start + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / n);
  buf[buf.length - 1] = 0;
}

/** Index one past the last sample whose magnitude exceeds `threshold`, or 0. */
export function endOfSignal(buf: ArrayLike<number>, threshold: number): number {
  for (let i = buf.length - 1; i >= 0; i--) if (Math.abs(buf[i]) > threshold) return i + 1;
  return 0;
}

/**
 * Drop the tail below `thresholdDb` (relative to the peak), keeping at least
 * `minLength` samples and `pad` samples after the last loud sample. Returns a
 * copy of the kept part.
 */
export function trimTail(buf: Float32Array, thresholdDb: number, pad: number, minLength = 1): Float32Array<ArrayBuffer> {
  const p = peakAbs(buf);
  const thr = p * Math.pow(10, thresholdDb / 20);
  const end = Math.min(buf.length, Math.max(minLength, endOfSignal(buf, thr) + Math.max(0, Math.round(pad))));
  return buf.slice(0, Math.max(1, end));
}

/** dst[offset + i] += src[i] * gain, within bounds. */
export function mixInto(dst: Float32Array, src: ArrayLike<number>, gain = 1, offset = 0): void {
  const start = Math.max(0, Math.round(offset));
  const n = Math.min(src.length, dst.length - start);
  for (let i = 0; i < n; i++) dst[start + i] += src[i] * gain;
}

export function reverseInPlace(buf: Float32Array): void {
  buf.reverse();
}
