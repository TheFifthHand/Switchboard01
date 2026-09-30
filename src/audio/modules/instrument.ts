/**
 * Instrument module: wraps the InstrumentEngine of one track in the patch.
 *
 * - 'out' carries the instrument's sound.
 * - Mod inputs 'pitch' and 'cutoff' are GainNodes scaled by the port's range
 *   (200 / 3600 cents per full-scale signal) feeding the engine's
 *   pitchMod / cutoffMod buses.
 * - The inner engine is created on the first `update()` (the module
 *   constructor only receives params, the engine needs the full Instrument)
 *   and swapped with a short crossfade when the instrument kind changes.
 */
import type { Id, Instrument, ParamValues } from '../../project/types';
import { MODULE_DEFS } from '../../project/modules';
import type { InstrumentEngine, NoteTrigger, VoiceHandle } from '../contracts';
import type { ModuleEnv, ModuleNode } from './types';

/** Crossfade when the instrument kind changes. */
export const INSTRUMENT_SWAP_FADE = 0.03;

function modAmount(port: string): number {
  return MODULE_DEFS.instrument.ports.find((p) => p.id === port && p.direction === 'in')?.modRange?.amount ?? 0;
}

interface EngineSlot {
  engine: InstrumentEngine;
  gain: GainNode;
  timer: number | null;
}

export class InstrumentModule implements ModuleNode {
  readonly type = 'instrument' as const;
  private readonly env: ModuleEnv;
  private readonly out: GainNode;
  private readonly pitchIn: GainNode;
  private readonly cutoffIn: GainNode;
  private current: EngineSlot | null = null;
  private readonly retiring = new Set<EngineSlot>();
  private instrument: Instrument | null = null;
  private disposed = false;

  constructor(
    env: ModuleEnv,
    readonly id: Id,
    _params: ParamValues,
  ) {
    this.env = env;
    const ctx = env.ctx;
    this.out = ctx.createGain();
    this.pitchIn = ctx.createGain();
    this.pitchIn.gain.value = modAmount('pitch');
    this.cutoffIn = ctx.createGain();
    this.cutoffIn.gain.value = modAmount('cutoff');
  }

  input(port: string): AudioNode | undefined {
    if (port === 'pitch') return this.pitchIn;
    if (port === 'cutoff') return this.cutoffIn;
    return undefined;
  }

  output(port: string): AudioNode | undefined {
    return port === 'out' ? this.out : undefined;
  }

  /** The instrument kind currently loaded, or null before the first update. */
  get kind(): Instrument['kind'] | null {
    return this.current?.engine.kind ?? null;
  }

  /** Apply instrument data (resolved params). Swaps the engine when the kind changes. */
  update(instrument: Instrument, time: number): void {
    if (this.disposed) return;
    const t = Math.max(Number.isFinite(time) ? time : 0, this.env.ctx.currentTime);
    if (!this.current || this.current.engine.kind !== instrument.kind) {
      this.swap(instrument, t);
    } else if (instrument !== this.instrument) {
      this.current.engine.update(instrument, t);
    }
    this.instrument = instrument;
  }

  /** Automation on instrument params (scheduleParam on "<track>:inst"). */
  setParams(params: ParamValues, time: number): void {
    if (!this.instrument) return;
    this.update({ ...this.instrument, params: { ...params } } as Instrument, time);
  }

  setBypass(_bypass: boolean, _time: number): void {
    // The sound source cannot be bypassed.
  }

  private swap(instrument: Instrument, time: number): void {
    const ctx = this.env.ctx;
    let engine: InstrumentEngine;
    try {
      engine = this.env.instrumentFactory(this.env.instrumentContext, instrument);
    } catch (err) {
      // A broken instrument must not take the rest of the graph down; this part stays silent.
      console.error(`Instrument "${instrument.kind}" could not be created for ${this.id}`, err);
      this.retire(time);
      return;
    }
    const gain = ctx.createGain();
    engine.output.connect(gain);
    gain.connect(this.out);
    this.pitchIn.connect(engine.pitchMod);
    this.cutoffIn.connect(engine.cutoffMod);
    engine.update(instrument, time);
    const hadPrevious = this.current !== null;
    this.retire(time);
    if (hadPrevious && !this.env.offline) {
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(1, time + INSTRUMENT_SWAP_FADE);
    } else {
      gain.gain.value = 1;
    }
    this.current = { engine, gain, timer: null };
  }

  /** Fade out the current engine and free it after the fade. */
  private retire(time: number): void {
    const slot = this.current;
    if (!slot) return;
    this.current = null;
    this.disconnectMod(slot.engine);
    if (this.env.offline) {
      this.destroySlot(slot);
      return;
    }
    const g = slot.gain.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(g.value, time);
    g.linearRampToValueAtTime(0, time + INSTRUMENT_SWAP_FADE);
    slot.engine.releaseAll(time);
    this.retiring.add(slot);
    const delayMs = Math.max(0, time - this.env.ctx.currentTime) * 1000 + INSTRUMENT_SWAP_FADE * 1000 + 30;
    slot.timer = this.env.setTimer(() => {
      slot.timer = null;
      this.retiring.delete(slot);
      this.destroySlot(slot);
    }, delayMs);
  }

  private disconnectMod(engine: InstrumentEngine): void {
    try {
      this.pitchIn.disconnect(engine.pitchMod);
    } catch {
      // Not connected.
    }
    try {
      this.cutoffIn.disconnect(engine.cutoffMod);
    } catch {
      // Not connected.
    }
  }

  private destroySlot(slot: EngineSlot): void {
    if (slot.timer !== null) {
      this.env.clearTimer(slot.timer);
      slot.timer = null;
    }
    slot.engine.kill();
    slot.engine.dispose();
    try {
      slot.engine.output.disconnect(slot.gain);
    } catch {
      // Already disconnected by the engine's own dispose.
    }
    slot.gain.disconnect();
  }

  trigger(note: NoteTrigger): VoiceHandle | null {
    if (this.disposed || !this.current) return null;
    return this.current.engine.trigger(note);
  }

  releaseAll(time: number): void {
    const t = Math.max(Number.isFinite(time) ? time : 0, this.env.ctx.currentTime);
    this.current?.engine.releaseAll(t);
  }

  /** Stop: end one-shots still playing out their sound (sampler One-shot); see InstrumentEngine.stopOneShots. */
  stopOneShots(time: number, startedOnly = false): void {
    const t = Math.max(Number.isFinite(time) ? time : 0, this.env.ctx.currentTime);
    this.current?.engine.stopOneShots?.(t, startedOnly);
  }

  /** Hard stop of every voice (current and fading engines). */
  kill(): void {
    this.current?.engine.kill();
    for (const s of this.retiring) s.engine.kill();
  }

  activeVoices(): number {
    let n = this.current?.engine.activeVoices() ?? 0;
    for (const s of this.retiring) n += s.engine.activeVoices();
    return n;
  }

  flush(): void {
    this.kill();
  }

  /** Warm the current instrument's caches (drum buffers) outside the scheduling path. */
  prepare(): void {
    this.current?.engine.prepare?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cur = this.current;
    this.current = null;
    if (cur) {
      this.disconnectMod(cur.engine);
      this.destroySlot(cur);
    }
    for (const s of this.retiring) this.destroySlot(s);
    this.retiring.clear();
    this.out.disconnect();
    this.pitchIn.disconnect();
    this.cutoffIn.disconnect();
  }
}
