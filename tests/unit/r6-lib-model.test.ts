/**
 * The Song view's loop library and region helpers in words and numbers:
 * what a search and the Part and Style chips list, which part a loop goes
 * to (and why a part cannot take it), the notes it gets there, new names,
 * the tab the browser opens on, where a scene plays in the song, and how
 * many places a loop plays.
 */
import { describe, expect, it } from 'vitest';
import { LIBRARY_LOOPS, getLoop, type LibraryLoop } from '../../src/content/loops';
import { BEATS } from '../../src/content/beats';
import { getStarter } from '../../src/content/starters';
import { createProject } from '../../src/project/factory';
import type { Clip, Project } from '../../src/project/types';
import {
  FEW_LOOPS,
  PART_CHIPS,
  beatsByStyle,
  defaultTab,
  freshName,
  libraryLoop,
  libraryResults,
  loopRoleOf,
  loopTarget,
  partProblem,
  realizeFor,
  styleChips,
} from '../../src/app/views/arrange/library/libraryModel';
import { loopPlaces, partLoops, placesBadge, sceneOfferText, scenePlaces } from '../../src/app/views/arrange/songModel';

const house = (): Project => getStarter('house')!.build();
const loop = (id: string): LibraryLoop => getLoop(id)!;
const track = (p: Project, name: string) => p.tracks.find((t) => t.name === name)!;

describe('the library list', () => {
  it('Part chips are the seven library parts, in plain names', () => {
    expect(PART_CHIPS.map((c) => c.name)).toEqual(['Beats', 'Percussion', 'Bass', 'Chords', 'Melody', 'Pads', 'Textures']);
  });

  it('with nothing chosen, every loop is listed; a part chip keeps only that part’s loops', () => {
    expect(libraryResults({ text: '', role: null, genre: null })).toHaveLength(LIBRARY_LOOPS.length);
    const bass = libraryResults({ text: '', role: 'bass', genre: null });
    expect(bass.length).toBeGreaterThan(5);
    expect(bass.every((l) => l.role === 'bass')).toBe(true);
  });

  it('a style chip and a search narrow it further, best match first', () => {
    const trapBeats = libraryResults({ text: '', role: 'drums', genre: 'trap' });
    expect(trapBeats.length).toBeGreaterThan(0);
    expect(trapBeats.every((l) => l.role === 'drums' && l.genres.includes('trap'))).toBe(true);
    const found = libraryResults({ text: 'trap bass', role: null, genre: null });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((l) => l.role === 'bass' && l.genres.includes('trap'))).toBe(true);
    const named = LIBRARY_LOOPS.find((l) => l.role === 'chords')!;
    expect(libraryResults({ text: named.name, role: null, genre: null })[0].id).toBe(named.id);
    expect(libraryResults({ text: 'zzzz nothing', role: null, genre: null })).toEqual([]);
  });

  it('Style chips show only the styles a part has loops in', () => {
    const all = styleChips(null);
    expect(all.length).toBe(15);
    for (const role of PART_CHIPS.map((c) => c.role)) {
      const chips = styleChips(role);
      expect(chips.length).toBeGreaterThan(0);
      for (const g of chips) expect(libraryResults({ text: '', role, genre: g.id }).length).toBeGreaterThan(0);
    }
  });

  it('beats for “Start from a beat…” come grouped by style, every beat once', () => {
    const groups = beatsByStyle();
    expect(groups.flatMap((g) => g.beats).length).toBe(BEATS.length);
    expect(groups.every((g) => g.beats.length > 0 && g.beats.every((b) => b.genre === g.genre))).toBe(true);
    // A beat id reads as a library loop (a drum loop).
    expect(libraryLoop(BEATS[0].id)?.part.kind).toBe('drums');
  });
});

describe('which part a loop goes to', () => {
  it('a loop goes to its own kind of part, the selected one when it is one', () => {
    const p = house();
    const beat = loop('beat-steady-four');
    expect(loopTarget(p, beat, null)).toEqual({ trackId: track(p, 'Drums').id });
    // Selected Percussion (a drum kit too, but another job): the beat still goes to Drums.
    expect(loopTarget(p, beat, track(p, 'Percussion').id)).toEqual({ trackId: track(p, 'Drums').id });
    const chords = LIBRARY_LOOPS.find((l) => l.role === 'chords')!;
    expect(loopTarget(p, chords, track(p, 'Bass').id)).toEqual({ trackId: track(p, 'Chords').id });
  });

  it('with no part of its job, the selected part when it can play it, else the first that can', () => {
    const p = house();
    p.tracks = p.tracks.filter((t) => t.role !== 'chords');
    const chords = LIBRARY_LOOPS.find((l) => l.role === 'chords')!;
    expect(loopTarget(p, chords, track(p, 'Pad').id)).toEqual({ trackId: track(p, 'Pad').id });
    expect(loopTarget(p, chords, track(p, 'Drums').id)).toEqual({ trackId: track(p, 'Bass').id });
  });

  it('a song with no part that can play it says so', () => {
    const p = house();
    p.tracks = p.tracks.filter((t) => t.instrument.kind !== 'drums');
    const r = loopTarget(p, loop('beat-steady-four'), null);
    expect(r).toEqual({ problem: 'This song has no drum part to play “Steady Four”.' });
  });

  it('the wrong kind of part is refused in words', () => {
    const p = house();
    expect(partProblem(loop('beat-steady-four'), track(p, 'Bass'))).toBe('“Steady Four” is a drum loop and Bass plays notes: put it on a drum or percussion part.');
    const melody = LIBRARY_LOOPS.find((l) => l.role === 'lead')!;
    expect(partProblem(melody, track(p, 'Drums'))).toMatch(/plays notes and Drums is a drum kit: put it on a synth or sampler part\.$/);
    expect(partProblem(melody, track(p, 'Vocal'))).toBeNull();
    expect(loopRoleOf(track(p, 'Vocal'))).toBeNull();
    expect(loopRoleOf(track(p, 'Lead'))).toBe('lead');
  });
});

describe('the notes a loop gets on a part', () => {
  it('pitched loops land in the song’s key; the same loop in another key moves with it', () => {
    const p = house();
    const bass = LIBRARY_LOOPS.find((l) => l.role === 'bass')!;
    const a = realizeFor(p, bass, track(p, 'Bass'))!;
    expect(a.bars).toBe(bass.bars);
    expect(a.notes.length).toBeGreaterThan(0);
    const up = realizeFor({ ...p, root: (p.root + 2) % 12 }, bass, track(p, 'Bass'))!;
    expect(up.notes.map((n) => n.pitch)).not.toEqual(a.notes.map((n) => n.pitch));
    expect(realizeFor(p, bass, track(p, 'Drums'))).toBeNull();
  });

  it('a new loop gets the loop’s name, or a number when the part has a loop called that', () => {
    const p = house();
    const drums = track(p, 'Drums');
    expect(freshName(drums, 'Steady Four')).toBe('Steady Four');
    expect(freshName(drums, 'Four Floor')).toBe('Four Floor 2');
    drums.songClips = [{ ...drums.clips[1]!, id: 'c-x', name: 'Four Floor 2' } as Clip];
    expect(freshName(drums, 'Four Floor')).toBe('Four Floor 3');
  });
});

describe('the browser’s tabs and the part’s loops', () => {
  it('opens on the Library while the project has few loops of its own, on This song otherwise', () => {
    expect(defaultTab(house())).toBe('song');
    const blank = createProject();
    expect(defaultTab(blank)).toBe('library');
    expect(FEW_LOOPS).toBeGreaterThan(1);
  });

  it('a part’s loops list its pads’ clips, then the song’s own loops (marked)', () => {
    const p = house();
    const drums = track(p, 'Drums');
    drums.songClips = [{ id: 'song-1', name: 'Steady Four', bars: 1, notes: [] } as unknown as Clip];
    const loops = partLoops(p, drums.id);
    expect(loops.map((l) => l.name)).toEqual(['Hats & Rim', 'Four Floor', 'Floor Rush', 'Steady Four']);
    expect(loops[3]).toMatchObject({ slot: 100, inSong: true });
    expect(loops[0].inSong).toBeUndefined();
  });
});

describe('loops in several places and where a scene plays', () => {
  it('counts the places a loop plays, with a “×N” badge from two places on', () => {
    const p = house();
    const r = p.arrangement.regions[0];
    const n = p.arrangement.regions.filter((x) => x.trackId === r.trackId && x.clipId === r.clipId).length;
    expect(loopPlaces(p, r.trackId, r.clipId)).toBe(n);
    expect(placesBadge(1)).toBeNull();
    expect(placesBadge(3)).toBe('×3');
  });

  it('a scene plays where its loops start (Groove: bars 9 and 65), only where the part is free', () => {
    const p = house();
    expect(scenePlaces(p, 1)).toEqual([
      { start: 8, bars: 16 },
      { start: 64, bars: 8 },
    ]);
    const lead = track(p, 'Lead');
    expect(scenePlaces(p, 1, lead.id)).toEqual([
      { start: 8, bars: 16 },
      { start: 64, bars: 8 },
    ]);
    // Lead already plays at bar 65: only the first place is offered.
    p.arrangement.regions.push({ id: 'rg-x', trackId: lead.id, clipId: lead.clips[2]!.id, start: 66, bars: 2, offset: 0 });
    expect(scenePlaces(p, 1, lead.id)).toEqual([{ start: 8, bars: 16 }]);
    expect(sceneOfferText('Lead 1', 'Groove', 2)).toBe('Add Lead 1 to the song where Groove plays (2 places)?');
  });
});
