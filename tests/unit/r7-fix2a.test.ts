/**
 * Round 7 fix 2a (code review + third beginner test): the song rules behind
 * Simple's tip line, Make it longer / shorter, LOOPS drops and repeat.
 *
 * - The tip line never points at a choice that is not there (+ Add instrument
 *   offers only hidden instruments; an empty loop is filled instead; LOOPS
 *   closed or covered is said), says how to hear a ready-made song whole,
 *   and never runs out after Share.
 * - Make it longer offers an intro or an ending only while the song has
 *   none; a second intro reads left to right and is built from the main part.
 * - Make it shorter offers the last section and the one at the playhead,
 *   never the only one.
 * - A loop dropped from LOOPS lands at a section's start (no silent gap).
 * - Repeat follows a stretch inside a section that moved, and back on Undo.
 * - A ready-made loop grows only loops that played it once, and only when it
 *   got longer.
 */
import { describe, expect, it } from 'vitest';
import { BLANK_STARTER, getStarter } from '../../src/content/starters';
import { hiddenInstruments, nextIdeas, shorterChoices, simpleDropBar, simpleRowIds, songEdges, songHasSound, songTip } from '../../src/app/views/arrange/songHome';
import { SIMPLE_SHORTCUT_GROUPS } from '../../src/app/views/hints/shortcuts';
import { invertShifts, mainSection, regionEnd, songBars, sortSections } from '../../src/project/arrangement';
import { slotOfClip } from '../../src/project/clips';
import { TICKS_PER_BEAT, type Note, type Project, type TrackRole } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { followSongLoop } from '../../src/time/songLoop';

const tid = (p: Project, role: TrackRole) => p.tracks.find((t) => t.role === role)!.id;
function notes(bars: number, pitch: number): Omit<Note, 'id'>[] {
  return Array.from({ length: bars * 4 }, (_, i) => ({ tick: i * TICKS_PER_BEAT, pitch, velocity: 100, duration: TICKS_PER_BEAT / 2 }));
}
const blank = () => new ProjectStore(BLANK_STARTER.build());
const house = () => new ProjectStore(getStarter('house')!.build());
const names = (p: Project) => sortSections(p.arrangement.sections).map((s) => s.name);

describe('the tip line never points at a choice that is not there', () => {
  it('Make a beat (empty drum loop) + a bass: fill the empty Drums loop (Drums is not in + Add instrument)', () => {
    const store = blank();
    const p = store.getState();
    cmd.addLoopToSong(store, tid(p, 'drums'), 0, { bars: 1 });
    cmd.addLoopToSong(store, tid(p, 'bass'), 0, { bars: 1, notes: notes(1, 36) });
    const q = store.getState();
    const offered = hiddenInstruments(q, simpleRowIds(q, new Set())).map((h) => h.role);
    expect(offered).not.toContain('drums');
    expect(songTip(q)).toEqual({ step: 'beat', text: 'Click the empty Drums loop to add sounds to it' });
  });

  it('an empty bass loop: fill it, not "+ Add instrument, then Bass"', () => {
    const store = blank();
    const p = store.getState();
    cmd.addLoopToSong(store, tid(p, 'drums'), 0, { bars: 1, notes: notes(1, 0) });
    cmd.addLoopToSong(store, tid(p, 'bass'), 0, { bars: 1 });
    expect(songTip(store.getState())).toEqual({ step: 'bass', text: 'Click the empty Bass loop to add sounds to it' });
  });

  it('no instrument of that kind at all (deleted in Advanced): the step is skipped', () => {
    const store = blank();
    const p = store.getState();
    cmd.addLoopToSong(store, tid(p, 'drums'), 0, { bars: 1, notes: notes(1, 0) });
    const q = store.getState();
    const noBass = { ...q, tracks: q.tracks.filter((t) => t.role !== 'bass') };
    expect(songTip(noBass).step).toBe('chords');
    expect(songTip(noBass).text).toBe('Add chords: press + Add instrument, then Keys & chords');
  });

  it('chords offered no more: a melody is suggested by the name the picker shows', () => {
    const store = blank();
    const p = store.getState();
    cmd.addLoopToSong(store, tid(p, 'drums'), 0, { bars: 1, notes: notes(1, 0) });
    cmd.addLoopToSong(store, tid(p, 'bass'), 0, { bars: 1, notes: notes(1, 36) });
    const q = store.getState();
    const shown = [...simpleRowIds(q, new Set()), tid(q, 'chords')];
    expect(songTip(q, { shown })).toEqual({ step: 'chords', text: 'Add a melody: press + Add instrument, then Melody' });
  });

  it('an empty song with LOOPS closed, or covered by the Sound panel, says how to get to it', () => {
    const p = blank().getState();
    expect(songTip(p).text).toBe('Pick a beat from Loops on the right');
    expect(songTip(p, { loops: 'closed' }).text).toBe('Press Loops at the top of your song, then pick a beat');
    expect(songTip(p, { loops: 'sound' }).text).toBe('Close the sound panel on the right (✕), then pick a beat from Loops');
  });
});

describe('the tip line after Jump In and after Share', () => {
  it('a ready-made song repeating its main part: first, how to hear the whole song', () => {
    const p = house().getState();
    expect(songTip(p, { fresh: true, repeating: 'Groove' })).toEqual({ step: 'whole', text: 'To hear your whole song, press ⟳ Repeating: Groove at the top' });
    expect(songTip(p, { fresh: true }).step).toBe('try');
  });

  it('never runs out: once shared it offers ideas of what to do next, one at a time', () => {
    const p = house().getState();
    expect(songTip(p).step).toBe('share');
    const a = songTip(p, { shared: true });
    const b = songTip(p, { shared: true, idea: 1 });
    expect(a.step).toBe('next');
    expect(b.step).toBe('next');
    expect(a.text).not.toBe(b.text);
    const ideas = nextIdeas(new Set());
    expect(new Set(Array.from({ length: ideas.length * 2 }, (_, i) => songTip(p, { shared: true, idea: i }).text)).size).toBe(ideas.length);
    // A Melody that can be added comes first.
    expect(nextIdeas(new Set(['lead']))[0]).toBe('Add a melody: press + Add instrument, then Melody');
  });
});

describe('Make it longer: an intro and an ending only while the song has none', () => {
  it('House has an intro and no ending; after Add an ending it has both', () => {
    const store = house();
    expect(songEdges(store.getState())).toEqual({ intro: true, ending: false });
    expect(cmd.addEnding(store, { plain: true }).changed).toBe(true);
    expect(songEdges(store.getState())).toEqual({ intro: true, ending: true });
    expect(songEdges(blank().getState())).toEqual({ intro: false, ending: false });
  });

  it('a second intro (Advanced) plays first and is called Intro; the old one is Intro 2; it is built from the main part', () => {
    const store = house();
    const before = store.getState();
    const intro = sortSections(before.arrangement.sections)[0];
    expect(intro.name).toBe('Intro');
    const r = cmd.addIntro(store);
    expect(r.changed).toBe(true);
    const after = store.getState();
    expect(names(after).slice(0, 3)).toEqual(['Intro', 'Intro 2', 'Groove']);
    // Built from the main part's loops (House: Lift, the most music), not from the old intro's build-up.
    const made = after.arrangement.regions.filter((x) => r.ids!.includes(x.id));
    const main = mainSection(before)!;
    const mainClips = new Set(before.arrangement.regions.filter((x) => x.start < regionEnd(main) && regionEnd(x) > main.start).map((x) => x.clipId));
    const introClips = new Set(before.arrangement.regions.filter((x) => x.start < regionEnd(intro) && regionEnd(x) > intro.start).map((x) => x.clipId));
    expect(made.length).toBeGreaterThan(introClips.size);
    expect(made.every((x) => mainClips.has(x.clipId))).toBe(true);
  });
});

describe('Make it shorter', () => {
  it('offers the last section and the one at the playhead, never the only one', () => {
    const p = house().getState();
    const sorted = sortSections(p.arrangement.sections);
    const last = sorted[sorted.length - 1];
    expect(shorterChoices(p, sorted[1].start).last?.id).toBe(last.id);
    expect(shorterChoices(p, sorted[1].start).here?.id).toBe(sorted[1].id);
    // The playhead in the last section: one choice.
    expect(shorterChoices(p, last.start).here).toBeNull();
    const one = { ...p, arrangement: { ...p.arrangement, sections: [sorted[0]] } };
    expect(shorterChoices(one, 0)).toEqual({ last: null, here: null });
  });
});

describe('a loop dropped from LOOPS in Simple', () => {
  it('lands at the start of the section under the pointer, never leaving silence at its start', () => {
    const p = house().getState();
    const s = sortSections(p.arrangement.sections);
    expect(simpleDropBar(p, s[1].start + 5)).toBe(s[1].start);
    expect(simpleDropBar(p, s[2].start)).toBe(s[2].start);
    // Past the song's end: right after its music.
    expect(simpleDropBar(p, regionEnd(s[s.length - 1]) + 10)).toBe(regionEnd(s[s.length - 1]));
  });
  it('a song without sections (a 1-bar beat): at the start of its music', () => {
    const store = blank();
    cmd.addLoopToSong(store, tid(store.getState(), 'drums'), 0, { bars: 1, notes: notes(1, 0) });
    expect(simpleDropBar(store.getState(), 4)).toBe(0);
    expect(simpleDropBar(blank().getState(), 7)).toBe(0);
  });
});

describe('repeat follows a stretch inside a section that moved', () => {
  it('a marked stretch inside the last section moved to the front goes with it, and back on Undo', () => {
    const store = house();
    const s = sortSections(store.getState().arrangement.sections);
    const lastS = s[s.length - 1];
    const loop = { fromBar: lastS.start + 1, toBar: lastS.start + 2 };
    const prev = store.getState();
    expect(cmd.reorderSection(store, lastS.id, s[0].id).changed).toBe(true);
    const moved = followSongLoop(prev, store.getState(), loop, store.lastChange().time);
    const now = store.getState().arrangement.sections.find((x) => x.id === lastS.id)!;
    expect(now.start).toBe(0);
    expect(moved).toEqual({ fromBar: now.start + 1, toBar: now.start + 2 });
    const after = store.getState();
    store.undo();
    expect(followSongLoop(after, store.getState(), moved!, store.lastChange().time)).toEqual(loop);
    // A move undone is the same bars moved back.
    expect(invertShifts([{ at: 4, bars: -2 }, { at: 0, bars: 2, moved: true }])).toEqual([
      { at: 0, bars: -2 },
      { at: 4, bars: 2, moved: true },
    ]);
  });
});

describe('a ready-made loop grows only what played it once', () => {
  it('a loop shortened on purpose stays as it is when its length did not change', () => {
    const store = blank();
    const drums = tid(store.getState(), 'drums');
    const added = cmd.addLoopToSong(store, drums, 0, { bars: 4, notes: notes(4, 0) });
    cmd.resizeRegions(store, [added.regionId!], 'end', -2);
    expect(cmd.fitSongToLoop(store, drums, added.clipId!, 4).changed).toBe(false);
    expect(store.getState().arrangement.regions.find((r) => r.id === added.regionId)!.bars).toBe(2);
  });
  it('a loop that got longer grows the places that played it once', () => {
    const store = blank();
    const drums = tid(store.getState(), 'drums');
    const added = cmd.addLoopToSong(store, drums, 0, { bars: 1, notes: notes(1, 0) });
    const slot = slotOfClip(store.getState().tracks.find((t) => t.id === drums)!, added.clipId!);
    cmd.repeatClipToBars(store, drums, slot, 2);
    expect(cmd.fitSongToLoop(store, drums, added.clipId!, 1).changed).toBe(true);
    expect(store.getState().arrangement.regions.find((r) => r.id === added.regionId)!.bars).toBe(2);
    expect(songBars(store.getState())).toBe(2);
  });
});

describe('small things', () => {
  it('a song of empty loops makes no sound (Share offers no file)', () => {
    const store = blank();
    cmd.addLoopToSong(store, tid(store.getState(), 'drums'), 0, { bars: 1 });
    expect(songHasSound(store.getState())).toBe(false);
    expect(songHasSound(house().getState())).toBe(true);
  });
  it('Simple Help names E, the key that opens a loop in the editor', () => {
    const song = SIMPLE_SHORTCUT_GROUPS.find((g) => g.id === 'song');
    expect(song?.items.some((i) => i.keys.includes('E') && /editor/.test(i.does))).toBe(true);
  });
});
