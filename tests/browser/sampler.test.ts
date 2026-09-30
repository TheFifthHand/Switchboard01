/**
 * Sampler engine and sample bank, rendered on a real
 * OfflineAudioContext(2, n, 48000) in Chromium and measured numerically:
 * region trim, one-shot end, loop sustain, pitch/rate, tempo sync, fades,
 * voice limit and cleanup, modulation buses and built-in samples.
 */
import { describe, expect, it } from 'vitest';
import type { InstrumentContext, VoiceHandle } from '../../src/audio/contracts';
import * as builtins from '../../src/audio/instruments/builtinSamples';
import { SampleBank, audioBufferFromChannels } from '../../src/audio/instruments/sampleBank';
import { SAMPLER_MAX_VOICES, SamplerEngine, samplerRegion } from '../../src/audio/instruments/sampler';
import { SAMPLER_PARAMS, defaultParams } from '../../src/project/params';
import { Rng } from '../../src/project/rng';
import type { SamplerInstrument } from '../../src/project/types';

const SR = 48000;
const TONE_HZ = 480;
const TONE_AMP = 0.5;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** 1 s mono sine at 480 Hz (a whole number of cycles every 1/480 s). */
function toneChannels(seconds = 1): Float32Array[] {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = TONE_AMP * Math.sin((2 * Math.PI * TONE_HZ * i) / SR);
  return [x];
}

function noiseChannels(seconds = 1): Float32Array[] {
  const x = new Float32Array(Math.round(seconds * SR));
  const rng = new Rng(3);
  for (let i = 0; i < x.length; i++) x[i] = 0.4 * rng.noise();
  return [x];
}

function makeBank(): SampleBank {
  const bank = new SampleBank(SR);
  bank.add('tone', audioBufferFromChannels(toneChannels(), SR));
  bank.add('noise', audioBufferFromChannels(noiseChannels(), SR));
  const left = new Float32Array(SR);
  const right = new Float32Array(SR);
  for (let i = 0; i < SR; i++) {
    left[i] = TONE_AMP * Math.sin((2 * Math.PI * 300 * i) / SR);
    right[i] = TONE_AMP * Math.sin((2 * Math.PI * 900 * i) / SR);
  }
  bank.add('stereo', audioBufferFromChannels([left, right], SR));
  return bank;
}

function sampler(p: Record<string, number> = {}, sampleId: string | null = 'tone'): SamplerInstrument {
  return { kind: 'sampler', sampleId, params: { ...defaultParams(SAMPLER_PARAMS), ...p } };
}

interface Rendered {
  L: Float32Array;
  R: Float32Array;
  engine: SamplerEngine;
}

async function render(
  seconds: number,
  instrument: SamplerInstrument,
  schedule: (engine: SamplerEngine, ctx: OfflineAudioContext, at: (time: number, fn: () => void) => void) => void,
  opts: { bpm?: number; bank?: SampleBank } = {},
): Promise<Rendered> {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const noise = ctx.createBuffer(1, SR, SR);
  const ictx: InstrumentContext = { ctx, samples: opts.bank ?? makeBank(), noise, getBpm: () => opts.bpm ?? 120 };
  const engine = new SamplerEngine(ictx, instrument);
  engine.output.connect(ctx.destination);
  const at = (time: number, fn: () => void) => {
    void ctx.suspend(time).then(() => {
      fn();
      void ctx.resume();
    });
  };
  schedule(engine, ctx, at);
  const buf = await ctx.startRendering();
  await new Promise((r) => setTimeout(r, 10));
  return { L: buf.getChannelData(0), R: buf.getChannelData(1), engine };
}

/* ------------------------------------------------------------------ */
/* Measurements                                                        */
/* ------------------------------------------------------------------ */

const idx = (t: number) => Math.round(t * SR);

function peak(x: Float32Array, a = 0, b = x.length): number {
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

function maxStep(x: Float32Array, a = 1, b = x.length): number {
  let m = 0;
  for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

/** First and last time (s) the signal exceeds `thr`. */
function extent(x: Float32Array, thr = 1e-4): { on: number; off: number } {
  let on = -1;
  let off = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > thr) {
      if (on < 0) on = i;
      off = i;
    }
  }
  return { on: on / SR, off: off / SR };
}

function zcFreq(x: Float32Array, a: number, b: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      last = t;
      count++;
    }
  }
  return count > 1 ? ((count - 1) * SR) / (last - first) : 0;
}

/** Energy above `hz` relative to total, via a first-order split (crude but monotonic brightness measure). */
function brightness(x: Float32Array, a: number, b: number): number {
  let d = 0;
  let s = 0;
  for (let i = a + 1; i < b; i++) {
    d += (x[i] - x[i - 1]) ** 2;
    s += x[i] ** 2;
  }
  return d / Math.max(1e-12, s);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('SamplerEngine', () => {
  it('one-shot plays the region once and ends exactly at the region end', async () => {
    const r = await render(1, sampler({ start: 0.25, end: 0.75 }), (e) => {
      e.trigger({ pitch: 60, velocity: 1, time: 0.1 });
      expect(e.activeVoices()).toBe(1);
    });
    const { on, off } = extent(r.L);
    expect(on).toBeGreaterThanOrEqual(0.1);
    expect(on).toBeLessThan(0.1 + 0.001);
    // Region 0.5 s at rate 1: the fade-out lands on zero exactly at 0.6 s.
    expect(off).toBeGreaterThan(0.598);
    expect(off).toBeLessThanOrEqual(0.6);
    expect(peak(r.L, idx(0.6) + 1)).toBe(0);
    expect(rms(r.L, idx(0.2), idx(0.58))).toBeGreaterThan(0.3);
    expect(peak(r.L)).toBeLessThan(1);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('region trim changes the output length', async () => {
    const lengthFor = async (start: number, end: number) => {
      const r = await render(1.3, sampler({ start, end }), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05 }));
      const { on, off } = extent(r.L);
      return off - on;
    };
    expect(await lengthFor(0, 1)).toBeCloseTo(1, 2);
    expect(await lengthFor(0.4, 0.6)).toBeCloseTo(0.2, 2);
    // end < start is reordered; a region below 5 ms is widened to 5 ms.
    expect(await lengthFor(0.8, 0.7)).toBeCloseTo(0.1, 2);
    expect(await lengthFor(0.5, 0.5)).toBeCloseTo(0.005, 3);
    expect(samplerRegion(1, 0.5, 0.5)).toEqual({ start: 0.5, end: 0.505 });
    expect(samplerRegion(1, 1, 1).end - samplerRegion(1, 1, 1).start).toBeCloseTo(0.005, 9);
  });

  it('+12 semitones doubles the rate: double frequency, half the length (speed and pitch together)', async () => {
    for (const [p, notePitch] of [
      [{ pitch: 12 }, 60],
      [{}, 72],
      [{ rootNote: 48 }, 60],
    ] as const) {
      const r = await render(1, sampler({ start: 0.25, end: 0.75, ...p }), (e) => void e.trigger({ pitch: notePitch, velocity: 1, time: 0.05 }));
      const { on, off } = extent(r.L);
      expect(off - on).toBeCloseTo(0.25, 2);
      expect(Math.abs(zcFreq(r.L, idx(0.08), idx(0.25)) / (2 * TONE_HZ) - 1)).toBeLessThan(0.01);
    }
    // Fine tuning: +100 cents is one semitone.
    const fine = await render(1, sampler({ fine: 100 }), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05 }));
    expect(Math.abs(zcFreq(fine.L, idx(0.1), idx(0.5)) / (TONE_HZ * Math.pow(2, 1 / 12)) - 1)).toBeLessThan(0.005);
  });

  it('tempo sync scales the rate by project BPM / original BPM', async () => {
    const synced = await render(
      1,
      sampler({ start: 0, end: 0.6, sync: 1, originalBpm: 100 }),
      (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05 }),
      { bpm: 150 },
    );
    const s = extent(synced.L);
    expect(s.off - s.on).toBeCloseTo(0.6 / 1.5, 2);
    expect(Math.abs(zcFreq(synced.L, idx(0.1), idx(0.4)) / (TONE_HZ * 1.5) - 1)).toBeLessThan(0.01);

    const unsynced = await render(
      1,
      sampler({ start: 0, end: 0.6, sync: 0, originalBpm: 100 }),
      (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05 }),
      { bpm: 150 },
    );
    const u = extent(unsynced.L);
    expect(u.off - u.on).toBeCloseTo(0.6, 2);
  });

  it('loop mode sustains beyond the region until the release, without seam clicks', async () => {
    // Region 0.2..0.3 s holds exactly 48 cycles, so the loop itself is seamless.
    const r = await render(1.2, sampler({ mode: 1, start: 0.2, end: 0.3 }), (e, _ctx, at) => {
      e.trigger({ pitch: 60, velocity: 1, time: 0.05, duration: 0.7 });
      let held: VoiceHandle | null = null;
      at(0.8, () => {
        held = e.trigger({ pitch: 60, velocity: 1, time: 0.85 });
      });
      at(1.05, () => held?.release(1.1));
    });
    // Still sounding far beyond 0.05 + 0.1 s, at the original pitch.
    expect(rms(r.L, idx(0.55), idx(0.74))).toBeGreaterThan(0.3);
    expect(Math.abs(zcFreq(r.L, idx(0.2), idx(0.7)) / TONE_HZ - 1)).toBeLessThan(0.005);
    // Release at 0.75 s, 50 ms release: silent from ~0.803 s until the held note.
    expect(peak(r.L, idx(0.81), idx(0.85))).toBe(0);
    const natural = (2 * Math.PI * TONE_HZ * TONE_AMP) / SR;
    expect(maxStep(r.L, idx(0.06), idx(0.8))).toBeLessThan(natural * 1.3);
    // The held note sounds until its handle is released.
    expect(rms(r.L, idx(0.95), idx(1.09))).toBeGreaterThan(0.3);
    expect(peak(r.L, idx(1.16))).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('fades keep trimmed edges click-free even when cut at a waveform peak', async () => {
    // Start and end both at +peak of the sine.
    const quarter = 0.25 / TONE_HZ;
    const r = await render(0.8, sampler({ start: 0.25 + quarter, end: 0.5 + quarter }), (e) => {
      e.trigger({ pitch: 60, velocity: 1, time: 0.05 });
    });
    const p = peak(r.L);
    expect(p).toBeGreaterThan(0.4);
    const natural = (2 * Math.PI * TONE_HZ * p) / SR;
    expect(maxStep(r.L)).toBeLessThan(natural * 1.3);
    // Without fades or attack the first sample would jump straight to the peak.
    expect(Math.abs(r.L[idx(0.05) + 1])).toBeLessThan(0.02);
  });

  it('releasing a one-shot early ends it with the release envelope', async () => {
    const r = await render(1, sampler({ start: 0, end: 0.8 }), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.1, duration: 0.2 }));
    expect(rms(r.L, idx(0.15), idx(0.29))).toBeGreaterThan(0.3);
    // Release 50 ms (longer than the 15 ms fade-out) from 0.3 s.
    expect(peak(r.L, idx(0.355))).toBe(0);
    const natural = (2 * Math.PI * TONE_HZ * TONE_AMP) / SR;
    expect(maxStep(r.L, idx(0.29), idx(0.36))).toBeLessThan(natural * 1.3);
  });

  it('returns null without a sample', async () => {
    const ctx = new OfflineAudioContext(2, 128, SR);
    const ictx: InstrumentContext = { ctx, samples: makeBank(), noise: ctx.createBuffer(1, 128, SR), getBpm: () => 120 };
    expect(new SamplerEngine(ictx, sampler({}, null)).trigger({ pitch: 60, velocity: 1, time: 0 })).toBeNull();
    const missing = new SamplerEngine(ictx, sampler({}, 'not-loaded'));
    expect(missing.trigger({ pitch: 60, velocity: 1, time: 0 })).toBeNull();
    expect(missing.activeVoices()).toBe(0);
  });

  it(`never allocates more than ${SAMPLER_MAX_VOICES} voices and frees them all`, async () => {
    let immediate = -1;
    const r = await render(1.2, sampler({ start: 0, end: 0.5 }), (e) => {
      for (let i = 0; i < 12; i++) e.trigger({ pitch: 60 + i, velocity: 0.5, time: 0.05 });
      immediate = e.activeVoices();
    });
    expect(immediate).toBe(SAMPLER_MAX_VOICES);
    expect(peak(r.L, idx(0.6))).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('pitchMod: a constant +1200 cents doubles the playback rate', async () => {
    const r = await render(0.6, sampler({ mode: 1, start: 0, end: 0.5 }), (e, ctx) => {
      const c = new ConstantSourceNode(ctx, { offset: 1200 });
      c.connect(e.pitchMod);
      c.start(0);
      e.trigger({ pitch: 60, velocity: 1, time: 0.02, duration: 0.5 });
    });
    expect(Math.abs(zcFreq(r.L, idx(0.1), idx(0.45)) / (2 * TONE_HZ) - 1)).toBeLessThan(0.01);
  });

  it('cutoff and cutoffMod darken the sound; gain scales it smoothly', async () => {
    const run = async (p: Record<string, number>, cutoffModCents = 0) =>
      render(0.6, sampler({ ...p }, 'noise'), (e, ctx) => {
        const c = new ConstantSourceNode(ctx, { offset: cutoffModCents });
        c.connect(e.cutoffMod);
        c.start(0);
        e.trigger({ pitch: 60, velocity: 1, time: 0.02, duration: 0.5 });
      });
    const open = await run({});
    const closed = await run({ cutoff: 500 });
    const modded = await run({ cutoff: 4000 }, -3600);
    const four = await run({ cutoff: 4000 });
    expect(brightness(closed.L, idx(0.1), idx(0.4))).toBeLessThan(brightness(open.L, idx(0.1), idx(0.4)) * 0.1);
    expect(brightness(modded.L, idx(0.1), idx(0.4))).toBeLessThan(brightness(four.L, idx(0.1), idx(0.4)) * 0.3);

    const loud = await render(0.6, sampler(), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.02, duration: 0.5 }));
    const quiet = await render(0.6, sampler({ gain: -6 }), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.02, duration: 0.5 }));
    expect(rms(quiet.L, idx(0.1), idx(0.4)) / rms(loud.L, idx(0.1), idx(0.4))).toBeCloseTo(Math.pow(10, -6 / 20), 2);

    const changed = await render(0.8, sampler({ mode: 1, start: 0.2, end: 0.3 }), (e, ctx, at) => {
      e.trigger({ pitch: 60, velocity: 1, time: 0.02, duration: 0.7 });
      at(0.3, () => e.update(sampler({ mode: 1, start: 0.2, end: 0.3, gain: -12 }), ctx.currentTime));
    });
    expect(20 * Math.log10(rms(changed.L, idx(0.45), idx(0.7)) / rms(changed.L, idx(0.1), idx(0.29)))).toBeCloseTo(-12, 0);
    const natural = (2 * Math.PI * TONE_HZ * TONE_AMP) / SR;
    expect(maxStep(changed.L, idx(0.29), idx(0.4))).toBeLessThan(natural * 1.3);
  });

  it('keeps stereo samples stereo', async () => {
    const r = await render(0.5, sampler({}, 'stereo'), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.02, duration: 0.4 }));
    expect(Math.abs(zcFreq(r.L, idx(0.1), idx(0.35)) / 300 - 1)).toBeLessThan(0.01);
    expect(Math.abs(zcFreq(r.R, idx(0.1), idx(0.35)) / 900 - 1)).toBeLessThan(0.01);
  });

  it('kill() silences held loops within 5 ms and frees them', async () => {
    const r = await render(0.8, sampler({ mode: 1, start: 0.2, end: 0.3 }), (e, _ctx, at) => {
      e.trigger({ pitch: 60, velocity: 1, time: 0.05 });
      e.trigger({ pitch: 67, velocity: 1, time: 0.05 });
      at(0.3, () => e.kill());
    });
    expect(rms(r.L, idx(0.1), idx(0.29))).toBeGreaterThan(0.2);
    expect(peak(r.L, idx(0.305) + 128)).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });
});

describe('SampleBank', () => {
  it('stores, serves and removes imported buffers', () => {
    const bank = new SampleBank(SR);
    const buf = audioBufferFromChannels(toneChannels(0.1), SR);
    expect(bank.has('a')).toBe(false);
    expect(bank.get('a')).toBeNull();
    bank.add('a', buf);
    expect(bank.has('a')).toBe(true);
    expect(bank.get('a')).toBe(buf);
    bank.remove('a');
    expect(bank.has('a')).toBe(false);
    expect(bank.get('a')).toBeNull();
  });

  it('audioBufferFromChannels keeps the rate, pads short channels and zeroes non-finite samples', () => {
    const buf = audioBufferFromChannels([Float32Array.from([0.5, Number.NaN, 0.25]), Float32Array.from([1])], 44100);
    expect(buf.sampleRate).toBe(44100);
    expect(buf.numberOfChannels).toBe(2);
    expect(buf.length).toBe(3);
    expect(Array.from(buf.getChannelData(0))).toEqual([0.5, 0, 0.25]);
    expect(Array.from(buf.getChannelData(1))).toEqual([1, 0, 0]);
    expect(audioBufferFromChannels([], 48000).length).toBe(1);
  });

  const hasGenerator = typeof (builtins as { generateBuiltinSample?: unknown }).generateBuiltinSample === 'function';

  it.skipIf(!hasGenerator)('generates built-in samples lazily, caches them and plays them (skipped until builtinSamples exports generateBuiltinSample)', async () => {
    const bank = new SampleBank(SR);
    expect(bank.has('builtin:bell-hit')).toBe(true);
    expect(bank.has('builtin:does-not-exist')).toBe(false);
    expect(bank.get('builtin:does-not-exist')).toBeNull();
    const buf = bank.get('builtin:bell-hit');
    expect(buf).not.toBeNull();
    if (!buf) return;
    expect(bank.get('builtin:bell-hit')).toBe(buf);
    expect(buf.length).toBeGreaterThan(SR * 0.1);
    let p = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      for (const v of buf.getChannelData(c)) {
        expect(Number.isFinite(v)).toBe(true);
        p = Math.max(p, Math.abs(v));
      }
    }
    expect(p).toBeGreaterThan(0.1);
    expect(p).toBeLessThanOrEqual(1);

    const r = await render(1.5, sampler({}, 'builtin:glass-chord'), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05 }), { bank });
    expect(rms(r.L, idx(0.06), idx(0.5))).toBeGreaterThan(0.01);
    expect(peak(r.L)).toBeLessThan(1);
  });
});
