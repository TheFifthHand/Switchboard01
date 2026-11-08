/**
 * Mono bass synth (InstrumentEngine for `bass` instruments).
 *
 * Per note:
 *   OscillatorNode (wave) [+ two Unison copies] ─► oscGain ─┐
 *   sub-oscillator (Sub Shape, -1200 ct) ─────────► subGain ─┴► low-pass ► low-pass (24 dB/oct)
 *   ► pre-gain ► WaveShaper tanh (2x oversampled) ► level compensation ► VCA ► output (level dB)
 *
 *   FM (FM Amount > 0): sine modulator at FM Ratio × the note (it glides with
 *   the note) ─► depth ─► envelope ─► main oscillator frequency (not the sub).
 *   Pitch Sweep ≠ 0: a decaying offset on every oscillator's detune (a legato
 *   note does not sweep, as it does not restrike).
 *   Unison Detune > 0: two copies of the main wave at ± the detune, starting
 *   at other phases; the three share the main oscillator's level.
 *   Every one of these is neutral by default and builds no nodes then, so a
 *   sound that does not use them renders exactly as before they existed.
 *
 * - Filter envelope: detune of both filter stages jumps to envAmount x
 *   (up to +6000 ct = 5 octaves, velocity-scaled) and decays toward 0 over
 *   filterDecay. cutoffMod is summed into the same detune params.
 * - pitchMod is summed into both oscillators' detune.
 * - Mono: at most one voice sounds. A trigger at T fades any voice still
 *   sounding at T over 5 ms. A legato trigger starts at the previous voice's
 *   pitch and glides (exponential ramp, i.e. linear in semitones) to its own
 *   over `glide` seconds, continuing the previous filter envelope and
 *   amplitude instead of retriggering them. If the previous note has already
 *   decayed to (near) silence there is nothing to continue, so the envelope
 *   restarts (the glide still happens).
 * - Phase alignment: when the new note starts at the pitch the previous
 *   voice has at T (legato, or a repeated note), its oscillators start a
 *   fraction of a cycle early with the VCA closed, so at T they are in phase
 *   with the previous voice. The 5 ms handover is then between near-identical
 *   signals: no level dip, no phase-cancellation knock. This needs the
 *   pre-roll to lie in the future (always offline; with the transport's
 *   look-ahead live). Pitch modulation is not part of the phase estimate.
 * - If a successor that cut a voice is cancelled before it sounds (the
 *   transport invalidated it), the cut is withdrawn and the voice continues.
 */
import { BASS_PARAMS, dbToGain, readParam } from '../../project/params';
import type { BassInstrument, Instrument } from '../../project/types';
import type { InstrumentContext, InstrumentEngine, NoteTrigger, VoiceHandle } from '../contracts';
import { PARAM_SMOOTHING } from '../modules/types';
import { FM_SUSTAIN, UNISON_PHASES, fmDeviationHz, fmRatioCents, phasedOscillator } from './synthParts';
import {
  BaseVoice,
  GainEnvelope,
  ParamTimeline,
  clamp,
  finiteOr,
  midiToHz,
  stereoGain,
  velocityAmount,
  velocityGain,
  type VoiceHooks,
} from './voice';

/** Fade of a voice cut by the next mono note, and legato crossfade (seconds). */
export const MONO_CUT_FADE = 0.005;
/** Fade used by kill() (seconds). */
export const MONO_KILL_FADE = 0.004;
/** Peak VCA gain at velocity 1 (level 0 dB): a default note peaks around -7 dBFS. */
const MONO_PEAK = 0.6;
/** Oscillator level into the filter; square/triangle/sine are matched to the saw's loudness. */
const OSC_LEVEL = 0.6;
const WAVE_TYPES: readonly OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];
const WAVE_GAIN: readonly number[] = [1, 0.72, 1.2, 1];
/** Sub-oscillator level at sub = 100%: square, and sine (RMS-matched to the square). */
const SUB_LEVEL = 0.42;
const SUB_SINE_LEVEL = SUB_LEVEL * Math.SQRT2;
/** Filter envelope depth at envAmount = 100%: +5 octaves. */
const ENV_MAX_CENTS = 6000;
/** A legato note continues the previous envelope only if it is above this fraction of the new peak. */
const LEGATO_MIN_LEVEL = 0.02;
/** A phase-aligned pre-roll must start at least this far after the current time (render quantum margin). */
const PREROLL_SAFETY = 0.003;
/** Saturation curve spans tanh(-8..8); pre-gain k/8 selects how far into it the signal goes. */
const DRIVE_RANGE = 8;
const DRIVE_CURVE_POINTS = 4097;

/**
 * Per-stage low-pass Q (dB) for resonance r. At r = 0 the two stages form a
 * 4-pole Butterworth (-5.33 / +2.33 dB, flat pass band); at r = 1 the peak at
 * the cutoff is +14 dB in total: strong and vocal, never self-oscillating.
 */
export function bassFilterQ(resonance: number): [number, number] {
  const r = clamp(resonance, 0, 1);
  return [-5.33 + r * (1 + 5.33), 2.33 + r * (13 - 2.33)];
}

/** Drive amount -> tanh gain k (0.4 is nearly clean warmth, 7.4 is heavy saturation). */
export function driveK(drive: number): number {
  const d = clamp(drive, 0, 1);
  return 0.4 + 7 * d * d;
}

/** Output gain that keeps the RMS of a half-scale sine equal before and after tanh(k x). */
export function driveCompensation(k: number): number {
  const amp = 0.5;
  let a = 0;
  let b = 0;
  for (let i = 0; i < 64; i++) {
    const x = amp * Math.sin((2 * Math.PI * (i + 0.5)) / 64);
    const y = Math.tanh(k * x);
    a += x * x;
    b += y * y;
  }
  return b > 0 ? Math.sqrt(a / b) : 1;
}

let sharedCurve: Float32Array<ArrayBuffer> | null = null;
function driveCurve(): Float32Array<ArrayBuffer> {
  if (!sharedCurve) {
    sharedCurve = new Float32Array(DRIVE_CURVE_POINTS);
    for (let i = 0; i < DRIVE_CURVE_POINTS; i++) {
      const x = (2 * i) / (DRIVE_CURVE_POINTS - 1) - 1;
      sharedCurve[i] = Math.tanh(DRIVE_RANGE * x);
    }
  }
  return sharedCurve;
}

interface BassSettings {
  wave: number;
  octave: number;
  sub: number;
  subWave: number;
  unisonDetune: number;
  fmAmount: number;
  fmRatio: number;
  fmDecay: number;
  pitchEnv: number;
  pitchDecay: number;
  cutoff: number;
  resonance: number;
  envAmount: number;
  filterDecay: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  glide: number;
  drive: number;
  velocity: number;
  level: number;
}

function readSettings(instrument: BassInstrument, sampleRate: number): BassSettings {
  const p = instrument.params;
  const r = (id: string) => readParam(BASS_PARAMS, p, id);
  return {
    wave: r('wave'),
    octave: r('octave'),
    sub: r('sub'),
    subWave: r('subWave'),
    unisonDetune: r('unisonDetune'),
    fmAmount: r('fmAmount'),
    fmRatio: r('fmRatio'),
    fmDecay: r('fmDecay'),
    pitchEnv: r('pitchEnv'),
    pitchDecay: r('pitchDecay'),
    cutoff: Math.min(r('cutoff'), sampleRate * 0.45),
    resonance: r('resonance'),
    envAmount: r('envAmount'),
    filterDecay: r('filterDecay'),
    attack: r('attack'),
    decay: r('decay'),
    sustain: r('sustain'),
    release: r('release'),
    glide: r('glide'),
    drive: r('drive'),
    velocity: r('velocity'),
    level: r('level'),
  };
}

interface MonoVoiceInit {
  settings: BassSettings;
  time: number;
  fromHz: number;
  toHz: number;
  /** Continue from a previous voice: its filter-envelope detune and amplitude at `time`. */
  legato: { envCents: number; level: number } | null;
  /**
   * Phase alignment with the previous voice: start times for the oscillator
   * and the sub (at or before `time`) that give both the same phase as the
   * previous voice's at `time`; `envCents` is the previous filter envelope
   * at the earlier of the two and `level` the previous amplitude at `time`.
   * Null starts both at `time`.
   */
  align: { oscStart: number; subStart: number; envCents: number; level: number } | null;
  velocity: number;
  destination: AudioNode;
  pitchMod: AudioNode;
  cutoffMod: AudioNode;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

function subLevel(s: BassSettings): number {
  return s.sub * (s.subWave === 1 ? SUB_SINE_LEVEL : SUB_LEVEL);
}

/** Level of each main oscillator: the Unison copies share the single oscillator's level. */
function oscLevel(s: BassSettings, copies: number): number {
  return (OSC_LEVEL * (WAVE_GAIN[s.wave] ?? 1)) / Math.sqrt(1 + copies);
}

class MonoVoice extends BaseVoice {
  /** Oscillator base frequency (both oscillators; the sub is detuned -1200 ct). */
  readonly freq: ParamTimeline;
  /** Filter-envelope detune (both stages). */
  readonly filterEnv: ParamTimeline;
  readonly amp: GainEnvelope;
  /** When the oscillators actually start (earlier than the note when phase-aligned). */
  readonly oscStart: number;
  readonly subStart: number;
  private readonly f1: BiquadFilterNode;
  private readonly f2: BiquadFilterNode;
  private readonly subGain: GainNode;
  private readonly pre: GainNode;
  private readonly post: GainNode;
  /** Unison copies of the main oscillator and their detune direction (-1 / +1). */
  private readonly copies: { osc: OscillatorNode; sign: number }[] = [];
  private readonly fm: { mod: OscillatorNode; depth: GainNode; noteHz: number; velocityScale: number } | null = null;

  constructor(ctx: BaseAudioContext, init: MonoVoiceInit, hooks: VoiceHooks) {
    const s = init.settings;
    const T = init.time;
    const vca = new GainNode(ctx, { gain: 0 });
    const amp = new GainEnvelope(vca.gain);
    super(ctx, T, amp, s.release, Infinity, hooks);
    this.amp = amp;
    this.oscStart = init.align ? Math.min(T, init.align.oscStart) : T;
    this.subStart = init.align ? Math.min(T, init.align.subStart) : T;
    const preStart = Math.min(this.oscStart, this.subStart);

    const wave = WAVE_TYPES[s.wave] ?? 'sawtooth';
    const osc = new OscillatorNode(ctx, { type: wave, frequency: init.fromHz });
    const sub = new OscillatorNode(ctx, { type: s.subWave === 1 ? 'sine' : 'square', frequency: init.fromHz, detune: -1200 });
    if (s.unisonDetune > 0) {
      for (const sign of [-1, 1]) {
        const phase = UNISON_PHASES[sign < 0 ? 1 : 2];
        this.copies.push({ osc: phasedOscillator(ctx, s.wave, phase, init.fromHz, sign * s.unisonDetune), sign });
      }
    }
    const oscGain = new GainNode(ctx, { gain: oscLevel(s, this.copies.length) });
    this.subGain = new GainNode(ctx, { gain: subLevel(s) });
    const [q1, q2] = bassFilterQ(s.resonance);
    this.f1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.cutoff, Q: q1 });
    this.f2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.cutoff, Q: q2 });
    const k = driveK(s.drive);
    this.pre = new GainNode(ctx, { gain: k / DRIVE_RANGE });
    // Curve assigned after construction: passing it in the options copies it element by element (~1 ms per note).
    const shaper = new WaveShaperNode(ctx, { oversample: '2x' });
    shaper.curve = driveCurve();
    this.post = new GainNode(ctx, { gain: driveCompensation(k) });

    osc.connect(oscGain).connect(this.f1);
    if (this.copies.length) {
      // The copies meet in their own bus first, so oscGain sums exactly two inputs (in any order, the same result).
      const copyBus = new GainNode(ctx, { gain: 1 });
      for (const c of this.copies) c.osc.connect(copyBus);
      copyBus.connect(oscGain);
      this.addNodes(copyBus);
    }
    sub.connect(this.subGain).connect(this.f1);
    this.f1.connect(this.f2).connect(this.pre).connect(shaper).connect(this.post).connect(vca).connect(init.destination);
    this.addNodes(oscGain, this.subGain, this.f1, this.f2, this.pre, shaper, this.post, vca);
    const mains = [osc, ...this.copies.map((c) => c.osc)];
    const oscillators = [osc, sub, ...this.copies.map((c) => c.osc)];

    // FM: a sine modulator at FM Ratio x the note bends the main oscillator(s); a legato note does not restrike it.
    if (s.fmAmount > 0) {
      const mod = new OscillatorNode(ctx, { type: 'sine', frequency: init.fromHz, detune: fmRatioCents(s.fmRatio) });
      const velocityScale = velocityAmount(init.velocity, s.velocity);
      const depth = new GainNode(ctx, { gain: fmDeviationHz(s.fmAmount, s.fmRatio, init.toHz, ctx.sampleRate) * velocityScale });
      const env = new GainNode(ctx, { gain: 0 });
      mod.connect(depth).connect(env);
      for (const m of mains) env.connect(m.frequency);
      this.addNodes(depth, env);
      const fmEnv = new ParamTimeline([env.gain], 0);
      if (init.legato) fmEnv.set(T, FM_SUSTAIN);
      else {
        fmEnv.set(T, 1);
        fmEnv.target(T, FM_SUSTAIN, s.fmDecay / 3);
      }
      this.fm = { mod, depth, noteHz: init.toHz, velocityScale };
      oscillators.push(mod);
    }

    // Pitch sweep (not on a legato note: it continues rather than restrikes).
    let sweep: ConstantSourceNode | null = null;
    if (s.pitchEnv !== 0 && !init.legato) {
      sweep = new ConstantSourceNode(ctx, { offset: 0 });
      const env = new ParamTimeline([sweep.offset], 0);
      env.set(T, s.pitchEnv * 100);
      env.target(T, 0, s.pitchDecay / 3);
      for (const o of oscillators) sweep.connect(o.detune);
    }

    for (const o of oscillators) this.link(init.pitchMod, o.detune);
    this.link(init.cutoffMod, this.f1.detune);
    this.link(init.cutoffMod, this.f2.detune);

    // Pitch: fromHz (held through any silent pre-roll), then glide to toHz.
    this.freq = new ParamTimeline(
      oscillators.map((o) => o.frequency),
      init.fromHz,
    );
    this.freq.set(preStart, init.fromHz);
    if (init.fromHz !== init.toHz) {
      if (s.glide > 0) this.freq.rampExp(T, T + s.glide, init.toHz);
      else this.freq.set(T, init.toHz);
    }

    // Filter envelope and amplitude. During a pre-roll the VCA is closed and
    // the filters follow the previous voice's envelope, so their state is
    // settled when the note becomes audible.
    const peak = MONO_PEAK * velocityGain(init.velocity, s.velocity);
    const sustainLevel = peak * s.sustain;
    this.filterEnv = new ParamTimeline([this.f1.detune, this.f2.detune], 0);
    const envTau = s.filterDecay / 3;
    if (init.align && preStart < T) {
      this.filterEnv.set(preStart, init.align.envCents);
      this.filterEnv.target(preStart, 0, envTau);
    }
    if (init.legato) {
      if (!(init.align && preStart < T)) {
        this.filterEnv.set(T, init.legato.envCents);
        this.filterEnv.target(T, 0, envTau);
      }
      // Crossfade in from the previous voice's level, then settle to this note's sustain.
      amp.start(T, 0, Math.max(init.legato.level, sustainLevel), MONO_CUT_FADE, sustainLevel, s.decay);
    } else {
      this.filterEnv.set(T, s.envAmount * ENV_MAX_CENTS * velocityAmount(init.velocity, s.velocity));
      this.filterEnv.target(T, 0, envTau);
      if (init.align) {
        // Phase-aligned retrigger: while the previous voice fades out, this one takes over its level so the
        // sum follows an attack that starts from the current level (as a single analog envelope would).
        const from = init.align.level;
        const handover = from + (peak - from) * Math.min(1, MONO_CUT_FADE / Math.max(s.attack, 1e-4));
        amp.start(T, 0, peak, s.attack, sustainLevel, s.decay, { time: T + MONO_CUT_FADE, level: handover });
      } else {
        amp.start(T, 0, peak, s.attack, sustainLevel, s.decay);
      }
    }

    osc.start(this.oscStart);
    sub.start(this.subStart);
    this.addSource(osc);
    this.addSource(sub);
    for (const o of oscillators.slice(2)) {
      o.start(this.oscStart);
      this.addSource(o);
    }
    if (sweep) {
      sweep.start(T);
      this.addSource(sweep);
    }
  }

  /** Oscillator phase (in cycles) at `t`, from the scheduled frequency; pitch modulation is not included. */
  oscCycles(t: number): number {
    return this.freq.integral(this.oscStart, t);
  }

  subCycles(t: number): number {
    return this.freq.integral(this.subStart, t) / 2;
  }

  /** Smoothly apply continuous settings to this sounding voice. */
  applyLive(s: BassSettings, time: number): void {
    if (this.ended) return;
    const [q1, q2] = bassFilterQ(s.resonance);
    const k = driveK(s.drive);
    this.f1.frequency.setTargetAtTime(s.cutoff, time, PARAM_SMOOTHING);
    this.f2.frequency.setTargetAtTime(s.cutoff, time, PARAM_SMOOTHING);
    this.f1.Q.setTargetAtTime(q1, time, PARAM_SMOOTHING);
    this.f2.Q.setTargetAtTime(q2, time, PARAM_SMOOTHING);
    this.subGain.gain.setTargetAtTime(subLevel(s), time, PARAM_SMOOTHING);
    this.pre.gain.setTargetAtTime(k / DRIVE_RANGE, time, PARAM_SMOOTHING);
    this.post.gain.setTargetAtTime(driveCompensation(k), time, PARAM_SMOOTHING);
    for (const c of this.copies) c.osc.detune.setTargetAtTime(c.sign * s.unisonDetune, time, PARAM_SMOOTHING);
    if (this.fm) {
      this.fm.mod.detune.setTargetAtTime(fmRatioCents(s.fmRatio), time, PARAM_SMOOTHING);
      this.fm.depth.gain.setTargetAtTime(fmDeviationHz(s.fmAmount, s.fmRatio, this.fm.noteHz, this.ctx.sampleRate) * this.fm.velocityScale, time, PARAM_SMOOTHING);
    }
  }
}

export class MonoSynthEngine implements InstrumentEngine {
  readonly kind = 'bass' as const;
  readonly output: GainNode;
  readonly pitchMod: GainNode;
  readonly cutoffMod: GainNode;

  private readonly ctx: BaseAudioContext;
  private readonly voices = new Set<MonoVoice>();
  private instrument: BassInstrument;
  private settings: BassSettings;
  private disposed = false;
  private readonly hooks: VoiceHooks = {
    onEnded: (voice, cancelled) => {
      this.voices.delete(voice as MonoVoice);
      // A successor that never sounded must not keep its predecessor cut.
      if (cancelled) for (const v of this.voices) v.uncut(voice);
    },
  };

  constructor(ictx: InstrumentContext, instrument: BassInstrument) {
    const ctx = ictx.ctx;
    this.ctx = ctx;
    this.instrument = instrument;
    this.settings = readSettings(instrument, ctx.sampleRate);
    this.output = stereoGain(ctx, dbToGain(this.settings.level));
    this.pitchMod = new GainNode(ctx, { gain: 1 });
    this.cutoffMod = new GainNode(ctx, { gain: 1 });
  }

  update(instrument: Instrument, time: number): void {
    if (this.disposed || instrument.kind !== 'bass' || instrument === this.instrument) return;
    const t = Math.max(finiteOr(time, 0), this.ctx.currentTime);
    const prev = this.settings;
    const next = readSettings(instrument, this.ctx.sampleRate);
    this.instrument = instrument;
    this.settings = next;
    if (next.level !== prev.level) this.output.gain.setTargetAtTime(dbToGain(next.level), t, PARAM_SMOOTHING);
    if (
      next.cutoff !== prev.cutoff ||
      next.resonance !== prev.resonance ||
      next.drive !== prev.drive ||
      next.sub !== prev.sub ||
      next.unisonDetune !== prev.unisonDetune ||
      next.fmAmount !== prev.fmAmount ||
      next.fmRatio !== prev.fmRatio
    ) {
      for (const v of this.voices) v.applyLive(next, t);
    }
  }

  trigger(note: NoteTrigger): VoiceHandle | null {
    if (this.disposed) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const T = Math.max(finiteOr(note.time, now), now);
    const s = this.settings;
    const midi = clamp(finiteOr(note.pitch, 36) + 12 * s.octave, 0, 127);
    const toHz = midiToHz(midi);
    const velocity = clamp(finiteOr(note.velocity, 0.8), 0, 1);

    // Voices starting at the same instant would never be heard: the newest trigger wins.
    for (const v of [...this.voices]) if (v.startTime === T) v.cancel();

    let prev: MonoVoice | null = null;
    let later: MonoVoice | null = null;
    for (const v of this.voices) {
      if (v.startTime < T) {
        if (v.soundingAt(T) && (!prev || v.startTime > prev.startTime)) prev = v;
      } else if (!later || v.startTime < later.startTime) {
        later = v;
      }
    }

    let fromHz = toHz;
    let legato: MonoVoiceInit['legato'] = null;
    let align: MonoVoiceInit['align'] = null;
    if (prev) {
      const prevHz = prev.freq.valueAt(T);
      if (note.legato) {
        fromHz = clamp(prevHz, 1, ctx.sampleRate / 2);
        const peak = MONO_PEAK * velocityGain(velocity, s.velocity);
        const level = Math.max(prev.amp.valueAt(T), peak * s.sustain);
        if (level > peak * LEGATO_MIN_LEVEL) legato = { envCents: prev.filterEnv.valueAt(T), level };
      }
      // Same pitch at T (legato, or a repeated note): start this voice's oscillators early so their phase
      // matches the previous voice at T. The 5 ms crossfade is then between near-identical signals: no dip.
      if (Math.abs(fromHz / prevHz - 1) < 1e-4) {
        const dOsc = frac(prev.oscCycles(T)) / fromHz;
        const dSub = frac(prev.subCycles(T)) / (fromHz / 2);
        const preStart = T - Math.max(dOsc, dSub);
        // Only when the pre-roll is still in the future (always offline; with look-ahead when live).
        if (preStart >= now + PREROLL_SAFETY) {
          align = { oscStart: T - dOsc, subStart: T - dSub, envCents: prev.filterEnv.valueAt(preStart), level: prev.amp.valueAt(T) };
        }
      }
    }

    const voice = new MonoVoice(
      ctx,
      {
        settings: s,
        time: T,
        fromHz,
        toHz,
        legato,
        align,
        velocity,
        destination: this.output,
        pitchMod: this.pitchMod,
        cutoffMod: this.cutoffMod,
      },
      this.hooks,
    );
    // Mono: everything still sounding at T fades out as this note begins.
    for (const v of this.voices) if (v.soundingAt(T)) v.cut(T, MONO_CUT_FADE, voice);
    // A note already scheduled after this one (out-of-order trigger) cuts this one when it starts.
    if (later) voice.cut(later.startTime, MONO_CUT_FADE, later);
    this.voices.add(voice);
    if (note.duration !== undefined && Number.isFinite(note.duration)) voice.release(T + Math.max(0, note.duration));
    return voice;
  }

  releaseAll(time: number): void {
    if (this.disposed) return;
    const t = Math.max(finiteOr(time, 0), this.ctx.currentTime);
    for (const v of [...this.voices]) {
      if (v.startTime >= t) v.cancel();
      else v.release(t);
    }
  }

  kill(): void {
    const now = this.ctx.currentTime;
    for (const v of [...this.voices]) {
      if (v.startTime >= now) v.cancel();
      else v.cut(now, MONO_KILL_FADE, null);
    }
  }

  activeVoices(): number {
    return this.voices.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const v of [...this.voices]) v.cancel();
    this.voices.clear();
    this.pitchMod.disconnect();
    this.cutoffMod.disconnect();
    this.output.disconnect();
  }
}
