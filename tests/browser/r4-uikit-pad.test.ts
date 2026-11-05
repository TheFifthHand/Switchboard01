/**
 * Pads for big screens and running loops, in real Chromium layout: a content sketch in the empty
 * middle of pads at least 100 px tall (hidden on smaller pads), a 3 px loop-progress bar driven by
 * --loop-progress written through a ref (no React render), an even wash for a playing pad (no
 * radial glow), a name that fades out instead of an ellipsis (with the whole name as the pad's
 * title only while it is cut, measured under a real mouse), and the larger name on large pads.
 * ClipSketch draws notes by pitch and hits by kit sound, and redraws only when its notes change.
 */
import { act, createElement as h, useRef, useState, type RefObject } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { ClipSketch, Pad, type SketchNote } from '../../src/ui/components';
import { cleanup, mount, nextFrame } from './ui-harness';
import { centre, mouse } from './r4-uikit-input';

afterEach(cleanup);

const BAR = 384;
const HATS: SketchNote[] = [
  { tick: 0, pitch: 0, duration: 24 },
  { tick: 192, pitch: 0, duration: 24 },
  { tick: 96, pitch: 1, duration: 24 },
  { tick: 288, pitch: 1, duration: 24 },
  ...Array.from({ length: 8 }, (_, i) => ({ tick: i * 48, pitch: 4, duration: 12 })),
];
const CHORD: SketchNote[] = [
  { tick: 0, pitch: 60, duration: 360, velocity: 0.7 },
  { tick: 0, pitch: 64, duration: 360, velocity: 0.7 },
  { tick: 0, pitch: 67, duration: 360, velocity: 0.7 },
];

function pad(w: number, hgt: number, props: Record<string, unknown> = {}) {
  let renders = 0;
  let ref: RefObject<HTMLButtonElement | null> = { current: null };
  function Host() {
    renders += 1;
    ref = useRef<HTMLButtonElement>(null);
    return h('div', { style: { width: `${w}px`, height: `${hgt}px`, display: 'flex' } }, h(Pad, { ref, state: 'playing', label: 'Steady Hats', sublabel: '1 bar', labelSize: 'lg', onPress: () => {}, sketch: h(ClipSketch, { notes: HATS, lengthTicks: BAR, kind: 'drums' }), ...props }));
  }
  const m = mount(h(Host));
  const button = m.container.querySelector<HTMLButtonElement>('button')!;
  return { m, button, ref: () => ref, renders: () => renders };
}

/** A real mouse comes over the element from outside it. */
async function hover(el: Element) {
  await mouse('mouseMoved', { x: window.innerWidth - 2, y: window.innerHeight - 2 });
  await mouse('mouseMoved', centre(el));
}

const visible = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;

describe('the sketch', () => {
  it('shows in the middle of a pad at least 100 px tall, below the name and above the state', () => {
    const { button } = pad(172, 155);
    const sketch = button.querySelector('svg[data-kind="drums"]')!;
    expect(visible(sketch)).toBe(true);
    const s = sketch.getBoundingClientRect();
    const name = [...button.querySelectorAll('span')].find((x) => x.textContent === 'Steady Hats' && x.children.length === 0)!.getBoundingClientRect();
    const state = [...button.querySelectorAll('span')].find((x) => x.textContent === 'Playing')!.getBoundingClientRect();
    expect(s.top).toBeGreaterThanOrEqual(name.bottom);
    expect(s.bottom).toBeLessThanOrEqual(state.top);
    expect(sketch.getAttribute('aria-hidden')).toBe('true');
  });

  it('is hidden on a pad under 100 px tall (1366 x 768 pads are about 103 x 71)', () => {
    const { button } = pad(103, 71);
    expect(visible(button.querySelector('svg[data-kind="drums"]'))).toBe(false);
  });
});

describe('loop progress', () => {
  it('a 3 px bar along the bottom appears once --loop-progress is written through the ref, without a render', async () => {
    const { button, ref, renders } = pad(172, 155);
    const bar = [...button.querySelectorAll<HTMLElement>('span')].find((s) => s.className.includes('progress'))!;
    expect(getComputedStyle(bar).opacity).toBe('0');
    const before = renders();
    ref().current!.style.setProperty('--loop-progress', '0.4');
    await nextFrame();
    expect(renders()).toBe(before);
    expect(getComputedStyle(bar).opacity).toBe('1');
    expect(bar.getBoundingClientRect().height).toBe(3);
    expect(Math.round(bar.getBoundingClientRect().bottom)).toBe(Math.round(button.getBoundingClientRect().bottom));
    const fill = new DOMMatrixReadOnly(getComputedStyle(bar, '::after').transform);
    expect(fill.a).toBeCloseTo(0.4, 5);
    // An ancestor may write it too (one loop for a whole grid).
    ref().current!.style.removeProperty('--loop-progress');
    (button.parentElement as HTMLElement).style.setProperty('--loop-progress', '0.75');
    await nextFrame();
    expect(new DOMMatrixReadOnly(getComputedStyle(bar, '::after').transform).a).toBeCloseTo(0.75, 5);
  });

  it('a pad that is not playing shows no bar', async () => {
    const { button, ref } = pad(172, 155, { state: 'ready' });
    ref().current!.style.setProperty('--loop-progress', '0.4');
    await nextFrame();
    const bar = [...button.querySelectorAll<HTMLElement>('span')].find((s) => s.className.includes('progress'))!;
    expect(getComputedStyle(bar).opacity).toBe('0');
  });
});

describe('the look of a playing pad and its name', () => {
  it('playing is an even wash of amber over the whole pad, not a radial pool', () => {
    const { button } = pad(172, 155);
    const light = [...button.querySelectorAll<HTMLElement>('span')].find((s) => s.className.includes('light'))!;
    const cs = getComputedStyle(light);
    expect(cs.backgroundImage).toBe('none');
    expect(cs.backgroundColor).toMatch(/rgba\(242, 166, 52, 0\.2\)/);
    const r = light.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    expect([r.left, r.top, r.width, r.height].map(Math.round)).toEqual([b.left, b.top, b.width, b.height].map(Math.round));
  });

  it('a long name fades out at its end (no ellipsis); with the mouse over it, the pad has the whole name as its title', async () => {
    const { button } = pad(103, 71, { label: 'Walking Bass Line Long Name' });
    const name = [...button.querySelectorAll<HTMLElement>('span')].find((x) => x.textContent === 'Walking Bass Line Long Name' && x.children.length === 0)!;
    const cs = getComputedStyle(name);
    expect(cs.textOverflow).not.toBe('ellipsis');
    expect(cs.maskImage || cs.webkitMaskImage).toContain('linear-gradient');
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    await hover(button);
    expect(button.title).toBe('Walking Bass Line Long Name');
  });

  it('a name that fits gives the pad no title (no second tooltip); a caller can still set one or turn it off', async () => {
    const short = pad(172, 155, { label: 'Hats' }).button;
    await hover(short);
    expect(short.hasAttribute('title')).toBe(false);
    cleanup();
    const asked = pad(172, 155, { label: 'Hats', title: 'Steady hats, 1 bar' }).button;
    expect(asked.title).toBe('Steady hats, 1 bar');
    cleanup();
    const never = pad(103, 71, { label: 'Walking Bass Line Long Name', title: null }).button;
    await hover(never);
    expect(never.hasAttribute('title')).toBe(false);
  });

  it('when the name changes under the mouse, the title follows: gone once the new name fits', async () => {
    let rename: (s: string) => void = () => {};
    function Host() {
      const [label, setLabel] = useState('Walking Bass Line Long Name');
      rename = setLabel;
      return h('div', { style: { width: '103px', height: '71px', display: 'flex' } }, h(Pad, { state: 'playing', label, labelSize: 'lg', onPress: () => {} }));
    }
    const m = mount(h(Host));
    const button = m.container.querySelector<HTMLButtonElement>('button')!;
    await hover(button);
    expect(button.title).toBe('Walking Bass Line Long Name');
    act(() => rename('Bass'));
    expect(button.hasAttribute('title')).toBe(false);
    act(() => rename('Another Very Long Clip Name'));
    expect(button.title).toBe('Another Very Long Clip Name');
  });

  it('large pads (a big screen) show a larger name', () => {
    const small = pad(103, 71).button;
    const big = pad(172, 155).button;
    const size = (b: HTMLElement) => parseFloat(getComputedStyle([...b.querySelectorAll<HTMLElement>('span')].find((x) => x.textContent === 'Steady Hats' && x.children.length === 0)!).fontSize);
    expect(size(small)).toBe(15);
    expect(size(big)).toBe(17);
  });
});

describe('ClipSketch', () => {
  it('drum clips: one row per kit sound used, the kick at the bottom', () => {
    const m = mount(h('div', { style: { width: '160px', height: '60px', display: 'flex' } }, h(ClipSketch, { notes: HATS, lengthTicks: BAR, kind: 'drums' })));
    const rects = [...m.container.querySelectorAll('rect')];
    expect(rects).toHaveLength(HATS.length);
    const rowOf = (pitch: number) => {
      const i = HATS.findIndex((n) => n.pitch === pitch);
      return rects[i].getBoundingClientRect().top;
    };
    expect(new Set(rects.map((r) => Math.round(r.getBoundingClientRect().top))).size).toBe(3);
    expect(rowOf(0)).toBeGreaterThan(rowOf(1));
    expect(rowOf(1)).toBeGreaterThan(rowOf(4));
    // Time runs left to right over the clip.
    const svg = m.container.querySelector('svg')!.getBoundingClientRect();
    expect(rects[1].getBoundingClientRect().left - svg.left).toBeCloseTo(svg.width / 2, 0);
  });

  it('melodic clips: the highest note at the top, a held note as long as it lasts', () => {
    const m = mount(h('div', { style: { width: '160px', height: '60px', display: 'flex' } }, h(ClipSketch, { notes: CHORD, lengthTicks: BAR, kind: 'notes' })));
    const rects = [...m.container.querySelectorAll('rect')].map((r) => r.getBoundingClientRect());
    expect(rects[2].top).toBeLessThan(rects[1].top);
    expect(rects[1].top).toBeLessThan(rects[0].top);
    expect(rects[0].width).toBeCloseTo((160 * 360) / BAR, 0);
  });

  it('draws again only when its notes change', async () => {
    let setTick: (n: number) => void = () => {};
    let setNotes: (n: SketchNote[]) => void = () => {};
    function Host() {
      const [, setT] = useState(0);
      const [notes, setN] = useState<SketchNote[]>(CHORD);
      setTick = setT;
      setNotes = setN;
      return h('div', { style: { width: '160px', height: '60px', display: 'flex' } }, h(ClipSketch, { notes, lengthTicks: BAR, kind: 'notes' }));
    }
    const m = mount(h(Host));
    const svg = m.container.querySelector('svg')!;
    const changes: MutationRecord[] = [];
    const mo = new MutationObserver((r) => changes.push(...r));
    mo.observe(svg, { subtree: true, childList: true, attributes: true });
    act(() => setTick(1));
    act(() => setTick(2));
    await nextFrame();
    expect(changes).toHaveLength(0);
    act(() => setNotes([...CHORD, { tick: 192, pitch: 72, duration: 96 }]));
    await nextFrame();
    expect(changes.length).toBeGreaterThan(0);
    expect(m.container.querySelectorAll('rect')).toHaveLength(4);
    mo.disconnect();
  });
});
