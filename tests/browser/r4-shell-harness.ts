/**
 * Shared set-up for the round-4 shell tests: the whole app mounted in real
 * Chromium with its styles and fonts, a fresh browser storage, and Jump In
 * without the audio engine (what is under test is the shell: Welcome, the
 * transport, Help, hints, toasts, keys). Input goes through Playwright
 * (userEvent) or CDP, so the browser's own handling is in play.
 */
import { act, createElement as h } from 'react';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { HINTS_STORAGE_KEY, INITIAL_HINTS, hintsStore } from '../../src/app/views/hints/hintsState';
import { deleteDb } from '../../src/persistence/db';
import { setGuideDone, setKeyboardCollapsed, setPadMode, setTipsEnabled, setUiMode, setView, selectTrack } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';

const realJumpIn = session.jumpIn;

export interface ShellOptions {
  width?: number;
  height?: number;
  /** The quick guide was done already (default true: it would sit over the strip). */
  guideDone?: boolean;
  /** Before boot: store a project, so the Welcome card is the returning visit's. */
  stored?: boolean;
}

/** Fonts the app uses, loaded so measurements are the real ones. */
export async function fonts(): Promise<void> {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 11px "Inter Variable"', '600 10px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
}

/** Let React, timers and the browser catch up. */
export async function settle(ms = 300): Promise<void> {
  await fonts();
  await act(async () => {
    await wait(ms);
  });
}

/** Wait until `fn` is truthy (polled every 20 ms inside act), or fail with `what`. */
export async function until<T>(fn: () => T, what: string, ms = 5000): Promise<NonNullable<T>> {
  const end = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await wait(20);
    });
  }
}

/** Reset everything the app remembers and mount it; Jump In makes the House starter without audio. */
export async function openShell(opts: ShellOptions = {}): Promise<{ boot: BootInfo; unmount(): void }> {
  await page.viewport(opts.width ?? 1366, opts.height ?? 768);
  window.scrollTo(0, 0);
  await deleteDb();
  localStorage.removeItem(HINTS_STORAGE_KEY);
  localStorage.removeItem('switchboard01.seenVersion');
  act(() => {
    hintsStore.setState(INITIAL_HINTS);
    setGuideDone(opts.guideDone ?? true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    selectTrack('t4');
    setKeyboardCollapsed(false);
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {}, stalled: null, starterReplaced: null, recordStartsAtTick: null });
  });
  session.jumpIn = async () => {
    await session.newFromStarter('house');
  };
  let boot = await session.boot();
  if (opts.stored) {
    await session.newFromStarter('house');
    await session.autosaver?.flush();
    boot = await session.boot();
  }
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  await settle(100);
  return { boot, unmount: m.unmount };
}

/** Undo openShell's stubs and storage (call in afterEach). */
export async function closeShell(): Promise<void> {
  cleanup();
  session.jumpIn = realJumpIn;
  localStorage.removeItem(HINTS_STORAGE_KEY);
  localStorage.removeItem('switchboard01.seenVersion');
  act(() => {
    hintsStore.setState(INITIAL_HINTS);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {}, stalled: null, starterReplaced: null, recordStartsAtTick: null });
  });
  await session.autosaver?.flush();
  await deleteDb();
}

export const transport = () => document.querySelector<HTMLElement>('header[aria-label="Transport"]')!;
export const buttons = (root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')];
/** The button with this accessible name (aria-label, else its words), or null. */
export function button(name: string | RegExp, root: ParentNode = document): HTMLButtonElement | null {
  return (
    buttons(root).find((b) => {
      const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      return typeof name === 'string' ? n === name : name.test(n);
    }) ?? null
  );
}
export const shown = (el: Element | null | undefined): boolean => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none';
};
/** The toasts on screen, their words. */
export const toasts = () => [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].filter((el) => el.closest('[aria-live="polite"][aria-relevant]')).map((el) => el.textContent ?? '');

/** A real click (Playwright, trusted events). */
export async function click(el: Element): Promise<void> {
  await userEvent.click(el);
  await settle(60);
}

/** Real key presses (Playwright keyboard syntax, e.g. "{Tab}", "{Shift>}{Tab}{/Shift}", "{Control>}s{/Control}"). */
export async function keys(text: string): Promise<void> {
  await userEvent.keyboard(text);
  await settle(60);
}
