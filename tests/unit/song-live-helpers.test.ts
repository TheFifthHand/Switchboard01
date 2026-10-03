/**
 * Song helpers (Build up, Strip down, Breakdown) used on the block that is
 * playing, and undoing or redoing them while their blocks play: what plays is
 * what the lane shows under the playhead.
 *  - The edited lane puts one of the blocks the helper made (or changed)
 *    under the playhead: playback continues in that block from its start on
 *    the lane (a pass line of the block that played, so every later block
 *    stays on the phrase grid); its parts that differ from what sounds switch
 *    at the edit point. Nothing is cut mid-bar that the lane still shows,
 *    nothing plays a pass late, the lane playhead does not jump back.
 *  - Deleting the playing block keeps its own rule: it sounds on to the next
 *    bar line, where the block after it takes over.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { songBlocks } from '../../src/time/sequencer';
import { makeClip, setClip } from './sequencer-fixtures';
import { BEAT, Rig, fixture, pitchOf, plays } from './song-live-rig';

/**
 * The fixture with b1 (row 1: drums t1, percussion t2, chords t4, 2-bar
 * clips) playing 4 passes, [768, 3840); percussion plays every beat (pitch 90)
 * so a cut mid-bar shows. Build up on b1: b1 x1 chords [768, 1536), then
 * chords + percussion [1536, 2304), then everything x2 [2304, 3840).
 */
function fourPasses(): Project {
  let p = fixture();
  p = setClip(p, 't2', 1, makeClip(2, Array.from({ length: 8 }, (_, i) => [i * BEAT, 90, 24] as [number, number, number]), 'perc'));
  p.arrangement.blocks[1].repeats = 4;
  return p;
}

const between = (notes: [number, number][], from: number, to: number) => notes.filter(([t]) => t >= from && t < to).map(([t]) => t);

/** The lane playhead after the `edits`-th edit: never behind where it was, and only moving forward. */
function laneAfter(r: Rig, edits: number): number[] {
  const lane = r.laneTrace.filter((x) => x.edits === edits).map((x) => x.lane);
  for (let i = 1; i < lane.length; i++) expect(lane[i]).toBeGreaterThanOrEqual(lane[i - 1]);
  return lane;
}

describe('a song helper on the playing block plays what the lane shows', () => {
  it('Build up in pass 2 of 4: percussion plays on, drums stop at the edit point and come back with the full block on its pass line', () => {
    const r = new Rig(fourPasses()).play();
    r.traceLane = true;
    r.to(2000);
    const before = r.laneTick()!;
    let ids: string[] = [];
    r.edit((s) => {
      ids = cmd.shapeBlock(s, 'b1', 'build').blockIds!;
    });
    // The lane: b1 [768, 1536), ids[1] [1536, 2304) (chords + percussion), ids[2] [2304, 3840).
    expect(songBlocks(r.project).slice(1, 4).map((b) => [b.blockId, b.startTick, b.endTick])).toEqual([['b1', 768, 1536], [ids[1], 1536, 2304], [ids[2], 2304, 3840]]);
    // Playback continues in the block under the playhead, laid out where the lane has it.
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 2, blockId: ids[1] });
    expect(r.plan().slice(1, 4)).toEqual([['b1', 1, 768, 1536], [ids[1], 2, 1536, 2304], [ids[2], 3, 2304, 3840]]);
    r.to(3200);
    expect(laneAfter(r, 1)[0]).toBeGreaterThanOrEqual(before);
    // Percussion is in that block: its beats go on through the edit (nothing cut mid-bar).
    expect(between(r.notes('t2'), 2000, 2304)).toEqual([2016, 2112, 2208]);
    // Drums are not: off from the edit point, back on the full block's pass line.
    expect(between(r.notes('t1'), 2000, 3072)).toEqual([2304, 2688]);
    // The chord held since 1536 sounds on; the full block starts at 2304, as on the lane (not a pass later).
    expect(r.held('t4').filter(([t]) => t >= 1536 && t < 3072)).toEqual([[1536, pitchOf(1, 0), 2304], [2304, pitchOf(1, 0), 3072]]);
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [2304, ids[2]]]);
  });

  it('Strip down in pass 3 of 4: the stripped block starts on its pass line (2304), drums stop at the edit point, the song keeps its grid', () => {
    const r = new Rig(fourPasses()).play();
    r.traceLane = true;
    r.to(2400);
    const before = r.laneTick()!;
    let ids: string[] = [];
    r.edit((s) => {
      ids = cmd.shapeBlock(s, 'b1', 'strip').blockIds!;
    });
    // The lane: b1 x2 everything [768, 2304), ids[1] chords + percussion [2304, 3072), ids[2] chords [3072, 3840).
    expect(songBlocks(r.project).slice(1, 4).map((b) => [b.startTick, b.endTick])).toEqual([[768, 2304], [2304, 3072], [3072, 3840]]);
    r.to(4700);
    expect(laneAfter(r, 1)[0]).toBeGreaterThanOrEqual(before);
    // The block under the playhead gets no 'block' event (it is already playing); the next ones come on the grid.
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [3072, ids[2]], [3840, 'b2'], [4608, 'b3']]);
    expect(between(r.notes('t1'), 2400, 3840)).toEqual([]);
    expect(between(r.notes('t2'), 2400, 3840)).toEqual([2400, 2496, 2592, 2688, 2784, 2880, 2976]);
    // b2 (row 2, 1-bar clips) on its own start.
    expect(r.notes('t1').filter(([t]) => t >= 3840 && t < 4608)).toEqual(plays(2, 3840, 4608));
  });

  it('Breakdown on the playing block (one block): drums and percussion stop at the edit point, the chords play on; Undo brings them back in phase', () => {
    const r = new Rig(fourPasses()).play();
    r.to(1700);
    r.edit((s) => cmd.shapeBlock(s, 'b1', 'breakdown'));
    r.to(2500);
    expect(between(r.notes('t1'), 1700, 2500)).toEqual([]);
    expect(between(r.notes('t2'), 1700, 2500)).toEqual([]);
    r.edit((s) => s.undo());
    r.to(3840);
    // Back at the edit point, in phase with b1's start (768).
    expect(r.notes('t1').filter(([t]) => t >= 2500 && t < 3840)).toEqual(plays(1, 2688, 3840, 768));
    expect(between(r.notes('t2'), 2500, 2700)).toEqual([2592, 2688]);
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [3840, 'b2']]);
  });
});

describe('undoing and redoing a helper while its blocks play', () => {
  it('Undo of Build up while its second block plays: the restored block plays on to its end (3840), drums back at the edit point, then b2', () => {
    const r = new Rig(fourPasses()).play();
    let ids: string[] = [];
    r.edit((s) => {
      ids = cmd.shapeBlock(s, 'b1', 'build').blockIds!;
    });
    r.traceLane = true;
    r.to(1800);
    expect(r.seq.songBlockAt(r.tick)!.blockId).toBe(ids[1]);
    r.edit((s) => s.undo());
    // The lane has the playhead in b1's second pass again.
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b1' });
    expect(r.plan().slice(1, 3)).toEqual([['b1', 1, 768, 3840], ['b2', 2, 3840, 4608]]);
    r.to(4400);
    expect(r.laneTrace.filter((x) => x.edits === 2)[0].lane).toBeCloseTo(1800, -1);
    laneAfter(r, 2);
    // Not skipped: b2 starts where b1 ends on the lane.
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [1536, ids[1]], [3840, 'b2']]);
    // Drums switch back on at the edit point, in phase with b1's start: the next bar note is its pass-2 bar 2.
    expect(r.notes('t1').filter(([t]) => t >= 1800 && t < 3840)).toEqual(plays(1, 1920, 3840, 768));
    // Percussion plays on through the edit.
    expect(between(r.notes('t2'), 1700, 2000)).toEqual([1728, 1824, 1920]);
  });

  it('Redo of Build up while the restored block plays its second pass: continues in the block the build puts there', () => {
    const r = new Rig(fourPasses()).play();
    let ids: string[] = [];
    r.edit((s) => {
      ids = cmd.shapeBlock(s, 'b1', 'build').blockIds!;
    });
    r.edit((s) => s.undo());
    r.traceLane = true;
    r.to(1800);
    r.edit((s) => s.redo());
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 2, blockId: ids[1] });
    r.to(3200);
    expect(r.laneTrace.filter((x) => x.edits === 3)[0].lane).toBeGreaterThanOrEqual(1800);
    expect(between(r.notes('t2'), 1700, 2304)).toEqual([1728, 1824, 1920, 2016, 2112, 2208]);
    expect(between(r.notes('t1'), 1800, 3072)).toEqual([2304, 2688]);
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [2304, ids[2]]]);
  });
});

describe('deleting the playing block keeps its own rule', () => {
  it('a block of the same scene with other parts after it takes over at the next bar line (the edit did not make it)', () => {
    const p = fixture();
    // b1x: row 1 again, drums off, x2, right after b1.
    p.arrangement.blocks.splice(2, 0, { id: 'b1x', sceneId: p.scenes[1].id, repeats: 2, parts: { t1: null } });
    const r = new Rig(p).play();
    r.to(1800);
    r.edit((s) => cmd.removeBlocks(s, ['b1']));
    r.to(2400);
    // b1 sounds on to 1920, where b1x takes over (laid out at its place: [768, 2304) on the new lane).
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [1920, 'b1x']]);
    expect(between(r.notes('t1'), 1800, 2400)).toEqual([]);
    expect(r.notes('t2').filter(([t]) => t >= 1536 && t < 2400).map(([t]) => t)).toEqual([1536, 1920, 2304]);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b1x' });
    expect(r.plan().slice(0, 3)).toEqual([['b0', 0, 0, 768], ['b1', -1, 768, 1920], ['b1x', 1, 1920, 3456]]);
  });
});
