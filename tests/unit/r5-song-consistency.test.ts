/**
 * The song follows the clips (state/commands/common.ts keepSongWithClips):
 * whatever an edit does to the clips, the song's loops stay playable, in the
 * same undo step. Deleting a clip, clearing a part or deleting a scene row
 * takes their loops out; moving a clip to another part takes its loops to
 * that row; a new clip length keeps the loops' bars and wraps their offsets;
 * copies never touch the song.
 */
import { describe, expect, it } from 'vitest';
import * as cmd from '../../src/state/commands';
import { expectValid, sketch, songStore } from './r5-song-fixtures';

/** A song with loops of Beat, Bounce, Walk and Hook; history cleared. */
function song() {
  const { store, clip } = songStore();
  cmd.addRegions(store, [
    { trackId: 't1', clipId: clip.Beat, start: 0, bars: 8 },
    { trackId: 't3', clipId: clip.Bounce, start: 0, bars: 8, offset: 3 },
    { trackId: 't3', clipId: clip.Walk, start: 8, bars: 4 },
    { trackId: 't4', clipId: clip.Stabs, start: 4, bars: 4 },
    { trackId: 't5', clipId: clip.Hook, start: 8, bars: 4 },
  ]);
  store.clearHistory();
  return { store, clip };
}

const START = ['t1:Beat@0+8~0', 't3:Bounce@0+8~3', 't4:Stabs@4+4~0', 't3:Walk@8+4~0', 't5:Hook@8+4~0'];

describe('the song follows the clips, in the same undo step', () => {
  it('deleting a clip takes its loops out of the song; Undo brings both back', () => {
    const { store } = song();
    const before = store.getState();
    expect(sketch(before)).toEqual(START);
    cmd.deleteClip(store, 't3', 0);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't4:Stabs@4+4~0', 't3:Walk@8+4~0', 't5:Hook@8+4~0']);
    expect(store.historySize().undo).toBe(1);
    expect(store.undoLabel()).toBe('Delete clip');
    expectValid(store.getState());
    store.undo();
    expect(store.getState().arrangement).toEqual(before.arrangement);
    expect(store.getState().tracks).toEqual(before.tracks);
  });

  it('clearing a part takes all its loops out', () => {
    const { store } = song();
    cmd.clearTrackClips(store, 't3');
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't4:Stabs@4+4~0', 't5:Hook@8+4~0']);
    expectValid(store.getState());
  });

  it('deleting a scene row takes its clips’ loops out (the delete says how many); the other rows’ loops stay', () => {
    const { store } = song();
    const p = store.getState();
    expect(cmd.sceneUse(p, p.scenes[0].id)).toEqual({ regions: 3 });
    expect(cmd.sceneUse(p, p.scenes[1].id)).toEqual({ regions: 2 });
    expect(cmd.sceneUse(p, p.scenes[3].id)).toEqual({ regions: 0 });
    expect(cmd.sceneUse(p, 'scene_gone')).toEqual({ regions: 0 });
    const r = cmd.deleteScene(store, 0);
    expect(r).toMatchObject({ changed: true, regions: 3 });
    expect(sketch(store.getState())).toEqual(['t3:Walk@8+4~0', 't5:Hook@8+4~0']);
    expect(store.historySize().undo).toBe(1);
    expectValid(store.getState());
    store.undo();
    expect(sketch(store.getState())).toEqual(START);
  });

  it('moving, adding and copying scene rows changes nothing in the song', () => {
    const { store } = song();
    const regions = store.getState().arrangement.regions;
    cmd.moveScene(store, 0, 3);
    cmd.insertScene(store, 1);
    cmd.duplicateScene(store, 2);
    expect(store.getState().arrangement.regions).toBe(regions);
    expectValid(store.getState());
  });

  it('a new clip length keeps the loops’ bars, their offsets wrapped into the clip', () => {
    const { store } = song();
    // Bounce: 4 → 2 bars. Its loop started 3 bars in: now 1 bar in.
    cmd.setClipBars(store, 't3', 0, 2);
    expect(sketch(store.getState())).toContain('t3:Bounce@0+8~1');
    expect(store.historySize().undo).toBe(1);
    expectValid(store.getState());
    // Longer again: the offset already fits.
    cmd.duplicateClipContent(store, 't3', 0);
    expect(sketch(store.getState())).toContain('t3:Bounce@0+8~1');
    store.undo();
    store.undo();
    expect(sketch(store.getState())).toEqual(START);
  });

  it('moving a clip to another part takes its loops to that part’s row, where they win', () => {
    const { store } = song();
    // Hook (lead, bars 8–12) to an empty pad of the chords part: its loop moves to the Chords row, after Stabs (bars 4–8).
    expect(cmd.moveClip(store, 't5', 1, 't4', 1).changed).toBe(true);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't3:Bounce@0+8~3', 't4:Stabs@4+4~0', 't3:Walk@8+4~0', 't4:Hook@8+4~0']);
    expect(store.historySize().undo).toBe(1);
    store.undo();
    // Bounce (bass) to the chords part: it lands over Stabs, which goes.
    cmd.moveClip(store, 't3', 0, 't4', 2);
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't4:Bounce@0+8~3', 't3:Walk@8+4~0', 't5:Hook@8+4~0']);
    expectValid(store.getState());
    store.undo();
    expect(sketch(store.getState())).toEqual(START);
  });

  it('swapping two parts’ clips swaps their loops between the rows', () => {
    const { store } = song();
    // Stabs (t4, row 0) and Bounce (t3, row 0) trade places.
    const r = cmd.moveClip(store, 't3', 0, 't4', 0);
    expect(r).toMatchObject({ changed: true, swapped: true });
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't4:Bounce@0+8~3', 't3:Stabs@4+4~0', 't3:Walk@8+4~0', 't5:Hook@8+4~0']);
    expectValid(store.getState());
  });

  it('moving a clip to another pad of its own part, or copying a clip anywhere, never touches the song', () => {
    const { store } = song();
    const regions = store.getState().arrangement.regions;
    cmd.moveClip(store, 't3', 0, 't3', 3);
    cmd.copyClipTo(store, 't3', 3, 't4', 2);
    cmd.duplicateClipToSlot(store, 't1', 0, 2);
    cmd.renameClip(store, 't1', 0, 'Big Beat');
    expect(store.getState().arrangement.regions).toBe(regions);
  });

  it('a clip pasted or copied over one the song plays takes over its loops', () => {
    const { store } = song();
    // Walk (2 bars) copied over Bounce's pad: the loop that played Bounce 3 bars in now plays Walk 1 bar in.
    const r = cmd.copyClipTo(store, 't3', 1, 't3', 0);
    expect(r).toMatchObject({ changed: true, replaced: true });
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~0', 't3:Walk@0+8~1', 't4:Stabs@4+4~0', 't3:Walk@8+4~0', 't5:Hook@8+4~0']);
    expect(store.getState().arrangement.regions[1].clipId).toBe(r.clipId);
    expectValid(store.getState());
    store.undo();
    const pasted = cmd.pasteClip(store, 't5', 1, cmd.copyClip(store.getState(), 't5', 2)!);
    expect(store.getState().arrangement.regions.find((x) => x.trackId === 't5')!.clipId).toBe(pasted.clipId);
    expectValid(store.getState());
  });

  it('note edits leave the song as it is (the same loops, the same array)', () => {
    const { store } = song();
    const regions = store.getState().arrangement.regions;
    cmd.toggleStep(store, 't1', 0, 3, 2);
    cmd.transposeClip(store, 't3', 0, 2);
    cmd.setMacro(store, 't3', 'tone', 0.3);
    expect(store.getState().arrangement.regions).toBe(regions);
  });
});
