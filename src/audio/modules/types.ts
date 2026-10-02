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
  /**
   * Cancel automation scheduled after `time`. With `hold`, a ramp under way
   * at `time` stops at the value it has reached there (cancelAndHoldAtTime)
   * instead of falling back to its last step.
   */
  cancelAfter?(time: number, hold?: boolean): void;
  /**
   * Song automation (AudioEngine.scheduleMacroRamp): apply `params` at
   * `time` without the usual smoothing. 'anchor' sets every value the
   * module drives at `time` (a ramp starts exactly there), 'step' sets the
   * values that change at `time`, 'ramp' moves them linearly from the
   * previous point to reach these values at `time`. Optional: modules
   * without it get smoothed points.
   */
  automate?(params: ParamValues, time: number, mode: AutomationMode): void;
  /**
   * Transport stopped: the song automation of the take is over. Forget all
   * of it (points before `time` included) and make the next setParams write
   * every value again, so the project's values come back even where the
   * automation ended on them. Called after cancelAfter, before setParams.
   */
  endAutomation?(time: number): void;
  /**
   * The module's mod inputs that have a working cable (a bypassed LFO's
   * silenced cables do not count), reported after every rewiring. Lets a
   * module keep processing that only a modulation can make audible.
   */
  setModulated?(ports: ReadonlySet<string>, time: number): void;
  dispose(): void;
}

/** How ModuleNode.automate applies a point. */
export type AutomationMode = 'anchor' | 'step' | 'ramp';

export type ModuleConstructor = new (env: ModuleEnv, id: Id, params: ParamValues) => ModuleNode;

/** Smoothing time constant for continuous parameter changes (seconds). */
export const PARAM_SMOOTHING = 0.015;
/** Ramp for connection gain changes when rewiring (seconds). */
export const REWIRE_RAMP = 0.02;
