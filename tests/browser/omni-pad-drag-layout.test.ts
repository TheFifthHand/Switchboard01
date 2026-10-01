/**
 * Carrying clip pads and scene rows in the running app (real Chromium, the
 * app's styles and fonts, real CDP mouse and keyboard input) at 1366 x 768,
 * 1920 x 1080 and 960 x 540 (200 % zoom of 1920 x 1080):
 * - the page never scrolls sideways while something is carried;
 * - the lifted pad's label (Move / Copy / why not) and the target's word stay
 *   whole inside the window, on the left and on the right of the grid, and
 *   never cover each other;
 * - the lifted scene row and its label stay inside the window;
 * - after a keyboard Move… the pad that received the clip has a visible focus
 *   ring, also while it settles.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { deleteDb } from '../../src/persistence/db';
import { selectSlot, selectTrack, setGuideDone, setKeyboardCollapsed, setPadMode, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';

const real = { pressClip: session.pressClip, launchScene: session.launchScene };
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
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {} });
  });
  session.pressClip = async () => {};
  session.launchScene = async () => {};
  boot = await session.boot();
});

afterEach(async () => {
  await cdp().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  cleanup();
  session.pressClip = real.pressClip;
  session.launchScene = real.launchScene;
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
  act(() => {
    selectTrack('t3');
    selectSlot('t3', 1);
  });
  await settle();
}

type Pt = { x: number; y: number };
type InputMethod = 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.dispatchTouchEvent';
async function send(method: InputMethod, params: Record<string, unknown>) {
  await act(async () => {
    await (cdp().send as (m: InputMethod, p: Record<string, unknown>) => Promise<unknown>)(method, params);
  });
}
const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', p: Pt, held = false) =>
  send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' && !held ? 'none' : 'left', buttons: type === 'mousePressed' || held ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
async function carry(from: Pt, to: Pt, steps = 10) {
  await mouse('mouseMoved', from);
  await mouse('mousePressed', from);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, true);
  await settle(200);
}
async function key(k: string, code: string, vk: number, text?: string) {
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
}

const pad = (trackId: string, slot: number) => document.getElementById(`pad-${trackId}-${slot}`) as HTMLButtonElement;
const centre = (el: Element): Pt => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const lift = () => document.querySelector<HTMLElement>('[data-testid="pad-lift"]');
const rowLift = () => document.querySelector<HTMLElement>('[data-testid="row-lift"]');
const labelOf = (root: Element | null) => root?.querySelector<HTMLElement>('[class*="liftLabel"]') ?? null;
const word = () => document.querySelector<HTMLElement>('[data-testid="pad-target-word"][data-on]');

function inside(el: Element, what: string) {
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  expect(r.left, `${what} left`).toBeGreaterThanOrEqual(0);
  expect(r.top, `${what} top`).toBeGreaterThanOrEqual(0);
  expect(r.right, `${what} right`).toBeLessThanOrEqual(vw);
  expect(r.bottom, `${what} bottom`).toBeLessThanOrEqual(vh);
}
function whole(el: HTMLElement, what: string) {
  const text = el.querySelector<HTMLElement>('[class*="liftText"]') ?? el;
  expect(text.scrollWidth, `${what} is cut short`).toBeLessThanOrEqual(text.clientWidth + 0.5);
}
function noSidewaysScroll() {
  expect(document.documentElement.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(document.documentElement.clientWidth);
}
function apart(a: Element, b: Element) {
  const x = a.getBoundingClientRect();
  const y = b.getBoundingClientRect();
  return x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top;
}

describe('carrying pads and rows at the supported sizes', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh}: labels stay whole and inside the window, nothing scrolls sideways, focus stays visible`, async () => {
      await openApp(w, hh);
      // The grid's rows in view (at 200 % the page scrolls vertically).
      pad('t3', 1).scrollIntoView({ block: 'center' });
      await settle();

      // A swap on the left of the grid.
      await carry(centre(pad('t3', 1)), centre(pad('t3', 2)));
      expect(lift()).not.toBeNull();
      noSidewaysScroll();
      inside(labelOf(lift())!, 'Move label');
      whole(labelOf(lift())!, 'Move label');
      inside(word()!, 'Swap word');
      expect(apart(labelOf(lift())!, word()!), 'the label covers the target word').toBe(true);
      await key('Escape', 'Escape', 27);
      await mouse('mouseReleased', centre(pad('t3', 2)));
      await settle(300);

      // The longest label (a refusal) over the right-hand columns: it hangs from the pad's right edge, still whole.
      await carry(centre(pad('t1', 1)), centre(pad('t8', 0)));
      const lab = labelOf(lift())!;
      expect(lab.textContent).toContain('Drum clips go to drum parts');
      noSidewaysScroll();
      inside(lab, 'refusal label');
      whole(lab, 'refusal label');
      inside(word()!, 'refusal word');
      expect(apart(lab, word()!), 'the label covers the target word').toBe(true);
      await key('Escape', 'Escape', 27);
      await mouse('mouseReleased', centre(pad('t8', 0)));
      await settle(300);

      // A scene row.
      const sceneBtn = (row: number) => document.querySelector<HTMLElement>(`[data-scene-row="${row}"] button[data-scene]`)!;
      await carry(centre(sceneBtn(0)), centre(sceneBtn(2)), 12);
      expect(rowLift()).not.toBeNull();
      noSidewaysScroll();
      inside(labelOf(rowLift())!, 'row label');
      whole(labelOf(rowLift())!, 'row label');
      await key('Escape', 'Escape', 27);
      await mouse('mouseReleased', centre(sceneBtn(2)));
      await settle(300);

      // Keyboard Move…: the pad that receives the clip shows the focus ring, while it settles and after.
      const p = pad('t3', 1);
      p.scrollIntoView({ block: 'center' });
      await settle();
      const tab = [...document.querySelectorAll<HTMLElement>('[data-pad-actions] button')].find((b) => b.textContent === 'Move…')!;
      await mouse('mouseMoved', centre(tab));
      await mouse('mousePressed', centre(tab));
      await mouse('mouseReleased', centre(tab));
      await settle(60);
      await key('ArrowDown', 'ArrowDown', 40);
      await key('Enter', 'Enter', 13, '\r');
      const target = pad('t3', 2);
      expect(document.activeElement).toBe(target);
      // The ring is teal (the pad's own shadow transition may still be fading it in).
      const teal = /rgba?\(35, 149, 142/;
      expect(target.matches(':focus-visible')).toBe(true);
      expect(getComputedStyle(target).boxShadow).toMatch(teal);
      await settle(300);
      expect(getComputedStyle(target).boxShadow).toMatch(teal);
      noSidewaysScroll();
    });
  }
});
