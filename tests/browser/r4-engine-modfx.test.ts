/**
 * Modulation effects keep a part's level (shape: switching an insert in is
 * about colour, not volume). Chorus, Phaser and Flanger at their defaults on
 * the House bass, drums, pad and chords: the energy with the effect on
 * stays within 1 dB of the effect bypassed. The Flanger's swept copy adds
 * in phase with bass (where an equal-power blend alone was +3.5 dB) and
 * out of phase with brighter sound, so it level-matches its blend
 * (FLANGER_MATCH_TAU); Chorus and Phaser blend equal-power.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { HOUSE } from '../../src/content/starters/house';
import { conn, createModule, moduleId } from '../../src/project/factory';
import type { ModuleType, Project } from '../../src/project/types';
import { renderOffline } from '../../src/render/offline';

const SR = 48000;
const BARS = 4;

async function render(track: string, row: number, insert: { type: ModuleType; bypass: boolean }): Promise<Float32Array[]> {
  const project: Project = HOUSE.build();
  for (const t of project.tracks) t.solo = t.id === track;
  const id = `${track}:fx-${insert.type}`;
  const f = moduleId.filter(track);
  const ch = moduleId.channel(track);
  project.patch.modules.push({ ...createModule(id, insert.type, track), bypass: insert.bypass });
  project.patch.connections = project.patch.connections.filter((c) => !(c.from.module === f && c.to.module === ch));
  project.patch.connections.push(conn(f, 'out', id, 'in'), conn(id, 'out', ch, 'in'));
  const bank = new SampleBank(SR);
  const buf = await renderOffline({
    project,
    source: { kind: 'scene', row, bars: BARS },
    sampleRate: SR,
    tailSeconds: 0.1,
    createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: project.seed, meters: false }),
  });
  return [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()];
}

/** Stereo energy (dB) from bar 1 on (the first bar lets the effects' movement and the match settle). */
function energyDb(chs: Float32Array[]): number {
  const from = Math.round((SR * 60 * 4) / HOUSE.build().bpm);
  let s = 0;
  let n = 0;
  for (const c of chs) {
    for (let i = from; i < c.length; i++) s += c[i] * c[i];
    n += c.length - from;
  }
  return 10 * Math.log10(s / n);
}

describe('modulation effects keep the part’s level', () => {
  it('Chorus, Phaser and Flanger on bass, drums, pad and chords: within 1 dB of bypassed', async () => {
    const lines: string[] = [];
    const worst: number[] = [];
    for (const [track, row, name] of [
      ['t3', 1, 'Bass'],
      ['t1', 1, 'Drums'],
      ['t6', 2, 'Pad'],
      ['t4', 1, 'Chords'],
    ] as const) {
      // Bypassed, the insert passes the part unchanged: one reference per part.
      const off = energyDb(await render(track, row, { type: 'flanger', bypass: true }));
      const row_: string[] = [];
      for (const type of ['chorus', 'phaser', 'flanger'] as const) {
        const d = energyDb(await render(track, row, { type, bypass: false })) - off;
        row_.push(`${type} ${d >= 0 ? '+' : ''}${d.toFixed(2)}`);
        worst.push(Math.abs(d));
        expect(Math.abs(d), `${name} + ${type}`).toBeLessThan(1);
      }
      lines.push(`${name}: ${row_.join(', ')} dB`);
    }
    console.info(`[modfx] energy on vs bypassed — ${lines.join(' | ')}; worst ${Math.max(...worst).toFixed(2)} dB`);
  }, 240_000);
});
