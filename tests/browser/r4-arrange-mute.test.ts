/**
 * The lane says what is heard (mute-solo-not-shown): the part names column
 * shows Muted / Solo / Not soloed and dims that part's cells in every block
 * (the blocks keep their colours); its compact Mute and Solo keys (an icon,
 * the word on hover or focus) are the same commands as Play and Mix, so the
 * three stay in sync; the column is not hidden from screen readers and a
 * cell's name says "(muted)". Real clicks and keys, at 1366, 1920 and 200 %.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { setView } from '../../src/state/uiStore';
import { blockEl, blockIds, cellEl, centre, clickAt, mouse, openApp, press, project, resetArrange, settle, teardownArrange, trackId } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const names = () => document.querySelector<HTMLElement>('[data-testid="part-names"]')!;
const row = (part: string) => names().querySelector<HTMLElement>(`[data-name-row][data-track="${trackId(part)}"]`)!;
const word = (part: string) => row(part).querySelector<HTMLElement>('[data-testid="part-status"]')!.textContent;
const key = (part: string, kind: 'Mute' | 'Solo') => names().querySelector<HTMLButtonElement>(`button[aria-label="${kind} ${part}"]`)!;
const cellRowOpacity = (blockId: string, part: string) => Number(getComputedStyle(cellEl(blockId, trackId(part)).parentElement!).opacity);
/** A real click on a part's Mute or Solo: they show on the row under the pointer, so point at its name first. */
async function clickKey(part: string, kind: 'Mute' | 'Solo') {
  row(part).scrollIntoView({ block: 'center' });
  await mouse('mouseMoved', centre(row(part).querySelector<HTMLElement>('[aria-haspopup="menu"]')!, 0.2));
  await settle(30);
  await clickAt(centre(key(part, kind)));
}

describe('mute and solo in the lane', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: Mute and Solo beside the part names change the real parts, dim their rows and say so`, async () => {
      await openApp(w, hh);
      const ids = blockIds();
      // Not hidden from screen readers; every part has its two keys.
      expect(names().closest('[aria-hidden="true"]')).toBeNull();
      expect(names().querySelectorAll('button[aria-label^="Mute "]').length).toBe(project().tracks.length);
      const intro = ids[0];
      const colourBefore = getComputedStyle(blockEl(intro)).backgroundImage;
      expect(cellRowOpacity(intro, 'Drums')).toBe(1);

      // At rest the column is the names and their state; Mute and Solo show on the row under the pointer.
      expect(key('Drums', 'Mute').getBoundingClientRect().width).toBe(0);
      // Mute Drums with a real click.
      await clickKey('Drums', 'Mute');
      expect(project().tracks.find((t) => t.name === 'Drums')!.mute).toBe(true);
      await settle(60);
      expect(word('Drums')).toBe('Muted');
      expect(key('Drums', 'Mute').getAttribute('aria-pressed')).toBe('true');
      for (const id of ids) expect(cellRowOpacity(id, 'Drums')).toBeLessThan(0.6);
      expect(cellRowOpacity(intro, 'Bass')).toBe(1);
      // The block keeps its colours; only the row is dimmed.
      expect(getComputedStyle(blockEl(intro)).backgroundImage).toBe(colourBefore);
      expect(cellEl(intro, trackId('Drums')).getAttribute('aria-label')).toMatch(/^Drums in Intro \(block 1\): plays “.+” \(muted\)$/);

      // Solo Bass: the others say Not soloed and dim; Bass says Solo.
      await clickKey('Bass', 'Solo');
      await settle(60);
      expect(project().tracks.find((t) => t.name === 'Bass')!.solo).toBe(true);
      expect(word('Bass')).toBe('Solo');
      expect(word('Chords')).toBe('Not soloed');
      expect(word('Drums')).toBe('Muted');
      expect(cellRowOpacity(ids[1], 'Chords')).toBeLessThan(1);
      expect(cellRowOpacity(ids[1], 'Bass')).toBe(1);
      expect(cellEl(ids[1], trackId('Chords')).getAttribute('aria-label')).toContain('(not soloed)');

      // The word of a key shows on hover (and on keyboard focus).
      await mouse('mouseMoved', centre(row('Lead').querySelector<HTMLElement>('[aria-haspopup="menu"]')!, 0.2));
      await settle(30);
      const solo = key('Lead', 'Solo');
      const tip = solo.querySelector<HTMLElement>('[class*="toggleWord"]')!;
      expect(Number(getComputedStyle(tip).opacity)).toBe(0);
      await mouse('mouseMoved', centre(solo));
      await settle(60);
      expect(Number(getComputedStyle(tip).opacity)).toBe(1);
      expect(tip.textContent).toBe('Solo');
      await mouse('mouseMoved', { x: 2, y: 2 });

      // Undo brings Bass back; the same state shows in Play (one source of truth).
      act(() => session.undo());
      await settle(60);
      expect(word('Chords')).toBe('');
      act(() => setView('play'));
      await settle(200);
      const playMute = document.querySelector<HTMLButtonElement>('main button[aria-label="Mute Drums"]')!;
      expect(playMute.getAttribute('aria-pressed')).toBe('true');
      // Unmute from Play: Arrange follows.
      await clickAt(centre(playMute));
      act(() => setView('arrange'));
      await settle(300);
      expect(word('Drums')).toBe('');
      expect(cellRowOpacity(blockIds()[0], 'Drums')).toBe(1);
    });
  }

  it('the keys work from the keyboard: the arrows reach them, Space toggles, the word shows on focus', async () => {
    await openApp(1366, 768);
    // From the part's name, → reaches its Mute key.
    act(() => row('Percussion').querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.focus());
    await press('ArrowRight');
    const mute = key('Percussion', 'Mute');
    expect(document.activeElement).toBe(mute);
    expect(mute.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
    await press(' ');
    expect(project().tracks.find((t) => t.name === 'Percussion')!.mute).toBe(true);
    expect(word('Percussion')).toBe('Muted');
    // Keyboard focus (focus-visible) shows the word.
    await press('ArrowRight');
    const solo = key('Percussion', 'Solo');
    expect(document.activeElement).toBe(solo);
    expect(Number(getComputedStyle(solo.querySelector<HTMLElement>('[class*="toggleWord"]')!).opacity)).toBe(1);
    await press(' ');
    expect(project().tracks.find((t) => t.name === 'Percussion')!.solo).toBe(true);
    // Muted wins over Solo, in words too (as in Play and Mix).
    expect(word('Percussion')).toBe('Muted');
  });
});
