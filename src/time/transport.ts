/**
 * Real-time transport: drives the pure Sequencer against the audio clock.
 *
 * A Web Worker ticker (every `interval` ms) asks the sequencer for every
 * event up to `ctx.currentTime + lookahead` and schedules it on the engine.
 * The audio clock is the only timing authority: the ticker only decides
 * *when we look ahead*, never when anything sounds. UI events (launch, block,
 * end, beat, and arp notes for Record Notes) are held until the audio clock
 * reaches their time.
 *
 * Scheduling margin: 300 ms ahead normally, so the app's own main-thread
 * work (a view switch, a dialog) never makes a note late. When the main
 * thread was busy anyway (a tick arrives more than TICK_GAP_MS late, or the
 * browser reports a long animation frame over LONG_FRAME_MS), and whenever
 * the app knows heavy work is coming (`brace()`: audio start, opening a
 * project, a view or mode switch), it schedules a second ahead for a few
 * seconds. Edits still act at once: what was scheduled from their time on
 * is cancelled and regenerated.
 *
 * Falling behind: a note whose start has passed is dropped, never played
 * late. In a visible tab whose audio is running, a missed stretch is skipped
 * (Sequencer.skipTo: launches, song blocks and loop phases carry on in time,
 * a 'skipped' event tells how late it was) and playback goes on. Only a
 * hidden (throttled) tab or a suspended audio device stops playback
 * ('stalled'), coherently and without a backlog.
 *
 * Voice handles are kept from scheduling until the note's gate ends, so that
 * not-yet-started voices can be cancelled on invalidation, sounding ones can
 * be released early (clip switch cuts, mono overlaps) and Stop can release
 * everything gracefully. The count exposed as `pendingHandles` is the voices
 * that have not started yet.
 *
 * Invalidation (launch inside the look-ahead, tempo, swing, arp input,
 * edits) cancels at one time `from`: voices starting at/after it, engine
 * automation, pump ducks and clicks at/after it (the engine drops those in
 * `cancelScheduledAutomation`), and queued UI events; the sequencer then
 * regenerates exactly the events at/after `from`, which are sent again.
 *
 * Recorded mute and master-volume events use the engine's timed
 * `scheduleMute` / `scheduleMasterVolume`, so they are sample-accurate live
 * and in exports, and cancellable like other automation.
 */
import type { AudioEngineApi, NoteTrigger, VoiceHandle } from '../audio/contracts';
import { PPQ, type Id, type Project } from '../project/types';
import { clampBpm } from './clock';
import type { ClipPhase, LaunchResult, SeqEvent, SongLoop, StartOptions } from './contracts';
import type { BeatEvent, NoteCut, NoteEvent, SeqPosition, Sequencer } from './sequencer';
import { TICKER_WORKER_SOURCE } from './tickerWorker';

/** Seconds scheduled ahead of the audio clock (raised for a while by `brace()`). */
export const DEFAULT_LOOKAHEAD = 0.3;
export const DEFAULT_INTERVAL = 25;
/**
 * In a hidden tab or with the audio device suspended, the ticker may fall
 * this far behind its scheduled horizon before playback stops ('stalled').
 * A visible tab whose audio runs never stops for being late: it skips.
 */
export const STALL_THRESHOLD = 0.25;
/** Scheduling margin while braced (seconds) and for how long a brace lasts (ms). */
export const BRACE_AHEAD = 1;
export const BRACE_MS = 3000;
/** A tick arriving this much later than the one before it (ms) means the main thread was busy: brace. */
export const TICK_GAP_MS = 60;
/** A long animation frame longer than this (ms, where the browser reports them) braces too. */
export const LONG_FRAME_MS = 80;
/** Notes whose start time passed more than this long ago (seconds) are dropped, never played late. */
export const LATE_TOLERANCE = 0.01;
/** Song moves: a song-gain value is reached by gliding over this long (seconds) before its time. */
export const MOVE_GLIDE = 0.005;
/** Play starts this far after the gesture so the first events can be scheduled in time. */
export const START_OFFSET = 0.05;
/** Live changes (tempo, swing, arp input, invalidate) take effect this far ahead of `currentTime`. */
export const INVALIDATE_MARGIN = 0.01;

/* ------------------------------------------------------------------ */
/* Event dispatch (shared with the offline renderer)                   */
/* ------------------------------------------------------------------ */

export interface DispatcherOptions {
  engine: AudioEngineApi;
  /** Project whose channel levels an unmute restores (the one being played). */
  getProject: () => Project;
  /** Regular beats click while this returns true. */
  metronome: () => boolean;
  /** Count-in beats click (live playback; exports never click). */
  countInClicks: boolean;
  /** Run `fn` when the audio clock reaches `time`. */
  at: (time: number, fn: () => void) => void;
  /** launch / block / end / beat events, for the UI or the driver. */
  onEvent: (e: SeqEvent) => void;
  /** Every note sent to the engine (after it is scheduled). */
  onNote?: (e: NoteEvent) => void;
  /**
   * Live playback: notes (and metronome clicks, pump ducks) timed before
   * this are dropped, never played late. Default: none (offline renders).
   */
  lateBefore?: () => number;
  /** A song-move song-gain event went to the engine. */
  onSongGain?: () => void;
}

/** An engine that can say its own output latency (AudioEngine.outputLatencyFrames; optional in AudioEngineApi). */
export interface EngineLatency {
  outputLatencyFrames?: () => number;
}

/**
 * Seconds from an event's audio-clock time to when it is heard: the
 * device's output latency and the context's base latency plus the engine's
 * own (its limiter look-ahead and the module latency every audible part has,
 * AudioEngineApi.outputLatencyFrames). Record Notes, audio input and the
 * visual playheads all use it.
 */
export function outputDelaySeconds(ctx: BaseAudioContext, engine?: EngineLatency | null): number {
  const c = ctx as BaseAudioContext & { outputLatency?: number; baseLatency?: number };
  const frames = engine?.outputLatencyFrames?.() ?? 0;
  const out = Number.isFinite(c.outputLatency) ? (c.outputLatency as number) : 0;
  const base = Number.isFinite(c.baseLatency) ? (c.baseLatency as number) : 0;
  return Math.max(0, out) + Math.max(0, base) + (ctx.sampleRate > 0 && Number.isFinite(frames) ? Math.max(0, frames) / ctx.sampleRate : 0);
}

interface HeldVoice {
  handle: VoiceHandle;
  trackId: Id;
  /** Event time (the sequencer's clock). */
  time: number;
  /** Scheduled end of the gate. */
  end: number;
}

/**
 * Sends sequencer events to an engine and keeps the voice handles it gets back.
 *
 * Every event is sent as it comes: the sequencer hands out each event once,
 * and after `invalidate(fromTime)` regenerates exactly the events at or after
 * `fromTime`, which the driver has cancelled first (voices via `cancelFrom`,
 * automation, pump ducks and clicks via `engine.cancelScheduledAutomation`).
 */
export class EngineDispatcher {
  private readonly voices = new Map<NoteEvent, HeldVoice>();
  /** Notes dropped because their start had already passed (see DispatcherOptions.lateBefore). */
  droppedLate = 0;

  constructor(private readonly o: DispatcherOptions) {}

  /** Handles currently held. */
  get size(): number {
    return this.voices.size;
  }

  /** True while the note's voice is held: scheduled and not cancelled (it may have started). */
  holds(note: NoteEvent): boolean {
    return this.voices.has(note);
  }

  counts(now: number): { pending: number; sounding: number } {
    let pending = 0;
    for (const v of this.voices.values()) if (v.handle.startTime > now) pending++;
    return { pending, sounding: this.voices.size - pending };
  }

  dispatch(events: readonly SeqEvent[]): void {
    const engine = this.o.engine;
    const late = this.o.lateBefore ? this.o.lateBefore() : -Infinity;
    for (const ev of events) {
      switch (ev.kind) {
        case 'note': {
          // Its time has passed (the main thread was busy): it is dropped, never played late.
          if (ev.time < late) {
            this.droppedLate++;
            break;
          }
          const trigger: NoteTrigger = { pitch: ev.pitch, velocity: ev.velocity, time: ev.time, duration: ev.duration, legato: ev.legato };
          if (ev.sample) trigger.sample = ev.sample;
          const h = engine.scheduleNote(ev.trackId, trigger);
          if (h) this.voices.set(ev, { handle: h, trackId: ev.trackId, time: ev.time, end: ev.time + ev.duration });
          this.o.onNote?.(ev);
          break;
        }
        case 'beat':
          // A beat regenerated after an invalidation replaces the duck/click the engine dropped.
          if (ev.time >= late) {
            if (!ev.countIn) engine.schedulePump(ev.time, ev.beatSeconds, Math.round(ev.tick / PPQ));
            if (ev.countIn ? this.o.countInClicks : this.o.metronome()) engine.scheduleClick(ev.time, ev.beat === 0);
          }
          this.o.onEvent(ev);
          break;
        case 'songGain':
          if (!engine.scheduleSongGain) break;
          // Reach `from` at `time` (a short glide just before it), then ramp to `value`.
          engine.scheduleSongGain(ev.from, ev.time - MOVE_GLIDE);
          if (ev.endTime > ev.time) engine.scheduleSongGain(ev.value, ev.time, ev.endTime);
          this.o.onSongGain?.();
          break;
        case 'macroRamp':
          // A set (no span) is a very short ramp, so it lands at its time.
          engine.scheduleMacroRamp?.(ev.trackId, ev.macro, ev.from, ev.value, ev.time, ev.endTime > ev.time ? ev.endTime : ev.time + MOVE_GLIDE);
          break;
        case 'param':
          engine.scheduleParam(ev.module, ev.param, ev.value, ev.time);
          break;
        case 'macro':
          engine.scheduleMacro(ev.trackId, ev.macro, ev.value, ev.time);
          break;
        case 'mute':
          engine.scheduleMute(ev.trackId, ev.mute, ev.time);
          break;
        case 'master':
          engine.scheduleMasterVolume(ev.volumeDb, ev.time);
          break;
        case 'tempo':
          engine.tempoChanged(ev.bpm, ev.time);
          break;
        case 'swing':
          // Swing is already part of every note time; no engine module depends on it.
          break;
        case 'launch':
        case 'block':
        case 'end':
          this.o.onEvent(ev);
          break;
      }
    }
  }

  /** Release (or, before they start, cancel) voices the sequencer shortened after handing them out. */
  applyCuts(cuts: readonly NoteCut[], now: number): void {
    for (const cut of cuts) {
      const v = this.voices.get(cut.note);
      if (!v) continue;
      if (cut.time <= v.time && v.handle.startTime > now) {
        v.handle.cancel();
        this.voices.delete(cut.note);
        continue;
      }
      v.handle.release(Math.max(cut.time, now));
      v.end = Math.min(v.end, cut.time);
    }
  }

  /**
   * Schedule again, with the instrument's settings as they are now, the
   * voices of `tracks` whose event time is at or after `from` (not started
   * yet): same notes, same lengths (cuts included), in time order. A voice
   * the engine declines now is forgotten. Returns how many were scheduled.
   */
  revoice(tracks: ReadonlySet<Id>, from: number): number {
    const redo: [NoteEvent, HeldVoice][] = [];
    for (const entry of this.voices) if (tracks.has(entry[1].trackId) && entry[1].time >= from) redo.push(entry);
    if (!redo.length) return 0;
    // All cancelled first, then scheduled again in order, as an invalidation does (a mono part's
    // notes cut and glide from one another in the order they are scheduled).
    for (const [, v] of redo) v.handle.cancel();
    redo.sort((a, b) => a[1].time - b[1].time);
    let n = 0;
    for (const [ev, v] of redo) {
      const trigger: NoteTrigger = { pitch: ev.pitch, velocity: ev.velocity, time: ev.time, duration: Math.max(0, v.end - ev.time), legato: ev.legato };
      if (ev.sample) trigger.sample = ev.sample;
      const h = this.o.engine.scheduleNote(ev.trackId, trigger);
      if (h) {
        v.handle = h;
        n++;
      } else this.voices.delete(ev);
    }
    return n;
  }

  /** Cancel voices whose event time is at or after `time` (not started yet). */
  cancelFrom(time: number): void {
    for (const [ev, v] of this.voices) {
      if (v.time >= time) {
        v.handle.cancel();
        this.voices.delete(ev);
      }
    }
  }

  /** Stop: cancel voices that have not started, release the sounding ones at `now`. */
  releaseAll(now: number): void {
    for (const v of this.voices.values()) {
      if (v.handle.startTime > now) v.handle.cancel();
      else v.handle.release(now);
    }
    this.voices.clear();
  }

  /** Forget voices whose gate has ended (their release is already scheduled). */
  prune(now: number): void {
    for (const [ev, v] of this.voices) if (v.handle.ended || v.end < now) this.voices.delete(ev);
  }
}

/* ------------------------------------------------------------------ */
/* Realtime transport                                                  */
/* ------------------------------------------------------------------ */

export interface TransportEventMap {
  launch: Extract<SeqEvent, { kind: 'launch' }>;
  block: Extract<SeqEvent, { kind: 'block' }>;
  end: Extract<SeqEvent, { kind: 'end' }>;
  beat: BeatEvent;
  /**
   * An arpeggiator note starts sounding now (on the transport, not the idle
   * clock). Notes cancelled before their time (new keys, Stop) never arrive.
   */
  arpNote: NoteEvent;
  /** The audio context changed state (e.g. suspended / interrupted while playing). */
  state: { state: string; playing: boolean };
  /**
   * Playback stopped because the scheduler fell behind in a hidden
   * (throttled) tab ('throttled') or with the audio device suspended
   * ('suspended'); offer Resume. `songBlockId`: in song mode, the block where
   * the music stopped (the block taking over when the playing one had just
   * been deleted), found before the stop cleared the song; else null.
   */
  stalled: { reason: 'throttled' | 'suspended'; lateBy: number; tick: number; songBlockId: Id | null };
  /**
   * The main thread was busy for longer than the scheduling margin in a
   * visible tab: the missed stretch (`lateBy` seconds) was skipped, notes in
   * it were left out (sent only when there were some), and playback goes on
   * in time from `tick`. Nothing stops (a performance take goes on too).
   */
  skipped: { lateBy: number; tick: number };
}

export type TransportEventName = keyof TransportEventMap;

export interface RealtimeTransportOptions {
  ctx: BaseAudioContext;
  engine: AudioEngineApi;
  sequencer: Sequencer;
  /** Seconds scheduled ahead of the audio clock (default DEFAULT_LOOKAHEAD). */
  lookahead?: number;
  /** Ticker period in ms (default 25). */
  interval?: number;
  /** Whether the page is hidden (a background tab). Default: document.visibilityState. */
  isHidden?: () => boolean;
  /** Wall clock in ms for tick gaps and braces. Default: performance.now. */
  wallClock?: () => number;
}

export interface TransportStats {
  /** Voices scheduled that have not started yet. */
  pendingHandles: number;
  /** Voices started whose gate has not ended (kept for cuts and Stop). */
  soundingHandles: number;
  listeners: number;
  tickerRunning: boolean;
  /** UI events / timed actions waiting for their audio time. */
  queuedEvents: number;
  /** Seconds scheduled ahead of the audio clock now (more while braced or held). */
  ahead: number;
  /** Notes dropped because their time had passed when they were generated (never played late). */
  lateDropped: number;
  /** Missed stretches skipped since the transport was made. */
  skips: number;
}

export interface TransportPosition extends SeqPosition {
  playing: boolean;
  /** Holding at a pause (the position is where it paused). */
  paused: boolean;
}

interface Timed {
  time: number;
  run: () => void;
}

function report(err: unknown): void {
  const g = globalThis as { reportError?: (e: unknown) => void };
  if (typeof g.reportError === 'function') g.reportError(err);
  else console.error(err);
}

export class RealtimeTransport {
  readonly ctx: BaseAudioContext;
  readonly engine: AudioEngineApi;
  readonly sequencer: Sequencer;
  readonly lookahead: number;
  readonly interval: number;

  private readonly dispatcher: EngineDispatcher;
  private readonly listeners = new Map<TransportEventName, Set<(payload: unknown) => void>>();
  private queue: Timed[] = [];
  /** How far ahead of the audio clock events are scheduled now (`lookahead`, or more while held or braced). */
  private ahead: number;
  /** Margin asked for by holdAhead (an export), or null. */
  private held: number | null = null;
  /** Margin asked for by brace() and until when (wall clock ms). */
  private braceAhead = 0;
  private braceUntil = 0;
  /** Audio time up to which events were handed to the engine (and not cancelled). */
  private horizon = 0;
  private stallUntil = 0;
  /** simulateStall: the tab counts as hidden until the stall has been noticed. */
  private simulatedHidden = false;
  /** Wall-clock time of the last tick (0: the ticker just started). */
  private lastTickAt = 0;
  private skips = 0;
  /** Song moves moved the song gain since playback started or resumed. */
  private songGainMoved = false;
  /**
   * Stopped or paused with the song gain where song moves left it (a
   * fade-out's tail stays faded): the next live sound brings it back to
   * unity (restoreSongGain), as the next start does (the engine).
   */
  private songGainHeld = false;
  private longFrames: PerformanceObserver | null = null;
  private readonly isHidden: () => boolean;
  private readonly wall: () => number;
  private lastState: string | undefined;
  private disposed = false;

  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private workerFailed = false;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private tickerRunning = false;

  constructor(opts: RealtimeTransportOptions) {
    this.ctx = opts.ctx;
    this.engine = opts.engine;
    this.sequencer = opts.sequencer;
    this.lookahead = opts.lookahead ?? DEFAULT_LOOKAHEAD;
    this.ahead = this.lookahead;
    this.interval = opts.interval ?? DEFAULT_INTERVAL;
    this.isHidden = opts.isHidden ?? (() => (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden');
    this.wall = opts.wallClock ?? (() => performance.now());
    const seq = this.sequencer;
    this.dispatcher = new EngineDispatcher({
      engine: this.engine,
      getProject: () => seq.activeProject(),
      metronome: () => seq.liveProject().settings.metronome,
      countInClicks: true,
      at: (time, fn) => this.enqueue(time, fn),
      onEvent: (e) => this.enqueue(e.time, () => this.deliver(e)),
      onNote: (e) => {
        if (e.source !== 'arp' || !seq.playing || !this.listeners.get('arpNote')?.size) return;
        // Delivered when it sounds, and only if its voice was not cancelled meanwhile.
        this.enqueue(e.time, () => {
          if (this.dispatcher.holds(e)) this.emit('arpNote', e);
        });
      },
      lateBefore: () => this.ctx.currentTime - LATE_TOLERANCE,
      onSongGain: () => {
        this.songGainMoved = true;
      },
    });
    this.lastState = this.ctx.state;
    this.ctx.addEventListener('statechange', this.onStateChange);
    this.watchLongFrames();
  }

  get playing(): boolean {
    return this.sequencer.playing;
  }

  /* ---------------------------------------------------------------- */
  /* Transport control                                                 */
  /* ---------------------------------------------------------------- */

  start(opts: StartOptions = {}): void {
    this.assertAlive();
    const mode = opts.mode;
    // Fail before anything is stopped or released: a bad request leaves playback as it was.
    if (mode?.kind === 'replay' && !this.sequencer.liveProject().performances.some((p) => p.id === mode.performanceId)) {
      throw new Error(`Performance "${mode.performanceId}" not found`);
    }
    const now = this.ctx.currentTime;
    if (this.sequencer.playing) {
      this.dispatcher.releaseAll(now);
      this.engine.transportStopped(now);
    }
    // Not-yet-started notes of the idle arpeggiator belong to its free clock.
    this.dispatcher.cancelFrom(now);
    this.queue = [];
    const t = now + START_OFFSET;
    this.sequencer.start(t, opts);
    this.engine.transportStarted(t, this.sequencer.tickAt(t), this.sequencer.bpm);
    // The engine returns the song gain to unity for a new playback.
    this.songGainMoved = false;
    this.songGainHeld = false;
    // Integrated loudness and true peak measure this playback: every start (a replay of a take
    // recorded mid-song, the song from a later block) begins a new measurement; resume() keeps counting.
    this.engine.resetLoudness?.();
    this.horizon = now;
    this.schedule(now);
    this.ensureTicker();
  }

  stop(): void {
    if (this.disposed) return;
    this.stopAt(this.ctx.currentTime);
  }

  /** Paused: holding its position and every clip's phase (see Sequencer.pause). */
  get paused(): boolean {
    return this.sequencer.paused;
  }

  /**
   * Pause now: every voice is released (not-yet-started ones cancelled), the
   * engine's clicks, pump ducks and automation end as at Stop, and the
   * sequencer holds its position for `resume()`. Returns false when nothing
   * was playing; when the music had already reached its end it stops instead
   * (also false).
   */
  pause(): boolean {
    this.assertAlive();
    if (!this.sequencer.playing) return false;
    const now = this.ctx.currentTime;
    if (!this.sequencer.pause(now)) {
      this.stopAt(now);
      return false;
    }
    this.dispatcher.releaseAll(now);
    this.engine.transportStopped(now);
    this.holdSongGain();
    this.queue = [];
    this.horizon = now;
    this.ensureTicker();
    return true;
  }

  /**
   * Continue from the pause, in time: the paused tick plays `START_OFFSET`
   * from now (like Play), every clip in its phase, with nothing from before
   * the pause played late. Returns false when not paused.
   */
  resume(): boolean {
    this.assertAlive();
    if (!this.sequencer.paused) return false;
    const now = this.ctx.currentTime;
    // Not-yet-started notes of the idle arpeggiator (keys pressed while paused) belong to its free clock.
    this.dispatcher.cancelFrom(now);
    this.queue = [];
    const t = now + START_OFFSET;
    this.sequencer.resume(t);
    // The engine glides the song gain back to unity; song moves send the value a fade had reached (moveSync).
    this.engine.transportStarted(t, this.sequencer.tickAt(t), this.sequencer.bpm);
    this.songGainMoved = false;
    this.songGainHeld = false;
    this.horizon = now;
    this.schedule(now);
    this.ensureTicker();
    return true;
  }

  private stopAt(now: number): void {
    const wasPlaying = this.sequencer.playing;
    this.sequencer.stop(now);
    if (wasPlaying) {
      this.dispatcher.releaseAll(now);
      this.engine.transportStopped(now);
      this.holdSongGain();
    } else {
      // Already stopped: Stop only drops a latched arpeggio. The idle arp's
      // look-ahead is regenerated from now, so keys still held play on
      // without a gap and latched-only notes stop.
      this.dispatcher.cancelFrom(now);
      this.sequencer.invalidate(now);
    }
    this.queue = [];
    this.horizon = now;
    // Keys still held keep an arpeggio going on the idle clock.
    if (this.sequencer.idleActive) this.schedule(now);
    this.ensureTicker();
  }

  launchClip(trackId: Id, slot: number): LaunchResult {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const r = this.sequencer.launchClip(trackId, slot, now);
    this.afterRequests([r], now);
    return r;
  }

  launchScene(row: number): LaunchResult[] {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const rs = this.sequencer.launchScene(row, now);
    this.afterRequests(rs, now);
    return rs;
  }

  stopTrack(trackId: Id): LaunchResult {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const r = this.sequencer.stopTrack(trackId, now);
    this.afterRequests([r], now);
    return r;
  }

  stopAll(): LaunchResult[] {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const rs = this.sequencer.stopAll(now);
    this.afterRequests(rs, now);
    return rs;
  }

  /** A switch that falls inside the already-scheduled window is made exact by regenerating from it. */
  private afterRequests(results: readonly LaunchResult[], now: number): void {
    if (!this.sequencer.playing) return;
    let from = Infinity;
    for (const r of results) if (r.atTick < this.sequencer.generatedTick) from = Math.min(from, r.atTime);
    if (from < Infinity) this.invalidateFrom(Math.max(from, now), now);
    this.dispatcher.applyCuts(this.sequencer.takeCuts(), now);
  }

  /** Clips moved between a part's slots: the launcher follows (see Sequencer.relocateSlots). */
  relocateSlots(trackId: Id, slots: ReadonlyMap<number, number | null>): void {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const at = now + INVALIDATE_MARGIN;
    if (!this.sequencer.relocateSlots(trackId, slots, at)) return;
    if (this.sequencer.playing) this.invalidateFrom(at, now);
  }

  /** Scene rows were reordered: a playing song keeps its scenes (see Sequencer.relocateSongRows). */
  relocateSongRows(rows: ReadonlyMap<number, number>): void {
    this.assertAlive();
    const now = this.ctx.currentTime;
    if (this.sequencer.relocateSongRows(rows) && this.sequencer.playing) this.invalidateFrom(now + INVALIDATE_MARGIN, now);
  }

  /**
   * The song was edited while it plays or is paused: lay out the rest of it
   * again from the block playing now (see Sequencer.replanSong) and
   * regenerate what was scheduled from then on. `loop`: the song loop as the
   * edit left it (taken without a jump). Returns true when playback changed.
   */
  replanSong(loop?: SongLoop | null): boolean {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const at = now + INVALIDATE_MARGIN;
    if (!this.sequencer.replanSong(at, loop)) return false;
    if (this.sequencer.playing) this.invalidateFrom(at, now);
    return true;
  }

  /**
   * Loop part of the song, or play it through (null); see
   * Sequencer.setSongLoop. Stopped, it applies to the next song start.
   * Returns true when playback changed (what was scheduled is regenerated).
   */
  setSongLoop(loop: SongLoop | null): boolean {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const at = now + INVALIDATE_MARGIN;
    if (!this.sequencer.setSongLoop(loop, at)) return false;
    if (this.sequencer.playing) this.invalidateFrom(at, now);
    return true;
  }

  /**
   * Schedule `seconds` ahead of the audio clock instead of the usual
   * look-ahead (null: back to it), while the main thread will be busy for a
   * while (an export preparing and rendering): playback goes on through a
   * block up to about that long, and only a longer one stops it (the stall
   * policy). Edits, launches, Pause and Stop still act at once: what was
   * scheduled from their time on is cancelled or regenerated.
   */
  holdAhead(seconds: number | null): void {
    if (this.disposed) return;
    this.held = seconds === null || !Number.isFinite(seconds) ? null : seconds;
    this.updateAhead();
    if (this.sequencer.playing) this.schedule(this.ctx.currentTime);
  }

  /**
   * Heavy main-thread work is coming (or just happened): schedule `seconds`
   * ahead (default BRACE_AHEAD) for the next `forMs` milliseconds (default
   * BRACE_MS), so a block of up to about that long passes without a late or
   * skipped note. Scheduling ahead happens now, before the work starts.
   * Edits, launches, Pause and Stop still act at once.
   */
  brace(seconds: number = BRACE_AHEAD, forMs: number = BRACE_MS): void {
    if (this.disposed || !Number.isFinite(seconds) || !Number.isFinite(forMs)) return;
    this.extendBrace(seconds, forMs);
    // A simulated stall (simulateStall) schedules nothing until it ends, as a frozen tab would not.
    if (this.sequencer.playing && !this.stalling()) this.schedule(this.ctx.currentTime);
  }

  /** Inside a simulated stall (simulateStall): ticks are ignored until it ends. */
  private stalling(): boolean {
    return this.stallUntil !== 0 && this.wall() < this.stallUntil;
  }

  /** Raise the margin to `seconds` for `forMs` (the next schedule uses it). */
  private extendBrace(seconds: number, forMs: number): void {
    const now = this.wall();
    const active = now < this.braceUntil;
    this.braceAhead = Math.max(Math.max(0, seconds), active ? this.braceAhead : 0);
    this.braceUntil = Math.max(this.braceUntil, now + Math.max(0, forMs));
    this.updateAhead();
  }

  /** The current margin: the look-ahead, or more while an export holds it or a brace lasts. */
  private updateAhead(): void {
    const braced = this.wall() < this.braceUntil ? this.braceAhead : 0;
    this.ahead = Math.max(this.lookahead, this.held ?? 0, braced);
  }

  /**
   * Live sound is about to play while the transport is stopped or paused
   * (a key, a preview): a song gain that song moves left away from unity (a
   * fade-out's end, a pause inside a fade) comes back to it at once, so the
   * sound is heard at its level. Nothing changes while playing, or when the
   * gain was not moved. A resume sends the value the fade had reached again.
   */
  restoreSongGain(): void {
    if (this.disposed || this.sequencer.playing || !this.songGainHeld) return;
    this.songGainHeld = false;
    this.engine.scheduleSongGain?.(1, this.ctx.currentTime);
  }

  /**
   * Stop or Pause: the engine holds the song gain where it is (effect tails
   * of a faded ending stay faded) until the next start or live sound.
   */
  private holdSongGain(): void {
    if (this.songGainMoved) this.songGainHeld = true;
    this.songGainMoved = false;
  }

  setTempo(bpm: number): void {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const at = now + INVALIDATE_MARGIN;
    this.sequencer.setTempo(bpm, at);
    this.engine.tempoChanged(clampBpm(bpm), at);
    if (this.sequencer.playing || this.sequencer.idleActive) this.invalidateFrom(at, now);
  }

  setSwing(swing: number): void {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const at = now + INVALIDATE_MARGIN;
    this.sequencer.setSwing(swing, at);
    if (this.sequencer.playing) this.invalidateFrom(at, now);
  }

  /** Arpeggiator input for a track (pitches in the order played, already scale-snapped). */
  setArpHeld(trackId: Id, pitches: readonly number[], velocity?: number): void {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const at = now + INVALIDATE_MARGIN;
    // The input changes exactly where regeneration starts; with an earlier
    // change time, a first arp step falling between the two would be lost.
    this.sequencer.setArpHeld(trackId, pitches, at, velocity);
    if (this.sequencer.playing || this.sequencer.idleActive) {
      if (this.horizon < now) this.horizon = now;
      this.invalidateFrom(at, now);
    }
    this.ensureTicker();
  }

  /** A track's arpeggiator or its Latch was switched off: the latched notes end (keys still held play on). */
  clearArpLatch(trackId: Id): void {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const at = now + INVALIDATE_MARGIN;
    if (!this.sequencer.clearArpLatch(trackId, at)) return;
    if (this.sequencer.playing || this.sequencer.idleActive) {
      if (this.horizon < now) this.horizon = now;
      this.invalidateFrom(at, now);
    }
    this.ensureTicker();
  }

  /**
   * Parts whose sound changed (instrument settings, kit, preset, a big knob
   * mapped onto the instrument): what is scheduled for them and has not
   * started is scheduled again with the new sound, so the next note is heard
   * as edited however far ahead it was scheduled (a brace schedules a second
   * ahead). The notes stay the same; nothing else is regenerated. Returns how
   * many voices were scheduled again.
   */
  revoice(trackIds: Iterable<Id>): number {
    if (this.disposed) return 0;
    const tracks = new Set(trackIds);
    if (!tracks.size) return 0;
    return this.dispatcher.revoice(tracks, this.ctx.currentTime + INVALIDATE_MARGIN);
  }

  /** Regenerate everything not yet started (after edits that change upcoming events). */
  invalidate(): void {
    this.assertAlive();
    const now = this.ctx.currentTime;
    if (this.sequencer.playing || this.sequencer.idleActive) this.invalidateFrom(now + INVALIDATE_MARGIN, now);
  }

  private invalidateFrom(fromTime: number, now: number): void {
    this.dispatcher.cancelFrom(fromTime);
    this.engine.cancelScheduledAutomation(fromTime);
    this.queue = this.queue.filter((q) => q.time < fromTime);
    this.sequencer.invalidate(fromTime);
    // What was handed out from `fromTime` on is gone: it is generated again below. Only the usual
    // look-ahead at once, so an edit made while braced stays quick; the next tick schedules the rest.
    this.horizon = Math.min(this.horizon, fromTime);
    this.schedule(now, this.lookahead);
  }

  getPosition(): TransportPosition {
    return { ...this.sequencer.getPosition(this.ctx.currentTime), playing: this.sequencer.playing, paused: this.sequencer.paused };
  }

  /**
   * The position you hear now: the playhead at the audio clock minus the
   * output delay (outputDelaySeconds: the device's output and base latency
   * and the engine's own), so a lit step or a progress bar matches the sound.
   * It waits at the start (or resume) point until the sound gets there. Use
   * it for every visual playhead; getPosition() stays what is scheduled now.
   */
  getAudiblePosition(): TransportPosition {
    return { ...this.sequencer.getPosition(this.audibleTime()), playing: this.sequencer.playing, paused: this.sequencer.paused };
  }

  /** The tick of getAudiblePosition(), without allocating (for animation-frame loops). */
  audibleTick(): number {
    return this.sequencer.playheadTick(this.audibleTime());
  }

  /** Audio-clock time of what is heard now (never below 0). */
  audibleTime(): number {
    return Math.max(0, this.ctx.currentTime - this.outputDelay());
  }

  private delayCache = 0;
  private delayAt = -Infinity;

  /** outputDelaySeconds for this transport's context and engine (looked up again twice a second). */
  outputDelay(): number {
    const now = this.wall();
    if (now - this.delayAt > 500 || now < this.delayAt) {
      this.delayAt = now;
      this.delayCache = outputDelaySeconds(this.ctx, this.engine as AudioEngineApi & EngineLatency);
    }
    return this.delayCache;
  }

  /**
   * The clip part `trackId` sounds now (at the audible position, in live,
   * song and replay playback; while paused, the clip holding at the pause),
   * with its loop start and length: its progress is
   * ((audibleTick() − startTick) mod lengthTicks) / lengthTicks. Null while
   * stopped or when the part is silent. Pass `out` to read without
   * allocating (in animation-frame loops).
   */
  clipPhase(trackId: Id, out?: ClipPhase): ClipPhase | null {
    if (!this.sequencer.playing && !this.sequencer.paused) return null;
    return this.sequencer.clipPhaseAt(trackId, this.audibleTick(), out ?? { slot: 0, startTick: 0, lengthTicks: 0 });
  }

  /**
   * The tick at which part `trackId`'s queued change of clip lands (a pad
   * launch or stop, the next song block switching it), as heard now; null
   * when nothing is queued or the transport is stopped. Allocation-free.
   */
  queuedAt(trackId: Id): number | null {
    if (!this.sequencer.playing && !this.sequencer.paused) return null;
    return this.sequencer.queuedAtTick(trackId, this.audibleTick());
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  on<K extends TransportEventName>(event: K, cb: (payload: TransportEventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const fn = cb as (payload: unknown) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  private emit<K extends TransportEventName>(event: K, payload: TransportEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        report(err);
      }
    }
  }

  private deliver(e: SeqEvent): void {
    switch (e.kind) {
      case 'launch':
        this.emit('launch', e);
        break;
      case 'block':
        this.emit('block', e);
        break;
      case 'beat':
        this.emit('beat', e);
        break;
      case 'end':
        this.emit('end', e);
        // The song / performance is over: stop so the UI and voices settle.
        if (this.sequencer.playing) this.stopAt(this.ctx.currentTime);
        break;
      default:
        break;
    }
  }

  private enqueue(time: number, run: () => void): void {
    const q = this.queue;
    let i = q.length;
    while (i > 0 && q[i - 1].time > time) i--;
    q.splice(i, 0, { time, run });
  }

  private flush(now: number): void {
    while (this.queue.length && this.queue[0].time <= now) {
      const item = this.queue.shift()!;
      try {
        item.run();
      } catch (err) {
        report(err);
      }
    }
  }

  getStats(): TransportStats {
    const c = this.dispatcher.counts(this.ctx.currentTime);
    let listeners = 0;
    for (const s of this.listeners.values()) listeners += s.size;
    return {
      pendingHandles: c.pending,
      soundingHandles: c.sounding,
      listeners,
      tickerRunning: this.tickerRunning,
      queuedEvents: this.queue.length,
      ahead: this.ahead,
      lateDropped: this.dispatcher.droppedLate,
      skips: this.skips,
    };
  }

  /**
   * Test hook: ignore ticks for `ms` milliseconds, as a throttled background
   * tab scheduling with the usual look-ahead would (the tab counts as hidden
   * until the stall is noticed, so a stall longer than the look-ahead plus
   * STALL_THRESHOLD stops playback). `{ hidden: false }`: as a busy main
   * thread in a visible tab would (playback skips the missed stretch and
   * goes on).
   */
  simulateStall(ms: number, opts: { hidden?: boolean } = {}): void {
    this.stallUntil = this.wall() + Math.max(0, ms);
    this.simulatedHidden = opts.hidden !== false;
    if (!this.simulatedHidden) return;
    // As a tab scheduling with the usual look-ahead (no brace in force) would: what lies further ahead is not counted.
    this.braceUntil = 0;
    this.braceAhead = 0;
    this.updateAhead();
    this.horizon = Math.min(this.horizon, this.ctx.currentTime + this.lookahead);
  }

  dispose(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.stopAt(now);
    // Stop leaves an idle arpeggio (keys still held) scheduled; nothing may outlive the transport.
    this.dispatcher.releaseAll(now);
    this.disposed = true;
    this.stopTicker();
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    this.listeners.clear();
    this.queue = [];
    this.ctx.removeEventListener('statechange', this.onStateChange);
    this.longFrames?.disconnect();
    this.longFrames = null;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('RealtimeTransport has been disposed');
  }

  /* ---------------------------------------------------------------- */
  /* Scheduling loop                                                   */
  /* ---------------------------------------------------------------- */

  /** Hand out everything up to `now + ahead` (`ahead`: the current margin by default). */
  private schedule(now: number, ahead: number = this.ahead): void {
    if (!this.sequencer.playing && !this.sequencer.idleActive) return;
    const until = now + ahead;
    const events = this.sequencer.process(until);
    // Events further ahead (scheduled while the look-ahead was held longer) are still there.
    this.horizon = Math.max(this.horizon, until);
    this.dispatcher.dispatch(events);
    this.dispatcher.applyCuts(this.sequencer.takeCuts(), now);
  }

  private readonly onTick = (): void => {
    if (this.disposed) return;
    const wall = this.wall();
    if (this.stallUntil !== 0) {
      if (wall < this.stallUntil) return;
      this.stallUntil = 0;
    }
    // Ticks come every `interval` ms; a longer gap means the main thread was busy: brace for more.
    const gap = this.lastTickAt > 0 ? wall - this.lastTickAt : 0;
    this.lastTickAt = wall;
    const now = this.ctx.currentTime;
    this.checkState();
    const active = this.sequencer.playing || this.sequencer.idleActive;
    if (active && gap > TICK_GAP_MS) this.extendBrace(BRACE_AHEAD, BRACE_MS);
    else if (this.braceUntil !== 0 && wall >= this.braceUntil) {
      this.braceUntil = 0;
      this.braceAhead = 0;
      this.updateAhead();
    }
    const hidden = this.simulatedHidden || this.isHidden();
    this.simulatedHidden = false;
    if (this.sequencer.playing) {
      const late = now - this.horizon;
      if (hidden || this.ctx.state !== 'running') {
        // A background tab or a paused device: playback stops (Resume continues).
        if (late > STALL_THRESHOLD) {
          this.stall(now, hidden);
          return;
        }
      } else if (late > LATE_TOLERANCE) {
        // Visible and running: the app itself was busy. Skip the missed stretch and play on in time.
        this.skip(now, late);
      }
    } else if (this.sequencer.idleActive && now - this.horizon > STALL_THRESHOLD) {
      // Same policy for the idle arpeggiator: skip the missed stretch.
      this.sequencer.skipIdleTo(now);
    }
    this.schedule(now);
    this.flush(now);
    this.dispatcher.prune(now);
    this.ensureTicker();
  };

  /**
   * The scheduler fell behind in a visible tab with the audio running: what
   * should already have sounded is skipped (never played late), every state
   * change in it applies (see Sequencer.skipTo), and playback goes on in time.
   */
  private skip(now: number, lateBy: number): void {
    // Up to the tolerance: what starts later is still played (in time, or at most LATE_TOLERANCE late).
    const at = now - LATE_TOLERANCE;
    const changes = this.sequencer.skipTo(at);
    const dropped = this.sequencer.skippedNotes;
    this.horizon = Math.max(this.horizon, at);
    this.dispatcher.dispatch(changes);
    this.dispatcher.applyCuts(this.sequencer.takeCuts(), now);
    this.extendBrace(BRACE_AHEAD, BRACE_MS);
    // A skip is only news when notes were left out.
    if (dropped === 0) return;
    this.skips++;
    this.emit('skipped', { lateBy, tick: this.sequencer.getPosition(now).tick });
  }

  /** Fell too far behind in a hidden tab or with the device suspended: stop without a backlog and let the app offer Resume. */
  private stall(now: number, hidden: boolean): void {
    const lateBy = now - this.horizon;
    const tick = this.sequencer.getPosition(now).tick;
    // The music ran out at the horizon (nothing was scheduled after it): the song block playing there.
    const songBlockId = this.sequencer.songBlockAt(this.sequencer.getPosition(Math.min(now, this.horizon)).tick)?.blockId ?? null;
    const reason = hidden || this.ctx.state === 'running' ? 'throttled' : 'suspended';
    this.stopAt(now);
    this.emit('stalled', { reason, lateBy, tick, songBlockId });
  }

  /** Long animation frames (where the browser reports them) brace too: the next one is likely close. */
  private watchLongFrames(): void {
    const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (!PO || !PO.supportedEntryTypes?.includes('long-animation-frame')) return;
    try {
      const observer = new PO((list) => {
        if (this.disposed || (!this.sequencer.playing && !this.sequencer.idleActive)) return;
        for (const e of list.getEntries()) {
          if (e.duration > LONG_FRAME_MS) {
            this.brace();
            return;
          }
        }
      });
      observer.observe({ type: 'long-animation-frame' });
      this.longFrames = observer;
    } catch {
      this.longFrames = null;
    }
  }

  private readonly onStateChange = (): void => {
    if (!this.disposed) this.checkState();
  };

  private checkState(): void {
    const s = this.ctx.state;
    if (s === this.lastState) return;
    this.lastState = s;
    this.emit('state', { state: s, playing: this.sequencer.playing });
  }

  /* ---------------------------------------------------------------- */
  /* Ticker                                                            */
  /* ---------------------------------------------------------------- */

  private ensureTicker(): void {
    if (this.disposed) return;
    const need = this.sequencer.playing || this.sequencer.idleActive || this.queue.length > 0 || this.dispatcher.size > 0;
    if (need) this.startTicker();
    else this.stopTicker();
  }

  private startTicker(): void {
    if (this.tickerRunning) return;
    this.tickerRunning = true;
    // The first tick has no gap to measure.
    this.lastTickAt = 0;
    if (!this.worker && !this.workerFailed) this.createWorker();
    if (this.worker) this.worker.postMessage({ interval: this.interval });
    else this.fallbackTimer = setInterval(this.onTick, this.interval);
  }

  private stopTicker(): void {
    if (!this.tickerRunning) return;
    this.tickerRunning = false;
    this.worker?.postMessage('stop');
    if (this.fallbackTimer !== null) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private createWorker(): void {
    if (typeof Worker === 'undefined' || typeof URL.createObjectURL !== 'function') {
      this.workerFailed = true;
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([TICKER_WORKER_SOURCE], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = this.onTick;
      w.onerror = (ev) => {
        // Blocked blob workers (e.g. a strict CSP): fall back to a main-thread timer.
        ev.preventDefault();
        this.workerFailed = true;
        this.destroyWorker();
        if (this.tickerRunning) {
          this.tickerRunning = false;
          this.startTicker();
        }
      };
      this.worker = w;
      this.workerUrl = url;
    } catch {
      this.workerFailed = true;
      this.destroyWorker();
    }
  }

  private destroyWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }
}
