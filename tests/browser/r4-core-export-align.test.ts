/**
 * MIX-04: an export starts on the music's first downbeat and lasts exactly
 * the music plus the tail. The render's start offset and the engine's output
 * latency (limiter look-ahead and the module latency every audible part has)
 * are cut from the start and rendered extra at the end, so a one-bar loop
 * export repeats cleanly in another app.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/app/session';
import { createClip, createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { computeRenderPlan } from '../../src/render/offline';
import { parseWav } from '../../src/render/wav';
import { deleteDb } from '../../src/persistence/db';

const SR = 48000;

/** A kick on the downbeat of a 1-bar clip (row 0), dry, at 120 BPM; nothing else plays. */
function kickProject(bpm = 120): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 11;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  p.tracks[0].clips[0] = createClip('kick', 1, [{ tick: 0, pitch: 0, velocity: 1, duration: 24 }, { tick: 192, pitch: 0, velocity: 1, duration: 24 }]);
  return p;
}

let live: Session[] = [];
beforeEach(async () => {
  await deleteDb();
});
afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  await deleteDb();
});

async function exportScene(s: Session, bars: number, tail: number) {
  const blob = await s.renderWav({ source: { kind: 'scene', row: 0, bars }, sampleRate: SR, bitDepth: 24, tailSeconds: tail });
  return parseWav(await blob.arrayBuffer());
}

/** First frame whose level is above −60 dBFS on either channel. */
function firstAudible(ch: Float32Array[]): number {
  const floor = Math.pow(10, -60 / 20);
  for (let i = 0; i < ch[0].length; i++) if (Math.abs(ch[0][i]) > floor || Math.abs(ch[1][i]) > floor) return i;
  return -1;
}

describe('Export alignment (MIX-04)', () => {
  it('a 1-bar scene export with tail 0 at 48 kHz is exactly one bar long, and its downbeat is at frame 0', async () => {
    const s = new Session(kickProject());
    live.push(s);
    const wav = await exportScene(s, 1, 0);
    const barSeconds = (4 * 60) / 120;
    expect(wav.sampleRate).toBe(SR);
    expect(Math.abs(wav.channels[0].length - Math.round(barSeconds * SR))).toBeLessThanOrEqual(1);
    const first = firstAudible(wav.channels);
    console.info(`[export-align] frames ${wav.channels[0].length} (bar ${Math.round(barSeconds * SR)}), first sample above −60 dBFS at frame ${first}`);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(2);
    // The kick on beat 3 is exactly half a bar later.
    const mid = Math.round((barSeconds / 2) * SR);
    const before = wav.channels[0].subarray(mid - 2000, mid + 200);
    const hit = firstAudible([before.map((x, i) => (i > 1500 ? x : 0)), new Float32Array(before.length)]);
    // The second kick (beat 3) is half a bar in, to the frame (its attack within a frame or two).
    expect(hit - 2000).toBeGreaterThanOrEqual(0);
    expect(hit - 2000).toBeLessThanOrEqual(2);
  });

  it('a tempo that does not fit whole frames: the length is the music plus the tail, rounded to a frame', async () => {
    const s = new Session(kickProject(97));
    live.push(s);
    const wav = await exportScene(s, 2, 0.5);
    const plan = computeRenderPlan(s.store.getState(), { kind: 'scene', row: 0, bars: 2 }, 0.5);
    expect(plan.fileSeconds).toBeCloseTo(2 * (240 / 97) + 0.5, 9);
    expect(Math.abs(wav.channels[0].length - Math.round(plan.fileSeconds * SR))).toBeLessThanOrEqual(1);
    expect(firstAudible(wav.channels)).toBeLessThanOrEqual(2);
  });
});
