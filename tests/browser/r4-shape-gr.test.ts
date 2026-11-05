/**
 * shape-11: the Squeeze law, and gain-reduction meters.
 *
 * - Squeeze (squeeze.ts) lowers Threshold and raises the ratio together, with
 *   Makeup to match: on every starter part full Squeeze stays clear of the
 *   output ceiling (the compressor has no look-ahead, so its makeup is
 *   capped). Simple no longer shows effect cards (r6), so its knob is gone.
 * - Compressor and Gate cards in the Advanced rack show a
 *   gain-reduction bar read from the engine's shared meter frame
 *   (MeterFrame.moduleReductionDb): "—" without an engine, a real number
 *   while the song plays.
 * Real keys and clicks; the live part runs the real audio engine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { session } from '../../src/app/instance';
import { squeezeParams } from '../../src/app/views/shape/squeeze';
import * as cmd from '../../src/state/commands';
import { selectTrack, setUiMode, setView } from '../../src/state/uiStore';
import { openApp, setUp, tearDown, until } from './r4-play-helpers';
import { closeShape, inAdvanced, mono, openShape, rackCard, renderSolo } from './r4-shape-helpers';
import { settleFrames } from './r4-uikit-input';
import { peak } from '../../src/render/analysis';
import { STARTERS } from '../../src/content/starters';
import { ProjectStore } from '../../src/state/projectStore';

describe('gain-reduction bars without an engine', () => {
  afterEach(closeShape);

  it('without an audio engine the gain-reduction bar says “—” (not measured), never a made-up number', async () => {
    await openShape({ mode: 'simple', trackId: 't4' });
    act(() => {
      session.accepted(cmd.insertEffect(session.store, 't4', 'compressor'));
      session.accepted(cmd.insertEffect(session.store, 't4', 'gate'));
    });
    await settleFrames(3);
    await inAdvanced(async () => {
      for (const id of ['t4:compressor', 't4:gate']) {
        const meter = rackCard(id).querySelector<HTMLElement>('[role="meter"]')!;
        expect(meter.getAttribute('aria-label')).toMatch(/gain reduction$/);
        expect(meter.textContent).toContain('—');
      }
    });
  });
});

/** Peaks at or above this (dBFS) mean the output limiter (ceiling −1 dBFS) is at work. */
const CEILING_MARGIN_DBFS = -1.5;

describe('full Squeeze on every starter part stays clear of the output ceiling (offline render, part soloed)', () => {
  for (const starter of STARTERS) {
    it(starter.name, async () => {
      const p0 = starter.build();
      const lines: string[] = [];
      for (const t of p0.tracks) {
        const store = new ProjectStore(structuredClone(p0));
        const r = cmd.insertEffect(store, t.id, 'compressor');
        expect(r.moduleId, `${starter.name} ${t.name}: a compressor`).toBeTruthy();
        for (const [k, v] of Object.entries(squeezeParams(1))) cmd.setModuleParam(store, r.moduleId!, k, v);
        const x = await renderSolo(store.getState(), t.id);
        const peakDb = 20 * Math.log10(peak(mono(x)) + 1e-12);
        const peakLR = 20 * Math.log10(Math.max(peak(x.L), peak(x.R)) + 1e-12);
        lines.push(`${t.name} ${peakLR.toFixed(1)}`);
        expect(peakLR, `${starter.name} ${t.name}: peak ${peakLR.toFixed(1)} dBFS (mono ${peakDb.toFixed(1)})`).toBeLessThan(CEILING_MARGIN_DBFS);
      }
      console.info(`[gr] ${starter.name} full Squeeze peaks (dBFS): ${lines.join(', ')}`);
    }, 240_000);
  }
});

describe('gain-reduction bars read the engine while the song plays', () => {
  afterEach(tearDown);

  it('Chords with a strong compressor and a high gate: both bars in the Advanced rack show real reduction', async () => {
    await setUp();
    await openApp(1366, 768, { play: true });
    act(() => {
      selectTrack('t4');
      setView('shape');
      session.accepted(cmd.insertEffect(session.store, 't4', 'compressor'));
      session.accepted(cmd.insertEffect(session.store, 't4', 'gate'));
    });
    await settleFrames(3);
    const s = squeezeParams(1);
    act(() => {
      for (const [k, v] of Object.entries(s)) session.setModuleParam('t4:compressor', k, v);
      session.setModuleParam('t4:gate', 'threshold', -20);
    });
    act(() => setUiMode('advanced'));
    await settleFrames(3);
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes('Effects'));
    if (tab) act(() => tab.click());
    await settleFrames(3);
    const meter = (id: string) => rackCard(id)?.querySelector<HTMLElement>('[role="meter"]') ?? null;
    await until(() => Number(meter('t4:compressor')?.getAttribute('aria-valuenow') ?? 0) > 1, 'compressor reduction', 15000);
    expect(meter('t4:compressor')!.textContent).toMatch(/−\d+\.\d dB/);
    expect(meter('t4:compressor')!.getAttribute('aria-valuetext')).toMatch(/^Turning down \d+\.\d dB$/);
    await until(() => Number(meter('t4:gate')?.getAttribute('aria-valuenow') ?? 0) > 1, 'gate reduction', 15000);
    // The gate opened (its threshold at the bottom): its bar follows within a moment, not seconds.
    act(() => session.setModuleParam('t4:gate', 'threshold', -80));
    const opened = performance.now();
    await until(() => meter('t4:gate')!.textContent?.includes('Open') ?? false, 'gate bar back to Open', 5000);
    expect(performance.now() - opened, 'the gate bar falls back fast').toBeLessThan(1500);
  }, 90_000);
});
