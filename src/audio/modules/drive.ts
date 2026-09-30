/**
 * Drive module: saturation / distortion with level compensation.
 *
 *   in ─┬─ 1/32 ─ identity shaper (2x) ─ dryGate ─────────────────────────┐
 *       └─ pre ─┬─ sel0 ─ Warm shaper (2x) ─┐                             │
 *               ├─ sel1 ─ Hard shaper (2x) ─┼─ wetGate ─ tone LP ─────────┴─> out
 *               └─ sel2 ─ Fold shaper (2x) ─┘
 *
 * Drive is an audio-rate control value d = clamp(amount + mod, 0, 1)
 * (ControlBus). Curves derived from d drive:
 *   pre.gain     = (1 + 30·d^1.5) / 32           (shaper curves span ±32)
 *   wetGate.gain = mix · fade(d) · makeup(d)     fade(d) = min(1, 8d)
 *   dryGate.gain = 32 · (1 − mix · fade(d))
 * so Drive at zero is exactly the dry signal, the drive knob and its
 * modulation input share one law, and louder settings are level-compensated.
 *
 * The oversampled WaveShaper delays its output (128 frames in Chromium), so
 * the dry path runs through an identity shaper with the same oversampling:
 * dry and wet stay sample-aligned in every browser and blending never
 * comb-filters. The module therefore has a small constant latency, the same
 * at every setting.
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
} from './fxutil';
import type { ModuleEnv } from './types';

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

    // Dry path, latency-matched to the oversampled shapers.
    const dryIn = this.own(new GainNode(ctx, { gain: 1 / SHAPER_DOMAIN }));
    const dryShaper = this.own(new WaveShaperNode(ctx, { curve: identityCurve(), oversample: '2x' }));
    const dryGate = this.own(new GainNode(ctx, { gain: SHAPER_DOMAIN }));
    input.connect(dryIn);
    dryIn.connect(dryShaper);
    dryShaper.connect(dryGate);
    dryGate.connect(out);

    // Wet path.
    const pre = this.own(new GainNode(ctx, { gain: 0 }));
    const shaped = this.own(new GainNode(ctx));
    const wetGate = this.own(new GainNode(ctx, { gain: 0 }));
    this.tone = this.own(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: driveToneHz(tone), Q: BUTTERWORTH_Q_DB }));
    input.connect(pre);
    for (let c = 0; c < DRIVE_CHARACTERS; c++) {
      const shaper = this.own(new WaveShaperNode(ctx, { curve: makeDriveCurve(c), oversample: '2x' }));
      const sel = this.own(new GainNode(ctx, { gain: c === character ? 1 : 0 }));
      // Gate before the shaper so idle characters receive silence and the
      // browser can skip their oversampling.
      pre.connect(sel);
      sel.connect(shaper);
      shaper.connect(shaped);
      this.sels.push(sel);
    }
    shaped.connect(wetGate);
    wetGate.connect(this.tone);
    this.tone.connect(out);

    // Control: d = clamp(amount + mod) drives pre-gain, wet and dry gates.
    this.ctl = new ControlBus(ctx, amount, 1, this.own);
    this.registerMod('amount', this.ctl.modInput);
    this.ctl.map(makeControlCurve((d) => driveGain(d) / SHAPER_DOMAIN), pre.gain);
    this.mixWet = this.own(new GainNode(ctx, { gain: mix, channelCount: 1, channelCountMode: 'explicit' }));
    this.ctl.shape(makeControlCurve((d) => driveWetFade(d) * driveMakeup(d))).connect(this.mixWet);
    this.mixWet.connect(wetGate.gain);
    this.mixDry = this.own(new GainNode(ctx, { gain: mix, channelCount: 1, channelCountMode: 'explicit' }));
    const dryNeg = this.own(new GainNode(ctx, { gain: -SHAPER_DOMAIN, channelCount: 1, channelCountMode: 'explicit' }));
    this.ctl.shape(makeControlCurve(driveWetFade)).connect(this.mixDry);
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
}
