/**
 * The Play view in the running app (real Chromium, the app's fonts and
 * styles) at 1366 x 768, 1920 x 1080 and 960 x 540, in Simple and Advanced:
 * Simple shows the key as a summary with the Musical Assist switch and hides
 * the arpeggiator strip, the key pickers, the cables drawer, Swing and Pan;
 * Advanced shows them; switching never changes the project or playback.
 * Nothing overflows sideways, the part panel shows all its controls, nothing
 * clickable is smaller than 32 px, primary controls are at least 40 px, and
 * keyboard focus is visible. The transport fits from 1024 to 1920 px in
 * Advanced too.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { deleteDb } from '../../src/persistence/db';
import { selectTrack, setGuideDone, setKeyboardCollapsed, setPadMode, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';

let boot: BootInfo;

beforeEach(async () => {
  await deleteDb();
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    setKeyboardCollapsed(false);
  });
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  act(() => {
    setUiMode('simple');
    setKeyboardCollapsed(false);
    patchRuntime({ playing: false, paused: false });
  });
  await session.autosaver?.flush();
  await deleteDb();
});

async function settle() {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 15px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await wait(30);
  });
}

async function openApp(w: number, hh: number) {
  await page.viewport(w, hh);
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  act(() => selectTrack('t4'));
  await settle();
}

const shown = (el: Element | null | undefined): el is HTMLElement => !!el && el.getBoundingClientRect().width > 1 && getComputedStyle(el).visibility !== 'hidden';
const transport = () => document.querySelector<HTMLElement>('header[aria-label="Transport"]')!;
const panel = () => document.querySelector<HTMLElement>('section[aria-labelledby="part-title"]')!;
const keyboard = () => document.querySelector<HTMLElement>('section[aria-label="Keyboard"]')!;
const pads = () => document.querySelector<HTMLElement>('section[aria-label="Pads"]')!;
const named = (root: ParentNode, name: string | RegExp) =>
  [...root.querySelectorAll<HTMLElement>('button, [role="switch"], [role="slider"], select')].find((b) => {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof name === 'string' ? n === name : name.test(n);
  }) ?? null;

/** Visible clickable things in `root` smaller than `min` px (width or height). */
function smallTargets(root: ParentNode, min: number): string[] {
  return [...root.querySelectorAll<HTMLElement>('button, [role="switch"], [role="radio"], [role="tab"], select, input')]
    .filter((el) => shown(el) && !el.closest('[aria-hidden="true"]'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width < min - 0.5 || r.height < min - 0.5;
    })
    .map((el) => `${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName} (${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)})`);
}

function expectNoSidewaysOverflow(label: string) {
  const doc = document.scrollingElement!;
  expect(doc.scrollWidth, `${label}: page scrolls sideways`).toBeLessThanOrEqual(window.innerWidth);
  for (const el of [transport(), pads(), panel(), keyboard()]) {
    expect(el.scrollWidth, `${label}: ${el.getAttribute('aria-label') ?? el.tagName} overflows`).toBeLessThanOrEqual(el.clientWidth + 1);
  }
}

describe('Simple and Advanced in the Play view', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh}: Simple hides the detail, Advanced shows it, and switching changes nothing else`, async () => {
      await openApp(w, hh);
      const before = session.store.getState();
      const run = runtimeStore.getState();

      // Simple: the key as a summary, Musical Assist; no arpeggiator, key pickers, cables, Swing or Pan.
      expect(keyboard().textContent).toMatch(/Key: [A-G]/);
      expect(shown(named(keyboard(), /^Musical Assist/))).toBe(true);
      expect(keyboard().querySelector('select')).toBeNull();
      expect(named(keyboard(), /^Arpeggiator settings/)).toBeNull();
      expect(document.querySelector('section[aria-label="Cables drawer"]')).toBeNull();
      expect(transport().textContent).not.toContain('Swing');
      expect(named(panel(), /^Pan/)).toBeNull();
      expectNoSidewaysOverflow(`${w} simple`);

      act(() => setUiMode('advanced'));
      await settle();
      expect(keyboard().querySelectorAll('select').length).toBe(2);
      expect(named(keyboard(), /^Arpeggiator settings/)).not.toBeNull();
      expect(document.querySelector('section[aria-label="Cables drawer"]')).not.toBeNull();
      expect(transport().textContent).toContain('Swing');
      expect(named(panel(), /^Pan/)).not.toBeNull();
      expectNoSidewaysOverflow(`${w} advanced`);

      act(() => setUiMode('simple'));
      await settle();
      // The project and playback are untouched by the switch.
      expect(session.store.getState()).toBe(before);
      expect(runtimeStore.getState().playing).toBe(run.playing);
      expect(runtimeStore.getState().tracks).toEqual(run.tracks);
    });
  }
});

describe('Sizes and visibility', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`at ${w} x ${hh} the part panel shows every control and the targets are big enough`, async () => {
      await openApp(w, hh);
      for (const mode of ['simple', 'advanced'] as const) {
        act(() => setUiMode(mode));
        await settle();
        const box = panel().getBoundingClientRect();
        const inside = (el: Element | null) => {
          if (!shown(el)) return false;
          const r = el.getBoundingClientRect();
          return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
        };
        for (const name of ['Mute', 'Solo', /^Change instrument/, 'Variation', 'More Variation choices', 'Keep pattern']) expect(inside(named(panel(), name)), `${mode}: ${String(name)}`).toBe(true);
        expect(inside(panel().querySelector('[role="slider"][aria-label^="Volume"]')), `${mode}: Volume`).toBe(true);
        const macros = panel().querySelectorAll('[role="group"][aria-label$="macros"] [role="slider"]');
        expect(macros.length).toBe(6);
        for (const k of macros) expect(inside(k), `${mode}: ${k.getAttribute('aria-label')}`).toBe(true);
        // Nothing clickable under 32 px in the transport, the pads, the part panel or the keyboard strip's controls.
        for (const root of [transport(), pads(), panel()]) expect(smallTargets(root, 32), `${mode} ${root.getAttribute('aria-label')}`).toEqual([]);
        // The keyboard strip's controls (the piano keys themselves are keys, not buttons).
        expect(smallTargets(keyboard(), 32).filter((t) => !/^[A-G]#?\d/.test(t)), `${mode} keyboard controls`).toEqual([]);
        // Primary controls: 40 px.
        const tabs = [...transport().querySelectorAll<HTMLElement>('[role="tab"]')];
        expect(tabs.map((t) => t.textContent)).toEqual(['Play', 'Shape', 'Song', 'Mix']);
        for (const el of [...tabs, transport().querySelector<HTMLElement>('button[aria-keyshortcuts="Space"]'), named(transport(), 'Stop'), named(panel(), 'Mute'), named(panel(), 'Solo'), named(panel(), /^Change instrument/)]) {
          const r = el!.getBoundingClientRect();
          expect(Math.min(r.width, r.height), el!.getAttribute('aria-label') ?? el!.textContent ?? '').toBeGreaterThanOrEqual(40);
        }
        expectNoSidewaysOverflow(`${w} ${mode}`);
      }
    });
  }

  it('at 960 x 540 (200 % zoom of 1920 x 1080) the page scrolls down, never sideways, and the pads keep 32 px targets', async () => {
    await openApp(960, 540);
    expectNoSidewaysOverflow('960');
    expect(smallTargets(pads(), 32)).toEqual([]);
    expect(smallTargets(panel(), 32)).toEqual([]);
  });

  it('keyboard focus is visible on pads, part toggles and the transport keys', async () => {
    await openApp(1366, 768);
    for (const el of [document.getElementById('pad-t4-1')!, named(pads(), 'Mute Chords')!, named(transport(), 'Play')!, named(panel(), /^Change instrument/)!]) {
      act(() => el.focus({ focusVisible: true } as FocusOptions));
      expect(document.activeElement).toBe(el);
      const style = getComputedStyle(el);
      const ring = style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0);
      expect(ring, el.getAttribute('aria-label') ?? el.textContent ?? '').toBe(true);
    }
  });

  it('the keyboard folds to a slim bar (remembered) and the pads get the room', async () => {
    await openApp(1366, 768);
    const padsBefore = pads().getBoundingClientRect().height;
    const fold = named(keyboard(), 'Hide the keyboard')!;
    act(() => fold.click());
    await settle();
    expect(keyboard().getBoundingClientRect().height).toBeLessThanOrEqual(48);
    expect(keyboard().textContent).toContain('Computer keys play');
    expect(pads().getBoundingClientRect().height).toBeGreaterThan(padsBefore + 40);
    act(() => named(keyboard(), 'Show the keyboard')!.click());
    await settle();
    expect(keyboard().getBoundingClientRect().height).toBeGreaterThan(90);
  });
});

describe('Transport in Advanced', () => {
  it('fits the strip (one row from 1180 px, two rows below) at every width from 1024 to 1920 px', async () => {
    await openApp(1366, 768);
    act(() => setUiMode('advanced'));
    for (const w of [1024, 1100, 1179, 1180, 1280, 1366, 1440, 1600, 1700, 1920]) {
      await page.viewport(w, 900);
      await settle();
      const b = transport();
      expect(b.scrollWidth, `${w}: strip overflows`).toBeLessThanOrEqual(b.clientWidth);
      const right = b.getBoundingClientRect().right;
      const outside = [...b.querySelectorAll<HTMLElement>('button, [role="status"], [role="timer"], input')].filter((el) => shown(el) && el.getBoundingClientRect().right > right + 0.5);
      expect(outside.map((el) => el.getAttribute('aria-label') ?? el.textContent), `${w}: outside`).toEqual([]);
      if (w >= 1180) expect(b.getBoundingClientRect().height, `${w}: one row`).toBeLessThan(70);
    }
  });
});
