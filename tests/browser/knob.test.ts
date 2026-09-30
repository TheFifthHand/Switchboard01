import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Knob, type KnobChangeInfo } from '../../src/ui/components';
import { BASS_PARAMS, CHANNEL_PARAMS, formatParam, fromNormalized, specById, toNormalized, type ParamSpec } from '../../src/project/params';
import { actFrame, cleanup, fire, key, mount, pointer, pointIn, wait } from './ui-harness';

const AMOUNT: ParamSpec = { id: 'amount', label: 'Amount', min: 0, max: 1, default: 0.25, unit: '%', curve: 'lin', tip: 'How much.' };
const CUTOFF = specById(BASS_PARAMS, 'cutoff')!;
const WAVE = specById(BASS_PARAMS, 'wave')!;
const OCTAVE = specById(BASS_PARAMS, 'octave')!;
const PAN = specById(CHANNEL_PARAMS, 'pan')!;

type Call = [number, KnobChangeInfo];

function setup(spec: ParamSpec, value: number, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const m = mount(h(Knob, { spec, value, onChange: (v: number, info: KnobChangeInfo) => calls.push([v, info]), ...extra }));
  const slider = m.container.querySelector<HTMLElement>('[role="slider"]')!;
  return { m, calls, slider };
}

function drag(slider: HTMLElement, dy: number, init: PointerEventInit = {}) {
  const start = pointIn(slider);
  pointer(slider, 'pointerdown', start);
  // Several small moves, like a real drag.
  const steps = 5;
  for (let i = 1; i <= steps; i++) pointer(slider, 'pointermove', { ...start, clientY: start.clientY - (dy * i) / steps, ...init });
  pointer(slider, 'pointerup', { ...start, clientY: start.clientY - dy });
}

afterEach(cleanup);

describe('Knob dragging', () => {
  it('dragging up increases the value; 200 px covers the full range', () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    drag(slider, 50);
    const last = calls[calls.length - 1];
    expect(last[1].final).toBe(true);
    expect(last[0]).toBeCloseTo(0.75, 5);
    // One drag = one gesture id.
    expect(new Set(calls.map((c) => c[1].gesture)).size).toBe(1);
  });

  it('dragging down decreases and clamps at the minimum', () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    drag(slider, -400);
    expect(calls[calls.length - 1][0]).toBe(0);
  });

  it('Shift makes the drag 10x finer', () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    drag(slider, 50, { shiftKey: true });
    expect(calls[calls.length - 1][0]).toBeCloseTo(0.525, 5);
  });

  it('moves evenly in normalised space on exponential parameters', () => {
    const { calls, slider } = setup(CUTOFF, 700);
    drag(slider, 40); // 20% of travel
    const expected = fromNormalized(CUTOFF, toNormalized(CUTOFF, 700) + 0.2);
    expect(calls[calls.length - 1][0]).toBeCloseTo(expected, 3);
    // Geometric, not linear: +20% of travel from 700 Hz is far less than +20% of the Hz range.
    expect(expected).toBeLessThan(700 + 0.2 * (CUTOFF.max - CUTOFF.min));
  });

  it('coalesces changes to at most one per animation frame during a drag', async () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    const start = pointIn(slider);
    pointer(slider, 'pointerdown', start);
    for (let i = 1; i <= 8; i++) pointer(slider, 'pointermove', { ...start, clientY: start.clientY - i * 4 });
    expect(calls.length).toBe(0);
    await actFrame();
    expect(calls.length).toBe(1);
    expect(calls[0][1].final).toBe(false);
    expect(calls[0][0]).toBeCloseTo(0.5 + 32 / 200, 5);
    pointer(slider, 'pointerup', { ...start, clientY: start.clientY - 32 });
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual([calls[0][0], { gesture: calls[0][1].gesture, final: true }]);
  });

  it('a pointer cancel ends the gesture with a final call', () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    const start = pointIn(slider);
    pointer(slider, 'pointerdown', start);
    pointer(slider, 'pointermove', { ...start, clientY: start.clientY - 20 });
    pointer(slider, 'pointercancel', start);
    expect(calls.length).toBe(1);
    expect(calls[0][1].final).toBe(true);
    expect(calls[0][0]).toBeCloseTo(0.6, 5);
  });

  it('a click without movement changes nothing', () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    const p = pointIn(slider);
    pointer(slider, 'pointerdown', p);
    pointer(slider, 'pointerup', p);
    expect(calls).toEqual([]);
  });

  it('double-click resets to the default', () => {
    const { calls, slider } = setup(CUTOFF, 3000);
    fire(slider, new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(CUTOFF.default);
    expect(calls[0][1].final).toBe(true);
  });

  it('a knob controlled by a macro is read-only and names the macro', () => {
    const { calls, slider, m } = setup(CUTOFF, 3000, { controlledBy: 'Tone' });
    drag(slider, 60);
    key(slider, 'keydown', { key: 'ArrowUp' });
    fire(slider, new MouseEvent('dblclick', { bubbles: true }));
    expect(calls).toEqual([]);
    expect(slider.getAttribute('aria-readonly')).toBe('true');
    expect(slider.getAttribute('aria-valuetext')).toBe('3.00 kHz, set by Tone');
    expect(m.container.textContent).toContain('Tone');
  });

  it('a disabled knob ignores input and leaves the tab order', () => {
    const { calls, slider } = setup(AMOUNT, 0.5, { disabled: true });
    drag(slider, 60);
    key(slider, 'keydown', { key: 'ArrowUp' });
    expect(calls).toEqual([]);
    expect(slider.tabIndex).toBe(-1);
    expect(slider.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Knob keyboard', () => {
  it('arrow keys step 1% of travel, Shift 0.1%, PageUp 10%, Home/End jump to the ends', () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    slider.focus();
    key(slider, 'keydown', { key: 'ArrowUp' });
    expect(calls.at(-1)![0]).toBeCloseTo(0.51, 6);
    key(slider, 'keydown', { key: 'ArrowUp', shiftKey: true });
    expect(calls.at(-1)![0]).toBeCloseTo(0.511, 6);
    key(slider, 'keydown', { key: 'ArrowDown' });
    expect(calls.at(-1)![0]).toBeCloseTo(0.501, 6);
    key(slider, 'keydown', { key: 'PageUp' });
    expect(calls.at(-1)![0]).toBeCloseTo(0.601, 6);
    key(slider, 'keydown', { key: 'End' });
    expect(calls.at(-1)![0]).toBe(1);
    key(slider, 'keydown', { key: 'Home' });
    expect(calls.at(-1)![0]).toBe(0);
    // The whole burst is one gesture; leaving the knob finalises it.
    expect(new Set(calls.map((c) => c[1].gesture)).size).toBe(1);
    expect(calls.every((c) => !c[1].final)).toBe(true);
    slider.blur();
    expect(calls.at(-1)).toEqual([0, { gesture: calls[0][1].gesture, final: true }]);
  });

  it('a key burst finalises by itself after a pause', async () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    slider.focus();
    key(slider, 'keydown', { key: 'ArrowUp' });
    await wait(900);
    expect(calls.at(-1)![1].final).toBe(true);
    key(slider, 'keydown', { key: 'ArrowUp' });
    expect(calls.at(-1)![1].gesture).not.toBe(calls[0][1].gesture);
  });

  it('stepped parameters move by at least one step', () => {
    const { calls, slider } = setup(OCTAVE, 0);
    slider.focus();
    key(slider, 'keydown', { key: 'ArrowUp' });
    expect(calls.at(-1)![0]).toBe(1);
    key(slider, 'keydown', { key: 'ArrowUp', shiftKey: true });
    expect(calls.at(-1)![0]).toBe(2);
    key(slider, 'keydown', { key: 'ArrowUp' });
    expect(calls).toHaveLength(2); // already at the maximum: no change reported
  });

  it('Delete resets to the default (keyboard equivalent of double-click)', () => {
    const { calls, slider } = setup(AMOUNT, 0.9);
    slider.focus();
    key(slider, 'keydown', { key: 'Delete' });
    expect(calls.at(-1)![0]).toBe(0.25);
  });
});

describe('Knob wheel', () => {
  it('does nothing unless the knob has keyboard focus', () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    const unfocused = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    fire(slider, unfocused);
    expect(calls).toEqual([]);
    expect(unfocused.defaultPrevented).toBe(false); // the page scrolls normally

    slider.focus();
    const focused = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    fire(slider, focused);
    expect(focused.defaultPrevented).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeGreaterThan(0.5);
  });

  it('does nothing after the knob was merely clicked (pointer focus is not keyboard focus)', () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    const p = pointIn(slider);
    pointer(slider, 'pointerdown', p);
    pointer(slider, 'pointerup', p);
    expect(document.activeElement).toBe(slider);
    fire(slider, new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(calls).toEqual([]);
    // Using the keyboard on it arms the wheel.
    key(slider, 'keydown', { key: 'Shift', shiftKey: true });
    fire(slider, new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeLessThan(0.5);
  });
});

describe('Knob accessibility', () => {
  it('exposes slider semantics with a unit-formatted value text', () => {
    const { slider } = setup(CUTOFF, 2400);
    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('aria-label')).toBe('Cutoff');
    expect(slider.getAttribute('aria-valuemin')).toBe(String(CUTOFF.min));
    expect(slider.getAttribute('aria-valuemax')).toBe(String(CUTOFF.max));
    expect(slider.getAttribute('aria-valuenow')).toBe('2400');
    expect(slider.getAttribute('aria-valuetext')).toBe(formatParam(CUTOFF, 2400));
    expect(slider.getAttribute('aria-valuetext')).toBe('2.40 kHz');
    expect(slider.tabIndex).toBe(0);
  });

  it('enum parameters read their option names', () => {
    const { slider, calls } = setup(WAVE, 1);
    expect(slider.getAttribute('aria-valuetext')).toBe('Square');
    slider.focus();
    key(slider, 'keydown', { key: 'ArrowUp' });
    expect(calls.at(-1)![0]).toBe(2);
    expect(slider.getAttribute('aria-valuetext')).toBe('Triangle');
  });

  it('a custom label becomes the accessible name; modulation is announced', () => {
    const { slider } = setup(PAN, -0.2, { label: 'Bass pan', modulated: true });
    expect(slider.getAttribute('aria-label')).toBe('Bass pan');
    expect(slider.getAttribute('aria-valuetext')).toBe('L20, modulated');
  });

  it('the tip is linked with aria-describedby', () => {
    const { slider } = setup(CUTOFF, 700);
    const id = slider.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)!.textContent).toContain(CUTOFF.tip);
  });
});

describe('Knob numeric entry', () => {
  it('Enter opens an entry field; "2.5k" sets 2500 Hz', () => {
    const { calls, slider, m } = setup(CUTOFF, 700);
    slider.focus();
    key(slider, 'keydown', { key: 'Enter' });
    const input = m.container.querySelector('input')!;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    setInput(input, '2.5k');
    key(input, 'keydown', { key: 'Enter' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(2500);
    expect(calls[0][1].final).toBe(true);
    expect(m.container.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(slider);
  });

  it('typing a digit starts entry with that digit; units and signs are understood', () => {
    const level = specById(BASS_PARAMS, 'level')!;
    const { calls, slider, m } = setup(level, 0);
    slider.focus();
    const ev = key(slider, 'keydown', { key: '-' });
    expect(ev.defaultPrevented).toBe(true);
    const input = m.container.querySelector('input')!;
    expect(input.value).toBe('-');
    setInput(input, '-6 dB');
    key(input, 'keydown', { key: 'Enter' });
    expect(calls.at(-1)![0]).toBe(-6);
  });

  it('Escape cancels; invalid text keeps the field open and changes nothing', () => {
    const { calls, slider, m } = setup(CUTOFF, 700);
    slider.focus();
    key(slider, 'keydown', { key: 'Enter' });
    let input = m.container.querySelector('input')!;
    setInput(input, 'loud');
    key(input, 'keydown', { key: 'Enter' });
    input = m.container.querySelector('input')!;
    expect(input).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    key(input, 'keydown', { key: 'Escape' });
    expect(m.container.querySelector('input')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('times typed as plain numbers are read in the unit shown (ms below one second)', () => {
    const decay = specById(BASS_PARAMS, 'decay')!; // shows "300 ms"
    const { calls, slider, m } = setup(decay, 0.3);
    slider.focus();
    key(slider, 'keydown', { key: '4' });
    const input = m.container.querySelector('input')!;
    setInput(input, '450');
    key(input, 'keydown', { key: 'Enter' });
    expect(calls.at(-1)![0]).toBeCloseTo(0.45, 6);
  });
});

/** Set an input's value the way typing does, so React's onChange fires. */
function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  fire(input, new Event('input', { bubbles: true }));
}
