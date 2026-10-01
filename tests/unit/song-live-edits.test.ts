/**
 * Edits while the song plays, as the owner asked for them after a hands-on
 * review: they are heard at once and the playhead never looks wrong.
 *  - An edit that leaves what sounds at the playhead unchanged (a split while
 *    a later pass plays, a join, undoing either) changes nothing you hear and
 *    does not move the playhead; playback continues in the block that now
 *    covers it.
 *  - An edit right after Resume judges the playing block by the pause point,
 *    and an end that would lie behind what was handed out is still delivered.
 *  - Deleting the block that plays hands over at the next bar line to the
 *    block that came after it; meanwhile the lane playhead waits where that
 *    block starts and the runtime reports it, never the deleted one.
 *  - Changes to what the playing block plays (its scene, a part switched off
 *    or on, a layered part, the clip in its slot) apply at the edit point, in
 *    phase with the block start.
 *  - A block shortened below the playhead: the lane playhead waits at its end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { Sequencer } from '../../src/time/sequencer';
import { RealtimeTransport } from '../../src/time/transport';
import { setClip } from './sequencer-fixtures';
import { Rig, UNEDITED, barClip, beatFixture, beats, fixture, plays, sceneId } from './song-live-rig';

/** The lane playhead never moved back after the `edits`-th edit and stayed inside the lane. */
function laneForward(r: Rig, edits: number): number[] {
  const lane = r.laneTrace.filter((t) => t.edits === edits);
  for (let i = 1; i < lane.length; i++) expect(lane[i].lane).toBeGreaterThanOrEqual(lane[i - 1].lane);
  for (const t of lane) expect(t.lane).toBeLessThanOrEqual(t.total);
  return lane.map((t) => t.lane);
}

describe('an edit that leaves what sounds at the playhead unchanged changes nothing you hear (H2)', () => {
  it('splitting the playing block while a later pass plays: same notes, same end, the playhead stays; it continues in the second half', () => {
    // b1 = row 1 (2 bars) x 2 = [768, 2304). Tick 1800 is in its second pass.
    const r = new Rig().play().to(1800);
    const lane = r.laneTick()!;
    expect(r.edit((s) => cmd.splitBlock(s, 'b1', 1))).toBe(true);
    const second = r.project.arrangement.blocks[2].id;
    expect(r.plan()).toEqual([['b0', 0, 0, 768], ['b1', 1, 768, 1536], [second, 2, 1536, 2304], ['b2', 3, 2304, 3072], ['b3', 4, 3072, 3456]]);
    // The second half is the block playing now (it gets no 'block' event: the runtime reads it from the plan).
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 2, blockId: second });
    expect(r.laneTick()).toBeCloseTo(lane, 9);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.notes('t2')).toEqual(UNEDITED);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(r.launches('t4')).toEqual([[0, 0], [768, 1], [2304, null], [3072, 3]]);
    expect(r.blocks()).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [2304, 3, 'b2'], [3072, 4, 'b3']]);
    expect(r.ends()).toEqual([3456]);
  });

  it('undoing that split while the second half plays: it continues in the whole block again', () => {
    const r = new Rig().play().to(1800);
    r.edit((s) => cmd.splitBlock(s, 'b1', 1));
    r.to(2000);
    const lane = r.laneTick()!;
    expect(r.edit((s) => s.undo())).toBe(true);
    expect(r.plan()).toEqual([['b0', 0, 0, 768], ['b1', 1, 768, 2304], ['b2', 2, 2304, 3072], ['b3', 3, 3072, 3456]]);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b1' });
    expect(r.laneTick()).toBeCloseTo(lane, 9);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.launches('t4')).toEqual([[0, 0], [768, 1], [2304, null], [3072, 3]]);
    expect(r.ends()).toEqual([3456]);
  });

  /** b1 as two neighbours of the same material: b1 [768, 1536) and b1b [1536, 2304). */
  function twoHalves(): Project {
    const p = fixture();
    p.arrangement.blocks.splice(1, 1, { id: 'b1', sceneId: p.scenes[1].id, repeats: 1 }, { id: 'b1b', sceneId: p.scenes[1].id, repeats: 1 });
    return p;
  }

  it('joining while the second block plays continues in the joined block, seamlessly', () => {
    const r = new Rig(twoHalves()).play().to(1800);
    const lane = r.laneTick()!;
    expect(r.edit((s) => cmd.joinWithNext(s, 'b1'))).toBe(true);
    expect(r.plan()).toEqual([['b0', 0, 0, 768], ['b1', 1, 768, 2304], ['b2', 2, 2304, 3072], ['b3', 3, 3072, 3456]]);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b1' });
    expect(r.laneTick()).toBeCloseTo(lane, 9);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(r.blocks()).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [1536, 2, 'b1b'], [2304, 2, 'b2'], [3072, 3, 'b3']]);
    expect(r.ends()).toEqual([3456]);
  });

  it('joining while the first block plays: it simply plays on, longer', () => {
    const r = new Rig(twoHalves()).play().to(1000);
    expect(r.edit((s) => cmd.joinWithNext(s, 'b1'))).toBe(true);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    // One block now: no switch at 1536.
    expect(r.launches('t4')).toEqual([[0, 0], [768, 1], [2304, null], [3072, 3]]);
    expect(r.blocks()).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [2304, 2, 'b2'], [3072, 3, 'b3']]);
    expect(r.ends()).toEqual([3456]);
  });

  it('with clips of different lengths, every clip keeps its loop phase (nothing restarts)', () => {
    // b1 plays a 3-bar clip (t1) and a 2-bar clip (t2): one pass is 3 bars, b1 = [768, 3072).
    let p = fixture();
    p = setClip(p, 't1', 1, barClip(1, 3));
    const unedited = new Rig(p).play().finish();
    const r = new Rig(p).play().to(2500);
    expect(r.edit((s) => cmd.splitBlock(s, 'b1', 1))).toBe(true);
    r.finish();
    // The 2-bar clip goes on from the phase it had (bar 2 of its loop at 1920), as if nothing happened.
    expect(r.notes('t2')).toEqual(unedited.notes('t2'));
    expect(r.notes('t1')).toEqual(unedited.notes('t1'));
    expect(r.ends()).toEqual(unedited.ends());
  });

  it('a deleted playing block whose successor plays the same clips: the song continues in the successor', () => {
    const p = fixture();
    p.arrangement.blocks.splice(2, 1, { id: 'twin', sceneId: p.scenes[1].id, repeats: 2 });
    const r = new Rig(p).play().to(1000);
    r.edit((s) => cmd.removeBlocks(s, ['b1']));
    // The lane is b0 twin b3: the playhead lies in twin, which plays what sounds now.
    expect(r.plan()).toEqual([['b0', 0, 0, 768], ['twin', 1, 768, 2304], ['b3', 2, 2304, 2688]]);
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(3, 2304, 2688)]);
    expect(r.ends()).toEqual([2688]);
  });
});

describe('an edit right after Resume (H3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The real transport on a fake audio clock, ticked by hand every 25 ms. */
  function transportRig() {
    const store = new ProjectStore(fixture());
    const seq = new Sequencer({ getProject: () => store.getState() });
    const ctx = { currentTime: 1, state: 'running', addEventListener() {}, removeEventListener() {} };
    const engine = new Proxy({}, { get: () => () => null });
    const t = new RealtimeTransport({ ctx: ctx as never, engine: engine as never, sequencer: seq });
    const ends: number[] = [];
    t.on('end', (e) => ends.push(e.tick));
    const runTo = (time: number) => {
      while (ctx.currentTime < time) {
        ctx.currentTime = Math.min(time, ctx.currentTime + 0.025);
        (t as unknown as { onTick(): void }).onTick();
      }
    };
    return { store, seq, ctx, t, ends, runTo };
  }

  it('with the pause point just after a block start, that block counts as started: deleted, it hands over at the next bar line and the song ends there', () => {
    const { store, seq, ctx, t, ends, runTo } = transportRig();
    t.start({ mode: { kind: 'song', fromBlock: 0 } });
    // Pause 15 ms (3 ticks) after b2 starts at 2304; Resume 2 s later; delete b2 and b3 at once.
    runTo(seq.timeAt(2304) + 0.015);
    expect(t.pause()).toBe(true);
    ctx.currentTime += 2;
    expect(t.resume()).toBe(true);
    cmd.removeBlocks(store, ['b2', 'b3']);
    expect(t.replanSong()).toBe(true);
    expect(seq.songPlan()!.map((b) => [b.blockId, b.index, b.startTick, b.endTick])).toEqual([['b0', 0, 0, 768], ['b1', 1, 768, 2304], ['b2', -1, 2304, 2688]]);
    runTo(ctx.currentTime + 30);
    expect({ ends, playing: t.playing }).toEqual({ ends: [2688], playing: false });
    t.dispose();
  });

  it('the same edit while playing (the control case) ends the song at the same bar line', () => {
    const { store, seq, ctx, t, ends, runTo } = transportRig();
    t.start({ mode: { kind: 'song', fromBlock: 0 } });
    runTo(seq.timeAt(2304) + 0.3);
    cmd.removeBlocks(store, ['b2', 'b3']);
    expect(t.replanSong()).toBe(true);
    runTo(ctx.currentTime + 30);
    expect({ ends, playing: t.playing }).toEqual({ ends: [2688], playing: false });
    t.dispose();
  });

  it('an end that falls before the resume point is still handed out, at the resume time', () => {
    const r = new Rig().play().to(1300).pause();
    r.now += 2;
    // Resume without letting the ticker run: generation restarts a little before the pause point.
    const resumeAt = r.now + 0.05;
    expect(r.seq.resume(resumeAt)).toBe(true);
    r.seq.setEndTick(1000);
    r.pump();
    const [end] = r.out.filter((e) => e.kind === 'end');
    expect(end).toBeDefined();
    expect(end.time).toBeGreaterThanOrEqual(resumeAt);
    expect(r.seq.ended).toBe(true);
  });

  it('an end that falls behind the edit point of a regeneration is still handed out, at the edit point', () => {
    const r = new Rig().play().to(1300);
    r.seq.setEndTick(1290);
    const at = r.now + 0.01;
    r.cancelFrom(at);
    const ends = r.out.filter((e) => e.kind === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0].time).toBeGreaterThanOrEqual(at);
    expect(r.seq.ended).toBe(true);
  });
});

describe('deleting the block that plays', () => {
  it('hands over at the next bar line; meanwhile the runtime reports the next block and the lane playhead waits where it starts', () => {
    const r = new Rig().play().to(1000);
    r.traceLane = true;
    r.edit((s) => cmd.removeBlocks(s, ['b1']));
    // Lane: b0 [0, 768) b2 [768, 1536) b3 [1536, 1920). b1 sounds on to 1152, then b2 starts.
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b2' });
    expect(r.laneTick()).toBe(768);
    r.to(1140);
    expect(r.laneTick()).toBe(768);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b2' });
    r.to(1152 + 96);
    expect(r.laneTick()).toBe(768 + 96);
    r.finish();
    const lane = laneForward(r, 1);
    expect(Math.min(...lane)).toBe(768);
    expect(r.blocks()).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [1152, 1, 'b2'], [1920, 2, 'b3']]);
    expect(r.ends()).toEqual([2304]);
  });

  it('the last block: the song ends at the next bar line, the lane playhead waits at the end of the song', () => {
    const r = new Rig().play().to(3100);
    r.edit((s) => cmd.removeBlocks(s, ['b3']));
    // Lane: b0 b1 b2, 3072 ticks.
    expect(r.seq.songBlockAt(r.tick)).toBeNull();
    expect(r.laneTick()).toBe(3072);
    r.finish();
    expect(r.notes('t1')).toEqual([...UNEDITED.filter(([t]) => t < 3072), ...plays(3, 3072, 3456)]);
    expect(r.ends()).toEqual([3456]);
  });

  it('undone before the hand-over, it plays on as if nothing happened', () => {
    const r = new Rig().play().to(1000);
    r.edit((s) => cmd.removeBlocks(s, ['b1']));
    r.to(1100);
    r.edit((s) => s.undo());
    expect(r.plan()).toEqual([['b0', 0, 0, 768], ['b1', 1, 768, 2304], ['b2', 2, 2304, 3072], ['b3', 3, 3072, 3456]]);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b1' });
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(r.launches('t4')).toEqual([[0, 0], [768, 1], [2304, null], [3072, 3]]);
    expect(r.ends()).toEqual([3456]);
  });

  it('while paused: Play sounds on to the next bar line after the pause point, then the next block', () => {
    const r = new Rig().play().to(1300).pause();
    r.now += 1;
    r.edit((s) => cmd.removeBlocks(s, ['b1']));
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b2' });
    expect(r.laneTick()).toBe(768);
    r.now += 1;
    r.resume().finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1536), ...plays(2, 1536, 2304), ...plays(3, 2304, 2688)]);
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [1536, 'b2'], [2304, 'b3']]);
    expect(r.ends()).toEqual([2688]);
  });
});

describe('edits to what the playing block plays apply at once, in phase with the block start', () => {
  it('a part switched off stops at the edit point: its sounding note is cut there', () => {
    const r = new Rig(beatFixture()).play().to(1000);
    r.edit((s) => cmd.setBlockPart(s, 'b1', 't5', null));
    expect(r.editTicks).toEqual([1002]);
    r.finish();
    expect(r.notes('t5')).toEqual([...beats(0, 0, 768), ...beats(1, 768, 1002), ...beats(2, 2304, 3072), ...beats(3, 3072, 3456)]);
    // The beat at 960 (48 ticks long) ends at the edit point.
    expect(r.held('t5').find(([t]) => t === 960)![2]).toBe(1002);
    expect(r.launches('t5')).toEqual([[0, 0], [768, 1], [1002, null], [2304, 2], [3072, 3]]);
  });

  it('a part switched on joins mid-loop at the edit point; notes that would have started before it are not played late', () => {
    const p = beatFixture();
    p.arrangement.blocks[1].parts = { t4: null, t5: null };
    const r = new Rig(p).play().to(1000);
    r.edit((s) => cmd.resetBlockParts(s, 'b1'));
    r.finish();
    // The beats come in on the next beat, in phase with the block; the chord that starts with each pass waits for the next pass.
    expect(r.notes('t5')).toEqual([...beats(0, 0, 768), ...beats(1, 1002, 2304), ...beats(2, 2304, 3072), ...beats(3, 3072, 3456)]);
    expect(r.held('t4')).toEqual([[0, 30, 768], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(r.launches('t4')).toEqual([[0, 0], [768, null], [1002, 1], [2304, null], [3072, 3]]);
  });

  it('a layered part plays the other scene’s clip from the edit point, in phase', () => {
    const r = new Rig(beatFixture()).play().to(1000);
    r.edit((s) => cmd.setBlockPart(s, 'b1', 't5', sceneId(r, 0)));
    r.finish();
    expect(r.notes('t5')).toEqual([...beats(0, 0, 768), ...beats(1, 768, 1002), ...beats(0, 1002, 2304), ...beats(2, 2304, 3072), ...beats(3, 3072, 3456)]);
    expect(r.notes('t1')).toEqual(UNEDITED);
  });

  it('the clip in the playing slot deleted: silent at once; Undo brings it back at once, in phase', () => {
    const r = new Rig(beatFixture()).play().to(1000);
    r.edit((s) => cmd.deleteClip(s, 't5', 1));
    r.to(1100);
    r.edit((s) => s.undo());
    r.finish();
    expect(r.editTicks).toEqual([1002, 1102]);
    expect(r.notes('t5')).toEqual([...beats(0, 0, 768), ...beats(1, 768, 1002), ...beats(1, 1102, 2304), ...beats(2, 2304, 3072), ...beats(3, 3072, 3456)]);
    expect(r.launches('t5')).toEqual([[0, 0], [768, 1], [1002, null], [1102, 1], [2304, 2], [3072, 3]]);
  });

  it('the clip moved to another part’s pad in the same row: that part plays it from the edit point (the lane shows it there); Undo moves it back', () => {
    const r = new Rig(beatFixture()).play().to(1000);
    r.edit((s) => cmd.moveClip(s, 't5', 1, 't6', 1));
    r.to(1100);
    r.edit((s) => s.undo());
    r.finish();
    expect(r.notes('t5')).toEqual([...beats(0, 0, 768), ...beats(1, 768, 1002), ...beats(1, 1102, 2304), ...beats(2, 2304, 3072), ...beats(3, 3072, 3456)]);
    expect(r.notes('t6')).toEqual(beats(1, 1002, 1102));
  });

  it('while paused, the change applies at the pause point when Play resumes', () => {
    const r = new Rig(beatFixture()).play().to(1300).pause();
    r.now += 1;
    r.edit((s) => cmd.setBlockPart(s, 'b1', 't5', sceneId(r, 0)));
    r.now += 1;
    r.resume().finish();
    expect(r.notes('t5')).toEqual([...beats(0, 0, 768), ...beats(1, 768, 1300), ...beats(0, 1300, 2304), ...beats(2, 2304, 3072), ...beats(3, 3072, 3456)]);
  });

  it('pad launches stay on the next bar line', () => {
    const r = new Rig(beatFixture()).play().to(1000).tap('t5', 3);
    r.edit((s) => cmd.setBlockPart(s, 'b1', 't2', null));
    r.finish();
    expect(r.launches('t5')).toEqual([[0, 0], [768, 1], [1152, 3], [2304, 2], [3072, 3]]);
  });
});

describe('found by the song loop fuzz (not loop-specific)', () => {
  it('a tempo change right after Resume, before the resume time comes, does not play the bar before the pause point again', () => {
    // Paused a tick after the note on bar line 1152; Resume; a slower tempo within the 50 ms before playback continues.
    const r = new Rig().play().to(1153).pause();
    r.now += 0.3;
    r.resume().setTempo(90);
    r.to(2000);
    expect(r.notes('t1').filter(([t]) => t < 2000)).toEqual(UNEDITED.filter(([t]) => t < 2000));
  });

  it('the clip in the playing pad replaced just after the block start: what the old clip sounds ends at the edit point', () => {
    // b1 starts at 768 with t4's 2-bar chord (row 1); 3 ticks later t4's row-1 and row-3 clips swap pads.
    const r = new Rig().play().to(769);
    r.edit((s) => cmd.moveClip(s, 't4', 1, 't4', 3));
    const at = r.editTicks[0];
    expect(at - 768).toBeLessThan(8);
    r.to(2304);
    // The row-3 chord (one bar) now plays in b1, in phase with the block: from its next loop (1152).
    expect(r.held('t4').filter(([t]) => t < 2304)).toEqual([[0, 30, 768], [768, 50, at], [1152, 90, 1536], [1536, 90, 1920], [1920, 90, 2304]]);
  });
});

describe('a block shortened below the playhead (L2)', () => {
  it('sounds on to the next bar line while the lane playhead waits at its end, then the next block takes over there', () => {
    const r = new Rig().play().to(1800);
    r.traceLane = true;
    r.edit((s) => cmd.setBlockRepeats(s, 'b1', 1));
    // Lane: b0 [0, 768) b1 [768, 1536) b2 [1536, 2304) b3 [2304, 2688). b1 sounds on to 1920.
    expect(r.plan()).toEqual([['b0', 0, 0, 768], ['b1', 1, 768, 1920], ['b2', 2, 1920, 2688], ['b3', 3, 2688, 3072]]);
    expect(r.laneTick()).toBe(1536);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b1' });
    r.to(1900);
    expect(r.laneTick()).toBe(1536);
    r.to(1920 + 96);
    expect(r.laneTick()).toBe(1536 + 96);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 2, blockId: 'b2' });
    r.finish();
    laneForward(r, 1);
    expect(r.ends()).toEqual([3072]);
  });
});
