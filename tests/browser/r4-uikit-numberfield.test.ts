/**
 * NumberField with real keys and a real mouse: with `blurOnCommit` (the transport's Tempo), Enter
 * commits and hands the keys back, so Space after Enter reaches the app (Play / Pause) instead of
 * typing into the field; one Escape reverts and leaves. Fields without it keep focus after Enter.
 * `dragStep` makes a drag land on whole steps (whole BPM). Units read as written ("bars", "s").
 */
import { createElement as h, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { NumberField, type NumberFieldChangeInfo } from '../../src/ui/components';
import { cleanup, mount } from './ui-harness';
import { centre, click, drag, settleFrames } from './r4-uikit-input';

afterEach(cleanup);

async function keys(text: string) {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.keyboard(text);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames();
}

function tempo(extra: Record<string, unknown> = {}) {
  const calls: [number, NumberFieldChangeInfo][] = [];
  function Host() {
    const [value, setValue] = useState(124);
    return h(NumberField, {
      label: 'Tempo',
      layout: 'inline',
      value,
      min: 40,
      max: 220,
      step: 1,
      fineStep: 0.1,
      unit: 'BPM',
      onChange: (v: number, i: NumberFieldChangeInfo) => {
        calls.push([v, i]);
        setValue(v);
      },
      ...extra,
    });
  }
  const m = mount(h(Host));
  const input = m.container.querySelector<HTMLInputElement>('input')!;
  return { m, calls, input };
}

describe('blurOnCommit', () => {
  it('Enter commits and gives the keys back: Space after it plays, it does not type into the field', async () => {
    const { calls, input } = tempo({ blurOnCommit: true });
    const seen: { key: string; target: string }[] = [];
    const onKey = (e: KeyboardEvent) => seen.push({ key: e.key, target: (e.target as Element).tagName });
    window.addEventListener('keydown', onKey);
    try {
      await click(centre(input));
      expect(document.activeElement).toBe(input);
      await keys('110{Enter}');
      expect(calls.at(-1)![0]).toBe(110);
      expect(document.activeElement).not.toBe(input);
      seen.length = 0;
      await keys(' a');
      // The keys went to the page (the instrument), not into the field.
      expect(seen.map((s) => s.target)).toEqual(['BODY', 'BODY']);
      expect(input.value).toBe('110');
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  it('a single Escape reverts typed text and leaves the field', async () => {
    const { calls, input } = tempo({ blurOnCommit: true });
    await click(centre(input));
    await keys('99');
    expect(input.value).toBe('99');
    await keys('{Escape}');
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe('124');
    expect(calls).toEqual([]);
  });

  it('after Enter the field can be dragged again at once', async () => {
    const { m, calls, input } = tempo({ blurOnCommit: true, dragStep: 1 });
    await click(centre(input));
    await keys('110{Enter}');
    const p = centre(input);
    await drag(p, { x: p.x, y: p.y - 40 }, 10);
    expect(calls.at(-1)![0]).toBeGreaterThan(110);
    expect(m.container.querySelector('input')).toBe(input);
  });

  it('fields without it keep focus after Enter (dialog fields)', async () => {
    const { input } = tempo();
    await click(centre(input));
    await keys('118{Enter}');
    expect(document.activeElement).toBe(input);
  });
});

describe('dragStep', () => {
  it('a drag lands on whole BPM', async () => {
    const { calls, input } = tempo({ dragStep: 1 });
    const p = centre(input);
    await drag(p, { x: p.x, y: p.y - 37 }, 12);
    const values = calls.map((c) => c[0]);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
    expect(values.at(-1)).toBeGreaterThan(124);
  });

  it('without it a drag may land between whole numbers (fine resolution)', async () => {
    const { calls, input } = tempo({ dragPixelsPerStep: 3 });
    const p = centre(input);
    await drag(p, { x: p.x, y: p.y - 20 }, 15);
    expect(calls.some((c) => !Number.isInteger(c[0]))).toBe(true);
  });
});

describe('units', () => {
  it('read as written: "bars", "s" in lower case, "BPM" in capitals', () => {
    const m = mount(h('div', null, h(NumberField, { label: 'Length', value: 8, min: 1, max: 64, unit: 'bars', onChange: () => {} }), h(NumberField, { label: 'Echo tail', value: 2, min: 0, max: 10, step: 0.5, unit: 's', onChange: () => {} }), h(NumberField, { label: 'Tempo', value: 124, min: 40, max: 220, unit: 'BPM', onChange: () => {} })));
    const units = [...m.container.querySelectorAll<HTMLElement>('[class*="unit"]')];
    expect(units.map((u) => u.innerText)).toEqual(['bars', 's', 'BPM']);
    for (const u of units) expect(getComputedStyle(u).textTransform).toBe('none');
  });
});
