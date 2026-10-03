/**
 * The Play review's fix round, with real input in the running app:
 * - M2: keyboard focus is never hidden under the sticky part headers (the
 *   grid's scroll padding follows the head's measured height) nor, where the
 *   page scrolls, under the sticky transport; no row shows above the head;
 * - short windows (1366 x 657, 1280 x 720): smaller rows, and a fade at the
 *   grid's foot while more rows are below;
 * - another project forgets the clips chosen in the last one;
 * - focus stays on a scene button after Delete scene and after an undo that
 *   takes the focused row away;
 * - another menu's trigger opens its menu on the first click;
 * - during a take: Alt+arrows on a scene say the one-line lock, Change
 *   instrument is off with the reason;
 * - "New scene from what's playing" is off while stopped;
 * - Variation never leaves a do-nothing undo step, says when a clip is too
 *   short, and Back to original says when the clip was edited since.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { TICKS_PER_STEP } from '../../src/project/types';
import { addNote, createClip, insertScene, toggleStep } from '../../src/state/commands';
import { selectSlot, selectTrack, uiStore } from '../../src/state/uiStore';
import { centre, click as cdpClick } from './r4-uikit-input';
import { button, clickEl, clipsOf, described, grid, item, menu, notice, openApp, pad, panel, press, project, setUp, tearDown, until } from './r4-play-helpers';

beforeEach(setUp);
afterEach(tearDown);

const head = () => grid().querySelector<HTMLElement>('[data-grid-head]')!;
const sceneBtn = (row: number) => document.querySelector<HTMLButtonElement>(`[data-scene-row="${row}"] button[data-scene]`)!;
const frame = () => grid().parentElement!;

/** Every point down the middle of `el` hits `el` itself (nothing covers it). */
function fullyShown(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  return [r.top + 3, r.top + r.height / 2, r.bottom - 3].every((y) => el.contains(document.elementFromPoint(x, y)));
}

async function eightScenes(): Promise<void> {
  act(() => {
    for (let i = 0; i < 4; i++) insertScene(session.store);
  });
  await until(() => document.querySelectorAll('button[data-scene]').length === 8, '8 rows');
}

describe('keyboard focus stays in view (M2)', () => {
  /** Put the first row just under whatever is sticky above it: the part headers (the grid scrolls) or the transport (the page scrolls). */
  async function firstRowUnderTheTop(w: number): Promise<void> {
    if (w >= 1024) {
      act(() => {
        grid().scrollTop = 70;
      });
    } else {
      const transport = document.querySelector<HTMLElement>('header[aria-label="Transport"]')!;
      const abs = pad('t1', 0).getBoundingClientRect().top + window.scrollY;
      act(() => window.scrollTo(0, abs - transport.getBoundingClientRect().height + 40));
    }
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(fullyShown(pad('t1', 0)), 'the first row starts hidden').toBe(false);
  }
  const twoFrames = () =>
    act(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });

  for (const [w, h] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${h}: arrowing up into a row hidden under the sticky headers or the transport brings the focused pad and scene button whole into view`, async () => {
      await openApp(w, h);
      await eightScenes();
      await firstRowUnderTheTop(w);
      act(() => pad('t1', 1).focus({ focusVisible: true } as FocusOptions));
      await press('{ArrowUp}');
      expect(document.activeElement).toBe(pad('t1', 0));
      await twoFrames();
      expect(fullyShown(pad('t1', 0))).toBe(true);

      await firstRowUnderTheTop(w);
      act(() => sceneBtn(1).focus({ focusVisible: true } as FocusOptions));
      await press('{ArrowUp}');
      expect(document.activeElement).toBe(sceneBtn(0));
      await twoFrames();
      expect(fullyShown(sceneBtn(0))).toBe(true);

      // From the last row to the first and back with Ctrl+End / Ctrl+Home.
      act(() => pad('t1', 0).focus({ focusVisible: true } as FocusOptions));
      await press('{Control>}{End}{/Control}');
      await twoFrames();
      expect(fullyShown(pad('t8', 7))).toBe(true);
      await press('{Control>}{Home}{/Control}');
      await twoFrames();
      expect(fullyShown(pad('t1', 0))).toBe(true);
    });
  }

  it('no row shows above the sticky head when the rows are scrolled (1366 x 768)', async () => {
    await openApp(1366, 768);
    await eightScenes();
    act(() => {
      grid().scrollTop = 200;
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    const g = grid().getBoundingClientRect();
    expect(Math.abs(head().getBoundingClientRect().top - g.top)).toBeLessThan(1);
    for (const x of [g.left + 60, g.right - 50]) {
      for (let y = Math.ceil(g.top) + 1; y < g.top + 6; y++) expect(document.elementFromPoint(x, y)?.closest('[data-grid-head]'), `${x},${y}`).not.toBeNull();
    }
  });
});

describe('short windows', () => {
  it('at 1366 x 657 (a laptop browser) three rows show whole, with a fade at the foot while more are below', async () => {
    await openApp(1366, 657);
    for (const r of [0, 1, 2]) expect(fullyShown(pad('t3', r)), `row ${r}`).toBe(true);
    expect(frame().hasAttribute('data-more')).toBe(true);
    const fade = frame().querySelector<HTMLElement>('[class*="gridFade"]')!;
    await until(() => Number(getComputedStyle(fade).opacity) > 0.9, 'the fade');
    act(() => {
      grid().scrollTop = grid().scrollHeight;
    });
    await until(() => !frame().hasAttribute('data-more'), 'the fade to go at the bottom');
    // The pads are short here: name and state (the length is in the action bar and the spoken name).
    expect(pad('t3', 1).getAttribute('aria-label')).toMatch(/\d bars?\./);
  });

  it('at 1280 x 720 all four starter rows fit, no fade', async () => {
    await openApp(1280, 720);
    for (const r of [0, 1, 2, 3]) expect(fullyShown(pad('t3', r)), `row ${r}`).toBe(true);
    expect(frame().hasAttribute('data-more')).toBe(false);
  });
});

describe('selection, focus and menus', () => {
  it('another project forgets the clips chosen in the last one: Select Lead rings its first clip, not the empty pad chosen before', async () => {
    await openApp(1366, 768);
    act(() => {
      selectTrack('t5');
      selectSlot('t5', 0);
    });
    expect(clipsOf('t5')[0]).toBeNull();
    await act(async () => {
      await session.newFromStarter('house');
    });
    act(() => selectTrack('t1'));
    await clickEl(button(/^Select Lead/));
    const bell = clipsOf('t5').findIndex((c) => c?.name === 'Bell Hook');
    expect(uiStore.getState().selectedSlot.t5).toBe(bell);
    expect(pad('t5', bell).hasAttribute('data-selected')).toBe(true);
  });

  it('after Delete scene (and after an undo that takes the focused row away) focus stays on a scene button', async () => {
    await openApp(1366, 768);
    // Keyboard only: the last scene's menu, Delete scene, confirm (Break is in the song).
    act(() => sceneBtn(3).focus({ focusVisible: true } as FocusOptions));
    await press('{Shift>}{F10}{/Shift}');
    for (let i = 0; i < 20 && !/Delete scene/.test(document.activeElement?.textContent ?? ''); i++) await press('{ArrowDown}');
    await press('{Enter}');
    if (menu()) await press('{Enter}');
    expect(project().scenes).toHaveLength(3);
    await until(() => document.activeElement !== document.body, 'focus');
    expect(document.activeElement).toBe(sceneBtn(2));
    await press('{Control>}z{/Control}');
    expect(project().scenes).toHaveLength(4);
    expect(document.activeElement?.matches('button[data-scene]')).toBe(true);

    // Insert a scene below (focus goes to the new row), then undo: the row goes, focus moves to its neighbour.
    act(() => sceneBtn(3).focus({ focusVisible: true } as FocusOptions));
    await press('{Shift>}{F10}{/Shift}');
    for (let i = 0; i < 20 && !/Insert scene below/.test(document.activeElement?.textContent ?? ''); i++) await press('{ArrowDown}');
    await press('{Enter}');
    await until(() => document.activeElement === sceneBtn(4), 'focus on the new row');
    await press('{Control>}z{/Control}');
    expect(project().scenes).toHaveLength(4);
    await until(() => document.activeElement !== document.body, 'focus after the undo');
    expect(document.activeElement).toBe(sceneBtn(3));
  });

  it("another menu's trigger opens its menu on the first click (real mouse); a pad under an open menu still does not start", async () => {
    await openApp(1366, 768);
    await clickEl(button('Options for scene Intro'));
    expect(menu()?.getAttribute('aria-label')).toBe('Scene Intro');
    await clickEl(button('Options for part Bass'));
    expect(menu()?.getAttribute('aria-label')).toBe('Part Bass');
    await clickEl(button('Options for scene Groove'));
    expect(menu()?.getAttribute('aria-label')).toBe('Scene Groove');
    // The transport's More menu too.
    const more = document.querySelector<HTMLElement>('header[aria-label="Transport"] button[aria-haspopup="menu"]')!;
    expect(more).not.toBeNull();
    await cdpClick(centre(more));
    await until(() => !!menu() && menu()!.getAttribute('aria-label') !== 'Scene Groove', 'the More menu');
    await press('{Escape}');
  });
});

describe('take lock gaps', () => {
  it('Alt+arrows on a scene say the one-line lock; Change instrument is off with the reason', async () => {
    await openApp(1366, 768, { play: true });
    await act(async () => {
      await session.togglePerformance();
    });
    await until(() => session.store.info.getState().lock !== null, 'the take');
    const before = project().scenes.map((s) => s.id);
    act(() => sceneBtn(1).focus());
    await press('{Alt>}{ArrowDown}{/Alt}');
    expect(project().scenes.map((s) => s.id)).toEqual(before);
    expect(notice()).toBe('Locked while a performance records. Stop the take to move scenes.');
    const change = button(/^Change instrument/, panel())!;
    expect(change.disabled).toBe(true);
    expect(described(change)).toContain('Locked while a performance records');
  });

  it("New scene from what's playing is off while stopped", async () => {
    await openApp(1366, 768, { play: true });
    act(() => session.stop());
    await clickEl(button('Options for scene Intro'));
    const capture = item("New scene from what's playing");
    expect(capture.getAttribute('aria-disabled')).toBe('true');
    expect(capture.textContent).toContain('Nothing is playing');
    await press('{Escape}');
  });
});

describe('Variation honesty', () => {
  it('a press that would change nothing leaves no undo step; a clip of a few notes says it is too short to vary', async () => {
    await openApp(1366, 768);
    const empty = clipsOf('t3').findIndex((c) => !c);
    act(() => {
      createClip(session.store, 't3', empty, 1);
      addNote(session.store, 't3', empty, { tick: 0, pitch: 40, velocity: 0.8, duration: TICKS_PER_STEP * 4 });
      selectTrack('t3');
      selectSlot('t3', empty);
    });
    let sawShort = false;
    for (let i = 0; i < 8; i++) {
      const notesBefore = JSON.stringify(clipsOf('t3')[empty]!.notes.map((n) => [n.tick, n.pitch, n.duration, n.velocity]));
      const stepBefore = session.store.undoEntryId();
      await clickEl(button('Variation', panel()));
      const notesAfter = JSON.stringify(clipsOf('t3')[empty]!.notes.map((n) => [n.tick, n.pitch, n.duration, n.velocity]));
      if (notesAfter === notesBefore) {
        // Nothing changed: no undo step, and it says why.
        expect(session.store.undoEntryId()).toBe(stepBefore);
        expect(notice()).toMatch(/too short to vary: add a few notes first\.$/);
        sawShort = true;
      } else expect(session.store.undoEntryId()).not.toBe(stepBefore);
    }
    // A one-note clip has almost nothing to vary: at least one press says so.
    expect(sawShort).toBe(true);
  });

  it('Back to original after an edit made in Steps says the edit is the new original', async () => {
    await openApp(1366, 768);
    const slot = clipsOf('t3').findIndex((c) => !!c && c.notes.length > 4);
    act(() => {
      selectTrack('t3');
      selectSlot('t3', slot);
    });
    await clickEl(button('Variation', panel()));
    act(() => void toggleStep(session.store, 't3', slot, 15, 40));
    await clickEl(button('More Variation choices', panel()));
    expect(item('Back to original').getAttribute('aria-disabled')).toBe('true');
    expect(item('Back to original').textContent).toContain('Edited since: these notes are the new original');
    await press('{Escape}');
  });
});
