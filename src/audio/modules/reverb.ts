/**
 * Reverb module: convolution with a generated, seeded stereo impulse response.
 *
 *   in ─┬─ dryGate (1 − mix) ───────────────────────────────────────────┐
 *       └─ pre-delay (mono) ─┬─ slot.in ─ convolver ─ slot.out ─┐        │
 *                            └─ (older slots ringing out) ──────┴─ tone LP ─ wetGate ─┴─> out
 *
 * The room is fed a mono sum and answers in decorrelated stereo, so every
 * part gets the same wide room whatever its pan.
 *
 * Size (decay) changes regenerate the IR. Live, regeneration is debounced
 * (120 ms after the last change). Offline, the IR is built immediately and
 * the same debounce is applied on the timeline: the switch lands 120 ms after
 * the change, and a further change before that replaces the pending switch.
 * A recorded knob drag therefore builds one room per pause, not one per step
 * (each 10 s room holds several MB), and exports switch when playback does.
 * The switch crossfades the convolvers' INPUTS over ~60 ms: the new convolver
 * takes new sound while the old one's tail rings out naturally, so there is
 * neither a click nor a dip in the reverb wash. At most two older convolvers
 * ring out at once; beyond that the oldest is faded out.
 */
import { REVERB_PARAMS, readParam } from '../../project/params';
import { subSeed } from '../../project/rng';
import type { Id, ParamValues } from '../../project/types';
import { BUTTERWORTH_Q_DB, ControlBus, EffectModule, clamp01Curve, createImpulseBuffer } from './fxutil';
import type { ModuleEnv } from './types';

/** Debounce for regenerating the IR after Size changes (live contexts). */
export const REVERB_REGEN_DEBOUNCE_MS = 120;
/** Input crossfade time constant between convolvers (about 95% after 60 ms). */
const XFADE_TAU = 0.02;
const MAX_RINGING = 2;
const FADE_TAU = 0.01;
const FLUSH_TAU = 0.003;
const FLUSH_CLEANUP_MS = 60;
/** IRs kept for reuse (current and previous size; each 10 s stereo IR is ~3.8 MB at 48 kHz). */
const BUFFER_CACHE = 2;

interface Slot {
  decay: number;
  buffer: AudioBuffer;
  inGain: GainNode;
  conv: ConvolverNode;
  outGain: GainNode;
  /** Context time of the Size change that asked for this room (-Infinity for the first). */
  requestAt: number;
  /** Context time this slot takes over the input (-Infinity for the first). */
  switchAt: number;
  /** Context time after which it is silent and can be released. */
  retireAt: number;
  timer: number | null;
  /** Being faded out early (too many rooms ringing at once). */
  forced: boolean;
}

export class ReverbModule extends EffectModule {
  readonly type = 'reverb' as const;
  private readonly ctl: ControlBus;
  private readonly dryGate: GainNode;
  private readonly convSum: GainNode;
  private readonly tone: BiquadFilterNode;
  private pre: DelayNode;
  private predelay: number;
  private current: Slot;
  /** Older slots ringing out (or fading out), oldest first. */
  private retired: Slot[] = [];
  private readonly seed: number;
  private readonly buffers = new Map<number, AudioBuffer>();
  /** Latest requested decay (may still be waiting for the debounce). */
  private requestedDecay: number;
  private debounce: number | null = null;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    this.seed = subSeed(env.seed, 'reverb-ir');
    const decay = readParam(REVERB_PARAMS, params, 'decay');
    const mix = readParam(REVERB_PARAMS, params, 'mix');
    this.predelay = readParam(REVERB_PARAMS, params, 'predelay') / 1000;
    this.requestedDecay = decay;

    const sum = this.own(new GainNode(ctx));
    sum.connect(this.bypass.processed);
    this.dryGate = this.own(new GainNode(ctx, { gain: 1 - mix }));
    this.bypass.input.connect(this.dryGate);
    this.dryGate.connect(sum);

    this.convSum = this.own(new GainNode(ctx));
    this.tone = this.own(
      new BiquadFilterNode(ctx, { type: 'lowpass', frequency: readParam(REVERB_PARAMS, params, 'tone'), Q: BUTTERWORTH_Q_DB }),
    );
    const wetGate = this.own(new GainNode(ctx, { gain: 0 }));
    this.convSum.connect(this.tone);
    this.tone.connect(wetGate);
    wetGate.connect(sum);

    // Wet level = clamp(mix + mod, 0, 1); dry follows the knob only.
    this.ctl = new ControlBus(ctx, mix, 1, this.own);
    this.registerMod('mix', this.ctl.modInput);
    this.ctl.map(clamp01Curve(), wetGate.gain);

    this.pre = this.makePre();
    this.current = this.makeSlot(decay, 1, -Infinity, -Infinity);
  }

  private makePre(): DelayNode {
    const pre = this.own(
      new DelayNode(this.ctx, { maxDelayTime: 0.2, delayTime: this.predelay, channelCount: 1, channelCountMode: 'explicit' }),
    );
    this.bypass.input.connect(pre);
    return pre;
  }

  private bufferFor(decay: number): AudioBuffer {
    const hit = this.buffers.get(decay);
    if (hit) {
      // Refresh LRU position.
      this.buffers.delete(decay);
      this.buffers.set(decay, hit);
      return hit;
    }
    const buf = createImpulseBuffer(this.ctx, decay, this.seed);
    this.buffers.set(decay, buf);
    while (this.buffers.size > BUFFER_CACHE) {
      const oldest = this.buffers.keys().next().value as number;
      this.buffers.delete(oldest);
    }
    return buf;
  }

  private makeSlot(decay: number, gain: number, switchAt: number, requestAt: number): Slot {
    const buffer = this.bufferFor(decay);
    const inGain = this.own(new GainNode(this.ctx, { gain, channelCount: 1, channelCountMode: 'explicit' }));
    const conv = this.own(new ConvolverNode(this.ctx, { buffer, disableNormalization: true }));
    const outGain = this.own(new GainNode(this.ctx));
    this.pre.connect(inGain);
    inGain.connect(conv);
    conv.connect(outGain);
    outGain.connect(this.convSum);
    return { decay, buffer, inGain, conv, outGain, requestAt, switchAt, retireAt: Infinity, timer: null, forced: false };
  }

  private releaseSlot(s: Slot): void {
    if (s.timer !== null) this.stopTimer(s.timer);
    s.timer = null;
    // Drop the inbound edge too, or the pre-delay would keep the slot alive.
    try {
      this.pre.disconnect(s.inGain);
    } catch {
      /* not connected to the current pre-delay */
    }
    this.release([s.inGain, s.conv, s.outGain]);
  }

  /** Release retired slots that have gone silent (offline contexts have no timers). */
  private reap(now: number): void {
    this.retired = this.retired.filter((s) => {
      if (s.retireAt <= now) {
        this.releaseSlot(s);
        return false;
      }
      return true;
    });
  }

  /** Schedule release of a slot once it is silent. */
  private scheduleRetire(s: Slot, retireAt: number): void {
    s.retireAt = retireAt;
    if (this.env.offline) return;
    if (s.timer !== null) this.stopTimer(s.timer);
    const ms = Math.max(0, (retireAt - this.ctx.currentTime) * 1000);
    s.timer = this.startTimer(() => {
      s.timer = null;
      this.retired = this.retired.filter((r) => r !== s);
      this.releaseSlot(s);
    }, ms);
  }

  /**
   * Switch to an IR for `decay` at context time `at` (requested at
   * `requestAt`), crossfading the inputs.
   */
  private switchTo(decay: number, at: number, requestAt: number): void {
    this.reap(this.ctx.currentTime);
    if (decay === this.current.decay) return;
    const old = this.current;
    const next = this.makeSlot(decay, 0, at, requestAt);
    next.inGain.gain.setTargetAtTime(1, at, XFADE_TAU);
    old.inGain.gain.setTargetAtTime(0, at, XFADE_TAU);
    this.retired.push(old);
    this.current = next;
    this.scheduleRetire(old, at + 8 * XFADE_TAU + old.buffer.duration + 0.05);
    // Bound CPU during rapid size changes: fade the oldest ringing rooms out
    // early. The fade starts when the new room takes over, never before: a
    // victim may still be the room in use until then (switches scheduled
    // ahead on an offline timeline).
    const ringing = this.retired.filter((r) => !r.forced);
    while (ringing.length > MAX_RINGING) {
      const victim = ringing.shift() as Slot;
      victim.forced = true;
      victim.outGain.gain.setTargetAtTime(0, at, FADE_TAU);
      this.scheduleRetire(victim, at + 8 * FADE_TAU);
    }
  }

  /**
   * Undo the newest switches while `undo(current)` holds. Only switches that
   * have not started may be undone; the previous room keeps the input.
   */
  private undoSwitches(undo: (s: Slot) => boolean): void {
    while (this.retired.length > 0 && undo(this.current)) {
      const prev = this.retired[this.retired.length - 1];
      // Never the case for the room a switch replaced (only older rooms are
      // forced out), but a forced room must not be revived.
      if (prev.forced) break;
      const cancelled = this.current;
      this.retired.pop();
      // Remove only prev's fade-out at the cancelled switch; its own fade-in
      // (an earlier switch that may itself still be pending) stays.
      prev.inGain.gain.cancelScheduledValues(cancelled.switchAt);
      if (prev.timer !== null) this.stopTimer(prev.timer);
      prev.timer = null;
      prev.retireAt = Infinity;
      this.releaseSlot(cancelled);
      this.current = prev;
    }
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const mix = readParam(REVERB_PARAMS, params, 'mix');
    this.predelay = readParam(REVERB_PARAMS, params, 'predelay') / 1000;
    this.smooth(this.dryGate.gain, 1 - mix, t);
    this.smooth(this.ctl.base.offset, mix, t);
    this.smooth(this.tone.frequency, readParam(REVERB_PARAMS, params, 'tone'), t);
    this.smooth(this.pre.delayTime, this.predelay, t);

    const decay = readParam(REVERB_PARAMS, params, 'decay');
    if (decay === this.requestedDecay) return;
    this.requestedDecay = decay;
    if (this.env.offline) {
      // The debounce on the timeline: a switch still pending at `t` is
      // replaced (it has not started, since t >= now).
      this.undoSwitches((s) => s.switchAt > t);
      this.switchTo(decay, t + REVERB_REGEN_DEBOUNCE_MS / 1000, t);
      return;
    }
    if (this.debounce !== null) this.stopTimer(this.debounce);
    this.debounce = this.startTimer(() => {
      this.debounce = null;
      const now = this.ctx.currentTime;
      this.switchTo(this.requestedDecay, now, now);
    }, REVERB_REGEN_DEBOUNCE_MS);
  }

  protected afterCancel(time: number): void {
    // Size changes requested at or after `time` are cancelled with the
    // automation that asked for them (their switches have not started: a
    // switch never precedes its request).
    const limit = Math.max(time, this.ctx.currentTime);
    this.undoSwitches((s) => s.requestAt >= limit);
    this.requestedDecay = this.current.decay;
  }

  /** Remove every tail immediately: fresh pre-delay and convolver, old ones faded and released. */
  flush(): void {
    if (this.disposed) return;
    const oldPre = this.pre;
    const oldSlots = [this.current, ...this.retired];
    this.bypass.input.disconnect(oldPre);
    this.forgetParams([oldPre.delayTime]);
    this.pre = this.makePre();
    this.retired = [];
    this.current = this.makeSlot(this.current.decay, 1, -Infinity, -Infinity);
    const now = this.ctx.currentTime;
    for (const s of oldSlots) {
      if (s.timer !== null) this.stopTimer(s.timer);
      s.timer = null;
    }
    const nodes: AudioNode[] = [oldPre];
    for (const s of oldSlots) nodes.push(s.inGain, s.conv, s.outGain);
    if (this.env.offline) {
      this.release(nodes);
      return;
    }
    for (const s of oldSlots) s.outGain.gain.setTargetAtTime(0, now, FLUSH_TAU);
    this.startTimer(() => this.release(nodes), FLUSH_CLEANUP_MS);
  }

  dispose(): void {
    this.buffers.clear();
    this.retired = [];
    this.debounce = null;
    super.dispose();
  }
}
