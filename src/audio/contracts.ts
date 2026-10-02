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

/**
 * The recording a sampler note plays, when it is not the part's own
 * (a per-clip recording: Clip.sample in project schema v3). Region bounds are
 * fractions of the buffer (0..1, like the sampler's Start/End), `rootNote` is
 * the MIDI note at which the recording plays at its own pitch.
 */
export interface NoteSample {
  id: string;
  start: number;
  end: number;
  rootNote: number;
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
  /**
   * Sampler parts: play this recording, region and root instead of the
   * part's own (its other settings still apply). A note whose recording is
   * not loaded yet is skipped and counted (EngineStats.skippedSampleNotes).
   */
  sample?: NoteSample;
}

/** Supplies decoded sample buffers (imported and built-in). */
export interface SampleProvider {
  get(sampleId: string): AudioBuffer | null;
  /**
   * Make `sampleId` available to get() (decode or generate it). Optional;
   * without it, AudioEngineApi.preloadSamples calls get() once per id.
   */
  load?(sampleId: string): Promise<AudioBuffer | null>;
}

export interface InstrumentContext {
  ctx: BaseAudioContext;
  samples: SampleProvider;
  /** Shared seeded white-noise buffer (2 s, mono) at the context sample rate. */
  noise: AudioBuffer;
  /** Current project tempo (for tempo-synced sampler playback). */
  getBpm(): number;
  /** A note could not sound because its recording is not loaded (counted in EngineStats). */
  noteSkipped?(): void;
  /** Offline rendering (export): everything must be computed in place, never deferred. */
  offline?: boolean;
}

/** InstrumentEngine.prepare / AudioEngine.prepareInstruments options. */
export interface PrepareOptions {
  /**
   * Prepare in idle slices of at most 8 ms (requestIdleCallback where
   * available, else setTimeout 0) instead of now, in one go. The returned
   * promise resolves when the work is done (or superseded).
   */
  incremental?: boolean;
  /**
   * 'used' prepares only what the project's clips use (drum voices that
   * play), 'all' (default) everything; used work always comes first.
   */
  scope?: 'used' | 'all';
  /** Drum kits: slots in the order to prepare them (most-used first); missing slots follow. */
  order?: readonly number[];
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
  /**
   * Optional warm-up outside the scheduling path (e.g. render drum buffers).
   * Incremental preparation resolves when its idle work is done.
   */
  prepare?(opts?: PrepareOptions): void | Promise<void>;
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

/** Peak and RMS (linear) of a stereo signal over the last read window. */
export interface LevelReading {
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
  /**
   * Gain reduction (dB, >= 0) of every Compressor and Gate module, by module
   * id, reported by their worklets about 30 times a second (live engines
   * only). A bypassed module reads 0.
   */
  moduleReductionDb?: Record<Id, number>;
  /**
   * Levels after the shared Reverb (fx:reverb) and Echo (fx:delay) returns,
   * i.e. what each return adds to the mix (live engines only). A return
   * switched off that only sends feed is silenced and reads 0; one with a
   * direct feed too passes that on dry, and reads it.
   */
  returns?: { reverb: LevelReading; delay: LevelReading };
  /**
   * Level-matched A/B (setMasteringBypass): the gain in dB applied to the
   * un-mastered sound while the comparison is on (and the project has
   * mastering on), 0 otherwise.
   */
  compareTrimDb?: number;
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
  /**
   * Short-term loudness (3 s, LUFS) of the mix as it enters the mastering
   * chain; −Infinity while mastering is off (the tap only runs while it is on).
   */
  preMasteringShortTerm?: number;
}

export interface EngineStats {
  /** Voices currently allocated across all instruments. */
  voices: number;
  modules: number;
  connections: number;
  /** Engine-owned timers / pending callbacks. */
  pendingTimers: number;
  /** Sampler notes skipped because their recording was not loaded yet (since the engine was made). */
  skippedSampleNotes?: number;
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
   * Song automation: move `macro` of a part linearly in macro space from
   * `from` at `t0` to `to` at `t1` (0..1), resolved through the part's
   * macroMap to every target. Targets mapped linearly ramp exactly
   * (linearRampToValueAtTime); other curves move linearly between points at
   * most 10 ms apart (enum params step). Where a param is not at the ramp's
   * start value when it starts (the project had it elsewhere, the ramp
   * starts late, or a cancel held it), it glides onto the ramp within 20 ms
   * (MACRO_RAMP_JOIN) instead of jumping; re-scheduling a ramp after a
   * cancel therefore rejoins without a step. The ramp owns its params until
   * `t1`: project edits and macro smoothing do not move them meanwhile.
   * Afterwards the value holds like other automation until the project
   * changes that param or a cancel; Stop (transportStopped) ends all song
   * automation and every target glides back to the project's value.
   * Optional.
   */
  scheduleMacroRamp?(trackId: Id, macro: MacroId, from: number, to: number, t0: number, t1: number): void;
  /**
   * Song automation: the song-gain stage (after master volume, before
   * mastering; linear gain, 1 = unity, at most 4) reaches `value` at `time`
   * (with a 5 ms glide), or, with `rampEndTime`, ramps linearly from its value
   * at `time` to `value` at `rampEndTime`. A ramp at the same `time` as a
   * step scheduled just before starts from that step's value: (0, t) then
   * (1, t, t1) is a fade-in from silence, also right after a start. Moves
   * scheduled earlier at or after `time` are replaced. Unity and
   * bit-transparent unless used. Stop holds it (a fade-out's tail stays
   * faded); the next transportStarted glides it back to unity over 20 ms
   * unless moves scheduled at that start say otherwise (a resume can set the
   * value it had). Optional.
   */
  scheduleSongGain?(value: number, time: number, rampEndTime?: number): void;
  /**
   * Cancel everything the engine scheduled on the sequencer's behalf at/after
   * `afterTime`: param/macro/mute/master automation, pump ducks, metronome
   * clicks, macro ramps and song-gain ramps (a ramp under way at that time
   * holds the value it has reached). The sequencer regenerates those events
   * after an invalidation.
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
   * Level-matched unless `matchLevels` is false: turning it on reads the
   * short-term loudness (the last 3 s) after and before mastering and plays
   * the un-mastered sound that much louder or quieter (±12 dB at most, a
   * boost only as far as it adds ≤ 1.5 dB of limiting), reported as
   * MeterFrame.compareTrimDb. Measured once per comparison: with less than
   * about 3 s of music before it (or silence) the gain is 0 dB, and changes
   * to the mastering while comparing are not re-measured (turn it off and on
   * again). The gain is in place as the comparison fades in.
   */
  setMasteringBypass?(on: boolean, opts?: { matchLevels?: boolean }): void;
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
