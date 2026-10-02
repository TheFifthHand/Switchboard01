/**
 * Typed values are one click away (real mouse and keyboard): the value under a fader or a number
 * knob is a key named "<name>: <value>, type a value" that opens the entry; the fader's value row
 * never spills out (formatShort for the visible text, the full text in aria and the title). A
 * knob set by a macro keeps its dial clear (a chain before the value, a teal outer arc), and big
 * screens get an xl knob.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { Fader, Knob, TipsProvider, type FaderChangeInfo, type KnobChangeInfo } from '../../src/ui/components';
import { BASS_PARAMS, CHANNEL_PARAMS, specById } from '../../src/project/params';
import { cleanup, mount } from './ui-harness';
import { centre, click, settleFrames } from './r4-uikit-input';

afterEach(cleanup);

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;
const CUTOFF = specById(BASS_PARAMS, 'cutoff')!;
const WAVE = specById(BASS_PARAMS, 'wave')!;
const MINUS = '−';
const db = (v: number) => `${v < 0 ? MINUS : v > 0 ? '+' : ''}${Math.abs(v).toFixed(1)} dB`;
const levelText = (v: number) => (v <= LEVEL.min ? `Silent (${db(v)})` : db(v));
const levelShort = (v: number) => (v <= LEVEL.min ? 'Silent' : db(v));

async function typeKeys(text: string) {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.keyboard(text);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames();
}

function fader(value: number, width = 60, extra: Record<string, unknown> = {}) {
  const calls: [number, FaderChangeInfo][] = [];
  const m = mount(
    h(TipsProvider, { enabled: false }, h('div', { style: { width: `${width}px`, height: '300px', display: 'flex' } }, h(Fader, { spec: LEVEL, value, label: 'Bass level', format: levelText, formatShort: levelShort, onChange: (v: number, i: FaderChangeInfo) => calls.push([v, i]), ...extra }))),
  );
  return { m, calls, readout: () => m.container.querySelector<HTMLElement>('[class*="value"]')! };
}

describe('the fader value is a key for typed entry', () => {
  it('is named for the level, opens the entry on a click, and takes a typed value', async () => {
    const { m, calls, readout } = fader(-7);
    const key = readout();
    expect(key.tagName).toBe('BUTTON');
    expect(key.getAttribute('aria-label')).toBe(`Bass level: ${MINUS}7.0 dB, type a value`);
    expect(key.tabIndex).toBe(-1); // the fader itself is the tab stop (Enter on it opens the same entry)
    await click(centre(key));
    const input = m.container.querySelector<HTMLInputElement>('input')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.selectionEnd! - input.selectionStart!).toBe(input.value.length);
    await typeKeys('-12{Enter}');
    expect(calls.at(-1)).toEqual([-12, { gesture: expect.any(String), final: true }]);
    expect(m.container.querySelector('input')).toBeNull();
    // Focus returns to the fader, so the arrow keys go on from there.
    expect(document.activeElement?.getAttribute('role')).toBe('slider');
  });

  it('at the bottom shows "Silent" in its own width; the full text is in aria and the title', async () => {
    const { m, readout } = fader(LEVEL.min, 60);
    const key = readout();
    const slider = m.container.querySelector('[role="slider"]')!;
    expect(key.textContent).toBe('Silent');
    expect(slider.getAttribute('aria-valuetext')).toBe(`Silent (${MINUS}60.0 dB)`);
    expect(key.getAttribute('title')).toBe(`Silent (${MINUS}60.0 dB)`);
    const fr = m.container.querySelector('[class*="fader"]')!.getBoundingClientRect();
    const r = key.getBoundingClientRect();
    expect(r.left).toBeGreaterThanOrEqual(fr.left - 0.5);
    expect(r.right).toBeLessThanOrEqual(fr.right + 0.5);
  });

  it('never spills out of a narrow strip, even without a short form: it ends in an ellipsis', async () => {
    const { m, readout } = fader(LEVEL.min, 50, { formatShort: undefined });
    const text = readout().querySelector<HTMLElement>('[class*="valueText"]')!;
    expect(text.textContent).toBe(`Silent (${MINUS}60.0 dB)`);
    expect(getComputedStyle(text).textOverflow).toBe('ellipsis');
    expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(m.container.querySelector('[class*="fader"]')!.getBoundingClientRect().right + 0.5);
  });

  it('a level set by a macro has no entry key: it names the macro', () => {
    const { readout } = fader(-4, 90, { controlledBy: 'Space' });
    expect(readout().tagName).toBe('DIV');
    expect(readout().textContent).toContain('Space');
  });
});

describe('the knob value is a key for typed entry', () => {
  it('opens the entry on a click; "2.5k" sets 2.5 kHz', async () => {
    const calls: [number, KnobChangeInfo][] = [];
    const m = mount(h(TipsProvider, { enabled: false }, h(Knob, { spec: CUTOFF, value: 700, onChange: (v: number, i: KnobChangeInfo) => calls.push([v, i]) })));
    const key = m.container.querySelector<HTMLButtonElement>('button[class*="value"]')!;
    expect(key.getAttribute('aria-label')).toMatch(/^Cutoff: .+, type a value$/);
    await click(centre(key));
    expect(document.activeElement?.tagName).toBe('INPUT');
    await typeKeys('2.5k{Enter}');
    expect(calls.at(-1)![0]).toBeCloseTo(2500, 6);
  });

  it('option knobs are turned, not typed: their value is plain text', () => {
    const m = mount(h(Knob, { spec: WAVE, value: 0, onChange: () => {} }));
    expect(m.container.querySelector('button')).toBeNull();
  });
});

describe('a knob set by a macro', () => {
  it('keeps the dial clear: a chain before the value, a teal outer arc, the macro named in its value text', () => {
    const m = mount(h(TipsProvider, { enabled: false }, h(Knob, { spec: CUTOFF, value: 3000, size: 'sm', controlledBy: 'Tone', macroRange: [400, 6000], onChange: () => {} })));
    const dial = m.container.querySelector<HTMLElement>('[class*="dial"]')!.getBoundingClientRect();
    const badge = m.container.querySelector<HTMLElement>('[class*="badge"]')!;
    const b = badge.getBoundingClientRect();
    // Nothing of the badge lies on the dial.
    expect(b.top >= dial.bottom || b.bottom <= dial.top || b.left >= dial.right || b.right <= dial.left).toBe(true);
    expect(badge.querySelector('svg[data-icon="link"]')).not.toBeNull();
    const arc = m.container.querySelector<SVGPathElement>('svg [class*="macroArc"]')!;
    expect(arc).not.toBeNull();
    const teal = document.createElement('span');
    teal.style.color = 'var(--teal-key)';
    document.body.append(teal);
    expect(getComputedStyle(arc).stroke).toBe(getComputedStyle(teal).color);
    teal.remove();
    expect(m.container.querySelector('[role="slider"]')!.getAttribute('aria-valuetext')).toBe('3.00 kHz, set by Tone');
  });
});

describe('big screens', () => {
  it("an 'xl' knob has an 80 px dial", () => {
    const m = mount(h(Knob, { spec: CUTOFF, value: 3000, size: 'xl', onChange: () => {} }));
    const dial = m.container.querySelector<HTMLElement>('[class*="dial"]')!.getBoundingClientRect();
    expect(dial.width).toBe(80);
    expect(dial.height).toBe(80);
  });

  it('a knob answers the pointer with a teal halo', async () => {
    const m = mount(h(Knob, { spec: CUTOFF, value: 3000, onChange: () => {} }));
    const dial = m.container.querySelector<HTMLElement>('[class*="dial"]')!;
    expect(getComputedStyle(dial).boxShadow).toBe('none');
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    g.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await userEvent.hover(dial);
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(getComputedStyle(dial).boxShadow).toContain('0px 0px 0px 4px');
  });
});
