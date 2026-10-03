/**
 * Drum Steps in the running app with real input (PLAY-03, PLAY-09):
 * - every cell of the kit overview is a hit target: a click toggles that sound at that step and
 *   selects the sound (Four Floor: 38 -> 39 notes); a drag along a row paints, or erases when the
 *   first cell was on, as one undo step; the big pad lane paints the same way;
 * - the overview is one ARIA grid with one Tab stop: arrows move (up/down choose the sound),
 *   Space toggles; a finger tap toggles too;
 * - a sound's menu (right-click its name, Shift+F10, or the ⋯ by the selected sound) clears it,
 *   fills it on every beat / 8th / 16th and shifts it;
 * - rows are at least 20 px at 1366 x 768 and 24 px at 1920 x 1080.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { DRUM_VOICES, type Note } from '../../src/project/types';
import { drumVoiceFor, selectDrumVoice, selectSlot, selectTrack, setPadMode, uiStore } from '../../src/state/uiStore';
import { item, menu, notice, openApp, press, setUp, tearDown, track, until } from './r4-play-helpers';
import { centre, click, drag, finger, settleFrames, touch } from './r4-uikit-input';
import { recordPlayed, resetKeyboardFold, rightClick } from './r4-keys-helpers';
import { wait } from './ui-harness';

beforeEach(async () => {
  await setUp();
  resetKeyboardFold();
});
afterEach(async () => {
  await tearDown();
  // Leave the keyboard unfolded everywhere for the next test file (the fold is remembered in storage).
  resetKeyboardFold();
});

const clip = () => track('t1').clips[1]!;
const hitsOf = (pitch: number, page = 0): number[] =>
  clip()
    .notes.filter((n: Note) => n.pitch === pitch && n.tick >= page * 384 && n.tick < (page + 1) * 384)
    .map((n) => Math.round((n.tick - page * 384) / 24))
    .sort((a, b) => a - b);
const gridEl = () => document.querySelector<HTMLElement>('[role="grid"][aria-label^="Kit sounds"]')!;
const row = (voice: number) => gridEl().querySelector<HTMLElement>(`[role="row"][data-voice="${voice}"]`)!;
const cell = (voice: number, step1: number) => row(voice).querySelector<HTMLElement>(`[data-col="${step1}"]`)!;
const name = (voice: number) => row(voice).querySelector<HTMLElement>('[role="rowheader"] button')!;
const lanePad = (step1: number) => document.querySelector<HTMLButtonElement>(`button[aria-label^="Step ${step1}, "]`)!;

/** Drums · Groove (Four Floor, 2 bars) in Steps. */
async function openSteps(w = 1366, hh = 768): Promise<void> {
  await openApp(w, hh);
  act(() => {
    selectTrack('t1');
    selectSlot('t1', 1);
    setPadMode('steps');
  });
  await settleFrames(3);
  await until(() => !!gridEl(), 'the kit overview');
}

describe('the overview is a grid of hit targets (PLAY-03)', () => {
  it('a click on a cell adds that hit (38 -> 39) and selects the sound; a second click removes it', async () => {
    await openSteps();
    expect(clip().name).toBe('Four Floor');
    const before = clip().notes.length;
    expect(before).toBe(38);
    expect(hitsOf(2)).toEqual([]);
    await click(centre(cell(2, 3)));
    expect(clip().notes.length).toBe(39);
    expect(hitsOf(2)).toEqual([2]);
    expect(drumVoiceFor(uiStore.getState(), 't1')).toBe(2);
    expect(row(2).getAttribute('aria-selected')).toBe('true');
    expect(cell(2, 3).getAttribute('aria-label')).toMatch(/, step 3$/);
    expect(cell(2, 3).getAttribute('aria-pressed')).toBe('true');
    // The big lane now edits the snare and shows the hit.
    expect(lanePad(3).getAttribute('aria-pressed')).toBe('true');
    await click(centre(cell(2, 3)));
    expect(clip().notes.length).toBe(38);
  });

  it('rows are at least 20 px tall at 1366 x 768', async () => {
    await openSteps();
    for (let v = 0; v < DRUM_VOICES; v++) expect(row(v).getBoundingClientRect().height, `row ${v}`).toBeGreaterThanOrEqual(19.5);
    // The big pads stay usable (they gave way first).
    expect(lanePad(1).getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
    // Nothing of the editor is pushed out of its panel.
    const vel = document.querySelector<HTMLElement>('[data-testid="velocity-lane"]')!.getBoundingClientRect();
    expect(vel.bottom).toBeLessThanOrEqual(window.innerHeight - 100);
  });

  it('rows are at least 24 px tall at 1920 x 1080', async () => {
    await openSteps(1920, 1080);
    for (let v = 0; v < DRUM_VOICES; v++) expect(row(v).getBoundingClientRect().height, `row ${v}`).toBeGreaterThanOrEqual(23.5);
  });

  it('is one Tab stop: arrows move (up and down choose the sound), Space toggles', async () => {
    await openSteps();
    const stops = [...gridEl().querySelectorAll<HTMLElement>('[tabindex="0"]')];
    expect(stops).toHaveLength(1);
    await click(centre(name(5)));
    expect(document.activeElement).toBe(name(5));
    await press('{ArrowRight}');
    await press('{ArrowRight}');
    expect(document.activeElement).toBe(cell(5, 2));
    await press('{ArrowDown}');
    expect(document.activeElement).toBe(cell(6, 2));
    expect(drumVoiceFor(uiStore.getState(), 't1')).toBe(6);
    const before = hitsOf(6);
    await press(' ');
    expect(hitsOf(6)).toEqual([...before, 1].sort((a, b) => a - b));
    expect([...gridEl().querySelectorAll('[tabindex="0"]')]).toEqual([cell(6, 2)]);
  });

  it('a finger tap toggles a cell', async () => {
    await openSteps();
    const p = centre(cell(8, 5));
    await touch('touchStart', [p]);
    await touch('touchEnd', []);
    await settleFrames();
    expect(hitsOf(8)).toEqual([4]);
  });

  it('a finger dragged sideways along a row paints every step it crosses (Blip, steps 2..9)', async () => {
    await openSteps();
    expect(hitsOf(14)).toEqual([]);
    await finger(centre(cell(14, 2)), centre(cell(14, 9)), { steps: 16 });
    expect(hitsOf(14)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(drumVoiceFor(uiStore.getState(), 't1')).toBe(14);
    // One undo step for the whole drag.
    await press('{Control>}z{/Control}');
    expect(hitsOf(14)).toEqual([]);
  });

  for (const [w, hh] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh}: a finger that swipes up or down from a sound name chooses and plays nothing; a tap on a name does`, async () => {
      await openSteps(w, hh);
      act(() => selectDrumVoice('t1', 0));
      await settleFrames();
      name(12).scrollIntoView({ block: 'center' });
      await settleFrames();
      const rec = recordPlayed();
      try {
        const p = centre(name(12));
        await finger(p, { x: p.x + 2, y: p.y - 160 }, { steps: 12 });
        expect(drumVoiceFor(uiStore.getState(), 't1'), 'swipe').toBe(0);
        expect(rec.ons(), 'swipe').toEqual([]);
        // Let a scroll the swipe started settle, then tap where the name is now.
        await wait(500);
        name(12).scrollIntoView({ block: 'center' });
        await settleFrames(3);
        const q = centre(name(12));
        await touch('touchStart', [q]);
        await touch('touchEnd', []);
        await settleFrames();
        expect(drumVoiceFor(uiStore.getState(), 't1'), 'tap').toBe(12);
        expect(rec.ons().map((n) => [n.pitch, n.source]), 'tap').toEqual([[12, 'preview']]);
      } finally {
        rec.restore();
      }
    });
  }
});

describe('paint drags and the sound menu (PLAY-09)', () => {
  it('dragging along a row over steps 1..8 paints 8 hits as one undo step; dragging from a lit cell erases', async () => {
    await openSteps();
    expect(hitsOf(8)).toEqual([]);
    await drag(centre(cell(8, 1)), centre(cell(8, 8)), 12);
    expect(hitsOf(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(session.store.undoLabel()).toMatch(/Paint steps/);
    await press('{Control>}z{/Control}');
    expect(hitsOf(8)).toEqual([]);
    await press('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(hitsOf(8)).toHaveLength(8);
    // Starting on a lit cell erases what the drag crosses.
    await drag(centre(cell(8, 1)), centre(cell(8, 4)), 6);
    expect(hitsOf(8)).toEqual([4, 5, 6, 7]);
  });

  it('the big pad lane paints too (Low Tom, steps 1..8)', async () => {
    await openSteps();
    await click(centre(name(9)));
    expect(drumVoiceFor(uiStore.getState(), 't1')).toBe(9);
    await drag(centre(lanePad(1)), centre(lanePad(8)), 12);
    expect(hitsOf(9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('right-click a sound name: Fill every 8th, then Shift right and Clear this sound, each with an Undo toast', async () => {
    await openSteps();
    await rightClick(centre(name(10)));
    expect(menu()).not.toBeNull();
    await click(centre(item('Fill every 8th')));
    // The whole clip (2 bars): a hit every 8th.
    expect(hitsOf(10, 0)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(hitsOf(10, 1)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(notice()).toMatch(/^Filled .+ on every 8th: 16 hits added\./);
    // Shift+F10 on the focused name opens the same menu.
    name(10).focus();
    await press('{Shift>}{F10}{/Shift}');
    await click(centre(item('Shift right')));
    expect(hitsOf(10, 0)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    // The ⋯ by the selected sound.
    const more = document.querySelector<HTMLButtonElement>('button[aria-label$=" actions"][aria-haspopup="menu"]')!;
    await click(centre(more));
    await click(centre(item('Clear this sound')));
    expect(hitsOf(10, 0)).toEqual([]);
    expect(notice()).toMatch(/^Cleared .+: 16 hits removed\./);
    await press('{Control>}z{/Control}');
    expect(hitsOf(10, 0)).toHaveLength(8);
  });
});
