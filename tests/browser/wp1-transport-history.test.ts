/**
 * Undo and Redo on the transport strip (real Chromium layout, the app's
 * fonts): always on the strip, with their words from 1600 px and as named
 * icon keys narrower (beside the Simple · Advanced switch from 1366 px); never
 * only in the ⋯ menu. Unavailable, they say why; available, their tip names
 * the step ("Undo: Change tempo"), and pressing them undoes and redoes it. The
 * strip still fits on one row (two rows only in Advanced below 1180 px) with
 * Stop and Export showing their words at 1366 px.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { deleteDb } from '../../src/persistence/db';
import { setGuideDone, setTipsEnabled, setUiMode } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';

let boot: BootInfo;

beforeEach(async () => {
  await deleteDb();
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
  });
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  act(() => {
    setUiMode('simple');
    patchRuntime({ playing: false, recording: 'off', muteAll: false });
  });
  await session.autosaver?.flush();
  await deleteDb();
});

async function settle() {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '400 12px "IBM Plex Mono"', '500 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function openApp() {
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  await settle();
}

const bar = () => document.querySelector<HTMLElement>('header[aria-label="Transport"]')!;
const key = (kind: 'undo' | 'redo') => bar().querySelector<HTMLButtonElement>(`button[data-history="${kind}"]`)!;
const shown = (el: Element | null): el is HTMLElement => !!el && el.getBoundingClientRect().width > 1 && getComputedStyle(el).visibility !== 'hidden';
const description = (el: Element) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

/** The word is drawn inside the key (not only its accessible name). */
function wordShown(b: HTMLElement, word: string): boolean {
  const el = [...b.querySelectorAll<HTMLElement>('span')].find((s) => s.children.length === 0 && s.textContent?.trim() === word);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const box = b.getBoundingClientRect();
  return r.width >= word.length * 5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && getComputedStyle(el).clip === 'auto';
}

function expectStripFits(label: string) {
  const b = bar();
  const right = b.getBoundingClientRect().right;
  expect(b.scrollWidth, `${label}: strip overflows`).toBeLessThanOrEqual(b.clientWidth);
  const outside = [...b.querySelectorAll<HTMLElement>('button, [role="status"], [role="timer"], input')]
    .filter((el) => shown(el) && el.getBoundingClientRect().right > right + 0.5)
    .map((el) => el.getAttribute('aria-label') ?? el.textContent);
  expect(outside, `${label}: controls outside the strip`).toEqual([]);
}

describe('Undo and Redo on the strip', () => {
  it('show their words from 1600 px and named icon keys narrower, in Simple and Advanced, and the strip fits', async () => {
    await openApp();
    for (const mode of ['simple', 'advanced'] as const) {
      act(() => setUiMode(mode));
      for (const w of [1024, 1100, 1180, 1279, 1280, 1366, 1440, 1536, 1600, 1700, 1760, 1920]) {
        await page.viewport(w, 900);
        await settle();
        const label = `${mode} ${w} px`;
        for (const kind of ['undo', 'redo'] as const) {
          const k = key(kind);
          const word = kind === 'undo' ? 'Undo' : 'Redo';
          expect(shown(k), `${label}: ${word} on the strip`).toBe(true);
          expect(k.getAttribute('aria-label')?.startsWith(word), `${label}: ${word}'s name`).toBe(true);
          const r = k.getBoundingClientRect();
          expect(Math.min(r.width, r.height), `${label}: ${word} is a 32 px target`).toBeGreaterThanOrEqual(32);
          expect(wordShown(k, word), `${label}: the word "${word}"`).toBe(w >= 1600);
        }
        // The Simple · Advanced switch is on the strip beside them from 1366 px (in More narrower).
        for (const name of ['Simple', 'Advanced']) expect(shown([...bar().querySelectorAll('[role="radio"]')].find((r) => r.textContent === name) ?? null), `${label}: "${name}"`).toBe(w >= 1366);
        expectStripFits(label);
        if (w >= 1180) expect(bar().getBoundingClientRect().height, `${label}: one row`).toBeLessThan(70);
      }
    }
    // At 1366 (Simple) Stop and Export keep their words next to them; Undo and Redo are named icon keys.
    act(() => setUiMode('simple'));
    await page.viewport(1366, 768);
    await settle();
    for (const word of ['Stop', 'Export']) {
      const b = [...bar().querySelectorAll<HTMLElement>('button')].find((x) => [...x.querySelectorAll('span')].some((s) => s.textContent?.trim() === word));
      expect(b && shown(b) && wordShown(b, word), `1366: "${word}"`).toBe(true);
    }
    for (const kind of ['undo', 'redo'] as const) expect(shown(key(kind)), `1366: ${kind}`).toBe(true);
    // From 1600 px the words are back.
    await page.viewport(1600, 900);
    await settle();
    for (const kind of ['undo', 'redo'] as const) expect(wordShown(key(kind), kind === 'undo' ? 'Undo' : 'Redo'), `1600: ${kind}'s word`).toBe(true);
  });

  it('say why when there is nothing to undo or redo, name the step when there is, and undo and redo it', async () => {
    await page.viewport(1366, 768);
    await openApp();
    act(() => session.store.replace(session.store.getState(), { resetHistory: true }));
    await settle();
    const undo = key('undo');
    const redo = key('redo');
    // Nothing yet: unavailable (still focusable, so the reason can be found), and the tip says why.
    expect(undo.getAttribute('aria-disabled')).toBe('true');
    expect(redo.getAttribute('aria-disabled')).toBe('true');
    expect(undo.disabled).toBe(false);
    expect(description(undo)).toContain('Nothing to undo');
    expect(description(redo)).toContain('Nothing to redo');
    const bpm = session.store.getState().bpm;
    act(() => undo.click());
    expect(session.store.getState().bpm, 'an unavailable Undo does nothing').toBe(bpm);

    // An edit: Undo names it.
    act(() => session.setBpm(bpm + 7));
    await settle();
    const step = session.store.info.getState().undoLabel!;
    expect(step).toBeTruthy();
    expect(undo.getAttribute('aria-disabled')).toBeNull();
    expect(undo.getAttribute('aria-label')).toBe(`Undo ${step}`);
    expect(description(undo)).toContain(`Undo: ${step}`);
    act(() => undo.click());
    await settle();
    expect(session.store.getState().bpm).toBe(bpm);
    // Now Redo names it, and brings it back.
    expect(redo.getAttribute('aria-disabled')).toBeNull();
    expect(description(redo)).toContain(`Redo: ${step}`);
    act(() => redo.click());
    await settle();
    expect(session.store.getState().bpm).toBe(bpm + 7);
    expect(redo.getAttribute('aria-disabled')).toBe('true');
  });
});
