/**
 * AudioEngine core: routing, rewiring, invalid patches, output limiter,
 * Mute All, mute/solo, instrument swaps and resource lifecycle — measured on
 * audio rendered by a real OfflineAudioContext (plus a live AudioContext for
 * meters and timers).
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine, loadEngineWorklets } from '../../src/audio/engine';
import { OUTPUT_CEILING, type EngineFactory, type MeterFrame } from '../../src/audio/contracts';
import { MASTER_ID, conn, createClip, createInstrument, moduleId } from '../../src/project/factory';
import { Rng } from '../../src/project/rng';
import type { Connection, Project } from '../../src/project/types';
import {
  LATENCY,
  SR,
  baseProject,
  clone,
  coreProject,
  harness,
  makeFactory,
  midiToHz,
  moduleParams,
  peak,
  rms,
  toneAmp,
} from './engine-harness';

const A4 = 69; // 440 Hz
const E5 = 76; // 659.26 Hz

function withoutConnection(p: Project, from: string, fromPort: string, to: string, toPort: string): Project {
  const q = clone(p);
  q.patch.connections = q.patch.connections.filter(
    (c) => !(c.from.module === from && c.from.port === fromPort && c.to.module === to && c.to.port === toPort),
  );
  return q;
}

describe('AudioEngine routing', () => {
  it('a note on a track reaches the output through the default patch', async () => {
    const p = baseProject();
    const h = await harness(1, p);
    h.engine.scheduleNote('t4', { pitch: A4, velocity: 0.5, time: 0.1, duration: 0.5 });
    const { L, R, stats } = await h.render();
    expect(stats.modules).toBe(p.patch.modules.length);
    expect(stats.connections).toBe(p.patch.connections.length);
    expect(peak(L, 0, 0.095)).toBeLessThan(1e-5);
    const amp = toneAmp(L, 440, 0.2, 0.55);
    expect(amp).toBeGreaterThan(0.25);
    expect(peak(L)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    // Centre-panned: both channels carry it equally.
    expect(toneAmp(R, 440, 0.2, 0.55) / amp).toBeGreaterThan(0.97);
    expect(toneAmp(R, 440, 0.2, 0.55) / amp).toBeLessThan(1.03);
  });

  it('removing channel -> master silences the track and re-adding it restores it', async () => {
    const p = coreProject();
    const cut = withoutConnection(p, 't3:ch', 'out', MASTER_ID, 'in');
    const h = await harness(1.6, p);
    const counts: number[] = [h.engine.getStats().connections];
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.5, time: 0.05, duration: 1.5 });
    h.at(0.5, () => {
      h.engine.setProject(cut);
      counts.push(h.engine.getStats().connections);
    });
    h.at(1.0, () => {
      h.engine.setProject(p);
      counts.push(h.engine.getStats().connections);
    });
    const { L } = await h.render();
    expect(counts).toEqual([16, 15, 16]);
    const before = toneAmp(L, 440, 0.15, 0.45);
    expect(before).toBeCloseTo(0.5, 2);
    expect(peak(L, 0.53, 0.98)).toBeLessThan(1e-4);
    expect(toneAmp(L, 440, 1.1, 1.5) / before).toBeCloseTo(1, 2);
    // Re-adding fades in over ~20 ms instead of stepping to full level.
    const t = 1.0 + LATENCY;
    expect(peak(L, t, t + 0.004)).toBeLessThan(0.15);
    expect(peak(L, t + 0.008, t + 0.012)).toBeGreaterThan(0.15);
    expect(peak(L, t + 0.008, t + 0.012)).toBeLessThan(0.35);
    expect(peak(L, t + 0.025, t + 0.05)).toBeCloseTo(0.5, 2);
  });

  it('ignores invalid, duplicate and cycle-closing connections without throwing', async () => {
    const p = coreProject();
    const extra: Connection[] = [
      conn('t3:lfo', 'out', MASTER_ID, 'in'), // mod -> audio
      conn('t3:ch', 'out', 'nowhere', 'in'), // missing module
      conn('t3:inst', 'bogus', 't3:ch', 'in'), // missing port
      conn('t3:ch', 'level', 't4:ch', 'in'), // an input used as a source
      conn('t3:ch', 'out', 't3:ch', 'in'), // self loop
      conn(moduleId.inst('t3'), 'out', moduleId.channel('t3'), 'in'), // duplicate route
      conn('t3:ch', 'out', 't4:ch', 'in'), // valid: t3 also through t4's strip
      conn('t4:ch', 'out', 't3:ch', 'in'), // would close a feedback loop
      conn('t4:lfo', 'out', 't3:ch', 'in'), // mod into audio input
      { id: 'broken' } as unknown as Connection, // malformed
    ];
    p.patch.connections.push(...extra);
    const h = await harness(0.6, p);
    expect(() => h.engine.setProject(clone(p))).not.toThrow();
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.2, time: 0.02, duration: 0.5 });
    const { L, stats } = await h.render();
    expect(stats.connections).toBe(16 + 1);
    // t3 arrives twice (own strip + via t4's strip): 2 x 0.2. A feedback
    // loop without delay would have been muted by Web Audio instead.
    expect(toneAmp(L, 440, 0.1, 0.5)).toBeCloseTo(0.4, 2);
    expect(peak(L)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
  });

  it('survives seeded random patch mutations with bounded, finite output', async () => {
    const rng = new Rng(2024);
    const base = baseProject();
    for (const t of base.tracks) t.macros = { ...t.macros, space: 0.6, echo: 0.5, drive: 0.4, motion: 0.5 };
    const ids = base.patch.modules.map((m) => m.id);
    const ports = ['in', 'out', 'sendA', 'sendB', 'level', 'pan', 'pitch', 'cutoff', 'amount', 'mix', 'bogus'];
    let current = base;
    const steps: Project[] = [];
    for (let i = 0; i < 24; i++) {
      const q = clone(current);
      const action = rng.int(0, 3);
      if (action === 0) {
        for (let k = 0; k < 4; k++) {
          q.patch.connections.push(conn(rng.pick(ids), rng.pick(ports), rng.pick(ids), rng.pick(ports), rng.range(-2, 2)));
        }
      } else if (action === 1 && q.patch.connections.length > 4) {
        q.patch.connections.splice(rng.int(0, q.patch.connections.length - 1), rng.int(1, 3));
      } else if (action === 2) {
        const m = rng.pick(q.patch.modules);
        m.bypass = !m.bypass;
        for (const key of Object.keys(m.params)) m.params[key] = rng.range(-1000, 1000);
      } else {
        q.patch.modules.splice(rng.int(0, q.patch.modules.length - 1), 1);
      }
      steps.push(q);
      current = q;
    }
    const h = await harness(2.6, base);
    for (const t of ['t1', 't3', 't4', 't5', 't6']) {
      for (let k = 0; k < 5; k++) h.engine.scheduleNote(t, { pitch: 48 + rng.int(0, 24), velocity: 1, time: 0.05 + k * 0.5, duration: 0.3 });
    }
    steps.forEach((q, i) => h.at(0.1 + i * 0.1, () => h.engine.setProject(q)));
    const { L, R, stats } = await h.render();
    expect(stats.connections).toBeLessThanOrEqual(current.patch.connections.length);
    let finite = true;
    for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) finite = false;
    expect(finite).toBe(true);
    expect(peak(L)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    expect(peak(R)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    expect(rms(L, 0.05, 2.5)).toBeGreaterThan(1e-3);
  });

  it('a note on an unknown track or with non-finite timing is refused', async () => {
    const h = await harness(0.2, coreProject());
    expect(h.engine.scheduleNote('t99', { pitch: 60, velocity: 1, time: 0.01 })).toBeNull();
    expect(h.engine.scheduleNote('t3', { pitch: 60, velocity: 1, time: Number.NaN })).toBeNull();
    const { L } = await h.render();
    expect(peak(L)).toBe(0);
  });
});

describe('AudioEngine output limiter', () => {
  it('keeps a +18 dB overdriven signal under the ceiling by limiting, not clipping', async () => {
    const p = coreProject();
    p.masterVolumeDb = 6;
    p.tracks[2].instrument.params.level = 6;
    moduleParams(p, 't3:ch').level = 6;
    const h = await harness(1, p);
    // velocity 1 x (+6 dB) x3 = x7.9 ~ +18 dB over full scale.
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 1, time: 0.05, duration: 0.9 });
    const { L, R } = await h.render();
    expect(peak(L)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    expect(peak(R)).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
    const fund = toneAmp(L, 440, 0.3, 0.9);
    expect(fund).toBeGreaterThan(OUTPUT_CEILING * 0.8);
    expect(toneAmp(L, 1320, 0.3, 0.9) / fund).toBeLessThan(0.03);
  });

  it('passes a quiet signal with unity gain', async () => {
    const h = await harness(0.6, coreProject());
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.25, time: 0.05, duration: 0.5 });
    const { L } = await h.render();
    expect(toneAmp(L, 440, 0.15, 0.5)).toBeCloseTo(0.25, 3);
    expect(peak(L, 0.15, 0.5)).toBeCloseTo(0.25, 2);
  });
});

describe('AudioEngine Mute All and panic', () => {
  it('silences voices and reverb/delay tails within 20 ms; tails do not return on unmute', async () => {
    const p = baseProject();
    p.tracks[3].macros = { ...p.tracks[3].macros, space: 1, echo: 1 };
    const h = await harness(1.6, p);
    h.engine.scheduleNote('t4', { pitch: A4, velocity: 0.8, time: 0.05, duration: 0.2 });
    // A long held note on another track as well.
    h.engine.scheduleNote('t5', { pitch: E5, velocity: 0.3, time: 0.05 });
    let voicesAfterMute = -1;
    h.at(0.6, () => {
      h.engine.setMuteAll(true);
      voicesAfterMute = h.engine.getStats().voices;
    });
    h.at(0.9, () => h.engine.setMuteAll(false));
    h.at(1.1, () => h.engine.scheduleNote('t4', { pitch: A4, velocity: 0.5, time: 1.2, duration: 0.3 }));
    const { L, R } = await h.render();
    // The tail really was there before muting: t4's note is over (dry) by
    // ~0.28 s, so 440 Hz after 0.32 s can only be its reverb and echoes.
    expect(toneAmp(L, 440, 0.32, 0.58)).toBeGreaterThan(0.01);
    expect(rms(L, 0.3, 0.58)).toBeGreaterThan(1e-3);
    expect(voicesAfterMute).toBe(0);
    expect(peak(L, 0.62, 1.19)).toBeLessThan(1e-5);
    expect(peak(R, 0.62, 1.19)).toBeLessThan(1e-5);
    // Output works again after unmute.
    expect(toneAmp(L, 440, 1.25, 1.45)).toBeGreaterThan(0.05);
  });

  it('panic stops held voices without changing the mute state', async () => {
    const h = await harness(1, coreProject());
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.5, time: 0.02 });
    h.at(0.3, () => h.engine.panic());
    h.at(0.5, () => h.engine.scheduleNote('t3', { pitch: E5, velocity: 0.5, time: 0.55, duration: 0.3 }));
    const { L } = await h.render();
    expect(toneAmp(L, 440, 0.1, 0.29)).toBeCloseTo(0.5, 2);
    expect(peak(L, 0.32, 0.54)).toBeLessThan(1e-5);
    expect(toneAmp(L, midiToHz(E5), 0.6, 0.8)).toBeCloseTo(0.5, 2);
  });
});

describe('AudioEngine mute and solo', () => {
  it('mute removes a track; solo leaves only soloed tracks', async () => {
    const p = coreProject();
    const muted = clone(p);
    muted.tracks[2].mute = true;
    const soloed = clone(p);
    soloed.tracks[2].solo = true;
    const both = clone(soloed);
    both.tracks[3].solo = true;
    const mutedSolo = clone(soloed);
    mutedSolo.tracks[2].mute = true;
    const h = await harness(2.6, p);
    const f3 = 440;
    const f4 = midiToHz(E5);
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.3, time: 0.02 });
    h.engine.scheduleNote('t4', { pitch: E5, velocity: 0.3, time: 0.02 });
    h.at(0.5, () => h.engine.setProject(muted));
    h.at(1.0, () => h.engine.setProject(soloed));
    h.at(1.5, () => h.engine.setProject(both));
    h.at(2.0, () => h.engine.setProject(mutedSolo));
    const { L } = await h.render();
    const w = (t: number): [number, number] => [toneAmp(L, f3, t + 0.1, t + 0.45), toneAmp(L, f4, t + 0.1, t + 0.45)];
    const [a0, b0] = w(0);
    expect(a0).toBeCloseTo(0.3, 2);
    expect(b0).toBeCloseTo(0.3, 2);
    const [a1, b1] = w(0.5); // t3 muted
    expect(a1).toBeLessThan(1e-3);
    expect(b1).toBeCloseTo(0.3, 2);
    const [a2, b2] = w(1.0); // t3 solo
    expect(a2).toBeCloseTo(0.3, 2);
    expect(b2).toBeLessThan(1e-3);
    const [a3, b3] = w(1.5); // t3 + t4 solo
    expect(a3).toBeCloseTo(0.3, 2);
    expect(b3).toBeCloseTo(0.3, 2);
    const [a4, b4] = w(2.0); // t3 solo but muted: nothing audible
    expect(a4).toBeLessThan(1e-3);
    expect(b4).toBeLessThan(1e-3);
  });

  it('sends are post-fader: they follow the channel level and go silent with mute', async () => {
    const p = coreProject();
    p.patch.connections.push(conn('t3:ch', 'sendA', MASTER_ID, 'in'));
    p.tracks[2].macros = { ...p.tracks[2].macros, space: 0.5 / 0.85 }; // -> sendA 0.5
    const quieter = clone(p);
    moduleParams(quieter, 't3:ch').level = -6;
    const muted = clone(quieter);
    muted.tracks[2].mute = true;
    const h = await harness(1.6, p);
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.2, time: 0.02 });
    h.at(0.5, () => h.engine.setProject(quieter));
    h.at(1.0, () => h.engine.setProject(muted));
    const { L } = await h.render();
    // Direct 0.2 + send 0.5 x 0.2.
    expect(toneAmp(L, 440, 0.1, 0.45)).toBeCloseTo(0.3, 3);
    expect(toneAmp(L, 440, 0.6, 0.95)).toBeCloseTo(0.3 * 10 ** (-6 / 20), 3);
    expect(toneAmp(L, 440, 1.1, 1.55)).toBeLessThan(1e-4);
  });

  it('level automation scheduled ahead never undoes a mute, nor re-mutes an unmuted part', async () => {
    const p = coreProject();
    const muted = clone(p);
    muted.tracks[2].mute = true;
    const h = await harness(2.4, p);
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.5, time: 0.01 });
    // Scheduled while audible, lands while muted.
    h.engine.scheduleParam('t3:ch', 'level', -6, 0.6);
    h.at(0.4, () => h.engine.setProject(muted));
    h.at(1.05, () => h.engine.setProject(p));
    // Scheduled while muted, lands after unmuting.
    h.at(1.5, () => h.engine.setProject(muted));
    h.at(1.55, () => h.engine.scheduleParam('t3:ch', 'level', -12, 1.8));
    h.at(1.65, () => h.engine.setProject(p));
    const { L } = await h.render();
    const db = (t0: number, t1: number) => 20 * Math.log10(toneAmp(L, 440, t0, t1) / 0.5);
    expect(db(0.1, 0.35)).toBeCloseTo(0, 1);
    expect(toneAmp(L, 440, 0.5, 1.0)).toBeLessThan(1e-4); // stays muted through the 0.6 s point
    expect(db(1.15, 1.45)).toBeCloseTo(-6, 1); // unmuted at the automated level
    expect(db(1.9, 2.3)).toBeCloseTo(-12, 1); // the point scheduled while muted does not re-mute
  });
});

describe('AudioEngine project updates', () => {
  it('swaps the instrument engine when the instrument kind changes', async () => {
    const p = coreProject();
    const poly = clone(p);
    poly.tracks[2].instrument = createInstrument('poly');
    poly.tracks[2].instrument.params.level = 0;
    const { factory, built } = makeFactory();
    const h = await harness(1, p, factory);
    const t3Before = built.filter((b) => b.kind === 'bass').length;
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.4, time: 0.05 });
    h.at(0.4, () => h.engine.setProject(poly));
    h.at(0.5, () => h.engine.scheduleNote('t3', { pitch: E5, velocity: 0.4, time: 0.55, duration: 0.3 }));
    const { L } = await h.render();
    expect(t3Before).toBe(1);
    const polys = built.filter((b) => b.kind === 'poly');
    // 4 poly tracks by default + the swapped one.
    expect(polys.length).toBe(5);
    // The old bass engine was disposed and its held note stopped.
    const bass = built.find((b) => b.kind === 'bass')!;
    expect(bass.disposed).toBe(true);
    expect(toneAmp(L, 440, 0.1, 0.35)).toBeCloseTo(0.4, 2);
    expect(toneAmp(L, 440, 0.6, 0.8)).toBeLessThan(1e-3);
    expect(toneAmp(L, midiToHz(E5), 0.6, 0.8)).toBeCloseTo(0.4, 2);
  });

  it('is cheap and inert when nothing audio-relevant changed', async () => {
    const p = coreProject();
    const { factory, built } = makeFactory();
    const h = await harness(0.1, p, factory);
    const updatesBefore = built.map((b) => b.updates);
    const statsBefore = h.engine.getStats();
    // Note edits replace the tracks array (as the store does) but leave every
    // instrument, macro and module untouched.
    const noteEdits: Project[] = Array.from({ length: 200 }, (_, i) => ({
      ...p,
      updatedAt: 5000 + i,
      tracks: p.tracks.map((t, k) => (k === 2 ? { ...t, clips: [createClip('c', 1, [{ tick: i, pitch: 60, velocity: 1, duration: 24 }]), null, null, null] } : t)),
    }));
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) h.engine.setProject({ ...p, name: `rename ${i}`, updatedAt: i });
    for (const q of noteEdits) h.engine.setProject(q);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(150);
    expect(built.map((b) => b.updates)).toEqual(updatesBefore);
    expect(h.engine.getStats()).toEqual(statsBefore);
    await h.render();
  });

  it('instrument automation does not carry over to a different instrument kind', async () => {
    const p = coreProject();
    const poly = clone(p);
    poly.tracks[2].instrument = createInstrument('poly');
    poly.tracks[2].instrument.params.level = 0; // same stored level as the bass had
    const h = await harness(1, p);
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.4, time: 0.02, duration: 0.3 });
    h.engine.scheduleParam('t3:inst', 'level', -12, 0.1);
    h.at(0.4, () => h.engine.setProject(poly));
    h.at(0.5, () => h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.4, time: 0.55, duration: 0.3 }));
    const { L } = await h.render();
    const db = (t0: number, t1: number) => 20 * Math.log10(toneAmp(L, 440, t0, t1) / 0.4);
    expect(db(0.15, 0.3)).toBeCloseTo(-12, 1); // the bass follows the automation
    expect(db(0.6, 0.8)).toBeCloseTo(0, 1); // the new poly engine starts from the project value
  });

  it('applies master volume changes from the project', async () => {
    const p = coreProject();
    const quieter = clone(p);
    quieter.masterVolumeDb = -12;
    const h = await harness(1, p);
    h.engine.scheduleNote('t3', { pitch: A4, velocity: 0.5, time: 0.02 });
    h.at(0.5, () => h.engine.setProject(quieter));
    const { L } = await h.render();
    const a = toneAmp(L, 440, 0.1, 0.45);
    const b = toneAmp(L, 440, 0.6, 0.95);
    expect(20 * Math.log10(b / a)).toBeCloseTo(-12, 1);
  });
});

describe('AudioEngine metronome and instrument context', () => {
  it('clicks are ~30 ms sine blips: 1.6 kHz accent, 1 kHz otherwise', async () => {
    const withMaster = coreProject();
    const noMaster = clone(withMaster);
    noMaster.patch.modules = noMaster.patch.modules.filter((m) => m.type !== 'master');
    noMaster.patch.connections = noMaster.patch.connections.filter((c) => c.to.module !== MASTER_ID);
    for (const p of [withMaster, noMaster]) {
      const h = await harness(1, p);
      h.engine.scheduleClick(0.1, true);
      h.engine.scheduleClick(0.5, false);
      const { L } = await h.render();
      const s0 = 0.1 + LATENCY;
      const s1 = 0.5 + LATENCY;
      expect(toneAmp(L, 1600, s0, s0 + 0.03)).toBeGreaterThan(5 * toneAmp(L, 1000, s0, s0 + 0.03));
      expect(toneAmp(L, 1000, s1, s1 + 0.03)).toBeGreaterThan(5 * toneAmp(L, 1600, s1, s1 + 0.03));
      expect(peak(L, s0, s0 + 0.01)).toBeGreaterThan(peak(L, s1, s1 + 0.01)); // accent is louder
      expect(peak(L, s0, s0 + 0.01)).toBeGreaterThan(0.2);
      // Short: gone ~36 ms after it starts.
      expect(peak(L, s0 + 0.04, s1 - 0.01)).toBeLessThan(1e-5);
      expect(peak(L, s1 + 0.04, 1)).toBeLessThan(1e-5);
      expect(peak(L, 0, s0 - 0.001)).toBe(0);
    }
  });

  it('hands instruments a 2 s seeded white-noise buffer', async () => {
    const grab = async (seed: number): Promise<Float32Array> => {
      let noise: AudioBuffer | null = null;
      const { factory } = makeFactory();
      const ctx = new OfflineAudioContext(2, 128, SR);
      const engine = await AudioEngine.create(ctx, {
        samples: { get: () => null },
        seed,
        meters: false,
        instrumentFactory: (ictx, inst) => {
          noise = ictx.noise;
          return factory(ictx, inst);
        },
      });
      engine.setProject(coreProject());
      engine.dispose();
      return (noise as AudioBuffer | null)!.getChannelData(0).slice();
    };
    const a = await grab(5);
    const b = await grab(5);
    const c = await grab(6);
    expect(a.length).toBe(2 * SR);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    let sum = 0;
    let sq = 0;
    let max = 0;
    for (const v of a) {
      sum += v;
      sq += v * v;
      max = Math.max(max, Math.abs(v));
    }
    expect(Math.abs(sum / a.length)).toBeLessThan(0.01);
    expect(Math.sqrt(sq / a.length)).toBeCloseTo(1 / Math.sqrt(3), 2);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('AudioEngine.create is an EngineFactory and loads worklets once per context', async () => {
    const create: EngineFactory = AudioEngine.create;
    const ctx = new OfflineAudioContext(2, 128, SR);
    expect(loadEngineWorklets(ctx)).toBe(loadEngineWorklets(ctx));
    const [e1, e2] = await Promise.all([
      create(ctx, { samples: { get: () => null }, seed: 1, meters: false, instrumentFactory: makeFactory().factory }),
      create(ctx, { samples: { get: () => null }, seed: 2, meters: false, instrumentFactory: makeFactory().factory }),
    ]);
    expect(e1.ctx).toBe(ctx);
    expect(e2.output).not.toBe(e1.output);
    e1.dispose();
    e2.dispose();
  });
});

describe('AudioEngine lifecycle', () => {
  it('creating and disposing 20 engines on one offline context leaves nothing behind', async () => {
    const n = Math.round(0.3 * SR);
    const ctx = new OfflineAudioContext(2, n, SR);
    const { factory, built } = makeFactory();
    for (let i = 0; i < 20; i++) {
      const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: i, meters: false, instrumentFactory: factory });
      engine.setProject(baseProject());
      engine.scheduleNote('t4', { pitch: A4, velocity: 1, time: 0.01 });
      engine.dispose();
      const s = engine.getStats();
      expect(s.pendingTimers).toBe(0);
      expect(s.modules).toBe(0);
      expect(s.connections).toBe(0);
      expect(s.voices).toBe(0);
      // Calls after dispose are harmless no-ops.
      engine.setProject(baseProject());
      expect(engine.scheduleNote('t4', { pitch: A4, velocity: 1, time: 0.01 })).toBeNull();
    }
    expect(built.length).toBe(20 * 8);
    expect(built.every((b) => b.disposed && b.voices.size === 0)).toBe(true);
    // Everything was disconnected from the destination.
    const buf = await ctx.startRendering();
    expect(peak(buf.getChannelData(0))).toBe(0);
  });

  it('on a live context, rewiring timers are counted and cleared by dispose', async () => {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener('error', onError);
    try {
      for (let i = 0; i < 20; i++) {
        const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: i, meters: true, instrumentFactory: makeFactory().factory });
        const p = coreProject();
        engine.setProject(p);
        engine.liveNoteOn('t3', A4, 0.5, 'KeyA');
        const cut = withoutConnection(p, 't3:ch', 'out', MASTER_ID, 'in');
        engine.setProject(cut);
        expect(engine.getStats().pendingTimers).toBeGreaterThan(0);
        engine.setMuteAll(true);
        engine.dispose();
        expect(engine.getStats().pendingTimers).toBe(0);
      }
      await new Promise((r) => setTimeout(r, 150));
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
      await ctx.close();
    }
  });

  it('live meters report master, limiter reduction and per-track levels', async () => {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    try {
      expect(ctx.state).toBe('running');
      const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: 1, meters: true, instrumentFactory: makeFactory().factory });
      const p = coreProject();
      p.masterVolumeDb = 6;
      moduleParams(p, 't3:ch').level = 6;
      engine.setProject(p);
      engine.liveNoteOn('t3', A4, 1, 'KeyA');
      await new Promise((r) => setTimeout(r, 400));
      const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
      engine.readMeters(frame);
      expect(frame.masterPeakL).toBeGreaterThan(0.8);
      expect(frame.masterPeakL).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-4);
      expect(frame.masterRms).toBeGreaterThan(0.5);
      // 1.0 x 2 (channel) x 2 (master) = +12 dB over full scale, limited to -1 dBFS.
      expect(frame.limiterReductionDb).toBeGreaterThan(10);
      expect(frame.limiterReductionDb).toBeLessThan(15);
      expect(frame.tracks.map((t) => t.trackId)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
      const t3 = frame.tracks[2];
      expect(t3.peak).toBeGreaterThan(1.9);
      expect(t3.rms).toBeGreaterThan(1.3);
      expect(frame.tracks[3].peak).toBe(0);
      expect(engine.getStats().voices).toBe(1);
      engine.liveNoteOff('t3', 'KeyA');
      await new Promise((r) => setTimeout(r, 150));
      expect(engine.getStats().voices).toBe(0);
      engine.dispose();
    } finally {
      await ctx.close();
    }
  });
});
