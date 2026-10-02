/**
 * PLAY-10 / capability-08: up to 8 scenes, with real input in the running
 * app:
 * - the scene menu inserts a scene above or below, duplicates one (copies of
 *   its clips, named like "Groove 2"), makes one from what is playing, and
 *   deletes one, asking first (and saying how many) when song blocks use it;
 *   each is one undo step;
 * - "Add scene" (beside the pad actions, under the scene column) adds rows
 *   up to 8; at 1366 x 768 the rows then scroll under the sticky part
 *   headers with pads of at least 64 px, and nothing scrolls sideways at any
 *   size;
 * - the pad menu offers lengths 1, 2, 3, 4 and 8 bars (new clip and Length),
 *   Double and Repeat to 8 bars, and duplicates and moves clips across all
 *   the rows there are.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { selectSlot, selectTrack, setPadMode, uiStore } from '../../src/state/uiStore';
import { SIZES, button, clickEl, clipsOf, grid, item, menu, openApp, pad, press, project, setUp, tearDown, until } from './r4-play-helpers';

beforeEach(setUp);
afterEach(tearDown);

const sceneNames = () => project().scenes.map((s) => s.name);
const sceneButtons = () => [...document.querySelectorAll<HTMLButtonElement>('button[data-scene]')];
async function sceneMenu(name: string): Promise<void> {
  await clickEl(button(`Options for scene ${name}`));
  expect(menu()?.getAttribute('aria-label')).toBe(`Scene ${name}`);
}

describe('the scene menu (PLAY-10)', () => {
  it('inserts above and below, duplicates with copies of the clips, and deletes (asking first when the song uses it); each undoes in one step', async () => {
    await openApp(1366, 768);
    expect(sceneNames()).toEqual(['Intro', 'Groove', 'Lift', 'Break']);

    // Insert above Groove: an empty row 2; every part gets an empty slot there.
    await sceneMenu('Groove');
    await clickEl(item('Insert scene above'));
    expect(project().scenes).toHaveLength(5);
    expect(sceneNames()[2]).toBe('Groove');
    expect(project().tracks.every((t) => t.clips.length === 5 && t.clips[1] === null)).toBe(true);
    expect(sceneButtons()).toHaveLength(5);
    expect(grid().getAttribute('aria-label')).toBe('Clip pads: eight parts by five scenes');
    act(() => session.undo());
    expect(sceneNames()).toEqual(['Intro', 'Groove', 'Lift', 'Break']);

    // Insert below Break: the new last row.
    await sceneMenu('Break');
    await clickEl(item('Insert scene below'));
    expect(project().scenes).toHaveLength(5);
    expect(project().tracks.every((t) => t.clips[4] === null)).toBe(true);
    act(() => session.undo());

    // Duplicate Groove: "Groove 2" just below, with copies (new ids, the same notes).
    const groove = project().tracks.map((t) => t.clips[1]);
    await sceneMenu('Groove');
    await clickEl(item('Duplicate scene'));
    expect(sceneNames()).toEqual(['Intro', 'Groove', 'Groove 2', 'Lift', 'Break']);
    project().tracks.forEach((t, i) => {
      const a = groove[i];
      const b = t.clips[2];
      if (!a) expect(b).toBeNull();
      else {
        expect(b!.id).not.toBe(a.id);
        expect(b!.notes.map((n) => [n.tick, n.pitch, n.duration])).toEqual(a.notes.map((n) => [n.tick, n.pitch, n.duration]));
      }
    });
    expect(session.store.undoLabel()).toBe('Duplicate scene');

    // Deleting the copy (no song block uses it): at once, with Undo.
    await sceneMenu('Groove 2');
    await clickEl(item('Delete scene'));
    expect(sceneNames()).toEqual(['Intro', 'Groove', 'Lift', 'Break']);
    act(() => session.undo());
    expect(sceneNames()).toHaveLength(5);
    act(() => session.undo());
    expect(sceneNames()).toEqual(['Intro', 'Groove', 'Lift', 'Break']);

    // Groove is in the song twice: Delete asks first and says how many blocks go with it.
    const blocks = project().arrangement.blocks.length;
    const grooveId = project().scenes[1].id;
    const using = project().arrangement.blocks.filter((b) => b.sceneId === grooveId).length;
    expect(using).toBe(2);
    await sceneMenu('Groove');
    await clickEl(item('Delete scene'));
    expect(sceneNames()).toHaveLength(4);
    expect(menu()?.textContent).toContain('2 song blocks play it');
    await clickEl(item('Delete scene and 2 song blocks'));
    expect(sceneNames()).toEqual(['Intro', 'Lift', 'Break']);
    expect(project().arrangement.blocks).toHaveLength(blocks - 2);
    act(() => session.undo());
    expect(sceneNames()).toEqual(['Intro', 'Groove', 'Lift', 'Break']);
    expect(project().arrangement.blocks).toHaveLength(blocks);
    // "Keep it" leaves everything.
    await sceneMenu('Groove');
    await clickEl(item('Delete scene'));
    await clickEl(item('Keep it'));
    expect(sceneNames()).toHaveLength(4);
  });

  it("New scene from what's playing copies the clips playing now into a new last row", async () => {
    await openApp(1366, 768, { play: true });
    const tracks = runtimeStore.getState().tracks;
    const playing = project().tracks.map((t) => tracks[t.id]?.playingSlot ?? null);
    expect(playing.some((s) => s !== null)).toBe(true);
    await sceneMenu('Intro');
    await clickEl(item("New scene from what's playing"));
    expect(project().scenes).toHaveLength(5);
    project().tracks.forEach((t, i) => {
      const from = playing[i];
      const got = t.clips[4];
      if (from === null) expect(got).toBeNull();
      else expect(got!.notes.length).toBe(t.clips[from]!.notes.length);
    });
    expect(session.store.undoLabel()).toBe('Capture scene');
  });
});

describe('up to 8 rows', () => {
  for (const s of SIZES) {
    it(`at ${s.name}: Add scene grows the grid to 8 rows (then it goes); the rows scroll under sticky headers where they do not fit; nothing scrolls sideways`, async () => {
      await openApp(s.w, s.h);
      for (let n = 5; n <= 8; n++) {
        await clickEl(button('Add scene'));
        await until(() => sceneButtons().length === n, `${n} rows`);
      }
      expect(button('Add scene')).toBeNull();
      expect(project().scenes).toHaveLength(8);
      expect(document.scrollingElement!.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(grid().scrollWidth).toBeLessThanOrEqual(grid().clientWidth + 1);
      const padH = pad('t1', 7).getBoundingClientRect().height;
      if (s.w === 1366) {
        // At 1366 x 768 eight rows do not fit: they scroll, and pads stay at least 64 px tall.
        expect(grid().scrollHeight).toBeGreaterThan(grid().clientHeight);
        expect(padH).toBeGreaterThanOrEqual(63.5);
        const head = grid().querySelector<HTMLElement>('[data-grid-head]')!;
        const headTop = head.getBoundingClientRect().top;
        act(() => {
          grid().scrollTop = grid().scrollHeight;
        });
        await act(async () => {
          await new Promise((r) => requestAnimationFrame(r));
        });
        // The part headers stay on top; the last row comes into view below them.
        expect(Math.abs(head.getBoundingClientRect().top - headTop)).toBeLessThan(1);
        const last = sceneButtons()[7].getBoundingClientRect();
        expect(last.bottom).toBeLessThanOrEqual(grid().getBoundingClientRect().bottom + 1);
        expect(last.top).toBeGreaterThanOrEqual(head.getBoundingClientRect().bottom - 1);
      } else expect(padH).toBeGreaterThanOrEqual(56);

      // Full: the menu says so instead of adding.
      await sceneMenu(project().scenes[7].name);
      for (const text of ['Insert scene above', 'Insert scene below', 'Duplicate scene']) {
        expect(item(text).getAttribute('aria-disabled'), text).toBe('true');
        expect(item(text).textContent).toContain('8 scenes is the most');
      }
      await press('{Escape}');
    });
  }
});

describe('the pad menu uses every row and the longer lengths', () => {
  it('new clips and Length offer 1, 2, 3, 4 and 8 bars; Double and Repeat to 8 bars repeat the pattern; duplicate and Move… reach rows past the fourth', async () => {
    await openApp(1366, 768);
    await clickEl(button('Add scene'));
    await clickEl(button('Add scene'));
    expect(project().scenes).toHaveLength(6);

    // A new 8-bar clip on an empty pad of the new row.
    await clickEl(pad('t3', 5));
    const keys = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((k) => k.getAttribute('aria-label'));
    expect(keys).toEqual(['New clip, 1 bar', 'New clip, 2 bars', 'New clip, 3 bars', 'New clip, 4 bars', 'New clip, 8 bars']);
    await clickEl(item(/New clip, 8 bars/));
    expect(clipsOf('t3')[5]!.bars).toBe(8);
    // PLAY-21: the next step is to fill it. Focus goes to the pad actions' Edit steps, and the toast offers Edit steps too.
    await until(() => (document.activeElement?.textContent ?? '') === 'Edit steps', 'focus on Edit steps');
    expect(document.activeElement!.closest('[data-pad-actions]')).not.toBeNull();
    const toast = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((t) => t.textContent?.includes('New 8-bar clip'))!;
    expect(toast).toBeDefined();
    await clickEl(button('Edit steps', toast));
    await until(() => !!document.querySelector('input[aria-label="Clip name"]'), 'Steps on the new clip');
    expect(uiStore.getState().padMode).toBe('steps');
    act(() => setPadMode('loops'));
    act(() => session.undo());

    // Double, then Repeat to 8 bars, on a 2-bar Bass clip.
    const two = clipsOf('t3').findIndex((c) => c?.bars === 2);
    const notes = clipsOf('t3')[two]!.notes.length;
    act(() => {
      selectTrack('t3');
      selectSlot('t3', two);
    });
    await clickEl(button(/^Options for clip/));
    expect([...menu()!.querySelectorAll('[role="menuitemradio"]')].map((k) => k.getAttribute('aria-label'))).toEqual(['Length 1 bar', 'Length 2 bars', 'Length 3 bars', 'Length 4 bars', 'Length 8 bars']);
    await clickEl(item('Double (repeat)'));
    expect(clipsOf('t3')[two]!.bars).toBe(4);
    expect(clipsOf('t3')[two]!.notes.length).toBe(notes * 2);
    await clickEl(button(/^Options for clip/));
    await clickEl(item('Repeat to 8 bars'));
    expect(clipsOf('t3')[two]!.bars).toBe(8);
    expect(clipsOf('t3')[two]!.notes.length).toBe(notes * 4);
    expect(session.store.undoLabel()).toBe('Repeat clip to 8 bars');
    act(() => {
      session.undo();
      session.undo();
    });

    // Duplicate goes to the next empty pad, past the fourth row when that is where room is.
    const bass = clipsOf('t3').map((c) => !!c);
    const from = bass.lastIndexOf(true);
    act(() => selectSlot('t3', from));
    await clickEl(button('Duplicate', document.querySelector('[data-pad-actions]')!));
    const to = clipsOf('t3').findIndex((c, i) => !!c && !bass[i]);
    expect(to).toBe(bass.indexOf(false, from + 1) >= 0 ? bass.indexOf(false, from + 1) : bass.indexOf(false));
    act(() => session.undo());

    // Move… with the arrow keys down to row 6.
    act(() => selectSlot('t3', from));
    await clickEl(button('Move…', document.querySelector('[data-pad-actions]')!));
    await until(() => document.activeElement === pad('t3', from), 'focus on the moving pad');
    for (let r = from; r < 5; r++) await press('{ArrowDown}');
    expect(document.activeElement).toBe(pad('t3', 5));
    await press('{Enter}');
    expect(clipsOf('t3')[5]).not.toBeNull();
    expect(clipsOf('t3')[from]).toBeNull();
  });
});
