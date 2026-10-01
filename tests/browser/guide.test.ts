/**
 * Quick guide coach marks in real Chromium: three steps anchored to Play,
 * the pads and the macros; Next / Skip guide / Escape; completion remembered;
 * never blocks the instrument (only the callout takes the pointer).
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { Guide, placeCallout } from '../../src/app/views/Guide';
import { createProject } from '../../src/project/factory';
import { UI_STORAGE_KEY, selectTrack, setGuideDone, setView, uiStore } from '../../src/state/uiStore';
import { cleanup, key, mount, wait } from './ui-harness';

let closes = 0;

beforeEach(async () => {
  // The laptop size the layout is designed for.
  await page.viewport(1366, 768);
  window.scrollTo(0, 0);
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
    // Controls right under the transport that the first callout must leave usable.
    h('button', { type: 'button', role: 'tab', id: 'steps-tab', style: { position: 'absolute', left: '237px', top: '82px', width: '58px', height: '30px' } }, 'Steps'),
    withPads && h('div', { id: 'pad-surface', role: 'tabpanel', style: { position: 'absolute', left: '27px', top: '125px', width: '988px', height: '520px' } },
      h('button', { type: 'button', id: 'pad', style: { width: '100px', height: '90px' } }, 'Pad'),
      h('button', { type: 'button', id: 'header', style: { position: 'absolute', left: '332px', top: '0', width: '102px', height: '70px' } }, 'Select Chords'),
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

/** Let placement run and the callout finish gliding to its spot. */
async function settle() {
  await act(async () => {
    await wait(260);
  });
}

describe('Quick guide', () => {
  it('walks through Play, the pads and the sound controls, then remembers completion', async () => {
    setup();
    await settle();

    // Step 1: Play / Stop.
    expect(callout().dataset.guideStep).toBe('play');
    expect(callout().getAttribute('aria-label')).toBe('Quick guide, step 1 of 3: Play and pause');
    expect(callout().textContent).toContain('1 of 3');
    // The text follows the transport: nothing armed yet, then playing.
    expect(callout().textContent).toContain('Tap a pad to begin');
    act(() => patchRuntime({ playing: true }));
    expect(callout().textContent).toContain('The groove is playing');
    act(() => patchRuntime({ playing: false }));
    await settle();
    const play = document.getElementById('play')!.getBoundingClientRect();
    const ring = document.querySelector<HTMLElement>('[data-guide-ring="play"]')!;
    const rr = ring.getBoundingClientRect();
    expect(rr.left).toBeLessThanOrEqual(play.left);
    expect(rr.right).toBeGreaterThanOrEqual(play.right);
    expect(overlaps(callout().getBoundingClientRect(), play)).toBe(false);
    expect(callout().dataset.side).toBe('bottom');
    // A slim strip under the transport that leaves the pad tabs and part headers free.
    expect(callout().dataset.layout).toBe('strip');
    expect(overlaps(callout().getBoundingClientRect(), document.getElementById('steps-tab')!.getBoundingClientRect())).toBe(false);
    expect(overlaps(callout().getBoundingClientRect(), document.getElementById('header')!.getBoundingClientRect())).toBe(false);
    // Its arrow still points at the Play button.
    const arrow = callout().querySelector('[class*="arrow"]')!.getBoundingClientRect();
    expect(arrow.left + arrow.width / 2).toBeGreaterThan(play.left);
    expect(arrow.left + arrow.width / 2).toBeLessThan(play.right);

    // Step 2: pads — the callout sits beside the pads, not over them.
    await click(button('Next'));
    await settle();
    expect(callout().dataset.guideStep).toBe('pads');
    expect(callout().textContent).toContain('2 of 3');
    expect(callout().textContent).toContain('Each column is a part');
    const pads = document.getElementById('pad-surface')!.getBoundingClientRect();
    expect(overlaps(callout().getBoundingClientRect(), pads)).toBe(false);
    expect(callout().dataset.layout).toBe('card');

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
    // On the Play view already: say where it is, without a button that would do nothing.
    expect(uiStore.getState().view).toBe('play');
    expect(callout().textContent).toContain('The pads fill the middle of the Play view.');
    expect(button('Show the Play view')).toBeNull();
    // On another view: offer to go there.
    act(() => setView('shape'));
    await settle();
    expect(callout().textContent).toContain('This is on the Play view.');
    await click(button('Show the Play view'));
    expect(uiStore.getState().view).toBe('play');
  });

  it('never covers the transport, even where that would hide fewer controls', async () => {
    await page.viewport(1920, 1080);
    const box = (id: string, left: number, top: number, width: number, height: number, extra: Record<string, string> = {}) =>
      h('button', { type: 'button', id, ...extra, style: { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` } }, id);
    // A 1920×1080 layout: undo/redo at the right of the transport, small part-header buttons, macros on the right
    // with Variation / Lock / level knobs below them.
    const stage = h(
      'div',
      { style: { position: 'fixed', inset: '0', background: '#ddd' } },
      h('header', { 'aria-label': 'Transport', id: 'transport', style: { position: 'absolute', left: '0', top: '0', right: '0', height: '58px' } },
        box('play', 372, 10, 93, 36, { 'aria-keyshortcuts': 'Space' }),
        box('undo', 1540, 15, 28, 28),
        box('redo', 1575, 15, 28, 28),
      ),
      h('div', { id: 'pad-surface', style: { position: 'absolute', left: '27px', top: '220px', width: '1240px', height: '700px' } }),
      // The last pad column and the scene buttons, left of the macros.
      box('mute', 1295, 170, 24, 20),
      box('solo', 1321, 170, 24, 20),
      box('pad-1', 1285, 220, 170, 168),
      box('pad-2', 1285, 397, 170, 168),
      box('scene-1', 1465, 220, 103, 168),
      box('scene-2', 1465, 397, 103, 168),
      h('div', { role: 'group', 'aria-label': 'Chords macros', id: 'macros', style: { position: 'absolute', left: '1603px', top: '180px', width: '294px', height: '203px' } }),
      box('variation', 1609, 390, 107, 36),
      box('lock', 1730, 390, 80, 36),
      box('level', 1700, 440, 30, 35, { role: 'slider' }),
      box('pan', 1770, 440, 30, 35, { role: 'slider' }),
    );
    mount(h('div', null, stage, h(Guide, { open: true, onClose: () => void (closes += 1) })));
    await settle();
    await click(button('Next'));
    await click(button('Next'));
    await settle();
    expect(callout().dataset.guideStep).toBe('sound');
    const c = callout().getBoundingClientRect();
    expect(overlaps(c, document.getElementById('transport')!.getBoundingClientRect())).toBe(false);
    expect(overlaps(c, document.getElementById('macros')!.getBoundingClientRect())).toBe(false);
    expect(callout().dataset.side).not.toBe('over');
  });

  it('scrolls a control that is off screen into view when its step starts', async () => {
    // At 200 % zoom the page is wider than the window and the sound controls sit to the right.
    const stage = h(
      'div',
      { style: { position: 'absolute', left: '0', top: '0', width: '2600px', height: '740px', background: '#ddd' } },
      h('header', { 'aria-label': 'Transport', style: { position: 'absolute', left: '0', top: '0', width: '1366px', height: '58px' } },
        h('button', { type: 'button', 'aria-keyshortcuts': 'Space', style: { position: 'absolute', left: '238px', top: '10px', width: '93px', height: '36px' } }, 'Play'),
      ),
      h('div', { id: 'pad-surface', style: { position: 'absolute', left: '27px', top: '125px', width: '988px', height: '520px' } }),
      h('div', { role: 'group', 'aria-label': 'Bass macros', id: 'macros', style: { position: 'absolute', left: '2100px', top: '180px', width: '282px', height: '196px' } }),
    );
    try {
      mount(h('div', null, stage, h(Guide, { open: true, onClose: () => void (closes += 1) })));
      await settle();
      expect(window.scrollX).toBe(0);
      await click(button('Next'));
      await click(button('Next'));
      await settle();
      expect(window.scrollX).toBeGreaterThan(0);
      const m = document.getElementById('macros')!.getBoundingClientRect();
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(window.innerWidth);
      // The ring follows the control to its new place (after the scroll settles), and nothing says it is missing.
      await settle();
      const ring = document.querySelector<HTMLElement>('[data-guide-ring="sound"]')!.getBoundingClientRect();
      expect(Math.abs(ring.left - (m.left - 5))).toBeLessThan(2);
      expect(callout().textContent).not.toContain('Play view');
    } finally {
      window.scrollTo(0, 0);
    }
  });

  it('is offered once in the app: after the first Jump In, not again once finished or skipped', async () => {
    // Jump In without the audio engine: the Welcome card → guide wiring is what is under test here.
    const realJumpIn = session.jumpIn;
    session.jumpIn = async () => {
      await session.newFromStarter('house');
    };
    const boot = { lastProject: null, warnings: [], storageError: null };
    const pressJumpIn = async () => {
      const jump = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Jump In');
      await click(jump ?? null);
      for (let i = 0; i < 100 && [...document.querySelectorAll('button')].some((b) => /Jump In|Starting/.test(b.textContent ?? '')); i++) {
        await act(async () => {
          await wait(20);
        });
      }
      await settle();
    };
    try {
      const first = mount(h(App, { boot }));
      await pressJumpIn();
      expect(callout().dataset.guideStep).toBe('play');
      // It points at the real transport Play button.
      const play = document.querySelector('header[aria-label="Transport"] button[aria-keyshortcuts="Space"]')!.getBoundingClientRect();
      const ring = document.querySelector<HTMLElement>('[data-guide-ring="play"]')!.getBoundingClientRect();
      expect(ring.left).toBeLessThanOrEqual(play.left);
      expect(ring.right).toBeGreaterThanOrEqual(play.right);
      await click(button('Skip guide'));
      expect(document.querySelector('[data-guide-step]')).toBeNull();
      expect(uiStore.getState().guideDone).toBe(true);
      first.unmount();

      mount(h(App, { boot }));
      await pressJumpIn();
      expect(document.querySelector('[data-guide-step]')).toBeNull();
    } finally {
      session.jumpIn = realJumpIn;
    }
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
    // With a cost, the callout slides along its side (arrow still on the anchor) to avoid covering things.
    const blocker = { left: 200, top: 50, right: 300, bottom: 120 };
    const slid = placeCallout(rect(238, 10, 93, 36), { w: 600, h: 52 }, ['bottom'], 'start', vp, {
      arrowInset: 16,
      cost: (c) => Math.max(0, Math.min(c.right, blocker.right) - Math.max(c.left, blocker.left)) * Math.max(0, Math.min(c.bottom, blocker.bottom) - Math.max(c.top, blocker.top)),
    });
    expect(slid.x).toBeGreaterThanOrEqual(300);
    expect(slid.x + (slid.arrow ?? 0)).toBeGreaterThan(238);
    expect(slid.x + (slid.arrow ?? 0)).toBeLessThan(331);
    // Nothing fits: inside the anchor, no arrow.
    const over = placeCallout(rect(0, 0, 1366, 768), size, ['right', 'left', 'bottom', 'top', 'over'], 'end', vp);
    expect(over.side).toBe('over');
    expect(over.arrow).toBeNull();
    expect(over.x).toBeGreaterThanOrEqual(12);
    expect(over.y + size.h).toBeLessThanOrEqual(vp.h - 12);
  });
});
