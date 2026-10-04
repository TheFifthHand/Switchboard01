/**
 * Shared set-up for the round-5 Song view tests: the running app at a window
 * size on the Song view, a song made to order (regions and sections written
 * straight into the project, so a test does not depend on a starter's song),
 * real mouse and keys through the Chrome DevTools Protocol (r4-uikit-input),
 * and where bars and rows are on screen.
 */
import { act, createElement as h } from 'react';
import { cdp, page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { LANE_SETTINGS_KEY } from '../../src/app/views/arrange/laneSettings';
import { dragStore, ppbStore } from '../../src/app/views/arrange/laneStore';
import { clearLoopClipboard } from '../../src/app/views/arrange/songActions';
import { resetLaneState } from '../../src/app/views/arrange/SongTimeline';
import { getStarter } from '../../src/content/starters';
import { deleteDb } from '../../src/persistence/db';
import type { Id, Project, SongRegion, SongSection } from '../../src/project/types';
import { setGuideDone, setKeyboardCollapsed, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { mouse, send, toPage, type Pt } from './r4-uikit-input';

export { mouse, send, toPage, type Pt };

/** Reset what other test files may have left: the song view's settings and state, the runtime, the database. */
export async function resetSong(): Promise<void> {
  localStorage.removeItem(LANE_SETTINGS_KEY);
  clearLoopClipboard();
  await deleteDb();
  act(() => {
    resetLaneState();
    session.store.replace(getStarter('house')!.build(), { resetHistory: true });
    patchRuntime({ held: {}, notice: null, recording: 'off', recordTarget: null, playing: false, paused: false, mode: 'live', replayId: null });
    setGuideDone(true);
    setTipsEnabled(false);
    setUiMode('simple');
    setKeyboardCollapsed(false);
  });
}

export async function teardownSong(): Promise<void> {
  if (session.playing || session.paused) act(() => session.stop());
  act(() => {
    session.setSongLoop(null);
  });
  cleanup();
  act(() => {
    patchRuntime({ playing: false, paused: false, mode: 'live', replayId: null, recording: 'off', recordTarget: null });
    setUiMode('simple');
    // The view is remembered in localStorage, shared with the other test files: leave the default.
    setView('play');
    resetLaneState();
  });
  localStorage.removeItem(LANE_SETTINGS_KEY);
  await session.autosaver?.flush();
  await deleteDb();
}

export async function settle(ms = 120): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await wait(ms);
  });
}

/** The running app at `w` × `hh` on the Song view, with the House starter (its song replaced by `song` when given). */
export async function openSong(w = 1366, hh = 768, song?: (p: Project) => void): Promise<void> {
  await page.viewport(w, hh);
  window.scrollTo(0, 0);
  const m = mount(h(App, { boot: { lastProject: null, warnings: [], storageError: null } }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  act(() => {
    const p = getStarter('house')!.build();
    song?.(p);
    session.store.replace(p, { resetHistory: true });
    setView('arrange');
  });
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"'].map((f) => document.fonts.load(f)));
  await settle(300);
}

/** Replace the song (one undo-less change, as if the project had been opened with it). */
export function setSong(regions: SongRegion[], sections: SongSection[] = []): void {
  act(() => {
    const p = structuredClone(session.store.getState());
    p.arrangement.regions = regions;
    p.arrangement.sections = sections;
    session.store.replace(p, { resetHistory: true });
  });
}

export const project = () => session.store.getState();
export const regions = () => project().arrangement.regions;
export const sections = () => project().arrangement.sections;
export const rt = () => runtimeStore.getState();
export const undoCount = () => session.store.historySize().undo;
export const trackId = (name: string) => project().tracks.find((t) => t.name === name)!.id;
export const clipOf = (trackIdx: number, slot = 0) => project().tracks[trackIdx].clips[slot]!;
export const ppb = () => ppbStore.getState();
export const dragView = () => dragStore.getState();

export const timeline = () => document.querySelector<HTMLElement>('[data-testid="song-timeline"]')!;
export const scroller = () => document.querySelector<HTMLElement>('[data-testid="lane-scroller"]')!;
export const regionEl = (id: Id) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`)!;
export const rowEl = (trackId: Id) => document.querySelector<HTMLElement>(`[data-lane="${trackId}"]`)!;
export const originEl = () => timeline().querySelector<HTMLElement>('[class*="origin"]')!;

/** Client x of bar line `bar` (0-based). */
export function barX(bar: number): number {
  return originEl().getBoundingClientRect().left + bar * ppb();
}

/** Client y of the middle of a part's row. */
export function rowY(trackId: Id): number {
  const r = rowEl(trackId).getBoundingClientRect();
  return r.top + r.height / 2;
}

/** A point on a region: `fx` of the way along it, in the middle of its height. */
export function on(id: Id, fx = 0.5, fy = 0.6): Pt {
  const r = regionEl(id).getBoundingClientRect();
  return { x: r.left + r.width * fx, y: r.top + r.height * fy };
}

/** Its right (or left) edge grip. */
export function edge(id: Id, which: 'start' | 'end'): Pt {
  const r = regionEl(id).getBoundingClientRect();
  return { x: which === 'end' ? r.right - 3 : r.left + 3, y: r.top + r.height * 0.6 };
}

/** A region (whole bars) for setSong. */
export function region(id: Id, trackId: Id, clipId: Id, start: number, bars: number, offset = 0): SongRegion {
  return { id, trackId, clipId, start, bars, offset };
}

/** Minimum-jerk ease (a human reach): 0 → 1. */
export function reach(k: number): number {
  const t = Math.min(1, Math.max(0, k));
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

/**
 * A real mouse drag from `a` to `b` over `ms` (one move a frame), with
 * modifiers held (1 Alt, 2 Ctrl, 4 Meta, 8 Shift). Leaves the button down
 * when `release` is false.
 */
export async function dragTo(a: Pt, b: Pt, opts: { ms?: number; modifiers?: number; release?: boolean } = {}): Promise<{ moves: number[] }> {
  const ms = opts.ms ?? 260;
  const modifiers = opts.modifiers ?? 0;
  const seen: number[] = [];
  const onMove = () => seen.push(performance.now());
  window.addEventListener('pointermove', onMove, true);
  await mouse('mouseMoved', a, { modifiers });
  await mouse('mousePressed', a, { modifiers });
  const steps = Math.max(3, Math.round((ms / 1000) * 60));
  for (let s = 1; s <= steps; s++) {
    const k = reach(s / steps);
    await mouse('mouseMoved', { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, { buttons: 1, modifiers });
    await new Promise((r) => requestAnimationFrame(r));
  }
  window.removeEventListener('pointermove', onMove, true);
  if (opts.release !== false) await mouse('mouseReleased', b, { modifiers });
  await settle(60);
  return { moves: seen };
}

export async function release(p: Pt, modifiers = 0): Promise<void> {
  await mouse('mouseReleased', p, { modifiers });
  await settle(60);
}

/** A real click (CDP), with modifiers. */
export async function clickAt(p: Pt, modifiers = 0, clickCount = 1): Promise<void> {
  await mouse('mouseMoved', p, { modifiers });
  await mouse('mousePressed', p, { modifiers, clickCount });
  await mouse('mouseReleased', p, { modifiers, clickCount });
  await settle(40);
}

export async function doubleClickAt(p: Pt): Promise<void> {
  await clickAt(p, 0, 1);
  await mouse('mousePressed', p, { clickCount: 2 });
  await mouse('mouseReleased', p, { clickCount: 2 });
  await settle(80);
}

export async function rightClickAt(p: Pt): Promise<void> {
  const q = toPage(p);
  await mouse('mouseMoved', p);
  await act(async () => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'right', buttons: 2, clickCount: 1, modifiers: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'right', buttons: 0, clickCount: 1, modifiers: 0 });
  });
  await settle(60);
}

/** A real key press (CDP): `key` as KeyboardEvent.key, with modifiers. */
export async function press(key: string, modifiers = 0): Promise<void> {
  const codes: Record<string, [string, number]> = {
    Escape: ['Escape', 27],
    Enter: ['Enter', 13],
    Delete: ['Delete', 46],
    Backspace: ['Backspace', 8],
    Home: ['Home', 36],
    ArrowLeft: ['ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 39],
    ArrowDown: ['ArrowDown', 40],
    ArrowUp: ['ArrowUp', 38],
    Tab: ['Tab', 9],
    F10: ['F10', 121],
    ' ': ['Space', 32],
  };
  const [code, vk] = codes[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
  const text = key.length === 1 && !(modifiers & 2) && !(modifiers & 4) ? key : undefined;
  await act(async () => {
    await cdp().send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  });
  await settle(40);
}

/** A real mouse wheel (CDP) at `p`. */
export async function wheelAt(p: Pt, deltaY: number, modifiers = 0, deltaX = 0): Promise<void> {
  const q = toPage(p);
  await send('Input.dispatchMouseEvent' as never, { type: 'mouseWheel', x: q.x, y: q.y, deltaX, deltaY, modifiers } as never);
  await settle(60);
}

export function menuItem(text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((x) => (x.querySelector('[class*="itemText"]')?.textContent ?? x.textContent ?? '').trim().startsWith(text));
  if (!el) throw new Error(`No menu item "${text}…" in ${[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((x) => x.textContent).join(' | ')}`);
  return el;
}

/** The words in the open menu that are cut off (an ellipsis): none, in a menu that reads well. */
export function cutOff(): string[] {
  const menu = document.querySelector('[role="menu"]');
  if (!menu) throw new Error('No menu is open');
  return [...menu.querySelectorAll<HTMLElement>('[class*="itemText"], [class*="itemHint"]')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent ?? '');
}

export const centre = (el: Element, fx = 0.5, fy = 0.5): Pt => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width * fx, y: r.top + r.height * fy };
};

/** Poll (letting React and the audio clock run) until `cond` holds. */
export async function waitFor(cond: () => boolean, what: string, timeout = 8000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await wait(30);
    });
  }
}

/** Short form for comparing regions: part@start+bars~offset clip, sorted. */
export function shapeOf(list: readonly SongRegion[]): string[] {
  return list.map((r) => `${r.trackId}@${r.start}+${r.bars}~${r.offset}:${r.clipId}`).sort();
}

/**
 * The regions drawn on screen now, as part@start+bars (from where they are,
 * in bars): the rows' own regions that are visible plus the drag overlay's.
 */
export function drawnShape(): string[] {
  const out: string[] = [];
  const o = originEl().getBoundingClientRect();
  const k = ppb();
  const rows = [...document.querySelectorAll<HTMLElement>('[data-lane]')];
  const rowAtY = (y: number) => rows.find((r) => {
    const b = r.getBoundingClientRect();
    return y >= b.top && y < b.bottom;
  })?.dataset.lane;
  for (const el of document.querySelectorAll<HTMLElement>('[data-region-id], [data-ghost]')) {
    if (getComputedStyle(el).visibility === 'hidden') continue;
    const b = el.getBoundingClientRect();
    const track = el.dataset.track ?? rowAtY(b.top + b.height / 2);
    const start = Math.round((b.left - 1 - o.left) / k);
    const bars = Math.round((b.width + 2) / k);
    out.push(`${track}@${start}+${bars}`);
  }
  return out.sort();
}
