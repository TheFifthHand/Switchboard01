/**
 * Polyphonic synth (InstrumentEngine for `poly` instruments).
 *
 * Per voice:
 *   osc1 (osc1Wave) ─► gain ─► StereoPanner (-width) ─┐
 *   osc2 (osc2Wave, +semi, +detune) ─► gain ─► StereoPanner (+width) ─┤
 *   noise (shared seeded buffer, looped from a seeded offset) ─► gain ─┴► low-pass (12 dB/oct) ► VCA ► output (level dB)
 *
 * - Filter envelope: detune jumps to filterEnv x 4800 ct (4 octaves,
 *   velocity-scaled) and decays toward 0 over filterDecay; cutoffMod is
 *   summed into the same detune param. pitchMod feeds every oscillator's
 *   detune.
 * - Level: the three sources are normalised by their combined RMS weight
 *   and the voice gain is chosen so a 4-note chord at velocity 1 peaks
 *   below about 0.7.
 * - Polyphony: at most POLY_MAX_VOICES per instrument. The oldest voice is
 *   stolen with a 6 ms fade (or dropped outright if it would not have
 *   sounded yet). Releases fade to exact zero; then oscillators stop and
 *   every node is disconnected.
 */
import { POLY_PARAMS, dbToGain, readParam } from '../../project/params';
import { hashString, Rng, subSeed } from '../../project/rng';
import type { Instrument, PolyInstrument } from '../../project/types';
import type { InstrumentContext, InstrumentEngine, NoteTrigger, VoiceHandle } from '../contracts';
import { PARAM_SMOOTHING } from '../modules/types';
import {
  BaseVoice,
  BUTTERWORTH_Q_DB,
  GainEnvelope,
  ParamTimeline,
  clamp,
  finiteOr,
  midiToHz,
  stealVoices,
  stereoGain,
  velocityAmount,
  velocityGain,
  type VoiceHooks,
} from './voice';

/** Maximum allocated voices per poly instrument. */
export const POLY_MAX_VOICES = 12;
/** Fade of a stolen voice (seconds). */
export const POLY_STEAL_FADE = 0.006;
/** Fade used by kill() (seconds). */
export const POLY_KILL_FADE = 0.004;
/** Peak VCA gain at velocity 1 before the mix normalisation. */
const POLY_VOICE_GAIN = 0.26;
const WAVE_TYPES: readonly OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];
/** Square/triangle/sine matched to the saw's loudness. */
const WAVE_GAIN: readonly number[] = [1, 0.72, 1.2, 1];
/** Noise level at noise = 100% (white noise is dense; this keeps it in balance with the oscillators). */
const NOISE_LEVEL = 0.5;
/** Pan position of each oscillator at width = 100% (never fully one-sided). */
const WIDTH_SPREAD = 0.9;
/** Filter envelope depth at filterEnv = 100%: +4 octaves. */
const ENV_MAX_CENTS = 4800;

/** Low-pass Q (dB) for resonance r: Butterworth at 0 up to a +12 dB peak at 1. */
export function polyFilterQ(resonance: number): number {
  return BUTTERWORTH_Q_DB + clamp(resonance, 0, 1) * (12 - BUTTERWORTH_Q_DB);
}

interface PolySettings {
  osc1Wave: number;
  osc2Wave: number;
  osc2Semi: number;
  detune: number;
  osc2Level: number;
  noise: number;
  width: number;
  cutoff: number;
  resonance: number;
  filterEnv: number;
  filterDecay: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  velocity: number;
  level: number;
}

function readSettings(instrument: PolyInstrument, sampleRate: number): PolySettings {
  const p = instrument.params;
  const r = (id: string) => readParam(POLY_PARAMS, p, id);
  return {
    osc1Wave: r('osc1Wave'),
    osc2Wave: r('osc2Wave'),
    osc2Semi: r('osc2Semi'),
    detune: r('detune'),
    osc2Level: r('osc2Level'),
    noise: r('noise'),
    width: r('width'),
    cutoff: Math.min(r('cutoff'), sampleRate * 0.45),
    resonance: r('resonance'),
    filterEnv: r('filterEnv'),
    filterDecay: r('filterDecay'),
    attack: r('attack'),
    decay: r('decay'),
    sustain: r('sustain'),
    release: r('release'),
    velocity: r('velocity'),
    level: r('level'),
  };
}

/** Source gains [osc1, osc2, noise], normalised so adding osc2/noise does not jump the level. */
function sourceGains(s: PolySettings): [number, number, number] {
  const n = NOISE_LEVEL * s.noise;
  const norm = 1 / Math.sqrt(1 + s.osc2Level * s.osc2Level + n * n);
  return [(WAVE_GAIN[s.osc1Wave] ?? 1) * norm, (WAVE_GAIN[s.osc2Wave] ?? 1) * s.osc2Level * norm, n * norm];
}

interface PolyVoiceInit {
  settings: PolySettings;
  time: number;
  midi: number;
  velocity: number;
  noise: AudioBuffer;
  destination: AudioNode;
  pitchMod: AudioNode;
  cutoffMod: AudioNode;
}

class PolyVoice extends BaseVoice {
  private readonly osc2: OscillatorNode;
  private readonly g1: GainNode;
  private readonly g2: GainNode;
  private readonly gNoise: GainNode | null;
  private readonly pan1: StereoPannerNode;
  private readonly pan2: StereoPannerNode;
  private readonly filter: BiquadFilterNode;

  constructor(ctx: BaseAudioContext, init: PolyVoiceInit, hooks: VoiceHooks) {
    const s = init.settings;
    const T = init.time;
    const vca = new GainNode(ctx, { gain: 0 });
    const amp = new GainEnvelope(vca.gain);
    super(ctx, T, amp, s.release, Infinity, hooks);

    const hz = midiToHz(init.midi);
    const [a1, a2, an] = sourceGains(s);
    const osc1 = new OscillatorNode(ctx, { type: WAVE_TYPES[s.osc1Wave] ?? 'sawtooth', frequency: hz });
    this.osc2 = new OscillatorNode(ctx, {
      type: WAVE_TYPES[s.osc2Wave] ?? 'sawtooth',
      frequency: hz,
      detune: s.osc2Semi * 100 + s.detune,
    });
    this.g1 = new GainNode(ctx, { gain: a1 });
    this.g2 = new GainNode(ctx, { gain: a2 });
    this.pan1 = new StereoPannerNode(ctx, { pan: -WIDTH_SPREAD * s.width });
    this.pan2 = new StereoPannerNode(ctx, { pan: WIDTH_SPREAD * s.width });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.cutoff, Q: polyFilterQ(s.resonance) });

    osc1.connect(this.g1).connect(this.pan1).connect(this.filter);
    this.osc2.connect(this.g2).connect(this.pan2).connect(this.filter);
    this.filter.connect(vca).connect(init.destination);
    this.addNodes(this.g1, this.g2, this.pan1, this.pan2, this.filter, vca);
    this.link(init.pitchMod, osc1.detune);
    this.link(init.pitchMod, this.osc2.detune);
    this.link(init.cutoffMod, this.filter.detune);

    let noiseSrc: AudioBufferSourceNode | null = null;
    if (an > 0 && init.noise.length > 1) {
      // Seeded from the note itself, so a render reproduces regardless of what played before.
      const seed = subSeed(hashString('poly-noise'), `${init.midi}:${Math.round(T * ctx.sampleRate)}`);
      const offset = new Rng(seed).float() * init.noise.duration;
      noiseSrc = new AudioBufferSourceNode(ctx, { buffer: init.noise, loop: true });
      // Mono noise is up-mixed to both channels at full level; -3 dB matches a centred panner.
      this.gNoise = new GainNode(ctx, { gain: an * Math.SQRT1_2 });
      noiseSrc.connect(this.gNoise).connect(this.filter);
      this.addNodes(this.gNoise);
      noiseSrc.start(T, offset);
    } else {
      this.gNoise = null;
    }

    const peak = POLY_VOICE_GAIN * velocityGain(init.velocity, s.velocity);
    const filterEnv = new ParamTimeline([this.filter.detune], 0);
    filterEnv.set(T, s.filterEnv * ENV_MAX_CENTS * velocityAmount(init.velocity, s.velocity));
    filterEnv.target(T, 0, s.filterDecay / 3);
    amp.start(T, 0, peak, s.attack, peak * s.sustain, s.decay);

    osc1.start(T);
    this.osc2.start(T);
    this.addSource(osc1);
    this.addSource(this.osc2);
    if (noiseSrc) this.addSource(noiseSrc);
  }

  /** Smoothly apply continuous settings to this sounding voice. */
  applyLive(s: PolySettings, time: number): void {
    if (this.ended) return;
    const [a1, a2, an] = sourceGains(s);
    this.filter.frequency.setTargetAtTime(s.cutoff, time, PARAM_SMOOTHING);
    this.filter.Q.setTargetAtTime(polyFilterQ(s.resonance), time, PARAM_SMOOTHING);
    this.pan1.pan.setTargetAtTime(-WIDTH_SPREAD * s.width, time, PARAM_SMOOTHING);
    this.pan2.pan.setTargetAtTime(WIDTH_SPREAD * s.width, time, PARAM_SMOOTHING);
    this.g1.gain.setTargetAtTime(a1, time, PARAM_SMOOTHING);
    this.g2.gain.setTargetAtTime(a2, time, PARAM_SMOOTHING);
    this.gNoise?.gain.setTargetAtTime(an * Math.SQRT1_2, time, PARAM_SMOOTHING);
    this.osc2.detune.setTargetAtTime(s.osc2Semi * 100 + s.detune, time, PARAM_SMOOTHING);
  }
}

export class PolySynthEngine implements InstrumentEngine {
  readonly kind = 'poly' as const;
  readonly output: GainNode;
  readonly pitchMod: GainNode;
  readonly cutoffMod: GainNode;

  private readonly ctx: BaseAudioContext;
  private readonly noise: AudioBuffer;
  private readonly voices = new Set<PolyVoice>();
  private instrument: PolyInstrument;
  private settings: PolySettings;
  private disposed = false;
  private readonly hooks: VoiceHooks = {
    onEnded: (voice) => {
      this.voices.delete(voice as PolyVoice);
    },
  };

  constructor(ictx: InstrumentContext, instrument: PolyInstrument) {
    const ctx = ictx.ctx;
    this.ctx = ctx;
    this.noise = ictx.noise;
    this.instrument = instrument;
    this.settings = readSettings(instrument, ctx.sampleRate);
    this.output = stereoGain(ctx, dbToGain(this.settings.level));
    this.pitchMod = new GainNode(ctx, { gain: 1 });
    this.cutoffMod = new GainNode(ctx, { gain: 1 });
  }

  update(instrument: Instrument, time: number): void {
    if (this.disposed || instrument.kind !== 'poly' || instrument === this.instrument) return;
    const t = Math.max(finiteOr(time, 0), this.ctx.currentTime);
    const prev = this.settings;
    const next = readSettings(instrument, this.ctx.sampleRate);
    this.instrument = instrument;
    this.settings = next;
    if (next.level !== prev.level) this.output.gain.setTargetAtTime(dbToGain(next.level), t, PARAM_SMOOTHING);
    const live: (keyof PolySettings)[] = ['cutoff', 'resonance', 'width', 'osc2Level', 'noise', 'osc2Semi', 'detune'];
    if (live.some((k) => next[k] !== prev[k])) for (const v of this.voices) v.applyLive(next, t);
  }

  trigger(note: NoteTrigger): VoiceHandle | null {
    if (this.disposed) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const T = Math.max(finiteOr(note.time, now), now);
    stealVoices(this.voices, T, POLY_MAX_VOICES, POLY_STEAL_FADE);
    const voice = new PolyVoice(
      ctx,
      {
        settings: this.settings,
        time: T,
        midi: clamp(finiteOr(note.pitch, 60), 0, 127),
        velocity: clamp(finiteOr(note.velocity, 0.8), 0, 1),
        noise: this.noise,
        destination: this.output,
        pitchMod: this.pitchMod,
        cutoffMod: this.cutoffMod,
      },
      this.hooks,
    );
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
      else v.cut(now, POLY_KILL_FADE, null);
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
