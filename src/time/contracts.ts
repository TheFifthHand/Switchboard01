/**
 * Contracts for musical time and event scheduling (architecture layer 2).
 *
 * Timing model
 * ------------
 * - Musical positions are ticks (PPQ = 96, 16th = 24 ticks, bar = 384 ticks, 4/4).
 * - The audio clock (AudioContext.currentTime) is the only timing authority.
 *   A tempo anchor {time, tick, bpm} maps ticks <-> seconds. A tempo change
 *   re-anchors at the change time, so earlier events keep their times.
 * - Swing warps positions inside each 8th note: the off-beat 16th moves later
 *   by swing * TICKS_PER_STEP / 3 ticks (swing 1 = triplet shuffle); positions
 *   in between are warped piecewise-linearly so ordering is preserved.
 *   Swing only delays, never advances, an event.
 * - Clip launches are quantized to the next bar line after the request
 *   (strictly later than the current playhead tick). Only one clip per track
 *   plays; at the switch tick the old clip's notes are cut (their duration is
 *   truncated to end at the switch tick) and the new clip starts at local
 *   position 0.
 * - Song mode plays the song's regions (project/arrangement.ts) on an
 *   absolute song timeline. The transport tick keeps running; "passes" map
 *   it to song ticks: a pass plays song ticks [from, to) from a transport
 *   tick on. The first pass starts at the start bar (transport tick = song
 *   tick); with a song loop, passes of the loop follow when the playhead
 *   reaches its end, so swing and the arpeggiator run on through the seam.
 *   A region switches its part to its clip at its start, in phase (the clip
 *   is `offset` bars in at the region's start), and stops it at its end
 *   unless the next region of that part starts there. An edit while the song
 *   plays acts from the edit point (the playhead at now + the invalidate
 *   margin): a part whose region changed there switches there, in phase, so
 *   a 'launch' event can lie off the bar line. See Sequencer.replanSong.
 * - A clip that started at tick S with length L plays note n at
 *   S + k*L + n.tick for k = 0, 1, 2 ...
 * - Events are generated for windows of ticks. Each event belongs to exactly
 *   one window (by its un-swung tick). `invalidate(fromTime)` rewinds the
 *   generation cursor so later events are regenerated from current state;
 *   the driver cancels voices that start at or after `fromTime` first.
 * - Song moves (SongSection.moves) are ramps of the song gain and of
 *   parts' big knobs ('songGain', 'macroRamp' events) over the sections they
 *   belong to, wherever a pass plays them, sent when generation reaches their
 *   start and again, from the value they have reached, where playback
 *   starts, resumes or is regenerated in the middle of one (see
 *   src/time/moves.ts).
 * - A driver that fell behind skips the missed stretch (Sequencer.skipTo):
 *   its notes never sound late, its state changes still apply.
 */
import type { ClipSample, Id, LauncherSnapshotEntry, MacroId } from '../project/types';

export type SeqEvent =
  | {
      kind: 'note';
      tick: number;
      time: number;
      trackId: Id;
      pitch: number;
      velocity: number;
      /** Seconds (already swing/tempo-adjusted). */
      duration: number;
      durationTicks: number;
      /** Mono instruments: glide from the previous overlapping note. */
      legato: boolean;
      source: 'clip' | 'arp' | 'replay';
      clipId?: Id;
      /** Sampler parts: the clip's own recording (Clip.sample), played instead of the part's. */
      sample?: ClipSample;
    }
  /**
   * Song moves: the song gain is `from` at `time` and goes linearly to
   * `value` at `endTime` (equal times: it is set to `value` there).
   */
  | { kind: 'songGain'; tick: number; time: number; from: number; value: number; endTick: number; endTime: number }
  /** Song moves: a part's big knob is `from` at `time` and goes linearly (in macro space) to `value` at `endTime`. */
  | { kind: 'macroRamp'; tick: number; time: number; trackId: Id; macro: MacroId; from: number; value: number; endTick: number; endTime: number }
  | { kind: 'launch'; tick: number; time: number; trackId: Id; slot: number | null; clipId: Id | null }
  | { kind: 'beat'; tick: number; time: number; bar: number; beat: number; beatSeconds: number; countIn: boolean }
  | { kind: 'param'; tick: number; time: number; module: Id; param: string; value: number }
  | { kind: 'macro'; tick: number; time: number; trackId: Id; macro: MacroId; value: number }
  | { kind: 'mute'; tick: number; time: number; trackId: Id; mute: boolean }
  | { kind: 'tempo'; tick: number; time: number; bpm: number }
  | { kind: 'swing'; tick: number; time: number; swing: number }
  | { kind: 'master'; tick: number; time: number; volumeDb: number }
  | { kind: 'end'; tick: number; time: number };

/**
 * A looped part of the song: bars [fromBar, toBar) (whole bars, toBar >
 * fromBar) play again and again until the loop is cleared. Runtime only (not
 * saved with the project); the session owns it (runtime `songLoop`).
 */
export interface SongLoop {
  fromBar: number;
  toBar: number;
}

export type PlayMode =
  | { kind: 'live' }
  /** Play the song (its regions) from a bar of the song timeline (0-based). */
  | { kind: 'song'; fromBar: number }
  /** Replay a recorded performance (uses its snapshot + events). */
  | { kind: 'replay'; performanceId: Id };

/** The clip a part sounds now and where its loop started (see RealtimeTransport.clipPhase). */
export interface ClipPhase {
  slot: number;
  /**
   * Transport tick its loop counts from (where it was launched; in the song,
   * where the clip's start falls for the region playing it, at or before
   * the region): at tick t it is ((t − startTick) mod lengthTicks) into its loop.
   */
  startTick: number;
  /** Loop length in ticks (the clip's bars). */
  lengthTicks: number;
}

export interface TrackLaunchState {
  playing: { slot: number; clipId: Id; startTick: number } | null;
  /** slot === null means "stop at atTick". */
  queued: { slot: number | null; atTick: number } | null;
}

export interface StartOptions {
  mode?: PlayMode;
  /** Transport tick at `time` (default 0; negative for count-in). */
  fromTick?: number;
  /** Initial launcher state (performance replay / resuming). */
  launcher?: LauncherSnapshotEntry[];
  /** Bars of count-in clicks before tick 0 (0 or 1). */
  countInBars?: number;
}

/** A launch request's outcome, for immediate UI feedback. */
export interface LaunchResult {
  trackId: Id;
  slot: number | null;
  atTick: number;
  atTime: number;
}
