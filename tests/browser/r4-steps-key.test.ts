/**
 * The roll's key chip and note names (PLAY-23, design-08, design-10) on House · Chords
 * (G Dorian): the chip is a target of at least 32 x 32 px that reads the full key where it fits
 * ('G Dorian' at 1920) and the short one with the full name in its accessible name and tooltip
 * where it does not; rows and notes are spelled by the key (B♭, never A#).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setUp, tearDown } from './r4-play-helpers';
import { CHORDS, openSteps, roll } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(tearDown);

const chip = () => document.querySelector<HTMLElement>('[aria-label^="Rows in key"]')!;
const shownText = () => chip().querySelector<HTMLElement>('span:not([class*="keyMeasure"])')!.textContent;

describe('key chip and spelling', () => {
  for (const s of [
    { w: 1920, h: 1080, text: 'G Dorian' },
    { w: 1366, h: 768, text: null },
    { w: 960, h: 540, text: null },
  ]) {
    it(`at ${s.w} x ${s.h}: a 32 px chip, ${s.text ? 'the full key' : 'the full key or the short one'}, nothing cut`, async () => {
      await openSteps(CHORDS, 1, { w: s.w, h: s.h });
      const el = chip();
      const r = el.getBoundingClientRect();
      expect(r.height).toBeGreaterThanOrEqual(32);
      expect(r.width).toBeGreaterThanOrEqual(32);
      expect(el.getAttribute('aria-label')).toBe('Rows in key: G Dorian');
      const text = shownText();
      if (s.text) expect(text).toBe(s.text);
      else expect(['G Dorian', 'G Dor']).toContain(text);
      // What is shown is not clipped.
      const shown = chip().querySelector<HTMLElement>('span:not([class*="keyMeasure"])')!;
      expect(shown.getBoundingClientRect().width).toBeLessThanOrEqual(r.width);
    });
  }

  it('rows and note names use the key’s flats', async () => {
    await openSteps(CHORDS, 1, { w: 1920, h: 1080 });
    const labels = [...roll().querySelectorAll<HTMLElement>('[data-row-label]')].map((l) => l.textContent ?? '');
    expect(labels.some((t) => t.startsWith('B♭4'))).toBe(true);
    expect(labels.some((t) => t.includes('#'))).toBe(false);
    const names = [...roll().querySelectorAll<HTMLElement>('[data-note-id]')].map((n) => n.textContent ?? '');
    expect(names).toContain('B♭3');
  });
});
