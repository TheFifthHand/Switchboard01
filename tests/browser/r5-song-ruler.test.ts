/**
 * The ruler, the playhead and playing the song, in real Chromium with the
 * real transport: a click on the ruler moves the song cursor (and the
 * playhead line), and jumps there while the song plays; a drag along the
 * ruler sets the loop range and loops it, a click on the band switches it,
 * the Loop key loops the selection; Play and Space play the song from the
 * playhead; Follow turns the page; zoom keeps the bar under the pointer; the
 * wheel scrolls the song sideways.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { songPlayheadBar } from '../../src/app/views/arrange/songApi';
import type { Project } from '../../src/project/types';
import {
  barX,
  centre,
  clickAt,
  dragTo,
  on,
  openSong,
  ppb,
  press,
  project,
  region,
  resetSong,
  rt,
  scroller,
  settle,
  teardownSong,
  timeline,
  waitFor,
  wheelAt,
} from './r5-song-helpers';

/** A 64-bar song: Drums over bars 1–64, Bass over 9–40. */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  p.arrangement.regions = [region('D', drums.id, drums.clips.find((c) => c)!.id, 0, 64), region('B', bass.id, bass.clips.find((c) => c)!.id, 8, 32)];
  p.arrangement.sections = [{ id: 'S1', name: 'Verse', start: 0, bars: 16 }];
}

const rulerY = () => {
  const r = document.querySelector('[data-ruler]')!.getBoundingClientRect();
  return r.top + r.height - 8;
};
const lineX = () => {
  const el = document.querySelector<HTMLElement>('[class*="playhead"][aria-hidden]')!;
  return el.getBoundingClientRect().left + 1;
};

async function open(scale = 16): Promise<void> {
  await openSong(1366, 768, song);
  act(() => ppbStore.setState(scale));
  await settle();
}

beforeEach(resetSong);
afterEach(teardownSong);

describe('the ruler', () => {
  it('a click moves the song cursor there, and the line with it', async () => {
    await open();
    await clickAt({ x: barX(12) + 4, y: rulerY() });
    expect(rt().songCursor).toBe(12);
    expect(Math.abs(lineX() - barX(12))).toBeLessThanOrEqual(2);
  });

  it('while the song plays a click jumps there; Stop leaves the playhead where it was last put', async () => {
    await open();
    await clickAt({ x: barX(2) + 4, y: rulerY() });
    await act(async () => {
      await (session as unknown as { playSong(o?: object): Promise<void> }).playSong();
    });
    await waitFor(() => (songPlayheadBar() ?? -1) >= 2, 'the song to play');
    await clickAt({ x: barX(30) + 4, y: rulerY() });
    await waitFor(() => (songPlayheadBar() ?? 0) >= 30, 'the jump to bar 31');
    expect(songPlayheadBar()!).toBeLessThan(32);
    act(() => session.stop());
    await settle();
    expect(rt().songCursor).toBe(30);
  });

  it('a drag along it sets the loop range and loops it; a click on the band switches it off and on', async () => {
    await open();
    await dragTo({ x: barX(4) + 3, y: rulerY() }, { x: barX(8) + 3, y: rulerY() });
    expect(rt().songLoop).toEqual({ fromBar: 4, toBar: 8 });
    const band = document.querySelector<HTMLElement>('[data-range-band]')!;
    expect(band.hasAttribute('data-on')).toBe(true);
    await clickAt(centre(band));
    expect(rt().songLoop).toBeNull();
    expect(document.querySelector('[data-range-band]')).toBeTruthy();
    await clickAt(centre(document.querySelector<HTMLElement>('[data-range-band]')!));
    expect(rt().songLoop).toEqual({ fromBar: 4, toBar: 8 });
  });

  it('the band’s ends drag to other bar lines', async () => {
    await open();
    await dragTo({ x: barX(4) + 3, y: rulerY() }, { x: barX(8) + 3, y: rulerY() });
    const end = document.querySelector<HTMLElement>('[data-range-edge="end"]')!;
    await dragTo(centre(end), { x: barX(12), y: centre(end).y });
    expect(rt().songLoop).toEqual({ fromBar: 4, toBar: 12 });
  });

  it('the Loop key with nothing set loops the selected loop’s bars; again stops looping', async () => {
    await open();
    await clickAt(on('B'));
    const key = document.querySelector<HTMLElement>('[data-testid="loop-toggle"]')!;
    await clickAt(centre(key));
    expect(rt().songLoop).toEqual({ fromBar: 8, toBar: 40 });
    expect(key.getAttribute('aria-pressed')).toBe('true');
    await clickAt(centre(key));
    expect(rt().songLoop).toBeNull();
  });
});

describe('playing', () => {
  it('Space in the Song view plays the song from the playhead, and pauses it', async () => {
    await open();
    await clickAt({ x: barX(16) + 4, y: rulerY() });
    await press(' ');
    await waitFor(() => rt().playing && rt().mode === 'song', 'the song to play');
    await waitFor(() => (songPlayheadBar() ?? 0) >= 16, 'the playhead at bar 17');
    expect(timeline().hasAttribute('data-playing')).toBe(true);
    await press(' ');
    expect(rt().paused).toBe(true);
  });

  it('the loop under the playhead gets an amber edge while the song plays', async () => {
    await open();
    await act(async () => {
      await (session as unknown as { playSong(o?: object): Promise<void> }).playSong({ fromBar: 10 });
    });
    await waitFor(() => !!document.querySelector('[data-region-id="B"][data-playing]'), 'the playing mark');
    expect(document.querySelector('[data-region-id="D"]')!.hasAttribute('data-playing')).toBe(true);
  });

  it('Follow turns the page when the playhead reaches the right edge', async () => {
    await open(48);
    const sc = scroller();
    const viewBars = (sc.clientWidth - 168) / ppb();
    expect(sc.scrollLeft).toBe(0);
    await act(async () => {
      await (session as unknown as { playSong(o?: object): Promise<void> }).playSong({ fromBar: Math.floor(viewBars) - 1 });
    });
    await waitFor(() => sc.scrollLeft > 0, 'a page turn', 12000);
    const head = (songPlayheadBar() ?? 0) * ppb();
    expect(head).toBeGreaterThanOrEqual(sc.scrollLeft);
    expect(head).toBeLessThan(sc.scrollLeft + sc.clientWidth);
  });
});

describe('zoom and scroll', () => {
  it('Ctrl+wheel zooms around the pointer: the bar under it stays put', async () => {
    await open(16);
    const x = barX(20) + 0.5 * ppb();
    const y = rulerY() + 60;
    const before = ppb();
    await wheelAt({ x, y }, -120, 2);
    expect(ppb()).toBeGreaterThan(before);
    const bar = (x - (barX(0))) / ppb();
    expect(Math.abs(bar - 20.5)).toBeLessThan(0.6);
  });

  it('− and + step the zoom; Fit shows the whole song', async () => {
    await open(16);
    await clickAt(centre(document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!));
    expect(ppb()).toBe(20);
    await clickAt(centre(document.querySelector<HTMLElement>('[aria-label="Zoom out"]')!));
    expect(ppb()).toBe(16);
    await clickAt(centre(document.querySelector<HTMLElement>('[data-testid="zoom-fit"]')!));
    const sc = scroller();
    expect(66 * ppb()).toBeLessThanOrEqual(sc.clientWidth - 168);
  });

  it('a plain wheel scrolls the song sideways', async () => {
    await open(48);
    const sc = scroller();
    await wheelAt({ x: barX(4), y: rulerY() + 80 }, 200);
    expect(sc.scrollLeft).toBeGreaterThan(100);
    expect(window.scrollY).toBe(0);
  });

  it('the zoom is remembered for the project', async () => {
    await open(16);
    await clickAt(centre(document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!));
    const id = project().id;
    const stored = JSON.parse(localStorage.getItem('switchboard01.songLane') ?? '{}') as { zoom?: Record<string, number> };
    expect(stored.zoom?.[id]).toBe(20);
  });
});
