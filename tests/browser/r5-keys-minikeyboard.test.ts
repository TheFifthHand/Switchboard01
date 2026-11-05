/**
 * MiniKeyboard's scale keyboard (`notes`) on its own, in real Chromium: one equal key per note,
 * named as the key writes it (`pitchNames`), roots with their octave; the real mouse plays the key
 * under it; every note key is a button named by its note that a click with no pointer press (a
 * screen reader's) plays briefly; other notes under a held key release it.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { MiniKeyboard } from '../../src/ui/components';
import { keyNoteNames, scaleKeyboardNotes } from '../../src/music/scales';
import { cleanup, mount, pointer, pointIn, wait } from './ui-harness';
import { centre, click } from './r4-uikit-input';

afterEach(cleanup);

const F_MAJOR = scaleKeyboardNotes(5, 'major', 60, 15);

function board(props: Record<string, unknown> = {}) {
  const events: [string, number][] = [];
  const el = (extra: Record<string, unknown> = {}) =>
    h(
      'div',
      { style: { width: '700px' } },
      h(MiniKeyboard, {
        baseNote: 60,
        notes: F_MAJOR,
        rootPc: 5,
        pitchNames: keyNoteNames(5, 'major'),
        keyLabels: { [F_MAJOR[0]]: 'A', [F_MAJOR[1]]: 'S' },
        height: 90,
        fit: true,
        keyMaxWidth: 64,
        onNoteOn: (n: number) => events.push(['on', n]),
        onNoteOff: (n: number) => events.push(['off', n]),
        ...props,
        ...extra,
      }),
    );
  const m = mount(el(), { width: 740 });
  const group = m.container.querySelector<HTMLElement>('[role="group"]')!;
  const keys = () => [...group.querySelectorAll<HTMLElement>('[data-midi]')];
  return { m, el, group, keys, events };
}

describe('MiniKeyboard notes (a scale keyboard)', () => {
  it('one equal key per note, named by the key (B♭, roots with their octave), letters where given, no rail', () => {
    const { group, keys } = board();
    expect(keys().map((k) => Number(k.dataset.midi))).toEqual(F_MAJOR);
    expect(keys().map((k) => k.getAttribute('aria-label'))).toEqual(['F3 (root)', 'G3', 'A3', 'B♭3', 'C4', 'D4', 'E4', 'F4 (root)', 'G4', 'A4', 'B♭4', 'C5', 'D5', 'E5', 'F5 (root)']);
    expect(keys().map((k) => k.querySelector('[class*="stepName"]')!.textContent)).toEqual(['F3', 'G', 'A', 'B♭', 'C', 'D', 'E', 'F4', 'G', 'A', 'B♭', 'C', 'D', 'E', 'F5']);
    expect(keys().map((k) => k.querySelector('[class*="keycap"]')?.textContent ?? '')).toEqual(['A', 'S', ...Array(13).fill('')]);
    const widths = keys().map((k) => k.getBoundingClientRect().width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.5);
    // Fit: 15 keys of at most 64 px fill the 700 px.
    expect(group.getBoundingClientRect().width).toBeCloseTo(700, 0);
    expect(group.querySelector('[class*="rail"]')).toBeNull();
    expect(group.getAttribute('aria-label')).toBe('Keyboard, F3 to F5');
  });

  it('the real mouse plays the key under it, anywhere on it', async () => {
    const { keys, events } = board();
    await click(centre(keys()[3], 0.5, 0.2));
    await click(centre(keys()[4], 0.03, 0.95));
    expect(events).toEqual([
      ['on', 58],
      ['off', 58],
      ['on', 60],
      ['off', 60],
    ]);
  });

  it('a click with no pointer press (a screen reader activating the key) plays it briefly; a real click does not play twice', async () => {
    const { keys, events } = board();
    keys()[2].click();
    expect(events).toEqual([['on', 57]]);
    await wait(400);
    expect(events).toEqual([
      ['on', 57],
      ['off', 57],
    ]);
    events.length = 0;
    await click(centre(keys()[2]));
    expect(events).toEqual([
      ['on', 57],
      ['off', 57],
    ]);
  });

  it('other notes under a held key release it (Assist or the key changed)', () => {
    const { m, el, group, keys, events } = board();
    const p = pointIn(keys()[1], 0.6);
    pointer(group, 'pointerdown', p);
    m.rerender(el({ notes: scaleKeyboardNotes(9, 'minor', 60, 15), rootPc: 9, pitchNames: keyNoteNames(9, 'minor') }));
    expect(events).toEqual([
      ['on', 55],
      ['off', 55],
    ]);
    pointer(group, 'pointerup', p);
    expect(events).toHaveLength(2);
  });
});
