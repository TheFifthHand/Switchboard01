/**
 * Every curated starter renders every scene through the real engine: finite,
 * audible, below the output ceiling, and at a comfortable, consistent level.
 *
 * The starters' sounds are part of the product: adding sounds, synth
 * features or drum kits must never change them. Each scene's level is
 * compared with the table measured for the shipped release (TEST_REPORT.md,
 * "Starter levels"): RMS of the steady part and sample peak, both within
 * ±0.3 dB.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { OUTPUT_CEILING } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { STARTERS } from '../../src/content/starters';
import { renderOffline } from '../../src/render/offline';
import { isAllFinite, peak, rms } from '../../src/render/analysis';

const SR = 44100;
/** Allowed drift from the shipped levels (dB). */
const TOLERANCE_DB = 0.3;

/**
 * TEST_REPORT.md "Starter levels": [RMS dBFS, peak dBFS] per scene, as shipped.
 * Techno, Breakbeat and Downtempo were re-measured in round 4: their parts
 * use the Drive (Techno's acid bass preset, Breakbeat's and Downtempo's
 * drive macros), and the Drive is now level-compensated in practice (an RMS
 * trim per character plus a slow level match) instead of lifting quiet
 * parts by a few dB. Downtempo's Intro peak was measured again after the
 * level match became block-wise (its sparse driven drum hits peak 0.6 dB
 * lower; RMS unchanged).
 */
const SHIPPED: Record<string, readonly (readonly [number, number])[]> = {
  house: [[-30.7, -13.3], [-19.3, -5.7], [-18.0, -1.3], [-25.2, -9.5]],
  synthwave: [[-30.3, -14.3], [-20.6, -5.5], [-19.3, -3.7], [-23.0, -9.1]],
  ambient: [[-26.9, -8.4], [-21.6, -6.2], [-20.2, -4.0], [-22.6, -6.9]],
  techno: [[-30.1, -5.9], [-18.7, -3.5], [-17.2, -2.3], [-20.3, -6.0]],
  breakbeat: [[-28.2, -8.4], [-20.5, -4.3], [-18.4, -2.5], [-23.3, -9.3]],
  drumAndBass: [[-28.8, -10.7], [-20.0, -4.3], [-18.5, -3.3], [-22.6, -9.2]],
  downtempo: [[-32.0, -15.3], [-21.9, -5.1], [-20.7, -4.5], [-23.6, -10.0]],
  garage: [[-30.3, -11.4], [-20.5, -1.6], [-18.5, -1.0], [-24.3, -6.0]],
};

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
  const pk = Math.max(peak(L), peak(R));
  return {
    finite: isAllFinite(L) && isAllFinite(R),
    peak: pk,
    peakDb: 20 * Math.log10(Math.max(1e-9, pk)),
    rmsDb: 20 * Math.log10(Math.max(1e-9, rms(mono))),
    nearCeiling: near / buf.length,
  };
}

describe('curated starters through the real engine', () => {
  for (const starter of STARTERS) {
    it(`${starter.name}: every scene is audible, finite, below the ceiling and sounds as shipped`, async () => {
      const project = starter.build();
      const shipped = SHIPPED[starter.id];
      expect(shipped, `no shipped levels for ${starter.id}`).toBeDefined();
      const rows: string[] = [];
      const drift: string[] = [];
      for (let row = 0; row < 4; row++) {
        const r = await renderRow(project, row, 4);
        const [rmsRef, peakRef] = shipped[row];
        rows.push(
          `${project.scenes[row].name}: ${r.rmsDb.toFixed(2)} dBFS rms (shipped ${rmsRef.toFixed(1)}), peak ${r.peakDb.toFixed(2)} dBFS (shipped ${peakRef.toFixed(1)}), near-ceiling ${(r.nearCeiling * 100).toFixed(2)}%`,
        );
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
        // The table is rounded to 0.1 dB: allow that rounding on top of the tolerance.
        if (Math.abs(r.rmsDb - rmsRef) > TOLERANCE_DB + 0.05) drift.push(`${project.scenes[row].name} rms ${(r.rmsDb - rmsRef).toFixed(2)} dB`);
        if (Math.abs(r.peakDb - peakRef) > TOLERANCE_DB + 0.05) drift.push(`${project.scenes[row].name} peak ${(r.peakDb - peakRef).toFixed(2)} dB`);
      }
      console.info(`[starters] ${starter.name}\n  ${rows.join('\n  ')}`);
      expect(drift, rows.join('\n')).toEqual([]);
    }, 120_000);
  }
});
