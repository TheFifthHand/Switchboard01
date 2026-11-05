/**
 * shape-11: gain-reduction meters. (The Simple card's Squeeze knob went with
 * the Simple effect cards in r6, and its law and tests with it.)
 *
 * - Compressor and Gate cards in the Advanced rack show a
 *   gain-reduction bar read from the engine's shared meter frame
 *   (MeterFrame.moduleReductionDb): "—" without an engine, a real number
 *   while the song plays.
 * Real keys and clicks; the live part runs the real audio engine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { selectTrack, setUiMode, setView } from '../../src/state/uiStore';
import { openApp, setUp, tearDown, until } from './r4-play-helpers';
import { closeShape, inAdvanced, openShape, rackCard } from './r4-shape-helpers';
import { settleFrames } from './r4-uikit-input';

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
    // A strong compressor: −28 dB, 5:1, fast attack.
    const s = { threshold: -28, ratio: 5, makeup: 8, attack: 0.5 };
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
