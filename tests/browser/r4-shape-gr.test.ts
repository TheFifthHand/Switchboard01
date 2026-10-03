/**
 * shape-11: the Compressor card's Squeeze, and gain-reduction meters.
 *
 * - The Simple Compressor card's knob is Squeeze: one amount that lowers
 *   Threshold and raises the ratio together, with Makeup to match, written in
 *   one gesture (one undo step). Rendered (Chords soloed): full Squeeze holds
 *   the part's loud moments down (its loudness spread shrinks) while its level
 *   stays about where it was.
 * - Compressor and Gate cards (Simple and the Advanced rack) show a
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
import { card, closeShape, keysOn, levelDb, mono, openShape, project, renderSolo, slider, SR, type Rendered } from './r4-shape-helpers';
import { settleFrames } from './r4-uikit-input';
import { crestFactor, peak } from '../../src/render/analysis';

/** How far the loud moments stand out: the 95th minus the 50th percentile of 20 ms RMS levels (dB), over the sounding windows. */
function spreadDb(x: Rendered): number {
  const m = mono(x);
  const w = Math.round(0.02 * SR);
  const levels: number[] = [];
  for (let i = Math.round(m.length / 8); i + w <= m.length; i += w) {
    let s = 0;
    for (let j = i; j < i + w; j++) s += m[j] * m[j];
    const db = 10 * Math.log10(s / w + 1e-20);
    if (db > -60) levels.push(db);
  }
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length * 0.95)] - levels[Math.floor(levels.length * 0.5)];
}

describe('Squeeze (Simple Compressor card)', () => {
  afterEach(closeShape);

  it('one knob writes Threshold, ratio and Makeup together, in one undo step', async () => {
    await openShape({ mode: 'simple', trackId: 't4' });
    act(() => void session.accepted(cmd.insertEffect(session.store, 't4', 'compressor')));
    await settleFrames();
    const knob = slider(card('t4:compressor'), 'Squeeze');
    expect(card('t4:compressor').textContent).toContain('Squeeze holds them down harder');
    await keysOn(knob, '{End}');
    const p = project().patch.modules.find((m) => m.id === 't4:compressor')!.params;
    expect(p).toMatchObject(squeezeParams(1));
    expect(p.threshold).toBe(-36);
    expect(p.ratio).toBe(7);
    expect(p.makeup).toBeGreaterThan(10);
    expect(p.attack).toBe(2);
    // An added Compressor sits at 50 %: its own defaults are on the curve.
    expect(squeezeParams(0.5)).toEqual({ threshold: -18, ratio: 4, makeup: 0, attack: 10 });
    await new Promise((r) => setTimeout(r, 900));
    act(() => session.undo());
    const q = project().patch.modules.find((m) => m.id === 't4:compressor')!.params;
    expect([q.threshold, q.ratio, q.makeup, q.attack]).toEqual([-18, 4, 0, 10]);
  });

  it('Drums, rendered: full Squeeze shrinks how far the loud moments stand out by 3 dB or more and keeps the level within 3 dB', async () => {
    await openShape({ mode: 'simple', trackId: 't1' });
    act(() => void session.accepted(cmd.insertEffect(session.store, 't1', 'compressor')));
    await settleFrames();
    const knob = slider(card('t1:compressor'), 'Squeeze');
    expect(knob.getAttribute('aria-valuetext')).toBe('50%');
    await keysOn(knob, '{Home}');
    const none = await renderSolo(structuredClone(project()), 't1', 4);
    await keysOn(knob, '{End}');
    const full = await renderSolo(structuredClone(project()), 't1', 4);
    const crest = (x: Rendered) => 20 * Math.log10(crestFactor(mono(x)));
    const pk = (x: Rendered) => 20 * Math.log10(peak(mono(x)));
    const line = `level ${levelDb(none).toFixed(1)} → ${levelDb(full).toFixed(1)} dB, spread ${spreadDb(none).toFixed(1)} → ${spreadDb(full).toFixed(1)} dB, crest ${crest(none).toFixed(1)} → ${crest(full).toFixed(1)} dB, peak ${pk(none).toFixed(1)} → ${pk(full).toFixed(1)} dBFS`;
    console.info(`[gr] Drums Squeeze 0 → 100 %: ${line}`);
    expect(spreadDb(none) - spreadDb(full), line).toBeGreaterThanOrEqual(3);
    expect(Math.abs(levelDb(full) - levelDb(none)), line).toBeLessThanOrEqual(3);
  }, 120_000);

  it('without an audio engine the gain-reduction bar says “—” (not measured), never a made-up number', async () => {
    await openShape({ mode: 'simple', trackId: 't4' });
    act(() => {
      session.accepted(cmd.insertEffect(session.store, 't4', 'compressor'));
      session.accepted(cmd.insertEffect(session.store, 't4', 'gate'));
    });
    await settleFrames(3);
    for (const id of ['t4:compressor', 't4:gate']) {
      const meter = card(id).querySelector<HTMLElement>('[role="meter"]')!;
      expect(meter.getAttribute('aria-label')).toMatch(/gain reduction$/);
      expect(meter.textContent).toContain('—');
    }
  });
});

describe('gain-reduction bars read the engine while the song plays', () => {
  afterEach(tearDown);

  it('Chords with a strong compressor and a high gate: both bars show real reduction (Simple and the Advanced rack)', async () => {
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
    const meter = (id: string) => card(id)?.querySelector<HTMLElement>('[role="meter"]') ?? null;
    await until(() => Number(meter('t4:compressor')?.getAttribute('aria-valuenow') ?? 0) > 1, 'compressor reduction', 15000);
    expect(meter('t4:compressor')!.textContent).toMatch(/−\d+\.\d dB/);
    expect(meter('t4:compressor')!.getAttribute('aria-valuetext')).toMatch(/^Turning down \d+\.\d dB$/);
    await until(() => Number(meter('t4:gate')?.getAttribute('aria-valuenow') ?? 0) > 1, 'gate reduction', 15000);
    // The Advanced rack's cards carry the same bar.
    act(() => setUiMode('advanced'));
    await settleFrames(3);
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes('Effects'));
    if (tab) act(() => tab.click());
    await settleFrames(3);
    const rack = () => document.getElementById('rack-card-t4:compressor')?.querySelector<HTMLElement>('[role="meter"]') ?? null;
    await until(() => Number(rack()?.getAttribute('aria-valuenow') ?? 0) > 1, 'rack compressor reduction', 15000);
  }, 90_000);
});
