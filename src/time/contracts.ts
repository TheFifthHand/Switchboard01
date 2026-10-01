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
 * - Song mode: parts switch at block starts. An edit to what the block
 *   playing plays switches its parts at the edit point instead (the playhead
 *   at now + the invalidate margin), in phase with the block start; see
 *   Sequencer.replanSong. A 'launch' event then lies off the bar line.
 * - A clip that started at tick S with length L plays note n at
 *   S + k*L + n.tick for k = 0, 1, 2 ...
 * - Events are generated for windows of ticks. Each event belongs to exactly
 *   one window (by its un-swung tick). `invalidate(fromTime)` rewinds the
 *   generation cursor so later events are regenerated from current state;
 *   the driver cancels voices that start at or after `fromTime` first.
 */
import type { Id, LauncherSnapshotEntry, MacroId } from '../project/types';

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
    }
  | { kind: 'launch'; tick: number; time: number; trackId: Id; slot: number | null; clipId: Id | null }
  | { kind: 'beat'; tick: number; time: number; bar: number; beat: number; beatSeconds: number; countIn: boolean }
  | { kind: 'param'; tick: number; time: number; module: Id; param: string; value: number }
  | { kind: 'macro'; tick: number; time: number; trackId: Id; macro: MacroId; value: number }
  | { kind: 'mute'; tick: number; time: number; trackId: Id; mute: boolean }
  | { kind: 'tempo'; tick: number; time: number; bpm: number }
  | { kind: 'swing'; tick: number; time: number; swing: number }
  | { kind: 'master'; tick: number; time: number; volumeDb: number }
  | { kind: 'block'; tick: number; time: number; blockIndex: number; blockId: Id; sceneRow: number }
  | { kind: 'end'; tick: number; time: number };

export type PlayMode =
  | { kind: 'live' }
  /** Play the arrangement from a block index. */
  | { kind: 'song'; fromBlock: number }
  /** Replay a recorded performance (uses its snapshot + events). */
  | { kind: 'replay'; performanceId: Id };

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
