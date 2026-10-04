/**
 * Sections in real Chromium: a double-click renames one in place, a click
 * selects the loops that start in it, a drag moves it with its music (one
 * undo step), its edges resize the label only (stopping at the next one), and its menu duplicates it,
 * deletes it (the label, or with its music) and switches its song moves (the
 * menu shows which are on). Hovering a stretch with no section offers
 * "+ Add section" there.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import type { Project } from '../../src/project/types';
import {
  barX,
  centre,
  clickAt,
  doubleClickAt,
  dragTo,
  menuItem,
  openSong,
  press,
  project,
  region,
  regions,
  resetSong,
  rightClickAt,
  sections,
  settle,
  teardownSong,
  undoCount,
} from './r5-song-helpers';

/** Intro (bars 1–4: Drums), Drop (bars 5–12: Drums and Bass), then nothing labelled from bar 13 to 16 (Drums). */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  const dc = drums.clips.find((c) => c)!.id;
  const bc = bass.clips.find((c) => c)!.id;
  p.arrangement.regions = [region('A', drums.id, dc, 0, 4), region('B', drums.id, dc, 4, 8), region('C', bass.id, bc, 4, 8), region('E', drums.id, dc, 12, 4)];
  p.arrangement.sections = [
    { id: 'S1', name: 'Intro', start: 0, bars: 4 },
    { id: 'S2', name: 'Drop', start: 4, bars: 8 },
  ];
}

const sectionEl = (id: string) => document.querySelector<HTMLElement>(`[data-section-id="${id}"]`)!;
const get = (id: string) => regions().find((r) => r.id === id);

async function open(): Promise<void> {
  await openSong(1366, 768, song);
  act(() => ppbStore.setState(32));
  await settle();
}

beforeEach(resetSong);
afterEach(teardownSong);

describe('sections', () => {
  it('a double-click renames it in place (Enter keeps the name)', async () => {
    await open();
    await doubleClickAt(centre(sectionEl('S2')));
    const input = sectionEl('S2').querySelector('input')!;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    await press('a', 2);
    for (const ch of 'Chorus') await press(ch);
    await press('Enter');
    expect(sections().find((s) => s.id === 'S2')?.name).toBe('Chorus');
  });

  it('a click selects the loops that start in it', async () => {
    await open();
    await clickAt(centre(sectionEl('S2')));
    const sel = [...document.querySelectorAll<HTMLElement>('[data-region-id][data-selected]')].map((e) => e.dataset.regionId).sort();
    expect(sel).toEqual(['B', 'C']);
  });

  it('a drag moves it with its music, one undo step', async () => {
    await open();
    const before = undoCount();
    const from = centre(sectionEl('S2'), 0.4);
    await dragTo(from, { x: from.x + 8 * 32, y: from.y });
    expect(sections().find((s) => s.id === 'S2')).toMatchObject({ start: 12, bars: 8 });
    expect(get('B')?.start).toBe(12);
    expect(get('C')?.start).toBe(12);
    expect(get('A')?.start).toBe(0);
    expect(undoCount()).toBe(before + 1);
  });

  it('its edges resize the label only, and stop at the next section', async () => {
    await open();
    const edgeAt = (id: string) => {
      const r = sectionEl(id).getBoundingClientRect();
      return { x: r.right - 2, y: r.top + r.height / 2 };
    };
    // Intro's end runs into Drop: it stops there.
    await dragTo(edgeAt('S1'), { x: barX(6), y: edgeAt('S1').y });
    expect(sections().find((s) => s.id === 'S1')).toMatchObject({ start: 0, bars: 4 });
    // Drop's end has room: two bars longer; the music stays.
    await dragTo(edgeAt('S2'), { x: barX(14), y: edgeAt('S2').y });
    expect(sections().find((s) => s.id === 'S2')).toMatchObject({ start: 4, bars: 10 });
    expect(get('B')).toMatchObject({ start: 4, bars: 8 });
    expect(get('E')).toMatchObject({ start: 12, bars: 4 });
  });

  it('its menu: Duplicate, Fade in (checked once on), Delete section and its music', async () => {
    await open();
    await rightClickAt(centre(sectionEl('S1')));
    await clickAt(centre(menuItem('Fade in')));
    expect(menuItem('Fade in').getAttribute('aria-checked')).toBe('true');
    expect(sections().find((s) => s.id === 'S1')?.moves?.map((m) => m.kind)).toEqual(['fadeIn']);
    await press('Escape');
    await rightClickAt(centre(sectionEl('S1')));
    await clickAt(centre(menuItem('Duplicate')));
    expect(sections().map((s) => [s.name, s.start, s.bars])).toEqual([
      ['Intro', 0, 4],
      ['Intro', 4, 4],
      ['Drop', 8, 8],
    ]);
    expect(get('B')?.start).toBe(8);
    await rightClickAt(centre(sectionEl('S2')));
    await clickAt(centre(menuItem('Delete section and its music')));
    expect(sections().map((s) => s.name)).toEqual(['Intro', 'Intro']);
    expect(get('B')).toBeUndefined();
    // The loop after it moved up to close the gap: the Drums play bars 9–12 again.
    expect(regions().some((r) => r.trackId === project().tracks[0].id && r.start <= 8 && r.start + r.bars >= 12)).toBe(true);
  });

  it('the ⋯ at its end, under the pointer, opens its actions', async () => {
    await open();
    const { mouse } = await import('./r4-uikit-input');
    await mouse('mouseMoved', centre(sectionEl('S2'), 0.3));
    await settle(60);
    const more = document.querySelector<HTMLElement>('[data-section-more]')!;
    expect(more.getAttribute('aria-label')).toBe('Actions for the section Drop');
    await clickAt(centre(more));
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Actions for the section Drop');
  });

  it('a stretch of the song with no section offers “+ Add section”', async () => {
    await open();
    const add = document.querySelector<HTMLElement>('[data-section-gap]')!;
    expect(add.getAttribute('aria-label')).toBe('Add a section over bars 13 to 16');
    await clickAt(centre(add));
    expect(sections().map((s) => [s.start, s.bars])).toContainEqual([12, 4]);
  });
});
