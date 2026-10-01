/**
 * The Mix view on the real session and audio engine (Chromium, real Web
 * Audio): strip meters follow what each part really plays, Mute and the
 * fader silence a part in the actual output, Mute All silences the master,
 * and the loudness readouts / spectrum show real measurements when the engine
 * provides them (and say so honestly when it does not).
 */
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import type { MeterFrame } from '../../src/audio/contracts';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { MixView } from '../../src/app/views/mix/MixView';
import { getStarter } from '../../src/content/starters';
import * as cmd from '../../src/state/commands';
import { setUiMode } from '../../src/state/uiStore';
import { cleanup, fire, key, mount, pointIn, pointer, wait } from './ui-harness';

const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };

/** Loudest reading of a part (or the master) over `ms` of real output. */
async function peakOver(ms: number, trackId?: string): Promise<number> {
  let peak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    session.readMeters(frame);
    const v = trackId ? (frame.tracks.find((t) => t.trackId === trackId)?.peak ?? 0) : Math.max(frame.masterPeakL, frame.masterPeakR);
    peak = Math.max(peak, v);
    await act(async () => wait(25));
  }
  return peak;
}

function strip(root: Element, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-testid="strip-${id}"]`)!;
}

const click = (el: Element) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

let root: HTMLElement;

beforeAll(async () => {
  await page.viewport(1366, 768);
  act(() => {
    session.store.replace(getStarter('house')!.build());
    setUiMode('advanced');
  });
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width: 1366 });
  m.container.style.padding = '0';
  m.container.style.height = '610px';
  root = m.container;
  await act(async () => {
    await session.play();
  });
  expect(runtimeStore.getState().audio).toBe('running');
  // Let the groove get going.
  await act(async () => wait(1200));
});

afterEach(() => {
  act(() => {
    if (runtimeStore.getState().muteAll) session.setMuteAll(false);
  });
});

afterAll(() => {
  act(() => session.stop());
  cleanup();
  session.dispose();
  patchRuntime({ playing: false, muteAll: false });
});

describe('Mix view on the real engine', () => {
  it('the drum strip meter reads real signal while the groove plays', async () => {
    expect(await peakOver(600, 't1')).toBeGreaterThan(0.01);
    await act(async () => wait(300));
    const meter = strip(root, 't1').querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuetext')).not.toBe('Silent');
  });

  it('Mute on the strip silences that part in the actual output, and unmuting brings it back', async () => {
    const name = session.store.getState().tracks[0].name;
    click(strip(root, 't1').querySelector(`button[aria-label="Mute ${name}"]`)!);
    expect(session.store.getState().tracks[0].mute).toBe(true);
    await act(async () => wait(80));
    expect(await peakOver(500, 't1')).toBeLessThan(1e-3);
    click(strip(root, 't1').querySelector(`button[aria-label="Mute ${name}"]`)!);
    expect(await peakOver(800, 't1')).toBeGreaterThan(0.01);
  });

  it('the fader at the bottom silences the part; double-click brings it back to 0 dB', async () => {
    const name = session.store.getState().tracks[0].name;
    const fader = strip(root, 't1').querySelector<HTMLElement>(`[role="slider"][aria-label="${name} level"]`)!;
    fader.focus();
    key(fader, 'keydown', { key: 'Home' });
    expect(fader.getAttribute('aria-valuetext')).toMatch(/^Silent/);
    await act(async () => wait(120));
    expect(await peakOver(500, 't1')).toBeLessThan(1e-3);
    fire(fader, new MouseEvent('dblclick', { bubbles: true }));
    expect(session.store.getState().patch.modules.find((m) => m.id === 't1:ch')!.params.level).toBe(0);
    expect(await peakOver(800, 't1')).toBeGreaterThan(0.01);
  });

  it('Mute All on the master strip silences the output', async () => {
    click(strip(root, 'master').querySelector('button[aria-label="Mute All"]')!);
    expect(runtimeStore.getState().muteAll).toBe(true);
    await act(async () => wait(60));
    expect(await peakOver(400)).toBeLessThan(1e-3);
    click(strip(root, 'master').querySelector('button[aria-label="Mute All"]')!);
    expect(runtimeStore.getState().muteAll).toBe(false);
  });

  it('loudness readouts and the spectrum show real measurements, or say they are not available', async () => {
    await act(async () => wait(3200));
    session.readMeters(frame);
    const loudness = root.querySelector<HTMLElement>('[data-testid="loudness-shortTerm"]')!;
    const status = root.querySelector<HTMLElement>('[data-testid="loudness-status"]')!.textContent ?? '';
    if (frame.loudness) {
      expect(Number.isFinite(frame.loudness.shortTerm)).toBe(true);
      expect(loudness.textContent).toMatch(/^[−+]?\d+\.\d$/);
      expect(status).toMatch(/than the Streaming target|on the Streaming target/);
    } else {
      expect(loudness.textContent).toBe('—');
      expect(status).toBe('Loudness metering is not available.');
    }
    const overlay = root.querySelector<HTMLElement>('[data-testid="spectrum-overlay"]')!;
    const bands = new Float32Array(32);
    if (session.readSpectrum(bands)) {
      expect(overlay.dataset.state).toBe('live');
      expect(Math.max(...bands)).toBeGreaterThan(-100);
    } else {
      expect(overlay.dataset.state).toBe('unavailable');
    }
  });

  it('A/B on the real engine: while held, the output is heard without mastering; the project never changes', async () => {
    // A clearly audible mastering setting: +9 dB of Loudness into the limiter.
    act(() => void session.accepted(cmd.setMasteringParam(session.store, 'loudness', 9)));
    const rmsOver = async (ms: number) => {
      let sum = 0;
      let n = 0;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        session.readMeters(frame);
        sum += frame.masterRms;
        n++;
        await act(async () => wait(25));
      }
      return sum / Math.max(1, n);
    };
    await act(async () => wait(300));
    const mastered = await rmsOver(800);
    const before = session.store.getState();
    const b = root.querySelector<HTMLButtonElement>('button[aria-label="Compare A/B (hear without mastering)"]')!;
    pointer(b, 'pointerdown', pointIn(b));
    await act(async () => wait(300));
    const without = await rmsOver(800);
    pointer(b, 'pointerup', pointIn(b));
    expect(session.store.getState()).toBe(before);
    expect(session.store.getState().mastering.enabled).toBe(true);
    // At least 4 dB quieter without the Loudness push.
    expect(20 * Math.log10(mastered / without)).toBeGreaterThan(4);
    await act(async () => wait(300));
    const back = await rmsOver(800);
    expect(20 * Math.log10(back / without)).toBeGreaterThan(4);
  });
});
