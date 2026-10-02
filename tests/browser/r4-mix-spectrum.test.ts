/**
 * The Mix view's main-thread cost (MIX-19, perf-03, perf-04, perf-10), in real Chromium:
 * - Stopped and decayed, the Mix view runs no animation frames at all (meters, readouts and the
 *   spectrum share the meters' sleeping loop), on the real engine.
 * - While playing, the spectrum reads and draws at most 30 times a second, draws only when the
 *   picture changed, and does nothing while it is scrolled out of view.
 * - Its canvas is at most 1.5 device pixels per CSS pixel.
 * - Every meter and readout in Mix shares one engine read per animation frame
 *   (session.readMetersShared).
 */
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import type { MeterFrame } from '../../src/audio/contracts';
import { TipsProvider } from '../../src/ui/components';
import { metersAwake } from '../../src/ui/components/meterScheduler';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { MixView } from '../../src/app/views/mix/MixView';
import { resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { resetMixFrame } from '../../src/app/views/mix/mixMeters';
import { getStarter } from '../../src/content/starters';
import { createProject } from '../../src/project/factory';
import { setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';

const project = () => session.store.getState();

/** Count requestAnimationFrame calls made while `ms` pass. */
async function rafCallsOver(ms: number): Promise<number> {
  const real = window.requestAnimationFrame;
  let n = 0;
  window.requestAnimationFrame = (cb) => {
    n++;
    return real.call(window, cb);
  };
  try {
    await new Promise((r) => setTimeout(r, ms));
  } finally {
    window.requestAnimationFrame = real;
  }
  return n;
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return test();
}

function mountMix(width = 1366, height: number | 'auto' = 610) {
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width });
  m.container.style.padding = '0';
  m.container.style.height = height === 'auto' ? 'auto' : `${height}px`;
  return m;
}

/** Fake output: a live spectrum and meters that say something is playing. */
function fakeOutput() {
  const out: MeterFrame = { masterPeakL: 0.4, masterPeakR: 0.4, masterRms: 0.1, limiterReductionDb: 0, tracks: [] };
  vi.spyOn(session, 'readMetersShared').mockImplementation(() => {
    out.tracks = project().tracks.map((t) => ({ trackId: t.id, peak: 0.2, rms: 0.05 }));
    return out;
  });
  return vi.spyOn(session, 'readSpectrum').mockImplementation((bands) => {
    for (let i = 0; i < bands.length; i++) bands[i] = -30 - i * 0.3;
    return true;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => {
    patchRuntime({ playing: false });
    setUiMode('simple');
  });
  resetMixFrame();
  resetLoudnessWatch();
  window.scrollTo(0, 0);
});

describe('the spectrum’s pace', () => {
  it('reads and draws at most 30 times a second, and draws only when the picture changed', async () => {
    await page.viewport(1366, 768);
    act(() => {
      session.store.replace(createProject({ name: 'Spectrum', now: 1 }));
      setView('mix');
      patchRuntime({ playing: true });
    });
    const reads = fakeOutput();
    const m = mountMix();
    await act(async () => wait(1200));
    const canvas = m.container.querySelector<HTMLCanvasElement>('[data-section="spectrum"] canvas')!;
    const ctx = canvas.getContext('2d')!;
    const clear = vi.spyOn(ctx, 'clearRect');
    reads.mockClear();
    await act(async () => wait(1000));
    const perSecond = reads.mock.calls.length;
    console.info(`[spectrum] ${perSecond} reads in 1 s, ${clear.mock.calls.length} draws (a still picture)`);
    expect(perSecond).toBeGreaterThan(10);
    expect(perSecond).toBeLessThanOrEqual(32);
    // The same bands every frame: nothing to draw again.
    expect(clear).not.toHaveBeenCalled();
  });

  it('does nothing while scrolled out of view, and picks up again when it comes back', async () => {
    await page.viewport(960, 540);
    act(() => {
      session.store.replace(createProject({ name: 'Spectrum', now: 1 }));
      setView('mix');
      patchRuntime({ playing: true });
    });
    const reads = fakeOutput();
    const m = mountMix(960, 'auto');
    await act(async () => wait(300));
    window.scrollTo(0, 0);
    // At 200 % the mastering (with the spectrum) sits below the mixer, off screen.
    const plot = m.container.querySelector<HTMLElement>('[data-section="spectrum"] canvas')!;
    expect(plot.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
    await act(async () => wait(300));
    reads.mockClear();
    await act(async () => wait(800));
    expect(reads).not.toHaveBeenCalled();
    plot.scrollIntoView({ block: 'center' });
    // Back in view (the observer reports it at the next rendering step), it reads again.
    expect(await until(() => reads.mock.calls.length > 3, 3000), `reads ${reads.mock.calls.length}, awake ${metersAwake()}`).toBe(true);
  });

  it('keeps its canvas at 1.5 device pixels per CSS pixel at most', async () => {
    await page.viewport(1366, 768);
    const ratio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    try {
      act(() => {
        session.store.replace(createProject({ name: 'Spectrum', now: 1 }));
        setView('mix');
      });
      const m = mountMix();
      await act(async () => wait(300));
      const canvas = m.container.querySelector<HTMLCanvasElement>('[data-section="spectrum"] canvas')!;
      expect(canvas.clientWidth).toBeGreaterThan(100);
      expect(canvas.width).toBe(Math.round(canvas.clientWidth * 1.5));
    } finally {
      if (ratio) Object.defineProperty(window, 'devicePixelRatio', ratio);
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });
});

describe('on the real engine', () => {
  it('one engine read per frame for every meter on screen; once stopped and decayed, no animation frames at all', async () => {
    await page.viewport(1366, 768);
    act(() => {
      session.store.replace(getStarter('house')!.build());
      setUiMode('advanced');
      setView('mix');
    });
    resetLoudnessWatch();
    const m = mountMix();
    await act(async () => {
      await session.play();
    });
    expect(runtimeStore.getState().audio).toBe('running');
    await act(async () => wait(1500));
    // Eleven strip meters, two master meters, the loudness, Glue, limiter readouts and the spectrum: one engine read a frame.
    const reads = vi.spyOn(session, 'readMeters');
    const frames = await rafCallsOver(1000);
    const perSecond = reads.mock.calls.length;
    reads.mockRestore();
    console.info(`[meters] ${perSecond} engine reads during ${frames} animation frames`);
    expect(perSecond).toBeGreaterThan(5);
    expect(perSecond).toBeLessThanOrEqual(frames + 2);
    expect(m.container.querySelectorAll('[role="meter"]').length).toBeGreaterThanOrEqual(13);

    act(() => session.stop());
    // The meters fall and the spectrum fades; then the shared loop sleeps.
    expect(await until(() => !metersAwake(), 10_000)).toBe(true);
    const spectrum = vi.spyOn(session, 'readSpectrum');
    const calls = await rafCallsOver(1500);
    console.info(`[idle] ${calls} animation frames in 1.5 s once stopped and decayed`);
    expect(calls).toBe(0);
    expect(spectrum).not.toHaveBeenCalled();
    act(() => session.dispose());
  }, 60_000);
});
