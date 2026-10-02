/**
 * Mix layout (MIX-13, design-06, design-08, MIX-10, MIX-02, MIX-05, MIX-11), in real Chromium with the
 * app's theme and fonts and real input (CDP mouse, keyboard and touch):
 * - 1366 × 768 Advanced: mastering stays beside the mixer, with Presets and Match target on screen
 *   without scrolling; fader travel is at least 220 px; part names are whole (two lines at most).
 * - Every fader at its minimum: each value row reads "Silent" inside its own strip.
 * - 200 % zoom (960 × 540): eight parts, two returns and the master fit, nothing scrolls sideways.
 * - A strip meter shares its fader's scale: −16 dBFS lights up next to the fader's −16, and the
 *   peak number under it turns coral above −1 dBFS.
 * - Hint homes and obstacles are marked for the hint placer.
 * - A finger swipe on a fader's lane scrolls (it does not change the level); a click on the value
 *   under a fader opens typed entry.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import type { MeterFrame } from '../../src/audio/contracts';
import { TipsProvider, faderPosition } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { MixView } from '../../src/app/views/mix/MixView';
import { resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { resetMixFrame } from '../../src/app/views/mix/mixMeters';
import { setLoudnessTarget, setSendsRow } from '../../src/app/views/mix/mixPrefs';
import { createProject } from '../../src/project/factory';
import { CHANNEL_PARAMS, specById } from '../../src/project/params';
import { selectModule, selectTrack, setUiMode, setView, type UiMode } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click, finger, send, settleFrames } from './r4-uikit-input';

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;
/** Transport (58 px) and keyboard (100 px) take this much of the window height. */
const CHROME = 158;
const project = () => session.store.getState();
const level = (trackId: string) => project().patch.modules.find((m) => m.id === `${trackId}:ch`)!.params.level ?? 0;

async function fonts() {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 15px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
}

async function setup(mode: UiMode, w: number, hh: number) {
  await page.viewport(w, hh);
  window.scrollTo(0, 0);
  act(() => {
    session.store.replace(createProject({ name: 'Mix layout', now: 1 }));
    setUiMode(mode);
    setView('mix');
    selectTrack('t1');
    selectModule(null);
  });
  resetMixFrame();
  resetLoudnessWatch();
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width: w });
  m.container.style.padding = '0';
  // Below 1024 px (200 % zoom) the page scrolls instead of the workspace.
  m.container.style.height = w < 1024 ? 'auto' : `${hh - CHROME}px`;
  await settleFrames(3);
  await fonts();
  await act(async () => wait(200));
  await settleFrames();
  const view = m.container.querySelector<HTMLElement>('[role="region"][aria-label="Mix"]')!;
  return { m, view };
}

const strips = (view: HTMLElement) => [...view.querySelectorAll<HTMLElement>('[data-testid^="strip-"]')];
const partStrips = (view: HTMLElement) => strips(view).filter((s) => /^strip-t\d$/.test(s.dataset.testid!));
const fader = (s: HTMLElement) => s.querySelector<HTMLElement>('[role="slider"][aria-orientation="vertical"]')!;
const masteringPanel = (view: HTMLElement) => view.querySelector<HTMLElement>('[data-section="presets"]')!.closest<HTMLElement>('[data-surface]')!;

/** Travel of a fader in px: its lane minus its cap. */
function travel(f: HTMLElement): number {
  const lane = f.querySelector<HTMLElement>('[class*="lane"]')!.getBoundingClientRect();
  const cap = f.querySelector<HTMLElement>('[class*="cap"]')!.getBoundingClientRect();
  return lane.height - cap.height;
}

/** The box of an element's text (not its padding). */
function textBox(el: Element): DOMRect {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r.getBoundingClientRect();
}

async function pressKey(key: string, code: string, vk: number) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}

async function typeKeys(text: string) {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.keyboard(text);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames();
}

beforeEach(() => {
  runtimeStore.setState((s) => ({ ...s, notice: null, recording: 'off', muteAll: false, playing: false }));
  setLoudnessTarget('streaming');
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  act(() => {
    patchRuntime({ playing: false });
    setUiMode('simple');
    setSendsRow(null);
  });
  resetMixFrame();
  resetLoudnessWatch();
  window.scrollTo(0, 0);
});

describe('1366 × 768', () => {
  for (const mode of ['simple', 'advanced'] as const) {
    it(`${mode}: mastering beside the mixer with Presets and Match target in sight; faders travel 220 px or more; names whole`, async () => {
      const { view } = await setup(mode, 1366, 768);
      const mixer = view.querySelector<HTMLElement>('[data-testid="strip-t1"]')!.closest<HTMLElement>('section')!.getBoundingClientRect();
      const panel = masteringPanel(view);
      expect(panel.getBoundingClientRect().left).toBeGreaterThanOrEqual(mixer.right);
      // Nothing to scroll to: the view and the mastering column are at their tops, and both keys are in the view.
      expect(view.scrollHeight).toBeLessThanOrEqual(view.clientHeight + 1);
      const viewBox = view.getBoundingClientRect();
      const bodyBox = panel.getBoundingClientRect();
      const chips = [...view.querySelectorAll<HTMLElement>('[data-section="presets"] button[aria-pressed]')];
      expect(chips.length).toBeGreaterThanOrEqual(6);
      const match = [...view.querySelectorAll<HTMLElement>('button')].find((b) => /^Match target/.test(b.textContent ?? ''))!;
      for (const el of [...chips, match]) {
        const r = el.getBoundingClientRect();
        expect(r.top, el.textContent ?? '').toBeGreaterThanOrEqual(Math.max(viewBox.top, bodyBox.top) - 1);
        expect(r.bottom, el.textContent ?? '').toBeLessThanOrEqual(Math.min(viewBox.bottom, bodyBox.bottom) + 1);
      }
      // Eight parts, two returns and the master, all inside the mixer (no sideways scrolling).
      expect(strips(view)).toHaveLength(11);
      const body = view.querySelector<HTMLElement>('[data-testid="strip-t1"]')!.parentElement!.parentElement!;
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
      for (const s of partStrips(view)) {
        expect(travel(fader(s)), s.dataset.testid).toBeGreaterThanOrEqual(220);
        // Names wrap to two lines rather than end in "…".
        const name = s.querySelector<HTMLElement>('[class*="name"]')!;
        expect(name.scrollWidth, name.textContent ?? '').toBeLessThanOrEqual(name.clientWidth + 1);
        expect(name.scrollHeight, name.textContent ?? '').toBeLessThanOrEqual(name.clientHeight + 1);
        const sound = s.querySelector<HTMLElement>('[class*="sound"]')!;
        expect(sound.scrollHeight, sound.textContent ?? '').toBeLessThanOrEqual(sound.clientHeight + 1);
      }
      expect(partStrips(view).map((s) => s.querySelector('[class*="name"]')!.textContent)).toContain('Percussion');
    });
  }
});

describe('every fader at its minimum', () => {
  for (const [w, hh] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    it(`${w} × ${hh}: each value row reads "Silent" inside its own strip, the full value is in aria`, async () => {
      const { view } = await setup('simple', w, hh);
      for (const s of strips(view)) {
        const f = fader(s);
        f.scrollIntoView({ block: 'center' });
        await click(centre(f.querySelector('[class*="cap"]')!));
        await pressKey('Home', 'Home', 36);
      }
      await settleFrames();
      for (const s of strips(view)) {
        const f = fader(s);
        expect(f.getAttribute('aria-valuetext'), s.dataset.testid).toMatch(/^−60\.0 dB, silent/);
        const value = f.parentElement!.parentElement!.querySelector<HTMLElement>('[class*="valueText"]')!;
        expect(value.textContent, s.dataset.testid).toBe('Silent');
        const t = textBox(value);
        const sr = s.getBoundingClientRect();
        expect(t.left, s.dataset.testid).toBeGreaterThanOrEqual(sr.left);
        expect(t.right, s.dataset.testid).toBeLessThanOrEqual(sr.right);
        expect(value.scrollWidth, s.dataset.testid).toBeLessThanOrEqual(value.clientWidth + 1);
      }
      expect(level('t1')).toBe(LEVEL.min);
      expect(project().masterVolumeDb).toBe(-60);
    });
  }
});

describe('200 % zoom (960 × 540)', () => {
  for (const mode of ['simple', 'advanced'] as const) {
    it(`${mode}: every strip fits the mixer, nothing scrolls sideways, mastering sits below`, async () => {
      const { m, view } = await setup(mode, 960, 540);
      expect(m.container.scrollWidth).toBeLessThanOrEqual(m.container.clientWidth + 1);
      expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth + 1);
      const body = view.querySelector<HTMLElement>('[data-testid="strip-t1"]')!.parentElement!.parentElement!;
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
      const mixer = view.querySelector<HTMLElement>('[data-testid="strip-t1"]')!.closest<HTMLElement>('section')!.getBoundingClientRect();
      expect(masteringPanel(view).getBoundingClientRect().top).toBeGreaterThanOrEqual(mixer.bottom);
      for (const s of strips(view)) {
        const r = s.getBoundingClientRect();
        expect(r.width, s.dataset.testid).toBeGreaterThanOrEqual(76);
        // Peak numbers stay inside their strip.
        const hold = s.querySelector<HTMLElement>('[data-meter-hold] span');
        if (hold) {
          const t = textBox(hold);
          expect(t.right, s.dataset.testid).toBeLessThanOrEqual(r.right + 0.5);
        }
      }
    });
  }
});

describe('a strip meter shares its fader’s scale', () => {
  it('−16 dBFS lights up next to the fader’s −16; the peak number reads it, coral above −1 dBFS', async () => {
    let peak = 10 ** (-16 / 20);
    const out: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
    vi.spyOn(session, 'readMetersShared').mockImplementation(() => {
      out.tracks = project().tracks.map((t) => ({ trackId: t.id, peak: t.id === 't3' ? peak : 0, rms: 0 }));
      return out;
    });
    const { view } = await setup('simple', 1366, 768);
    await act(async () => wait(500));
    const s = view.querySelector<HTMLElement>('[data-testid="strip-t3"]')!;
    const canvas = s.querySelector<HTMLCanvasElement>('canvas[data-meter-bar]')!;
    const ctx = canvas.getContext('2d')!;
    const off = getComputedStyle(canvas.parentElement!).getPropertyValue('--seg-off').trim();
    // The topmost lit pixel of the meter's middle column, in page px.
    const col = Math.floor(canvas.width / 2);
    const px = ctx.getImageData(col, 0, 1, canvas.height).data;
    let topLit = -1;
    for (let y = 0; y < canvas.height; y++) {
      const [r, g, b, a] = [px[y * 4], px[y * 4 + 1], px[y * 4 + 2], px[y * 4 + 3]];
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      if (a > 0 && hex !== off) {
        topLit = y;
        break;
      }
    }
    expect(topLit).toBeGreaterThanOrEqual(0);
    const cr = canvas.getBoundingClientRect();
    const litY = cr.top + (topLit / canvas.height) * cr.height;
    // Where the fader puts −16 dB: along its travel (lane minus cap), from the bottom.
    const f = fader(s);
    const lane = f.querySelector<HTMLElement>('[class*="lane"]')!.getBoundingClientRect();
    const capH = f.querySelector<HTMLElement>('[class*="cap"]')!.getBoundingClientRect().height;
    const y16 = lane.bottom - capH / 2 - faderPosition(LEVEL, -16) * (lane.height - capH);
    const pitch = cr.height / 24;
    console.info(`[meter] lit top ${litY.toFixed(1)} px, fader −16 at ${y16.toFixed(1)} px (segment ${pitch.toFixed(1)} px)`);
    // Whole segments light, so the lit top is at most one segment above the level, never below it.
    expect(litY).toBeLessThanOrEqual(y16 + 1);
    expect(litY).toBeGreaterThanOrEqual(y16 - pitch - 1);
    // Next to the −20 … −10 marks, far from the 0 mark.
    const marks = [...f.querySelectorAll<HTMLElement>('[class*="mark"]')];
    const markY = (text: string) => {
      const mk = marks.find((x) => x.textContent === text)!.getBoundingClientRect();
      return mk.top + mk.height / 2;
    };
    expect(litY).toBeGreaterThan(markY('−10'));
    expect(litY).toBeLessThan(markY('−20'));
    expect(Math.abs(litY - markY('0'))).toBeGreaterThan(40);
    // The highest peak, as a number under the meter.
    const hold = s.querySelector<HTMLElement>('[data-meter-hold]')!;
    expect(hold.textContent).toBe('−16.0');
    expect(hold.hasAttribute('data-hot')).toBe(false);
    peak = 10 ** (-0.5 / 20);
    await act(async () => wait(300));
    expect(hold.textContent).toBe('−0.5');
    expect(hold.hasAttribute('data-hot')).toBe(true);
    expect(getComputedStyle(hold).color).toBe('rgb(138, 38, 22)'); // --coral-ink
    // A click resets it (to what plays now).
    peak = 10 ** (-30 / 20);
    await act(async () => wait(100));
    await click(centre(hold));
    await act(async () => wait(300));
    expect(hold.textContent).toBe('−30.0');
  });

  it('the master meters carry the limiter’s −1 dBFS ceiling on the master fader’s scale', async () => {
    const { view } = await setup('simple', 1366, 768);
    const master = view.querySelector<HTMLElement>('[data-testid="strip-master"]')!;
    const mark = master.querySelector<HTMLElement>('[data-testid="ceiling-mark"]')!.getBoundingClientRect();
    const f = fader(master);
    const lane = f.querySelector<HTMLElement>('[class*="lane"]')!.getBoundingClientRect();
    const capH = f.querySelector<HTMLElement>('[class*="cap"]')!.getBoundingClientRect().height;
    const spec = { ...LEVEL, min: -60, max: 6 };
    const y1 = lane.bottom - capH / 2 - faderPosition(spec, -1) * (lane.height - capH);
    expect(Math.abs(mark.top - y1)).toBeLessThanOrEqual(1.5);
    // It spans both meters.
    const meters = [...master.querySelectorAll<HTMLElement>('[role="meter"]')].map((x) => x.getBoundingClientRect());
    expect(meters).toHaveLength(2);
    expect(mark.left).toBeLessThanOrEqual(meters[0].left + 1);
    expect(mark.right).toBeGreaterThanOrEqual(meters[1].right - 1);
  });
});

describe('the hint placer’s marks', () => {
  it('the mixer header is a hint home; the spectrum’s labels and the loudness readings are obstacles', async () => {
    const { view } = await setup('simple', 1366, 768);
    const home = view.querySelector('[data-hint-home]')!;
    expect(home.closest('header')).not.toBeNull();
    expect(home.textContent).toContain('Drag a fader');
    const avoid = [...view.querySelectorAll('[data-hint-avoid]')];
    expect(avoid.some((el) => el.getAttribute('aria-label') === 'Level of the lows, mids and highs')).toBe(true);
    expect(avoid.some((el) => el.getAttribute('aria-label') === 'Loudness readings')).toBe(true);
    expect(avoid.some((el) => el.textContent?.includes('10k'))).toBe(true);
  });
});

describe('touch and typed values in Mix (MIX-05, MIX-11)', () => {
  it('at 200 %, a finger swipe that starts on a fader’s lane scrolls the page and leaves the level alone', async () => {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    try {
      const { view } = await setup('simple', 960, 540);
      const s = view.querySelector<HTMLElement>('[data-testid="strip-t3"]')!;
      const f = fader(s);
      // The fader low on the page, below the fold.
      f.scrollIntoView({ block: 'end' });
      await settleFrames();
      const before = level('t3');
      const y0 = window.scrollY;
      const cap = f.querySelector<HTMLElement>('[class*="cap"]')!.getBoundingClientRect();
      const lane = f.getBoundingClientRect();
      // On the scale side of the lane, away from the cap.
      const from = { x: lane.left + 8, y: Math.min(lane.bottom - 10, cap.bottom + 40) };
      await finger(from, { x: from.x, y: from.y - 160 }, { steps: 10 });
      await act(async () => wait(150));
      expect(window.scrollY).toBeGreaterThan(y0 + 60);
      expect(level('t3')).toBe(before);
    } finally {
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  });

  it('a click on the value under a fader opens typed entry; Enter sets it (one undo step naming the part)', async () => {
    const { view } = await setup('simple', 1366, 768);
    const s = view.querySelector<HTMLElement>('[data-testid="strip-t3"]')!;
    const name = project().tracks.find((t) => t.id === 't3')!.name;
    const readout = s.querySelector<HTMLButtonElement>(`button[aria-label^="${name} level:"]`)!;
    expect(readout.getAttribute('aria-label')).toBe(`${name} level: 0.0 dB, type a value`);
    await click(centre(readout));
    const input = s.querySelector<HTMLInputElement>('input')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await typeKeys('-12{Enter}');
    expect(level('t3')).toBe(-12);
    expect(session.store.undoLabel()).toBe(`${name} level`);
  });
});
