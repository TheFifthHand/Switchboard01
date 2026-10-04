/**
 * Smaller kit fixes, in real Chromium:
 * - a switch that is on fills its slot (amber; teal for Musical Assist) and says its state in the
 *   UI font, 11 px / 600;
 * - a small button keeps a 32 x 32 px target whatever a view sets;
 * - a dialog adds no banner/contentinfo landmarks and marks body[data-modal-open] while open;
 * - a tooltip opens for focus the user moved with the keyboard (Tab), not for focus the app moved
 *   after another key (Delete), so it never lands on a button nobody went to;
 * - the new icons; useRafLoop's frame cap and its pause while the tab is hidden; useElementSize
 *   measures before the first paint.
 */
import { act, createElement as h, Fragment, useRef, useState, type KeyboardEvent } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { Button, Dialog, Icon, IconButton, Switch, Tooltip } from '../../src/ui/components';
import { useElementSize } from '../../src/ui/hooks/useElementSize';
import { useRafLoop } from '../../src/ui/hooks/useRafLoop';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click, settleFrames } from './r4-uikit-input';

afterEach(cleanup);

async function keys(text: string) {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.keyboard(text);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames();
}

describe('Switch', () => {
  it('on fills the slot with its colour; the state word is Inter 11 px / 600', () => {
    const m = mount(h(Fragment, null, h(Switch, { label: 'Musical Assist', checked: true, tone: 'teal', onChange: () => {}, onText: 'IN KEY', offText: 'CHROMATIC' }), h(Switch, { label: 'Hear the input', checked: false, onChange: () => {} }), h(Switch, { label: 'Metronome', checked: true, onChange: () => {} })));
    const [assist, off, metronome] = [...m.container.querySelectorAll<HTMLElement>('[role="switch"]')];
    const slot = (s: HTMLElement) => getComputedStyle(s.querySelector('[class*="slot"]')!).backgroundImage;
    expect(slot(assist)).not.toBe(slot(off));
    expect(slot(metronome)).not.toBe(slot(off));
    expect(slot(assist)).not.toBe(slot(metronome));
    const state = getComputedStyle(assist.querySelector('[class*="state"]')!);
    expect(state.fontFamily).toContain('Inter');
    expect([state.fontSize, state.fontWeight]).toEqual(['11px', '600']);
  });
});

describe('Button', () => {
  it("size 'sm' keeps a 32 x 32 px target even when a view squeezes it", () => {
    const style = document.createElement('style');
    style.textContent = '.squeeze { height: 24px !important; width: 24px; }';
    document.head.append(style);
    try {
      const m = mount(h(Fragment, null, h(IconButton, { icon: 'close', label: 'Remove', size: 'sm', className: 'squeeze' }), h(Button, { size: 'sm' }, 'Ok')));
      for (const b of m.container.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        expect(Math.min(r.width, r.height), b.textContent ?? '').toBeGreaterThanOrEqual(32);
      }
    } finally {
      style.remove();
    }
  });
});

describe('Dialog', () => {
  function Host() {
    const [open, setOpen] = useState(0);
    return h(
      Fragment,
      null,
      h('button', { 'data-testid': 'open', onClick: () => setOpen(1) }, 'Open'),
      h(Dialog, { open: open >= 1, onClose: () => setOpen(0), title: 'Export audio', actions: h(Button, { onClick: () => setOpen(2) }, 'More') }, h('p', null, 'Body')),
      h(Dialog, { open: open >= 2, onClose: () => setOpen(1), title: 'Details', actions: h(Button, { onClick: () => setOpen(1) }, 'Done') }, h('p', null, 'Inner')),
    );
  }

  it('has no banner or contentinfo landmarks inside, and marks body while any dialog is open', async () => {
    const m = mount(h(Host));
    expect(document.body.hasAttribute('data-modal-open')).toBe(false);
    await click(centre(m.container.querySelector('[data-testid="open"]')!));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll('header, footer, [role="banner"], [role="contentinfo"]')).toHaveLength(0);
    expect(document.body.hasAttribute('data-modal-open')).toBe(true);
    // A second dialog on top, then closed: the first is still open, so the mark stays.
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'More')!.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'Done')!.click());
    expect(document.body.hasAttribute('data-modal-open')).toBe(true);
    await keys('{Escape}');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.body.hasAttribute('data-modal-open')).toBe(false);
  });
});

describe('Tooltip and focus', () => {
  const bubble = () => [...document.querySelectorAll<HTMLElement>('body > div[aria-hidden="true"]')].find((d) => d.textContent?.includes('Adds every scene once')) ?? null;

  function Lane() {
    const [empty, setEmpty] = useState(false);
    const add = useRef<HTMLButtonElement>(null);
    return h(
      'div',
      null,
      h(
        'button',
        {
          'data-testid': 'block',
          onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key !== 'Delete') return;
            setEmpty(true);
            // The app moves focus to what replaced the deleted block.
            setTimeout(() => add.current?.focus(), 0);
          },
        },
        'Groove',
      ),
      empty && h(Tooltip, { name: 'Add all 4 scenes', tip: 'Adds every scene once, in row order.', children: h('button', { ref: add, 'data-testid': 'add' }, 'Add all 4 scenes') }),
      h(Tooltip, { name: 'Fit song', tip: 'Adds every scene once, as a test of Tab.', children: h('button', { 'data-testid': 'fit' }, 'Fit song') }),
    );
  }

  it('focus the app moves after Delete opens no tip; Tab to a control does', async () => {
    const m = mount(h(Lane));
    await click(centre(m.container.querySelector('[data-testid="block"]')!));
    await keys('{Delete}');
    await wait(50);
    await settleFrames();
    const add = m.container.querySelector<HTMLElement>('[data-testid="add"]')!;
    expect(document.activeElement).toBe(add);
    expect(add.matches(':focus-visible')).toBe(true);
    expect(bubble()).toBeNull();
    // The user tabs on: the next control's tip opens at once.
    await keys('{Tab}');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('fit');
    expect(bubble()?.textContent).toContain('as a test of Tab');
  });
});

describe('icons', () => {
  it('pencil, scissors, cut, join, layers and scene are drawn', () => {
    const names = ['pencil', 'scissors', 'cut', 'join', 'layers', 'scene'] as const;
    const m = mount(h(Fragment, null, ...names.map((n) => h(Icon, { key: n, name: n }))));
    for (const n of names) {
      const svg = m.container.querySelector(`svg[data-icon="${n}"]`)!;
      expect(svg.children.length, n).toBeGreaterThan(0);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('hooks', () => {
  it('useRafLoop with an fps cap calls at most that often', async () => {
    let calls = 0;
    function Host() {
      useRafLoop(() => {
        calls += 1;
      }, true, { fps: 20 });
      return null;
    }
    mount(h(Host));
    await wait(1000);
    expect(calls).toBeGreaterThan(8);
    expect(calls).toBeLessThanOrEqual(22);
  });

  it('useRafLoop makes no calls while the tab is hidden, and picks up again when it is shown', async () => {
    // The page's visibility, as the browser reports it to the loop (the test runner itself must keep running).
    const setHidden = (hidden: boolean) => {
      if (hidden) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      } else {
        delete (document as { hidden?: boolean }).hidden;
        delete (document as { visibilityState?: string }).visibilityState;
      }
      document.dispatchEvent(new Event('visibilitychange'));
    };
    let calls = 0;
    let firstDelta = 0;
    function Host() {
      useRafLoop((dt) => {
        calls += 1;
        if (calls === 1) firstDelta = dt;
      }, true);
      return null;
    }
    try {
      // Mounted while hidden: it does not start.
      setHidden(true);
      mount(h(Host));
      await wait(250);
      expect(calls).toBe(0);
      setHidden(false);
      await wait(250);
      expect(calls).toBeGreaterThan(3);
      // The first call after showing measures from the moment it was shown, not from mount.
      expect(firstDelta).toBeLessThan(120);
      // Hidden while running: it stops.
      setHidden(true);
      await settleFrames(2);
      const atHide = calls;
      await wait(300);
      expect(calls).toBe(atHide);
      setHidden(false);
      await wait(250);
      expect(calls).toBeGreaterThan(atHide + 3);
    } finally {
      if (Object.prototype.hasOwnProperty.call(document, 'hidden')) setHidden(false);
    }
  });

  it('useElementSize has the real size before the first paint (no frame laid out for zero)', () => {
    const seen: { width: number; height: number }[] = [];
    function Host() {
      const ref = useRef<HTMLDivElement>(null);
      const size = useElementSize(ref);
      seen.push(size);
      return h('div', { ref, style: { width: '240px', height: '40px' } });
    }
    mount(h(Host));
    // mount() flushes React synchronously (act): no animation frame has run yet.
    expect(seen.at(-1)).toEqual({ width: 240, height: 40 });
  });
});
