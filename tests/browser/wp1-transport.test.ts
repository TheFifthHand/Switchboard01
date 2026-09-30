/**
 * The transport strip in the running app (real Chromium layout): the offline
 * readiness and Update states are on screen and fit the compact strip at the
 * target sizes without pushing anything off it; Update never reloads during
 * playback, a recording or with unsaved edits; the More menu carries both
 * where the strip has no room; and at 200 % zoom the strip (with Mute All)
 * stays on screen while the page scrolls.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { offlineStore, patchRuntime, runtimeStore, type OfflineState } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { deleteDb } from '../../src/persistence/db';
import { setGuideDone, setTipsEnabled } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';

let boot: BootInfo;

beforeEach(async () => {
  await deleteDb();
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
  });
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  act(() => {
    offlineStore.setState({ state: 'unsupported', apply: null });
    patchRuntime({ playing: false, recording: 'off', muteAll: false });
  });
  await session.autosaver?.flush();
  await deleteDb();
});

function setOffline(state: OfflineState, apply: (() => void) | null = null) {
  act(() => offlineStore.setState({ state, apply }));
}

/** Layout is measured in the app's own fonts (they load on first use) after the viewport settles. */
async function settle() {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '400 12px "IBM Plex Mono"', '500 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function openApp() {
  const m = mount(h(App, { boot }));
  // The app fills the window, as it does in #root.
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  await settle();
}

const bar = () => document.querySelector<HTMLElement>('header[aria-label="Transport"]')!;
const shown = (el: Element | null | undefined): el is HTMLElement => !!el && el.getBoundingClientRect().width > 1 && getComputedStyle(el).visibility !== 'hidden';

function buttonNamed(name: string | RegExp, root: ParentNode = document): HTMLButtonElement | null {
  for (const b of root.querySelectorAll<HTMLButtonElement>('button')) {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    if (typeof name === 'string' ? n === name : name.test(n)) return b;
  }
  return null;
}

/** Every visible control of the strip lies inside it (nothing pushed off the right edge). */
function expectStripFits(label: string) {
  const b = bar();
  const right = b.getBoundingClientRect().right;
  expect(b.scrollWidth, `${label}: strip overflows`).toBeLessThanOrEqual(b.clientWidth);
  const outside = [...b.querySelectorAll<HTMLElement>('button, [role="status"], [role="timer"], input')]
    .filter((el) => shown(el) && el.getBoundingClientRect().right > right + 0.5)
    .map((el) => el.getAttribute('aria-label') ?? el.textContent);
  expect(outside, `${label}: controls outside the strip`).toEqual([]);
}

async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    await act(async () => {
      await wait(15);
    });
    const v = fn();
    if (v) return v;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

describe('Offline readiness in the transport', () => {
  it('shows Caching…, Offline ready and Online only in the strip, and fits at 1366 x 768', async () => {
    await page.viewport(1366, 768);
    await openApp();
    for (const [state, text] of [
      ['installing', 'Caching…'],
      ['ready', 'Offline ready'],
      ['error', 'Online only'],
    ] as const) {
      setOffline(state);
      await settle();
      const status = [...bar().querySelectorAll<HTMLElement>('[role="status"]')].find((el) => el.textContent?.includes(text));
      expect(shown(status), `${text} visible`).toBe(true);
      // The icon carries the state on screen; the words are its text for screen readers and the tooltip.
      expect(status!.querySelector('svg')).not.toBeNull();
      expectStripFits(text);
    }
    // Saved and every wide-screen control stay in view next to it.
    setOffline('ready');
    for (const name of [/^Autosave: /, /^Undo/, /^Redo/, /^Projects \(open:/, 'Export']) expect(shown(buttonNamed(name, bar())), String(name)).toBe(true);
    expect(buttonNamed(/^Autosave: /, bar())!.textContent).toContain('Preview');
  });

  it('fits the strip at every width from 1024 to 1920 px, with an update waiting, a preview or a failed save', async () => {
    await openApp();
    const widths = [1024, 1100, 1180, 1280, 1320, 1366, 1440, 1541, 1600, 1680, 1760, 1920];
    const sweep = async (save: string) => {
      for (const w of widths) {
        await page.viewport(w, 900);
        await settle();
        for (const state of ['unsupported', 'ready', 'update-ready'] as const) {
          setOffline(state, state === 'update-ready' ? () => {} : null);
          await act(async () => {
            await wait(0);
          });
          expectStripFits(`${w} px, ${state}, ${save}`);
        }
      }
    };
    expect(buttonNamed(/^Autosave: /, bar())!.getAttribute('aria-label')).toContain('Preview');
    await sweep('preview');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    try {
      act(() => session.setBpm(109));
      await session.autosaver!.flush();
      await until(() => buttonNamed('Autosave: Not saved', bar()), 'Not saved');
      await sweep('not saved');
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });

  it('Update waits for playback and recordings to stop, writes pending edits first, then applies', async () => {
    await page.viewport(1366, 768);
    await openApp();
    let applied = 0;
    setOffline('update-ready', () => {
      applied += 1;
    });
    const update = buttonNamed('Update', bar())!;
    expect(shown(update)).toBe(true);
    expectStripFits('update ready');

    act(() => patchRuntime({ playing: true }));
    expect(update.disabled).toBe(true);
    act(() => patchRuntime({ playing: false, recording: 'performance' }));
    expect(update.disabled).toBe(true);
    act(() => patchRuntime({ recording: 'off' }));
    expect(update.disabled).toBe(false);

    // An edit that is still waiting to be saved is written before the page reloads.
    act(() => session.setBpm(111));
    expect(session.autosaver!.status.getState().dirty).toBe(true);
    await act(async () => {
      update.click();
    });
    await until(() => applied === 1, 'update applied');
    expect(session.autosaver!.status.getState().dirty).toBe(false);
  });

  it('Update does not reload while the latest edits could not be saved', async () => {
    await page.viewport(1366, 768);
    await openApp();
    let applied = 0;
    setOffline('update-ready', () => {
      applied += 1;
    });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    try {
      act(() => session.setBpm(112));
      await act(async () => {
        buttonNamed('Update', bar())!.click();
      });
      await until(() => runtimeStore.getState().notice?.text.startsWith('The update waits'), 'warning');
      expect(applied).toBe(0);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });

  it('where the strip has no room (1024-1179 px) the More menu shows the offline state and the Update action', async () => {
    await page.viewport(1100, 768);
    await openApp();
    setOffline('ready');
    const more = buttonNamed(/^More:/, bar())!;
    expect(shown(more)).toBe(true);
    await act(async () => {
      more.click();
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.textContent).toContain('Offline ready');
    await act(async () => {
      more.click();
    });

    let applied = 0;
    setOffline('update-ready', () => {
      applied += 1;
    });
    // The key says an update is waiting.
    expect(more.getAttribute('aria-label')).toContain('update ready');
    await act(async () => {
      more.click();
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Update to the new version'))!;
    expect(item).toBeTruthy();
    await act(async () => {
      item.click();
    });
    await until(() => applied === 1, 'update applied from the menu');
  });
});

describe('Transport at 200 % zoom', () => {
  it('stays on screen while the page scrolls, so Mute All is always one press away', async () => {
    await page.viewport(960, 470);
    await openApp();
    const scroller = document.scrollingElement!;
    await act(async () => {
      scroller.scrollTop = scroller.scrollHeight;
      await wait(30);
    });
    // The page really scrolled: the keyboard strip at the bottom is in view.
    expect(scroller.scrollTop).toBeGreaterThan(100);
    const keyboard = document.querySelector('footer')!.getBoundingClientRect();
    expect(keyboard.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    const mute = buttonNamed(/Mute All/, bar())!;
    const r = mute.getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
    // And it is the control on top at that spot (nothing scrolled over it).
    expect(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button')).toBe(mute);
    await act(async () => {
      mute.click();
    });
    expect(runtimeStore.getState().muteAll).toBe(true);
  });
});
