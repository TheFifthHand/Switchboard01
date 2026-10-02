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
 * level by at most ±6 dB. Drive 0 gates both to silence, so the dry signal
 * passes untouched.
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
  workletParam,
  WorkletFlush,
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

export class DriveModule extends EffectModule {
  readonly type = 'drive' as const;
  private readonly ctl: ControlBus;
  private readonly sels: GainNode[] = [];
  private readonly mixDry: GainNode;
  private readonly mixWet: GainNode;
  private readonly tone: BiquadFilterNode;
  private readonly flusher: WorkletFlush | null = null;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const amount = readParam(DRIVE_PARAMS, params, 'amount');
    const character = readParam(DRIVE_PARAMS, params, 'character');
    const tone = readParam(DRIVE_PARAMS, params, 'tone');
    const mix = readParam(DRIVE_PARAMS, params, 'mix');
    const input = this.bypass.input;

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

    // Wet path.
    const pre = this.own(new GainNode(ctx, { gain: 0 }));
    const shaped = this.own(new GainNode(ctx));
    const wetGate = this.own(new GainNode(ctx, { gain: 0 }));
    this.tone = this.own(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: driveToneHz(tone), Q: BUTTERWORTH_Q_DB }));
    input.connect(pre);
    for (let c = 0; c < DRIVE_CHARACTERS; c++) {
      const shaper = this.own(shaperNode(ctx, k.shapers[c], { oversample: '2x' }));
      const sel = this.own(new GainNode(ctx, { gain: c === character ? 1 : 0 }));
      const trim = this.own(new GainNode(ctx, { gain: 0 }));
      // Gate before the shaper so idle characters receive silence and the
      // browser can skip their oversampling.
      pre.connect(sel);
      sel.connect(shaper);
      shaper.connect(trim);
      trim.connect(shaped);
      this.ctl.map(k.trims[c], trim.gain);
      this.sels.push(sel);
    }
    shaped.connect(wetGate);
    // Level match: wet against the part's own sound at the same wet share.
    const refGate = this.own(new GainNode(ctx, { gain: 0 }));
    input.connect(refGate);
    let match: AudioWorkletNode | null = null;
    try {
      match = this.ownWorklet(
        new AudioWorkletNode(ctx, LEVEL_MATCH_PROCESSOR_NAME, {
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
      match = null;
    }
    if (match) {
      this.flusher = new WorkletFlush(workletParam(match, 'flush', 'Drive level match'));
      wetGate.connect(match, 0, 0);
      refGate.connect(match, 0, 1);
      match.connect(this.tone);
    } else {
      wetGate.connect(this.tone);
    }
    this.tone.connect(out);

    this.ctl.map(k.pre, pre.gain);
    const fade = this.ctl.shape(k.fade);
    this.mixWet = this.own(new GainNode(ctx, { gain: mix, channelCount: 1, channelCountMode: 'explicit' }));
    fade.connect(this.mixWet);
    this.mixWet.connect(wetGate.gain);
    this.mixWet.connect(refGate.gain);
    this.mixDry = this.own(new GainNode(ctx, { gain: mix, channelCount: 1, channelCountMode: 'explicit' }));
    const dryNeg = this.own(new GainNode(ctx, { gain: -SHAPER_DOMAIN, channelCount: 1, channelCountMode: 'explicit' }));
    fade.connect(this.mixDry);
    this.mixDry.connect(dryNeg);
    dryNeg.connect(dryGate.gain);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const character = readParam(DRIVE_PARAMS, params, 'character');
    const mix = readParam(DRIVE_PARAMS, params, 'mix');
    this.smooth(this.ctl.base.offset, readParam(DRIVE_PARAMS, params, 'amount'), t);
    this.smooth(this.mixWet.gain, mix, t);
    this.smooth(this.mixDry.gain, mix, t);
    this.smooth(this.tone.frequency, driveToneHz(readParam(DRIVE_PARAMS, params, 'tone')), t);
    for (let c = 0; c < this.sels.length; c++) this.smooth(this.sels[c].gain, c === character ? 1 : 0, t, SWITCH_TAU);
  }

  /** Mute All: the level match forgets what it measured. */
  flush(): void {
    if (!this.disposed) this.flusher?.fire(this.ctx.currentTime);
  }
}
