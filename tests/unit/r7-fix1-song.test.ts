/**
 * Round 7 fix 1 (the beginner re-test): the song rules behind Simple's
 * "Make it longer", "Repeat this part" and the tip line.
 *
 * - Repeat follows the music it repeated through every edit that moves the
 *   song (an intro, a new part, bars in or out, Undo and Redo), or goes off
 *   when nothing of it is left: never another part of the song.
 * - Make it longer builds a real song from a 1-bar beat: a main part, an
 *   intro and an ending that are lighter, new parts in order (Verse, then
 *   Chorus), each made of the main part's music; three presses ≈ 1 minute.
 * - A loop that gets longer (a ready-made loop) plays through in the song.
 * - The tip line: beat → bass → chords → longer → share, Share only for a
 *   song of 45 s or more with 3 instruments; a ready-made song first says
 *   to try its loops.
 */
import { describe, expect, it } from 'vitest';
import { BLANK_STARTER, getStarter } from '../../src/content/starters';
import { instrumentRange, isUntouchedStarter, songSeconds, songTip } from '../../src/app/views/arrange/songHome';
import { invertShifts, mainSection, musicPerBar, regionEnd, shiftRange, songBars, sortSections } from '../../src/project/arrangement';
import { slotOfClip } from '../../src/project/clips';
import { TICKS_PER_BEAT, type Note, type Project, type TrackRole } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { followSongLoop } from '../../src/time/songLoop';

const tid = (p: Project, role: TrackRole) => p.tracks.find((t) => t.role === role)!.id;

/** One note per beat over `bars` bars (for drums `pitch` is the kit voice: 0 is the kick). */
function notes(bars: number, pitch: number): Omit<Note, 'id'>[] {
  return Array.from({ length: bars * 4 }, (_, i) => ({ tick: i * TICKS_PER_BEAT, pitch, velocity: 100, duration: TICKS_PER_BEAT / 2 }));
}

/** "Make a beat from scratch" then + Add instrument twice: a 1-bar drum loop, a 1-bar bass and 1-bar chords at bar 1, no sections. */
function beat(): ProjectStore {
  const store = new ProjectStore(BLANK_STARTER.build());
  const p = store.getState();
  cmd.addLoopToSong(store, tid(p, 'drums'), 0, { bars: 1, notes: notes(1, 0) });
  cmd.addLoopToSong(store, tid(p, 'bass'), 0, { bars: 1, notes: notes(1, 36) });
  cmd.addLoopToSong(store, tid(p, 'chords'), 0, { bars: 1, notes: notes(1, 60) });
  store.clearHistory();
  return store;
}

const names = (p: Project) => sortSections(p.arrangement.sections).map((s) => s.name);
const section = (p: Project, name: string) => p.arrangement.sections.find((s) => s.name === name)!;
/** The instruments that play somewhere in a section. */
const playingIn = (p: Project, name: string) => {
  const s = section(p, name);
  return new Set(p.arrangement.regions.filter((r) => r.start < regionEnd(s) && regionEnd(r) > s.start).map((r) => p.tracks.find((t) => t.id === r.trackId)!.role));
};

describe('time shifts', () => {
  it('move a range with the music, grow it from inside, and give it up when its bars go', () => {
    expect(shiftRange([{ at: 0, bars: 8 }], 0, 1)).toEqual([8, 9]);
    expect(shiftRange([{ at: 4, bars: 2 }], 0, 4)).toEqual([0, 4]);
    expect(shiftRange([{ at: 2, bars: 2 }], 0, 4)).toEqual([0, 6]);
    expect(shiftRange([{ at: 0, bars: -2 }], 4, 8)).toEqual([2, 6]);
    expect(shiftRange([{ at: 4, bars: -4 }], 4, 8)).toBeNull();
    expect(shiftRange([{ at: 6, bars: -4 }], 4, 8)).toEqual([4, 6]);
    const there = [{ at: 0, bars: 8 }, { at: 20, bars: 4 }];
    expect(shiftRange(invertShifts(there), ...(shiftRange(there, 2, 6) as [number, number]))).toEqual([2, 6]);
  });

  it('are recorded with the edit, reversed by Undo and given again by Redo', () => {
    const store = beat();
    cmd.addIntro(store, { plain: true });
    const made = store.lastChange().time!;
    expect(made.length).toBeGreaterThan(0);
    store.undo();
    expect(store.lastChange()).toMatchObject({ kind: 'undo', time: invertShifts(made) });
    store.redo();
    expect(store.lastChange()).toMatchObject({ kind: 'redo', time: made });
    const r = cmd.insertBars(store, 2, 3);
    expect(r.changed).toBe(true);
    expect(store.lastChange().time).toEqual([{ at: 2, bars: 3 }]);
  });
});

describe('Repeat this part follows the music', () => {
  it('Add an intro while repeating the whole beat: still the whole song (the intro is heard, then the beat)', () => {
    const store = beat();
    const before = store.getState();
    cmd.addIntro(store, { plain: true });
    const after = store.getState();
    const loop = followSongLoop(before, after, { fromBar: 0, toBar: 1 }, store.lastChange().time);
    expect(loop).toEqual({ fromBar: 0, toBar: songBars(after) });
  });

  it('a repeated section moves with its music when an intro goes in before it, and back with Undo', () => {
    const p = getStarter('house')!.build();
    const groove = p.arrangement.sections.find((s) => s.name === 'Groove')!;
    const store = new ProjectStore(p);
    const loop = { fromBar: groove.start, toBar: regionEnd(groove) };
    cmd.addIntro(store, { plain: true });
    const moved = followSongLoop(p, store.getState(), loop, store.lastChange().time)!;
    const now = store.getState().arrangement.sections.find((s) => s.id === groove.id)!;
    expect(moved).toEqual({ fromBar: now.start, toBar: regionEnd(now) });
    expect(moved.fromBar).toBeGreaterThan(loop.fromBar);
    const mid = store.getState();
    store.undo();
    expect(followSongLoop(mid, store.getState(), moved, store.lastChange().time)).toEqual(loop);
  });

  it('every command that moves the song moves a range of bars with it', () => {
    const p = getStarter('house')!.build();
    const sorted = sortSections(p.arrangement.sections);
    const last = sorted[sorted.length - 1];
    // A range that is no section: two bars inside the last section.
    const loop = { fromBar: last.start + 1, toBar: last.start + 3 };
    const edits: [string, (s: ProjectStore) => unknown][] = [
      ['insert bars', (s) => cmd.insertBars(s, 0, 2)],
      ['remove bars', (s) => cmd.removeBars(s, 0, 2)],
      ['intro', (s) => cmd.addIntro(s, { plain: true })],
      ['duplicate', (s) => cmd.duplicateSection(s, sorted[0].id)],
      ['grow again', (s) => cmd.growSong(s, 'again')],
      ['delete with music', (s) => cmd.removeSection(s, sorted[0].id, { withMusic: true })],
      ['move later', (s) => cmd.moveSectionStep(s, sorted[0].id, 1)],
    ];
    for (const [what, edit] of edits) {
      const store = new ProjectStore(p);
      edit(store);
      const after = store.getState();
      const moved = followSongLoop(p, after, loop, store.lastChange().time);
      // The same section (by id) is under it, the same bars into it.
      const s = after.arrangement.sections.find((x) => x.id === last.id)!;
      expect(moved, what).toEqual({ fromBar: s.start + 1, toBar: s.start + 3 });
    }
  });

  it('goes off when the bars it repeated are taken out', () => {
    const store = beat();
    cmd.insertBars(store, 0, 4);
    const before = store.getState();
    cmd.removeBars(store, 4, 5);
    expect(followSongLoop(before, store.getState(), { fromBar: 4, toBar: 5 }, store.lastChange().time)).toBeNull();
  });

  it('stays where it is (the same object) for edits that move no time', () => {
    const p = getStarter('house')!.build();
    const store = new ProjectStore(p);
    const r = p.arrangement.regions[3];
    cmd.moveRegions(store, [r.id], 1);
    const loop = { fromBar: 1, toBar: 3 };
    expect(followSongLoop(p, store.getState(), loop, store.lastChange().time)).toBe(loop);
  });
});

describe('Make it longer builds a song from a 1-bar beat', () => {
  it('three presses (intro, a part after, ending): about a minute, in order, each part heard', () => {
    const store = beat();
    expect(cmd.addIntro(store, { plain: true }).changed).toBe(true);
    const r = cmd.growSong(store, 'after');
    expect([r.name, r.from, r.after]).toEqual(['Chorus', 'Verse', 'Verse']);
    expect(cmd.addEnding(store, { plain: true }).changed).toBe(true);
    const p = store.getState();
    expect(names(p)).toEqual(['Intro', 'Verse', 'Chorus', 'Ending']);
    expect(songSeconds(p)).toBeGreaterThanOrEqual(55);
    expect(songSeconds(p)).toBeLessThanOrEqual(70);
    // Every part plays; the main parts have all three instruments, the intro and ending fewer per bar.
    for (const n of ['Intro', 'Verse', 'Chorus', 'Ending']) expect(playingIn(p, n).size, n).toBeGreaterThan(0);
    expect(playingIn(p, 'Verse')).toEqual(new Set(['drums', 'bass', 'chords']));
    expect(playingIn(p, 'Chorus')).toEqual(new Set(['drums', 'bass', 'chords']));
    const per = (n: string) => musicPerBar(p.arrangement.regions, section(p, n));
    expect(per('Chorus')).toBe(3);
    expect(per('Intro')).toBeLessThan(3);
    expect(per('Ending')).toBeLessThan(3);
    expect(mainSection(p)!.name).toBe('Verse');
    expect(store.historySize().undo).toBe(3);
    const v = validateProject(p);
    expect(v.ok && v.warnings).toEqual([]);
  });

  it('the beat itself becomes an 8-bar Verse the first time, in the same step', () => {
    const store = beat();
    cmd.growSong(store, 'again');
    const p = store.getState();
    expect(names(p)).toEqual(['Verse', 'Verse']);
    expect(sortSections(p.arrangement.sections).map((s) => s.bars)).toEqual([8, 8]);
    expect(store.historySize().undo).toBe(1);
  });

  it('new parts go after the main parts and before the ending, in name order', () => {
    const store = beat();
    cmd.addIntro(store, { plain: true });
    cmd.addEnding(store, { plain: true });
    for (let i = 0; i < 3; i++) cmd.growSong(store, 'after');
    expect(names(store.getState())).toEqual(['Intro', 'Verse', 'Chorus', 'Bridge', 'Verse 2', 'Ending']);
    expect(store.historySize().undo).toBe(5);
    // "Repeat … again" repeats the main part, not the intro the playhead may be on.
    expect(cmd.growSong(store, 'again').from).toBe('Verse');
  });

  it('names music that has no section (a song from before this round) before it grows', () => {
    const store = beat();
    cmd.addIntro(store); // Advanced's intro leaves the beat without a section.
    expect(names(store.getState())).toEqual(['Intro']);
    const r = cmd.growSong(store, 'after');
    expect(r.from).toBe('Verse');
    expect(names(store.getState())).toEqual(['Intro', 'Verse', 'Chorus']);
  });
});

describe('a loop that gets longer plays through', () => {
  it('its regions grow to one pass, and in a song without sections the others play on with it', () => {
    const store = beat();
    const p = store.getState();
    const chords = tid(p, 'chords');
    const region = p.arrangement.regions.find((r) => r.trackId === chords)!;
    const slot = slotOfClip(p.tracks.find((t) => t.id === chords)!, region.clipId);
    cmd.setClipBars(store, chords, slot, 4);
    expect(cmd.fitSongToLoop(store, chords, region.clipId).changed).toBe(true);
    const after = store.getState();
    expect(after.arrangement.regions.map((r) => r.bars)).toEqual([4, 4, 4]);
    expect(songBars(after)).toBe(4);
  });

  it('inside a section it grows only to the section’s end', () => {
    const store = beat();
    cmd.growSong(store, 'again'); // Verse 0–8, Verse 8–16, each one loop of 8 bars per instrument.
    const p = store.getState();
    const chords = tid(p, 'chords');
    // A 2-bar region at bar 7 of a 1-bar loop that becomes 4 bars: it may grow to bar 8, no further.
    const r0 = p.arrangement.regions.find((r) => r.trackId === chords)!;
    cmd.resizeRegions(store, [r0.id], 'end', -2); // 0–6
    const added = cmd.addLoopToSong(store, chords, 6, { bars: 1, notes: notes(1, 64) });
    const slot = added.slot!;
    cmd.setClipBars(store, chords, slot, 4);
    cmd.fitSongToLoop(store, chords, added.clipId!);
    const grown = store.getState().arrangement.regions.find((r) => r.id === added.regionId)!;
    expect([grown.start, regionEnd(grown)]).toEqual([6, 8]);
  });
});

describe('the tip line', () => {
  const song = (roles: TrackRole[], bars: number): Project => {
    const p = BLANK_STARTER.build();
    const store = new ProjectStore(p);
    for (const role of roles) cmd.addLoopToSong(store, tid(p, role), 0, { bars: 1, notes: notes(1, role === 'drums' ? 0 : 48) });
    const q = store.getState();
    return { ...q, arrangement: { ...q.arrangement, regions: q.arrangement.regions.map((r) => ({ ...r, bars })) } };
  };

  it('goes beat → bass → chords → longer → share', () => {
    expect(songTip(song(['chords'], 1)).step).toBe('beat');
    expect(songTip(song(['drums'], 1)).step).toBe('bass');
    expect(songTip(song(['drums', 'bass'], 1))).toEqual({ step: 'chords', text: 'Add chords: press + Add instrument, then Keys & chords' });
    expect(songTip(song(['drums', 'bass', 'chords'], 1)).step).toBe('longer');
    // 22 bars at 120 BPM: 44 s, still too short to share.
    expect(songTip(song(['drums', 'bass', 'chords'], 22)).step).toBe('longer');
    expect(songTip(song(['drums', 'bass', 'chords'], 23))).toEqual({ step: 'share', text: 'Share your song: press Share at the top right' });
    // A melody counts as the tune step.
    expect(songTip(song(['drums', 'bass', 'lead'], 23)).step).toBe('share');
  });

  it('never offers Share for a song under 45 s or with fewer than 3 instruments', () => {
    for (const roles of [['drums'], ['drums', 'bass'], ['drums', 'chords']] as TrackRole[][]) {
      for (const bars of [1, 8, 30]) expect(songTip(song(roles, bars)).step, `${roles} ${bars}`).not.toBe('share');
    }
  });

  it('right after Jump In: try a loop first; once the song is changed, the usual steps', () => {
    const p = getStarter('house')!.build();
    expect(isUntouchedStarter(p)).toBe(true);
    expect(songTip(p, { fresh: isUntouchedStarter(p) })).toEqual({ step: 'try', text: 'Click any loop in your song to change its notes' });
    // With the loop editor open the step is done.
    expect(songTip(p, { fresh: true, editorOpen: true }).step).toBe('share');
    const store = new ProjectStore(p);
    cmd.moveRegions(store, [p.arrangement.regions[0].id], 1);
    expect(isUntouchedStarter(store.getState())).toBe(false);
    expect(isUntouchedStarter(BLANK_STARTER.build())).toBe(false);
  });
});

describe('+ Add instrument', () => {
  it('plays over the main parts, not only where the playhead is (the intro and ending stay lighter)', () => {
    const store = beat();
    cmd.addIntro(store, { plain: true });
    cmd.growSong(store, 'after');
    cmd.addEnding(store, { plain: true });
    const p = store.getState();
    const range = instrumentRange(p, 0);
    const verse = section(p, 'Verse');
    const chorus = section(p, 'Chorus');
    expect([range.start, range.start + range.bars!]).toEqual([verse.start, regionEnd(chorus)]);
  });

  it('a song without sections: over all of its music', () => {
    const p = beat().getState();
    expect(instrumentRange(p, 0)).toEqual({ start: 0, bars: 1, name: null });
    const empty = BLANK_STARTER.build();
    expect(instrumentRange(empty, 3.5)).toEqual({ start: 3, bars: null, name: null });
  });
});
