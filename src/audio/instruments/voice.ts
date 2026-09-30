/**
 * Shared building blocks for the melodic instruments (mono bass, poly synth,
 * sampler).
 *
 * - ParamTimeline writes automation to one or more AudioParams and keeps a
 *   JS model of the same timeline, so the scheduled value at any time is
 *   known. A release, steal or kill therefore starts from exactly the level
 *   the envelope has at that moment, even in the middle of an attack or
 *   decay, and a legato note can pick up the previous note's pitch, filter
 *   and level.
 * - GainEnvelope is an ADSR on a gain AudioParam built on ParamTimeline.
 * - BaseVoice implements VoiceHandle: release / cut (fast fade) / restore /
 *   cancel bookkeeping, source stop times and node cleanup after the tail.
 */
import type { VoiceHandle } from '../contracts';

/* ------------------------------------------------------------------ */
/* Small numeric helpers                                               */
/* ------------------------------------------------------------------ */

export function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, finiteOr(v, lo)));
}

/** Equal-tempered MIDI note to Hz (A4 = 69 = 440 Hz). */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (finiteOr(midi, 69) - 69) / 12);
}

/**
 * Amplitude for a note velocity. `sensitivity` 0 ignores velocity; 1 gives
 * a v^1.6 curve (velocity 0.5 is about -10 dB), which feels natural on pads
 * and keys.
 */
export function velocityGain(velocity: number, sensitivity: number): number {
  const v = clamp(velocity, 0, 1);
  const s = clamp(sensitivity, 0, 1);
  return 1 - s + s * Math.pow(v, 1.6);
}

/** Linear velocity scaling for modulation depths (filter envelopes). */
export function velocityAmount(velocity: number, sensitivity: number): number {
  const v = clamp(velocity, 0, 1);
  const s = clamp(sensitivity, 0, 1);
  return 1 - s + s * v;
}

/** Web Audio low-pass Q (in dB) of a Butterworth response: flat, no resonant bump. */
export const BUTTERWORTH_Q_DB = -3.0103;

/* ------------------------------------------------------------------ */
/* Automation timeline with a value model                             */
/* ------------------------------------------------------------------ */

/** Whether AudioParam.cancelAndHoldAtTime exists (Chromium, Safari). */
export const HAS_CANCEL_AND_HOLD =
  typeof AudioParam !== 'undefined' && typeof (AudioParam.prototype as Partial<AudioParam>).cancelAndHoldAtTime === 'function';

type EventKind = 'set' | 'lin' | 'exp' | 'target';

interface TimelineEvent {
  kind: EventKind;
  time: number;
  value: number;
  /** setTarget time constant (target events only). */
  tau: number;
}

function interpolate(kind: EventKind, t0: number, v0: number, t1: number, v1: number, t: number): number {
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
  if (kind === 'exp' && v0 !== 0 && v0 * v1 > 0) return v0 * Math.pow(v1 / v0, f);
  return v0 + (v1 - v0) * f;
}

/**
 * Automation on one or more AudioParams (all receive the same events) plus
 * a model of the resulting curve following the Web Audio timeline rules.
 * Ramps are always anchored with an explicit start value so their shape
 * never depends on when a previous setTarget was cut short.
 */
export class ParamTimeline {
  private events: TimelineEvent[] = [];

  constructor(
    private readonly params: readonly AudioParam[],
    private readonly initial: number,
    /** Use cancelAndHoldAtTime when the browser has it; otherwise the model supplies the held value. */
    private readonly useHold: boolean = HAS_CANCEL_AND_HOLD,
  ) {}

  /** The scheduled (un-modulated) value at context time `t`. */
  valueAt(t: number): number {
    let v = this.initial;
    let vt = -Infinity;
    let target: TimelineEvent | null = null;
    let targetFrom = 0;
    for (const e of this.events) {
      if (e.time > t) {
        if (target) return target.value + (targetFrom - target.value) * Math.exp(-(t - target.time) / target.tau);
        if ((e.kind === 'lin' || e.kind === 'exp') && vt > -Infinity) return interpolate(e.kind, vt, v, e.time, e.value, t);
        return v;
      }
      if (target) {
        v = target.value + (targetFrom - target.value) * Math.exp(-(e.time - target.time) / target.tau);
        vt = e.time;
        target = null;
      }
      if (e.kind === 'target') {
        target = e;
        targetFrom = v;
      } else {
        v = e.value;
        vt = e.time;
      }
    }
    if (target) return target.value + (targetFrom - target.value) * Math.exp(-(t - target.time) / target.tau);
    return v;
  }

  /**
   * Integral of the scheduled value over [t0, t1] (e.g. oscillator cycles
   * from a frequency timeline). Piecewise between events, Simpson's rule on
   * each piece: exact for constants and linear ramps, and far below 1e-6
   * relative error for exponential ramps and targets.
   */
  integral(t0: number, t1: number): number {
    if (!(t1 > t0)) return 0;
    const bounds = [t0];
    for (const e of this.events) if (e.time > t0 && e.time < t1 && e.time !== bounds[bounds.length - 1]) bounds.push(e.time);
    bounds.push(t1);
    const n = 16;
    let sum = 0;
    for (let p = 0; p + 1 < bounds.length; p++) {
      const a = bounds[p];
      const b = bounds[p + 1];
      const h = (b - a) / n;
      if (!(h > 0)) continue;
      // Left limit at the piece end, so a jump at b belongs to the next piece.
      const endProbe = b - Math.min(1e-9, h * 1e-3);
      let acc = this.valueAt(a) + this.valueAt(endProbe);
      for (let i = 1; i < n; i++) acc += (i % 2 ? 4 : 2) * this.valueAt(a + i * h);
      sum += (acc * h) / 3;
    }
    return sum;
  }

  /** Model insertion: after events at or before `time`; replaces an event of the same kind at the same time (as browsers do). */
  private insert(e: TimelineEvent): void {
    let i = 0;
    while (i < this.events.length && this.events[i].time <= e.time) {
      if (this.events[i].time === e.time && this.events[i].kind === e.kind) {
        this.events[i] = e;
        return;
      }
      i++;
    }
    this.events.splice(i, 0, e);
  }

  set(time: number, value: number): void {
    for (const p of this.params) p.setValueAtTime(value, time);
    this.insert({ kind: 'set', time, value, tau: 0 });
  }

  /** Linear ramp from the current value at `t0` to `value` at `t1`. */
  rampLinear(t0: number, t1: number, value: number): void {
    this.set(t0, this.valueAt(t0));
    const end = Math.max(t1, t0);
    for (const p of this.params) p.linearRampToValueAtTime(value, end);
    this.insert({ kind: 'lin', time: end, value, tau: 0 });
  }

  /** Exponential ramp (linear in log value, e.g. pitch) from the value at `t0` to `value` at `t1`. Values must be > 0. */
  rampExp(t0: number, t1: number, value: number): void {
    const from = this.valueAt(t0);
    if (!(from > 0) || !(value > 0)) {
      this.rampLinear(t0, t1, value);
      return;
    }
    this.set(t0, from);
    const end = Math.max(t1, t0);
    for (const p of this.params) p.exponentialRampToValueAtTime(value, end);
    this.insert({ kind: 'exp', time: end, value, tau: 0 });
  }

  /** Exponential approach toward `value` from `time` with time constant `tau`. */
  target(time: number, value: number, tau: number): void {
    const k = Math.max(1e-4, finiteOr(tau, 1e-4));
    for (const p of this.params) p.setTargetAtTime(value, time, k);
    this.insert({ kind: 'target', time, value, tau: k });
  }

  /**
   * Remove everything scheduled at or after `t` and hold the value the
   * timeline has at `t`, without a jump. Returns that value.
   */
  hold(t: number): number {
    const v = this.valueAt(t);
    // A ramp that is in progress at t (or ends exactly at t) is shortened to end at t on the same curve.
    let spanning: TimelineEvent | null = null;
    let prevTime = -Infinity;
    let prevKind: EventKind | null = null;
    for (const e of this.events) {
      if (e.time >= t) {
        if ((e.kind === 'lin' || e.kind === 'exp') && prevTime < t && prevTime > -Infinity && prevKind !== 'target') spanning = e;
        break;
      }
      prevTime = e.time;
      prevKind = e.kind;
    }
    for (const p of this.params) {
      if (this.useHold) {
        p.cancelAndHoldAtTime(t);
      } else {
        p.cancelScheduledValues(t);
        if (spanning?.kind === 'lin') p.linearRampToValueAtTime(v, t);
        else if (spanning?.kind === 'exp' && v > 0) p.exponentialRampToValueAtTime(v, t);
        else p.setValueAtTime(v, t);
      }
    }
    this.events = this.events.filter((e) => e.time < t);
    if (spanning && (spanning.kind === 'lin' || v > 0)) this.events.push({ kind: spanning.kind, time: t, value: v, tau: 0 });
    else this.events.push({ kind: 'set', time: t, value: v, tau: 0 });
    return v;
  }
}

/* ------------------------------------------------------------------ */
/* Amplitude envelope                                                  */
/* ------------------------------------------------------------------ */

/** Decay reaches ~95% of the way to sustain after the decay time. */
export const DECAY_TAU_DIVISOR = 3;
/** Release reaches -40 dB after the release time... */
export const RELEASE_TAU_DIVISOR = 4.6;
/** ...then a short linear ramp lands on exact zero, so stopping the sources is silent. */
export const RELEASE_END_RAMP = 0.003;

/** Release time actually used (bounded below so a release never clicks). */
export function releaseSeconds(releaseTime: number): number {
  return Math.max(0.005, finiteOr(releaseTime, 0.05));
}

/** Fade time actually used by GainEnvelope.fade. */
function fadeSeconds(fadeTime: number): number {
  return Math.max(0.001, finiteOr(fadeTime, 0.005));
}

/** The natural (un-released) shape of an envelope, kept so a cancelled cut can be undone. */
interface EnvShape {
  /** When the attack (or legato fade-in) reaches `peak`. */
  attackEnd: number;
  peak: number;
  /** Level the decay approaches. */
  sustain: number;
  decayTau: number;
}

export class GainEnvelope {
  readonly timeline: ParamTimeline;
  private shape: EnvShape | null = null;

  constructor(param: AudioParam, useHold: boolean = HAS_CANCEL_AND_HOLD) {
    this.timeline = new ParamTimeline([param], 0, useHold);
  }

  /**
   * Attack from `from` to `peak` over `attack` seconds (linear), then decay
   * toward `sustain` (absolute level) with time `decay`. `via` inserts an
   * intermediate attack point (used to hand over from a fading voice); the
   * peak is then reached at the later of the attack time and the via point.
   */
  start(
    t: number,
    from: number,
    peak: number,
    attack: number,
    sustain: number,
    decay: number,
    via?: { time: number; level: number },
  ): void {
    let attackEnd = t + Math.max(0.0005, finiteOr(attack, 0.001));
    this.timeline.set(t, from);
    if (via && via.time > t) {
      this.timeline.rampLinear(t, via.time, via.level);
      attackEnd = Math.max(attackEnd, via.time);
      if (attackEnd > via.time) this.timeline.rampLinear(via.time, attackEnd, peak);
      else this.timeline.set(attackEnd, via.level);
    } else {
      this.timeline.rampLinear(t, attackEnd, peak);
    }
    const decayTau = Math.max(0.001, finiteOr(decay, 0.1)) / DECAY_TAU_DIVISOR;
    this.timeline.target(attackEnd, sustain, decayTau);
    this.shape = { attackEnd, peak: this.timeline.valueAt(attackEnd), sustain, decayTau };
  }

  valueAt(t: number): number {
    return this.timeline.valueAt(t);
  }

  /** Release from the current level at `t`. Returns the time the level is exactly 0. */
  release(t: number, releaseTime: number): number {
    return this.continueRelease(t, t, releaseTime);
  }

  /**
   * (Re)apply, from `from` on, a release that began at `releaseStart`. The
   * exponential part is memoryless, so continuing it from the current level
   * reproduces the original curve (used when a cut inside a release tail is
   * withdrawn). Returns the time the level is exactly 0.
   */
  continueRelease(from: number, releaseStart: number, releaseTime: number): number {
    const r = releaseSeconds(releaseTime);
    const end = releaseStart + r;
    this.timeline.hold(from);
    this.timeline.target(from, 0, r / RELEASE_TAU_DIVISOR);
    this.timeline.rampLinear(Math.max(from, end), Math.max(from, end) + RELEASE_END_RAMP, 0);
    return Math.max(from, end) + RELEASE_END_RAMP;
  }

  /** Short linear fade to 0 from the current level at `t` (steal, mono cut, kill). Returns the end time. */
  fade(t: number, fadeTime: number): number {
    const f = fadeSeconds(fadeTime);
    this.timeline.hold(t);
    this.timeline.rampLinear(t, t + f, 0);
    return t + f;
  }

  /** Undo a release/fade that begins at `t`: continue the natural attack/decay from there. */
  restore(t: number): void {
    const s = this.shape;
    this.timeline.hold(t);
    if (!s) return;
    if (t < s.attackEnd) {
      this.timeline.rampLinear(t, s.attackEnd, s.peak);
      this.timeline.target(s.attackEnd, s.sustain, s.decayTau);
    } else {
      this.timeline.target(t, s.sustain, s.decayTau);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Voices                                                              */
/* ------------------------------------------------------------------ */

/** Sources of a voice stop this long after its amplitude reaches zero. */
export const STOP_MARGIN = 0.002;
/** Stop time used when a held voice is restored (a far-future time; release reschedules it). */
const HELD_STOP_TIME = 1e7;

interface CutRequest {
  /** The voice that caused the cut (mono successor), or null for steals/kills (never undone). */
  by: BaseVoice | null;
  time: number;
  fade: number;
}

/** One step of a voice's ending, applied on top of the natural envelope in time order. */
type EndOp = { kind: 'release'; time: number } | { kind: 'cut'; time: number; fade: number };

function sameOp(a: EndOp, b: EndOp): boolean {
  return a.kind === b.kind && a.time === b.time && (a.kind === 'release' || (b.kind === 'cut' && a.fade === b.fade));
}

export interface VoiceHooks {
  /** Called exactly once when the voice has ended and disconnected (or was cancelled). */
  onEnded(voice: BaseVoice, cancelled: boolean): void;
}

/**
 * VoiceHandle base: every voice has an amplitude envelope, scheduled
 * sources and a set of nodes. The voice ends when its sources report
 * `ended` (after the release tail) and then disconnects everything.
 */
export abstract class BaseVoice implements VoiceHandle {
  ended = false;
  /** Serial number: allocation order (tie-break for stealing). */
  readonly serial: number;
  /** When the amplitude is exactly 0 and the sources stop (Infinity while held). */
  endTime = Infinity;

  /** Start of the note's own release (Infinity while held). */
  private releaseAt = Infinity;
  private readonly cuts: CutRequest[] = [];
  /** The ending currently scheduled on the envelope. */
  private scheduled: EndOp[] = [];
  private pendingSources = 0;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly links: [AudioNode, AudioParam][] = [];

  private static nextSerial = 1;

  protected constructor(
    protected readonly ctx: BaseAudioContext,
    readonly startTime: number,
    protected readonly env: GainEnvelope,
    /** Release time of this note (seconds), snapshotted at trigger. */
    protected readonly releaseTime: number,
    /**
     * Nominal end of the sound if nothing releases it (e.g. a one-shot
     * sample at its unmodulated rate); Infinity for oscillators. Used for
     * voice bookkeeping (endTime); the sources themselves decide when they finish.
     */
    protected readonly naturalEnd: number,
    private readonly hooks: VoiceHooks,
  ) {
    this.serial = BaseVoice.nextSerial++;
    this.endTime = naturalEnd;
  }

  /** Register a started source. The voice ends once every registered source has ended. */
  protected addSource(src: AudioScheduledSourceNode): void {
    this.sources.push(src);
    this.nodes.push(src);
    this.pendingSources++;
    src.onended = () => {
      src.onended = null;
      this.pendingSources--;
      if (this.pendingSources <= 0) this.finish(false);
    };
  }

  /** Nodes to disconnect when the voice ends. */
  protected addNodes(...nodes: AudioNode[]): void {
    this.nodes.push(...nodes);
  }

  /** A modulation bus feeding a param of this voice; unhooked when the voice ends. */
  protected link(bus: AudioNode, param: AudioParam): void {
    bus.connect(param);
    this.links.push([bus, param]);
  }

  /** Whether this voice produces sound at context time `t` (started, not yet silent). */
  soundingAt(t: number): boolean {
    return !this.ended && this.startTime <= t && this.endTime > t;
  }

  /** Whether this voice still occupies a polyphony slot at `t` (not ending before or at `t`). */
  occupiesAt(t: number): boolean {
    return !this.ended && this.endTime > t && this.cutStart() > t;
  }

  private cutStart(): number {
    let c = Infinity;
    for (const r of this.cuts) c = Math.min(c, r.time);
    return c;
  }

  /**
   * A requested ending time, never before the note starts and never in the
   * past: automation scheduled behind the audio clock would make the level
   * jump to where the curve "should" be by now (a click).
   */
  private endingTime(time: number): number {
    return Math.max(finiteOr(time, this.startTime), this.startTime, this.ctx.currentTime);
  }

  release(time: number): void {
    if (this.ended) return;
    const t = this.endingTime(time);
    if (t >= this.releaseAt) return;
    this.releaseAt = t;
    this.reschedule();
  }

  /** Fast fade starting at `time` (steal, mono successor, kill). */
  cut(time: number, fade: number, by: BaseVoice | null): void {
    if (this.ended) return;
    const t = this.endingTime(time);
    this.cuts.push({ by, time: t, fade });
    this.reschedule();
  }

  /** Withdraw the cuts caused by `by` (it was cancelled before sounding). Cuts already under way stay. */
  uncut(by: BaseVoice): void {
    if (this.ended) return;
    const now = this.ctx.currentTime;
    const before = this.cuts.length;
    for (let i = this.cuts.length - 1; i >= 0; i--) {
      if (this.cuts[i].by === by && this.cuts[i].time > now) this.cuts.splice(i, 1);
    }
    if (this.cuts.length !== before) this.reschedule();
  }

  /**
   * The ending implied by the release and cut requests: the earliest cut
   * alone if it comes first; otherwise the release, followed by the earliest
   * cut if that lands inside the release tail (a steal or kill shortens a
   * long release). Steps after a one-shot's nominal end are kept: pitch
   * modulation can slow a sample down so it is still sounding then (and on
   * a source that has already finished they are harmless).
   */
  private plan(): EndOp[] {
    let cut: CutRequest | null = null;
    for (const c of this.cuts) if (!cut || c.time < cut.time) cut = c;
    const ops: EndOp[] = [];
    const rel = this.releaseAt;
    if (cut && cut.time <= rel) {
      ops.push({ kind: 'cut', time: cut.time, fade: cut.fade });
    } else {
      if (Number.isFinite(rel)) ops.push({ kind: 'release', time: rel });
      if (cut && cut.time < rel + releaseSeconds(this.releaseTime) + RELEASE_END_RAMP) ops.push({ kind: 'cut', time: cut.time, fade: cut.fade });
    }
    return ops;
  }

  /** Re-derive the envelope ending and the source stop time from the release and cut requests. */
  private reschedule(): void {
    const next = this.plan();
    const old = this.scheduled;
    let i = 0;
    while (i < old.length && i < next.length && sameOp(old[i], next[i])) i++;
    if (i === old.length && i === next.length) return;
    // Rebuild from the first point where the plans differ; steps before it are already in place.
    if (i < old.length) {
      const from = Math.min(old[i].time, next[i]?.time ?? Infinity);
      const prior = i > 0 ? next[i - 1] : null;
      if (prior?.kind === 'release') this.env.continueRelease(from, prior.time, this.releaseTime);
      else this.env.restore(from);
    }
    let end = Infinity;
    for (const op of next) {
      if (op.kind === 'release') end = op.time + releaseSeconds(this.releaseTime) + RELEASE_END_RAMP;
      else end = op.time + fadeSeconds(op.fade);
    }
    for (let k = i; k < next.length; k++) {
      const op = next[k];
      if (op.kind === 'release') this.env.release(op.time, this.releaseTime);
      else this.env.fade(op.time, op.fade);
    }
    this.scheduled = next;
    this.setEnd(end);
  }

  /**
   * `end`: when the scheduled ending reaches exact zero (Infinity while held).
   * Sources stop just after it, never earlier: a source with a natural end
   * (one-shot sample) stops by itself, possibly later than nominal under pitch
   * modulation, and must not be cut off while its amplitude is not yet zero.
   */
  private setEnd(end: number): void {
    this.endTime = Math.min(end, this.naturalEnd);
    const stopAt = Number.isFinite(end) ? end + STOP_MARGIN : HELD_STOP_TIME;
    for (const s of this.sources) {
      try {
        s.stop(stopAt);
      } catch {
        // Already stopped.
      }
    }
  }

  /** Stop immediately and free nodes. A voice that has not started never sounds. */
  cancel(): void {
    if (this.ended) return;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    this.finish(true);
  }

  private finish(cancelled: boolean): void {
    if (this.ended) return;
    this.ended = true;
    for (const s of this.sources) s.onended = null;
    for (const [bus, param] of this.links) {
      try {
        bus.disconnect(param);
      } catch {
        // Not connected any more.
      }
    }
    this.links.length = 0;
    for (const n of this.nodes) n.disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
    this.hooks.onEnded(this, cancelled);
  }
}

/* ------------------------------------------------------------------ */
/* Voice pools                                                         */
/* ------------------------------------------------------------------ */

/**
 * Make room for one more voice starting at `time`: while `limit` or more
 * voices occupy a slot at `time`, the oldest is cancelled (if it would not
 * have sounded yet) or faded out over `fade`.
 */
export function stealVoices<V extends BaseVoice>(voices: Iterable<V>, time: number, limit: number, fade: number): void {
  const occupying: V[] = [];
  for (const v of voices) if (v.occupiesAt(time)) occupying.push(v);
  let excess = occupying.length + 1 - limit;
  if (excess <= 0) return;
  occupying.sort((a, b) => a.startTime - b.startTime || a.serial - b.serial);
  for (const v of occupying) {
    if (excess <= 0) break;
    if (v.startTime >= time) v.cancel();
    else v.cut(time, fade, null);
    excess--;
  }
}

/** A GainNode forced to two output channels (instrument outputs are stereo). */
export function stereoGain(ctx: BaseAudioContext, gain: number): GainNode {
  return new GainNode(ctx, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
}
