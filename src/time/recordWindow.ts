/**
 * Record Notes timing (pure): which transport tick a played note is written
 * at, and from which loop start its position in the clip counts.
 *
 * - While the target clip plays, a note counts from the clip's loop start at
 *   the tick it was played (the session compensates for output latency).
 * - Waiting for the recording to start (the clip launches at the next bar,
 *   or the count-in runs), a note played up to an 8th note before that
 *   downbeat is kept and snaps to the downbeat: players often come in a
 *   little early. Earlier notes are not recorded (the transport shows the
 *   beats left until the recording starts, runtime.recordStartsAtTick).
 * - Song playback: when the song moves into a block that does not play the
 *   target clip, notes still go into it, counted from where its loop would
 *   be (`lastLoopStart`), so they land where they would have sounded.
 */
import { TICKS_PER_BAR } from '../project/types';

/** How early (ticks) a note may come before the record start and still count (an 8th note). */
export const RECORD_EARLY_TICKS = TICKS_PER_BAR / 8;

export interface RecordWindowInput {
  /** Transport tick the note was played at (latency-compensated). */
  tick: number;
  /** The clip the part sounds at that tick (Sequencer.playingAt), or null. */
  playing: { slot: number; startTick: number } | null;
  /** The clip slot being recorded into. */
  slot: number;
  /** The tick recording starts at while it waits for it (runtime.recordStartsAtTick), else null. */
  startsAt: number | null;
  /** Song playback, the target not playing here: its last loop start, else null (the note is not recorded). */
  lastLoopStart?: number | null;
}

/**
 * Where a played note goes: `tick` (transport tick it is written at) and
 * `loopStart` (the transport tick its clip position counts from; the clip
 * position is tick − loopStart, wrapped into the clip), or null when it is
 * not recorded.
 */
export function recordedNoteAt(input: RecordWindowInput): { tick: number; loopStart: number } | null {
  const { tick, playing, slot, startsAt } = input;
  if (!Number.isFinite(tick)) return null;
  if (playing && playing.slot === slot && tick >= playing.startTick) return { tick, loopStart: playing.startTick };
  if (startsAt !== null && Number.isFinite(startsAt) && tick < startsAt) {
    return tick >= startsAt - RECORD_EARLY_TICKS ? { tick: startsAt, loopStart: startsAt } : null;
  }
  // The clip's own first downbeat, generated ahead of the sound: the same early window.
  if (playing && playing.slot === slot && tick >= playing.startTick - RECORD_EARLY_TICKS) return { tick: playing.startTick, loopStart: playing.startTick };
  const last = input.lastLoopStart;
  if (last !== null && last !== undefined && Number.isFinite(last)) return { tick, loopStart: last };
  return null;
}
