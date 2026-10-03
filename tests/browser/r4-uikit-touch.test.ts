/**
 * The touch rule for faders and knobs, with real touch input (CDP Input.dispatchTouchEvent), so
 * the browser's own panning decides: a swipe that starts on a fader's lane or a knob's label
 * scrolls the page and changes nothing; a finger on the cap (fader) or the dial (knob) drags at
 * once and the page stays put; a finger that rests still for a moment anywhere on the control
 * takes it. Mouse drags anywhere still work at once.
 */
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { Fader, Knob, TOUCH_HOLD_MS, TipsProvider, type FaderChangeInfo } from '../../src/ui/components';
import { CHANNEL_PARAMS, specById } from '../../src/project/params';
import { cleanup, mount, wait } from './ui-harness';
import { centre, drag, finger, send } from './r4-uikit-input';

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;
const PAN = specById(CHANNEL_PARAMS, 'pan')!;

beforeEach(async () => {
  await page.viewport(960, 540);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
});

afterEach(async () => {
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  cleanup();
});

/** A scrolling page (a tall scroller) with a fader and a knob near its top. */
function setup() {
  const calls: { fader: number[]; knob: number[] } = { fader: [], knob: [] };
  const m = mount(
    h(
      TipsProvider,
      { enabled: false },
      h(
        'div',
        { 'data-testid': 'scroller', style: { height: '460px', overflow: 'auto', background: '#eee' } },
        h(
          'div',
          { style: { display: 'flex', gap: '40px', padding: '20px', height: '1600px', alignItems: 'flex-start' } },
          h('div', { style: { height: '320px', display: 'flex' } }, h(Fader, { spec: LEVEL, value: -7, label: 'Bass level', onChange: (v: number, _i: FaderChangeInfo) => calls.fader.push(v) })),
          h(Knob, { spec: PAN, value: 0.18, label: 'Pan', size: 'md', onChange: (v: number) => calls.knob.push(v) }),
        ),
      ),
    ),
    { width: 600 },
  );
  const scroller = m.container.querySelector<HTMLElement>('[data-testid="scroller"]')!;
  const fader = m.container.querySelector<HTMLElement>('[role="slider"][aria-orientation="vertical"]')!;
  const cap = fader.querySelector<HTMLElement>('[class*="cap"]')!;
  const knob = m.container.querySelector<HTMLElement>('[role="slider"]:not([aria-orientation])')!;
  const dial = knob.querySelector<HTMLElement>('[class*="dial"]')!;
  const knobLabel = knob.querySelector<HTMLElement>('[class*="labelText"]')!;
  return { calls, scroller, fader, cap, knob, dial, knobLabel };
}

describe('a finger on a fader', () => {
  it('a swipe that starts on the lane (not the cap) scrolls the page and leaves the level alone', async () => {
    const { calls, scroller, fader, cap } = setup();
    // On the scale side of the lane, well below the cap.
    const r = fader.getBoundingClientRect();
    const c = cap.getBoundingClientRect();
    const from = { x: r.left + 8, y: c.bottom + 60 };
    expect(scroller.scrollTop).toBe(0);
    await finger(from, { x: from.x, y: from.y - 150 }, { steps: 10 });
    await wait(150);
    expect(scroller.scrollTop).toBeGreaterThan(60);
    expect(calls.fader).toEqual([]);
  });

  it('a finger on the cap drags the level at once, and the page does not move', async () => {
    const { calls, scroller, cap } = setup();
    const from = centre(cap);
    await finger(from, { x: from.x, y: from.y - 60 }, { steps: 10 });
    expect(scroller.scrollTop).toBe(0);
    expect(calls.fader.length).toBeGreaterThan(0);
    expect(calls.fader.at(-1)!).toBeGreaterThan(-7);
  });

  it('the cap takes a finger within 44 px around it', async () => {
    const { calls, scroller, cap } = setup();
    const c = cap.getBoundingClientRect();
    // Just above the 30 px tall cap and on the scale beside it: inside the 44 px target.
    const from = { x: c.left - 4, y: c.top - 4 };
    await finger(from, { x: from.x, y: from.y - 40 }, { steps: 8 });
    expect(scroller.scrollTop).toBe(0);
    expect(calls.fader.length).toBeGreaterThan(0);
  });

  it(`a finger that rests still for ${TOUCH_HOLD_MS} ms on the lane takes the fader`, async () => {
    const { calls, scroller, fader, cap } = setup();
    const r = fader.getBoundingClientRect();
    const from = { x: r.left + 8, y: cap.getBoundingClientRect().bottom + 60 };
    await finger(from, { x: from.x, y: from.y - 50 }, { steps: 8, holdMs: TOUCH_HOLD_MS + 120 });
    expect(scroller.scrollTop).toBe(0);
    expect(calls.fader.length).toBeGreaterThan(0);
    expect(calls.fader.at(-1)!).toBeGreaterThan(-7);
  });
});

describe('a finger on a knob', () => {
  it('a swipe that starts on its label scrolls the page and leaves the value alone', async () => {
    const { calls, scroller, knobLabel } = setup();
    const from = centre(knobLabel);
    await finger(from, { x: from.x, y: from.y - 140 }, { steps: 10 });
    await wait(150);
    expect(scroller.scrollTop).toBeGreaterThan(50);
    expect(calls.knob).toEqual([]);
  });

  it('a finger on the dial turns it at once, and the page does not move', async () => {
    const { calls, scroller, dial } = setup();
    const from = centre(dial);
    await finger(from, { x: from.x, y: from.y - 50 }, { steps: 10 });
    expect(scroller.scrollTop).toBe(0);
    expect(calls.knob.length).toBeGreaterThan(0);
    expect(calls.knob.at(-1)!).toBeGreaterThan(0.18);
  });

  it(`a finger that rests still for ${TOUCH_HOLD_MS} ms on its label, then moves up, turns it; the page does not move`, async () => {
    const { calls, scroller, knobLabel } = setup();
    const from = centre(knobLabel);
    await finger(from, { x: from.x, y: from.y - 50 }, { steps: 10, holdMs: TOUCH_HOLD_MS + 120 });
    expect(scroller.scrollTop).toBe(0);
    expect(calls.knob.length).toBeGreaterThan(0);
    expect(calls.knob.at(-1)!).toBeGreaterThan(0.18);
  });
});

describe('a mouse', () => {
  it('still drags a fader from anywhere on it at once', async () => {
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    const { calls, scroller, fader, cap } = setup();
    const r = fader.getBoundingClientRect();
    const from = { x: r.left + 8, y: cap.getBoundingClientRect().bottom + 60 };
    await drag(from, { x: from.x, y: from.y - 50 }, 8);
    expect(scroller.scrollTop).toBe(0);
    expect(calls.fader.at(-1)!).toBeGreaterThan(-7);
  });
});
