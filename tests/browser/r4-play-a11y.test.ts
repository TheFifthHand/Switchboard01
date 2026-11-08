/**
 * Keyboard and screen-reader details of the Loops grid, with real keys:
 * - PLAY-18: no control announces an "S" shortcut (S plays a note; Solo has
 *   no key);
 * - PLAY-19: the pads (with the scene buttons) are one Tab stop and the part
 *   headers another (roving tabindex), so Tab goes from the Loops tab to the
 *   part panel in at most 12 presses; arrow keys move inside, Home / End to a
 *   row's ends, Ctrl+Home / Ctrl+End to the grid's corners; the stop follows
 *   the selected pad.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectSlot, selectTrack } from '../../src/state/uiStore';
import { SIZES, button, openApp, pad, panel, press, project, setUp, tearDown } from './r4-play-helpers';

beforeEach(setUp);
afterEach(tearDown);

const name = (el: Element | null) => (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim().slice(0, 50);

describe('keyboard (PLAY-18, PLAY-19)', () => {
  for (const s of SIZES) {
    it(`at ${s.name}: no "S" shortcut is announced; Tab reaches the part panel from the Loops tab in at most 12 stops`, async () => {
      await openApp(s.w, s.h);
      act(() => {
        selectTrack('t3');
        selectSlot('t3', 1);
      });
      // PLAY-18: Solo has no key, so nothing says it does.
      const withS = [...document.querySelectorAll('[aria-keyshortcuts]')].filter((el) => el.getAttribute('aria-keyshortcuts')!.split(/\s+/).includes('S'));
      expect(withS.map(name)).toEqual([]);
      expect(button('Solo Bass')!.hasAttribute('aria-keyshortcuts')).toBe(false);
      expect(panel().querySelector('button[data-kind="solo"]')!.hasAttribute('aria-keyshortcuts')).toBe(false);

      // PLAY-19: from the Loops tab to the part panel.
      const loops = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Loops')!;
      act(() => loops.focus());
      const stops: string[] = [];
      for (let i = 0; i < 40 && !panel().contains(document.activeElement); i++) {
        await press('{Tab}');
        stops.push(name(document.activeElement));
      }
      expect(panel().contains(document.activeElement), stops.join(' / ')).toBe(true);
      expect(stops.length, stops.join(' / ')).toBeLessThanOrEqual(12);
      // The pads' stop is the selected pad.
      expect(stops).toContain(name(pad('t3', 1)));
      // Every pad but one, and every header key but one, is skipped by Tab.
      expect([...document.querySelectorAll('[data-pad-cell] button[id^="pad-"]')].filter((b) => (b as HTMLElement).tabIndex === 0)).toHaveLength(1);
      expect([...document.querySelectorAll('[id^="part-head-"]')].filter((b) => (b as HTMLElement).tabIndex === 0)).toHaveLength(1);
    });
  }

  it('arrows, Home / End and Ctrl+Home / Ctrl+End move through the pads; the stop follows focus; the headers rove too', async () => {
    await openApp(1366, 768);
    act(() => {
      selectTrack('t3');
      selectSlot('t3', 1);
    });
    act(() => pad('t3', 1).focus());
    await press('{ArrowRight}');
    expect(document.activeElement).toBe(pad('t4', 1));
    expect(pad('t4', 1).tabIndex).toBe(0);
    expect(pad('t3', 1).tabIndex).toBe(-1);
    await press('{Home}');
    expect(document.activeElement).toBe(pad('t1', 1));
    await press('{End}');
    expect(document.activeElement).toBe(pad('t8', 1));
    // Past the last part: the row's scene button; Left comes back.
    await press('{ArrowRight}');
    expect(document.activeElement).toBe(document.querySelector('[data-scene-row="1"] button[data-scene]'));
    await press('{ArrowDown}');
    expect(document.activeElement).toBe(document.querySelector('[data-scene-row="2"] button[data-scene]'));
    await press('{ArrowLeft}');
    expect(document.activeElement).toBe(pad('t8', 2));
    await press('{Control>}{Home}{/Control}');
    expect(document.activeElement).toBe(pad('t1', 0));
    await press('{Control>}{End}{/Control}');
    const last = project().scenes.length - 1;
    expect(document.activeElement).toBe(pad('t8', last));

    // Header keys: Left / Right keep the key, Down goes through a part's keys.
    const mute = button('Mute Bass')!;
    act(() => mute.focus());
    await press('{ArrowRight}');
    expect(document.activeElement).toBe(button('Mute Chords'));
    await press('{ArrowDown}');
    expect(document.activeElement).toBe(button('Solo Chords'));
    await press('{Home}');
    expect(document.activeElement).toBe(button('Solo Drums'));
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
  });
});
