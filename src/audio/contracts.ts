/**
 * Contracts for the audio layer (architecture layer 3).
 *
 * The audio engine never imports React or the UI. It is driven by:
 *  - `setProject(project)` — declarative reconciliation of the audio graph
 *    with the serializable project (modules, connections, params, instruments),
 *  - timed calls from the sequencer (notes, pump beats, clicks, automation),
 *  - immediate live input (keyboard / pads).
 *
 * The same engine class runs on an AudioContext (playback) and on an
 * OfflineAudioContext (WAV export), which is what makes exports match
 * playback.
 */
import type { Id, Instrument, InstrumentKind, MacroId, Project } from '../project/types';

/* ------------------------------------------------------------------ */
/* Voices & instruments                                                */
/* ------------------------------------------------------------------ */

export interface VoiceHandle {
  /** Context time the voice starts. */
  readonly startTime: number;
  /**
   * The note ends at `time`: begin the release phase. No-op if already
   * released. A one-shot (sampler One-shot, drum hit) plays on regardless.
   */
  release(time: number): void;
  /**
   * End the sound at `time` with its release even if it is a one-shot that
   * release() lets play on (Stop, an editor preview being let go). Voices
   * without it end on release().
   */
  stop?(time: number): void;
  /** Stop immediately and free nodes. A voice that has not started yet never sounds. */
  cancel(): void;
  /** True once the voice has ended and disconnected its nodes. */
  readonly ended: boolean;
}

export interface NoteTrigger {
  /** MIDI note for melodic instruments; drum slot 0..15 for drum kits. */
  pitch: number;
  /** 0..1 */
  velocity: number;
  /** Context time the note starts. */
  time: number;
  /** Seconds until release begins; undefined = held until `release()` is called. */
  duration?: number;
  /**
   * Mono instruments: if true and another note is sounding at `time`, slide
   * from that note's pitch (glide) instead of retriggering the envelope.
   */
  legato?: boolean;
}

/** Supplies decoded sample buffers (imported and built-in). */
export interface SampleProvider {
  get(sampleId: string): AudioBuffer | null;
}

export interface InstrumentContext {
  ctx: BaseAudioContext;
  samples: SampleProvider;
  /** Shared seeded white-noise buffer (2 s, mono) at the context sample rate. */
  noise: AudioBuffer;
  /** Current project tempo (for tempo-synced sampler playback). */
  getBpm(): number;
}

/** One per track. Implementations: drum kit, mono bass synth, poly synth, sampler. */
export interface InstrumentEngine {
  readonly kind: InstrumentKind;
  /** Stereo output. */
  readonly output: AudioNode;
  /**
   * Modulation buses. Any signal connected into these (in cents) is added to
   * every current and future voice's oscillator detune / filter detune.
   */
  readonly pitchMod: AudioNode;
  readonly cutoffMod: AudioNode;
  /** Apply instrument data (resolved params, kit, preset, sample). Cheap when nothing changed. */
  update(instrument: Instrument, time: number): void;
  /** Start a note. Returns null if the note cannot sound (e.g. no sample loaded). */
  trigger(note: NoteTrigger): VoiceHandle | null;
  /** Gently release every sounding voice at `time` (one-shots included). */
  releaseAll(time: number): void;
  /**
   * Stop: end the one-shots that are playing out past their note (sampler
   * One-shot); ones that start later never sound. With `startedOnly`, only
   * the one-shots already sounding at `time` end and later ones still play.
   */
  stopOneShots?(time: number, startedOnly?: boolean): void;
  /** Hard stop of every voice, immediately (Mute All / panic). */
  kill(): void;
  activeVoices(): number;
  /** Optional warm-up outside the scheduling path (e.g. render drum buffers). */
  prepare?(): void;
  dispose(): void;
}

export type InstrumentFactory = (ictx: InstrumentContext, instrument: Instrument) => InstrumentEngine;

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export interface TrackMeter {
  trackId: Id;
  /** Peak absolute sample value over the last read window, linear. */
  peak: number;
  rms: number;
}

export interface MeterFrame {
  masterPeakL: number;
  masterPeakR: number;
  masterRms: number;
  /** Gain reduction applied by the output limiter in dB (>= 0). */
  limiterReductionDb: number;
  tracks: TrackMeter[];
  /**
   * Loudness of the final output (ITU-R BS.1770 / EBU R128, K-weighted, in
   * LUFS; -Infinity when silent). Filled by engines that measure it.
   */
  loudness?: LoudnessReading;
  /** Gain reduction of the mastering Glue compressor in dB (>= 0). */
  glueReductionDb?: number;
}

export interface LoudnessReading {
  /** 400 ms window. */
  momentary: number;
  /** 3 s window. */
  shortTerm: number;
  /** Gated average since the last resetLoudness() (or since playback started). */
  integrated: number;
  /** Highest true peak since the last reset, in dBTP (4× oversampled). */
  truePeakDb: number;
}

export interface EngineStats {
  /** Voices currently allocated across all instruments. */
  voices: number;
  modules: number;
  connections: number;
  /** Engine-owned timers / pending callbacks. */
  pendingTimers: number;
}

export interface EngineOptions {
  samples: SampleProvider;
  /** Seed for noise/IR/random-LFO generation so renders are deterministic. */
  seed: number;
  /** Create per-track meters (off for offline renders). */
  meters: boolean;
  /** Instrument construction; defaults to createInstrumentEngine from src/audio/instruments/index.ts. */
  instrumentFactory?: InstrumentFactory;
}

/** Creates a ready engine (worklets loaded) on a context. `AudioEngine.create` has this shape. */
export type EngineFactory = (ctx: BaseAudioContext, opts: EngineOptions) => Promise<AudioEngineApi>;

export interface AudioEngineApi {
  readonly ctx: BaseAudioContext;
  /** Reconcile the audio graph with the project. Safe to call on every project change. */
  setProject(project: Project): void;

  /* Sequencer-driven (timed) */
  scheduleNote(trackId: Id, note: NoteTrigger): VoiceHandle | null;
  /** Called once per beat by the sequencer; channels with Pump > 0 duck at `time`. */
  schedulePump(time: number, beatSeconds: number, beatIndex: number): void;
  scheduleClick(time: number, accent: boolean): void;
  /** Automation: set a module parameter at a future time (performance replay). */
  scheduleParam(moduleId: Id, param: string, value: number, time: number): void;
  /** Automation: set a macro at a future time; resolves to its mapped targets. */
  scheduleMacro(trackId: Id, macro: MacroId, value: number, time: number): void;
  /** Automation: mute/unmute a part's channel at a future time (performance replay). Solo still applies. */
  scheduleMute(trackId: Id, mute: boolean, time: number): void;
  /** Automation: master volume (dB) at a future time (performance replay). */
  scheduleMasterVolume(db: number, time: number): void;
  /**
   * Cancel everything the engine scheduled on the sequencer's behalf at/after
   * `afterTime`: param/macro/mute/master automation, pump ducks and metronome
   * clicks. The sequencer regenerates those events after an invalidation.
   */
  cancelScheduledAutomation(afterTime: number): void;

  /* Transport notifications */
  transportStarted(time: number, tick: number, bpm: number): void;
  transportStopped(time: number): void;
  tempoChanged(bpm: number, time: number): void;

  /*
   * Live input (immediate). `key` names the press; keys that start with one
   * of PREVIEW_KEY_PREFIXES are editor previews: letting go of one ends it
   * even on a one-shot, which otherwise plays its whole sound.
   */
  liveNoteOn(trackId: Id, pitch: number, velocity: number, key: string): void;
  liveNoteOff(trackId: Id, key: string): void;
  /**
   * Release all live-held notes and stop live one-shots still playing out
   * (Stop, Mute All, window blur, pointer cancel, input change). With the
   * transport stopped, one-shots the idle arpeggio started end too.
   */
  releaseLive(trackId?: Id): void;

  /* Output */
  setMasterVolume(db: number): void;
  /** Silence output within ~10 ms, kill voices and flush effect tails. */
  setMuteAll(muted: boolean): void;
  /** Kill every voice and flush tails without changing mute state. */
  panic(): void;

  /** The final output node (after limiter). Connected to ctx.destination by the engine. */
  readonly output: AudioNode;
  readMeters(out: MeterFrame): void;
  /**
   * Spectrum of the final output: fills `out` with the energy of out.length
   * log-spaced bands from 20 Hz to 20 kHz in dB (−140..+20; a full-scale
   * sine reads about 0 dB in its band, pink noise reads flat). The analyser
   * smooths between reads, so call it at a steady rate (e.g. every frame).
   * Engines without live meters fill −140. Optional.
   */
  readSpectrum?(out: Float32Array): void;
  /**
   * Restart the integrated loudness and true-peak measurement. Optional.
   * The engine also restarts it when playback starts from the top (tick 0).
   */
  resetLoudness?(): void;
  /**
   * A/B listening: hear the output without the mastering chain while `on`.
   * Never changes the project; offline renders (exports) are unaffected.
   */
  setMasteringBypass?(on: boolean): void;
  /**
   * Live pitch bend for a part's playing and future notes, in cents
   * (MIDI pitch wheel). Optional; 0 = centred.
   */
  setPitchBend?(trackId: Id, cents: number, time: number): void;
  getStats(): EngineStats;
  dispose(): void;
}

/** Live-note keys of editor previews (session NoteSource 'preview', session.audition). */
export const PREVIEW_KEY_PREFIXES: readonly string[] = ['preview:', 'audition:'];

/** Output ceiling enforced by the master limiter (linear, = -1 dBFS). */
export const OUTPUT_CEILING = 0.8912509381337456;
