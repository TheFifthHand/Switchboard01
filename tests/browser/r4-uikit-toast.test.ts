/**
 * Toasts never cover what is being played or chosen (real Chromium, real mouse):
 * - they sit above the on-screen keyboard, whose height the KeyboardStrip writes to --keyboard-h;
 * - while a menu is open (body[data-popover-open]) the stack moves to the top, under the transport
 *   (--transport-h), and below the menu, which is never covered; the toast keeps its Undo;
 * - while a modal dialog is open (Dialog sets body[data-modal-open]) the action key is hidden;
 * - a caller's duration wins over the 8 s default for a toast with an action.
 */
import { act, createElement as h, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { Button, Dialog, ToastProvider, useToasts, type ToastApi } from '../../src/ui/components';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click } from './r4-uikit-input';

let api: ToastApi | null = null;
function Grab() {
  api = useToasts();
  return null;
}

beforeEach(async () => {
  await page.viewport(1366, 768);
  document.documentElement.style.removeProperty('--keyboard-h');
  document.body.removeAttribute('data-popover-open');
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--keyboard-h');
  document.documentElement.style.removeProperty('--transport-h');
  document.body.removeAttribute('data-popover-open');
  api = null;
});

const toastWith = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].find((el) => el.textContent?.includes(text)) ?? null;
const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function show(message: string, extra: Record<string, unknown> = {}) {
  let undone = 0;
  act(() => {
    api!.show({ message, action: { label: 'Undo', onAction: () => (undone += 1) }, ...extra });
  });
  await act(async () => {
    await wait(200); // past the entrance
    // On a busy machine the entrance can still be running: measure where the card comes to rest.
    const t = toastWith(message);
    if (t) await Promise.all(t.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
  return { toast: toastWith(message)!, undone: () => undone };
}

/** A stand-in for the keyboard strip: fixed to the bottom, `height` px tall. */
function Keyboard({ height }: { height: number }) {
  return h('div', { 'data-testid': 'keys', style: { position: 'fixed', left: 0, right: 0, bottom: 0, height: `${height}px`, background: '#333' } });
}

describe('toasts and the keyboard strip', () => {
  it('sit above the keyboard: never on the element at --keyboard-h', async () => {
    mount(h(ToastProvider, null, h(Grab), h(Keyboard, { height: 101 })));
    document.documentElement.style.setProperty('--keyboard-h', '101px');
    const { toast } = await show('Moved Stabs to Groove.');
    const keys = document.querySelector('[data-testid="keys"]')!.getBoundingClientRect();
    const r = toast.getBoundingClientRect();
    expect(overlaps(r, keys)).toBe(false);
    expect(r.bottom).toBeLessThanOrEqual(keys.top - 8);
    // What is under a key's centre is the key, not the toast.
    const p = centre(document.querySelector('[data-testid="keys"]')!, 0.5, 0.5);
    expect(document.elementFromPoint(p.x, p.y)?.getAttribute('data-testid')).toBe('keys');
  });

  it('with no keyboard on screen they sit near the bottom edge', async () => {
    mount(h(ToastProvider, null, h(Grab)));
    const { toast } = await show('Deleted clip.');
    expect(innerHeight - toast.getBoundingClientRect().bottom).toBeLessThanOrEqual(16);
  });

  it('also clear a bottom bar marked data-toast-avoid above the keyboard (Play’s pad actions); its keys stay clickable', async () => {
    let clicked = 0;
    const bar = h(
      'div',
      { 'data-toast-avoid': '', 'data-testid': 'bar', style: { position: 'fixed', left: '200px', right: '200px', bottom: '113px', height: '40px', background: '#555' } },
      h('button', { type: 'button', 'data-testid': 'dup', style: { width: '100%', height: '100%' }, onClick: () => (clicked += 1) }, 'Duplicate'),
    );
    mount(h(ToastProvider, null, h(Grab), h(Keyboard, { height: 101 }), bar));
    document.documentElement.style.setProperty('--keyboard-h', '101px');
    const { toast } = await show('Duplicated Stabs.');
    const barBox = document.querySelector('[data-testid="bar"]')!.getBoundingClientRect();
    const r = toast.getBoundingClientRect();
    expect(overlaps(r, barBox)).toBe(false);
    expect(r.bottom).toBeLessThanOrEqual(barBox.top - 8);
    await click(centre(document.querySelector<HTMLElement>('[data-testid="dup"]')!));
    expect(clicked).toBe(1);
  });

  it('ignore a marked element off to the side or in the top half of the window', async () => {
    const side = h('div', { 'data-toast-avoid': '', style: { position: 'fixed', left: 0, width: '120px', bottom: 0, height: '300px' } });
    const top = h('div', { 'data-toast-avoid': '', style: { position: 'fixed', left: 0, right: 0, top: '60px', height: '80px' } });
    mount(h(ToastProvider, null, h(Grab), side, top));
    const { toast } = await show('Renamed Groove.');
    expect(innerHeight - toast.getBoundingClientRect().bottom).toBeLessThanOrEqual(16);
  });
});

describe('toasts and an open menu', () => {
  it('move to the top under the transport and stay below the menu; Undo still works', async () => {
    mount(h(ToastProvider, null, h(Grab), h(Keyboard, { height: 101 })));
    document.documentElement.style.setProperty('--keyboard-h', '101px');
    // A menu that reaches down to where toasts sit, with its last row over the toast's place.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.style.cssText = 'position:fixed;left:420px;width:400px;top:60px;bottom:40px;z-index:850;background:#fff';
    const row = document.createElement('div');
    row.textContent = 'Remove from song';
    row.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:32px';
    menu.append(row);
    document.body.append(menu);
    document.body.setAttribute('data-popover-open', '');
    try {
      const { toast, undone } = await show('Drums off in Groove.');
      const r = toast.getBoundingClientRect();
      const transportH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--transport-h'));
      expect(r.top).toBeCloseTo(transportH + 8, 0);
      // The menu's last row is the menu, everywhere.
      for (const fx of [0.1, 0.5, 0.9]) {
        const p = centre(row, fx, 0.5);
        expect(row.contains(document.elementFromPoint(p.x, p.y))).toBe(true);
      }
      // Where the menu is not, the toast's Undo is visible and works with a real click.
      menu.style.left = '900px';
      const undo = [...toast.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
      expect(undo.getBoundingClientRect().width).toBeGreaterThan(0);
      await click(centre(undo));
      expect(undone()).toBe(1);
    } finally {
      menu.remove();
    }
  });

  it('come back above the keyboard when the menu closes', async () => {
    mount(h(ToastProvider, null, h(Grab), h(Keyboard, { height: 90 })));
    document.documentElement.style.setProperty('--keyboard-h', '90px');
    document.body.setAttribute('data-popover-open', '');
    const { toast } = await show('Copied.');
    expect(toast.getBoundingClientRect().top).toBeLessThan(200);
    document.body.removeAttribute('data-popover-open');
    await act(async () => {
      await wait(50);
      // The move replays the short entrance (8 px slide); measure where it comes to rest.
      await Promise.all(toast.getAnimations().map((a) => a.finished.catch(() => undefined)));
    });
    expect(toast.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight - 90 - 8);
  });
});

describe('toasts and a modal dialog', () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return h(
      ToastProvider,
      null,
      h(Grab),
      h(Button, { id: 'open-export', onClick: () => setOpen(true) }, 'Export'),
      h(Dialog, { open, onClose: () => setOpen(false), title: 'Export audio', actions: h(Button, { onClick: () => setOpen(false) }, 'Close') }, h('p', null, 'Rendering…')),
    );
  }

  it('hide their action key while the dialog is open and show it again after', async () => {
    mount(h(Host));
    const { toast } = await show('Undid: Move block.', { action: { label: 'Redo', onAction: () => {} } });
    const redo = () => [...toast.querySelectorAll('button')].find((b) => b.textContent === 'Redo')!;
    expect(getComputedStyle(redo()).display).not.toBe('none');
    await click(centre(document.getElementById('open-export')!));
    expect(document.body.hasAttribute('data-modal-open')).toBe(true);
    expect(getComputedStyle(redo()).display).toBe('none');
    // The dialog closes: the key is back.
    act(() => {
      (document.querySelector('[role="dialog"] button[aria-label="Close"]') as HTMLButtonElement).click();
    });
    expect(document.body.hasAttribute('data-modal-open')).toBe(false);
    expect(getComputedStyle(redo()).display).not.toBe('none');
  });
});

describe('durations', () => {
  it('a caller may shorten a toast with an action (Undid / Redid use 3 s)', async () => {
    mount(h(ToastProvider, null, h(Grab)));
    await show('Undid: Mute Drums.', { duration: 700 });
    expect(toastWith('Undid: Mute Drums.')).not.toBeNull();
    await act(async () => {
      await wait(700);
    });
    expect(toastWith('Undid: Mute Drums.')).toBeNull();
  });
});
