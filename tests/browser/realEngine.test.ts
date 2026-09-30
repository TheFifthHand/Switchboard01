/**
 * Audio evidence with the REAL engine, instruments and effects, rendered on
 * an OfflineAudioContext exactly as WAV export does:
 *  - impulse/timing fixture: onset positions over several bars (and swing),
 *  - macros produce measurable changes,
 *  - a cable rewire changes the signal and undo restores it bit-exactly,
 *  - invalid/cyclic connections are refused without touching the graph,
 *  - timed mute automation, the output ceiling, determinism.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { OUTPUT_CEILING } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { applyKitToProject, applyPresetToProject } from '../../src/content/presets';
import { createNote, createProject, moduleId } from '../../src/project/factory';
import type { Clip, ClipBars, MacroId, Note, Project } from '../../src/project/types';
import { RENDER_START_OFFSET, renderOffline, type RenderSource } from '../../src/render/offline';
import { detectOnsets, envelope, isAllFinite, peak, rms, spectralCentroid, bandEnergy } from '../../src/render/analysis';
import { makeSnapshot } from '../../src/time/snapshot';
import { ProjectStore } from '../../src/state/projectStore';
import * as cmd from '../../src/state/commands';
import { engineLatencyFrames } from '../../src/audio/worklets/limiter';

const SR = 48000;

async function render(project: Project, source: RenderSource, tail = 0.4): Promise<{ L: Float32Array; R: Float32Array; mono: Float32Array }> {
  const bank = new SampleBank(SR);
  const buf = await renderOffline({ project, source, sampleRate: SR, tailSeconds: tail, createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: project.seed, meters: false }) });
  const L = buf.getChannelData(0).slice();
  const R = buf.getChannelData(1).slice();
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
  return { L, R, mono };
}

/** A dry project: no reverb/delay sends, fixed seed. */
function dryProject(bpm = 120): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 1234;
  for (const t of p.tracks) {
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  return p;
}

function setClip(p: Project, trackId: string, slot: number, bars: ClipBars, notes: Omit<Note, 'id'>[]): void {
  const t = p.tracks.find((x) => x.id === trackId)!;
  const clip: Clip = { id: `clip-${trackId}-${slot}`, name: 'fixture', bars, notes: notes.map((n) => createNote(n)) };
  t.clips[slot] = clip;
}

const secAt = (i: number) => i / SR;
const slice = (x: Float32Array, from: number, to: number) => x.subarray(Math.max(0, Math.round(from * SR)), Math.min(x.length, Math.round(to * SR)));

describe('real engine: timing fixture', () => {
  it('drum hits land at the scheduled sample positions, bar after bar', async () => {
    const p = dryProject(120);
    applyKitToProject(p, 't1', 'tight-circuit');
    // Rim (voice 7) on steps 1, 5, 11 and 16 of a one-bar loop.
    const steps = [0, 4, 10, 15];
    setClip(p, 't1', 0, 1, steps.map((s) => ({ tick: s * 24, pitch: 7, velocity: 1, duration: 24 })));
    const bars = 4;
    const { mono } = await render(p, { kind: 'scene', row: 0, bars });
    expect(isAllFinite(mono)).toBe(true);
    const onsets = detectOnsets(mono, SR, { threshold: 0.03, minGapMs: 40 });
    const expected: number[] = [];
    for (let b = 0; b < bars; b++) for (const s of steps) expected.push(RENDER_START_OFFSET + b * 2 + s * 0.125);
    expect(onsets).toHaveLength(expected.length);
    // The master chain delays everything by a constant latency (limiter look-ahead + one render quantum).
    const latency = engineLatencyFrames(SR) / SR;
    const delays = onsets.map((o, i) => secAt(o) - expected[i] - latency);
    // Every hit starts within 0.5 ms of its scheduled time plus that latency ...
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(-0.0002);
      expect(d).toBeLessThan(0.0005);
    }
    // ... and the offset is identical for every hit in every bar (no drift, no jitter).
    expect(Math.max(...delays) - Math.min(...delays)).toBeLessThan(0.0002);
  });

  it('swing delays only the off-beat 16ths, by one third of a step at 100%', async () => {
    const p = dryProject(120);
    p.swing = 1;
    applyKitToProject(p, 't1', 'tight-circuit');
    setClip(p, 't1', 0, 1, [0, 1, 2, 3].map((s) => ({ tick: s * 24, pitch: 7, velocity: 1, duration: 12 })));
    const { mono } = await render(p, { kind: 'scene', row: 0, bars: 1 });
    const onsets = detectOnsets(mono, SR, { threshold: 0.03, minGapMs: 40 }).map(secAt);
    expect(onsets).toHaveLength(4);
    const base = onsets[0];
    const step = 0.125;
    expect(onsets[1] - base).toBeCloseTo(step + step / 3, 3);
    expect(onsets[2] - base).toBeCloseTo(2 * step, 3);
    expect(onsets[3] - base).toBeCloseTo(3 * step + step / 3, 3);
  });
});

describe('real engine: macros produce measurable changes', () => {
  function chordProject(macro: MacroId, value: number, opts: { stab?: boolean } = {}): Project {
    const p = dryProject(120);
    applyPresetToProject(p, 't4', 'poly-lumen-chords');
    const t = p.tracks.find((x) => x.id === 't4')!;
    for (const m of ['space', 'echo', 'motion', 'drive', 'pump'] as const) t.macros[m] = 0;
    t.macros.tone = 0.5;
    t.macros[macro] = value;
    const dur = opts.stab ? 24 : 2 * 384 - 12;
    setClip(p, 't4', 0, 2, [57, 60, 64].map((pitch) => ({ tick: 0, pitch, velocity: 0.9, duration: dur })));
    return p;
  }
  const renderChord = (macro: MacroId, value: number, opts: { stab?: boolean; bars?: number; tail?: number } = {}) =>
    render(chordProject(macro, value, opts), { kind: 'scene', row: 0, bars: opts.bars ?? 2 }, opts.tail ?? 2);

  it('Tone darkens and brightens the part', async () => {
    const dark = await renderChord('tone', 0.1);
    const bright = await renderChord('tone', 0.9);
    const cDark = spectralCentroid(slice(dark.mono, 0.5, 3.5), SR);
    const cBright = spectralCentroid(slice(bright.mono, 0.5, 3.5), SR);
    expect(cBright).toBeGreaterThan(cDark * 1.5);
  });

  it('Space adds a room: energy after the notes end', async () => {
    const dry = await renderChord('space', 0, { stab: true, bars: 1, tail: 3 });
    const wet = await renderChord('space', 0.9, { stab: true, bars: 1, tail: 3 });
    const tailDry = rms(slice(dry.mono, 1.2, 2.5));
    const tailWet = rms(slice(wet.mono, 1.2, 2.5));
    expect(tailWet).toBeGreaterThan(tailDry * 10 + 1e-4);
  });

  it('bypassing the shared Reverb return removes the room instead of adding dry signal', async () => {
    const wet = chordProject('space', 0.9, { stab: true });
    const bypassed = chordProject('space', 0.9, { stab: true });
    bypassed.patch.modules.find((m) => m.id === 'fx:reverb')!.bypass = true;
    const a = await render(wet, { kind: 'scene', row: 0, bars: 1 }, 3);
    const b = await render(bypassed, { kind: 'scene', row: 0, bars: 1 }, 3);
    expect(rms(slice(b.mono, 1.2, 2.5))).toBeLessThan(rms(slice(a.mono, 1.2, 2.5)) * 0.05);
    // The dry part itself is not louder than with the room on.
    expect(rms(slice(b.mono, 0, 0.25))).toBeLessThanOrEqual(rms(slice(a.mono, 0, 0.25)) * 1.05);
  });

  it('Echo repeats the sound in time', async () => {
    const dry = await renderChord('echo', 0, { stab: true, bars: 1, tail: 3 });
    const wet = await renderChord('echo', 0.9, { stab: true, bars: 1, tail: 3 });
    expect(rms(slice(wet.mono, 0.6, 2))).toBeGreaterThan(rms(slice(dry.mono, 0.6, 2)) * 5 + 1e-4);
  });

  it('Motion makes the tone move over time', async () => {
    const still = await renderChord('motion', 0);
    const moving = await renderChord('motion', 1);
    const variation = (x: Float32Array) => {
      const cs: number[] = [];
      for (let t = 0.6; t < 3.6; t += 0.25) cs.push(spectralCentroid(slice(x, t, t + 0.2), SR));
      const mean = cs.reduce((a, b) => a + b, 0) / cs.length;
      return Math.sqrt(cs.reduce((a, b) => a + (b - mean) ** 2, 0) / cs.length) / mean;
    };
    expect(variation(moving.mono)).toBeGreaterThan(variation(still.mono) * 2 + 0.02);
  });

  it('Drive adds harmonics', async () => {
    const clean = await renderChord('drive', 0);
    const driven = await renderChord('drive', 1);
    const hfRatio = (x: Float32Array) => {
      const s = slice(x, 0.5, 3.5);
      return bandEnergy(s, SR, 3000, 16000) / Math.max(1e-12, bandEnergy(s, SR, 50, 3000));
    };
    expect(hfRatio(driven.mono)).toBeGreaterThan(hfRatio(clean.mono) * 1.5);
  });

  it('Pump ducks the part on the beat', async () => {
    const flat = await renderChord('pump', 0);
    const pumped = await renderChord('pump', 1);
    // Level just after each beat vs mid-beat, over beats 3..7 (the chord is sustained there).
    const duckRatio = (x: Float32Array) => {
      let on = 0;
      let mid = 0;
      for (let beat = 2; beat < 7; beat++) {
        const t = RENDER_START_OFFSET + beat * 0.5;
        on += rms(slice(x, t + 0.01, t + 0.05));
        mid += rms(slice(x, t + 0.3, t + 0.34));
      }
      return on / mid;
    };
    expect(duckRatio(flat.mono)).toBeGreaterThan(0.8);
    expect(duckRatio(pumped.mono)).toBeLessThan(0.5);
  });
});

describe('real engine: cables change the real signal', () => {
  function bassProject(): Project {
    const p = dryProject(120);
    applyPresetToProject(p, 't3', 'bass-velvet-saw');
    setClip(p, 't3', 0, 1, [0, 4, 8, 12].map((s) => ({ tick: s * 24, pitch: 45, velocity: 0.9, duration: 20 })));
    return p;
  }
  const src: RenderSource = { kind: 'scene', row: 0, bars: 2 };

  it('disconnecting the channel from the master silences the part; undo restores it bit-exactly', async () => {
    const store = new ProjectStore(bassProject());
    const before = await render(store.getState(), src);
    expect(rms(before.mono)).toBeGreaterThan(0.01);
    const conn = store.getState().patch.connections.find((c) => c.from.module === moduleId.channel('t3') && c.from.port === 'out')!;
    expect(cmd.disconnect(store, conn.id).changed).toBe(true);
    const cut = await render(store.getState(), src);
    expect(rms(cut.mono)).toBeLessThan(rms(before.mono) * 0.01);
    store.undo();
    const restored = await render(store.getState(), src);
    expect(restored.mono).toEqual(before.mono);
  });

  it('patching the raw instrument straight to the master changes the rendered sound', async () => {
    const store = new ProjectStore(bassProject());
    const before = await render(store.getState(), src);
    const r = cmd.connect(store, { module: moduleId.inst('t3'), port: 'out' }, { module: 'master', port: 'in' });
    expect(r.ok).toBe(true);
    const after = await render(store.getState(), src);
    expect(rms(after.mono)).toBeGreaterThan(rms(before.mono) * 1.3);
  });

  it('refuses a cycle and an incompatible connection without touching the graph or the sound', async () => {
    const store = new ProjectStore(bassProject());
    const patchBefore = JSON.stringify(store.getState().patch);
    const before = await render(store.getState(), src);
    const cycle = cmd.connect(store, { module: moduleId.channel('t3'), port: 'out' }, { module: moduleId.drive('t3'), port: 'in' });
    expect(cycle.ok).toBe(false);
    expect(cycle.ok === false && cycle.code).toBe('cycle');
    const wrongKind = cmd.connect(store, { module: moduleId.lfo('t3'), port: 'out' }, { module: 'master', port: 'in' });
    expect(wrongKind.ok === false && wrongKind.code).toBe('incompatible');
    expect(JSON.stringify(store.getState().patch)).toBe(patchBefore);
    const after = await render(store.getState(), src);
    expect(after.mono).toEqual(before.mono);
  });
});

describe('real engine: automation, ceiling, determinism', () => {
  it('a replayed mute silences the part from its exact time', async () => {
    const p = dryProject(120);
    applyKitToProject(p, 't1', 'round-machine');
    setClip(p, 't1', 0, 1, [0, 2, 4, 6, 8, 10, 12, 14].map((s) => ({ tick: s * 24, pitch: 4, velocity: 1, duration: 12 })));
    const perf = {
      id: 'take',
      name: 'Take',
      createdAt: 0,
      startTick: 0,
      endTick: 768,
      snapshot: makeSnapshot(p, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], 0),
      events: [{ t: 384, type: 'mute' as const, trackId: 't1', mute: true }],
    };
    const out = await render({ ...p, performances: [perf] }, { kind: 'performance', performanceId: 'take' }, 0.2);
    expect(rms(slice(out.mono, 0.1, 1.9))).toBeGreaterThan(0.005);
    expect(rms(slice(out.mono, 2.1, 3.9))).toBeLessThan(1e-4);
  });

  it('never exceeds the -1 dBFS ceiling even when everything is pushed', async () => {
    const p = dryProject(128);
    p.masterVolumeDb = 6;
    applyKitToProject(p, 't1', 'tight-circuit');
    applyPresetToProject(p, 't3', 'bass-acid-line');
    applyPresetToProject(p, 't4', 'poly-lumen-chords');
    for (const id of ['t1', 't3', 't4']) {
      p.patch.modules.find((m) => m.id === moduleId.channel(id))!.params.level = 6;
      p.tracks.find((t) => t.id === id)!.macros.drive = 1;
    }
    setClip(p, 't1', 0, 1, [0, 4, 8, 12].map((s) => ({ tick: s * 24, pitch: 0, velocity: 1, duration: 12 })));
    setClip(p, 't3', 0, 1, [0, 2, 4, 6, 8, 10, 12, 14].map((s) => ({ tick: s * 24, pitch: 33, velocity: 1, duration: 20 })));
    setClip(p, 't4', 0, 1, [45, 57, 60, 64, 67, 71].map((pitch) => ({ tick: 0, pitch, velocity: 1, duration: 380 })));
    const out = await render(p, { kind: 'scene', row: 0, bars: 2 });
    expect(isAllFinite(out.L) && isAllFinite(out.R)).toBe(true);
    expect(Math.max(peak(out.L), peak(out.R))).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-5);
    expect(rms(out.mono)).toBeGreaterThan(0.1);
  });

  // Chromium sums a node's inputs in an unspecified order, so float rounding may differ in the
  // last bits between renders (~1e-7). Renders must match to far below audibility (-100 dBFS).
  it('renders the same project identically twice (within float rounding)', async () => {
    const p = dryProject(124);
    applyKitToProject(p, 't1', 'round-machine');
    applyPresetToProject(p, 't4', 'poly-halo-pad');
    p.tracks[3].macros.space = 0.6;
    p.tracks[3].macros.motion = 0.7;
    setClip(p, 't1', 0, 1, [0, 4, 8, 12].map((s) => ({ tick: s * 24, pitch: 0, velocity: 1, duration: 12 })));
    setClip(p, 't4', 0, 1, [57, 60, 64].map((pitch) => ({ tick: 0, pitch, velocity: 0.8, duration: 300 })));
    const a = await render(p, { kind: 'scene', row: 0, bars: 2 }, 1);
    const b = await render(p, { kind: 'scene', row: 0, bars: 2 }, 1);
    let maxDiff = 0;
    for (let i = 0; i < a.L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.L[i] - b.L[i]), Math.abs(a.R[i] - b.R[i]));
    expect(a.L.length).toBe(b.L.length);
    expect(maxDiff).toBeLessThan(1e-5);
    // Sanity: the fixture is not silence.
    expect(rms(a.mono)).toBeGreaterThan(0.005);
    void envelope;
  });
});
