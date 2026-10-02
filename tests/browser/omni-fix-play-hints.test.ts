/**
 * The "Try this" chip, follow-ups (real Chromium, the app's styles and fonts):
 * - for a moment after it appears or moves it ignores pointer clicks, so the
 *   second click of a double-click on "Skip guide" (or "Next hint") never
 *   lands on "Hide hints"; keyboard presses always work;
 * - it never covers a heading (the Shape view's "Shaping: 2 Percussion — Hand
 *   Percussion", even when a longer part name appears under it) or a status
 *   line (Arrange's "Playback follows" explanation), at 1366 x 768,
 *   1920 x 1080 and 960 x 540;
 * - in a narrow spot its buttons wrap instead of running over its counter;
 * - the closing line says where Export really is at this width.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { HINT_CLICK_GUARD_MS } from '../../src/app/views/hints/Hints';
import { HINTS_STORAGE_KEY, HINT_IDS, INITIAL_HINTS, hideHints, hintsStore, markHintDone, showHintsAgain, type HintId } from '../../src/app/views/hints/hintsState';
import { deleteDb } from '../../src/persistence/db';
import { selectTrack, setGuideDone, setPadMode, setTipsEnabled, setUiMode, setView, type UiMode } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';

const realJumpIn = session.jumpIn;
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
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {} });
  });
  // Jump In without the audio engine: what is under test is the chip.
  session.jumpIn = async () => {
    await session.newFromStarter('house');
  };
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  localStorage.removeItem(HINTS_STORAGE_KEY);
  session.jumpIn = realJumpIn;
  act(() => {
    hintsStore.setState(INITIAL_HINTS);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    patchRuntime({ playing: false, recording: 'off', tracks: {} });
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

function openApp() {
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  return m;
}

const buttons = (root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')];
function button(name: string | RegExp, root: ParentNode = document): HTMLButtonElement | null {
  return (
    buttons(root).find((b) => {
      const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      return typeof name === 'string' ? n === name : name.test(n);
    }) ?? null
  );
}
const chip = () => document.querySelector<HTMLElement>('[data-hint]');

/** A click as a mouse makes it (detail 1, the first of a double-click; detail 2, its second). */
function mouseClick(el: Element, detail = 1) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0, detail }));
  });
}

async function jumpIn() {
  await act(async () => {
    button('Jump In')!.click();
  });
  for (let i = 0; i < 100 && buttons().some((b) => /^(Jump In|Starting…)$/.test(b.textContent?.trim() ?? '')); i++) await settle(20);
  await settle();
}

/** Open the app on the house starter with the hints at `step` (the ones before it done). */
async function openAt(w: number, hh: number, step: HintId | 'finished') {
  await page.viewport(w, hh);
  window.scrollTo(0, 0);
  openApp();
  const look = button('Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  await act(async () => {
    await session.newFromStarter('house');
  });
  showStep(step);
  await settle();
}

function showStep(step: HintId | 'finished') {
  act(() => {
    showHintsAgain();
    for (const s of HINT_IDS) {
      if (s === step) break;
      markHintDone(s);
    }
  });
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** Headings and status lines (their words, line by line) the chip covers; with `headers`, also a panel header's words (the Song header's labels). */
function coveredKeyText(opts: { headers?: boolean } = {}): string[] {
  const c = chip()!.getBoundingClientRect();
  const out: string[] = [];
  for (const el of document.querySelectorAll(`h1, h2, h3, h4, h5, h6, [role="heading"], [role="status"], [role="alert"]${opts.headers ? ', main header' : ''}`)) {
    if (chip()!.contains(el) || el.closest('header[aria-label="Transport"]')) continue;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 2 && r.height > 2 && overlaps(c, r)) out.push(n.nodeValue.trim());
    }
  }
  return out;
}

/** Controls (and the transport, pads and keyboard) the chip covers. */
function coveredControls(): string[] {
  const c = chip()!.getBoundingClientRect();
  const out: string[] = [];
  for (const [sel, name] of [
    ['header[aria-label="Transport"]', 'the transport'],
    ['#pad-surface', 'the pads'],
    ['main ~ footer', 'the keyboard'],
  ]) {
    const el = document.querySelector(sel);
    if (el && overlaps(c, el.getBoundingClientRect())) out.push(name);
  }
  for (const el of document.querySelectorAll<HTMLElement>('button, [role="slider"], [role="tab"], [role="radio"], [role="switch"], input, select, textarea')) {
    if (chip()!.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') continue;
    if (overlaps(c, r)) out.push(el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName);
  }
  return out;
}

/** Inside the chip, no button runs over the "Try this" label or the 2/7 counter, and every button stays inside the chip. */
function expectNoOverlapInside(label: string) {
  const c = chip()!;
  const box = c.getBoundingClientRect();
  const marks = [...c.querySelectorAll<HTMLElement>('span')].filter((s) => s.children.length === 0 && /^(Try this|All done|\d+\/\d+)$/i.test(s.textContent?.trim() ?? '') && s.getBoundingClientRect().width > 0);
  expect(marks.length, `${label}: label and counter`).toBeGreaterThan(0);
  for (const b of buttons(c)) {
    const r = b.getBoundingClientRect();
    for (const m of marks) expect(overlaps(r, m.getBoundingClientRect()), `${label}: "${b.textContent || b.getAttribute('aria-label')}" over "${m.textContent}"`).toBe(false);
    expect(r.left, `${label}: inside`).toBeGreaterThanOrEqual(box.left - 0.5);
    expect(r.right, `${label}: inside`).toBeLessThanOrEqual(box.right + 0.5);
    expect(r.bottom, `${label}: inside`).toBeLessThanOrEqual(box.bottom + 0.5);
    expect(Math.min(r.width, r.height), `${label}: 32 px target`).toBeGreaterThanOrEqual(32);
  }
  // The suggestion's words do not run under the buttons either.
  const text = c.querySelector('p')!.getBoundingClientRect();
  for (const b of buttons(c)) expect(overlaps(b.getBoundingClientRect(), text), `${label}: button over the suggestion`).toBe(false);
}

describe('the chip ignores a click meant for what was there before', () => {
  it('a mouse click right after it appears is ignored; a moment later it works; the keyboard always works', async () => {
    await page.viewport(1366, 768);
    act(() => setGuideDone(false));
    openApp();
    await jumpIn();
    await act(async () => {
      button('Skip guide')!.click();
    });
    expect(chip()).not.toBeNull();
    // The second click of a double-click lands on Hide hints, or on Next hint: ignored.
    mouseClick(button('Hide hints', chip()!)!, 2);
    mouseClick(button('Next hint', chip()!)!, 2);
    expect(chip()?.dataset.hint).toBe('pad');
    expect(hintsStore.getState().hidden).toBe(false);
    // A moment later a click counts.
    await settle(HINT_CLICK_GUARD_MS + 60);
    mouseClick(button('Next hint', chip()!)!);
    await act(async () => {
      await wait(0);
    });
    expect(chip()?.dataset.hint).toBe('mute');
    // The chip changed (new words, new size): a quick second click is ignored again ...
    mouseClick(button('Next hint', chip()!)!, 2);
    expect(chip()?.dataset.hint).toBe('mute');
    // ... but a key press on a focused button always works (its click has detail 0).
    const next = button('Next hint', chip()!)!;
    next.focus();
    await act(async () => {
      next.click();
    });
    expect(chip()?.dataset.hint).toBe('drag');
  });

  it('a real double-click on "Skip guide" never turns the hints off', async () => {
    await page.viewport(1366, 768);
    act(() => setGuideDone(false));
    openApp();
    await jumpIn();
    const skip = button('Skip guide')!;
    await userEvent.dblClick(skip);
    await settle();
    expect(chip(), 'the chip is there').not.toBeNull();
    expect(hintsStore.getState().hidden).toBe(false);
    expect(chip()!.dataset.hint).toBe('pad');
  });
});

describe('the chip never covers a heading or a status line', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    for (const mode of ['simple', 'advanced'] as UiMode[]) {
      it(`at ${w} x ${hh} in ${mode}: Shape with a long part name, Arrange while playing, and the other views`, async () => {
        await openAt(w, hh, 'tone');
        act(() => setUiMode(mode));
        // Shape: the chip found its spot with Chords selected; Percussion's longer name then runs into the heading's row.
        act(() => {
          selectTrack('t4');
          setView('shape');
        });
        await settle();
        act(() => selectTrack('t2'));
        await settle(900);
        const heading = [...document.querySelectorAll('h2')].find((el) => el.textContent?.includes('Hand Percussion'));
        expect(heading, 'the Shape heading').toBeTruthy();
        expect(coveredKeyText(), `${w} ${mode} shape: covers`).toEqual([]);
        expect(coveredControls(), `${w} ${mode} shape: covers`).toEqual([]);
        // Arrange while the pads play: "Playback follows: Live pads" and its longer explanation.
        for (const step of ['pad', 'record'] as HintId[]) {
          act(() => {
            patchRuntime({ playing: true, mode: 'live' });
            setView('arrange');
          });
          showStep(step);
          await settle();
          expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toMatch(/Loops pads decide what plays\./);
          // The Song header's words too ("Export tail", "Length"): the chip finds room elsewhere.
          expect(coveredKeyText({ headers: true }), `${w} ${mode} arrange ${step}: covers`).toEqual([]);
          expect(coveredControls(), `${w} ${mode} arrange ${step}: covers`).toEqual([]);
          expectNoOverlapInside(`${w} ${mode} arrange ${step}`);
        }
        act(() => patchRuntime({ playing: false }));
        // The other views, at the step each is mostly about.
        for (const [view, step] of [
          ['play', 'pad'],
          ['play', 'mute'],
          ['mix', 'master'],
        ] as const) {
          act(() => setView(view));
          showStep(step);
          await settle();
          expect(coveredKeyText(), `${w} ${mode} ${view} ${step}: covers`).toEqual([]);
          expect(coveredControls(), `${w} ${mode} ${view} ${step}: covers`).toEqual([]);
          expectNoOverlapInside(`${w} ${mode} ${view} ${step}`);
        }
      });
    }
  }

  it('in the narrowest layouts its buttons wrap rather than run over the label and counter', async () => {
    await openAt(960, 540, 'pad');
    act(() => setView('arrange'));
    showStep('pad');
    await settle();
    const c = chip()!;
    expect(button('Show the pads', c)).not.toBeNull();
    // Every layout the chip can take (Hints.tsx LAYOUTS), measured as the chip lays itself out.
    for (const [maxW, stack, compact] of [
      [340, true, true],
      [440, true, true],
      [440, true, false],
      [560, false, true],
    ] as const) {
      c.style.maxWidth = `${maxW}px`;
      c.toggleAttribute('data-stack', stack);
      c.toggleAttribute('data-compact', compact);
      expect(c.getBoundingClientRect().width).toBeLessThanOrEqual(maxW + 0.5);
      expectNoOverlapInside(`${maxW}${stack ? ' stacked' : ''}${compact ? ' compact' : ''}`);
    }
  });
});

describe('the closing line says where Export is', () => {
  it('on the strip at 1366 px (Simple); in the ⋯ menu where the strip has no room for it', async () => {
    await openAt(1366, 768, 'finished');
    const exportKey = () => button('Export', document.querySelector('header[aria-label="Transport"]')!);
    expect(chip()!.dataset.hint).toBe('finished');
    expect(exportKey()!.getBoundingClientRect().width).toBeGreaterThan(1);
    expect(chip()!.textContent).toContain('Export, at the top right, saves your music as a WAV file.');
    // Narrower: Export is in the ⋯ menu, and the line says so.
    await page.viewport(1100, 768);
    await settle(900);
    expect(exportKey()!.getBoundingClientRect().width).toBe(0);
    expect(chip()!.textContent).toContain('Export, in the ⋯ menu at the top right, saves your music as a WAV file.');
    await act(async () => {
      button(/^More:/)!.click();
    });
    expect([...document.querySelectorAll('[role="menuitem"]')].some((el) => el.textContent?.includes('Export WAV…'))).toBe(true);
    await act(async () => {
      button(/^More:/)!.click();
    });
    // Advanced at 1366 px keeps Export in the menu too.
    await page.viewport(1366, 768);
    act(() => setUiMode('advanced'));
    await settle(900);
    expect(exportKey()!.getBoundingClientRect().width).toBe(0);
    expect(chip()!.textContent).toContain('in the ⋯ menu');
    act(() => setUiMode('simple'));
    await settle(900);
    expect(chip()!.textContent).toContain('Export, at the top right');
  });
});

describe('the page is exactly the window, hints showing', () => {
  for (const [w, hh] of [
    [1920, 1080],
    [1366, 768],
  ] as const) {
    it(`at ${w} x ${hh}: no page scroll in any view, hints showing or hidden (the hints' status line takes no room)`, async () => {
      await openAt(w, hh, 'pad');
      expect(document.querySelector('[data-hints-status]'), 'the hints are showing').not.toBeNull();
      for (const hidden of [false, true]) {
        if (hidden) act(() => hideHints());
        for (const view of ['play', 'shape', 'arrange', 'mix'] as const) {
          act(() => setView(view));
          await settle(200);
          const doc = document.scrollingElement!;
          const label = `${view}${hidden ? ', hints hidden' : ''}`;
          expect(doc.scrollHeight, `${label}: page taller than the window`).toBeLessThanOrEqual(window.innerHeight);
          expect(doc.scrollWidth, `${label}: page wider than the window`).toBeLessThanOrEqual(window.innerWidth);
        }
      }
    });
  }
});
