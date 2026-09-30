/**
 * Shared helpers for the audio-engine browser tests: a small test instrument
 * (sine voices with an ADSR that honour pitchMod / cutoffMod), projects that
 * use only core modules, offline render helpers and signal measurements.
 */
import { AudioEngine } from '../../src/audio/engine';
import { limiterLatencyFrames } from '../../src/audio/worklets/limiter';
import type { EngineStats, InstrumentContext, InstrumentEngine, InstrumentFactory, NoteTrigger, VoiceHandle } from '../../src/audio/contracts';
import { MASTER_ID, conn, createProject, moduleId } from '../../src/project/factory';
import { dbToGain } from '../../src/project/params';
import type { Instrument, InstrumentKind, Project } from '../../src/project/types';

export const SR = 48000;
export const ATTACK = 0.004;
export const RELEASE = 0.02;
/** The output limiter's look-ahead delays everything the engine outputs. */
export const LATENCY = limiterLatencyFrames(SR) / SR;

export function midiToHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** (Fractional) note number whose test-instrument frequency is exactly `hz`. */
export function pitchForHz(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

class TestVoice implements VoiceHandle {
  ended = false;
  private released = false;

  constructor(
    readonly startTime: number,
    private readonly owner: TestInstrument,
    private readonly osc: OscillatorNode,
    private readonly filter: BiquadFilterNode,
    private readonly env: GainNode,
    private readonly level: number,
  ) {
    osc.onended = () => this.cleanup();
  }

  release(time: number): void {
    if (this.released || this.ended) return;
    this.released = true;
    // Sustain is flat at `level` after the attack, so the release starts from it.
    const t = Math.max(time, this.startTime + ATTACK, this.owner.ctx.currentTime);
    this.env.gain.cancelScheduledValues(t);
    this.env.gain.setValueAtTime(this.level, t);
    this.env.gain.linearRampToValueAtTime(0, t + RELEASE);
    this.osc.stop(t + RELEASE + 0.005);
  }

  cancel(): void {
    if (this.ended) return;
    this.osc.onended = null;
    try {
      this.osc.stop();
    } catch {
      // never started
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.ended) return;
    this.ended = true;
    this.osc.onended = null;
    try {
      this.owner.pitchMod.disconnect(this.osc.detune);
    } catch {
      // already gone
    }
    try {
      this.owner.cutoffMod.disconnect(this.filter.detune);
    } catch {
      // already gone
    }
    this.osc.disconnect();
    this.filter.disconnect();
    this.env.disconnect();
    this.owner.voices.delete(this);
  }
}

export class TestInstrument implements InstrumentEngine {
  readonly kind: InstrumentKind;
  readonly ctx: BaseAudioContext;
  readonly output: GainNode;
  readonly pitchMod: GainNode;
  readonly cutoffMod: GainNode;
  readonly voices = new Set<TestVoice>();
  disposed = false;
  updates = 0;

  constructor(
    ictx: InstrumentContext,
    instrument: Instrument,
    readonly trackHint: string,
  ) {
    this.ctx = ictx.ctx;
    this.kind = instrument.kind;
    this.output = this.ctx.createGain();
    // Stereo output: mono voices are copied to both channels.
    this.output.channelCount = 2;
    this.output.channelCountMode = 'explicit';
    this.output.channelInterpretation = 'speakers';
    this.output.gain.value = dbToGain(instrument.params.level ?? 0);
    this.pitchMod = this.ctx.createGain();
    this.cutoffMod = this.ctx.createGain();
  }

  update(instrument: Instrument, time: number): void {
    this.updates++;
    this.output.gain.setTargetAtTime(dbToGain(instrument.params.level ?? 0), time, 0.005);
  }

  trigger(note: NoteTrigger): VoiceHandle | null {
    if (this.disposed) return null;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.value = midiToHz(note.pitch);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 16000;
    filter.Q.value = 0.5;
    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, note.time);
    env.gain.linearRampToValueAtTime(note.velocity, note.time + ATTACK);
    osc.connect(filter);
    filter.connect(env);
    env.connect(this.output);
    this.pitchMod.connect(osc.detune);
    this.cutoffMod.connect(filter.detune);
    const voice = new TestVoice(note.time, this, osc, filter, env, note.velocity);
    this.voices.add(voice);
    osc.start(note.time);
    if (note.duration !== undefined) voice.release(note.time + note.duration);
    return voice;
  }

  releaseAll(time: number): void {
    for (const v of [...this.voices]) v.release(time);
  }

  kill(): void {
    for (const v of [...this.voices]) v.cancel();
  }

  activeVoices(): number {
    return this.voices.size;
  }

  dispose(): void {
    this.kill();
    this.disposed = true;
    this.output.disconnect();
    this.pitchMod.disconnect();
    this.cutoffMod.disconnect();
  }
}

/** A factory that records every instrument it builds. */
export function makeFactory(): { factory: InstrumentFactory; built: TestInstrument[] } {
  const built: TestInstrument[] = [];
  const factory: InstrumentFactory = (ictx, instrument) => {
    const inst = new TestInstrument(ictx, instrument, String(built.length));
    built.push(inst);
    return inst;
  };
  return { factory, built };
}

/** Default project, fixed seed, master and instrument levels at 0 dB and no send levels. */
export function baseProject(bpm = 120): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 4242;
  p.masterVolumeDb = 0;
  for (const t of p.tracks) {
    t.macros = { ...t.macros, space: 0, echo: 0 };
    t.instrument.params.level = 0;
  }
  return p;
}

/**
 * Only core modules (instrument, LFO, channel, master): each track is
 * instrument -> channel -> master. No effect module takes part.
 */
export function coreProject(bpm = 120): Project {
  const p = baseProject(bpm);
  const keep = new Set(['instrument', 'channel', 'lfo', 'master']);
  p.patch.modules = p.patch.modules.filter((m) => keep.has(m.type));
  p.patch.connections = p.tracks.flatMap((t) => [
    conn(moduleId.inst(t.id), 'out', moduleId.channel(t.id), 'in'),
    conn(moduleId.channel(t.id), 'out', MASTER_ID, 'in'),
  ]);
  return p;
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function moduleParams(p: Project, id: string): Record<string, number> {
  const m = p.patch.modules.find((x) => x.id === id);
  if (!m) throw new Error(`no module ${id}`);
  return m.params;
}

export interface Harness {
  ctx: OfflineAudioContext;
  engine: AudioEngine;
  /** Run `fn` when the render reaches `time` (engine calls at a precise audio time). */
  at(time: number, fn: () => void): void;
  render(): Promise<Rendered>;
}

export interface Rendered {
  L: Float32Array;
  R: Float32Array;
  stats: EngineStats;
}

export async function harness(seconds: number, project: Project, factory: InstrumentFactory = makeFactory().factory): Promise<Harness> {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const engine = await AudioEngine.create(ctx, { samples: { get: () => null }, seed: 7, meters: false, instrumentFactory: factory });
  engine.setProject(project);
  const errors: unknown[] = [];
  return {
    ctx,
    engine,
    at(time, fn) {
      ctx.suspend(time).then(
        () => {
          try {
            fn();
          } catch (err) {
            errors.push(err);
          } finally {
            void ctx.resume();
          }
        },
        // A suspend that cannot be scheduled (same render quantum as another,
        // or already past) must fail the test, not silently skip the step.
        (err: unknown) => errors.push(new Error(`at(${time}) was not scheduled: ${String(err)}`)),
      );
    },
    async render() {
      const buf = await ctx.startRendering();
      const stats = engine.getStats();
      engine.dispose();
      if (errors.length) throw errors[0];
      return { L: buf.getChannelData(0), R: buf.getChannelData(1), stats };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Measurements                                                        */
/* ------------------------------------------------------------------ */

function range(d: Float32Array, t0: number, t1: number): [number, number] {
  return [Math.max(0, Math.round(t0 * SR)), Math.min(d.length, Math.round(t1 * SR))];
}

export function peak(d: Float32Array, t0 = 0, t1 = d.length / SR): number {
  const [a, b] = range(d, t0, t1);
  let m = 0;
  for (let i = a; i < b; i++) {
    const v = Math.abs(d[i]);
    if (v > m || Number.isNaN(v)) m = Number.isNaN(v) ? Infinity : v;
  }
  return m;
}

export function rms(d: Float32Array, t0: number, t1: number): number {
  const [a, b] = range(d, t0, t1);
  let s = 0;
  for (let i = a; i < b; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

/**
 * Amplitude of the `freq` component in [t0, t1): single-bin DFT with a Hann
 * window, so other tones more than a few bins away do not leak in.
 */
export function toneAmp(d: Float32Array, freq: number, t0: number, t1: number): number {
  const [a, b] = range(d, t0, t1);
  const n = Math.max(2, b - a);
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = a; i < b; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (n - 1));
    const ph = (2 * Math.PI * freq * i) / SR;
    re += w * d[i] * Math.cos(ph);
    im += w * d[i] * Math.sin(ph);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

/** Peak envelope in windows of `win` seconds: [{t (window centre), v}]. */
export function envelope(d: Float32Array, t0: number, t1: number, win: number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  for (let t = t0; t + win <= t1 + 1e-9; t += win) out.push({ t: t + win / 2, v: peak(d, t, t + win) });
  return out;
}

/**
 * Amplitude envelope of a steady tone whose period is exactly `cycle`
 * samples: RMS x sqrt(2) over each whole cycle.
 */
export function cycleEnvelope(d: Float32Array, cycle: number, t0: number, t1: number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  const a = Math.round(t0 * SR);
  const b = Math.min(d.length, Math.round(t1 * SR));
  for (let i = a; i + cycle <= b; i += cycle) {
    let s = 0;
    for (let k = i; k < i + cycle; k++) s += d[k] * d[k];
    out.push({ t: (i + cycle / 2) / SR, v: Math.sqrt((2 * s) / cycle) });
  }
  return out;
}

/**
 * Sinusoidal amplitude modulation of an envelope at frequency `f` (Hz):
 * depth = |E1| / E0 and the phase of the component, using whole periods.
 */
export function modulation(env: { t: number; v: number }[], f: number): { depth: number; mean: number } {
  let re = 0;
  let im = 0;
  let sum = 0;
  for (const e of env) {
    re += e.v * Math.cos(2 * Math.PI * f * e.t);
    im += e.v * Math.sin(2 * Math.PI * f * e.t);
    sum += e.v;
  }
  const mean = sum / env.length;
  return { depth: (2 * Math.hypot(re, im)) / env.length / mean, mean };
}

/** Time of the minimum envelope value within [t0, t1]. */
export function argMin(env: { t: number; v: number }[], t0: number, t1: number): { t: number; v: number } {
  let best = { t: NaN, v: Infinity };
  for (const e of env) if (e.t >= t0 && e.t <= t1 && e.v < best.v) best = e;
  return best;
}
