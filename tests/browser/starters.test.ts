/**
 * Every curated starter renders every scene through the real engine: finite,
 * audible, below the output ceiling, and at a comfortable, consistent level.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { OUTPUT_CEILING } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { STARTERS } from '../../src/content/starters';
import { renderOffline } from '../../src/render/offline';
import { isAllFinite, peak, rms } from '../../src/render/analysis';

const SR = 44100;

async function renderRow(project: ReturnType<(typeof STARTERS)[number]['build']>, row: number, bars: number) {
  const bank = new SampleBank(SR);
  const buf = await renderOffline({ project, source: { kind: 'scene', row, bars }, sampleRate: SR, tailSeconds: 0.2, createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: project.seed, meters: false }) });
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  // Skip the first bar's attack transients for loudness; measure the steady groove.
  const from = Math.round(buf.length * 0.25);
  const mono = new Float32Array(buf.length - from);
  for (let i = from; i < buf.length; i++) mono[i - from] = 0.5 * (L[i] + R[i]);
  let near = 0;
  for (let i = 0; i < buf.length; i++) if (Math.abs(L[i]) > OUTPUT_CEILING * 0.97 || Math.abs(R[i]) > OUTPUT_CEILING * 0.97) near++;
  return { finite: isAllFinite(L) && isAllFinite(R), peak: Math.max(peak(L), peak(R)), rmsDb: 20 * Math.log10(Math.max(1e-9, rms(mono))), nearCeiling: near / buf.length };
}

describe('curated starters through the real engine', () => {
  for (const starter of STARTERS) {
    it(`${starter.name}: every scene is audible, finite and below the ceiling`, async () => {
      const project = starter.build();
      const rows: string[] = [];
      for (let row = 0; row < 4; row++) {
        const r = await renderRow(project, row, 4);
        rows.push(`${project.scenes[row].name}: ${r.rmsDb.toFixed(1)} dBFS rms, peak ${r.peak.toFixed(3)}, near-ceiling ${(r.nearCeiling * 100).toFixed(2)}%`);
        expect(r.finite, rows.join('\n')).toBe(true);
        expect(r.peak, rows.join('\n')).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-5);
        expect(r.rmsDb, rows.join('\n')).toBeGreaterThan(-40);
        // Comfortable: not slammed into the limiter.
        expect(r.nearCeiling, rows.join('\n')).toBeLessThan(0.01);
        if (row === 1) {
          // The core groove sits in a comfortable, consistent loudness window.
          expect(r.rmsDb, rows.join('\n')).toBeGreaterThan(-26);
          expect(r.rmsDb, rows.join('\n')).toBeLessThan(-10);
        }
      }
    }, 120_000);
  }
});
