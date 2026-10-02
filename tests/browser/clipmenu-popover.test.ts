/**
 * The shared popover menu (ClipMenu's Popover), with the real pointer and
 * keyboard in Chromium:
 * - it opens below its trigger when it fits, else above, else beside it, and
 *   never covers the key that opened it (the song lane's tall block menu at
 *   1366 x 768);
 * - a second click on the trigger closes it, and a double-click on '⋯' never
 *   chooses a menu item;
 * - for a moment after it opens, a click that comes without the pointer
 *   moving chooses nothing; a click after the pointer moved, or a moment
 *   later, works; keys always work;
 * - a row lights up under the pointer only once the pointer moves over the
 *   menu (keyboard focus always shows), and then it is the only lit row;
 * - Ctrl/⌘+Z, Ctrl+Shift+Z and Ctrl+Y undo and redo with a menu open (the
 *   menu closes);
 * - Ctrl+A on the page (not in a text field) never selects the page's text.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { MENU_CLICK_GUARD_MS, MenuItem, Popover, placePopover, type MenuAnchor } from '../../src/app/views/ClipMenu';
import { deleteDb } from '../../src/persistence/db';
import { renameClip } from '../../src/state/commands';
import { selectSlot, selectTrack, setGuideDone, setPadMode, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, nextFrame, wait } from './ui-harness';

/** Trusted input goes through the browser outside React's act(). */
async function real(fn: () => Promise<unknown>): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await fn();
    await nextFrame();
    await nextFrame();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const rect = (el: Element) => el.getBoundingClientRect();
function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

describe('where a popover goes (placePopover)', () => {
  const view = { vw: 1366, vh: 768 };
  const trigger: MenuAnchor = { left: 200, top: 180, width: 26, height: 30 };
  it('below when it fits, above when only that fits', () => {
    expect(placePopover(trigger, { w: 240, h: 300 }, view)).toMatchObject({ side: 'below', top: 214, left: 200 });
    expect(placePopover({ ...trigger, top: 600 }, { w: 240, h: 300 }, view)).toMatchObject({ side: 'above', top: 296 });
    // Preferring above (the arpeggiator's panel): above when it fits, else below.
    expect(placePopover({ ...trigger, top: 600 }, { w: 240, h: 300 }, view, { placement: 'above' })).toMatchObject({ side: 'above' });
    expect(placePopover(trigger, { w: 240, h: 300 }, view, { placement: 'above' })).toMatchObject({ side: 'below' });
  });
  it('beside the trigger when it fits neither below nor above, never over it', () => {
    const tall = { w: 330, h: 690 };
    const p = placePopover(trigger, tall, view);
    expect(p.side).toBe('right');
    expect(p.left).toBe(trigger.left + trigger.width + 4);
    expect(p.top + tall.h).toBeLessThanOrEqual(view.vh - 8);
    // At the window's right edge it goes to the left; an end-aligned menu prefers the left.
    expect(placePopover({ ...trigger, left: 1200 }, tall, view).side).toBe('left');
    expect(placePopover(trigger, tall, view, { align: 'end' }).side).toBe('right');
    expect(placePopover({ ...trigger, left: 1000 }, tall, view, { align: 'end' }).side).toBe('left');
    for (const t of [trigger, { ...trigger, left: 1200 }]) {
      const q = placePopover(t, tall, view);
      const box = new DOMRect(q.left, q.top, tall.w, tall.h);
      expect(overlaps(box, new DOMRect(t.left, t.top, t.width, t.height)), 'covers the trigger').toBe(false);
    }
    // A right-click point: beside it, so the pointer is not over the menu.
    const at = placePopover({ left: 500, top: 400, width: 0, height: 0 }, tall, view);
    expect(at.side).toBe('right');
    expect(at.left).toBeGreaterThan(500);
  });
  it('inside the window when there is no room anywhere', () => {
    const p = placePopover(trigger, { w: 900, h: 760 }, { vw: 1000, vh: 768 });
    expect(p.side).toBe('over');
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
});

/* ------------------------------------------------------------------ */
/* A popover under a resting pointer                                   */
/* ------------------------------------------------------------------ */

describe('a menu that opens under the pointer', () => {
  afterEach(() => cleanup());

  /** Rows 32 px tall from the menu's top (6 px padding): row `i`'s middle. */
  const rowY = (top: number, i: number) => top + 6 + 32 * i + 16;

  async function openUnderPointer(chosen: string[]) {
    await page.viewport(1000, 700);
    // The pointer rests at (300, 300) before the menu exists.
    const spot = document.createElement('div');
    spot.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:700px';
    document.body.append(spot);
    await real(() => userEvent.hover(spot, { position: { x: 300, y: 300 } }));
    spot.remove();
    // Opened (say, by the keyboard) so that its third row lies under the pointer.
    // (The menu's top is the anchor's bottom + 4 px.)
    const anchor: MenuAnchor = { left: 260, top: 300 - rowY(0, 2) - 4, width: 0, height: 0 };
    const m = mount(
      h(Popover, {
        anchor,
        label: 'Test menu',
        onClose: () => {},
        children: ['One', 'Two', 'Three', 'Four'].map((t) => h(MenuItem, { key: t, onSelect: () => void chosen.push(t), children: t })),
      }),
    );
    await act(async () => {
      await nextFrame();
    });
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    return { m, rows };
  }

  it('lights the row under the pointer only once the pointer moves; keyboard focus shows at once', async () => {
    const chosen: string[] = [];
    const { rows } = await openUnderPointer(chosen);
    await wait(MENU_CLICK_GUARD_MS + 50);
    const under = document.elementFromPoint(300, 300)?.closest<HTMLElement>('[role="menuitem"]');
    expect(under, 'a row under the resting pointer').toBe(rows[2]);
    expect(under!.matches(':hover')).toBe(true);
    // Keyboard focus (the first row) is lit; the row under the resting pointer is not.
    expect(document.activeElement).toBe(rows[0]);
    const bg = (el: Element) => getComputedStyle(el).backgroundColor;
    expect(bg(rows[0])).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg(rows[2])).toBe('rgba(0, 0, 0, 0)');
    // The pointer moves a little over the menu: now the row under it lights up, and takes the focus,
    // so it is the only lit row (the keyboard goes on from there).
    await real(() => userEvent.hover(rows[2], { position: { x: 60, y: 14 } }));
    expect(bg(rows[2])).not.toBe('rgba(0, 0, 0, 0)');
    expect(document.activeElement).toBe(rows[2]);
    expect(rows.filter((r) => bg(r) !== 'rgba(0, 0, 0, 0)'), 'one lit row').toEqual([rows[2]]);
    await real(() => userEvent.keyboard('{ArrowDown}'));
    expect(document.activeElement).toBe(rows[3]);
    expect(chosen).toEqual([]);
  });

  it('a click with the pointer still, right after opening, chooses nothing; moved or later, it does', async () => {
    // No movement since it opened, within the guard (the second click of a double-click): ignored; keys (detail 0) work.
    const chosen2: string[] = [];
    const again = await openUnderPointer(chosen2);
    act(() => {
      again.rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: 300, clientY: 300 }));
    });
    expect(chosen2, 'a still click right after opening').toEqual([]);
    act(() => {
      again.rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    });
    expect(chosen2, 'Enter / Space (detail 0) always work').toEqual(['Two']);
    // After the moment passes, a still click works.
    await wait(MENU_CLICK_GUARD_MS + 20);
    act(() => {
      again.rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: 300, clientY: 300 }));
    });
    expect(chosen2).toEqual(['Two', 'Three']);
    again.m.unmount();

    // Moving the pointer makes a quick click deliberate.
    const chosen3: string[] = [];
    const third = await openUnderPointer(chosen3);
    await real(() => userEvent.click(third.rows[3]));
    expect(chosen3).toEqual(['Four']);
  });
});

/* ------------------------------------------------------------------ */
/* In the app                                                           */
/* ------------------------------------------------------------------ */

let boot: BootInfo;
const realPressClip = session.pressClip;

describe('menus in the app', () => {
  beforeEach(async () => {
    await deleteDb();
    act(() => {
      setGuideDone(true);
      setTipsEnabled(true);
      setUiMode('simple');
      setView('play');
      setPadMode('loops');
      patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {} });
    });
    session.pressClip = async () => {};
    boot = await session.boot();
  });

  afterEach(async () => {
    cleanup();
    session.pressClip = realPressClip;
    act(() => {
      setView('play');
      patchRuntime({ playing: false, paused: false, tracks: {} });
    });
    await session.autosaver?.flush();
    await deleteDb();
  });

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
    act(() => patchRuntime({ playing: false, paused: false, tracks: {} }));
    await act(async () => {
      await wait(80);
    });
  }

  it("the song lane's block menu opens beside its '⋯' at 1366 x 768; a second click closes it; a double-click chooses nothing", async () => {
    await openApp(1366, 768);
    act(() => setView('arrange'));
    await act(async () => {
      await wait(200);
    });
    const block = document.querySelector<HTMLElement>('[data-block-id]')!;
    const dots = block.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
    const before = JSON.stringify(session.store.getState().arrangement);
    const notice = runtimeStore.getState().notice;
    await real(() => userEvent.click(dots));
    const m = menu();
    expect(m, 'the block menu').not.toBeNull();
    const r = rect(m!);
    expect(overlaps(r, rect(dots)), 'the menu covers its ⋯').toBe(false);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(r.right).toBeLessThanOrEqual(window.innerWidth);
    expect(dots.getAttribute('aria-expanded')).toBe('true');
    // The trigger again: closed (not closed and reopened).
    await real(() => userEvent.click(dots));
    expect(menu(), 'a second click closes it').toBeNull();
    // A double-click on the ⋯: open, then closed again; nothing in the song changed.
    await real(() => userEvent.dblClick(dots));
    await wait(100);
    expect(JSON.stringify(session.store.getState().arrangement)).toBe(before);
    expect(runtimeStore.getState().notice, 'no action ran').toBe(notice);
  });

  it("a pad's '⋯' toggles its menu; a double-click on it chooses nothing", async () => {
    await openApp(1366, 768);
    const t = session.store.getState().tracks[2];
    const slot = t.clips.findIndex((c) => !!c);
    act(() => {
      selectTrack(t.id);
      selectSlot(t.id, slot);
    });
    await act(async () => {
      await wait(60);
    });
    const dots = document.getElementById(`pad-${t.id}-${slot}`)!.closest('[data-pad-cell]')!.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
    await real(() => userEvent.click(dots));
    expect(menu()).not.toBeNull();
    expect(overlaps(rect(menu()!), rect(dots))).toBe(false);
    await real(() => userEvent.click(dots));
    expect(menu()).toBeNull();
    const before = JSON.stringify(session.store.getState().tracks);
    await real(() => userEvent.dblClick(dots));
    await wait(100);
    expect(JSON.stringify(session.store.getState().tracks)).toBe(before);
  });

  it('Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y undo and redo with a menu open', async () => {
    await openApp(1366, 768);
    const t = session.store.getState().tracks[2];
    const slot = t.clips.findIndex((c) => !!c);
    const name = () => session.store.getState().tracks[2].clips[slot]!.name;
    const old = name();
    act(() => void session.accepted(renameClip(session.store, t.id, slot, 'Renamed Clip')));
    expect(name()).toBe('Renamed Clip');
    const openMenu = async () => {
      act(() => {
        selectTrack(t.id);
        selectSlot(t.id, slot);
      });
      await act(async () => {
        await wait(40);
      });
      const dots = document.getElementById(`pad-${t.id}-${slot}`)!.closest('[data-pad-cell]')!.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
      await real(() => userEvent.click(dots));
      expect(menu()).not.toBeNull();
      expect(menu()!.contains(document.activeElement)).toBe(true);
    };
    await openMenu();
    await real(() => userEvent.keyboard('{Control>}z{/Control}'));
    expect(name(), 'Ctrl+Z undid the rename').toBe(old);
    expect(menu(), 'the menu closed').toBeNull();
    await openMenu();
    await real(() => userEvent.keyboard('{Control>}{Shift>}z{/Shift}{/Control}'));
    expect(name(), 'Ctrl+Shift+Z redid it').toBe('Renamed Clip');
    expect(menu()).toBeNull();
    act(() => session.undo());
    await openMenu();
    await real(() => userEvent.keyboard('{Control>}y{/Control}'));
    expect(name(), 'Ctrl+Y redid it').toBe('Renamed Clip');
    // The More menu too.
    const more = document.querySelector<HTMLElement>('header[aria-label="Transport"] button[aria-label^="More"]')!;
    await real(() => userEvent.click(more));
    expect(menu()).not.toBeNull();
    await real(() => userEvent.keyboard('{Control>}z{/Control}'));
    expect(name()).toBe(old);
    expect(menu()).toBeNull();
  });

  it('Ctrl+A on the page never selects its text; in a text field it selects the field', async () => {
    await openApp(1366, 768);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    window.getSelection()?.removeAllRanges();
    await real(() => userEvent.keyboard('{Control>}a{/Control}'));
    expect(window.getSelection()?.toString() ?? '', 'page text selected').toBe('');
    // After a click on a pad (focus on a button), too.
    const p = document.querySelector<HTMLElement>('[id^="pad-t1-"]')!;
    await real(() => userEvent.click(p));
    await real(() => userEvent.keyboard('{Control>}a{/Control}'));
    expect(window.getSelection()?.toString() ?? '').toBe('');
    // A text field keeps its own Ctrl+A.
    const field = document.createElement('input');
    field.value = 'Bell Hook';
    document.body.append(field);
    try {
      await real(() => userEvent.click(field));
      await real(() => userEvent.keyboard('{Control>}a{/Control}'));
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, 9]);
    } finally {
      field.remove();
    }
  });
});

