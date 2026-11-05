/**
 * The roll's key chip and note names (PLAY-23, design-08, design-10) on House · Chords
 * (G Dorian): the chip is a target of at least 32 x 32 px that reads the full key where it fits
 * ('G Dorian' at 1920 in Advanced; its mood, 'G · jazzy minor', in Simple) and the short one with the full name in its accessible name and tooltip
 * where it does not; rows and notes are spelled by the key (B♭, never A#).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setUiMode } from '../../src/state/uiStore';
import { setUp, tearDown } from './r4-play-helpers';
import { CHORDS, openSteps, roll } from './r4-steps-helpers';
import { settleFrames } from './r4-uikit-input';

beforeEach(setUp);
afterEach(tearDown);

const chip = () => document.querySelector<HTMLElement>('[aria-label^="Rows in key"]')!;
const shownText = () => chip().querySelector<HTMLElement>('span:not([class*="keyMeasure"])')!.textContent;

describe('key chip and spelling', () => {
  // Simple names the key by its mood (r6: no scale names in Simple); Advanced by its scale.
  for (const s of [
    { w: 1920, h: 1080, mode: 'advanced', text: ['G Dorian'] },
    { w: 1920, h: 1080, mode: 'simple', text: ['G · jazzy minor', 'G · jazzy'] },
    { w: 1366, h: 768, mode: 'simple', text: ['G · jazzy minor', 'G · jazzy', 'G'] },
    { w: 960, h: 540, mode: 'simple', text: ['G · jazzy minor', 'G · jazzy', 'G'] },
  ] as const) {
    it(`at ${s.w} x ${s.h} (${s.mode}): a 32 px chip, ${s.text.join(' or ')}, nothing cut`, async () => {
      await openSteps(CHORDS, 1, { w: s.w, h: s.h });
      act(() => setUiMode(s.mode));
      await settleFrames(3);
      const el = chip();
      const r = el.getBoundingClientRect();
      expect(r.height).toBeGreaterThanOrEqual(32);
      expect(r.width).toBeGreaterThanOrEqual(32);
      expect(el.getAttribute('aria-label')).toBe('Rows in key: G Dorian');
      const text = shownText();
      expect(s.text as readonly string[]).toContain(text);
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
