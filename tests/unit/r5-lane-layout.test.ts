/**
 * Song view geometry: bars and pixels line up on every row at every zoom,
 * clicks and drags land on whole bars, Fit shows the whole song, zooming
 * keeps the bar under the pointer, the playhead turns pages, and rows share
 * the height within their limits.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PX_PER_BAR,
  END_ROOM_BARS,
  MAX_PX_PER_BAR,
  MIN_PX_PER_BAR,
  ROW_MAX_PX,
  ROW_MIN_PX,
  ZOOM_STEPS,
  barAt,
  barToX,
  edgeAt,
  fitZoom,
  followScroll,
  gridStep,
  labelStep,
  rowAt,
  rowHeight,
  rulerBarAt,
  rulerMarks,
  snapBar,
  timelineBars,
  xToBar,
  zoomIndex,
  zoomScroll,
  zoomStep,
} from '../../src/app/views/arrange/songLayout';
import { MAX_SONG_BARS } from '../../src/project/types';

describe('bars and pixels', () => {
  it('maps bars to the same x on every row, at every zoom', () => {
    for (const ppb of ZOOM_STEPS) {
      expect(barToX(9, ppb)).toBe(9 * ppb);
      expect(xToBar(barToX(9, ppb), ppb)).toBe(9);
    }
  });

  it('snaps an edge or a moved region to the nearest bar line, never before bar 1', () => {
    expect(snapBar(3 * 32 + 15, 32)).toBe(3);
    expect(snapBar(3 * 32 + 17, 32)).toBe(4);
    expect(snapBar(-40, 32)).toBe(0);
  });

  it('a click or a drop lands in the bar under the pointer', () => {
    expect(barAt(0, 16)).toBe(0);
    expect(barAt(16 * 4 + 15.9, 16)).toBe(4);
    expect(barAt(-5, 16)).toBe(0);
    expect(barAt(1e9, 16)).toBe(MAX_SONG_BARS - 1);
  });

  it('a click on the ruler a hair left of a bar line means that bar (its number sits right of the line)', () => {
    expect(rulerBarAt(8 * 32 - 3, 32)).toBe(8);
    expect(rulerBarAt(8 * 32 - 12, 32)).toBe(7);
    expect(rulerBarAt(8 * 32 + 20, 32)).toBe(8);
    // At a small zoom the slack is a quarter of a bar.
    expect(rulerBarAt(8 * 4 - 0.9, 4)).toBe(8);
    expect(rulerBarAt(8 * 4 - 1.1, 4)).toBe(7);
  });

  it('keeps room after the song and fills the view', () => {
    expect(timelineBars(32, 10)).toBe(32 + END_ROOM_BARS);
    expect(timelineBars(4, 80.2)).toBe(81);
    expect(timelineBars(MAX_SONG_BARS, 10)).toBe(MAX_SONG_BARS);
  });
});

describe('zoom', () => {
  it('Fit shows the whole song (with a bar either side) at the largest step that does', () => {
    const ppb = fitZoom(64, 900);
    expect(ZOOM_STEPS).toContain(ppb);
    expect((64 + 2) * ppb).toBeLessThanOrEqual(900);
    const next = zoomStep(ppb, 1);
    expect(next === null || (64 + 2) * next > 900).toBe(true);
    expect(fitZoom(0, 900)).toBe(DEFAULT_PX_PER_BAR);
    expect(fitZoom(MAX_SONG_BARS, 300)).toBe(MIN_PX_PER_BAR);
  });

  it('steps along the ladder and stops at its ends', () => {
    expect(zoomStep(32, 1)).toBe(40);
    expect(zoomStep(32, -1)).toBe(24);
    expect(zoomStep(33, -1)).toBe(32);
    expect(zoomStep(32, 1, 2)).toBe(48);
    expect(zoomStep(MAX_PX_PER_BAR, 1)).toBeNull();
    expect(zoomStep(MIN_PX_PER_BAR, -1)).toBeNull();
    expect(ZOOM_STEPS[zoomIndex(31)]).toBe(32);
  });

  it('keeps the bar under the pointer where it is', () => {
    const scroll = 500;
    const pointer = 300;
    const bar = xToBar(scroll + pointer, 20);
    const next = zoomScroll(scroll, pointer, 20, 48);
    expect(xToBar(next + pointer, 48)).toBeCloseTo(bar, 9);
    // Never scrolls before the start.
    expect(zoomScroll(0, 300, 48, 4)).toBe(0);
  });
});

describe('ruler', () => {
  it('numbers bars at a readable spacing, every bar line where they are far enough apart', () => {
    expect(labelStep(48)).toBe(1);
    expect(labelStep(40)).toBe(2);
    expect(labelStep(16)).toBe(4);
    expect(labelStep(4)).toBe(16);
    expect(gridStep(4)).toBe(2);
    expect(gridStep(8)).toBe(1);
    const marks = rulerMarks(16, 0, 16);
    expect(marks.map((m) => m.bar)).toEqual([...Array(17).keys()]);
    expect(marks.filter((m) => m.label).map((m) => m.bar + 1)).toEqual([1, 5, 9, 13, 17]);
    for (const m of marks) expect(m.x).toBe(m.bar * 16);
  });
});

describe('following the playhead', () => {
  it('turns a page when the playhead reaches the right edge, and comes back when it is left of the view', () => {
    expect(followScroll(400, 0, 800, 4000)).toBeNull();
    const to = followScroll(795, 0, 800, 4000)!;
    expect(to).toBeGreaterThan(700);
    expect(795 - to).toBeLessThan(60);
    expect(followScroll(100, 2000, 800, 4000)).toBeLessThan(100);
    // Never past the end of the content.
    expect(followScroll(3990, 0, 800, 4000)).toBe(3200);
  });
});

describe('rows and edges', () => {
  it('rows share the free height within their limits', () => {
    expect(rowHeight(400, 8)).toBe(50);
    expect(rowHeight(100, 8)).toBe(ROW_MIN_PX);
    expect(rowHeight(2000, 4)).toBe(ROW_MAX_PX);
    expect(rowAt(-1, 40)).toBe(-1);
    expect(rowAt(79, 40)).toBe(1);
  });

  it('an 8 px grip at each end of a region, narrower on a short one so its middle still moves it', () => {
    expect(edgeAt(2, 128)).toBe('start');
    expect(edgeAt(124, 128)).toBe('end');
    expect(edgeAt(60, 128)).toBeNull();
    expect(edgeAt(8, 16)).toBeNull();
    expect(edgeAt(14, 16)).toBe('end');
  });
});
