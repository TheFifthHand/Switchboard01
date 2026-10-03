/**
 * Drive module: saturation / distortion with level compensation.
 *
 *   in ─┬─ 1/32 ─ identity shaper (2x) ─ dryGate ─────────────────────────────────────────┐
 *       ├─ pre ─┬─ sel0 ─ Warm shaper (2x) ─ trim0 ─┐                                      │
 *       │       ├─ sel1 ─ Hard shaper (2x) ─ trim1 ─┼─ wetGate ─ level match ─ tone LP ──────┴─> out
 *       │       └─ sel2 ─ Fold shaper (2x) ─ trim2 ─┘                ↑ (reference)
 *       └─ refGate ──────────────────────────────────────────────────┘
 *
 * Drive is an audio-rate control value d = clamp(amount + mod, 0, 1)
 * (ControlBus). Curves derived from d drive:
 *   pre.gain     = (1 + 30·d^1.5) / 32           (shaper curves span ±32)
 *   trimC.gain   = makeup(C, d)                   (RMS trim per character)
 *   wetGate.gain = mix · fade(d)                  fade(d) = min(1, 8d)
 *   dryGate.gain = 32 · (1 − mix · fade(d))
 * so Drive at zero is exactly the dry signal and the drive knob and its
 * modulation input share one law. The trim is level compensation in
 * practice: for each character it keeps a Gaussian input at −20 dBFS RMS
 * (DRIVE_REF_RMS, about where a part's sound reaches its Drive) at the same
 * RMS level at every Drive setting, so turning Drive up changes the
 * character, not the loudness (louder input is squeezed more, quieter input
 * less, as with any saturator).
 *
 * A fixed trim cannot fit every part: saturation turns level differences
 * into gain differences (a quiet, staccato chord part comes out of full
 * drive about 3 dB hotter than a drum kit with the same trim). The 'level
 * match' worklet (src/audio/worklets/fx.ts) finishes the job: it compares
 * the wet sound with the part's own sound before the drive (refGate carries
 * the same wet share, so both read alike) over 0.4 s and corrects the wet
 * level by at most ±6 dB, with block-wise averages (a few operations per
 * sample).
 *
 * The wet path (pre, shapers, trims, level match, tone) is only in the
 * graph while the Drive can be heard: Amount above 0, or a cable on its
 * Amount input (the engine reports patched inputs through setModulated; a
 * Drive used outside the engine must be told too). At Drive 0 it is
 * disconnected, so an idle Drive costs one latency-matching shaper and a
 * few gains, no worklet. Switching in is silent (the wet gate is 0 at Drive 0 and the knob
 * glides up from there); switching out waits until the glide down has ended
 * (live: a timer; an offline render keeps the path once it was needed, so it
 * never depends on wall-clock timing). The level match is created the first
 * time it is needed and starts afresh each time the path is switched in.
 *
 * The oversampled WaveShaper delays its output (128 frames in Chromium), so
 * the dry path runs through an identity shaper with the same oversampling:
 * dry and wet stay sample-aligned in every browser and blending never
 * comb-filters. The module therefore has a small constant latency, the same
 * at every setting (DRIVE_LATENCY_FRAMES).
 *
 * Every curve is computed once per page and shared: assigning a curve to a
 * WaveShaperNode copies it, while passing it in the constructor options is
 * a slow element-by-element conversion.
 */
import { DRIVE_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import {
  ControlBus,
  DRIVE_CHARACTERS,
  EffectModule,
  SHAPER_DOMAIN,
  SWITCH_TAU,
  BUTTERWORTH_Q_DB,
  driveGain,
  driveMakeup,
  driveWetFade,
  identityCurve,
  makeControlCurve,
  makeDriveCurve,
  shaperNode,
  type Curve,
} from './fxutil';
import { LEVEL_MATCH_PROCESSOR_NAME } from '../worklets/fx';
import type { ModuleEnv } from './types';

/** Constant delay of the module's oversampled shapers in Chromium (frames), the same at every setting. */
export const DRIVE_LATENCY_FRAMES = 128;

/** Grid of drive values the RMS trims are computed on (interpolated in between: the trims are smooth). */
const TRIM_GRID = 256;

interface DriveCurves {
  identity: Curve;
  shapers: Curve[];
  pre: Curve;
  fade: Curve;
  trims: Curve[];
}

let curves: DriveCurves | null = null;

/** f(d) for d in 0..1 tabulated on TRIM_GRID + 1 points and linearly interpolated. */
function tabulated(fn: (d: number) => number): (d: number) => number {
  const table = new Float64Array(TRIM_GRID + 1);
  for (let i = 0; i <= TRIM_GRID; i++) table[i] = fn(i / TRIM_GRID);
  return (d) => {
    const x = Math.min(1, Math.max(0, d)) * TRIM_GRID;
    const i = Math.min(TRIM_GRID - 1, Math.floor(x));
    const f = x - i;
    return table[i] + (table[i + 1] - table[i]) * f;
  };
}

/** The module's curves (built on first use, then shared by every Drive). */
function driveCurves(): DriveCurves {
  if (!curves) {
    curves = {
      identity: identityCurve(),
      shapers: Array.from({ length: DRIVE_CHARACTERS }, (_, c) => makeDriveCurve(c)),
      pre: makeControlCurve((d) => driveGain(d) / SHAPER_DOMAIN),
      fade: makeControlCurve(driveWetFade),
      trims: Array.from({ length: DRIVE_CHARACTERS }, (_, c) => makeControlCurve(tabulated((d) => driveMakeup(d, c)))),
    };
  }
  return curves;
}

/** Post-drive tone low-pass: 1.5 kHz at tone 0, 18 kHz at tone 1 (exponential). */
export function driveToneHz(tone: number): number {
  const t = Math.min(1, Math.max(0, tone));
  return 1500 * Math.pow(12, t);
}

/** Seconds after Drive reaches 0 before the idle wet path leaves the graph (the knob glide has ended by then). */
export const DRIVE_IDLE_DELAY = 0.25;

export class DriveModule extends EffectModule {
  readonly type = 'drive' as const;
  private readonly ctl: ControlBus;
  private readonly sels: GainNode[] = [];
  private readonly mixDry: GainNode;
  private readonly mixWet: GainNode;
  private readonly tone: BiquadFilterNode;
  private readonly src: AudioNode;
  private readonly pre: GainNode;
  private readonly wetGate: GainNode;
  private readonly refGate: GainNode;
  private match: AudioWorkletNode | null = null;
  private matchTried = false;
  /** Whether the wet path is in the graph. */
  private wetOn = false;
  private amount: number;
  /** Whether a cable drives Amount (reported by the engine after each rewiring). */
  private modulated = false;
  private idleTimer: number | null = null;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const amount = readParam(DRIVE_PARAMS, params, 'amount');
    const character = readParam(DRIVE_PARAMS, params, 'character');
    const tone = readParam(DRIVE_PARAMS, params, 'tone');
    const mix = readParam(DRIVE_PARAMS, params, 'mix');
    this.amount = amount;
    const input = this.bypass.input;
    this.src = input;

    const out = this.own(new GainNode(ctx));
    out.connect(this.bypass.processed);

    const k = driveCurves();

    // Dry path, latency-matched to the oversampled shapers.
    const dryIn = this.own(new GainNode(ctx, { gain: 1 / SHAPER_DOMAIN }));
    const dryShaper = this.own(shaperNode(ctx, k.identity, { oversample: '2x' }));
    const dryGate = this.own(new GainNode(ctx, { gain: SHAPER_DOMAIN }));
    input.connect(dryIn);
    dryIn.connect(dryShaper);
    dryShaper.connect(dryGate);
    dryGate.connect(out);

    // Control: d = clamp(amount + mod) drives pre-gain, the trims, wet and dry gates.
    this.ctl = new ControlBus(ctx, amount, 1, this.own);
    this.registerMod('amount', this.ctl.modInput);

    // Wet path (wired in by setWet while the Drive can be heard).
    this.pre = this.own(new GainNode(ctx, { gain: 0 }));
    const shaped = this.own(new GainNode(ctx));
    this.wetGate = this.own(new GainNode(ctx, { gain: 0 }));
    this.tone = this.own(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: driveToneHz(tone), Q: BUTTERWORTH_Q_DB }));
    for (let c = 0; c < DRIVE_CHARACTERS; c++) {
      const shaper = this.own(shaperNode(ctx, k.shapers[c], { oversample: '2x' }));
      const sel = this.own(new GainNode(ctx, { gain: c === character ? 1 : 0 }));
      const trim = this.own(new GainNode(ctx, { gain: 0 }));
      // Gate before the shaper so idle characters receive silence and the
      // browser can skip their oversampling.
      this.pre.connect(sel);
      sel.connect(shaper);
      shaper.connect(trim);
      trim.connect(shaped);
      this.ctl.map(k.trims[c], trim.gain);
      this.sels.push(sel);
    }
    shaped.connect(this.wetGate);
    // Level match reference: the part's own sound at the same wet share.
    this.refGate = this.own(new GainNode(ctx, { gain: 0 }));
    this.tone.connect(out);

    this.ctl.map(k.pre, this.pre.gain);
    const fade = this.ctl.shape(k.fade);
    this.mixWet = this.own(new GainNode(ctx, { gain: mix, channelCount: 1, channelCountMode: 'explicit' }));
    fade.connect(this.mixWet);
    this.mixWet.connect(this.wetGate.gain);
    this.mixWet.connect(this.refGate.gain);
    this.mixDry = this.own(new GainNode(ctx, { gain: mix, channelCount: 1, channelCountMode: 'explicit' }));
    const dryNeg = this.own(new GainNode(ctx, { gain: -SHAPER_DOMAIN, channelCount: 1, channelCountMode: 'explicit' }));
    fade.connect(this.mixDry);
    this.mixDry.connect(dryNeg);
    dryNeg.connect(dryGate.gain);
    this.updateWet(ctx.currentTime);
  }

  /** Whether the wet path (shapers, level match) is currently in the graph. */
  get wetActive(): boolean {
    return this.wetOn;
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const character = readParam(DRIVE_PARAMS, params, 'character');
    const mix = readParam(DRIVE_PARAMS, params, 'mix');
    this.amount = readParam(DRIVE_PARAMS, params, 'amount');
    // Switched in before the knob moves up from 0 (silently: the wet gate is still 0).
    this.updateWet(t);
    this.smooth(this.ctl.base.offset, this.amount, t);
    this.smooth(this.mixWet.gain, mix, t);
    this.smooth(this.mixDry.gain, mix, t);
    this.smooth(this.tone.frequency, driveToneHz(readParam(DRIVE_PARAMS, params, 'tone')), t);
    for (let c = 0; c < this.sels.length; c++) this.smooth(this.sels[c].gain, c === character ? 1 : 0, t, SWITCH_TAU);
  }

  /** A cable on Amount keeps the wet path in the graph even at Amount 0. */
  setModulated(ports: ReadonlySet<string>, time: number): void {
    if (this.disposed) return;
    this.modulated = ports.has('amount');
    this.updateWet(this.at(time));
  }

  private get needed(): boolean {
    return this.amount > 0 || this.modulated;
  }

  /**
   * Wire the wet path in when the Drive can be heard; take it out once it
   * cannot, after the glide to 0 has ended at `time` + DRIVE_IDLE_DELAY
   * (live only).
   */
  private updateWet(time: number): void {
    if (this.needed) {
      if (this.idleTimer !== null) {
        this.stopTimer(this.idleTimer);
        this.idleTimer = null;
      }
      this.setWet(true);
      return;
    }
    if (!this.wetOn || this.idleTimer !== null || this.env.offline) return;
    const ms = Math.max(0, time - this.ctx.currentTime) * 1000 + DRIVE_IDLE_DELAY * 1000;
    this.idleTimer = this.startTimer(() => {
      this.idleTimer = null;
      if (!this.needed) this.setWet(false);
    }, ms);
  }

  private setWet(on: boolean): void {
    if (on === this.wetOn) return;
    this.wetOn = on;
    if (on) {
      if (!this.matchTried) {
        this.matchTried = true;
        this.match = this.createMatch();
      } else {
        // Switched in again (live only: an offline render never switches out): fresh measurements.
        this.match?.port.postMessage('reset');
      }
      this.src.connect(this.pre);
      if (this.match) {
        this.src.connect(this.refGate);
        this.wetGate.connect(this.match, 0, 0);
        this.refGate.connect(this.match, 0, 1);
        this.match.connect(this.tone);
      } else {
        this.wetGate.connect(this.tone);
      }
      return;
    }
    const cut = (from: AudioNode, to: AudioNode, input?: number) => {
      try {
        if (input === undefined) from.disconnect(to);
        else from.disconnect(to, 0, input);
      } catch {
        // Not connected.
      }
    };
    cut(this.src, this.pre);
    if (this.match) {
      cut(this.src, this.refGate);
      cut(this.wetGate, this.match, 0);
      cut(this.refGate, this.match, 1);
      cut(this.match, this.tone);
    } else {
      cut(this.wetGate, this.tone);
    }
  }

  private createMatch(): AudioWorkletNode | null {
    let match: AudioWorkletNode;
    try {
      match = this.ownWorklet(
        new AudioWorkletNode(this.ctx, LEVEL_MATCH_PROCESSOR_NAME, {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        }),
      );
    } catch {
      // Worklets not loaded (a bare test context): the fixed trims alone compensate.
      return null;
    }
    return match;
  }

  /** Mute All: the level match forgets what it measured. */
  flush(): void {
    if (!this.disposed) this.match?.port.postMessage('reset');
  }
}
