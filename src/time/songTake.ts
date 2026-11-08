/**
 * Recording into the song (pure): the notes played during a take, as the
 * session caught them on the audio clock, become the take that is put in the
 * song (commands/songClips.ts recordTakeIntoSong: song clips and regions from
 * the start bar).
 *
 * Every tick here counts from the take's start bar (song tick − startBar ×
 * TICKS_PER_BAR). The rules follow Record Notes on the pads:
 * - A note played before the start (the count-in, or the wait for the next
 *   bar line) is kept only when it comes at most an 8th early
 *   (RECORD_EARLY_TICKS): it moves to the downbeat, its length measured from
 *   when it was pressed. Earlier ones are not recorded.
 * - Its start snaps to settings.recordQuantize (nearest grid line); its length
 *   is as long as the key was held (at least MIN_TAKE_NOTE_TICKS). Notes the
 *   arpeggiator played are on its own grid already and are not moved.
 * - A key still held when the take stops ends at the stop.
 * - The same key pressed again before its release ends the earlier note there.
 * - The song may loop while recording: a note never lasts past the end of the
 *   pass it started in (`until`), and passes merge into one take (last note
 *   wins at the same tick and pitch), as GarageBand merges cycle passes.
 * - The take is whole bars: up to where it reached (at least 1), longer when
 *   a quantized note lands after that, never past `maxBars`.
 */
import { TICKS_PER_BAR, type Id, type Note, type QuantizeGrid } from '../project/types';
import { RECORD_EARLY_TICKS } from './recordWindow';

/** Shortest note a take keeps (ticks; a 64th note): a tap is still a note you can see and hear (as Record Notes). */
export const MIN_TAKE_NOTE_TICKS = 6;

/** Grid ticks of each Record Notes quantize setting (as commands/notes.ts QUANTIZE_TICKS). */
const GRID: Readonly<Record<QuantizeGrid, number>> = { off: 0, '1/4': 96, '1/8': 48, '1/16': 24, '1/32': 12 };

/** One thing caught during a take. Ticks count from the start bar (negative: before it). */
export type TakeEvent =
  | {
      kind: 'on';
      tick: number;
      /** What pairs it with its release (the held key). */
      key: string;
      pitch: number;
      velocity: number;
      /** The song jumps back after this tick (a loop's end): the note ends there at the latest. */
      until?: number;
      /** False: already on its own grid (arpeggiator notes), not quantized. */
      quantize?: boolean;
    }
  | { kind: 'off'; tick: number; key: string };

export interface TakeCapture {
  trackId: Id;
  /** Song bar (0-based) where the take starts. */
  startBar: number;
  /** Events in the order they happened. */
  events: readonly TakeEvent[];
  /** Where the take stopped (keys still held end here). */
  stopTick: number;
  /** The furthest tick the take reached (more than stopTick once the song looped); defaults to stopTick. */
  reachedTick?: number;
  quantize: QuantizeGrid;
  /** Most bars the take may have (the song's room after the start bar). */
  maxBars?: number;
}

/** A finished take: the shape commands/songClips.ts recordTakeIntoSong takes (notes timed from the start bar). */
export interface CapturedSongTake {
  trackId: Id;
  startBar: number;
  bars: number;
  notes: Omit<Note, 'id'>[];
  /** The notes are on their grid already (Record timing, or the arpeggiator's own): the command must not snap them again. */
  quantize: 'off';
}

function snap(tick: number, grid: QuantizeGrid): number {
  const g = GRID[grid] ?? 0;
  return g ? Math.round(tick / g) * g : tick;
}

/** The take the events make (see the file header). No notes: an empty take (the command refuses it). */
export function songTakeFrom(c: TakeCapture): CapturedSongTake {
  const maxBars = Math.max(1, Math.floor(c.maxBars ?? Infinity));
  const open = new Map<string, { tick: number; press: number; pitch: number; velocity: number; until: number; quantize: boolean }>();
  const raw: { tick: number; end: number; pitch: number; velocity: number; quantize: boolean }[] = [];
  const close = (key: string, at: number): void => {
    const n = open.get(key);
    if (!n) return;
    open.delete(key);
    // Released after the song jumped back (a loop came round): it ended where its pass did.
    const end = at < n.press ? n.until : Math.min(at, n.until);
    raw.push({ tick: n.tick, end: Math.max(end, n.press) + (n.tick - n.press), pitch: n.pitch, velocity: n.velocity, quantize: n.quantize });
  };
  for (const e of c.events) {
    if (!Number.isFinite(e.tick)) continue;
    if (e.kind === 'off') {
      close(e.key, e.tick);
      continue;
    }
    close(e.key, e.tick);
    if (!Number.isFinite(e.pitch) || !Number.isFinite(e.velocity)) continue;
    // Before the start: only a moment early (it moves onto the downbeat), else not recorded.
    if (e.tick < 0 && e.tick < -RECORD_EARLY_TICKS) continue;
    const until = e.until !== undefined && Number.isFinite(e.until) ? e.until : Infinity;
    open.set(e.key, { tick: Math.max(0, e.tick), press: e.tick, pitch: Math.round(e.pitch), velocity: Math.min(1, Math.max(0, e.velocity)), until, quantize: e.quantize !== false });
  }
  for (const key of [...open.keys()]) close(key, c.stopTick);

  const reached = Math.max(c.stopTick, c.reachedTick ?? -Infinity);
  let bars = Math.max(1, Math.ceil(reached / TICKS_PER_BAR));
  // Last write wins at the same tick and pitch (as Record Notes).
  const placed = new Map<string, Omit<Note, 'id'>>();
  for (const n of raw) {
    const length = n.end - n.tick;
    let tick = n.quantize ? snap(n.tick, c.quantize) : n.tick;
    tick = Math.max(0, tick) || 0;
    if (tick >= maxBars * TICKS_PER_BAR) continue;
    bars = Math.max(bars, Math.floor(tick / TICKS_PER_BAR) + 1);
    placed.set(`${tick}:${n.pitch}`, { tick, pitch: n.pitch, velocity: n.velocity, duration: Math.max(MIN_TAKE_NOTE_TICKS, length) });
  }
  bars = Math.min(bars, maxBars);
  const end = bars * TICKS_PER_BAR;
  const notes = [...placed.values()]
    .map((n) => ({ ...n, duration: Math.max(1, Math.min(n.duration, end - n.tick)) }))
    .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  return { trackId: c.trackId, startBar: c.startBar, bars, notes, quantize: 'off' };
}
