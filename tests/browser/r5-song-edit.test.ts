/**
 * Editing loops from their menu and from the keyboard, in real Chromium:
 * right-click and ⋯ open the loop's actions (Split here, Split at the
 * playhead, Duplicate, Delete, Use another loop, Make it 2× longer, Edit
 * notes), and the keys do the same (Delete, Ctrl+D, Ctrl+C / Ctrl+V at the
 * playhead, Ctrl+E split, ← → move, Alt+← → length, ↑ ↓ and Ctrl+← → to
 * move between loops). A double-click opens the loop's notes in Play › Steps
 * with a way back to the song. Each edit is one undo step.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import type { Project } from '../../src/project/types';
import { uiStore } from '../../src/state/uiStore';
import {
  centre,
  clickAt,
  cutOff,
  doubleClickAt,
  menuItem,
  mouse,
  on,
  openSong,
  press,
  project,
  region,
  regionEl,
  regions,
  resetSong,
  rightClickAt,
  rt,
  settle,
  teardownSong,
  undoCount,
  waitFor,
} from './r5-song-helpers';

/** Drums: A over bars 1–8, B over 13–16; Bass: C over 1–16. */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  const dc = drums.clips.find((c) => c)!;
  const bc = bass.clips.find((c) => c)!;
  p.arrangement.regions = [region('A', drums.id, dc.id, 0, 8), region('B', drums.id, dc.id, 12, 4), region('C', bass.id, bc.id, 0, 16)];
  p.arrangement.sections = [];
}

const get = (id: string) => regions().find((r) => r.id === id);
const drums = () => regions().filter((r) => r.trackId === project().tracks[0].id).map((r) => [r.start, r.bars]);

async function open(): Promise<void> {
  await openSong(1366, 768, song);
  act(() => ppbStore.setState(32));
  await settle();
}

beforeEach(resetSong);
afterEach(teardownSong);

describe('the loop menu', () => {
  it('right-click → Split here cuts the loop at the bar line nearest the pointer (one undo step)', async () => {
    await open();
    const before = undoCount();
    await rightClickAt(on('A', 0.5 - 0.1 / 8));
    await clickAt(centre(menuItem('Split here')));
    expect(drums()).toEqual([
      [0, 4],
      [4, 4],
      [12, 4],
    ]);
    expect(undoCount()).toBe(before + 1);
  });

  it('Duplicate, Make it 2× longer and Delete', async () => {
    await open();
    await rightClickAt(on('B'));
    await clickAt(centre(menuItem('Duplicate')));
    expect(drums()).toEqual([
      [0, 8],
      [12, 4],
      [16, 4],
    ]);
    await rightClickAt(on('A'));
    await clickAt(centre(menuItem('Make it 2× longer')));
    expect(get('A')?.bars).toBe(16);
    await rightClickAt(on('C'));
    await clickAt(centre(menuItem('Delete')));
    expect(get('C')).toBeUndefined();
  });

  it('Use another loop ▸ lists the part’s loops; choosing one swaps what the region plays', async () => {
    await open();
    const clips = project().tracks[0].clips.filter((c) => c);
    expect(clips.length).toBeGreaterThan(1);
    await rightClickAt(on('A'));
    await clickAt(centre(menuItem('Use another loop')));
    await clickAt(centre(menuItem(clips[1]!.name)));
    expect(get('A')).toMatchObject({ clipId: clips[1]!.id, start: 0, bars: 8, offset: 0 });
  });

  it('the ⋯ on a hovered loop opens the same menu', async () => {
    await open();
    await mouse('mouseMoved', on('A', 0.4));
    await settle();
    const more = document.querySelector<HTMLElement>('[data-hover-more]')!;
    expect(more).toBeTruthy();
    await clickAt(centre(more));
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toContain('Actions for');
  });

  it('Split at playhead says when the playhead is not in the loop; nothing in the menu is cut off', async () => {
    await open();
    act(() => session.setSongCursor(20));
    await rightClickAt(on('A'));
    const item = menuItem('Split at playhead');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain('Playhead not in this loop');
    expect(cutOff()).toEqual([]);
    await press('Escape');
    act(() => session.setSongCursor(2));
    await rightClickAt(on('A'));
    expect(cutOff()).toEqual([]);
    await clickAt(centre(menuItem('Split at playhead')));
    expect(drums()[0]).toEqual([0, 2]);
  });
});

describe('keys', () => {
  it('← → move the selection a bar (Shift: 4), Alt+→ lengthens it, each one undo step', async () => {
    await open();
    await clickAt(on('B'));
    expect(document.activeElement).toBe(regionEl('B'));
    const before = undoCount();
    await press('ArrowRight');
    expect(get('B')?.start).toBe(13);
    await press('ArrowLeft', 8);
    expect(get('B')?.start).toBe(9);
    await press('ArrowRight', 1);
    expect(get('B')).toMatchObject({ start: 9, bars: 5 });
    expect(undoCount()).toBe(before + 3);
    expect(document.activeElement).toBe(regionEl('B'));
  });

  it('Delete removes the selection; then nothing is selected or looks it, focus stays in the song, and Delete again does nothing', async () => {
    await open();
    const all = regions().length;
    await clickAt(on('A'));
    await press('Delete');
    expect(get('A')).toBeUndefined();
    expect(document.querySelectorAll('[data-region-id][data-selected]').length).toBe(0);
    // Focus is on the rows as a whole (in the song), not on a loop that would look chosen.
    await waitFor(() => document.activeElement?.getAttribute('aria-label') === 'The song: a row of loops for each part', 'focus on the rows');
    await press('Delete');
    await press('Backspace');
    expect(regions().length).toBe(all - 1);
  });

  it('Ctrl+D duplicates after the selection; Ctrl+C then Ctrl+V pastes at the playhead on the same part', async () => {
    await open();
    await clickAt(on('B'));
    await press('d', 2);
    expect(drums()).toEqual([
      [0, 8],
      [12, 4],
      [16, 4],
    ]);
    await clickAt(on('A'));
    await press('c', 2);
    act(() => session.setSongCursor(24));
    await press('v', 2);
    expect(drums()).toContainEqual([24, 8]);
  });

  it('Ctrl+E splits the selection at the playhead; Enter takes the playhead back to bar 1', async () => {
    await open();
    act(() => session.setSongCursor(6));
    await clickAt(on('C'));
    await press('e', 2);
    expect(regions().filter((r) => r.trackId === project().tracks[2].id).map((r) => [r.start, r.bars])).toEqual([
      [0, 6],
      [6, 10],
    ]);
    await press('Enter');
    expect(rt().songCursor).toBe(0);
  });

  it('↑ ↓ go to the loop on the part above or below; Ctrl+← → along the part', async () => {
    await open();
    await clickAt(on('A'));
    await press('ArrowDown');
    await settle(60);
    expect(document.activeElement).toBe(regionEl('C'));
    await press('ArrowUp');
    await settle(60);
    expect(document.activeElement).toBe(regionEl('A'));
    await press('ArrowRight', 2);
    await settle(60);
    expect(document.activeElement).toBe(regionEl('B'));
    expect(regionEl('B').getAttribute('aria-pressed')).toBe('true');
  });

  it('regions are named for screen readers and the song is one Tab stop', async () => {
    await open();
    expect(regionEl('A').getAttribute('aria-label')).toMatch(/^.+, Drums, bars 1 to 8, plays .+$/);
    const tabbable = [...document.querySelectorAll('[data-region-id]')].filter((e) => (e as HTMLElement).tabIndex === 0);
    expect(tabbable).toHaveLength(1);
  });
});

describe('notes', () => {
  it('a double-click opens the loop’s notes in Play › Steps, and “Back to Song” returns', async () => {
    await open();
    const clip = project().tracks[2].clips.find((c) => c)!;
    await doubleClickAt(on('C'));
    expect(uiStore.getState()).toMatchObject({ view: 'play', padMode: 'steps', selectedTrackId: project().tracks[2].id });
    expect(uiStore.getState().selectedSlot[project().tracks[2].id]).toBe(project().tracks[2].clips.indexOf(clip));
    await waitFor(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Back to Song'), 'Back to Song');
    const back = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Back to Song')!;
    await clickAt(centre(back));
    expect(uiStore.getState().view).toBe('arrange');
  });
});
