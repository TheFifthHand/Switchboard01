/**
 * Loudness metering (BS.1770-4 / EBU R128) and the oversampling half-bands,
 * checked in Node against reference signals: EBU Tech 3341-style sine
 * sequences for the gates, momentary and short-term windows, true peak of
 * inter-sample peaks, and the live meter's worklet processor itself (run in
 * Node) agreeing with the offline analysis.
 */
import { describe, expect, it } from 'vitest';
import { HALFBAND_JS, HALFBAND_STEEP, HALFBAND_WIDE, halfbandMagnitude } from '../../src/audio/worklets/halfband';
import { LOUDNESS_PROCESSOR_NAME, LOUDNESS_WORKLET_SOURCE, kWeightingCoefs, loudnessProcessorOptions } from '../../src/audio/worklets/loudness';
import { measureLoudness, truePeak } from '../../src/render/loudness';
import { concat, dbfs, loadProcessors, runProcessor, sine } from './omni-fx-harness';

const SR = 48000;
const sec = (s: number) => Math.round(s * SR);
/** A 1 kHz sine whose peak is `db` dBFS, `seconds` long (stereo: same on both channels). */
const tone = (db: number, seconds: number) => sine(sec(seconds), 1000, dbfs(db), SR);

describe('K-weighting', () => {
  it('matches the BS.1770 coefficient table at 48 kHz', () => {
    const [shelf, hp] = kWeightingCoefs(48000);
    const expected = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
    shelf.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 8));
    expect(hp.slice(0, 3)).toEqual([1, -2, 1]);
    expect(hp[3]).toBeCloseTo(-1.99004745483398, 8);
    expect(hp[4]).toBeCloseTo(0.99007225036621, 8);
  });
});

describe('integrated loudness (EBU Tech 3341 style cases)', () => {
  it('a stereo 1 kHz sine at −23 dBFS reads −23 LUFS; at −33 dBFS, −33 LUFS', () => {
    for (const level of [-23, -33]) {
      const x = tone(level, 20);
      const r = measureLoudness(x, x, SR, { truePeak: false });
      expect(Math.abs(r.integrated - level)).toBeLessThan(0.1);
      expect(Math.abs(r.momentaryMax - level)).toBeLessThan(0.1);
      expect(Math.abs(r.shortTermMax - level)).toBeLessThan(0.1);
    }
  });

  it('the relative gate ignores quiet passages (−36 / −23 / −36 dBFS → −23 LUFS)', () => {
    const x = concat(tone(-36, 10), tone(-23, 60), tone(-36, 10));
    expect(Math.abs(measureLoudness(x, x, SR, { truePeak: false }).integrated + 23)).toBeLessThan(0.1);
  });

  it('the absolute gate ignores near-silence (−72 / −36 / −23 / −36 / −72 dBFS → −23 LUFS)', () => {
    const x = concat(tone(-72, 10), tone(-36, 10), tone(-23, 60), tone(-36, 10), tone(-72, 10));
    expect(Math.abs(measureLoudness(x, x, SR, { truePeak: false }).integrated + 23)).toBeLessThan(0.1);
  });

  it('power averaging: −26 / −20 / −26 dBFS (20 s / 20.1 s / 20 s) → −23 LUFS', () => {
    const x = concat(tone(-26, 20), tone(-20, 20.1), tone(-26, 20));
    expect(Math.abs(measureLoudness(x, x, SR, { truePeak: false }).integrated + 23)).toBeLessThan(0.1);
  });

  it('one channel alone reads 3 dB lower than the same sine on both', () => {
    const x = tone(-20, 5);
    const silent = new Float32Array(x.length);
    const one = measureLoudness(x, silent, SR, { truePeak: false }).integrated;
    const both = measureLoudness(x, x, SR, { truePeak: false }).integrated;
    expect(both - one).toBeCloseTo(10 * Math.log10(2), 1);
  });

  it('silence is −Infinity, never NaN', () => {
    const z = new Float32Array(sec(2));
    const r = measureLoudness(z, z, SR);
    expect(r.integrated).toBe(-Infinity);
    expect(r.momentaryMax).toBe(-Infinity);
    expect(r.truePeakDb).toBe(-Infinity);
  });
});

describe('true peak (4x)', () => {
  it('finds the inter-sample peak of a quarter-rate sine at 45° (3 dB above its samples)', () => {
    const amp = dbfs(-6);
    const x = sine(sec(1), SR / 4, amp, SR, Math.PI / 4);
    const r = measureLoudness(x, x, SR);
    expect(r.samplePeakDb).toBeCloseTo(-6 - 3.0103, 1);
    expect(Math.abs(r.truePeakDb + 6)).toBeLessThan(0.1);
  });

  it('reads the sample peak for a low tone, and true peak is never below the sample peak', () => {
    const x = sine(sec(1), 997, dbfs(-3), SR, 0.3);
    const tp = 20 * Math.log10(truePeak(x));
    expect(Math.abs(tp + 3)).toBeLessThan(0.05);
    const y = sine(sec(0.5), 18000, 0.5, SR, 1.1);
    let sp = 0;
    for (const v of y) sp = Math.max(sp, Math.abs(v));
    expect(truePeak(y)).toBeGreaterThanOrEqual(sp);
    expect(Math.abs(20 * Math.log10(truePeak(y) / 0.5))).toBeLessThan(0.3);
  });
});

describe('live meter worklet (run in Node)', () => {
  const Proc = loadProcessors(LOUDNESS_WORKLET_SOURCE, SR).get(LOUDNESS_PROCESSOR_NAME)!;

  it('registers and reports momentary, short-term, integrated and true peak every 100 ms', () => {
    const x = tone(-23, 5);
    const { processor } = runProcessor(Proc, x, x, { options: { processorOptions: loudnessProcessorOptions(SR, true) } });
    const msgs = processor.port.messages as { m: number; s: number; i: number; tp: number }[];
    expect(msgs.length).toBe(50);
    const last = msgs[msgs.length - 1];
    expect(Math.abs(last.m + 23)).toBeLessThan(0.1);
    expect(Math.abs(last.s + 23)).toBeLessThan(0.1);
    expect(Math.abs(last.i + 23)).toBeLessThan(0.1);
    expect(Math.abs(last.tp + 23)).toBeLessThan(0.05);
  });

  it('agrees with the offline analysis on a gated sequence, and reset restarts the integration', () => {
    const x = concat(tone(-26, 8), tone(-20, 8), tone(-40, 4));
    const offline = measureLoudness(x, x, SR, { truePeak: false }).integrated;
    const opts = { processorOptions: { ...loudnessProcessorOptions(SR, true), tp: [] } };
    const { processor } = runProcessor(Proc, x, x, { options: opts });
    const msgs = processor.port.messages as { i: number }[];
    expect(Math.abs(msgs[msgs.length - 1].i - offline)).toBeLessThan(0.02);

    // Reset after the loud part: only the quiet tail counts.
    const y = concat(tone(-20, 4), tone(-30, 6));
    const run2 = runProcessor(Proc, y, y, {
      options: opts,
      onBlock: (f, p) => {
        if (f === Math.floor(sec(4) / 128) * 128) p.port.onmessage?.({ data: 'reset' });
      },
    });
    const m2 = run2.processor.port.messages as { i: number }[];
    expect(Math.abs(m2[m2.length - 1].i + 30)).toBeLessThan(0.15);
  });

  it('true peak follows inter-sample peaks that grow later (block skipping never misses one)', () => {
    // Quarter-rate sines at 45°: samples sit 3 dB below the real peaks. −12 dBTP, then −6 dBTP.
    const x = concat(sine(sec(1), SR / 4, dbfs(-12), SR, Math.PI / 4), sine(sec(1), SR / 4, dbfs(-6), SR, Math.PI / 4));
    const { processor } = runProcessor(Proc, x, x, { options: { processorOptions: loudnessProcessorOptions(SR, true) } });
    const msgs = processor.port.messages as { tp: number }[];
    expect(Math.abs(msgs[5].tp + 12)).toBeLessThan(0.1);
    expect(Math.abs(msgs[msgs.length - 1].tp + 6)).toBeLessThan(0.1);
    // The offline analysis also sees the abrupt ends of the test signal (edge ringing), hence 0.1 dB.
    expect(Math.abs(msgs[msgs.length - 1].tp - measureLoudness(x, x, SR).truePeakDb)).toBeLessThan(0.1);
  });

  it('silence reports −Infinity (finite-safe), never NaN', () => {
    const z = new Float32Array(sec(1));
    const { processor } = runProcessor(Proc, z, z, { options: { processorOptions: loudnessProcessorOptions(SR, true) } });
    const last = processor.port.messages[processor.port.messages.length - 1] as Record<string, number>;
    for (const k of ['m', 's', 'i', 'tp']) expect(last[k]).toBe(-Infinity);
  });
});

describe('oversampling half-bands', () => {
  it('reject images and aliases by more than 75 dB with a flat pass band', () => {
    for (const [coefs, t] of [[HALFBAND_STEEP, 0.02], [HALFBAND_WIDE, 0.12]] as const) {
      let stop = 0;
      for (let f = 0.25 + t; f <= 0.5; f += 0.0005) stop = Math.max(stop, halfbandMagnitude(coefs, f));
      expect(20 * Math.log10(stop)).toBeLessThan(-75);
      for (let f = 0; f <= 0.25 - t; f += 0.0005) expect(Math.abs(20 * Math.log10(halfbandMagnitude(coefs, f)))).toBeLessThan(1e-3);
    }
  });

  it('up then down is an all-pass (unity gain at every frequency) and upsampling leaves no image', () => {
    const SbHalfband = new Function(`${HALFBAND_JS}\nreturn SbHalfband;`)() as new (c: number[]) => {
      up(v: number): void;
      down(a: number, b: number): number;
      o0: number;
      o1: number;
    };
    for (const f of [50, 1000, 8000, 18000]) {
      const up = new SbHalfband(HALFBAND_STEEP);
      const down = new SbHalfband(HALFBAND_STEEP);
      const x = sine(sec(0.5), f, 0.5, SR);
      const y = new Float32Array(x.length);
      const u = new Float64Array(2 * x.length);
      for (let i = 0; i < x.length; i++) {
        up.up(x[i]);
        u[2 * i] = up.o0;
        u[2 * i + 1] = up.o1;
        y[i] = down.down(up.o0, up.o1);
      }
      // Amplitude from the RMS over the settled part (sample maxima miss the peaks of high tones).
      let s = 0;
      for (let i = sec(0.2); i < x.length; i++) s += y[i] * y[i];
      expect(Math.sqrt((2 * s) / (x.length - sec(0.2)))).toBeCloseTo(0.5, 3);
      // The upsampled signal carries no image at 48 kHz − f.
      const img = 48000 - f;
      let re = 0;
      let im = 0;
      for (let i = 2 * sec(0.2); i < u.length; i++) {
        re += u[i] * Math.cos((2 * Math.PI * img * i) / (2 * SR));
        im += u[i] * Math.sin((2 * Math.PI * img * i) / (2 * SR));
      }
      const imgAmp = (2 * Math.hypot(re, im)) / (u.length - 2 * sec(0.2));
      expect(20 * Math.log10(imgAmp / 0.5)).toBeLessThan(-70);
    }
  });
});
