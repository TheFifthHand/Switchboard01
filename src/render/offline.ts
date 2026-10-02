/**
 * Offline rendering: the same Sequencer and engine as playback, on an
 * OfflineAudioContext, so an export sounds like what was played.
 *
 * The render is scheduled chunk by chunk with `ctx.suspend()`: at each chunk
 * boundary the sequencer generates everything up to the next boundary plus a
 * look-ahead, progress is reported and cancellation is checked. All engine
 * calls happen at fixed render positions, so rendering the same request twice
 * gives bit-identical output (given a deterministic engine).
 */
import type { AudioEngineApi } from '../audio/contracts';
import { TICKS_PER_BAR, type Id, type LauncherSnapshotEntry, type PerformanceEvent, type Project } from '../project/types';
import { TempoMap, clampBpm, ticksToSeconds } from '../time/clock';
import type { StartOptions } from '../time/contracts';
import { Sequencer, songBlocks, songLengthTicks } from '../time/sequencer';
import { songLoopRange } from '../time/songLoop';
import { projectFromSnapshot } from '../time/snapshot';
import { EngineDispatcher } from '../time/transport';

export type RenderSource =
  | { kind: 'song' }
  /**
   * Part of the song: the blocks from `fromBlockId` to `toBlockId`
   * (inclusive, either way round, in the song's order) played once, as the
   * song plays them there (a song loop's blocks, exported once).
   */
  | { kind: 'songRange'; fromBlockId: Id; toBlockId: Id }
  | { kind: 'performance'; performanceId: Id }
  | { kind: 'scene'; row: number; bars: number }
  | { kind: 'launcher'; launcher: LauncherSnapshotEntry[]; bars: number };

export interface RenderRequest {
  project: Project;
  source: RenderSource;
  sampleRate: number;
  /** Seconds of release / effect tail after the music ends. */
  tailSeconds: number;
  createEngine: (ctx: OfflineAudioContext) => Promise<AudioEngineApi>;
  signal?: AbortSignal;
  /** 0..1 after each chunk, 1 when done. */
  onProgress?: (fraction: number) => void;
  /** Seconds rendered between scheduling passes (default 1). */
  chunkSeconds?: number;
}

export interface RenderPlan {
  /** Length of the music (start tick to end tick) in seconds. */
  musicSeconds: number;
  /** Rendered length: start offset + music + tail. */
  totalSeconds: number;
  startTick: number;
  endTick: number;
}

/** Music starts this long after the beginning of the file (identical for every render). */
export const RENDER_START_OFFSET = 0.005;
/** Events are generated this far past each chunk boundary. */
export const RENDER_LOOKAHEAD = 0.12;
const QUANTUM = 128;

function clampBars(bars: number): number {
  return Number.isFinite(bars) ? Math.max(1, Math.min(256, Math.round(bars))) : 1;
}

/** Where a song range starts and ends on the song timeline, and the block it starts with. */
function songRange(project: Project, source: { fromBlockId: Id; toBlockId: Id }): { startTick: number; endTick: number; fromBlock: number } {
  const lane = songBlocks(project);
  const r = songLoopRange(lane, { fromBlockId: source.fromBlockId, toBlockId: source.toBlockId });
  if (!r) throw new Error('Those blocks are no longer in the song');
  return { startTick: lane[r[0]].startTick, endTick: lane[r[1]].endTick, fromBlock: lane[r[0]].index };
}

function findPerformance(project: Project, id: Id) {
  const perf = project.performances.find((p) => p.id === id);
  if (!perf) throw new Error(`Performance "${id}" not found`);
  return perf;
}

/** Length and tick range of a render, including recorded tempo changes of a performance. */
export function computeRenderPlan(project: Project, source: RenderSource, tailSeconds: number = project.arrangement.tailSeconds): RenderPlan {
  const tail = Number.isFinite(tailSeconds) ? Math.max(0, tailSeconds) : 0;
  let startTick = 0;
  let endTick = 0;
  let musicSeconds = 0;
  // The sequencer plays at the clamped tempo; the plan must agree with it.
  const bpm = clampBpm(project.bpm);
  switch (source.kind) {
    case 'song':
      endTick = songLengthTicks(project);
      musicSeconds = ticksToSeconds(endTick, bpm);
      break;
    case 'songRange':
      ({ startTick, endTick } = songRange(project, source));
      musicSeconds = ticksToSeconds(endTick - startTick, bpm);
      break;
    case 'performance': {
      const perf = findPerformance(project, source.performanceId);
      startTick = perf.startTick;
      endTick = Math.max(perf.endTick, perf.startTick);
      const map = new TempoMap({ time: 0, tick: startTick, bpm: perf.snapshot.bpm });
      const tempos = perf.events
        .filter((e): e is Extract<PerformanceEvent, { type: 'tempo' }> => e.type === 'tempo' && e.t >= startTick && e.t < endTick)
        .sort((a, b) => a.t - b.t);
      for (const e of tempos) map.reanchorAtTick(e.t, e.bpm);
      musicSeconds = map.timeAt(endTick);
      break;
    }
    case 'scene':
    case 'launcher':
      endTick = clampBars(source.bars) * TICKS_PER_BAR;
      musicSeconds = ticksToSeconds(endTick, bpm);
      break;
  }
  return { musicSeconds, totalSeconds: RENDER_START_OFFSET + musicSeconds + tail, startTick, endTick };
}

function abortError(): Error {
  return new DOMException('Render cancelled', 'AbortError');
}

/**
 * Runs callbacks at render-quantum positions of an OfflineAudioContext. One
 * `suspend()` per quantum; callbacks may register later ones.
 */
class QuantumScheduler {
  private readonly slots = new Map<number, Array<() => void>>();
  private current = -1;
  private readonly lastQuantum: number;
  readonly errors: unknown[] = [];

  constructor(private readonly ctx: OfflineAudioContext) {
    this.lastQuantum = Math.floor((ctx.length - 1) / QUANTUM);
  }

  private quantum(time: number): number {
    return Math.floor((time * this.ctx.sampleRate) / QUANTUM);
  }

  at(time: number, fn: () => void): void {
    const q = this.quantum(time);
    if (q <= Math.max(this.current, 0)) {
      this.run(fn);
      return;
    }
    if (q > this.lastQuantum) return;
    let list = this.slots.get(q);
    if (!list) {
      list = [];
      this.slots.set(q, list);
      // suspend() times are quantized to render quanta (Chromium rounds up).
      // Half a quantum before boundary q lands exactly on q when rounding up,
      // on q - 1 when rounding down: never after the action's time, and one
      // distinct quantum per index either way.
      const when = (q * QUANTUM - QUANTUM / 2) / this.ctx.sampleRate;
      this.ctx
        .suspend(when)
        .then(
          () => {
            this.current = q;
            const fns = this.slots.get(q) ?? [];
            this.slots.delete(q);
            for (const f of fns) this.run(f);
            return this.ctx.resume();
          },
          (err: unknown) => {
            this.slots.delete(q);
            this.errors.push(err);
          },
        )
        .catch((err: unknown) => this.errors.push(err));
    }
    list.push(fn);
  }

  private run(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.errors.push(err);
    }
  }
}

function startOptions(project: Project, source: RenderSource): { opts: StartOptions; endTick: number | null } {
  switch (source.kind) {
    case 'song':
      return { opts: { mode: { kind: 'song', fromBlock: 0 } }, endTick: null };
    case 'songRange': {
      // The song from the range's first block (every part as the song plays it there), ending with its last.
      const r = songRange(project, source);
      return { opts: { mode: { kind: 'song', fromBlock: r.fromBlock } }, endTick: r.endTick };
    }
    case 'performance':
      return { opts: { mode: { kind: 'replay', performanceId: source.performanceId } }, endTick: null };
    case 'scene': {
      const launcher: LauncherSnapshotEntry[] = project.tracks.map((t) => ({
        trackId: t.id,
        playing: t.clips[source.row] ? { slot: source.row, startTick: 0 } : null,
      }));
      return { opts: { mode: { kind: 'live' }, fromTick: 0, launcher }, endTick: clampBars(source.bars) * TICKS_PER_BAR };
    }
    case 'launcher':
      return { opts: { mode: { kind: 'live' }, fromTick: 0, launcher: source.launcher }, endTick: clampBars(source.bars) * TICKS_PER_BAR };
  }
}

/** Render a song (or part of it), performance, scene or launcher state to a stereo AudioBuffer. */
export async function renderOffline(req: RenderRequest): Promise<AudioBuffer> {
  const { project, source, signal } = req;
  if (signal?.aborted) throw abortError();
  if (!Number.isFinite(req.sampleRate) || req.sampleRate < 8000) throw new RangeError(`Unsupported sample rate ${req.sampleRate}`);
  const plan = computeRenderPlan(project, source, req.tailSeconds);
  const sampleRate = req.sampleRate;
  const chunk = Math.max(QUANTUM / sampleRate, Number.isFinite(req.chunkSeconds) && req.chunkSeconds! > 0 ? req.chunkSeconds! : 1);
  const total = plan.totalSeconds;

  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * sampleRate)), sampleRate);
  const engine = await req.createEngine(ctx);
  let disposed = false;
  const disposeEngine = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      engine.dispose();
    } catch {
      // Already torn down.
    }
  };
  if (signal?.aborted) {
    disposeEngine();
    throw abortError();
  }

  const seq = new Sequencer({ getProject: () => project });
  const scheduler = new QuantumScheduler(ctx);
  let aborted = false;
  const progress = (f: number): void => {
    if (!req.onProgress) return;
    try {
      req.onProgress(Math.min(1, Math.max(0, f)));
    } catch (err) {
      scheduler.errors.push(err);
    }
  };
  try {
    const playProject = source.kind === 'performance' ? projectFromSnapshot(project, findPerformance(project, source.performanceId).snapshot) : project;
    engine.setProject(playProject);

    const dispatcher = new EngineDispatcher({
      engine,
      getProject: () => seq.activeProject(),
      metronome: () => false,
      countInClicks: false,
      at: (time, fn) => scheduler.at(time, fn),
      // At the end of the music the live transport stops (sampler one-shots end, the take's
      // automation hands back to the project's values); do the same so the tail matches.
      onEvent: (ev) => {
        if (ev.kind === 'end') scheduler.at(ev.time, () => engine.transportStopped(ev.time));
      },
    });

    const { opts, endTick } = startOptions(project, source);
    seq.start(RENDER_START_OFFSET, opts);
    if (endTick !== null) seq.setEndTick(endTick);
    engine.transportStarted(RENDER_START_OFFSET, seq.tickAt(RENDER_START_OFFSET), seq.bpm);

    const scheduleUntil = (time: number, now: number): void => {
      if (seq.ended) return;
      dispatcher.dispatch(seq.process(time));
      dispatcher.applyCuts(seq.takeCuts(), now);
      dispatcher.prune(now);
    };
    const step = (t: number): void => {
      if (aborted) return;
      scheduleUntil(t + chunk + RENDER_LOOKAHEAD, t);
      progress(t / total);
      const next = t + chunk;
      if (next < total) scheduler.at(next, () => step(next));
    };

    scheduleUntil(chunk + RENDER_LOOKAHEAD, 0);
    if (chunk < total) scheduler.at(chunk, () => step(chunk));
  } catch (err) {
    // Nothing is rendering yet: release the engine before failing.
    disposeEngine();
    throw err;
  }

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => {
      aborted = true;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // The offline context cannot be cancelled: after an abort it finishes rendering silence in the background.
  const rendering = ctx.startRendering().then(
    (buf) => {
      disposeEngine();
      return buf;
    },
    (err: unknown) => {
      disposeEngine();
      throw err;
    },
  );
  try {
    const buffer = await Promise.race([rendering, abortPromise]);
    if (scheduler.errors.length) throw scheduler.errors[0];
    progress(1);
    return buffer;
  } catch (err) {
    aborted = true;
    // Keep an unobserved rejection of the background render from surfacing.
    rendering.catch(() => {});
    throw err;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
