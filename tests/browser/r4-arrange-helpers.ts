/**
 * Shared set-up for the round-4 Arrange tests: the running app (or the
 * Arrange view alone) at a given window size with the House starter's song,
 * real input through the Chrome DevTools Protocol (r4-uikit-input), and
 * smooth timed pointer paths.
 */
import { act, createElement as h } from 'react';
import { cdp, page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { clearBlockClipboard } from '../../src/app/views/arrange/songActions';
import { LANE_SETTINGS_KEY } from '../../src/app/views/arrange/laneSettings';
import { getStarter } from '../../src/content/starters';
import { deleteDb } from '../../src/persistence/db';
import { TICKS_PER_BAR, type Id, type Performance, type PerformanceEvent } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setGuideDone, setTipsEnabled, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { makeSnapshot } from '../../src/time/snapshot';
import { actFrame, cleanup, mount, wait } from './ui-harness';
import { mouse, send, toPage, type Pt } from './r4-uikit-input';

export { mouse, send, toPage, type Pt };

/** Reset what other test files may have left: the song, the runtime, the lane's remembered settings. */
export async function resetArrange(): Promise<void> {
  localStorage.removeItem(LANE_SETTINGS_KEY);
  clearBlockClipboard();
  await deleteDb();
  act(() => {
    session.store.replace(getStarter('house')!.build(), { resetHistory: true });
    patchRuntime({ held: {}, notice: null, recording: 'off', recordTarget: null, playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, songLoop: null, replayId: null });
    setGuideDone(true);
    setTipsEnabled(false);
    setUiMode('simple');
    uiStore.setState((s) => ({ ...s, laneView: {} }));
  });
}

export async function teardownArrange(): Promise<void> {
  if (session.playing || session.paused) act(() => session.stop());
  act(() => session.setSongLoop(null));
  cleanup();
  act(() => {
    patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, replayId: null, recording: 'off', recordTarget: null });
    setUiMode('simple');
    // The view is remembered in localStorage, shared with the other test files: leave the default.
    setView('play');
  });
  localStorage.removeItem(LANE_SETTINGS_KEY);
  await session.autosaver?.flush();
  await deleteDb();
}

export async function settle(ms = 300): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await wait(ms);
  });
}

/** The running app at `w` × `hh` (a window that size), on Arrange with the House starter's song. */
export async function openApp(w: number, hh: number): Promise<void> {
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
    session.store.replace(getStarter('house')!.build(), { resetHistory: true });
    setView('arrange');
  });
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 13px "Inter Variable"'].map((f) => document.fonts.load(f)));
  await settle(400);
}

/** The Arrange view alone, `width` px wide (and 680 px high), in a window of `w` × `hh`. */
export async function openLane(width = 1320, w = 1400, hh = 900): Promise<void> {
  await page.viewport(w, hh);
  mount(h('div', { style: { width: `${width}px`, height: '680px', display: 'flex', flexDirection: 'column' } }, h(ArrangeView)), { width: width + 40 });
  await actFrame();
  await actFrame();
  await settle(260);
}

export const project = () => session.store.getState();
export const blocks = () => project().arrangement.blocks;
export const blockIds = () => blocks().map((b) => b.id);
export const rt = () => runtimeStore.getState();
export const sceneId = (name: string) => project().scenes.find((s) => s.name === name)!.id;
export const trackId = (name: string) => project().tracks.find((t) => t.name === name)!.id;
export const blockEl = (id: Id) => document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
export const cellEl = (id: Id, track: Id) => blockEl(id).querySelector<HTMLButtonElement>(`[data-cell][data-track="${track}"]`)!;
export const lane = () => document.querySelector<HTMLElement>('[data-testid="song-lane"]')!;
export const scroller = () => document.querySelector<HTMLElement>('[data-testid="lane-scroller"]')!;
export const status = () => document.querySelector('[data-testid="lane-status"]')!.textContent ?? '';
export const notice = () => rt().notice;
export const undoCount = () => session.store.historySize().undo;
export const card = (name: string) => document.querySelector<HTMLElement>(`[role="listitem"][aria-label^="Scene ${name}:"]`)!;
export const ghostText = () => document.querySelector<HTMLElement>('[data-testid="lane-ghost"]')?.textContent ?? '';
export const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid="loop-toggle"]')!;

export function byLabel<T extends HTMLElement = HTMLButtonElement>(start: string, root: ParentNode = document): T {
  const el = [...root.querySelectorAll<T>('[aria-label]')].find((x) => x.getAttribute('aria-label')!.startsWith(start));
  if (!el) throw new Error(`No element labelled "${start}…"`);
  return el;
}

export function menuItem(text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((x) => (x.querySelector('[class*="itemText"]')?.textContent ?? x.textContent ?? '').trim().startsWith(text));
  if (!el) throw new Error(`No menu item "${text}…" in ${[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((x) => x.textContent).join(' | ')}`);
  return el;
}

export const centre = (el: Element, fx = 0.5, fy = 0.5): Pt => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width * fx, y: r.top + r.height * fy };
};

/** A real click (CDP), with modifiers (2 = Ctrl, 8 = Shift). */
export async function clickAt(p: Pt, modifiers = 0): Promise<void> {
  await mouse('mouseMoved', p, { modifiers });
  await mouse('mousePressed', p, { modifiers });
  await mouse('mouseReleased', p, { modifiers });
  await settle(30);
}

/** On a block's name, near its start (a compact block's ▶ and ⋯ appear over the right of its header on hover). */
export function nameAt(id: Id): Pt {
  const r = blockEl(id).querySelector<HTMLElement>('[class*="name"]')!.getBoundingClientRect();
  return { x: r.left + 8, y: r.top + r.height / 2 };
}

/** Open a block's actions menu with the mouse (hovering it first, so a compact block shows its ⋯). */
export async function openBlockMenu(id: Id): Promise<HTMLElement> {
  await mouse('mouseMoved', nameAt(id));
  await settle(30);
  await clickAt(centre(blockEl(id).querySelector<HTMLElement>('[aria-haspopup="menu"][aria-label*="block actions"]')!));
  await settle(60);
  const m = document.querySelector<HTMLElement>('[role="menu"]');
  if (!m) throw new Error('The block menu did not open');
  return m;
}

/** A real right-click (CDP) at `p`: the context menu. */
export async function rightClickAt(p: Pt): Promise<void> {
  const q = toPage(p);
  await mouse('mouseMoved', p);
  await act(async () => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'right', buttons: 2, clickCount: 1, modifiers: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'right', buttons: 0, clickCount: 1, modifiers: 0 });
  });
  await settle(40);
}

/** A real key press (CDP): `key` as KeyboardEvent.key, with modifiers. */
export async function press(key: string, modifiers = 0): Promise<void> {
  const codes: Record<string, [string, number]> = {
    Escape: ['Escape', 27],
    Enter: ['Enter', 13],
    Delete: ['Delete', 46],
    ArrowLeft: ['ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 39],
    ArrowDown: ['ArrowDown', 40],
    ArrowUp: ['ArrowUp', 38],
    Tab: ['Tab', 9],
    ' ': ['Space', 32],
  };
  const [code, vk] = codes[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
  const text = key.length === 1 && !(modifiers & 2) ? key : undefined;
  await act(async () => {
    await cdp().send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  });
  await settle(30);
}

/** A real mouse wheel (CDP) at `p`. */
export async function wheelAt(p: Pt, deltaY: number, modifiers = 0, deltaX = 0): Promise<void> {
  const q = toPage(p);
  await send('Input.dispatchMouseEvent' as never, { type: 'mouseWheel', x: q.x, y: q.y, deltaX, deltaY, modifiers } as never);
  await settle(30);
}

/** Minimum-jerk ease (the speed profile of a human reach): 0 → 1. */
export function reach(k: number): number {
  const t = Math.min(1, Math.max(0, k));
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

/**
 * Move the pressed mouse along `points` (a smooth curve through them) over
 * `ms`, one move every 1/60 s. Returns the times (performance.now) the page
 * saw each pointermove, so a run the machine stalled in (a gap long enough to
 * count as the pointer resting) can be told apart.
 */
export async function smoothDrag(points: Pt[], ms: number, opts: { hz?: number; release?: boolean } = {}): Promise<{ gaps: number[] }> {
  const hz = opts.hz ?? 60;
  const seen: number[] = [];
  const onMove = () => seen.push(performance.now());
  window.addEventListener('pointermove', onMove, true);
  const at = (k: number): Pt => {
    // Catmull-Rom through the points, `k` in 0..1 over the whole path.
    const n = points.length - 1;
    const f = Math.min(n - 1e-9, Math.max(0, k * n));
    const i = Math.floor(f);
    const u = f - i;
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n, i + 2)];
    const c = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u * u + (-a + 3 * b - 3 * cc + d) * u * u * u);
    return { x: c(p0.x, p1.x, p2.x, p3.x), y: c(p0.y, p1.y, p2.y, p3.y) };
  };
  await mouse('mouseMoved', points[0]);
  await mouse('mousePressed', points[0]);
  const steps = Math.max(2, Math.round((ms / 1000) * hz));
  const t0 = performance.now();
  for (let s = 1; s <= steps; s++) {
    const due = t0 + (s * 1000) / hz;
    const ahead = due - performance.now();
    if (ahead > 1) await new Promise((r) => setTimeout(r, ahead));
    await mouse('mouseMoved', at(reach(s / steps)), { buttons: 1 });
  }
  window.removeEventListener('pointermove', onMove, true);
  if (opts.release !== false) await mouse('mouseReleased', points[points.length - 1]);
  const gaps = seen.slice(1).map((t, i) => t - seen[i]);
  return { gaps };
}

/**
 * Add a recorded take to the project (one undo step): `events` from the
 * take's start (default bar 3), lasting `bars` bars.
 */
export function addTake(events: PerformanceEvent[], opts: { name?: string; startTick?: number; bars?: number } = {}): Id {
  const p = project();
  const startTick = opts.startTick ?? 2 * TICKS_PER_BAR;
  const perf: Performance = {
    id: `perf-${Math.random().toString(36).slice(2, 8)}`,
    name: opts.name ?? 'Take 1',
    createdAt: Date.now(),
    startTick,
    endTick: startTick + (opts.bars ?? 4) * TICKS_PER_BAR,
    snapshot: makeSnapshot(p, p.tracks.map((t) => ({ trackId: t.id, playing: null })), startTick),
    events,
  };
  let id: Id | undefined;
  act(() => {
    id = cmd.addPerformance(session.store, perf).performanceId;
  });
  if (!id) throw new Error('The take was not added');
  return id;
}

/**
 * A take that launches scene rows: `[row, bars]` stretches one after another
 * from the take's start, plus a played note and a knob move (which song
 * blocks cannot hold).
 */
export function sceneTake(stretches: [number, number][], opts: { name?: string; startTick?: number } = {}): Id {
  const start = opts.startTick ?? 2 * TICKS_PER_BAR;
  const events: PerformanceEvent[] = [];
  let at = start;
  for (const [row, bars] of stretches) {
    events.push({ t: Math.max(start, at - 40), type: 'scene', row, atTick: at });
    at += bars * TICKS_PER_BAR;
  }
  const track = project().tracks[4].id;
  events.push({ t: start + 96, type: 'noteOn', trackId: track, pitch: 60, velocity: 0.8, key: 'KeyA' });
  events.push({ t: start + 200, type: 'noteOff', trackId: track, pitch: 60, key: 'KeyA' });
  events.push({ t: start + 300, type: 'macro', trackId: project().tracks[2].id, macro: 'tone', value: 0.62 });
  const bars = stretches.reduce((a, [, b]) => a + b, 0);
  events.sort((a, b) => a.t - b.t);
  return addTake(events, { name: opts.name, startTick: start, bars });
}

/** Clear the lane's remembered settings and the uiStore's remembered lane views. */
export function forgetLaneView(): void {
  localStorage.removeItem(LANE_SETTINGS_KEY);
  act(() => uiStore.setState((s) => ({ ...s, laneView: {} })));
}
