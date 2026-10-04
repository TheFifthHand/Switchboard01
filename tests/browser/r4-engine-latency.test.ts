/**
 * outputLatencyFrames (MIX-04): the frames between a note's time and its
 * sound at the output for the current project. The limiter's look-ahead
 * always; the Drive's 128 frames only when every audible part passes a
 * Drive (trimming more would clip the attack of a part without one).
 * Measured on rendered hits.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { DRIVE_LATENCY_FRAMES } from '../../src/audio/modules/drive';
import { limiterLatencyFrames } from '../../src/audio/worklets/limiter';
import { applyKitToProject } from '../../src/content/presets';
import { conn, createProject, moduleId } from '../../src/project/factory';
import type { Project } from '../../src/project/types';

const SR = 48000;

/** Drums only (t1), the rest muted; `withoutDrive` patches t1 straight from its instrument to its filter. */
function drumsProject(withoutDrive: boolean): Project {
  const p = createProject({ now: 0 });
  p.seed = 9;
  applyKitToProject(p, 't1', 'tight-circuit');
  for (const t of p.tracks) {
    t.macros = { ...t.macros, space: 0, echo: 0 };
    t.mute = t.id !== 't1';
  }
  if (withoutDrive) {
    const inst = moduleId.inst('t1');
    const drive = moduleId.drive('t1');
    p.patch.connections = p.patch.connections.filter((c) => c.from.module !== inst && c.from.module !== drive);
    p.patch.connections.push(conn(inst, 'out', moduleId.filter('t1'), 'in'));
  }
  return p;
}

async function onsetFrame(project: Project, time: number): Promise<{ onset: number; latency: number }> {
  const ctx = new OfflineAudioContext(2, SR / 2, SR);
  const engine = await AudioEngine.create(ctx, { samples: new SampleBank(SR), seed: project.seed, meters: false });
  engine.setProject(project);
  const latency = engine.outputLatencyFrames();
  // Rim shot: a sharp attack.
  engine.scheduleNote('t1', { pitch: 7, velocity: 1, time });
  const buf = await ctx.startRendering();
  const d = buf.getChannelData(0);
  let onset = -1;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > 1e-4) {
      onset = i;
      break;
    }
  }
  engine.dispose();
  return { onset, latency };
}

describe('output latency', () => {
  it('every part through a Drive: limiter look-ahead + 128 frames, and the hit lands exactly there', async () => {
    const time = 0.1;
    const { onset, latency } = await onsetFrame(drumsProject(false), time);
    expect(latency).toBe(limiterLatencyFrames(SR) + DRIVE_LATENCY_FRAMES);
    expect(Math.abs(onset - (Math.round(time * SR) + latency))).toBeLessThanOrEqual(1);
  });

  it('an audible part without a Drive: the limiter look-ahead only (its hit lands there)', async () => {
    const time = 0.1;
    const { onset, latency } = await onsetFrame(drumsProject(true), time);
    expect(latency).toBe(limiterLatencyFrames(SR));
    expect(Math.abs(onset - (Math.round(time * SR) + latency))).toBeLessThanOrEqual(1);
  });

  it('follows the project: muting the part without a Drive, or bypassing a Drive, changes it', async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(SR), seed: 1, meters: false });
    const p = drumsProject(true);
    // Another audible part with its Drive: the earliest audible part decides.
    p.tracks[2].mute = false;
    engine.setProject(p);
    expect(engine.outputLatencyFrames()).toBe(limiterLatencyFrames(SR));
    const muted = { ...p, tracks: p.tracks.map((t) => (t.id === 't1' ? { ...t, mute: true } : t)) };
    engine.setProject(muted);
    expect(engine.outputLatencyFrames()).toBe(limiterLatencyFrames(SR) + DRIVE_LATENCY_FRAMES);
    const bypassed = { ...muted, patch: { ...muted.patch, modules: muted.patch.modules.map((m) => (m.id === moduleId.drive('t3') ? { ...m, bypass: true } : m)) } };
    engine.setProject(bypassed);
    expect(engine.outputLatencyFrames()).toBe(limiterLatencyFrames(SR));
    engine.dispose();
  });
});
