/**
 * AudioEngine: reconciles the Web Audio graph with the serializable Project
 * and executes timed calls from the sequencer.
 *
 * Graph:
 *   patch modules --(one GainNode per connection)--> ... --> master sum
 *   master sum -> volume -> Mute All -> look-ahead limiter (worklet)
 *              -> safety clipper (WaveShaper, bounded to OUTPUT_CEILING) -> destination
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
  MeterFrame,
  NoteTrigger,
  VoiceHandle,
} from './contracts';
import { PPQ, type Connection, type Id, type Instrument, type MacroId, type ModuleType, type ParamValues, type PatchModule, type PortKind, type Project, type Track } from '../project/types';
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
import { LIMITER_PROCESSOR_NAME, LIMITER_WORKLET_SOURCE, limiterProcessorOptions, safetyClipperCurve } from './worklets/limiter';
import { CRUSHER_WORKLET_SOURCE } from './worklets/crusher';
import { createInstrumentEngine } from './instruments/index';
import { moduleId as trackModuleId } from '../project/factory';

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
 * Load the engine's AudioWorklet processors (limiter, crusher) into `ctx`
 * once. Concurrent and repeated calls share the same promise; a failed load
 * can be retried.
 */
export function loadEngineWorklets(ctx: BaseAudioContext): Promise<void> {
  let p = workletLoads.get(ctx);
  if (!p) {
    if (!ctx.audioWorklet) {
      return Promise.reject(new Error('AudioWorklet is not available (a secure context is required).'));
    }
    p = Promise.all([addWorkletSource(ctx, LIMITER_WORKLET_SOURCE), addWorkletSource(ctx, CRUSHER_WORKLET_SOURCE)]).then(() => undefined);
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
  private readonly muteGain: GainNode;
  private readonly limiter: AudioWorkletNode;
  private readonly safety: WaveShaperNode;
  private readonly meterSplit: ChannelSplitterNode | null = null;
  private readonly meterL: AnalyserNode | null = null;
  private readonly meterR: AnalyserNode | null = null;
  private readonly meterBuf: Float32Array<ArrayBuffer> | null = null;
  private readonly channelReading: ChannelMeterReading = { peak: 0, rms: 0 };
  private limiterReductionDb = 0;

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
    this.ictx = { ctx, samples: opts.samples, noise, getBpm: () => this.bpm };

    // Output chain.
    this.volume = ctx.createGain();
    this.volume.gain.value = dbToGain(MASTER_VOLUME_SPEC.default);
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
    this.volume.connect(this.muteGain);
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
    }
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
        // A real project change to an automated param takes over from the automation.
        for (const param of [...ov.keys()]) if (proj[param] !== rec.projParams[param]) ov.delete(param);
        // Automation recorded for another instrument kind means nothing to the new one.
        if (rec.node instanceof InstrumentModule && rec.node.kind !== null) {
          const track = rec.trackId ? tracks.get(rec.trackId) : undefined;
          if (track && track.instrument.kind !== rec.node.kind) ov.clear();
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
    const desired = new Map<Id, DesiredConn>();
    const edges = new Map<Id, Set<Id>>();
    const pairs = new Set<string>();
    for (const c of project.patch.connections) {
      if (!c || typeof c.id !== 'string' || desired.has(c.id)) continue;
      const d = this.resolveConnection(c);
      if (!d) continue;
      if (d.kind === 'audio' && mutedReturns.has(c.from.module)) d.target = 0;
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

  scheduleNote(trackId: Id, note: NoteTrigger): VoiceHandle | null {
    if (this.disposed || !note) return null;
    const inst = this.instByTrack.get(trackId);
    if (!inst || !Number.isFinite(note.time) || !Number.isFinite(note.pitch)) return null;
    const n: NoteTrigger = {
      pitch: note.pitch,
      velocity: clamp(finiteOr(note.velocity, 0), 0, 1),
      time: Math.max(note.time, this.now()),
    };
    if (note.duration !== undefined) n.duration = Math.max(0, finiteOr(note.duration, 0));
    if (note.legato !== undefined) n.legato = note.legato;
    return inst.trigger(n);
  }

  liveNoteOn(trackId: Id, pitch: number, velocity: number, key: string): void {
    if (this.disposed) return;
    const now = this.now();
    const k = liveKey(trackId, key);
    const prev = this.live.get(k);
    if (prev) {
      this.live.delete(k);
      prev.handle.release(now);
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
      entry.handle.release(now);
      return;
    }
    // The key went down on another track (selection changed while held): release it there.
    for (const [lk, v] of this.live) {
      if (v.key === key) {
        this.live.delete(lk);
        v.handle.release(now);
      }
    }
  }

  releaseLive(trackId?: Id): void {
    const now = this.now();
    for (const [lk, v] of this.live) {
      if (trackId !== undefined && v.trackId !== trackId) continue;
      this.live.delete(lk);
      v.handle.release(now);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Timed calls                                                       */
  /* ---------------------------------------------------------------- */

  schedulePump(time: number, beatSeconds: number, beatIndex: number): void {
    if (this.disposed) return;
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
    for (const [moduleId, params] of [...this.overlay]) {
      let changed = false;
      for (const [param, points] of [...params]) {
        const keep = points.filter((p) => p.time < t);
        if (keep.length === points.length) continue;
        changed = true;
        if (keep.length) params.set(param, keep);
        else params.delete(param);
      }
      if (params.size === 0) this.overlay.delete(moduleId);
      if (changed) this.restoreModule(moduleId, t);
    }
  }

  /** Cancel a module's pending automation at `t` and re-apply project + remaining overlay values. */
  private restoreModule(moduleId: Id, t: number): void {
    const rec = this.mods.get(moduleId);
    if (!rec) return;
    rec.node.cancelAfter?.(t);
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
  }

  transportStopped(time: number): void {
    if (this.disposed) return;
    const now = this.now();
    const t = Math.max(finiteOr(time, now), now);
    this.transport = null;
    for (const ch of this.channels) ch.cancelAfter(t);
    for (const lfo of this.lfos) lfo.transportStopped(t);
    this.cancelClicksAfter(t);
    // Mutes and master moves belonged to the take that was playing.
    this.cancelMuteAndMasterAfter(t, true);
    // Automation belongs to the take that was playing; the project's own values return.
    for (const moduleId of [...this.overlay.keys()]) {
      this.overlay.delete(moduleId);
      const rec = this.mods.get(moduleId);
      if (!rec) continue;
      if (!(rec.node instanceof ChannelModule)) rec.node.cancelAfter?.(t);
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
    for (const rec of this.mods.values()) {
      if (rec.node instanceof InstrumentModule) rec.node.kill();
    }
    for (const rec of this.mods.values()) rec.node.flush?.();
    for (const node of this.retiredMods) node.flush?.();
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
    if (!this.meterL || !this.meterR || !this.meterBuf || this.disposed) {
      out.masterPeakL = 0;
      out.masterPeakR = 0;
      out.masterRms = 0;
      out.tracks.length = 0;
      return;
    }
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

  /**
   * Warm every instrument's caches now (drum kit buffers, ~50-300 ms of CPU).
   * Call while the transport is stopped, e.g. right after audio starts or a
   * project loads, so the first hits never render inside the scheduler.
   */
  prepareInstruments(): void {
    if (this.disposed) return;
    for (const rec of this.mods.values()) if (rec.node instanceof InstrumentModule) rec.node.prepare();
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
    for (const n of [this.volume, this.muteGain, this.limiter, this.safety, this.meterSplit, this.meterL, this.meterR]) n?.disconnect();
    this.project = null;
  }
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
