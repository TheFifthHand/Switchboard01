/**
 * The Pad's `action` (what a press does, "▶ Play" / "■ Stop") in real
 * Chromium layout, under a real mouse and keyboard: it shows in the pad's
 * bottom-right corner only while the pointer is over the pad or it has
 * keyboard focus; the state words stay beside it where they fit and step out
 * of sight where they do not (coming back when the pointer leaves); nothing
 * else in the pad moves, and a pad whose action is null (nothing to say now)
 * is laid out exactly like one with an action. Pads without the prop are
 * unchanged.
 */
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { Pad } from '../../src/ui/components';
import type { PadAction } from '../../src/ui/components/Pad';
import { centre, mouse, settleFrames } from './r4-uikit-input';
import { cleanup, mount } from './ui-harness';

afterEach(async () => {
  cleanup();
  await mouse('mouseMoved', { x: 1, y: 1 });
});

const STOP: PadAction = { icon: 'stop', text: 'Stop' };

function pad(w: number, hgt: number, props: Record<string, unknown> = {}) {
  const m = mount(
    h('div', { style: { width: `${w}px`, height: `${hgt}px`, display: 'flex' } }, h(Pad, { state: 'playing', label: 'Bounce', sublabel: '2 bars', labelSize: 'lg', action: STOP, onPress: () => {}, ...props })),
    { width: w + 40 },
  );
  return m.container.querySelector<HTMLButtonElement>('button')!;
}

const action = (el: Element) => el.querySelector<HTMLElement>('[data-pad-action]');
const shown = (el: HTMLElement | null) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
const leaf = (el: Element, text: string) => [...el.querySelectorAll<HTMLElement>('span')].find((s) => s.textContent === text && s.children.length === 0)!;
/** The words are on screen: inside the pad (a caption that stepped aside sits below it, cut off). */
function onScreen(el: HTMLElement, pad: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const p = pad.getBoundingClientRect();
  return r.width > 0 && r.top >= p.top && r.bottom <= p.bottom && r.left >= p.left && r.right <= p.right;
}
const box = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

async function away() {
  await mouse('mouseMoved', { x: 1, y: 1 });
  await settleFrames();
}

describe('the action key', () => {
  it('shows in the bottom-right corner only under the pointer; the state words stay beside it where there is room', async () => {
    const p = pad(170, 120);
    await away();
    expect(shown(action(p))).toBe(false);
    const name = box(leaf(p, 'Bounce'));
    const caption = box(leaf(p, 'Playing'));
    await mouse('mouseMoved', centre(p));
    await settleFrames();
    const a = action(p)!;
    expect(shown(a)).toBe(true);
    expect(a.textContent).toBe('Stop');
    const ar = a.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    expect(pr.right - ar.right).toBeLessThan(10);
    expect(pr.bottom - ar.bottom).toBeLessThan(12);
    // The name and the state words did not move.
    expect(box(leaf(p, 'Bounce'))).toEqual(name);
    expect(box(leaf(p, 'Playing'))).toEqual(caption);
    expect(onScreen(leaf(p, 'Playing'), p)).toBe(true);
    await away();
    expect(shown(action(p))).toBe(false);
  });

  it('on a narrow pad the state words step out of sight while it shows, and come back', async () => {
    const p = pad(92, 66, { state: 'stopping', caption: 'Stops at bar 12', action: { icon: 'play', text: 'Play' } });
    await away();
    const words = leaf(p, 'Stops at bar 12');
    expect(onScreen(words, p)).toBe(true);
    await mouse('mouseMoved', centre(p));
    await settleFrames();
    expect(shown(action(p))).toBe(true);
    expect(onScreen(words, p)).toBe(false);
    // The key itself is whole, inside the pad.
    expect(onScreen(action(p)!, p)).toBe(true);
    await away();
    expect(onScreen(words, p)).toBe(true);
  });

  it('shows on keyboard focus too, never on a disabled pad', async () => {
    const p = pad(170, 120);
    const off = pad(170, 120, { disabled: true });
    await away();
    // Keyboard focus: Tab onto the pad from a key just before it.
    const before = document.createElement('button');
    before.textContent = 'before';
    document.body.prepend(before);
    act(() => before.focus());
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    g.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await userEvent.keyboard('{Tab}');
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await settleFrames();
    expect(document.activeElement).toBe(p);
    expect(shown(action(p))).toBe(true);
    before.remove();
    await mouse('mouseMoved', centre(off));
    await settleFrames();
    expect(shown(action(off))).toBe(false);
  });

  it('a pad with nothing to say now (null) is laid out exactly like one with an action; a pad without the prop is unchanged', async () => {
    await away();
    const withAction = pad(110, 68, { action: STOP });
    const nothing = pad(110, 68, { action: null });
    const plain = pad(110, 68, { action: undefined });
    expect(action(nothing)).toBeNull();
    expect(action(plain)).toBeNull();
    const at = (p: HTMLElement, text: string) => {
      const r = leaf(p, text).getBoundingClientRect();
      const o = p.getBoundingClientRect();
      return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
    };
    for (const text of ['Bounce', '2 bars', 'Playing']) expect(at(nothing, text)).toEqual(at(withAction, text));
    // Without the prop, the caption is the pad's own (no action row).
    expect(plain.querySelector('[class*="foot"]')).toBeNull();
    expect(withAction.querySelector('[class*="foot"]')).not.toBeNull();
  });
});
