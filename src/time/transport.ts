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
import type { AudioEngineApi, VoiceHandle } from '../audio/contracts';
import { PPQ, type Id, type Project } from '../project/types';
import { clampBpm } from './clock';
import type { LaunchResult, SeqEvent, StartOptions } from './contracts';
import type { BeatEvent, NoteCut, NoteEvent, SeqPosition, Sequencer } from './sequencer';
import { TICKER_WORKER_SOURCE } from './tickerWorker';

export const DEFAULT_LOOKAHEAD = 0.12;
export const DEFAULT_INTERVAL = 25;
/** The ticker may fall this far behind its scheduled horizon before playback stops. */
export const STALL_THRESHOLD = 0.25;
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
    for (const ev of events) {
      switch (ev.kind) {
        case 'note': {
          const h = engine.scheduleNote(ev.trackId, { pitch: ev.pitch, velocity: ev.velocity, time: ev.time, duration: ev.duration, legato: ev.legato });
          if (h) this.voices.set(ev, { handle: h, trackId: ev.trackId, time: ev.time, end: ev.time + ev.duration });
          this.o.onNote?.(ev);
          break;
        }
        case 'beat':
          // A beat regenerated after an invalidation replaces the duck/click the engine dropped.
          if (!ev.countIn) engine.schedulePump(ev.time, ev.beatSeconds, Math.round(ev.tick / PPQ));
          if (ev.countIn ? this.o.countInClicks : this.o.metronome()) engine.scheduleClick(ev.time, ev.beat === 0);
          this.o.onEvent(ev);
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
  /** Playback stopped because the scheduler fell behind; offer Resume. */
  stalled: { reason: 'throttled' | 'suspended'; lateBy: number; tick: number };
}

export type TransportEventName = keyof TransportEventMap;

export interface RealtimeTransportOptions {
  ctx: BaseAudioContext;
  engine: AudioEngineApi;
  sequencer: Sequencer;
  /** Seconds scheduled ahead of the audio clock (default 0.12). */
  lookahead?: number;
  /** Ticker period in ms (default 25). */
  interval?: number;
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
  private horizon = 0;
  private stallUntil = 0;
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
    this.interval = opts.interval ?? DEFAULT_INTERVAL;
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
    });
    this.lastState = this.ctx.state;
    this.ctx.addEventListener('statechange', this.onStateChange);
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
    this.engine.transportStarted(t, this.sequencer.tickAt(t), this.sequencer.bpm);
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
   * regenerate what was scheduled from then on. Returns true when playback
   * changed.
   */
  replanSong(): boolean {
    this.assertAlive();
    const now = this.ctx.currentTime;
    const at = now + INVALIDATE_MARGIN;
    if (!this.sequencer.replanSong(at)) return false;
    if (this.sequencer.playing) this.invalidateFrom(at, now);
    return true;
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
    this.schedule(now);
  }

  getPosition(): TransportPosition {
    return { ...this.sequencer.getPosition(this.ctx.currentTime), playing: this.sequencer.playing, paused: this.sequencer.paused };
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
    return { pendingHandles: c.pending, soundingHandles: c.sounding, listeners, tickerRunning: this.tickerRunning, queuedEvents: this.queue.length };
  }

  /** Test hook: ignore ticks for `ms` milliseconds, as a throttled background tab would. */
  simulateStall(ms: number): void {
    this.stallUntil = performance.now() + Math.max(0, ms);
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
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('RealtimeTransport has been disposed');
  }

  /* ---------------------------------------------------------------- */
  /* Scheduling loop                                                   */
  /* ---------------------------------------------------------------- */

  private schedule(now: number): void {
    if (!this.sequencer.playing && !this.sequencer.idleActive) return;
    const until = now + this.lookahead;
    const events = this.sequencer.process(until);
    this.horizon = until;
    this.dispatcher.dispatch(events);
    this.dispatcher.applyCuts(this.sequencer.takeCuts(), now);
  }

  private readonly onTick = (): void => {
    if (this.disposed) return;
    if (this.stallUntil !== 0) {
      if (performance.now() < this.stallUntil) return;
      this.stallUntil = 0;
    }
    const now = this.ctx.currentTime;
    this.checkState();
    if (this.sequencer.playing) {
      if (now - this.horizon > STALL_THRESHOLD) {
        this.stall(now);
        return;
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

  /** Fell too far behind to play on coherently: stop without a backlog and let the app offer Resume. */
  private stall(now: number): void {
    const lateBy = now - this.horizon;
    const tick = this.sequencer.getPosition(now).tick;
    const reason = this.ctx.state === 'running' ? 'throttled' : 'suspended';
    this.stopAt(now);
    this.emit('stalled', { reason, lateBy, tick });
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
