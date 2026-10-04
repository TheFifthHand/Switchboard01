/**
 * Match target only acts on readings of the music it is matching, on the real session and audio
 * engine (MIX-01, MIX-17; review fix round M1, M2):
 * - A change made before Mix was first opened counts: play 15 s, turn the transport's Master up
 *   6 dB, wait 4 s, then open Mix and press Match: the readings are of the louder output, so
 *   Loudness drive does not go up (the stale 19-second average would have pushed it up).
 * - Mute All, Solo and a part fader moved while it matches each stop it, with words, and Loudness
 *   drive stays where it was afterwards (the quieter output would otherwise have driven it up).
 */
import { act, createElement as h } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import type { MeterFrame } from '../../src/audio/contracts';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { MixView } from '../../src/app/views/mix/MixView';
import { STOPPED_CHANGE, STOPPED_MUTE_ALL, matchState, resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { getStarter } from '../../src/content/starters';
import { MASTERING_PARAMS, readParam } from '../../src/project/params';
import * as cmd from '../../src/state/commands';
import { setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click, send } from './r4-uikit-input';

const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
const drive = () => readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');

function reading(): { s: number; i: number } {
  session.readMeters(frame);
  const l = frame.loudness!;
  return { s: l.shortTerm, i: l.integrated };
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (test()) return true;
    await act(async () => wait(100));
  }
  return test();
}

let root: HTMLElement | null = null;
const matchKey = () => [...root!.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Match target|^Matching…/.test(b.querySelector('[data-shown]')?.textContent ?? ''))!;
const result = () => root!.querySelector<HTMLElement>('[data-testid="match-result"]')!.textContent ?? '';
const strip = (id: string) => root!.querySelector<HTMLElement>(`[data-testid="strip-${id}"]`)!;

function openMix() {
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width: 1366 });
  m.container.style.padding = '0';
  m.container.style.height = '666px';
  root = m.container;
}

/** Loudness drive back to 0 (a mastering change: the readings start again), then fresh readings. */
async function freshAtZero() {
  if (drive() !== 0) act(() => void session.accepted(cmd.setMasteringParam(session.store, 'loudness', 0)));
  await act(async () => wait(3800));
  expect(matchState().measuring).toBe(false);
}

/** Match toward Loud: the first pass is made at once and Match goes on (Matching… 1/3). */
async function startMatching(): Promise<number> {
  await click(centre(matchKey()));
  expect(matchState().matching).toEqual({ applied: 1 });
  return drive();
}

/** Stopped: drive stays where the stop found it while the music plays on. */
async function staysStopped(at: number, message: string) {
  expect(matchState().matching).toBeNull();
  expect(result()).toBe(message);
  await act(async () => wait(4500));
  expect(matchState().matching).toBeNull();
  expect(drive()).toBe(at);
}

beforeAll(async () => {
  await page.viewport(1366, 768);
  setLoudnessTarget('streaming');
  act(() => {
    session.store.replace(getStarter('house')!.build(), { resetHistory: true });
    setUiMode('simple');
    setView('play');
  });
  act(() => void session.accepted(cmd.applyMasteringPreset(session.store, 'clean')));
  resetLoudnessWatch();
  await act(async () => {
    await session.play();
  });
  expect(runtimeStore.getState().audio).toBe('running');
});

afterAll(() => {
  act(() => session.stop());
  cleanup();
  session.dispose();
  patchRuntime({ playing: false, muteAll: false });
  setLoudnessTarget('streaming');
  resetLoudnessWatch();
});

describe('Match acts only on readings of the music it matches', () => {
  it('a change made before Mix was first opened: the readings are of it, and Match does not push the wrong way', async () => {
    await act(async () => wait(15_000));
    const clean = reading();
    // The transport's Master knob, 6 dB up, while another view is open.
    act(() => session.setMasterVolume(6));
    await act(async () => wait(4000));
    const after = reading();
    console.info(`[guard] Clean 15 s: S ${clean.s.toFixed(1)} I ${clean.i.toFixed(1)} | Master +6, 4 s: S ${after.s.toFixed(1)} I ${after.i.toFixed(1)}`);
    // The integrated reading started again with the change: it is of the louder output only.
    expect(Math.abs(after.i - after.s)).toBeLessThan(1.5);
    expect(after.i).toBeGreaterThan(clean.i + 3);
    act(() => setView('mix'));
    openMix();
    expect(await until(() => !!matchKey() && matchKey().getAttribute('aria-disabled') === null, 4000)).toBe(true);
    const before = drive();
    await click(centre(matchKey()));
    await act(async () => wait(300));
    console.info(`[guard] Match: drive ${before} → ${drive()} | ${result()}`);
    // Louder than −14 with the drive at 0 dB already: nothing to raise.
    expect(drive()).toBeLessThanOrEqual(before);
    expect(result()).toMatch(/^Louder than the Streaming target already/);
    act(() => session.setMasterVolume(0));
  }, 60_000);

  it('Mute All while it matches stops it, and drive stays put', async () => {
    setLoudnessTarget('loud');
    await freshAtZero();
    const at = await startMatching();
    act(() => session.toggleMuteAll());
    expect(runtimeStore.getState().muteAll).toBe(true);
    await staysStopped(at, STOPPED_MUTE_ALL);
    act(() => session.toggleMuteAll());
  }, 30_000);

  it('Solo on a part while it matches stops it, and drive stays put', async () => {
    await freshAtZero();
    const at = await startMatching();
    await click(centre(strip('t1').querySelector<HTMLElement>('button[aria-label^="Solo"]')!));
    expect(session.store.getState().tracks.find((t) => t.id === 't1')!.solo).toBe(true);
    await staysStopped(at, STOPPED_CHANGE);
    act(() => strip('t1').querySelector<HTMLElement>('button[aria-label^="Solo"]')!.click());
    expect(session.store.getState().tracks.find((t) => t.id === 't1')!.solo).toBe(false);
  }, 30_000);

  it('a part fader moved while it matches stops it, and drive stays put', async () => {
    await freshAtZero();
    const at = await startMatching();
    const fader = strip('t1').querySelector<HTMLElement>('[role="slider"][aria-orientation="vertical"]')!;
    const level = () => session.store.getState().patch.modules.find((m) => m.id === 't1:ch')!.params.level ?? 0;
    const was = level();
    fader.focus();
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
    await act(async () => wait(50));
    expect(level()).toBeLessThan(was);
    await staysStopped(at, STOPPED_CHANGE);
  }, 30_000);
});
