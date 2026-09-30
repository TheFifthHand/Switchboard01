/**
 * Sampler (InstrumentEngine for `sampler` instruments).
 *
 * Per voice:
 *   AudioBufferSourceNode (region, playbackRate, detune <- pitchMod)
 *   ► low-pass (cutoff, detune <- cutoffMod) ► edge fades ► VCA (attack/release) ► output (gain dB)
 *
 * Speed and pitch always change together here: there is no time-stretching.
 * Transposing up an octave plays the region twice as fast (half as long),
 * and Tempo Sync ("Speed") scales the rate by project BPM / original BPM, so
 * a synced loop follows the tempo AND shifts in pitch. The UI must say so.
 *
 *   playbackRate = 2^((pitch + (note - rootNote) + fine/100) / 12) x (sync ? bpm / originalBpm : 1)
 *
 * - Region = [start, end] as fractions of the buffer; end > start is
 *   enforced with a minimum region of 5 ms.
 * - One-shot: plays the region once. Fade-in at the start, and a fade-out
 *   that ends exactly at the region end in output time (region / rate). The
 *   note ends at the region end, or earlier on release.
 * - Loop: loops the region (loopStart/loopEnd) until release, then the
 *   release envelope. The fade-out time also acts as the minimum release.
 * - At most SAMPLER_MAX_VOICES voices; the oldest is stolen with a 6 ms fade.
 * - pitchMod (cents, on the source's detune) also changes the speed. A
 *   one-shot's fade-out is placed for the unmodulated rate, so a one-shot
 *   sped up by modulation reaches its region end slightly before the fade
 *   completes. Loop mode is unaffected (it ends on its release envelope).
 */
import { SAMPLER_PARAMS, dbToGain, readParam } from '../../project/params';
import type { Instrument, SamplerInstrument } from '../../project/types';
import type { InstrumentContext, InstrumentEngine, NoteTrigger, SampleProvider, VoiceHandle } from '../contracts';
import { PARAM_SMOOTHING } from '../modules/types';
import {
  BaseVoice,
  BUTTERWORTH_Q_DB,
  GainEnvelope,
  ParamTimeline,
  clamp,
  finiteOr,
  stealVoices,
  stereoGain,
  velocityGain,
  type VoiceHooks,
} from './voice';

/** Maximum allocated voices per sampler. */
export const SAMPLER_MAX_VOICES = 8;
/** Fade of a stolen voice (seconds). */
export const SAMPLER_STEAL_FADE = 0.006;
/** Fade used by kill() (seconds). */
export const SAMPLER_KILL_FADE = 0.004;
/** Shortest playable region (seconds of buffer). */
export const MIN_REGION_SECONDS = 0.005;
/** Velocity sensitivity of the sampler (fixed; the sampler has no velocity control). */
const SAMPLER_VELOCITY_SENS = 0.5;
/** Rate limits: +-4 octaves of combined transposition, tempo sync included. */
const MIN_RATE = 1 / 16;
const MAX_RATE = 16;

interface SamplerSettings {
  start: number;
  end: number;
  gain: number;
  pitch: number;
  fine: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
  sync: boolean;
  originalBpm: number;
  rootNote: number;
  attack: number;
  release: number;
  cutoff: number;
}

function readSettings(instrument: SamplerInstrument, sampleRate: number): SamplerSettings {
  const p = instrument.params;
  const r = (id: string) => readParam(SAMPLER_PARAMS, p, id);
  return {
    start: r('start'),
    end: r('end'),
    gain: r('gain'),
    pitch: r('pitch'),
    fine: r('fine'),
    loop: r('mode') === 1,
    fadeIn: r('fadeIn') / 1000,
    fadeOut: r('fadeOut') / 1000,
    sync: r('sync') === 1,
    originalBpm: r('originalBpm'),
    rootNote: r('rootNote'),
    attack: r('attack'),
    release: r('release'),
    cutoff: Math.min(r('cutoff'), sampleRate * 0.49),
  };
}

/**
 * The playable region of a buffer in seconds for start/end fractions:
 * end > start with at least MIN_REGION_SECONDS (or the whole buffer if it is shorter).
 */
export function samplerRegion(duration: number, start: number, end: number): { start: number; end: number } {
  const d = Math.max(0, finiteOr(duration, 0));
  if (d <= MIN_REGION_SECONDS) return { start: 0, end: d };
  let s = clamp(start, 0, 1) * d;
  let e = clamp(end, 0, 1) * d;
  if (e < s) [s, e] = [e, s];
  if (e - s < MIN_REGION_SECONDS) {
    e = Math.min(d, s + MIN_REGION_SECONDS);
    s = Math.max(0, e - MIN_REGION_SECONDS);
  }
  return { start: s, end: e };
}

/** Playback rate for a note (see the file comment). */
export function samplerRate(
  settings: { pitch: number; fine: number; rootNote: number; sync: boolean; originalBpm: number },
  notePitch: number,
  bpm: number,
): number {
  const semis = settings.pitch + (finiteOr(notePitch, settings.rootNote) - settings.rootNote) + settings.fine / 100;
  const tempo = settings.sync ? clamp(finiteOr(bpm, settings.originalBpm), 40, 220) / settings.originalBpm : 1;
  return clamp(Math.pow(2, semis / 12) * tempo, MIN_RATE, MAX_RATE);
}

interface SamplerVoiceInit {
  settings: SamplerSettings;
  buffer: AudioBuffer;
  time: number;
  rate: number;
  velocity: number;
  destination: AudioNode;
  pitchMod: AudioNode;
  cutoffMod: AudioNode;
}

class SamplerVoice extends BaseVoice {
  private readonly filter: BiquadFilterNode;

  constructor(ctx: BaseAudioContext, init: SamplerVoiceInit, hooks: VoiceHooks) {
    const s = init.settings;
    const T = init.time;
    const region = samplerRegion(init.buffer.duration, s.start, s.end);
    const regionLen = region.end - region.start;
    const outLen = regionLen / init.rate;
    const naturalEnd = s.loop ? Infinity : T + outLen;
    const vca = new GainNode(ctx, { gain: 0 });
    const amp = new GainEnvelope(vca.gain);
    super(ctx, T, amp, Math.max(s.release, s.fadeOut), naturalEnd, hooks);

    const src = new AudioBufferSourceNode(ctx, { buffer: init.buffer, playbackRate: init.rate });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.cutoff, Q: BUTTERWORTH_Q_DB });
    const edges = new GainNode(ctx, { gain: 0 });
    src.connect(this.filter).connect(edges).connect(vca).connect(init.destination);
    this.addNodes(this.filter, edges, vca);
    this.link(init.pitchMod, src.detune);
    this.link(init.cutoffMod, this.filter.detune);

    // Edge fades (output time). In one-shot mode they share the region; if they overlap they are scaled down.
    let fadeIn = s.fadeIn;
    let fadeOut = s.loop ? 0 : s.fadeOut;
    if (!s.loop && fadeIn + fadeOut > outLen) {
      const k = outLen / (fadeIn + fadeOut);
      fadeIn *= k;
      fadeOut *= k;
    }
    const edge = new ParamTimeline([edges.gain], 0);
    if (fadeIn > 0) {
      edge.set(T, 0);
      edge.rampLinear(T, T + fadeIn, 1);
    } else {
      edge.set(T, 1);
    }
    if (!s.loop && fadeOut > 0) edge.rampLinear(T + outLen - fadeOut, T + outLen, 0);

    const peak = velocityGain(init.velocity, SAMPLER_VELOCITY_SENS);
    amp.start(T, 0, peak, s.attack, peak, 1);

    if (s.loop) {
      src.loop = true;
      src.loopStart = region.start;
      src.loopEnd = region.end;
      src.start(T, region.start);
    } else {
      // The duration argument is buffer time: the source stops by itself at the region end.
      src.start(T, region.start, regionLen);
    }
    this.addSource(src);
  }

  applyLive(s: SamplerSettings, time: number): void {
    if (this.ended) return;
    this.filter.frequency.setTargetAtTime(s.cutoff, time, PARAM_SMOOTHING);
  }
}

export class SamplerEngine implements InstrumentEngine {
  readonly kind = 'sampler' as const;
  readonly output: GainNode;
  readonly pitchMod: GainNode;
  readonly cutoffMod: GainNode;

  private readonly ctx: BaseAudioContext;
  private readonly samples: SampleProvider;
  private readonly getBpm: () => number;
  private readonly voices = new Set<SamplerVoice>();
  private instrument: SamplerInstrument;
  private settings: SamplerSettings;
  private disposed = false;
  private readonly hooks: VoiceHooks = {
    onEnded: (voice) => {
      this.voices.delete(voice as SamplerVoice);
    },
  };

  constructor(ictx: InstrumentContext, instrument: SamplerInstrument) {
    const ctx = ictx.ctx;
    this.ctx = ctx;
    this.samples = ictx.samples;
    this.getBpm = () => ictx.getBpm();
    this.instrument = instrument;
    this.settings = readSettings(instrument, ctx.sampleRate);
    this.output = stereoGain(ctx, dbToGain(this.settings.gain));
    this.pitchMod = new GainNode(ctx, { gain: 1 });
    this.cutoffMod = new GainNode(ctx, { gain: 1 });
  }

  update(instrument: Instrument, time: number): void {
    if (this.disposed || instrument.kind !== 'sampler' || instrument === this.instrument) return;
    const t = Math.max(finiteOr(time, 0), this.ctx.currentTime);
    const prev = this.settings;
    const next = readSettings(instrument, this.ctx.sampleRate);
    this.instrument = instrument;
    this.settings = next;
    // Sample, region, pitch and mode apply from the next note; sounding notes keep playing as they started.
    if (next.gain !== prev.gain) this.output.gain.setTargetAtTime(dbToGain(next.gain), t, PARAM_SMOOTHING);
    if (next.cutoff !== prev.cutoff) for (const v of this.voices) v.applyLive(next, t);
  }

  trigger(note: NoteTrigger): VoiceHandle | null {
    if (this.disposed) return null;
    const id = this.instrument.sampleId;
    if (!id) return null;
    const buffer = this.samples.get(id);
    if (!buffer || buffer.length < 2) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const T = Math.max(finiteOr(note.time, now), now);
    const s = this.settings;
    stealVoices(this.voices, T, SAMPLER_MAX_VOICES, SAMPLER_STEAL_FADE);
    const voice = new SamplerVoice(
      ctx,
      {
        settings: s,
        buffer,
        time: T,
        rate: samplerRate(s, note.pitch, this.getBpm()),
        velocity: clamp(finiteOr(note.velocity, 0.8), 0, 1),
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
      else v.cut(now, SAMPLER_KILL_FADE, null);
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
