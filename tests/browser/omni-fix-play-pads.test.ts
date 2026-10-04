/**
 * Play view follow-ups in the running app (real Chromium, the app's styles
 * and fonts), at 1366 x 768, 1920 x 1080 and 960 x 540 (200 % zoom):
 * - the selected pad's '⋯' never covers its state word ("Playing") or name;
 * - a clip pad says how to reach its actions without playing it (right-click;
 *   Shift+F10 is among its keyboard shortcuts), and a focused pad opens them
 *   with the menu key and "." (unless "." is a key that plays notes on this
 *   keyboard layout);
 * - "Not soloed" is plain grey in the grid and the part panel (coral stays
 *   for Muted, amber for Solo);
 * - the master meter in the transport says what its red top light means;
 * - the "Key: G Dorian" summary is text, not a tab stop.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, setTrackRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { deleteDb } from '../../src/persistence/db';
import { selectSlot, selectTrack, setGuideDone, setKeyboardCollapsed, setPadMode, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, key, mount, pointer, pointIn, wait } from './ui-harness';

const realPressClip = session.pressClip;
let presses: string[] = [];
let boot: BootInfo;

beforeEach(async () => {
  await deleteDb();
  presses = [];
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    setKeyboardCollapsed(false);
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {} });
  });
  session.pressClip = async (trackId, slot) => void presses.push(`${trackId} ${slot}`);
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  session.pressClip = realPressClip;
  act(() => {
    setUiMode('simple');
    patchRuntime({ playing: false, paused: false, tracks: {} });
  });
  await session.autosaver?.flush();
  await deleteDb();
});

async function settle(ms = 60) {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 15px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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
  await settle();
}

const pad = (trackId: string, slot: number) => document.getElementById(`pad-${trackId}-${slot}`) as HTMLButtonElement;
const button = (name: string | RegExp, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof name === 'string' ? n === name : name.test(n);
  }) ?? null;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');

function overlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** The box of the visible words inside `el` that read `text` (its own text node, not the element's padding). */
function wordsBox(root: Element, text: string): DOMRect {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue?.trim() !== text) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    return r.getBoundingClientRect();
  }
  throw new Error(`"${text}" not found`);
}

/** The text a screen reader hears as the element's description (its aria-describedby targets). */
function description(el: Element): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/** "rgb(r, g, b)" of a theme token. */
function tokenColor(name: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

describe("the selected pad's '⋯'", () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh} sits in the corner without covering the state word or the clip's name`, async () => {
      await openApp(w, hh);
      const clipName = session.store.getState().tracks.find((t) => t.id === 't4')!.clips[1]!.name;
      // The Chords clip in the second row plays, and is the selected pad.
      act(() => {
        patchRuntime({ playing: true });
        setTrackRuntime('t4', { playingSlot: 1, queued: null });
        selectTrack('t4');
        selectSlot('t4', 1);
      });
      await settle();
      const p = pad('t4', 1);
      p.scrollIntoView({ block: 'center' });
      await settle();
      const more = button(/^Options for clip/)!;
      expect(more.closest('[data-pad-cell]')).toBe(p.closest('[data-pad-cell]'));
      const m = more.getBoundingClientRect();
      // A real target, inside the pad.
      expect(Math.min(m.width, m.height)).toBeGreaterThanOrEqual(32);
      const box = p.getBoundingClientRect();
      expect(m.left).toBeGreaterThanOrEqual(box.left);
      expect(m.right).toBeLessThanOrEqual(box.right);
      expect(m.top).toBeGreaterThanOrEqual(box.top);
      expect(m.bottom).toBeLessThanOrEqual(box.bottom);
      // "Playing" is whole and uncovered; so is what shows of the name.
      expect(p.textContent).toContain('Playing');
      const playing = wordsBox(p, 'Playing');
      expect(overlap(m, playing), 'the ⋯ covers "Playing"').toBe(false);
      const capText = [...p.querySelectorAll('span')].find((s) => s.children.length === 0 && s.textContent === 'Playing')!;
      expect(capText.scrollWidth, '"Playing" is cut short').toBeLessThanOrEqual(capText.clientWidth);
      const label = [...p.querySelectorAll('span')].find((s) => s.children.length === 0 && s.textContent === clipName)!;
      expect(overlap(m, label.getBoundingClientRect()), 'the ⋯ covers the name').toBe(false);
      // Pressing it opens the clip's menu (and does not play the pad).
      await act(async () => {
        more.click();
      });
      expect(menu()).not.toBeNull();
      expect(presses).toEqual([]);
    });
  }
});

describe('reaching a clip pad’s actions without playing it', () => {
  it('the pad says how (right-click) in its tooltip and its description; Shift+F10 is in its keyboard shortcuts', async () => {
    await openApp(1366, 768);
    const p = pad('t3', 1);
    expect(description(p)).toContain('Right-click for its actions');
    expect(p.getAttribute('aria-keyshortcuts')).toContain('Shift+F10');
    // Hovering shows the same words.
    pointer(p, 'pointerover', { ...pointIn(p), buttons: 0 });
    pointer(p, 'pointermove', { ...pointIn(p), buttons: 0 });
    await settle(500);
    const bubble = [...document.querySelectorAll<HTMLElement>('body > div[aria-hidden="true"]')].find((d) => d.textContent?.includes('Right-click for its actions'));
    expect(bubble, 'tooltip').toBeTruthy();
    pointer(p, 'pointerout', { ...pointIn(p), relatedTarget: document.body } as PointerEventInit);
  });

  it('a focused pad opens its actions with the menu key and with ".", and does not play', async () => {
    await openApp(1366, 768);
    for (const press of [{ key: 'ContextMenu', code: 'ContextMenu' }, { key: '.', code: 'Period' }, { key: 'F10', code: 'F10', shiftKey: true }]) {
      const p = pad('t3', 1);
      act(() => p.focus());
      const ev = key(p, 'keydown', press);
      await settle();
      expect(ev.defaultPrevented, press.key).toBe(true);
      const m = menu();
      expect(m, `${press.key} opens the menu`).not.toBeNull();
      // The clip's own actions, at this pad, which is now the selected one.
      expect(m!.textContent).toContain('Rename');
      expect(presses, `${press.key} plays nothing`).toEqual([]);
      key(document.activeElement ?? document.body, 'keydown', { key: 'Escape', code: 'Escape' });
      await settle();
      expect(menu()).toBeNull();
    }
    // Where "." is a key that plays notes (the E key on a Dvorak layout), it plays and opens nothing.
    const p = pad('t3', 1);
    act(() => p.focus());
    key(p, 'keydown', { key: '.', code: 'KeyE' });
    await settle();
    expect(menu()).toBeNull();
    key(window, 'keyup', { key: '.', code: 'KeyE' });
  });
});

describe('colour says what it means', () => {
  it('"Not soloed" is grey in the grid and the part panel; Muted stays coral and Solo amber', async () => {
    await openApp(1366, 768);
    act(() => selectTrack('t3'));
    await settle();
    // Solo Drums: every other part says "Not soloed", in grey.
    await act(async () => {
      button('Solo Drums')!.click();
    });
    await settle();
    const header = (name: string) => button(new RegExp(`^Select ${name} `))!.closest<HTMLElement>('div')!;
    const statusIn = (root: Element, word: string) => [...root.querySelectorAll<HTMLElement>('span')].find((s) => s.children.length === 0 && s.textContent === word);
    const grey = tokenColor('--ink-3');
    const coral = tokenColor('--coral-ink');
    const amber = tokenColor('--amber-ink');
    const bassStatus = statusIn(header('Bass'), 'Not soloed')!;
    expect(bassStatus).toBeTruthy();
    expect(getComputedStyle(bassStatus).color).toBe(grey);
    const panel = document.querySelector<HTMLElement>('section[aria-labelledby="part-title"]')!;
    expect(panel.querySelector('#part-title')!.textContent).toBe('Bass');
    expect(getComputedStyle(statusIn(panel, 'Not soloed')!).color).toBe(grey);
    expect(getComputedStyle(statusIn(header('Drums'), 'Solo')!).color).toBe(amber);
    // Mute Bass: Muted wins, in coral.
    await act(async () => {
      button('Mute Bass')!.click();
    });
    await settle();
    expect(getComputedStyle(statusIn(header('Bass'), 'Muted')!).color).toBe(coral);
    expect(getComputedStyle(statusIn(panel, 'Muted')!).color).toBe(coral);
  });

  it('the master meter says its red top light means "near the ceiling", not distortion', async () => {
    await openApp(1366, 768);
    const meters = document.querySelector<HTMLElement>('header[aria-label="Transport"] [data-master-meters]')!;
    expect(meters.querySelectorAll('[role="meter"]').length).toBe(2);
    const said = description(meters);
    expect(said).toContain('red light at the top');
    expect(said).toContain('does not mean distortion');
    pointer(meters, 'pointerover', { ...pointIn(meters), buttons: 0 });
    pointer(meters, 'pointermove', { ...pointIn(meters), buttons: 0 });
    await settle(500);
    expect([...document.querySelectorAll<HTMLElement>('body > div[aria-hidden="true"]')].some((d) => d.textContent?.includes('Master level'))).toBe(true);
  });
});

describe('the key summary', () => {
  it('"Key: G Dorian" is plain text, not a tab stop', async () => {
    await openApp(1366, 768);
    const keyboard = document.querySelector<HTMLElement>('section[aria-label="Keyboard"]')!;
    const summary = [...keyboard.querySelectorAll<HTMLElement>('p')].find((p) => /^Key: /.test(p.textContent ?? ''))!;
    expect(summary).toBeTruthy();
    expect(summary.tabIndex).toBe(-1);
    expect(summary.hasAttribute('tabindex')).toBe(false);
  });
});
