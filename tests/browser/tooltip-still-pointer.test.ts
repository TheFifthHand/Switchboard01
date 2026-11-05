/**
 * Tooltips open only for a pointer that moves over a control (or for
 * keyboard focus), with the real pointer in Chromium: a control that comes to
 * lie under a resting pointer (something dropped there, a dialog or menu
 * closing, a hint appearing) shows nothing until the pointer moves; then the
 * usual hover delay applies. Pressing a button hides its tip, as before.
 */
import { act, createElement as h, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TOOLTIP_DELAY_MS, Tooltip } from '../../src/ui/components';
import { cleanup, key, mount, nextFrame, wait } from './ui-harness';

afterEach(() => cleanup());

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

const bubble = () => [...document.querySelectorAll<HTMLElement>('body > div[aria-hidden="true"]')].find((d) => d.textContent?.includes('Silence everything')) ?? null;

/** A control at a fixed spot of the window (left 300, top 300), with a tip. */
function Target() {
  return h(Tooltip, {
    name: 'Mute All',
    tip: 'Silence everything at once.',
    children: h('button', { type: 'button', 'data-testid': 'target', style: { position: 'fixed', left: '300px', top: '300px', width: '120px', height: '40px' } }, 'Mute All'),
  });
}

/** A cover over the control's spot that goes away when clicked (a dialog's backdrop, a menu, a dragged pad). */
function Scene(props: { covered: boolean }) {
  const [covered, setCovered] = useState(props.covered);
  return h(
    'div',
    null,
    h(Target),
    covered &&
      h('div', {
        'data-testid': 'cover',
        style: { position: 'fixed', left: '250px', top: '250px', width: '220px', height: '140px', background: '#ddd', zIndex: 10 },
        onClick: () => setCovered(false),
      }),
  );
}

describe('tooltips and a pointer at rest', () => {
  it('a cover that goes away under a still pointer (a dialog or menu closing) shows no tip until the pointer moves', async () => {
    await page.viewport(900, 700);
    mount(h(Scene, { covered: true }));
    await act(async () => {
      await nextFrame();
    });
    const cover = document.querySelector<HTMLElement>('[data-testid="cover"]')!;
    // Click the cover where the control lies beneath it; the cover goes, the pointer stays.
    await real(() => userEvent.click(cover, { position: { x: 100, y: 70 } }));
    expect(document.querySelector('[data-testid="cover"]')).toBeNull();
    const target = document.querySelector<HTMLElement>('[data-testid="target"]')!;
    await wait(TOOLTIP_DELAY_MS + 300);
    expect(target.matches(':hover'), 'the pointer is over the control').toBe(true);
    expect(bubble(), 'no tip under a still pointer').toBeNull();
    // The pointer moves over it: the tip follows the usual delay.
    await real(() => userEvent.hover(target, { position: { x: 30, y: 20 } }));
    await wait(TOOLTIP_DELAY_MS + 150);
    expect(bubble(), 'the tip after the pointer moved').not.toBeNull();
  });

  it('a control that appears under the resting pointer (mounted there) shows no tip; one the pointer moves onto does', async () => {
    await page.viewport(900, 700);
    const rest = document.createElement('div');
    rest.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px';
    document.body.append(rest);
    await real(() => userEvent.hover(rest, { position: { x: 340, y: 320 } }));
    rest.remove();
    mount(h(Target));
    await act(async () => {
      await nextFrame();
    });
    await wait(TOOLTIP_DELAY_MS + 300);
    expect(bubble()).toBeNull();
    await real(() => userEvent.hover(document.querySelector<HTMLElement>('[data-testid="target"]')!, { position: { x: 60, y: 10 } }));
    await wait(TOOLTIP_DELAY_MS + 150);
    expect(bubble()).not.toBeNull();
  });

  it('keyboard focus opens it at once, wherever the pointer is', async () => {
    await page.viewport(900, 700);
    mount(h(Target));
    await act(async () => {
      await nextFrame();
    });
    const target = document.querySelector<HTMLElement>('[data-testid="target"]')!;
    key(document.body, 'keydown', { key: 'Tab' });
    act(() => target.focus({ focusVisible: true } as FocusOptions));
    await act(async () => {
      await nextFrame();
    });
    expect(bubble()).not.toBeNull();
  });
});
