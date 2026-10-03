/**
 * Help and the More menu (shell-12, shell-18), with real clicks and keys:
 * - ⋯ → Help… opens Help; its Shortcuts tab lists every row of the one
 *   shortcuts table, its Guides tab the three walkthroughs with "Show the
 *   quick guide again" and "Show hints again" (which work), its About tab the
 *   version and what is new;
 * - the More menu: a waiting Update first, then the actions (with New
 *   project… and Help…), and the offline state last as plain text that takes
 *   no focus and is never cut off; focus starts on the first action.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { offlineStore } from '../../src/app/runtime';
import { SHORTCUT_GROUPS } from '../../src/app/views/hints/shortcuts';
import { WALKTHROUGHS } from '../../src/app/views/hints/guides';
import { hintsStore } from '../../src/app/views/hints/hintsState';
import { setTipsEnabled, uiStore } from '../../src/state/uiStore';
import { button, click, closeShell, keys, openShell, settle, transport, until } from './r4-shell-harness';

afterEach(async () => {
  act(() => offlineStore.setState({ state: 'unsupported', apply: null }));
  await closeShell();
});

const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="More"]');
const items = () => [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])];
const helpDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].find((d) => d.textContent?.startsWith('Help'));

async function openMore() {
  await click(button(/^More/, transport())!);
  return until(menu, 'the More menu');
}

describe('Help', () => {
  it('⋯ → Help… opens it; Shortcuts come from the one table; Guides and About', async () => {
    await openShell();
    await keys('{Escape}');
    await openMore();
    await click(items().find((i) => i.textContent?.includes('Help…'))!);
    const dialog = await until(helpDialog, 'Help');
    // Every shortcut of the table, once.
    const rows = [...dialog.querySelectorAll<HTMLElement>('[data-shortcut]')].map((r) => r.dataset.shortcut);
    expect(rows).toEqual(SHORTCUT_GROUPS.flatMap((g) => g.items.map((s) => s.id)));
    for (const g of SHORTCUT_GROUPS) expect(dialog.textContent).toContain(g.title);
    expect(dialog.textContent).toContain('Ctrl+S');
    // No view-switching key: F6 and Ctrl+digits belong to the browser.
    expect(dialog.textContent).not.toMatch(/F6|Ctrl\+[1-4]\b/);
    // Guides.
    await click([...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Guides')!);
    for (const w of WALKTHROUGHS) {
      expect(dialog.textContent).toContain(w.title);
      for (const s of w.steps) expect(dialog.textContent).toContain(s);
    }
    expect(button('Show the quick guide again', dialog)).not.toBeNull();
    // About: the version (this test build has no version define: "development") and what is new.
    await click([...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'About')!);
    expect(dialog.querySelector('[data-testid="app-version"]')?.textContent).toMatch(/^version (\d+\.\d+\.\d+|development)$/);
    expect(dialog.textContent).toContain('What’s new in');
    await click(button('Done', dialog)!);
    expect(helpDialog()).toBeUndefined();
  });

  it('Show hints again starts the hints over and turns Tips on; Show the quick guide again opens the guide', async () => {
    await openShell();
    await keys('{Escape}');
    act(() => {
      hintsStore.setState({ started: true, hidden: true, done: ['pad', 'mute'], finished: false });
      setTipsEnabled(false);
    });
    await keys('?');
    let dialog = await until(helpDialog, 'Help');
    await click([...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Guides')!);
    await click(button('Show hints again', dialog)!);
    expect(helpDialog()).toBeUndefined();
    expect(hintsStore.getState()).toMatchObject({ started: true, hidden: false, done: [] });
    expect(uiStore.getState().tipsEnabled).toBe(true);
    await until(() => document.querySelector('[data-hint="pad"]'), 'the first hint');
    await keys('?');
    dialog = await until(helpDialog, 'Help');
    await click([...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Guides')!);
    await click(button('Show the quick guide again', dialog)!);
    await until(() => document.querySelector('[data-guide-step="play"]'), 'the guide');
    await keys('{Escape}');
  });
});

describe('the More menu', () => {
  it('focus starts on the first action; New project… opens the Starters; the offline state closes the menu as plain text', async () => {
    await openShell();
    await keys('{Escape}');
    act(() => offlineStore.setState({ state: 'ready', apply: null }));
    await openMore();
    const list = items();
    expect(list[0].textContent).toContain('Undo');
    await until(() => document.activeElement === list[0], 'focus on the first action');
    const words = list.map((i) => i.textContent ?? '');
    for (const w of ['Redo', 'Show every control (Advanced)', 'Tips', 'New project…', 'Projects…', 'Export WAV…', 'MIDI & audio…', 'Help…']) expect(words.some((x) => x.includes(w)), w).toBe(true);
    // The offline state: the menu's last line, a status (not a menu item), its words whole.
    const status = menu()!.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toContain('Offline ready');
    expect(status.textContent).toContain('Works without internet');
    expect(status.closest('[role="menuitem"]')).toBeNull();
    expect(status.tabIndex).toBe(-1);
    const all = [...menu()!.children];
    expect(all.indexOf(status)).toBe(all.length - 1);
    for (const el of status.querySelectorAll('span')) expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth + 1);
    // Arrow keys never land on it: from the last action, Down goes round to the first.
    await keys('{End}');
    expect(document.activeElement?.textContent).toContain('Help…');
    await keys('{ArrowDown}');
    expect(document.activeElement).toBe(items()[0]);
    // New project… opens the project library on its Starters tab.
    await click(items().find((i) => i.textContent?.includes('New project…'))!);
    const lib = await until(() => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]'), 'the library');
    expect(lib.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Starters');
    await keys('{Escape}');
    await settle();
  });

  it('a waiting Update is the first row', async () => {
    await openShell();
    await keys('{Escape}');
    act(() => offlineStore.setState({ state: 'update-ready', apply: () => undefined }));
    await openMore();
    expect(items()[0].textContent).toContain('Update to the new version');
    await keys('{Escape}');
  });
});
