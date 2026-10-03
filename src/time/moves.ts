/**
 * Song moves (pure: no DOM, no Web Audio).
 *
 * What the moves of a song block (ArrangementBlock.moves, schema v3) do over
 * the song timeline, as segments: a target (the song gain, or one big knob of
 * one part) goes from `v0` at `tick0` to `v1` at `tick1`, linearly. The
 * sequencer hands them to the engine as ramps (SeqEvent 'songGain' and
 * 'macroRamp') when generation reaches their start, and again from the value
 * they have reached wherever playback starts, resumes or is regenerated in
 * the middle of one (see Sequencer). Live playback and exports use the same
 * events, so an export moves exactly like playback.
 *
 * - fadeIn: the song gain rises from 0 to 1 across the whole block; fadeOut
 *   falls from 1 to 0. A block with both rises over its first half and falls
 *   over its second.
 * - filterRise: each part's Tone rises from FILTER_RISE_FROM to the part's
 *   own Tone across the block (back at its own value when the block ends).
 * - echoThrow: each part's Echo rises to ECHO_THROW_TO over the block's last
 *   beat, holds there, and returns to the part's own value over the last beat
 *   of the bar that follows (one bar after the block's end it is back).
 * - Outside every move a target rests: the song gain at 1, a big knob at the
 *   part's own value. A move of a later block takes over a target from its
 *   own start (an echo throw still returning when the next block's moves begin).
 */
import { TICKS_PER_BAR, TICKS_PER_BEAT, type BlockMove, type Id, type MacroId, type Project, type Track, type TrackRole } from '../project/types';

/** Where Filter rise starts the Tone big knob. */
export const FILTER_RISE_FROM = 0.15;
/** Where Echo throw takes the Echo big knob. */
export const ECHO_THROW_TO = 0.85;
/** Parts filterRise and echoThrow act on when a move lists none (every melodic part). */
export const MOVE_PART_ROLES: ReadonlySet<TrackRole> = new Set<TrackRole>(['bass', 'chords', 'lead', 'pad', 'texture', 'sampler']);

/** The song gain's key. */
export const GAIN_KEY = 'gain';

/** A part's big knob as a move target key. */
export function macroKey(trackId: Id, macro: MacroId): string {
  return `${trackId}\u0000${macro}`;
}

export interface MoveSegment {
  /** GAIN_KEY, or macroKey(trackId, macro). */
  key: string;
  /** Null for the song gain. */
  trackId: Id | null;
  macro: MacroId | null;
  tick0: number;
  tick1: number;
  v0: number;
  v1: number;
}

/** The parts a filterRise or echoThrow move acts on. */
export function moveParts(project: Project, move: BlockMove): Track[] {
  if (move.parts?.length) return project.tracks.filter((t) => move.parts!.includes(t.id));
  return project.tracks.filter((t) => MOVE_PART_ROLES.has(t.role));
}

/** The value a target rests at: the song gain at 1, a big knob at the part's own value. */
export function restValue(project: Project, key: string): number {
  if (key === GAIN_KEY) return 1;
  const sep = key.indexOf('\u0000');
  const trackId = key.slice(0, sep);
  const macro = key.slice(sep + 1) as MacroId;
  const v = project.tracks.find((t) => t.id === trackId)?.macros[macro];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** True when any song block carries a move. */
export function hasMoves(project: Project): boolean {
  for (const b of project.arrangement.blocks) if (b.moves?.length) return true;
  return false;
}

/**
 * The segments of one block placed on the song timeline at [startTick,
 * endTick) (its moves as the project has them now; none when it has none).
 */
export function blockMoveSegments(project: Project, blockId: Id, startTick: number, endTick: number): MoveSegment[] {
  const block = project.arrangement.blocks.find((b) => b.id === blockId);
  const moves = block?.moves;
  if (!moves?.length || !(endTick > startTick)) return [];
  const out: MoveSegment[] = [];
  const S = startTick;
  const E = endTick;
  const fadeIn = moves.some((m) => m.kind === 'fadeIn');
  const fadeOut = moves.some((m) => m.kind === 'fadeOut');
  const gain = (tick0: number, tick1: number, v0: number, v1: number) => out.push({ key: GAIN_KEY, trackId: null, macro: null, tick0, tick1, v0, v1 });
  if (fadeIn && fadeOut) {
    const mid = S + (E - S) / 2;
    gain(S, mid, 0, 1);
    gain(mid, E, 1, 0);
  } else if (fadeIn) gain(S, E, 0, 1);
  else if (fadeOut) gain(S, E, 1, 0);
  for (const move of moves) {
    if (move.kind === 'filterRise') {
      for (const t of moveParts(project, move)) {
        const own = restValue(project, macroKey(t.id, 'tone'));
        out.push({ key: macroKey(t.id, 'tone'), trackId: t.id, macro: 'tone', tick0: S, tick1: E, v0: FILTER_RISE_FROM, v1: own });
      }
    } else if (move.kind === 'echoThrow') {
      const rise = Math.max(S, E - TICKS_PER_BEAT);
      const back = E + TICKS_PER_BAR - TICKS_PER_BEAT;
      for (const t of moveParts(project, move)) {
        const key = macroKey(t.id, 'echo');
        const own = restValue(project, key);
        out.push({ key, trackId: t.id, macro: 'echo', tick0: rise, tick1: E, v0: own, v1: ECHO_THROW_TO });
        out.push({ key, trackId: t.id, macro: 'echo', tick0: E, tick1: back, v0: ECHO_THROW_TO, v1: ECHO_THROW_TO });
        out.push({ key, trackId: t.id, macro: 'echo', tick0: back, tick1: E + TICKS_PER_BAR, v0: ECHO_THROW_TO, v1: own });
      }
    }
  }
  return out;
}

/**
 * The segments of consecutive song blocks (in timeline order), with a later
 * block's moves taking a target over from their own start: an earlier
 * segment of that target is cut there (its end value then where it was cut).
 */
export function timelineSegments(project: Project, blocks: readonly { blockId: Id; startTick: number; endTick: number }[]): MoveSegment[] {
  const all: MoveSegment[] = [];
  for (const b of blocks) {
    const segs = blockMoveSegments(project, b.blockId, b.startTick, b.endTick);
    if (!segs.length) continue;
    // Where this block's moves take each target over.
    const takeover = new Map<string, number>();
    for (const s of segs) takeover.set(s.key, Math.min(takeover.get(s.key) ?? Infinity, s.tick0));
    for (let i = all.length - 1; i >= 0; i--) {
      const s = all[i];
      const at = takeover.get(s.key);
      if (at === undefined || s.tick1 <= at) continue;
      if (s.tick0 >= at) all.splice(i, 1);
      else all[i] = { ...s, tick1: at, v1: valueIn(s, at) };
    }
    all.push(...segs);
  }
  all.sort((a, b) => a.tick0 - b.tick0 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return all;
}

/** A segment's value at `tick` (clamped to its span). */
export function valueIn(s: MoveSegment, tick: number): number {
  if (!(s.tick1 > s.tick0) || tick >= s.tick1) return s.v1;
  if (tick <= s.tick0) return s.v0;
  return s.v0 + ((s.v1 - s.v0) * (tick - s.tick0)) / (s.tick1 - s.tick0);
}

/** The segment of `key` that holds `tick` (tick0 <= tick < tick1), or null (the target rests there). */
export function segmentAt(segs: readonly MoveSegment[], key: string, tick: number): MoveSegment | null {
  let found: MoveSegment | null = null;
  for (const s of segs) {
    if (s.tick0 > tick) break;
    if (s.key === key && tick < s.tick1) found = s;
  }
  return found;
}
