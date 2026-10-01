/**
 * Polyphonic synth (InstrumentEngine for `poly` instruments).
 *
 * Per voice:
 *   osc1 (osc1Wave; Unison copies) ─► gain ─► StereoPanner (-width) ─┐
 *        (Unison > 1: copies split onto a -width and a +width panner) │
 *   osc2 (osc2Wave, +semi, +detune) ─► gain ─► StereoPanner (+width) ─┤
 *   noise (shared seeded buffer, looped from a seeded offset)          │
 *        [─► low-pass ─► high-pass when Noise Colour ≠ 50 %] ─► gain ──┴► low-pass (12 dB/oct) ► VCA ► output (level dB)
 *
 *   FM (FM Amount > 0): sine modulator at FM Ratio × note ─► depth ─► envelope ─► every osc1 frequency
 *   Pitch Sweep ≠ 0 or Vibrato > 0: one pitch source per voice (sweep in cents
 *   + the part's pitchMod, plus a fading-in sine vibrato) ─► every oscillator's detune
 *   Drift > 0: seeded per-note detune of each oscillator and filter offset
 *
 * - Filter envelope: detune jumps to filterEnv x 4800 ct (4 octaves,
 *   velocity-scaled) and decays toward 0 over filterDecay; cutoffMod is
 *   summed into the same detune param. pitchMod feeds every oscillator's
 *   detune (the FM modulator's too, so FM stays in tune).
 * - Level: the three sources are normalised by their combined RMS weight
 *   and the voice gain is chosen so a 4-note chord at velocity 1 peaks
 *   below about 0.7. Unison copies share osc1's level (1/√n each).
 * - Every feature defaults to neutral, and a voice only builds the nodes
 *   its sound uses: a sound that uses none of them renders exactly as before
 *   they existed.
 * - Polyphony: at most POLY_MAX_VOICES per instrument, fewer for heavy
 *   sounds (an oscillator budget: an audio-rate FM carrier costs about five
 *   plain oscillators), never fewer than POLY_MIN_VOICES. The oldest voice
 *   is stolen with a 6 ms fade (or dropped outright if it would not have
 *   sounded yet). Releases fade to exact zero; then sources stop and every
 *   node is disconnected.
 */
import { POLY_PARAMS, dbToGain, readParam } from '../../project/params';
import { hashString, Rng, subSeed } from '../../project/rng';
import type { Instrument, PolyInstrument } from '../../project/types';
import type { InstrumentContext, InstrumentEngine, NoteTrigger, VoiceHandle } from '../contracts';
import { PARAM_SMOOTHING } from '../modules/types';
import {
  FM_SUSTAIN,
  NOISE_WHITE,
  UNISON_PHASES,
  VIBRATO_FADE_IN,
  VIBRATO_MAX_CENTS,
  driftOffsets,
  fmDeviationHz,
  fmRatioCents,
  noiseColorFilter,
  phasedOscillator,
  unisonPositions,
} from './synthParts';
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
/** Heavy sounds still play at least this many notes at once. */
export const POLY_MIN_VOICES = 6;
/** Oscillator budget per poly instrument (plain oscillator = 1, audio-rate FM carrier = 5). */
export const POLY_OSC_BUDGET = 64;
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
/** Relative cost of an oscillator whose frequency is modulated at audio rate (measured in Chromium). */
const FM_CARRIER_COST = 5;

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
  unison: number;
  unisonDetune: number;
  fmAmount: number;
  fmRatio: number;
  fmDecay: number;
  noiseColor: number;
  pitchEnv: number;
  pitchDecay: number;
  vibrato: number;
  vibratoRate: number;
  drift: number;
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
    unison: r('unison'),
    unisonDetune: r('unisonDetune'),
    fmAmount: r('fmAmount'),
    fmRatio: r('fmRatio'),
    fmDecay: r('fmDecay'),
    noiseColor: r('noiseColor'),
    pitchEnv: r('pitchEnv'),
    pitchDecay: r('pitchDecay'),
    vibrato: r('vibrato'),
    vibratoRate: r('vibratoRate'),
    drift: r('drift'),
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

/** Oscillator cost of one voice with these settings (see POLY_OSC_BUDGET). */
export function polyVoiceCost(s: Pick<PolySettings, 'unison' | 'fmAmount' | 'vibrato' | 'pitchEnv'>): number {
  const fm = s.fmAmount > 0;
  return Math.round(s.unison) * (fm ? FM_CARRIER_COST : 1) + 1 + (fm ? 1 : 0) + (s.vibrato > 0 ? 1 : 0) + (s.pitchEnv !== 0 ? 1 : 0);
}

/** How many notes a poly instrument with these settings plays at once. */
export function polyVoiceLimit(s: Pick<PolySettings, 'unison' | 'fmAmount' | 'vibrato' | 'pitchEnv'>): number {
  return Math.max(POLY_MIN_VOICES, Math.min(POLY_MAX_VOICES, Math.floor(POLY_OSC_BUDGET / polyVoiceCost(s))));
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

interface UnisonCopy {
  osc: OscillatorNode;
  position: number;
  drift: number;
}

class PolyVoice extends BaseVoice {
  private readonly osc2: OscillatorNode;
  /** osc1 level: one gain without Unison, the left and right stacks with it. */
  private readonly g1: GainNode[];
  private readonly g2: GainNode;
  private readonly gNoise: GainNode | null;
  private readonly pan1: StereoPannerNode;
  /** The +width panner of a Unison stack. */
  private readonly pan1b: StereoPannerNode | null;
  private readonly pan2: StereoPannerNode;
  private readonly filter: BiquadFilterNode;
  private readonly copies: UnisonCopy[] = [];
  private readonly unisonNorm: number;
  private readonly osc2Drift: number;
  private readonly fm: { mod: OscillatorNode; depth: GainNode; noteHz: number; velocityScale: number } | null = null;
  private readonly noiseColor: { lp: BiquadFilterNode; hp: BiquadFilterNode } | null = null;
  private readonly vibrato: { lfo: OscillatorNode; depth: GainNode } | null = null;

  constructor(ctx: BaseAudioContext, init: PolyVoiceInit, hooks: VoiceHooks) {
    const s = init.settings;
    const T = init.time;
    const vca = new GainNode(ctx, { gain: 0 });
    const amp = new GainEnvelope(vca.gain);
    super(ctx, T, amp, s.release, Infinity, hooks);

    const hz = midiToHz(init.midi);
    const frame = Math.round(T * ctx.sampleRate);
    const [a1, a2, an] = sourceGains(s);
    const n = Math.max(1, Math.round(s.unison));
    const drift = driftOffsets(s.drift, init.midi, frame, n + 1);
    this.osc2Drift = drift.osc[n];
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.cutoff, Q: polyFilterQ(s.resonance) });
    this.pan1 = new StereoPannerNode(ctx, { pan: -WIDTH_SPREAD * s.width });
    this.pan2 = new StereoPannerNode(ctx, { pan: WIDTH_SPREAD * s.width });

    // Tone 1: a single oscillator, or a Unison stack of phase-offset copies split across two panners.
    const tone1: OscillatorNode[] = [];
    this.unisonNorm = 1 / Math.sqrt(n);
    if (n === 1) {
      const osc1 = new OscillatorNode(ctx, { type: WAVE_TYPES[s.osc1Wave] ?? 'sawtooth', frequency: hz, detune: drift.osc[0] });
      this.g1 = [new GainNode(ctx, { gain: a1 })];
      osc1.connect(this.g1[0]).connect(this.pan1);
      this.copies.push({ osc: osc1, position: 0, drift: drift.osc[0] });
      tone1.push(osc1);
      this.pan1b = null;
    } else {
      const left = new GainNode(ctx, { gain: a1 * this.unisonNorm });
      const right = new GainNode(ctx, { gain: a1 * this.unisonNorm });
      this.g1 = [left, right];
      this.pan1b = new StereoPannerNode(ctx, { pan: WIDTH_SPREAD * s.width });
      left.connect(this.pan1);
      right.connect(this.pan1b).connect(this.filter);
      this.addNodes(this.pan1b);
      const positions = unisonPositions(n);
      positions.forEach((position, i) => {
        const osc = phasedOscillator(ctx, s.osc1Wave, UNISON_PHASES[i % UNISON_PHASES.length], hz, position * s.unisonDetune + drift.osc[i]);
        if (position < 0) osc.connect(left);
        else if (position > 0) osc.connect(right);
        else {
          // The centre copy sits in the middle at the same power as the others.
          const centre = new GainNode(ctx, { gain: Math.SQRT1_2 });
          osc.connect(centre);
          centre.connect(left);
          centre.connect(right);
          this.addNodes(centre);
        }
        this.copies.push({ osc, position, drift: drift.osc[i] });
        tone1.push(osc);
      });
    }
    this.osc2 = new OscillatorNode(ctx, {
      type: WAVE_TYPES[s.osc2Wave] ?? 'sawtooth',
      frequency: hz,
      detune: s.osc2Semi * 100 + s.detune + this.osc2Drift,
    });
    this.g2 = new GainNode(ctx, { gain: a2 });

    this.pan1.connect(this.filter);
    this.osc2.connect(this.g2).connect(this.pan2).connect(this.filter);
    this.filter.connect(vca).connect(init.destination);
    this.addNodes(...this.g1, this.g2, this.pan1, this.pan2, this.filter, vca);
    const oscillators = [...tone1, this.osc2];

    // FM: a sine modulator bends Tone 1's frequency; depth envelope from the strike toward FM_SUSTAIN.
    if (s.fmAmount > 0) {
      const mod = new OscillatorNode(ctx, { type: 'sine', frequency: hz, detune: fmRatioCents(s.fmRatio) });
      const velocityScale = velocityAmount(init.velocity, s.velocity);
      const depth = new GainNode(ctx, { gain: fmDeviationHz(s.fmAmount, s.fmRatio, hz, ctx.sampleRate) * velocityScale });
      const env = new GainNode(ctx, { gain: 0 });
      mod.connect(depth).connect(env);
      for (const o of tone1) env.connect(o.frequency);
      this.addNodes(depth, env);
      const fmEnv = new ParamTimeline([env.gain], 0);
      fmEnv.set(T, 1);
      fmEnv.target(T, FM_SUSTAIN, s.fmDecay / 3);
      this.fm = { mod, depth, noteHz: hz, velocityScale };
      oscillators.push(mod);
    }

    // Pitch sweep and vibrato reach the oscillators through one per-voice pitch source, which also
    // carries the part's pitch modulation: every detune then has a single input. (Chromium sums a
    // param's inputs in no fixed order; with several moving inputs the rounding would differ between
    // renders and, integrated into the phase of FM'd oscillators, grow audible to the last bits.)
    let pitchSrc: ConstantSourceNode | null = null;
    if (s.pitchEnv !== 0 || s.vibrato > 0) {
      pitchSrc = new ConstantSourceNode(ctx, { offset: 0 });
      this.link(init.pitchMod, pitchSrc.offset);
      if (s.pitchEnv !== 0) {
        const env = new ParamTimeline([pitchSrc.offset], 0);
        env.set(T, s.pitchEnv * 100);
        env.target(T, 0, s.pitchDecay / 3);
      }
      let pitch: AudioNode = pitchSrc;
      if (s.vibrato > 0) {
        // Vibrato: a sine LFO per voice, fading in after the note starts, summed with the sweep.
        const lfo = new OscillatorNode(ctx, { type: 'sine', frequency: s.vibratoRate });
        const depth = new GainNode(ctx, { gain: s.vibrato * VIBRATO_MAX_CENTS });
        const fade = new GainNode(ctx, { gain: 0 });
        const bus = new GainNode(ctx, { gain: 1 });
        lfo.connect(depth).connect(fade).connect(bus);
        pitchSrc.connect(bus);
        this.addNodes(depth, fade, bus);
        const env = new ParamTimeline([fade.gain], 0);
        env.set(T, 0);
        env.rampLinear(T, T + VIBRATO_FADE_IN, 1);
        this.vibrato = { lfo, depth };
        pitch = bus;
      }
      for (const o of oscillators) pitch.connect(o.detune);
    } else {
      for (const o of oscillators) this.link(init.pitchMod, o.detune);
    }
    this.link(init.cutoffMod, this.filter.detune);

    let noiseSrc: AudioBufferSourceNode | null = null;
    if (an > 0 && init.noise.length > 1) {
      // Seeded from the note itself, so a render reproduces regardless of what played before.
      const seed = subSeed(hashString('poly-noise'), `${init.midi}:${frame}`);
      const offset = new Rng(seed).float() * init.noise.duration;
      noiseSrc = new AudioBufferSourceNode(ctx, { buffer: init.noise, loop: true });
      // Mono noise is up-mixed to both channels at full level; -3 dB matches a centred panner.
      let colourGain = 1;
      let head: AudioNode = noiseSrc;
      if (s.noiseColor !== NOISE_WHITE) {
        const c = noiseColorFilter(s.noiseColor, ctx.sampleRate);
        const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: c.lowpass, Q: BUTTERWORTH_Q_DB });
        const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: c.highpass, Q: BUTTERWORTH_Q_DB });
        head = noiseSrc.connect(lp).connect(hp);
        colourGain = c.gain;
        this.noiseColor = { lp, hp };
        this.addNodes(lp, hp);
      }
      this.gNoise = new GainNode(ctx, { gain: an * Math.SQRT1_2 * colourGain });
      head.connect(this.gNoise).connect(this.filter);
      this.addNodes(this.gNoise);
      noiseSrc.start(T, offset);
    } else {
      this.gNoise = null;
    }

    const peak = POLY_VOICE_GAIN * velocityGain(init.velocity, s.velocity);
    const filterEnv = new ParamTimeline([this.filter.detune], drift.filter);
    filterEnv.set(T, s.filterEnv * ENV_MAX_CENTS * velocityAmount(init.velocity, s.velocity) + drift.filter);
    filterEnv.target(T, drift.filter, s.filterDecay / 3);
    amp.start(T, 0, peak, s.attack, peak * s.sustain, s.decay);

    for (const o of oscillators) {
      o.start(T);
      this.addSource(o);
    }
    if (pitchSrc) {
      pitchSrc.start(T);
      this.addSource(pitchSrc);
    }
    if (this.vibrato) {
      this.vibrato.lfo.start(T);
      this.addSource(this.vibrato.lfo);
    }
    if (noiseSrc) this.addSource(noiseSrc);
  }

  /** Smoothly apply continuous settings to this sounding voice. */
  applyLive(s: PolySettings, time: number): void {
    if (this.ended) return;
    const [a1, a2, an] = sourceGains(s);
    const k = PARAM_SMOOTHING;
    this.filter.frequency.setTargetAtTime(s.cutoff, time, k);
    this.filter.Q.setTargetAtTime(polyFilterQ(s.resonance), time, k);
    this.pan1.pan.setTargetAtTime(-WIDTH_SPREAD * s.width, time, k);
    this.pan1b?.pan.setTargetAtTime(WIDTH_SPREAD * s.width, time, k);
    this.pan2.pan.setTargetAtTime(WIDTH_SPREAD * s.width, time, k);
    const g1 = this.g1.length > 1 ? a1 * this.unisonNorm : a1;
    for (const g of this.g1) g.gain.setTargetAtTime(g1, time, k);
    this.g2.gain.setTargetAtTime(a2, time, k);
    this.osc2.detune.setTargetAtTime(s.osc2Semi * 100 + s.detune + this.osc2Drift, time, k);
    if (this.copies.length > 1) for (const c of this.copies) c.osc.detune.setTargetAtTime(c.position * s.unisonDetune + c.drift, time, k);
    let colourGain = 1;
    if (this.noiseColor) {
      const c = noiseColorFilter(s.noiseColor, this.ctx.sampleRate);
      this.noiseColor.lp.frequency.setTargetAtTime(c.lowpass, time, k);
      this.noiseColor.hp.frequency.setTargetAtTime(c.highpass, time, k);
      colourGain = c.gain;
    }
    this.gNoise?.gain.setTargetAtTime(an * Math.SQRT1_2 * colourGain, time, k);
    if (this.fm) {
      this.fm.mod.detune.setTargetAtTime(fmRatioCents(s.fmRatio), time, k);
      this.fm.depth.gain.setTargetAtTime(fmDeviationHz(s.fmAmount, s.fmRatio, this.fm.noteHz, this.ctx.sampleRate) * this.fm.velocityScale, time, k);
    }
    if (this.vibrato) {
      this.vibrato.lfo.frequency.setTargetAtTime(s.vibratoRate, time, k);
      this.vibrato.depth.gain.setTargetAtTime(s.vibrato * VIBRATO_MAX_CENTS, time, k);
    }
  }
}

/** Settings a sounding voice follows smoothly (the rest apply from the next note). */
const LIVE_KEYS: readonly (keyof PolySettings)[] = [
  'cutoff',
  'resonance',
  'width',
  'osc2Level',
  'noise',
  'osc2Semi',
  'detune',
  'unisonDetune',
  'noiseColor',
  'fmAmount',
  'fmRatio',
  'vibrato',
  'vibratoRate',
];

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
    if (LIVE_KEYS.some((k) => next[k] !== prev[k])) for (const v of this.voices) v.applyLive(next, t);
  }

  /** Notes this instrument plays at once with its current sound. */
  voiceLimit(): number {
    return polyVoiceLimit(this.settings);
  }

  trigger(note: NoteTrigger): VoiceHandle | null {
    if (this.disposed) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const T = Math.max(finiteOr(note.time, now), now);
    stealVoices(this.voices, T, this.voiceLimit(), POLY_STEAL_FADE);
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
