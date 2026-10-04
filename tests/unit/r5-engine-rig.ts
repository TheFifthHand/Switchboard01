/**
 * Shared driver for the song playback tests (r5-engine-*.test.ts): runs a
 * Sequencer the way RealtimeTransport and the session do (25 ms ticker, the
 * transport's look-ahead, cancel-and-regenerate on every change; on an edit,
 * clips that moved within a part are followed first, then the song is laid
 * out again when what it plays changed) and records everything it hands out.
 * Also the oracle the tests compare with: the notes a song's regions play
 * through given passes, computed straight from the regions.
 */
import { expect, vi } from 'vitest';
import type { AudioEngineApi, NoteTrigger, VoiceHandle } from '../../src/audio/contracts';
import { regionClip, regionEnd } from '../../src/project/arrangement';
import type { ClipBars, Id, Project, SongRegion, SongSection } from '../../src/project/types';
import { TICKS_PER_BAR } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import type { SeqEvent, SongLoop, StartOptions } from '../../src/time/contracts';
import { Sequencer, passEnd, songPlayChanged, type NoteCut, type NoteEvent, type SongPass } from '../../src/time/sequencer';
import { DEFAULT_LOOKAHEAD, RealtimeTransport } from '../../src/time/transport';
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

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Parts whose held notes are chased (synth and bass; not drums, not samplers). */
export function chasesNotes(p: Project, trackId: Id): boolean {
  const kind = p.tracks.find((t) => t.id === trackId)?.instrument.kind;
  return kind === 'poly' || kind === 'bass';
}

/**
 * The oracle for note chase, from the regions alone: the notes of part
 * `trackId` sounding at song tick `s` when the song plays straight through
 * (begun before `s`, ending after it), with their song ticks. A note
 * sounds from its start to its length in the clip (a mono part's next note
 * ends it), within its region; touching regions of the same clip in phase
 * play on as one.
 */
export function soundingAt(p: Project, trackId: Id, s: number): { pitch: number; velocity: number; start: number; end: number }[] {
  const regs = p.arrangement.regions.filter((r) => r.trackId === trackId && regionClip(p, r)).sort((a, b) => a.start - b.start);
  const i = regs.findIndex((r) => r.start * BAR <= s && s < regionEnd(r) * BAR);
  if (i < 0) return [];
  const r = regs[i];
  const clip = regionClip(p, r)!.clip;
  const len = clip.bars * BAR;
  const anchor = (r.start - r.offset) * BAR;
  const joins = (q: SongRegion) => q.clipId === r.clipId && mod((q.start - q.offset) * BAR - anchor, len) === 0;
  let runFrom = r.start * BAR;
  for (let k = i - 1; k >= 0 && regionEnd(regs[k]) * BAR === runFrom && joins(regs[k]); k--) runFrom = regs[k].start * BAR;
  let runTo = regionEnd(r) * BAR;
  for (let k = i + 1; k < regs.length && regs[k].start * BAR === runTo && joins(regs[k]); k++) runTo = regionEnd(regs[k]) * BAR;
  const mono = p.tracks.find((t) => t.id === trackId)?.instrument.kind === 'bass';
  let notes = clip.notes.map((n) => ({ tick: n.tick, pitch: n.pitch, velocity: n.velocity, end: Math.min(n.tick + n.duration, len) })).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  if (mono) {
    notes = notes.filter((n, k) => k === 0 || notes[k - 1].tick !== n.tick);
    notes = notes.map((n, k) => ({ ...n, end: Math.min(n.end, k + 1 < notes.length ? notes[k + 1].tick : len) }));
  }
  const base = anchor + Math.floor((s - anchor) / len) * len;
  const out: { pitch: number; velocity: number; start: number; end: number }[] = [];
  for (const n of notes) {
    const start = base + n.tick;
    const end = Math.min(base + n.end, runTo);
    if (start < s && start >= runFrom && end > s) out.push({ pitch: n.pitch, velocity: n.velocity, start, end });
  }
  return out;
}

/** The song tick transport tick `tick` plays through `passes` (the pass starting there, at a seam). */
export function songTickOf(passes: readonly SongPass[], tick: number): number | null {
  for (let i = passes.length - 1; i >= 0; i--) {
    const p = passes[i];
    if (p.at > tick) continue;
    return tick < passEnd(p) ? p.from + (tick - p.at) : null;
  }
  return null;
}

/** What a part plays at transport tick `tick` through `passes`: its clip and loop phase, or '' (silent). */
function playKey(p: Project, passes: readonly SongPass[], trackId: Id, tick: number): string {
  const s = songTickOf(passes, tick);
  if (s === null) return '';
  const r = p.arrangement.regions.find((x) => x.trackId === trackId && x.start * BAR <= s && s < regionEnd(x) * BAR);
  const rc = r && regionClip(p, r);
  if (!r || !rc) return '';
  const len = rc.clip.bars * BAR;
  return `${r.clipId}/${mod(tick - (s - (r.start - r.offset) * BAR), len)}`;
}

/**
 * [tick, pitch] of the notes the song chases for part `trackId` where a
 * pass starts in [from, to): playback enters the part's music there in the
 * middle (it played something else, or nothing, just before), and a note
 * sounding there with at least a 16th left is played from there.
 */
export function expectedChases(p: Project, passes: readonly SongPass[], trackId: Id, from: number, to: number): [number, number][] {
  if (!chasesNotes(p, trackId)) return [];
  const out: [number, number][] = [];
  passes.forEach((pass, i) => {
    if (pass.at < from || pass.at >= to) return;
    if (i > 0 && playKey(p, passes, trackId, pass.at - 0.5) === playKey(p, passes, trackId, pass.at)) return;
    for (const n of soundingAt(p, trackId, pass.from)) if (n.end - pass.from >= 24) out.push([pass.at, n.pitch]);
  });
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

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
  /** Where each pause held (transport ticks). */
  readonly pauses: number[] = [];
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

  /** Stop a part at the next bar, as RealtimeTransport.stopTrack does (the session's tap on the playing pad). */
  stopPart(trackId: Id): this {
    const res = this.seq.stopTrack(trackId, this.now);
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
    this.pauses.push(tick);
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

  /** [tick, pitch] of every note a part started, in order (chased notes are in `chased`). */
  notes(trackId: Id): [number, number][] {
    return notesOf(this.out, trackId)
      .filter((n) => !n.chased)
      .map((n) => [n.tick, n.pitch] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  /** [tick, pitch] of every chased note of a part (sounding from `tick`), in order. */
  chased(trackId: Id): [number, number][] {
    return notesOf(this.out, trackId)
      .filter((n) => n.chased)
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

/** A voice the fake engine was asked to play: when it starts, when its gate ends, and what became of it. */
export interface Voice {
  trackId: Id;
  pitch: number;
  time: number;
  /** Scheduled end (time + duration). */
  end: number;
  released: number | null;
  cancelled: boolean;
  /** The sequencer's note it plays (null when none matched). */
  note: NoteEvent | null;
}

/** When a voice is heard to end: its scheduled end or its release, whichever comes first. */
export const heardEnd = (v: Voice): number => Math.min(v.end, v.released ?? Infinity);

/**
 * The real RealtimeTransport and Sequencer on a fake audio clock and wall
 * clock (the ticker under fake timers: call vi.useFakeTimers first), with a
 * fake engine that keeps every voice it was given: scheduled, released and
 * cancelled. What the engine is asked to sound is what is heard.
 */
export class TransportRig {
  readonly ctx = { currentTime: 0, state: 'running', sampleRate: 48000, outputLatency: 0, baseLatency: 0, addEventListener() {}, removeEventListener() {} };
  readonly store: ProjectStore;
  readonly seq: Sequencer;
  readonly transport: RealtimeTransport;
  readonly voices: Voice[] = [];
  wall = 1000;
  private batch: SeqEvent[] = [];

  constructor(p: Project) {
    this.store = new ProjectStore(p);
    this.seq = new Sequencer({ getProject: () => this.store.getState() });
    const process = this.seq.process.bind(this.seq);
    this.seq.process = (until: number) => (this.batch = process(until));
    const voices = this.voices;
    const self = this;
    const nop = () => {};
    const engine = {
      ctx: this.ctx,
      scheduleNote(trackId: Id, n: NoteTrigger): VoiceHandle {
        const note = self.batch.find((e): e is NoteEvent => e.kind === 'note' && e.trackId === trackId && e.pitch === n.pitch && e.time === n.time && !voices.some((v) => v.note === e)) ?? null;
        const v: Voice = { trackId, pitch: n.pitch, time: n.time, end: n.time + (n.duration ?? Infinity), released: null, cancelled: false, note };
        voices.push(v);
        const release = (t: number) => {
          if (v.released === null || t < v.released) v.released = t;
        };
        return { startTime: n.time, release, stop: release, cancel: () => void (v.cancelled = true), ended: false };
      },
      setProject: nop,
      schedulePump: nop,
      scheduleClick: nop,
      scheduleParam: nop,
      scheduleMacro: nop,
      scheduleMute: nop,
      scheduleMasterVolume: nop,
      scheduleSongGain: nop,
      scheduleMacroRamp: nop,
      cancelScheduledAutomation: nop,
      transportStarted: nop,
      transportStopped: nop,
      tempoChanged: nop,
      liveNoteOn: nop,
      liveNoteOff: nop,
      releaseLive: nop,
      setMasterVolume: nop,
      setMuteAll: nop,
      panic: nop,
      output: null,
      readMeters: nop,
      getStats: () => ({ voices: 0, modules: 0, connections: 0, pendingTimers: 0 }),
      dispose: nop,
    };
    this.transport = new RealtimeTransport({
      ctx: this.ctx as unknown as BaseAudioContext,
      engine: engine as unknown as AudioEngineApi,
      sequencer: this.seq,
      isHidden: () => false,
      wallClock: () => this.wall,
    });
  }

  /** Time passes with the ticker running (25 ms ticks). */
  run(ms: number): this {
    for (let t = 0; t < ms; t += 25) {
      this.ctx.currentTime += 0.025;
      this.wall += 25;
      vi.advanceTimersByTime(25);
    }
    return this;
  }

  /** The main thread is busy: the clocks run, no tick happens. */
  block(ms: number): this {
    this.ctx.currentTime += ms / 1000;
    this.wall += ms;
    return this;
  }

  /** Run until the playhead reaches transport bar `bar`. */
  toBar(bar: number): this {
    for (let guard = 0; guard < 100_000 && this.transport.getPosition().tick < bar * BAR; guard++) this.run(25);
    return this;
  }

  /** Run until the transport stops by itself. */
  toEnd(): this {
    for (let guard = 0; guard < 100_000 && this.transport.playing; guard++) this.run(25);
    return this;
  }

  /** Voices not cancelled (they sound, at least from their start to their heard end). */
  heard(trackId?: Id): Voice[] {
    return this.voices.filter((v) => !v.cancelled && (trackId === undefined || v.trackId === trackId));
  }

  /** An edit as the session follows it: the song laid out again when what it plays changed, else regenerated. */
  edit(fn: (s: ProjectStore) => unknown): void {
    const prev = this.store.getState();
    fn(this.store);
    const p = this.store.getState();
    if (p === prev) return;
    const song = this.seq.mode.kind === 'song' && (this.seq.playing || this.seq.paused);
    if (!(song && songPlayChanged(p, prev) && this.transport.replanSong())) this.transport.invalidate();
  }

  dispose(): void {
    this.transport.dispose();
  }
}
