/**
 * Mix view fixes, in real Chromium with the app's theme and fonts:
 * - The mastering panel is always usable: beside the mixer (from 1280 px, in
 *   Simple and Advanced) it fills the workspace height; below the mixer
 *   (narrower, 200 % zoom) it has its full height, with no small scroll box of
 *   its own, and the view scrolls to it; its header (name, A/B, switch) shows
 *   under the mixer on first view. Checked at 1280 × 720, 1280 × 800, 1339,
 *   1366, 1440, 1600, 1920, 1100 × 700 and 960 × 540 in Simple and Advanced.
 * - At 1366 × 768 in Simple, a Match keeps the spectrum on screen.
 * - True peak is amber at the limiter's −1 dBTP ceiling (normal) and red only
 *   above 0 dBTP, with one line saying so; the master meter's tooltip says
 *   what the line across it (the −1 dBFS ceiling) means.
 * - Reset (the loudness readings) and Compare A/B say what they are in words.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import type { MeterFrame } from '../../src/audio/contracts';
import { MixView } from '../../src/app/views/mix/MixView';
import { truePeakLevel } from '../../src/app/views/mix/MasteringPanel';
import { resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { resetMixFrame } from '../../src/app/views/mix/mixMeters';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { createProject } from '../../src/project/factory';
import { selectModule, selectTrack, setUiMode, setView, type UiMode } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, mount, wait } from './ui-harness';

const project = () => session.store.getState();
/** Transport (58 px) and the keyboard bar (collapsed in Mix, 44 px) take this much of the window height. */
const CHROME = 102;

async function fonts() {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 15px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
}

async function setup(mode: UiMode, w: number, hh: number) {
  await page.viewport(w, hh);
  act(() => {
    session.store.replace(createProject({ name: 'Mix fixes', now: 1 }));
    setUiMode(mode);
    setView('mix');
    selectTrack('t1');
    selectModule(null);
  });
  resetMixFrame();
  resetLoudnessWatch();
  const m = mount(h(TipsProvider, { enabled: true }, h(MixView)), { width: w });
  await actFrame();
  m.container.style.padding = '0';
  // Below 1024 px (200 % zoom) the page scrolls instead of the workspace.
  m.container.style.height = w < 1024 ? 'auto' : `${hh - CHROME}px`;
  await fonts();
  await act(async () => wait(350));
  await actFrame();
  const view = m.container.querySelector<HTMLElement>('[role="region"][aria-label="Mix view"]')!;
  return { m, view };
}

/** A frame for the session's shared meter read (what the Mix view reads). */
const frame = (): MeterFrame => ({ masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] });

function fakeMeters(truePeakDb = -0.5) {
  const out = frame();
  return vi.spyOn(session, 'readMetersShared').mockImplementation(() => {
    out.masterPeakL = 0.8;
    out.masterPeakR = 0.8;
    out.masterRms = 0.3;
    out.limiterReductionDb = 1;
    out.tracks = project().tracks.map((t) => ({ trackId: t.id, peak: 0.3, rms: 0.1 }));
    out.loudness = { momentary: -10.8, shortTerm: -11.1, integrated: -13.5, truePeakDb };
    return out;
  });
}

/** The Mastering panel (the section holding the Presets section). */
const masteringPanel = (view: HTMLElement) => view.querySelector<HTMLElement>('[data-section="presets"]')!.parentElement!.closest<HTMLElement>('section')!;
/** The panel's body (the element that would scroll). */
const masteringBody = (view: HTMLElement) => view.querySelector<HTMLElement>('[data-section="presets"]')!.parentElement!.parentElement!;
const mixerPanel = (view: HTMLElement) => view.querySelector<HTMLElement>('[data-testid="strip-t1"]')!.closest<HTMLElement>('section')!;
const byText = (root: ParentNode, text: string | RegExp) =>
  [...root.querySelectorAll<HTMLElement>('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')))!;
const click = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

beforeEach(() => {
  runtimeStore.setState((s) => ({ ...s, notice: null, recording: 'off', muteAll: false, playing: false }));
  setLoudnessTarget('streaming');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => {
    patchRuntime({ playing: false });
    setUiMode('simple');
  });
  resetMixFrame();
  resetLoudnessWatch();
});

describe('Mastering is usable at every size', () => {
  const sizes: [number, number][] = [
    [1280, 720],
    [1280, 800],
    [1339, 768],
    [1366, 768],
    [1440, 900],
    [1600, 900],
    [1920, 1080],
    [1100, 700],
    [960, 540],
  ];
  for (const mode of ['simple', 'advanced'] as const) {
    for (const [w, hh] of sizes) {
      const beside = w >= 1280;
      it(`${w}×${hh} ${mode}: mastering ${beside ? 'beside the mixer at full height' : 'below the mixer, full height, no inner scroll box'}`, async () => {
        const { view } = await setup(mode, w, hh);
        expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth + 1);
        const mixer = mixerPanel(view).getBoundingClientRect();
        const panel = masteringPanel(view);
        const body = masteringBody(view);
        const r = panel.getBoundingClientRect();
        expect(panel.querySelector('h2')!.textContent).toBe('Mastering');
        if (beside) {
          expect(r.left).toBeGreaterThanOrEqual(mixer.right);
          // As tall as the mixer: a real panel, not a strip.
          expect(Math.abs(r.height - mixer.height)).toBeLessThanOrEqual(2);
          expect(r.height).toBeGreaterThanOrEqual(440);
          // Presets and Match target are in sight without scrolling, and nothing in the header spills out.
          const vb = view.getBoundingClientRect();
          for (const el of [view.querySelector<HTMLElement>('[data-section="presets"] h3')!, byText(view, /^Match target/)]) {
            const e = el.getBoundingClientRect();
            expect(e.top, el.textContent ?? '').toBeGreaterThanOrEqual(Math.max(vb.top, r.top) - 1);
            expect(e.bottom, el.textContent ?? '').toBeLessThanOrEqual(Math.min(vb.bottom, r.bottom) + 1);
          }
          for (const el of panel.querySelectorAll<HTMLElement>('header button, header [role="switch"]')) expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(r.right + 1);
          // Every target and reading name whole (no "Momen…").
          for (const el of panel.querySelectorAll<HTMLElement>('[data-section="loudness"] [role="radio"], [data-section="loudness"] [data-key] > span:first-child')) {
            expect(el.scrollWidth, el.textContent ?? '').toBeLessThanOrEqual(el.clientWidth + 1);
          }
        } else {
          expect(r.top).toBeGreaterThanOrEqual(mixer.bottom);
          // Its whole content shows: the panel body does not scroll on its own.
          expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
          expect(body.clientHeight).toBeGreaterThanOrEqual(300);
          // Wide: Presets and Loudness on the left, the Spectrum on the right.
          const spectrum = view.querySelector<HTMLElement>('[data-section="spectrum"]')!.getBoundingClientRect();
          const loudness = view.querySelector<HTMLElement>('[data-section="loudness"]')!.getBoundingClientRect();
          expect(spectrum.left).toBeGreaterThanOrEqual(loudness.right);
          if (w >= 1024) {
            // The Mastering header (its name, A/B and switch) shows under the mixer on first view.
            const head = panel.querySelector('header')!.getBoundingClientRect();
            expect(view.scrollTop).toBe(0);
            expect(head.bottom).toBeLessThanOrEqual(view.getBoundingClientRect().top + view.clientHeight);
          }
          if (w >= 1024) {
            // The view scrolls to all of it.
            expect(view.scrollHeight).toBeGreaterThan(view.clientHeight);
            view.scrollTop = view.scrollHeight;
            await actFrame();
            expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(view.getBoundingClientRect().bottom + 1);
          }
        }
        // Every mastering control is big enough to hit; below the mixer, none is clipped.
        const box = panel.getBoundingClientRect();
        for (const el of panel.querySelectorAll<HTMLElement>('button, [role="slider"], [role="radio"], [role="switch"]')) {
          const e = el.getBoundingClientRect();
          if (!beside) {
            expect(e.top).toBeGreaterThanOrEqual(box.top - 1);
            expect(e.bottom).toBeLessThanOrEqual(box.bottom + 1);
          }
          if (el.matches('button, [role="radio"]')) {
            expect(e.height, el.textContent ?? '').toBeGreaterThanOrEqual(32);
            expect(e.width, el.textContent ?? '').toBeGreaterThanOrEqual(32);
          }
        }
        if (mode === 'advanced') expect(panel.querySelectorAll('[data-group]').length).toBeGreaterThanOrEqual(6);
      });
    }
  }
});

describe('Simple at 1366 × 768: Match keeps the spectrum in sight', () => {
  it('after Match the spectrum is still fully on screen, and what Match did is shown in words', async () => {
    setLoudnessTarget('loud');
    fakeMeters(-0.5);
    act(() => patchRuntime({ playing: true }));
    const { view } = await setup('simple', 1366, 768);
    const panel = masteringPanel(view);
    const plotFits = () => {
      const plot = view.querySelector<HTMLElement>('[data-section="spectrum"] canvas')!.getBoundingClientRect();
      expect(plot.height).toBeGreaterThanOrEqual(60);
      expect(plot.bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom - 8);
    };
    plotFits();
    click(byText(view, /^Match target/));
    await act(async () => wait(300));
    expect(project().mastering.params.loudness).toBeCloseTo(4.5, 5);
    expect(view.querySelector('[data-testid="loudness-control"]')!.textContent).toBe('Loudness drive 0.0 → +4.5 dB');
    // One toast for the press (its passes are one undo step): what this pass did, and that it checks again.
    expect(runtimeStore.getState().notice?.text).toMatch(/^Matching the Loud target: Loudness drive 0\.0 dB → \+4\.5 dB \(the integrated reading was −13\.5 LUFS\)\. Checking again/);
    plotFits();
  });
});

describe('True peak and the master meter', () => {
  it('true peak: plain below the ceiling, amber at the −1 dBTP ceiling (normal), red only above 0 dBTP, which also says so', async () => {
    expect([truePeakLevel(-3), truePeakLevel(-1.6), truePeakLevel(-1.4), truePeakLevel(-1), truePeakLevel(-0.6), truePeakLevel(0), truePeakLevel(0.2), truePeakLevel(undefined)]).toEqual([
      'ok',
      'ok',
      'near',
      'near',
      'near',
      'near',
      'over',
      'ok',
    ]);
    const spy = fakeMeters(-2);
    const { view } = await setup('simple', 1366, 768);
    const value = view.querySelector<HTMLElement>('[data-testid="loudness-truePeak"]')!;
    const name = value.closest('[data-key="truePeak"]')!.firstElementChild as HTMLElement;
    const ink = () => getComputedStyle(value).color;
    expect(value.textContent).toBe('−2.0');
    expect(value.dataset.level).toBe('ok');
    const plain = ink();

    const out = frame();
    spy.mockImplementation(() => {
      out.loudness = { momentary: -9, shortTerm: -9, integrated: -9, truePeakDb: -1.0 };
      return out;
    });
    await act(async () => wait(300));
    expect(value.dataset.level).toBe('near');
    expect(ink()).toBe('rgb(122, 72, 0)'); // --amber-ink
    expect(name.textContent).toBe('True peak');

    spy.mockImplementation(() => {
      out.loudness = { momentary: -8, shortTerm: -8, integrated: -8, truePeakDb: 0.3 };
      return out;
    });
    await act(async () => wait(300));
    expect(value.textContent).toBe('+0.3');
    expect(value.dataset.level).toBe('over');
    expect(ink()).toBe('rgb(138, 38, 22)'); // --coral-ink
    expect(name.textContent).toBe('Peak too high');
    expect(plain).not.toBe(ink());
    // One line says what true peak is and what the colours mean.
    expect(view.querySelector('[data-testid="true-peak-note"]')!.textContent).toBe('True peak amber: at the limiter’s −1 dBTP ceiling (normal). Red: above 0 dBTP.');
  });

  it('the master meters carry the −1 dBFS ceiling, and their tooltip says what the line means', async () => {
    const { view } = await setup('simple', 1366, 768);
    const meter = view.querySelector<HTMLElement>('[role="meter"][aria-label="Master left meter"]')!;
    const described = meter.closest<HTMLElement>('[aria-describedby]')!;
    const text = document.getElementById(described.getAttribute('aria-describedby')!)!.textContent ?? '';
    expect(text).toMatch(/The line across them is the limiter’s −1 dBFS ceiling/);
    expect(text).toMatch(/nothing goes above it/);
    expect(view.querySelector('[data-testid="ceiling-mark"]')).not.toBeNull();
  });
});

describe('Words on the loudness and A/B buttons', () => {
  it('Reset shows its word and restarts the measurement', async () => {
    const reset = vi.spyOn(session, 'resetLoudness');
    const { view } = await setup('simple', 1366, 768);
    // (Another project restarts the readings by itself: count only the click.)
    reset.mockClear();
    const b = byText(view, 'Reset');
    expect(b.getAttribute('aria-label')).toBe('Reset loudness readings');
    const r = b.getBoundingClientRect();
    expect(r.height).toBeGreaterThanOrEqual(40);
    expect(r.width).toBeGreaterThanOrEqual(40);
    click(b);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('Compare A/B: the accessible name starts with the visible words, on and off', async () => {
    const { view } = await setup('simple', 1366, 768);
    const b = byText(view, /Compare A\/B/);
    const check = () => expect(b.getAttribute('aria-label')!.startsWith(b.querySelector('[data-shown]')!.textContent!.trim())).toBe(true);
    expect(b.getAttribute('aria-label')).toBe('Compare A/B (hear without mastering)');
    check();
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    expect(b.querySelector('[data-shown]')!.textContent).toBe('Hearing: no mastering');
    check();
    fire(b, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    check();
  });
});
