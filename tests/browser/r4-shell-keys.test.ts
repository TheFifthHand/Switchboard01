/**
 * Shell keys with the real keyboard (shell-19, shell-12, shell-21):
 * - Ctrl+S never opens the browser's "Save page as": it saves now and says
 *   "Saved in this browser" with Export project file (also from a field);
 * - ? opens Help on its Shortcuts tab, but not while typing in a field; Esc
 *   closes it;
 * - Esc on the Welcome card is "Just look around";
 * - Enter in the Tempo field commits and gives the keys back (Space plays
 *   again, letters play notes).
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '../../src/app/instance';
import { button, click, closeShell, keys, openShell, settle, toasts, transport, until } from './r4-shell-harness';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeShell();
});

/** Whether the app took the next key down (default prevented), read after every other listener. */
function watchPrevented(): { last: () => boolean | null; stop(): void } {
  let last: boolean | null = null;
  const on = (e: KeyboardEvent) => {
    last = e.defaultPrevented;
  };
  window.addEventListener('keydown', on);
  return { last: () => last, stop: () => window.removeEventListener('keydown', on) };
}

const helpDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].find((d) => d.textContent?.startsWith('Help'));

describe('Ctrl+S', () => {
  it('saves now, says so with Export project file, and never lets the browser save the page; also from a field', async () => {
    await openShell();
    await keys('{Escape}');
    // A first change stores the preview; then another edit is pending.
    act(() => session.setBpm(118));
    await session.autosaver?.flush();
    act(() => session.setBpm(119));
    expect(session.autosaver!.status.getState().dirty).toBe(true);
    const flush = vi.spyOn(session.autosaver!, 'flush');
    const w = watchPrevented();
    await keys('{Control>}s{/Control}');
    expect(w.last()).toBe(true);
    expect(flush).toHaveBeenCalled();
    await until(() => !session.autosaver!.status.getState().dirty, 'the save');
    const toast = await until(() => toasts().find((t) => t.includes('Saved in this browser.')), 'the toast');
    expect(toast).toContain('Export project file');
    // From the Tempo field too (the browser's dialog would open over the app).
    const field = transport().querySelector<HTMLInputElement>('input')!;
    await click(field);
    expect(document.activeElement).toBe(field);
    await keys('{Control>}s{/Control}');
    expect(w.last()).toBe(true);
    w.stop();
  });
});

describe('? opens Help', () => {
  it('on the Shortcuts tab; not while typing in a field; Esc closes it', async () => {
    await openShell();
    await keys('{Escape}');
    await keys('?');
    const dialog = await until(helpDialog, 'Help');
    expect(dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Shortcuts');
    await keys('{Escape}');
    expect(helpDialog()).toBeUndefined();
    // Typing "?" into the Tempo field types it (the field keeps it until Esc), Help stays closed.
    const field = transport().querySelector<HTMLInputElement>('input')!;
    await click(field);
    await keys('?');
    expect(helpDialog()).toBeUndefined();
    await keys('{Escape}');
  });
});

describe('Esc on the Welcome card', () => {
  it('is Just look around: the card goes and nothing else changes', async () => {
    await openShell();
    const before = session.store.getState();
    await keys('{Escape}');
    expect(document.querySelector('[aria-labelledby="welcome-title"]')).toBeNull();
    expect(session.store.getState()).toBe(before);
  });
});

describe('Tempo field', () => {
  it('Enter commits and gives the keys back: Space plays, the field is not typed into', async () => {
    await openShell();
    await keys('{Escape}');
    const toggle = vi.spyOn(session, 'togglePlay').mockResolvedValue();
    const field = transport().querySelector<HTMLInputElement>('input')!;
    await click(field);
    await keys('{Control>}a{/Control}110{Enter}');
    expect(session.store.getState().bpm).toBe(110);
    expect(document.activeElement).not.toBe(field);
    await keys(' ');
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(field.value).not.toContain(' ');
    await settle();
  });

  it('a drag moves the tempo in whole BPM', async () => {
    await openShell();
    await keys('{Escape}');
    const field = transport().querySelector<HTMLInputElement>('input')!;
    const r = field.getBoundingClientRect();
    const { mouse } = await import('./r4-uikit-input');
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    await mouse('mouseMoved', { x, y });
    await mouse('mousePressed', { x, y });
    for (let i = 1; i <= 12; i++) await mouse('mouseMoved', { x, y: y - i * 3 }, { buttons: 1 });
    await mouse('mouseReleased', { x, y: y - 36 });
    await settle(100);
    const bpm = session.store.getState().bpm;
    expect(bpm).toBeGreaterThan(124);
    expect(Number.isInteger(bpm)).toBe(true);
    expect(button('Play', transport())).not.toBeNull();
  });
});
