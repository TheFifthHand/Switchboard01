/**
 * MIX-09: export without mastering, and a loudness report of what was
 * exported (integrated loudness, true peak, sample peak, length), measured
 * with render/loudness on the rendered audio. renderWav keeps its signature.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/app/session';
import { getStarter } from '../../src/content/starters';
import * as cmd from '../../src/state/commands';
import { measureLoudness, truePeak } from '../../src/render/loudness';
import { measureExport } from '../../src/render/offline';
import { parseWav } from '../../src/render/wav';
import { deleteDb } from '../../src/persistence/db';

const SR = 48000;
let live: Session[] = [];
beforeEach(async () => {
  await deleteDb();
});
afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  await deleteDb();
});

function house(): Session {
  const s = new Session(getStarter('house')!.build());
  live.push(s);
  return s;
}

const opts = { source: { kind: 'scene', row: 1, bars: 4 } as const, sampleRate: SR as 48000, bitDepth: 24 as const, tailSeconds: 1 };

describe('Export report (MIX-09)', () => {
  it('renderWavWithReport: the WAV plus integrated loudness, true peak, sample peak and length of the rendered audio', async () => {
    const s = house();
    const { blob, report } = await s.renderWavWithReport(opts);
    const wav = parseWav(await blob.arrayBuffer());
    const [L, R] = wav.channels;
    expect(report.seconds).toBeCloseTo(L.length / SR, 6);
    expect(report.seconds).toBeCloseTo(4 * (240 / s.store.getState().bpm) + 1, 3);
    // The same measurement on the file (24-bit, so within a hair of the float render).
    const m = measureLoudness(L, R, SR);
    console.info(`[report] ${report.integratedLufs.toFixed(2)} LUFS, true peak ${report.truePeakDb.toFixed(2)} dBTP, sample peak ${report.samplePeakDb.toFixed(2)} dBFS; file: ${m.integrated.toFixed(2)} / ${m.truePeakDb.toFixed(2)} / ${m.samplePeakDb.toFixed(2)}`);
    expect(Number.isFinite(report.integratedLufs)).toBe(true);
    expect(Math.abs(report.integratedLufs - m.integrated)).toBeLessThan(0.05);
    expect(Math.abs(report.truePeakDb - m.truePeakDb)).toBeLessThan(0.05);
    expect(Math.abs(report.samplePeakDb - m.samplePeakDb)).toBeLessThan(0.05);
    // The output ceiling: −1 dBTP (the limiter's true-peak detection, a small margin for its own estimator).
    expect(report.truePeakDb).toBeLessThanOrEqual(-0.95);
    expect(report.samplePeakDb).toBeLessThanOrEqual(report.truePeakDb + 1e-9);
    // renderWav still returns just the file, the same audio.
    const plain = parseWav(await (await s.renderWav(opts)).arrayBuffer());
    expect(plain.channels[0].length).toBe(L.length);
  });

  it('the pruned true-peak search finds exactly what a full search finds', async () => {
    // A 1-second burst with strong inter-sample peaks (a tone at a quarter of the rate, phase-shifted) plus noise.
    const n = SR;
    const buf = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: SR });
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < n; i++) {
      L[i] = 0.7 * Math.sin((2 * Math.PI * (SR / 4) * i) / SR + Math.PI / 4) + 0.05 * rnd();
      R[i] = 0.3 * rnd();
    }
    const r = await measureExport(buf, { sliceFrames: 5000 });
    const full = 20 * Math.log10(Math.max(truePeak(L), truePeak(R)));
    expect(r.truePeakDb).toBeCloseTo(full, 6);
    expect(r.truePeakDb).toBeGreaterThan(r.samplePeakDb + 1);
  });

  it('without mastering: the project’s mastering is off in the file, the limiter and its ceiling stay, the project is unchanged', async () => {
    const s = house();
    // A loud mastering setting: +9 dB of Loudness into the limiter.
    expect(s.accepted(cmd.setMasteringParam(s.store, 'loudness', 9))).toBe(true);
    const before = s.store.getState();
    const mastered = await s.renderWavWithReport(opts);
    const dry = await s.renderWavWithReport({ ...opts, mastering: false });
    console.info(`[report] mastered ${mastered.report.integratedLufs.toFixed(2)} LUFS, without mastering ${dry.report.integratedLufs.toFixed(2)} LUFS (true peak ${dry.report.truePeakDb.toFixed(2)} dBTP)`);
    expect(s.store.getState()).toBe(before);
    expect(mastered.report.integratedLufs - dry.report.integratedLufs).toBeGreaterThan(3);
    expect(dry.report.truePeakDb).toBeLessThanOrEqual(-0.95);
    expect(dry.report.seconds).toBeCloseTo(mastered.report.seconds, 9);
  });
});
