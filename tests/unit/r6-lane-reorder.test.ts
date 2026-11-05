/**
 * Reordering sections (ripple, like GarageBand's arrangement track): the pure
 * rule (project/arrangement reorderSection, reorderTarget) and the commands
 * (reorderSection, moveSectionStep). A moved section takes its music with it,
 * the bars between close up, nothing is cut, the song keeps its length, and
 * every bar still plays exactly what it played (only the order changes).
 */
import { describe, expect, it } from 'vitest';
import { clipBarAt, clipBarsOf, regionAt, reorderSection, reorderTarget, songBars, timelineBars } from '../../src/project/arrangement';
import type { Id, Project, SongSection } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { expectRefused, expectValid, sections, sketch, songStore } from './r5-song-fixtures';

let n = 0;
const newId = () => `new${++n}`;

/** What part `trackId` plays in bar `bar`: "clip:bar-in-clip", or "-" for silence. */
function playsAt(p: Project, trackId: Id, bar: number): string {
  const r = regionAt(p.arrangement.regions, trackId, bar + 0.5);
  return r ? `${r.clipId}:${clipBarAt(r, clipBarsOf(p, r), bar)}` : '-';
}

/** Every part's bars, as heard. */
function heard(p: Project, bars: number): string[][] {
  return p.tracks.map((t) => Array.from({ length: bars }, (_, b) => playsAt(p, t.id, b)));
}

/** Old bar order after moving bars [a, b) to before bar `target` (target outside [a, b]). */
function reorderBars(total: number, a: number, b: number, target: number): number[] {
  const all = Array.from({ length: total }, (_, i) => i);
  const block = all.slice(a, b);
  const rest = all.filter((i) => i < a || i >= b);
  const at = target < a ? target : target - (b - a);
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * Intro 0–4, Groove 4–12, Lift 12–16 and loops that cross the section edges:
 * Bounce (4-bar clip) from bar 2 to 10 crosses Intro→Groove, Wash (8 bars)
 * from 8 to 14 crosses Groove→Lift, Beat everywhere 0–16 (2-bar clip).
 */
function crossing() {
  const { store, clip } = songStore();
  cmd.addRegions(store, [
    { trackId: 't1', clipId: clip.Beat, start: 0, bars: 16 },
    { trackId: 't3', clipId: clip.Bounce, start: 2, bars: 8 },
    { trackId: 't6', clipId: clip.Wash, start: 8, bars: 6, offset: 1 },
    { trackId: 't5', clipId: clip.Riff, start: 12, bars: 3 },
  ]);
  cmd.addSection(store, 0, 4, 'Intro');
  cmd.addSection(store, 4, 8, 'Groove');
  cmd.addSection(store, 12, 4, 'Lift');
  store.clearHistory();
  const id = (name: string) => store.getState().arrangement.sections.find((s) => s.name === name)!.id;
  return { store, clip, id };
}

describe('reorderSection (pure)', () => {
  it('moves a section earlier with its music; the bars between close up; nothing is cut', () => {
    const { store, id } = crossing();
    const p = store.getState();
    const res = reorderSection(p, p.arrangement.regions, p.arrangement.sections, id('Lift'), id('Groove'), newId)!;
    expect(res.sections.map((s) => `${s.name}@${s.start}+${s.bars}`)).toEqual(['Intro@0+4', 'Lift@4+4', 'Groove@8+8']);
    expect(res.section).toMatchObject({ name: 'Lift', start: 4, bars: 4 });
    expect(res.delta).toBe(-8);
    const after: Project = { ...p, arrangement: { ...p.arrangement, regions: res.regions, sections: res.sections } };
    // Same length; every bar plays what the bar it came from played.
    expect(songBars(after)).toBe(songBars(p));
    expect(timelineBars(after)).toBe(timelineBars(p));
    const order = reorderBars(16, 12, 16, 4);
    const was = heard(p, 16);
    const now = heard(after, 16);
    for (let t = 0; t < was.length; t++) expect(now[t], p.tracks[t].name).toEqual(order.map((b) => was[t][b]));
    // The loops that start in Lift came along (the Riff, and the pieces of Beat and Wash in it).
    expect(res.moved.every((r) => r.start >= 4 && r.start < 8)).toBe(true);
    expect(res.moved.some((r) => r.trackId === 't5')).toBe(true);
  });

  it('moves a section later (to before another, or to the end), splitting loops at its edges', () => {
    const { store, id } = crossing();
    const p = store.getState();
    const end = reorderSection(p, p.arrangement.regions, p.arrangement.sections, id('Intro'), null, newId)!;
    expect(end.sections.map((s) => `${s.name}@${s.start}+${s.bars}`)).toEqual(['Groove@0+8', 'Lift@8+4', 'Intro@12+4']);
    const after: Project = { ...p, arrangement: { ...p.arrangement, regions: end.regions, sections: end.sections } };
    const order = reorderBars(16, 0, 4, 16);
    const was = heard(p, 16);
    const now = heard(after, 16);
    for (let t = 0; t < was.length; t++) expect(now[t]).toEqual(order.map((b) => was[t][b]));
    // Bounce crossed Intro's end: its piece in Intro moved, the rest stayed with Groove (in phase).
    const bounce = end.regions.filter((r) => r.trackId === 't3').map((r) => `${r.start}+${r.bars}~${r.offset}`);
    expect(bounce).toEqual(['0+6~2', '14+2~0']);
  });

  it('joins the pieces of one loop that meet again in phase, never separate loops', () => {
    const { store, id, clip } = crossing();
    const p = store.getState();
    // Groove to the end: Beat (one loop, 0–16) is cut at 4 and 12; its pieces meet again in phase (2-bar clip).
    const one = reorderSection(p, p.arrangement.regions, p.arrangement.sections, id('Groove'), null, newId)!;
    expect(one.regions.filter((r) => r.trackId === 't1').map((r) => `${r.start}+${r.bars}~${r.offset}`)).toEqual(['0+16~0']);
    // Moved back: the sections and every bar are as they were.
    const back = reorderSection(p, one.regions, one.sections, id('Groove'), id('Lift'), newId)!;
    expect(back.sections).toEqual(p.arrangement.sections);
    const after: Project = { ...p, arrangement: { ...p.arrangement, regions: back.regions, sections: back.sections } };
    expect(heard(after, 16)).toEqual(heard(p, 16));
    // Two loops of the same clip that end up touching stay two loops.
    const two = [
      { id: 'a', trackId: 't2', clipId: clip.Shaker, start: 0, bars: 4, offset: 0 },
      { id: 'b', trackId: 't2', clipId: clip.Shaker, start: 12, bars: 4, offset: 0 },
    ];
    const res = reorderSection(p, two, p.arrangement.sections, id('Lift'), id('Groove'), newId)!;
    expect(res.regions.map((r) => `${r.id}@${r.start}+${r.bars}`)).toEqual(['a@0+4', 'b@4+4']);
  });

  it('changes nothing when the section is already there, or for unknown ids', () => {
    const { store, id } = crossing();
    const p = store.getState();
    const { regions, sections: secs } = p.arrangement;
    expect(reorderSection(p, regions, secs, id('Intro'), id('Groove'), newId)).toBeNull();
    expect(reorderSection(p, regions, secs, id('Lift'), null, newId)).toBeNull();
    expect(reorderSection(p, regions, secs, id('Lift'), id('Lift'), newId)).toBeNull();
    expect(reorderSection(p, regions, secs, 'nope', null, newId)).toBeNull();
    expect(reorderSection(p, regions, secs, id('Intro'), 'nope', newId)).toBeNull();
  });

  it('bars no section covers move with the bars they are among', () => {
    // A 0–4, nothing 4–6, B 6–10; B moved before A: A and the free bars after it move 4 later.
    const s: SongSection[] = [
      { id: 'A', name: 'A', start: 0, bars: 4 },
      { id: 'B', name: 'B', start: 6, bars: 4 },
    ];
    const { store, clip } = songStore();
    const p = store.getState();
    const regions = [{ id: 'x', trackId: 't2', clipId: clip.Shaker, start: 4, bars: 2, offset: 0 }];
    const res = reorderSection(p, regions, s, 'B', 'A', newId)!;
    expect(res.sections.map((x) => `${x.id}@${x.start}+${x.bars}`)).toEqual(['B@0+4', 'A@4+4']);
    expect(res.regions.map((r) => `${r.id}@${r.start}`)).toEqual(['x@8']);
  });
});

describe('reorderTarget', () => {
  const secs: SongSection[] = [
    { id: 'A', name: 'A', start: 0, bars: 4 },
    { id: 'B', name: 'B', start: 4, bars: 8 },
    { id: 'C', name: 'C', start: 12, bars: 4 },
  ];
  it('goes before the first section whose middle is past the dragged middle', () => {
    expect(reorderTarget(secs, 'C', 0)).toEqual({ before: null, same: true });
    expect(reorderTarget(secs, 'C', -5)).toEqual({ before: null, same: true });
    expect(reorderTarget(secs, 'C', -7)).toEqual({ before: 'B', same: false });
    expect(reorderTarget(secs, 'C', -13)).toEqual({ before: 'A', same: false });
    expect(reorderTarget(secs, 'A', 3)).toEqual({ before: 'B', same: true });
    expect(reorderTarget(secs, 'A', 7)).toEqual({ before: 'C', same: false });
    expect(reorderTarget(secs, 'A', 13)).toEqual({ before: null, same: false });
    expect(reorderTarget(secs, 'Z', 0)).toBeNull();
  });
});

describe('reorderSection / moveSectionStep (commands)', () => {
  it('is one undo step with plain words; Undo puts everything back', () => {
    const { store, id } = crossing();
    const before = store.getState();
    const r = cmd.reorderSection(store, id('Lift'), id('Intro'));
    expect(r).toMatchObject({ changed: true, sectionId: id('Lift') });
    expect(r.ids!.length).toBeGreaterThan(0);
    expect(store.undoLabel()).toBe('Move Lift before Intro');
    expect(store.historySize().undo).toBe(1);
    expect(sections(store.getState())).toEqual(['Lift@0+4', 'Intro@4+4', 'Groove@8+8']);
    expectValid(store.getState());
    store.undo();
    expect(sketch(store.getState())).toEqual(sketch(before));
    expect(sections(store.getState())).toEqual(sections(before));
  });

  it('to the end says so; already there changes nothing and leaves no step', () => {
    const { store, id } = crossing();
    expect(cmd.reorderSection(store, id('Intro'), null).changed).toBe(true);
    expect(store.undoLabel()).toBe('Move Intro to the end');
    const steps = store.historySize().undo;
    expect(cmd.reorderSection(store, id('Intro'), null)).toEqual({ changed: false });
    expect(store.historySize().undo).toBe(steps);
    expectRefused(store, () => cmd.reorderSection(store, 'gone', null), 'not-found');
    expectRefused(store, () => cmd.reorderSection(store, id('Intro'), 'gone'), 'not-found');
  });

  it('Move earlier / Move later step one place, and say when there is no place to go', () => {
    const { store, id } = crossing();
    expect(cmd.moveSectionStep(store, id('Groove'), -1).changed).toBe(true);
    expect(store.undoLabel()).toBe('Move Groove earlier');
    expect(sections(store.getState())).toEqual(['Groove@0+8', 'Intro@8+4', 'Lift@12+4']);
    expect(cmd.moveSectionStep(store, id('Intro'), 1).changed).toBe(true);
    expect(store.undoLabel()).toBe('Move Intro later');
    expect(sections(store.getState())).toEqual(['Groove@0+8', 'Lift@8+4', 'Intro@12+4']);
    expectValid(store.getState());
    expectRefused(store, () => cmd.moveSectionStep(store, id('Groove'), -1), 'invalid');
    expectRefused(store, () => cmd.moveSectionStep(store, id('Intro'), 1), 'invalid');
    expect(cmd.moveSectionStep(store, id('Intro'), 1).message).toBe('Intro is already the last section.');
  });
});
