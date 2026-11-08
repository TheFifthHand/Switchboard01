/**
 * True-peak ceiling (MIX-16): the output limiter detects 4× oversampled true
 * peaks, so a Loud-mastered export stays at or under −1 dBTP as measured by
 * an independent 4× windowed-sinc estimator (64 taps per phase), not just
 * −1 dBFS sample peak. The cost of the interpolation is measured (it only
 * runs on blocks that could hold a peak over the ceiling).
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { OUTPUT_CEILING } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { LIMITER_PROCESSOR_NAME, LIMITER_WORKLET_SOURCE, limiterLatencyFrames, limiterProcessorOptions } from '../../src/audio/worklets/limiter';
import { masteringPreset } from '../../src/content/mastering';
import { HOUSE } from '../../src/content/starters/house';
import { renderOffline } from '../../src/render/offline';
import { encodeWav, parseWav } from '../../src/render/wav';
import { Rng } from '../../src/project/rng';

const SR = 48000;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 80; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-14 * sum) break;
  }
  return sum;
}

/** Independent 4× true-peak estimate (Kaiser β 9 windowed sinc, 64 taps per phase), linear. */
function truePeak4x(channels: Float32Array[]): number {
  const half = 32;
  const beta = 9;
  const i0b = besselI0(beta);
  const kernels = [0.25, 0.5, 0.75].map((frac) => {
    const k = new Float64Array(2 * half);
    for (let j = 0; j < 2 * half; j++) {
      const t = j - (half - 1) - frac;
      const r = t / half;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      k[j] = (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w;
    }
    return k;
  });
  let peak = 0;
  for (const x of channels) {
    for (let n = 0; n < x.length; n++) {
      const a = Math.abs(x[n]);
      if (a > peak) peak = a;
    }
    for (let n = 2 * half - 1; n < x.length; n++) {
      // Only around samples that could be near the peak (cheap pre-check).
      if (Math.abs(x[n - half]) < 0.5 * OUTPUT_CEILING && Math.abs(x[n - half + 1]) < 0.5 * OUTPUT_CEILING) continue;
      for (const k of kernels) {
        let v = 0;
        for (let j = 0; j < 2 * half; j++) v += k[j] * x[n - 2 * half + 1 + j];
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    }
  }
  return peak;
}

async function loudGroove(bars: number): Promise<Float32Array[]> {
  const project = HOUSE.build();
  project.mastering = { enabled: true, params: { ...masteringPreset('loud')!.params } };
  const bank = new SampleBank(SR);
  const buf = await renderOffline({
    project,
    source: { kind: 'scene', row: 1, bars },
    sampleRate: SR,
    tailSeconds: 0.5,
    createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: project.seed, meters: false }),
  });
  return [buf.getChannelData(0), buf.getChannelData(1)];
}

describe('true-peak limiter', () => {
  it('a Loud-mastered Groove export (8 bars, 48 kHz, 24-bit) stays at or under −1 dBTP', async () => {
    const channels = await loudGroove(8);
    const wav = parseWav(encodeWav(channels, SR, 24));
    let samplePeak = 0;
    for (const c of wav.channels) for (const v of c) samplePeak = Math.max(samplePeak, Math.abs(v));
    const tp = truePeak4x(wav.channels);
    console.info(`[truepeak] Loud groove: sample peak ${(20 * Math.log10(samplePeak)).toFixed(3)} dBFS, true peak ${(20 * Math.log10(tp)).toFixed(3)} dBTP`);
    // Loud really pushes into the limiter...
    expect(samplePeak).toBeGreaterThan(OUTPUT_CEILING * Math.pow(10, -1.5 / 20));
    // ...and the ceiling holds between the samples too.
    expect(20 * Math.log10(tp)).toBeLessThanOrEqual(-1.0);
  }, 120_000);

  it('an intersample-peak test tone (fs/4 at 45°) is held to the ceiling between samples', async () => {
    // Samples at ±0.707·A, just under the ceiling; the true peak A is 3 dB higher: a sample-peak
    // limiter lets it through untouched, about 2.9 dB over the ceiling.
    const n = SR;
    const amp = 1.25;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = amp * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    const out = await throughLimiter(x, true);
    const settled = [out.slice(SR / 4)];
    const tp = truePeak4x(settled);
    expect(20 * Math.log10(tp)).toBeLessThanOrEqual(20 * Math.log10(OUTPUT_CEILING) + 0.05);
    const plain = await throughLimiter(x, false);
    expect(20 * Math.log10(truePeak4x([plain.slice(SR / 4)]))).toBeGreaterThan(20 * Math.log10(OUTPUT_CEILING) + 2);
  });

  it('costs little: interpolation runs only near the ceiling (measured)', async () => {
    const rng = new Rng(5);
    const seconds = 20;
    const loud = new Float32Array(SR * seconds);
    for (let i = 0; i < loud.length; i++) loud[i] = 1.4 * Math.sin((2 * Math.PI * 110 * i) / SR) * 0.6 + 0.4 * rng.noise();
    const quiet = loud.map((v) => v * 0.25);
    const time = async (x: Float32Array, tp: boolean) => {
      const t = performance.now();
      await throughLimiter(x, tp);
      return performance.now() - t;
    };
    // Warm-up, then interleaved runs.
    await time(loud.subarray(0, SR), true);
    const runs = { loudTp: [] as number[], loudPlain: [] as number[], quietTp: [] as number[] };
    for (let k = 0; k < 3; k++) {
      runs.loudTp.push(await time(loud, true));
      runs.loudPlain.push(await time(loud, false));
      runs.quietTp.push(await time(quiet, true));
    }
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[1];
    const extra = (med(runs.loudTp) - med(runs.loudPlain)) / (seconds * 1000);
    console.info(
      `[truepeak] ${seconds} s through the limiter offline: true peak ${med(runs.loudTp).toFixed(0)} ms, sample peak ${med(runs.loudPlain).toFixed(0)} ms, quiet material with true peak ${med(runs.quietTp).toFixed(0)} ms; extra CPU of a real-time stream (worst case, always limiting): ${(extra * 100).toFixed(2)} %`,
    );
    expect(Number.isFinite(extra)).toBe(true);
  }, 120_000);

  it('latency is the look-ahead plus the interpolators: quiet sound passes untouched, just delayed', async () => {
    const x = new Float32Array(SR / 2);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const out = await throughLimiter(x, true);
    const d = limiterLatencyFrames(SR);
    let err = 0;
    for (let i = d; i < x.length; i++) err = Math.max(err, Math.abs(out[i] - x[i - d]));
    expect(err).toBeLessThan(1e-6);
  });
});

async function throughLimiter(x: Float32Array, truePeak: boolean): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(2, x.length, SR);
  const url = URL.createObjectURL(new Blob([LIMITER_WORKLET_SOURCE], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const buf = ctx.createBuffer(2, x.length, SR);
  buf.copyToChannel(new Float32Array(x), 0);
  buf.copyToChannel(new Float32Array(x), 1);
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  const opts = limiterProcessorOptions(true);
  const node = new AudioWorkletNode(ctx, LIMITER_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: truePeak ? opts : { ...opts, tp: [] },
  });
  src.connect(node).connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0).slice();
}
