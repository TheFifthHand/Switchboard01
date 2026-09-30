/**
 * The output limiter worklet and safety clipper, measured on real rendered audio.
 */
import { describe, expect, it } from 'vitest';
import { OUTPUT_CEILING } from '../../src/audio/contracts';
import {
  LIMITER_PROCESSOR_NAME,
  LIMITER_WORKLET_SOURCE,
  limiterLatencyFrames,
  limiterProcessorOptions,
  safetyClipperCurve,
} from '../../src/audio/worklets/limiter';
import { Rng } from '../../src/project/rng';

const SR = 48000;
const DELAY = limiterLatencyFrames(SR);

async function loadLimiter(ctx: BaseAudioContext): Promise<void> {
  const url = URL.createObjectURL(new Blob([LIMITER_WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Render stereo `input` through limiter (+ optional safety clipper). */
async function limit(inputL: Float32Array, inputR: Float32Array = inputL, withClipper = false): Promise<[Float32Array, Float32Array]> {
  const ctx = new OfflineAudioContext(2, inputL.length, SR);
  await loadLimiter(ctx);
  const buf = ctx.createBuffer(2, inputL.length, SR);
  buf.copyToChannel(Float32Array.from(inputL), 0);
  buf.copyToChannel(Float32Array.from(inputR), 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const node = new AudioWorkletNode(ctx, LIMITER_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: limiterProcessorOptions(true),
  });
  src.connect(node);
  if (withClipper) {
    const ws = ctx.createWaveShaper();
    ws.curve = safetyClipperCurve();
    ws.oversample = 'none';
    node.connect(ws);
    ws.connect(ctx.destination);
  } else {
    node.connect(ctx.destination);
  }
  src.start(0);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

function maxAbs(d: Float32Array, from = 0, to = d.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(d[i]));
  return m;
}

/** Amplitude of the `freq` component over [from, to) (single-bin DFT). */
function toneAmp(d: Float32Array, freq: number, from: number, to: number): number {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    const ph = (2 * Math.PI * freq * i) / SR;
    re += d[i] * Math.cos(ph);
    im += d[i] * Math.sin(ph);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

function sine(n: number, freq: number, amp: number): Float32Array {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return d;
}

describe('look-ahead limiter worklet', () => {
  it('holds a +18 dB overdriven sine under the ceiling without clipping it', async () => {
    const n = SR;
    const amp = OUTPUT_CEILING * Math.pow(10, 18 / 20);
    const [l, r] = await limit(sine(n, 220, amp));
    expect(maxAbs(l)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    expect(maxAbs(r)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    // Gain reduction, not clipping: the fundamental sits just under the ceiling
    // and the 3rd harmonic that a clipper would create stays small.
    const from = SR / 4;
    const to = SR - 4800;
    const fund = toneAmp(l, 220, from, to);
    const third = toneAmp(l, 660, from, to);
    expect(fund).toBeGreaterThan(OUTPUT_CEILING * 0.8);
    expect(fund).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-3);
    expect(third / fund).toBeLessThan(0.03);
    // A hard clip at 1/8 of the amplitude would park ~90% of samples at the ceiling.
    let atCeiling = 0;
    for (let i = from; i < to; i++) if (Math.abs(l[i]) > OUTPUT_CEILING * 0.98) atCeiling++;
    expect(atCeiling / (to - from)).toBeLessThan(0.15);
  });

  it('never exceeds the ceiling on seeded random bursts and single-sample spikes', async () => {
    const n = SR;
    const rng = new Rng(99);
    const l = new Float32Array(n);
    const rr = new Float32Array(n);
    let level = 0.1;
    for (let i = 0; i < n; i++) {
      if (i % 2400 === 0) level = rng.chance(0.5) ? rng.range(2, 12) : rng.range(0.05, 0.6);
      l[i] = rng.noise() * level;
      rr[i] = rng.noise() * level * 0.5;
    }
    // Isolated spikes, including one only on the right channel (stereo link).
    for (const i of [12000, 12001, 30000, 47000]) l[i] = 20;
    rr[20000] = -30;
    const [ol, or] = await limit(l, rr);
    expect(maxAbs(ol)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    expect(maxAbs(or)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    // The spike is turned down to exactly the ceiling, and (stereo link) the
    // left channel gets the same gain at that instant.
    const k = 20000 + DELAY;
    expect(Math.abs(or[k])).toBeGreaterThan(OUTPUT_CEILING * 0.99);
    expect(Math.abs(ol[k])).toBeLessThanOrEqual(Math.abs(l[20000]) * (OUTPUT_CEILING / 30) + 1e-6);
    let finite = true;
    for (const v of ol) if (!Number.isFinite(v)) finite = false;
    expect(finite).toBe(true);
  });

  it('passes a quiet signal unchanged apart from the look-ahead delay', async () => {
    const n = SR / 2;
    const x = sine(n, 440, 0.25);
    const [l] = await limit(x);
    let err = 0;
    for (let i = DELAY; i < n; i++) err = Math.max(err, Math.abs(l[i] - x[i - DELAY]));
    expect(err).toBeLessThan(1e-6);
    // First DELAY samples are the (silent) look-ahead buffer.
    expect(maxAbs(l, 0, DELAY)).toBeLessThan(1e-9);
  });

  it('ramps the gain down before a peak arrives and releases smoothly afterwards', async () => {
    const n = SR;
    const x = new Float32Array(n).fill(0.5);
    const peakAt = 10000;
    x[peakAt] = 5; // needs -15 dB for one sample
    const [l] = await limit(x);
    const outPeak = peakAt + DELAY;
    // The peak itself lands exactly on the ceiling.
    expect(Math.abs(l[outPeak])).toBeCloseTo(OUTPUT_CEILING, 3);
    // Gain before the peak: already reduced ~2.5 ms early (look-ahead), untouched 6 ms early.
    const gainAt = (i: number) => l[i] / 0.5;
    expect(gainAt(outPeak - Math.round(0.0025 * SR))).toBeLessThan(0.75);
    expect(gainAt(outPeak - Math.round(0.006 * SR))).toBeCloseTo(1, 5);
    // Attack is a ramp, not a step: consecutive samples change little.
    let maxStep = 0;
    for (let i = outPeak - DELAY; i < outPeak - 1; i++) maxStep = Math.max(maxStep, Math.abs(gainAt(i + 1) - gainAt(i)));
    expect(maxStep).toBeLessThan(0.01);
    // Release: still reduced 20 ms later, recovered (> 0.95) within 0.5 s, and never above unity.
    expect(gainAt(outPeak + Math.round(0.02 * SR))).toBeLessThan(0.9);
    expect(gainAt(outPeak + Math.round(0.5 * SR))).toBeGreaterThan(0.95);
    expect(maxAbs(l)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    let maxGain = 0;
    for (let i = outPeak + 1; i < n; i++) maxGain = Math.max(maxGain, gainAt(i));
    expect(maxGain).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('limiter + safety clipper keep any input bounded', async () => {
    const n = SR / 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = ((i % 480) / 480 - 0.5) * 400; // +/-200 sawtooth
    const [l] = await limit(x, x, true);
    expect(maxAbs(l)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
  });
});

describe('safety clipper curve', () => {
  it('is identity inside the ceiling, flat beyond it, and maps 0 to 0', async () => {
    const curve = safetyClipperCurve();
    expect(curve.length).toBeGreaterThanOrEqual(4097);
    expect(curve.length % 2).toBe(1);
    expect(curve[(curve.length - 1) / 2]).toBe(0);
    expect(maxAbs(curve)).toBeLessThanOrEqual(OUTPUT_CEILING);

    // Render a -3..3 ramp through a WaveShaper with the curve.
    const n = 48000;
    const ctx = new OfflineAudioContext(1, n, SR);
    const buf = ctx.createBuffer(1, n, SR);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = -3 + (6 * i) / (n - 1);
    buf.copyToChannel(x, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const ws = ctx.createWaveShaper();
    ws.curve = curve;
    ws.oversample = 'none';
    src.connect(ws);
    ws.connect(ctx.destination);
    src.start(0);
    const y = (await ctx.startRendering()).getChannelData(0);
    let maxIdentityErr = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(x[i]) < OUTPUT_CEILING - 0.002) maxIdentityErr = Math.max(maxIdentityErr, Math.abs(y[i] - x[i]));
    }
    expect(maxAbs(y)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-6);
    expect(maxIdentityErr).toBeLessThan(1e-4);
    expect(y[n - 1]).toBeCloseTo(OUTPUT_CEILING, 4);
    expect(y[0]).toBeCloseTo(-OUTPUT_CEILING, 4);
  });
});
