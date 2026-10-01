/**
 * Sequencer (pure: no DOM, no Web Audio).
 *
 * Turns the project (clips, launcher, arrangement, performances, arp input)
 * into timed `SeqEvent`s for windows of the transport timeline. A driver
 * (RealtimeTransport, renderOffline) calls `process(untilTime)` repeatedly
 * and schedules what comes back on the audio clock.
 *
 * See src/time/contracts.ts for the timing model. Implementation notes:
 * - Every state change (clip switch, song block, recorded control event,
 *   end) is a boundary: the window is generated up to it, the change is
 *   applied, generation continues. Applied switches are kept in a short
 *   history so `invalidate()` can roll them back and replay them.
 * - A note already handed out can only be shortened through a `NoteCut`
 *   (`takeCuts()`): the driver releases that voice early. That happens when
 *   a launch is queued after the outgoing clip's note was generated, a mono
 *   part gets a new note while an earlier one is still sounding, or a tempo
 *   change makes a sounding note's end tick come sooner.
 * - A replayed take's recorded tempo changes are all in the clock from the
 *   start, so every note length and time already follows them.
 * - Song mode lays every block's part changes out as transitions ('song'
 *   source) when it starts; `replanSong()` replaces those from the edit
 *   point (or the start of a block not heard yet) when the song is edited
 *   while it plays.
 * - A song loop (`setSongLoop`) continues the plan with the loop's blocks
 *   again and again: one pass of it is kept as a template and laid out
 *   again a little ahead of the generation cursor (`extendSong`); entries
 *   that played long ago are dropped (`pruneSong`), so a long loop never
 *   grows the plan.
 */
import {
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  TICKS_PER_STEP,
  type Clip,
  type Id,
  type LauncherSnapshotEntry,
  type Performance,
  type PerformanceEvent,
  type Project,
  type Track,
} from '../project/types';
import { blockBars, blockRowOverrides, clampRepeats } from '../project/arrangement';
import type { LaunchResult, PlayMode, SeqEvent, SongLoop, StartOptions, TrackLaunchState } from './contracts';
import { MAX_SWING_TICKS, TempoMap, clampBpm, clampSwing, swingWarp } from './clock';
import { EMPTY_LATCH, arpDivisionTicks, arpGateTicks, arpGridAtOrAfter, arpInput, arpNoteAt, updateLatch, type LatchState } from './arp';
import { projectFromSnapshot } from './snapshot';
import { sameSongLoop, songLoopRange } from './songLoop';

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

export interface SongBlockPlan {
  /** Index into project.arrangement.blocks (-1: a block deleted while it played, sounding on to the next bar line, where the block that followed it takes over). */
  index: number;
  blockId: Id;
  /** The block's scene row (what every part plays unless `parts` says otherwise). */
  row: number;
  /** Parts that play another row in this block (null = silent there); see project/arrangement.ts. */
  parts: Readonly<Record<Id, number | null>>;
  bars: number;
  repeats: number;
  startTick: number;
  endTick: number;
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

/** Scene length in bars: the longest clip in the row (at least 1). */
export function sceneBars(project: Project, row: number): number {
  let bars = 1;
  for (const t of project.tracks) {
    const c = t.clips[row];
    if (c && c.bars > bars) bars = c.bars;
  }
  return bars;
}

/** Arrangement blocks laid out on the song timeline (blocks whose scene is missing are skipped). */
export function songBlocks(project: Project): SongBlockPlan[] {
  const out: SongBlockPlan[] = [];
  let tick = 0;
  project.arrangement.blocks.forEach((b, index) => {
    const row = project.scenes.findIndex((s) => s.id === b.sceneId);
    if (row < 0) return;
    const bars = blockBars(project, b);
    const repeats = clampRepeats(b.repeats);
    const len = bars * repeats * TICKS_PER_BAR;
    out.push({ index, blockId: b.id, row, parts: blockRowOverrides(project, b), bars, repeats, startTick: tick, endTick: tick + len });
    tick += len;
  });
  return out;
}

/**
 * Where tick `tick` of a song plan (see `Sequencer.songPlan`) lies on the
 * lane `lane` (`songBlocks` of the project as it is now), in ticks from the
 * lane start: the lane start of the plan block containing it plus how far
 * into that block it is, never past the block's length on the lane (a block
 * shortened below the playhead sounds on to the next bar line while the
 * playhead waits at its end). While a block deleted as it played sounds on
 * to the next bar line, the playhead waits where the block that takes over
 * starts (the end of the block before it), or at the end of the song.
 */
export function songLaneTick(plan: readonly SongBlockPlan[], lane: readonly SongBlockPlan[], tick: number): number {
  if (!plan.length) return 0;
  let i = plan.findIndex((b) => tick < b.endTick);
  if (i < 0) i = plan.length - 1;
  const b = plan[i];
  const here = lane.find((x) => x.blockId === b.blockId);
  if (here) return here.startTick + Math.min(Math.max(0, tick - b.startTick), here.endTick - here.startTick);
  for (let j = i + 1; j < plan.length; j++) {
    const next = lane.find((x) => x.blockId === plan[j].blockId);
    if (next) return next.startTick;
  }
  return lane.length ? lane[lane.length - 1].endTick : 0;
}

/** Song length in ticks: sum of scene bars x repeats. */
export function songLengthTicks(project: Project): number {
  const blocks = songBlocks(project);
  return blocks.length ? blocks[blocks.length - 1].endTick : 0;
}

/** What one part plays in a song block: the scene row whose slot it plays (null: silent) and the clip there. */
interface PartPlay {
  row: number | null;
  clipId: Id | null;
}

/** What every part plays in a planned block. */
function partPlays(project: Project, b: SongBlockPlan): Record<Id, PartPlay> {
  const out: Record<Id, PartPlay> = {};
  for (const t of project.tracks) {
    const row = Object.prototype.hasOwnProperty.call(b.parts, t.id) ? b.parts[t.id] : b.row;
    const clip = row !== null ? t.clips[row] : null;
    out[t.id] = { row, clipId: clip ? clip.id : null };
  }
  return out;
}

/** A planned block placed on the song timeline at `startTick`, with what its parts play now. */
function songEntry(project: Project, b: SongBlockPlan, startTick: number): SongEntry {
  return { ...b, startTick, endTick: startTick + (b.endTick - b.startTick), phases: [{ tick: startTick, parts: partPlays(project, b) }] };
}

/**
 * Lay out passes of a loop (`state.cycle`, going on with its block
 * `state.cycleNext`) after the last entry of `blocks` until the plan reaches
 * past `until`. Every pass plays its blocks exactly as the song does there.
 */
function layCycles(project: Project, blocks: SongEntry[], state: { cycle: readonly SongBlockPlan[] | null; cycleNext: number }, until: number): void {
  const cycle = state.cycle;
  let last = blocks[blocks.length - 1];
  if (!cycle?.length || !last) return;
  while (last.endTick <= until) {
    const b = cycle[state.cycleNext % cycle.length];
    state.cycleNext = (state.cycleNext + 1) % cycle.length;
    last = songEntry(project, b, last.endTick);
    blocks.push(last);
  }
}

/**
 * The block playing (`anchor`) as the project has it now (`b`), from its
 * start to `end`: what played before `from` stays, and parts whose clip
 * changed switch at `from`, in phase with the block start.
 */
function keepPlaying(project: Project, anchor: SongEntry, b: SongBlockPlan, end: number, from: number): SongEntry {
  const parts = partPlays(project, b);
  const phases = anchor.phases.filter((ph) => ph.tick < from);
  const now = phases.length ? phases[phases.length - 1].parts : null;
  if (from < end && (!now || project.tracks.some((t) => !samePart(now[t.id], parts[t.id])))) phases.push({ tick: from, parts });
  return { ...b, startTick: anchor.startTick, endTick: end, phases };
}

/** Two choices sound the same: the same clip, or silence. */
function samePart(a: PartPlay | undefined, b: PartPlay): boolean {
  return !!a && a.clipId === b.clipId;
}

/** Every part plays the same clip (or nothing) in both: switching from `a` to `b` would change nothing you hear. */
function sameClips(project: Project, a: Readonly<Record<Id, PartPlay>>, b: Readonly<Record<Id, PartPlay>>): boolean {
  return project.tracks.every((t) => (a[t.id]?.clipId ?? null) === (b[t.id]?.clipId ?? null));
}

/** What a block's parts play from `tick` on (the phase in effect before `tick`, else its first). */
function partsBefore(e: SongEntry, tick: number): Record<Id, PartPlay> | null {
  let parts = e.phases.length ? e.phases[0].parts : null;
  for (const ph of e.phases) if (ph.tick < tick) parts = ph.parts;
  return parts;
}

function partsKey(parts: Readonly<Record<Id, number | null>>): string {
  return Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join(',');
}

function blockKey(b: SongBlockPlan): string {
  return `${b.index}:${b.blockId}:${b.startTick}-${b.endTick}:${b.row}:${b.bars}x${b.repeats}:${partsKey(b.parts)}`;
}

/**
 * Everything a replan can change: placement and content of the blocks
 * starting before `limit` (from `skip` on), part phases from `first` on, the
 * end, and the loop still to come (`cycle`, a pending jump).
 */
function songKey(blocks: readonly SongEntry[], first: number, end: number | null, loop: { skip: number; limit: number; cycle: readonly SongBlockPlan[] | null; jumpAt: number | null }): string {
  const out = [`end ${end}`, `jump ${loop.jumpAt}`, `cycle ${loop.cycle ? loop.cycle.map((b) => `${b.blockId}:${b.endTick - b.startTick}:${b.row}:${partsKey(b.parts)}`).join(',') : '-'}`];
  for (let i = loop.skip; i < blocks.length; i++) {
    const e = blocks[i];
    if (e.startTick >= loop.limit) break;
    let k = blockKey(e);
    if (i >= first) for (const ph of e.phases) k += `;${ph.tick}=` + Object.values(ph.parts).map((p) => `${p.row}/${p.clipId}`).join(',');
    out.push(k);
  }
  return out.join('|');
}

/** Length of one pass of a loop (0 without one). */
function cycleTicks(cycle: readonly SongBlockPlan[] | null): number {
  return cycle ? cycle.reduce((n, b) => n + b.endTick - b.startTick, 0) : 0;
}

/**
 * Identity of the song as playback lays it out: blocks in order, their
 * lengths and what every part plays in them (row and clip). A change to it
 * while the song plays is what `Sequencer.replanSong` follows.
 */
export function songSignature(project: Project): string {
  return songBlocks(project)
    .map((b) => {
      const parts = partPlays(project, b);
      return `${b.index}:${b.blockId}:${b.bars}x${b.repeats}:` + project.tracks.map((t) => `${parts[t.id].row}/${parts[t.id].clipId}`).join(',');
    })
    .join('|');
}

const KIND_ORDER: Record<SeqEvent['kind'], number> = {
  end: 0,
  block: 1,
  launch: 2,
  tempo: 3,
  swing: 4,
  master: 5,
  mute: 6,
  param: 7,
  macro: 8,
  beat: 9,
  note: 10,
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
  /** Target slot (null = stop) unless `row` is set. */
  slot: number | null;
  /** Scene row resolved when applied: that slot if it holds a clip, else stop. */
  row: number | null;
  source: TransitionSource;
  /** Order among transitions at the same tick (later wins); song changes are negative, so a pad tapped for that bar wins. */
  seq: number;
  /** Tick at which the request was made (queued state becomes visible then). */
  requestTick: number;
  /** Loop start of the clip it starts (default `atTick`): a part switched inside a song block plays in phase with the block. */
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

/** A block on the song timeline (absolute ticks) and what its parts play. */
interface SongEntry extends SongBlockPlan {
  /**
   * What every part plays from `tick` on: from the block start, then after
   * each switch made because the block changed while it played. The song
   * transitions in the launcher always mirror these.
   */
  phases: { tick: number; parts: Record<Id, PartPlay> }[];
}

interface SongState {
  /**
   * The whole song on the timeline: history (blocks before the start point,
   * or before the block that was playing at the last replan, laid out in the
   * current order), then the blocks that play.
   */
  blocks: SongEntry[];
  /** First entry that plays (earlier ones are history and never send a 'block' event). */
  first: number;
  /** Next entry whose 'block' event is due. */
  next: number;
  /**
   * While the song loops: one pass of the loop (its blocks as the lane had
   * them at the last layout), laid out again after the last entry whenever
   * playback gets near it (`extendSong`). Null: the song ends after the last
   * entry.
   */
  cycle: SongBlockPlan[] | null;
  /** The block of `cycle` that follows the last entry. */
  cycleNext: number;
  /**
   * Blocks after the loop on the lane (ids, at the last layout): where the
   * song goes on when every block it would loop through was deleted.
   */
  after: Id[];
  /** A loop set while the playhead was outside it: at this bar line playback continues at the loop's first block. */
  jumpAt: number | null;
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
    return positionOf(this._playing ? Math.max(this.playheadFloor, this.clock.tickAt(time)) : this.stoppedTick);
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
      const blocks = songBlocks(base);
      const total = blocks.length ? blocks[blocks.length - 1].endTick : 0;
      const from = blocks.findIndex((b) => b.index >= mode.fromBlock);
      fromTick ??= from >= 0 ? blocks[from].startTick : total;
      const f = fromTick;
      // Blocks before the start position are history; the block containing it switches in at the start.
      let first = blocks.findIndex((b) => b.endTick > f);
      if (first < 0) first = blocks.length;
      // Starting before the loop's end it plays into the loop and loops; starting after it, to the song's end.
      const range = songLoopRange(blocks, this.loop);
      const loops = range !== null && first <= range[1];
      song = {
        blocks: (loops ? blocks.slice(0, range[1] + 1) : blocks).map((b) => songEntry(base, b, b.startTick)),
        first,
        next: first,
        cycle: loops ? blocks.slice(range[0], range[1] + 1) : null,
        cycleNext: 0,
        after: loops ? blocks.slice(range[1] + 1).map((b) => b.blockId) : [],
        jumpAt: null,
      };
      endTick = loops ? null : total;
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

    if (song) {
      for (let i = song.first; i < song.blocks.length; i++) this.insertSongPhase(song.blocks[i], 0, song.blocks[i].startTick - TICKS_PER_BAR);
      this.extendSong(startTick + 2 * TICKS_PER_BAR);
    }

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
    if (this.song) this.song.next = this.songIndexFrom(tick);
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
   * that bar would have been without the pause).
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
   * Scene rows were reordered (`rows` maps an old row to its new row): song
   * playback keeps playing the same scenes. Live launches follow per part
   * through `relocateSlots`; a replay plays its own snapshot.
   */
  relocateSongRows(rows: ReadonlyMap<number, number>): boolean {
    const song = this.song;
    if (!song || !rows.size || this.replay) return false;
    const row = (r: number): number => rows.get(r) ?? r;
    const rowOrNull = (r: number | null): number | null => (r === null ? null : row(r));
    const remapTr = (tr: Transition): Transition => (tr.row !== null && rows.has(tr.row) ? { ...tr, row: rows.get(tr.row)! } : tr);
    const remapParts = (from: Readonly<Record<Id, number | null>>): Record<Id, number | null> => {
      const parts: Record<Id, number | null> = {};
      for (const [id, r] of Object.entries(from)) parts[id] = rowOrNull(r);
      return parts;
    };
    if (song.cycle) song.cycle = song.cycle.map((b) => ({ ...b, row: row(b.row), parts: remapParts(b.parts) }));
    song.blocks = song.blocks.map((b) => {
      const parts = remapParts(b.parts);
      const phases = b.phases.map((ph) => {
        const pp: Record<Id, PartPlay> = {};
        for (const [id, p] of Object.entries(ph.parts)) pp[id] = { row: rowOrNull(p.row), clipId: p.clipId };
        return { tick: ph.tick, parts: pp };
      });
      return { ...b, row: row(b.row), parts, phases };
    });
    for (const rt of this.tracks.values()) {
      rt.pending = rt.pending.map(remapTr);
      for (const h of rt.history) h.due = h.due.map(remapTr);
    }
    return true;
  }

  /**
   * The song changed while it plays (or is paused): lay out the rest of it
   * again from the project, anchored on the block playing at `time` (at the
   * pause point while paused). Blocks before it are history. The edit point
   * is the playhead at `time` (the pause point while paused), rounded up to
   * a whole tick: nothing before it changes.
   * - The playing block, found by its id, keeps its start tick and takes its
   *   new length. Parts whose clip in it changed (its scene, a part switched
   *   off or on, a layered part, the clip in that slot) switch at the edit
   *   point, in phase with the block start: a part switched off stops there
   *   (its sounding notes end), one switched on joins mid-loop (its notes
   *   that would have started before the edit point are not played late).
   * - When the edited lane puts another block under the playhead and that
   *   block plays the same clips as what sounds now (a split while a later
   *   pass plays, a join while the second block plays, undoing either, a
   *   deleted block whose neighbour plays the same), playback continues in
   *   that block: nothing switches and every clip keeps its loop phase. The
   *   playhead's place on the edited lane: the new order laid out from the
   *   playing block's start or, when that block was deleted, from the start
   *   of the nearest block before it that is still in the song (with none,
   *   the block after it takes its place).
   * - Otherwise a block that no longer reaches the playhead (shortened below
   *   it) or that was deleted sounds on to the next bar line, where the block
   *   after it takes over (for a deleted block: the first block that followed
   *   it and still exists, at its place in the new order), or the song ends.
   * - Everything after it (order, scenes, parts, repeats, lengths, the end)
   *   follows the project. The end never lies behind the playhead.
   * A block whose start has not sounded yet (right after Play, or paused or
   * resumed on its first tick) starts as the project has it now; deleted,
   * the block that followed it starts in its place.
   * With a loop: after the loop's last block the loop's first block follows
   * (also when the block playing is the one handing over); the song has no
   * end while it loops. An edit never jumps: a playhead before the loop
   * plays into it, one after it plays to the song's end. A jump to the loop
   * set by `setSongLoop` still waiting for its bar line is kept. `loop`
   * given: the loop as the session left it after this edit (see
   * songLoopAfterEdit), taken without a jump.
   * Returns true when playback changed: the driver then cancels what it
   * scheduled from `time` and calls `invalidate(time)`. False outside song
   * mode, while stopped, or once the song is over.
   */
  replanSong(time: number, loop?: SongLoop | null): boolean {
    if (loop !== undefined) this.loop = loop ? { fromBlockId: loop.fromBlockId, toBlockId: loop.toBlockId } : null;
    return this.layoutSong(time, false);
  }

  /** The looped part of the song, or null (it plays through). */
  get songLoop(): SongLoop | null {
    return this.loop ? { ...this.loop } : null;
  }

  /**
   * Loop the blocks from `loop.fromBlockId` to `loop.toBlockId` (inclusive,
   * either way round, in the song's current order), or play the song through
   * again (null). Stopped, it applies to the next song start. While the song
   * plays or is paused (as of the playhead at `time`, or the pause point):
   * - the block under the playhead lies in the new loop: playback goes on
   *   and, at the end of the loop's last block, continues at the start of
   *   its first block, again and again;
   * - it lies outside: playback continues at the loop's first block at the
   *   next bar line (in its place when the block has not sounded yet, right
   *   after Play or Resume);
   * - cleared: nothing changes until the loop's end would come; the song
   *   plays on from there to its end (a jump still waiting is dropped).
   * Replay and live playback do not use it. Returns true when playback
   * changed (the driver regenerates from `time`), as `replanSong`.
   */
  setSongLoop(loop: SongLoop | null, time: number): boolean {
    const next = loop ? { fromBlockId: loop.fromBlockId, toBlockId: loop.toBlockId } : null;
    if (sameSongLoop(next, this.loop)) return false;
    this.loop = next;
    return this.layoutSong(time, true);
  }

  /**
   * Lay out the song again from the block under the playhead (see
   * `replanSong`); `loopSet`: the loop was just set or changed, so a
   * playhead outside it jumps to it (see `setSongLoop`).
   */
  private layoutSong(time: number, loopSet: boolean): boolean {
    const song = this.song;
    const ps = this.pausedState;
    if (!song || this.replay || this._mode.kind !== 'song' || (!this._playing && !ps)) return false;
    const t = Number.isFinite(time) ? time : 0;
    // The playhead waits at its floor (the start or resume point) until that time comes.
    const floor = ps ? ps.tick : this.playheadFloor;
    const pos = ps ? ps.tick : Math.max(floor, this.clock.tickAt(t));
    if (this.endTick !== null && pos >= this.endTick) return false;
    this.extendSong(pos + TICKS_PER_BAR);
    const old = song.blocks;
    let ai = song.first;
    while (ai < old.length && old[ai].endTick <= pos) ai++;
    if (ai >= old.length) return false;
    const anchor = old[ai];
    // Its start was heard: it lies before the playhead's floor (also right after Resume, while the
    // playhead still waits at the pause point) or its time has passed. Else it can still start as edited.
    const started = anchor.startTick < floor || (!ps && this.clock.timeAt(anchor.startTick) < t);
    // Nothing before this tick changes: what already sounds stays.
    const from = started ? Math.ceil(pos) : anchor.startTick;

    const project = this.getProject();
    const plan = songBlocks(project);
    const order = new Map(plan.map((b, i) => [b.blockId, i]));
    const length = (b: SongBlockPlan): number => b.endTick - b.startTick;
    const range = songLoopRange(plan, this.loop);
    // The block that plays after lane block `i`: the next one, or the loop's first after its last.
    const after = (i: number): number => (range && i === range[1] ? range[0] : i + 1);
    // Old and new layouts are compared up to here: past one whole pass of either loop after the anchor.
    const horizon = anchor.endTick + 2 * TICKS_PER_BAR + Math.max(cycleTicks(song.cycle), range ? plan[range[1]].endTick - plan[range[0]].startTick : 0);
    this.extendSong(horizon);

    // The first block after the anchor (in the plan being played) that is still in the song; with
    // every one of them deleted (a whole loop), the first block after the loop that still is.
    let successor = plan.length;
    for (let i = ai + 1; i < old.length && successor === plan.length; i++) successor = order.get(old[i].blockId) ?? plan.length;
    for (let i = 0; i < song.after.length && successor === plan.length; i++) successor = order.get(song.after[i]) ?? plan.length;
    const at = order.get(anchor.blockId);
    // What plays: `kept` (the block under the playhead, null when the next block starts in its place),
    // after the history plan[0, cut) and before the rest: plan[next, …) in song order.
    let kept: SongEntry | null = null;
    let cut = successor;
    let next = successor;
    if (!started) {
      if (at !== undefined) kept = keepPlaying(project, anchor, plan[at], anchor.startTick + length(plan[at]), from);
    } else if (loopSet && (at === undefined || anchor.startTick + length(plan[at]) <= pos)) {
      // Setting the loop changes what follows, never the block the playhead is in: one deleted (or
      // shortened below the playhead) by an earlier edit sounds on to its bar line as it did.
      kept = { ...anchor, phases: anchor.phases.filter((ph) => ph.tick < from) };
    } else {
      const sounding = partsBefore(anchor, from);
      // The playhead's place on the edited lane (see above): the block laid out under it there, and its start.
      let under = successor;
      let start = anchor.startTick;
      for (let p = ai; p >= 0; p--) {
        const j = order.get(old[p].blockId);
        if (j !== undefined) {
          under = j;
          start = old[p].startTick;
          break;
        }
      }
      for (let guard = 0; under < plan.length && start + length(plan[under]) <= pos && guard < 100_000; guard++) {
        start += length(plan[under]);
        under = after(under);
      }
      if (under < plan.length && under === at && start === anchor.startTick) {
        // Still under the playhead: it plays on, its changed parts switch now.
        kept = keepPlaying(project, anchor, plan[at], anchor.startTick + length(plan[at]), from);
      } else if (under < plan.length && sounding && sameClips(project, sounding, partPlays(project, plan[under]))) {
        // Another block now covers the playhead with the same clips (also its own next pass in a loop
        // it was shortened in): continue in it, nothing switches.
        const b = plan[under];
        kept = { ...b, startTick: start, endTick: start + length(b), phases: [{ tick: start, parts: partPlays(project, b) }] };
      } else if (at !== undefined) {
        // Shortened below the playhead: it ends at the next bar line (its changed parts switch now).
        kept = keepPlaying(project, anchor, plan[at], nextBarTick(pos), from);
      } else {
        // Deleted: what it plays sounds on to the next bar line, where its successor takes over.
        kept = { ...anchor, index: -1, endTick: nextBarTick(pos), phases: anchor.phases.filter((ph) => ph.tick < from) };
      }
    }
    if (kept && kept.index >= 0) {
      cut = order.get(kept.blockId)!;
      next = after(cut);
    }

    // A jump to the loop: kept while it waits for its bar line; set when the loop was just set and the
    // block the lane shows at the playhead lies outside it.
    let jumpAt = range && song.jumpAt !== null && song.jumpAt > pos ? song.jumpAt : null;
    if (loopSet) {
      const shown = kept && kept.index >= 0 ? cut : next;
      jumpAt = range && (shown < range[0] || shown > range[1]) ? (started ? nextBarTick(pos) : anchor.startTick) : null;
    }
    if (range && jumpAt !== null) {
      if (!started || !kept) {
        // Not heard yet: the loop's first block starts in its place.
        kept = null;
        jumpAt = null;
        cut = range[0];
      } else {
        // It sounds on to the bar line (its changed parts switched as above), then the loop starts.
        const end = Math.min(kept.endTick, jumpAt);
        kept = { ...kept, endTick: end, phases: kept.phases.filter((ph, i) => i === 0 || ph.tick < end) };
      }
      next = range[0];
    }

    const history = plan.slice(0, cut);
    // With the loop ahead: up to its last block, then the loop again and again (laid out as playback gets there).
    const loops = range !== null && next <= range[1];
    const rest = loops ? plan.slice(next, range[1] + 1) : plan.slice(next);
    const restStart = kept ? kept.endTick : anchor.startTick;

    // History is drawn in the current order, ending where the kept block (or the rest) starts.
    const blocks: SongEntry[] = [];
    let tick = (kept ? kept.startTick : restStart) - history.reduce((n, b) => n + length(b), 0);
    for (const b of history) {
      blocks.push({ ...b, startTick: tick, endTick: tick + length(b), phases: [] });
      tick += length(b);
    }
    const first = blocks.length;
    if (kept) blocks.push(kept);
    tick = restStart;
    for (const b of rest) {
      const e = songEntry(project, b, tick);
      blocks.push(e);
      tick = e.endTick;
    }
    const cycle = loops ? plan.slice(range[0], range[1] + 1) : null;
    const cyc = { cycle, cycleNext: 0 };
    layCycles(project, blocks, cyc, horizon);
    // Every path above ends the song at or after the next bar line (at the playhead for a block not
    // heard yet); kept as a guard, since an end behind the playhead is never handed out. A loop has no end.
    const end = cycle ? null : Math.max(tick, started ? nextBarTick(pos) : pos);
    const afterLoop = cycle ? plan.slice(range![1] + 1).map((b) => b.blockId) : [];
    // History counts too, unless a loop repeats blocks there (nothing audible depends on it). A looping
    // plan is compared as far as both are laid out; one without a loop as a whole.
    const looped = cycle !== null || song.cycle !== null;
    const limit = looped ? horizon : Infinity;
    const oldJump = song.jumpAt !== null && song.jumpAt > pos ? song.jumpAt : null;
    const same =
      songKey(blocks, first, end, { skip: looped ? first : 0, limit, cycle, jumpAt }) ===
      songKey(old, ai, this.endTick, { skip: looped ? ai : 0, limit, cycle: song.cycle, jumpAt: oldJump });
    if (same) {
      song.after = afterLoop;
      return false;
    }

    // Song changes from `from` on are replaced: those waiting and those applied that a rewind would bring back.
    const stale = (tr: Transition): boolean => tr.source === 'song' && tr.atTick >= from;
    for (const rt of this.tracks.values()) {
      rt.pending = rt.pending.filter((tr) => !stale(tr));
      for (const h of rt.history) h.due = h.due.filter((tr) => !stale(tr));
    }
    song.blocks = blocks;
    song.first = first;
    song.cycle = cycle;
    song.cycleNext = cyc.cycleNext;
    song.after = afterLoop;
    song.jumpAt = jumpAt;
    if (kept) for (let i = 0; i < kept.phases.length; i++) if (kept.phases[i].tick >= from) this.insertSongPhase(kept, i, pos);
    for (let i = first + (kept ? 1 : 0); i < blocks.length; i++) this.insertSongPhase(blocks[i], 0, blocks[i].startTick - TICKS_PER_BAR);
    // Blocks already announced count as sent; a rewind (invalidate) recounts from its own point.
    song.next = this.songIndexFrom(ps ? ps.tick : this.cursor);
    this.endTick = end;
    return true;
  }

  /**
   * While the song loops: lay out passes of the loop after the last entry
   * until the plan reaches past `until` (their part changes go to the
   * launcher as at the start).
   */
  private extendSong(until: number): void {
    const song = this.song;
    if (!song?.cycle) return;
    const n = song.blocks.length;
    layCycles(this.getProject(), song.blocks, song, until);
    for (let i = n; i < song.blocks.length; i++) this.insertSongPhase(song.blocks[i], 0, song.blocks[i].startTick - TICKS_PER_BAR);
  }

  /**
   * While the song loops: forget entries that played before `floor` (a
   * rewind never goes back that far). The history before them is drawn
   * again right before what is left, so the plan stays one piece.
   */
  private pruneSong(floor: number): void {
    const song = this.song;
    if (!song?.cycle) return;
    let k = song.first;
    while (k + 1 < song.next && song.blocks[k].endTick < floor) k++;
    const n = k - song.first;
    if (n <= 0) return;
    const shift = song.first > 0 ? song.blocks[k].startTick - song.blocks[song.first - 1].endTick : 0;
    if (shift) {
      for (let i = 0; i < song.first; i++) {
        const e = song.blocks[i];
        song.blocks[i] = { ...e, startTick: e.startTick + shift, endTick: e.endTick + shift, phases: e.phases.map((ph) => ({ tick: ph.tick + shift, parts: ph.parts })) };
      }
    }
    song.blocks.splice(song.first, n);
    song.next -= n;
  }

  /**
   * The song on its timeline while it plays or is paused in song mode: every
   * block with absolute ticks (history first, in the current order, then the
   * block playing and what follows it), or null.
   */
  songPlan(): SongBlockPlan[] | null {
    const song = this.song;
    if (!song || (!this._playing && !this.pausedState)) return null;
    return song.blocks.map((b) => ({ index: b.index, blockId: b.blockId, row: b.row, parts: { ...b.parts }, bars: b.bars, repeats: b.repeats, startTick: b.startTick, endTick: b.endTick }));
  }

  /**
   * `songLaneTick` on the plan as it plays now (a looping song lays out its
   * next passes as it goes, so a copy taken earlier may end before `tick`).
   * Null when the song is not playing or paused.
   */
  songLaneTickAt(lane: readonly SongBlockPlan[], tick: number): number | null {
    const song = this.song;
    if (!song || (!this._playing && !this.pausedState) || !Number.isFinite(tick)) return null;
    return songLaneTick(song.blocks, lane, this.playedTick(song, tick));
  }

  /**
   * History is laid out again by every edit, in the lane's order, ending
   * where the block under the edit point starts; an edit made just before a
   * block (or loop pass) starts leaves the playhead there for a moment (the
   * edit point lies a little ahead of it). That moment counts as the start
   * of the block that plays first.
   */
  private playedTick(song: SongState, tick: number): number {
    const e = song.blocks[song.first];
    return e && tick < e.startTick ? e.startTick : tick;
  }

  /**
   * The song block at `tick` as the lane shows it: the block of the plan
   * containing it. While a block deleted as it played sounds on to the next
   * bar line, the block that takes over there. Null when the song is not
   * playing or paused, or when nothing follows (the song ends).
   */
  songBlockAt(tick: number): { index: number; blockId: Id } | null {
    const song = this.song;
    if (!song || (!this._playing && !this.pausedState) || !Number.isFinite(tick)) return null;
    const at = this.playedTick(song, tick);
    let i = song.blocks.findIndex((b) => at < b.endTick);
    if (i < 0) return null;
    while (i < song.blocks.length && song.blocks[i].index < 0) i++;
    const b = song.blocks[i];
    return b ? { index: b.index, blockId: b.blockId } : null;
  }

  /**
   * First song entry (not history) whose 'block' event falls at or after
   * `tick`: at its start, or at the transport start for the block a start
   * position falls in.
   */
  private songIndexFrom(tick: number): number {
    const song = this.song!;
    let i = song.first;
    while (i < song.blocks.length && Math.max(song.blocks[i].startTick, this.startTick) < tick) i++;
    return i;
  }

  /**
   * Song transitions for phase `i` of a block: every part at the block start;
   * at a later phase, the parts it switches, in phase with the block start.
   */
  private insertSongPhase(e: SongEntry, i: number, requestTick: number): void {
    const ph = e.phases[i];
    const prev = i > 0 ? e.phases[i - 1].parts : null;
    for (const [trackId, part] of Object.entries(ph.parts)) {
      if (prev && samePart(prev[trackId], part)) continue;
      const tr: Transition = { atTick: ph.tick, slot: null, row: part.row, source: 'song', seq: -(++this.transitionSeq), requestTick };
      if (i > 0) tr.loopStart = e.startTick;
      // Notes already sounding across the switch end there when it is applied (applyDue), so an edit undone before it leaves them alone.
      this.insertTransition(this.rt(trackId), tr);
    }
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
      // A looping song is laid out a bar past what is generated (pads show the next block's clips a bar ahead).
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
    const song = this.song;
    if (song && song.next < song.blocks.length) b = Math.min(b, song.blocks[song.next].startTick);
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
    const song = this.song;
    if (song) {
      while (song.next < song.blocks.length && song.blocks[song.next].startTick <= at) {
        const b = song.blocks[song.next++];
        this.push(out, { kind: 'block', tick: at, time: this.clock.timeAt(at), blockIndex: b.index, blockId: b.blockId, sceneRow: b.row });
      }
    }
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
        // just after a block start, re-applied by the rewind): what another clip still sounds ends here.
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

  private clipCandidates(track: Track, order: number, p: Playing, a: number, b: number, switchTick: number, mono: boolean, cands: Candidate[]): void {
    const clip = track.clips[p.slot];
    if (!clip) return;
    if (clip.id !== p.clipId) p.clipId = clip.id;
    const prep = prepareClip(clip, mono);
    if (!prep.notes.length) return;
    const len = prep.length;
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
    if (this.song) this.song.next = this.songIndexFrom(r);
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
