/**
 * Validation of the song (schema v4): loops (regions) whose part and clip
 * exist, in whole bars inside the song, offsets inside their clips, never
 * overlapping on a part; sections that never overlap, with names and song
 * moves. A valid song comes back exactly as it went in; every repair is said
 * in plain words, and what validation makes opens again with nothing to say.
 */
import { describe, expect, it } from 'vitest';
import { VALIDATION_LIMITS, validateProject } from '../../src/project/validate';
import type { Project } from '../../src/project/types';
import { sections, sketch, songProject } from './r5-song-fixtures';

/** The fixture project with a raw (possibly damaged) song. */
function withSong(song: { regions?: unknown; sections?: unknown; tailSeconds?: unknown }) {
  const { p, clip } = songProject();
  const raw = JSON.parse(JSON.stringify(p));
  raw.arrangement = { regions: [], sections: [], tailSeconds: 3, ...song };
  return { raw, clip };
}

function check(raw: unknown): { project: Project; warnings: string[] } {
  const r = validateProject(raw);
  if (!r.ok) throw new Error(r.errors.join(' '));
  // What it makes opens again unchanged, with nothing to repair.
  const again = validateProject(JSON.parse(JSON.stringify(r.project)));
  expect(again.ok && again.warnings).toEqual([]);
  if (again.ok) expect(again.project).toEqual(JSON.parse(JSON.stringify(r.project)));
  return r;
}

describe('song validation', () => {
  it('keeps a valid song exactly', () => {
    const { raw, clip } = withSong({
      regions: [
        { id: 'rg_a', trackId: 't1', clipId: '', start: 0, bars: 8, offset: 1 },
        { id: 'rg_b', trackId: 't3', clipId: '', start: 0, bars: 4, offset: 3 },
        { id: 'rg_c', trackId: 't3', clipId: '', start: 4, bars: 2, offset: 0 },
      ],
      sections: [
        { id: 'sec_a', name: 'Intro', start: 0, bars: 4, moves: [{ id: 'mv_a', kind: 'fadeIn' }] },
        { id: 'sec_b', name: 'Drop', start: 6, bars: 506 },
      ],
      tailSeconds: 2.5,
    });
    raw.arrangement.regions[0].clipId = clip.Beat;
    raw.arrangement.regions[1].clipId = clip.Bounce;
    raw.arrangement.regions[2].clipId = clip.Walk;
    const r = check(raw);
    expect(r.warnings).toEqual([]);
    expect(r.project.arrangement).toEqual(raw.arrangement);
  });

  it('removes loops whose part or clip is gone, or that are damaged; a clip must be on the loop’s own part', () => {
    const { raw, clip } = withSong({});
    raw.arrangement.regions = [
      { id: 'rg_a', trackId: 't1', clipId: clip.Beat, start: 0, bars: 2, offset: 0 },
      { id: 'rg_b', trackId: 't3', clipId: clip.Beat, start: 0, bars: 2, offset: 0 },
      { id: 'rg_c', trackId: 't9', clipId: clip.Beat, start: 4, bars: 2, offset: 0 },
      { id: 'rg_d', trackId: 't1', clipId: 'clip_gone', start: 4, bars: 2, offset: 0 },
      { id: 'rg_e', trackId: 't1', clipId: clip.Beat, start: '4', bars: 2, offset: 0 },
      { id: 'rg_f', trackId: 't1', clipId: clip.Beat, start: 6, bars: 2 },
      'loop',
      { id: 'rg_g', trackId: 't1', clipId: clip.Beat, start: 8, bars: 0, offset: 0 },
    ];
    const r = check(raw);
    expect(sketch(r.project)).toEqual(['t1:Beat@0+2~0']);
    expect(r.warnings).toEqual([
      'Removed a loop whose clip no longer exists from the song. (3 times)',
      'Removed a damaged loop from the song. (3 times)',
      'Removed a loop with no length from the song.',
    ]);
  });

  it('puts loops on the bar lines, inside the song and with their offsets inside their clips', () => {
    const { raw, clip } = withSong({});
    raw.arrangement.regions = [
      { id: 'rg_a', trackId: 't1', clipId: clip.Beat, start: 0.4, bars: 1.8, offset: 0 },
      // Starts two bars before the song: those bars are cut, the music stays in time (two bars later in the clip).
      { id: 'rg_b', trackId: 't3', clipId: clip.Bounce, start: -2, bars: 6, offset: 1 },
      { id: 'rg_c', trackId: 't4', clipId: clip.Stabs, start: 500, bars: 40, offset: 9 },
      { id: 'rg_d', trackId: 't5', clipId: clip.Hook, start: 600, bars: 4, offset: 0 },
    ];
    const r = check(raw);
    expect(sketch(r.project)).toEqual(['t1:Beat@0+2~0', 't3:Bounce@0+4~3', 't4:Stabs@500+12~1']);
    expect(r.warnings).toEqual([
      'Moved a loop onto the bar lines.',
      'Cut a loop that started before the song.',
      'Shortened the song to 512 bars, the longest a song can be. (2 times)',
      'Adjusted where a loop starts in its clip.',
    ]);
  });

  it('fixes overlapping loops on a part (the earlier keeps its bars, the later starts after it, in phase), says how many, and puts the song in order', () => {
    const { raw, clip } = withSong({});
    raw.arrangement.regions = [
      { id: 'rg_a', trackId: 't3', clipId: clip.Bounce, start: 0, bars: 8, offset: 0 },
      { id: 'rg_b', trackId: 't3', clipId: clip.Walk, start: 6, bars: 4, offset: 0 },
      { id: 'rg_c', trackId: 't3', clipId: clip.Walk, start: 2, bars: 4, offset: 0 },
      { id: 'rg_d', trackId: 't1', clipId: clip.Beat, start: 0, bars: 4, offset: 0 },
    ];
    const r = check(raw);
    expect(sketch(r.project)).toEqual(['t1:Beat@0+4~0', 't3:Bounce@0+8~0', 't3:Walk@8+2~0']);
    expect(r.warnings).toEqual(['Fixed 2 overlapping loops in the song.']);
    // Only out of order: put back in time order, said once.
    const { raw: shuffled, clip: c2 } = withSong({});
    shuffled.arrangement.regions = [
      { id: 'rg_b', trackId: 't3', clipId: c2.Walk, start: 8, bars: 2, offset: 0 },
      { id: 'rg_a', trackId: 't3', clipId: c2.Bounce, start: 0, bars: 8, offset: 0 },
    ];
    const s = check(shuffled);
    expect(s.project.arrangement.regions.map((x) => x.id)).toEqual(['rg_a', 'rg_b']);
    expect(s.warnings).toEqual(['Put the song’s loops back in time order.']);
  });

  it('gives repeated or invalid ids new ones', () => {
    const { raw, clip } = withSong({});
    raw.arrangement.regions = [
      { id: 'rg_a', trackId: 't1', clipId: clip.Beat, start: 0, bars: 2, offset: 0 },
      { id: 'rg_a', trackId: 't3', clipId: clip.Bounce, start: 0, bars: 2, offset: 0 },
      { id: 'no spaces allowed', trackId: 't4', clipId: clip.Stabs, start: 0, bars: 2, offset: 0 },
    ];
    raw.arrangement.sections = [
      { id: 'sec_a', name: 'A', start: 0, bars: 2 },
      { id: 'sec_a', name: 'B', start: 2, bars: 2 },
    ];
    const r = check(raw);
    const ids = r.project.arrangement.regions.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('rg_a');
    expect(new Set(r.project.arrangement.sections.map((x) => x.id)).size).toBe(2);
    expect(r.warnings).toEqual(['Gave a loop in the song a new id. (2 times)', 'Gave a song section a new id.']);
  });

  it('sections: named in one line of at most 40 characters, in whole bars inside the song, never overlapping', () => {
    const { raw } = withSong({});
    raw.arrangement.sections = [
      { id: 'sec_a', name: '  Big   Drop ', start: 0, bars: 8 },
      { id: 'sec_b', name: 'x'.repeat(50), start: 4, bars: 8 },
      { id: 'sec_c', name: 42, start: 12.5, bars: 2 },
      { id: 'sec_d', name: 'Late', start: 510, bars: 9 },
      { id: 'sec_e', name: 'Gone', start: 20, bars: 0 },
      { id: 'sec_f', name: 'Damaged', start: null, bars: 2 },
      { id: 'sec_g', name: `${'y'.repeat(39)} cut`, start: 30, bars: 2 },
    ];
    const r = check(raw);
    expect(sections(r.project)).toEqual(['Big Drop@0+8', `${'x'.repeat(40)}@8+4`, 'Section@13+2', `${'y'.repeat(39)}@30+2`, 'Late@510+2']);
    expect(r.warnings).toEqual([
      'Adjusted a song section name. (3 times)',
      'Moved a section onto the bar lines.',
      'Named a song section that had no name.',
      'Shortened the song to 512 bars, the longest a song can be.',
      'Removed a section with no length from the song.',
      'Removed a damaged section from the song.',
      'Fixed 1 overlapping section in the song.',
    ]);
  });

  it('a song with more loops or sections than it can hold keeps the first ones and says so', () => {
    const { raw, clip } = withSong({});
    raw.arrangement.regions = Array.from({ length: VALIDATION_LIMITS.maxRegions + 3 }, (_, i) => ({ id: `rg_${i}`, trackId: `t${(i % 2) * 2 + 1}`, clipId: i % 2 ? clip.Bounce : clip.Beat, start: Math.floor(i / 2) % 512, bars: 1, offset: 0 }));
    raw.arrangement.sections = Array.from({ length: VALIDATION_LIMITS.maxSections + 1 }, (_, i) => ({ id: `sec_${i}`, name: `S${i}`, start: i, bars: 1 }));
    const r = validateProject(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.arrangement.sections).toHaveLength(VALIDATION_LIMITS.maxSections);
    expect(r.project.arrangement.regions.length).toBeLessThanOrEqual(VALIDATION_LIMITS.maxRegions);
    expect(r.warnings).toContain(`Removed loops beyond the limit of ${VALIDATION_LIMITS.maxRegions} from the song.`);
    expect(r.warnings).toContain(`Removed sections beyond the limit of ${VALIDATION_LIMITS.maxSections} from the song.`);
    expect([VALIDATION_LIMITS.maxRegions, VALIDATION_LIMITS.maxSections]).toEqual([4000, 256]);
  });

  it('a damaged or missing song is reset, and the reset is said', () => {
    const { raw } = withSong({ regions: 'x' });
    expect(check(raw).warnings).toEqual(['Reset a damaged song.']);
    const { raw: none } = withSong({});
    delete none.arrangement;
    const r = check(none);
    expect(r.project.arrangement).toEqual({ regions: [], sections: [], tailSeconds: 3 });
    expect(r.warnings).toEqual(['Reset a missing song.']);
  });
});
