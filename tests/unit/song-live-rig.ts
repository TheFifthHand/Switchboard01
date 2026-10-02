/**
 * Shared driver for the song playback tests (song-live*.test.ts,
 * song-loop*.test.ts): runs a Sequencer the way RealtimeTransport and the
 * session do (25 ms ticker, 120 ms look-ahead, cancel-and-regenerate on every
 * change; on an edit, clips and scenes that moved are followed first, the
 * song loop follows the edit, then the song is replanned when its signature
 * or the loop changed) and records everything it hands out.
 */
import { expect } from 'vitest';
import type { ClipBars, Id, Project } from '../../src/project/types';
import { TICKS_PER_BAR } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import type { SeqEvent, SongLoop, StartOptions } from '../../src/time/contracts';
import { Sequencer, songBlocks, songSignature, type NoteCut, type NoteEvent, type SongBlockPlan } from '../../src/time/sequencer';
import { SongLoopHistory, sameSongLoop, songLoopRange } from '../../src/time/songLoop';
import { makeClip, makeProject, notesOf, ofKind, setClip } from './sequencer-fixtures';

export const BAR = 384;
export const BEAT = 96;
const LOOKAHEAD = 0.12;
const TICKER = 0.025;
/** INVALIDATE_MARGIN: live edits take effect this far ahead of the audio clock. */
export const MARGIN = 0.01;
const START = 0.05;

/** Bars of the clips in each scene row. */
export const ROW_BARS = [2, 2, 1, 1];
/** Every bar-note clip plays one note on each of its bar lines; the pitch says its row and which of its bars it is. */
export const pitchOf = (row: number, k: number) => 30 + row * 20 + k;
/** Beat-note clips (t5): one note on every beat; the pitch says the row and the beat within the clip. */
export const beatPitch = (row: number, beat: number) => 100 + row * 8 + beat;

export function barClip(row: number, bars = ROW_BARS[row]) {
  return makeClip(bars as ClipBars, Array.from({ length: bars }, (_, k) => [k * BAR, pitchOf(row, k), 48] as [number, number, number]), `bars${row}`);
}

/** One chord held through the whole clip. */
export function heldClip(row: number, bars = ROW_BARS[row]) {
  return makeClip(bars as ClipBars, [[0, pitchOf(row, 0), bars * BAR]], `held${row}`);
}

/** One bar, a note on every beat. */
export function beatClip(row: number) {
  return makeClip(1, Array.from({ length: 4 }, (_, b) => [b * BEAT, beatPitch(row, b), 48] as [number, number, number]), `beats${row}`);
}

/**
 * t1 and t2 play bar-note clips in every row; t4 holds a chord in rows 0, 1
 * and 3. Song: b0 row 0 x1 [0, 768), b1 row 1 x2 [768, 2304), b2 row 2 x2
 * [2304, 3072), b3 row 3 x1 [3072, 3456).
 */
export function fixture(): Project {
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

/** The fixture plus t5 playing a beat-note clip in every row (block lengths stay the same). */
export function beatFixture(): Project {
  let p = fixture();
  for (let row = 0; row < 4; row++) p = setClip(p, 't5', row, beatClip(row));
  return p;
}

/** Notes of a bar-note part playing `row` over [from, to), its loop starting at `loop`. */
export function plays(row: number, from: number, to: number, loop = from, bars = ROW_BARS[row]): [number, number][] {
  const out: [number, number][] = [];
  for (let t = from; t < to; t += BAR) out.push([t, pitchOf(row, ((t - loop) / BAR) % bars)]);
  return out;
}

/** Notes of the beat part playing `row` over [from, to) (first beat at or after `from`). */
export function beats(row: number, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (let t = Math.ceil(from / BEAT) * BEAT; t < to; t += BEAT) out.push([t, beatPitch(row, (t / BEAT) % 4)]);
  return out;
}

/** The unedited song on a bar-note part. */
export const UNEDITED = [...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(2, 2304, 3072), ...plays(3, 3072, 3456)];

export class Rig {
  readonly store: ProjectStore;
  readonly seq: Sequencer;
  now = 0;
  /** Everything handed out and not cancelled since: what the engine and the UI received. */
  out: SeqEvent[] = [];
  cuts: NoteCut[] = [];
  /** Where each edit took effect (whole ticks): a song switch an edit makes lies there. */
  readonly editTicks: number[] = [];
  /**
   * With `traceLane`: the lane playhead after every ticker step, how many
   * edits were made by then, and the song loop on the lane ([start, end)
   * ticks) with whether the block the lane shows at the playhead is in it.
   */
  traceLane = false;
  readonly laneTrace: { lane: number; edits: number; total: number; loop: [number, number] | null; inside: boolean }[] = [];
  /** The song loop as the session holds it (runtime `songLoop`). */
  loop: SongLoop | null = null;
  /** How the loop follows edits, undo and redo (as the session). */
  readonly loopHistory = new SongLoopHistory();
  /** Voices released by a pause (note → tick). */
  private readonly released = new Map<NoteEvent, number>();

  constructor(p: Project = fixture()) {
    this.store = new ProjectStore(p);
    this.seq = new Sequencer({ getProject: () => this.store.getState() });
  }

  get project(): Project {
    return this.store.getState();
  }

  /** The transport's playhead now. */
  get tick(): number {
    return this.seq.getPosition(this.now).tick;
  }

  pump(): void {
    this.out.push(...this.seq.process(this.now + LOOKAHEAD));
    this.cuts.push(...this.seq.takeCuts());
    if (this.traceLane && this.seq.songPlan()) {
      const lane = this.lane();
      const range = songLoopRange(lane, this.loop);
      const at = this.seq.songBlockAt(this.tick);
      const i = at ? lane.findIndex((b) => b.blockId === at.blockId) : -1;
      this.laneTrace.push({
        lane: this.laneTick()!,
        edits: this.editTicks.length,
        total: lane.at(-1)?.endTick ?? 0,
        loop: range ? [lane[range[0]].startTick, lane[range[1]].endTick] : null,
        inside: !!range && i >= range[0] && i <= range[1],
      });
    }
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

  /**
   * As Session.playSong: from block `fromBlock` or lane bar `fromBar`; with
   * neither (Play song), from the loop's first block when a loop is set.
   */
  playSong(fromBlock?: number, fromBar?: number): this {
    let block = fromBlock ?? 0;
    if (fromBlock === undefined && fromBar === undefined) {
      const lane = songBlocks(this.project);
      const range = songLoopRange(lane, this.loop);
      if (range) block = lane[range[0]].index;
    }
    return this.play({ mode: { kind: 'song', fromBlock: block }, fromTick: fromBar === undefined ? undefined : fromBar * TICKS_PER_BAR });
  }

  /** As Session.setSongLoop: set (or clear) the loop; what was scheduled from the edit point is regenerated. */
  setLoop(from: Id | null, to: Id | null = from): this {
    const loop = from === null || to === null ? null : { fromBlockId: from, toBlockId: to };
    if (sameSongLoop(this.loop, loop)) return this;
    const at = this.now + MARGIN;
    this.editTicks.push(Math.ceil(this.seq.getPosition(this.seq.paused ? this.now : at).tick));
    this.loop = loop;
    if (this.seq.setSongLoop(loop, at) && this.seq.playing) this.cancelFrom(at);
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

  /** Let the audio clock run for `seconds`. */
  wait(seconds: number): this {
    const end = this.now + seconds;
    while (this.now < end - 1e-9) {
      this.now = Math.min(end, this.now + TICKER);
      this.pump();
    }
    return this;
  }

  /** Play to the end of the song. */
  finish(): this {
    for (let guard = 0; !this.seq.ended && guard < 20_000; guard++) {
      this.now += TICKER;
      this.pump();
    }
    expect(this.seq.ended).toBe(true);
    return this;
  }

  /**
   * Edit the project as the session does (Session.onProjectChange): the
   * launcher follows clips and scenes that moved (in song mode a clip that
   * left its part is left to the replan), then the song is replanned when its
   * signature changed; any other change regenerates. Returns whether the song
   * was replanned.
   */
  edit(fn: (s: ProjectStore) => unknown): boolean {
    const prev = this.project;
    fn(this.store);
    const p = this.project;
    if (p === prev) return false;
    const at = this.now + MARGIN;
    this.editTicks.push(Math.ceil(this.seq.getPosition(this.seq.paused ? this.now : at).tick));
    const song = this.seq.mode.kind === 'song';
    if (p.scenes !== prev.scenes) {
      const rows = new Map<number, number>();
      prev.scenes.forEach((s, i) => {
        const j = p.scenes.findIndex((x) => x.id === s.id);
        if (j >= 0 && j !== i) rows.set(i, j);
      });
      if (rows.size && this.seq.relocateSongRows(rows) && this.seq.playing) this.cancelFrom(at);
    }
    if (p.tracks !== prev.tracks) {
      const partOf = new Map<Id, Id>();
      for (const tr of p.tracks) for (const c of tr.clips) if (c) partOf.set(c.id, tr.id);
      for (const tr of p.tracks) {
        const was = prev.tracks.find((x) => x.id === tr.id);
        if (!was || was.clips === tr.clips) continue;
        const slots = new Map<number, number | null>();
        was.clips.forEach((c, s) => {
          if (!c || tr.clips[s]?.id === c.id) return;
          const to = tr.clips.findIndex((x) => x?.id === c.id);
          if (to >= 0) slots.set(s, to);
          else if (partOf.has(c.id) && !song) slots.set(s, null);
        });
        if (slots.size && this.seq.relocateSlots(tr.id, slots, at) && this.seq.playing) this.cancelFrom(at);
      }
    }
    // The loop follows the edit (blocks deleted, split, joined; undo and redo of a step that changed it)
    // and goes to the replan with it.
    const loop = this.loopHistory.follow(this.loop, prev, p, this.store.lastChange());
    let replanned = false;
    if (song && (this.seq.playing || this.seq.paused) && (songSignature(p) !== songSignature(prev) || !sameSongLoop(this.seq.songLoop, loop))) {
      replanned = this.seq.replanSong(at, loop);
      if (replanned && this.seq.playing) this.cancelFrom(at);
    }
    if (!sameSongLoop(this.seq.songLoop, loop)) this.seq.replanSong(at, loop);
    this.loop = loop;
    if (!replanned && this.seq.playing) this.cancelFrom(at);
    return replanned;
  }

  /** Tap a pad, as RealtimeTransport.launchClip does. */
  tap(trackId: Id, slot: number): this {
    const res = this.seq.launchClip(trackId, slot, this.now);
    if (res.atTick < this.seq.generatedTick) this.cancelFrom(Math.max(res.atTime, this.now));
    this.cuts.push(...this.seq.takeCuts());
    return this;
  }

  setTempo(bpm: number): this {
    const at = this.now + MARGIN;
    this.seq.setTempo(bpm, at);
    if (this.seq.playing) this.cancelFrom(at);
    return this;
  }

  pause(): this {
    expect(this.seq.pause(this.now)).toBe(true);
    const tick = this.tick;
    // The transport cancels what has not started and releases what sounds (a note released by an earlier pause stays released there).
    this.out = this.out.filter((e) => e.time <= this.now);
    for (const n of notesOf(this.out)) if (n.time + n.duration > this.now && !this.released.has(n)) this.released.set(n, tick);
    return this;
  }

  resume(): this {
    expect(this.seq.resume(this.now + START)).toBe(true);
    this.pump();
    return this;
  }

  private laneCache: { project: Project; blocks: SongBlockPlan[] } | null = null;

  /** The blocks on the lane as the project has them now. */
  lane(): SongBlockPlan[] {
    if (this.laneCache?.project !== this.project) this.laneCache = { project: this.project, blocks: songBlocks(this.project) };
    return this.laneCache.blocks;
  }

  /** The lane playhead (ticks from the lane start), as songTimelineBar draws it; null when the song is not on. */
  laneTick(): number | null {
    return this.seq.songLaneTickAt(this.lane(), this.tick);
  }

  /** [blockId, index, start, end] of every block of the plan. */
  plan(): [Id, number, number, number][] {
    return (this.seq.songPlan() ?? []).map((b) => [b.blockId, b.index, b.startTick, b.endTick]);
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

export const sceneId = (r: Rig, row: number) => r.project.scenes[row].id;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
