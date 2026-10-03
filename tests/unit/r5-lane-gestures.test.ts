/**
 * The Song view's drag, selection, loop and key rules. The drag preview is
 * the song the drop makes: it is worked out with the same timeline rules as
 * the commands (project/arrangement.ts), so "carve preview equals result" is
 * checked here against those rules directly; the view's browser tests check
 * it against the real commands.
 */
import { describe, expect, it } from 'vitest';
import {
  barsMoved,
  copyKey,
  diffRegions,
  loopDrop,
  offRow,
  previewMove,
  previewPlace,
  previewResize,
  previewSectionMove,
  previewSectionResize,
  rangeEdgeDrag,
  rangeFromDrag,
  sceneDrop,
  touches,
} from '../../src/app/views/arrange/laneGestures';
import { EMPTY_SELECTION, clickSelect, marqueeSelect, neighbour, pressSelect, pruneSelection, regionsInBox, selectAll, selectionSpan } from '../../src/app/views/arrange/laneSelection';
import { loopKeyRange, playStartBar, rangeWords, sameRange } from '../../src/app/views/arrange/laneLoop';
import { laneKey } from '../../src/app/views/arrange/laneKeys';
import * as A from '../../src/project/arrangement';
import { createClip, createProject } from '../../src/project/factory';
import type { Project, SongRegion } from '../../src/project/types';

const D = 't1';
const B = 't3';

function project(): Project {
  const p = createProject();
  p.tracks[0].clips[0] = { ...createClip('Beat', 2), id: 'c-beat' };
  p.tracks[0].clips[1] = { ...createClip('Fill', 1), id: 'c-fill' };
  p.tracks[2].clips[0] = { ...createClip('Bassline', 4), id: 'c-bass' };
  return p;
}

const r = (id: string, trackId: string, clipId: string, start: number, bars: number, offset = 0): SongRegion => ({ id, trackId, clipId, start, bars, offset });
const short = (list: readonly SongRegion[]) => list.map((x) => `${x.id}@${x.start}+${x.bars}~${x.offset}`);
/** The same, with the ids an edit made up (a carve's second piece, a copy) left out: they differ between runs. */
const shape = (list: readonly SongRegion[]) => short(list).map((s) => s.replace(/^(n\d+|preview:\d+|carve:\d+)@/, '*@'));
function ids() {
  let n = 0;
  return () => `n${++n}`;
}

describe('dragging regions', () => {
  const p = project();
  const song = [r('a', D, 'c-beat', 0, 8), r('b', D, 'c-fill', 8, 2), r('c', B, 'c-bass', 0, 16)];

  it('moves in whole bars from the pointer’s travel', () => {
    expect(barsMoved(47, 32)).toBe(1);
    expect(barsMoved(49, 32)).toBe(2);
    expect(barsMoved(-15, 32)).toBe(-0);
    expect(copyKey({ altKey: true, ctrlKey: false, metaKey: false })).toBe(true);
    expect(copyKey({ altKey: false, ctrlKey: false, metaKey: true })).toBe(true);
  });

  it('the move preview is the song the move makes: it carves what it lands on', () => {
    const pv = previewMove(p, song, ['b'], -3, false);
    const real = A.moveRegions(p, song, ['b'], -3, { newId: ids() });
    expect(shape(pv.regions)).toEqual(shape(real.regions));
    // The fill lands at bar 6 inside the beat, which is split around it (its second piece one bar into its clip).
    expect(pv.hidden.sort()).toEqual(['a', 'b']);
    expect(shape(pv.shown)).toEqual(['a@0+5~0', 'b@5+2~0', '*@7+1~1']);
    expect(pv).toMatchObject({ trimmed: 1, removed: 0, delta: -3 });
  });

  it('a copy keeps the original and lands a new region', () => {
    const pv = previewMove(p, song, ['b'], 4, true);
    expect(pv.hidden).toEqual([]);
    expect(pv.shown).toHaveLength(1);
    expect(pv.moved[0]).toMatchObject({ trackId: D, clipId: 'c-fill', start: 12, bars: 2 });
    expect(pv.moved[0].id).not.toBe('b');
  });

  it('stops at the song’s start', () => {
    const pv = previewMove(p, song, ['b'], -20, false);
    expect(pv.delta).toBe(-8);
    expect(pv.moved[0].start).toBe(0);
  });

  it('several selected regions move together, on their own rows', () => {
    const pv = previewMove(p, song, ['a', 'c'], 2, false);
    expect(pv.moved.map((m) => [m.id, m.trackId, m.start])).toEqual([
      ['a', D, 2],
      ['c', B, 2],
    ]);
  });

  it('the right edge lengthens (the clip repeats to fill it) and carves the next region', () => {
    const pv = previewResize(p, song, ['a'], 'end', 1);
    const real = A.resizeRegions(p, song, ['a'], 'end', 1, ids());
    expect(shape(pv.regions)).toEqual(shape(real.regions));
    expect(short(pv.moved)).toEqual(['a@0+9~0']);
    expect(pv.delta).toBe(1);
  });

  it('the left edge trims the start; the music stays where it was in time', () => {
    const pv = previewResize(p, song, ['c'], 'start', 3);
    expect(short(pv.moved)).toEqual(['c@3+13~3']);
    expect(pv.delta).toBe(3);
    // Never under one bar.
    expect(previewResize(p, song, ['b'], 'end', -5).moved[0].bars).toBe(1);
    expect(previewResize(p, song, ['b'], 'end', -5).delta).toBe(-1);
  });

  it('no travel, no change', () => {
    const pv = previewMove(p, song, ['a'], 0, false);
    expect(pv.hidden).toEqual([]);
    expect(pv.shown).toEqual([]);
    expect(pv.moved.map((m) => m.id)).toEqual(['a']);
  });

  it('flashes where a dragged edge newly meets a neighbour’s', () => {
    const apart = [r('a', D, 'c-beat', 0, 4), r('b', D, 'c-fill', 6, 2)];
    const pv = previewResize(p, apart, ['a'], 'end', 2);
    expect(pv.touches).toEqual([{ trackId: D, bar: 6 }]);
    // Already touching before the drag: nothing new.
    expect(previewMove(p, song, ['c'], 0, false).touches).toEqual([]);
    expect(touches(song, ['a'])).toEqual([{ trackId: D, bar: 8 }]);
    expect(touches(song, ['a'], 'start')).toEqual([]);
  });

  it('diffs two songs', () => {
    const after = [song[0], { ...song[1], start: 9 }];
    expect(diffRegions(song, after)).toEqual({ hidden: ['b', 'c'], shown: [{ ...song[1], start: 9 }] });
  });

  it('leaving the row by more than a row’s height shows “not allowed”', () => {
    expect(offRow(100 + 40, 100, 48)).toBe(false);
    expect(offRow(100 - 49, 100, 48)).toBe(true);
    expect(offRow(100 + 2 * 48 + 1, 100, 48)).toBe(true);
  });
});

describe('drops from the loop browser', () => {
  const p = project();
  it('a scene card adds a region for each part with a clip in that row, carving what is there', () => {
    const song = [r('x', B, 'c-bass', 0, 16)];
    const placed = sceneDrop(p, 0, 4);
    expect(placed.map((x) => [x.trackId, x.start, x.bars])).toEqual([
      [D, 4, 4],
      [B, 4, 4],
    ]);
    const pv = previewPlace(p, song, placed);
    expect(short(pv.regions.filter((x) => x.trackId === B)).map((s) => s.replace(/^[^@]+/, ''))).toEqual(['@0+4~0', '@4+4~0', '@8+8~0']);
    expect(pv.hidden).toEqual(['x']);
  });

  it('a part’s loop adds one region of its clip’s length', () => {
    expect(loopDrop(p, B, 'c-bass', 6.7)).toEqual([{ id: 'drop:1', trackId: B, clipId: 'c-bass', start: 7, bars: 4, offset: 0 }]);
  });
});

describe('sections', () => {
  const p = project();
  const song = [r('a', D, 'c-beat', 0, 8), r('b', D, 'c-fill', 8, 2), r('c', B, 'c-bass', 8, 8)];
  const secs = [
    { id: 's1', name: 'Intro', start: 0, bars: 8 },
    { id: 's2', name: 'Drop', start: 8, bars: 8 },
  ];

  it('moving a section moves the loops that start in it', () => {
    const pv = previewSectionMove(p, song, secs, 's2', 4, false);
    expect(pv.section).toMatchObject({ id: 's2', start: 12 });
    expect(pv.regions.moved.map((m) => [m.id, m.start])).toEqual([
      ['b', 12],
      ['c', 12],
    ]);
    expect(pv.sections.map((s) => [s.id, s.start, s.bars])).toEqual([
      ['s1', 0, 8],
      ['s2', 12, 8],
    ]);
  });

  it('resizing a section is a label change only', () => {
    const pv = previewSectionResize(secs, 's1', 'end', 2);
    expect(pv.sections.map((s) => [s.id, s.start, s.bars])).toEqual([
      ['s1', 0, 10],
      ['s2', 10, 6],
    ]);
    expect(previewSectionResize(secs, 's1', 'end', -20).section?.bars).toBe(1);
  });
});

describe('the loop range', () => {
  it('a ruler drag puts both ends on the nearest bar lines, at least one bar', () => {
    expect(rangeFromDrag(4.2, 8.3)).toEqual({ fromBar: 4, toBar: 8 });
    expect(rangeFromDrag(8.3, 4.2)).toEqual({ fromBar: 4, toBar: 8 });
    expect(rangeFromDrag(4.2, 4.3)).toEqual({ fromBar: 4, toBar: 5 });
    expect(rangeEdgeDrag({ fromBar: 4, toBar: 8 }, 'end', 12.4)).toEqual({ fromBar: 4, toBar: 12 });
    expect(rangeEdgeDrag({ fromBar: 4, toBar: 8 }, 'start', 9)).toEqual({ fromBar: 7, toBar: 8 });
    expect(rangeWords({ fromBar: 8, toBar: 16 })).toBe('Bars 9–16');
    expect(sameRange({ fromBar: 1, toBar: 2 }, { fromBar: 1, toBar: 2 })).toBe(true);
    expect(sameRange(null, null)).toBe(true);
  });

  it('the Loop key with no range: the selection, else the section at the cursor, else the whole song', () => {
    const sections = [{ id: 's', name: 'Drop', start: 8, bars: 8 }];
    expect(loopKeyRange({ selection: [2, 6], sections, cursorBar: 9, songBars: 32 })).toEqual({ fromBar: 2, toBar: 6 });
    expect(loopKeyRange({ selection: null, sections, cursorBar: 9, songBars: 32 })).toEqual({ fromBar: 8, toBar: 16 });
    expect(loopKeyRange({ selection: null, sections, cursorBar: 2, songBars: 32 })).toEqual({ fromBar: 0, toBar: 32 });
    expect(loopKeyRange({ selection: null, sections: [], cursorBar: 0, songBars: 0 })).toBeNull();
  });

  it('Play starts inside the loop', () => {
    expect(playStartBar(10, { fromBar: 8, toBar: 16 })).toBe(10);
    expect(playStartBar(2, { fromBar: 8, toBar: 16 })).toBe(8);
    expect(playStartBar(2, null)).toBe(2);
  });
});

describe('selection', () => {
  const song = [r('a', D, 'c-beat', 0, 8), r('b', D, 'c-fill', 8, 2), r('c', B, 'c-bass', 0, 16), r('d', B, 'c-bass', 16, 4)];
  const order = ['t1', 't2', 't3'];

  it('click, Shift/Ctrl-click, and pressing a selected region keeps the group', () => {
    let s = clickSelect(EMPTY_SELECTION, 'a', 'replace');
    expect(s.ids).toEqual(['a']);
    s = clickSelect(s, 'c', 'toggle');
    expect(s.ids).toEqual(['a', 'c']);
    expect(pressSelect(s, 'a', 'replace').ids).toEqual(['a', 'c']);
    expect(pressSelect(s, 'b', 'replace').ids).toEqual(['b']);
    expect(clickSelect(s, 'a', 'toggle').ids).toEqual(['c']);
    expect(selectionSpan(song, ['b', 'c'])).toEqual([0, 16]);
  });

  it('a marquee selects what it touches, added with Shift', () => {
    const rowOf = (t: string) => order.indexOf(t);
    const hits = regionsInBox(song, rowOf, { bar0: 7.5, bar1: 9, row0: 0, row1: 0 });
    expect(hits).toEqual(['a', 'b']);
    expect(regionsInBox(song, rowOf, { bar0: 15.5, bar1: 15.9, row0: 0, row1: 2 })).toEqual(['c']);
    const s = marqueeSelect({ ids: ['d'], focus: 'd' }, hits, true);
    expect(s.ids).toEqual(['d', 'a', 'b']);
    expect(marqueeSelect({ ids: ['d'], focus: 'd' }, [], false)).toEqual(EMPTY_SELECTION);
    expect(selectAll(song).ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('forgets regions that are gone', () => {
    const s = pruneSelection({ ids: ['a', 'x'], focus: 'x' }, new Set(['a', 'b']));
    expect(s).toEqual({ ids: ['a'], focus: 'a' });
    const same = { ids: ['a'], focus: 'a' };
    expect(pruneSelection(same, new Set(['a']))).toBe(same);
  });

  it('the keyboard moves to the part above or below (nearest in time) and along a part', () => {
    expect(neighbour(song, order, 'b', 'down')).toBe('c');
    expect(neighbour(song, order, 'd', 'up')).toBe('b');
    expect(neighbour(song, order, 'a', 'up')).toBeNull();
    expect(neighbour(song, order, 'a', 'next')).toBe('b');
    expect(neighbour(song, order, 'b', 'next')).toBeNull();
    expect(neighbour(song, order, 'd', 'prev')).toBe('c');
    // Nothing focused yet: the first region still sounding at the playhead.
    expect(neighbour(song, order, null, 'next', 9)).toBe('c');
    expect(neighbour(song, order, null, 'next', 17)).toBe('d');
  });
});

describe('keys', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}, mac = false) =>
    laneKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }, mac);

  it('maps the Song shortcuts', () => {
    expect(k('Delete')).toEqual({ kind: 'delete' });
    expect(k('Backspace')).toEqual({ kind: 'delete' });
    expect(k('c', { ctrlKey: true })).toEqual({ kind: 'copy' });
    expect(k('C', { ctrlKey: true })).toEqual({ kind: 'copy' });
    expect(k('v', { metaKey: true }, true)).toEqual({ kind: 'paste' });
    expect(k('v', { ctrlKey: true }, true)).toBeNull();
    expect(k('d', { ctrlKey: true })).toEqual({ kind: 'duplicate' });
    expect(k('e', { ctrlKey: true })).toEqual({ kind: 'split' });
    expect(k('t', { ctrlKey: true })).toEqual({ kind: 'split' });
    expect(k('ArrowRight')).toEqual({ kind: 'move', bars: 1 });
    expect(k('ArrowLeft', { shiftKey: true })).toEqual({ kind: 'move', bars: -4 });
    expect(k('ArrowRight', { altKey: true })).toEqual({ kind: 'length', bars: 1 });
    expect(k('ArrowLeft', { altKey: true, shiftKey: true })).toEqual({ kind: 'length', bars: -4 });
    expect(k('ArrowDown')).toEqual({ kind: 'focus', dir: 'down', extend: false });
    expect(k('ArrowRight', { ctrlKey: true })).toEqual({ kind: 'focus', dir: 'next', extend: false });
    expect(k('Enter')).toEqual({ kind: 'home' });
    expect(k('Home')).toEqual({ kind: 'home' });
    expect(k('F10', { shiftKey: true })).toEqual({ kind: 'menu' });
    expect(k('Escape')).toEqual({ kind: 'escape' });
  });

  it('leaves playing keys and the app’s own keys alone', () => {
    for (const key of ['a', 's', 'w', ' ', 'm', '?', '[', ']']) expect(k(key), key).toBeNull();
    expect(k('z', { ctrlKey: true })).toBeNull();
    expect(k('z', { ctrlKey: true, shiftKey: true })).toBeNull();
  });
});
