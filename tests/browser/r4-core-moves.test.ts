/**
 * Song moves played on the real engine (arrange-no-change-over-time,
 * capability-09 stage 1): a block's Fade in / Fade out move the song gain and
 * Filter rise moves the parts' Tone across the block, rendered offline as an
 * export renders them, and live through the real-time transport the same way.
 * A sine test instrument holds one tone per bar, so levels are easy to read.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { MeterFrame } from '../../src/audio/contracts';
import type { BlockMove, Project } from '../../src/project/types';
import { renderOffline } from '../../src/render/offline';
import { Sequencer } from '../../src/time/sequencer';
import { RealtimeTransport } from '../../src/time/transport';
import { LATENCY, SR, baseProject, coreProject, makeFactory, pitchForHz, toneAmp } from './engine-harness';
import { makeClip } from '../unit/sequencer-fixtures';

const HZ = 1000;
const TONE = Math.round(pitchForHz(HZ) * 1000) / 1000;
const VEL = 0.25;
/** 120 BPM: a beat is 0.5 s, a bar 2 s. */
const BEAT_S = 0.5;

/** t3 holds a tone through every bar of every row. Song: A (row 0, 1 bar), B (row 1, 2 bars), C (row 2, 1 bar). */
function song(p: Project, moves: { A?: BlockMove[]; B?: BlockMove[] }, pitch = TONE): Project {
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  const t3 = p.tracks.find((t) => t.id === 't3')!;
  for (let row = 0; row < 3; row++) t3.clips[row] = makeClip(1, [[0, pitch, 384, VEL]], `tone${row}`);
  p.arrangement = {
    tailSeconds: 0,
    blocks: [
      { id: 'A', sceneId: p.scenes[0].id, repeats: 1, ...(moves.A ? { moves: moves.A } : {}) },
      { id: 'B', sceneId: p.scenes[1].id, repeats: 2, ...(moves.B ? { moves: moves.B } : {}) },
      { id: 'C', sceneId: p.scenes[2].id, repeats: 1 },
    ],
  };
  return p;
}

async function render(p: Project): Promise<Float32Array> {
  const { factory } = makeFactory();
  const buf = await renderOffline({
    project: p,
    source: { kind: 'song' },
    sampleRate: SR,
    tailSeconds: 0,
    align: true,
    createEngine: (ctx) => AudioEngine.create(ctx, { samples: { get: () => null }, seed: 7, meters: false, instrumentFactory: factory }),
  });
  return buf.getChannelData(0);
}

/** Tone level (linear, re. the note's own level) over a beat starting at song time `t` (an aligned export: no offset). */
function beatLevel(d: Float32Array, t: number, hz = HZ): number {
  return toneAmp(d, hz, t + 0.03, t + BEAT_S - 0.03) / VEL;
}

const db = (x: number) => 20 * Math.log10(x);

describe('song moves, rendered (an export)', () => {
  it('Fade in: the first beat of the block is at least 20 dB below its last; the block before is untouched, the one after at unity', async () => {
    const d = await render(song(coreProject(), { B: [{ id: 'f', kind: 'fadeIn' }] }));
    const a = beatLevel(d, 1.0);
    const first = beatLevel(d, 2.0);
    const last = beatLevel(d, 5.5);
    const after = beatLevel(d, 6.5);
    console.info(`[moves] fade in: A ${db(a).toFixed(1)} dB, B first beat ${db(first).toFixed(1)} dB, last ${db(last).toFixed(1)} dB, C ${db(after).toFixed(1)} dB`);
    expect(db(last) - db(first)).toBeGreaterThanOrEqual(20);
    expect(a).toBeGreaterThan(0.9);
    expect(after).toBeGreaterThan(0.9);
    expect(last).toBeGreaterThan(0.8);
  });

  it('Fade out: falls to silence across the block, then the next block is back at unity', async () => {
    const d = await render(song(coreProject(), { B: [{ id: 'f', kind: 'fadeOut' }] }));
    // Linear in gain: 3/4 a quarter in, 1/4 three quarters in.
    expect(beatLevel(d, 2.75)).toBeCloseTo(0.75, 1);
    expect(beatLevel(d, 4.75)).toBeCloseTo(0.25, 1);
    expect(db(beatLevel(d, 5.5))).toBeLessThan(-20);
    expect(beatLevel(d, 6.5)).toBeGreaterThan(0.9);
  });

  it('Filter rise: the part’s Tone starts closed and opens across the block, back at its own value after it', async () => {
    // A bright tone (6 kHz) through the part's filter, whose cutoff the Tone big knob sets.
    const hz = 6000;
    const p = song(baseProject(), { B: [{ id: 'r', kind: 'filterRise', parts: ['t3'] }] }, Math.round(pitchForHz(hz) * 1000) / 1000);
    const d = await render(p);
    const own = beatLevel(d, 1.0, hz);
    const start = beatLevel(d, 2.0, hz);
    const end = beatLevel(d, 5.5, hz);
    const after = beatLevel(d, 6.5, hz);
    console.info(`[moves] filter rise: A ${db(own).toFixed(1)} dB, B first beat ${db(start).toFixed(1)} dB, last ${db(end).toFixed(1)} dB, C ${db(after).toFixed(1)} dB`);
    expect(db(own) - db(start)).toBeGreaterThan(6);
    expect(Math.abs(db(end) - db(own))).toBeLessThan(1.5);
    expect(Math.abs(db(after) - db(own))).toBeLessThan(0.5);
  });
});

describe('song moves, live (the real-time transport on an AudioContext)', () => {
  /** Plays `p` as a song live (from `fromTick`) and reads the master level whenever the audio clock reaches song time t. */
  async function liveLevels(p: Project, times: number[], fromTick = 0): Promise<number[]> {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    const { factory } = makeFactory();
    const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: 7, meters: true, instrumentFactory: factory });
    engine.setProject(p);
    const seq = new Sequencer({ getProject: () => p });
    const transport = new RealtimeTransport({ ctx, engine, sequencer: seq });
    const f: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
    try {
      transport.start({ mode: { kind: 'song', fromBlock: 0 }, fromTick });
      const t0 = seq.timeAt(fromTick);
      const out: number[] = [];
      for (const t of times) {
        const when = t0 + (t - (fromTick / 384) * 2) + LATENCY;
        while (ctx.currentTime < when) await new Promise((r) => setTimeout(r, 5));
        engine.readMeters(f);
        // A sine of amplitude VEL has RMS VEL/√2.
        out.push(f.masterRms / (VEL * Math.SQRT1_2));
      }
      return out;
    } finally {
      transport.dispose();
      engine.dispose();
      await ctx.close();
    }
  }

  it('a 2-block song with a fade out: live levels follow the offline render within the meter tolerance', async () => {
    const p = song(coreProject(), { B: [{ id: 'f', kind: 'fadeOut' }] });
    const times = [1.25, 2.75, 3.75, 4.75];
    const d = await render(p);
    const offline = times.map((t) => toneAmp(d, HZ, t - 0.02, t + 0.02) / VEL);
    const live = await liveLevels(p, times);
    console.info(`[moves] fade out, offline ${offline.map((x) => x.toFixed(3)).join(' ')}, live ${live.map((x) => x.toFixed(3)).join(' ')}`);
    for (let i = 0; i < times.length; i++) {
      expect(live[i], `at ${times[i]} s`).toBeGreaterThan(offline[i] - 0.06);
      expect(live[i], `at ${times[i]} s`).toBeLessThan(offline[i] + 0.06);
    }
  });

  it('a song that opens with a Fade in starts from silence, also again after Stop; Pause and Play in the fade go on from the level reached', async () => {
    const p = song(coreProject(), { A: [{ id: 'f', kind: 'fadeIn' }] });
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    const { factory } = makeFactory();
    const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: 7, meters: true, instrumentFactory: factory });
    engine.setProject(p);
    const seq = new Sequencer({ getProject: () => p });
    const transport = new RealtimeTransport({ ctx, engine, sequencer: seq });
    const f: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
    /** The level when the audio clock reaches song time `t` of a playback whose tick 0 is at `t0` (relative to the tone's own). */
    const levelAt = async (t0: number, t: number) => {
      while (ctx.currentTime < t0 + t + LATENCY) await new Promise((r) => setTimeout(r, 5));
      engine.readMeters(f);
      return f.masterRms / (VEL * Math.SQRT1_2);
    };
    try {
      const levels: number[] = [];
      for (let pass = 0; pass < 2; pass++) {
        transport.start({ mode: { kind: 'song', fromBlock: 0 } });
        const t0 = seq.timeAt(0);
        levels.push(await levelAt(t0, 0.15), await levelAt(t0, 1.75));
        // Stopped at ~90 %: the gain holds there until the next start.
        transport.stop();
      }
      // Pause at about half way (song time 1.0 s), Play again half a second later.
      transport.start({ mode: { kind: 'song', fromBlock: 0 } });
      const t0 = seq.timeAt(0);
      await levelAt(t0, 1.0);
      expect(transport.pause()).toBe(true);
      const pausedTick = seq.tickAt(ctx.currentTime);
      await new Promise((r) => setTimeout(r, 500));
      expect(transport.resume()).toBe(true);
      const t1 = seq.timeAt(pausedTick);
      const resumed = await levelAt(t1, 0.1);
      const reached = pausedTick / 384;
      console.info(`[moves] fade-in start ${levels.map((x) => x.toFixed(3)).join(' ')}; resumed at ${reached.toFixed(2)} of the fade: ${resumed.toFixed(3)}`);
      expect(levels[0]).toBeLessThan(0.15);
      expect(levels[1]).toBeGreaterThan(0.75);
      expect(levels[2]).toBeLessThan(0.15);
      expect(levels[3]).toBeGreaterThan(0.75);
      expect(resumed).toBeGreaterThan(reached - 0.1);
      expect(resumed).toBeLessThan(reached + 0.15);
    } finally {
      transport.dispose();
      engine.dispose();
      await ctx.close();
    }
  });

  it('started in the middle of a fade (a seek), it begins at the value the fade has there', async () => {
    const p = song(coreProject(), { B: [{ id: 'f', kind: 'fadeIn' }] });
    // Bar 2 of the song = half way through B's fade in (B spans song bars 1..3).
    const [level] = await liveLevels(p, [4.25], 2 * 384);
    console.info(`[moves] seek into a fade in: ${level.toFixed(3)} (expected ~0.53)`);
    expect(level).toBeGreaterThan(0.45);
    expect(level).toBeLessThan(0.62);
  });
});
