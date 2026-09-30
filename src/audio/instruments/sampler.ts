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
 *   that ends at the region end (at the unmodulated rate: region / rate in
 *   output time). The note ends at the region end, or earlier on release.
 *   The fade-out has a 1 ms floor, so even Fade Out 0 never ends on a click.
 * - One-shot edge fades are locked to the playhead, not to the clock:
 *   pitchMod (cents on the source's detune) changes speed as well as pitch,
 *   so an LFO on Pitch moves the moment the region end is reached. A second
 *   buffer source plays a low-rate envelope buffer (the fade shape over the
 *   region, in buffer time) with the same playbackRate and the same pitchMod
 *   link as the sample, into the edge gain. Both playheads advance
 *   identically, so the fade always completes exactly as the sample runs out.
 * - Loop: loops the region (loopStart/loopEnd) until release, then the
 *   release envelope. Fade In applies at the note start; Fade Out acts as the
 *   minimum release.
 * - At most SAMPLER_MAX_VOICES voices; the oldest is stolen with a 6 ms fade.
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
/** Shortest one-shot fade-out (output seconds): a trimmed end never clicks. */
const MIN_FADE_OUT = 0.001;
/** Sample rate of the one-shot edge envelopes: fades need ~0.1 ms resolution, not audio bandwidth. */
const EDGE_ENV_RATE = 8000;
/**
 * The edge envelope is exactly 0 over its last frames before the region end.
 * This absorbs sub-frame differences between the sample's and the
 * envelope's playheads, so the sample always runs out while already silent.
 */
const EDGE_ENV_ZERO_FRAMES = 2;
/** Per-engine edge envelope cache: at most this many buffers / frames in total (~8 MB). */
const EDGE_CACHE_ENTRIES = 16;
const EDGE_CACHE_FRAMES = 2_000_000;

/**
 * Fill `out` (sampled at EDGE_ENV_RATE in buffer time from the region start)
 * with the one-shot edge gain: a linear fade-in over `fadeIn`, 1, and a
 * linear fade-out over `fadeOut` that reaches 0 just before `regionLen`
 * (all in seconds of buffer time). Overlapping fades are scaled to fit.
 */
function fillEdgeEnvelope(out: Float32Array, regionLen: number, fadeIn: number, fadeOut: number): void {
  const zeroAt = Math.max(0, regionLen - Math.min(EDGE_ENV_ZERO_FRAMES / EDGE_ENV_RATE, regionLen / 4));
  let fi = Math.max(0, finiteOr(fadeIn, 0));
  let fo = Math.max(0, finiteOr(fadeOut, 0));
  if (fi + fo > zeroAt && fi + fo > 0) {
    const k = zeroAt / (fi + fo);
    fi *= k;
    fo *= k;
  }
  // Frame i sits at i / EDGE_ENV_RATE seconds: 1 before zeroAt, 0 from there; then the ramps.
  const on = Math.min(out.length, Math.ceil(zeroAt * EDGE_ENV_RATE));
  out.fill(1, 0, on);
  out.fill(0, on);
  if (fi > 0) {
    const n = Math.min(on, Math.ceil(fi * EDGE_ENV_RATE));
    for (let i = 0; i < n; i++) out[i] = Math.min(out[i], i / EDGE_ENV_RATE / fi);
  }
  if (fo > 0) {
    for (let i = Math.max(0, Math.floor((zeroAt - fo) * EDGE_ENV_RATE)); i < on; i++) {
      out[i] = Math.min(out[i], Math.max(0, (zeroAt - i / EDGE_ENV_RATE) / fo));
    }
  }
}

/** Small LRU of edge envelope buffers, so repeated notes do not rebuild them. */
class EdgeEnvelopeCache {
  private readonly buffers = new Map<string, AudioBuffer>();
  private frames = 0;

  /** Envelope for a region of `regionLen` buffer seconds with fades in buffer seconds. */
  get(regionLen: number, fadeIn: number, fadeOut: number): AudioBuffer {
    const key = `${regionLen}|${fadeIn}|${fadeOut}`;
    const hit = this.buffers.get(key);
    if (hit) {
      this.buffers.delete(key);
      this.buffers.set(key, hit);
      return hit;
    }
    // The last frame lies at or beyond the region end, so the envelope covers the whole region.
    const length = Math.max(2, Math.ceil(regionLen * EDGE_ENV_RATE) + 1);
    const buffer = new AudioBuffer({ length, numberOfChannels: 1, sampleRate: EDGE_ENV_RATE });
    fillEdgeEnvelope(buffer.getChannelData(0), regionLen, fadeIn, fadeOut);
    if (length <= EDGE_CACHE_FRAMES) {
      this.buffers.set(key, buffer);
      this.frames += length;
      for (const [k, b] of this.buffers) {
        if (this.frames <= EDGE_CACHE_FRAMES && this.buffers.size <= EDGE_CACHE_ENTRIES) break;
        this.buffers.delete(k);
        this.frames -= b.length;
      }
    }
    return buffer;
  }

  clear(): void {
    this.buffers.clear();
    this.frames = 0;
  }
}

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
  envelopes: EdgeEnvelopeCache;
}

class SamplerVoice extends BaseVoice {
  private readonly filter: BiquadFilterNode;

  constructor(ctx: BaseAudioContext, init: SamplerVoiceInit, hooks: VoiceHooks) {
    const s = init.settings;
    const T = init.time;
    const region = samplerRegion(init.buffer.duration, s.start, s.end);
    const regionLen = region.end - region.start;
    // Nominal (unmodulated) end; pitch modulation can move the real end either way.
    const naturalEnd = s.loop ? Infinity : T + regionLen / init.rate;
    const vca = new GainNode(ctx, { gain: 0 });
    const amp = new GainEnvelope(vca.gain);
    super(ctx, T, amp, Math.max(s.release, s.fadeOut), naturalEnd, hooks);

    const src = new AudioBufferSourceNode(ctx, { buffer: init.buffer, playbackRate: init.rate });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.cutoff, Q: BUTTERWORTH_Q_DB });
    // Edge fades after the filter, so the output is exactly zero whatever the filter still rings.
    const edges = new GainNode(ctx, { gain: 0 });
    src.connect(this.filter).connect(edges).connect(vca).connect(init.destination);
    this.addNodes(this.filter, edges, vca);
    this.link(init.pitchMod, src.detune);
    this.link(init.cutoffMod, this.filter.detune);

    const peak = velocityGain(init.velocity, SAMPLER_VELOCITY_SENS);
    amp.start(T, 0, peak, s.attack, peak, 1);

    if (s.loop) {
      // Fade in at the note start (output time); the loop ends on its release envelope.
      const edge = new ParamTimeline([edges.gain], 0);
      if (s.fadeIn > 0) {
        edge.set(T, 0);
        edge.rampLinear(T, T + s.fadeIn, 1);
      } else {
        edge.set(T, 1);
      }
      src.loop = true;
      src.loopStart = region.start;
      src.loopEnd = region.end;
      src.start(T, region.start);
      this.addSource(src);
    } else {
      // Playhead-locked edge fades (see the file comment). Fade times are output seconds at the
      // note's rate, i.e. fade x rate seconds of buffer.
      const envelope = init.envelopes.get(regionLen, s.fadeIn * init.rate, Math.max(s.fadeOut, MIN_FADE_OUT) * init.rate);
      const envSrc = new AudioBufferSourceNode(ctx, { buffer: envelope, playbackRate: init.rate });
      envSrc.connect(edges.gain);
      this.link(init.pitchMod, envSrc.detune);
      // The duration argument is buffer time: the source stops by itself at the region end.
      src.start(T, region.start, regionLen);
      envSrc.start(T, 0);
      this.addSource(src);
      this.addSource(envSrc);
    }
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
  private readonly envelopes = new EdgeEnvelopeCache();
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
        envelopes: this.envelopes,
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
    this.envelopes.clear();
    this.pitchMod.disconnect();
    this.cutoffMod.disconnect();
    this.output.disconnect();
  }
}
