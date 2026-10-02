/**
 * 16-voice drum kit instrument (InstrumentEngine for `drums` instruments).
 *
 * Buffers: each slot's sound is rendered offline by renderDrumVoice for
 * (kit, slot, quantised effective decay = kit decay x voice decay, sample
 * rate), shared through the drumSynth cache and wrapped in an AudioBuffer
 * per engine. update() stays cheap and a kit change only affects future hits.
 * Rendering never has to happen inside the scheduler: prepare() renders the
 * voices ahead, at once or in idle slices (the engine starts that for a new
 * kit, the slots the clips play first), and a hit scheduled ahead whose new
 * voice is not rendered yet plays the slot's previous sound once more while
 * the new one renders in idle time. A slot with no sound yet, an immediate
 * (live) hit and every offline render still render in place.
 *
 * Per hit:
 *   AudioBufferSourceNode (playbackRate = 2^((kit tune + voice tune)/12),
 *   detune <- pitchMod) -> hit GainNode (velocity curve x voice level)
 *   -> StereoPannerNode (voice pan) -> kit bus
 * Kit bus (+3 dB pan-law makeup, so a centred voice keeps its designed
 * level) -> low-pass (kit cutoff, detune <- cutoffMod) -> level (kit dB)
 * -> output.
 *
 * Choke: each kit's chokeGroups (kits.ts), e.g. closed hat -> open hat. Of
 * two hits in a group, the later one (by start time, then trigger order)
 * fades the earlier one over 8 ms when it starts. A slot chokes its own
 * previous hit only for SELF_CHOKE_SLOTS (4/5/6: hats, shakers, tambourine),
 * so tails of repeated kicks overlap.
 * Polyphony: at most DRUM_MAX_HITS hits sound at once; the oldest is stolen
 * with a 5 ms fade.
 * Cancelling a hit before it sounds (the transport does this whenever it
 * regenerates upcoming notes) undoes the chokes and steals it had scheduled,
 * so a ringing open hat is not cut by a closed hat that never plays.
 */
import { DRUM_KIT_PARAMS, DRUM_VOICE_PARAM_SPECS, clampParam, dbToGain, readParam } from '../../project/params';
import { DRUM_VOICES, type DrumVoiceSettings, type DrumsInstrument, type Instrument } from '../../project/types';
import type { InstrumentContext, InstrumentEngine, NoteTrigger, PrepareOptions, VoiceHandle } from '../contracts';
import { PARAM_SMOOTHING } from '../modules/types';
import { runWhenIdle } from '../idle';
import { drumVoiceKey, getDrumVoice, peekDrumVoice, quantizeDrumDecay } from './drumSynth';
import { DEFAULT_KIT_ID, getKitRecipe, resolveKitId } from './kits';

/** Maximum simultaneously sounding hits per kit. */
export const DRUM_MAX_HITS = 40;
/** Fade applied to a choked hit (seconds). */
export const DRUM_CHOKE_FADE = 0.008;
/** Fade applied to a stolen hit (seconds). */
export const DRUM_STEAL_FADE = 0.005;
/** Fade used by releaseAll (seconds). */
export const DRUM_RELEASE_FADE = 0.06;
/** Web Audio low-pass Q (dB) for a Butterworth response: no resonant bump at the cutoff. */
const BUTTERWORTH_Q_DB = -3.0103;
/** Equal-power panning of a mono hit puts -3 dB on each side at centre; the bus restores unity. */
const PAN_LAW_MAKEUP = Math.SQRT2;
/** Playback-rate exponent limit: +-24 semitones. */
const MAX_TUNE_SEMITONES = 24;
/** Slots whose new hit also chokes their own previous hit (the hat / shaker family). */
const SELF_CHOKE_SLOTS: readonly number[] = [4, 5, 6];
/**
 * A scheduled cut is only undone while it is at least this far ahead of the
 * clock: the audio thread renders a little ahead of `currentTime`, and
 * cancelling a fade it has already begun would snap the level back (a click).
 */
const RESTORE_MARGIN = 0.008;
/** Stop time used to let a restored hit play to the end of its buffer (sources end there by themselves). */
const NO_STOP_SECONDS = 1e5;
/** A hit due sooner than this (live input) renders its new voice in place rather than play the old one. */
const IMMEDIATE_HIT = 0.002;

type ChokeTable = readonly (readonly boolean[])[];
const chokeTables = new Map<string, ChokeTable>();

/** chokeTable(kit)[a][b]: a hit on slot a and a hit on slot b cut each other (the later one wins). */
function chokeTable(kitId: string): ChokeTable {
  let table = chokeTables.get(kitId);
  if (!table) {
    const groups = getKitRecipe(kitId).chokeGroups;
    table = Array.from({ length: DRUM_VOICES }, (_, a) =>
      Array.from({ length: DRUM_VOICES }, (_, b) => (a === b ? SELF_CHOKE_SLOTS.includes(a) : groups.some((g) => g.includes(a) && g.includes(b)))),
    );
    chokeTables.set(kitId, table);
  }
  return table;
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Gain for a hit: (1 - vs) + vs * v^1.6, where vs is the kit's velocity sensitivity. */
export function drumVelocityGain(velocity: number, sensitivity: number): number {
  const v = Math.min(1, Math.max(0, finiteOr(velocity, 0)));
  const vs = Math.min(1, Math.max(0, finiteOr(sensitivity, 0)));
  return 1 - vs + vs * Math.pow(v, 1.6);
}

class DrumHit implements VoiceHandle {
  ended = false;
  /** Start of a scheduled fade-out (choke, steal, releaseAll), or Infinity. */
  cutAt = Infinity;
  /** The hit whose choke or steal scheduled the current cut (null for releaseAll). */
  cutBy: DrumHit | null = null;

  /**
   * `src` must already be started at `startTime`: stop() before start()
   * throws, which would leave a choked source running silently.
   */
  constructor(
    private readonly ctx: BaseAudioContext,
    readonly slot: number,
    readonly startTime: number,
    /** Trigger order within the kit; breaks start-time ties (the later trigger wins a choke). */
    readonly seq: number,
    /** Natural end of the buffer at its playback rate. */
    readonly endTime: number,
    private readonly src: AudioBufferSourceNode,
    private readonly gain: GainNode,
    private readonly panner: StereoPannerNode,
    private readonly level: number,
    /** Unhooks the hit from its kit (pitch-mod connection, active set); `cancelled` when stopped by cancel(). */
    private readonly onEnded: (hit: DrumHit, src: AudioBufferSourceNode, cancelled: boolean) => void,
  ) {
    src.onended = () => this.finish(false);
  }

  /** True if this hit starts after `other` (ties: triggered later). */
  isLaterThan(other: DrumHit): boolean {
    return this.startTime > other.startTime || (this.startTime === other.startTime && this.seq > other.seq);
  }

  /** Drums are one-shots: a note's release does not cut the sound (choke groups and releaseAll do). */
  release(_time: number): void {
    // Intentionally empty.
  }

  cancel(): void {
    if (this.ended) return;
    try {
      this.src.stop();
    } catch {
      // Already stopped.
    }
    this.finish(true);
  }

  /**
   * Fade to silence over `fade` seconds starting at `time`, caused by `by`.
   * No-op (returns false) if an earlier cut is scheduled or the hit is over by then.
   */
  fadeOut(time: number, fade: number, by: DrumHit | null): boolean {
    if (this.ended) return false;
    const t = Math.max(time, this.startTime, this.ctx.currentTime);
    if (t >= this.cutAt || t >= this.endTime) return false;
    const g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(this.level, t);
    g.linearRampToValueAtTime(0, t + fade);
    this.cutAt = t;
    this.cutBy = by;
    // A later stop() call replaces an earlier one, so this also moves an earlier-scheduled cut.
    this.stopAt(t + fade + 0.001);
    return true;
  }

  private stopAt(time: number): void {
    try {
      this.src.stop(time);
    } catch {
      // The source has already finished; its onended handler frees the hit.
    }
  }

  /**
   * Undo the scheduled cut (its cause was cancelled before it sounded), if
   * the fade is still safely in the future. Returns true if restored.
   */
  restore(): boolean {
    if (this.ended || this.cutAt === Infinity || this.cutAt < this.ctx.currentTime + RESTORE_MARGIN) return false;
    // Removes the hold-and-ramp; the gain's own value is still the hit level.
    this.gain.gain.cancelScheduledValues(this.cutAt);
    this.stopAt(this.startTime + NO_STOP_SECONDS);
    this.cutAt = Infinity;
    this.cutBy = null;
    return true;
  }

  private finish(cancelled: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.src.onended = null;
    this.onEnded(this, this.src, cancelled);
    this.src.disconnect();
    this.gain.disconnect();
    this.panner.disconnect();
  }
}

interface SlotBuffer {
  key: string;
  buffer: AudioBuffer;
}

export class DrumKitEngine implements InstrumentEngine {
  readonly kind = 'drums' as const;
  readonly output: GainNode;
  readonly pitchMod: GainNode;
  readonly cutoffMod: GainNode;

  private readonly ctx: BaseAudioContext;
  private readonly bus: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly hits = new Set<DrumHit>();
  private readonly slotBuffers: (SlotBuffer | null)[] = Array.from({ length: DRUM_VOICES }, () => null);
  private instrument: DrumsInstrument | null = null;
  private kitId = '';
  private chokes: ChokeTable = chokeTable(DEFAULT_KIT_ID);
  private tune = 0;
  private decay = 1;
  private velocitySens = 0.6;
  private cutoff = 20000;
  private levelDb = 0;
  private voices: DrumVoiceSettings[] = [];
  /** Trigger counter (DrumHit.seq). */
  private seq = 0;
  /** True while kill() stops every hit. */
  private stoppingAll = false;
  private disposed = false;
  private readonly offline: boolean;
  /** Slots waiting for an idle render, in order. */
  private pending: number[] = [];
  private idleJob: Promise<void> | null = null;

  constructor(ictx: InstrumentContext, instrument: DrumsInstrument) {
    const ctx = ictx.ctx;
    this.ctx = ctx;
    this.offline = ictx.offline ?? (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext);
    this.bus = new GainNode(ctx, { gain: PAN_LAW_MAKEUP });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: BUTTERWORTH_Q_DB });
    this.output = new GainNode(ctx, { gain: 1 });
    this.pitchMod = new GainNode(ctx, { gain: 1 });
    this.cutoffMod = new GainNode(ctx, { gain: 1 });
    this.bus.connect(this.filter);
    this.filter.connect(this.output);
    this.cutoffMod.connect(this.filter.detune);
    this.apply(instrument, ctx.currentTime, true);
  }

  update(instrument: Instrument, time: number): void {
    if (this.disposed || instrument.kind !== 'drums' || instrument === this.instrument) return;
    const t = Math.max(finiteOr(time, 0), this.ctx.currentTime);
    this.apply(instrument, t, false);
  }

  private apply(instrument: DrumsInstrument, time: number, initial: boolean): void {
    this.instrument = instrument;
    const p = instrument.params;
    this.kitId = resolveKitId(instrument.kitId);
    this.chokes = chokeTable(this.kitId);
    this.tune = readParam(DRUM_KIT_PARAMS, p, 'tune');
    this.decay = readParam(DRUM_KIT_PARAMS, p, 'decay');
    this.velocitySens = readParam(DRUM_KIT_PARAMS, p, 'velocity');
    const cutoff = Math.min(readParam(DRUM_KIT_PARAMS, p, 'cutoff'), this.ctx.sampleRate * 0.49);
    const levelDb = readParam(DRUM_KIT_PARAMS, p, 'level');
    const S = DRUM_VOICE_PARAM_SPECS;
    this.voices = Array.from({ length: DRUM_VOICES }, (_, s) => {
      const v = instrument.voices?.[s];
      return {
        tune: clampParam(S.tune, v?.tune ?? S.tune.default),
        decay: clampParam(S.decay, v?.decay ?? S.decay.default),
        level: clampParam(S.level, v?.level ?? S.level.default),
        pan: clampParam(S.pan, v?.pan ?? S.pan.default),
      };
    });
    if (initial) {
      this.filter.frequency.value = cutoff;
      this.output.gain.value = dbToGain(levelDb);
    } else {
      // Smoothed so knob moves never zipper.
      if (cutoff !== this.cutoff) this.filter.frequency.setTargetAtTime(cutoff, time, PARAM_SMOOTHING);
      if (levelDb !== this.levelDb) this.output.gain.setTargetAtTime(dbToGain(levelDb), time, PARAM_SMOOTHING);
    }
    this.cutoff = cutoff;
    this.levelDb = levelDb;
  }

  /** Effective (quantised) decay multiplier of a slot. */
  private slotDecay(slot: number): number {
    return quantizeDrumDecay(this.decay * this.voices[slot].decay);
  }

  /**
   * The AudioBuffer for a slot at the current settings; rendered on first
   * use after a change. With `stale`, a slot whose new voice would have to be
   * rendered keeps its previous sound for now and queues the render for idle
   * time (a voice already in the shared cache is used at once).
   */
  private bufferFor(slot: number, stale = false): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const dm = this.slotDecay(slot);
    const key = drumVoiceKey(this.kitId, slot, sr, dm);
    const cur = this.slotBuffers[slot];
    if (cur && cur.key === key) return cur.buffer;
    let data = peekDrumVoice(this.kitId, slot, sr, dm);
    if (!data && stale && cur) {
      void this.renderLater([slot]);
      return cur.buffer;
    }
    data ??= getDrumVoice(this.kitId, slot, sr, dm);
    const buffer = this.ctx.createBuffer(1, data.length, sr);
    buffer.copyToChannel(data, 0);
    this.slotBuffers[slot] = { key, buffer };
    return buffer;
  }

  /**
   * Render the kit's voices ahead of the hits. At once by default; with
   * `incremental` (live engines) in idle slices, `order` first (the slots the
   * clips play), only those with scope 'used'. Resolves when done.
   */
  prepare(opts?: PrepareOptions): void | Promise<void> {
    if (!opts?.incremental || this.offline) {
      this.preload();
      return;
    }
    const order: number[] = [];
    for (const v of opts.order ?? []) {
      const s = Math.round(v);
      if (Number.isFinite(s) && s >= 0 && s < DRUM_VOICES && !order.includes(s)) order.push(s);
    }
    if (opts.scope !== 'used') for (let s = 0; s < DRUM_VOICES; s++) if (!order.includes(s)) order.push(s);
    return this.renderLater(order);
  }

  /** Render every slot's buffer now (optional warm-up, e.g. right after choosing a kit). */
  preload(): void {
    if (this.disposed) return;
    for (let s = 0; s < DRUM_VOICES; s++) this.bufferFor(s);
  }

  /** Queue slots for idle rendering (these first); resolves when the queue is empty. */
  private renderLater(slots: readonly number[]): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending = [...slots, ...this.pending.filter((s) => !slots.includes(s))];
    this.idleJob ??= runWhenIdle(() => this.renderNext()).then(() => {
      this.idleJob = null;
    });
    return this.idleJob;
  }

  /** One idle unit: render the next queued slot (at the settings in force now). */
  private renderNext(): boolean {
    if (this.disposed) {
      this.pending = [];
      return false;
    }
    const slot = this.pending.shift();
    if (slot !== undefined) this.bufferFor(slot);
    return this.pending.length > 0;
  }

  trigger(note: NoteTrigger): VoiceHandle | null {
    if (this.disposed) return null;
    const slot = Math.round(finiteOr(note.pitch, -1));
    if (slot < 0 || slot >= DRUM_VOICES) return null;
    const ctx = this.ctx;
    const voice = this.voices[slot];
    // A hit scheduled ahead never waits for a render: it may play the slot's previous sound.
    const stale = !this.offline && finiteOr(note.time, 0) > ctx.currentTime + IMMEDIATE_HIT;
    // May render the slot's sound first (a few ms), so read the clock afterwards.
    const buffer = this.bufferFor(slot, stale);
    const now = ctx.currentTime;
    const time = Math.max(finiteOr(note.time, now), now);
    const level = drumVelocityGain(note.velocity, this.velocitySens) * voice.level;
    const semis = Math.min(MAX_TUNE_SEMITONES, Math.max(-MAX_TUNE_SEMITONES, this.tune + voice.tune));
    const rate = Math.pow(2, semis / 12);

    const src = new AudioBufferSourceNode(ctx, { buffer, playbackRate: rate });
    const gain = new GainNode(ctx, { gain: level });
    const panner = new StereoPannerNode(ctx, { pan: voice.pan });
    src.connect(gain);
    gain.connect(panner);
    panner.connect(this.bus);
    this.pitchMod.connect(src.detune);
    // Start before any choke or steal can schedule this hit's stop.
    src.start(time);

    const hit = new DrumHit(ctx, slot, time, this.seq++, time + buffer.duration / rate, src, gain, panner, level, this.detach);
    this.choke(hit);
    this.limitPolyphony(hit);
    this.hits.add(hit);
    return hit;
  }

  /** Choke-group interaction between a new hit and the hits already scheduled. */
  private choke(hit: DrumHit): void {
    const chokes = this.chokes[hit.slot];
    for (const other of this.hits) {
      if (other.ended || !chokes[other.slot]) continue;
      // The later hit wins, whichever order the triggers arrived in.
      if (hit.isLaterThan(other)) other.fadeOut(hit.startTime, DRUM_CHOKE_FADE, hit);
      else hit.fadeOut(other.startTime, DRUM_CHOKE_FADE, other);
    }
  }

  /** Steal the oldest hits so at most DRUM_MAX_HITS sound when `hit` starts (including `hit`). */
  private limitPolyphony(hit: DrumHit): void {
    const time = hit.startTime;
    const sounding: DrumHit[] = [];
    for (const h of this.hits) if (!h.ended && h.startTime <= time && h.cutAt > time && h.endTime > time) sounding.push(h);
    let excess = sounding.length + 1 - DRUM_MAX_HITS;
    if (excess <= 0) return;
    sounding.sort((a, b) => (a.isLaterThan(b) ? 1 : -1));
    for (const h of sounding) {
      if (excess <= 0) break;
      h.fadeOut(time, DRUM_STEAL_FADE, hit);
      excess--;
    }
  }

  /**
   * A hit was cancelled before it sounded: give back the hits it would have
   * choked or stolen, then re-apply the chokes of the hits that remain.
   */
  private undoCuts(cancelled: DrumHit): void {
    for (const h of this.hits) {
      if (h.cutBy !== cancelled || !h.restore()) continue;
      const chokes = this.chokes[h.slot];
      for (const other of this.hits) {
        if (other !== h && !other.ended && chokes[other.slot] && other.isLaterThan(h)) h.fadeOut(other.startTime, DRUM_CHOKE_FADE, other);
      }
    }
  }

  private readonly detach = (hit: DrumHit, src: AudioBufferSourceNode, cancelled: boolean): void => {
    this.hits.delete(hit);
    try {
      this.pitchMod.disconnect(src.detune);
    } catch {
      // Already disconnected.
    }
    if (cancelled && !this.stoppingAll) this.undoCuts(hit);
  };

  /** Fade everything that has started by `time`; hits scheduled later never sound. */
  releaseAll(time: number): void {
    if (this.disposed) return;
    const t = Math.max(finiteOr(time, 0), this.ctx.currentTime);
    const all = [...this.hits];
    // Cancel first: that can give back chokes, and the hits they restore must still fade at `t`.
    for (const h of all) if (h.startTime >= t) h.cancel();
    for (const h of all) if (!h.ended) h.fadeOut(t, DRUM_RELEASE_FADE, null);
  }

  kill(): void {
    // Everything stops, so there is nothing to give back to other hits.
    this.stoppingAll = true;
    for (const h of [...this.hits]) h.cancel();
    this.stoppingAll = false;
  }

  activeVoices(): number {
    return this.hits.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.kill();
    this.disposed = true;
    this.pending = [];
    this.slotBuffers.fill(null);
    this.cutoffMod.disconnect();
    this.pitchMod.disconnect();
    this.bus.disconnect();
    this.filter.disconnect();
    this.output.disconnect();
  }
}
