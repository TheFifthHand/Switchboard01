/**
 * Fader in real Chromium: drag with pointer capture (one gesture per drag,
 * coalesced per frame, Shift fine), double-click default, keyboard (dB steps,
 * Page, Home/End, one gesture per burst), wheel only with keyboard focus,
 * typed entry, read-only when a macro sets it, the audio taper, accessibility.
 */
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { FADER_BURST_IDLE_MS, Fader, TipsProvider, faderPosition, faderValue, type FaderChangeInfo } from '../../src/ui/components';
import { CHANNEL_PARAMS, MASTER_VOLUME_SPEC, specById, type ParamSpec } from '../../src/project/params';
import { actFrame, cleanup, fire, key, mount, pointer, pointIn, wait } from './ui-harness';

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;
const AMOUNT: ParamSpec = { id: 'amount', label: 'Amount', min: 0, max: 1, default: 0.25, unit: '%', curve: 'lin', tip: 'How much.' };

type Call = [number, FaderChangeInfo];

function setup(spec: ParamSpec, value: number, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const m = mount(h(TipsProvider, { enabled: false }, h(Fader, { spec, value, label: 'Drums level', onChange: (v: number, info: FaderChangeInfo) => calls.push([v, info]), ...extra })), { width: 120 });
  m.container.style.height = '320px';
  const slider = m.container.querySelector<HTMLElement>('[role="slider"]')!;
  const cap = m.container.querySelector<HTMLElement>('[class*="cap"]')!;
  return { m, calls, slider, cap };
}

/** Lane travel in px (lane height minus cap height). */
function travel(slider: HTMLElement): number {
  const lane = slider.querySelector<HTMLElement>('[class*="lane"]')!;
  const cap = slider.querySelector<HTMLElement>('[class*="cap"]')!;
  return lane.getBoundingClientRect().height - cap.getBoundingClientRect().height;
}

function drag(slider: HTMLElement, dy: number, init: PointerEventInit = {}) {
  const start = pointIn(slider);
  pointer(slider, 'pointerdown', start);
  const steps = 6;
  for (let i = 1; i <= steps; i++) pointer(slider, 'pointermove', { ...start, clientY: start.clientY - (dy * i) / steps, ...init });
  pointer(slider, 'pointerup', { ...start, clientY: start.clientY - dy });
}

afterEach(cleanup);

describe('Fader taper', () => {
  it('puts 0 dB about four fifths of the way up and round-trips to 0.1 dB', () => {
    const unity = faderPosition(LEVEL, 0);
    expect(unity).toBeGreaterThan(0.75);
    expect(unity).toBeLessThan(0.85);
    expect(faderPosition(LEVEL, LEVEL.min)).toBe(0);
    expect(faderPosition(LEVEL, LEVEL.max)).toBe(1);
    // More travel per dB near unity than near the bottom.
    expect(faderPosition(LEVEL, 0) - faderPosition(LEVEL, -10)).toBeGreaterThan(faderPosition(LEVEL, -40) - faderPosition(LEVEL, -50));
    for (const db of [-60, -42.5, -20, -6, -0.5, 0, 3.2, 6]) expect(faderValue(LEVEL, faderPosition(LEVEL, db))).toBeCloseTo(db, 5);
    // Non-dB faders are linear in the registry's normalised space.
    expect(faderPosition(AMOUNT, 0.4)).toBeCloseTo(0.4, 9);
  });
});

describe('Fader dragging', () => {
  it('is a vertical slider named for its part, with the value in dB', () => {
    const { slider } = setup(LEVEL, -3);
    expect(slider.getAttribute('aria-orientation')).toBe('vertical');
    expect(slider.getAttribute('aria-label')).toBe('Drums level');
    expect(slider.getAttribute('aria-valuenow')).toBe('-3');
    expect(slider.getAttribute('aria-valuemin')).toBe('-60');
    expect(slider.getAttribute('aria-valuemax')).toBe('6');
    expect(slider.getAttribute('aria-valuetext')).toBe('-3.0 dB');
    expect(slider.tabIndex).toBe(0);
  });

  it('the cap follows the pointer one to one; one drag is one gesture ending with final', () => {
    const { calls, slider } = setup(LEVEL, 0);
    const px = travel(slider);
    drag(slider, -px * 0.2);
    const last = calls[calls.length - 1];
    expect(last[1].final).toBe(true);
    expect(last[0]).toBeCloseTo(faderValue(LEVEL, faderPosition(LEVEL, 0) - 0.2), 1);
    expect(new Set(calls.map((c) => c[1].gesture)).size).toBe(1);
  });

  it('a press without movement changes nothing (no jumps)', () => {
    const { calls, slider } = setup(LEVEL, -6);
    const at = pointIn(slider, 0.05);
    pointer(slider, 'pointerdown', at);
    pointer(slider, 'pointerup', at);
    expect(calls).toHaveLength(0);
  });

  it('Shift makes the drag 10x finer and changes are coalesced per frame', async () => {
    const { calls, slider } = setup(AMOUNT, 0.5);
    const px = travel(slider);
    const start = pointIn(slider);
    pointer(slider, 'pointerdown', start);
    for (let i = 1; i <= 5; i++) pointer(slider, 'pointermove', { ...start, clientY: start.clientY - (px * 0.5 * i) / 5, shiftKey: true });
    expect(calls).toHaveLength(0);
    await actFrame();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeCloseTo(0.55, 3);
    pointer(slider, 'pointerup', { ...start, clientY: start.clientY - px * 0.5 });
    expect(calls[1][1].final).toBe(true);
  });

  it('double-click returns to the default', () => {
    const { calls, slider } = setup(MASTER_VOLUME_SPEC, -20);
    fire(slider, new MouseEvent('dblclick', { bubbles: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(MASTER_VOLUME_SPEC.default);
    expect(calls[0][1].final).toBe(true);
  });
});

describe('Fader keyboard and wheel', () => {
  it('arrows move 0.5 dB (Shift 0.1 dB), Page 10% of travel, Home/End the ends, Delete the default', async () => {
    const { calls, slider } = setup(LEVEL, -3);
    slider.focus();
    key(slider, 'keydown', { key: 'ArrowUp' });
    expect(calls[0][0]).toBe(-2.5);
    key(slider, 'keydown', { key: 'ArrowDown', shiftKey: true });
    expect(calls[1][0]).toBe(-2.6);
    // One key burst is one gesture; it ends (final) after a pause.
    expect(calls[0][1].gesture).toBe(calls[1][1].gesture);
    await act(async () => wait(FADER_BURST_IDLE_MS + 80));
    expect(calls[2]).toEqual([-2.6, { gesture: calls[0][1].gesture, final: true }]);
    // The owner did not apply the change (value stays -3): the fader shows and steps from its value again.
    expect(slider.getAttribute('aria-valuenow')).toBe('-3');
    key(slider, 'keydown', { key: 'PageUp' });
    expect(calls[3][0]).toBeCloseTo(faderValue(LEVEL, faderPosition(LEVEL, -3) + 0.1), 5);
    key(slider, 'keydown', { key: 'Home' });
    expect(calls[calls.length - 1][0]).toBe(-60);
    key(slider, 'keydown', { key: 'End' });
    expect(calls[calls.length - 1][0]).toBe(6);
    key(slider, 'keydown', { key: 'Delete' });
    expect(calls[calls.length - 1][0]).toBe(0);
  });

  it('the wheel does nothing after a click, but works once the fader has keyboard focus', () => {
    const { calls, slider } = setup(LEVEL, 0);
    const at = pointIn(slider);
    pointer(slider, 'pointerdown', at);
    pointer(slider, 'pointerup', at);
    expect(document.activeElement).toBe(slider);
    fire(slider, new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(calls).toHaveLength(0);
    // Keyboard use arms the wheel.
    key(slider, 'keydown', { key: 'ArrowUp' });
    const ev = fire(slider, new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(ev.defaultPrevented).toBe(true);
    expect(calls[calls.length - 1][0]).toBe(1);
  });

  it('typing a number opens entry; Enter commits it as one final change', () => {
    const { calls, slider, m } = setup(LEVEL, 0);
    slider.focus();
    key(slider, 'keydown', { key: '-' });
    const input = m.container.querySelector<HTMLInputElement>('input')!;
    expect(input).not.toBeNull();
    expect(input.getAttribute('aria-label')).toBe('Drums level value');
    // React controlled input: set the value through the native setter.
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, '-7.26');
    fire(input, new Event('input', { bubbles: true }));
    key(input, 'keydown', { key: 'Enter' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(-7.3);
    expect(calls[0][1].final).toBe(true);
    expect(m.container.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(slider);
  });

  it('a level set by a macro is read-only and says so', () => {
    const { calls, slider } = setup(LEVEL, -4, { controlledBy: 'Space' });
    expect(slider.getAttribute('aria-readonly')).toBe('true');
    expect(slider.getAttribute('aria-valuetext')).toBe('-4.0 dB, set by Space');
    slider.focus();
    key(slider, 'keydown', { key: 'ArrowUp' });
    drag(slider, 40);
    fire(slider, new MouseEvent('dblclick', { bubbles: true }));
    expect(calls).toHaveLength(0);
  });

  it('the cap sits at the value’s position and is at least 40 px wide with the scale', () => {
    const { slider, cap } = setup(LEVEL, 0);
    const lane = slider.querySelector<HTMLElement>('[class*="lane"]')!.getBoundingClientRect();
    const c = cap.getBoundingClientRect();
    const pos = (lane.bottom - c.bottom) / (lane.height - c.height);
    expect(pos).toBeCloseTo(faderPosition(LEVEL, 0), 2);
    expect(slider.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
  });
});
