/**
 * Kit keys in the running app with real keys and mouse (PLAY-07): with a kit selected the
 * computer keys always use the drum-pad layout (Z–V / A–F / Q–R / 1–4, one table with the Drums
 * pads), so A, S and Z play the same kit sounds in Loops, Steps and Drums modes; the strip shows
 * 16 named sound keys with their letters, the octave controls give way to "KIT · 16 sounds", and
 * the Musical Assist switch is hidden ("Drums: keys play the kit sounds.").
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getKitVoiceNames } from '../../src/audio/instruments/kits';
import { DRUM_KEYS } from '../../src/ui/components';
import { selectTrack, setPadMode, setUiMode, type PadMode } from '../../src/state/uiStore';
import { openApp, press, setUp, tearDown, track } from './r4-play-helpers';
import { centre, click, settleFrames } from './r4-uikit-input';
import { keyboard, recordPlayed, resetKeyboardFold, strip } from './r4-keys-helpers';

beforeEach(async () => {
  await setUp();
  resetKeyboardFold();
});
afterEach(async () => {
  await tearDown();
  // Leave the keyboard unfolded everywhere for the next test file (the fold is remembered in storage).
  resetKeyboardFold();
});

const kitNames = () => {
  const inst = track('t1').instrument;
  if (inst.kind !== 'drums') throw new Error('t1 is not a kit');
  return getKitVoiceNames(inst.kitId);
};

async function keysIn(mode: PadMode, keys: string[]): Promise<number[]> {
  act(() => setPadMode(mode));
  await settleFrames(2);
  (document.activeElement as HTMLElement | null)?.blur();
  const rec = recordPlayed();
  try {
    for (const k of keys) await press(k);
    expect(rec.ons().every((p) => p.trackId === 't1' && p.source === 'computer'), JSON.stringify(rec.played)).toBe(true);
    // Every note is released.
    expect(rec.played.filter((p) => !p.on)).toHaveLength(rec.ons().length);
    return rec.ons().map((p) => p.pitch);
  } finally {
    rec.restore();
  }
}

describe('one key, one kit sound, in every pad mode', () => {
  it('a, s and z play Closed Hat, Open Hat and Kick in Loops, Steps and Drums alike', async () => {
    await openApp(1366, 768);
    act(() => selectTrack('t1'));
    const expected = ['KeyA', 'KeyS', 'KeyZ'].map((code) => DRUM_KEYS.find((k) => k.code === code)!.index);
    expect(expected).toEqual([4, 5, 0]);
    expect(await keysIn('loops', ['a', 's', 'z'])).toEqual(expected);
    expect(await keysIn('steps', ['a', 's', 'z'])).toEqual(expected);
    expect(await keysIn('drums', ['a', 's', 'z'])).toEqual(expected);
    // The top row too (1 = sound 13), and X no longer shifts an octave for a kit: it plays sound 2.
    expect(await keysIn('loops', ['1', 'x'])).toEqual([12, 1]);
  });
});

describe('the strip for a kit', () => {
  it('shows 16 named sound keys with their letters (no piano, no octave keys) and hides Musical Assist', async () => {
    await openApp(1366, 768);
    act(() => selectTrack('t1'));
    await settleFrames(2);
    const names = kitNames();
    const keys = [...keyboard().querySelectorAll<HTMLElement>('[data-midi]')];
    expect(keys).toHaveLength(16);
    for (const k of DRUM_KEYS) {
      const el = keys[k.index];
      expect(el.textContent, `sound ${k.index}`).toBe(`${names[k.index]}${k.label}`);
      const r = el.getBoundingClientRect();
      expect(r.width).toBeGreaterThanOrEqual(32);
      expect(r.height).toBeGreaterThanOrEqual(32);
      // The whole name shows (no word cut off inside the key).
      const nameEl = el.firstElementChild as HTMLElement;
      expect(nameEl.scrollHeight, names[k.index]).toBeLessThanOrEqual(nameEl.clientHeight + 1);
      expect(nameEl.scrollWidth, names[k.index]).toBeLessThanOrEqual(nameEl.clientWidth + 1);
    }
    // In order, left to right: Z X C V | A S D F | Q W E R | 1 2 3 4.
    const lefts = keys.map((k) => k.getBoundingClientRect().left);
    expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
    expect(strip().querySelector('button[aria-label^="Octave"]')).toBeNull();
    expect(strip().querySelector('button[aria-label="Reset octave to C4"]')).toBeNull();
    expect(strip().textContent).toContain('KIT');
    expect(strip().textContent).toContain('16 sounds');
    expect(strip().querySelector('[role="switch"]')).toBeNull();
    expect(strip().textContent).toContain('Drums: keys play the kit sounds.');
    // A melodic part brings the piano and the switch back.
    act(() => selectTrack('t3'));
    await settleFrames(2);
    expect([...strip().querySelectorAll('[role="switch"]')].some((s) => s.textContent?.includes('Musical Assist'))).toBe(true);
    expect(keyboard().querySelectorAll('[data-midi]').length).toBeGreaterThanOrEqual(25);
  });

  it('a click on a kit key plays that sound; Advanced shows the same kit keys', async () => {
    await openApp(1366, 768);
    act(() => selectTrack('t1'));
    await settleFrames(2);
    const rec = recordPlayed();
    try {
      await click(centre(keyboard().querySelector('[data-midi="62"]')!, 0.5, 0.8));
      expect(rec.ons().map((p) => [p.trackId, p.pitch, p.source])).toEqual([['t1', 2, 'keyboard']]);
    } finally {
      rec.restore();
    }
    act(() => setUiMode('advanced'));
    await settleFrames(2);
    expect(keyboard().querySelectorAll('[data-midi]')).toHaveLength(16);
    // Narrower keys beside the key pickers and the arpeggiator note: every name still whole.
    for (const el of keyboard().querySelectorAll<HTMLElement>('[data-midi]')) {
      const nameEl = el.firstElementChild as HTMLElement;
      expect(nameEl.scrollWidth, nameEl.textContent ?? '').toBeLessThanOrEqual(nameEl.clientWidth + 1);
      expect(nameEl.scrollHeight, nameEl.textContent ?? '').toBeLessThanOrEqual(nameEl.clientHeight + 1);
    }
    expect(strip().scrollWidth).toBeLessThanOrEqual(strip().clientWidth + 1);
    expect([...strip().querySelectorAll('[role="switch"]')].some((s) => s.textContent?.includes('Musical Assist'))).toBe(false);
  });
});

describe('narrow strips (1024 x 768)', () => {
  for (const mode of ['simple', 'advanced'] as const) {
    it(`${mode}: the 16 kit keys go in two rows of eight (Q–4 above Z–F), every name whole and every key at least 32 px tall`, async () => {
      await openApp(1024, 768);
      act(() => {
        selectTrack('t1');
        setUiMode(mode);
      });
      await settleFrames(3);
      const names = kitNames();
      const keys = [...keyboard().querySelectorAll<HTMLElement>('[data-midi]')];
      expect(keys).toHaveLength(16);
      const top = (i: number) => Math.round(keys[i].getBoundingClientRect().top);
      expect(new Set(keys.map((_, i) => top(i))).size).toBe(2);
      // Z (Kick) bottom-left, 1 (sound 13) top-left.
      expect(top(0)).toBeGreaterThan(top(12));
      expect(Math.abs(keys[0].getBoundingClientRect().left - keys[8].getBoundingClientRect().left)).toBeLessThan(1);
      for (const k of DRUM_KEYS) {
        const el = keys[k.index];
        const r = el.getBoundingClientRect();
        expect(r.height, names[k.index]).toBeGreaterThanOrEqual(32);
        expect(r.width, names[k.index]).toBeGreaterThanOrEqual(40);
        expect(el.textContent).toBe(`${names[k.index]}${k.label}`);
        const nameEl = el.firstElementChild as HTMLElement;
        expect(nameEl.scrollWidth, names[k.index]).toBeLessThanOrEqual(nameEl.clientWidth + 1);
        expect(nameEl.scrollHeight, names[k.index]).toBeLessThanOrEqual(nameEl.clientHeight + 1);
        // The letter never covers the name.
        const cap = el.lastElementChild!.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(nameEl);
        for (const line of text.getClientRects()) {
          const apart = line.right <= cap.left || cap.right <= line.left || line.bottom <= cap.top || cap.bottom <= line.top;
          expect(apart, `${names[k.index]}: letter over the name`).toBe(true);
        }
      }
      expect(strip().scrollWidth).toBeLessThanOrEqual(strip().clientWidth + 1);
      // A click still plays the key under it: Snare (bottom row) and sound 14 (top row).
      const rec = recordPlayed();
      try {
        await click(centre(keys[2], 0.5, 0.5));
        expect(rec.ons().map((p) => p.pitch)).toEqual([2]);
        await click(centre(keys[13], 0.5, 0.5));
        expect(rec.ons().map((p) => p.pitch)).toEqual([2, 13]);
      } finally {
        rec.restore();
      }
    });
  }
});
