/**
 * Where the "Try this" chip sits, in the running app with its real styles
 * and fonts: at 1366 x 768 and 960 x 540 (200 % zoom on a 1920 x 1080
 * screen), Simple and Advanced, in every view and pad mode, it never covers
 * the transport, the pads or the keyboard, and covers no control at all
 * (where a view has no room for it, such as the Song view at 960 x 540 in
 * Advanced, it waits unseen); it stays inside the window. When a control
 * appears under it, it moves.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { HINTS_STORAGE_KEY, HINT_IDS, INITIAL_HINTS, hintsStore, markHintDone, showHintsAgain, type HintId } from '../../src/app/views/hints/hintsState';
import { findSpot } from '../../src/app/views/hints/placement';
import { deleteDb } from '../../src/persistence/db';
import { selectTrack, setGuideDone, setPadMode, setTipsEnabled, setUiMode, setView, type PadMode, type UiMode, type View } from '../../src/state/uiStore';
import { chipPlaced } from './r4-shell-chip';
import { cleanup, mount, wait } from './ui-harness';

let boot: BootInfo;

beforeEach(async () => {
  await deleteDb();
  localStorage.removeItem(HINTS_STORAGE_KEY);
  act(() => {
    hintsStore.setState(INITIAL_HINTS);
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    patchRuntime({ playing: false, paused: false, recording: 'off', tracks: {} });
  });
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  // Other test files in this browser share localStorage: leave no hints behind.
  localStorage.removeItem(HINTS_STORAGE_KEY);
  act(() => hintsStore.setState(INITIAL_HINTS));
  act(() => {
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
  });
  await session.autosaver?.flush();
  await deleteDb();
});

async function settle(ms = 400) {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 11px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await act(async () => {
    await wait(ms);
  });
}

async function openApp(w: number, hh: number) {
  await page.viewport(w, hh);
  window.scrollTo(0, 0);
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  await act(async () => {
    await session.newFromStarter('house');
  });
  act(() => {
    selectTrack('t4');
    showHintsAgain();
  });
  await settle();
  return m;
}

const chip = () => document.querySelector<HTMLElement>('[data-hint]')!;
const CONTROLS = 'button, [role="slider"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], input, select, textarea, a[href]';

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** What the chip covers, in words, for the failure message (nothing while it waits unseen for room, as a crowded view may have it). */
function covered(): string[] {
  if (!chip().hasAttribute('data-ready')) return [];
  const c = chip().getBoundingClientRect();
  const out: string[] = [];
  const region = (sel: string, name: string) => {
    const el = document.querySelector(sel);
    if (el && overlaps(c, el.getBoundingClientRect())) out.push(name);
  };
  region('header[aria-label="Transport"]', 'the transport');
  region('#pad-surface', 'the pads');
  region('main ~ footer', 'the keyboard');
  for (const el of document.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (chip().contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') continue;
    if (overlaps(c, r)) out.push(`${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName} (${el.tagName.toLowerCase()})`);
  }
  return out;
}

function expectInWindow(label: string) {
  const c = chip().getBoundingClientRect();
  expect(c.left, `${label}: left edge`).toBeGreaterThanOrEqual(0);
  expect(c.top, `${label}: top edge`).toBeGreaterThanOrEqual(0);
  expect(c.right, `${label}: right edge`).toBeLessThanOrEqual(window.innerWidth);
  expect(c.bottom, `${label}: bottom edge`).toBeLessThanOrEqual(window.innerHeight);
}

/** The steps each view is mostly about (their text length changes the chip's size). Arrange: the song track, and a basics step. */
const STEPS_FOR: Record<View, HintId[]> = { play: ['pad', 'mute', 'master'], shape: ['tone'], mix: ['master'], arrange: ['song-play', 'record'] };

/** The hints at `id`: the steps before it done; for a step of the basics, the song steps too (Arrange would put them first). */
async function showStep(id: HintId) {
  act(() => {
    showHintsAgain();
    for (const s of HINT_IDS) {
      if (s === id) break;
      markHintDone(s);
    }
    if (!id.startsWith('song-')) for (const s of HINT_IDS) if (s.startsWith('song-')) markHintDone(s);
  });
  await settle();
  await chipPlaced();
}

describe('where the hint chip sits', () => {
  for (const [w, hh] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    for (const mode of ['simple', 'advanced'] as UiMode[]) {
      it(`at ${w} x ${hh} in ${mode}: never over the transport, the pads or the keyboard, and over no control`, async () => {
        await openApp(w, hh);
        act(() => setUiMode(mode));
        const cases: [View, PadMode][] = [
          ['play', 'loops'],
          ['play', 'drums'],
          ['play', 'notes'],
          ['play', 'steps'],
          ['shape', 'loops'],
          ['arrange', 'loops'],
          ['mix', 'loops'],
        ];
        for (const [view, pad] of cases) {
          act(() => {
            setView(view);
            setPadMode(pad);
          });
          for (const id of STEPS_FOR[view]) {
            await showStep(id);
            const label = `${w}x${hh} ${mode} ${view}/${pad} "${chip().dataset.hint}"`;
            expect(chip().dataset.hint, label).toBe(id);
            expectInWindow(label);
            expect(covered(), `${label} covers`).toEqual([]);
          }
        }
      });
    }
  }

  it('moves away when a control appears under it', async () => {
    await openApp(1366, 768);
    const before = chip().getBoundingClientRect();
    // Something new shows up right where the chip is (a panel opening, say).
    const intruder = document.createElement('button');
    intruder.textContent = 'New control';
    Object.assign(intruder.style, { position: 'fixed', left: `${before.left + 20}px`, top: `${before.top + 4}px`, width: '120px', height: '32px', zIndex: '1' });
    document.body.appendChild(intruder);
    try {
      await settle(900);
      await chipPlaced();
      const after = chip().getBoundingClientRect();
      expect(overlaps(after, intruder.getBoundingClientRect())).toBe(false);
      expect(covered()).toEqual([]);
    } finally {
      intruder.remove();
    }
  });

  it('chooses the first free spot from the top, and the least covering one when nothing is free', () => {
    const area = { left: 0, top: 0, right: 400, bottom: 300 };
    const block = (left: number, top: number, right: number, bottom: number, weight = 6) => ({ box: { left, top, right, bottom }, weight });
    // A band of controls along the top: the first free row is below it.
    const free = findSpot({ w: 100, h: 40 }, area, [block(0, 0, 400, 60)]);
    expect(free).toMatchObject({ x: 0, cost: 0 });
    expect(free.y).toBeGreaterThanOrEqual(60);
    expect(free.y).toBeLessThan(70);
    // Room right of a control on the top row.
    expect(findSpot({ w: 100, h: 40 }, area, [block(0, 0, 150, 50)])).toMatchObject({ y: 0, cost: 0 });
    // Nowhere free: covering text (cheap) beats covering a control (dear).
    const spot = findSpot({ w: 100, h: 40 }, area, [block(0, 0, 400, 150, 6), block(0, 150, 400, 300, 0.4)]);
    expect(spot.y).toBeGreaterThanOrEqual(150 - 6);
    expect(spot.cost).toBeGreaterThan(0);
  });
});
