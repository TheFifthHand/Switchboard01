/**
 * The song timeline's rules (project/arrangement.ts): placing, moving,
 * stretching, trimming, splitting and copying regions, inserting and
 * removing bars, sections, and tidying damaged data. These rules are shared
 * by the Song view's drag preview, the commands and playback, so what the
 * lane shows is what plays.
 */
import { describe, expect, it } from 'vitest';
import * as A from '../../src/project/arrangement';
import { createClip, createProject } from '../../src/project/factory';
import { MAX_SONG_BARS, type Project, type SongRegion, type SongSection } from '../../src/project/types';

/** A project whose Drums have a 2-bar clip (row 0) and a 1-bar clip (row 1), and Bass a 4-bar clip (row 0). */
function project(): Project {
  const p = createProject();
  p.tracks[0].clips[0] = { ...createClip('Beat', 2), id: 'c-beat' };
  p.tracks[0].clips[1] = { ...createClip('Fill', 1), id: 'c-fill' };
  p.tracks[2].clips[0] = { ...createClip('Bassline', 4), id: 'c-bass' };
  return p;
}

const D = 't1';
const B = 't3';

function ids() {
  let n = 0;
  return () => `new${++n}`;
}

const r = (id: string, trackId: string, clipId: string, start: number, bars: number, offset = 0): SongRegion => ({ id, trackId, clipId, start, bars, offset });
/** Short form for comparing: id@start+bars~offset. */
const short = (list: readonly SongRegion[], trackId?: string) => list.filter((x) => !trackId || x.trackId === trackId).map((x) => `${x.id}@${x.start}+${x.bars}~${x.offset}`);

describe('placing a region carves what it lands on (the placed region wins)', () => {
  const p = project();
  const base = [r('a', D, 'c-beat', 0, 8)];

  it('cuts short a region it covers the end of', () => {
    const res = A.placeRegions(p, base, [r('f', D, 'c-fill', 6, 4)], { newId: ids() });
    expect(short(res.regions, D)).toEqual(['a@0+6~0', 'f@6+4~0']);
    expect(res).toMatchObject({ trimmed: 1, removed: 0 });
  });

  it('starts a region later, in phase with its clip, when it covers its start', () => {
    const res = A.placeRegions(p, [r('a', D, 'c-beat', 4, 8)], [r('f', D, 'c-fill', 3, 2)], { newId: ids() });
    // The beat region now starts at bar 5, one bar into its 2-bar clip: the music stays where it was.
    expect(short(res.regions, D)).toEqual(['f@3+2~0', 'a@5+7~1']);
  });

  it('splits a region it lands inside', () => {
    const res = A.placeRegions(p, base, [r('f', D, 'c-fill', 3, 1)], { newId: ids() });
    expect(short(res.regions, D)).toEqual(['a@0+3~0', 'f@3+1~0', 'new1@4+4~0']);
    expect(res.trimmed).toBe(1);
  });

  it('removes a region it covers completely', () => {
    const res = A.placeRegions(p, [r('a', D, 'c-fill', 2, 2)], [r('b', D, 'c-beat', 0, 8)], { newId: ids() });
    expect(short(res.regions, D)).toEqual(['b@0+8~0']);
    expect(res).toMatchObject({ trimmed: 0, removed: 1 });
  });

  it('never touches another part', () => {
    const res = A.placeRegions(p, [r('bass', B, 'c-bass', 0, 8)], [r('f', D, 'c-fill', 0, 8)], { newId: ids() });
    expect(short(res.regions, B)).toEqual(['bass@0+8~0']);
  });
});

describe('moving regions', () => {
  const p = project();
  const base = [r('a', D, 'c-beat', 0, 4), r('b', D, 'c-fill', 4, 2), r('bass', B, 'c-bass', 0, 8)];

  it('slides along the row and carves what it lands on', () => {
    const res = A.moveRegions(p, base, ['a'], 3, { newId: ids() });
    expect(short(res.regions, D)).toEqual(['a@3+4~0']);
    expect(res.removed).toBe(1);
    expect(short(res.moved)).toEqual(['a@3+4~0']);
  });

  it('copies with new ids and leaves the originals', () => {
    const res = A.moveRegions(p, base, ['a', 'bass'], 8, { copy: true, newId: ids() });
    expect(short(res.regions, D)).toEqual(['a@0+4~0', 'b@4+2~0', 'new1@8+4~0']);
    expect(short(res.regions, B)).toEqual(['bass@0+8~0', 'new2@8+8~0']);
  });

  it('keeps the selection inside the song (never before bar 1 or past the end)', () => {
    expect(A.clampMove(base, ['b'], -10)).toBe(-4);
    expect(A.clampMove(base, ['bass'], MAX_SONG_BARS)).toBe(MAX_SONG_BARS - 8);
  });

  it('duplicates right after the selection', () => {
    const res = A.duplicateRegions(p, base, ['a', 'b'], ids());
    expect(short(res.regions, D)).toEqual(['a@0+4~0', 'b@4+2~0', 'new1@6+4~0', 'new2@10+2~0']);
  });
});

describe('resizing regions', () => {
  const p = project();

  it('the end edge makes the clip repeat longer, carving the neighbour', () => {
    const res = A.resizeRegions(p, [r('a', D, 'c-beat', 0, 2), r('b', D, 'c-fill', 4, 4)], ['a'], 'end', 4, ids());
    expect(short(res.regions, D)).toEqual(['a@0+6~0', 'b@6+2~0']);
  });

  it('the start edge trims the region: it starts later in its clip', () => {
    const res = A.resizeRegions(p, [r('a', D, 'c-beat', 0, 8)], ['a'], 'start', 3, ids());
    expect(short(res.regions, D)).toEqual(['a@3+5~1']);
  });

  it('the start edge pulled earlier reveals the clip before it, in phase', () => {
    const res = A.resizeRegions(p, [r('a', D, 'c-beat', 4, 4)], ['a'], 'start', -1, ids());
    expect(short(res.regions, D)).toEqual(['a@3+5~1']);
  });

  it('a region is always at least one bar', () => {
    expect(short(A.resizeRegions(p, [r('a', D, 'c-beat', 4, 4)], ['a'], 'end', -10, ids()).regions)).toEqual(['a@4+1~0']);
    expect(short(A.resizeRegions(p, [r('a', D, 'c-beat', 4, 4)], ['a'], 'start', 10, ids()).regions)).toEqual(['a@7+1~1']);
  });

  it('among regions stretched together, the earlier one wins', () => {
    const res = A.resizeRegions(p, [r('a', D, 'c-beat', 0, 2), r('b', D, 'c-fill', 2, 2)], ['a', 'b'], 'end', 2, ids());
    // a grew to 4 bars over b's start; b (also stretched to bar 6) keeps bars 4–6, later in its clip.
    expect(short(res.regions, D)).toEqual(['a@0+4~0', 'b@4+2~0']);
  });
});

describe('splitting', () => {
  it('cuts at a bar; the second piece starts later in its clip', () => {
    const p = project();
    const res = A.splitRegions(p, [r('a', D, 'c-beat', 2, 6)], ['a'], 5, ids());
    expect(short(res.regions)).toEqual(['a@2+3~0', 'new1@5+3~1']);
    expect(res.made.map((x) => x.id)).toEqual(['new1']);
  });

  it('ignores a cut on the edge', () => {
    const p = project();
    expect(short(A.splitRegions(p, [r('a', D, 'c-beat', 2, 6)], ['a'], 2, ids()).regions)).toEqual(['a@2+6~0']);
  });
});

describe('inserting and removing bars', () => {
  const p = project();
  const regions = [r('a', D, 'c-beat', 0, 8), r('bass', B, 'c-bass', 8, 4)];
  const sections: SongSection[] = [
    { id: 's1', name: 'Intro', start: 0, bars: 8 },
    { id: 's2', name: 'Drop', start: 8, bars: 4 },
  ];

  it('insert splits what crosses the point and moves the rest later', () => {
    const t = A.insertTime(p, regions, sections, 4, 2, ids());
    expect(short(t.regions)).toEqual(['a@0+4~0', 'new1@6+4~0', 'bass@10+4~0']);
    expect(t.sections.map((s) => `${s.name}@${s.start}+${s.bars}`)).toEqual(['Intro@0+10', 'Drop@10+4']);
  });

  it('remove closes the gap and joins a region that plays on as one', () => {
    const t = A.removeTime(p, regions, sections, 2, 4, ids());
    // Bars 2–4 of the beat go; bars 0–2 and 4–8 meet again and play on in phase (2-bar clip), so they join.
    expect(short(t.regions)).toEqual(['a@0+6~0', 'bass@6+4~0']);
    expect(t.sections.map((s) => `${s.name}@${s.start}+${s.bars}`)).toEqual(['Intro@0+6', 'Drop@6+4']);
  });

  it('remove takes a section that lies inside the gap', () => {
    const t = A.removeTime(p, regions, sections, 8, 12, ids());
    expect(t.sections.map((s) => s.name)).toEqual(['Intro']);
    expect(short(t.regions)).toEqual(['a@0+8~0']);
  });
});

describe('scenes become regions', () => {
  it('one region per part with a clip in the row, as long as the scene', () => {
    const p = project();
    const list = A.sceneRegions(p, 0, 16, ids());
    expect(list.map((x) => `${x.trackId}:${x.clipId}@${x.start}+${x.bars}`)).toEqual(['t1:c-beat@16+4', 't3:c-bass@16+4']);
    expect(A.rowBars(p, 1)).toBe(1);
  });
});

describe('sections', () => {
  const secs: SongSection[] = [
    { id: 's1', name: 'Intro', start: 0, bars: 8 },
    { id: 's2', name: 'Drop', start: 8, bars: 8 },
  ];

  it('a placed section trims the ones it overlaps', () => {
    const out = A.placeSection(secs, { id: 'n', name: 'Break', start: 6, bars: 4 });
    expect(out.map((s) => `${s.name}@${s.start}+${s.bars}`)).toEqual(['Intro@0+6', 'Break@6+4', 'Drop@10+6']);
  });

  it('a section owns the regions that start in it', () => {
    const list = [r('a', D, 'c-beat', 0, 12), r('b', D, 'c-fill', 12, 2)];
    expect(A.sectionRegions(list, secs[1]).map((x) => x.id)).toEqual(['b']);
  });

  it('gaps are the stretches no section covers', () => {
    expect(A.sectionGaps([{ id: 'x', name: 'X', start: 4, bars: 4 }], 12)).toEqual([
      [0, 4],
      [8, 12],
    ]);
  });
});

describe('tidying damaged data', () => {
  it('drops regions whose clip is gone, keeps offsets inside the clip, and resolves overlaps', () => {
    const p = project();
    const out = A.tidyRegions(p, [r('gone', D, 'nope', 0, 4), r('a', D, 'c-beat', 0, 4, 5), r('b', D, 'c-fill', 2, 4), r('c', D, 'c-beat', 3, 1)]);
    expect(short(out.regions)).toEqual(['a@0+4~1', 'b@4+2~0']);
    expect(out.fixed).toBe(4);
  });

  it('keeps sections apart', () => {
    const out = A.tidySections([
      { id: 'a', name: 'A', start: 0, bars: 8 },
      { id: 'b', name: 'B', start: 4, bars: 8 },
    ]);
    expect(out.sections.map((s) => `${s.name}@${s.start}+${s.bars}`)).toEqual(['A@0+8', 'B@8+4']);
  });
});

describe('reading the song', () => {
  it('length, the region at a bar, and where in its clip it is', () => {
    const p = project();
    p.arrangement = { regions: [r('a', D, 'c-beat', 2, 6, 1)], sections: [{ id: 's', name: 'S', start: 0, bars: 10 }], tailSeconds: 3 };
    expect(A.songBars(p)).toBe(10);
    expect(A.regionAt(p.arrangement.regions, D, 2.5)?.id).toBe('a');
    expect(A.regionAt(p.arrangement.regions, D, 8)).toBeNull();
    expect(A.clipBarAt(p.arrangement.regions[0], 2, 2)).toBe(1);
    expect(A.clipBarAt(p.arrangement.regions[0], 2, 3.5)).toBe(0.5);
  });
});
