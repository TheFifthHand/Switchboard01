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

  it('Fade In and Fade Out shape the one-shot edges over their set times, at any pitch', async () => {
    for (const pitch of [0, 12]) {
      const rate = Math.pow(2, pitch / 12);
      const T = 0.05;
      const outLen = 0.8 / rate;
      const r = await render(1, sampler({ start: 0, end: 0.8, fadeIn: 100, fadeOut: 200, pitch }), (e) => {
        e.trigger({ pitch: 60, velocity: 1, time: T });
      });
      // Local amplitude from the RMS of 4 periods centred on t.
      const period = 1 / (TONE_HZ * rate);
      const amp = (t: number) => Math.SQRT2 * rms(r.L, idx(t - 2 * period), idx(t + 2 * period));
      const steady = amp(T + 0.15);
      expect(steady, `pitch ${pitch}`).toBeGreaterThan(0.45);
      expect(amp(T + 0.05) / steady, `pitch ${pitch}: half-way into the fade-in`).toBeCloseTo(0.5, 1);
      expect(amp(T + outLen - 0.1) / steady, `pitch ${pitch}: half-way through the fade-out`).toBeCloseTo(0.5, 1);
      expect(amp(T + outLen - 0.05) / steady, `pitch ${pitch}: three quarters through the fade-out`).toBeCloseTo(0.25, 1);
      expect(extent(r.L).off).toBeGreaterThan(T + outLen - 0.002);
      expect(peak(r.L, idx(T + outLen) + 1)).toBe(0);
    }
  });

  it('a one-shot under full-scale pitch modulation fades out with its playhead: no click at the region end', async () => {
    // The region ends on a waveform peak: without a completed fade, running out there is a hard step.
    const quarter = 0.25 / TONE_HZ;
    const T = 0.05;
    const regionLen = 0.5 + quarter;
    for (const mod of ['+200', '-200', 'lfo', 'lfo-no-fades'] as const) {
      const r = await render(
        1,
        sampler({ start: 0, end: regionLen, ...(mod === 'lfo-no-fades' ? { fadeIn: 0, fadeOut: 0, pitch: 12 } : {}) }),
        (e, ctx) => {
          if (mod === '+200' || mod === '-200') {
            const c = new ConstantSourceNode(ctx, { offset: Number(mod) });
            c.connect(e.pitchMod);
            c.start(0);
          } else {
            // A +-200 ct LFO (one full-scale cable into the Pitch input), 7 Hz.
            const lfo = new OscillatorNode(ctx, { frequency: 7 });
            const depth = new GainNode(ctx, { gain: 200 });
            lfo.connect(depth).connect(e.pitchMod);
            lfo.start(0);
          }
          e.trigger({ pitch: 60, velocity: 1, time: T });
        },
      );
      const maxRate = Math.pow(2, (mod === 'lfo-no-fades' ? 1400 : 200) / 1200);
      const natural = (2 * Math.PI * TONE_HZ * TONE_AMP * maxRate) / SR;
      expect(maxStep(r.L), mod).toBeLessThan(natural * 1.1);
      if (mod === '+200' || mod === '-200') {
        // The region is still played to its end, just faster or slower.
        const expectedEnd = T + regionLen / Math.pow(2, Number(mod) / 1200);
        expect(Math.abs(extent(r.L).off - expectedEnd), mod).toBeLessThan(0.002);
      }
      expect(r.engine.activeVoices()).toBe(0);
    }
  });

  it('kill() still stops a one-shot that pitch modulation has slowed past its nominal end', async () => {
    // Region 0.5 s at -200 ct lasts 0.561 s: nominal end 0.55 s, real end 0.611 s.
    const r = await render(0.8, sampler({ start: 0, end: 0.5 }), (e, ctx, at) => {
      const c = new ConstantSourceNode(ctx, { offset: -200 });
      c.connect(e.pitchMod);
      c.start(0);
      e.trigger({ pitch: 60, velocity: 1, time: 0.05 });
      at(0.56, () => e.kill());
    });
    expect(rms(r.L, idx(0.551), idx(0.559))).toBeGreaterThan(0.2);
    expect(peak(r.L, idx(0.565) + 128)).toBe(0);
    expect(r.engine.activeVoices()).toBe(0);
  });

  it('a one-shot plays its whole region however short the note; stop() ends it early with the release', async () => {
    // A one-step note (0.125 s) on a 0.8 s region: the whole region still plays.
    const short = await render(1, sampler({ start: 0, end: 0.8 }), (e) => {
      const v = e.trigger({ pitch: 60, velocity: 1, time: 0.1, duration: 0.125 });
      v?.release(0.15); // a pad let go early changes nothing either
    });
    expect(rms(short.L, idx(0.6), idx(0.85))).toBeGreaterThan(0.3);
    const { off } = extent(short.L);
    expect(off).toBeGreaterThan(0.898);
    expect(off).toBeLessThanOrEqual(0.9);
    expect(short.engine.activeVoices()).toBe(0);

    // Stop: the release envelope (50 ms, longer than the 15 ms fade-out) from 0.3 s, no click.
    const stopped = await render(1, sampler({ start: 0, end: 0.8 }), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.1 })?.stop?.(0.3));
    expect(rms(stopped.L, idx(0.15), idx(0.29))).toBeGreaterThan(0.3);
    expect(peak(stopped.L, idx(0.355))).toBe(0);
    const natural = (2 * Math.PI * TONE_HZ * TONE_AMP) / SR;
    expect(maxStep(stopped.L, idx(0.29), idx(0.36))).toBeLessThan(natural * 1.3);
  });

  it('transport Stop (stopOneShots) ends playing one-shots but leaves held loops; releaseAll ends both', async () => {
    const run = (mode: number, stop: (e: SamplerEngine) => void) =>
      render(1, sampler({ mode, start: 0, end: 0.8 }), (e, _ctx, at) => {
        e.trigger({ pitch: 60, velocity: 1, time: 0.05, duration: 0.1 });
        e.trigger({ pitch: 72, velocity: 1, time: 0.7 }); // starts after the stop: never sounds
        at(0.25, () => stop(e));
      });
    const shot = await run(0, (e) => e.stopOneShots(0.3));
    expect(rms(shot.L, idx(0.1), idx(0.29))).toBeGreaterThan(0.3);
    expect(peak(shot.L, idx(0.3 + 0.05 + 0.003))).toBe(0);
    expect(shot.engine.activeVoices()).toBe(0);
    // A held loop (the 0.7 s note has no duration) keeps going: stopOneShots is not a note-off for it.
    const held = await render(1, sampler({ mode: 1, start: 0.2, end: 0.3 }), (e, _ctx, at) => {
      e.trigger({ pitch: 60, velocity: 1, time: 0.05 });
      at(0.25, () => e.stopOneShots(0.3));
    });
    expect(rms(held.L, idx(0.5), idx(0.95))).toBeGreaterThan(0.3);
    const all = await run(0, (e) => e.releaseAll(0.3));
    expect(peak(all.L, idx(0.3 + 0.05 + 0.003))).toBe(0);
  });

  it('a loop whose ends do not meet crossfades at the loop point: no click, and the loop keeps its exact length', async () => {
    const natural = (2 * Math.PI * TONE_HZ * TONE_AMP) / SR;
    // 0.2 s .. 0.3 s + 0.37 cycle: the region ends mid-cycle, so a plain loop jumps at every repeat.
    const odd = 0.3 + 0.37 / TONE_HZ;
    const r = await render(1.2, sampler({ mode: 1, start: 0.2, end: odd }), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05, duration: 1 }));
    expect(maxStep(r.L, idx(0.06), idx(1.04))).toBeLessThan(natural * 1.3);
    // Every repeat is the same stretch of audio, exactly one region apart.
    const L = Math.round((odd - 0.2) * SR);
    const a = idx(0.05) + L + 100;
    let diff = 0;
    for (let i = 0; i < L; i++) diff = Math.max(diff, Math.abs(r.L[a + i] - r.L[a + L + i]));
    expect(diff).toBeLessThan(1e-5);
    // The first pass is the region as trimmed, up to the crossfade over its last Fade Out (15 ms).
    const first = await render(0.4, sampler({ start: 0.2, end: odd }), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05 }));
    let pass = 0;
    for (let i = idx(0.06); i < idx(0.05) + L - 800; i++) pass = Math.max(pass, Math.abs(r.L[i] - first.L[i]));
    expect(pass).toBeLessThan(1e-5);

    // A region that is the whole recording (nothing after it to borrow) loops click-free too.
    const bank = makeBank();
    bank.add('odd', audioBufferFromChannels(toneChannels(0.9 + 0.37 / TONE_HZ), SR));
    const whole = await render(2.2, sampler({ mode: 1 }, 'odd'), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05, duration: 2 }), { bank });
    expect(rms(whole.L, idx(1.0), idx(1.9))).toBeGreaterThan(0.3);
    expect(maxStep(whole.L, idx(0.06), idx(2.04))).toBeLessThan(natural * 1.5);
  });

  it('every repeat of a loop keeps the region’s own attack (a drum loop’s downbeat is not softened)', async () => {
    // A "drum loop": two sharp noise hits 0.2 s apart, each decaying, after 0.1 s of silence.
    const hits = (lead: number) => {
      const x = new Float32Array(Math.round((lead + 0.4) * SR));
      for (const at of [lead, lead + 0.2]) {
        const rng = new Rng(9); // identical hits
        for (let i = 0; i < idx(0.15); i++) x[idx(at) + i] = 0.8 * Math.exp(-i / idx(0.02)) * rng.noise();
      }
      return audioBufferFromChannels([x], SR);
    };
    const attack = (x: Float32Array, at: number) => peak(x, idx(at), idx(at + 0.003));
    const bank = makeBank();
    bank.add('loop-lead', hits(0.1));
    bank.add('loop-whole', hits(0));
    // Region with audio (silence) before it, and a region that starts at the very beginning of the recording.
    const cases: { id: string; params: Record<string, number> }[] = [
      { id: 'loop-lead', params: { mode: 1, start: 0.1 / 0.5, end: 1 } },
      { id: 'loop-whole', params: { mode: 1 } },
    ];
    for (const c of cases) {
      const r = await render(1.5, sampler(c.params, c.id), (e) => void e.trigger({ pitch: 60, velocity: 1, time: 0.05, duration: 1.3 }), { bank });
      // Reference: the second hit of the first pass (away from the note start and the loop point).
      const ref = attack(r.L, 0.05 + 0.2);
      expect(ref).toBeGreaterThan(0.1);
      // Repeats start 0.4 s apart and their downbeat hits exactly as hard.
      for (const n of [1, 2]) expect(Math.abs(attack(r.L, 0.05 + n * 0.4) - ref) / ref).toBeLessThan(0.02);
    }
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

  it('releaseAll() releases held loops smoothly and cancels notes that start later', async () => {
    const r = await render(0.8, sampler({ mode: 1, start: 0.2, end: 0.3 }), (e, _ctx, at) => {
      e.trigger({ pitch: 60, velocity: 1, time: 0.05 });
      e.trigger({ pitch: 67, velocity: 1, time: 0.05 });
      e.trigger({ pitch: 64, velocity: 1, time: 0.5 }); // after the releaseAll time: never sounds
      at(0.25, () => e.releaseAll(0.3));
    });
    expect(rms(r.L, idx(0.1), idx(0.29))).toBeGreaterThan(0.2);
    // Release 50 ms from 0.3 s, then exact silence (nothing starts at 0.5 s).
    expect(peak(r.L, idx(0.3 + 0.05 + 0.003) + 1)).toBe(0);
    const natural = (2 * Math.PI * TONE_HZ * Math.pow(2, 7 / 12) * 2 * TONE_AMP) / SR;
    expect(maxStep(r.L, idx(0.29), idx(0.36))).toBeLessThan(natural);
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
