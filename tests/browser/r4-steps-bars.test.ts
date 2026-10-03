/**
 * Clips up to 8 bars in Steps (capability-07, PLAY-10), real mouse:
 * - Length offers 1, 2, 3, 4 and 8 bars; an 8-bar clip shows a strip of 8 bar keys with an
 *   overview of the whole clip drawn over them (each bar's notes over its own key), and a press
 *   on the overview shows that bar;
 * - Double works up to 8 bars (4 -> 8; 3 -> 6, which Length then shows); "To bar N" reaches bar 8;
 * - the clip keys follow the project's scene count (1 to 8 rows), not 4.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { button, setUp, tearDown } from './r4-play-helpers';
import { centre, click, settleFrames } from './r4-uikit-input';
import { CHORDS, clipOf, openSteps, page, tabs } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(tearDown);

const lengthKey = (bars: number) => document.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${bars === 1 ? '1 bar' : `${bars} bars`}"]`);
const lengthKeys = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-labelledby^="steps-len-"] [role="radio"]')].map((b) => b.textContent?.trim());
const overview = () => document.querySelector<SVGElement>('[class*="stripInner"] svg')!;

describe('bar strip and overview (capability-07, PLAY-14)', () => {
  it('an 8-bar clip: 8 bar keys under an overview of the whole clip; pressing the overview shows that bar', async () => {
    await openSteps(CHORDS, 1);
    expect(lengthKeys()).toEqual(['1', '2', '3', '4', '8']);
    expect(tabs()).toHaveLength(4);
    await click(centre(lengthKey(8)!));
    expect(clipOf(CHORDS, 1).bars).toBe(8);
    expect(tabs()).toHaveLength(8);
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['Bar 1', 'Bar 2', 'Bar 3', 'Bar 4', 'Bar 5', 'Bar 6', 'Bar 7', 'Bar 8']);
    // Every key is a full target, side by side, and the overview spans all of them.
    const rects = tabs().map((t) => t.getBoundingClientRect());
    for (const r of rects) {
      expect(r.height).toBeGreaterThanOrEqual(32);
      expect(r.width).toBeGreaterThanOrEqual(32);
    }
    const o = overview().getBoundingClientRect();
    expect(Math.abs(o.left - rects[0].left)).toBeLessThan(2);
    expect(Math.abs(o.right - rects[7].right)).toBeLessThan(2);
    expect(o.top).toBeGreaterThanOrEqual(rects[0].top);
    expect(o.bottom).toBeLessThan(rects[0].bottom);
    // The first 4 bars hold the notes (the new bars start empty): the drawing ends half way.
    const marks = [...overview().querySelectorAll('rect')].map((m) => m.getBoundingClientRect());
    expect(marks.length).toBeGreaterThan(10);
    expect(Math.max(...marks.map((m) => m.right))).toBeLessThanOrEqual(rects[3].right + 3);
    // A press on the overview over bar 6 shows bar 6.
    await click({ x: (rects[5].left + rects[5].right) / 2, y: o.top + o.height / 2 });
    expect(page(CHORDS)).toBe(5);
    expect(tabs()[5].getAttribute('aria-selected')).toBe('true');
    // Bar 8 is reachable and "To next bar" stops there.
    await click(centre(tabs()[6]));
    expect(button('To bar 8')!.disabled).toBe(false);
    await click(centre(tabs()[7]));
    expect(button('To next bar')!.disabled).toBe(true);
  });

  it('Double works up to 8 bars: 4 -> 8, then off; 3 -> 6 shows 6 in Length', async () => {
    await openSteps(CHORDS, 1);
    const double = () => button(/Double$/)!;
    await click(centre(double()));
    expect(clipOf(CHORDS, 1).bars).toBe(8);
    expect(clipOf(CHORDS, 1).notes.length).toBe(136);
    expect(double().disabled).toBe(true);
    await click(centre(lengthKey(3)!));
    expect(clipOf(CHORDS, 1).bars).toBe(3);
    await click(centre(double()));
    expect(clipOf(CHORDS, 1).bars).toBe(6);
    expect(lengthKeys()).toEqual(['1', '2', '3', '4', '6', '8']);
    expect(lengthKey(6)!.getAttribute('aria-checked')).toBe('true');
    expect(tabs()).toHaveLength(6);
  });

  it('the clip keys follow the scene count (6 rows here, not 4)', async () => {
    await openSteps(CHORDS, 1);
    const slots = () => document.querySelectorAll('[role="radiogroup"][aria-labelledby^="steps-slot-label-"] [role="radio"]');
    expect(slots()).toHaveLength(4);
    act(() => {
      expect(cmd.insertScene(session.store).changed).toBe(true);
      expect(cmd.insertScene(session.store).changed).toBe(true);
    });
    await settleFrames(2);
    expect(slots()).toHaveLength(6);
  });
});
