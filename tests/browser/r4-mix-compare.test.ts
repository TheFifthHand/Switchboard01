/**
 * Level-matched A/B (MIX-06) on the real session and audio engine, with real clicks: with the Loud
 * preset, hearing the mix without mastering is played at the mastered loudness (within 1 dB of
 * short-term loudness), the panel says by how much ("Level-matched (+6.1 dB)", from
 * MeterFrame.compareTrimDb), and the Compare key keeps its width, so its left edge never moves.
 * Ending the comparison restarts the loudness readings (they measured the comparison meanwhile).
 */
import { act, createElement as h } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import type { MeterFrame } from '../../src/audio/contracts';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { MixView } from '../../src/app/views/mix/MixView';
import { compareState } from '../../src/app/views/mix/compare';
import { resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { formatDb } from '../../src/app/views/mix/mixMeters';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { getStarter } from '../../src/content/starters';
import { setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click } from './r4-uikit-input';

const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };

/** Mean short-term loudness over `ms` (LUFS). */
async function shortTermOver(ms: number): Promise<number> {
  const xs: number[] = [];
  const end = performance.now() + ms;
  while (performance.now() < end) {
    session.readMeters(frame);
    const v = frame.loudness?.shortTerm;
    if (v !== undefined && Number.isFinite(v)) xs.push(v);
    await act(async () => wait(100));
  }
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

let root: HTMLElement;
const compareKey = () => root.querySelector<HTMLButtonElement>('button[aria-pressed][aria-label^="Compare A/B"], button[aria-pressed][aria-label^="Hearing: no mastering"]')!;
const chip = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('[data-section="presets"] button')].find((b) => b.textContent === name)!;

beforeAll(async () => {
  await page.viewport(1366, 768);
  setLoudnessTarget('streaming');
  act(() => {
    session.store.replace(getStarter('house')!.build());
    setUiMode('simple');
    setView('mix');
  });
  resetLoudnessWatch();
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width: 1366 });
  m.container.style.padding = '0';
  m.container.style.height = '610px';
  root = m.container;
  await act(async () => {
    await session.play();
  });
  expect(runtimeStore.getState().audio).toBe('running');
  await act(async () => wait(300));
});

afterAll(() => {
  act(() => session.stop());
  cleanup();
  session.dispose();
  patchRuntime({ playing: false });
});

describe('Compare A/B on the real engine', () => {
  it('is level-matched within 1 dB, says by how much, and the key does not move', async () => {
    await click(centre(chip('Loud')));
    expect(session.store.getState().mastering.presetId).toBe('loud');
    // Three seconds of the Loud master fill the short-term window (and the meter before the mastering).
    await act(async () => wait(4500));
    const mastered = await shortTermOver(1000);
    const key = compareKey();
    const off = key.getBoundingClientRect();
    expect(key.querySelector('[data-shown]')!.textContent).toBe('Compare A/B');

    const reset = vi.spyOn(session, 'resetLoudness');
    await click(centre(key));
    expect(compareState().mode).toBe('latched');
    expect(session.masteringListenBypass).toBe(true);
    const on = compareKey().getBoundingClientRect();
    expect(compareKey().querySelector('[data-shown]')!.textContent).toBe('Hearing: no mastering');
    // The key keeps its width (the longer words'), so its left edge stays put.
    expect(Math.abs(on.left - off.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(on.width - off.width)).toBeLessThanOrEqual(0.5);

    await act(async () => wait(3500));
    const compared = await shortTermOver(1000);
    session.readMeters(frame);
    const trim = frame.compareTrimDb ?? 0;
    console.info(`[compare] mastered ${mastered.toFixed(2)} LUFS, compared ${compared.toFixed(2)} LUFS, trim ${trim.toFixed(1)} dB`);
    expect(Math.abs(trim)).toBeGreaterThan(2);
    expect(Math.abs(compared - mastered)).toBeLessThanOrEqual(1);
    // The panel says it is level-matched, and by how much.
    expect(root.querySelector('[data-testid="level-match"]')!.textContent).toBe(`Level-matched (${formatDb(trim)})`);

    // Back to the master: the readings measured the comparison, so they start again.
    await click(centre(compareKey()));
    expect(compareState().mode).toBe('off');
    expect(session.masteringListenBypass).toBe(false);
    expect(reset).toHaveBeenCalled();
    await act(async () => wait(400));
    expect(root.querySelector('[data-testid="loudness-status"]')!.textContent).toMatch(/^Measuring the new setting…/);
    expect(root.querySelector('[data-testid="level-match"]')!.textContent).toBe('');
    // The project never changed.
    expect(session.store.getState().mastering.presetId).toBe('loud');
  }, 60_000);
});
