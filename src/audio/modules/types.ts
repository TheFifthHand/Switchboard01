/**
 * Internal contract between the engine core (src/audio/engine.ts) and the
 * per-type module implementations (src/audio/modules/*.ts).
 *
 * The engine creates one ModuleNode per PatchModule, wires connections
 * between `output(port)` and `input(port)` through per-connection GainNodes,
 * and pushes resolved params / tempo / transport notifications.
 */
import type { AudioEngineApi, InstrumentFactory, InstrumentContext } from '../contracts';
import type { Id, ModuleType, ParamValues } from '../../project/types';

export interface ModuleEnv {
  ctx: BaseAudioContext;
  /** Deterministic seed for this module (derived from project seed + module id). */
  seed: number;
  /** Current tempo. */
  getBpm(): number;
  /** Instrument construction (instrument modules only). */
  instrumentFactory: InstrumentFactory;
  instrumentContext: InstrumentContext;
  /** Register a timer the engine should count and clear on dispose (returns the id). */
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  /** True when running on an OfflineAudioContext (no timers, no meters). */
  offline: boolean;
  /** Back-reference for modules that need engine services (rarely). */
  engine?: AudioEngineApi;
}

export interface ModuleNode {
  readonly id: Id;
  readonly type: ModuleType;
  /**
   * Input node for a port. Audio inputs receive sound; modulation inputs are
   * GainNodes that the module has internally routed (with the port's range)
   * into the right AudioParams. Undefined if the port does not exist.
   */
  input(port: string): AudioNode | undefined;
  /** Output node for a port, or undefined. */
  output(port: string): AudioNode | undefined;
  /**
   * Apply resolved parameter values. `time` is the context time the change
   * should reach; implementations smooth continuous params (setTargetAtTime,
   * ~10–30 ms) and switch discrete ones without clicks where possible.
   */
  setParams(params: ParamValues, time: number): void;
  /** Bypass: route input straight to output (crossfaded). Only meaningful for effects. */
  setBypass(bypass: boolean, time: number): void;
  /** Tempo-synced modules update rates/times. */
  setTempo?(bpm: number, time: number): void;
  /** Transport started at `time` at musical `tick`: align LFO phase etc. */
  transportStarted?(time: number, tick: number, bpm: number): void;
  /** Transport stopped at `time`: tempo-synced movement keeps running freely from its phase. */
  transportStopped?(time: number): void;
  /** Clear internal state/tails immediately (Mute All / panic). */
  flush?(): void;
  /** Cancel automation scheduled after `time`. */
  cancelAfter?(time: number): void;
  dispose(): void;
}

export type ModuleConstructor = new (env: ModuleEnv, id: Id, params: ParamValues) => ModuleNode;

/** Smoothing time constant for continuous parameter changes (seconds). */
export const PARAM_SMOOTHING = 0.015;
/** Ramp for connection gain changes when rewiring (seconds). */
export const REWIRE_RAMP = 0.02;
