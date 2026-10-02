/**
 * AudioEngine: reconciles the Web Audio graph with the serializable Project
 * and executes timed calls from the sequencer.
 *
 * Graph:
 *   patch modules --(one GainNode per connection)--> ... --> master sum
 *   master sum -> volume -> song gain (song automation) -> mastering chain
 *              (Project.mastering) -> Mute All
 *              -> look-ahead true-peak limiter (worklet)
 *              -> safety clipper (WaveShaper, bounded to OUTPUT_CEILING) -> destination
 *   live meters on the final output: peak/RMS analysers, a BS.1770 loudness
 *   worklet (LUFS, true peak) and a spectrum analyser; a second loudness
 *   worklet on the mastering input while mastering is on (level-matched A/B);
 *   peak/RMS taps after the shared Reverb and Echo returns; gain reduction of
 *   every Compressor and Gate.
 *
 * The same class runs on an AudioContext (live) and an OfflineAudioContext
 * (export). Offline, nothing waits on wall-clock timers: rewiring and module
 * disposal happen immediately and no meter nodes are created.
 */
import type {
  AudioEngineApi,
  EngineOptions,
  EngineStats,
  InstrumentContext,
  InstrumentFactory,
  LevelReading,
  LoudnessReading,
  MeterFrame,
  NoteSample,
  NoteTrigger,
  PrepareOptions,
  VoiceHandle,
} from './contracts';
import { OUTPUT_CEILING, PREVIEW_KEY_PREFIXES } from './contracts';
import { PPQ, type Connection, type Id, type Instrument, type MacroId, type MacroTarget, type ModuleType, type ParamValues, type PatchModule, type PortKind, type Project, type Track } from '../project/types';
import { MODULE_DEFS, portDef } from '../project/modules';
import { BPM_SPEC, INSTRUMENT_PARAMS, MASTER_VOLUME_SPEC, MODULE_PARAMS, clampParam, dbToGain, specById, type ParamSpec } from '../project/params';
import { macroTargetValue, resolveAllParams } from '../project/resolve';
import { Rng, subSeed } from '../project/rng';
import { createModuleNode } from './modules/index';
import { InstrumentModule } from './modules/instrument';
import { ChannelModule, type ChannelMeterReading } from './modules/channel';
import { LfoModule } from './modules/lfo';
import { measureFeedbackCycleLatency } from './modules/delay';
import { MasterModule, scheduleClickVoice, stopClickVoice, type ClickVoice } from './modules/master';
import { PARAM_SMOOTHING, REWIRE_RAMP, type ModuleEnv, type ModuleNode } from './modules/types';
import { LIMITER_PROCESSOR_NAME, LIMITER_WORKLET_SOURCE, limiterLatencyFrames, limiterProcessorOptions, safetyClipperCurve } from './worklets/limiter';
import { CRUSHER_WORKLET_SOURCE } from './worklets/crusher';
import { DYNAMICS_WORKLET_SOURCE } from './worklets/dynamics';
import { FX_WORKLET_SOURCE } from './worklets/fx';
import { MASTERING_WORKLET_SOURCE } from './worklets/mastering';
import { LOUDNESS_PROCESSOR_NAME, LOUDNESS_WORKLET_SOURCE, loudnessProcessorOptions } from './worklets/loudness';
import { MasteringChain } from './modules/mastering';
import { createInstrumentEngine } from './instruments/index';
import { DELAY_ID, REVERB_ID, moduleId as trackModuleId } from '../project/factory';
import { DRIVE_LATENCY_FRAMES } from './modules/drive';
import { CompressorModule } from './modules/compressor';
import { GateModule } from './modules/gate';
import { SPECTRUM_HIGH_HZ as BAND_HIGH_HZ, SPECTRUM_LOW_HZ as BAND_LOW_HZ, spectrumBandMap, spectrumBands } from './spectrum';

/** Mute All fade-out. */
export const MUTE_RAMP = 0.008;
/** Fade back in after Mute All is released. */
export const UNMUTE_RAMP = 0.02;
/** Output dip used to make a panic stop click-free. */
const PANIC_RAMP = 0.006;
/** Wall-clock margin after a gain ramp before nodes are disconnected. */
const TIMER_MARGIN_MS = 40;
/** Seconds of shared white noise handed to instruments. */
const NOISE_SECONDS = 2;
const MASTER_METER_FFT = 1024;
/**
 * Spectrum analyser size (11.7 Hz bins at 48 kHz; bands narrower than a bin
 * read their share of the interpolated density, src/audio/spectrum.ts). Half
 * the cost of the 8192-point FFT it replaced; on pink noise its bands read
 * within 0.5 dB of the 8192-point ones from 60 Hz, within 1 dB below
 * (tests/unit/r4-engine-spectrum).
 */
export const SPECTRUM_FFT = 4096;
/** Lowest and highest edge of the readSpectrum bands. */
export const SPECTRUM_LOW_HZ = BAND_LOW_HZ;
export const SPECTRUM_HIGH_HZ = BAND_HIGH_HZ;
/** Pitch bend is clamped to ±2 octaves (the glide is the instrument module's BEND_TAU). */
export const PITCH_BEND_MAX_CENTS = 2400;
/** Glide of a song-gain step without a ramp (seconds). */
export const SONG_GAIN_STEP = 0.005;
/** Largest song gain (linear). */
export const SONG_GAIN_MAX = 4;
/** Return to unity of the song gain when a new playback starts (seconds). */
const SONG_GAIN_RESET = 0.02;
/** Macro ramps on curved mappings are set in steps at most this far apart (seconds). */
export const MACRO_RAMP_STEP = 0.01;
/** Level-matched A/B: the comparison never shifts levels by more than this (dB). */
export const COMPARE_MAX_DB = 12;
/** Level-matched A/B: the boost may add at most this much limiter gain reduction (dB). */
export const COMPARE_MAX_EXTRA_LIMITING_DB = 1.5;
/** Level-matched A/B: below this short-term loudness (LUFS) nothing much plays, and levels are left alone. */
export const COMPARE_MIN_LUFS = -60;
const CEILING_DB = 20 * Math.log10(OUTPUT_CEILING);
const RETURN_METER_FFT = 1024;

/* ------------------------------------------------------------------ */
/* Worklets                                                            */
/* ------------------------------------------------------------------ */

const workletLoads = new WeakMap<BaseAudioContext, Promise<void>>();

async function addWorkletSource(ctx: BaseAudioContext, source: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Load the engine's AudioWorklet processors (limiter, crusher, dynamics,
 * flanger / tape, mastering, loudness meter) into `ctx` once. Concurrent and
 * repeated calls share the same promise; a failed load can be retried.
 */
export function loadEngineWorklets(ctx: BaseAudioContext): Promise<void> {
  let p = workletLoads.get(ctx);
  if (!p) {
    if (!ctx.audioWorklet) {
      return Promise.reject(new Error('AudioWorklet is not available (a secure context is required).'));
    }
    p = Promise.all(
      [LIMITER_WORKLET_SOURCE, CRUSHER_WORKLET_SOURCE, DYNAMICS_WORKLET_SOURCE, FX_WORKLET_SOURCE, MASTERING_WORKLET_SOURCE, LOUDNESS_WORKLET_SOURCE].map((src) =>
        addWorkletSource(ctx, src),
      ),
    ).then(() => undefined);
    workletLoads.set(ctx, p);
    p.catch(() => {
      if (workletLoads.get(ctx) === p) workletLoads.delete(ctx);
    });
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function sameParams(a: ParamValues, b: ParamValues): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Freeze an AudioParam at `time` (= now) so a new ramp starts from its actual
 * value. An explicit setValueAtTime anchor is required: a linear ramp always
 * starts at the previous event, and cancelAndHoldAtTime inserts no event when
 * no ramp is in progress, so a later ramp would start in the past.
 */
function holdAt(param: AudioParam, time: number): void {
  const v = param.value;
  param.cancelScheduledValues(time);
  param.setValueAtTime(Number.isFinite(v) ? v : 0, time);
}

function isOfflineContext(ctx: BaseAudioContext): boolean {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
}

function liveKey(trackId: Id, key: string): string {
  return `${trackId}\u0000${key}`;
}

function isPreviewKey(key: string): boolean {
  return PREVIEW_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/** Let go of a live note: an editor preview stops outright, anything else releases (a one-shot plays on). */
function letGo(handle: VoiceHandle, key: string, time: number): void {
  if (handle.stop && isPreviewKey(key)) handle.stop(time);
  else handle.release(time);
}

interface ModRec {
  id: Id;
  type: ModuleType;
  trackId: Id | undefined;
  node: ModuleNode;
  /** Last resolved values from the project (no automation). */
  projParams: ParamValues;
  /** Last values handed to the node (project + automation overlay). */
  applied: ParamValues;
  bypass: boolean;
  /** Instrument modules: the Track.instrument object last applied. */
  instRef: Instrument | null;
}

interface ConnRec {
  id: Id;
  kind: PortKind;
  fromAudio: AudioNode;
  toAudio: AudioNode;
  gain: GainNode;
  target: number;
}

interface DesiredConn {
  kind: PortKind;
  fromAudio: AudioNode;
  toAudio: AudioNode;
  target: number;
}

interface AutoPoint {
  time: number;
  value: number;
}

interface LiveNote {
  trackId: Id;
  key: string;
  handle: VoiceHandle;
}

/** A point of the running transport's tempo map: transport `tick` at context `time`. */
interface TransportAnchor {
  time: number;
  tick: number;
  bpm: number;
}

/** A scheduled macro ramp on one module param (it owns the param until t1). */
interface ParamRamp {
  t0: number;
  t1: number;
  /** The param's value along the ramp (macro space interpolated, then mapped). */
  valueAt(time: number): number;
}

/** One segment of the song gain: v0 at t0, moving linearly to v1 at t1 (t1 = t0 for a step). */
interface GainSegment {
  t0: number;
  v0: number;
  t1: number;
  v1: number;
}

/** Peak/RMS taps after a shared return's output. */
interface ReturnTap {
  node: ModuleNode;
  split: ChannelSplitterNode;
  left: AnalyserNode;
  right: AnalyserNode;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class AudioEngine implements AudioEngineApi {
  /**
   * Create an engine with its worklets loaded (and the browser's
   * feedback-cycle latency measured once, so delay echoes are exact from the
   * first render). Shape-compatible with EngineFactory.
   */
  static async create(ctx: BaseAudioContext, opts: EngineOptions): Promise<AudioEngine> {
    await Promise.all([loadEngineWorklets(ctx), measureFeedbackCycleLatency()]);
    return new AudioEngine(ctx, opts);
  }

  readonly ctx: BaseAudioContext;
  readonly output: AudioNode;

  private readonly offline: boolean;
  private readonly meters: boolean;
  private readonly instrumentFactory: InstrumentFactory;
  private readonly ictx: InstrumentContext;

  private readonly volume: GainNode;
  /** Song automation stage (fades): unity unless scheduleSongGain is used. */
  private readonly songGain: GainNode;
  private songSegs: GainSegment[] = [];
  private readonly mastering: MasteringChain;
  private readonly muteGain: GainNode;
  private readonly limiter: AudioWorkletNode;
  private readonly safety: WaveShaperNode;
  private readonly meterSplit: ChannelSplitterNode | null = null;
  private readonly meterL: AnalyserNode | null = null;
  private readonly meterR: AnalyserNode | null = null;
  private readonly meterBuf: Float32Array<ArrayBuffer> | null = null;
  private readonly channelReading: ChannelMeterReading = { peak: 0, rms: 0 };
  private limiterReductionDb = 0;
  private glueReductionDb = 0;
  private readonly loudnessNode: AudioWorkletNode | null = null;
  private readonly loudness: LoudnessReading = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, truePeakDb: -Infinity };
  private readonly spectrum: AnalyserNode | null = null;
  private readonly spectrumBuf: Float32Array<ArrayBuffer> | null = null;
  private readonly spectrumPower: Float64Array | null = null;
  /** Loudness of the mastering input (level-matched A/B), connected only while mastering is on. */
  private readonly preLoudnessNode: AudioWorkletNode | null = null;
  private preLoudnessOn = false;
  private preShortTerm = -Infinity;
  /** Highest sample peak at the mastering input over the last 3 s (linear). */
  private prePeak = 0;
  /** Gain (dB) on the un-mastered sound while an A/B comparison is on. */
  private compareTrimDb = 0;
  private masteringListen = false;
  /** Meter taps after the shared returns, by return. */
  private readonly returnTaps = new Map<'reverb' | 'delay', ReturnTap>();
  private returnBuf: Float32Array<ArrayBuffer> | null = null;
  private readonly returnReading: LevelReading = { peak: 0, rms: 0 };
  /** Sampler notes skipped because their recording was not loaded. */
  private skippedSampleNotes = 0;
  /** Macro ramps in force: module id -> param -> ramp. */
  private readonly ramps = new Map<Id, Map<string, ParamRamp>>();
  /** Drum kit last prepared per track (a new kit starts an idle preload). */
  private readonly preparedKits = new Map<Id, string>();
  /** Pitch bend per part (cents), re-applied when an instrument module is rebuilt. */
  private readonly bends = new Map<Id, number>();

  private project: Project | null = null;
  private bpm = BPM_SPEC.default;
  private muted = false;
  private disposed = false;

  private readonly mods = new Map<Id, ModRec>();
  private readonly conns = new Map<Id, ConnRec>();
  /** Connections ramping out before disconnect. */
  private readonly fadingConns = new Set<ConnRec>();
  /** Modules removed from the patch, waiting for their connections to fade. */
  private readonly retiredMods = new Set<ModuleNode>();

  private instByTrack = new Map<Id, InstrumentModule>();
  private channelByTrack = new Map<Id, ChannelModule>();
  private channels: ChannelModule[] = [];
  private lfos: LfoModule[] = [];
  private master: MasterModule | null = null;
  /** Clicks played without a master module (fallback straight into the volume stage). */
  private readonly looseClicks = new Set<ClickVoice>();

  /** Automation overlay: module id -> param -> scheduled points (time ascending). */
  private readonly overlay = new Map<Id, Map<string, AutoPoint[]>>();
  /** Timed mute automation per track (time ascending), for cancellation. */
  private readonly muteAuto = new Map<Id, { time: number; mute: boolean }[]>();
  /** Timed master volume automation (time ascending), for cancellation. */
  private masterAuto: { time: number; db: number }[] = [];
  private readonly live = new Map<string, LiveNote>();
  /** Live one-shots let go of but still playing out their sound: Stop (releaseLive) ends them. */
  private readonly playingOn = new Set<LiveNote>();
  /**
   * Tempo map of the running transport (null while stopped), so modules
   * created during playback (an LFO patched in, an undo restoring one) start
   * phase-aligned instead of free-running.
   */
  private transport: TransportAnchor[] | null = null;

  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private timerSeq = 0;
  private flushTimer: number | null = null;
  private flushAfter: (() => void) | null = null;

  private readonly setTimerFn = (fn: () => void, ms: number): number => this.setTimer(fn, ms);
  private readonly clearTimerFn = (id: number): void => this.clearTimer(id);

  private constructor(ctx: BaseAudioContext, opts: EngineOptions) {
    this.ctx = ctx;
    this.offline = isOfflineContext(ctx);
    this.meters = !!opts.meters && !this.offline;
    this.instrumentFactory = opts.instrumentFactory ?? createInstrumentEngine;

    // Shared seeded white noise for instruments.
    const noiseLen = Math.max(1, Math.round(ctx.sampleRate * NOISE_SECONDS));
    const noise = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    const rng = new Rng(subSeed(finiteOr(opts.seed, 0) >>> 0, 'engine:noise'));
    for (let i = 0; i < noiseLen; i++) nd[i] = rng.noise();
    this.ictx = {
      ctx,
      samples: opts.samples,
      noise,
      getBpm: () => this.bpm,
      noteSkipped: () => {
        this.skippedSampleNotes++;
      },
      offline: this.offline,
    };

    // Output chain.
    this.volume = ctx.createGain();
    this.volume.gain.value = dbToGain(MASTER_VOLUME_SPEC.default);
    this.songGain = ctx.createGain();
    this.songGain.gain.value = 1;
    this.muteGain = ctx.createGain();
    this.muteGain.gain.value = 1;
    this.limiter = new AudioWorkletNode(ctx, LIMITER_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: limiterProcessorOptions(this.offline),
    });
    this.limiter.port.onmessage = (e: MessageEvent) => {
      const db = typeof e.data === 'number' && Number.isFinite(e.data) ? e.data : 0;
      this.limiterReductionDb = Math.max(0, db);
    };
    this.safety = ctx.createWaveShaper();
    this.safety.curve = safetyClipperCurve();
    this.safety.oversample = 'none';
    this.mastering = new MasteringChain(ctx, this.meters ? { onGlueReduction: (db) => (this.glueReductionDb = db) } : {});
    this.volume.connect(this.songGain);
    this.songGain.connect(this.mastering.input);
    this.mastering.output.connect(this.muteGain);
    this.muteGain.connect(this.limiter);
    this.limiter.connect(this.safety);
    this.safety.connect(ctx.destination);
    this.output = this.safety;

    if (this.meters) {
      this.meterSplit = ctx.createChannelSplitter(2);
      this.meterL = ctx.createAnalyser();
      this.meterR = ctx.createAnalyser();
      this.meterL.fftSize = MASTER_METER_FFT;
      this.meterR.fftSize = MASTER_METER_FFT;
      this.meterBuf = new Float32Array(MASTER_METER_FFT);
      this.safety.connect(this.meterSplit);
      this.meterSplit.connect(this.meterL, 0);
      this.meterSplit.connect(this.meterR, 1);

      // Loudness (BS.1770) of the final output. Its output is silent; it is
      // connected to the destination only so the graph keeps pulling it.
      this.loudnessNode = new AudioWorkletNode(ctx, LOUDNESS_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: loudnessProcessorOptions(ctx.sampleRate, true),
      });
      this.loudnessNode.port.onmessage = (e: MessageEvent) => this.onLoudness(e.data);
      this.safety.connect(this.loudnessNode);
      this.loudnessNode.connect(ctx.destination);

      this.spectrum = ctx.createAnalyser();
      this.spectrum.fftSize = SPECTRUM_FFT;
      this.spectrum.smoothingTimeConstant = 0.75;
      this.spectrumBuf = new Float32Array(SPECTRUM_FFT / 2);
      this.spectrumPower = new Float64Array(SPECTRUM_FFT / 2);
      this.safety.connect(this.spectrum);

      // Loudness of the mastering input, for the level-matched A/B (connected while mastering is on).
      this.preLoudnessNode = new AudioWorkletNode(ctx, LOUDNESS_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: loudnessProcessorOptions(ctx.sampleRate, true),
      });
      this.preLoudnessNode.port.onmessage = (e: MessageEvent) => this.onPreLoudness(e.data);
    }
  }

  private onPreLoudness(data: unknown): void {
    if (!this.preLoudnessOn || !data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    this.preShortTerm = typeof d.s === 'number' && !Number.isNaN(d.s) ? d.s : -Infinity;
    this.prePeak = typeof d.pk === 'number' && Number.isFinite(d.pk) ? Math.max(0, d.pk) : 0;
  }

  /** Run the mastering-input loudness tap only while mastering is on. */
  private setPreLoudness(on: boolean): void {
    const node = this.preLoudnessNode;
    if (!node || on === this.preLoudnessOn || this.disposed) return;
    this.preLoudnessOn = on;
    if (on) {
      this.songGain.connect(node);
      node.connect(this.ctx.destination);
    } else {
      try {
        this.songGain.disconnect(node);
      } catch {
        // not connected
      }
      node.disconnect();
      this.preShortTerm = -Infinity;
      this.prePeak = 0;
    }
  }

  private onLoudness(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && !Number.isNaN(v) ? v : -Infinity);
    this.loudness.momentary = num(d.m);
    this.loudness.shortTerm = num(d.s);
    this.loudness.integrated = num(d.i);
    this.loudness.truePeakDb = num(d.tp);
  }

  /* ---------------------------------------------------------------- */
  /* Timers                                                            */
  /* ---------------------------------------------------------------- */

  private setTimer(fn: () => void, ms: number): number {
    const id = ++this.timerSeq;
    if (this.disposed) return id;
    const handle = setTimeout(
      () => {
        this.timers.delete(id);
        if (!this.disposed) fn();
      },
      Math.max(0, finiteOr(ms, 0)),
    );
    this.timers.set(id, handle);
    return id;
  }

  private clearTimer(id: number): void {
    const h = this.timers.get(id);
    if (h !== undefined) {
      clearTimeout(h);
      this.timers.delete(id);
    }
  }

  private envFor(project: Project, moduleIdStr: Id): ModuleEnv {
    return {
      ctx: this.ctx,
      seed: subSeed(finiteOr(project.seed, 0) >>> 0, moduleIdStr),
      getBpm: () => this.bpm,
      instrumentFactory: this.instrumentFactory,
      instrumentContext: this.ictx,
      setTimer: this.setTimerFn,
      clearTimer: this.clearTimerFn,
      offline: this.offline,
      engine: this,
    };
  }

  private now(): number {
    return this.ctx.currentTime;
  }

  /* ---------------------------------------------------------------- */
  /* Project reconciliation                                            */
  /* ---------------------------------------------------------------- */

  setProject(project: Project): void {
    if (this.disposed || !project || project === this.project) return;
    const prev = this.project;
    const now = this.now();
    const first = prev === null;

    if (first || project.bpm !== prev.bpm) {
      const bpm = clampParam(BPM_SPEC, project.bpm);
      if (first) this.bpm = bpm;
      // The transport usually reports the same change (at its own, exact
      // time) before the store update arrives here: do not apply it twice.
      else if (bpm !== this.bpm) this.tempoChanged(bpm, now);
    }

    const seedChanged = !first && project.seed !== prev.seed;
    const patchChanged = first || seedChanged || project.patch !== prev.patch;
    const tracksChanged = first || project.tracks !== prev.tracks;
    const paramsChanged = patchChanged || (tracksChanged && this.trackSoundChanged(prev, project));

    let resolved: Map<Id, ParamValues> | null = null;
    const getResolved = (): Map<Id, ParamValues> => (resolved ??= resolveAllParams(project));

    let created = new Set<Id>();
    if (patchChanged) created = this.reconcileModules(project, getResolved(), seedChanged, now);
    this.project = project;
    if (paramsChanged) this.applyParams(project, getResolved(), now);
    if (patchChanged) this.reconcileConnections(project, now, first);
    if (tracksChanged || patchChanged) this.applyAudible(project, now, first, created);

    if (first) {
      this.volume.gain.value = dbToGain(clampParam(MASTER_VOLUME_SPEC, project.masterVolumeDb));
    } else if (project.masterVolumeDb !== prev.masterVolumeDb) {
      this.setMasterVolume(project.masterVolumeDb);
    }
    if (first || project.mastering !== prev.mastering) {
      this.mastering.set(project.mastering, now, first);
      this.setPreLoudness(this.mastering.isOn);
      if (this.masteringListen) this.applyCompareTrim(now);
    }
    if (patchChanged) this.attachReturnTaps();
    if (!first && (tracksChanged || patchChanged)) this.preloadChangedKits(project);
  }

  /* ---------------------------------------------------------------- */
  /* Instrument preparation                                            */
  /* ---------------------------------------------------------------- */

  /** Drum slots a track's clips play, most-played first. */
  private drumOrder(track: Track): number[] {
    const counts = new Map<number, number>();
    for (const clip of track.clips) {
      if (!clip) continue;
      for (const n of clip.notes) counts.set(n.pitch, (counts.get(n.pitch) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([slot]) => slot);
  }

  /** A drum part whose kit changed renders its new voices in idle time, before notes reach them (live engines). */
  private preloadChangedKits(project: Project): void {
    if (this.offline) return;
    for (const track of project.tracks) {
      const inst = track.instrument;
      if (inst.kind !== 'drums') {
        this.preparedKits.delete(track.id);
        continue;
      }
      if (this.preparedKits.get(track.id) === inst.kitId) continue;
      this.preparedKits.set(track.id, inst.kitId);
      void this.instByTrack.get(track.id)?.prepare({ incremental: true, order: this.drumOrder(track) });
    }
  }

  /**
   * Warm every instrument's caches outside the scheduling path: drum kit
   * voices (~10 ms each), sampler loop buffers. Without options it does it
   * all now (~50-300 ms of CPU), as before. `{ incremental: true }` does it
   * in idle slices of at most 8 ms, the drum voices the project's clips play
   * first (`scope: 'used'` stops there); the promise resolves when done.
   * Offline engines always prepare at once.
   */
  prepareInstruments(opts: PrepareOptions = {}): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const incremental = !!opts.incremental && !this.offline;
    const jobs: Promise<void>[] = [];
    const tracks = new Map((this.project?.tracks ?? []).map((t) => [t.id, t]));
    for (const rec of this.mods.values()) {
      if (!(rec.node instanceof InstrumentModule)) continue;
      const track = rec.trackId ? tracks.get(rec.trackId) : undefined;
      if (track?.instrument.kind === 'drums') this.preparedKits.set(track.id, track.instrument.kitId);
      const order = track && track.instrument.kind === 'drums' ? this.drumOrder(track) : undefined;
      const r = rec.node.prepare({ ...opts, incremental, order });
      if (r) jobs.push(r);
    }
    return Promise.all(jobs).then(() => undefined);
  }

  /**
   * Load recordings that sampler notes name (NoteTrigger.sample) through the
   * SampleProvider, one at a time with a yield between them. Never rejects.
   */
  async preloadSamples(ids: readonly string[]): Promise<void> {
    const provider = this.ictx.samples;
    for (const id of new Set(ids)) {
      if (this.disposed) return;
      if (typeof id !== 'string' || !id) continue;
      try {
        if (provider.load) await provider.load(id);
        else provider.get(id);
      } catch {
        // A recording that cannot load stays unavailable: its notes are skipped and counted.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  /** True when any track's sound-relevant data (instrument, macros, mapping) changed. */
  private trackSoundChanged(prev: Project, next: Project): boolean {
    if (prev.tracks.length !== next.tracks.length) return true;
    for (let i = 0; i < next.tracks.length; i++) {
      const a = prev.tracks[i];
      const b = next.tracks[i];
      if (a === b) continue;
      if (a.id !== b.id || a.instrument !== b.instrument || a.macros !== b.macros || a.macroMap !== b.macroMap) return true;
    }
    return false;
  }

  /** Create / dispose module nodes. Returns the ids created in this pass. */
  private reconcileModules(project: Project, resolved: Map<Id, ParamValues>, recreateAll: boolean, now: number): Set<Id> {
    const next = new Map<Id, PatchModule>();
    for (const m of project.patch.modules) {
      if (m && typeof m.id === 'string' && MODULE_DEFS[m.type] && !next.has(m.id)) next.set(m.id, m);
    }

    for (const [id, rec] of this.mods) {
      const m = next.get(id);
      if (recreateAll || !m || m.type !== rec.type || m.trackId !== rec.trackId) {
        this.mods.delete(id);
        this.overlay.delete(id);
        this.retireModule(rec.node);
      }
    }

    const created = new Set<Id>();
    for (const m of next.values()) {
      const existing = this.mods.get(m.id);
      if (existing) {
        const bypass = !!m.bypass;
        if (bypass !== existing.bypass) {
          existing.bypass = bypass;
          existing.node.setBypass(bypass, now);
        }
        continue;
      }
      const params = { ...(resolved.get(m.id) ?? m.params ?? {}) };
      let node: ModuleNode;
      try {
        node = createModuleNode(this.envFor(project, m.id), { ...m, params });
      } catch (err) {
        console.error(`Module ${m.id} (${m.type}) could not be created`, err);
        continue;
      }
      if (m.bypass) node.setBypass(true, now);
      if (node instanceof ChannelModule && this.meters) node.enableMeter();
      if (node instanceof InstrumentModule && m.trackId && this.bends.has(m.trackId)) node.setPitchBend(this.bends.get(m.trackId)!, now);
      if (node instanceof MasterModule) node.output('out')?.connect(this.volume);
      this.alignToTransport(node, now);
      this.mods.set(m.id, {
        id: m.id,
        type: m.type,
        trackId: m.trackId,
        node,
        projParams: params,
        applied: params,
        bypass: !!m.bypass,
        instRef: null,
      });
      created.add(m.id);
    }

    this.rebuildIndexes(project);
    return created;
  }

  /** Meter taps after the shared Reverb and Echo returns (live meters), following module rebuilds. */
  private attachReturnTaps(): void {
    if (!this.meters) return;
    for (const [key, id] of [
      ['reverb', REVERB_ID],
      ['delay', DELAY_ID],
    ] as const) {
      const node = this.mods.get(id)?.node ?? null;
      const tap = this.returnTaps.get(key);
      if (tap && tap.node === node) continue;
      if (tap) {
        try {
          tap.node.output('out')?.disconnect(tap.split);
        } catch {
          // module already disposed
        }
        tap.split.disconnect();
        this.returnTaps.delete(key);
      }
      const out = node?.output('out');
      if (!node || !out) continue;
      const split = this.ctx.createChannelSplitter(2);
      const left = this.ctx.createAnalyser();
      const right = this.ctx.createAnalyser();
      left.fftSize = RETURN_METER_FFT;
      right.fftSize = RETURN_METER_FFT;
      out.connect(split);
      split.connect(left, 0);
      split.connect(right, 1);
      this.returnTaps.set(key, { node, split, left, right });
    }
    this.returnBuf ??= new Float32Array(RETURN_METER_FFT);
  }

  /** Bring a module created while the transport runs onto the transport's phase and tempo map. */
  private alignToTransport(node: ModuleNode, now: number): void {
    const map = this.transport;
    if (!map || map.length === 0) return;
    let i = 0;
    while (i + 1 < map.length && map[i + 1].time <= now) i++;
    const a = map[i];
    if (node.transportStarted) {
      if (a.time >= now) {
        // The start (or the first tempo point) is still ahead: schedule it as is.
        node.transportStarted(a.time, a.tick, a.bpm);
      } else {
        node.transportStarted(now, a.tick + ((now - a.time) * a.bpm * PPQ) / 60, a.bpm);
      }
    }
    // Tempo points still ahead (a module without transport hooks, e.g. a delay, needs them too).
    for (let k = i + 1; k < map.length; k++) node.setTempo?.(map[k].bpm, map[k].time);
  }

  private retireModule(node: ModuleNode): void {
    if (this.offline) {
      node.dispose();
      return;
    }
    // Keep the node alive until its connections have ramped out.
    this.retiredMods.add(node);
    this.setTimer(() => {
      this.retiredMods.delete(node);
      node.dispose();
    }, REWIRE_RAMP * 1000 + TIMER_MARGIN_MS);
  }

  private rebuildIndexes(project: Project): void {
    this.instByTrack = new Map();
    this.channelByTrack = new Map();
    this.channels = [];
    this.lfos = [];
    this.master = null;
    for (const m of project.patch.modules) {
      const rec = m ? this.mods.get(m.id) : undefined;
      if (!rec || rec.type !== m.type) continue;
      const node = rec.node;
      if (node instanceof InstrumentModule) {
        if (rec.trackId && !this.instByTrack.has(rec.trackId)) this.instByTrack.set(rec.trackId, node);
      } else if (node instanceof ChannelModule) {
        if (!this.channels.includes(node)) this.channels.push(node);
        if (rec.trackId && !this.channelByTrack.has(rec.trackId)) this.channelByTrack.set(rec.trackId, node);
      } else if (node instanceof LfoModule) {
        if (!this.lfos.includes(node)) this.lfos.push(node);
      } else if (node instanceof MasterModule) {
        this.master ??= node;
      }
    }
  }

  private applyParams(project: Project, resolved: Map<Id, ParamValues>, now: number): void {
    const tracks = new Map<Id, Track>();
    for (const t of project.tracks) tracks.set(t.id, t);
    for (const rec of this.mods.values()) {
      const proj = resolved.get(rec.id) ?? {};
      const ov = this.overlay.get(rec.id);
      if (ov) {
        // A real project change to an automated param takes over from the automation,
        // except from a macro ramp still under way: the ramp owns its params until it ends.
        const ramps = this.ramps.get(rec.id);
        for (const param of [...ov.keys()]) {
          if (proj[param] === rec.projParams[param]) continue;
          const ramp = ramps?.get(param);
          if (ramp && ramp.t1 > now) continue;
          ov.delete(param);
          ramps?.delete(param);
        }
        // Automation recorded for another instrument kind means nothing to the new one.
        if (rec.node instanceof InstrumentModule && rec.node.kind !== null) {
          const track = rec.trackId ? tracks.get(rec.trackId) : undefined;
          if (track && track.instrument.kind !== rec.node.kind) {
            ov.clear();
            this.ramps.delete(rec.id);
          }
        }
        if (ov.size === 0) this.overlay.delete(rec.id);
      }
      rec.projParams = proj;
      const merged = this.withOverlay(rec.id, proj);
      if (rec.node instanceof InstrumentModule) {
        const track = rec.trackId ? tracks.get(rec.trackId) : undefined;
        if (!track) continue;
        if (track.instrument !== rec.instRef || !sameParams(merged, rec.applied)) {
          rec.instRef = track.instrument;
          rec.applied = merged;
          rec.node.update({ ...track.instrument, params: merged } as Instrument, now);
        }
      } else if (!sameParams(merged, rec.applied)) {
        rec.applied = merged;
        rec.node.setParams(merged, now);
      }
    }
  }

  private withOverlay(id: Id, proj: ParamValues): ParamValues {
    const ov = this.overlay.get(id);
    if (!ov || ov.size === 0) return proj;
    const out = { ...proj };
    for (const [param, points] of ov) if (points.length) out[param] = points[points.length - 1].value;
    return out;
  }

  /** Validate a connection against the live modules; null if it must be skipped. */
  private resolveConnection(c: Connection): DesiredConn | null {
    if (!c || !c.from || !c.to) return null;
    const from = this.mods.get(c.from.module);
    const to = this.mods.get(c.to.module);
    if (!from || !to) return null;
    const pf = portDef(from.type, c.from.port, 'out');
    const pt = portDef(to.type, c.to.port, 'in');
    if (!pf || !pt || pf.kind !== pt.kind) return null;
    const fromAudio = from.node.output(c.from.port);
    const toAudio = to.node.input(c.to.port);
    if (!fromAudio || !toAudio) return null;
    const target = pf.kind === 'mod' ? clamp(finiteOr(c.amount, 1), -1, 1) : 1;
    return { kind: pf.kind, fromAudio, toAudio, target };
  }

  /**
   * Effects fed only by channel sends are send returns (the shared Reverb and
   * Delay by default). Bypassing a return switches its output off; passing
   * the dry send through would just make every sending part louder.
   */
  private bypassedReturns(project: Project): Set<Id> {
    const out = new Set<Id>();
    const byId = new Map(project.patch.modules.map((m) => [m.id, m]));
    for (const m of project.patch.modules) {
      if (!m?.bypass || m.type === 'channel' || m.type === 'master' || m.type === 'instrument') continue;
      const incoming = project.patch.connections.filter((c) => c?.to?.module === m.id && c.to.port === 'in');
      if (incoming.length && incoming.every((c) => byId.get(c.from.module)?.type === 'channel' && (c.from.port === 'sendA' || c.from.port === 'sendB'))) out.add(m.id);
    }
    return out;
  }

  private reconcileConnections(project: Project, now: number, immediate: boolean): void {
    const mutedReturns = this.bypassedReturns(project);
    // A bypassed LFO stops moving its targets: its cables glide to 0 and stay
    // patched. Silencing the cables (not the LFO's Depth) keeps recorded or
    // macro-driven Depth changes from switching the movement back on.
    const stoppedLfos = new Set(project.patch.modules.filter((m) => m?.type === 'lfo' && m.bypass).map((m) => m.id));
    const desired = new Map<Id, DesiredConn>();
    const edges = new Map<Id, Set<Id>>();
    const pairs = new Set<string>();
    for (const c of project.patch.connections) {
      if (!c || typeof c.id !== 'string' || desired.has(c.id)) continue;
      const d = this.resolveConnection(c);
      if (!d) continue;
      if (d.kind === 'audio' && mutedReturns.has(c.from.module)) d.target = 0;
      if (d.kind === 'mod' && stoppedLfos.has(c.from.module)) d.target = 0;
      const pair = `${c.from.module}\u0000${c.from.port}\u0000${c.to.module}\u0000${c.to.port}`;
      if (pairs.has(pair)) continue;
      // Never build a feedback loop: reject any edge that closes a cycle.
      if (c.from.module === c.to.module || reaches(edges, c.to.module, c.from.module)) continue;
      pairs.add(pair);
      let out = edges.get(c.from.module);
      if (!out) edges.set(c.from.module, (out = new Set()));
      out.add(c.to.module);
      desired.set(c.id, d);
    }

    for (const [id, rec] of this.conns) {
      const d = desired.get(id);
      if (!d || d.fromAudio !== rec.fromAudio || d.toAudio !== rec.toAudio) {
        this.conns.delete(id);
        this.dropConnection(rec, now);
      } else if (d.target !== rec.target) {
        rec.target = d.target;
        // Drop a fade-in that may still be under way (its end point would
        // otherwise pull the gain back to the old amount), then glide.
        holdAt(rec.gain.gain, now);
        rec.gain.gain.setTargetAtTime(d.target, now, PARAM_SMOOTHING);
      }
    }
    for (const [id, d] of desired) {
      if (this.conns.has(id)) continue;
      const gain = this.ctx.createGain();
      // First build: nothing is sounding yet, so full gain from the start (a
      // fade-in would soften a note at time 0 of an export).
      if (immediate) {
        gain.gain.value = d.target;
      } else {
        gain.gain.value = 0;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(d.target, now + REWIRE_RAMP);
      }
      d.fromAudio.connect(gain);
      gain.connect(d.toAudio);
      this.conns.set(id, { id, kind: d.kind, fromAudio: d.fromAudio, toAudio: d.toAudio, gain, target: d.target });
    }
  }

  private dropConnection(rec: ConnRec, now: number): void {
    if (this.offline) {
      this.disconnectConnection(rec);
      return;
    }
    const p = rec.gain.gain;
    holdAt(p, now);
    p.linearRampToValueAtTime(0, now + REWIRE_RAMP);
    this.fadingConns.add(rec);
    this.setTimer(() => {
      this.fadingConns.delete(rec);
      this.disconnectConnection(rec);
    }, REWIRE_RAMP * 1000 + TIMER_MARGIN_MS);
  }

  private disconnectConnection(rec: ConnRec): void {
    try {
      rec.fromAudio.disconnect(rec.gain);
    } catch {
      // Source already disconnected (module disposed).
    }
    rec.gain.disconnect();
  }

  private applyAudible(project: Project, now: number, immediate: boolean, created: Set<Id>): void {
    const anySolo = project.tracks.some((t) => t.solo);
    const tracks = new Map<Id, Track>();
    for (const t of project.tracks) tracks.set(t.id, t);
    for (const rec of this.mods.values()) {
      if (!(rec.node instanceof ChannelModule)) continue;
      const track = rec.trackId ? tracks.get(rec.trackId) : undefined;
      const audible = track ? !track.mute && (!anySolo || track.solo) : true;
      rec.node.setAudible(audible, now, immediate || created.has(rec.id));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Notes                                                             */
  /* ---------------------------------------------------------------- */

  /** Ramp points on instrument params due by `time` reach their instruments (the scheduler got that far). */
  private advanceAutomation(time: number): void {
    if (!Number.isFinite(time)) return;
    for (const inst of this.instByTrack.values()) inst.advance(time);
  }

  scheduleNote(trackId: Id, note: NoteTrigger): VoiceHandle | null {
    if (this.disposed || !note) return null;
    if (Number.isFinite(note.time)) this.advanceAutomation(note.time);
    const inst = this.instByTrack.get(trackId);
    if (!inst || !Number.isFinite(note.time) || !Number.isFinite(note.pitch)) return null;
    const n: NoteTrigger = {
      pitch: note.pitch,
      velocity: clamp(finiteOr(note.velocity, 0), 0, 1),
      time: Math.max(note.time, this.now()),
    };
    if (note.duration !== undefined) n.duration = Math.max(0, finiteOr(note.duration, 0));
    if (note.legato !== undefined) n.legato = note.legato;
    const sample = cleanSample(note.sample);
    if (sample) n.sample = sample;
    return inst.trigger(n);
  }

  liveNoteOn(trackId: Id, pitch: number, velocity: number, key: string): void {
    if (this.disposed) return;
    const now = this.now();
    const k = liveKey(trackId, key);
    const prev = this.live.get(k);
    if (prev) {
      this.live.delete(k);
      this.letGoLive(prev, now);
    }
    let legato = false;
    for (const v of this.live.values()) {
      if (v.trackId === trackId && !v.handle.ended) {
        legato = true;
        break;
      }
    }
    const handle = this.scheduleNote(trackId, { pitch, velocity, time: now, legato });
    if (handle) this.live.set(k, { trackId, key, handle });
  }

  liveNoteOff(trackId: Id, key: string): void {
    if (this.disposed) return;
    const now = this.now();
    const k = liveKey(trackId, key);
    const entry = this.live.get(k);
    if (entry) {
      this.live.delete(k);
      this.letGoLive(entry, now);
      return;
    }
    // The key went down on another track (selection changed while held): release it there.
    for (const [lk, v] of this.live) {
      if (v.key === key) {
        this.live.delete(lk);
        this.letGoLive(v, now);
      }
    }
  }

  /** Release a live note; a one-shot that plays on is remembered so Stop can still end it. */
  private letGoLive(note: LiveNote, now: number): void {
    letGo(note.handle, note.key, now);
    for (const n of this.playingOn) if (n.handle.ended) this.playingOn.delete(n);
    if (note.handle.stop && !note.handle.ended && !isPreviewKey(note.key)) this.playingOn.add(note);
  }

  releaseLive(trackId?: Id): void {
    const now = this.now();
    for (const [lk, v] of this.live) {
      if (trackId !== undefined && v.trackId !== trackId) continue;
      this.live.delete(lk);
      if (v.handle.stop) v.handle.stop(now);
      else v.handle.release(now);
    }
    for (const n of this.playingOn) {
      if (trackId !== undefined && n.trackId !== trackId) continue;
      this.playingOn.delete(n);
      n.handle.stop?.(now);
    }
    // With the transport stopped, the only other notes are the idle arpeggio's:
    // its one-shots that are playing out end too. Later ones are the transport's
    // to cancel (Stop does; a latched arpeggio keeps going after a window blur).
    if (this.transport === null) {
      for (const [id, inst] of this.instByTrack) if (trackId === undefined || id === trackId) inst.stopOneShots(now, true);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Timed calls                                                       */
  /* ---------------------------------------------------------------- */

  schedulePump(time: number, beatSeconds: number, beatIndex: number): void {
    if (this.disposed) return;
    this.advanceAutomation(time);
    for (const ch of this.channels) ch.pump(time, beatSeconds, beatIndex);
  }

  scheduleClick(time: number, accent: boolean): void {
    if (this.disposed) return;
    if (this.master) {
      this.master.click(time, accent);
      return;
    }
    const v = scheduleClickVoice(this.ctx, this.volume, time, accent, (done) => this.looseClicks.delete(done));
    if (v) this.looseClicks.add(v);
  }

  private specFor(rec: ModRec, param: string): ParamSpec | undefined {
    if (rec.node instanceof InstrumentModule) {
      const kind = rec.node.kind ?? this.project?.tracks.find((t) => t.id === rec.trackId)?.instrument.kind;
      return kind ? specById(INSTRUMENT_PARAMS[kind], param) : undefined;
    }
    return specById(MODULE_PARAMS[rec.type], param);
  }

  scheduleParam(moduleId: Id, param: string, value: number, time: number): void {
    if (this.disposed || !Number.isFinite(value)) return;
    const rec = this.mods.get(moduleId);
    if (!rec) return;
    const spec = this.specFor(rec, param);
    if (!spec) return;
    const v = clampParam(spec, value);
    const now = this.now();
    const t = Math.max(finiteOr(time, now), now);

    let ov = this.overlay.get(moduleId);
    if (!ov) this.overlay.set(moduleId, (ov = new Map()));
    let points = ov.get(param);
    if (!points) ov.set(param, (points = []));
    // Insert in time order (a point at the same time replaces the earlier one).
    let i = points.length;
    while (i > 0 && points[i - 1].time > t) i--;
    if (i > 0 && points[i - 1].time === t) points[i - 1].value = v;
    else points.splice(i, 0, { time: t, value: v });
    // Forget points that are superseded in the past.
    let firstLive = 0;
    while (firstLive + 1 < points.length && points[firstLive + 1].time <= now) firstLive++;
    if (firstLive > 0) points.splice(0, firstLive);

    const merged = { ...rec.applied, [param]: v };
    rec.applied = merged;
    rec.node.setParams(merged, t);
  }

  scheduleMute(trackId: Id, mute: boolean, time: number): void {
    if (this.disposed) return;
    const ch = this.mods.get(trackModuleId.channel(trackId))?.node;
    if (!(ch instanceof ChannelModule)) return;
    const now = this.now();
    const t = Math.max(finiteOr(time, now), now);
    const points = (this.muteAuto.get(trackId) ?? []).filter((p) => p.time !== t);
    points.push({ time: t, mute });
    points.sort((a, b) => a.time - b.time);
    this.muteAuto.set(trackId, points);
    ch.scheduleAudible(this.audibleFor(trackId, mute), t);
  }

  scheduleMasterVolume(db: number, time: number): void {
    if (this.disposed || !Number.isFinite(db)) return;
    const now = this.now();
    const t = Math.max(finiteOr(time, now), now);
    const v = clampParam(MASTER_VOLUME_SPEC, db);
    this.masterAuto = this.masterAuto.filter((p) => p.time !== t && p.time >= now - 1);
    this.masterAuto.push({ time: t, db: v });
    this.masterAuto.sort((a, b) => a.time - b.time);
    this.volume.gain.setTargetAtTime(dbToGain(v), t, PARAM_SMOOTHING);
  }

  /** Mute/solo result for a track given an explicit mute state (solo comes from the project). */
  private audibleFor(trackId: Id, mute: boolean): boolean {
    const tracks = this.project?.tracks ?? [];
    const anySolo = tracks.some((x) => x.solo);
    const track = tracks.find((x) => x.id === trackId);
    return !mute && (!anySolo || !!track?.solo);
  }

  /** Drop timed mute/master automation at/after `t` and settle on the values that hold then. */
  private cancelMuteAndMasterAfter(t: number, clearAll: boolean): void {
    for (const [trackId, points] of [...this.muteAuto]) {
      const keep = clearAll ? [] : points.filter((p) => p.time < t);
      if (keep.length === points.length) continue;
      const ch = this.mods.get(trackModuleId.channel(trackId))?.node;
      const projectMute = this.project?.tracks.find((x) => x.id === trackId)?.mute ?? false;
      const mute = keep.length ? keep[keep.length - 1].mute : projectMute;
      if (ch instanceof ChannelModule) ch.cancelAudibleAfter(t, this.audibleFor(trackId, mute));
      if (keep.length) this.muteAuto.set(trackId, keep);
      else this.muteAuto.delete(trackId);
    }
    const keepMaster = clearAll ? [] : this.masterAuto.filter((p) => p.time < t);
    if (keepMaster.length !== this.masterAuto.length) {
      this.masterAuto = keepMaster;
      const db = keepMaster.length ? keepMaster[keepMaster.length - 1].db : (this.project?.masterVolumeDb ?? MASTER_VOLUME_SPEC.default);
      const g = this.volume.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(dbToGain(clampParam(MASTER_VOLUME_SPEC, db)), t, PARAM_SMOOTHING);
    }
  }

  scheduleMacro(trackId: Id, macro: MacroId, value: number, time: number): void {
    if (this.disposed || !Number.isFinite(value)) return;
    const track = this.project?.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const m = clamp(value, 0, 1);
    for (const target of track.macroMap[macro] ?? []) {
      this.scheduleParam(target.module, target.param, macroTargetValue(target, m), time);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Song automation                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Move a part's macro linearly in macro space from `from` (at t0) to `to`
   * (at t1), through its macroMap to every target param. Targets mapped
   * linearly (and not in dB) ramp exactly with linearRampToValueAtTime
   * (piecewise at the corners of a macroFrom/macroTo window); other curves
   * are set in steps at most MACRO_RAMP_STEP apart. A ramp that has already
   * started joins at the value it has now reached. The ramp owns its params
   * until t1 (project edits and smoothing leave them alone); afterwards the
   * end value holds like other automation.
   */
  scheduleMacroRamp(trackId: Id, macro: MacroId, from: number, to: number, t0: number, t1: number): void {
    if (this.disposed || !Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(t0) || !Number.isFinite(t1)) return;
    const track = this.project?.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const targets = track.macroMap[macro] ?? [];
    if (targets.length === 0) return;
    const now = this.now();
    const m0 = clamp(from, 0, 1);
    const m1 = clamp(to, 0, 1);
    const end = Math.max(t0, t1);
    const span = end - t0;
    // Macro position at a time (linear in macro space; held after the end).
    const macroAt = (t: number): number => (span <= 0 || t >= end ? m1 : t <= t0 ? m0 : m0 + ((m1 - m0) * (t - t0)) / span);
    const start = Math.max(t0, now);
    if (end <= start) {
      // Over already (or a jump): the end value, smoothed, from now.
      for (const target of targets) this.scheduleParam(target.module, target.param, macroTargetValue(target, m1), now);
      return;
    }

    const byModule = new Map<Id, MacroTarget[]>();
    for (const target of targets) {
      const list = byModule.get(target.module);
      if (list) list.push(target);
      else byModule.set(target.module, [target]);
    }
    for (const [moduleIdStr, list] of byModule) {
      const rec = this.mods.get(moduleIdStr);
      if (!rec) continue;
      const specs = new Map<string, ParamSpec>();
      for (const target of list) {
        const spec = this.specFor(rec, target.param);
        if (spec) specs.set(target.param, spec);
      }
      const owned = list.filter((target) => specs.has(target.param));
      if (owned.length === 0) continue;
      const valuesAt = (t: number): ParamValues => {
        const m = macroAt(t);
        const out: ParamValues = {};
        for (const target of owned) out[target.param] = clampParam(specs.get(target.param)!, macroTargetValue(target, m));
        return out;
      };
      const base = this.withOverlay(moduleIdStr, rec.projParams);
      // Exact linear ramps on AudioParams; instruments take their settings in steps (see InstrumentModule.automate).
      const exact = !!rec.node.automate && !(rec.node instanceof InstrumentModule);
      const linear = exact && owned.every((target) => target.curve === 'lin' && specs.get(target.param)!.unit !== 'dB' && specs.get(target.param)!.curve !== 'enum');
      // Times of the points after the start: window corners and the end (linear), or a step grid.
      const times: number[] = [];
      if (linear) {
        for (const target of owned) {
          for (const corner of [target.macroFrom ?? 0, target.macroTo ?? 1]) {
            if (m1 === m0) continue;
            const t = t0 + ((corner - m0) / (m1 - m0)) * span;
            if (t > start + 1e-6 && t < end - 1e-6) times.push(t);
          }
        }
        times.push(end);
        times.sort((a, b) => a - b);
      } else {
        const steps = Math.max(1, Math.ceil((end - start) / MACRO_RAMP_STEP));
        for (let k = 1; k <= steps; k++) times.push(start + ((end - start) * k) / steps);
      }
      const node = rec.node;
      if (node.automate) {
        node.automate({ ...base, ...valuesAt(start) }, start, 'anchor');
        for (const t of times) node.automate({ ...base, ...valuesAt(t) }, t, linear ? 'ramp' : 'step');
      } else {
        // No automation hook: smoothed points on the step grid.
        node.setParams({ ...base, ...valuesAt(start) }, start);
        for (const t of times) node.setParams({ ...base, ...valuesAt(t) }, t);
      }
      const final = { ...base, ...valuesAt(end) };
      rec.applied = final;
      // The end values sit in the automation overlay, so project re-applies merge them (no fight).
      let ov = this.overlay.get(moduleIdStr);
      if (!ov) this.overlay.set(moduleIdStr, (ov = new Map()));
      let ramps = this.ramps.get(moduleIdStr);
      if (!ramps) this.ramps.set(moduleIdStr, (ramps = new Map()));
      for (const target of owned) {
        const spec = specs.get(target.param)!;
        const points = (ov.get(target.param) ?? []).filter((p) => p.time < start);
        points.push({ time: start, value: valuesAt(start)[target.param] }, { time: end, value: final[target.param] });
        ov.set(target.param, points);
        ramps.set(target.param, { t0: start, t1: end, valueAt: (t) => clampParam(spec, macroTargetValue(target, macroAt(t))) });
      }
    }
  }

  /**
   * Song gain (linear, 1 = unity): reach `value` at `time` with a short
   * glide, or with `rampEndTime` move linearly from the value in force at
   * `time` to `value` at `rampEndTime`. Later segments scheduled before are
   * replaced.
   */
  scheduleSongGain(value: number, time: number, rampEndTime?: number): void {
    if (this.disposed || !Number.isFinite(value) || !Number.isFinite(time)) return;
    const now = this.now();
    const v = clamp(value, 0, SONG_GAIN_MAX);
    const t0 = Math.max(time, now);
    const ramp = rampEndTime !== undefined && Number.isFinite(rampEndTime) && rampEndTime > t0;
    const t1 = ramp ? (rampEndTime as number) : t0 + SONG_GAIN_STEP;
    const v0 = this.songGainAt(t0);
    this.songSegs = this.songSegs.filter((sg) => sg.t1 <= t0 || sg.t0 < t0);
    // A segment still running at t0 ends there, at the value it has reached.
    const last = this.songSegs[this.songSegs.length - 1];
    if (last && last.t1 > t0) {
      last.v1 = v0;
      last.t1 = t0;
    }
    const g = this.songGain.gain;
    g.cancelAndHoldAtTime(t0);
    g.setValueAtTime(v0, t0);
    g.linearRampToValueAtTime(v, t1);
    this.songSegs.push({ t0, v0, t1, v1: v });
    this.pruneSongSegs(now);
  }

  /** The song gain the schedule gives at `time`. */
  private songGainAt(time: number): number {
    let value = 1;
    for (const sg of this.songSegs) {
      if (sg.t0 > time) break;
      if (time >= sg.t1) value = sg.v1;
      else value = sg.v0 + ((sg.v1 - sg.v0) * (time - sg.t0)) / Math.max(1e-9, sg.t1 - sg.t0);
    }
    return value;
  }

  private pruneSongSegs(now: number): void {
    let first = 0;
    while (first + 1 < this.songSegs.length && this.songSegs[first + 1].t0 <= now) first++;
    if (first > 0) this.songSegs = this.songSegs.slice(first);
  }

  /** Cancel song-gain moves at/after `t`, holding the value reached at `t`. */
  private cancelSongGainAfter(t: number): void {
    if (this.songSegs.length === 0) return;
    const v = this.songGainAt(t);
    this.songSegs = this.songSegs.filter((sg) => sg.t0 < t);
    const last = this.songSegs[this.songSegs.length - 1];
    if (last && last.t1 > t) {
      last.v1 = v;
      last.t1 = t;
    }
    const g = this.songGain.gain;
    g.cancelAndHoldAtTime(t);
    g.setValueAtTime(v, t);
    if (!last || last.t1 <= t) this.songSegs.push({ t0: t, v0: v, t1: t, v1: v });
  }

  /** Back to unity from `t` (a short glide); the schedule is cleared. */
  private resetSongGain(t: number): void {
    const v = this.songGainAt(t);
    const g = this.songGain.gain;
    g.cancelAndHoldAtTime(t);
    g.setValueAtTime(v, t);
    g.linearRampToValueAtTime(1, t + SONG_GAIN_RESET);
    this.songSegs = [];
  }

  /**
   * Called when the sequencer invalidates from `afterTime`: everything the
   * engine scheduled on its behalf at/after that time is dropped — parameter
   * automation (the latest earlier value stays in force), pump ducks and
   * metronome clicks — because the sequencer regenerates those events.
   */
  cancelScheduledAutomation(afterTime: number): void {
    if (this.disposed) return;
    const now = this.now();
    const t = Math.max(finiteOr(afterTime, now), now);
    for (const ch of this.channels) ch.cancelPumpAfter(t);
    this.cancelClicksAfter(t);
    this.cancelMuteAndMasterAfter(t, false);
    this.cancelSongGainAfter(t);
    // Macro ramps: one under way at `t` holds the value it has reached; later ones are dropped.
    const holding = new Set<Id>();
    const held = new Map<Id, Map<string, number>>();
    for (const [moduleId, ramps] of [...this.ramps]) {
      for (const [param, ramp] of [...ramps]) {
        if (ramp.t1 < t) continue;
        ramps.delete(param);
        if (ramp.t0 < t) {
          holding.add(moduleId);
          let m = held.get(moduleId);
          if (!m) held.set(moduleId, (m = new Map()));
          m.set(param, ramp.valueAt(t));
        }
      }
      if (ramps.size === 0) this.ramps.delete(moduleId);
    }
    for (const [moduleId, params] of [...this.overlay]) {
      let changed = false;
      for (const [param, points] of [...params]) {
        const keep = points.filter((p) => p.time < t);
        const hold = held.get(moduleId)?.get(param);
        if (hold !== undefined) {
          keep.push({ time: t, value: hold });
          changed = true;
          params.set(param, keep);
          continue;
        }
        if (keep.length === points.length) continue;
        changed = true;
        if (keep.length) params.set(param, keep);
        else params.delete(param);
      }
      if (params.size === 0) this.overlay.delete(moduleId);
      if (changed) this.restoreModule(moduleId, t, holding.has(moduleId));
    }
  }

  /**
   * Cancel a module's pending automation at `t` and re-apply project +
   * remaining overlay values. `hold`: a ramp under way stops at the value it
   * has reached rather than falling back to its last point.
   */
  private restoreModule(moduleId: Id, t: number, hold = false): void {
    const rec = this.mods.get(moduleId);
    if (!rec) return;
    rec.node.cancelAfter?.(t, hold);
    const merged = this.withOverlay(moduleId, rec.projParams);
    rec.applied = merged;
    rec.node.setParams(merged, t);
  }

  /* ---------------------------------------------------------------- */
  /* Transport                                                         */
  /* ---------------------------------------------------------------- */

  transportStarted(time: number, tick: number, bpm: number): void {
    if (this.disposed || !Number.isFinite(time) || !Number.isFinite(tick)) return;
    const b = clampParam(BPM_SPEC, finiteOr(bpm, this.bpm));
    const t = Math.max(time, this.now());
    this.transport = null;
    if (b !== this.bpm) this.tempoChanged(b, t);
    this.transport = [{ time, tick, bpm: b }];
    for (const rec of this.mods.values()) rec.node.transportStarted?.(time, tick, b);
    // A new playback starts at unity song gain (what a song's fade left behind is over).
    if (this.songSegs.length) this.resetSongGain(t);
    // Integrated loudness counts from the start of playback (a resume from Pause keeps counting).
    if (tick <= 0) this.resetLoudness();
  }

  transportStopped(time: number): void {
    if (this.disposed) return;
    const now = this.now();
    const t = Math.max(finiteOr(time, now), now);
    this.transport = null;
    // Ramps under way stop where they are (no jump back), then glide to the project's values.
    const ramped = new Set([...this.ramps.entries()].filter(([, r]) => [...r.values()].some((x) => x.t0 < t)).map(([id]) => id));
    this.ramps.clear();
    for (const [id, rec] of this.mods) if (rec.node instanceof ChannelModule) rec.node.cancelAfter(t, ramped.has(id));
    // The song gain holds where it is (a fade-out's tail stays faded); the next start returns to unity.
    this.cancelSongGainAfter(t);
    // Tempo-synced movement (LFOs, Auto Pan) runs on freely from its phase.
    for (const rec of this.mods.values()) rec.node.transportStopped?.(t);
    // Sampler one-shots play out past their notes' ends: Stop ends them.
    for (const inst of this.instByTrack.values()) inst.stopOneShots(t);
    this.cancelClicksAfter(t);
    // Mutes and master moves belonged to the take that was playing.
    this.cancelMuteAndMasterAfter(t, true);
    // Automation belongs to the take that was playing; the project's own values return.
    for (const moduleId of [...this.overlay.keys()]) {
      this.overlay.delete(moduleId);
      const rec = this.mods.get(moduleId);
      if (!rec) continue;
      if (!(rec.node instanceof ChannelModule)) rec.node.cancelAfter?.(t, ramped.has(moduleId));
      rec.applied = rec.projParams;
      rec.node.setParams(rec.projParams, t);
    }
  }

  tempoChanged(bpm: number, time: number): void {
    if (this.disposed || !Number.isFinite(bpm)) return;
    const b = clampParam(BPM_SPEC, bpm);
    const now = this.now();
    const t = Math.max(finiteOr(time, now), now);
    this.bpm = b;
    const map = this.transport;
    if (map && map.length) {
      // Re-anchor the transport tempo map at `t` (later points are superseded).
      let a = map[0];
      for (const x of map) if (x.time <= t) a = x;
      const tick = a.tick + ((t - a.time) * a.bpm * PPQ) / 60;
      const kept = map.filter((x) => x.time < t);
      kept.push({ time: t, tick, bpm: b });
      let first = 0;
      while (first + 1 < kept.length && kept[first + 1].time <= now) first++;
      this.transport = kept.slice(first);
    }
    for (const rec of this.mods.values()) rec.node.setTempo?.(b, t);
  }

  /* ---------------------------------------------------------------- */
  /* Output                                                            */
  /* ---------------------------------------------------------------- */

  setMasterVolume(db: number): void {
    if (this.disposed) return;
    const v = clampParam(MASTER_VOLUME_SPEC, db);
    this.volume.gain.setTargetAtTime(dbToGain(v), this.now(), PARAM_SMOOTHING);
  }

  setMuteAll(muted: boolean): void {
    if (this.disposed) return;
    const now = this.now();
    const g = this.muteGain.gain;
    if (muted) {
      this.muted = true;
      holdAt(g, now);
      g.linearRampToValueAtTime(0, now + MUTE_RAMP);
      this.flushWhenSilent(now + MUTE_RAMP, null);
    } else {
      if (!this.muted) return;
      this.muted = false;
      // Tails must be gone before the output opens again. If the fade-out is
      // still under way, reopen right after its flush; killing voices now,
      // while they are still audible, would click.
      if (this.flushTimer !== null) this.flushAfter = () => this.reopen();
      else this.reopen();
    }
  }

  /** Ramp the Mute All gain back to unity (unless muted again meanwhile). */
  private reopen(): void {
    if (this.muted || this.disposed) return;
    const t = this.now();
    const g = this.muteGain.gain;
    holdAt(g, t);
    g.linearRampToValueAtTime(1, t + UNMUTE_RAMP);
  }

  panic(): void {
    if (this.disposed) return;
    if (this.offline || this.muted) {
      if (this.flushTimer === null) this.killAndFlush();
      return;
    }
    // Dip the output for a few ms so the hard stop cannot click, then reopen.
    const now = this.now();
    const g = this.muteGain.gain;
    holdAt(g, now);
    g.linearRampToValueAtTime(0, now + PANIC_RAMP);
    this.flushWhenSilent(now + PANIC_RAMP, () => this.reopen());
  }

  /**
   * Kill voices and flush tails once the output gain has reached zero at
   * `silentAt` (context time). Offline this happens immediately.
   */
  private flushWhenSilent(silentAt: number, after: (() => void) | null): void {
    if (this.flushTimer !== null) {
      this.clearTimer(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAfter = after;
    if (this.offline) {
      this.runFlush();
      return;
    }
    const check = (): void => {
      this.flushTimer = null;
      const remaining = silentAt + 0.002 - this.now();
      const running = (this.ctx as AudioContext).state === 'running';
      if (remaining <= 0 || !running) this.runFlush();
      else this.flushTimer = this.setTimer(check, remaining * 1000 + 2);
    };
    this.flushTimer = this.setTimer(check, Math.max(0, silentAt - this.now()) * 1000 + 4);
  }

  /** Kill + flush now, then run the pending follow-up (reopen after a panic / early unmute). */
  private runFlush(): void {
    const after = this.flushAfter;
    this.flushAfter = null;
    this.killAndFlush();
    after?.();
  }

  private killAndFlush(): void {
    this.live.clear();
    this.playingOn.clear();
    for (const rec of this.mods.values()) {
      if (rec.node instanceof InstrumentModule) rec.node.kill();
    }
    for (const rec of this.mods.values()) rec.node.flush?.();
    for (const node of this.retiredMods) node.flush?.();
    this.mastering.flush();
    for (const v of this.looseClicks) stopClickVoice(v);
    this.looseClicks.clear();
  }

  private cancelClicksAfter(t: number): void {
    for (const rec of this.mods.values()) if (rec.node instanceof MasterModule) rec.node.cancelAfter(t);
    for (const v of [...this.looseClicks]) {
      if (v.start >= t) {
        stopClickVoice(v);
        this.looseClicks.delete(v);
      }
    }
  }

  readMeters(out: MeterFrame): void {
    out.limiterReductionDb = this.disposed ? 0 : this.limiterReductionDb;
    out.glueReductionDb = this.disposed || !this.mastering.isEnabled ? 0 : this.glueReductionDb;
    out.compareTrimDb = this.disposed || !this.masteringListen ? 0 : this.compareTrimDb;
    if (!this.meterL || !this.meterR || !this.meterBuf || this.disposed) {
      out.masterPeakL = 0;
      out.masterPeakR = 0;
      out.masterRms = 0;
      out.tracks.length = 0;
      return;
    }
    const lr = (out.loudness ??= { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, truePeakDb: -Infinity });
    lr.momentary = this.loudness.momentary;
    lr.shortTerm = this.loudness.shortTerm;
    lr.integrated = this.loudness.integrated;
    lr.truePeakDb = this.loudness.truePeakDb;
    lr.preMasteringShortTerm = this.preLoudnessOn ? this.preShortTerm : -Infinity;
    this.readModuleReductions(out);
    this.readReturns(out);
    const buf = this.meterBuf;
    this.meterL.getFloatTimeDomainData(buf);
    const l = peakAndSquares(buf);
    this.meterR.getFloatTimeDomainData(buf);
    const r = peakAndSquares(buf);
    out.masterPeakL = l.peak;
    out.masterPeakR = r.peak;
    const rms = Math.sqrt((l.squares + r.squares) / (2 * buf.length));
    out.masterRms = Number.isFinite(rms) ? rms : 0;

    let n = 0;
    for (const track of this.project?.tracks ?? []) {
      const ch = this.channelByTrack.get(track.id);
      if (!ch) continue;
      const r = ch.readMeter(this.channelReading);
      const slot = out.tracks[n];
      if (slot) {
        slot.trackId = track.id;
        slot.peak = r.peak;
        slot.rms = r.rms;
      } else {
        out.tracks[n] = { trackId: track.id, peak: r.peak, rms: r.rms };
      }
      n++;
    }
    out.tracks.length = n;
  }

  /** Compressor and Gate gain reduction by module id (a bypassed module reads 0). */
  private readModuleReductions(out: MeterFrame): void {
    let map = out.moduleReductionDb;
    for (const rec of this.mods.values()) {
      const node = rec.node;
      if (!(node instanceof CompressorModule || node instanceof GateModule)) continue;
      map ??= out.moduleReductionDb = {};
      map[rec.id] = rec.bypass ? 0 : node.reductionDb;
    }
    if (map) for (const id of Object.keys(map)) if (!this.mods.has(id)) delete map[id];
  }

  /** Peak and RMS after the shared Reverb and Echo returns (0 for a return switched off). */
  private readReturns(out: MeterFrame): void {
    const buf = this.returnBuf;
    if (!buf) return;
    const r = (out.returns ??= { reverb: { peak: 0, rms: 0 }, delay: { peak: 0, rms: 0 } });
    for (const key of ['reverb', 'delay'] as const) {
      const tap = this.returnTaps.get(key);
      const slot = r[key];
      const rec = this.mods.get(key === 'reverb' ? REVERB_ID : DELAY_ID);
      if (!tap || !rec || rec.bypass) {
        slot.peak = 0;
        slot.rms = 0;
        continue;
      }
      const reading = this.returnReading;
      tap.left.getFloatTimeDomainData(buf);
      const a = peakAndSquares(buf);
      tap.right.getFloatTimeDomainData(buf);
      const b = peakAndSquares(buf);
      reading.peak = Math.max(a.peak, b.peak);
      const rms = Math.sqrt((a.squares + b.squares) / (2 * buf.length));
      reading.rms = Number.isFinite(rms) ? rms : 0;
      slot.peak = reading.peak;
      slot.rms = reading.rms;
    }
  }

  /**
   * Spectrum of the final output in `out.length` log-spaced bands from 20 Hz
   * to 20 kHz: the energy in each band in dB (a full-scale sine reads about
   * 0 dB in its band, pink noise reads flat; silence −140). Bands narrower
   * than an FFT bin are interpolated between bins. The band map is computed
   * once per band count (src/audio/spectrum.ts).
   * Live engines with meters only; otherwise every band reads −140.
   */
  readSpectrum(out: Float32Array): void {
    const n = out.length;
    if (n === 0) return;
    const an = this.spectrum;
    const buf = this.spectrumBuf;
    const power = this.spectrumPower;
    if (!an || !buf || !power || this.disposed) {
      out.fill(-140);
      return;
    }
    an.getFloatFrequencyData(buf);
    spectrumBands(spectrumBandMap(SPECTRUM_FFT, this.ctx.sampleRate, n), buf, out, power);
  }

  /**
   * A/B listening without the mastering chain (never touches the project or
   * exports). Level-matched: turning the comparison on measures the
   * short-term loudness after (post) and before (pre) mastering and plays
   * the un-mastered sound with a glided gain of post − pre (at most ±12 dB,
   * and a boost only as far as it adds at most 1.5 dB of limiter gain
   * reduction on its recent peaks), so the comparison is about tone and
   * punch, not volume. MeterFrame.compareTrimDb reports the gain.
   * `matchLevels: false` compares at the levels as they are.
   */
  setMasteringBypass(on: boolean, opts: { matchLevels?: boolean } = {}): void {
    if (this.disposed) return;
    this.masteringListen = !!on;
    this.compareTrimDb = on && opts.matchLevels !== false ? this.measureCompareTrim() : 0;
    this.applyCompareTrim(this.now());
  }

  private applyCompareTrim(time: number): void {
    this.mastering.setListenBypass(this.masteringListen, time, this.masteringListen ? dbToGain(this.compareTrimDb) : 1);
  }

  /** post − pre short-term loudness (dB) for the level-matched A/B; 0 when it cannot be known. */
  private measureCompareTrim(): number {
    const post = this.loudness.shortTerm;
    const pre = this.preShortTerm;
    if (!this.preLoudnessOn || !Number.isFinite(post) || !Number.isFinite(pre)) return 0;
    if (post < COMPARE_MIN_LUFS || pre < COMPARE_MIN_LUFS) return 0;
    let diff = clamp(post - pre, -COMPARE_MAX_DB, COMPARE_MAX_DB);
    if (diff > 0) {
      // Peaks already over the ceiling get at most the extra limiting; quieter peaks the room under it too.
      const pk = this.prePeak > 0 ? 20 * Math.log10(this.prePeak) : -Infinity;
      const room = COMPARE_MAX_EXTRA_LIMITING_DB + Math.max(0, CEILING_DB - pk);
      diff = Math.min(diff, room);
    }
    return Math.round(diff * 10) / 10;
  }

  resetLoudness(): void {
    if (this.disposed) return;
    this.loudness.integrated = -Infinity;
    this.loudness.truePeakDb = -Infinity;
    this.loudnessNode?.port.postMessage('reset');
  }

  /**
   * Pitch bend for a part's playing and future notes (cents, smoothed).
   * Bass, poly and sampler parts bend; drum kits ignore it.
   */
  setPitchBend(trackId: Id, cents: number, time: number): void {
    if (this.disposed || !Number.isFinite(cents)) return;
    const c = clamp(cents, -PITCH_BEND_MAX_CENTS, PITCH_BEND_MAX_CENTS);
    if (c === 0) this.bends.delete(trackId);
    else this.bends.set(trackId, c);
    const now = this.now();
    this.instByTrack.get(trackId)?.setPitchBend(c, Math.max(finiteOr(time, now), now));
  }

  /**
   * Frames from a note's scheduled time to its sound at the output for the
   * current project: the limiter's look-ahead (true-peak interpolators
   * included) plus the least module latency on any audible part's way to the
   * master (a Drive in the chain adds DRIVE_LATENCY_FRAMES; bypassed, it
   * adds nothing). A part without a Drive is that much earlier than one
   * with, so only latency every audible part has is counted.
   */
  outputLatencyFrames(): number {
    const base = limiterLatencyFrames(this.ctx.sampleRate);
    const p = this.project;
    if (!p || this.disposed) return base;
    const edges = new Map<Id, Id[]>();
    for (const c of p.patch.connections) {
      const rec = c ? this.conns.get(c.id) : undefined;
      if (!rec || rec.kind !== 'audio' || rec.target === 0) continue;
      const list = edges.get(c.from.module);
      if (list) list.push(c.to.module);
      else edges.set(c.from.module, [c.to.module]);
    }
    const memo = new Map<Id, number>();
    const own = (id: Id): number => {
      const rec = this.mods.get(id);
      return rec && rec.type === 'drive' && !rec.bypass ? DRIVE_LATENCY_FRAMES : 0;
    };
    const toMaster = (id: Id, depth: number): number => {
      const rec = this.mods.get(id);
      if (!rec) return Infinity;
      if (rec.type === 'master') return 0;
      const hit = memo.get(id);
      if (hit !== undefined) return hit;
      if (depth > 64) return Infinity;
      let best = Infinity;
      for (const next of edges.get(id) ?? []) best = Math.min(best, toMaster(next, depth + 1));
      const v = best === Infinity ? Infinity : own(id) + best;
      memo.set(id, v);
      return v;
    };
    const anySolo = p.tracks.some((t) => t.solo);
    let least = Infinity;
    for (const t of p.tracks) {
      if (t.mute || (anySolo && !t.solo)) continue;
      least = Math.min(least, toMaster(trackModuleId.inst(t.id), 0));
    }
    return base + (Number.isFinite(least) ? least : 0);
  }

  getStats(): EngineStats {
    let voices = 0;
    for (const inst of this.instByTrack.values()) voices += inst.activeVoices();
    for (const node of this.retiredMods) if (node instanceof InstrumentModule) voices += node.activeVoices();
    return {
      voices,
      modules: this.mods.size,
      connections: this.conns.size,
      pendingTimers: this.timers.size,
      skippedSampleNotes: this.skippedSampleNotes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
    this.flushTimer = null;
    this.flushAfter = null;
    this.live.clear();
    this.playingOn.clear();
    this.overlay.clear();

    for (const rec of this.conns.values()) this.disconnectConnection(rec);
    for (const rec of this.fadingConns) this.disconnectConnection(rec);
    this.conns.clear();
    this.fadingConns.clear();

    for (const rec of this.mods.values()) rec.node.dispose();
    for (const node of this.retiredMods) node.dispose();
    this.mods.clear();
    this.retiredMods.clear();
    this.instByTrack.clear();
    this.channelByTrack.clear();
    this.channels = [];
    this.lfos = [];
    this.master = null;
    this.killAndFlush();

    this.limiter.port.onmessage = null;
    this.limiter.port.postMessage('stop');
    this.limiter.port.close();
    this.mastering.dispose();
    for (const node of [this.loudnessNode, this.preLoudnessNode]) {
      if (!node) continue;
      node.port.onmessage = null;
      node.port.postMessage('stop');
      node.port.close();
    }
    for (const tap of this.returnTaps.values()) tap.split.disconnect();
    this.returnTaps.clear();
    this.ramps.clear();
    this.songSegs = [];
    for (const n of [this.volume, this.songGain, this.muteGain, this.limiter, this.safety, this.meterSplit, this.meterL, this.meterR, this.loudnessNode, this.preLoudnessNode, this.spectrum]) n?.disconnect();
    this.bends.clear();
    this.preparedKits.clear();
    this.project = null;
  }
}

/** A per-note recording with valid fields, or undefined (malformed ones play the part's own recording). */
function cleanSample(sample: NoteSample | undefined): NoteSample | undefined {
  if (!sample || typeof sample.id !== 'string' || !sample.id) return undefined;
  return {
    id: sample.id,
    start: clamp(finiteOr(sample.start, 0), 0, 1),
    end: clamp(finiteOr(sample.end, 1), 0, 1),
    rootNote: clamp(Math.round(finiteOr(sample.rootNote, 60)), 0, 127),
  };
}

/** Peak |x| and sum of squares of a meter buffer (non-finite reads as 0). */
function peakAndSquares(buf: Float32Array): { peak: number; squares: number } {
  let peak = 0;
  let squares = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    squares += v * v;
  }
  return { peak: Number.isFinite(peak) ? peak : 0, squares: Number.isFinite(squares) ? squares : 0 };
}

/** Depth-first reachability in the accepted connection graph. */
function reaches(edges: Map<Id, Set<Id>>, from: Id, target: Id): boolean {
  if (from === target) return true;
  const seen = new Set<Id>([from]);
  const stack: Id[] = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    const outs = edges.get(cur);
    if (!outs) continue;
    for (const nxt of outs) {
      if (nxt === target) return true;
      if (!seen.has(nxt)) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return false;
}
