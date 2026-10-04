/**
 * shape-10 / shape-21 / shape-20 / design-13: a usable Advanced layout.
 *
 * - Below 850 px of height Advanced Shape shows tabs (Macros | Instrument |
 *   Effects), one full-height column at a time; tall windows keep three columns.
 * - Each column keeps its scroll position per part.
 * - Cables open as an overlay over the columns (the columns keep their size
 *   underneath and cannot be tabbed into while covered); its grip resizes it.
 * - The Play view's cables drawer has a resizable splitter that never takes
 *   the pads below two rows, and a patch wider than the drawer scrolls with
 *   edge shadows and arrow keys that reach Master Out.
 * - The LFO block's name is never cut; number badges use --teal-key.
 * Real clicks, drags and keys.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { selectTrack, setCablesOpen, setPadMode, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { openApp, setUp, tearDown } from './r4-play-helpers';
import { clickEl, closeShape, keysOn, openShape } from './r4-shape-helpers';
import { centre, contrast, drag, settleFrames } from './r4-uikit-input';

const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes(name)) ?? null;
const columns = () => ['macros', 'instrument', 'effects'].filter((c) => document.getElementById(`shape-col-${c}`));
const body = (col: string) => document.querySelector<HTMLElement>(`#shape-col-${col} > section > div:last-child`)!;

/** Pairs of things in one mapping row that overlap (names, keys, fields, knobs and their readouts), as text. */
function rowOverlaps(): string[] {
  const out: string[] = [];
  for (const row of document.querySelectorAll<HTMLElement>('section[aria-label$=" macro"] [role="group"][aria-label*=" moves "]')) {
    const els = [...row.querySelectorAll<HTMLElement>('button, input, [role="slider"], span, label')].filter((el) => {
      if (el.closest('.visually-hidden') || el.classList.contains('visually-hidden')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) return false;
      // Things to compare: controls, and text that is not inside a control.
      if (el.matches('button, input, [role="slider"]')) return true;
      return !el.closest('button, [role="slider"]') && [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue!.trim());
    });
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i];
        const b = els[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 1 && h > 1) out.push(`${row.getAttribute('aria-label')}: “${(a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 30)}” × “${(b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 30)}”`);
      }
    }
  }
  return out;
}

describe('the Macros column’s mapping rows never overlap', () => {
  afterEach(closeShape);

  for (const [w, hh] of [
    [960, 540],
    [1366, 768],
    [1600, 900],
    [1920, 1080],
  ] as const) {
    it(`${w} × ${hh}: names, curve keys, range fields and range knobs each have their own room (Drums, Chords, Vocal)`, async () => {
      await openShape({ mode: 'advanced', w, hh });
      for (const id of ['t1', 't4', 't8']) {
        act(() => selectTrack(id));
        await settleFrames(3);
        const rows = document.querySelectorAll('section[aria-label$=" macro"] [role="group"][aria-label*=" moves "]');
        expect(rows.length, `${w} ${id}: mapping rows`).toBeGreaterThan(3);
        expect(rowOverlaps(), `${w} × ${hh} ${id}`).toEqual([]);
      }
    });
  }
});

describe('Advanced Shape: tabs on a short window, columns on a tall one', () => {
  afterEach(closeShape);

  it('1366 × 768: tabs Macros | Instrument | Effects, one column at a time using the whole width and height', async () => {
    await openShape({ mode: 'advanced', w: 1366, hh: 768 });
    expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Macros', 'Instrument', 'Effects']);
    expect(columns()).toEqual(['macros']);
    await clickEl(tab('Effects'));
    expect(columns()).toEqual(['effects']);
    const col = document.getElementById('shape-col-effects')!.getBoundingClientRect();
    expect(col.width).toBeGreaterThan(1200);
    expect(document.getElementById('shape-col-effects')!.getAttribute('role')).toBe('tabpanel');
    expect(tab('Effects')!.getAttribute('aria-selected')).toBe('true');
    // Arrow keys move between the tabs.
    await keysOn(tab('Effects')!, '{ArrowLeft}');
    expect(columns()).toEqual(['instrument']);
  });

  it('1920 × 1080: no tabs, three columns side by side', async () => {
    await openShape({ mode: 'advanced', w: 1920, hh: 1080 });
    expect(document.querySelector('[role="tab"]')).toBeNull();
    expect(columns()).toEqual(['macros', 'instrument', 'effects']);
    const tops = columns().map((c) => Math.round(document.getElementById(`shape-col-${c}`)!.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
  });

  it('each column keeps its scroll position per part', async () => {
    await openShape({ mode: 'advanced', w: 1366, hh: 768, trackId: 't4' });
    // The Macros column (six macro cards) is taller than the window.
    const el = () => body('macros');
    expect(el().scrollHeight).toBeGreaterThan(el().clientHeight + 200);
    el().scrollTop = 300;
    el().dispatchEvent(new Event('scroll'));
    await settleFrames();
    const at = el().scrollTop;
    expect(at).toBeGreaterThan(100);
    await clickEl(document.getElementById('shape-part-t1'));
    expect(el().scrollTop).toBe(0);
    el().scrollTop = 120;
    el().dispatchEvent(new Event('scroll'));
    await clickEl(document.getElementById('shape-part-t4'));
    expect(el().scrollTop).toBe(at);
    await clickEl(document.getElementById('shape-part-t1'));
    expect(el().scrollTop).toBe(120);
  });
});

describe('Cables in Advanced Shape: an overlay, not a squeeze', () => {
  afterEach(closeShape);

  it('opening the cables covers the columns at full height (they keep their size, and are inert); the grip shows part of both', async () => {
    await openShape({ mode: 'advanced', w: 1920, hh: 1080 });
    const before = document.getElementById('shape-col-effects')!.getBoundingClientRect();
    await clickEl([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Show cables') ?? null);
    const dock = document.querySelector<HTMLElement>('section[aria-label="Cable panel"][data-open]')!;
    expect(dock).not.toBeNull();
    const after = document.getElementById('shape-col-effects')!.getBoundingClientRect();
    expect(after.height).toBeGreaterThanOrEqual(before.height);
    const work = dock.parentElement!.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    expect(d.top).toBeLessThanOrEqual(work.top + 1);
    expect(d.bottom).toBeGreaterThanOrEqual(work.bottom - 1);
    expect(document.querySelector('[class*="columns"]')!.hasAttribute('inert')).toBe(true);
    // Drag the grip down: the columns show above the panel and take the keyboard again.
    const grip = dock.querySelector<HTMLElement>('[role="separator"]')!;
    const g = centre(grip);
    await drag(g, { x: g.x, y: g.y + 300 }, 8);
    const d2 = dock.getBoundingClientRect();
    expect(d2.top).toBeGreaterThan(work.top + 250);
    expect(document.querySelector('[class*="columns"]')!.hasAttribute('inert')).toBe(false);
    // End (keyboard) gives it the whole height again.
    await keysOn(grip, '{End}');
    expect(dock.getBoundingClientRect().top).toBeLessThanOrEqual(work.top + 1);
  });

  it('the LFO block’s name is never cut short (1366 and 1920)', async () => {
    for (const [w, hh] of [
      [1366, 768],
      [1920, 1080],
    ] as const) {
      await openShape({ mode: 'advanced', w, hh });
      act(() => setCablesOpen(true));
      await settleFrames(3);
      const name = document.querySelector<HTMLElement>('[data-type="lfo"] [class*="blockName"]')!;
      expect(name.textContent).toBe('LFO');
      expect(name.scrollWidth, `${w}`).toBeLessThanOrEqual(name.clientWidth + 0.5);
      closeShape();
    }
  });

  it('number badges are white on --teal-key (at least 4.5:1)', async () => {
    await openShape({ mode: 'simple', w: 1366, hh: 768 });
    for (const el of [document.querySelector('h2 [class*="contextNum"]'), document.querySelector('[data-selected] [class*="partNum"]')]) {
      const cs = getComputedStyle(el!);
      expect(contrast(cs.color, cs.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('Play view: the cables drawer', () => {
  afterEach(tearDown);

  it('1366 × 768: a splitter resizes it; at its tallest the pads keep two whole rows; edge arrows reach Master Out', async () => {
    await setUp();
    await openApp(1366, 768);
    act(() => {
      setUiMode('advanced');
      setView('play');
      setPadMode('loops');
      selectTrack('t4');
      setCablesOpen(true);
    });
    await settleFrames(4);
    const drawer = document.querySelector<HTMLElement>('section[aria-label="Cables drawer"][data-open]')!;
    const grip = drawer.querySelector<HTMLElement>('[role="separator"]')!;
    expect(grip.getAttribute('aria-label')).toBe('Resize cable drawer');
    const h0 = drawer.getBoundingClientRect().height;
    await keysOn(grip, '{Home}');
    expect(drawer.getBoundingClientRect().height).toBeLessThan(h0);
    await keysOn(grip, '{End}');
    // Two whole pad rows stay in view above it.
    const grid = document.querySelector<HTMLElement>('[aria-label^="Clip pads"]')!;
    const g = grid.getBoundingClientRect();
    const rows = [0, 1].map((r) => document.getElementById(`pad-t4-${r}`)!.getBoundingClientRect());
    for (const r of rows) {
      expect(r.top).toBeGreaterThanOrEqual(g.top - 1);
      expect(r.bottom).toBeLessThanOrEqual(Math.min(g.bottom, drawer.getBoundingClientRect().top) + 1);
    }
    // A mouse drag on the grip resizes too (down: smaller).
    const tall = drawer.getBoundingClientRect().height;
    const p = centre(grip);
    await drag(p, { x: p.x, y: p.y + 20 }, 6);
    expect(drawer.getBoundingClientRect().height).toBeLessThan(tall - 10);

    // The patch is wider than the drawer: a right edge shadow and arrow; pressing it brings Master Out into view.
    const viewport = drawer.querySelector<HTMLElement>('[data-cable-stage]')!.parentElement!;
    expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
    const right = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Scroll the patch right')!;
    expect(right).toBeDefined();
    for (let i = 0; i < 4 && right.isConnected; i++) {
      await clickEl(right);
      await new Promise((r) => setTimeout(r, 400));
      await settleFrames();
    }
    const master = drawer.querySelector<HTMLElement>('[data-module="master"]')!;
    const vp = viewport.getBoundingClientRect();
    expect(master.getBoundingClientRect().right).toBeLessThanOrEqual(vp.right + 1);
    expect([...drawer.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Scroll the patch left')).toBe(true);

    // "Open in Shape": the same part's cables in Shape, the cable panel taking the whole height.
    await clickEl(document.getElementById('cables-drawer-open-in-shape'));
    await settleFrames(4);
    expect(uiStore.getState().view).toBe('shape');
    const dock = document.querySelector<HTMLElement>('section[aria-label="Cable panel"][data-open]');
    expect(dock, 'the cable panel is open in Shape').not.toBeNull();
    expect(dock!.querySelector('[role="region"]')!.getAttribute('aria-label')).toMatch(/^Cables for Chords/);
    expect(dock!.getBoundingClientRect().height).toBeGreaterThan(400);
  }, 60_000);
});
