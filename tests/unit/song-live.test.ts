/**
 * Song playback is always exactly what the Arrange lane shows: per-part
 * changes in a block play (a layered part plays another scene's clip, an off
 * part is silent), and edits made while the song plays or is paused lay out
 * the rest of it again, anchored on the block playing now. Checked on the
 * notes, launches, block events and the end the sequencer hands to a driver
 * that behaves like RealtimeTransport (25 ms ticker, 120 ms look-ahead,
 * cancel-and-regenerate on every change).
 */
import { describe, expect, it } from 'vitest';
import type { ClipBars, Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import type { SeqEvent, StartOptions } from '../../src/time/contracts';
import { Sequencer, songBlocks, type NoteCut, type NoteEvent } from '../../src/time/sequencer';
import { makeClip, makeProject, notesOf, ofKind, setClip } from './sequencer-fixtures';

const BAR = 384;
const LOOKAHEAD = 0.12;
const TICKER = 0.025;
const MARGIN = 0.01;
const START = 0.05;

/** Bars of the clips in each scene row. */
const ROW_BARS = [2, 2, 1, 1];
/** Every bar-note clip plays one note on each of its bar lines; the pitch says its row and which of its bars it is. */
const pitchOf = (row: number, k: number) => 30 + row * 20 + k;

function barClip(row: number) {
  const bars = ROW_BARS[row] as ClipBars;
  return makeClip(bars, Array.from({ length: bars }, (_, k) => [k * BAR, pitchOf(row, k), 48] as [number, number, number]), `bars${row}`);
}

/** One chord held through the whole clip. */
function heldClip(row: number) {
  const bars = ROW_BARS[row] as ClipBars;
  return makeClip(bars, [[0, pitchOf(row, 0), bars * BAR]], `held${row}`);
}

/**
 * t1 and t2 play bar-note clips in every row; t4 holds a chord in rows 0, 1
 * and 3. Song: b0 row 0 x1 [0, 768), b1 row 1 x2 [768, 2304), b2 row 2 x2
 * [2304, 3072), b3 row 3 x1 [3072, 3456).
 */
function fixture(): Project {
  let p = makeProject(120);
  ROW_BARS.forEach((_, row) => {
    p = setClip(p, 't1', row, barClip(row));
    p = setClip(p, 't2', row, barClip(row));
    if (row !== 2) p = setClip(p, 't4', row, heldClip(row));
  });
  p.arrangement = {
    tailSeconds: 1,
    blocks: [
      { id: 'b0', sceneId: p.scenes[0].id, repeats: 1 },
      { id: 'b1', sceneId: p.scenes[1].id, repeats: 2 },
      { id: 'b2', sceneId: p.scenes[2].id, repeats: 2 },
      { id: 'b3', sceneId: p.scenes[3].id, repeats: 1 },
    ],
  };
  return p;
}

/** Notes of a bar-note part playing `row` over [from, to), its loop starting at `loop`. */
function plays(row: number, from: number, to: number, loop = from): [number, number][] {
  const out: [number, number][] = [];
  for (let t = from; t < to; t += BAR) out.push([t, pitchOf(row, ((t - loop) / BAR) % ROW_BARS[row])]);
  return out;
}

/** The unedited song on a bar-note part. */
const UNEDITED = [...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(2, 2304, 3072), ...plays(3, 3072, 3456)];

/** Drives a Sequencer the way RealtimeTransport and the session do. */
class Rig {
  readonly store: ProjectStore;
  readonly seq: Sequencer;
  now = 0;
  /** Everything handed out and not cancelled since: what the engine and the UI received. */
  out: SeqEvent[] = [];
  cuts: NoteCut[] = [];
  /** Voices released by a pause (note → tick). */
  private readonly released = new Map<NoteEvent, number>();

  constructor(p: Project = fixture()) {
    this.store = new ProjectStore(p);
    this.seq = new Sequencer({ getProject: () => this.store.getState() });
  }

  get project(): Project {
    return this.store.getState();
  }

  private pump(): void {
    this.out.push(...this.seq.process(this.now + LOOKAHEAD));
    this.cuts.push(...this.seq.takeCuts());
  }

  /** What the transport does after a change: cancel what was scheduled from `time`, regenerate. */
  cancelFrom(time: number): void {
    this.out = this.out.filter((e) => e.time < time);
    this.seq.invalidate(time);
    this.pump();
  }

  play(opts: StartOptions = { mode: { kind: 'song', fromBlock: 0 } }): this {
    this.seq.start(this.now + START, opts);
    this.pump();
    return this;
  }

  /** Let the audio clock run until the playhead reaches `tick`. */
  to(tick: number): this {
    const end = this.seq.timeAt(tick);
    while (this.now < end - 1e-9) {
      this.now = Math.min(end, this.now + TICKER);
      this.pump();
    }
    return this;
  }

  /** Play to the end of the song. */
  finish(): this {
    for (let guard = 0; !this.seq.ended && guard < 10_000; guard++) {
      this.now += TICKER;
      this.pump();
    }
    expect(this.seq.ended).toBe(true);
    return this;
  }

  /** Edit the project as the session does: the song follows (replan), edited clips regenerate. */
  edit(fn: (s: ProjectStore) => unknown): boolean {
    const before = this.project;
    fn(this.store);
    const at = this.now + MARGIN;
    const replanned = this.seq.replanSong(at);
    if (this.seq.playing && (replanned || this.project.tracks !== before.tracks)) this.cancelFrom(at);
    return replanned;
  }

  /** Tap a pad, as RealtimeTransport.launchClip does. */
  tap(trackId: Id, slot: number): this {
    const res = this.seq.launchClip(trackId, slot, this.now);
    if (res.atTick < this.seq.generatedTick) this.cancelFrom(Math.max(res.atTime, this.now));
    this.cuts.push(...this.seq.takeCuts());
    return this;
  }

  pause(): this {
    expect(this.seq.pause(this.now)).toBe(true);
    const tick = this.seq.getPosition(this.now).tick;
    // The transport cancels what has not started and releases what sounds.
    this.out = this.out.filter((e) => e.time <= this.now);
    for (const n of notesOf(this.out)) if (n.time + n.duration > this.now) this.released.set(n, tick);
    return this;
  }

  resume(): this {
    expect(this.seq.resume(this.now + START)).toBe(true);
    this.pump();
    return this;
  }

  /** [tick, pitch] of every note a part played, in order. */
  notes(trackId: Id): [number, number][] {
    return notesOf(this.out, trackId)
      .map((n) => [n.tick, n.pitch] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  /** Tick where a note stopped sounding (after cuts and pauses). */
  endOf(n: NoteEvent): number {
    let end = n.tick + n.durationTicks;
    for (const c of this.cuts) if (c.note === n) end = Math.min(end, c.tick);
    const r = this.released.get(n);
    return r === undefined ? end : Math.min(end, r);
  }

  /** [tick, pitch, end tick] of a held-chord part. */
  held(trackId: Id): [number, number, number][] {
    return notesOf(this.out, trackId)
      .sort((a, b) => a.tick - b.tick)
      .map((n) => [n.tick, n.pitch, this.endOf(n)]);
  }

  blocks(): [number, number, Id][] {
    return ofKind(this.out, 'block').map((b) => [b.tick, b.blockIndex, b.blockId]);
  }

  launches(trackId: Id): [number, number | null][] {
    return ofKind(this.out, 'launch')
      .filter((l) => l.trackId === trackId)
      .map((l) => [l.tick, l.slot]);
  }

  ends(): number[] {
    return ofKind(this.out, 'end').map((e) => e.tick);
  }
}

const sceneId = (r: Rig, row: number) => r.project.scenes[row].id;

describe('per-part changes in song blocks', () => {
  it('a layered part plays the other scene’s clip, an off part is silent, each from the block start exactly', () => {
    let p = fixture();
    p = { ...p, arrangement: { ...p.arrangement, blocks: [
      { id: 'a', sceneId: p.scenes[0].id, repeats: 1 },
      // Row 2 is one bar, but the layered 2-bar clip makes one pass two bars long.
      { id: 'b', sceneId: p.scenes[2].id, repeats: 1, parts: { t2: p.scenes[1].id, t4: null } },
      { id: 'c', sceneId: p.scenes[0].id, repeats: 1 },
    ] } };
    const r = new Rig(p).play().finish();
    expect(r.blocks()).toEqual([[0, 0, 'a'], [768, 1, 'b'], [1536, 2, 'c']]);
    expect(r.ends()).toEqual([2304]);
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(2, 768, 1536), ...plays(0, 1536, 2304)]);
    expect(r.notes('t2')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1536), ...plays(0, 1536, 2304)]);
    // The off part stops at the block start and comes back at the next one; its chord never sounds into the block.
    expect(r.held('t4')).toEqual([[0, 30, 768], [1536, 30, 2304]]);
    expect(r.launches('t4')).toEqual([[0, 0], [768, null], [1536, 0]]);
    expect(r.launches('t2')).toEqual([[0, 0], [768, 1], [1536, 0]]);
  });

  it('plays from a bar of the lane: the block containing it switches in at the start, every clip in phase', () => {
    // Bar 6 (tick 1920) is the fourth bar of b1: its 2-bar clips are in their second bar.
    const r = new Rig().play({ mode: { kind: 'song', fromBlock: 0 }, fromTick: 5 * BAR });
    expect(r.seq.getPosition(r.now).tick).toBe(1920);
    r.finish();
    expect(r.blocks()).toEqual([[1920, 1, 'b1'], [2304, 2, 'b2'], [3072, 3, 'b3']]);
    expect(r.notes('t1')).toEqual(UNEDITED.filter(([t]) => t >= 1920));
    expect(r.notes('t1')[0]).toEqual([1920, pitchOf(1, 1)]);
    // The held chord of b1 started before the start position: it is not played late.
    expect(r.held('t4')).toEqual([[3072, 90, 3456]]);
    // The plan is the whole lane: the blocks before the start are its history.
    expect(r.seq.songPlan()!.map((b) => [b.blockId, b.startTick])).toEqual([['b0', 0], ['b1', 768], ['b2', 2304], ['b3', 3072]]);
  });
});

describe('editing the song while it plays', () => {
  it('without edits, plays the lane as laid out', () => {
    const r = new Rig().play().finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.notes('t2')).toEqual(UNEDITED);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(r.ends()).toEqual([3456]);
  });

  it('reordered later blocks play in the new order; the end follows', () => {
    const r = new Rig().play().to(1000);
    expect(r.edit((s) => cmd.moveBlocks(s, ['b3'], 2))).toBe(true);
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(3, 2304, 2688), ...plays(2, 2688, 3456)]);
    expect(r.blocks()).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [2304, 2, 'b3'], [2688, 3, 'b2']]);
    expect(r.ends()).toEqual([3456]);
  });

  it('a block inserted before the playing one is history: nothing audible changes, later blocks report their new index', () => {
    const r = new Rig().play().to(1000);
    r.edit((s) => cmd.insertBlocks(s, [{ sceneId: sceneId(r, 3), repeats: 1 }], 0));
    const plan = r.seq.songPlan()!;
    // History is laid out in the current order, ending where the playing block started.
    expect(plan.map((b) => [b.index, b.startTick, b.endTick])).toEqual([[0, -384, 0], [1, 0, 768], [2, 768, 2304], [3, 2304, 3072], [4, 3072, 3456]]);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.blocks()).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [2304, 3, 'b2'], [3072, 4, 'b3']]);
    expect(r.ends()).toEqual([3456]);
  });

  it('a block inserted right after the playing one plays next', () => {
    const r = new Rig().play().to(1000);
    r.edit((s) => cmd.insertBlocks(s, [{ sceneId: sceneId(r, 3), repeats: 1 }], 2));
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(3, 2304, 2688), ...plays(2, 2688, 3456), ...plays(3, 3456, 3840)]);
    expect(r.ends()).toEqual([3840]);
  });

  it('extending the playing block keeps it going, in phase; the rest moves later', () => {
    const r = new Rig().play().to(1000);
    r.edit((s) => cmd.setBlockRepeats(s, 'b1', 3));
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 3072), ...plays(2, 3072, 3840), ...plays(3, 3840, 4224)]);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [2304, 50, 3072], [3840, 90, 4224]]);
    expect(r.ends()).toEqual([4224]);
  });

  it('shortening it ends it at its new end, or at the next bar line when that has passed', () => {
    const a = new Rig().play().to(1000);
    a.edit((s) => cmd.setBlockRepeats(s, 'b1', 1));
    a.finish();
    expect(a.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1536), ...plays(2, 1536, 2304), ...plays(3, 2304, 2688)]);
    expect(a.ends()).toEqual([2688]);

    // At tick 1800 the one-pass end (1536) is behind the playhead: the block ends at bar line 1920.
    const b = new Rig().play().to(1800);
    b.edit((s) => cmd.setBlockRepeats(s, 'b1', 1));
    b.finish();
    expect(b.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1920), ...plays(2, 1920, 2688), ...plays(3, 2688, 3072)]);
    expect(b.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [1920, 'b2'], [2688, 'b3']]);
    // Its held chord (second pass, from 1536) ends at the switch.
    expect(b.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 1920], [2688, 90, 3072]]);
    expect(b.ends()).toEqual([3072]);
  });

  it('a deleted playing block plays to its planned end, then the first block that followed it and still exists', () => {
    const a = new Rig().play().to(1000);
    a.edit((s) => cmd.removeBlocks(s, ['b1']));
    expect(a.seq.songPlan()!.map((b) => [b.index, b.blockId])).toEqual([[0, 'b0'], [-1, 'b1'], [1, 'b2'], [2, 'b3']]);
    a.finish();
    expect(a.notes('t1')).toEqual(UNEDITED);
    expect(a.blocks()).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [2304, 1, 'b2'], [3072, 2, 'b3']]);
    expect(a.ends()).toEqual([3456]);

    const b = new Rig().play().to(1000);
    b.edit((s) => cmd.removeBlocks(s, ['b1', 'b2']));
    b.finish();
    expect(b.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(3, 2304, 2688)]);
    expect(b.ends()).toEqual([2688]);

    // Its old successor moved to the end: the song goes on from there, so b3 (now before it) does not play.
    const c = new Rig().play().to(1000);
    c.edit((s) => cmd.removeBlocks(s, ['b1']));
    c.to(1100);
    c.edit((s) => cmd.moveBlocks(s, ['b2'], 3));
    c.finish();
    expect(c.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(2, 2304, 3072)]);
    expect(c.ends()).toEqual([3072]);
  });

  it('with every block removed, the playing block finishes and the song ends there, once', () => {
    const r = new Rig().play().to(1000);
    r.edit((s) => cmd.removeBlocks(s, ['b0', 'b1', 'b2', 'b3']));
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 2304)]);
    expect(r.ends()).toEqual([2304]);
  });

  it('changing the playing block’s scene switches every part at the next bar line, in phase with the block', () => {
    const r = new Rig().play().to(1000);
    r.edit((s) => cmd.setBlockScene(s, 'b1', sceneId(r, 3)));
    r.finish();
    // Row 3 is one bar: the block is now 2 bars (768–1536) and b2 follows at 1536.
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1152), ...plays(3, 1152, 1536, 768), ...plays(2, 1536, 2304), ...plays(3, 2304, 2688)]);
    expect(r.launches('t1')).toEqual([[0, 0], [768, 1], [1152, 3], [1536, 2], [2304, 3]]);
    // The chord sounding since 768 ends at the switch; row 3's chord starts there.
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1152], [1152, 90, 1536], [2304, 90, 2688]]);
    expect(r.ends()).toEqual([2688]);
  });

  it('changing one part switches only that part at the next bar line, in phase with the block', () => {
    const r = new Rig().play().to(1000);
    r.edit((s) => cmd.setBlockPart(s, 'b1', 't2', null));
    r.edit((s) => cmd.setBlockPart(s, 'b1', 't1', sceneId(r, 0)));
    r.finish();
    // t1 picks up row 0's clip in its second bar (the block started a bar before).
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1152), ...plays(0, 1152, 2304, 768), ...plays(2, 2304, 3072), ...plays(3, 3072, 3456)]);
    expect(r.notes('t1')[3]).toEqual([1152, pitchOf(0, 1)]);
    expect(r.notes('t2')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1152), ...plays(2, 2304, 3072), ...plays(3, 3072, 3456)]);
    expect(r.launches('t2')).toEqual([[0, 0], [768, 1], [1152, null], [2304, 2], [3072, 3]]);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
  });

  it('a clip made longer in a later block moves the blocks after it', () => {
    const r = new Rig().play().to(1000);
    expect(r.edit((s) => cmd.setClipBars(s, 't1', 2, 2))).toBe(true);
    r.finish();
    // b2 now passes 2 bars twice (2304–3840); t2's one-bar clip loops through it.
    expect(r.notes('t2')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(2, 2304, 3840), ...plays(3, 3840, 4224)]);
    expect(r.notes('t1').filter(([t]) => t >= 2304)).toEqual([[2304, 70], [3072, 70], [3840, 90]]);
    expect(r.ends()).toEqual([4224]);
  });

  it('replans while paused; Play continues the edited song from the pause point', () => {
    const r = new Rig().play().to(1300).pause();
    r.now += 3;
    expect(r.edit((s) => cmd.moveBlocks(s, ['b3'], 2))).toBe(true);
    expect(r.edit((s) => cmd.setBlockRepeats(s, 'b1', 3))).toBe(true);
    // A part changed while paused switches at the next bar line after the pause point.
    expect(r.edit((s) => cmd.setBlockPart(s, 'b1', 't2', null))).toBe(true);
    r.now += 1;
    r.resume().finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 3072), ...plays(3, 3072, 3456), ...plays(2, 3456, 4224)]);
    expect(r.notes('t2')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1536), ...plays(3, 3072, 3456), ...plays(2, 3456, 4224)]);
    expect(r.blocks().map(([t, i, id]) => [t, i, id])).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [3072, 2, 'b3'], [3456, 3, 'b2']]);
    expect(r.ends()).toEqual([4224]);
  });

  it('undo before the change takes effect leaves the song exactly as it was; undo after it switches back at the next bar', () => {
    const a = new Rig().play().to(1000);
    a.edit((s) => cmd.setBlockPart(s, 'b1', 't4', null));
    a.to(1100);
    a.edit((s) => s.undo());
    a.to(1200);
    a.edit((s) => cmd.moveBlocks(s, ['b3'], 2));
    a.to(1250);
    a.edit((s) => s.undo());
    a.finish();
    expect(a.notes('t1')).toEqual(UNEDITED);
    expect(a.notes('t2')).toEqual(UNEDITED);
    // The chord was never cut by the switch that did not happen.
    expect(a.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(a.launches('t4')).toEqual([[0, 0], [768, 1], [2304, null], [3072, 3]]);
    expect(a.ends()).toEqual([3456]);

    const b = new Rig().play().to(1000);
    b.edit((s) => cmd.setBlockScene(s, 'b1', sceneId(b, 3)));
    b.to(1300);
    b.edit((s) => s.undo());
    b.finish();
    // Row 3 from 1152, then row 1 again from 1536, in phase with the block (and the block is 4 bars again).
    expect(b.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1152), ...plays(3, 1152, 1536, 768), ...plays(1, 1536, 2304, 768), ...plays(2, 2304, 3072), ...plays(3, 3072, 3456)]);
    expect(b.ends()).toEqual([3456]);
  });

  it('an edit playback does not depend on leaves the plan alone; one to a block already played changes only history', () => {
    const r = new Rig().play().to(1000);
    expect(r.edit((s) => cmd.renameBlock(s, 'b2', 'Drop'))).toBe(false);
    expect(r.edit((s) => cmd.setBlockRepeats(s, 'b0', 2))).toBe(true);
    expect(r.seq.songPlan()!.map((b) => [b.blockId, b.startTick, b.endTick])).toEqual([['b0', -768, 768], ['b1', 768, 2304], ['b2', 2304, 3072], ['b3', 3072, 3456]]);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.blocks()).toEqual([[0, 0, 'b0'], [768, 1, 'b1'], [2304, 2, 'b2'], [3072, 3, 'b3']]);
  });

  it('an edit made right after Play, before the first block sounds, plays from the start', () => {
    const a = new Rig().play();
    a.edit((s) => cmd.setBlockPart(s, 'b0', 't1', sceneId(a, 1)));
    a.finish();
    expect(a.notes('t1')).toEqual([...plays(1, 0, 768), ...UNEDITED.filter(([t]) => t >= 768)]);

    // Deleted before it sounds, the block that followed it starts in its place.
    const b = new Rig().play();
    b.edit((s) => cmd.removeBlocks(s, ['b0']));
    b.finish();
    expect(b.notes('t1')).toEqual([...plays(1, 0, 1536), ...plays(2, 1536, 2304), ...plays(3, 2304, 2688)]);
    expect(b.blocks()).toEqual([[0, 0, 'b1'], [1536, 1, 'b2'], [2304, 2, 'b3']]);
  });

  it('a scene reorder is followed once (the song keeps its scenes); the replan after it changes nothing', () => {
    const r = new Rig().play().to(1000);
    const prev = r.project;
    cmd.moveScene(r.store, 1, 3);
    const p = r.project;
    // As the session does: the launcher follows the moved clips, the song its rows.
    const at = r.now + MARGIN;
    for (const t of p.tracks) {
      const was = prev.tracks.find((x) => x.id === t.id)!;
      const slots = new Map<number, number | null>();
      was.clips.forEach((c, i) => {
        if (c && t.clips[i]?.id !== c.id) slots.set(i, t.clips.findIndex((x) => x?.id === c.id));
      });
      r.seq.relocateSlots(t.id, slots, at);
    }
    const rows = new Map<number, number>();
    prev.scenes.forEach((sc, i) => {
      const j = p.scenes.findIndex((x) => x.id === sc.id);
      if (j !== i) rows.set(i, j);
    });
    expect(r.seq.relocateSongRows(rows)).toBe(true);
    expect(r.seq.replanSong(at)).toBe(false);
    r.cancelFrom(at);
    r.finish();
    // The same clips (their pitches name the row they were made in) at the same ticks.
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[0, 'b0'], [768, 'b1'], [2304, 'b2'], [3072, 'b3']]);
  });

  it('pad launches made while the song plays survive a replan; a pad tapped for a block start wins there', () => {
    const r = new Rig().play().to(1000).tap('t2', 3);
    r.edit((s) => cmd.moveBlocks(s, ['b3'], 2));
    r.to(2000).tap('t1', 0);
    r.edit((s) => cmd.setBlockRepeats(s, 'b3', 2));
    r.finish();
    // t2: row 3 from the next bar until the next block starts; then the song again.
    expect(r.notes('t2')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1152), ...plays(3, 1152, 2304), ...plays(3, 2304, 3072), ...plays(2, 3072, 3840)]);
    // t1: tapped in b1's last bar, row 0 starts with b3 and plays through it; b2 takes over at its start.
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(0, 2304, 3072), ...plays(2, 3072, 3840)]);
    expect(r.ends()).toEqual([3840]);
  });

  it('is only for song mode', () => {
    const r = new Rig();
    r.seq.launchScene(0, 0);
    r.play({ mode: { kind: 'live' } }).to(500);
    expect(r.edit((s) => cmd.moveBlocks(s, ['b3'], 0))).toBe(false);
    expect(r.seq.songPlan()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Random edit sequences                                               */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('random edits while the song plays', () => {
  it('keep the invariants: launches on bar lines, one clip per part at a time, no doubled notes, the end once, the plan equal to the lane', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
      const r = new Rig().play();
      let paused = false;
      for (let step = 0; step < 14 && !r.seq.ended; step++) {
        if (paused) {
          r.now += 0.5;
          if (rnd() < 0.5) {
            r.resume();
            paused = false;
          }
        } else {
          r.to(r.seq.getPosition(r.now).tick + 40 + Math.floor(rnd() * 500));
          if (r.seq.ended) break;
          if (rnd() < 0.12) {
            r.pause();
            paused = true;
          }
        }
        const p = r.project;
        const ids = p.arrangement.blocks.map((b) => b.id);
        const scene = () => pick(p.scenes).id;
        const op = Math.floor(rnd() * 10);
        r.edit((s) => {
          if (op === 0 && ids.length) cmd.moveBlocks(s, [pick(ids)], Math.floor(rnd() * (ids.length + 1)));
          else if (op === 1) cmd.insertBlocks(s, [{ sceneId: scene(), repeats: 1 + Math.floor(rnd() * 3) }], Math.floor(rnd() * (ids.length + 1)));
          else if (op === 2 && ids.length) cmd.removeBlocks(s, ids.filter(() => rnd() < 0.35));
          else if (op === 3 && ids.length) cmd.setBlockRepeats(s, pick(ids), 1 + Math.floor(rnd() * 4));
          else if (op === 4 && ids.length) cmd.setBlockPart(s, pick(ids), pick(['t1', 't2', 't4']), pick([null, undefined, scene()]));
          else if (op === 5 && ids.length) cmd.setBlockScene(s, pick(ids), scene());
          else if (op === 6) s.undo();
          else if (op === 7) s.redo();
          else if (op === 8) cmd.setClipBars(s, pick(['t1', 't2']), Math.floor(rnd() * 4), pick([1, 2, 4] as ClipBars[]));
          else if (ids.length) cmd.splitBlock(s, pick(ids), 1);
        });
        // Apart from a block deleted while it plays, the plan is the lane: same blocks, same order, same lengths.
        const plan = r.seq.songPlan();
        if (plan) {
          const lane = songBlocks(r.project);
          const live = plan.filter((b) => b.index >= 0);
          expect(live.map((b) => b.blockId), `seed ${seed}`).toEqual(lane.map((b) => b.blockId));
          expect(live.map((b) => b.index)).toEqual(lane.map((b) => b.index));
          const pos = r.seq.getPosition(r.now).tick;
          for (const b of live) {
            const l = lane.find((x) => x.blockId === b.blockId)!;
            // The block playing keeps its own end; every other one has its lane length.
            if (!(b.startTick <= pos && pos < b.endTick)) expect(b.endTick - b.startTick, `seed ${seed}`).toBe(l.endTick - l.startTick);
          }
          for (let i = 1; i < plan.length; i++) expect(plan[i].startTick).toBe(plan[i - 1].endTick);
        }
      }
      if (paused) r.resume();
      r.finish();

      const where = `seed ${seed}`;
      const ends = r.ends();
      expect(ends, where).toHaveLength(1);
      expect(ends[0] % BAR, where).toBe(0);
      const plan = r.seq.songPlan()!;
      expect(ends[0], where).toBe(plan.at(-1)?.endTick ?? ends[0]);
      for (const l of ofKind(r.out, 'launch')) expect(l.tick % BAR, where).toBe(0);
      const blocks = ofKind(r.out, 'block');
      for (let i = 0; i < blocks.length; i++) {
        expect(blocks[i].tick % BAR, where).toBe(0);
        if (i) expect(blocks[i].tick, where).toBeGreaterThan(blocks[i - 1].tick);
      }
      for (const trackId of ['t1', 't2', 't4']) {
        const ns = notesOf(r.out, trackId).sort((a, b) => a.tick - b.tick);
        const seen = new Set<string>();
        for (const n of ns) {
          const k = `${n.tick}:${n.pitch}`;
          expect(seen.has(k), `${where}: ${trackId} note ${k} twice`).toBe(false);
          seen.add(k);
          expect(n.tick, where).toBeLessThan(ends[0]);
          if (trackId !== 't4') expect(n.tick % BAR, where).toBe(0);
        }
        // One clip at a time: a note ends before a note of another clip starts.
        for (const n of ns) {
          for (const m of ns) {
            if (m === n || m.clipId === n.clipId || m.tick < n.tick) continue;
            expect(r.endOf(n), `${where}: ${trackId} ${n.clipId}@${n.tick} overlaps ${m.clipId}@${m.tick}`).toBeLessThanOrEqual(m.tick);
          }
        }
      }
    }
  });
});
