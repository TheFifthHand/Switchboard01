/**
 * Offline rendering: the same Sequencer and engine as playback, on an
 * OfflineAudioContext, so an export sounds like what was played.
 *
 * The render is scheduled chunk by chunk with `ctx.suspend()`: at each chunk
 * boundary the sequencer generates everything up to the next boundary plus a
 * look-ahead, progress is reported and cancellation is checked. All engine
 * calls happen at fixed render positions, so rendering the same request twice
 * gives bit-identical output (given a deterministic engine).
 *
 * Exports (`align`): the music starts RENDER_START_OFFSET into the render and
 * every sound leaves the engine its output latency later (the limiter's
 * look-ahead and the module latency every audible part has). Both are cut
 * from the start, and as much more is rendered at the end, so musical time 0
 * is sample 0 and the file is exactly the music plus the tail: a one-bar loop
 * export repeats cleanly in another app. `mastering: false` renders with the
 * project's mastering chain off; the output limiter and its ceiling stay.
 */
import type { AudioEngineApi } from '../audio/contracts';
import { truePeakKernels } from '../audio/worklets/loudness';
import { engineLatencyFrames } from '../audio/worklets/limiter';
import { MAX_SONG_BARS, TICKS_PER_BAR, type Id, type LauncherSnapshotEntry, type PerformanceEvent, type Project } from '../project/types';
import { TempoMap, clampBpm, ticksToSeconds } from '../time/clock';
import type { StartOptions } from '../time/contracts';
import { Sequencer, songLengthTicks } from '../time/sequencer';
import { projectFromSnapshot } from '../time/snapshot';
import { EngineDispatcher } from '../time/transport';
import { measureLoudness } from './loudness';

export type RenderSource =
  /** The whole song: bar 1 to its end, plus the tail. */
  | { kind: 'song' }
  /**
   * Part of the song: bars [fromBar, toBar) played once, as the song plays
   * them there (a song loop, exported once), plus the tail.
   */
  | { kind: 'songRange'; fromBar: number; toBar: number }
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
  /**
   * An export: the start offset and the engine's output latency are cut from
   * the start (and rendered extra at the end), so musical time 0 is sample 0
   * and the buffer is exactly `fileSeconds` long. Default false: the raw
   * render (`totalSeconds`, the music starting RENDER_START_OFFSET in).
   */
  align?: boolean;
  /** False: render with the project's mastering off (the limiter and ceiling stay). Default true. */
  mastering?: boolean;
}

export interface RenderPlan {
  /** Length of the music (start tick to end tick) in seconds. */
  musicSeconds: number;
  /** Rendered length: start offset + music + tail. */
  totalSeconds: number;
  /** Length of an exported file (an aligned render): music + tail. */
  fileSeconds: number;
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

/** The bars a song range covers, whole bars inside the song's range. */
function songRange(source: { fromBar: number; toBar: number }): { fromBar: number; toBar: number } {
  const from = Number.isFinite(source.fromBar) ? Math.max(0, Math.round(source.fromBar)) : 0;
  const to = Number.isFinite(source.toBar) ? Math.min(MAX_SONG_BARS, Math.round(source.toBar)) : 0;
  if (to <= from) throw new Error('Choose at least one bar of the song to export.');
  return { fromBar: from, toBar: to };
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
    case 'songRange': {
      const r = songRange(source);
      startTick = r.fromBar * TICKS_PER_BAR;
      endTick = r.toBar * TICKS_PER_BAR;
      musicSeconds = ticksToSeconds(endTick - startTick, bpm);
      break;
    }
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
  return { musicSeconds, totalSeconds: RENDER_START_OFFSET + musicSeconds + tail, fileSeconds: musicSeconds + tail, startTick, endTick };
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
      return { opts: { mode: { kind: 'song', fromBar: 0 } }, endTick: null };
    case 'songRange': {
      // The song from the range's first bar (every part as the song plays it there, in phase), ending at its last.
      const r = songRange(source);
      return { opts: { mode: { kind: 'song', fromBar: r.fromBar } }, endTick: r.toBar * TICKS_PER_BAR };
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
  const align = !!req.align;
  // An export renders as much more at the end as it cuts from the start (at most the engine's whole latency).
  const extraFrames = align ? engineLatencyFrames(sampleRate) + 1 : 0;
  const total = plan.totalSeconds + extraFrames / sampleRate;

  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(plan.totalSeconds * sampleRate) + extraFrames), sampleRate);
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
    let playProject = source.kind === 'performance' ? projectFromSnapshot(project, findPerformance(project, source.performanceId).snapshot) : project;
    if (req.mastering === false && playProject.mastering?.enabled) playProject = { ...playProject, mastering: { ...playProject.mastering, enabled: false } };
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
  // What the export cuts from the start: the start offset plus the output latency of this project's engine.
  const latency = (engine as AudioEngineApi & { outputLatencyFrames?: () => number }).outputLatencyFrames?.() ?? engineLatencyFrames(sampleRate);
  const cut = Math.round(RENDER_START_OFFSET * sampleRate) + Math.max(0, Math.min(engineLatencyFrames(sampleRate), Math.round(latency)));
  try {
    const rendered = await Promise.race([rendering, abortPromise]);
    if (scheduler.errors.length) throw scheduler.errors[0];
    const buffer = align ? trimStart(rendered, cut, Math.max(1, Math.round(plan.fileSeconds * sampleRate))) : rendered;
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

/** `length` frames of `buf` from frame `start` (silence past its end). */
function trimStart(buf: AudioBuffer, start: number, length: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length, sampleRate: buf.sampleRate });
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    out.copyToChannel(src.subarray(Math.min(start, src.length), Math.min(src.length, start + length)), ch);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Loudness report                                                     */
/* ------------------------------------------------------------------ */

export interface ExportReport {
  /** Gated integrated loudness, LUFS (−Infinity for silence). */
  integratedLufs: number;
  /** Highest true peak, dBTP (4× oversampled, the meter's kernels). */
  truePeakDb: number;
  /** Highest sample peak, dBFS. */
  samplePeakDb: number;
  /** Length in seconds. */
  seconds: number;
}

/**
 * Loudness of a rendered export (render/loudness: BS.1770 integrated
 * loudness, sample and true peak). The true peak is searched only around
 * samples loud enough to make an interpolated point exceed the sample peak
 * (exact: no interpolated value can exceed Σ|kernel| times its loudest
 * neighbour), yielding to the main thread between slices of a long song.
 */
export async function measureExport(buffer: AudioBuffer, opts: { sliceFrames?: number } = {}): Promise<ExportReport> {
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const m = measureLoudness(L, R, buffer.sampleRate, { truePeak: false });
  const sp = m.samplePeakDb > -Infinity ? Math.pow(10, m.samplePeakDb / 20) : 0;
  let tp = sp;
  if (sp > 0) {
    const kernels = truePeakKernels().map((k) => Float64Array.from(k));
    const len = kernels[0].length;
    const half = len / 2;
    let bound = 0;
    for (const k of kernels) bound = Math.max(bound, k.reduce((a, v) => a + Math.abs(v), 0));
    const threshold = sp / bound;
    const slice = Math.max(4096, opts.sliceFrames ?? 1 << 18);
    for (const x of R ? [L, R] : [L]) {
      const n = x.length;
      // Points between x[i] and x[i + 1], i from -1 to n - 1; window x[i - half + 1 .. i + half].
      let done = -2;
      for (let h = 0; h < n; h++) {
        if (h % slice === slice - 1) await new Promise((r) => setTimeout(r, 0));
        if (Math.abs(x[h]) < threshold) continue;
        const last = Math.min(n - 1, h + half - 1);
        for (let i = Math.max(done + 1, h - half); i <= last; i++) {
          const base = i - half + 1;
          for (const k of kernels) {
            let v = 0;
            for (let j = 0; j < len; j++) {
              const idx = base + j;
              if (idx >= 0 && idx < n) v += k[j] * x[idx];
            }
            const a = v < 0 ? -v : v;
            if (a > tp) tp = a;
          }
        }
        done = Math.max(done, last);
      }
    }
  }
  return {
    integratedLufs: m.integrated,
    truePeakDb: tp > 0 ? 20 * Math.log10(tp) : -Infinity,
    samplePeakDb: m.samplePeakDb,
    seconds: buffer.length / buffer.sampleRate,
  };
}
