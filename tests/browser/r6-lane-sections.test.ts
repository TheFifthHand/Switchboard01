/**
 * Round 6 in the Song view's timeline, real Chromium, real mouse and keys:
 * - a section drag reorders (ripple): a teal line shows where it goes while
 *   the drag runs, the drop moves the section with all its music, the others
 *   close the gap, nothing is cut, the song keeps its length, one undo step;
 *   Alt+← → on a section moves it one place;
 * - the ruler's right-click menu inserts 4 or 8 bars at that bar line and,
 *   with a range marked, removes those bars (one undo step each); Shift+F10
 *   with no loop selected opens it at the playhead;
 * - a drag held at the timeline's edge scrolls gently (at most about two
 *   bars a second) and the dragged loop is drawn only around the view.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { songBars } from '../../src/project/arrangement';
import type { Project } from '../../src/project/types';
import { barX, centre, clickAt, dragTo, menuItem, mouse, openSong, press, project, region, regionEl, regions, resetSong, rightClickAt, scroller, sections, settle, teardownSong, undoCount } from './r5-song-helpers';

const sectionEl = (id: string) => document.querySelector<HTMLElement>(`[data-section-id="${id}"]`)!;
const order = () => [...sections()].sort((a, b) => a.start - b.start).map((s) => `${s.name}@${s.start}+${s.bars}`);
const insertLines = () => [...document.querySelectorAll<HTMLElement>('[class*="insertLine"]')];

/**
 * Intro (bars 1–4: Drums A), Verse (5–12: Drums B, Bass C), Chorus (13–16:
 * Drums E, Lead F); the Bass loop C runs on into the Chorus (bars 5–14).
 */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  const lead = p.tracks[4];
  const dc = drums.clips.find((c) => c)!.id;
  const bc = bass.clips.find((c) => c)!.id;
  const lc = lead.clips.find((c) => c)!.id;
  p.arrangement.regions = [region('A', drums.id, dc, 0, 4), region('B', drums.id, dc, 4, 8), region('C', bass.id, bc, 4, 10), region('E', drums.id, dc, 12, 4), region('F', lead.id, lc, 12, 4)];
  p.arrangement.sections = [
    { id: 'S1', name: 'Intro', start: 0, bars: 4 },
    { id: 'S2', name: 'Verse', start: 4, bars: 8 },
    { id: 'S3', name: 'Chorus', start: 12, bars: 4 },
  ];
}

async function open(w = 1366, hh = 768): Promise<void> {
  await openSong(w, hh, song);
  act(() => ppbStore.setState(32));
  await settle();
}

beforeEach(resetSong);
afterEach(teardownSong);

describe('reordering sections', () => {
  it('a drag shows where the section goes, and the drop moves it with its music; nothing is cut; one undo step', async () => {
    await open();
    const before = undoCount();
    const length = songBars(project());
    const from = centre(sectionEl('S3'), 0.5);
    // Chorus dragged over the Verse's first half: it goes before the Verse.
    await dragTo(from, { x: barX(6), y: from.y }, { release: false });
    const lines = insertLines();
    expect(lines.length).toBe(2);
    expect(lines[0].getBoundingClientRect().left + 2).toBeCloseTo(barX(4), 0);
    const badge = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((e) => /^Move /.test(e.textContent ?? ''));
    expect(badge?.textContent).toBe('Move before Verse');
    // Nothing is written while the drag runs.
    expect(undoCount()).toBe(before);
    await mouse('mouseReleased', { x: barX(6), y: from.y });
    await settle(80);
    expect(order()).toEqual(['Intro@0+4', 'Chorus@4+4', 'Verse@8+8']);
    expect(undoCount()).toBe(before + 1);
    expect(songBars(project())).toBe(length);
    // The Chorus's loops moved with it; the Bass loop that ran into it was split there and its piece came along.
    expect(regions().find((r) => r.id === 'E')?.start).toBe(4);
    expect(regions().find((r) => r.id === 'F')?.start).toBe(4);
    const bass = regions().filter((r) => r.trackId === project().tracks[2].id).map((r) => `${r.start}+${r.bars}`).sort();
    expect(bass).toEqual(['4+2', '8+8']);
    expect(insertLines().length).toBe(0);
    act(() => session.undo());
    expect(order()).toEqual(['Intro@0+4', 'Verse@4+8', 'Chorus@12+4']);
    expect(regions().find((r) => r.id === 'C')).toMatchObject({ start: 4, bars: 10 });
  });

  it('a drag that stays over its own place changes nothing and says how to move it', async () => {
    await open();
    const before = undoCount();
    const from = centre(sectionEl('S2'), 0.5);
    await dragTo(from, { x: from.x + 40, y: from.y }, { release: false });
    const badge = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((e) => /section/.test(e.textContent ?? ''));
    expect(badge?.textContent).toBe('Drag over another section to move it');
    expect(insertLines().length).toBe(0);
    await mouse('mouseReleased', { x: from.x + 40, y: from.y });
    await settle(60);
    expect(undoCount()).toBe(before);
    expect(order()).toEqual(['Intro@0+4', 'Verse@4+8', 'Chorus@12+4']);
  });

  it('Alt+← and Alt+→ on a section move it one place, with its music', async () => {
    await open();
    act(() => sectionEl('S1').focus());
    await press('ArrowRight', 1);
    expect(order()).toEqual(['Verse@0+8', 'Intro@8+4', 'Chorus@12+4']);
    expect(regions().find((r) => r.id === 'A')?.start).toBe(8);
    expect(session.store.undoLabel()).toBe('Move Intro later');
    expect(document.activeElement).toBe(sectionEl('S1'));
    await press('ArrowLeft', 1);
    expect(order()).toEqual(['Intro@0+4', 'Verse@4+8', 'Chorus@12+4']);
  });
});

describe('the ruler’s menu', () => {
  it('inserts 4 or 8 bars at the bar line clicked, one undo step each', async () => {
    await open();
    const ruler = document.querySelector<HTMLElement>('[data-ruler]')!;
    const y = ruler.getBoundingClientRect().top + 24;
    await rightClickAt({ x: barX(4) + 3, y });
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('At bar 5');
    const before = undoCount();
    await clickAt(centre(menuItem('Insert 4 bars here')));
    expect(undoCount()).toBe(before + 1);
    expect(order()).toEqual(['Intro@0+4', 'Verse@8+8', 'Chorus@16+4']);
    expect(regions().find((r) => r.id === 'B')?.start).toBe(8);
    expect(session.store.undoLabel()).toBe('Insert 4 bars');
    await rightClickAt({ x: barX(0) + 3, y });
    await clickAt(centre(menuItem('Insert 8 bars here')));
    expect(order()).toEqual(['Intro@8+4', 'Verse@16+8', 'Chorus@24+4']);
  });

  it('with a range marked, removes those bars (the rest closes up); without one it says how', async () => {
    await open();
    const ruler = document.querySelector<HTMLElement>('[data-ruler]')!;
    const y = ruler.getBoundingClientRect().top + 24;
    await rightClickAt({ x: barX(2), y });
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('drag along the ruler');
    await press('Escape');
    // Mark bars 5–12 (the Verse) by dragging along the ruler, then remove them.
    await dragTo({ x: barX(4) + 2, y }, { x: barX(12) + 2, y });
    await rightClickAt({ x: barX(6), y: ruler.getBoundingClientRect().top + 24 });
    const before = undoCount();
    await clickAt(centre(menuItem('Remove bars 5–12')));
    expect(undoCount()).toBe(before + 1);
    expect(order()).toEqual(['Intro@0+4', 'Chorus@4+4']);
    // The Chorus's loops closed up to bar 5 (its drums play on from the Intro's, as one loop).
    expect(regions().find((r) => r.id === 'F')?.start).toBe(4);
    expect(regions().some((r) => r.trackId === project().tracks[0].id && r.start <= 4 && r.start + r.bars >= 8)).toBe(true);
  });

  it('Shift+F10 with no loop selected opens it at the playhead', async () => {
    await open();
    act(() => session.setSongCursor(12));
    await settle(60);
    act(() => document.querySelector<HTMLElement>('[aria-label^="The song: a row"]')!.focus());
    await press('F10', 8);
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('At bar 13');
    await clickAt(centre(menuItem('Insert 4 bars here')));
    expect(order()).toEqual(['Intro@0+4', 'Verse@4+8', 'Chorus@16+4']);
  });
});

describe('drags near the edge', () => {
  it('auto-scroll eases in and stays at about two bars a second; the dragged loop is drawn only around the view', async () => {
    await open();
    act(() => ppbStore.setState(64));
    await settle(150);
    const sc = scroller();
    const box = sc.getBoundingClientRect();
    const r = regionEl('B').getBoundingClientRect();
    const from = { x: r.right - 5, y: r.top + r.height / 2 };
    const edgeX = box.right - 4;
    await dragTo(from, { x: edgeX, y: from.y }, { release: false, ms: 200 });
    const start = sc.scrollLeft;
    const t0 = performance.now();
    await settle(1500);
    const secs = (performance.now() - t0) / 1000;
    const bars = (sc.scrollLeft - start) / 64;
    expect(bars).toBeGreaterThan(0.5);
    expect(bars).toBeLessThanOrEqual(2 * secs + 0.5);
    // The ghost never reaches past a view's width either side of the view.
    const view = box.width;
    for (const g of document.querySelectorAll<HTMLElement>('[data-ghost]')) expect(g.getBoundingClientRect().width).toBeLessThanOrEqual(3 * view + 2);
    await press('Escape');
    expect(regions().find((x) => x.id === 'B')).toMatchObject({ start: 4, bars: 8 });
  });
});
