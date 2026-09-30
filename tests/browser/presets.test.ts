/**
 * Renders every synth preset through the real mono/poly synth engines in
 * Chromium (OfflineAudioContext) and checks that each one is audible, finite,
 * level-matched within its group, and that the Tone macro really changes its
 * brightness.
 *
 * The engines are written concurrently with the preset library; while they
 * are absent this suite is skipped with an explanatory placeholder test.
 */
import { describe, expect, it } from 'vitest';
import type { InstrumentContext, InstrumentEngine, InstrumentFactory } from '../../src/audio/contracts';
import { PRESETS, applyPresetToProject } from '../../src/content/presets';
import { SYNTH_PRESETS, type PresetInfo } from '../../src/content/catalog';
import { parseChord, voiceLeadProgression } from '../../src/music/chords';
import { parseNote } from '../../src/music/scales';
import { createProject } from '../../src/project/factory';
import { resolveAllParams } from '../../src/project/resolve';
import { Rng } from '../../src/project/rng';
import type { Instrument } from '../../src/project/types';

type Loader = () => Promise<unknown>;
const ENGINE_FILES = import.meta.glob('../../src/audio/instruments/{index,monoSynth,polySynth}.ts') as Record<string, Loader>;
const INDEX = '../../src/audio/instruments/index.ts';
const MONO = '../../src/audio/instruments/monoSynth.ts';
const POLY = '../../src/audio/instruments/polySynth.ts';
const ENGINES_PRESENT = INDEX in ENGINE_FILES || (MONO in ENGINE_FILES && POLY in ENGINE_FILES);

type EngineCtor = new (ictx: InstrumentContext, instrument: Instrument) => InstrumentEngine;

async function loadFactory(): Promise<InstrumentFactory> {
  if (INDEX in ENGINE_FILES) {
    const m = (await ENGINE_FILES[INDEX]()) as { createInstrumentEngine?: InstrumentFactory };
    if (typeof m.createInstrumentEngine === 'function') return m.createInstrumentEngine;
  }
  const mono = (await ENGINE_FILES[MONO]()) as { MonoSynthEngine?: EngineCtor };
  const poly = (await ENGINE_FILES[POLY]()) as { PolySynthEngine?: EngineCtor };
  if (!mono.MonoSynthEngine || !poly.PolySynthEngine) throw new Error('Synth engine modules exist but do not export MonoSynthEngine / PolySynthEngine.');
  const Mono = mono.MonoSynthEngine;
  const Poly = poly.PolySynthEngine;
  return (ictx, instrument) => (instrument.kind === 'bass' ? new Mono(ictx, instrument) : new Poly(ictx, instrument));
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
  const ctx = new OfflineAudioContext(4, SR * RENDER_SECONDS, SR);
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
  for (const n of phrase(info)) engine.trigger({ pitch: n.pitch, velocity: n.velocity, time: 0.05 + n.time, duration: n.duration, legato: n.legato ?? false });
  const buf = await ctx.startRendering();
  engine.dispose();

  const frames = SR * MEASURE_SECONDS;
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
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

describe.skipIf(!ENGINES_PRESENT)('synth presets rendered through the real engines', () => {
  it('every preset is audible, finite and level-matched within ±6 dB of its group median', async () => {
    const factory = await loadFactory();
    const results = new Map<string, Render>();
    for (const info of SYNTH_PRESETS) results.set(info.id, await render(factory, info));

    for (const [id, r] of results) {
      expect(r.finite, `${id} produced non-finite samples`).toBe(true);
      expect(r.rmsDb, `${id} is (nearly) silent`).toBeGreaterThan(-45);
      expect(r.peak, `${id} peaks implausibly high`).toBeLessThan(4);
    }
    const problems: string[] = [];
    for (const kind of ['bass', 'poly'] as const) {
      const group = SYNTH_PRESETS.filter((p) => p.kind === kind);
      const med = median(group.map((p) => results.get(p.id)!.loudness));
      const report = group.map((p) => `${p.name} ${(results.get(p.id)!.loudness - med).toFixed(1)}`).join(', ');
      console.info(`[presets] ${kind} loudness relative to median ${med.toFixed(1)} LUFS: ${report}`);
      for (const p of group) {
        const off = results.get(p.id)!.loudness - med;
        if (Math.abs(off) > 6) problems.push(`${p.name} is ${off.toFixed(1)} dB from the ${kind} median`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('Tone makes every preset audibly darker or brighter', async () => {
    const factory = await loadFactory();
    const problems: string[] = [];
    for (const info of SYNTH_PRESETS) {
      const dark = await render(factory, info, 0.1);
      const bright = await render(factory, info, 0.9);
      // At least ~5% more high-frequency content (a first-difference/RMS ratio, i.e. a spectral-centroid proxy).
      if (!(bright.brightness > dark.brightness * 1.05)) problems.push(`${info.name}: ${dark.brightness.toFixed(4)} -> ${bright.brightness.toFixed(4)}`);
    }
    expect(problems).toEqual([]);
  });

  it('preset data in the table is what the engines render (no hidden defaults)', () => {
    for (const info of SYNTH_PRESETS) {
      const inst = presetInstrument(info.id, 0.5);
      for (const [k, v] of Object.entries(PRESETS[info.id].params)) expect(inst.params[k], `${info.id}.${k}`).toBeCloseTo(v, 9);
    }
  });
});

describe.runIf(!ENGINES_PRESENT)('synth presets rendered through the real engines', () => {
  it('is skipped: src/audio/instruments/monoSynth.ts and polySynth.ts (or instruments/index.ts) are not present yet', () => {
    expect(ENGINES_PRESENT).toBe(false);
  });
});
