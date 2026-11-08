/**
 * Toasts never cover what is being worked on (real Chromium, real mouse):
 * - they sit in one place in every view, the bottom centre on the keyboard strip's upper half
 *   ([data-toast-floor]): never above it (the pads' action bar, the step lanes) and never on
 *   the top band, where views keep their headers, tabs, the song's ruler and sections and the
 *   editing fields; the keys' lower half stays clickable;
 * - while a menu is open (body[data-popover-open]) the menu is above the stack, which is never
 *   over it; the toast keeps its Undo;
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

/** A stand-in for the keyboard strip: fixed to the bottom, `height` px tall, marked as the toasts' floor. */
function Keyboard({ height }: { height: number }) {
  return h('div', { 'data-testid': 'keys', 'data-toast-floor': '', style: { position: 'fixed', left: 0, right: 0, bottom: 0, height: `${height}px`, background: '#333' } });
}

/** Tabs and a field along the top band (a view's header), where toasts used to go. */
function TopControls() {
  const tab = (label: string, left: number) => h('button', { key: label, type: 'button', role: 'tab', 'data-testid': `tab-${label}`, style: { position: 'fixed', top: '72px', left: `${left}px`, width: '64px', height: '30px' } }, label);
  return h('div', null, tab('Loops', 30), tab('Drums', 100), tab('Notes', 170), tab('Steps', 240), h('input', { 'data-testid': 'name', 'aria-label': 'Loop name', style: { position: 'fixed', top: '72px', left: '420px', width: '520px', height: '30px' } }));
}

describe('where toasts sit', () => {
  it('at the bottom centre, on the keyboard strip’s upper half: never over a bar just above it nor the header band, which stay clickable', async () => {
    document.documentElement.style.setProperty('--transport-h', '64px');
    let clicked = '';
    mount(h(ToastProvider, null, h(Grab), h(Keyboard, { height: 101 }), h(TopControls), h('button', { type: 'button', 'data-testid': 'bar', style: { position: 'fixed', left: '16px', right: '16px', bottom: '109px', height: '36px' } }, 'Duplicate')));
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-testid^="tab-"], [data-testid="bar"]')) b.onclick = () => (clicked = b.textContent ?? '');
    const { toast } = await show('Inserted 4 bars at bar 25.');
    const r = toast.getBoundingClientRect();
    const keys = document.querySelector('[data-testid="keys"]')!.getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(keys.top - 1);
    expect(r.bottom).toBeLessThanOrEqual(keys.top + 56);
    expect(Math.abs((r.left + r.right) / 2 - innerWidth / 2)).toBeLessThanOrEqual(1);
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="tab-"], [data-testid="name"], [data-testid="bar"]')) {
      expect(overlaps(r, el.getBoundingClientRect()), el.dataset.testid).toBe(false);
    }
    await click(centre(document.querySelector<HTMLElement>('[data-testid="tab-Steps"]')!));
    expect(clicked).toBe('Steps');
    await click(centre(document.querySelector<HTMLElement>('[data-testid="bar"]')!, 0.5, 0.5));
    expect(clicked).toBe('Duplicate');
    // The keys' lower half is the keys.
    const low = { x: innerWidth / 2, y: keys.bottom - 12 };
    expect(document.elementFromPoint(low.x, low.y)?.getAttribute('data-testid')).toBe('keys');
  });

  it('the same place for every toast: a second one stacks above the first', async () => {
    mount(h(ToastProvider, null, h(Grab), h(Keyboard, { height: 90 })));
    const { toast: first } = await show('Copied.');
    const { toast: second } = await show('Pasted Bounce on Groove.');
    const keys = document.querySelector('[data-testid="keys"]')!.getBoundingClientRect();
    expect(first.getBoundingClientRect().bottom).toBeLessThanOrEqual(second.getBoundingClientRect().top + 1);
    expect(second.getBoundingClientRect().bottom).toBeLessThanOrEqual(keys.top + 56);
    expect(second.getBoundingClientRect().top).toBeGreaterThanOrEqual(keys.top - 1);
  });

  it('without a keyboard strip they sit just above the window’s bottom edge', async () => {
    mount(h(ToastProvider, null, h(Grab)));
    const { toast } = await show('Deleted loop.');
    const r = toast.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(innerHeight - 8);
    expect(r.bottom).toBeGreaterThanOrEqual(innerHeight - 20);
  });

  it('go above guidance on screen (the hint chip) instead of covering it', async () => {
    mount(h(ToastProvider, null, h(Grab), h(Keyboard, { height: 101 })));
    const chip = document.createElement('aside');
    chip.setAttribute('data-toast-below', '');
    chip.setAttribute('data-ready', '');
    chip.style.cssText = `position:fixed;left:${innerWidth / 2 - 200}px;width:400px;bottom:60px;height:40px`;
    document.body.append(chip);
    try {
      const { toast } = await show('Added Root Pulse to Bass at bar 1.');
      expect(overlaps(toast.getBoundingClientRect(), chip.getBoundingClientRect())).toBe(false);
      expect(toast.getBoundingClientRect().bottom).toBeLessThanOrEqual(chip.getBoundingClientRect().top);
    } finally {
      chip.remove();
    }
  });
});

describe('toasts and an open menu', () => {
  it('stay in their place, under the menu (it is never covered); Undo still works', async () => {
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
      const keys = document.querySelector('[data-testid="keys"]')!.getBoundingClientRect();
      expect(r.bottom).toBeLessThanOrEqual(keys.top + 56);
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

  it('stay in place when the menu closes, and come back above other layers', async () => {
    mount(h(ToastProvider, null, h(Grab), h(Keyboard, { height: 90 })));
    document.documentElement.style.setProperty('--transport-h', '60px');
    document.body.setAttribute('data-popover-open', '');
    const { toast } = await show('Copied.');
    const before = toast.getBoundingClientRect().top;
    expect(toast.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight - 90 + 56);
    document.body.removeAttribute('data-popover-open');
    await act(async () => {
      await wait(50);
    });
    expect(toast.getBoundingClientRect().top).toBeCloseTo(before, 0);
    expect(Number(getComputedStyle(toast.parentElement!).zIndex)).toBeGreaterThan(900);
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
