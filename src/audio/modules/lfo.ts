/**
 * Tempo-synced LFO.
 *
 * A looping AudioBufferSourceNode plays a single-cycle wavetable; its
 * playbackRate is chosen so one cycle lasts LFO_DIVISION_BEATS[division]
 * beats at the current tempo. The bipolar (-1..1) signal leaves through a
 * depth GainNode ('out', a modulation port).
 *
 * Phase is tracked analytically with anchors {time, phase, cycles/s, tick},
 * so the LFO can be restarted at the exact phase that matches the transport
 * position (transportStarted), keep its phase across tempo changes, and swap
 * waveforms without a phase jump. Restarts crossfade old and new sources so
 * the modulation target never sees a step.
 *
 * With the transport stopped the LFO keeps running freely at the project tempo.
 */
import { PPQ, type Id, type ParamValues } from '../../project/types';
import { LFO_DIVISION_BEATS, LFO_PARAMS, BPM_SPEC, clampParam, readParam } from '../../project/params';
import { Rng } from '../../project/rng';
import { PARAM_SMOOTHING, type AutomationMode, type ModuleEnv, type ModuleNode } from './types';

/** Samples in the single-cycle wavetable (keeps playbackRate <= 1 at the fastest division/tempo). */
export const LFO_TABLE_SIZE = 2048;
/** Steps in the seeded Random shape. */
export const LFO_RANDOM_STEPS = 16;
/** Half-width (samples) of the edge smoothing applied to shapes with jumps. */
const EDGE_SMOOTH = 4;
/** Crossfade time constant for restarts, and when the old source is stopped. */
const XFADE_TAU = 0.004;
const XFADE_STOP = XFADE_TAU * 9;

/** Option indices of LFO_WAVES. */
export const LfoWave = {
  Sine: 0,
  Triangle: 1,
  SawUp: 2,
  SawDown: 3,
  Square: 4,
  Random: 5,
} as const;

function frac(x: number): number {
  const f = x - Math.floor(x);
  return f >= 1 ? 0 : f;
}

/** The seeded step values of the Random shape (bipolar). */
export function lfoRandomSteps(seed: number): number[] {
  const rng = new Rng(seed);
  return Array.from({ length: LFO_RANDOM_STEPS }, () => rng.range(-1, 1));
}

/** Raw shape value at cycle phase 0..1 (before edge smoothing). */
export function lfoShape(wave: number, phase: number, steps: readonly number[]): number {
  const p = frac(phase);
  switch (wave) {
    case LfoWave.Sine:
      return Math.sin(2 * Math.PI * p);
    case LfoWave.Triangle:
      // Starts at 0 rising, like the sine.
      return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case LfoWave.SawUp:
      return 2 * p - 1;
    case LfoWave.SawDown:
      return 1 - 2 * p;
    case LfoWave.Square:
      return p < 0.5 ? 1 : -1;
    case LfoWave.Random:
      return steps[Math.min(steps.length - 1, Math.floor(p * steps.length))] ?? 0;
    default:
      return 0;
  }
}

/**
 * Single-cycle table. Shapes with discontinuities get a short centred
 * circular moving average so hard edges do not click on level/pan targets
 * (the edge lasts ~0.4% of a cycle; no phase shift).
 */
export function lfoTable(wave: number, seed: number, size = LFO_TABLE_SIZE): Float32Array<ArrayBuffer> {
  const steps = wave === LfoWave.Random ? lfoRandomSteps(seed) : [];
  const raw = new Float32Array(size);
  for (let i = 0; i < size; i++) raw[i] = lfoShape(wave, i / size, steps);
  if (wave === LfoWave.Sine || wave === LfoWave.Triangle) return raw;
  const out = new Float32Array(size);
  const w = EDGE_SMOOTH;
  for (let i = 0; i < size; i++) {
    let s = 0;
    for (let k = -w; k <= w; k++) s += raw[(i + k + size) % size];
    out[i] = s / (2 * w + 1);
  }
  return out;
}

interface PhaseAnchor {
  time: number;
  /** Cycle phase at `time`, 0..1. */
  phase: number;
  /** Cycles per second from `time` on. */
  cps: number;
  bpm: number;
  /** Transport tick at `time`, or null while the transport is stopped (free running). */
  tick: number | null;
  /**
   * True when the phase jumps here (transport start, division change while
   * running): a new source must start at this anchor.
   */
  restart: boolean;
}

interface LfoVoice {
  src: AudioBufferSourceNode;
  fade: GainNode;
  /** Context time the source starts. */
  start: number;
  /** Context time the source is scheduled to stop (Infinity until stopped). */
  stop: number;
}

export class LfoModule implements ModuleNode {
  readonly type = 'lfo' as const;
  private readonly ctx: BaseAudioContext;
  private readonly seed: number;
  private readonly out: GainNode;
  private readonly tables = new Map<number, AudioBuffer>();
  private readonly voices = new Set<LfoVoice>();
  private anchors: PhaseAnchor[] = [];
  private wave: number;
  private division: number;
  private depth: number;
  private disposed = false;

  constructor(
    env: ModuleEnv,
    readonly id: Id,
    params: ParamValues,
  ) {
    this.ctx = env.ctx;
    this.seed = env.seed;
    this.wave = readParam(LFO_PARAMS, params, 'wave');
    this.division = readParam(LFO_PARAMS, params, 'division');
    this.depth = readParam(LFO_PARAMS, params, 'depth');
    this.out = this.ctx.createGain();
    this.out.gain.value = this.depth;
    const now = this.ctx.currentTime;
    const bpm = clampParam(BPM_SPEC, env.getBpm());
    const anchor: PhaseAnchor = { time: now, phase: 0, cps: this.cycleRate(bpm), bpm, tick: null, restart: true };
    this.anchors = [anchor];
    this.restartFrom(now);
  }

  input(_port: string): AudioNode | undefined {
    return undefined;
  }

  output(port: string): AudioNode | undefined {
    return port === 'out' ? this.out : undefined;
  }

  /** Current cycle length in beats. */
  private beats(): number {
    return LFO_DIVISION_BEATS[this.division] ?? 4;
  }

  private cycleRate(bpm: number): number {
    return bpm / 60 / this.beats();
  }

  private playbackRate(cps: number): number {
    return (cps * LFO_TABLE_SIZE) / this.ctx.sampleRate;
  }

  private table(wave: number): AudioBuffer {
    let buf = this.tables.get(wave);
    if (!buf) {
      const data = lfoTable(wave, this.seed);
      buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      buf.copyToChannel(data, 0);
      this.tables.set(wave, buf);
    }
    return buf;
  }

  private anchorAt(time: number): PhaseAnchor {
    let a = this.anchors[0];
    for (const x of this.anchors) {
      if (x.time <= time) a = x;
      else break;
    }
    return a;
  }

  /** LFO cycle phase (0..1) at context time `time`. */
  phaseAt(time: number): number {
    const a = this.anchorAt(time);
    return frac(a.phase + (time - a.time) * a.cps);
  }

  private tickAt(time: number): number | null {
    const a = this.anchorAt(time);
    return a.tick === null ? null : a.tick + ((time - a.time) * a.bpm * PPQ) / 60;
  }

  /**
   * Insert an anchor. It supersedes every anchor at or after its time, except
   * (with `keepRestarts`) later restart anchors: a transport start that is
   * already scheduled stays in place and is re-derived from its own tick
   * with the current division (and, for a tempo change, the new tempo).
   */
  private pushAnchor(anchor: PhaseAnchor, keepRestarts: boolean, tempoChange = false): void {
    const kept: PhaseAnchor[] = [];
    const later: PhaseAnchor[] = [];
    for (const a of this.anchors) {
      if (a.time < anchor.time) kept.push(a);
      else if (a.time === anchor.time) {
        // Same instant as a restart (e.g. a tempo event at the transport start): stay a restart.
        if (keepRestarts && a.restart) anchor.restart = true;
      } else if (keepRestarts && a.restart) {
        const bpm = tempoChange ? anchor.bpm : a.bpm;
        // Like the sequencer's tempo map: a tempo change before the start
        // re-times the stretch in between, which moves the tick reached there.
        const tick = a.tick === null ? null : a.tick + ((a.time - anchor.time) * (bpm - a.bpm) * PPQ) / 60;
        const phase = tick === null ? a.phase : frac(tick / (this.beats() * PPQ));
        later.push({ ...a, bpm, tick, cps: this.cycleRate(bpm), phase });
      }
    }
    kept.push(anchor, ...later);
    // Keep the anchor in force now and everything after it.
    const now = this.ctx.currentTime;
    let first = 0;
    while (first + 1 < kept.length && kept[first + 1].time <= now) first++;
    this.anchors = kept.slice(first);
  }

  private hasRestartAfter(time: number): boolean {
    return this.anchors.some((a) => a.restart && a.time > time);
  }

  /**
   * (Re)build the sources from `time` on: one starting at `time` with the
   * modelled phase, then one at every later restart anchor, each crossfading
   * from the previous one. Sources that were scheduled to start at/after
   * `time` are cancelled before they sound.
   */
  private restartFrom(time: number): void {
    const points = [time];
    for (const a of this.anchors) if (a.restart && a.time > time) points.push(a.time);
    for (const t of points) this.spawn(t, this.phaseAt(t));
  }

  private spawn(time: number, phase: number): void {
    const ctx = this.ctx;
    let audible = false;
    for (const v of this.voices) {
      if (v.start >= time) {
        // Never heard: silence it and end it no later than its start.
        v.fade.gain.cancelScheduledValues(0);
        v.fade.gain.value = 0;
        if (v.stop > v.start) {
          v.stop = v.start;
          v.src.stop(v.start);
        }
      } else if (v.stop > time) {
        audible = true;
        // setTargetAtTime starts from whatever value the fade has at `time`,
        // so overlapping restarts stay continuous.
        v.fade.gain.cancelScheduledValues(time);
        v.fade.gain.setTargetAtTime(0, time, XFADE_TAU);
        const stop = time + XFADE_STOP;
        if (stop < v.stop) {
          v.stop = stop;
          v.src.stop(stop);
        }
      }
    }

    const buf = this.table(this.wave);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = this.playbackRate(this.anchorAt(time).cps);
    for (const a of this.anchors) {
      if (a.time > time) src.playbackRate.setValueAtTime(this.playbackRate(a.cps), a.time);
    }
    const fade = ctx.createGain();
    src.connect(fade);
    fade.connect(this.out);
    const voice: LfoVoice = { src, fade, start: time, stop: Infinity };
    src.onended = () => this.releaseVoice(voice);
    this.voices.add(voice);
    if (audible) {
      fade.gain.value = 0;
      fade.gain.setTargetAtTime(1, time, XFADE_TAU);
    } else {
      fade.gain.value = 1;
    }
    src.start(time, phase * buf.duration);
  }

  private releaseVoice(v: LfoVoice): void {
    v.src.onended = null;
    v.src.disconnect();
    v.fade.disconnect();
    this.voices.delete(v);
  }

  /** Re-apply the anchors' playback rates from `time` on to every live source (phase-continuous). */
  private applyRate(time: number): void {
    for (const v of this.voices) {
      if (v.stop <= time) continue;
      const p = v.src.playbackRate;
      p.cancelScheduledValues(time);
      for (const a of this.anchors) {
        if (a.time >= time) p.setValueAtTime(this.playbackRate(a.cps), a.time);
      }
    }
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = Math.max(Number.isFinite(time) ? time : 0, this.ctx.currentTime);
    const wave = readParam(LFO_PARAMS, params, 'wave');
    const division = readParam(LFO_PARAMS, params, 'division');
    const depth = readParam(LFO_PARAMS, params, 'depth');

    if (depth !== this.depth) {
      this.depth = depth;
      this.out.gain.setTargetAtTime(depth, t, PARAM_SMOOTHING);
    }

    const waveChanged = wave !== this.wave;
    const divChanged = division !== this.division;
    if (!waveChanged && !divChanged) return;

    const before = this.anchorAt(t);
    const tick = this.tickAt(t);
    let phase = this.phaseAt(t);
    this.wave = wave;
    this.division = division;
    let restart = waveChanged;
    if (divChanged) {
      if (tick !== null) {
        // Transport running: jump to the phase the new cycle length has at this tick.
        phase = frac(tick / (this.beats() * PPQ));
        restart = true;
      }
      this.pushAnchor({ time: t, phase, cps: this.cycleRate(before.bpm), bpm: before.bpm, tick, restart: tick !== null }, true);
      // Scheduled restarts were re-derived for the new cycle length: rebuild their sources.
      if (this.hasRestartAfter(t)) restart = true;
    }
    if (restart) this.restartFrom(t);
    else this.applyRate(t);
  }

  /** Song automation: Depth set at `time` ('anchor' / 'step') or ramped linearly to it ('ramp'); shape and rate as setParams. */
  automate(params: ParamValues, time: number, mode: AutomationMode): void {
    if (this.disposed) return;
    const t = Math.max(Number.isFinite(time) ? time : 0, this.ctx.currentTime);
    const depth = readParam(LFO_PARAMS, params, 'depth');
    if (mode === 'anchor' || depth !== this.depth) {
      if (mode === 'ramp') this.out.gain.linearRampToValueAtTime(depth, t);
      else this.out.gain.setValueAtTime(depth, t);
    }
    this.depth = depth;
    this.setParams(params, t);
  }

  setBypass(_bypass: boolean, _time: number): void {
    // Nothing to do here: the engine glides a bypassed LFO's cables to 0
    // (AudioEngine.reconcileConnections), so the LFO keeps its phase and
    // resumes in step when switched back on.
  }

  setTempo(bpm: number, time: number): void {
    if (this.disposed || !Number.isFinite(bpm)) return;
    const b = clampParam(BPM_SPEC, bpm);
    const t = Math.max(Number.isFinite(time) ? time : 0, this.ctx.currentTime);
    const a = this.anchorAt(t);
    if (a.bpm === b && this.anchors[this.anchors.length - 1] === a) return;
    this.pushAnchor({ time: t, phase: this.phaseAt(t), cps: this.cycleRate(b), bpm: b, tick: this.tickAt(t), restart: false }, true, true);
    // A scheduled restart moved with the new tempo: rebuild its source too.
    if (this.hasRestartAfter(t)) this.restartFrom(t);
    else this.applyRate(t);
  }

  /** Align the cycle to the transport: phase = (tick / cycle ticks) mod 1 at `time`. */
  transportStarted(time: number, tick: number, bpm: number): void {
    if (this.disposed || !Number.isFinite(time) || !Number.isFinite(tick) || !Number.isFinite(bpm)) return;
    const b = clampParam(BPM_SPEC, bpm);
    const now = this.ctx.currentTime;
    let t = time;
    let tk = tick;
    if (t < now) {
      // Started in the past (late call): advance to now along the transport.
      tk += ((now - t) * b * PPQ) / 60;
      t = now;
    }
    const phase = frac(tk / (this.beats() * PPQ));
    this.pushAnchor({ time: t, phase, cps: this.cycleRate(b), bpm: b, tick: tk, restart: true }, false);
    this.restartFrom(t);
  }

  /** Transport stopped: keep running freely from the current phase. */
  transportStopped(time: number): void {
    if (this.disposed) return;
    const t = Math.max(Number.isFinite(time) ? time : 0, this.ctx.currentTime);
    const a = this.anchorAt(t);
    if (a.tick === null && this.anchors[this.anchors.length - 1] === a) return;
    // A transport start still pending after `t` is called off with the stop.
    const pending = this.hasRestartAfter(t);
    this.pushAnchor({ time: t, phase: this.phaseAt(t), cps: a.cps, bpm: a.bpm, tick: null, restart: false }, false);
    if (pending) this.restartFrom(t);
    else this.applyRate(t);
  }

  /**
   * Cancel depth automation scheduled at/after `time`; depth keeps heading to
   * the latest value (the engine re-applies the value that should hold).
   */
  cancelAfter(time: number, hold = false): void {
    if (this.disposed) return;
    const t = Math.max(Number.isFinite(time) ? time : 0, this.ctx.currentTime);
    if (hold) {
      // A depth ramp under way stops where it is; the engine re-applies the value to hold.
      this.out.gain.cancelAndHoldAtTime(t);
      this.depth = Number.NaN;
      return;
    }
    this.out.gain.cancelScheduledValues(t);
    if (Number.isFinite(this.depth)) this.out.gain.setTargetAtTime(this.depth, t, PARAM_SMOOTHING);
  }

  /** Number of sources alive (current + fading), for resource checks. */
  sourceCount(): number {
    return this.voices.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const v of [...this.voices]) {
      v.src.onended = null;
      try {
        v.src.stop();
      } catch {
        // Already stopped.
      }
      this.releaseVoice(v);
    }
    this.out.disconnect();
    this.tables.clear();
  }
}
