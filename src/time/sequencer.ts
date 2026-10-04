/**
 * Sequencer (pure: no DOM, no Web Audio).
 *
 * Turns the project (clips, launcher, arrangement, performances, arp input)
 * into timed `SeqEvent`s for windows of the transport timeline. A driver
 * (RealtimeTransport, renderOffline) calls `process(untilTime)` repeatedly
 * and schedules what comes back on the audio clock.
 *
 * See src/time/contracts.ts for the timing model. Implementation notes:
 * - Every state change (clip switch, a song region's start or end, a
 *   recorded control event, the end) is a boundary: the window is generated
 *   up to it, the change is applied, generation continues. Applied switches are kept in a short
 *   history so `invalidate()` can roll them back and replay them.
 * - A note already handed out can only be shortened through a `NoteCut`
 *   (`takeCuts()`): the driver releases that voice early. That happens when
 *   a launch is queued after the outgoing clip's note was generated, a mono
 *   part gets a new note while an earlier one is still sounding, or a tempo
 *   change makes a sounding note's end tick come sooner.
 * - A replayed take's recorded tempo changes are all in the clock from the
 *   start, so every note length and time already follows them.
 * - Song mode plays the song's regions on an absolute song timeline mapped
 *   onto the transport through passes (`SongPass`, see contracts.ts). Each
 *   part's regions become 'song' transitions in its launcher (the clip, in
 *   phase, at a region's start; silence at its end unless the next region
 *   starts there), laid out a little ahead of the generation cursor
 *   (`extendSong`), so a looping song never grows its plan.
 *   `replanSong()` lays them out again from the edit point when the song is
 *   edited while it plays or is paused: a part whose music changed there
 *   switches there, in phase; nothing else moves, and the playhead never
 *   jumps (time is absolute).
 */
import {
  MAX_SONG_BARS,
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  TICKS_PER_STEP,
  type Clip,
  type ClipSample,
  type Id,
  type LauncherSnapshotEntry,
  type MacroId,
  type Performance,
  type PerformanceEvent,
  type Project,
  type Track,
} from '../project/types';
import { regionClip, regionEnd, songBars } from '../project/arrangement';
import type { ClipPhase, LaunchResult, PlayMode, SeqEvent, SongLoop, StartOptions, TrackLaunchState } from './contracts';
import { MAX_SWING_TICKS, TempoMap, clampBpm, clampSwing, swingWarp } from './clock';
import { EMPTY_LATCH, arpDivisionTicks, arpGateTicks, arpGridAtOrAfter, arpInput, arpNoteAt, updateLatch, type LatchState } from './arp';
import { GAIN_KEY, hasMoves, restValue, segmentAt, timelineSegments, valueIn, type MoveSegment, type SectionSpan } from './moves';
import { projectFromSnapshot } from './snapshot';
import { cleanSongLoop, sameSongLoop } from './songLoop';

export type NoteEvent = Extract<SeqEvent, { kind: 'note' }>;
export type BeatEvent = Extract<SeqEvent, { kind: 'beat' }>;

/** Shorten a note that was already handed out: release its voice at `time`. */
export interface NoteCut {
  note: NoteEvent;
  trackId: Id;
  tick: number;
  time: number;
}

export interface SequencerOptions {
  getProject: () => Project;
}

export interface SeqPosition {
  tick: number;
  bar: number;
  /** 0..3 */
  beat: number;
  /** 0..15 */
  step: number;
}

/** Applied transport state older than this is forgotten; `invalidate()` cannot rewind further back. */
export const HISTORY_TICKS = 8 * TICKS_PER_BAR;
export const DEFAULT_ARP_VELOCITY = 0.8;
const MAX_RECENT = 512;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** The next bar line strictly after `tick`. */
export function nextBarTick(tick: number): number {
  return (Math.floor(tick / TICKS_PER_BAR) + 1) * TICKS_PER_BAR;
}

export function positionOf(tick: number): SeqPosition {
  const bar = Math.floor(tick / TICKS_PER_BAR);
  const within = tick - bar * TICKS_PER_BAR;
  return { tick, bar, beat: Math.floor(within / TICKS_PER_BEAT), step: Math.floor(within / TICKS_PER_STEP) };
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function clipLength(clip: Clip): number {
  return clampInt(clip.bars, 1, 64) * TICKS_PER_BAR;
}

/* ------------------------------------------------------------------ */
/* Song timeline                                                       */
/* ------------------------------------------------------------------ */

/**
 * A stretch of the song timeline as playback plays it: song ticks [from, to)
 * from transport tick `at` on (song tick from + k plays at transport tick
 * at + k). `to` is Infinity for the last pass of a song that plays on to its
 * end. Passes are whole bars and follow one another without gaps.
 */
export interface SongPass {
  at: number;
  from: number;
  to: number;
}

/** Transport tick where a pass ends (Infinity for an open one). */
export function passEnd(p: SongPass): number {
  return p.to === Infinity ? Infinity : p.at + (p.to - p.from);
}

/** Song length in ticks: where its last region or section ends. */
export function songLengthTicks(project: Project): number {
  return songBars(project) * TICKS_PER_BAR;
}

/** One region of a part in song ticks: the clip it plays, in phase. */
interface PartSpan {
  from: number;
  to: number;
  clipId: Id;
  /** Song tick where the clip's loop starts (its position 0) for this region: at or before `from`. */
  anchor: number;
  /** The clip's length in ticks. */
  len: number;
}

/** What a part plays in the song: a clip and the transport tick its loop counts from, or null (silent). */
interface SongPlay {
  clipId: Id;
  /** Canonical: the loop start in (−len, 0], so one phase has one value. */
  loopStart: number;
}

/** Each part's regions as spans of song ticks, in time order (regions whose clip is gone play nothing). */
function songParts(project: Project): Map<Id, PartSpan[]> {
  const out = new Map<Id, PartSpan[]>();
  for (const r of project.arrangement.regions) {
    const rc = regionClip(project, r);
    if (!rc) continue;
    const len = clipLength(rc.clip);
    const from = r.start * TICKS_PER_BAR;
    let list = out.get(r.trackId);
    if (!list) out.set(r.trackId, (list = []));
    list.push({ from, to: regionEnd(r) * TICKS_PER_BAR, clipId: rc.clip.id, anchor: from - r.offset * TICKS_PER_BAR, len });
  }
  for (const list of out.values()) {
    list.sort((x, y) => x.from - y.from);
    // Regions of a part never overlap (see tidyRegions); should two, the later one wins from its start.
    for (let i = 0; i + 1 < list.length; i++) if (list[i].to > list[i + 1].from) list[i] = { ...list[i], to: list[i + 1].from };
  }
  return out;
}

/**
 * Identity of what the song plays: every region (part, clip, place, length,
 * offset), the clips' lengths and slots, and the song's length. A change of
 * it while the song plays is what `Sequencer.replanSong` follows.
 */
export function songSignature(project: Project): string {
  const out: string[] = [String(songBars(project))];
  for (const r of project.arrangement.regions) {
    const rc = regionClip(project, r);
    out.push(`${r.trackId}:${r.clipId}:${r.start}+${r.bars}@${r.offset}:${rc ? `${rc.slot}/${rc.clip.bars}` : '-'}`);
  }
  return out.join('|');
}

/** a mod n in [0, n). */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** A loop start as one value per phase: in (−len, 0]. */
function canonicalLoopStart(tick: number, len: number): number {
  const r = mod(tick, len);
  return r === 0 ? 0 : r - len;
}

function samePlay(a: SongPlay | null | undefined, b: SongPlay | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.clipId === b.clipId && a.loopStart === b.loopStart;
}

/** Index of the pass holding transport tick `tick` (the first before they start, the last after they end), -1 for none. */
function passIndexAt(passes: readonly SongPass[], tick: number): number {
  if (!passes.length) return -1;
  for (let i = passes.length - 1; i >= 0; i--) if (passes[i].at <= tick) return i;
  return 0;
}

/** The span of `spans` holding song tick `s`, or null. */
function spanAt(spans: readonly PartSpan[] | undefined, s: number): PartSpan | null {
  if (!spans) return null;
  let lo = 0;
  let hi = spans.length;
  // First span ending after s.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].to <= s) lo = mid + 1;
    else hi = mid;
  }
  const sp = spans[lo];
  return sp && sp.from <= s ? sp : null;
}

/** What a part with regions `spans` plays at transport tick `tick` through `passes` (null: silent there). */
function playAt(spans: readonly PartSpan[] | undefined, passes: readonly SongPass[], tick: number): SongPlay | null {
  const i = passIndexAt(passes, tick);
  if (i < 0) return null;
  const p = passes[i];
  if (tick < p.at || tick >= passEnd(p)) return null;
  const sp = spanAt(spans, p.from + (tick - p.at));
  return sp ? { clipId: sp.clipId, loopStart: canonicalLoopStart(p.at + (sp.anchor - p.from), sp.len) } : null;
}

/** Transport ticks in (lo, hi] where what a part plays may change: pass starts, its regions' starts and ends. */
function changePoints(spans: readonly PartSpan[] | undefined, passes: readonly SongPass[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (const p of passes) {
    if (p.at > hi) break;
    const end = passEnd(p);
    if (end <= lo) continue;
    if (p.at > lo) out.push(p.at);
    if (!spans) continue;
    // Song ticks of the pass that lie in (lo, hi].
    const a = p.from + Math.max(0, lo - p.at);
    const b = Math.min(p.to, p.from + (hi - p.at));
    let i = 0;
    while (i < spans.length && spans[i].to <= a) i++;
    for (; i < spans.length && spans[i].from <= b; i++) {
      for (const x of [spans[i].from, spans[i].to]) {
        if (x <= p.from || x >= p.to) continue;
        const t = p.at + (x - p.from);
        if (t > lo && t <= hi) out.push(t);
      }
    }
  }
  out.sort((x, y) => x - y);
  return out.filter((t, i) => i === 0 || t !== out[i - 1]);
}

/** A song transition to be laid out: part `trackId` plays `play` from `atTick` on. */
interface SongChange {
  trackId: Id;
  atTick: number;
  play: SongPlay | null;
}

/**
 * The changes of what each part plays over transport ticks (lo, hi], each
 * part going on from what it plays at `lo` (`last`, updated to what it plays
 * at `hi`). `at` (in (lo, hi]) is looked at too: an edit point, where what a
 * part plays may change without a region starting or ending there.
 */
function songChanges(trackIds: readonly Id[], parts: ReadonlyMap<Id, PartSpan[]>, passes: readonly SongPass[], last: Map<Id, SongPlay | null>, lo: number, hi: number, at?: number): SongChange[] {
  const out: SongChange[] = [];
  for (const id of trackIds) {
    const spans = parts.get(id);
    let cur = last.get(id) ?? null;
    const points = changePoints(spans, passes, lo, hi);
    if (at !== undefined && at > lo && at <= hi && !points.includes(at)) points.unshift(at);
    for (const t of points) {
      const play = playAt(spans, passes, t);
      if (samePlay(cur, play)) continue;
      out.push({ trackId: id, atTick: t, play });
      cur = play;
    }
    last.set(id, cur);
  }
  return out;
}

/** Where the song ends on the transport: its length through the last pass, or null while it loops (no end). */
function songEndTick(passes: readonly SongPass[], project: Project): number | null {
  const last = passes[passes.length - 1];
  if (!last || last.to !== Infinity) return null;
  return last.at + (songLengthTicks(project) - last.from);
}

/** `passes` with passes of `loop` (song ticks) laid after a last pass that ends, until they reach past `until`. */
function extendPasses(passes: SongPass[], loop: { from: number; to: number } | null, until: number): void {
  if (!loop) return;
  for (let guard = 0; guard < 100_000; guard++) {
    const last = passes[passes.length - 1];
    const end = last ? passEnd(last) : Infinity;
    if (end > until) return;
    passes.push({ at: end, from: loop.from, to: loop.to });
  }
}

const KIND_ORDER: Record<SeqEvent['kind'], number> = {
  end: 0,
  launch: 1,
  tempo: 2,
  swing: 3,
  master: 4,
  mute: 5,
  param: 6,
  macro: 7,
  songGain: 8,
  macroRamp: 9,
  beat: 10,
  note: 11,
};

function compareEvents(a: SeqEvent, b: SeqEvent): number {
  return a.tick - b.tick || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}

/* ------------------------------------------------------------------ */
/* Prepared clips                                                      */
/* ------------------------------------------------------------------ */

interface PreparedNote {
  tick: number;
  pitch: number;
  velocity: number;
  /** End within the loop (clamped to the clip length). */
  end: number;
  /** Mono parts: end also clamped to the next note's start. */
  monoEnd: number;
}

interface PreparedClip {
  length: number;
  notes: PreparedNote[];
}

interface PrepEntry {
  notes: Clip['notes'];
  bars: number;
  poly?: PreparedClip;
  mono?: PreparedClip;
}

// Clips are immutable project data; cache by identity (re-validated against notes/bars).
const prepCache = new WeakMap<Clip, PrepEntry>();

function prepareClip(clip: Clip, mono: boolean): PreparedClip {
  let entry = prepCache.get(clip);
  if (!entry || entry.notes !== clip.notes || entry.bars !== clip.bars) {
    entry = { notes: clip.notes, bars: clip.bars };
    prepCache.set(clip, entry);
  }
  const cached = mono ? entry.mono : entry.poly;
  if (cached) return cached;
  const length = clipLength(clip);
  const notes: PreparedNote[] = [];
  for (const n of clip.notes) {
    if (!Number.isFinite(n.tick) || !Number.isFinite(n.pitch) || n.tick < 0 || n.tick >= length) continue;
    const dur = Number.isFinite(n.duration) && n.duration > 0 ? n.duration : 1;
    // Notes end at the loop end, like a looping clip in any sequencer.
    const end = Math.min(n.tick + dur, length);
    notes.push({ tick: n.tick, pitch: n.pitch, velocity: clamp01(n.velocity), end, monoEnd: end });
  }
  notes.sort((x, y) => x.tick - y.tick || x.pitch - y.pitch);
  let list = notes;
  if (mono) {
    // One note at a time: of notes starting together the lowest wins, and a
    // note ends where the next one starts.
    list = [];
    for (const n of notes) if (!list.length || list[list.length - 1].tick !== n.tick) list.push(n);
    for (let i = 0; i < list.length; i++) {
      const next = i + 1 < list.length ? list[i + 1].tick : length;
      list[i].monoEnd = Math.min(list[i].end, next);
    }
  }
  const prep: PreparedClip = { length, notes: list };
  if (mono) entry.mono = prep;
  else entry.poly = prep;
  return prep;
}

/* ------------------------------------------------------------------ */
/* Internal state                                                      */
/* ------------------------------------------------------------------ */

interface Playing {
  slot: number;
  clipId: Id;
  startTick: number;
}

type TransitionSource = 'live' | 'song' | 'replay';

interface Transition {
  atTick: number;
  /** Target slot (null = stop) unless `row` or `clipId` is set. */
  slot: number | null;
  /** Scene row resolved when applied: that slot if it holds a clip, else stop. */
  row: number | null;
  /** Song changes: the clip resolved when applied (the slot holding it now; null, or gone: stop). */
  clipId?: Id | null;
  source: TransitionSource;
  /** Order among transitions at the same tick (later wins); song changes are negative, so a pad tapped for that bar wins. */
  seq: number;
  /** Tick at which the request was made (queued state becomes visible then). */
  requestTick: number;
  /** Loop start of the clip it starts (default `atTick`): a song region's clip plays in phase with the region. */
  loopStart?: number;
}

interface Applied {
  appliedTick: number;
  prev: Playing | null;
  due: Transition[];
}

interface Emitted {
  event: NoteEvent;
  tick: number;
  endTick: number;
  /** End before mono truncation (for legato detection). */
  naturalEndTick: number;
  /** Scheduled end time: `time + duration`, lowered by every truncation or cut since. */
  endTime: number;
  swing: number;
  clock: TempoMap;
  batch: number;
  dropped: boolean;
}

interface TrackRt {
  playing: Playing | null;
  pending: Transition[];
  history: Applied[];
  recent: Emitted[];
}

interface ArpChange extends LatchState {
  tick: number;
  /** Grid tick of arp step 0, null when nothing sounds. */
  origin: number | null;
  velocity: number;
}

interface ArpRt {
  latch: LatchState;
  velocity: number;
  changes: ArpChange[];
  /** Changes come from a performance being replayed. */
  replayDriven: boolean;
}

interface ReplayNote {
  tick: number;
  endTick: number;
  trackId: Id;
  pitch: number;
  velocity: number;
}

type ControlEvent = Extract<PerformanceEvent, { type: 'macro' | 'param' | 'mute' | 'tempo' | 'swing' | 'master' }>;

interface ReplayState {
  performance: Performance;
  project: Project;
  controls: ControlEvent[];
  next: number;
  notes: ReplayNote[];
  /** The take's recorded tempo changes, in order (the clock is built from them up front). */
  tempos: { tick: number; bpm: number }[];
  /** Tick of a live tempo change that replaced the recorded tempo map from there on, else null. */
  tempoOverrideTick: number | null;
}

interface SongState {
  /**
   * The song timeline on the transport, from the pass playing (passes that
   * ended before the history floor are forgotten). The last pass is open
   * when the song plays on to its end; while it loops, passes of the loop are
   * laid after it as playback gets near (`extendPasses`).
   */
  passes: SongPass[];
  /** Each part's regions as the song was last laid out. */
  parts: Map<Id, PartSpan[]>;
  /** Song transitions are in the launchers for every change at a tick up to here. */
  laidTo: number;
  /** What each part plays at `laidTo` (the last change laid out). */
  last: Map<Id, SongPlay | null>;
  /**
   * The edit point of the last replan and what each part played just before
   * it: another edit at the same point (two edits while paused) changes
   * what follows from there, never what played before it.
   */
  editAt: number;
  editBefore: Map<Id, SongPlay | null>;
}

/** Events with tick < untilTick and time < floorTime were already handed out (and not cancelled). */
interface Clause {
  untilTick: number;
  floorTime: number;
}

interface Candidate {
  tick: number;
  endTick: number;
  naturalEndTick: number;
  trackId: Id;
  order: number;
  /** Source order at equal ticks: clip, replay, arp. */
  src: number;
  pitch: number;
  velocity: number;
  source: NoteEvent['source'];
  clipId?: Id;
  /** Sampler parts: the clip's own recording. */
  sample?: ClipSample;
  swung: boolean;
  mono: boolean;
}

interface Domain {
  clock: TempoMap;
  swing: SwingTimeline | null;
  clauses: Clause[];
  /** Events timed before this never sound (the music before a resume point). */
  floor: number;
}

/** Where a paused transport holds: everything needed to continue exactly there. */
interface PausedState {
  /** Transport tick (playhead) at the pause. */
  tick: number;
  /** Where generation restarts on resume (a little earlier, for notes swing delays past the pause point). */
  cursor: number;
  /** Tempo in effect at the pause (a replayed take keeps its own). */
  bpm: number;
}

class SwingTimeline {
  private pts: { tick: number; swing: number }[] = [{ tick: -Infinity, swing: 0 }];

  reset(swing: number): void {
    this.pts = [{ tick: -Infinity, swing: clampSwing(swing) }];
  }

  at(tick: number): number {
    const p = this.pts;
    for (let i = p.length - 1; i > 0; i--) if (p[i].tick <= tick) return p[i].swing;
    return p[0].swing;
  }

  set(tick: number, swing: number): void {
    const keep = this.pts.filter((p) => p.tick < tick);
    this.pts = keep.length ? [...keep, { tick, swing: clampSwing(swing) }] : [{ tick: -Infinity, swing: clampSwing(swing) }];
  }

  prune(tick: number): void {
    let first = 0;
    while (first + 1 < this.pts.length && this.pts[first + 1].tick <= tick) first++;
    if (first > 0) this.pts = this.pts.slice(first);
  }
}

function compareCandidates(x: Candidate, y: Candidate): number {
  return x.tick - y.tick || x.order - y.order || x.src - y.src || x.pitch - y.pitch;
}

function skipped(clauses: readonly Clause[], tick: number, time: number): boolean {
  for (const c of clauses) if (tick < c.untilTick && time < c.floorTime) return true;
  return false;
}

function changeAt(changes: readonly ArpChange[], tick: number): ArpChange | undefined {
  for (let i = changes.length - 1; i >= 0; i--) if (changes[i].tick <= tick) return changes[i];
  return undefined;
}

/** The arp change produced by new input at `tick`, continuing the step count unless the arp restarts. */
function nextArpChange(prev: ArpChange | undefined, latch: LatchState, tick: number, track: Track, velocity: number): ArpChange {
  const prevSet = prev ? arpInput(prev, track.arp.latch) : [];
  const nextSet = arpInput(latch, track.arp.latch);
  let origin = prev?.origin ?? null;
  if (!nextSet.length) origin = null;
  else if (!prevSet.length || origin === null) origin = arpGridAtOrAfter(tick, track.arp.division);
  return { tick, held: latch.held, latched: latch.latched, origin, velocity };
}

function samePlaying(a: Playing | null, b: Playing | null): boolean {
  if (!a || !b) return a === b;
  return a.slot === b.slot && a.startTick === b.startTick;
}

/**
 * Loop start for a clip given as playing in a start launcher. An entry that
 * started after `from` (e.g. a launcher snapshot taken later on the timeline)
 * would stay silent until then; it moves back by whole loops so it plays from
 * `from` with the same loop phase.
 */
function loopStartAtOrBefore(startTick: number, length: number, from: number): number {
  if (!Number.isFinite(startTick)) return from;
  if (startTick <= from) return startTick;
  return startTick - Math.ceil((startTick - from) / length) * length;
}

/* ------------------------------------------------------------------ */
/* Sequencer                                                           */
/* ------------------------------------------------------------------ */

export class Sequencer {
  private readonly getProject: () => Project;
  private readonly clock = new TempoMap();
  private readonly swing = new SwingTimeline();
  private readonly tracks = new Map<Id, TrackRt>();
  private readonly arps = new Map<Id, ArpRt>();

  private _playing = false;
  private _mode: PlayMode = { kind: 'live' };
  private cursor = 0;
  private startTick = 0;
  /** Musical start (after any count-in): no clip plays before it. */
  private musicStartTick = 0;
  private historyFloor = -Infinity;
  private endTick: number | null = null;
  private _ended = false;
  private stoppedTick = 0;
  private clauses: Clause[] = [];
  private song: SongState | null = null;
  /** The looped part of the song (kept while stopped; song playback uses it). */
  private loop: SongLoop | null = null;
  private replay: ReplayState | null = null;
  private savedLive: Map<Id, Playing | null> | null = null;
  private transitionSeq = 0;
  private cuts: NoteCut[] = [];
  /**
   * Time of the 'end' event already handed out and not cancelled since. The
   * end sits on the cursor, at the upper edge of a rewind, so the rewind
   * clauses cannot tell whether it was handed out: this does.
   */
  private endSentTime: number | null = null;
  private batch = 0;
  private inProcess = false;
  private readonly dropped = new Set<NoteEvent>();
  /** Set while paused (see `pause()`). */
  private pausedState: PausedState | null = null;
  /** After a resume: events timed before the resume time are the paused past and never sound. */
  private resumeFloor = -Infinity;
  /** The playhead waits here until the start (or resume) time comes. */
  private playheadFloor = 0;
  /** A resumed replay's control values in effect at the pause point, sent again at the resume time. */
  private resumeEvents: SeqEvent[] = [];
  private resumeSent = true;
  /**
   * Song moves: where their state is sent again (the value every move has
   * reached, the rest value of a target no move holds), because the engine's
   * ramps were cut or reset there: the start or resume time, an
   * invalidation, a skip. Null: nothing to send again.
   */
  private moveSync: number | null = null;
  /** Move targets sent away from their rest value (see moves.ts) since playback started or resumed. */
  private readonly moved = new Set<string>();

  // Free-running arpeggiator clock while the transport is stopped.
  private freeClock: TempoMap | null = null;
  private freeCursor = 0;
  private freeClauses: Clause[] = [];
  private freeHistoryFloor = -Infinity;

  constructor(opts: SequencerOptions) {
    this.getProject = opts.getProject;
  }

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  get playing(): boolean {
    return this._playing;
  }

  get mode(): PlayMode {
    return { ...this._mode };
  }

  /** True after a song / performance / bounded render reached its end. */
  get ended(): boolean {
    return this._ended;
  }

  /** Paused: not playing, holding its position, mode and every clip's phase until `resume()` (or `stop()`). */
  get paused(): boolean {
    return this.pausedState !== null;
  }

  /** Events have been generated for un-swung ticks below this. */
  get generatedTick(): number {
    return this._playing ? this.cursor : this.freeCursor;
  }

  /**
   * Tempo at the generation cursor while playing (the start tempo right after
   * `start()`); the idle arpeggiator's tempo while stopped.
   */
  get bpm(): number {
    if (this._playing) return this.clock.bpmAtTick(this.cursor);
    return this.freeClock ? this.freeClock.bpm : this.clock.bpm;
  }

  /** The arpeggiator is running on its free clock (transport stopped, notes held or latched). */
  get idleActive(): boolean {
    return !this._playing && this.freeClock !== null;
  }

  /** The project being played: the performance snapshot while replaying, else the live project. */
  activeProject(): Project {
    return this.replay?.project ?? this.getProject();
  }

  /** The live project (settings such as the metronome stay live during a replay). */
  liveProject(): Project {
    return this.getProject();
  }

  tickAt(time: number): number {
    return this.clock.tickAt(time);
  }

  timeAt(tick: number): number {
    return this.clock.timeAt(tick);
  }

  swingAt(tick: number): number {
    return this.swing.at(tick);
  }

  /**
   * Playhead at `time`; it waits at the start tick until the transport's start
   * time comes. Paused: where it paused. Stopped: the start (bar 1).
   */
  getPosition(time: number): SeqPosition {
    return positionOf(this.playheadTick(time));
  }

  /** The tick of getPosition(time), without allocating. */
  playheadTick(time: number): number {
    return this._playing ? Math.max(this.playheadFloor, this.clock.tickAt(time)) : this.stoppedTick;
  }

  private rt(trackId: Id): TrackRt {
    let rt = this.tracks.get(trackId);
    if (!rt) {
      rt = { playing: null, pending: [], history: [], recent: [] };
      this.tracks.set(trackId, rt);
    }
    return rt;
  }

  private requireTrack(project: Project, trackId: Id): Track {
    const t = project.tracks.find((x) => x.id === trackId);
    if (!t) throw new Error(`Unknown track "${trackId}"`);
    return t;
  }

  private resolvePlaying(track: Track, slot: number, startTick: number): Playing | null {
    const clip = Number.isInteger(slot) ? track.clips[slot] : null;
    return clip ? { slot, clipId: clip.id, startTick } : null;
  }

  private slotFor(track: Track, tr: Transition): number | null {
    if (tr.clipId !== undefined) {
      // A song change plays its clip wherever it is now (scenes and clips move while the song plays).
      if (tr.clipId === null) return null;
      const at = track.clips.findIndex((c) => c?.id === tr.clipId);
      return at < 0 ? null : at;
    }
    const slot = tr.row !== null ? tr.row : tr.slot;
    return slot !== null && track.clips[slot] ? slot : null;
  }

  getTrackState(trackId: Id): TrackLaunchState {
    const rt = this.tracks.get(trackId);
    if (!rt) return { playing: null, queued: null };
    const q = rt.pending.find((tr) => tr.source === 'live' || tr.requestTick <= this.cursor);
    let queued: TrackLaunchState['queued'] = null;
    if (q) {
      const track = this.activeProject().tracks.find((t) => t.id === trackId);
      queued = { slot: track ? this.slotFor(track, q) : q.slot, atTick: q.atTick };
    }
    return { playing: rt.playing ? { ...rt.playing } : null, queued };
  }

  /**
   * The clip a track played at `tick` (its slot and loop start), looking back
   * through the applied switches still in the history (HISTORY_TICKS), or
   * null when it played nothing then.
   */
  playingAt(trackId: Id, tick: number): { slot: number; startTick: number } | null {
    const rt = this.tracks.get(trackId);
    if (!rt) return null;
    let p = rt.playing;
    for (let i = rt.history.length - 1; i >= 0 && rt.history[i].appliedTick > tick; i--) p = rt.history[i].prev;
    return p ? { slot: p.slot, startTick: p.startTick } : null;
  }

  /** A track's arpeggiator input now: keys held, notes kept by latch, and the velocity it plays at (null before any input). */
  getArpInput(trackId: Id): { held: readonly number[]; latched: readonly number[]; velocity: number } | null {
    const arp = this.arps.get(trackId);
    return arp ? { held: arp.latch.held, latched: arp.latch.latched, velocity: arp.velocity } : null;
  }

  /** What plays now (or will play when Play is pressed, while stopped). */
  getLauncherSnapshot(): LauncherSnapshotEntry[] {
    return this.activeProject().tracks.map((t) => {
      const p = this.tracks.get(t.id)?.playing;
      return { trackId: t.id, playing: p ? { slot: p.slot, startTick: p.startTick } : null };
    });
  }

  /** Cuts produced since the last call (the driver releases those voices early). */
  takeCuts(): NoteCut[] {
    const c = this.cuts;
    this.cuts = [];
    return c;
  }

  /* ---------------------------------------------------------------- */
  /* Transport                                                         */
  /* ---------------------------------------------------------------- */

  start(time: number, opts: StartOptions = {}): void {
    const t0 = Number.isFinite(time) ? time : 0;
    const mode: PlayMode = opts.mode ?? { kind: 'live' };
    let perf: Performance | null = null;
    if (mode.kind === 'replay') {
      // Validate before touching any state: a failed start leaves playback as it was.
      perf = this.getProject().performances.find((p) => p.id === mode.performanceId) ?? null;
      if (!perf) throw new Error(`Performance "${mode.performanceId}" not found`);
    }
    if (this._playing) this.stopTransport(t0);
    else if (this.pausedState) this.endPause();
    const base = this.getProject();
    let project = base;
    let replay: ReplayState | null = null;
    let song: SongState | null = null;
    let fromTick = opts.fromTick;
    let launcher = opts.launcher;
    let endTick: number | null = null;

    if (perf) {
      project = projectFromSnapshot(base, perf.snapshot);
      fromTick ??= perf.startTick;
      launcher ??= perf.snapshot.launcher;
      endTick = perf.endTick;
    } else if (mode.kind === 'song') {
      // The transport tick of the first pass is its song tick: bar lines and beats match the song's.
      const at = clampInt(mode.fromBar, 0, MAX_SONG_BARS) * TICKS_PER_BAR;
      fromTick = at;
      song = { passes: this.firstPasses(at), parts: songParts(base), laidTo: at - 0.5, last: new Map(), editAt: -Infinity, editBefore: new Map() };
      endTick = songEndTick(song.passes, base);
    }

    const from = Number.isFinite(fromTick) ? (fromTick as number) : 0;
    const countIn = clampInt(opts.countInBars ?? 0, 0, 4);
    const startTick = from - countIn * TICKS_PER_BAR;

    if (mode.kind !== 'live') {
      this.savedLive = new Map();
      for (const t of base.tracks) {
        const p = this.tracks.get(t.id)?.playing ?? null;
        this.savedLive.set(t.id, p ? { ...p } : null);
      }
    } else {
      this.savedLive = null;
    }

    this._mode = mode;
    this.song = song;
    this.endTick = endTick;
    this._ended = false;
    this.clock.reset({ time: t0, tick: startTick, bpm: project.bpm });
    this.swing.reset(project.swing);
    this.startTick = startTick;
    this.playheadFloor = startTick;
    this.musicStartTick = from;
    this.cursor = startTick;
    this.historyFloor = startTick;
    this.clauses = [];
    this.cuts = [];
    this.endSentTime = null;
    this.resumeFloor = -Infinity;
    this.resumeEvents = [];
    this.resumeSent = true;
    this.moveSync = t0;
    this.moved.clear();

    for (const id of [...this.tracks.keys()]) {
      if (!project.tracks.some((t) => t.id === id)) this.tracks.delete(id);
    }
    for (const track of project.tracks) {
      const rt = this.rt(track.id);
      let playing: Playing | null = null;
      if (launcher) {
        const e = launcher.find((x) => x.trackId === track.id);
        const clip = e?.playing && Number.isInteger(e.playing.slot) ? track.clips[e.playing.slot] : null;
        if (e?.playing && clip) playing = this.resolvePlaying(track, e.playing.slot, loopStartAtOrBefore(e.playing.startTick, clipLength(clip), from));
      } else if (mode.kind === 'live' && rt.playing) {
        // Armed while stopped: starts with the transport.
        playing = this.resolvePlaying(track, rt.playing.slot, from);
      }
      rt.playing = playing;
      rt.pending = [];
      rt.history = [];
      rt.recent = [];
    }

    // Every part starts with what the song plays at the start (silent ones need nothing).
    if (song) this.extendSong(startTick + 2 * TICKS_PER_BAR);

    // Arpeggiator input moves onto the transport grid.
    this.freeClock = null;
    this.freeClauses = [];
    for (const track of project.tracks) {
      const arp = this.arps.get(track.id);
      if (!arp) continue;
      arp.replayDriven = false;
      arp.changes = [nextArpChange(undefined, arp.latch, startTick, track, arp.velocity)];
    }

    if (perf) {
      this.replay = null;
      replay = this.setupReplay(perf, project);
    }
    this.replay = replay;
    this._playing = true;
  }

  /**
   * Stop the transport at `time` (also from a pause). Stop also releases a
   * latched arpeggio (keys still physically held keep playing on the
   * free-running clock). The playhead returns to the start (bar 1) and the
   * launcher to its armed state: in live mode the latest queued request of
   * each track (or what it was playing) starts again from the top on the next
   * Play; after song or replay playback the live selection from before is
   * restored.
   */
  stop(time: number): void {
    const t = Number.isFinite(time) ? time : 0;
    for (const arp of this.arps.values()) arp.latch = { held: arp.latch.held, latched: [] };
    if (this._playing) {
      this.stopTransport(t);
      return;
    }
    if (this.pausedState) this.endPause();
    if (this.freeClock) {
      const tick = this.freeClock.tickAt(t);
      const project = this.getProject();
      for (const track of project.tracks) {
        const arp = this.arps.get(track.id);
        if (arp && arp.changes.length) this.pushLiveArpChange(track, arp, tick);
      }
    }
  }

  /**
   * Pause at `time`: hold the playhead, the mode (live pads, song, replay), the
   * song position, every playing clip's loop phase and every queued launch, so
   * `resume()` continues exactly there, in time. Generated events at or after
   * the pause point are forgotten (the driver releases or cancels every voice
   * at `time`). Like Stop, a latched arpeggio ends, and the arpeggiator does
   * not run while paused unless keys are pressed (as when stopped). Returns
   * false when there is nothing to pause: not playing, or the music already
   * reached its end (the driver stops instead).
   */
  pause(time: number): boolean {
    if (!this._playing || this._ended) return false;
    const t = Number.isFinite(time) ? time : 0;
    const tick = Math.max(this.playheadFloor, this.clock.tickAt(t));
    if (this.endTick !== null && tick >= this.endTick) return false;
    const project = this.activeProject();
    // Catch up to the pause point if the ticker had not generated that far (nothing of it was handed out in time).
    if (this.cursor < tick) this.runTransport(t, project, []);
    if (this._ended) return false;
    // State applied at or after the pause point is rolled back; it applies again (and is announced) on resume.
    for (const rt of this.tracks.values()) {
      while (rt.history.length && rt.history[rt.history.length - 1].appliedTick >= tick) {
        const h = rt.history.pop()!;
        rt.playing = h.prev;
        for (const tr of h.due) this.insertTransition(rt, tr);
      }
      // Every voice is released at the pause: nothing sounds on into the resume.
      rt.recent = [];
    }
    const rp = this.replay;
    if (rp) {
      rp.next = 0;
      while (rp.next < rp.controls.length && rp.controls[rp.next].t < tick) rp.next++;
    }
    // Live arpeggiator input: as at Stop, a latched pattern ends; keys pressed while paused play on the idle clock.
    for (const arp of this.arps.values()) {
      if (arp.replayDriven) continue;
      arp.latch = { held: arp.latch.held, latched: [] };
      arp.changes = [];
    }
    this.freeClock = null;
    this.freeClauses = [];
    // Swing delays notes by up to MAX_SWING_TICKS: generation restarts that much earlier, and the
    // resume floor keeps everything that belongs before the pause point silent.
    const cursor = Math.min(tick, Math.max(tick - MAX_SWING_TICKS, this.startTick, this.historyFloor));
    this.pausedState = { tick, cursor, bpm: this.clock.bpmAtTick(tick) };
    this.cursor = cursor;
    this.clauses = [];
    this.cuts = [];
    this.endSentTime = null;
    this.resumeEvents = [];
    this.resumeSent = true;
    this.stoppedTick = tick;
    this._playing = false;
    return true;
  }

  /**
   * Continue a pause at `time`: the playhead tick at `time` is the tick where
   * it paused, every clip keeps its loop phase, queued launches and the song
   * carry on, and nothing from before the pause point sounds (no backlog).
   * Live and song playback take the project's tempo and swing as they are
   * now; a replayed take keeps its own tempo map, and the control values the
   * take had reached (knobs, macros, mutes, master) are sent again at `time`.
   * Returns false when not paused.
   */
  resume(time: number): boolean {
    const ps = this.pausedState;
    if (!ps || this._playing) return false;
    const t0 = Number.isFinite(time) ? time : 0;
    const project = this.activeProject();
    const rp = this.replay;
    this.clock.reset({ time: t0, tick: ps.tick, bpm: rp ? ps.bpm : project.bpm });
    if (rp) {
      if (rp.tempoOverrideTick !== null && rp.tempoOverrideTick > ps.tick) rp.tempoOverrideTick = null;
      // The take's later tempo changes go back into the clock (a live override holds until the next one).
      if (rp.tempoOverrideTick === null) for (const tp of rp.tempos) if (tp.tick > ps.tick) this.clock.reanchorAtTick(tp.tick, tp.bpm);
      this.resumeEvents = this.replayStateAt(rp, ps.tick, t0);
    } else {
      this.swing.set(ps.cursor, project.swing);
      this.resumeEvents = [];
    }
    this.resumeSent = this.resumeEvents.length === 0;
    this.resumeFloor = t0;
    // The engine's song gain and automation were reset by the pause: song moves continue from here.
    this.moveSync = t0;
    this.moved.clear();
    this.playheadFloor = ps.tick;
    this.cursor = ps.cursor;
    this.clauses = [];
    this.cuts = [];
    this.endSentTime = null;
    // Arpeggiator input moves onto the transport grid from the resume point.
    this.freeClock = null;
    this.freeClauses = [];
    for (const track of project.tracks) {
      const arp = this.arps.get(track.id);
      if (!arp || arp.replayDriven) continue;
      arp.changes = [nextArpChange(undefined, arp.latch, ps.tick, track, arp.velocity)];
    }
    this.pausedState = null;
    this._playing = true;
    return true;
  }

  /** The values a replayed take's controls reached before `tick` (the engine dropped them at the pause), as events at `time`. */
  private replayStateAt(rp: ReplayState, tick: number, time: number): SeqEvent[] {
    const last = new Map<string, ControlEvent>();
    for (const c of rp.controls) {
      if (c.t >= tick) break;
      switch (c.type) {
        case 'macro':
          last.set(`macro:${c.trackId}:${c.macro}`, c);
          break;
        case 'param':
          last.set(`param:${c.module}:${c.param}`, c);
          break;
        case 'mute':
          last.set(`mute:${c.trackId}`, c);
          break;
        case 'master':
          last.set('master', c);
          break;
        default:
          // Tempo is in the clock and swing in the sequencer itself.
          break;
      }
    }
    const out: SeqEvent[] = [];
    for (const c of last.values()) {
      if (c.type === 'macro') out.push({ kind: 'macro', tick, time, trackId: c.trackId, macro: c.macro, value: c.value });
      else if (c.type === 'param') out.push({ kind: 'param', tick, time, module: c.module, param: c.param, value: c.value });
      else if (c.type === 'mute') out.push({ kind: 'mute', tick, time, trackId: c.trackId, mute: c.mute });
      else if (c.type === 'master') out.push({ kind: 'master', tick, time, volumeDb: c.volumeDb });
    }
    return out;
  }

  /** Leave a pause without resuming (Stop, or a new start): settle the launcher as Stop does. */
  private endPause(): void {
    this.pausedState = null;
    this.settleStopped();
    // A replayed take's arpeggiator input belongs to the take.
    for (const arp of this.arps.values()) {
      if (!arp.replayDriven) continue;
      arp.changes = [];
      arp.replayDriven = false;
    }
  }

  private stopTransport(time: number): void {
    this.settleStopped();
    this.startFreeArp(time);
  }

  /** Back to stopped at bar 1: the launcher re-armed, song, replay and pause state cleared. */
  private settleStopped(): void {
    this.stoppedTick = 0;
    const live = this.getProject();
    for (const [id, rt] of this.tracks) {
      let armed: Playing | null = null;
      if (this.savedLive) {
        const saved = this.savedLive.get(id) ?? null;
        const track = live.tracks.find((t) => t.id === id);
        armed = saved && track ? this.resolvePlaying(track, saved.slot, 0) : null;
      } else {
        // The latest queued request is the part's most recent intention.
        let slot: number | null = rt.playing?.slot ?? null;
        for (let i = rt.pending.length - 1; i >= 0; i--) {
          if (rt.pending[i].source === 'live') {
            slot = rt.pending[i].slot;
            break;
          }
        }
        const track = live.tracks.find((t) => t.id === id);
        armed = slot !== null && track ? this.resolvePlaying(track, slot, 0) : null;
      }
      rt.playing = armed;
      rt.pending = [];
      rt.history = [];
      rt.recent = [];
    }
    this._playing = false;
    this._mode = { kind: 'live' };
    this.replay = null;
    this.song = null;
    this.savedLive = null;
    this.endTick = null;
    this._ended = false;
    this.endSentTime = null;
    this.clauses = [];
    this.cuts = [];
    this.resumeFloor = -Infinity;
    this.resumeEvents = [];
    this.resumeSent = true;
  }

  /** Keys still held keep the arpeggiator going on a free clock anchored at `time`. */
  private startFreeArp(time: number): void {
    const project = this.getProject();
    this.freeClauses = [];
    const active = project.tracks.filter((t) => {
      const arp = this.arps.get(t.id);
      return t.arp.enabled && !!arp && arpInput(arp.latch, t.arp.latch).length > 0;
    });
    for (const arp of this.arps.values()) {
      arp.changes = [];
      arp.replayDriven = false;
    }
    if (!active.length) {
      this.freeClock = null;
      return;
    }
    // The tempo in effect at Stop (a replayed take's clock also holds its later tempo changes).
    this.freeClock = new TempoMap({ time, tick: 0, bpm: this.clock.bpmAtTime(time) });
    this.freeCursor = 0;
    this.freeHistoryFloor = 0;
    for (const track of active) {
      const arp = this.arps.get(track.id)!;
      arp.changes = [nextArpChange(undefined, arp.latch, 0, track, arp.velocity)];
    }
  }

  /**
   * Change tempo at `time` (clamped to 40-220). Call `invalidate(time)`
   * afterwards to re-time generated events. Notes already handed out that
   * started before the change and end after it are shortened (via cuts) when
   * the new tempo makes them end earlier. While a take is replayed, the live
   * tempo holds until the take's next recorded tempo change.
   */
  setTempo(bpm: number, time: number): void {
    const b = clampBpm(bpm);
    const t = Number.isFinite(time) ? time : 0;
    if (this._playing) {
      // Not before the start or resume point: the playhead waits there until its time, and a change
      // anchored earlier would move that point (music from before a pause could sound again).
      const a = this.clock.reanchor(Math.max(t, this.clock.timeAt(this.playheadFloor)), b);
      if (this.replay) this.replay.tempoOverrideTick = a.tick;
      this.retimeAfter(this.clock, a.tick);
    }
    if (this.freeClock) {
      const a = this.freeClock.reanchor(t, b);
      this.retimeAfter(this.freeClock, a.tick);
    }
  }

  /** Change swing from the tick reached at `time`. Call `invalidate(time)` afterwards. */
  setSwing(swing: number, time: number): void {
    if (!this._playing || !Number.isFinite(time)) return;
    this.swing.set(this.clock.tickAt(time), clampSwing(swing));
  }

  /** End the music at `tick` (bounded offline renders of a scene or launcher state). */
  setEndTick(tick: number | null): void {
    if (!this._playing) return;
    this.endTick = tick === null || !Number.isFinite(tick) ? null : Math.max(tick, this.startTick);
    this._ended = false;
    this.endSentTime = null;
  }

  /* ---------------------------------------------------------------- */
  /* Launcher                                                          */
  /* ---------------------------------------------------------------- */

  launchClip(trackId: Id, slot: number, time: number): LaunchResult {
    const track = this.requireTrack(this.activeProject(), trackId);
    if (!Number.isInteger(slot) || slot < 0 || slot >= track.clips.length) throw new RangeError(`Clip slot ${slot} is out of range`);
    return this.request(track, track.clips[slot] ? slot : null, time);
  }

  stopTrack(trackId: Id, time: number): LaunchResult {
    return this.request(this.requireTrack(this.activeProject(), trackId), null, time);
  }

  /** Every track: slot `row` if it holds a clip, otherwise stop. */
  launchScene(row: number, time: number): LaunchResult[] {
    const project = this.activeProject();
    const rows = project.tracks.reduce((m, t) => Math.max(m, t.clips.length), 0);
    if (!Number.isInteger(row) || row < 0 || row >= rows) throw new RangeError(`Scene row ${row} is out of range`);
    return project.tracks.map((t) => this.request(t, t.clips[row] ? row : null, time));
  }

  stopAll(time: number): LaunchResult[] {
    return this.activeProject().tracks.map((t) => this.request(t, null, time));
  }

  /**
   * Stopped: arm (or disarm) the clip for the next Play. Playing: queue the
   * change for the next bar. Paused: queue it for the next bar after the
   * pause point, so it happens there after Resume (`atTime` is then where
   * that bar would have been without the pause). The clip the part plays
   * (heard at that point) launched again plays on in phase: a stop or switch
   * queued for the part is called off and its loop is not restarted (in the
   * song, it also holds against a song change on that bar line).
   */
  private request(track: Track, slot: number | null, time: number): LaunchResult {
    const t = Number.isFinite(time) ? time : 0;
    const rt = this.rt(track.id);
    const ps = this.pausedState;
    if (!this._playing && !ps) {
      rt.playing = slot === null ? null : this.resolvePlaying(track, slot, 0);
      rt.pending = [];
      return { trackId: track.id, slot, atTick: 0, atTime: t };
    }
    const nowTick = ps ? ps.tick : this.clock.tickAt(t);
    const at = nextBarTick(nowTick);
    const result: LaunchResult = { trackId: track.id, slot, atTick: at, atTime: this.clock.timeAt(at) };
    const heard = slot !== null ? this.playingAt(track.id, nowTick) : null;
    if (heard && heard.slot === slot && track.clips[slot]) {
      // Live requests from that bar on are called off, also one applied ahead already (the driver
      // regenerates from it, and the rewind must not bring it back).
      const later = (tr: Transition): boolean => tr.source === 'live' && tr.atTick >= at;
      rt.pending = rt.pending.filter((tr) => !later(tr));
      for (const h of rt.history) h.due = h.due.filter((tr) => !later(tr));
      // A song (or take) change on that bar line: the pad keeps the clip, in phase, there.
      const other = (tr: Transition): boolean => tr.source !== 'live' && tr.atTick === at;
      if (rt.pending.some(other) || rt.history.some((h) => h.due.some(other))) {
        this.insertTransition(rt, { atTick: at, slot, row: null, source: 'live', seq: ++this.transitionSeq, requestTick: nowTick, loopStart: heard.startTick });
      }
      return result;
    }
    const queued = rt.pending.find((tr) => tr.source === 'live' && tr.atTick === at);
    if (queued && queued.slot === slot) return result;
    // One queued request per track: the newest replaces later live requests.
    rt.pending = rt.pending.filter((tr) => !(tr.source === 'live' && tr.atTick >= at));
    this.insertTransition(rt, { atTick: at, slot, row: null, source: 'live', seq: ++this.transitionSeq, requestTick: nowTick });
    this.cutAtSwitch(rt, at);
    return result;
  }

  /**
   * Clips moved between the slots of a part (a drag between pads, a scene
   * reorder, or undoing one): the launcher follows them. `slots` maps an old
   * slot to its new slot (a clip playing there keeps playing, in phase, from
   * its new slot; a queued launch of it follows it), or to null when the clip
   * left the part: the part stops playing it at `time` (its sounding notes end
   * there) and a queued launch of it is dropped. Works stopped (armed clips),
   * playing and paused. During a replay only the live selection that comes
   * back afterwards follows (the take plays its own snapshot). Returns true
   * when anything changed (the driver then regenerates from `time`).
   */
  relocateSlots(trackId: Id, slots: ReadonlyMap<number, number | null>, time: number): boolean {
    if (!slots.size) return false;
    const remap = (p: Playing | null): Playing | null => {
      if (!p || !slots.has(p.slot)) return p;
      const to = slots.get(p.slot)!;
      return to === null ? null : { ...p, slot: to };
    };
    const remapTr = (tr: Transition): Transition => (tr.row === null && tr.slot !== null && slots.has(tr.slot) ? { ...tr, slot: slots.get(tr.slot)! } : tr);
    let changed = false;
    if (this.savedLive?.has(trackId)) {
      const saved = this.savedLive.get(trackId) ?? null;
      const next = remap(saved);
      if (next !== saved) {
        this.savedLive.set(trackId, next);
        changed = true;
      }
    }
    if (this.replay) return changed;
    const rt = this.tracks.get(trackId);
    if (!rt) return changed;
    const playing = remap(rt.playing);
    if (playing !== rt.playing) {
      if (!playing && this._playing) this.cutAtSwitch(rt, Math.max(this.playheadFloor, this.clock.tickAt(Number.isFinite(time) ? time : 0)));
      rt.playing = playing;
      changed = true;
    }
    const pending: Transition[] = [];
    for (const tr of rt.pending) {
      const next = remapTr(tr);
      if (next === tr) pending.push(tr);
      else {
        changed = true;
        // A queued launch of a clip that left the part is dropped.
        if (next.slot !== null) pending.push(next);
      }
    }
    rt.pending = pending;
    for (const h of rt.history) {
      h.prev = remap(h.prev);
      h.due = h.due.map(remapTr);
    }
    return changed;
  }

  /**
   * The song changed while it plays (or is paused): what the parts play from
   * the edit point on follows the project's regions as they are now. The
   * edit point is the playhead at `time` (the pause point while paused),
   * rounded up to a whole tick: nothing before it changes and the playhead
   * never moves (time is absolute). A part whose music at the edit point
   * differs from what the song had it play just before switches there, in
   * phase with its region (its notes sounding across the edit point end
   * there; one that joins mid-loop does not play the notes it missed);
   * every later change follows the new regions. A part a pad was tapped on
   * keeps the pad until the song changes what it plays. The end moves with
   * the song's length, never behind the playhead (at least the next bar
   * line). Returns true when playback changed: the driver then cancels what
   * it scheduled from `time` and calls `invalidate(time)`. False outside
   * song mode, while stopped, or once the song is over.
   */
  replanSong(time: number): boolean {
    return this.relayoutSong(time, false);
  }

  /** The looped part of the song, or null (it plays through). */
  get songLoop(): SongLoop | null {
    return this.loop ? { ...this.loop } : null;
  }

  /**
   * Loop bars [fromBar, toBar) of the song (see cleanSongLoop), or play it
   * through (null). Stopped, it applies to the next song start: one that
   * starts before the loop's end plays into the loop and repeats it, one
   * after it plays to the end. While the song plays or is paused (as of the
   * playhead at `time`, or the pause point):
   * - the playhead lies inside the new loop: playback goes on and, at the
   *   loop's end, continues at its start, again and again;
   * - it lies outside: playback continues at the loop's start at the next bar
   *   line (at once when nothing of that bar has sounded: right after Play,
   *   or paused on a bar line);
   * - cleared: playback plays on to the song's end.
   * Replay and live playback do not use it. Returns true when playback
   * changed (the driver regenerates from `time`), as `replanSong`.
   */
  setSongLoop(loop: SongLoop | null, time: number): boolean {
    const next = cleanSongLoop(loop);
    if (sameSongLoop(next, this.loop)) return false;
    this.loop = next;
    return this.relayoutSong(time, true);
  }

  /** The loop in song ticks, or null. */
  private loopTicks(): { from: number; to: number } | null {
    return this.loop ? { from: this.loop.fromBar * TICKS_PER_BAR, to: this.loop.toBar * TICKS_PER_BAR } : null;
  }

  /** The passes of a song starting at transport (and song) tick `at`: into the loop when it starts before the loop's end, else to the end. */
  private firstPasses(at: number): SongPass[] {
    const loop = this.loopTicks();
    return [{ at, from: at, to: loop && at < loop.to ? loop.to : Infinity }];
  }

  /**
   * The passes after the loop was set, changed or cleared with the playhead
   * at `pos` (see setSongLoop): the pass playing keeps what it played so far.
   */
  private passesForLoop(passes: readonly SongPass[], pos: number): SongPass[] {
    const loop = this.loopTicks();
    const i = Math.max(0, passIndexAt(passes, pos));
    const cur = passes[i];
    const out = passes.slice(0, i);
    const s = cur.from + Math.max(0, pos - cur.at);
    if (!loop) out.push({ ...cur, to: Infinity });
    else if (s >= loop.from && s < loop.to) out.push({ ...cur, to: loop.to });
    else {
      // Outside the loop: on to the next bar line (nothing of a bar not heard yet plays), then the loop.
      const jump = Math.ceil(pos / TICKS_PER_BAR) * TICKS_PER_BAR;
      if (jump <= cur.at) out.push({ at: cur.at, from: loop.from, to: loop.to });
      else out.push({ ...cur, to: cur.from + (jump - cur.at) }, { at: jump, from: loop.from, to: loop.to });
    }
    return out;
  }

  /**
   * Lay out the song's changes again from the edit point (see replanSong);
   * `loopChanged`: the loop was just set, changed or cleared, so the passes
   * after the playhead change too (see setSongLoop).
   */
  private relayoutSong(time: number, loopChanged: boolean): boolean {
    const song = this.song;
    const ps = this.pausedState;
    if (!song || this.replay || this._mode.kind !== 'song' || (!this._playing && !ps)) return false;
    const t = Number.isFinite(time) ? time : 0;
    // The playhead waits at its floor (the start or resume point) until that time comes.
    const pos = ps ? ps.tick : Math.max(this.playheadFloor, this.clock.tickAt(t));
    if (this.endTick !== null && pos >= this.endTick) return false;
    const from = Math.ceil(pos);
    const project = this.getProject();
    const ids = project.tracks.map((tr) => tr.id);
    // What each part plays just before the edit point (it stays). The layout follows the latest regions
    // from the last edit point on, so after an earlier one they say it; at the same point, it was kept.
    let before = song.editBefore;
    if (song.editAt !== from) {
      before = new Map();
      for (const id of ids) before.set(id, playAt(song.parts.get(id), song.passes, from - 0.5));
    }
    song.editAt = from;
    song.editBefore = before;
    const last = new Map(before);
    const passes = loopChanged ? this.passesForLoop(song.passes, pos) : [...song.passes];
    const parts = songParts(project);
    const until = Math.max(song.laidTo, from);
    extendPasses(passes, this.loopTicks(), until + TICKS_PER_BAR);
    const changes = songChanges(ids, parts, passes, last, from - 0.5, until, from);
    let end = songEndTick(passes, project);
    // The end never lies behind the playhead: a song cut short below it ends at the next bar line.
    if (end !== null && end <= pos) end = nextBarTick(pos);
    const key = (c: { trackId: Id; atTick: number; clipId: Id | null; loopStart: number | null }) => `${c.trackId}@${c.atTick}=${c.clipId}/${c.loopStart}`;
    const laid = this.songTransitionsFrom(from).map((tr) => key({ trackId: tr.trackId, atTick: tr.atTick, clipId: tr.clipId ?? null, loopStart: tr.clipId ? (tr.loopStart ?? null) : null }));
    const next = changes.map((c) => key({ trackId: c.trackId, atTick: c.atTick, clipId: c.play?.clipId ?? null, loopStart: c.play?.loopStart ?? null }));
    laid.sort();
    next.sort();
    song.parts = parts;
    song.passes = passes;
    if (laid.join('|') === next.join('|') && end === this.endTick) return false;

    // Song changes from the edit point on are replaced: those waiting and those applied that a rewind would bring back.
    const stale = (tr: Transition): boolean => tr.source === 'song' && tr.atTick >= from;
    for (const rt of this.tracks.values()) {
      rt.pending = rt.pending.filter((tr) => !stale(tr));
      for (const h of rt.history) h.due = h.due.filter((tr) => !stale(tr));
    }
    for (const c of changes) this.insertSongChange(c);
    song.laidTo = until;
    song.last = last;
    this.endTick = end;
    return true;
  }

  /** Song transitions at or after `from`, waiting or applied (a rewind brings those back), with their part. */
  private songTransitionsFrom(from: number): (Transition & { trackId: Id })[] {
    const out: (Transition & { trackId: Id })[] = [];
    for (const [trackId, rt] of this.tracks) {
      for (const tr of rt.pending) if (tr.source === 'song' && tr.atTick >= from) out.push({ ...tr, trackId });
      for (const h of rt.history) for (const tr of h.due) if (tr.source === 'song' && tr.atTick >= from) out.push({ ...tr, trackId });
    }
    return out;
  }

  /**
   * Lay out the song's changes up to transport tick `until` (passes of a loop
   * as needed); they reach the launchers a bar ahead (pads show what comes).
   */
  private extendSong(until: number): void {
    const song = this.song;
    if (!song || until <= song.laidTo) return;
    const project = this.activeProject();
    extendPasses(song.passes, this.loopTicks(), until + TICKS_PER_BAR);
    const ids = project.tracks.map((t) => t.id);
    for (const c of songChanges(ids, song.parts, song.passes, song.last, song.laidTo, until)) this.insertSongChange(c);
    song.laidTo = until;
  }

  /** A song change into its part's launcher (seen there a bar ahead). */
  private insertSongChange(c: SongChange): void {
    const tr: Transition = {
      atTick: c.atTick,
      slot: null,
      row: null,
      clipId: c.play?.clipId ?? null,
      source: 'song',
      seq: -(++this.transitionSeq),
      requestTick: c.atTick - TICKS_PER_BAR,
    };
    if (c.play) tr.loopStart = c.play.loopStart;
    // Notes already sounding across the switch end there when it is applied (applyDue), so an edit undone before it leaves them alone.
    this.insertTransition(this.rt(c.trackId), tr);
  }

  /** Forget passes that ended before `floor` (a rewind never goes back that far). */
  private pruneSong(floor: number): void {
    const song = this.song;
    if (!song) return;
    let k = 0;
    while (k + 1 < song.passes.length && passEnd(song.passes[k]) < floor) k++;
    if (k > 0) song.passes = song.passes.slice(k);
  }

  /** The pass holding transport tick `tick` while the song plays or is paused (passes laid out as far as needed), else null. */
  private passAt(tick: number): SongPass | null {
    const song = this.song;
    if (!song || this._mode.kind !== 'song' || (!this._playing && !this.pausedState) || !Number.isFinite(tick)) return null;
    extendPasses(song.passes, this.loopTicks(), tick + TICKS_PER_BAR);
    const i = passIndexAt(song.passes, tick);
    return i < 0 ? null : song.passes[i];
  }

  /**
   * The song bar (fractional, 0-based) that transport tick `tick` plays,
   * while the song plays or is paused; null otherwise. Before the start it is
   * the start; after the end, the end.
   */
  songBarAt(tick: number): number | null {
    const p = this.passAt(tick);
    if (!p) return null;
    let at = Math.max(p.at, tick);
    if (this.endTick !== null) at = Math.min(at, this.endTick);
    const s = p.from + (at - p.at);
    return (p.to === Infinity ? s : Math.min(s, p.to)) / TICKS_PER_BAR;
  }

  /**
   * The song plays (or is paused) inside its loop at transport tick `tick`
   * and will repeat it. False while it plays towards the loop (or on to the
   * next bar line before jumping into it), when it plays on to its end (no
   * loop, a loop cleared, or started after the loop), and when the song is
   * not playing or paused.
   */
  songLoopingAt(tick: number): boolean {
    const loop = this.loopTicks();
    const p = this.passAt(tick);
    if (!loop || !p || p.to !== loop.to) return false;
    const s = p.from + Math.max(0, tick - p.at);
    return s >= loop.from && s < loop.to;
  }

  /** The song's passes while it plays or is paused (copies), else null. */
  songPasses(): SongPass[] | null {
    const song = this.song;
    if (!song || (!this._playing && !this.pausedState)) return null;
    return song.passes.map((p) => ({ ...p }));
  }

  private insertTransition(rt: TrackRt, tr: Transition): void {
    let i = rt.pending.length;
    while (i > 0 && (rt.pending[i - 1].atTick > tr.atTick || (rt.pending[i - 1].atTick === tr.atTick && rt.pending[i - 1].seq > tr.seq))) i--;
    rt.pending.splice(i, 0, tr);
  }

  /** Clip notes already generated that sound across a switch at `at` end there (those of clip `keep` excepted, when given). */
  private cutAtSwitch(rt: TrackRt, at: number, keep?: Id | null): void {
    for (const e of rt.recent) {
      if (e.dropped || e.event.source !== 'clip' || e.tick >= at) continue;
      if (keep !== undefined && e.event.clipId === keep) continue;
      if (e.naturalEndTick > at) e.naturalEndTick = at;
      if (e.endTick > at) this.truncate(e, at);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Arpeggiator                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Keys held for a track's arpeggiator, in the order played (already
   * scale-snapped). Uses the track's ArpSettings; latch is applied here, and
   * only keeps notes while the arp is on with Latch on (so switching Latch on
   * later never brings back keys let go of long ago). `velocity` comes with a
   * press; a release passes none and keeps the velocity in effect.
   * While the transport is stopped the arp runs on a free clock anchored at
   * the first press.
   */
  setArpHeld(trackId: Id, pitches: readonly number[], time: number, velocity?: number): void {
    const project = this.activeProject();
    const track = project.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const t = Number.isFinite(time) ? time : 0;
    let arp = this.arps.get(trackId);
    if (!arp) {
      arp = { latch: EMPTY_LATCH, velocity: DEFAULT_ARP_VELOCITY, changes: [], replayDriven: false };
      this.arps.set(trackId, arp);
    }
    arp.latch = updateLatch(track.arp.enabled && track.arp.latch ? arp.latch : EMPTY_LATCH, pitches);
    if (velocity !== undefined) arp.velocity = clamp01(velocity);
    this.applyArpInput(track, arp, t);
  }

  /**
   * Drop the notes latch keeps on a track (its arpeggiator or its Latch was
   * switched off): keys still held keep playing. Returns true when something
   * was dropped (the caller regenerates from `time`).
   */
  clearArpLatch(trackId: Id, time: number): boolean {
    const arp = this.arps.get(trackId);
    const track = this.activeProject().tracks.find((x) => x.id === trackId);
    if (!arp || !track || arp.replayDriven) return false;
    const { held, latched } = arp.latch;
    if (latched.length === held.length && latched.every((p) => held.includes(p))) return false;
    arp.latch = { held, latched: [...held] };
    this.applyArpInput(track, arp, Number.isFinite(time) ? time : 0);
    return true;
  }

  /** New arp input at `t`: on the transport grid while playing, else on the free clock (started if needed). */
  private applyArpInput(track: Track, arp: ArpRt, t: number): void {
    const project = this.activeProject();
    if (this._playing) {
      this.pushLiveArpChange(track, arp, this.clock.tickAt(t));
      return;
    }
    if (!this.freeClock) {
      if (!track.arp.enabled || !arpInput(arp.latch, track.arp.latch).length) {
        arp.changes = [];
        return;
      }
      this.freeClock = new TempoMap({ time: t, tick: 0, bpm: project.bpm });
      this.freeCursor = 0;
      this.freeClauses = [];
      this.freeHistoryFloor = 0;
      // (A paused replay keeps its take's arpeggiator input for the resume.)
      for (const a of this.arps.values()) if (!a.replayDriven) a.changes = [];
    }
    this.pushLiveArpChange(track, arp, this.freeClock.tickAt(t));
  }

  private pushLiveArpChange(track: Track, arp: ArpRt, tick: number): void {
    const change = nextArpChange(changeAt(arp.changes, tick), arp.latch, tick, track, arp.velocity);
    if (arp.replayDriven) {
      // A recorded take owns the later changes: insert, keep them.
      let i = arp.changes.length;
      while (i > 0 && arp.changes[i - 1].tick > tick) i--;
      arp.changes.splice(i, 0, change);
    } else {
      // Live input describes the state from now on.
      arp.changes = [...arp.changes.filter((c) => c.tick < tick), change];
    }
  }

  /* ---------------------------------------------------------------- */
  /* Replay                                                            */
  /* ---------------------------------------------------------------- */

  private setupReplay(perf: Performance, project: Project): ReplayState {
    const start = perf.startTick;
    const end = perf.endTick;
    const events = perf.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => Number.isFinite(e.t))
      .sort((x, y) => x.e.t - y.e.t || x.i - y.i)
      .map((x) => x.e);
    const controls: ControlEvent[] = [];
    const notes: ReplayNote[] = [];
    const open = new Map<string, { t: number; pitch: number; velocity: number; trackId: Id }>();
    const arpTracks = new Map(project.tracks.filter((t) => t.arp.enabled).map((t) => [t.id, t]));
    const arpKeys = new Map<Id, { key: string; pitch: number }[]>();
    const arpState = new Map<Id, { latch: LatchState; changes: ArpChange[] }>();
    for (const [id, track] of arpTracks) {
      arpState.set(id, { latch: EMPTY_LATCH, changes: [nextArpChange(undefined, EMPTY_LATCH, this.startTick, track, DEFAULT_ARP_VELOCITY)] });
      arpKeys.set(id, []);
    }
    const noteKey = (trackId: Id, key: string): string => `${trackId}\u0000${key}`;
    const close = (k: string, t: number): void => {
      const o = open.get(k);
      if (!o) return;
      open.delete(k);
      // A recorded tap still sounds: at least one tick.
      notes.push({ tick: o.t, endTick: Math.max(t, o.t + 1), trackId: o.trackId, pitch: o.pitch, velocity: o.velocity });
    };
    const arpInputChange = (trackId: Id, t: number, velocity: number): void => {
      const track = arpTracks.get(trackId)!;
      const st = arpState.get(trackId)!;
      st.latch = updateLatch(st.latch, arpKeys.get(trackId)!.map((k) => k.pitch));
      st.changes.push(nextArpChange(st.changes[st.changes.length - 1], st.latch, t, track, velocity));
    };

    for (const e of events) {
      switch (e.type) {
        case 'launch':
          if (e.atTick >= start && e.atTick < end && project.tracks.some((t) => t.id === e.trackId)) {
            this.insertTransition(this.rt(e.trackId), { atTick: e.atTick, slot: e.slot, row: null, source: 'replay', seq: ++this.transitionSeq, requestTick: e.t });
          }
          break;
        case 'scene':
        case 'stopAll':
          if (e.atTick >= start && e.atTick < end) {
            for (const track of project.tracks) {
              this.insertTransition(this.rt(track.id), {
                atTick: e.atTick,
                slot: null,
                row: e.type === 'scene' ? e.row : null,
                source: 'replay',
                seq: ++this.transitionSeq,
                requestTick: e.t,
              });
            }
          }
          break;
        case 'noteOn': {
          if (e.t < start || e.t >= end) break;
          const velocity = clamp01(e.velocity);
          const keys = arpKeys.get(e.trackId);
          if (keys) {
            const i = keys.findIndex((k) => k.key === e.key);
            if (i >= 0) keys.splice(i, 1);
            keys.push({ key: e.key, pitch: e.pitch });
            arpInputChange(e.trackId, e.t, velocity);
            break;
          }
          const k = noteKey(e.trackId, e.key);
          close(k, e.t);
          open.set(k, { t: e.t, pitch: e.pitch, velocity, trackId: e.trackId });
          break;
        }
        case 'noteOff': {
          const keys = arpKeys.get(e.trackId);
          if (keys) {
            const i = keys.findIndex((k) => k.key === e.key);
            if (i < 0 || e.t < start || e.t >= end) break;
            keys.splice(i, 1);
            arpInputChange(e.trackId, e.t, arpState.get(e.trackId)!.changes.at(-1)?.velocity ?? DEFAULT_ARP_VELOCITY);
            break;
          }
          close(noteKey(e.trackId, e.key), Math.min(e.t, end));
          break;
        }
        default:
          if (e.t >= start && e.t < end) controls.push(e);
      }
    }
    for (const k of [...open.keys()]) close(k, end);
    notes.sort((a, b) => a.tick - b.tick);

    // The whole recorded tempo map goes into the clock now, so a note that
    // spans a later tempo change gets its true length however the timeline is
    // windowed (live replay and export agree).
    const tempos: ReplayState['tempos'] = [];
    for (const c of controls) if (c.type === 'tempo') tempos.push({ tick: c.t, bpm: clampBpm(c.bpm) });
    // Starting later in the take (fromTick): changes before the start set the starting tempo.
    const anchor = this.clock.anchor;
    let startBpm = anchor.bpm;
    for (const tp of tempos) if (tp.tick <= this.startTick) startBpm = tp.bpm;
    if (startBpm !== anchor.bpm) this.clock.reset({ ...anchor, bpm: startBpm });
    for (const tp of tempos) if (tp.tick > this.startTick) this.clock.reanchorAtTick(tp.tick, tp.bpm);

    for (const [id, st] of arpState) {
      let arp = this.arps.get(id);
      if (!arp) {
        arp = { latch: EMPTY_LATCH, velocity: DEFAULT_ARP_VELOCITY, changes: [], replayDriven: true };
        this.arps.set(id, arp);
      }
      arp.changes = st.changes;
      arp.replayDriven = true;
    }
    return { performance: perf, project, controls, next: 0, notes, tempos, tempoOverrideTick: null };
  }

  /* ---------------------------------------------------------------- */
  /* Generation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Generate every event whose un-swung tick lies in
   * [generatedTick, tickAt(untilTime)), in tick order, and advance.
   */
  process(untilTime: number): SeqEvent[] {
    let out: SeqEvent[] = [];
    if (!Number.isFinite(untilTime)) return out;
    this.batch++;
    this.inProcess = true;
    this.dropped.clear();
    try {
      const project = this.activeProject();
      if (this._playing && !this.resumeSent) {
        this.resumeSent = true;
        out.push(...this.resumeEvents);
      }
      if (this._playing) this.runTransport(untilTime, project, out);
      else if (this.freeClock) this.runFree(untilTime, project, out);
    } finally {
      this.inProcess = false;
    }
    if (this.dropped.size) {
      const dropped = this.dropped;
      out = out.filter((e) => !(e.kind === 'note' && dropped.has(e)));
      this.dropped.clear();
    }
    out.sort(compareEvents);
    this.prune();
    return out;
  }

  private runTransport(untilTime: number, project: Project, out: SeqEvent[]): void {
    // Each pass either applies due changes (which consumes them) or advances the cursor.
    for (let guard = 0; guard < 1_000_000 && !this._ended; guard++) {
      const untilTick = this.clock.tickAt(untilTime);
      if (this.cursor >= untilTick) break;
      // The song is laid out a bar past what is generated (pads show what each part plays next a bar ahead).
      this.extendSong(untilTick + TICKS_PER_BAR);
      const b = this.nextBoundary();
      if (b <= this.cursor) {
        this.applyDue(project, out);
        continue;
      }
      const segEnd = Math.min(b, untilTick);
      this.generate(this.cursor, segEnd, project, out);
      this.cursor = segEnd;
    }
    this.clauses = this.clauses.filter((c) => c.untilTick > this.cursor);
  }

  private nextBoundary(): number {
    let b = this.endTick ?? Infinity;
    for (const rt of this.tracks.values()) if (rt.pending.length && rt.pending[0].atTick < b) b = rt.pending[0].atTick;
    const rp = this.replay;
    if (rp && rp.next < rp.controls.length) b = Math.min(b, rp.controls[rp.next].t);
    return b;
  }

  private push(out: SeqEvent[], e: SeqEvent): void {
    if (e.time >= this.resumeFloor && !skipped(this.clauses, e.tick, e.time)) out.push(e);
  }

  private applyDue(project: Project, out: SeqEvent[]): void {
    const at = this.cursor;
    if (this.endTick !== null && this.endTick <= at) {
      if (this.endSentTime === null) {
        // The driver stops on this event, so it must reach it: never before the resume point or the
        // floor of a rewind (the music already handed out there), where it would be dropped.
        let time = Math.max(this.clock.timeAt(at), this.resumeFloor);
        for (const c of this.clauses) if (at < c.untilTick && time < c.floorTime) time = c.floorTime;
        const tick = time > this.clock.timeAt(at) ? Math.max(at, this.clock.tickAt(time)) : at;
        out.push({ kind: 'end', tick, time });
        this.endSentTime = time;
      }
      this._ended = true;
      return;
    }
    const rp = this.replay;
    if (rp) while (rp.next < rp.controls.length && rp.controls[rp.next].t <= at) this.applyControl(rp.controls[rp.next++], out);
    const byId = new Map(project.tracks.map((t) => [t.id, t]));
    const ids = [...project.tracks.map((t) => t.id), ...[...this.tracks.keys()].filter((id) => !byId.has(id))];
    for (const id of ids) {
      const rt = this.tracks.get(id);
      if (!rt || !rt.pending.length || rt.pending[0].atTick > at) continue;
      const due: Transition[] = [];
      while (rt.pending.length && rt.pending[0].atTick <= at) due.push(rt.pending.shift()!);
      const track = byId.get(id);
      if (!track) continue;
      const prev = rt.playing;
      let next = prev;
      for (const tr of due) {
        const slot = this.slotFor(track, tr);
        next = slot === null ? null : this.resolvePlaying(track, slot, tr.loopStart ?? tr.atTick);
      }
      rt.history.push({ appliedTick: at, prev, due });
      rt.playing = next;
      if (!samePlaying(prev, next)) {
        // Notes generated before this switch was known (a song edited while it plays) end here too.
        this.cutAtSwitch(rt, at);
        this.push(out, { kind: 'launch', tick: at, time: this.clock.timeAt(at), trackId: id, slot: next?.slot ?? null, clipId: next?.clipId ?? null });
      } else {
        // The same pad plays on, but its clip may have been replaced since notes were handed out (an edit
        // just after a region start, re-applied by the rewind): what another clip still sounds ends here.
        this.cutAtSwitch(rt, at, next?.clipId ?? null);
      }
    }
  }

  private applyControl(ev: ControlEvent, out: SeqEvent[]): void {
    // Recorded before a later start position (fromTick): applied at the start, not in the past.
    const tick = Math.max(ev.t, this.cursor);
    const time = this.clock.timeAt(tick);
    switch (ev.type) {
      case 'tempo': {
        const bpm = clampBpm(ev.bpm);
        const rp = this.replay;
        // The clock already follows the recorded tempo map, unless a live
        // tempo change replaced it: then the take takes over again from here.
        if (rp && rp.tempoOverrideTick !== null && tick >= rp.tempoOverrideTick) {
          for (const tp of rp.tempos) if (tp.tick >= tick) this.clock.reanchorAtTick(tp.tick, tp.bpm);
          rp.tempoOverrideTick = null;
          this.retimeAfter(this.clock, tick);
        }
        this.push(out, { kind: 'tempo', tick, time, bpm });
        break;
      }
      case 'swing': {
        const swing = clampSwing(ev.swing);
        this.swing.set(tick, swing);
        this.push(out, { kind: 'swing', tick, time, swing });
        break;
      }
      case 'macro':
        this.push(out, { kind: 'macro', tick, time, trackId: ev.trackId, macro: ev.macro, value: ev.value });
        break;
      case 'param':
        this.push(out, { kind: 'param', tick, time, module: ev.module, param: ev.param, value: ev.value });
        break;
      case 'mute':
        this.push(out, { kind: 'mute', tick, time, trackId: ev.trackId, mute: ev.mute });
        break;
      case 'master':
        this.push(out, { kind: 'master', tick, time, volumeDb: ev.volumeDb });
        break;
    }
  }

  private generate(a: number, b: number, project: Project, out: SeqEvent[]): void {
    // `+ 0` turns Math.ceil's -0 into 0.
    let bt = Math.ceil(a / TICKS_PER_BEAT) * TICKS_PER_BEAT + 0;
    if (bt < a) bt += TICKS_PER_BEAT;
    for (; bt < b; bt += TICKS_PER_BEAT) {
      const bar = Math.floor(bt / TICKS_PER_BAR);
      const beat = Math.round((bt - bar * TICKS_PER_BAR) / TICKS_PER_BEAT);
      this.push(out, {
        kind: 'beat',
        tick: bt,
        time: this.clock.timeAt(bt),
        bar,
        beat,
        beatSeconds: 60 / this.clock.bpmAtTick(bt),
        countIn: bt < this.musicStartTick,
      });
    }

    if (this.song) this.moveEvents(a, b, project, out);
    else this.moveSync = null;

    const cands: Candidate[] = [];
    const limit = this.endTick ?? Infinity;
    project.tracks.forEach((track, order) => {
      const rt = this.tracks.get(track.id);
      const mono = track.instrument.kind === 'bass';
      if (rt?.playing) {
        // No pending switch lies inside the window (switches are boundaries), so the first one bounds every note.
        const switchTick = Math.min(rt.pending.length ? rt.pending[0].atTick : Infinity, limit);
        this.clipCandidates(track, order, rt.playing, a, b, switchTick, mono, cands);
      }
      this.arpCandidates(track, order, a, b, limit, mono, true, cands);
    });
    if (this.replay) this.replayCandidates(project, a, b, limit, cands);
    cands.sort(compareCandidates);
    const domain: Domain = { clock: this.clock, swing: this.swing, clauses: this.clauses, floor: this.resumeFloor };
    for (const c of cands) this.emitNote(c, domain, out);
  }

  /**
   * Song moves for the window [a, b) (see moves.ts): each move segment of
   * the sections the passes play that starts in it, the rest value of targets
   * a move had moved where a pass or section starts (or a section ends with
   * more song after it) without one, and, once after a start, resume,
   * invalidation or skip (`moveSync`), the state there: a move under way
   * goes on from the value it has reached, a target no move holds rests.
   */
  private moveEvents(a: number, b: number, project: Project, out: SeqEvent[]): void {
    const sync = this.moveSync;
    if (!this.moved.size && !hasMoves(project)) {
      if (sync !== null && this.clock.timeAt(b) > sync) this.moveSync = null;
      return;
    }
    // Sections whose moves can act in the window: an echo throw returns a bar after its section; a
    // section starting within a bar after the window may take a target over.
    const { spans, rests } = this.sectionSpans(project, a - TICKS_PER_BAR, b + TICKS_PER_BAR);
    const segs = timelineSegments(project, spans);
    let from = a;
    if (sync !== null) {
      const at = Math.max(a, this.clock.tickAt(sync));
      if (at < b) {
        const time = Math.max(sync, this.clock.timeAt(at));
        const keys = new Set(this.moved);
        for (const s of segs) if (s.tick0 < at && at < s.tick1) keys.add(s.key);
        for (const key of keys) {
          const s = segmentAt(segs, key, at);
          if (s && s.tick0 < at) this.pushMove(out, s, at, time, valueIn(s, at));
          else if (!s) this.pushRest(out, project, key, at, time);
        }
        this.moveSync = null;
        from = at;
      }
    }
    // In time order (a move starting at a rest point holds its target there).
    const starts = segs.filter((s) => s.tick0 >= from && s.tick0 < b);
    const points = rests.filter((t) => t >= from && t < b);
    let i = 0;
    for (const t of points) {
      for (; i < starts.length && starts[i].tick0 <= t; i++) this.pushMove(out, starts[i], starts[i].tick0, this.clock.timeAt(starts[i].tick0), starts[i].v0);
      for (const key of [...this.moved]) if (!segmentAt(segs, key, t)) this.pushRest(out, project, key, t, this.clock.timeAt(t));
    }
    for (; i < starts.length; i++) this.pushMove(out, starts[i], starts[i].tick0, this.clock.timeAt(starts[i].tick0), starts[i].v0);
  }

  /**
   * The sections the song's passes play over transport ticks [lo, hi), as
   * move spans (see moves.ts SectionSpan), and the ticks where a target no
   * move holds goes back to rest: where a pass starts, where a section starts,
   * and where a section ends with more of the song after it (a fade-out at
   * the song's end stays faded through the tail). In time order.
   */
  private sectionSpans(project: Project, lo: number, hi: number): { spans: SectionSpan[]; rests: number[] } {
    const song = this.song!;
    const spans: SectionSpan[] = [];
    const rests: number[] = [];
    const length = songLengthTicks(project);
    const sections = [...project.arrangement.sections].sort((x, y) => x.start - y.start);
    extendPasses(song.passes, this.loopTicks(), hi);
    for (const p of song.passes) {
      if (p.at >= hi) break;
      const pe = passEnd(p);
      if (pe <= lo) continue;
      rests.push(p.at);
      for (const sec of sections) {
        const s0 = sec.start * TICKS_PER_BAR;
        const s1 = regionEnd(sec) * TICKS_PER_BAR;
        if (s1 <= p.from || s0 >= p.to) continue;
        const startTick = p.at + (s0 - p.from);
        const endTick = p.at + (s1 - p.from);
        if (startTick >= hi || endTick + TICKS_PER_BAR <= lo) continue;
        const inside = s1 <= p.to;
        spans.push({ section: sec, startTick, endTick, from: Math.max(startTick, p.at), to: inside ? Infinity : pe });
        rests.push(Math.max(startTick, p.at));
        if (inside && s1 < length) rests.push(endTick);
      }
    }
    spans.sort((x, y) => x.from - y.from);
    rests.sort((x, y) => x - y);
    return { spans, rests: rests.filter((t, i) => i === 0 || t !== rests[i - 1]) };
  }

  private pushMove(out: SeqEvent[], s: MoveSegment, tick: number, time: number, from: number): void {
    const endTime = Math.max(time, this.clock.timeAt(s.tick1));
    if (s.key === GAIN_KEY) this.push(out, { kind: 'songGain', tick, time, from, value: s.v1, endTick: s.tick1, endTime });
    else this.push(out, { kind: 'macroRamp', tick, time, trackId: s.trackId!, macro: s.macro!, from, value: s.v1, endTick: s.tick1, endTime });
    this.moved.add(s.key);
  }

  /** A target back at its rest value (song gain 1, a big knob at the part's own value) from `tick`. */
  private pushRest(out: SeqEvent[], project: Project, key: string, tick: number, time: number): void {
    const v = restValue(project, key);
    if (key === GAIN_KEY) this.push(out, { kind: 'songGain', tick, time, from: v, value: v, endTick: tick, endTime: time });
    else {
      const sep = key.indexOf('\u0000');
      this.push(out, { kind: 'macroRamp', tick, time, trackId: key.slice(0, sep), macro: key.slice(sep + 1) as MacroId, from: v, value: v, endTick: tick, endTime: time });
    }
    this.moved.delete(key);
  }

  private clipCandidates(track: Track, order: number, p: Playing, a: number, b: number, switchTick: number, mono: boolean, cands: Candidate[]): void {
    const clip = track.clips[p.slot];
    if (!clip) return;
    if (clip.id !== p.clipId) p.clipId = clip.id;
    const prep = prepareClip(clip, mono);
    if (!prep.notes.length) return;
    const len = prep.length;
    // A sampler clip with its own recording plays that one (other kinds keep the field but ignore it).
    const sample = track.instrument.kind === 'sampler' ? clip.sample : undefined;
    const lo = Math.max(a, p.startTick, this.musicStartTick);
    if (lo >= b) return;
    for (let k = Math.max(0, Math.floor((lo - p.startTick) / len)); ; k++) {
      const base = p.startTick + k * len;
      if (base >= b) break;
      for (const n of prep.notes) {
        const t = base + n.tick;
        if (t < lo) continue;
        if (t >= b) break;
        const natural = Math.min(base + n.end, switchTick);
        const end = mono ? Math.min(base + n.monoEnd, switchTick) : natural;
        if (end <= t) continue;
        cands.push({
          tick: t,
          endTick: end,
          naturalEndTick: natural,
          trackId: track.id,
          order,
          src: 0,
          pitch: n.pitch,
          velocity: n.velocity,
          source: 'clip',
          clipId: clip.id,
          sample,
          swung: true,
          mono,
        });
      }
    }
  }

  private arpCandidates(track: Track, order: number, a: number, b: number, limit: number, mono: boolean, swung: boolean, cands: Candidate[]): void {
    const arp = this.arps.get(track.id);
    if (!arp || !arp.changes.length || !track.arp.enabled) return;
    const div = arpDivisionTicks(track.arp.division);
    const gate = arpGateTicks(track.arp);
    let g = Math.ceil(a / div) * div + 0;
    if (g < a) g += div;
    for (; g < b; g += div) {
      const ch = changeAt(arp.changes, g);
      if (!ch || ch.origin === null || g < ch.origin) continue;
      const set = arpInput(ch, track.arp.latch);
      if (!set.length) continue;
      const pitch = arpNoteAt(set, track.arp, Math.round((g - ch.origin) / div));
      if (pitch === null) continue;
      const end = Math.min(g + gate, limit);
      if (end <= g) continue;
      cands.push({ tick: g, endTick: end, naturalEndTick: end, trackId: track.id, order, src: 2, pitch, velocity: ch.velocity, source: 'arp', swung, mono });
    }
  }

  private replayCandidates(project: Project, a: number, b: number, limit: number, cands: Candidate[]): void {
    const notes = this.replay!.notes;
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].tick < a) lo = mid + 1;
      else hi = mid;
    }
    const order = new Map(project.tracks.map((t, i) => [t.id, i]));
    for (let i = lo; i < notes.length && notes[i].tick < b; i++) {
      const n = notes[i];
      const idx = order.get(n.trackId);
      if (idx === undefined || n.tick < this.musicStartTick) continue;
      const end = Math.min(n.endTick, limit);
      if (end <= n.tick) continue;
      cands.push({
        tick: n.tick,
        endTick: end,
        naturalEndTick: end,
        trackId: n.trackId,
        order: idx,
        src: 1,
        pitch: n.pitch,
        velocity: n.velocity,
        source: 'replay',
        // Recorded ticks already carry the player's timing.
        swung: false,
        mono: project.tracks[idx].instrument.kind === 'bass',
      });
    }
  }

  private lastSounding(rt: TrackRt): Emitted | undefined {
    for (let i = rt.recent.length - 1; i >= 0; i--) if (!rt.recent[i].dropped) return rt.recent[i];
    return undefined;
  }

  private emitNote(c: Candidate, d: Domain, out: SeqEvent[]): void {
    const swing = c.swung && d.swing ? d.swing.at(c.tick) : 0;
    const time = d.clock.timeAtSwung(c.tick, swing);
    if (time < d.floor || skipped(d.clauses, c.tick, time)) return;
    const rt = this.rt(c.trackId);
    let legato = false;
    if (c.mono) {
      const prev = this.lastSounding(rt);
      if (prev && prev.tick === c.tick) {
        // Two notes starting together on a mono part: the lowest wins.
        if (c.pitch >= prev.event.pitch) return;
        this.truncate(prev, c.tick);
      } else if (prev && prev.tick < c.tick) {
        legato = prev.naturalEndTick > c.tick;
        // End exactly where this note starts (a swung and an unswung source may disagree by a few ticks).
        if (prev.endTick > c.tick) this.truncate(prev, c.tick, time);
      }
    }
    const endTime = d.clock.timeAtSwung(c.endTick, swing);
    const event: NoteEvent = {
      kind: 'note',
      tick: c.tick,
      time,
      trackId: c.trackId,
      pitch: c.pitch,
      velocity: c.velocity,
      duration: Math.max(0, endTime - time),
      durationTicks: c.endTick - c.tick,
      legato,
      source: c.source,
    };
    if (c.clipId !== undefined) event.clipId = c.clipId;
    if (c.sample) event.sample = c.sample;
    out.push(event);
    rt.recent.push({
      event,
      tick: c.tick,
      endTick: c.endTick,
      naturalEndTick: c.naturalEndTick,
      endTime: time + event.duration,
      swing,
      clock: d.clock,
      batch: this.batch,
      dropped: false,
    });
    if (rt.recent.length > MAX_RECENT) rt.recent.splice(0, rt.recent.length - MAX_RECENT);
  }

  /**
   * Shorten an emitted note to end at `tick` (at `atTime` when given): in
   * place while it is still in the batch being built, else via a cut. A note
   * is never lengthened.
   */
  private truncate(e: Emitted, tick: number, atTime?: number): void {
    const newEnd = Math.max(e.tick, tick);
    if (newEnd >= e.endTick) return;
    e.endTick = newEnd;
    const ev = e.event;
    const drop = newEnd <= e.tick;
    const endTime = drop ? ev.time : Math.min(e.endTime, Math.max(ev.time, atTime ?? e.clock.timeAtSwung(newEnd, e.swing)));
    const shortened = endTime < e.endTime;
    e.endTime = endTime;
    if (this.inProcess && e.batch === this.batch) {
      if (drop) {
        e.dropped = true;
        this.dropped.add(ev);
      } else {
        ev.durationTicks = newEnd - e.tick;
        ev.duration = endTime - ev.time;
      }
      return;
    }
    if (drop) e.dropped = true;
    if (drop || shortened) this.cuts.push({ note: ev, trackId: ev.trackId, tick: newEnd, time: endTime });
  }

  /**
   * After a tempo change at `tick` of `clock`: notes that started before it
   * and end after it follow the new tempo. A note still in the batch being
   * built is re-timed in place (longer or shorter); one already handed out can
   * only be shortened, by a cut, since a scheduled voice cannot be lengthened.
   */
  private retimeAfter(clock: TempoMap, tick: number): void {
    for (const rt of this.tracks.values()) {
      for (const e of rt.recent) {
        if (e.dropped || e.clock !== clock || e.endTick <= tick) continue;
        // Notes that sound from the change on move as a whole: invalidate() regenerates them.
        if (swingWarp(e.tick, e.swing) >= tick) continue;
        const ev = e.event;
        const end = Math.max(ev.time, clock.timeAtSwung(e.endTick, e.swing));
        if (this.inProcess && e.batch === this.batch) {
          ev.duration = end - ev.time;
          e.endTime = end;
        } else if (end < e.endTime - 1e-9) {
          e.endTime = end;
          this.cuts.push({ note: ev, trackId: ev.trackId, tick: e.endTick, time: end });
        }
      }
    }
  }

  private runFree(untilTime: number, project: Project, out: SeqEvent[]): void {
    const clock = this.freeClock!;
    const untilTick = clock.tickAt(untilTime);
    if (this.freeCursor < untilTick) {
      const cands: Candidate[] = [];
      project.tracks.forEach((track, order) =>
        this.arpCandidates(track, order, this.freeCursor, untilTick, Infinity, track.instrument.kind === 'bass', false, cands),
      );
      cands.sort(compareCandidates);
      const domain: Domain = { clock, swing: null, clauses: this.freeClauses, floor: -Infinity };
      for (const c of cands) this.emitNote(c, domain, out);
      this.freeCursor = untilTick;
      this.freeClauses = this.freeClauses.filter((c) => c.untilTick > this.freeCursor);
    }
    if (!this.freeArpActive(project)) {
      // Nothing held or latched any more: retire the idle clock.
      this.freeClock = null;
      this.freeClauses = [];
      for (const a of this.arps.values()) a.changes = [];
    }
  }

  private freeArpActive(project: Project): boolean {
    for (const track of project.tracks) {
      const arp = this.arps.get(track.id);
      if (!arp || !track.arp.enabled || !arp.changes.length) continue;
      const last = arp.changes[arp.changes.length - 1];
      if (last.tick > this.freeCursor || arpInput(last, track.arp.latch).length) return true;
    }
    return false;
  }

  private _skippedNotes = 0;

  /** How many notes the last skipTo left out (0 when it skipped nothing, or only beats and controls). */
  get skippedNotes(): number {
    return this._skippedNotes;
  }

  /**
   * Playing, the driver fell behind (the main thread was busy): move
   * generation on to `time` without handing out what should already have
   * sounded. The notes and beats of the missed stretch are dropped (never
   * played late); every state change on the way applies in order as if it
   * had played (clip launches, the song's region changes, a replayed take's
   * controls, the end), so the launcher, the song position and each clip's
   * loop phase stay where the audio clock is. Returns those changes (launch,
   * end, control values) for the driver to pass on, in order. Song moves are sent
   * again from `time` with the value they have reached (see moveEvents).
   * Notes already handed out that the stretch would have ended are cut as
   * usual (takeCuts). Like `skipIdleTo` for the idle arpeggiator.
   */
  skipTo(time: number): SeqEvent[] {
    this._skippedNotes = 0;
    if (!this._playing || !Number.isFinite(time)) return [];
    if (this.cursor >= this.clock.tickAt(time)) return [];
    const project = this.activeProject();
    let scratch: SeqEvent[] = [];
    this.batch++;
    this.inProcess = true;
    this.dropped.clear();
    try {
      if (!this.resumeSent) {
        this.resumeSent = true;
        scratch.push(...this.resumeEvents);
      }
      this.runTransport(time, project, scratch);
    } finally {
      this.inProcess = false;
    }
    this.dropped.clear();
    // The stretch's notes never sound: they end nothing later and no mono note glides from them.
    for (const rt of this.tracks.values()) for (const e of rt.recent) if (e.batch === this.batch) e.dropped = true;
    let notes = 0;
    for (const e of scratch) if (e.kind === 'note') notes++;
    this._skippedNotes = notes;
    scratch = scratch.filter((e) => e.kind !== 'note' && e.kind !== 'beat' && e.kind !== 'songGain' && e.kind !== 'macroRamp');
    scratch.sort(compareEvents);
    this.moveSync = time;
    this.prune();
    return scratch;
  }

  /**
   * The clip part `trackId` sounds at transport tick `tick` (looking back
   * through the applied changes still in the history, HISTORY_TICKS), with
   * its loop start and length, written into `out`; null when the part is
   * silent there (stopped, or before the clip's first downbeat). While
   * paused, the clip holding at the pause. Allocation-free.
   */
  clipPhaseAt(trackId: Id, tick: number, out: ClipPhase): ClipPhase | null {
    const rt = this.tracks.get(trackId);
    if (!rt || !Number.isFinite(tick)) return null;
    let p = rt.playing;
    for (let i = rt.history.length - 1; i >= 0 && rt.history[i].appliedTick > tick; i--) p = rt.history[i].prev;
    if (!p || tick < p.startTick) return null;
    const project = this.activeProject();
    let clip: Clip | null = null;
    for (const t of project.tracks) {
      if (t.id !== trackId) continue;
      clip = t.clips[p.slot] ?? null;
      break;
    }
    if (!clip) return null;
    out.slot = p.slot;
    out.startTick = p.startTick;
    out.lengthTicks = clipLength(clip);
    return out;
  }

  /**
   * The tick at which part `trackId`'s next change of clip lands, as heard
   * at transport tick `tick`: a switch already generated ahead of it (in the
   * history, not heard yet) or the first queued one (a pad launch, a stop,
   * or the song switching the part to another clip or to silence at its
   * next region change). Song changes that keep the part on the same clip
   * do not count. Null when nothing is queued. Allocation-free.
   */
  queuedAtTick(trackId: Id, tick: number): number | null {
    const rt = this.tracks.get(trackId);
    if (!rt) return null;
    const h = rt.history;
    for (let i = 0; i < h.length; i++) {
      if (h[i].appliedTick <= tick) continue;
      const next = i + 1 < h.length ? h[i + 1].prev : rt.playing;
      if ((h[i].prev?.slot ?? null) !== (next?.slot ?? null)) return h[i].appliedTick;
    }
    if (!rt.pending.length) return null;
    let track: Track | null = null;
    for (const t of this.activeProject().tracks) {
      if (t.id !== trackId) continue;
      track = t;
      break;
    }
    let cur = rt.playing?.slot ?? null;
    for (const tr of rt.pending) {
      // Song changes become visible a bar ahead (see insertSongChange), as in getTrackState.
      if (tr.source !== 'live' && tr.requestTick > this.cursor) continue;
      const slot = track ? this.slotFor(track, tr) : tr.slot;
      if (slot !== cur) return tr.atTick;
      cur = slot;
    }
    return null;
  }

  /** Transport stopped and the idle arp clock fell behind (throttled tab): skip ahead without a backlog. */
  skipIdleTo(time: number): void {
    if (this._playing || !this.freeClock || !Number.isFinite(time)) return;
    this.freeCursor = Math.max(this.freeCursor, this.freeClock.tickAt(time));
    this.freeClauses = this.freeClauses.filter((c) => c.untilTick > this.freeCursor);
  }

  /* ---------------------------------------------------------------- */
  /* Invalidation                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Regenerate events whose (swung) time is >= fromTime on the next
   * process(). The driver must first cancel every voice/automation it
   * scheduled at or after `fromTime`; earlier events are not repeated.
   */
  invalidate(fromTime: number): void {
    if (!Number.isFinite(fromTime)) return;
    // Cuts on cancelled notes are void, and cancelled notes no longer sound.
    this.cuts = this.cuts.filter((c) => c.note.time < fromTime);
    for (const rt of this.tracks.values()) rt.recent = rt.recent.filter((e) => e.event.time < fromTime);
    // The driver cancelled the engine's automation from `fromTime` (a move under way holds there): send the moves' state again.
    if (this._playing) this.moveSync = this.moveSync === null ? fromTime : Math.min(this.moveSync, fromTime);
    if (this._playing) this.rewindTransport(fromTime);
    else if (this.freeClock) this.rewindFree(fromTime);
  }

  private rewindTransport(fromTime: number): void {
    // A resumed take's control values sent at the resume time were cancelled with the rest: send them again.
    if (this.resumeEvents.length && this.resumeEvents[0].time >= fromTime) this.resumeSent = false;
    const fromTick = this.clock.tickAt(fromTime);
    // Swing delays notes by up to MAX_SWING_TICKS: earlier ticks can sound at/after fromTime.
    const r = Math.max(fromTick - MAX_SWING_TICKS, this.startTick, this.historyFloor);
    const c = this.cursor;
    if (r >= c) return;
    for (const rt of this.tracks.values()) {
      while (rt.history.length && rt.history[rt.history.length - 1].appliedTick >= r) {
        const h = rt.history.pop()!;
        rt.playing = h.prev;
        for (const tr of h.due) this.insertTransition(rt, tr);
      }
    }
    const rp = this.replay;
    if (rp) {
      rp.next = 0;
      while (rp.next < rp.controls.length && rp.controls[rp.next].t < r) rp.next++;
    }
    if (this.endTick !== null && this.endTick >= r) this._ended = false;
    // The driver cancelled an 'end' at or after fromTime (it is sent again); an earlier one is still out.
    if (this.endSentTime !== null && this.endSentTime >= fromTime) {
      this.endSentTime = null;
      this._ended = false;
    }
    this.clauses = [{ untilTick: c, floorTime: fromTime }, ...this.clauses.map((cl) => ({ untilTick: cl.untilTick, floorTime: Math.min(cl.floorTime, fromTime) }))];
    this.cursor = r;
  }

  private rewindFree(fromTime: number): void {
    const clock = this.freeClock!;
    const r = Math.max(clock.tickAt(fromTime), this.freeHistoryFloor);
    const c = this.freeCursor;
    if (r >= c) return;
    this.freeClauses = [{ untilTick: c, floorTime: fromTime }, ...this.freeClauses.map((cl) => ({ untilTick: cl.untilTick, floorTime: Math.min(cl.floorTime, fromTime) }))];
    this.freeCursor = r;
  }

  /* ---------------------------------------------------------------- */
  /* Housekeeping                                                      */
  /* ---------------------------------------------------------------- */

  private prune(): void {
    const playing = this._playing;
    if (!playing && !this.freeClock) return;
    const cursor = playing ? this.cursor : this.freeCursor;
    const floor = cursor - HISTORY_TICKS;
    if (floor <= (playing ? this.historyFloor : this.freeHistoryFloor)) return;
    if (playing) {
      this.historyFloor = floor;
      for (const rt of this.tracks.values()) while (rt.history.length && rt.history[0].appliedTick < floor) rt.history.shift();
      this.clock.prune(this.clock.timeAt(floor));
      this.swing.prune(floor);
      this.pruneSong(floor);
    } else {
      this.freeHistoryFloor = floor;
      this.freeClock!.prune(this.freeClock!.timeAt(floor));
    }
    for (const rt of this.tracks.values()) {
      if (rt.recent.length < 2) continue;
      const last = rt.recent[rt.recent.length - 1];
      rt.recent = rt.recent.filter((e) => e === last || Math.max(e.endTick, e.naturalEndTick) >= floor);
    }
    for (const arp of this.arps.values()) {
      let first = 0;
      while (first + 1 < arp.changes.length && arp.changes[first + 1].tick <= floor) first++;
      if (first > 0) arp.changes = arp.changes.slice(first);
    }
  }
}
