/**
 * The keyboard strip in the running app (PLAY-17, PLAY-24, design-02, PLAY-05, MIX-13,
 * arrange-vertical-room, shape-10), with real clicks:
 * - every key the computer plays shows its letter (A and K included); C4, C5 and the root sit on
 *   a rail above their keys; the octave reset reads "↺ C4" (named "Reset octave to C4");
 * - the keys widen to the strip: wider than 1200 px at 1920 x 1080 (a third octave), and still
 *   one row at 1366 x 768;
 * - --keyboard-h on :root is the strip's height while it is docked, 0 when folded or when the
 *   page scrolls (960 x 540 at 200 %), and toasts sit above the keys;
 * - folding is remembered per view: Mix starts folded, the other views keep their own choice.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notify } from '../../src/app/runtime';
import { NOTE_KEYS } from '../../src/ui/components';
import { selectTrack, setView, uiStore } from '../../src/state/uiStore';
import { button, clickEl, openApp, setUp, tearDown, until } from './r4-play-helpers';
import { settleFrames } from './r4-uikit-input';
import { keyboard, resetKeyboardFold, strip } from './r4-keys-helpers';

beforeEach(async () => {
  await setUp();
  resetKeyboardFold();
});
afterEach(async () => {
  await tearDown();
  // Leave the keyboard unfolded everywhere for the next test file (the fold is remembered in storage).
  resetKeyboardFold();
});

const keyboardH = () => getComputedStyle(document.documentElement).getPropertyValue('--keyboard-h').trim();

describe('legends', () => {
  it('every computer key shows its letter on its key; C4, C5 and the root are on the rail above; reset reads ↺ C4', async () => {
    await openApp(1366, 768);
    act(() => selectTrack('t3'));
    await settleFrames(2);
    const base = (uiStore.getState().keyboardOctave + 1) * 12;
    for (const k of NOTE_KEYS) {
      const key = keyboard().querySelector<HTMLElement>(`[data-midi="${base + k.index}"]`)!;
      expect(key.querySelector('[class*="keycap"]')?.textContent, `${k.label} on ${key.dataset.note}`).toBe(k.label);
    }
    expect(keyboard().querySelector(`[data-midi="${base}"] [class*="keycap"]`)!.textContent).toBe('A');
    expect(keyboard().querySelector(`[data-midi="${base + 12}"] [class*="keycap"]`)!.textContent).toBe('K');
    const rail = [...keyboard().querySelectorAll<HTMLElement>('[class*="railName"]')].map((r) => r.textContent);
    expect(rail).toEqual(expect.arrayContaining(['C4', 'C5', 'G']));
    // Rail names sit above the keys, never on them.
    const c4 = [...keyboard().querySelectorAll<HTMLElement>('[class*="railName"]')].find((r) => r.textContent === 'C4')!;
    expect(c4.getBoundingClientRect().bottom).toBeLessThanOrEqual(keyboard().querySelector<HTMLElement>(`[data-midi="${base}"]`)!.getBoundingClientRect().top + 0.5);
    const reset = strip().querySelector<HTMLButtonElement>('button[aria-label="Reset octave to C4"]')!;
    expect(reset.textContent?.replace(/\s+/g, ' ').trim()).toBe('↺ C4');
    // The letter and the scale dot never touch.
    for (const key of keyboard().querySelectorAll<HTMLElement>('[data-midi]')) {
      const dot = key.querySelector('[class*="dot"]')?.getBoundingClientRect();
      const cap = key.querySelector('[class*="keycap"]')?.getBoundingClientRect();
      if (dot && cap) expect(dot.bottom <= cap.top || cap.bottom <= dot.top, key.dataset.note).toBe(true);
    }
  });
});

describe('size', () => {
  it('at 1920 x 1080 the keyboard is wider than 1200 px (a third octave); at 1366 x 768 two octaves fill the strip', async () => {
    await openApp(1920, 1080);
    act(() => selectTrack('t3'));
    await settleFrames(3);
    expect(keyboard().getBoundingClientRect().width).toBeGreaterThan(1200);
    expect(keyboard().querySelectorAll('[data-midi]')).toHaveLength(37);
    const white = keyboard().querySelector<HTMLElement>('[data-note="D4"]')!.getBoundingClientRect();
    expect(white.width).toBeLessThanOrEqual(60.5);
    expect(strip().scrollWidth).toBeLessThanOrEqual(strip().clientWidth + 1);
  });

  it('at 1366 x 768 the strip holds 25 keys wider than 760 px, nothing overflowing', async () => {
    await openApp(1366, 768);
    act(() => selectTrack('t3'));
    await settleFrames(3);
    expect(keyboard().querySelectorAll('[data-midi]')).toHaveLength(25);
    expect(keyboard().getBoundingClientRect().width).toBeGreaterThan(760);
    expect(strip().scrollWidth).toBeLessThanOrEqual(strip().clientWidth + 1);
    expect(keyboard().getBoundingClientRect().right).toBeLessThanOrEqual(strip().querySelector<HTMLElement>('[class*="assist"]')!.getBoundingClientRect().left);
  });
});

describe('--keyboard-h and toasts', () => {
  it('is the docked strip’s height, toasts sit above the keys, and 0 when folded', async () => {
    await openApp(1366, 768);
    const h = Math.round(strip().getBoundingClientRect().height);
    expect(keyboardH()).toBe(`${h}px`);
    act(() => notify('A message to show'));
    await until(() => [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].some((el) => el.textContent?.includes('A message to show')), 'the toast');
    const toast = [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].find((el) => el.textContent?.includes('A message to show'))!;
    expect(toast.getBoundingClientRect().bottom).toBeLessThanOrEqual(strip().getBoundingClientRect().top);
    await clickEl(button('Hide the keyboard', strip()));
    expect(keyboardH()).toBe('0px');
    await clickEl(button('Show the keyboard', strip()));
    expect(keyboardH()).toBe(`${h}px`);
  });

  it('is 0 at 960 x 540 (200 %), where the page scrolls', async () => {
    await openApp(960, 540);
    await settleFrames(2);
    expect(keyboardH()).toBe('0px');
  });
});

describe('folding is remembered per view', () => {
  it('folded in Play stays folded there; Shape keeps its own choice; Mix starts folded', async () => {
    await openApp(1366, 768);
    await clickEl(button('Hide the keyboard', strip()));
    expect(strip().hasAttribute('data-collapsed')).toBe(true);
    act(() => setView('shape'));
    await settleFrames(2);
    expect(strip().hasAttribute('data-collapsed')).toBe(false);
    act(() => setView('mix'));
    await settleFrames(2);
    expect(strip().hasAttribute('data-collapsed')).toBe(true);
    expect(keyboardH()).toBe('0px');
    await clickEl(button('Show the keyboard', strip()));
    expect(strip().hasAttribute('data-collapsed')).toBe(false);
    act(() => setView('play'));
    await settleFrames(2);
    expect(strip().hasAttribute('data-collapsed')).toBe(true);
    expect(uiStore.getState().keyboardCollapsedByView).toEqual({ play: true, mix: false });
    // The computer keys still play while folded (the slim bar says so).
    expect(strip().textContent).toMatch(/Computer keys play|computer keys play/);
  });
});
