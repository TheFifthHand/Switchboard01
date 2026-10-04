/**
 * The Song view after the UX review, in real Chromium with a real mouse and
 * keys:
 * - clearing the song empties it: Ctrl+A takes the loops and the section
 *   labels, Delete removes them as one undo step, the length reads 0 bars,
 *   the empty note shows and its button makes a song; with only labels left
 *   the song is empty too, and Play then says the song is empty;
 * - the keys act on the selection wherever the view has focus: after a
 *   marquee, a click on an empty spot, a section, a ruler click and a Cut;
 *   never inside a field, never in another view;
 * - Ctrl+drag copies exactly what Alt+drag does (a Ctrl click still adds or
 *   removes);
 * - after a scene drop nothing is selected (stretching one of its loops
 *   stretches that loop only), and stretching several says how many;
 * - a split leaves the right-hand piece selected;
 * - a part's loop over another part's row says "Not this part" at the
 *   pointer;
 * - clicking a part's header or one of its loops chooses the part the
 *   keyboard plays (its header shows it).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { ppbStore, selectionStore } from '../../src/app/views/arrange/laneStore';
import type { Project } from '../../src/project/types';
import { setView, uiStore } from '../../src/state/uiStore';
import {
  barX,
  centre,
  clickAt,
  dragTo,
  menuItem,
  on,
  openSong,
  ppb,
  press,
  project,
  region,
  regionEl,
  regions,
  resetSong,
  rightClickAt,
  rowY,
  rt,
  sections,
  settle,
  teardownSong,
  undoCount,
  waitFor,
} from './r5-song-helpers';

/** Drums: A (bars 1–8), B (13–16); Bass: C (1–16); sections Intro (1–8) and Drop (9–16). */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  const dc = drums.clips.find((c) => c)!.id;
  const bc = bass.clips.find((c) => c)!.id;
  p.arrangement.regions = [region('A', drums.id, dc, 0, 8), region('B', drums.id, dc, 12, 4), region('C', bass.id, bc, 0, 16)];
  p.arrangement.sections = [
    { id: 'S1', name: 'Intro', start: 0, bars: 8 },
    { id: 'S2', name: 'Drop', start: 8, bars: 8 },
  ];
}

const get = (id: string) => regions().find((r) => r.id === id);
const selected = () => [...document.querySelectorAll<HTMLElement>('[data-region-id][data-selected]')].map((e) => e.dataset.regionId!).sort();
const sectionEl = (id: string) => document.querySelector<HTMLElement>(`[data-section-id="${id}"]`)!;
const lengthText = () => document.querySelector('[data-testid="song-length"]')!.textContent;
const rulerY = () => {
  const r = document.querySelector('[data-ruler]')!.getBoundingClientRect();
  return r.bottom - 8;
};

async function open(fill: (p: Project) => void = song): Promise<void> {
  await openSong(1366, 768, fill);
  act(() => ppbStore.setState(24));
  await settle();
}

beforeEach(resetSong);
afterEach(teardownSong);

describe('clearing the song', () => {
  it('Ctrl+A takes the loops and the sections; Delete clears the song in one undo step; it reads empty and the button makes a song', async () => {
    await open();
    await clickAt(on('A'));
    await press('a', 2);
    expect(selected()).toEqual(['A', 'B', 'C']);
    expect(sectionEl('S1').hasAttribute('data-selected')).toBe(true);
    expect(sectionEl('S2').hasAttribute('data-selected')).toBe(true);
    const before = undoCount();
    await press('Delete');
    expect(regions()).toEqual([]);
    expect(sections()).toEqual([]);
    expect(undoCount()).toBe(before + 1);
    expect(lengthText()).toBe('0 bars · 0:00');
    expect(document.querySelector('[data-testid="song-empty"]')?.textContent).toContain('The song is empty');
    // One Undo brings back loops and labels alike.
    act(() => void session.undo());
    await settle();
    expect(regions().length).toBe(3);
    expect(sections().length).toBe(2);
    act(() => void session.redo());
    await settle();
    // The empty song's button works.
    await clickAt(centre(document.querySelector('[data-testid="empty-make-song"]')!));
    expect(regions().length).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid="song-empty"]')).toBeNull();
  });

  it('with only section labels left the song is empty: 0 bars, the empty note, and its button still makes a song', async () => {
    await open();
    // A marquee over every loop (from an empty spot after them), then Delete.
    await dragTo({ x: barX(17.5), y: rowY(project().tracks[0].id) }, { x: barX(0.2), y: rowY(project().tracks[2].id) + 8 });
    expect(selected()).toEqual(['A', 'B', 'C']);
    await press('Delete');
    expect(regions()).toEqual([]);
    expect(sections().length).toBe(2);
    expect(lengthText()).toBe('0 bars · 0:00');
    expect(document.querySelector('[data-testid="song-empty"]')).not.toBeNull();
    await clickAt(centre(document.querySelector('[data-testid="empty-make-song"]')!));
    expect(regions().length).toBeGreaterThan(0);
  });

  it('Play with an empty song plays the pads, and the header says the song is empty', async () => {
    await open((p) => {
      p.arrangement.regions = [];
      p.arrangement.sections = [];
    });
    await press(' ');
    await waitFor(() => rt().playing, 'the pads to play');
    expect(rt().mode).toBe('live');
    expect(document.querySelector('[data-testid="pads-playing"]')?.textContent).toBe('The song is empty: your pads are playing');
    await press(' ');
    await waitFor(() => document.querySelector('[data-testid="pads-playing"]')?.textContent === 'The song is empty: your pads are paused', 'paused words');
  });
});

describe('the keys act on the selection wherever the view has focus', () => {
  it('after a marquee, Delete deletes what it selected', async () => {
    await open();
    await dragTo({ x: barX(9.5), y: rowY(project().tracks[0].id) - 12 }, { x: barX(10.5), y: rowY(project().tracks[2].id) + 6 });
    expect(selected()).toEqual(['C']);
    await press('Delete');
    expect(get('C')).toBeUndefined();
    expect(get('A')).toBeDefined();
  });

  it('after a click on an empty spot (which clears), Ctrl+A selects every loop', async () => {
    await open();
    await clickAt(on('A'));
    // The loop's ⋯, then an empty spot: focus never stays on the button.
    await clickAt({ x: barX(10), y: rowY(project().tracks[0].id) });
    expect(selected()).toEqual([]);
    await press('a', 2);
    expect(selected()).toEqual(['A', 'B', 'C']);
  });

  it('a section click selects its loops and Delete deletes them; Ctrl+X, a ruler click and Ctrl+V paste there', async () => {
    await open();
    await clickAt(centre(sectionEl('S2'), 0.5));
    expect(selected()).toEqual(['B']);
    await press('Delete');
    expect(get('B')).toBeUndefined();
    // Cut A, click bar 21 on the ruler, paste: A comes back at bar 21.
    await clickAt(on('A'));
    await press('x', 2);
    expect(get('A')).toBeUndefined();
    await clickAt({ x: barX(20) + 4, y: rulerY() });
    expect(rt().songCursor).toBe(20);
    await press('v', 2);
    expect(regions().some((r) => r.trackId === project().tracks[0].id && r.start === 20 && r.bars === 8)).toBe(true);
  });

  it('not while renaming a section (the field takes Delete), and not in another view', async () => {
    await open();
    await clickAt(on('A'));
    // Rename the Intro: Backspace edits the name, the loops stay.
    const s1 = sectionEl('S1');
    await clickAt(centre(s1, 0.4), 0, 1);
    const { mouse } = await import('./r4-uikit-input');
    const p = centre(s1, 0.4);
    await mouse('mousePressed', p, { clickCount: 2 });
    await mouse('mouseReleased', p, { clickCount: 2 });
    await settle(80);
    const field = document.querySelector<HTMLInputElement>('input[aria-label^="Name of the section"]')!;
    expect(document.activeElement).toBe(field);
    const count = regions().length;
    await press('Backspace');
    expect(regions().length).toBe(count);
    await press('Escape');
    // In Play, Delete is not the song's.
    act(() => setView('play'));
    await settle(200);
    await press('Delete');
    expect(regions().length).toBe(count);
  });
});

describe('Ctrl and Alt', () => {
  it('Ctrl+drag copies exactly what Alt+drag would: only the loop dragged, when it was not selected', async () => {
    await open();
    await clickAt(on('C'));
    expect(selected()).toEqual(['C']);
    const k = ppb();
    const from = on('B', 0.5);
    await dragTo(from, { x: from.x + 4 * k, y: from.y }, { modifiers: 2 });
    // B copied to bar 17; C neither copied nor moved.
    expect(regions().filter((r) => r.trackId === project().tracks[2].id).map((r) => r.start)).toEqual([0]);
    expect(regions().filter((r) => r.trackId === project().tracks[0].id).map((r) => [r.start, r.bars])).toEqual([
      [0, 8],
      [12, 4],
      [16, 4],
    ]);
    // A Ctrl click still adds and removes.
    await clickAt(on('A'), 2);
    expect(selectionStore.getState().ids).toContain('A');
    await clickAt(on('A'), 2);
    expect(selectionStore.getState().ids).not.toContain('A');
  });
});

describe('what an edit leaves selected', () => {
  it('a scene drop leaves nothing selected: stretching one of its loops stretches that one; several say how many', async () => {
    await open((p) => {
      p.arrangement.regions = [];
      p.arrangement.sections = [];
    });
    const card = document.querySelector<HTMLElement>('[data-scene-row="0"]')!;
    card.scrollIntoView({ block: 'nearest' });
    await dragTo(centre(card, 0.6), { x: barX(0) + 4, y: rowY(project().tracks[0].id) });
    const added = regions();
    expect(added.length).toBeGreaterThan(1);
    expect(selected()).toEqual([]);
    const drums = added.find((r) => r.trackId === project().tracks[0].id)!;
    const others = added.filter((r) => r.id !== drums.id).map((r) => [r.id, r.bars]);
    const grip = (() => {
      const r = regionEl(drums.id).getBoundingClientRect();
      return { x: r.right - 3, y: r.top + r.height * 0.6 };
    })();
    await dragTo(grip, { x: grip.x + 4 * ppb(), y: grip.y });
    expect(get(drums.id)!.bars).toBe(drums.bars + 4);
    expect(regions().filter((r) => r.id !== drums.id).map((r) => [r.id, r.bars])).toEqual(others);
    // Ctrl+A, then stretch: the badge says how many.
    await clickAt(on(drums.id));
    await press('a', 2);
    const g2 = (() => {
      const r = regionEl(drums.id).getBoundingClientRect();
      return { x: r.right - 3, y: r.top + r.height * 0.6 };
    })();
    await dragTo(g2, { x: g2.x + 2 * ppb(), y: g2.y }, { release: false });
    const badge = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((e) => /loops ·/.test(e.textContent ?? ''));
    expect(badge?.textContent).toMatch(new RegExp(`^${added.length} loops · `));
    await press('Escape');
  });

  it('Split here leaves the right-hand piece selected', async () => {
    await open();
    await rightClickAt(on('A', 0.5 - 0.1 / 8));
    await clickAt(centre(menuItem('Split here')));
    const pieces = regions().filter((r) => r.trackId === project().tracks[0].id && r.start < 8);
    expect(pieces.map((r) => [r.start, r.bars])).toEqual([
      [0, 4],
      [4, 4],
    ]);
    expect(selectionStore.getState().ids).toEqual([pieces[1].id]);
  });
});

describe('carrying a part’s loop', () => {
  it('over another part’s row, "Not this part" shows at the pointer only', async () => {
    await open((p) => {
      p.arrangement.regions = [];
      p.arrangement.sections = [];
    });
    const bass = project().tracks[2];
    const chip = document.querySelector<HTMLElement>(`[data-chip="${bass.clips.find((c) => c)!.id}"]`)!;
    chip.scrollIntoView({ block: 'nearest' });
    const at = { x: barX(6) + 4, y: rowY(project().tracks[0].id) };
    await dragTo(centre(chip), at, { release: false });
    const notes = [...document.querySelectorAll<HTMLElement>('*')].filter((e) => e.childElementCount === 0 && e.textContent === 'Not this part');
    expect(notes.length).toBe(1);
    const r = notes[0].getBoundingClientRect();
    expect(Math.abs(r.left - at.x)).toBeLessThan(30);
    expect(Math.abs(r.bottom - at.y)).toBeLessThan(30);
    await press('Escape');
  });
});

describe('the part the keyboard plays', () => {
  it('a click on a part’s header, or on one of its loops, chooses it; its header shows it', async () => {
    await open();
    const bass = project().tracks[2];
    const drums = project().tracks[0];
    const head = (id: string) => document.querySelector<HTMLElement>(`[data-lane-row="${id}"] [data-part-head]`)!;
    await clickAt(centre(head(bass.id), 0.35));
    expect(uiStore.getState().selectedTrackId).toBe(bass.id);
    expect(head(bass.id).hasAttribute('data-current')).toBe(true);
    expect(head(bass.id).textContent).toContain('the keyboard plays this part');
    await clickAt(on('A'));
    expect(uiStore.getState().selectedTrackId).toBe(drums.id);
    expect(head(drums.id).hasAttribute('data-current')).toBe(true);
    expect(head(bass.id).hasAttribute('data-current')).toBe(false);
    // The header's Mute key mutes; it does not choose the part.
    await clickAt(centre(head(bass.id).querySelector('[data-kind="mute"]')!));
    expect(uiStore.getState().selectedTrackId).toBe(drums.id);
  });
});
