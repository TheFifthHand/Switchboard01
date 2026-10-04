/**
 * Renders every synth preset through the real mono/poly synth engines in
 * Chromium (OfflineAudioContext) and checks that each one is audible, finite,
 * level-matched within its browser category (and the categories with each
 * other), that the Tone macro really changes its brightness, that presets of
 * a category sound measurably different from each other, and that every
 * voice is freed after its release.
 */
import { describe, expect, it } from 'vitest';
import type { InstrumentContext, InstrumentFactory } from '../../src/audio/contracts';
import { MonoSynthEngine } from '../../src/audio/instruments/monoSynth';
import { PolySynthEngine } from '../../src/audio/instruments/polySynth';
import { PRESETS, applyPresetToProject } from '../../src/content/presets';
import { SOUND_CATEGORIES, SYNTH_PRESETS, type PresetInfo } from '../../src/content/catalog';
import { parseChord, voiceLeadProgression } from '../../src/music/chords';
import { parseNote } from '../../src/music/scales';
import { createProject } from '../../src/project/factory';
import { resolveAllParams } from '../../src/project/resolve';
import { spectralCentroid } from '../../src/render/analysis';
import { Rng } from '../../src/project/rng';
import type { Instrument } from '../../src/project/types';

/** The real engines, as the instrument module builds them. */
async function loadFactory(): Promise<InstrumentFactory> {
  return (ictx, instrument) => {
    if (instrument.kind === 'bass') return new MonoSynthEngine(ictx, instrument);
    if (instrument.kind === 'poly') return new PolySynthEngine(ictx, instrument);
    throw new Error(`not a synth preset: ${instrument.kind}`);
  };
}

const SR = 48000;
const BPM = 120;
const BEAT = 60 / BPM;
/** Rendered length: a two-bar phrase plus room for release tails. */
const RENDER_SECONDS = 6;
const MEASURE_SECONDS = 5;

interface PhraseNote {
  pitch: number;
  time: number;
  duration: number;
  velocity: number;
  legato?: boolean;
}

/** A typical two-bar part for the preset's main role (original material). */
function phrase(info: PresetInfo): PhraseNote[] {
  const out: PhraseNote[] = [];
  const role = info.roles[0];
  if (info.kind === 'bass') {
    const line = ['A1', 'A1', 'A2', 'A1', 'C2', 'C2', 'E2', 'G1', 'F1', 'F1', 'F2', 'F1', 'G1', 'G1', 'B1', 'D2'];
    line.forEach((n, i) => out.push({ pitch: parseNote(n), time: i * BEAT * 0.5, duration: BEAT * 0.42, velocity: i % 2 ? 0.7 : 0.9 }));
  } else if (role === 'lead') {
    const line = ['E4', 'G4', 'A4', 'C5', 'B4', 'A4', 'G4', 'E4'];
    line.forEach((n, i) => out.push({ pitch: parseNote(n), time: i * BEAT, duration: BEAT * 0.8, velocity: 0.8 }));
  } else if (role === 'chords') {
    const chords = voiceLeadProgression(['Am7', 'Fmaj7', 'C', 'G'].map((c) => parseChord(c, 3)), parseNote('E3'), parseNote('E5'));
    chords.forEach((c, i) => {
      for (const hit of [0, 1.5]) for (const p of c) out.push({ pitch: p, time: i * 2 * BEAT + hit * BEAT, duration: BEAT * 0.9, velocity: 0.8 });
    });
  } else if (role === 'pad') {
    const chords = voiceLeadProgression(['Am9', 'Fmaj7'].map((c) => parseChord(c, 3)), parseNote('E3'), parseNote('E5'));
    chords.forEach((c, i) => {
      for (const p of c) out.push({ pitch: p, time: i * 4 * BEAT, duration: 4 * BEAT - 0.05, velocity: 0.7 });
    });
  } else {
    // Texture: a held open fifth.
    for (const n of ['A3', 'E4']) out.push({ pitch: parseNote(n), time: 0, duration: 8 * BEAT - 0.05, velocity: 0.7 });
  }
  return out;
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const rng = new Rng(20240601);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rng.noise();
  return buf;
}

/** The instrument exactly as the engine receives it for a track using the preset with Tone at `tone`. */
function presetInstrument(presetId: string, tone: number): Instrument {
  const p = createProject({ now: 1 });
  applyPresetToProject(p, 't4', presetId);
  p.tracks[3].macros.tone = tone;
  const params = resolveAllParams(p).get('t4:inst')!;
  return { ...p.tracks[3].instrument, params } as Instrument;
}

interface Render {
  /** Gated, K-weighted loudness of the phrase (EBU R128 style), in LUFS. */
  loudness: number;
  /** Plain RMS over the phrase window, dBFS. */
  rmsDb: number;
  peak: number;
  finite: boolean;
  /** RMS of the first difference over RMS: rises with high-frequency content. */
  brightness: number;
  /** Spectral centroid of the phrase (mono mix), Hz. */
  centroid: number;
  /** Band energies (dB, relative to the total) of the mono phrase: a coarse spectral fingerprint. */
  bands: number[];
  /** Voices still allocated after the render (every one should have been freed). */
  voicesLeft: number;
  envelope: number[];
}

/** Third-octave bands from 28 Hz to 14 kHz for the spectral fingerprint. */
const BAND_EDGES = Array.from({ length: 28 }, (_, i) => 28 * Math.pow(2, i / 3));

/** Long-term spectrum in third-octave bands, dB relative to the strongest band (floor -50 dB). */
function bandProfile(x: Float32Array): number[] {
  const n = 8192;
  const hop = 4096;
  const acc = new Float64Array(n / 2);
  for (let a = 0; a + n <= x.length; a += hop) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = x[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    fft(re, im);
    for (let k = 1; k < n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
  }
  const out: number[] = [];
  for (let b = 0; b + 1 < BAND_EDGES.length; b++) {
    let e = 1e-20;
    for (let k = Math.ceil((BAND_EDGES[b] * n) / SR); k < Math.min(n / 2, (BAND_EDGES[b + 1] * n) / SR); k++) e += acc[k];
    out.push(10 * Math.log10(e));
  }
  const top = Math.max(...out);
  return out.map((v) => Math.max(-50, v - top));
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
      }
    }
  }
}

/** RMS envelope (20 ms blocks, dB) of the mono phrase: a dynamic fingerprint. */
function envelopeDb(x: Float32Array): number[] {
  const block = Math.round(0.02 * SR);
  const out: number[] = [];
  for (let a = 0; a + block <= x.length; a += block) {
    let z = 0;
    for (let i = a; i < a + block; i++) z += x[i] * x[i];
    out.push(Math.max(-60, 10 * Math.log10(z / block + 1e-20)));
  }
  return out;
}

/**
 * Integrated loudness with the R128 gating scheme: 400 ms blocks every
 * 100 ms, absolute gate at -70 LUFS, relative gate 10 LU below the mean.
 * Gating ignores the silence between stabs and plucks, so short sounds are
 * compared by how loud they are when they play, as a listener hears it.
 */
function gatedLoudness(l: Float32Array, r: Float32Array, frames: number): number {
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const powers: number[] = [];
  for (let s = 0; s + block <= frames; s += hop) {
    let z = 0;
    for (let i = s; i < s + block; i++) z += l[i] * l[i] + r[i] * r[i];
    powers.push(z / block);
  }
  const lufs = (z: number) => -0.691 + 10 * Math.log10(z + 1e-20);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const abs = powers.filter((z) => lufs(z) > -70);
  if (!abs.length) return -Infinity;
  const gate = lufs(avg(abs)) - 10;
  return lufs(avg(abs.filter((z) => lufs(z) > gate)));
}

async function render(factory: InstrumentFactory, info: PresetInfo, tone = 0.5): Promise<Render> {
  // Channels 0-1: the instrument as heard. Channels 2-3: the same through K-weighting, for loudness.
  // Long enough for every release tail to finish, so leftover voices would be real leaks.
  const notes = phrase(info);
  const release = PRESETS[info.id].params.release ?? 0.5;
  const end = Math.max(...notes.map((n) => 0.05 + n.time + n.duration)) + release + 0.3;
  const ctx = new OfflineAudioContext(4, Math.ceil(SR * Math.max(RENDER_SECONDS, end)), SR);
  const ictx: InstrumentContext = { ctx, samples: { get: () => null }, noise: noiseBuffer(ctx), getBpm: () => BPM };
  const instrument = presetInstrument(info.id, tone);
  const engine = factory(ictx, instrument);
  engine.update(instrument, 0);
  const stereo = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const merger = ctx.createChannelMerger(4);
  const raw = ctx.createChannelSplitter(2);
  const weighted = ctx.createChannelSplitter(2);
  const shelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 1681.97, gain: 4 });
  const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 38.13, Q: 0.5 });
  engine.output.connect(stereo);
  stereo.connect(raw);
  stereo.connect(shelf).connect(highpass).connect(weighted);
  raw.connect(merger, 0, 0);
  raw.connect(merger, 1, 1);
  weighted.connect(merger, 0, 2);
  weighted.connect(merger, 1, 3);
  merger.connect(ctx.destination);
  for (const n of notes) engine.trigger({ pitch: n.pitch, velocity: n.velocity, time: 0.05 + n.time, duration: n.duration, legato: n.legato ?? false });
  const buf = await ctx.startRendering();
  // Let the sources' 'ended' events run, then count what is still allocated.
  await new Promise((r) => setTimeout(r, 20));
  const voicesLeft = engine.activeVoices();
  engine.dispose();

  const frames = SR * MEASURE_SECONDS;
  const mono = new Float32Array(frames);
  let sum = 0;
  let diff = 0;
  let peak = 0;
  let finite = true;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) finite = false;
      peak = Math.max(peak, Math.abs(v));
      if (i < frames) {
        mono[i] += v / 2;
        sum += v * v;
        if (i > 0) diff += (v - d[i - 1]) ** 2;
      }
    }
  }
  return {
    loudness: gatedLoudness(buf.getChannelData(2), buf.getChannelData(3), frames),
    rmsDb: 10 * Math.log10(sum / (frames * 2) + 1e-20),
    peak,
    finite,
    brightness: Math.sqrt(diff / (sum + 1e-20)),
    centroid: spectralCentroid(mono, SR),
    bands: bandProfile(mono),
    voicesLeft,
    envelope: envelopeDb(mono),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Renders at Tone 0.5, shared by the level, distinctness and cleanup checks. */
let designed: Map<string, Render> | null = null;
async function designedRenders(): Promise<Map<string, Render>> {
  if (designed) return designed;
  const factory = await loadFactory();
  const results = new Map<string, Render>();
  for (const info of SYNTH_PRESETS) results.set(info.id, await render(factory, info));
  designed = results;
  return results;
}

/**
 * How different two rendered presets are: mean third-octave spectrum
 * difference (dB, where either has energy), mean difference of the 20 ms
 * loudness contour after matching levels (dB), and the spectral-centroid
 * ratio (octaves, weighted x6).
 */
function soundDistance(a: Render, b: Render): { total: number; spectral: number; contour: number; bright: number } {
  let spectral = 0;
  let bands = 0;
  for (let k = 0; k < a.bands.length; k++) {
    if (Math.max(a.bands[k], b.bands[k]) < -40) continue;
    spectral += Math.abs(a.bands[k] - b.bands[k]);
    bands++;
  }
  spectral /= Math.max(1, bands);
  const shift = a.loudness - b.loudness;
  const n = Math.min(a.envelope.length, b.envelope.length);
  let contour = 0;
  for (let k = 0; k < n; k++) contour += Math.min(30, Math.abs(a.envelope[k] - b.envelope[k] - shift));
  contour /= n;
  const bright = Math.abs(Math.log2(a.centroid / b.centroid));
  return { total: spectral + contour + 6 * bright, spectral, contour, bright };
}

/** Two presets of a category must differ at least this much (the closest original pair scores well above it). */
const MIN_SOUND_DISTANCE = 3.5;

/** Allowed loudness spread inside a category, and between category medians (LU). */
const IN_CATEGORY_LU = 4.5;
const BETWEEN_CATEGORIES_LU = 2.5;

describe('synth presets rendered through the real engines', () => {
  it('every preset is audible, finite, frees its voices and is level-matched within its category', async () => {
    const results = await designedRenders();
    for (const [id, r] of results) {
      expect(r.finite, `${id} produced non-finite samples`).toBe(true);
      expect(r.rmsDb, `${id} is (nearly) silent`).toBeGreaterThan(-45);
      expect(r.peak, `${id} peaks implausibly high`).toBeLessThan(4);
      expect(r.voicesLeft, `${id} left voices allocated after their release`).toBe(0);
    }
    const problems: string[] = [];
    const medians = new Map<string, number>();
    for (const cat of SOUND_CATEGORIES) {
      const group = SYNTH_PRESETS.filter((p) => p.category === cat.id);
      if (group.length === 0) continue;
      const med = median(group.map((p) => results.get(p.id)!.loudness));
      medians.set(cat.id, med);
      const report = group.map((p) => `${p.name} ${(results.get(p.id)!.loudness - med).toFixed(1)}`).join(', ');
      console.info(`[presets] ${cat.name} (${group.length}) loudness relative to median ${med.toFixed(1)} LUFS: ${report}`);
      for (const p of group) {
        const off = results.get(p.id)!.loudness - med;
        if (Math.abs(off) > IN_CATEGORY_LU) problems.push(`${p.name} is ${off.toFixed(1)} dB from the ${cat.name} median`);
      }
    }
    // Switching a part between melodic categories (keys to a pad, a lead to a pluck) keeps it at a similar
    // level; basses are designed to sit a few dB above the rest, as in the starters.
    const melodic = [...medians].filter(([id]) => id !== 'bass');
    const centre = median(melodic.map(([, m]) => m));
    for (const [id, m] of melodic) if (Math.abs(m - centre) > BETWEEN_CATEGORIES_LU) problems.push(`${id} median is ${(m - centre).toFixed(1)} dB from the other categories`);
    const bassLift = medians.get('bass')! - centre;
    console.info(`[presets] melodic categories centre ${centre.toFixed(1)} LUFS; basses ${bassLift.toFixed(1)} dB above`);
    if (bassLift < 2 || bassLift > 8) problems.push(`basses sit ${bassLift.toFixed(1)} dB above the other categories (designed: 2 to 8 dB)`);
    expect(problems).toEqual([]);
  });

  it('presets in a category sound measurably different from each other', async () => {
    const results = await designedRenders();
    const problems: string[] = [];
    const closest: string[] = [];
    for (const cat of SOUND_CATEGORIES) {
      const group = SYNTH_PRESETS.filter((p) => p.category === cat.id);
      let near = { d: Infinity, label: '' };
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const d = soundDistance(results.get(group[i].id)!, results.get(group[j].id)!);
          const label = `${group[i].name} / ${group[j].name} ${d.total.toFixed(1)} (spectrum ${d.spectral.toFixed(1)} dB, contour ${d.contour.toFixed(1)} dB, centroid ${d.bright.toFixed(2)} oct)`;
          if (d.total < near.d) near = { d: d.total, label };
          if (d.total < MIN_SOUND_DISTANCE) problems.push(label);
        }
      }
      if (group.length > 1) closest.push(`${cat.name}: ${near.label}`);
    }
    console.info(`[presets] closest pair per category:\n  ${closest.join('\n  ')}`);
    expect(problems).toEqual([]);
  });

  it('Tone makes every preset audibly darker or brighter', async () => {
    const factory = await loadFactory();
    const problems: string[] = [];
    const report: string[] = [];
    for (const info of SYNTH_PRESETS) {
      const dark = await render(factory, info, 0.1);
      const bright = await render(factory, info, 0.9);
      report.push(`${info.name} ${dark.centroid.toFixed(0)} -> ${bright.centroid.toFixed(0)} Hz`);
      // The spectral centroid should move by well over half an octave (it is about an octave or more for every preset).
      if (!(bright.centroid > dark.centroid * 1.8 && bright.brightness > dark.brightness)) {
        problems.push(`${info.name}: centroid ${dark.centroid.toFixed(0)} -> ${bright.centroid.toFixed(0)} Hz, brightness ${dark.brightness.toFixed(3)} -> ${bright.brightness.toFixed(3)}`);
      }
    }
    console.info(`[presets] spectral centroid at Tone 0.1 -> 0.9: ${report.join(', ')}`);
    expect(problems).toEqual([]);
    // Two offline renders per preset (60+ presets): more than the default minute on a slow machine.
  }, 240_000);

  it('preset data in the table is what the engines render (no hidden defaults)', () => {
    for (const info of SYNTH_PRESETS) {
      const inst = presetInstrument(info.id, 0.5);
      for (const [k, v] of Object.entries(PRESETS[info.id].params)) expect(inst.params[k], `${info.id}.${k}`).toBeCloseTo(v, 9);
    }
  });
});
