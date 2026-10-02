/**
 * Shared set-up for the round-4 Play view tests: the whole app at a given
 * window size (1366 x 768, 1920 x 1080, 960 x 540 = 1920 x 1080 at 200 %),
 * the House starter loaded (optionally playing, through the real Jump In),
 * and trusted pointer and keyboard input sent through the browser (CDP).
 */
import { act, createElement as h } from 'react';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { hintsStore, type HintsState } from '../../src/app/views/hints/hintsState';
import { deleteDb } from '../../src/persistence/db';
import type { Clip, Id } from '../../src/project/types';
import { setGuideDone, setKeyboardCollapsed, setPadMode, setTipsEnabled, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { centre, click as cdpClick, mouse, settleFrames, type Pt } from './r4-uikit-input';
import { cleanup, mount, wait } from './ui-harness';

export const SIZES = [
  { name: '1366 x 768', w: 1366, h: 768 },
  { name: '1920 x 1080', w: 1920, h: 1080 },
  { name: '960 x 540 (200 %)', w: 960, h: 540 },
] as const;

let boot: BootInfo;
let hintsBefore: HintsState | null = null;

/** Before each test: a clean library, Simple mode, the Play view's Loops pads, Tips on (the default) with the hint chip closed. */
export async function setUp(): Promise<void> {
  await deleteDb();
  hintsBefore = hintsStore.getState();
  act(() => {
    hintsStore.setState({ ...hintsBefore!, hidden: true });
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    setKeyboardCollapsed(false);
    // A fresh page: no part has a chosen clip yet.
    uiStore.setState((st) => ({ ...st, selectedTrackId: 't1', selectedSlot: {} }));
    patchRuntime({ playing: false, paused: false, recording: 'off', recordTarget: null, notice: null, tracks: {} });
  });
  boot = await session.boot();
}

/** Every notice raised while `fn` runs (a later notice, e.g. a busy-machine skip, can replace the one asked about). */
export async function noticesDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const off = runtimeStore.subscribe((st, prev) => {
    if (st.notice && st.notice !== prev.notice) seen.push(st.notice.text);
  });
  try {
    await fn();
  } finally {
    off();
  }
  return seen;
}

/** After each test: stop whatever plays or records, unmount, clean the library. */
export async function tearDown(): Promise<void> {
  if (session.recordingPerformance) await act(async () => void (await session.togglePerformance()));
  act(() => session.stop());
  session.store.setLock(null);
  cleanup();
  act(() => {
    if (hintsBefore) hintsStore.setState(hintsBefore);
    setView('play');
    setPadMode('loops');
    setTipsEnabled(true);
    patchRuntime({ playing: false, paused: false, recording: 'off', recordTarget: null, notice: null, tracks: {} });
  });
  await session.autosaver?.flush();
  await deleteDb();
}

/** The app at `w` x `h` with the House starter: playing (the real Jump In) or stopped. */
export async function openApp(w: number, hh: number, opts: { play?: boolean } = {}): Promise<void> {
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
  if (opts.play) {
    await act(async () => {
      await session.jumpIn();
    });
    await until(() => runtimeStore.getState().playing, 'playback after Jump In');
  } else {
    await act(async () => {
      await session.newFromStarter('house');
    });
  }
  await act(async () => {
    await document.fonts.ready;
    await wait(60);
  });
}

/** Wait (polling, up to `ms`) until `ok()`; throws with `what` otherwise. */
export async function until(ok: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await wait(25);
    });
  }
}

/** Trusted input runs outside React's act(). */
async function real<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    return await fn();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

/** A real mouse click in the middle of `el` (scrolled into view first). */
export async function clickEl(el: Element | null, at?: Pt): Promise<void> {
  if (!el) throw new Error('nothing to click');
  // The middle of the window: never under the sticky transport at 960 x 540, where the page scrolls.
  (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
  await settleFrames();
  await cdpClick(at ?? centre(el));
  await settleFrames();
}

/** A real mouse drag from one element's middle to another's, in steps a frame apart; `release: false` keeps the button down. */
export async function dragEl(from: Element, to: Element, opts: { steps?: number; release?: boolean } = {}): Promise<void> {
  const a = centre(from);
  const b = centre(to);
  const steps = opts.steps ?? 10;
  await mouse('mouseMoved', a);
  await mouse('mousePressed', a);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }, { buttons: 1 });
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (opts.release !== false) await mouse('mouseReleased', b);
  await settleFrames();
}

/** Real keys (Playwright's keyboard): e.g. press('Tab'), press('Control+Home'). */
export async function press(keys: string): Promise<void> {
  await real(() => userEvent.keyboard(keys));
  await settleFrames();
}

export const project = () => session.store.getState();
export const track = (id: Id) => project().tracks.find((t) => t.id === id)!;
export const clipsOf = (id: Id): (Clip | null)[] => track(id).clips;
export const pad = (trackId: Id, slot: number) => document.getElementById(`pad-${trackId}-${slot}`) as HTMLButtonElement;
export const grid = () => document.querySelector<HTMLElement>('[aria-label^="Clip pads"]')!;
export const panel = () => document.querySelector<HTMLElement>('section[aria-labelledby="part-title"]')!;
export const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
export const notice = () => runtimeStore.getState().notice?.text ?? '';

/** A button (or menu row) by its accessible name or text. */
export function button(name: string | RegExp, root: ParentNode = document): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => {
      const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      return typeof name === 'string' ? n === name : name.test(n);
    }) ?? null
  );
}

/** A menu row by its visible text. */
export function item(text: string | RegExp): HTMLButtonElement {
  const m = menu();
  if (!m) throw new Error('no menu open');
  const rows = [...m.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
  const found = rows.find((b) => (typeof text === 'string' ? (b.textContent ?? '').includes(text) : text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? '')));
  if (!found) throw new Error(`no menu item ${String(text)} in: ${rows.map((r) => r.textContent).join(' | ')}`);
  return found;
}

/** The text a control's aria-describedby points at (its tooltip's words). */
export function described(el: Element): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
    .join(' ');
}
