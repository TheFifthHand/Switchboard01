/**
 * Channel module: the mixer strip of one part.
 *
 *   in -> pump gain -> tremolo gain -> fader gain -> StereoPanner -> out
 *                                                              |-> sendA (post-fader)
 *                                                              |-> sendB (post-fader)
 *                                                              |-> meter (optional)
 *
 * - Pump is a tempo-synchronized ducking envelope driven by the engine once
 *   per beat (`pump()`); it does not listen to any audio (no sidechain).
 * - Mod input 'level' adds to the tremolo gain (base 1, +1 signal = +100%).
 * - Mod input 'pan' adds to the panner position (clamped by the panner).
 * - Fader gain = level (dB) x audible (mute/solo), always ramped.
 */
import type { Id, ParamValues } from '../../project/types';
import { CHANNEL_PARAMS, PUMP_DIVISION_BEATS, dbToGain, readParam } from '../../project/params';
import { MODULE_DEFS } from '../../project/modules';
import { PARAM_SMOOTHING, type ModuleEnv, type ModuleNode } from './types';

/** Duck attack: time to reach the ducked level. */
export const PUMP_ATTACK = 0.006;
/** Recovery time constant as a fraction of the pump division length. */
export const PUMP_RECOVERY_FRACTION = 0.22;
/** Time constant used to return to unity when pump automation is cancelled. */
const PUMP_CANCEL_TAU = 0.03;
/** Mute/solo fades. */
const AUDIBLE_TAU = 0.008;
const METER_FFT = 1024;

function modAmount(port: string): number {
  return MODULE_DEFS.channel.ports.find((p) => p.id === port && p.direction === 'in')?.modRange?.amount ?? 1;
}

/**
 * One scheduled segment of the pump gain: a linear move from `v0` to `floor`
 * over `att` seconds starting at `t`, then exponential recovery toward 1 with
 * time constant `tau`. Mirrors exactly what is scheduled on the AudioParam so
 * the value at any time can be computed without reading the param.
 */
interface PumpSegment {
  t: number;
  v0: number;
  floor: number;
  att: number;
  tau: number;
}

export interface ChannelMeterReading {
  peak: number;
  rms: number;
}

export class ChannelModule implements ModuleNode {
  readonly type = 'channel' as const;
  private readonly ctx: BaseAudioContext;
  private readonly inGain: GainNode;
  private readonly pumpGain: GainNode;
  private readonly tremGain: GainNode;
  private readonly levelMod: GainNode;
  private readonly fader: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly panMod: GainNode;
  private readonly sendAGain: GainNode;
  private readonly sendBGain: GainNode;

  private level = 0;
  private pan = 0;
  private sendA = 0;
  private sendB = 0;
  private pumpAmount = 0;
  private pumpDiv = 0;
  private audible = true;

  private segments: PumpSegment[] = [];

  private meterSplit: ChannelSplitterNode | null = null;
  private meterL: AnalyserNode | null = null;
  private meterR: AnalyserNode | null = null;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;
  private disposed = false;

  constructor(
    env: ModuleEnv,
    readonly id: Id,
    params: ParamValues,
  ) {
    const ctx = env.ctx;
    this.ctx = ctx;
    this.inGain = ctx.createGain();
    this.pumpGain = ctx.createGain();
    this.tremGain = ctx.createGain();
    this.levelMod = ctx.createGain();
    this.fader = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.panMod = ctx.createGain();
    this.sendAGain = ctx.createGain();
    this.sendBGain = ctx.createGain();

    this.inGain.connect(this.pumpGain);
    this.pumpGain.connect(this.tremGain);
    this.tremGain.connect(this.fader);
    this.fader.connect(this.panner);
    this.panner.connect(this.sendAGain);
    this.panner.connect(this.sendBGain);

    this.pumpGain.gain.value = 1;
    this.tremGain.gain.value = 1;
    this.levelMod.gain.value = modAmount('level');
    this.levelMod.connect(this.tremGain.gain);
    this.panMod.gain.value = modAmount('pan');
    this.panMod.connect(this.panner.pan);

    // Initial values are set directly: nothing is sounding through a new strip yet.
    this.readParams(params);
    this.fader.gain.value = this.faderTarget();
    this.panner.pan.value = this.pan;
    this.sendAGain.gain.value = this.sendA;
    this.sendBGain.gain.value = this.sendB;
  }

  input(port: string): AudioNode | undefined {
    switch (port) {
      case 'in':
        return this.inGain;
      case 'level':
        return this.levelMod;
      case 'pan':
        return this.panMod;
      default:
        return undefined;
    }
  }

  output(port: string): AudioNode | undefined {
    switch (port) {
      case 'out':
        return this.panner;
      case 'sendA':
        return this.sendAGain;
      case 'sendB':
        return this.sendBGain;
      default:
        return undefined;
    }
  }

  private readParams(params: ParamValues): void {
    this.level = readParam(CHANNEL_PARAMS, params, 'level');
    this.pan = readParam(CHANNEL_PARAMS, params, 'pan');
    this.sendA = readParam(CHANNEL_PARAMS, params, 'sendA');
    this.sendB = readParam(CHANNEL_PARAMS, params, 'sendB');
    this.pumpAmount = readParam(CHANNEL_PARAMS, params, 'pump');
    this.pumpDiv = readParam(CHANNEL_PARAMS, params, 'pumpDiv');
  }

  private faderTarget(): number {
    return this.audible ? dbToGain(this.level) : 0;
  }

  private at(time: number): number {
    const now = this.ctx.currentTime;
    return Number.isFinite(time) ? Math.max(time, now) : now;
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const prev = { level: this.level, pan: this.pan, sendA: this.sendA, sendB: this.sendB };
    this.readParams(params);
    if (prev.level !== this.level) this.fader.gain.setTargetAtTime(this.faderTarget(), t, PARAM_SMOOTHING);
    if (prev.pan !== this.pan) this.panner.pan.setTargetAtTime(this.pan, t, PARAM_SMOOTHING);
    if (prev.sendA !== this.sendA) this.sendAGain.gain.setTargetAtTime(this.sendA, t, PARAM_SMOOTHING);
    if (prev.sendB !== this.sendB) this.sendBGain.gain.setTargetAtTime(this.sendB, t, PARAM_SMOOTHING);
    // pump / pumpDiv take effect at the next scheduled beat.
  }

  /**
   * Mute/solo result for this strip. `immediate` sets the gain without a fade
   * (used when the strip is new and nothing is flowing through it yet).
   */
  setAudible(audible: boolean, time: number, immediate = false): void {
    if (this.disposed || audible === this.audible) return;
    this.audible = audible;
    if (immediate) {
      this.fader.gain.cancelScheduledValues(0);
      this.fader.gain.value = this.faderTarget();
      return;
    }
    this.fader.gain.setTargetAtTime(this.faderTarget(), this.at(time), AUDIBLE_TAU);
  }

  isAudible(): boolean {
    return this.audible;
  }

  setBypass(_bypass: boolean, _time: number): void {
    // A channel strip cannot be bypassed.
  }

  /* ---------------------------------------------------------------- */
  /* Pump                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Called once per beat. Ducks at every pump-division boundary that falls
   * within this beat: 1/4 on every beat, 1/2 on even beats, 1/8 on the beat
   * and half-way through it.
   */
  pump(time: number, beatSeconds: number, beatIndex: number): void {
    if (this.disposed || this.pumpAmount <= 0) return;
    if (!Number.isFinite(time) || !(beatSeconds > 0) || !Number.isFinite(beatSeconds)) return;
    const divBeats = PUMP_DIVISION_BEATS[this.pumpDiv] ?? 1;
    const divSeconds = divBeats * beatSeconds;
    if (divBeats >= 1) {
      const every = Math.max(1, Math.round(divBeats));
      const idx = Math.round(Number.isFinite(beatIndex) ? beatIndex : 0);
      if (((idx % every) + every) % every !== 0) return;
      this.duck(time, divSeconds);
    } else {
      const per = Math.max(1, Math.round(1 / divBeats));
      for (let k = 0; k < per; k++) this.duck(time + k * divSeconds, divSeconds);
    }
  }

  private duck(time: number, divSeconds: number): void {
    const now = this.ctx.currentTime;
    const t = Math.max(time, now);
    this.pruneSegments(now);
    // Drop anything already queued at/after t (a re-scheduled beat replaces it).
    this.segments = this.segments.filter((s) => s.t < t);
    const v0 = this.pumpValueAt(t);
    const floor = Math.min(v0, 1 - this.pumpAmount);
    const tau = Math.max(0.005, PUMP_RECOVERY_FRACTION * divSeconds);
    const g = this.pumpGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(v0, t);
    g.linearRampToValueAtTime(floor, t + PUMP_ATTACK);
    g.setTargetAtTime(1, t + PUMP_ATTACK, tau);
    this.segments.push({ t, v0, floor, att: PUMP_ATTACK, tau });
  }

  /** Model of the scheduled pump gain at `time`. */
  private pumpValueAt(time: number): number {
    let seg: PumpSegment | null = null;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (this.segments[i].t <= time) {
        seg = this.segments[i];
        break;
      }
    }
    if (!seg) return 1;
    const dt = time - seg.t;
    if (dt < seg.att) return seg.v0 + (seg.floor - seg.v0) * (dt / seg.att);
    return 1 - (1 - seg.floor) * Math.exp(-(dt - seg.att) / seg.tau);
  }

  private pruneSegments(now: number): void {
    // Keep the segment in force at `now` and everything after it.
    let first = 0;
    while (first + 1 < this.segments.length && this.segments[first + 1].t <= now) first++;
    if (first > 0) this.segments = this.segments.slice(first);
  }

  /**
   * Cancel automation scheduled at/after `time`: pump ducks glide back to
   * unity; level/pan/sends keep heading to the strip's latest values (the
   * engine re-applies the values that should hold after a cancel).
   */
  cancelAfter(time: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const t = Math.max(Number.isFinite(time) ? time : now, now);
    const params: [AudioParam, number][] = [
      [this.fader.gain, this.faderTarget()],
      [this.panner.pan, this.pan],
      [this.sendAGain.gain, this.sendA],
      [this.sendBGain.gain, this.sendB],
    ];
    for (const [param, value] of params) {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(value, t, PARAM_SMOOTHING);
    }
    this.cancelPumpAfter(t);
  }

  /**
   * Cancel pump ducks scheduled at/after `time` and glide back to unity. A
   * duck already under way at `time` keeps its natural recovery.
   */
  cancelPumpAfter(time: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const t = Math.max(Number.isFinite(time) ? time : now, now);
    if (!this.segments.some((s) => s.t >= t)) return;
    this.segments = this.segments.filter((s) => s.t < t);
    const v = this.pumpValueAt(t);
    const g = this.pumpGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(v, t);
    g.setTargetAtTime(1, t, PUMP_CANCEL_TAU);
    this.segments.push({ t, v0: v, floor: v, att: 0, tau: PUMP_CANCEL_TAU });
    this.pruneSegments(now);
  }

  /* ---------------------------------------------------------------- */
  /* Metering                                                          */
  /* ---------------------------------------------------------------- */

  /** Attach a post-fader stereo meter (live contexts only). */
  enableMeter(): void {
    if (this.meterSplit || this.disposed) return;
    this.meterSplit = this.ctx.createChannelSplitter(2);
    this.meterL = this.ctx.createAnalyser();
    this.meterR = this.ctx.createAnalyser();
    this.meterL.fftSize = METER_FFT;
    this.meterR.fftSize = METER_FFT;
    this.meterBuf = new Float32Array(METER_FFT);
    this.panner.connect(this.meterSplit);
    this.meterSplit.connect(this.meterL, 0);
    this.meterSplit.connect(this.meterR, 1);
  }

  /** Peak and RMS (linear) of the last ~21 ms, both channels combined. */
  readMeter(into: ChannelMeterReading): ChannelMeterReading {
    into.peak = 0;
    into.rms = 0;
    if (!this.meterL || !this.meterR || !this.meterBuf) return into;
    let peak = 0;
    let sum = 0;
    const buf = this.meterBuf;
    for (const an of [this.meterL, this.meterR]) {
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
    }
    into.peak = Number.isFinite(peak) ? peak : 0;
    const rms = Math.sqrt(sum / (2 * buf.length));
    into.rms = Number.isFinite(rms) ? rms : 0;
    return into;
  }

  flush(): void {
    // No internal tail: the strip is memoryless apart from the pump envelope,
    // which recovers on its own.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of [
      this.inGain,
      this.pumpGain,
      this.tremGain,
      this.levelMod,
      this.fader,
      this.panner,
      this.panMod,
      this.sendAGain,
      this.sendBGain,
      this.meterSplit,
      this.meterL,
      this.meterR,
    ]) {
      n?.disconnect();
    }
    this.segments = [];
  }
}
