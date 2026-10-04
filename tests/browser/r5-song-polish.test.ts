/**
 * The Song view's smaller fixes after the UX review, in real Chromium with a
 * real mouse and keys:
 * - − and + zoom around the playhead (else the selection, else the middle);
 *   Fit shows a long song whole, below the zoom ladder if it must;
 * - when the song stops and the playhead goes back, the view goes with it;
 * - a loop's or a section's name stays in sight at the view's left edge;
 * - Play starting at the loop rather than the playhead says why, once, with
 *   Loop off;
 * - paused, the playhead is not amber and the header says Paused;
 * - hit areas: the sections strip and the loop band are tall enough, a
 *   section's end grip is not under its ⋯, a narrow loop band shows its sign
 *   (never cut words), a narrow "+ Add section" shows "+" and there is one
 *   after the song's end; a new section opens for its name;
 * - a section drag says "Bar N" / "+ Copy · Bar N" as a loop drag does;
 * - Use another loop: its chevron at the right, the loop playing now ticked;
 * - Back to Song after Edit notes: the loop selected and focused again;
 * - Shape the song… adds an intro or an ending (unavailable, with the
 *   reason, in an empty song); Add loops is the browser's key; the browser's
 *   loops say "2 bars"; part names keep their whole name in a tooltip.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { ppbStore, selectionStore } from '../../src/app/views/arrange/laneStore';
import { MIN_PX_PER_BAR } from '../../src/app/views/arrange/songLayout';
import { songPlayheadBar } from '../../src/app/songPlayback';
import type { Project } from '../../src/project/types';
import { uiStore } from '../../src/state/uiStore';
import {
  barX,
  centre,
  clickAt,
  doubleClickAt,
  dragTo,
  menuItem,
  mouse,
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
  rt,
  scroller,
  sections,
  settle,
  teardownSong,
  timeline,
  waitFor,
} from './r5-song-helpers';

/** A 64-bar song: Drums D over bars 1–64, Bass B over 9–40; sections Verse (1–16) and Chorus (17–48). */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  p.arrangement.regions = [region('D', drums.id, drums.clips.find((c) => c)!.id, 0, 64), region('B', bass.id, bass.clips.find((c) => c)!.id, 8, 32)];
  p.arrangement.sections = [
    { id: 'S1', name: 'Verse', start: 0, bars: 16 },
    { id: 'S2', name: 'Chorus', start: 16, bars: 32 },
  ];
}

const rulerY = () => {
  const r = document.querySelector('[data-ruler]')!.getBoundingClientRect();
  return r.bottom - 8;
};
const lineEl = () => document.querySelector<HTMLElement>('[class*="playhead"][aria-hidden]')!;
const lineX = () => lineEl().getBoundingClientRect().left + 1;
const sectionEl = (id: string) => document.querySelector<HTMLElement>(`[data-section-id="${id}"]`)!;
const header = () => document.querySelector<HTMLElement>('header[class*="head"]')!;
const button = (name: string) => [...header().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)!;

async function open(scale = 16, fill: (p: Project) => void = song): Promise<void> {
  await openSong(1366, 768, fill);
  act(() => ppbStore.setState(scale));
  await settle();
}

beforeEach(resetSong);
afterEach(teardownSong);

describe('zoom', () => {
  it('+ and − zoom around the playhead while it is in view, else around the selected loops', async () => {
    await open(16);
    await clickAt({ x: barX(30) + 3, y: rulerY() });
    expect(rt().songCursor).toBe(30);
    const x0 = lineX();
    await clickAt(centre(button('Zoom in')));
    await settle(150);
    expect(ppb()).toBe(20);
    expect(Math.abs(lineX() - x0)).toBeLessThan(3);
    await clickAt(centre(button('Zoom out')));
    await settle(150);
    expect(Math.abs(lineX() - x0)).toBeLessThan(3);
    // The playhead out of view: around the selection.
    await clickAt({ x: barX(1) + 3, y: rulerY() });
    scroller().scrollLeft = 30 * ppb();
    await settle(150);
    await clickAt(on('B', 0.8));
    const b0 = regionEl('B').getBoundingClientRect();
    const mid = (b0.left + b0.right) / 2;
    const view = scroller().getBoundingClientRect();
    expect(mid).toBeGreaterThan(view.left);
    await clickAt(centre(button('Zoom in')));
    await settle(150);
    const b1 = regionEl('B').getBoundingClientRect();
    // The selection's visible middle stays roughly where it was.
    expect(b1.right).toBeGreaterThan(view.left + 200);
    expect(b1.left).toBeLessThan(view.right);
  });

  it('Fit shows a long song whole, below the smallest zoom step if it must', async () => {
    await open(16, (p) => {
      const drums = p.tracks[0];
      p.arrangement.regions = [region('L', drums.id, drums.clips.find((c) => c)!.id, 0, 400)];
      p.arrangement.sections = [];
    });
    await clickAt(centre(button('Fit')));
    await settle(200);
    expect(ppb()).toBeLessThan(MIN_PX_PER_BAR);
    const sc = scroller();
    const r = regionEl('L').getBoundingClientRect();
    expect(r.right).toBeLessThanOrEqual(sc.getBoundingClientRect().right);
    expect(sc.scrollLeft).toBe(0);
  });
});

describe('playing', () => {
  it('when the song stops, the view comes back to the playhead', async () => {
    await open(96);
    const sc = scroller();
    const headW = document.querySelector<HTMLElement>('[data-part-head]')!.getBoundingClientRect().width;
    const from = Math.floor((sc.clientWidth - headW) / ppb()) - 1;
    await act(async () => {
      await session.playSong({ fromBar: from });
    });
    // The page turns as the playhead runs off to the right: where it started is out of sight.
    await waitFor(() => sc.scrollLeft > from * ppb(), 'a page turn', 15000);
    act(() => session.stop());
    await settle(300);
    expect(rt().songCursor).toBe(from);
    const x = lineX();
    expect(x).toBeGreaterThanOrEqual(sc.getBoundingClientRect().left + headW);
    expect(x).toBeLessThan(sc.getBoundingClientRect().right);
  });

  it('paused: the playhead is not amber, nothing is marked under it, and the header says Paused', async () => {
    await open(16);
    await act(async () => {
      await session.playSong({ fromBar: 10 });
    });
    await waitFor(() => !!document.querySelector('[data-region-id="B"][data-playing]'), 'the playing mark');
    expect(lineEl().hasAttribute('data-on')).toBe(true);
    await press(' ');
    expect(rt().paused).toBe(true);
    await settle(200);
    expect(lineEl().hasAttribute('data-on')).toBe(false);
    expect(timeline().hasAttribute('data-playing')).toBe(false);
    expect(document.querySelectorAll('[data-region-id][data-playing]').length).toBe(0);
    expect(document.querySelector('[data-testid="song-paused"]')?.textContent).toBe('Paused');
    await press(' ');
    await waitFor(() => lineEl().hasAttribute('data-on'), 'amber again');
    expect(document.querySelector('[data-testid="song-paused"]')).toBeNull();
  });

  it('Play starting at the loop, not at the playhead put outside it, says so once, with Loop off', async () => {
    await open(16);
    // Loop bars 9–12 (a drag on the ruler), then click bar 2 and Play.
    await dragTo({ x: barX(8) + 3, y: rulerY() }, { x: barX(12) + 3, y: rulerY() });
    expect(rt().songLoop).toEqual({ fromBar: 8, toBar: 12 });
    await clickAt({ x: barX(1) + 3, y: rulerY() });
    await press(' ');
    await waitFor(() => rt().playing && rt().mode === 'song', 'the song to play');
    const toast = () => [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((e) => /Looping bars 9–12/.test(e.textContent ?? ''));
    await waitFor(() => !!toast(), 'the loop toast');
    expect(toast()!.textContent).toContain('Play starts at the loop');
    const off = [...toast()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Loop off')!;
    await clickAt(centre(off));
    expect(rt().songLoop).toBeNull();
    expect((songPlayheadBar() ?? 0) >= 8).toBe(true);
  });
});

describe('names stay in sight', () => {
  it('a loop or section that starts left of the view shows its name at the view’s left edge', async () => {
    await open(32);
    const sc = scroller();
    sc.scrollLeft = 20 * ppb();
    await settle(150);
    const left = document.querySelector<HTMLElement>('[data-part-head]')!.getBoundingClientRect().right;
    const name = regionEl('D').querySelector<HTMLElement>('[class*="regionName"]')!.getBoundingClientRect();
    expect(name.left).toBeGreaterThanOrEqual(left - 1);
    expect(name.left).toBeLessThan(left + 12);
    const chorus = sectionEl('S2').querySelector<HTMLElement>('[class*="sectionName"]')!.getBoundingClientRect();
    expect(chorus.left).toBeGreaterThanOrEqual(left - 1);
    expect(chorus.left).toBeLessThan(left + 16);
  });
});

describe('hit areas', () => {
  it('the sections strip and the loop band are tall enough; a section’s end grip works with its ⋯ showing', async () => {
    await open(16);
    expect(sectionEl('S1').getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    await dragTo({ x: barX(8) + 3, y: rulerY() }, { x: barX(16) + 3, y: rulerY() });
    expect(document.querySelector<HTMLElement>('[data-range-band]')!.getBoundingClientRect().height).toBeGreaterThanOrEqual(14);
    // Hover the Verse: its ⋯ shows; the end grip (4 px from the end) still resizes it.
    await mouse('mouseMoved', centre(sectionEl('S1'), 0.5));
    await settle(80);
    expect(document.querySelector('[data-section-more]')).not.toBeNull();
    const r = sectionEl('S1').getBoundingClientRect();
    const grip = { x: r.right - 4, y: r.top + r.height / 2 };
    const hit = document.elementFromPoint(grip.x, grip.y);
    expect(hit?.closest('[data-section-edge="end"]')).not.toBeNull();
  });

  it('a narrow loop band shows its sign, never cut words; a narrow gap shows "+"; there is "+ Add section" after the song; a new section opens for its name', async () => {
    await open(8);
    // A one-bar loop at 8 px per bar.
    await dragTo({ x: barX(4) + 2, y: rulerY() }, { x: barX(5) + 2, y: rulerY() });
    const label = document.querySelector<HTMLElement>('[data-range-band] [class*="rangeLabel"]')!;
    const words = label.querySelector<HTMLElement>('span')!;
    expect(getComputedStyle(label).display === 'none' || getComputedStyle(words).display === 'none' || words.scrollWidth <= words.clientWidth + 1).toBe(true);
    // A 2-bar gap between Verse and Chorus at this scale: just "+".
    act(() => {
      const p = structuredClone(session.store.getState());
      p.arrangement.sections[1] = { ...p.arrangement.sections[1], start: 18, bars: 30 };
      session.store.replace(p, { resetHistory: true });
    });
    await settle();
    const gaps = [...document.querySelectorAll<HTMLElement>('[data-section-gap]')];
    const narrow = gaps.find((g) => g.getAttribute('aria-label') === 'Add a section over bars 17 to 18')!;
    expect(getComputedStyle(narrow.querySelector('[class*="addSectionText"]')!).display).toBe('none');
    // After the song's end (bar 65 on).
    const after = gaps.find((g) => g.hasAttribute('data-after-end'))!;
    expect(after.getAttribute('aria-label')).toBe('Add a section over bars 65 to 72');
    after.scrollIntoView({ inline: 'nearest' });
    await settle(80);
    await mouse('mouseMoved', centre(after));
    await clickAt(centre(after));
    await settle(80);
    expect(sections().some((s) => s.start === 64 && s.bars === 8)).toBe(true);
    // It opens for its name.
    const field = document.querySelector<HTMLInputElement>('input[aria-label^="Name of the section"]');
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    await press('Escape');
  });
});

describe('drags and menus', () => {
  it('a section drag says where it lands, and "+ Copy" with Alt', async () => {
    await open(16);
    const from = centre(sectionEl('S1'), 0.4);
    await dragTo(from, { x: from.x + 4 * ppb(), y: from.y }, { release: false });
    const badge = () => [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((e) => /Bar \d+$/.test(e.textContent ?? ''));
    expect(badge()?.textContent).toBe('Bar 5');
    await press('Escape');
    await dragTo(from, { x: from.x + 64 * ppb(), y: from.y }, { release: false, modifiers: 1 });
    expect(badge()?.textContent).toMatch(/^\+ Copy · Bar \d+$/);
    await press('Escape');
  });

  it('Name these bars as a section (a loop’s menu) opens the new section for its name', async () => {
    await open(16, (p) => {
      const drums = p.tracks[0];
      p.arrangement.regions = [region('D', drums.id, drums.clips.find((c) => c)!.id, 0, 8)];
      p.arrangement.sections = [];
    });
    await rightClickAt(on('D', 0.4));
    await clickAt(centre(menuItem('Name these bars as a section')));
    await settle(120);
    const field = document.querySelector<HTMLInputElement>('input[aria-label^="Name of the section"]');
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    await press('Escape');
    expect(sections().map((x) => [x.start, x.bars])).toEqual([[0, 8]]);
  });

  it('Use another loop: its chevron at the right end; the loop playing now is ticked, not greyed', async () => {
    await open(16);
    await rightClickAt(on('D', 0.3));
    const item = menuItem('Use another loop');
    const chevron = item.querySelector('[class*="itemChevron"]')!;
    expect(chevron.getBoundingClientRect().left).toBeGreaterThan(item.querySelector('[class*="itemText"]')!.getBoundingClientRect().right - 1);
    await clickAt(centre(item));
    const now = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((e) => e.getAttribute('aria-checked') === 'true')!;
    expect(now.getAttribute('aria-disabled')).toBeNull();
    expect(now.querySelector('svg')).not.toBeNull();
    expect(now.textContent).toContain('Playing');
    await press('Escape');
  });

  it('Back to Song after Edit notes: the loop is selected and has keyboard focus again, the view where it was', async () => {
    await open(32);
    scroller().scrollLeft = 4 * ppb();
    await settle(100);
    const left = scroller().scrollLeft;
    await doubleClickAt(on('B', 0.5));
    expect(uiStore.getState().view).toBe('play');
    const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Back to Song')!;
    await clickAt(centre(back));
    await waitFor(() => uiStore.getState().view === 'arrange' && !!document.querySelector('[data-region-id="B"]'), 'the Song view');
    await waitFor(() => document.activeElement === regionEl('B'), 'focus on the loop');
    expect(selectionStore.getState().ids).toEqual(['B']);
    expect(Math.abs(scroller().scrollLeft - left)).toBeLessThan(2);
  });
});

describe('the header', () => {
  it('Shape the song… adds an intro before the song (and is unavailable, with the reason, while the song is empty)', async () => {
    await open(16);
    await clickAt(centre(button('Shape the song…')));
    await clickAt(centre(menuItem('Add an intro')));
    const intro = sections().find((s) => s.name === 'Intro')!;
    expect(intro.start).toBe(0);
    expect(regions().find((r) => r.id === 'D')!.start).toBe(intro.bars);
    // An ending after the song.
    await clickAt(centre(button('Shape the song…')));
    await clickAt(centre(menuItem('Add an ending')));
    expect(sections().some((s) => s.name === 'Ending')).toBe(true);
  });

  it('in an empty song, Shape the song… says why it cannot', async () => {
    await open(16, (p) => {
      p.arrangement.regions = [];
      p.arrangement.sections = [];
    });
    await clickAt(centre(button('Shape the song…')));
    const item = menuItem('Add an intro');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain('Put some loops in the song first');
    await press('Escape');
  });

  it('Add loops (not "Loops") opens the browser; its loops say "2 bars"; part names keep their whole name in a tooltip', async () => {
    await open(16);
    const toggle = document.querySelector<HTMLElement>('[data-testid="loops-toggle"]')!;
    expect(toggle.textContent?.trim()).toBe('Add loops');
    expect(toggle.querySelector('svg')).not.toBeNull();
    if (toggle.getAttribute('aria-pressed') !== 'true') await clickAt(centre(toggle));
    const bars = [...document.querySelectorAll<HTMLElement>('[data-chip] [class*="chipBars"]')].map((e) => e.textContent);
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) expect(b).toMatch(/^\d+ bars?$/);
    for (const t of project().tracks) {
      const head = document.querySelector<HTMLElement>(`[data-lane-row="${t.id}"] [data-part-head]`)!;
      expect(head.querySelector(`[title="${t.name}"]`)).not.toBeNull();
    }
  });
});
