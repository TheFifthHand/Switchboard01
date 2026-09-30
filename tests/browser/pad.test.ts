import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Pad, type PadState } from '../../src/ui/components';
import { cleanup, fire, key, mount, pointer, pointIn } from './ui-harness';

afterEach(cleanup);

function setup(props: Record<string, unknown> = {}) {
  const log: (['press', number] | ['release'])[] = [];
  const el = (p: Record<string, unknown> = {}) =>
    h(Pad, {
      state: 'ready' as PadState,
      label: 'Walker',
      sublabel: '2 bars',
      onPress: (e: { velocity: number }) => log.push(['press', e.velocity]),
      onRelease: () => log.push(['release']),
      ...props,
      ...p,
    });
  const m = mount(el());
  const pad = m.container.querySelector<HTMLButtonElement>('button')!;
  return { log, m, pad, el };
}

describe('Pad', () => {
  it('fires onPress on pointerdown (not on click) and onRelease on pointerup', () => {
    const { log, pad } = setup();
    pointer(pad, 'pointerdown', pointIn(pad));
    expect(log).toHaveLength(1);
    expect(log[0][0]).toBe('press');
    pointer(pad, 'pointerup', pointIn(pad));
    fire(pad, new MouseEvent('click', { bubbles: true }));
    expect(log.map((e) => e[0])).toEqual(['press', 'release']);
  });

  it('velocity follows the strike position: lower is harder', () => {
    const { log, pad } = setup();
    pointer(pad, 'pointerdown', pointIn(pad, 0.1));
    pointer(pad, 'pointerup', pointIn(pad, 0.1));
    pointer(pad, 'pointerdown', pointIn(pad, 0.95));
    pointer(pad, 'pointerup', pointIn(pad, 0.95));
    const v = log.filter((e) => e[0] === 'press').map((e) => e[1] as number);
    expect(v[1]).toBeGreaterThan(v[0]);
    expect(v[0]).toBeGreaterThanOrEqual(0.4);
    expect(v[1]).toBeLessThanOrEqual(1);
  });

  it('pointercancel releases', () => {
    const { log, pad } = setup();
    pointer(pad, 'pointerdown', pointIn(pad));
    pointer(pad, 'pointercancel', pointIn(pad));
    expect(log.map((e) => e[0])).toEqual(['press', 'release']);
  });

  it('Space and Enter press when focused, key-up releases, repeats are ignored', () => {
    const { log, pad } = setup();
    pad.focus();
    const down = key(pad, 'keydown', { key: ' ', code: 'Space' });
    expect(down.defaultPrevented).toBe(true); // no page scroll
    key(pad, 'keydown', { key: ' ', code: 'Space', repeat: true });
    key(pad, 'keyup', { key: ' ', code: 'Space' });
    key(pad, 'keydown', { key: 'Enter', code: 'Enter' });
    key(pad, 'keyup', { key: 'Enter', code: 'Enter' });
    expect(log).toEqual([['press', 0.8], ['release'], ['press', 0.8], ['release']]);
  });

  it('a held pad is released on window blur and on unmount', () => {
    const a = setup();
    pointer(a.pad, 'pointerdown', pointIn(a.pad));
    fire(window, new Event('blur'));
    expect(a.log.map((e) => e[0])).toEqual(['press', 'release']);

    const b = setup();
    b.pad.focus();
    key(b.pad, 'keydown', { key: 'Enter' });
    b.m.unmount();
    expect(b.log.map((e) => e[0])).toEqual(['press', 'release']);
  });

  it('a pad disabled while held is released at once (it will never see its pointerup)', () => {
    const { log, m, pad, el } = setup();
    pointer(pad, 'pointerdown', pointIn(pad));
    m.rerender(el({ disabled: true }));
    expect(log.map((e) => e[0])).toEqual(['press', 'release']);
    expect(pad.hasAttribute('data-pressed')).toBe(false);
    pointer(pad, 'pointerup', pointIn(pad));
    expect(log).toHaveLength(2);
  });

  it('a disabled pad does nothing', () => {
    const { log, pad } = setup({ disabled: true });
    pointer(pad, 'pointerdown', pointIn(pad));
    key(pad, 'keydown', { key: 'Enter' });
    expect(log).toEqual([]);
  });

  it('states are readable without colour: visible caption and accessible name', () => {
    const cases: [PadState, string | null, string][] = [
      ['playing', 'Playing', 'playing'],
      ['queued', 'Next bar', 'starts on the next bar'],
      ['recording', 'Rec', 'recording'],
      ['stopping', 'Stopping', 'stopping at the next bar'],
      ['ready', 'Ready', 'ready'],
      ['empty', null, 'empty'],
    ];
    for (const [state, caption, spoken] of cases) {
      const { pad, m } = setup({ state, label: state === 'empty' ? 'Empty' : 'Walker' });
      if (caption) expect(pad.textContent).toContain(caption);
      expect(pad.getAttribute('aria-label')).toContain(spoken);
      expect(pad.getAttribute('data-state')).toBe(state);
      m.unmount();
    }
  });

  it('on a narrow pad the state icon stays whole and the caption words stay inside the pad', () => {
    const m = mount(h(Pad, { state: 'stopping', label: 'Grain', sublabel: '2 bars', caption: 'Stops next bar', onPress: () => {} }), { width: 64 });
    const pad = m.container.querySelector('button')!;
    const box = pad.getBoundingClientRect();
    const words = [...pad.querySelectorAll('span')].find((s) => s.textContent === 'Stops next bar' && s.children.length === 0)!;
    const icon = pad.querySelector('svg[data-icon="stop"]')!.getBoundingClientRect();
    expect(icon.width).toBeGreaterThan(0);
    expect(icon.right).toBeLessThanOrEqual(box.right);
    expect(words.getBoundingClientRect().right).toBeLessThanOrEqual(box.right);
    expect(words.scrollWidth).toBeGreaterThan(words.clientWidth); // shortened with an ellipsis, not cut mid-letter
  });

  it('shows the selection in the accessible name and the key hint on the pad', () => {
    const { pad } = setup({ selected: true, keyHint: 'Z', caption: null, state: 'ready', label: 'Kick', sublabel: undefined });
    expect(pad.getAttribute('aria-label')).toBe('Kick, ready, selected');
    expect(pad.textContent).toContain('Z');
    // The computer key is announced as the pad's shortcut.
    expect(pad.getAttribute('aria-keyshortcuts')).toBe('Z');
  });
});
