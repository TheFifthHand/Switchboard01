/**
 * Part switches apply to the selection (parts-apply-to-selection): with
 * several blocks selected, a click on a part cell switches that part in all of
 * them (one Undo, "Drums off in 4 blocks"); the block menu's parts list reads
 * "Parts in 4 blocks"; a part's name opens Off in selected blocks, Off
 * everywhere and Back on everywhere. "Select blocks named “Lift”" selects
 * every Lift block, and Loop and Duplicate then act on them (no-sections).
 * The running app, real clicks, at 1366 × 768, 1920 × 1080 and 200 %.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import {
  blockEl,
  blockIds,
  blocks,
  cellEl,
  centre,
  clickAt,
  menuItem,
  nameAt,
  notice,
  openApp,
  openBlockMenu,
  project,
  resetArrange,
  rt,
  settle,
  status,
  teardownArrange,
  toggle,
  trackId,
  undoCount,
} from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const selected = () => blockIds().filter((id) => blockEl(id).hasAttribute('data-selected'));
const partIn = (i: number, part: string) => blocks()[i].parts?.[trackId(part)];
const CTRL = 2;
const SHIFT = 8;

/** Click a block's name (with modifiers), scrolling the lane to it first if needed. */
async function pick(i: number, modifiers = 0) {
  const el = blockEl(blockIds()[i]);
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await settle(30);
  await clickAt(nameAt(blockIds()[i]), modifiers);
}

describe('part switches across the selection', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`${w} x ${hh}: a cell click with 4 blocks selected switches the part in all 4 (one Undo); the menu says "Parts in 4 blocks"`, async () => {
      await openApp(w, hh);
      const ids = blockIds();
      // Groove (2), Lift (3) with Shift, then Lift (5) and Groove (6) with Ctrl.
      await pick(1);
      await pick(2, SHIFT);
      await pick(4, CTRL);
      await pick(5, CTRL);
      expect(selected()).toEqual([ids[1], ids[2], ids[4], ids[5]]);
      const undo = undoCount();
      // A plain click on Drums in Lift: off in all four.
      await clickAt(centre(cellEl(ids[2], trackId('Drums'))));
      await settle(60);
      for (const i of [1, 2, 4, 5]) expect(partIn(i, 'Drums'), `block ${i + 1}`).toBeNull();
      expect(partIn(0, 'Drums')).toBeUndefined();
      expect(notice()?.text).toBe('Drums off in 4 blocks');
      expect(undoCount()).toBe(undo + 1);
      // The cells say so (and the selection stays).
      expect(cellEl(ids[5], trackId('Drums')).getAttribute('aria-label')).toMatch(/off/i);
      expect(selected().length).toBe(4);
      // One Undo brings Drums back in all four.
      act(() => session.undo());
      for (const i of [1, 2, 4, 5]) expect(partIn(i, 'Drums')).toBeUndefined();

      // The block menu's parts list acts on all four.
      await openBlockMenu(ids[1]);
      const item = menuItem('Parts in 4 blocks');
      act(() => item.click());
      await settle(60);
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
      expect(menu.getAttribute('aria-label')).toBe('Parts in 4 blocks');
      const bass = menuItem('Bass');
      expect(bass.getAttribute('aria-checked')).toBe('true');
      act(() => bass.click());
      await settle(60);
      for (const i of [1, 2, 4, 5]) expect(partIn(i, 'Bass')).toBeNull();
      // The menu stays open and says it with its check mark (no toast over it); the lane says it aloud.
      expect(menuItem('Bass').getAttribute('aria-checked')).toBe('false');
      expect(status()).toBe('Bass off in 4 blocks.');
    });
  }

  it('200 % (960 x 540): Shift+click two blocks, a cell click switches the part in both', async () => {
    await openApp(960, 540);
    const ids = blockIds();
    blockEl(ids[1]).scrollIntoView({ block: 'center' });
    await settle(60);
    await pick(1);
    await pick(2, SHIFT);
    expect(selected()).toEqual([ids[1], ids[2]]);
    await clickAt(centre(cellEl(ids[1], trackId('Bass'))));
    await settle(60);
    expect(partIn(1, 'Bass')).toBeNull();
    expect(partIn(2, 'Bass')).toBeNull();
    expect(notice()?.text).toBe('Bass off in 2 blocks');
  });

  it('a part’s name offers Off in selected blocks, Off everywhere and Back on everywhere (each one Undo)', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    const nameButton = () => document.querySelector<HTMLElement>(`[data-name-row][data-track="${trackId('Chords')}"] [aria-haspopup="menu"]`)!;
    const openPartMenu = async () => {
      await clickAt(centre(nameButton()));
      await settle(60);
      const m = document.querySelector<HTMLElement>('[role="menu"]')!;
      expect(m.getAttribute('aria-label')).toBe('Chords in the song');
      return m;
    };
    // Nothing selected: "Off in selected blocks" says to select blocks first.
    await openPartMenu();
    expect(menuItem('Off in selected blocks').getAttribute('aria-disabled')).toBe('true');
    expect(menuItem('Back on everywhere').getAttribute('aria-disabled')).toBe('true');
    const plays = blocks().filter((_, i) => cellEl(ids[i], trackId('Chords')).getAttribute('aria-label')!.includes('plays')).length;
    // Off everywhere.
    let undo = undoCount();
    act(() => menuItem('Off everywhere').click());
    await settle(60);
    expect(undoCount()).toBe(undo + 1);
    expect(notice()?.text).toBe(`Chords off everywhere (${plays} blocks)`);
    expect(blocks().filter((b) => b.parts?.[trackId('Chords')] === null).length).toBe(plays);
    // Back on everywhere.
    await openPartMenu();
    undo = undoCount();
    act(() => menuItem('Back on everywhere').click());
    await settle(60);
    expect(undoCount()).toBe(undo + 1);
    expect(blocks().every((b) => b.parts?.[trackId('Chords')] === undefined)).toBe(true);
    // Two selected: Off in selected blocks switches it there only.
    await pick(1);
    await pick(2, SHIFT);
    await openPartMenu();
    const off = menuItem('Off in selected blocks');
    expect(off.textContent).toContain('2 blocks selected');
    act(() => off.click());
    await settle(60);
    expect(partIn(1, 'Chords')).toBeNull();
    expect(partIn(2, 'Chords')).toBeNull();
    expect(partIn(5, 'Chords')).toBeUndefined();
    expect(notice()?.text).toBe('Chords off in 2 blocks');
  });

  it('“Select blocks named Lift” selects every Lift block; Loop and Duplicate then act on them', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    await openBlockMenu(ids[2]);
    const item = menuItem('Select blocks named “Lift”');
    expect(item.textContent).toContain('2 blocks');
    act(() => item.click());
    await settle(60);
    expect(selected()).toEqual([ids[2], ids[4]]);
    expect(notice()?.text).toContain('Selected 2 blocks named “Lift”');
    // The Loop button loops them (first to last).
    expect(toggle().getAttribute('aria-label')).toBe('Loop blocks 3–5');
    await clickAt(centre(toggle()));
    expect(rt().songLoop).toEqual({ fromBlockId: ids[2], toBlockId: ids[4] });
    // Duplicate copies both.
    await openBlockMenu(ids[4]);
    act(() => menuItem('Duplicate 2 blocks').click());
    await settle(100);
    expect(blocks().length).toBe(ids.length + 2);
    expect(blocks().filter((b) => b.sceneId === project().arrangement.blocks[2].sceneId).length).toBe(4);
  });
});
