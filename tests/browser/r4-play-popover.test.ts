/**
 * The shared Popover (ClipMenu.tsx) with real input in the running app
 * (shell-20, arrange-toast-covers-block-menu, design-10, design-14,
 * design-15):
 * - a press outside an open menu closes it and does nothing else: with the
 *   pad's '⋯' open, clicking the Rolling pad does not queue it, and clicking
 *   Stop does not stop; the trigger still toggles; keys are never swallowed;
 * - while any popover is open body carries data-popover-open (counted), and
 *   a toast moves to the top, clear of the menu;
 * - the menu's length keys are at least 32 px; hints are words in the UI
 *   font and shortcuts are key caps; Rename has the pencil in the pad, part
 *   and scene menus.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { notify, runtimeStore } from '../../src/app/runtime';
import { MenuItem, Popover } from '../../src/app/views/ClipMenu';
import { selectSlot, selectTrack } from '../../src/state/uiStore';
import { SIZES, button, clickEl, clipsOf, item, menu, openApp, pad, press, setUp, tearDown, until } from './r4-play-helpers';
import { mount } from './ui-harness';

beforeEach(setUp);
afterEach(tearDown);

const open = () => document.body.hasAttribute('data-popover-open');

describe('a press outside a menu only closes it (shell-20)', () => {
  for (const s of SIZES) {
    it(`at ${s.name}: with '⋯' open, the Rolling pad does not start and Stop does not stop; the trigger toggles; keys still work`, async () => {
      await openApp(s.w, s.h, { play: true });
      const rolling = clipsOf('t3').findIndex((c) => c?.name === 'Rolling');
      const playingBass = runtimeStore.getState().tracks.t3?.playingSlot;
      expect(rolling).not.toBe(playingBass);
      // The selected pad's '⋯' (Chords, after Jump In).
      const more = () => button(/^Options for clip /)!;
      await clickEl(more());
      expect(menu()).not.toBeNull();
      expect(open()).toBe(true);

      await clickEl(pad('t3', rolling));
      expect(menu()).toBeNull();
      expect(open()).toBe(false);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      const t3 = runtimeStore.getState().tracks.t3;
      expect(t3?.queued?.slot ?? null).not.toBe(rolling);
      expect(t3?.playingSlot).toBe(playingBass);

      // Stop, clicked while the menu is open, only closes the menu.
      await clickEl(more());
      expect(menu()).not.toBeNull();
      const stop = document.querySelector<HTMLButtonElement>('header[aria-label="Transport"] button[aria-keyshortcuts="Shift+Space"]')!;
      await clickEl(stop);
      expect(menu()).toBeNull();
      expect(runtimeStore.getState().playing).toBe(true);
      // The next click is a click again.
      await clickEl(stop);
      await until(() => !runtimeStore.getState().playing, 'Stop on the next click');

      // The trigger toggles its own menu.
      await clickEl(more());
      expect(menu()).not.toBeNull();
      await clickEl(more());
      expect(menu()).toBeNull();

      // Keys are never swallowed: a menu closed by an outside press, then Enter on a focused pad launches it.
      await clickEl(more());
      await clickEl(document.querySelector('[data-grid-head] [class*="sceneHeaderText"]') ?? document.querySelector('section[aria-labelledby="part-title"] h2'));
      expect(menu()).toBeNull();
      const pressed: string[] = [];
      const real = session.pressClip;
      session.pressClip = async (trackId, slot) => void pressed.push(`${trackId} ${slot}`);
      try {
        act(() => pad('t3', rolling).focus());
        await press('{Enter}');
        expect(pressed).toEqual([`t3 ${rolling}`]);
      } finally {
        session.pressClip = real;
      }
    });
  }
});

describe('popovers and toasts (arrange-toast-covers-block-menu)', () => {
  it('body[data-popover-open] is counted across popovers; a toast moves to the top while a menu is open and never covers it', async () => {
    await openApp(1366, 768);
    // Counted: two popovers, the attribute stays until the last one closes.
    const anchor = { left: 100, top: 100, width: 10, height: 10 };
    const a = mount(h(Popover, { anchor, label: 'A', onClose: () => {}, role: 'dialog', children: h('p', null, 'a') }));
    const b = mount(h(Popover, { anchor: { ...anchor, left: 400 }, label: 'B', onClose: () => {}, role: 'dialog', children: h(MenuItem, { onSelect: () => {}, children: 'b' }) }));
    expect(open()).toBe(true);
    a.unmount();
    expect(open()).toBe(true);
    b.unmount();
    expect(open()).toBe(false);

    // A toast, then a menu low on the screen (the last scene's menu): the toast goes to the top, clear of it.
    act(() => notify('Something happened.', 'info'));
    const toast = await (async () => {
      await until(() => [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].some((t) => t.textContent?.includes('Something happened.')), 'the toast');
      return [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].find((t) => t.textContent?.includes('Something happened.'))!;
    })();
    const low = toast.getBoundingClientRect().top;
    await clickEl(button('Options for scene Break'));
    expect(menu()).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    const t = toast.getBoundingClientRect();
    const m = menu()!.getBoundingClientRect();
    expect(t.top).toBeLessThan(low);
    expect(t.top).toBeLessThan(140);
    const overlap = t.left < m.right && m.left < t.right && t.top < m.bottom && m.top < t.bottom;
    expect(overlap).toBe(false);
  });
});

describe('menu keys, hints and icons (design-10, design-14, design-15)', () => {
  it('length keys are at least 32 px; hints are UI-font words, shortcuts are key caps; Rename has the pencil in the pad, part and scene menus', async () => {
    await openApp(1366, 768);
    const full = clipsOf('t3').findIndex((c) => !!c);
    act(() => {
      selectTrack('t3');
      selectSlot('t3', full);
    });
    await clickEl(button(/^Options for clip /));
    for (const k of menu()!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
      const r = k.getBoundingClientRect();
      expect(r.width).toBeGreaterThanOrEqual(32);
      expect(r.height).toBeGreaterThanOrEqual(32);
    }
    const rename = item('Rename…');
    expect(rename.querySelector('svg[data-icon="pencil"]')).not.toBeNull();
    expect([...rename.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['F2']);
    const copy = item('Copy');
    expect([...copy.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'C']);
    const words = item('Edit steps').querySelector<HTMLElement>('span:last-child')!;
    expect(words.textContent).toBe('Steps view');
    expect(getComputedStyle(words).fontFamily).toMatch(/Inter/);
    expect(getComputedStyle(item('Duplicate').querySelector<HTMLElement>('span:last-child')!).fontFamily).toMatch(/Inter/);
    await press('{Escape}');

    await clickEl(button('Options for part Bass'));
    expect(item('Rename part…').querySelector('svg[data-icon="pencil"]')).not.toBeNull();
    await press('{Escape}');
    await clickEl(button('Options for scene Groove'));
    expect(item('Rename scene…').querySelector('svg[data-icon="pencil"]')).not.toBeNull();
    // Scene part counts are words in the UI font.
    await press('{Escape}');
    const count = document.querySelector<HTMLElement>('button[data-scene] [class*="sceneCount"]')!;
    expect(getComputedStyle(count).fontFamily).toMatch(/Inter/);
  });
});
