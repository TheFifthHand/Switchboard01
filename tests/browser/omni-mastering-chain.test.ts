/**
 * The mastering chain on the master bus, through the real engine:
 *  - neutral (and switched-off) mastering renders bit-for-bit like no mastering,
 *  - every preset does what its sentence says on a real starter mix
 *    (loudness, crest factor, spectral tilt, side energy) and never exceeds
 *    the −1 dBFS ceiling, even with Loudness +15 dB on hot material,
 *  - each stage measured with test tones: EQ bands, low cut, the Glue curve
 *    and its make-up, Warmth harmonics and (thanks to 4x oversampling) the
 *    absence of aliasing, Width / Mono Bass, the On/Off crossfade and Mute
 *    All flushing the Glue.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { OUTPUT_CEILING } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { MASTERING_PRESETS, masteringPreset } from '../../src/content/mastering';
import { getStarter } from '../../src/content/starters';
import { applyPresetToProject } from '../../src/content/presets';
import { createNote, createProject, moduleId } from '../../src/project/factory';
import { neutralMasteringParams } from '../../src/project/params';
import type { ParamValues, Project } from '../../src/project/types';
import { isAllFinite, powerSpectrum } from '../../src/render/analysis';
import { measureLoudness, sideToMidDb } from '../../src/render/loudness';
import { renderOffline } from '../../src/render/offline';
import { GLUE_MAKEUP_REF_DB, glueStaticReduction } from '../../src/audio/worklets/mastering';
import { LATENCY, SR, clone, coreProject, harness, moduleParams, pitchForHz, rms, toneAmp } from './engine-harness';

/* ------------------------------------------------------------------ */
/* Real mix                                                            */
/* ------------------------------------------------------------------ */

async function renderMix(p: Project, bars = 4, row = 1): Promise<{ L: Float32Array; R: Float32Array }> {
  const bank = new SampleBank(SR);
  const buf = await renderOffline({
    project: p,
    source: { kind: 'scene', row, bars },
    sampleRate: SR,
    tailSeconds: 0.3,
    createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: p.seed, meters: false }),
  });
  return { L: buf.getChannelData(0).slice(), R: buf.getChannelData(1).slice() };
}

function withMastering(p: Project, params: ParamValues, enabled = true): Project {
  const q = clone(p);
  q.mastering = { enabled, params: { ...neutralMasteringParams(), ...params } };
  return q;
}

function bandEnergy(x: Float32Array, lo: number, hi: number): number {
  const { power, binHz } = powerSpectrum(x, SR);
  let e = 0;
  for (let k = 0; k < power.length; k++) if (k * binHz >= lo && k * binHz <= hi) e += power[k];
  return e;
}

interface MixMetrics {
  lufs: number;
  /** Peak / RMS of the mono sum, dB. */
  crest: number;
  /** Highs (4–16 kHz) against the middle (0.5–2 kHz), dB. */
  tilt: number;
  /** Lows (20–150 Hz) against the middle, dB. */
  lows: number;
  /** Side-to-mid energy, dB. */
  sideMid: number;
  /** Side energy below 100 Hz, dB. */
  sideLow: number;
  /** Sample peak of the whole render, linear. */
  peak: number;
}

function metrics(L: Float32Array, R: Float32Array): MixMetrics {
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  // The steady groove: skip the first bar.
  const from = Math.round(L.length * 0.25);
  const l = L.subarray(from);
  const r = R.subarray(from);
  const mono = new Float32Array(l.length);
  const side = new Float32Array(l.length);
  let mp = 0;
  let ms = 0;
  for (let i = 0; i < l.length; i++) {
    mono[i] = 0.5 * (l[i] + r[i]);
    side[i] = 0.5 * (l[i] - r[i]);
    mp = Math.max(mp, Math.abs(mono[i]));
    ms += mono[i] * mono[i];
  }
  const mid = bandEnergy(mono, 500, 2000);
  return {
    lufs: measureLoudness(l, r, SR, { truePeak: false }).integrated,
    crest: 20 * Math.log10(mp / Math.sqrt(ms / mono.length)),
    tilt: 10 * Math.log10(bandEnergy(mono, 4000, 16000) / mid),
    lows: 10 * Math.log10(bandEnergy(mono, 20, 150) / mid),
    sideMid: sideToMidDb(l, r),
    sideLow: 10 * Math.log10(bandEnergy(side, 20, 100) + 1e-30),
    peak,
  };
}

const house = () => getStarter('house')!.build();

/**
 * One bass part, no sends: a single-voice path, which Chromium renders bit
 * for bit the same every time (a full mix sums many inputs in an unspecified
 * order, so two renders of it differ by about 2e-6 whatever the settings).
 */
function bassPart(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  p.seed = 1234;
  for (const t of p.tracks) {
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  applyPresetToProject(p, 't3', 'bass-velvet-saw');
  const t3 = p.tracks.find((t) => t.id === 't3')!;
  t3.clips[0] = { id: 'clip-bass', name: 'fixture', bars: 1, notes: [0, 4, 8, 12].map((s) => createNote({ tick: s * 24, pitch: 45, velocity: 0.9, duration: 20 })) };
  return p;
}

function maxDiff(a: { L: Float32Array; R: Float32Array }, b: { L: Float32Array; R: Float32Array }): number {
  let d = 0;
  for (let i = 0; i < a.L.length; i++) d = Math.max(d, Math.abs(a.L[i] - b.L[i]), Math.abs(a.R[i] - b.R[i]));
  return d;
}

describe('mastering on a real mix (House groove, 4 bars)', () => {
  it('neutral mastering, and mastering switched off whatever its settings, render bit for bit like no mastering', async () => {
    const p = bassPart();
    const neutral = await renderMix(withMastering(p, {}), 2, 0);
    const off = await renderMix(withMastering(p, {}, false), 2, 0);
    const offLoud = await renderMix(withMastering(p, masteringPreset('loud')!.params, false), 2, 0);
    expect(rms(neutral.L, 0.1, 3.9)).toBeGreaterThan(0.01);
    expect(maxDiff(neutral, off)).toBeLessThan(1e-6);
    expect(maxDiff(offLoud, off)).toBeLessThan(1e-6);
    // A whole starter: the same level, and the same samples within the engine's own render-to-render
    // variation (Chromium's unspecified input summation order; two renders with mastering off differ as much).
    const h = house();
    expect(h.mastering.enabled).toBe(true);
    const a = await renderMix(withMastering(h, {}));
    const b = await renderMix(withMastering(h, {}, false));
    expect(maxDiff(a, b)).toBeLessThan(5e-4);
    expect(Math.abs(20 * Math.log10(rms(a.L, 2, 7.5) / rms(b.L, 2, 7.5)))).toBeLessThan(1e-3);
  });

  it('every preset does what its sentence says, and none exceeds the −1 dBFS ceiling', async () => {
    const p = house();
    const m: Record<string, MixMetrics> = {};
    for (const preset of MASTERING_PRESETS) {
      const { L, R } = await renderMix(withMastering(p, preset.params));
      expect(isAllFinite(L) && isAllFinite(R), preset.id).toBe(true);
      m[preset.id] = metrics(L, R);
      expect(m[preset.id].peak, preset.id).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-6);
    }
    const c = m.clean;
    const d = (id: string, k: keyof MixMetrics) => m[id][k] - c[k];
    // Gentle: a little louder, dynamics almost untouched.
    expect(d('gentle', 'lufs')).toBeGreaterThan(1);
    expect(d('gentle', 'lufs')).toBeLessThan(4);
    expect(Math.abs(d('gentle', 'crest'))).toBeLessThan(1.5);
    // Warm: rounder lows, softer highs, denser.
    expect(d('warm', 'lows')).toBeGreaterThan(1);
    expect(d('warm', 'tilt')).toBeLessThan(-1.5);
    expect(d('warm', 'crest')).toBeLessThan(-1);
    // Punchy: louder while keeping its transients (clearly more crest than Loud), low mids cleaned up.
    expect(d('punchy', 'lufs')).toBeGreaterThan(2);
    expect(d('punchy', 'crest')).toBeGreaterThan(-1.5);
    expect(m.punchy.crest).toBeGreaterThan(m.loud.crest + 1);
    // Bright: more top end.
    expect(d('bright', 'tilt')).toBeGreaterThan(2);
    // Wide: more side, less side in the lows.
    expect(d('wide', 'sideMid')).toBeGreaterThan(2);
    expect(d('wide', 'sideLow')).toBeLessThan(-3);
    // Loud: much louder, less dynamic range, right up to the ceiling.
    expect(d('loud', 'lufs')).toBeGreaterThan(5);
    expect(d('loud', 'crest')).toBeLessThan(-1.5);
    expect(20 * Math.log10(m.loud.peak)).toBeGreaterThan(-1.3);
    // Lo-fi: band-limited and narrow.
    expect(d('lofi', 'tilt')).toBeLessThan(-6);
    expect(d('lofi', 'lows')).toBeLessThan(-6);
    expect(d('lofi', 'sideMid')).toBeLessThan(-1);
  });

  it('Glue keeps the groove at about the same loudness, whatever the Punch', async () => {
    const p = house();
    const clean = await renderMix(withMastering(p, {}));
    for (const [glue, punch] of [[1, 0], [1, 1], [0.5, 0.5]]) {
      const glued = await renderMix(withMastering(p, { glue, punch }));
      expect(Math.abs(metrics(glued.L, glued.R).lufs - metrics(clean.L, clean.R).lufs), `glue ${glue} punch ${punch}`).toBeLessThan(2);
    }
  });

  it('Loudness +15 dB on hot material stays under the ceiling', async () => {
    const p = house();
    p.masterVolumeDb = 6;
    for (const t of p.tracks) {
      moduleParams(p, moduleId.channel(t.id)).level = 6;
      t.macros.drive = 1;
    }
    const hot = withMastering(p, { loudness: 15, glue: 1, punch: 1, saturation: 1, width: 1.6, highGain: 6, air: 6, lowGain: 6 });
    const { L, R } = await renderMix(hot, 2);
    expect(isAllFinite(L) && isAllFinite(R)).toBe(true);
    let peak = 0;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    expect(peak).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-6);
    expect(rms(L, 0.5, 3.5)).toBeGreaterThan(0.3);
  });

  it('renders deterministically with every stage working', async () => {
    const params = { ...masteringPreset('loud')!.params, air: 2, monoBass: 150, saturation: 0.6 };
    // On a single-voice path (no summation-order rounding upstream) the chain itself adds no randomness.
    const p = withMastering(bassPart(), params);
    const a = await renderMix(p, 2, 0);
    const b = await renderMix(p, 2, 0);
    expect(maxDiff(a, b)).toBeLessThan(1e-6);
    // A full mix: Chromium sums a node's inputs in an unspecified order, so two renders of a starter
    // differ slightly even with mastering off (measured up to ~5e-5); pushed +8 dB into the limiter
    // that grows, but stays far below hearing (−60 dBFS).
    const m = withMastering(house(), params);
    expect(maxDiff(await renderMix(m, 2), await renderMix(m, 2))).toBeLessThan(1e-3);
  });
});

/* ------------------------------------------------------------------ */
/* Stages with test tones                                              */
/* ------------------------------------------------------------------ */

/** Core project (instrument → channel → master, 0 dB everywhere) with mastering params. */
function toneProject(params: ParamValues, enabled = true): Project {
  const p = coreProject();
  p.mastering = { enabled, params: { ...neutralMasteringParams(), ...params } };
  return p;
}

/** Steady tone(s) on t3 (and optionally t4) through the engine; returns the render. */
async function tones(params: ParamValues, notes: { track?: string; hz: number; velocity: number }[], seconds = 1, setup?: (p: Project) => void) {
  const p = toneProject(params);
  setup?.(p);
  const h = await harness(seconds, p);
  for (const n of notes) h.engine.scheduleNote(n.track ?? 't3', { pitch: pitchForHz(n.hz), velocity: n.velocity, time: 0.02 });
  return h.render();
}

const gainDb = async (params: ParamValues, hz: number, velocity = 0.25) => {
  const flat = await tones({}, [{ hz, velocity }]);
  const eq = await tones(params, [{ hz, velocity }]);
  return 20 * Math.log10(toneAmp(eq.L, hz, 0.3, 0.95) / toneAmp(flat.L, hz, 0.3, 0.95));
};

describe('mastering stages measured with test tones', () => {
  it('EQ: Lows, Mids, Highs and Air move their own ranges; the low cut removes rumble', async () => {
    expect(await gainDb({ lowGain: 6, lowFreq: 110 }, 40)).toBeGreaterThan(5);
    expect(Math.abs(await gainDb({ lowGain: 6, lowFreq: 110 }, 3000))).toBeLessThan(0.1);
    expect(await gainDb({ midGain: -6, midFreq: 1200 }, 1200)).toBeCloseTo(-6, 1);
    expect(await gainDb({ highGain: 6, highFreq: 4000 }, 12000)).toBeGreaterThan(5);
    expect(await gainDb({ air: 6 }, 18000)).toBeGreaterThan(3.5);
    expect(Math.abs(await gainDb({ air: 6 }, 1000))).toBeLessThan(0.1);
    expect(await gainDb({ lowCut: 80 }, 30)).toBeLessThan(-25);
    expect(Math.abs(await gainDb({ lowCut: 80 }, 1000))).toBeLessThan(0.1);
  });

  it('Glue follows its curve: −6 dBFS at full Glue loses 13.5 dB and gets its automatic make-up back', async () => {
    // threshold −24 dB, ratio 4: (−6 + 24)·0.75 = 13.5 dB; make-up = the reduction at GLUE_MAKEUP_REF_DB.
    expect(glueStaticReduction(1, -6)).toBeCloseTo(13.5, 6);
    const makeup = glueStaticReduction(1, GLUE_MAKEUP_REF_DB);
    expect(makeup).toBeGreaterThan(3);
    // Punch 0 (1 ms attack): the peak-sensing detector holds the reduction at the tone's peaks.
    const { L } = await tones({ glue: 1, punch: 0 }, [{ hz: 1000, velocity: 0.5 }], 1.5);
    expect(20 * Math.log10(toneAmp(L, 1000, 1.0, 1.45))).toBeCloseTo(-6 - 13.5 + makeup, 0);
    // A quiet tone sits below the knee: only the make-up applies. Glue 0 is exactly unity.
    const quiet = await tones({ glue: 1 }, [{ hz: 1000, velocity: 0.01 }], 1.5);
    expect(20 * Math.log10(toneAmp(quiet.L, 1000, 1.0, 1.45) / 0.01)).toBeCloseTo(makeup, 1);
    expect(glueStaticReduction(0, 0)).toBe(0);
  });

  it('Glue evens out loud and quiet passages', async () => {
    // 1.5 s passages alternating between −6 dBFS and −20 dBFS (14 dB apart); the end of each is measured,
    // after the automatic release has settled.
    const level = async (params: ParamValues) => {
      const h = await harness(6.1, toneProject(params));
      for (let k = 0; k < 4; k++) h.engine.scheduleNote('t3', { pitch: pitchForHz(500), velocity: k % 2 ? 0.1 : 0.5, time: 0.05 + k * 1.5, duration: 1.49 });
      const { L } = await h.render();
      const t = (k: number) => 0.05 + k * 1.5 + LATENCY;
      return 20 * Math.log10(rms(L, t(2) + 1.0, t(2) + 1.4) / rms(L, t(3) + 1.0, t(3) + 1.4));
    };
    expect(await level({})).toBeCloseTo(14, 0);
    expect(await level({ glue: 1, punch: 0.5 })).toBeLessThan(8);
    expect(await level({ glue: 0.5, punch: 0.5 })).toBeLessThan(12.5);
  });

  it('Punch: the front of each hit gets through before the Glue reacts (1 ms .. 30 ms attack)', async () => {
    // Notes with a 4 ms attack, every 0.5 s: level 2..15 ms after each onset vs the settled level.
    const overshoot = async (punch: number) => {
      const h = await harness(2.1, toneProject({ glue: 1, punch }));
      for (let k = 0; k < 4; k++) h.engine.scheduleNote('t3', { pitch: pitchForHz(1000), velocity: 0.5, time: 0.05 + k * 0.5, duration: 0.3 });
      const { L } = await h.render();
      let sum = 0;
      for (let k = 1; k < 4; k++) {
        // The output limiter delays everything by its look-ahead.
        const t = 0.05 + k * 0.5 + LATENCY;
        sum += 20 * Math.log10(rms(L, t + 0.005, t + 0.02) / rms(L, t + 0.2, t + 0.28));
      }
      return sum / 3;
    };
    const tight = await overshoot(0);
    const open = await overshoot(1);
    expect(tight).toBeLessThan(1.5);
    expect(open).toBeGreaterThan(tight + 2);
  });

  it('Warmth adds harmonics at about the same level, and its 4x oversampling keeps aliases out', async () => {
    // A tone peaking at −10.5 dBFS, about where a mix's peaks sit before the limiter.
    const clean = await tones({}, [{ hz: 440, velocity: 0.3 }]);
    const warm = await tones({ saturation: 1 }, [{ hz: 440, velocity: 0.3 }]);
    const h3 = (x: Float32Array) => toneAmp(x, 1320, 0.3, 0.95) / toneAmp(x, 440, 0.3, 0.95);
    expect(h3(clean.L)).toBeLessThan(1e-4);
    expect(h3(warm.L)).toBeGreaterThan(0.01);
    expect(Math.abs(20 * Math.log10(rms(warm.L, 0.3, 0.95) / rms(clean.L, 0.3, 0.95)))).toBeLessThan(1);
    // A 9 kHz tone: harmonics at 27, 45, 63 kHz would fold back to 21, 3 and 15 kHz without oversampling.
    const hi = await tones({ saturation: 1 }, [{ hz: 9000, velocity: 0.7 }]);
    const fund = toneAmp(hi.L, 9000, 0.3, 0.95);
    for (const alias of [21000, 3000, 15000]) expect(20 * Math.log10(toneAmp(hi.L, alias, 0.3, 0.95) / fund), `${alias} Hz`).toBeLessThan(-60);
  });

  it('Width narrows and widens around the centre; Mono Bass folds the lows to the middle', async () => {
    const pan = (p: Project) => {
      moduleParams(p, 't3:ch').pan = -1;
      moduleParams(p, 't4:ch').pan = 1;
    };
    const pair = [{ track: 't3', hz: 440, velocity: 0.3 }, { track: 't4', hz: 660, velocity: 0.3 }];
    const base = await tones({}, pair, 1, pan);
    const mono = await tones({ width: 0 }, pair, 1, pan);
    let d = 0;
    for (let i = 0; i < mono.L.length; i++) d = Math.max(d, Math.abs(mono.L[i] - mono.R[i]));
    expect(d).toBeLessThan(1e-6);
    const wide = await tones({ width: 1.6 }, pair, 1, pan);
    const span = (x: { L: Float32Array; R: Float32Array }) => sideToMidDb(x.L.subarray(SR * 0.3), x.R.subarray(SR * 0.3));
    expect(span(wide) - span(base)).toBeCloseTo(20 * Math.log10(1.6), 1);
    // A 60 Hz tone hard left: with Mono Bass at 300 Hz it comes out of both sides almost equally.
    const low = await tones({ monoBass: 300 }, [{ track: 't3', hz: 60, velocity: 0.3 }], 1, pan);
    const l = toneAmp(low.L, 60, 0.3, 0.95);
    const r = toneAmp(low.R, 60, 0.3, 0.95);
    expect(Math.abs(20 * Math.log10(l / r))).toBeLessThan(1.5);
  });

  it('switching mastering off crossfades without a click and leaves the plain mix', async () => {
    const loud = { ...masteringPreset('loud')!.params };
    const p = toneProject(loud);
    const h = await harness(2.2, p);
    h.engine.scheduleNote('t3', { pitch: pitchForHz(220), velocity: 0.4, time: 0.02 });
    h.at(0.5, () => h.engine.setProject({ ...p, mastering: { ...p.mastering, enabled: false } }));
    const on = await h.render();
    const ref = await tones(loud, [{ hz: 220, velocity: 0.4 }], 2.2, (q) => (q.mastering.enabled = false));
    const maxStep = (from: number, to: number) => {
      let m = 0;
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) m = Math.max(m, Math.abs(on.L[i] - on.L[i - 1]));
      return m;
    };
    // The switch is no steeper than the music on either side of it.
    expect(maxStep(0.48, 0.6)).toBeLessThan(Math.max(maxStep(0.1, 0.48), maxStep(0.6, 2)) * 1.1);
    // Once the output limiter has recovered, it is exactly the unmastered sound.
    let d = 0;
    for (let i = Math.round(2.0 * SR); i < on.L.length; i++) d = Math.max(d, Math.abs(on.L[i] - ref.L[i]));
    expect(d).toBeLessThan(1e-5);
  });

  it('Mute All also clears the Glue: the next note is not held down by the last one', async () => {
    const p = toneProject({ glue: 1, punch: 0 });
    const h = await harness(1.2, p);
    h.engine.scheduleNote('t3', { pitch: pitchForHz(440), velocity: 0.8, time: 0.02, duration: 0.35 });
    h.at(0.4, () => h.engine.setMuteAll(true));
    h.at(0.6, () => h.engine.setMuteAll(false));
    h.at(0.7, () => h.engine.scheduleNote('t3', { pitch: pitchForHz(440), velocity: 0.05, time: 0.75, duration: 0.3 }));
    const muted = await h.render();
    const fresh = await harness(1.2, toneProject({ glue: 1, punch: 0 }));
    fresh.engine.scheduleNote('t3', { pitch: pitchForHz(440), velocity: 0.05, time: 0.75, duration: 0.3 });
    const ref = await fresh.render();
    const a = toneAmp(muted.L, 440, 0.76, 0.85);
    const b = toneAmp(ref.L, 440, 0.76, 0.85);
    expect(Math.abs(20 * Math.log10(a / b))).toBeLessThan(0.3);
  });
});
