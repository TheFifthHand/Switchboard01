/**
 * Song helpers on sections (build up, strip down, breakdown), with the plain
 * words they give when they would do nothing, and "Add an intro" / "Add an
 * ending". Helpers only cut loops at clip boundaries: everything stays in
 * phase and the song keeps its length.
 */
import { describe, expect, it } from 'vitest';
import { clipBarAt, regionAt, songBars } from '../../src/project/arrangement';
import { createProject } from '../../src/project/factory';
import { mulberry32 } from '../../src/project/rng';
import type { Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import * as cmd from '../../src/state/commands';
import { expectRefused, expectValid, sections, sketch, songStore } from './r5-song-fixtures';

/** A section "Drop" over bars [from, from + bars) and loops of these clips over [0, until). */
function drop(clips: [trackId: string, name: string][], bars = 16, until = bars, from = 0) {
  const { store, clip } = songStore();
  cmd.addRegions(store, clips.map(([trackId, name]) => ({ trackId, clipId: clip[name], start: 0, bars: until })));
  const id = cmd.addSection(store, from, bars, 'Drop').sectionId!;
  store.clearHistory();
  return { store, id };
}

const FULL: [string, string][] = [
  ['t1', 'Beat'],
  ['t3', 'Bounce'],
  ['t4', 'Stabs'],
  ['t6', 'Wash'],
];

describe('build up, strip down, breakdown', () => {
  it('build up: the parts come in one at a time in build order (pad, chords, bass, drums), each at its clip’s start', () => {
    const { store, id } = drop(FULL);
    expect(cmd.shapeProblem(store.getState(), id, 'build')).toBeNull();
    const r = cmd.shapeSection(store, id, 'build');
    expect(r).toMatchObject({ changed: true, trimmed: 3, removed: 0 });
    expect(sketch(store.getState())).toEqual(['t6:Wash@0+16~0', 't4:Stabs@4+12~0', 't3:Bounce@8+8~0', 't1:Beat@12+4~0']);
    expect(r.ids).toHaveLength(4);
    expect(store.undoLabel()).toBe('Build up Drop');
    expect(songBars(store.getState())).toBe(16);
    expectValid(store.getState());
    store.undo();
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+16~0', 't3:Bounce@0+16~0', 't4:Stabs@0+16~0', 't6:Wash@0+16~0']);
  });

  it('strip down: every part first, then they drop out one at a time (the drums first), each after whole clips', () => {
    const { store, id } = drop(FULL);
    cmd.shapeSection(store, id, 'strip');
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+4~0', 't3:Bounce@0+8~0', 't4:Stabs@0+12~0', 't6:Wash@0+16~0']);
    expect(store.undoLabel()).toBe('Strip down Drop');
    expectValid(store.getState());
  });

  it('breakdown: the drums, percussion and bass leave the section', () => {
    const { store, id } = drop(FULL);
    expect(cmd.shapeSection(store, id, 'breakdown')).toMatchObject({ changed: true, removed: 2, trimmed: 0 });
    expect(sketch(store.getState())).toEqual(['t4:Stabs@0+16~0', 't6:Wash@0+16~0']);
    expect(store.undoLabel()).toBe('Breakdown in Drop');
    expectValid(store.getState());
  });

  it('only the section’s bars change: loops going on after it keep playing, in phase', () => {
    // Loops over bars 0–24, the section over 8–24.
    const { store, id } = drop(FULL, 16, 24, 8);
    cmd.shapeSection(store, id, 'build');
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't3:Bounce@0+8~0', 't4:Stabs@0+8~0', 't6:Wash@0+24~0', 't4:Stabs@12+12~0', 't3:Bounce@16+8~0', 't1:Beat@20+4~0']);
    store.undo();
    cmd.shapeSection(store, id, 'strip');
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+12~0', 't3:Bounce@0+16~0', 't4:Stabs@0+20~0', 't6:Wash@0+24~0']);
    expectValid(store.getState());
    // Music after the section: carried on in its phase.
    const after = drop(FULL, 16, 24);
    cmd.shapeSection(after.store, after.id, 'strip');
    expect(sketch(after.store.getState())).toEqual(['t1:Beat@0+4~0', 't3:Bounce@0+8~0', 't4:Stabs@0+12~0', 't6:Wash@0+24~0', 't1:Beat@16+8~0', 't3:Bounce@16+8~0', 't4:Stabs@16+8~0']);
    expectValid(after.store.getState());
  });

  it('says in plain words why a helper would do nothing, and refuses it with nothing changed', () => {
    const quiet = drop([['t4', 'Stabs'], ['t6', 'Wash']]);
    expect(cmd.shapeProblem(quiet.store.getState(), quiet.id, 'breakdown')).toBe('No drums, percussion or bass play here.');
    expectRefused(quiet.store, () => cmd.shapeSection(quiet.store, quiet.id, 'breakdown'), 'invalid');
    const beat = drop([['t1', 'Beat'], ['t3', 'Bounce']]);
    expect(cmd.shapeProblem(beat.store.getState(), beat.id, 'breakdown')).toBe('Only drums, percussion and bass play here: a breakdown would leave silence.');
    const one = drop([['t6', 'Wash']]);
    expect(cmd.shapeProblem(one.store.getState(), one.id, 'build')).toBe('Only one part plays here: there is nothing to bring in one at a time.');
    expect(cmd.shapeProblem(one.store.getState(), one.id, 'strip')).toBe('Only one part plays here: there is nothing to drop out one at a time.');
    const none = drop([], 8);
    expect(cmd.shapeProblem(none.store.getState(), none.id, 'build')).toBe('No part plays here.');
    // Two 4-bar clips in a 4-bar section: no clip boundary to bring the second in at.
    const short = drop([['t3', 'Bounce'], ['t4', 'Stabs']], 4);
    expect(cmd.shapeProblem(short.store.getState(), short.id, 'build')).toBe('The clips here are as long as the section, so the parts cannot come in one at a time: make the section longer first.');
    expectRefused(short.store, () => cmd.shapeSection(short.store, short.id, 'build'), 'invalid');
    expect(cmd.shapeProblem(short.store.getState(), 'sec_gone', 'build')).toBe('That section no longer exists.');
    expectRefused(short.store, () => cmd.shapeSection(short.store, 'sec_gone', 'build'), 'not-found');
  });
});

/** What part `trackId` plays at `bar`: "clip@phase", or null. */
function playsAt(p: Project, trackId: string, bar: number): string | null {
  const r = regionAt(p.arrangement.regions, trackId, bar);
  if (!r) return null;
  const clip = p.tracks.find((t) => t.id === trackId)!.clips.find((c) => c?.id === r.clipId)!;
  return `${r.clipId}@${clipBarAt(r, clip.bars, bar)}`;
}

describe('the helpers only take music away inside the section', () => {
  it('across random loops and sections: the song keeps its length, nothing changes outside the section, and what still plays inside plays as before; parts come in (or leave) where their clips start (or end)', () => {
    const rnd = mulberry32(99);
    const int = (n: number) => Math.floor(rnd() * n);
    const parts: [string, string[]][] = [
      ['t1', ['Beat', 'Fill']],
      ['t2', ['Shaker']],
      ['t3', ['Bounce', 'Walk']],
      ['t4', ['Stabs']],
      ['t5', ['Hook', 'Riff']],
      ['t6', ['Wash']],
    ];
    let shaped = 0;
    for (let round = 0; round < 150; round++) {
      const { store, clip } = songStore();
      for (const [trackId, names] of parts) {
        for (let at = int(4); at < 40; at += 1 + int(12)) {
          const bars = 1 + int(12);
          cmd.addRegions(store, [{ trackId, clipId: clip[names[int(names.length)]], start: at, bars, offset: int(8) }]);
          at += bars;
        }
      }
      const id = cmd.addSection(store, int(20), 2 + int(20), 'Part').sectionId!;
      for (const kind of ['build', 'strip', 'breakdown'] as const) {
        const before = store.getState();
        const sec = before.arrangement.sections[0];
        const problem = cmd.shapeProblem(before, id, kind);
        const r = cmd.shapeSection(store, id, kind);
        const after = store.getState();
        if (problem) {
          expect(r).toMatchObject({ changed: false, message: problem });
          expect(after).toBe(before);
          continue;
        }
        shaped++;
        expect(songBars(after)).toBe(songBars(before));
        for (const t of before.tracks) {
          for (let bar = 0; bar < songBars(before); bar++) {
            const was = playsAt(before, t.id, bar);
            const is = playsAt(after, t.id, bar);
            const inside = bar >= sec.start && bar < sec.start + sec.bars;
            if (!inside || is !== null) expect(is, `${kind} ${t.id} bar ${bar}`).toBe(was);
          }
          // A part comes in at the top of its clip, or leaves after a whole clip (unless it was cut at the section's edge).
          for (let bar = sec.start + 1; bar < sec.start + sec.bars; bar++) {
            const prev = playsAt(after, t.id, bar - 1);
            const now = playsAt(after, t.id, bar);
            if (kind === 'build' && prev === null && now !== null && playsAt(before, t.id, bar - 1) !== null) expect(now.endsWith('@0'), `${t.id} comes in at bar ${bar}`).toBe(true);
            if (kind === 'strip' && prev !== null && now === null && playsAt(before, t.id, bar) !== null) expect(playsAt(before, t.id, bar)!.endsWith('@0'), `${t.id} leaves at bar ${bar}`).toBe(true);
          }
        }
        expectValid(after);
        store.undo();
      }
    }
    expect(shaped).toBeGreaterThan(150);
  });
});

describe('an intro and an ending', () => {
  /** "Verse" over bars 0–8 with Beat, Stabs and Wash. */
  function verse() {
    const { store } = drop([['t1', 'Beat'], ['t4', 'Stabs'], ['t6', 'Wash']], 8);
    cmd.renameSection(store, store.getState().arrangement.sections[0].id, 'Verse');
    store.clearHistory();
    return store;
  }

  it('an intro: 4 to 8 bars before the song from its first section’s clips, the quieter parts first; the song moves later', () => {
    const store = verse();
    const r = cmd.addIntro(store);
    expect(r.changed).toBe(true);
    expect(sketch(store.getState())).toEqual(['t6:Wash@0+8~0', 't4:Stabs@4+4~0', 't1:Beat@6+2~0', 't1:Beat@8+8~0', 't4:Stabs@8+8~0', 't6:Wash@8+8~0']);
    expect(sections(store.getState())).toEqual(['Intro@0+8', 'Verse@8+8']);
    expect(r.sectionId).toBe(store.getState().arrangement.sections[0].id);
    expect(r.ids).toHaveLength(3);
    expect(store.historySize().undo).toBe(1);
    expect(store.undoLabel()).toBe('Add an intro');
    expectValid(store.getState());
  });

  it('an ending: 4 to 8 bars after the song from its last section’s clips, the drums dropping out first, fading out', () => {
    const store = verse();
    store.apply('test:no tail', (d) => void (d.arrangement.tailSeconds = 0));
    const r = cmd.addEnding(store);
    expect(r.changed).toBe(true);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't4:Stabs@0+8~0', 't6:Wash@0+8~0', 't1:Beat@8+2~0', 't4:Stabs@8+4~0', 't6:Wash@8+8~0']);
    expect(sections(store.getState())).toEqual(['Verse@0+8', 'Ending@8+8/fadeOut']);
    // The tail was off: the ending rings out.
    expect(store.getState().arrangement.tailSeconds).toBe(cmd.ENDING_TAIL_SECONDS);
    expect(store.undoLabel()).toBe('Add an ending');
    expectValid(store.getState());
  });

  it('a song without sections takes its first or last 8 bars; one part alone still makes an intro', () => {
    const { store, clip } = songStore();
    cmd.addClipToSong(store, 't1', clip.Beat, 0, 4);
    cmd.addIntro(store);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+4~0', 't1:Beat@4+4~0']);
    expect(sections(store.getState())).toEqual(['Intro@0+4']);
    expectValid(store.getState());
  });

  it('refused for an empty song, or when it would pass 512 bars', () => {
    const empty = new ProjectStore(createProject({ now: 0 }));
    expectRefused(empty, () => cmd.addIntro(empty), 'empty');
    expectRefused(empty, () => cmd.addEnding(empty), 'empty');
    const { store, clip } = songStore();
    cmd.addClipToSong(store, 't1', clip.Beat, 0, 510);
    expectRefused(store, () => cmd.addIntro(store), 'limit');
    expectRefused(store, () => cmd.addEnding(store), 'limit');
  });
});
