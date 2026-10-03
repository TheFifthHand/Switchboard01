/**
 * What the Song view says: region names for screen readers, how many times a
 * loop plays ("4×", "2½×"), where its clip repeats (notches), the drag
 * badges, the song's length, part colours and states, and the loop browser's
 * scenes and loops.
 */
import { describe, expect, it } from 'vitest';
import {
  PART_HUES,
  clockText,
  lengthBadge,
  lengthText,
  moveBadge,
  notches,
  partHue,
  partLoops,
  partStatus,
  rangeText,
  regionFace,
  regionLabel,
  rowViews,
  sameRows,
  sceneCardText,
  sceneCards,
  sectionLabel,
  songSummary,
  startBadge,
  timesShort,
  timesWords,
} from '../../src/app/views/arrange/songModel';
import { createClip, createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';

function project(): Project {
  const p = createProject();
  p.tracks[0].clips[0] = { ...createClip('Four Floor', 4), id: 'c-ff' };
  p.tracks[0].clips[1] = { ...createClip('Fill', 1), id: 'c-fill' };
  p.tracks[2].clips[0] = { ...createClip('Bounce', 2), id: 'c-bounce' };
  p.arrangement.regions = [
    { id: 'r1', trackId: 't1', clipId: 'c-ff', start: 8, bars: 16, offset: 0 },
    { id: 'r2', trackId: 't3', clipId: 'c-bounce', start: 4, bars: 5, offset: 1 },
  ];
  p.arrangement.sections = [{ id: 's1', name: 'Drop', start: 8, bars: 16 }];
  return p;
}

describe('how many times a region plays', () => {
  it('short, for the badge', () => {
    expect(timesShort(16, 4)).toBe('4×');
    expect(timesShort(10, 4)).toBe('2½×');
    expect(timesShort(4, 3)).toBe('1⅓×');
    expect(timesShort(1, 4)).toBe('¼×');
    expect(timesShort(7, 5)).toBe('1.4×');
  });

  it('in words, for screen readers', () => {
    expect(timesWords(4, 4)).toBe('plays once');
    expect(timesWords(8, 4)).toBe('plays twice');
    expect(timesWords(16, 4)).toBe('plays 4 times');
    expect(timesWords(10, 4)).toBe('plays 2 and a half times');
    expect(timesWords(2, 8)).toBe('plays a quarter of its loop');
  });
});

describe('regions', () => {
  it('names a region as the brief reads it', () => {
    expect(regionLabel('Four Floor', 'Drums', { start: 8, bars: 8, offset: 0 }, 2)).toBe('Four Floor, Drums, bars 9 to 16, plays 4 times');
    expect(regionLabel('Fill', 'Drums', { start: 0, bars: 1, offset: 0 }, 1)).toBe('Fill, Drums, bar 1, plays once');
    expect(regionLabel('Bounce', 'Bass', { start: 4, bars: 5, offset: 1 }, 2)).toBe('Bounce, Bass, bars 5 to 9, plays 2 and a half times, starts 1 bar into its loop');
  });

  it('notches sit where the clip starts again, also after a mid-clip start', () => {
    expect(notches({ bars: 16, offset: 0 }, 4)).toEqual([4, 8, 12]);
    expect(notches({ bars: 4, offset: 0 }, 4)).toEqual([]);
    expect(notches({ bars: 8, offset: 1 }, 4)).toEqual([3, 7]);
    expect(notches({ bars: 5, offset: 1 }, 2)).toEqual([1, 3]);
  });

  it('a region face carries its clip, words and notches', () => {
    const p = project();
    const f = regionFace(p, p.arrangement.regions[1]);
    expect(f).toMatchObject({ clipName: 'Bounce', clipBars: 2, kind: 'notes', notches: [1, 3] });
    expect(f.clip?.id).toBe('c-bounce');
    expect(f.label).toContain('bars 5 to 9');
    expect(regionFace(p, p.arrangement.regions[0]).kind).toBe('drums');
    // A region whose clip went is still drawn sensibly until the song is tidied.
    expect(regionFace(p, { ...p.arrangement.regions[0], clipId: 'gone' })).toMatchObject({ clip: null, clipBars: 1, clipName: 'Loop' });
  });
});

describe('badges and lengths', () => {
  it('says where a drag lands', () => {
    expect(moveBadge(8, false)).toBe('Bar 9');
    expect(moveBadge(8, true)).toBe('+ Copy · Bar 9');
    expect(lengthBadge(8, 2)).toBe('8 bars · plays 4×');
    expect(lengthBadge(5, 2)).toBe('5 bars · plays 2½×');
    expect(startBadge(4)).toBe('starts at bar 5');
  });

  it('the song length in bars and minutes', () => {
    expect(clockText(62.4)).toBe('1:02');
    expect(clockText(59.6)).toBe('1:00');
    expect(clockText(9)).toBe('0:09');
    // 32 bars at 124 BPM: 32 × 4 beats = 61.9 s.
    expect(lengthText(32, 124)).toBe('32 bars · 1:02');
    expect(lengthText(1, 120)).toBe('1 bar · 0:02');
  });

  it('ranges and sections in words', () => {
    expect(rangeText(8, 16)).toBe('Bars 9–16');
    expect(rangeText(8, 9)).toBe('Bar 9');
    expect(sectionLabel({ name: 'Intro', start: 0, bars: 8 })).toBe('Intro, bars 1 to 8');
    expect(songSummary(project())).toEqual({ regions: 2, bars: 24 });
  });
});

describe('parts', () => {
  it('one row per part, in track order, each its own colour, never amber, teal or coral', () => {
    const p = project();
    const rows = rowViews(p);
    expect(rows.map((r) => r.id)).toEqual(p.tracks.map((t) => t.id));
    expect(rows[0]).toMatchObject({ number: 1, name: p.tracks[0].name, hue: PART_HUES[0] });
    expect(new Set(rows.map((r) => r.hue)).size).toBe(rows.length);
    for (const h of PART_HUES) {
      // Away from amber (~36°), teal (~176°) and coral (~9°).
      for (const reserved of [36, 176, 9]) expect(Math.min(Math.abs(h - reserved), 360 - Math.abs(h - reserved))).toBeGreaterThanOrEqual(20);
    }
    expect(partHue(PART_HUES.length)).toBe(PART_HUES[0]);
    expect(sameRows(rows, rowViews(p))).toBe(true);
    p.tracks[1].mute = true;
    expect(sameRows(rows, rowViews(p))).toBe(false);
  });

  it('says whether a part is heard', () => {
    expect(partStatus({ mute: true, solo: false }, false)).toBe('Muted');
    expect(partStatus({ mute: false, solo: true }, true)).toBe('Solo');
    expect(partStatus({ mute: false, solo: false }, true)).toBe('Not soloed');
    expect(partStatus({ mute: false, solo: false }, false)).toBeNull();
  });
});

describe('the loop browser', () => {
  it('a card per scene with clips, and each part’s loops', () => {
    const p = project();
    const cards = sceneCards(p);
    expect(cards.map((c) => c.row)).toEqual([0, 1]);
    expect(cards[0]).toMatchObject({ bars: 4, parts: [{ trackId: 't1' }, { trackId: 't3' }] });
    expect(sceneCardText(cards[0])).toBe(`${p.scenes[0].name} · 4 bars · 2 parts`);
    expect(sceneCardText(cards[1])).toBe(`${p.scenes[1].name} · 1 bar · 1 part`);
    expect(partLoops(p, 't1').map((l) => [l.name, l.bars, l.slot])).toEqual([
      ['Four Floor', 4, 0],
      ['Fill', 1, 1],
    ]);
    expect(partLoops(p, 'nope')).toEqual([]);
  });
});
