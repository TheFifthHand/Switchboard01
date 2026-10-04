/**
 * Song v4 commands (state/commands/arrangement.ts): placing, moving, copying,
 * resizing, splitting and removing loops; scenes and the whole set of scenes
 * as song material; inserting and removing bars; sections and their song
 * moves; the export tail. Each edit is one undo step with plain words, a
 * refusal changes nothing and leaves no step, and the song stays valid.
 */
import { describe, expect, it } from 'vitest';
import { removeTime } from '../../src/project/arrangement';
import { createProject } from '../../src/project/factory';
import type { SongRegion } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import * as cmd from '../../src/state/commands';
import { expectRefused, expectValid, sections, sketch, songStore } from './r5-song-fixtures';

/** A store with these loops already in the song (one undo step each, then the history cleared). */
function withLoops(list: [trackId: string, clip: string, start: number, bars: number, offset?: number][]) {
  const { store, clip } = songStore();
  const ids = list.map(([trackId, name, start, bars, offset]) => cmd.addRegions(store, [{ trackId, clipId: clip[name], start, bars, offset }]).ids![0]);
  store.clearHistory();
  return { store, clip, ids };
}

describe('placing loops', () => {
  it('a clip goes on its part’s row for its own length by default, and what lands on loops already there wins', () => {
    const { store, clip } = songStore();
    const a = cmd.addClipToSong(store, 't3', clip.Bounce, 0, 8);
    expect(a).toMatchObject({ changed: true, trimmed: 0, removed: 0 });
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+8~0']);
    expect(store.getState().arrangement.regions[0].id).toBe(a.ids![0]);
    expect(store.undoLabel()).toBe('Add Bounce');
    // Walk dropped into the middle of Bounce splits it; the second piece goes on in time (same phase).
    const b = cmd.addClipToSong(store, 't3', clip.Walk, 2);
    expect(b).toMatchObject({ changed: true, trimmed: 1, removed: 0 });
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+2~0', 't3:Walk@2+2~0', 't3:Bounce@4+4~0']);
    expect(store.undoLabel()).toBe('Add Walk');
    // Several at once: the later of two overlapping drafts wins; an offset is wrapped into its clip.
    const c = cmd.addRegions(store, [
      { trackId: 't1', clipId: clip.Beat, start: 0, bars: 4, offset: 3 },
      { trackId: 't1', clipId: clip.Fill, start: 2, bars: 1 },
      { trackId: 't3', clipId: clip.Walk, start: 0, bars: 8 },
    ]);
    expect(c).toMatchObject({ changed: true, removed: 3, trimmed: 0 });
    expect(c.ids).toHaveLength(3);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+2~1', 't3:Walk@0+8~0', 't1:Fill@2+1~0', 't1:Beat@3+1~0']);
    expect(store.undoLabel()).toBe('Add 3 loops');
    expectValid(store.getState());
    store.undo();
    store.undo();
    store.undo();
    expect(store.getState().arrangement.regions).toEqual([]);
  });

  it('refuses a missing part or clip, a clip of another part, positions off the bar lines and a song past 512 bars', () => {
    const { store, clip } = songStore();
    expectRefused(store, () => cmd.addClipToSong(store, 't3', clip.Beat, 0), 'not-found');
    expectRefused(store, () => cmd.addClipToSong(store, 't3', 'clip_gone', 0), 'not-found');
    expectRefused(store, () => cmd.addRegions(store, [{ trackId: 't9', clipId: clip.Beat, start: 0, bars: 1 }]), 'not-found');
    expectRefused(store, () => cmd.addClipToSong(store, 't3', clip.Bounce, 1.5), 'invalid');
    expectRefused(store, () => cmd.addClipToSong(store, 't3', clip.Bounce, -1), 'invalid');
    expectRefused(store, () => cmd.addClipToSong(store, 't3', clip.Bounce, 0, 0), 'invalid');
    expectRefused(store, () => cmd.addRegions(store, [{ trackId: 't3', clipId: clip.Bounce, start: 0, bars: 2, offset: 0.5 }]), 'invalid');
    expectRefused(store, () => cmd.addClipToSong(store, 't3', clip.Bounce, 510), 'limit');
    expectRefused(store, () => cmd.addRegions(store, []), 'empty');
    // One bad draft refuses them all.
    expectRefused(store, () => cmd.addRegions(store, [{ trackId: 't3', clipId: clip.Bounce, start: 0, bars: 2 }, { trackId: 't3', clipId: clip.Bounce, start: -4, bars: 2 }]), 'invalid');
    // The last bar of the song is fine.
    expect(cmd.addClipToSong(store, 't3', clip.Bounce, 508).changed).toBe(true);
    expectValid(store.getState());
  });

  it('a scene row goes on every part that has a clip there, as long as the scene, with a section named after it', () => {
    const { store } = songStore();
    const intro = cmd.addSceneToSong(store, 0, 0);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't2:Shaker@0+8~0', 't3:Bounce@0+8~0', 't4:Stabs@0+8~0', 't6:Wash@0+8~0']);
    expect(sections(store.getState())).toEqual(['Intro@0+8']);
    expect(intro.sectionId).toBe(store.getState().arrangement.sections[0].id);
    expect(intro.ids).toHaveLength(5);
    expect(store.undoLabel()).toBe('Add Intro');
    // Over part of it: its loops win on their parts; a section is already there, so none is added.
    const groove = cmd.addSceneToSong(store, 1, 4, { bars: 4 });
    expect(groove).toMatchObject({ changed: true, trimmed: 2, removed: 0 });
    expect(groove.sectionId).toBeUndefined();
    expect(sections(store.getState())).toEqual(['Intro@0+8']);
    // Without a section on request.
    cmd.addSceneToSong(store, 2, 8, { section: false });
    expect(sketch(store.getState())).toEqual([
      't1:Beat@0+4~0',
      't2:Shaker@0+8~0',
      't3:Bounce@0+4~0',
      't4:Stabs@0+8~0',
      't6:Wash@0+8~0',
      't1:Fill@4+4~0',
      't3:Walk@4+4~0',
      't5:Hook@4+4~0',
      't5:Riff@8+3~0',
    ]);
    expect(sections(store.getState())).toEqual(['Intro@0+8']);
    expectValid(store.getState());
    expectRefused(store, () => cmd.addSceneToSong(store, 3, 0), 'empty');
    expectRefused(store, () => cmd.addSceneToSong(store, 9, 0), 'not-found');
    expectRefused(store, () => cmd.addSceneToSong(store, 0, 506), 'limit');
  });

  it('“Make a song from my scenes” plays every scene with clips twice, in order, each under its own section, only into an empty song', () => {
    const { store } = songStore();
    const r = cmd.fillSongFromScenes(store);
    expect(r.changed).toBe(true);
    expect(sections(store.getState())).toEqual(['Intro@0+16', 'Groove@16+4', 'Lift@20+6']);
    expect(sketch(store.getState())).toEqual([
      't1:Beat@0+16~0',
      't2:Shaker@0+16~0',
      't3:Bounce@0+16~0',
      't4:Stabs@0+16~0',
      't6:Wash@0+16~0',
      't1:Fill@16+4~0',
      't3:Walk@16+4~0',
      't5:Hook@16+4~0',
      't5:Riff@20+6~0',
    ]);
    expect(r.ids).toHaveLength(9);
    expect(store.undoLabel()).toBe('Make a song from my scenes');
    expectValid(store.getState());
    expectRefused(store, () => cmd.fillSongFromScenes(store), 'invalid');
    const blank = new ProjectStore(createProject({ now: 0 }));
    expectRefused(blank, () => cmd.fillSongFromScenes(blank), 'empty');
  });
});

describe('editing loops', () => {
  it('moves loops along their rows (limited to the song), carving what they land on; a drag is one undo step', () => {
    const { store, ids } = withLoops([
      ['t3', 'Bounce', 0, 8],
      ['t3', 'Walk', 10, 2],
      ['t1', 'Beat', 0, 4],
    ]);
    const [bounce, walk, beat] = ids;
    const r = cmd.moveRegions(store, [bounce], 4);
    expect(r).toMatchObject({ changed: true, ids: [bounce], trimmed: 0, removed: 1 });
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+4~0', 't3:Bounce@4+8~0']);
    expect(store.undoLabel()).toBe('Move Bounce');
    store.undo();
    // Already at bar 0: nothing moves, no step.
    expect(cmd.moveRegions(store, [bounce, beat], -3)).toMatchObject({ changed: false });
    expect(store.historySize()).toEqual({ undo: 0, redo: 1 });
    // As far as the song goes.
    cmd.moveRegions(store, [bounce], 1000);
    expect(store.getState().arrangement.regions.find((x) => x.id === bounce)!.start).toBe(504);
    expect(store.undoLabel()).toBe('Move Bounce');
    store.undo();
    // A drag: every call with the same gesture is one step.
    cmd.moveRegions(store, [bounce, walk], 1, { gesture: 'drag' });
    cmd.moveRegions(store, [bounce, walk], 1, { gesture: 'drag' });
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+4~0', 't3:Bounce@2+8~0', 't3:Walk@12+2~0']);
    expect(store.undoLabel()).toBe('Move 2 loops');
    store.undo();
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+4~0', 't3:Bounce@0+8~0', 't3:Walk@10+2~0']);
    expectRefused(store, () => cmd.moveRegions(store, ['rg_gone'], 1), 'not-found');
    expectRefused(store, () => cmd.moveRegions(store, [bounce], 0.5), 'invalid');
  });

  it('copies loops with a move: the copies land and the originals stay', () => {
    const { store, ids } = withLoops([
      ['t1', 'Beat', 0, 4],
      ['t3', 'Bounce', 0, 4, 2],
    ]);
    const r = cmd.moveRegions(store, ids, 4, { copy: true });
    expect(r.changed).toBe(true);
    expect(r.ids).toHaveLength(2);
    expect(r.ids!.some((id) => ids.includes(id))).toBe(false);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+4~0', 't3:Bounce@0+4~2', 't1:Beat@4+4~0', 't3:Bounce@4+4~2']);
    expect(store.undoLabel()).toBe('Copy 2 loops');
    expect(cmd.moveRegions(store, [ids[0]], 0, { copy: true })).toMatchObject({ changed: false, ids: [] });
    expectValid(store.getState());
  });

  it('drags an edge: the end makes the clip repeat longer or shorter, the start keeps the music in time', () => {
    const { store, ids } = withLoops([
      ['t3', 'Bounce', 0, 8],
      ['t3', 'Walk', 10, 2],
    ]);
    const [bounce, walk] = ids;
    expect(cmd.resizeRegions(store, [bounce], 'end', 4)).toMatchObject({ changed: true, ids: [bounce], removed: 1 });
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+12~0']);
    expect(store.undoLabel()).toBe('Lengthen Bounce');
    store.undo();
    cmd.resizeRegions(store, [bounce], 'end', -5);
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+3~0', 't3:Walk@10+2~0']);
    expect(store.undoLabel()).toBe('Shorten Bounce');
    store.undo();
    // The start a bar earlier: the loop starts a bar earlier in its clip, so bar 10 still plays the clip's first bar.
    cmd.resizeRegions(store, [walk], 'start', -1);
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+8~0', 't3:Walk@9+3~1']);
    expect(store.undoLabel()).toBe('Lengthen Walk');
    store.undo();
    cmd.resizeRegions(store, [walk], 'start', 1);
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+8~0', 't3:Walk@11+1~1']);
    expect(store.undoLabel()).toBe('Shorten Walk');
    // Never under one bar; a drag is one step.
    cmd.resizeRegions(store, [bounce], 'end', -3, 'edge');
    cmd.resizeRegions(store, [bounce], 'end', -30, 'edge');
    expect(sketch(store.getState())[0]).toBe('t3:Bounce@0+1~0');
    store.undo();
    expect(sketch(store.getState())[0]).toBe('t3:Bounce@0+8~0');
    expect(cmd.resizeRegions(store, [bounce], 'end', 0).changed).toBe(false);
    expectRefused(store, () => cmd.resizeRegions(store, [bounce], 'middle' as 'end', 1), 'invalid');
    expectRefused(store, () => cmd.resizeRegions(store, [bounce], 'end', 1.5), 'invalid');
    expectValid(store.getState());
  });

  it('splits loops at a bar: the right pieces are new and go on later in their clips', () => {
    const { store, ids } = withLoops([
      ['t3', 'Bounce', 0, 8],
      ['t1', 'Beat', 0, 8],
    ]);
    const r = cmd.splitRegions(store, [ids[0]], 3);
    expect(r.changed).toBe(true);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't3:Bounce@0+3~0', 't3:Bounce@3+5~3']);
    expect(r.ids).toEqual([store.getState().arrangement.regions[2].id]);
    expect(store.undoLabel()).toBe('Split Bounce');
    cmd.splitRegions(store, [ids[1], r.ids![0]], 6);
    expect(store.undoLabel()).toBe('Split 2 loops');
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+6~0', 't3:Bounce@0+3~0', 't3:Bounce@3+3~3', 't1:Beat@6+2~0', 't3:Bounce@6+2~2']);
    expectRefused(store, () => cmd.splitRegions(store, [ids[0]], 0), 'invalid');
    expectRefused(store, () => cmd.splitRegions(store, [ids[0]], 3), 'invalid');
    expectRefused(store, () => cmd.splitRegions(store, [ids[0]], 1.5), 'invalid');
    expectValid(store.getState());
  });

  it('deletes or cuts loops, naming them', () => {
    const { store, ids } = withLoops([
      ['t3', 'Bounce', 0, 8],
      ['t1', 'Beat', 0, 8],
      ['t5', 'Hook', 2, 2],
    ]);
    expect(cmd.removeRegions(store, ids.slice(0, 2))).toMatchObject({ changed: true, removed: 2 });
    expect(store.undoLabel()).toBe('Delete 2 loops');
    expect(cmd.removeRegions(store, [ids[2]], { cut: true })).toMatchObject({ changed: true, removed: 1 });
    expect(store.undoLabel()).toBe('Cut Hook');
    expect(store.getState().arrangement.regions).toEqual([]);
    expectRefused(store, () => cmd.removeRegions(store, ids), 'not-found');
  });

  it('duplicates loops right after the selection, keeping their places; refused without room', () => {
    const { store, ids } = withLoops([
      ['t3', 'Bounce', 0, 6],
      ['t1', 'Beat', 2, 2],
    ]);
    const r = cmd.duplicateRegions(store, ids);
    expect(r.changed).toBe(true);
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+6~0', 't1:Beat@2+2~0', 't3:Bounce@6+6~0', 't1:Beat@8+2~0']);
    expect(r.ids).toHaveLength(2);
    expect(store.undoLabel()).toBe('Duplicate 2 loops');
    const late = cmd.addClipToSong(store, 't5', store.getState().tracks[4].clips[1]!.id, 500, 8).ids![0];
    expectRefused(store, () => cmd.duplicateRegions(store, [late]), 'limit');
    expectValid(store.getState());
  });

  it('copies loops to a clipboard and pastes them anywhere; a clip deleted since is skipped, one moved since follows its part', () => {
    const { store, ids } = withLoops([
      ['t3', 'Bounce', 2, 4, 1],
      ['t1', 'Beat', 4, 2],
    ]);
    const clip = cmd.copyRegions(store.getState(), ids);
    expect(clip!.items.map((x) => `${x.trackId}@${x.at}+${x.bars}~${x.offset}`)).toEqual(['t3@0+4~1', 't1@2+2~0']);
    expect(cmd.copyRegions(store.getState(), ['rg_gone'])).toBeNull();
    const r = cmd.pasteRegions(store, clip!, 10);
    expect(r).toMatchObject({ changed: true, skipped: 0 });
    expect(sketch(store.getState()).slice(2)).toEqual(['t3:Bounce@10+4~1', 't1:Beat@12+2~0']);
    expect(store.undoLabel()).toBe('Paste 2 loops');
    // The Beat clip is deleted: its item is skipped.
    cmd.deleteClip(store, 't1', 0);
    expect(cmd.pasteRegions(store, clip!, 20)).toMatchObject({ changed: true, skipped: 1 });
    expect(store.undoLabel()).toBe('Paste Bounce');
    // Bounce moves to the chords part: it is pasted there.
    expect(cmd.moveClip(store, 't3', 0, 't4', 2).changed).toBe(true);
    cmd.pasteRegions(store, clip!, 30);
    expect(sketch(store.getState()).at(-1)).toBe('t4:Bounce@30+4~1');
    cmd.deleteClip(store, 't4', 2);
    expectRefused(store, () => cmd.pasteRegions(store, clip!, 40), 'empty');
    expectRefused(store, () => cmd.pasteRegions(store, clip!, -1), 'invalid');
    expectRefused(store, () => cmd.pasteRegions(store, { items: [] }, 0), 'empty');
    expectValid(store.getState());
  });

  it('a loop plays another clip of its own part, from that clip’s start', () => {
    const { store, clip, ids } = withLoops([['t3', 'Bounce', 0, 8, 2]]);
    expect(cmd.setRegionClip(store, ids[0], clip.Walk)).toMatchObject({ changed: true, ids });
    expect(sketch(store.getState())).toEqual(['t3:Walk@0+8~0']);
    expect(store.undoLabel()).toBe('Play Walk instead of Bounce');
    expect(cmd.setRegionClip(store, ids[0], clip.Walk).changed).toBe(false);
    expectRefused(store, () => cmd.setRegionClip(store, ids[0], clip.Beat), 'invalid');
    expectRefused(store, () => cmd.setRegionClip(store, 'rg_gone', clip.Walk), 'not-found');
  });
});

describe('inserting and removing bars', () => {
  it('inserts empty bars: what comes after moves later, a loop across the bar is split, a section across it grows', () => {
    const { store } = withLoops([
      ['t3', 'Bounce', 0, 8],
      ['t1', 'Beat', 8, 4],
    ]);
    const a = cmd.addSection(store, 0, 8, 'A').sectionId!;
    cmd.addSection(store, 8, 4, 'B');
    const r = cmd.insertBars(store, 4, 2);
    expect(r).toMatchObject({ changed: true, trimmed: 1 });
    expect(sketch(store.getState())).toEqual(['t3:Bounce@0+4~0', 't3:Bounce@6+4~0', 't1:Beat@10+4~0']);
    expect(sections(store.getState())).toEqual(['A@0+10', 'B@10+4']);
    expect(store.getState().arrangement.sections[0].id).toBe(a);
    expect(store.undoLabel()).toBe('Insert 2 bars');
    expectValid(store.getState());
    expectRefused(store, () => cmd.insertBars(store, 14, 1), 'empty');
    expectRefused(store, () => cmd.insertBars(store, 0, 500), 'limit');
    expectRefused(store, () => cmd.insertBars(store, 2, 0), 'invalid');
  });

  it('removes bars: what lay there goes and the gap closes; pieces that play on as one join again, others stay apart', () => {
    const { store, ids } = withLoops([
      ['t1', 'Beat', 0, 8],
      ['t3', 'Bounce', 0, 8],
      ['t5', 'Riff', 8, 3],
    ]);
    cmd.addSection(store, 0, 8, 'A');
    cmd.addSection(store, 8, 3, 'B');
    // A split the user made stays a split.
    cmd.splitRegions(store, [ids[0]], 6);
    store.clearHistory();
    const r = cmd.removeBars(store, 2, 4);
    expect(r).toMatchObject({ changed: true, trimmed: 2, removed: 0 });
    // Beat (2 bars) goes on in phase across the gap: one loop again. Bounce (4 bars) does not: two.
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+4~0', 't3:Bounce@0+2~0', 't3:Bounce@2+4~0', 't1:Beat@4+2~0', 't5:Riff@6+3~0']);
    expect(sections(store.getState())).toEqual(['A@0+6', 'B@6+3']);
    expect(store.undoLabel()).toBe('Remove 2 bars');
    expect(cmd.removeBars(store, 6, 9)).toMatchObject({ changed: true, removed: 1, trimmed: 0 });
    expect(sections(store.getState())).toEqual(['A@0+6']);
    expectValid(store.getState());
    expectRefused(store, () => cmd.removeBars(store, 20, 30), 'empty');
    expectRefused(store, () => cmd.removeBars(store, 3, 3), 'invalid');
  });

  it('the timeline rule joins only the pieces that meet where bars were removed', () => {
    const p = withLoops([
      ['t1', 'Beat', 0, 6],
      ['t1', 'Beat', 6, 2],
      ['t1', 'Beat', 8, 8],
    ]).store.getState();
    let n = 0;
    const t = removeTime(p, p.arrangement.regions, [], 10, 12, () => `rg_new${n++}`);
    const r = t.regions.map((x: SongRegion) => `${x.start}+${x.bars}~${x.offset}`);
    // 0+6 and 6+2 touch and play on as one, but were not cut: they stay apart. 8+2 and 12+4 meet at the gap: joined.
    expect(r).toEqual(['0+6~0', '6+2~0', '8+6~0']);
  });
});

describe('sections', () => {
  it('adds sections (named “Section N” unless given a name); one laid over another cuts it back', () => {
    const { store } = songStore();
    const r = cmd.addSection(store, 0, 8);
    expect(r.changed).toBe(true);
    expect(sections(store.getState())).toEqual(['Section 1@0+8']);
    expect(store.undoLabel()).toBe('Add Section 1');
    cmd.addSection(store, 4, 8, '  Big   Drop ');
    expect(sections(store.getState())).toEqual(['Section 1@0+4', 'Big Drop@4+8']);
    cmd.addSection(store, 12, 2, '   ');
    expect(sections(store.getState())).toEqual(['Section 1@0+4', 'Big Drop@4+8', 'Section 3@12+2']);
    // At most 40 characters, never ending in a space where it was cut.
    cmd.addSection(store, 14, 2, `${'x'.repeat(39)} and more`);
    expect(store.getState().arrangement.sections[3].name).toBe('x'.repeat(39));
    expectRefused(store, () => cmd.addSection(store, -1, 2), 'invalid');
    expectRefused(store, () => cmd.addSection(store, 0, 0), 'invalid');
    expectRefused(store, () => cmd.addSection(store, 510, 4), 'limit');
    expectValid(store.getState());
  });

  it('renames a section; an empty name is refused', () => {
    const { store } = songStore();
    const id = cmd.addSection(store, 0, 8, 'Drop').sectionId!;
    expect(cmd.renameSection(store, id, '  Big  Drop ').changed).toBe(true);
    expect(sections(store.getState())).toEqual(['Big Drop@0+8']);
    expect(store.undoLabel()).toBe('Rename Drop to Big Drop');
    expect(cmd.renameSection(store, id, 'Big Drop').changed).toBe(false);
    expectRefused(store, () => cmd.renameSection(store, id, '  '), 'invalid');
    expectRefused(store, () => cmd.renameSection(store, 'sec_gone', 'X'), 'not-found');
  });

  it('a section’s edges move the label only, stopping at its neighbours; the music stays', () => {
    const { store } = withLoops([['t3', 'Bounce', 0, 16]]);
    const one = cmd.addSection(store, 0, 4, 'One').sectionId!;
    const drop = cmd.addSection(store, 4, 8, 'Drop').sectionId!;
    const regions = store.getState().arrangement.regions;
    expect(cmd.resizeSection(store, one, 'end', 3).changed).toBe(false);
    expect(cmd.resizeSection(store, drop, 'start', -2).changed).toBe(false);
    cmd.resizeSection(store, drop, 'start', 2);
    expect(sections(store.getState())).toEqual(['One@0+4', 'Drop@6+6']);
    expect(store.undoLabel()).toBe('Shorten Drop');
    cmd.resizeSection(store, one, 'end', 3, 'edge');
    cmd.resizeSection(store, one, 'end', 3, 'edge');
    expect(sections(store.getState())).toEqual(['One@0+6', 'Drop@6+6']);
    expect(store.undoLabel()).toBe('Lengthen One');
    cmd.resizeSection(store, drop, 'end', -20);
    expect(sections(store.getState())).toEqual(['One@0+6', 'Drop@6+1']);
    expect(store.getState().arrangement.regions).toBe(regions);
    expectRefused(store, () => cmd.resizeSection(store, drop, 'end', 0.5), 'invalid');
    expectValid(store.getState());
  });

  it('moves a section with the loops that start in it (they win where they land); a copy brings its own moves', () => {
    const { store } = withLoops([
      ['t6', 'Wash', 0, 16],
      ['t3', 'Walk', 4, 4],
      ['t5', 'Hook', 6, 4],
      ['t3', 'Bounce', 12, 4],
    ]);
    const drop = cmd.addSection(store, 4, 4, 'Drop').sectionId!;
    cmd.addSection(store, 12, 4, 'Outro');
    cmd.toggleSectionMove(store, drop, 'fadeIn');
    store.clearHistory();
    const r = cmd.moveSection(store, drop, 8);
    expect(r.changed).toBe(true);
    expect(r.sectionId).toBe(drop);
    expect(r.ids).toHaveLength(2);
    // Walk and Hook started in Drop and move with it (Walk takes Bounce's place); Wash started before it and stays.
    expect(sketch(store.getState())).toEqual(['t6:Wash@0+16~0', 't3:Walk@12+4~0', 't5:Hook@14+4~0']);
    expect(sections(store.getState())).toEqual(['Drop@12+4/fadeIn']);
    expect(store.undoLabel()).toBe('Move Drop');
    store.undo();
    const c = cmd.moveSection(store, drop, 4, { copy: true });
    expect(c.sectionId).not.toBe(drop);
    expect(sections(store.getState())).toEqual(['Drop@4+4/fadeIn', 'Drop@8+4/fadeIn', 'Outro@12+4']);
    const [a, b] = store.getState().arrangement.sections;
    expect(a.moves![0].id).not.toBe(b.moves![0].id);
    expect(sketch(store.getState())).toEqual(['t6:Wash@0+16~0', 't3:Walk@4+4~0', 't5:Hook@6+4~0', 't3:Walk@8+4~0', 't5:Hook@10+4~0', 't3:Bounce@12+4~0']);
    expect(store.undoLabel()).toBe('Copy Drop');
    store.undo();
    // Limited to the song: not before bar 0.
    cmd.moveSection(store, drop, -100);
    expect(sections(store.getState())[0]).toBe('Drop@0+4/fadeIn');
    expectValid(store.getState());
  });

  it('duplicates a section: its length is inserted after it and filled with what plays in it, in the same phase', () => {
    const { store } = withLoops([
      ['t6', 'Wash', 0, 16],
      ['t3', 'Walk', 4, 4],
      ['t5', 'Riff', 8, 3],
    ]);
    const drop = cmd.addSection(store, 4, 4, 'Drop').sectionId!;
    cmd.addSection(store, 8, 4, 'After');
    cmd.toggleSectionMove(store, drop, 'fadeIn');
    const r = cmd.duplicateSection(store, drop);
    expect(r.changed).toBe(true);
    expect(sketch(store.getState())).toEqual(['t6:Wash@0+8~0', 't3:Walk@4+4~0', 't3:Walk@8+4~0', 't6:Wash@8+4~4', 't5:Riff@12+3~0', 't6:Wash@12+8~0']);
    expect(sections(store.getState())).toEqual(['Drop@4+4/fadeIn', 'Drop@8+4/fadeIn', 'After@12+4']);
    expect(r.sectionId).toBe(store.getState().arrangement.sections[1].id);
    expect(r.ids).toHaveLength(2);
    expect(store.undoLabel()).toBe('Duplicate Drop');
    expectValid(store.getState());
  });

  it('deletes a section’s label alone, or with its music (the gap closes)', () => {
    const { store } = withLoops([
      ['t6', 'Wash', 0, 16],
      ['t3', 'Walk', 4, 4],
      ['t5', 'Riff', 8, 3],
    ]);
    const drop = cmd.addSection(store, 4, 4, 'Drop').sectionId!;
    cmd.addSection(store, 8, 4, 'After');
    const regions = store.getState().arrangement.regions;
    cmd.removeSection(store, drop);
    expect(sections(store.getState())).toEqual(['After@8+4']);
    expect(store.getState().arrangement.regions).toBe(regions);
    expect(store.undoLabel()).toBe('Delete Drop');
    store.undo();
    expect(cmd.removeSection(store, drop, { withMusic: true })).toMatchObject({ changed: true, removed: 1, trimmed: 1 });
    // Wash does not join again: removing 4 bars of an 8-bar clip shifts its phase.
    expect(sketch(store.getState())).toEqual(['t6:Wash@0+4~0', 't5:Riff@4+3~0', 't6:Wash@4+8~0']);
    expect(sections(store.getState())).toEqual(['After@4+4']);
    expect(store.undoLabel()).toBe('Delete Drop and its music');
    expectRefused(store, () => cmd.removeSection(store, drop), 'not-found');
    expectValid(store.getState());
  });

  it('song moves: toggled on and off (one of each kind), set as a list keeping the ids already there', () => {
    const { store } = songStore();
    const id = cmd.addSection(store, 0, 8, 'Drop').sectionId!;
    expect(cmd.toggleSectionMove(store, id, 'fadeIn')).toMatchObject({ changed: true, on: true });
    expect(store.undoLabel()).toBe('Add Fade in');
    expect(cmd.toggleSectionMove(store, id, 'filterRise', ['t4', 't4', 't9'])).toMatchObject({ changed: true, on: true });
    const moves = store.getState().arrangement.sections[0].moves!;
    expect(moves.map((m) => [m.kind, m.parts ?? null])).toEqual([['fadeIn', null], ['filterRise', ['t4']]]);
    expect(cmd.toggleSectionMove(store, id, 'fadeIn')).toMatchObject({ changed: true, on: false });
    expect(store.undoLabel()).toBe('Remove Fade in');
    expectRefused(store, () => cmd.toggleSectionMove(store, id, 'spin' as 'fadeIn'), 'invalid');
    // A list: kinds already there keep their ids; repeats, parts on fades and unknown parts go.
    const rise = store.getState().arrangement.sections[0].moves![0].id;
    cmd.setSectionMoves(store, id, [{ kind: 'filterRise', parts: ['t5'] }, { kind: 'fadeOut', parts: ['t1'] }, { kind: 'fadeOut' }]);
    expect(store.getState().arrangement.sections[0].moves).toEqual([
      { id: rise, kind: 'filterRise', parts: ['t5'] },
      { id: expect.any(String), kind: 'fadeOut' },
    ]);
    expect(cmd.setSectionMoves(store, id, store.getState().arrangement.sections[0].moves!).changed).toBe(false);
    cmd.setSectionMoves(store, id, []);
    expect(store.getState().arrangement.sections[0].moves).toBeUndefined();
    expectRefused(store, () => cmd.setSectionMoves(store, id, [{ kind: 'spin' as 'fadeIn' }]), 'invalid');
    expectValid(store.getState());
  });
});

describe('the export tail and the take lock', () => {
  it('the tail is 0 to 10 seconds; a drag is one step', () => {
    const { store } = songStore();
    cmd.setTailSeconds(store, 25, 'tail');
    cmd.setTailSeconds(store, 6, 'tail');
    expect(store.getState().arrangement.tailSeconds).toBe(6);
    expect(store.historySize().undo).toBe(1);
    expect(store.undoLabel()).toBe('Change tail length');
    expectRefused(store, () => cmd.setTailSeconds(store, Number.NaN), 'invalid');
  });

  it('every song edit is refused while a take records (the take allows only what it records), with nothing changed', () => {
    const { store, clip, ids } = withLoops([['t3', 'Bounce', 0, 8]]);
    const sec = cmd.addSection(store, 0, 8, 'Drop').sectionId!;
    store.setLock('Recording a performance', (label) => !label.startsWith('arrange:'));
    const before = store.getState();
    const all = [
      cmd.addClipToSong(store, 't1', clip.Beat, 0),
      cmd.addSceneToSong(store, 0, 8),
      cmd.moveRegions(store, ids, 2),
      cmd.resizeRegions(store, ids, 'end', 2),
      cmd.splitRegions(store, ids, 4),
      cmd.removeRegions(store, ids),
      cmd.duplicateRegions(store, ids),
      cmd.insertBars(store, 2, 2),
      cmd.removeBars(store, 2, 4),
      cmd.addSection(store, 8, 4),
      cmd.renameSection(store, sec, 'X'),
      cmd.moveSection(store, sec, 2),
      cmd.duplicateSection(store, sec),
      cmd.removeSection(store, sec),
      cmd.toggleSectionMove(store, sec, 'fadeIn'),
      cmd.setTailSeconds(store, 1),
    ];
    for (const r of all) expect(r).toMatchObject({ changed: false, refused: 'Recording a performance' });
    expect(store.getState()).toBe(before);
  });
});
