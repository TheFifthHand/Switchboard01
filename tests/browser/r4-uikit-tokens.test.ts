/**
 * Design tokens checked through computed style: white on --teal-key reads 4.5:1 or better; the
 * knob's track and value arcs read 3:1 or better on --surface, and the knob draws with exactly
 * those tokens; the type layer (sizes, the four weights, role classes) and the live layout
 * measures have their defaults; every component in the gallery uses only the four weights.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { Knob } from '../../src/ui/components';
import { Gallery } from '../../src/ui/gallery/Gallery';
import { BASS_PARAMS, CHANNEL_PARAMS, specById } from '../../src/project/params';
import { cleanup, mount, wait } from './ui-harness';
import { contrast } from './r4-uikit-input';

afterEach(cleanup);

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** The browser's rgb() for a CSS colour value. */
function rgb(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  document.body.append(el);
  const c = getComputedStyle(el).color;
  el.remove();
  return c;
}

describe('colour tokens', () => {
  it('white on --teal-key (part numbers, the selected chip) reads 4.5:1 or better', () => {
    expect(token('--teal-key')).toBe('#1d7b75');
    expect(contrast('#ffffff', 'var(--teal-key)')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', 'var(--teal-key)')).toBeCloseTo(5.07, 1);
    // The old teal did not.
    expect(contrast('#ffffff', 'var(--teal)')).toBeLessThan(4.5);
  });

  it('the knob track and value arcs read 3:1 or better on --surface (and on --surface-hi)', () => {
    for (const name of ['--knob-track', '--knob-arc', '--knob-arc-teal']) {
      expect(contrast(`var(${name})`, 'var(--surface)'), name).toBeGreaterThanOrEqual(3);
      expect(contrast(`var(${name})`, 'var(--surface-hi)'), name).toBeGreaterThanOrEqual(3);
    }
    // Not the old values (track 1.29:1, arc 1.80:1), and not --amber-ink.
    expect(rgb('var(--knob-arc)')).not.toBe(rgb('var(--amber-ink)'));
    expect(contrast('#cfd3d7', 'var(--surface)')).toBeLessThan(1.5);
  });

  it('a knob draws its track and arcs with those tokens', () => {
    const cutoff = specById(BASS_PARAMS, 'cutoff')!;
    const pan = specById(CHANNEL_PARAMS, 'pan')!;
    const m = mount(h('div', null, h(Knob, { spec: cutoff, value: 3000, onChange: () => {} }), h(Knob, { spec: pan, value: -0.4, accent: 'teal', onChange: () => {} })));
    const [amber, teal] = [...m.container.querySelectorAll<HTMLElement>('[data-size]')];
    const stroke = (k: HTMLElement, cls: string) => getComputedStyle(k.querySelector(`svg [class*="${cls}"]`)!).stroke;
    expect(stroke(amber, 'track')).toBe(rgb('var(--knob-track)'));
    expect(stroke(amber, 'arc')).toBe(rgb('var(--knob-arc)'));
    expect(stroke(teal, 'arc')).toBe(rgb('var(--knob-arc-teal)'));
  });
});

describe('type and size tokens', () => {
  it('sizes, the four weights and the role classes', () => {
    expect(token('--fs-2xs')).toBe('10px');
    expect(token('--fs-xs')).toBe('11px');
    expect(token('--fs-2xl')).toBe('17px');
    expect([token('--fw-regular'), token('--fw-medium'), token('--fw-semibold'), token('--fw-bold')]).toEqual(['400', '500', '600', '700']);
    const m = mount(h('div', null, h('span', { className: 't-eyebrow' }, 'Record'), h('span', { className: 't-label' }, 'Tempo'), h('span', { className: 't-panel-title' }, 'Song'), h('span', { className: 't-value' }, '124')));
    const [eyebrow, label, title, value] = [...m.container.querySelectorAll('span')].map((s) => getComputedStyle(s));
    expect([eyebrow.fontSize, eyebrow.fontWeight, eyebrow.textTransform]).toEqual(['10px', '600', 'uppercase']);
    expect([label.fontSize, label.fontWeight, label.textTransform]).toEqual(['12px', '500', 'none']);
    expect([title.fontSize, title.fontWeight]).toEqual(['15px', '600']);
    expect(value.fontFamily).toContain('IBM Plex Mono');
  });

  it('live layout measures default to no keyboard and a 56 px transport', () => {
    expect(token('--keyboard-h')).toBe('0px');
    expect(token('--transport-h')).toBe('56px');
  });

  it('every component in the gallery uses only the weights 400, 500, 600 and 700', async () => {
    await page.viewport(1600, 1000);
    const m = mount(h(Gallery), { width: 1560 });
    await wait(100);
    const weights = new Set<string>();
    for (const el of m.container.querySelectorAll<HTMLElement>('*')) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
      weights.add(getComputedStyle(el).fontWeight);
    }
    expect([...weights].filter((w) => !['400', '500', '600', '700'].includes(w))).toEqual([]);
  });
});
