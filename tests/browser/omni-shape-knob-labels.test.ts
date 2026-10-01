/**
 * Knob labels in real Chromium with the app's fonts: full words wrap to two
 * lines instead of being cut, small knobs keep one height whatever their
 * label, value or macro badge (so rows stay aligned and nothing jumps), and
 * every parameter name in the registry fits a small knob.
 */
import { createElement as h, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { Knob, type KnobProps } from '../../src/ui/components';
import { labelMayWrap } from '../../src/ui/components/Knob';
import { CHANNEL_PARAMS, INSTRUMENT_PARAMS, MASTERING_PARAMS, MODULE_PARAMS, specById, type ParamSpec } from '../../src/project/params';
import { cleanup, key, mount } from './ui-harness';

const ECHO = specById(CHANNEL_PARAMS, 'sendB')!; // "Echo Amount"
const PAN = specById(CHANNEL_PARAMS, 'pan')!; // "Pan"
const FILTER_ENV = specById(INSTRUMENT_PARAMS.poly, 'filterEnv')!; // "Filter Envelope"

const noop = () => {};
const knob = (spec: ParamSpec, extra: Partial<KnobProps> = {}) => h(Knob, { key: `${spec.id}-${extra.label ?? ''}-${extra.id ?? ''}-${extra.size ?? ''}-${extra.labelLines ?? ''}`, spec, value: spec.default, onChange: noop, size: 'sm', ...extra });

function row(children: ReturnType<typeof knob>[]) {
  const m = mount(h('div', { style: { display: 'flex', gap: '4px', alignItems: 'flex-start' } }, h(Fragment, null, ...children)));
  const knobs = [...m.container.querySelectorAll<HTMLElement>('[data-size]')];
  return { m, knobs };
}

const lines = (el: HTMLElement) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
const labelText = (k: HTMLElement) => k.querySelector<HTMLElement>('[class*="labelText"]')!;
const valueEl = (k: HTMLElement) => k.querySelector<HTMLElement>('[class*="value"]')!;

beforeEach(async () => {
  await document.fonts.ready;
});

afterEach(cleanup);

describe('Knob labels', () => {
  it('a long name wraps to two lines on a small knob instead of being cut off', () => {
    const { knobs } = row([knob(FILTER_ENV), knob(ECHO)]);
    for (const k of knobs) {
      const t = labelText(k);
      expect(lines(t)).toBe(2);
      expect(t.scrollHeight).toBeLessThanOrEqual(t.clientHeight + 1);
      expect(t.scrollWidth).toBeLessThanOrEqual(t.clientWidth + 1);
    }
    expect(labelText(knobs[0]).textContent).toBe('Filter Envelope');
  });

  it('small knobs in a row line up: one- and two-line labels take the same height', () => {
    const { knobs } = row([knob(PAN), knob(FILTER_ENV), knob(ECHO, { controlledBy: 'Echo' }), knob(PAN, { label: 'Pan', modulated: true })]);
    const heights = new Set(knobs.map((k) => Math.round(k.getBoundingClientRect().height)));
    expect(heights.size).toBe(1);
    const valueTops = new Set(knobs.map((k) => Math.round(valueEl(k).getBoundingClientRect().top)));
    expect(valueTops.size).toBe(1);
  });

  it('nothing moves while a knob is turned or taken over by a macro', () => {
    const { m, knobs } = row([knob(FILTER_ENV)]);
    const k = knobs[0];
    const before = k.getBoundingClientRect();
    const slider = k.querySelector<HTMLElement>('[role="slider"]')!;
    slider.focus();
    for (let i = 0; i < 5; i++) key(slider, 'keydown', { key: 'PageUp' });
    m.rerender(h('div', null, knob(FILTER_ENV, { value: 1, controlledBy: 'Chords Tone' })));
    const after = m.container.querySelector<HTMLElement>('[data-size]')!.getBoundingClientRect();
    expect(after.height).toBeCloseTo(before.height, 0);
    expect(after.width).toBeCloseTo(before.width, 0);
    // A long macro name in the badge stays within the knob's neighbourhood.
    const badge = m.container.querySelector<HTMLElement>('[class*="badge"]')!.getBoundingClientRect();
    expect(badge.width).toBeLessThanOrEqual(after.width + 16);
  });

  it('a lone small knob (the transport’s Master) stays compact; labelLines overrides the default', () => {
    const box = (k: HTMLElement) => k.querySelector<HTMLElement>('[class*="label"]')!.getBoundingClientRect().height;
    const lone = row([knob(PAN, { label: 'Master' })]);
    const one = box(lone.knobs[0]);
    expect(one).toBeLessThan(16);
    cleanup();
    // A row of short labels (the Play view's Level and Pan) stays compact too.
    const short = row([knob(PAN, { label: 'Level' }), knob(PAN)]);
    for (const k of short.knobs) expect(box(k)).toBeCloseTo(one, 0);
    cleanup();
    // One label that can wrap: the whole row reserves two lines, unless a knob asks for one.
    const mixed = row([knob(PAN), knob(ECHO), knob(PAN, { label: 'Width' }), knob(PAN, { label: 'Spread', labelLines: 1 })]);
    expect(box(mixed.knobs[0])).toBeGreaterThan(one * 1.8);
    expect(box(mixed.knobs[1])).toBeGreaterThan(one * 1.8);
    expect(box(mixed.knobs[2])).toBeGreaterThan(one * 1.8);
    expect(box(mixed.knobs[3])).toBeCloseTo(one, 0);
  });

  it('only multi-word names of ten or more characters are treated as able to wrap, and that holds for the registry', () => {
    expect(labelMayWrap('Resonance')).toBe(false);
    expect(labelMayWrap('Mono Bass')).toBe(false);
    expect(labelMayWrap('Reverb Amount')).toBe(true);
    // Every registry name the rule calls short really fits one line of a small knob.
    const specs = [...Object.values(MODULE_PARAMS).flat(), ...Object.values(INSTRUMENT_PARAMS).flat(), ...MASTERING_PARAMS].filter((s) => !labelMayWrap(s.label));
    const { knobs } = row(specs.map((s, i) => knob(s, { id: `s${i}`, labelLines: 1 })));
    const twoLines = knobs.map(labelText).filter((t) => lines(t) > 1).map((t) => t.textContent);
    expect(twoLines).toEqual([]);
  });

  it('larger knobs reserve one line unless asked for two, and still wrap a long name', () => {
    const { knobs } = row([knob(PAN, { size: 'md' }), knob(ECHO, { size: 'md' }), knob(PAN, { size: 'md', labelLines: 2 })]);
    expect(lines(labelText(knobs[0]))).toBe(1);
    const reserved = (k: HTMLElement) => k.querySelector<HTMLElement>('[class*="label"]')!.getBoundingClientRect().height;
    expect(reserved(knobs[2])).toBeGreaterThan(reserved(knobs[0]) * 1.8);
    expect(knobs[2].getAttribute('data-label-lines')).toBe('2');
    const echo = labelText(knobs[1]);
    expect(echo.scrollWidth).toBeLessThanOrEqual(echo.clientWidth + 1);
  });

  it('every parameter name in the registry fits a small knob in at most two lines', () => {
    const specs = [...Object.values(MODULE_PARAMS).flat(), ...Object.values(INSTRUMENT_PARAMS).flat(), ...MASTERING_PARAMS];
    const { knobs } = row(specs.map((s, i) => knob(s, { id: `k${i}` })));
    const cut = knobs
      .map(labelText)
      .filter((t) => t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1 || lines(t) > 2)
      .map((t) => t.textContent);
    expect(cut).toEqual([]);
  });
});
