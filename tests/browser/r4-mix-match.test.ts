/**
 * Match target on the real session and audio engine, with real clicks (MIX-01, MIX-17):
 * - After 20 s of the Clean master, choosing Loud restarts the loudness readings; meanwhile the
 *   status says "Measuring the new setting…" from the short-term reading, and Match then moves
 *   Loudness drive DOWN toward −14 LUFS (the stale integrated reading would have pushed it up).
 * - While the music plays, Match goes on correcting after each fresh 3-second reading
 *   ("Matching… 2/3") until it is within 0.5 dB or has made 3 passes.
 * - Stop, or a change made by hand, ends it.
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
import { matchState, resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { getStarter } from '../../src/content/starters';
import { MASTERING_PARAMS, readParam } from '../../src/project/params';
import { setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click } from './r4-uikit-input';

const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
const drive = () => readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');

function reading(): { m: number; s: number; i: number } {
  session.readMeters(frame);
  const l = frame.loudness!;
  return { m: l.momentary, s: l.shortTerm, i: l.integrated };
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (test()) return true;
    await act(async () => wait(100));
  }
  return test();
}

let root: HTMLElement;
const status = () => root.querySelector<HTMLElement>('[data-testid="loudness-status"]')!.textContent ?? '';
const matchKey = () => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Match target|^Matching…/.test(b.querySelector('[data-shown]')?.textContent ?? ''))!;
const matchWords = () => matchKey().querySelector('[data-shown]')!.textContent ?? '';
const chip = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('[data-section="presets"] button')].find((b) => b.textContent === name)!;
const result = () => root.querySelector<HTMLElement>('[data-testid="match-result"]')!.textContent ?? '';

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
});

afterAll(() => {
  act(() => session.stop());
  cleanup();
  session.dispose();
  patchRuntime({ playing: false });
  setLoudnessTarget('streaming');
});

describe('Match target on the real engine', () => {
  it('Clean for 20 s, then Loud, then Match: the readings start again and Loudness drive moves down toward −14 LUFS', async () => {
    await click(centre(chip('Clean')));
    expect(session.store.getState().mastering.presetId).toBe('clean');
    await act(async () => wait(20_000));
    const clean = reading();
    console.info(`[match] Clean 20 s: M ${clean.m.toFixed(1)} S ${clean.s.toFixed(1)} I ${clean.i.toFixed(1)} | ${status()}`);
    expect(clean.i).toBeLessThan(-15);
    expect(status()).toMatch(/^Integrated: .* quieter than the Streaming target/);

    const reset = vi.spyOn(session, 'resetLoudness');
    await click(centre(chip('Loud')));
    const before = drive();
    // At once: the readings are of the old setting, and the panel says so.
    await act(async () => wait(400));
    expect(status()).toMatch(/^Measuring the new setting…/);
    expect(await until(() => reset.mock.calls.length > 0, 2000)).toBe(true);
    await act(async () => wait(5000));
    const loud = reading();
    console.info(`[match] Loud +5 s: M ${loud.m.toFixed(1)} S ${loud.s.toFixed(1)} I ${loud.i.toFixed(1)} | ${status()} | drive ${before} dB`);
    // The integrated reading started again at the new setting: no 20 s of Clean in it.
    expect(Math.abs(loud.i - loud.s)).toBeLessThan(1.5);
    expect(loud.s).toBeGreaterThan(-14);
    expect(status()).toMatch(/louder than the Streaming target|on the Streaming target/);

    await click(centre(matchKey()));
    const after = drive();
    console.info(`[match] Match → Loudness drive ${before} → ${after} dB | ${runtimeStore.getState().notice?.text}`);
    expect(after).toBeLessThan(before);
    // It goes on while the music plays, then lands near the target.
    expect(await until(() => matchState().matching === null, 15_000)).toBe(true);
    await act(async () => wait(3500));
    const end = reading();
    console.info(`[match] after matching: S ${end.s.toFixed(1)} I ${end.i.toFixed(1)} | drive ${drive()} | ${result()} | ${status()}`);
    expect(Math.abs(end.s - -14)).toBeLessThan(Math.abs(loud.s - -14));
    expect(Math.abs(end.s - -14)).toBeLessThan(1.2);
  }, 90_000);

  it('while the music plays it corrects again after each fresh reading ("Matching… 2/3"); Stop ends it', async () => {
    setLoudnessTarget('loud');
    await act(async () => wait(3500));
    expect(drive()).toBeGreaterThan(0);
    await click(centre(matchKey()));
    expect(matchState().matching).not.toBeNull();
    expect(matchWords()).toBe('Matching… 1/3');
    expect(matchKey().getAttribute('aria-disabled')).toBe('true');
    // A second pass after a fresh 3-second reading (the limiter swallows part of each push).
    expect(await until(() => (matchState().matching?.applied ?? 0) >= 2 || matchState().matching === null, 12_000)).toBe(true);
    const words = matchWords();
    console.info(`[match] ${words} | ${status()} | drive ${drive()} | ${result()}`);
    if (matchState().matching) {
      expect(words).toBe('Matching… 2/3');
      act(() => session.stop());
      await act(async () => wait(200));
      expect(matchState().matching).toBeNull();
      expect(result()).toBe('Matching stopped: the music stopped.');
      expect(matchWords()).toBe('Match target');
    } else {
      // Landed already: within the tolerance, it says so.
      expect(result()).toMatch(/^On the Loud target|after 3 passes/);
    }
  }, 60_000);

  it('a change made by hand while it matches ends it', async () => {
    if (!runtimeStore.getState().playing) {
      await act(async () => {
        await session.play();
      });
    }
    // A fresh preset, then three seconds of it, then Match toward the Loud target.
    await click(centre(chip('Warm')));
    await act(async () => wait(3800));
    await click(centre(matchKey()));
    expect(matchState().matching).not.toBeNull();
    await click(centre(chip('Bright')));
    expect(matchState().matching).toBeNull();
    expect(result()).toBe('Matching stopped: a setting changed.');
    expect(status()).toMatch(/^Measuring the new setting…/);
  }, 60_000);
});
