/**
 * Shared driver for the song playback tests (r5-engine-*.test.ts): runs a
 * Sequencer the way RealtimeTransport and the session do (25 ms ticker, the
 * transport's look-ahead, cancel-and-regenerate on every change; on an edit,
 * clips that moved within a part are followed first, then the song is laid
 * out again when what it plays changed) and records everything it hands out.
 * Also the oracle the tests compare with: the notes a song's regions play
 * through given passes, computed straight from the regions.
 */
import { expect } from 'vitest';
import { regionClip, regionEnd } from '../../src/project/arrangement';
import type { ClipBars, Id, Project, SongRegion, SongSection } from '../../src/project/types';
import { TICKS_PER_BAR } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import type { SeqEvent, SongLoop, StartOptions } from '../../src/time/contracts';
import { Sequencer, passEnd, songPlayChanged, type NoteCut, type NoteEvent, type SongPass } from '../../src/time/sequencer';
import { DEFAULT_LOOKAHEAD } from '../../src/time/transport';
import { makeClip, makeProject, notesOf, ofKind, setClip } from './sequencer-fixtures';

export const BAR = TICKS_PER_BAR;
export const BEAT = 96;
const LOOKAHEAD = DEFAULT_LOOKAHEAD;
const TICKER = 0.025;
/** INVALIDATE_MARGIN: live edits take effect this far ahead of the audio clock. */
export const MARGIN = 0.01;
const START = 0.05;

/** Bars of the clip in each slot. */
export const ROW_BARS = [2, 2, 1, 1];
/** Every bar-note clip plays one note on each of its bar lines; the pitch says its slot and which of its bars it is. */
export const pitchOf = (row: number, k: number) => 30 + row * 20 + k;
/** Beat-note clips (t5): one note on every beat; the pitch says the slot and the beat within the clip. */
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

/** The id of the clip in a part's slot. */
export function clipId(p: Project, trackId: Id, slot: number): Id {
  const c = p.tracks.find((t) => t.id === trackId)?.clips[slot];
  if (!c) throw new Error(`no clip in ${trackId} slot ${slot}`);
  return c.id;
}

/** A region of part `trackId` playing the clip in `slot` over bars [start, start + bars), `offset` bars into it. */
export function region(p: Project, id: Id, trackId: Id, slot: number, start: number, bars: number, offset = 0): SongRegion {
  return { id, trackId, clipId: clipId(p, trackId, slot), start, bars, offset };
}

/** Regions for every part with a clip in `slot`, over bars [start, start + bars) (like a scene placed on the song). */
export function sceneAt(p: Project, slot: number, start: number, bars: number, prefix = `s${slot}@${start}`): SongRegion[] {
  return p.tracks.filter((t) => t.clips[slot]).map((t) => region(p, `${prefix}:${t.id}`, t.id, slot, start, bars));
}

export function withSong(p: Project, regions: SongRegion[], sections: SongSection[] = []): Project {
  return { ...p, arrangement: { ...p.arrangement, regions, sections } };
}

/**
 * t1 and t2 play bar-note clips in every slot; t4 holds a chord in slots 0,
 * 1 and 3. Song (as 2.2's four blocks were): slot 0 over bars [0, 2), slot 1
 * over [2, 6), slot 2 over [6, 8), slot 3 over [8, 9).
 */
export function fixture(): Project {
  let p = makeProject(120);
  ROW_BARS.forEach((_, row) => {
    p = setClip(p, 't1', row, barClip(row));
    p = setClip(p, 't2', row, barClip(row));
    if (row !== 2) p = setClip(p, 't4', row, heldClip(row));
  });
  return withSong(p, [...sceneAt(p, 0, 0, 2), ...sceneAt(p, 1, 2, 4), ...sceneAt(p, 2, 6, 2), ...sceneAt(p, 3, 8, 1)]);
}

/** The fixture plus t5 playing a beat-note clip in every slot and region. */
export function beatFixture(): Project {
  let p = fixture();
  for (let row = 0; row < 4; row++) p = setClip(p, 't5', row, beatClip(row));
  return withSong(p, [...sceneAt(p, 0, 0, 2), ...sceneAt(p, 1, 2, 4), ...sceneAt(p, 2, 6, 2), ...sceneAt(p, 3, 8, 1)]);
}

/** Notes of a bar-note part playing slot `row` over ticks [from, to), its loop starting at `loop`. */
export function plays(row: number, from: number, to: number, loop = from, bars = ROW_BARS[row]): [number, number][] {
  const out: [number, number][] = [];
  for (let t = from; t < to; t += BAR) out.push([t, pitchOf(row, (((t - loop) / BAR) % bars + bars) % bars)]);
  return out;
}

/** The unedited fixture song on a bar-note part. */
export const UNEDITED = [...plays(0, 0, 768), ...plays(1, 768, 2304), ...plays(2, 2304, 3072), ...plays(3, 3072, 3456)];

/**
 * The oracle: [tick, pitch] of every note part `trackId` plays over
 * transport ticks [from, to) when the song `p` plays through `passes`,
 * straight from its regions (each clip in phase with its region).
 */
export function expectedNotes(p: Project, passes: readonly SongPass[], trackId: Id, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const pass of passes) {
    const pe = passEnd(pass);
    if (pass.at >= to || pe <= from) continue;
    for (const r of p.arrangement.regions) {
      if (r.trackId !== trackId) continue;
      const rc = regionClip(p, r);
      if (!rc) continue;
      const len = rc.clip.bars * BAR;
      const a = Math.max(r.start * BAR, pass.from);
      const b = Math.min(regionEnd(r) * BAR, pass.to);
      const anchor = (r.start - r.offset) * BAR;
      for (let base = anchor + Math.floor((a - anchor) / len) * len; base < b; base += len) {
        for (const n of rc.clip.notes) {
          const s = base + n.tick;
          if (s < a || s >= b) continue;
          const t = pass.at + (s - pass.from);
          if (t >= from && t < to) out.push([t, n.pitch]);
        }
      }
    }
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** The passes of a song played from `fromBar` with no loop: transport tick = song tick. */
export const straight = (fromBar = 0): SongPass[] => [{ at: fromBar * BAR, from: fromBar * BAR, to: Infinity }];

export class Rig {
  readonly store: ProjectStore;
  readonly seq: Sequencer;
  now = 0;
  /** Everything handed out and not cancelled since: what the engine and the UI received. */
  out: SeqEvent[] = [];
  cuts: NoteCut[] = [];
  /** Where each edit took effect (whole ticks): a song switch an edit makes lies there. */
  readonly editTicks: number[] = [];
  /** Voices released by a pause (note → tick). */
  private readonly released = new Map<NoteEvent, number>();
  /**
   * Every pass the song played or will play, by its transport start, kept
   * past the sequencer's pruning (a later layout replaces what it changed).
   */
  readonly passLog = new Map<number, SongPass>();

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

  /** The song bar under the playhead (fractional), as the Song view draws it. */
  get bar(): number | null {
    return this.seq.songBarAt(this.tick);
  }

  pump(): void {
    this.out.push(...this.seq.process(this.now + LOOKAHEAD));
    this.cuts.push(...this.seq.takeCuts());
    this.logPasses();
  }

  private logPasses(): void {
    const passes = this.seq.songPasses();
    if (!passes?.length) return;
    for (const at of [...this.passLog.keys()]) if (at >= passes[0].at) this.passLog.delete(at);
    for (const p of passes) this.passLog.set(p.at, p);
  }

  /** Every pass logged so far, in order. */
  allPasses(): SongPass[] {
    return [...this.passLog.values()].sort((a, b) => a.at - b.at);
  }

  /** What the transport does after a change: cancel what was scheduled from `time`, regenerate. */
  cancelFrom(time: number): void {
    this.out = this.out.filter((e) => e.time < time);
    this.seq.invalidate(time);
    this.pump();
  }

  play(opts: StartOptions = { mode: { kind: 'song', fromBar: 0 } }): this {
    this.seq.start(this.now + START, opts);
    this.pump();
    return this;
  }

  /** Play the song from bar `fromBar`. */
  playSong(fromBar = 0): this {
    return this.play({ mode: { kind: 'song', fromBar } });
  }

  /** As Session.setSongLoop: set (or clear) the loop; what was scheduled from the edit point is regenerated. */
  setLoop(loop: SongLoop | null): this {
    const at = this.now + MARGIN;
    this.editTicks.push(Math.ceil(this.seq.getPosition(this.seq.paused ? this.now : at).tick));
    if (this.seq.setSongLoop(loop, at) && this.seq.playing) this.cancelFrom(at);
    this.logPasses();
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
    for (let guard = 0; !this.seq.ended && guard < 40_000; guard++) {
      this.now += TICKER;
      this.pump();
    }
    expect(this.seq.ended).toBe(true);
    return this;
  }

  /**
   * Edit the project as the session does (Session.onProjectChange): the
   * launcher follows clips moved within a part, then the song is laid out
   * again when what it plays changed; any other change regenerates. Returns
   * whether the song was laid out again with a change.
   */
  edit(fn: (s: ProjectStore) => unknown): boolean {
    const prev = this.project;
    fn(this.store);
    const p = this.project;
    if (p === prev) return false;
    const at = this.now + MARGIN;
    this.editTicks.push(Math.ceil(this.seq.getPosition(this.seq.paused ? this.now : at).tick));
    if (p.tracks !== prev.tracks) {
      for (const tr of p.tracks) {
        const was = prev.tracks.find((x) => x.id === tr.id);
        if (!was || was.clips === tr.clips) continue;
        const slots = new Map<number, number | null>();
        was.clips.forEach((c, s) => {
          if (!c || tr.clips[s]?.id === c.id) return;
          const to = tr.clips.findIndex((x) => x?.id === c.id);
          if (to >= 0) slots.set(s, to);
        });
        if (slots.size && this.seq.relocateSlots(tr.id, slots, at) && this.seq.playing) this.cancelFrom(at);
      }
    }
    let replanned = false;
    if (this.seq.mode.kind === 'song' && (this.seq.playing || this.seq.paused) && songPlayChanged(p, prev)) {
      replanned = this.seq.replanSong(at);
      if (replanned && this.seq.playing) this.cancelFrom(at);
    }
    if (!replanned && this.seq.playing) this.cancelFrom(at);
    this.logPasses();
    return replanned;
  }

  /** Replace the song's regions (one undo step). */
  setRegions(regions: SongRegion[]): boolean {
    return this.edit((s) => s.apply('arrange:Test', (d) => void (d.arrangement.regions = regions)));
  }

  /** Change the song's regions with `fn` (one undo step). */
  regions(fn: (r: SongRegion[], p: Project) => SongRegion[]): boolean {
    return this.setRegions(fn(this.project.arrangement.regions, this.project));
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

  launches(trackId: Id): [number, number | null][] {
    return ofKind(this.out, 'launch')
      .filter((l) => l.trackId === trackId)
      .map((l) => [l.tick, l.slot]);
  }

  ends(): number[] {
    return ofKind(this.out, 'end').map((e) => e.tick);
  }

  /** The passes as they play now. */
  passes(): SongPass[] {
    return this.seq.songPasses() ?? [];
  }
}

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
