/**
 * Round 7, the Song screen as the home: the pure rules behind it. Which rows
 * Simple shows, what "+ Add instrument" offers, the tip line's next step, the
 * plain names new parts of the song get, and "Make it longer" as song
 * commands (one undo step each, repeating real music, never two new parts
 * with the same name).
 */
import { describe, expect, it } from 'vitest';
import { getStarter } from '../../src/content/starters';
import { hiddenInstruments, secondsWords, simpleRowIds, songClock, songSeconds, songTip } from '../../src/app/views/arrange/songHome';
import { nextPartName, regionEnd, sectionToGrow, songBars, uniqueSectionName } from '../../src/project/arrangement';
import { validateProject } from '../../src/project/validate';
import type { Project, SongRegion, SongSection } from '../../src/project/types';
import { addEnding, addIntro, growSong } from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';

function house(): Project {
  return getStarter('house')!.build();
}

const tid = (p: Project, name: string) => p.tracks.find((t) => t.name === name)!.id;

/** House with only these loops and sections. */
function withSong(regions: (p: Project) => SongRegion[], sections: SongSection[] = []): Project {
  const p = house();
  p.arrangement.regions = regions(p);
  p.arrangement.sections = sections;
  return p;
}

const drumsOnly = () =>
  withSong(
    (p) => [
      { id: 'd1', trackId: tid(p, 'Drums'), clipId: p.tracks[0].clips[0]!.id, start: 0, bars: 8, offset: 0 },
      { id: 'd2', trackId: tid(p, 'Drums'), clipId: p.tracks[0].clips[1]!.id, start: 8, bars: 8, offset: 0 },
      { id: 'p1', trackId: tid(p, 'Percussion'), clipId: p.tracks[1].clips[1]!.id, start: 8, bars: 8, offset: 0 },
    ],
    [
      { id: 'sIntro', name: 'Intro', start: 0, bars: 8 },
      { id: 'sGroove', name: 'Groove', start: 8, bars: 8 },
    ],
  );

describe('rows in Simple', () => {
  it('shows the instruments with music, plus the ones kept, in track order', () => {
    const p = drumsOnly();
    expect(simpleRowIds(p, new Set())).toEqual([tid(p, 'Drums'), tid(p, 'Percussion')]);
    expect(simpleRowIds(p, new Set([tid(p, 'Pad')]))).toEqual([tid(p, 'Drums'), tid(p, 'Percussion'), tid(p, 'Pad')]);
  });

  it('shows every instrument while the song is empty, or a loop is carried in', () => {
    const empty = withSong(() => []);
    expect(simpleRowIds(empty, new Set())).toHaveLength(8);
    expect(simpleRowIds(drumsOnly(), new Set(), true)).toHaveLength(8);
  });

  it('+ Add instrument offers only the hidden ones, beat → bass → harmony → tune → colour', () => {
    const p = drumsOnly();
    const offered = hiddenInstruments(p, simpleRowIds(p, new Set()));
    expect(offered.map((h) => h.kind)).toEqual(['Bass', 'Keys & chords', 'Melody', 'Pad', 'Texture', 'Recording']);
    expect(offered.every((h) => h.icon)).toBe(true);
    expect(hiddenInstruments(p, p.tracks.map((t) => t.id))).toEqual([]);
  });
});

describe('length and the tip line', () => {
  it('reads the length in minutes and seconds', () => {
    const p = house();
    // 72 bars at 124 BPM: 139.35 s.
    expect(songBars(p)).toBe(72);
    expect(songSeconds(p)).toBeCloseTo((72 * 4 * 60) / 124, 6);
    expect(songClock(p)).toBe('2:19');
    expect(secondsWords(64)).toBe('1 minute 4 seconds');
    expect(secondsWords(60)).toBe('1 minute');
    expect(secondsWords(9)).toBe('9 seconds');
  });

  it('offers one next step from the real song', () => {
    expect(songTip(withSong(() => []))).toEqual({ step: 'loops', text: 'Pick a beat from LOOPS on the right' });
    expect(songTip(drumsOnly())).toEqual({ step: 'bass', text: 'Add a bass: + Add instrument' });
    const short = withSong((p) => [
      { id: 'd', trackId: tid(p, 'Drums'), clipId: p.tracks[0].clips[1]!.id, start: 0, bars: 4, offset: 0 },
      { id: 'b', trackId: tid(p, 'Bass'), clipId: p.tracks[2].clips[1]!.id, start: 0, bars: 4, offset: 0 },
    ]);
    // 4 bars at 124 BPM: under 8 s.
    expect(songTip(short).step).toBe('longer');
    expect(songTip(house())).toEqual({ step: 'share', text: 'Share your song' });
  });
});

describe('plain names for new parts', () => {
  it('goes Verse, Chorus, Bridge, Verse 2… skipping names in use', () => {
    const named = (...n: string[]) => n.map((name) => ({ name }));
    expect(nextPartName([])).toBe('Verse');
    expect(nextPartName(named('Verse'))).toBe('Chorus');
    expect(nextPartName(named('Verse', 'chorus', 'Bridge'))).toBe('Verse 2');
    expect(nextPartName(named('Verse', 'Chorus', 'Bridge', 'Verse 2'))).toBe('Chorus 2');
    expect(uniqueSectionName(named('Intro'), 'Intro')).toBe('Intro 2');
    expect(uniqueSectionName(named('Intro', 'Intro 2'), 'Intro')).toBe('Intro 3');
    expect(uniqueSectionName(named('Groove'), 'Intro')).toBe('Intro');
  });

  it('grows the part at the playhead, else the last one before it', () => {
    const s: SongSection[] = [
      { id: 'a', name: 'A', start: 0, bars: 8 },
      { id: 'b', name: 'B', start: 12, bars: 4 },
    ];
    expect(sectionToGrow(s, 3)?.id).toBe('a');
    expect(sectionToGrow(s, 9)?.id).toBe('a');
    expect(sectionToGrow(s, 40)?.id).toBe('b');
    expect(sectionToGrow([], 0)).toBeNull();
  });
});

describe('Make it longer (commands)', () => {
  it('adds a part after the one at the playhead: the next plain name, its music copied, one undo step', () => {
    const store = new ProjectStore(drumsOnly());
    const r = growSong(store, 9, 'after');
    expect(r.changed).toBe(true);
    expect(r.name).toBe('Verse');
    expect(r.from).toBe('Groove');
    const p = store.getState();
    const verse = p.arrangement.sections.find((x) => x.id === r.sectionId)!;
    expect([verse.name, verse.start, verse.bars]).toEqual(['Verse', 16, 8]);
    // The same loops play in Verse as in Groove (Drums and Percussion).
    const inVerse = p.arrangement.regions.filter((x) => x.start >= 16 && x.start < 24);
    expect(inVerse.map((x) => x.clipId).sort()).toEqual(p.arrangement.regions.filter((x) => x.id === 'd2' || x.id === 'p1').map((x) => x.clipId).sort());
    expect(store.historySize().undo).toBe(1);
    const v = validateProject(p);
    expect(v.ok && v.warnings).toEqual([]);
    // Again and again: never the same new name twice.
    const names = [r.name];
    for (let i = 0; i < 4; i++) names.push(growSong(store, 9, 'after').name!);
    expect(names).toEqual(['Verse', 'Chorus', 'Bridge', 'Verse 2', 'Chorus 2']);
    expect(store.historySize().undo).toBe(5);
    store.undo();
    expect(store.getState().arrangement.sections.some((x) => x.name === 'Chorus 2')).toBe(false);
  });

  it('repeats the part again under its own name, with its song moves', () => {
    const p = drumsOnly();
    p.arrangement.sections[1] = { ...p.arrangement.sections[1], moves: [{ id: 'mv1', kind: 'fadeIn' }] };
    const store = new ProjectStore(p);
    const r = growSong(store, 10, 'again');
    const copy = store.getState().arrangement.sections.find((x) => x.id === r.sectionId)!;
    expect([copy.name, copy.start, copy.bars]).toEqual(['Groove', 16, 8]);
    expect(copy.moves?.map((m) => m.kind)).toEqual(['fadeIn']);
    expect(songBars(store.getState())).toBe(24);
  });

  it('names a song without sections before growing it, in the same step', () => {
    const p = drumsOnly();
    p.arrangement.sections = [];
    const store = new ProjectStore(p);
    growSong(store, 0, 'after');
    const names = store.getState().arrangement.sections.map((x) => `${x.name} ${x.start}+${x.bars}`);
    expect(names).toEqual(['Verse 0+16', 'Chorus 16+16']);
    expect(store.historySize().undo).toBe(1);
    store.undo();
    expect(store.getState().arrangement.sections).toEqual([]);
  });

  it('is refused with nothing changed while the song has no music', () => {
    const store = new ProjectStore(withSong(() => []));
    const r = growSong(store, 0, 'again');
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('empty');
    expect(r.message).toMatch(/no music/);
    expect(store.historySize().undo).toBe(0);
  });

  it('a second intro or ending gets a name of its own', () => {
    const store = new ProjectStore(drumsOnly());
    expect(addIntro(store).changed).toBe(true);
    addIntro(store);
    addEnding(store);
    addEnding(store);
    const names = store.getState().arrangement.sections.map((s) => s.name);
    expect(names.filter((n) => n.startsWith('Intro')).sort()).toEqual(['Intro', 'Intro 2', 'Intro 3']);
    expect(names.filter((n) => n.startsWith('Ending')).sort()).toEqual(['Ending', 'Ending 2']);
    const last = store.getState().arrangement.sections.at(-1)!;
    expect(regionEnd(last)).toBe(songBars(store.getState()));
  });
});
