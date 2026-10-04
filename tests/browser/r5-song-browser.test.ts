/**
 * Building a song from the loop browser in real Chromium with a real mouse:
 * the empty song's one button, a scene card dragged onto the rows (every part
 * with a clip in it gets a loop there, plus a section named after it), a part's
 * loop that lands only on its own row, a double-click on an empty spot that
 * picks a loop for it, and Enter on a card or chip (the keyboard way).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { rowBars } from '../../src/project/arrangement';
import type { Project } from '../../src/project/types';
import {
  barX,
  centre,
  clickAt,
  doubleClickAt,
  dragCursorNow,
  dragTo,
  dragView,
  openSong,
  press,
  project,
  regions,
  release,
  resetSong,
  rowY,
  sections,
  settle,
  teardownSong,
  undoCount,
} from './r5-song-helpers';

const emptySong = (p: Project) => {
  p.arrangement.regions = [];
  p.arrangement.sections = [];
};

beforeEach(resetSong);
afterEach(teardownSong);

const browser = () => document.querySelector<HTMLElement>('[data-testid="loop-browser"]');
const card = (row: number) => document.querySelector<HTMLElement>(`[data-scene-row="${row}"]`)!;
/** A part's loop chip, scrolled into view in the browser. */
function chip(clipId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-chip="${clipId}"]`)!;
  el.scrollIntoView({ block: 'nearest' });
  return el;
}

describe('an empty song', () => {
  it('says what to do in one line, with one button that makes a song from the scenes; the loop browser is open', async () => {
    await openSong(1366, 768, emptySong);
    const empty = document.querySelector<HTMLElement>('[data-testid="song-empty"]')!;
    expect(empty.textContent).toContain('Drag a scene or a loop here — or');
    expect(browser()).toBeTruthy();
    const before = undoCount();
    await clickAt(centre(document.querySelector('[data-testid="empty-make-song"]')!));
    expect(regions().length).toBeGreaterThan(0);
    expect(sections().length).toBeGreaterThan(0);
    expect(undoCount()).toBe(before + 1);
    expect(document.querySelector('[data-testid="song-empty"]')).toBeNull();
    // Each section is named after its scene.
    const names = new Set(project().scenes.map((s) => s.name));
    for (const s of sections()) expect(names.has(s.name)).toBe(true);
  });
});

describe('dragging from the loop browser', () => {
  it('a scene card dropped on the rows: a loop for each of its parts from that bar, and a section named after it (one undo step)', async () => {
    await openSong(1366, 768, emptySong);
    act(() => ppbStore.setState(24));
    await settle();
    const row = 1;
    const p = project();
    const parts = p.tracks.filter((t) => t.clips[row]).map((t) => t.id);
    const from = centre(card(row), 0.6);
    const to = { x: barX(4) + 6, y: rowY(p.tracks[3].id) };
    await dragTo(from, to, { release: false });
    // The preview shows all of its loops, and the section it would add.
    expect(dragView()?.preview?.moved.length).toBe(parts.length);
    expect(document.querySelector('[data-new]')?.textContent).toBe(p.scenes[row].name);
    await release(to);
    expect(regions().map((r) => r.trackId).sort()).toEqual([...parts].sort());
    for (const r of regions()) expect(r).toMatchObject({ start: 4, bars: rowBars(p, row) });
    expect(sections()).toMatchObject([{ name: p.scenes[row].name, start: 4, bars: rowBars(p, row) }]);
  });

  it('a part’s loop lands only on its own row: that row lights up; over another row the drop does nothing', async () => {
    await openSong(1366, 768, emptySong);
    act(() => ppbStore.setState(24));
    await settle();
    const bass = project().tracks[2];
    const clip = bass.clips.find((c) => c)!;
    const from = centre(chip(clip.id), 0.5);
    // Over the Drums row: not here.
    const wrong = { x: barX(2) + 4, y: rowY(project().tracks[0].id) };
    await dragTo(from, wrong, { release: false });
    expect(dragView()?.notAllowed).toBe(true);
    expect(dragView()?.ownRow).toBe(bass.id);
    expect(dragCursorNow()).toBe('not-allowed');
    // "Not this part" at the pointer, not on the rows.
    const note = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((e) => e.textContent === 'Not this part')!;
    const nb = note.getBoundingClientRect();
    expect(Math.hypot(nb.left - wrong.x, nb.bottom - wrong.y)).toBeLessThan(40);
    expect(document.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
    await release(wrong);
    expect(regions()).toEqual([]);
    // Over its own row: there.
    const right = { x: barX(2) + 4, y: rowY(bass.id) };
    await dragTo(from, right);
    expect(regions()).toMatchObject([{ trackId: bass.id, clipId: clip.id, start: 2, bars: clip.bars }]);
    expect(dragCursorNow()).toBeNull();
  });

  it('Enter on a chip adds it at the playhead (the keyboard way)', async () => {
    await openSong(1366, 768, emptySong);
    const lead = project().tracks[4];
    const clip = lead.clips.find((c) => c)!;
    chip(clip.id).focus();
    await press('Enter');
    expect(regions()).toMatchObject([{ trackId: lead.id, clipId: clip.id, start: 0 }]);
  });
});

describe('the loop picker', () => {
  it('a double-click on an empty spot of a row offers that part’s loops; choosing one places it at that bar', async () => {
    await openSong(1366, 768, emptySong);
    act(() => ppbStore.setState(32));
    await settle();
    const chords = project().tracks[3];
    await doubleClickAt({ x: barX(6) + 10, y: rowY(chords.id) });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).toBeTruthy();
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const loops = chords.clips.filter((c) => c);
    expect(items.length).toBe(loops.length);
    await clickAt(centre(items[0]));
    expect(regions()).toMatchObject([{ trackId: chords.id, clipId: loops[0]!.id, start: 6 }]);
  });

  it('hovering an empty spot shows a faint + at that bar', async () => {
    await openSong(1366, 768, emptySong);
    const plus = document.querySelector<HTMLElement>('[class*="plus"]')!;
    const y = rowY(project().tracks[1].id);
    await act(async () => {
      const { mouse } = await import('./r4-uikit-input');
      await mouse('mouseMoved', { x: barX(3) + 5, y });
    });
    await settle();
    expect(plus.hasAttribute('data-on')).toBe(true);
    expect(plus.style.getPropertyValue('--s')).toBe('3');
  });
});
