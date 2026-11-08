/**
 * The beat-maker starters and the loop library through the real engine:
 * every part of each new starter's Groove and Lift is heard on its own (no
 * silent parts), the Groove plays at a comfortable level under the output
 * ceiling, and library loops played on their suggested sounds are audible,
 * finite and clean.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { OUTPUT_CEILING } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { getStarter } from '../../src/content/starters';
import { LOOP_ROLES, loopsFor, realizeLoop, type LibraryLoop } from '../../src/content/loops';
import { applyKitToProject, applyPresetToProject } from '../../src/content/presets';
import { createClip, createProject } from '../../src/project/factory';
import { renderOffline } from '../../src/render/offline';
import { isAllFinite, peak, rms } from '../../src/render/analysis';
import type { Project } from '../../src/project/types';

const SR = 44100;
const db = (x: number) => 20 * Math.log10(Math.max(1e-9, x));

async function render(project: Project, row: number, bars: number) {
  const bank = new SampleBank(SR);
  const buf = await renderOffline({ project, source: { kind: 'scene', row, bars }, sampleRate: SR, tailSeconds: 0.2, createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: project.seed, meters: false }) });
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const mono = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
  return { finite: isAllFinite(L) && isAllFinite(R), peak: Math.max(peak(L), peak(R)), rmsDb: db(rms(mono)) };
}

describe('beat-maker starters through the real engine', () => {
  for (const id of ['trap', 'lofi', 'pop', 'afrobeats', 'boomBap']) {
    it(`${id}: the Groove is comfortable and every part of the Groove and Lift is heard`, async () => {
      const p0 = getStarter(id)!.build();
      const mix = await render(structuredClone(p0), 1, 2);
      expect(mix.finite).toBe(true);
      expect(mix.peak).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-5);
      expect(mix.rmsDb).toBeGreaterThan(-26);
      expect(mix.rmsDb).toBeLessThan(-14);
      const silent: string[] = [];
      for (const row of [1, 2]) {
        for (const t of p0.tracks) {
          if (!t.clips[row]) continue;
          const p = structuredClone(p0);
          for (const u of p.tracks) u.mute = u.id !== t.id;
          const solo = await render(p, row, 4);
          expect(solo.finite).toBe(true);
          if (solo.rmsDb < -55) silent.push(`${p0.scenes[row].name} ${t.name} ${solo.rmsDb.toFixed(1)} dBFS`);
        }
      }
      expect(silent).toEqual([]);
    }, 240_000);
  }
});

/** A blank project playing one library loop on its suggested sound. */
function loopProject(loop: LibraryLoop): Project {
  const p = createProject({ name: 'Loop', now: 1 });
  p.root = 9;
  p.scale = 'minor';
  const t = p.tracks.find((x) => x.role === loop.role)!;
  if (loop.part.kind === 'drums') applyKitToProject(p, t.id, loop.sound);
  else applyPresetToProject(p, t.id, loop.sound);
  const inst = p.tracks.find((x) => x.id === t.id)!.instrument;
  const r = realizeLoop(loop, { root: p.root, scale: p.scale, kind: inst.kind, kitId: inst.kind === 'drums' ? inst.kitId : undefined });
  p.tracks.find((x) => x.id === t.id)!.clips[0] = createClip(r.name, r.bars, r.notes);
  return p;
}

describe('library loops on their suggested sounds', () => {
  it('the first loops of every part play audibly, finite and under the ceiling', async () => {
    const quiet: string[] = [];
    for (const role of LOOP_ROLES) {
      for (const loop of loopsFor(role).slice(0, 3)) {
        const r = await render(loopProject(loop), 0, Math.min(loop.bars, 4));
        expect(r.finite, loop.id).toBe(true);
        expect(r.peak, loop.id).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-5);
        if (r.rmsDb < -50) quiet.push(`${loop.id} ${r.rmsDb.toFixed(1)} dBFS`);
      }
    }
    expect(quiet).toEqual([]);
  }, 240_000);
});
