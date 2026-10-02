/**
 * The on-screen keyboard in real Chromium: every key can show its computer letter while the note
 * names (C keys, the root) sit on a rail above their keys instead of stacking on the scale dots;
 * `fit` widens the keys to the container up to about 44 px (no extra keys); the kit variant is 16
 * named sound keys in 4 rows with their letters, played with the real mouse.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { DRUM_KEYS, MiniKeyboard, noteKeyLabels } from '../../src/ui/components';
import { DRUM_SLOTS } from '../../src/content/catalog';
import { scaleMask } from '../../src/music/scales';
import { cleanup, mount } from './ui-harness';
import { centre, click, mouse } from './r4-uikit-input';

afterEach(cleanup);

const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function piano(width: number, extra: Record<string, unknown> = {}) {
  const events: [string, number][] = [];
  const m = mount(
    h('div', { style: { width: `${width}px` } }, h(MiniKeyboard, { baseNote: 60, keys: 25, height: 90, keyLabels: noteKeyLabels(60), scaleMask: scaleMask(7, 'dorian'), rootPc: 7, onNoteOn: (n: number) => events.push(['on', n]), onNoteOff: (n: number) => events.push(['off', n]), ...extra })),
    { width: width + 40 },
  );
  const board = m.container.querySelector<HTMLElement>('[role="group"]')!;
  return { m, board, events, key: (midi: number) => board.querySelector<HTMLElement>(`[data-midi="${midi}"]`)! };
}

describe('letters on every key, names above', () => {
  it('every key the computer plays shows its letter, A and K included', () => {
    const { board } = piano(760, { noteNames: 'above' });
    const labels = noteKeyLabels(60);
    for (const [midi, letter] of Object.entries(labels)) {
      const key = board.querySelector<HTMLElement>(`[data-midi="${midi}"]`);
      if (!key) continue;
      expect(key.querySelector('[class*="keycap"]')?.textContent, `key ${midi}`).toBe(letter);
    }
    expect(board.querySelector('[data-midi="60"] [class*="keycap"]')!.textContent).toBe('A');
    expect(board.querySelector('[data-midi="72"] [class*="keycap"]')!.textContent).toBe('K');
  });

  it('note names (C4, C5, the root) sit on a rail above their keys, never in the legend over the dots', () => {
    const { board, key } = piano(760, { noteNames: 'above' });
    const rail = [...board.querySelectorAll<HTMLElement>('[class*="railName"]')];
    expect(rail.map((r) => r.textContent)).toEqual(['C4', 'G', 'C5', 'G', 'C6']);
    for (const [text, midi] of [
      ['C4', 60],
      ['G', 67],
      ['C5', 72],
    ] as const) {
      const name = rail.find((r) => r.textContent === text)!.getBoundingClientRect();
      const k = key(midi).getBoundingClientRect();
      expect(name.bottom).toBeLessThanOrEqual(k.top + 0.5);
      expect(name.left + name.width / 2).toBeGreaterThan(k.left);
      expect(name.left + name.width / 2).toBeLessThan(k.right);
    }
    // No name inside a key's legend; the letter and the scale dot never touch.
    expect(board.querySelectorAll('[data-midi] [class*="name"]')).toHaveLength(0);
    for (const k of board.querySelectorAll<HTMLElement>('[data-midi]')) {
      const dot = k.querySelector('[class*="dot"]');
      const cap = k.querySelector('[class*="keycap"]');
      if (dot && cap) expect(overlap(dot.getBoundingClientRect(), cap.getBoundingClientRect()), k.dataset.note).toBe(false);
    }
  });

  it('the default legend mode is unchanged (names in the legend of C keys)', () => {
    const { key } = piano(760, { keyLabels: {} });
    expect(key(60).querySelector('[class*="name"]')!.textContent).toBe('C4');
  });

  it('with the rail the keys still play where they are drawn (real mouse)', async () => {
    const { key, events } = piano(760, { noteNames: 'above' });
    await click(centre(key(62), 0.5, 0.85));
    await click(centre(key(61), 0.5, 0.5));
    expect(events.filter((e) => e[0] === 'on').map((e) => e[1])).toEqual([62, 61]);
  });
});

describe('fit', () => {
  it('on a wide strip the keys widen to about 44 px and no keys are added', () => {
    const { board } = piano(1400, { fit: true });
    expect(board.querySelectorAll('[data-midi]')).toHaveLength(25);
    const white = board.querySelector<HTMLElement>('[data-midi="60"]')!.getBoundingClientRect();
    expect(white.width).toBeLessThanOrEqual(44.5);
    expect(white.width).toBeGreaterThan(42);
    expect(board.getBoundingClientRect().width).toBeCloseTo(15 * 44, -1);
  });

  it('on a narrower strip they fill it', () => {
    const { board } = piano(500, { fit: true });
    expect(board.getBoundingClientRect().width).toBeCloseTo(500, 0);
  });
});

describe('kit keys', () => {
  function kit(width = 760) {
    const events: [string, number][] = [];
    const letters = Object.fromEntries(DRUM_KEYS.map((k) => [60 + k.index, k.label]));
    const m = mount(
      h('div', { style: { width: `${width}px` } }, h(MiniKeyboard, { variant: 'kit', baseNote: 60, height: 90, kitNames: DRUM_SLOTS.map((d) => d.name), keyLabels: letters, onNoteOn: (n: number) => events.push(['on', n]), onNoteOff: (n: number) => events.push(['off', n]) })),
      { width: width + 40 },
    );
    const board = m.container.querySelector<HTMLElement>('[role="group"]')!;
    return { board, events, pad: (i: number) => board.querySelector<HTMLElement>(`[data-midi="${60 + i}"]`)! };
  }

  it('16 named sounds in 4 rows of at least 32 px, each with its letter, laid out like the drum pads', () => {
    const { board, pad } = kit();
    expect(board.querySelectorAll('[data-midi]')).toHaveLength(16);
    expect(pad(0).textContent).toBe(`${DRUM_SLOTS[0].name}Z`);
    expect(pad(12).textContent).toBe(`${DRUM_SLOTS[12].name}1`);
    const rows = new Set([...board.querySelectorAll<HTMLElement>('[data-midi]')].map((p) => Math.round(p.getBoundingClientRect().top)));
    expect(rows.size).toBe(4);
    for (const p of board.querySelectorAll<HTMLElement>('[data-midi]')) expect(p.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
    // Pad 0 (Z) bottom-left, pad 12 (1) top-left, pad 3 (V) bottom-right.
    expect(pad(0).getBoundingClientRect().top).toBeGreaterThan(pad(12).getBoundingClientRect().top);
    expect(pad(3).getBoundingClientRect().left).toBeGreaterThan(pad(0).getBoundingClientRect().left);
  });

  it('plays the sound under the real mouse; a glide moves to the next sound', async () => {
    const { pad, events } = kit();
    await click(centre(pad(0)));
    expect(events).toEqual([
      ['on', 60],
      ['off', 60],
    ]);
    events.length = 0;
    await mouse('mouseMoved', centre(pad(4)));
    await mouse('mousePressed', centre(pad(4)));
    await mouse('mouseMoved', centre(pad(5)), { buttons: 1 });
    await mouse('mouseReleased', centre(pad(5)));
    expect(events).toEqual([
      ['on', 64],
      ['off', 64],
      ['on', 65],
      ['off', 65],
    ]);
  });
});
