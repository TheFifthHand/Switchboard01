/**
 * Small plain-JS helpers shared by the studio worklet processors. Each
 * processor source includes them (worklet modules do not share scope).
 */

export const WORKLET_COMMON_JS = /* js */ `
const SB_LN10_20 = Math.LN10 / 20;
/** a-rate parameter value at frame i (constant blocks have length 1). */
function sbAt(a, i) {
  return a.length > 1 ? a[i] : a[0];
}
/** Non-finite or absurd input (a misbehaving upstream node) reads as silence. */
function sbIn(v) {
  return v > -1e6 && v < 1e6 ? v : 0;
}
/** Flush tiny values to zero so recursive filters never run on denormals. */
function sbTidy(v) {
  return v < 1e-20 && v > -1e-20 ? 0 : v;
}
function sbDbToGain(db) {
  return Math.exp(db * SB_LN10_20);
}
/** One-pole coefficient for a time constant in seconds. */
function sbPole(seconds) {
  return seconds > 0 ? Math.exp(-1 / (seconds * sampleRate)) : 0;
}
/** mulberry32 PRNG (same generator as src/project/rng.ts). */
function sbRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 4-point cubic Hermite read of ring buffer \`buf\` (size mask+1) at fractional position pos. */
function sbHermite(buf, mask, pos) {
  const i = Math.floor(pos);
  const f = pos - i;
  const xm1 = buf[(i - 1) & mask];
  const x0 = buf[i & mask];
  const x1 = buf[(i + 1) & mask];
  const x2 = buf[(i + 2) & mask];
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}
/** RBJ biquad coefficients [b0, b1, b2, a1, a2] (normalised). */
function sbBiquad(type, freq, q) {
  const f = Math.min(Math.max(freq, 1), sampleRate * 0.45);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cs = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  if (type === 'hp') {
    return [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, (-2 * cs) / a0, (1 - alpha) / a0];
  }
  return [(1 - cs) / 2 / a0, (1 - cs) / a0, (1 - cs) / 2 / a0, (-2 * cs) / a0, (1 - alpha) / a0];
}
function sbRegister(name, cls) {
  try {
    registerProcessor(name, cls);
  } catch (err) {
    // Already registered in this context (a second load): keep the first definition.
    if (!err || err.name !== 'NotSupportedError') throw err;
  }
}
`;

/** Parameter descriptor of the k-rate "flush" counter every studio processor has. */
export const FLUSH_PARAM_JS = `{ name: 'flush', defaultValue: 0, minValue: 0, maxValue: 1e9, automationRate: 'k-rate' }`;
