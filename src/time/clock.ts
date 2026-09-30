/**
 * Musical time math (pure: no DOM, no Web Audio).
 *
 * Ticks <-> seconds through tempo anchors, and the swing warp. See
 * src/time/contracts.ts for the timing model.
 */
import { MAX_BPM, MIN_BPM, PPQ, TICKS_PER_STEP } from '../project/types';

/** One 8th note: the unit inside which swing warps positions. */
export const SWING_CELL_TICKS = TICKS_PER_STEP * 2;
/** How far swing 1 delays the off-beat 16th (swing 1 = triplet position). */
export const MAX_SWING_TICKS = TICKS_PER_STEP / 3;

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

export function clampSwing(swing: number): number {
  if (!Number.isFinite(swing)) return 0;
  return Math.min(1, Math.max(0, swing));
}

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks * 60) / (bpm * PPQ);
}

export function secondsToTicks(seconds: number, bpm: number): number {
  return (seconds * bpm * PPQ) / 60;
}

/**
 * Un-swung tick -> swung tick. Inside each 8th note the first 16th is
 * stretched and the second compressed (piecewise linear), so the off-beat
 * 16th lands `swing * 8` ticks later. Continuous, strictly increasing,
 * identity at swing 0 and on every 8th-note line, and never earlier than
 * the input.
 */
export function swingWarp(tick: number, swing: number): number {
  const d = clampSwing(swing) * MAX_SWING_TICKS;
  if (d === 0 || !Number.isFinite(tick)) return tick;
  const half = TICKS_PER_STEP;
  const base = Math.floor(tick / SWING_CELL_TICKS) * SWING_CELL_TICKS;
  const p = tick - base;
  const warped = p < half ? (p * (half + d)) / half : half + d + ((p - half) * (half - d)) / half;
  return base + warped;
}

/** Inverse of `swingWarp` (swung tick -> un-swung tick), e.g. for recording against a swung grid. */
export function unswingWarp(swungTick: number, swing: number): number {
  const d = clampSwing(swing) * MAX_SWING_TICKS;
  if (d === 0 || !Number.isFinite(swungTick)) return swungTick;
  const half = TICKS_PER_STEP;
  const base = Math.floor(swungTick / SWING_CELL_TICKS) * SWING_CELL_TICKS;
  const q = swungTick - base;
  const p = q < half + d ? (q * half) / (half + d) : half + ((q - half - d) * half) / (half - d);
  return base + p;
}

export interface TempoAnchor {
  /** Context time (seconds). */
  time: number;
  /** Transport tick at `time`. */
  tick: number;
  bpm: number;
}

/**
 * Piecewise-constant tempo map. Each re-anchor starts a new segment at its
 * time, so ticks and times before a tempo change keep their mapping (earlier
 * events keep their times). Before the first anchor the first segment is
 * extrapolated.
 */
export class TempoMap {
  private segs: TempoAnchor[];

  constructor(anchor: TempoAnchor = { time: 0, tick: 0, bpm: 120 }) {
    this.segs = [TempoMap.norm(anchor)];
  }

  private static norm(a: TempoAnchor): TempoAnchor {
    return {
      time: Number.isFinite(a.time) ? a.time : 0,
      tick: Number.isFinite(a.tick) ? a.tick : 0,
      bpm: clampBpm(a.bpm),
    };
  }

  /** The latest anchor. */
  get anchor(): TempoAnchor {
    return { ...this.segs[this.segs.length - 1] };
  }

  /** Current (latest) tempo. */
  get bpm(): number {
    return this.segs[this.segs.length - 1].bpm;
  }

  get segmentCount(): number {
    return this.segs.length;
  }

  /** Forget all history and start from one anchor. */
  reset(anchor: TempoAnchor): void {
    this.segs = [TempoMap.norm(anchor)];
  }

  private segAtTime(time: number): TempoAnchor {
    const s = this.segs;
    for (let i = s.length - 1; i > 0; i--) if (s[i].time <= time) return s[i];
    return s[0];
  }

  private segAtTick(tick: number): TempoAnchor {
    const s = this.segs;
    for (let i = s.length - 1; i > 0; i--) if (s[i].tick <= tick) return s[i];
    return s[0];
  }

  tickAt(time: number): number {
    const s = this.segAtTime(time);
    return s.tick + secondsToTicks(time - s.time, s.bpm);
  }

  /** Un-swung time of a tick. */
  timeAt(tick: number): number {
    const s = this.segAtTick(tick);
    return s.time + ticksToSeconds(tick - s.tick, s.bpm);
  }

  /** Time of `tick` after the swing warp. */
  timeAtSwung(tick: number, swing: number): number {
    return this.timeAt(swingWarp(tick, swing));
  }

  bpmAtTime(time: number): number {
    return this.segAtTime(time).bpm;
  }

  bpmAtTick(tick: number): number {
    return this.segAtTick(tick).bpm;
  }

  /**
   * Change tempo at `time`: the tick reached at `time` is kept and the new
   * tempo applies from there. Segments that started at or after `time` are
   * replaced. Returns the new anchor.
   */
  reanchor(time: number, bpm: number): TempoAnchor {
    const t = Number.isFinite(time) ? time : this.anchor.time;
    const tick = this.tickAt(t);
    const next: TempoAnchor = { time: t, tick, bpm: clampBpm(bpm) };
    const keep = this.segs.filter((s) => s.time < t);
    this.segs = keep.length ? [...keep, next] : [next];
    return { ...next };
  }

  /** Change tempo at a musical position (exact tick kept, e.g. a recorded tempo event). */
  reanchorAtTick(tick: number, bpm: number): TempoAnchor {
    const time = this.timeAt(tick);
    const next: TempoAnchor = { time, tick, bpm: clampBpm(bpm) };
    const keep = this.segs.filter((s) => s.time < time);
    this.segs = keep.length ? [...keep, next] : [next];
    return { ...next };
  }

  /** Drop segments that ended before `time` (the one in effect at `time` stays). */
  prune(time: number): void {
    let first = 0;
    while (first + 1 < this.segs.length && this.segs[first + 1].time <= time) first++;
    if (first > 0) this.segs = this.segs.slice(first);
  }
}

/** Alias: the transport clock is a tempo map. */
export { TempoMap as Clock };
