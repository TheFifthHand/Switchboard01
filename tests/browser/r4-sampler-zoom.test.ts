/**
 * shape-14 (partial): the sampler waveform zooms and snaps. The whole app
 * (House starter) in the Shape view on Vocal, editing a clip that plays an
 * imported test file (clicks at known times); trusted mouse, wheel, keyboard
 * and touch input through the browser, at 1366 x 768, 1920 x 1080 and
 * 960 x 540:
 * - Ctrl+wheel zooms around the pointer, a plain wheel never zooms, − and +
 *   zoom, the overview strip's window drags to scroll, two fingers pinch;
 * - Shift while dragging a handle snaps to the nearest hit, or with Tempo
 *   Sync on to whole beats from the other handle; Alt drags finely;
 * - the trim handles stay 32 px targets, zoomed or not; arrow keys step in
 *   the visible window; a handle outside the view waits at its edge.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { SIZES, clicksWav, clickEl, openApp, project, setUp, shapeOn, tearDown, track, until } from './r4-sampler-helpers';
import { centre, mouse, send, settleFrames, touch, type Pt } from './r4-uikit-input';

/** The test file: 4 s, clicks (hits) at these times. */
const HITS = [0.5, 1.25, 2.0, 2.75, 3.5];
const DURATION = 4;

const wave = () => document.querySelector<HTMLElement>('[aria-label^="Waveform of Hits"]')!;
const handle = (which: 'start' | 'end') => wave().querySelector<HTMLElement>(`[role="slider"][aria-label="Trim ${which}"]`)!;
const viewport = () => document.querySelector<HTMLElement>('[role="slider"][aria-label="Visible part of the recording"]')!;
const zoomText = () => wave().parentElement!.querySelector('[data-zoom-level]')?.textContent ?? '';
const zoomKey = (name: 'Zoom in' | 'Zoom out') => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
/** The clip's own recording settings (the editor edits the selected clip, which plays the file itself). */
const own = () => track('t8').clips.find((c) => c?.sample && project().samples.some((s) => s.id === c.sample!.id && s.name === 'Hits'))!.sample!;
/** The visible window, as fractions of the file (from the overview strip's slider). */
function view(): { a: number; span: number } {
  const v = viewport();
  return { a: Number(v.getAttribute('aria-valuenow')) / 100, span: parseFloat(v.style.width) / 100 };
}
/** Screen x of a point of the file (fraction) in the waveform as it is shown now. */
function xAt(f: number): number {
  const r = wave().getBoundingClientRect();
  const { a, span } = view();
  return r.left + ((f - a) / span) * r.width;
}

async function wheel(at: Pt, deltaY: number, modifiers = 0, deltaX = 0): Promise<void> {
  const fe = window.frameElement as HTMLElement | null;
  const fr = fe?.getBoundingClientRect();
  const k = fe && fe.offsetWidth ? fr!.width / fe.offsetWidth : 1;
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: (fr?.left ?? 0) + at.x * k, y: (fr?.top ?? 0) + at.y * k, deltaX, deltaY, modifiers });
  await settleFrames();
}

/** A real drag of `el` by `dx` px in `steps`, holding `modifiers` (8 = Shift, 1 = Alt). */
async function dragBy(el: Element, dx: number, modifiers = 0, steps = 10): Promise<void> {
  // In the middle of the window: never under the keyboard strip or the transport.
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  await settleFrames();
  const a = centre(el);
  await mouse('mouseMoved', a, { modifiers });
  await mouse('mousePressed', a, { modifiers });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: a.x + (dx * i) / steps, y: a.y }, { buttons: 1, modifiers });
    await new Promise((r) => requestAnimationFrame(r));
  }
  await mouse('mouseReleased', { x: a.x + dx, y: a.y }, { modifiers });
  await settleFrames(3);
}

async function setUpHits(w: number, h: number): Promise<void> {
  await openApp(w, h);
  const res = await session.importSample(clicksWav('Hits.wav', DURATION, HITS), 't8');
  expect(res.ok, res.message).toBe(true);
  await shapeOn('t8');
  await until(() => !!document.querySelector('[aria-label^="Waveform of Hits"]'), 'the waveform of the imported clip');
  wave().scrollIntoView({ block: 'center' });
  await settleFrames(3);
}

beforeEach(async () => {
  await setUp();
});
afterEach(async () => {
  await cdp()
    .send('Emulation.setTouchEmulationEnabled', { enabled: false })
    .catch(() => undefined);
  await tearDown();
});

describe('Sampler waveform zoom (shape-14)', () => {
  for (const size of SIZES) {
    it(`${size.name}: Ctrl+wheel zooms at the pointer, a plain wheel never does; − and +; the overview window drags; handles stay 32 px`, async () => {
      await setUpHits(size.w, size.h);
      for (const which of ['start', 'end'] as const) {
        const r = handle(which).getBoundingClientRect();
        expect(r.width, which).toBeGreaterThanOrEqual(32);
        expect(r.height, which).toBeGreaterThanOrEqual(32);
      }
      for (const k of [zoomKey('Zoom in'), zoomKey('Zoom out'), viewport()]) expect(k.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
      expect(zoomText()).toContain('1×');
      expect(zoomKey('Zoom out').disabled).toBe(true);

      // A plain wheel over the waveform changes nothing.
      const before = project();
      await wheel(centre(wave()), -240);
      expect(zoomText()).toContain('1×');
      expect(project()).toBe(before);

      // Ctrl+wheel up zooms in around the pointer: the point under it stays put.
      const r = wave().getBoundingClientRect();
      const px = r.left + r.width * 0.3;
      const fAt = view().a + 0.3 * view().span;
      await wheel({ x: px, y: r.top + r.height / 2 }, -240, 2);
      expect(view().span).toBeCloseTo(0.5, 2);
      expect(zoomText()).toContain('2×');
      // (The window's start is read to 0.1% of the file, so to about a pixel here.)
      expect(Math.abs(xAt(fAt) - px)).toBeLessThan(2.5);
      expect(project()).toBe(before);

      // + and −.
      await clickEl(zoomKey('Zoom in'));
      expect(view().span).toBeCloseTo(0.25, 2);
      expect(zoomText()).toContain('4×');
      // The overview window drags (a real mouse): the view scrolls by as much of the file.
      const a0 = view().a;
      const strip = document.querySelector('[data-overview]')!.getBoundingClientRect();
      await dragBy(viewport(), strip.width * 0.2);
      expect(view().a - a0).toBeCloseTo(0.2, 1);
      expect(view().span).toBeCloseTo(0.25, 2);
      // A sideways wheel scrolls a zoomed view too.
      const a1 = view().a;
      await wheel(centre(wave()), 0, 0, -120);
      expect(view().a).toBeLessThan(a1);
      await clickEl(zoomKey('Zoom out'));
      await clickEl(zoomKey('Zoom out'));
      expect(zoomText()).toContain('1×');
      expect(project()).toBe(before);
    });
  }

  it('two fingers pinch to zoom (touch), and moving both scrolls; trims nothing', async () => {
    await setUpHits(1366, 768);
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const before = project();
    const r = wave().getBoundingClientRect();
    const y = r.top + r.height / 2;
    const mid = r.left + r.width * 0.5;
    const p1 = { x: mid - 20, y };
    const p2 = { x: mid + 20, y };
    await touch('touchStart', [p1]);
    await touch('touchStart', [p1, p2]);
    for (let i = 1; i <= 8; i++) {
      await touch('touchMove', [
        { x: p1.x - i * 10, y },
        { x: p2.x + i * 10, y },
      ]);
      await new Promise((res) => requestAnimationFrame(res));
    }
    await touch('touchEnd', []);
    await settleFrames(3);
    // 40 px apart → 200 px apart: five times closer.
    expect(1 / view().span).toBeGreaterThan(4);
    expect(1 / view().span).toBeLessThan(6);
    // Nothing was trimmed by the fingers.
    expect(own()).toEqual(before.tracks.find((t) => t.id === 't8')!.clips.find((c) => c?.sample?.id === own().id)!.sample);
  });

  it('Shift-drag snaps a handle to the nearest hit; with Tempo Sync on, End snaps to whole beats from Start; Alt drags finely', async () => {
    await setUpHits(1366, 768);
    // Start dragged (with Shift) to just short of the hit at 1.25 s lands exactly on it.
    const target = 1.22 / DURATION;
    await dragBy(handle('start'), xAt(target) - centre(handle('start')).x, 8);
    expect(own().start * DURATION).toBeCloseTo(1.25, 2);
    // Without Shift it lands where it is let go.
    await dragBy(handle('start'), xAt(1.6 / DURATION) - centre(handle('start')).x);
    const free = own().start * DURATION;
    expect(Math.min(...HITS.map((h) => Math.abs(h - free)))).toBeGreaterThan(0.05);
    // Tempo Sync on (Original BPM 120: a beat is 0.5 s): End snaps to whole beats from Start.
    act(() => session.setInstrumentParam('t8', 'sync', 1));
    await settleFrames();
    expect(track('t8').instrument.params.originalBpm).toBe(120);
    await dragBy(handle('end'), xAt((free + 1.37) / DURATION) - centre(handle('end')).x, 8);
    const beats = ((own().end - own().start) * DURATION) / 0.5;
    expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-3);
    expect(Math.round(beats)).toBe(3);
    // Alt: a 100 px drag moves a tenth as far.
    const s0 = own().start;
    const r = wave().getBoundingClientRect();
    await dragBy(handle('start'), 100, 1);
    expect((own().start - s0) * r.width).toBeCloseTo(10, -0.5);
  });

  it('arrow keys step in the visible window; a handle outside the view waits at its edge, and Zoom in is around the handle used last', async () => {
    await setUpHits(1366, 768);
    // Zoom in 8× around Start (the handle used last).
    handle('start').focus();
    for (let i = 0; i < 3; i++) await clickEl(zoomKey('Zoom in'));
    expect(1 / view().span).toBeCloseTo(8, 0);
    expect(view().a).toBe(0);
    // End lies beyond the view: it waits at the right edge, still focusable.
    expect(handle('end').dataset.offview).toBe('right');
    expect(handle('end').getBoundingClientRect().left).toBeLessThanOrEqual(wave().getBoundingClientRect().right);
    // ArrowRight moves 1% of the view (an eighth of 1% of the file).
    const s0 = own().start;
    handle('start').focus();
    await act(async () => {
      handle('start').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(own().start - s0).toBeCloseTo(0.01 / 8, 6);
    // Pressing the End handle waiting at the edge brings it to the pointer (into the view).
    const e = handle('end');
    const at = centre(e);
    await mouse('mouseMoved', at);
    await mouse('mousePressed', at);
    await mouse('mouseReleased', at);
    await settleFrames(3);
    expect(own().end).toBeLessThanOrEqual(view().a + view().span + 1e-6);
    expect(own().end).toBeGreaterThan(view().a + view().span * 0.8);
    expect(handle('end').dataset.offview).toBeUndefined();
  });
});
