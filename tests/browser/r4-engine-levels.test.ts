/**
 * Honest levels (offline renders of the House starter's Groove, one part
 * soloed): knobs change the character of a part, not how loud it is.
 *  - Filter Resonance on a wide-open low-pass barely changes the level, and
 *    still rings (moves the spectral centroid) once the cutoff is in range.
 *  - The Drive big knob keeps Chords, Drums and Bass within ±1.5 dB RMS.
 *  - Chorus, Phaser and Flanger at their defaults keep the part's total
 *    stereo energy within 1 dB (equal-power mix).
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { HOUSE } from '../../src/content/starters/house';
import { conn, createModule, moduleId } from '../../src/project/factory';
import type { ModuleType, Project } from '../../src/project/types';
import { renderOffline } from '../../src/render/offline';
import { spectralCentroid } from '../../src/render/analysis';

const SR = 48000;
const BARS = 4;

function soloed(trackId: string, edit?: (p: Project) => void): Project {
  const p = HOUSE.build();
  for (const t of p.tracks) t.solo = t.id === trackId;
  edit?.(p);
  return p;
}

async function render(project: Project): Promise<{ L: Float32Array; R: Float32Array }> {
  const bank = new SampleBank(SR);
  const buf = await renderOffline({
    project,
    source: { kind: 'scene', row: 1, bars: BARS },
    sampleRate: SR,
    tailSeconds: 0.1,
    createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: project.seed, meters: false }),
  });
  return { L: buf.getChannelData(0).slice(), R: buf.getChannelData(1).slice() };
}

/** Total stereo energy as an RMS level in dB, from the second bar on (attacks of the first hits skipped). */
function energyDb(x: { L: Float32Array; R: Float32Array }): number {
  const from = Math.round(x.L.length / BARS);
  let s = 0;
  for (let i = from; i < x.L.length; i++) s += x.L[i] * x.L[i] + x.R[i] * x.R[i];
  return 10 * Math.log10(s / (2 * (x.L.length - from)));
}

function mono(x: { L: Float32Array; R: Float32Array }): Float32Array {
  const m = new Float32Array(x.L.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (x.L[i] + x.R[i]);
  return m;
}

function setModule(p: Project, id: string, params: Record<string, number>): void {
  const m = p.patch.modules.find((x) => x.id === id);
  if (!m) throw new Error(`no module ${id}`);
  m.params = { ...m.params, ...params };
}

/** The part's filter under direct control: no macro moves its cutoff, no LFO sweeps it. */
function freeFilter(p: Project, trackId: string): void {
  const t = p.tracks.find((x) => x.id === trackId)!;
  const f = moduleId.filter(trackId);
  for (const k of Object.keys(t.macroMap) as (keyof typeof t.macroMap)[]) t.macroMap[k] = t.macroMap[k].filter((x) => !(x.module === f && x.param === 'cutoff'));
  t.macros = { ...t.macros, motion: 0 };
}

/** Insert an effect between the part's filter and its channel strip. */
function insertEffect(p: Project, trackId: string, type: ModuleType, bypass: boolean): void {
  const id = `${trackId}:test-${type}`;
  const f = moduleId.filter(trackId);
  const ch = moduleId.channel(trackId);
  p.patch.modules.push({ ...createModule(id, type, trackId), bypass });
  p.patch.connections = p.patch.connections.filter((c) => !(c.from.module === f && c.to.module === ch));
  p.patch.connections.push(conn(f, 'out', id, 'in'), conn(id, 'out', ch, 'in'));
}

describe('Filter resonance (shape-01)', () => {
  it('a wide-open low-pass: Resonance 0 -> 1 changes the Chords level by at most 1 dB', async () => {
    const at = async (resonance: number) =>
      energyDb(
        await render(
          soloed('t4', (p) => {
            freeFilter(p, 't4');
            setModule(p, moduleId.filter('t4'), { mode: 0, cutoff: 20000, resonance });
          }),
        ),
      );
    const r0 = await at(0);
    const r1 = await at(1);
    console.info(`[levels] chords wide open: resonance 0 ${r0.toFixed(2)} dB, 1 ${r1.toFixed(2)} dB`);
    expect(Math.abs(r1 - r0)).toBeLessThanOrEqual(1);
  }, 60_000);

  it('at a 2 kHz cutoff Resonance still rings: the spectral centroid moves by 30 % or more', async () => {
    const at = async (resonance: number) =>
      spectralCentroid(
        mono(
          await render(
            soloed('t4', (p) => {
              freeFilter(p, 't4');
              setModule(p, moduleId.filter('t4'), { mode: 0, cutoff: 2000, resonance });
            }),
          ),
        ),
        SR,
      );
    const c0 = await at(0);
    const c1 = await at(1);
    console.info(`[levels] chords at 2 kHz: centroid ${c0.toFixed(0)} -> ${c1.toFixed(0)} Hz`);
    expect(Math.abs(c1 - c0) / c0).toBeGreaterThanOrEqual(0.3);
  }, 60_000);
});

describe('Drive big knob (shape-04)', () => {
  for (const [trackId, name] of [
    ['t4', 'Chords'],
    ['t1', 'Drums'],
    ['t3', 'Bass'],
  ] as const) {
    it(`${name}: Drive 0 -> 1 stays within ±1.5 dB RMS`, async () => {
      const levels: number[] = [];
      for (const drive of [0, 0.25, 0.5, 0.75, 1]) {
        levels.push(energyDb(await render(soloed(trackId, (p) => (p.tracks.find((t) => t.id === trackId)!.macros.drive = drive)))));
      }
      console.info(`[levels] ${name} drive 0/.25/.5/.75/1: ${levels.map((l) => l.toFixed(2)).join(' / ')} dB`);
      for (const l of levels) expect(Math.abs(l - levels[0]), levels.map((x) => x.toFixed(2)).join(' / ')).toBeLessThanOrEqual(1.5);
    }, 120_000);
  }
});

describe('Movement effects keep the level (equal-power mix)', () => {
  for (const type of ['chorus', 'phaser', 'flanger'] as const) {
    it(`${type} at its defaults changes the Chords' stereo energy by at most 1 dB`, async () => {
      const off = energyDb(await render(soloed('t4', (p) => insertEffect(p, 't4', type, true))));
      const on = energyDb(await render(soloed('t4', (p) => insertEffect(p, 't4', type, false))));
      console.info(`[levels] ${type}: bypassed ${off.toFixed(2)} dB, on ${on.toFixed(2)} dB`);
      expect(Math.abs(on - off)).toBeLessThanOrEqual(1);
    }, 60_000);
  }
});
