/**
 * Quick guide coach marks in real Chromium: three steps anchored to Play,
 * the pads and the macros; Next / Skip guide / Escape; completion remembered;
 * never blocks the instrument (only the callout takes the pointer).
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { Guide, placeCallout } from '../../src/app/views/Guide';
import { createProject } from '../../src/project/factory';
import { UI_STORAGE_KEY, selectTrack, setGuideDone, setView, uiStore } from '../../src/state/uiStore';
import { cleanup, key, mount, wait } from './ui-harness';

let closes = 0;

beforeEach(() => {
  closes = 0;
  session.store.replace(createProject({ name: 'Guide test' }), { resetHistory: true });
  act(() => {
    setGuideDone(false);
    setView('play');
    selectTrack('t3');
  });
});

afterEach(() => {
  cleanup();
});

/** A stand-in for the instrument: transport Play button, the pad surface and a macro group. */
function Stage(props: { withPads?: boolean }) {
  const withPads = props.withPads ?? true;
  return h(
    'div',
    { style: { position: 'fixed', inset: '0', width: '1366px', height: '768px', background: '#ddd' } },
    h('header', { 'aria-label': 'Transport', style: { position: 'absolute', left: '0', top: '0', right: '0', height: '58px' } },
      h('button', { type: 'button', 'aria-keyshortcuts': 'Space', id: 'play', style: { position: 'absolute', left: '238px', top: '10px', width: '93px', height: '36px' } }, 'Play'),
    ),
    withPads && h('div', { id: 'pad-surface', role: 'tabpanel', style: { position: 'absolute', left: '27px', top: '125px', width: '988px', height: '520px' } },
      h('button', { type: 'button', id: 'pad', style: { width: '100px', height: '90px' } }, 'Pad'),
    ),
    h('div', { role: 'group', 'aria-label': 'Bass macros', id: 'macros', style: { position: 'absolute', left: '1055px', top: '180px', width: '282px', height: '196px' } }),
    h('input', { id: 'text', style: { position: 'absolute', left: '600px', top: '20px' } }),
  );
}

function setup(withPads = true) {
  return mount(h('div', null, h(Stage, { withPads }), h(Guide, { open: true, onClose: () => void (closes += 1) })));
}

function callout(): HTMLElement {
  const c = document.querySelector<HTMLElement>('[data-guide-step]');
  if (!c) throw new Error('no guide callout');
  return c;
}

function button(name: string): HTMLButtonElement | null {
  return [...callout().querySelectorAll('button')].find((b) => b.textContent?.trim() === name) ?? null;
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error('button not found');
  await act(async () => {
    el.click();
  });
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

async function settle() {
  await act(async () => {
    await wait(30);
  });
}

describe('Quick guide', () => {
  it('walks through Play, the pads and the sound controls, then remembers completion', async () => {
    setup();
    await settle();

    // Step 1: Play / Stop.
    expect(callout().dataset.guideStep).toBe('play');
    expect(callout().getAttribute('aria-label')).toBe('Quick guide, step 1 of 3: Play and stop');
    expect(callout().textContent).toContain('1 of 3');
    expect(callout().textContent).toContain('Press Play');
    const play = document.getElementById('play')!.getBoundingClientRect();
    const ring = document.querySelector<HTMLElement>('[data-guide-ring="play"]')!;
    const rr = ring.getBoundingClientRect();
    expect(rr.left).toBeLessThanOrEqual(play.left);
    expect(rr.right).toBeGreaterThanOrEqual(play.right);
    expect(overlaps(callout().getBoundingClientRect(), play)).toBe(false);
    expect(callout().dataset.side).toBe('bottom');

    // Step 2: pads — the callout sits beside the pads, not over them.
    await click(button('Next'));
    await settle();
    expect(callout().dataset.guideStep).toBe('pads');
    expect(callout().textContent).toContain('2 of 3');
    expect(callout().textContent).toContain('Each column is a part');
    const pads = document.getElementById('pad-surface')!.getBoundingClientRect();
    expect(overlaps(callout().getBoundingClientRect(), pads)).toBe(false);

    // Step 3: macros of the selected part.
    await click(button('Next'));
    await settle();
    expect(callout().dataset.guideStep).toBe('sound');
    expect(callout().textContent).toContain('3 of 3');
    expect(callout().textContent).toContain('Bass, the selected part');
    expect(overlaps(callout().getBoundingClientRect(), document.getElementById('macros')!.getBoundingClientRect())).toBe(false);
    // The last step finishes instead of offering a skip.
    expect(button('Skip guide')).toBeNull();
    expect(uiStore.getState().guideDone).toBe(false);

    await click(button('Done'));
    expect(closes).toBe(1);
    expect(uiStore.getState().guideDone).toBe(true);
    expect(JSON.parse(localStorage.getItem(UI_STORAGE_KEY)!).guideDone).toBe(true);
  });

  it('Skip guide ends it at any step and is remembered', async () => {
    setup();
    await settle();
    await click(button('Next'));
    await click(button('Skip guide'));
    expect(closes).toBe(1);
    expect(uiStore.getState().guideDone).toBe(true);
  });

  it('Escape skips the guide, but not while typing in a text field', async () => {
    setup();
    await settle();
    const text = document.getElementById('text') as HTMLInputElement;
    text.focus();
    key(text, 'keydown', { key: 'Escape' });
    expect(closes).toBe(0);
    text.blur();
    key(document.body, 'keydown', { key: 'Escape' });
    expect(closes).toBe(1);
    expect(uiStore.getState().guideDone).toBe(true);
  });

  it('never blocks the instrument: only the callout takes the pointer', async () => {
    setup();
    await settle();
    await click(button('Next'));
    await settle();
    const ring = document.querySelector<HTMLElement>('[data-guide-ring="pads"]')!;
    expect(getComputedStyle(ring).pointerEvents).toBe('none');
    expect(callout().getAttribute('aria-modal')).toBe('false');
    const pad = document.getElementById('pad')!.getBoundingClientRect();
    expect(document.elementFromPoint(pad.left + pad.width / 2, pad.top + pad.height / 2)?.id).toBe('pad');
    const play = document.getElementById('play')!.getBoundingClientRect();
    expect(document.elementFromPoint(play.left + 10, play.top + 10)?.id).toBe('play');
  });

  it('explains where a control lives when it is not on screen', async () => {
    setup(false);
    await settle();
    await click(button('Next'));
    await settle();
    expect(callout().dataset.guideStep).toBe('pads');
    expect(document.querySelector('[data-guide-ring]')).toBeNull();
    expect(callout().textContent).toContain('This is on the Play view.');
    act(() => setView('shape'));
    await click(button('Show the Play view'));
    expect(uiStore.getState().view).toBe('play');
  });

  it('places the callout on the first side that fits and keeps it on screen', () => {
    const vp = { w: 1366, h: 768 };
    const size = { w: 300, h: 180 };
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
    // Below a transport button, arrow pointing at its centre.
    const below = placeCallout(rect(238, 10, 93, 36), size, ['bottom', 'top'], 'start', vp);
    expect(below.side).toBe('bottom');
    expect(below.y).toBe(60);
    expect(below.x + (below.arrow ?? 0)).toBeCloseTo(238 + 93 / 2, 0);
    // No room below a control at the bottom: goes above.
    const above = placeCallout(rect(600, 700, 80, 40), size, ['bottom', 'top'], 'center', vp);
    expect(above.side).toBe('top');
    expect(above.y + size.h).toBeLessThanOrEqual(700);
    // Right of a wide panel, clamped inside the viewport.
    const right = placeCallout(rect(27, 125, 988, 520), size, ['right', 'left', 'over'], 'end', vp);
    expect(right.side).toBe('right');
    expect(right.x + size.w).toBeLessThanOrEqual(vp.w - 12);
    // Nothing fits: inside the anchor, no arrow.
    const over = placeCallout(rect(0, 0, 1366, 768), size, ['right', 'left', 'bottom', 'top', 'over'], 'end', vp);
    expect(over.side).toBe('over');
    expect(over.arrow).toBeNull();
    expect(over.x).toBeGreaterThanOrEqual(12);
    expect(over.y + size.h).toBeLessThanOrEqual(vp.h - 12);
  });
});
