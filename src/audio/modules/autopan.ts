/**
 * Auto Pan module: tempo-synced panning or tremolo.
 *
 *   lfo (LfoModule: Sine / Triangle / Square, synced division, transport-aligned)
 *     ─ smoother 120 Hz (critically damped two-pole: rounds Square edges so they never click)
 *     ─ ×depth ──> p (−1..1)
 *
 *   Pan:     in ─ split ─ M = (L+R)/2 ─┬─ ×√2·cos((1+p)·π/4) ─┐
 *                        S = (L−R)/2 ──┼─────────── +S ───────┼─ L
 *                                      └─ ×√2·sin((1+p)·π/4) ─┴─ R (−S)
 *            the middle of the image moves with constant power (a mono part
 *            sweeps from left to right without getting louder at the sides);
 *            the stereo spread of the input (S) is kept.
 *   Tremolo: gain = 1 − depth·(1 − lfo)/2, between 1 − depth and 1.
 *
 * Depth is an audio-rate control (ControlBus: knob + 'depth' modulation,
 * clamped to 0..1). Mode switches crossfade between the two paths. The LFO
 * is the same tempo-synced LfoModule the patch uses, so it follows tempo
 * changes and lines up with the transport (setTempo / transportStarted /
 * transportStopped are forwarded to it).
 */
import { AUTOPAN_PARAMS, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { ControlBus, EffectModule, SWITCH_TAU, controlSmoother, makeControlCurve, shaperNode } from './fxutil';
import { LfoModule, LfoWave } from './lfo';
import type { ModuleEnv } from './types';

/** AUTOPAN_SHAPES (Sine, Triangle, Square) as LFO waves. */
const SHAPE_WAVES = [LfoWave.Sine, LfoWave.Triangle, LfoWave.Square] as const;
/** −3 dB corner of the smoother on the LFO signal (Hz). */
export const AUTOPAN_SMOOTH_HZ = 120;
const PAN_CURVE_POINTS = 4097;

/** Equal-power pan law for p in −1..1: [gain of M into L, gain of M into R] (1, 1 at the centre). */
export function autopanGains(p: number): [number, number] {
  const x = Math.min(1, Math.max(-1, p));
  const theta = ((1 + x) * Math.PI) / 4;
  return [Math.SQRT2 * Math.cos(theta), Math.SQRT2 * Math.sin(theta)];
}

const panCurves: (Float32Array<ArrayBuffer> | null)[] = [null, null];

/** Pan law curve for one side (computed once; assigning a curve copies it). */
function panCurve(side: 0 | 1): Float32Array<ArrayBuffer> {
  return (panCurves[side] ??= buildPanCurve(side));
}

function buildPanCurve(side: 0 | 1): Float32Array<ArrayBuffer> {
  const c = new Float32Array(PAN_CURVE_POINTS);
  for (let i = 0; i < PAN_CURVE_POINTS; i++) {
    const u = (2 * i) / (PAN_CURVE_POINTS - 1) - 1;
    c[i] = autopanGains(u)[side];
  }
  // Exactly 1 in the centre (float rounding of √2·cos(π/4)).
  c[(PAN_CURVE_POINTS - 1) / 2] = 1;
  return c;
}

export class AutoPanModule extends EffectModule {
  readonly type = 'autopan' as const;
  private readonly lfo: LfoModule;
  private readonly ctl: ControlBus;
  private readonly selPan: GainNode;
  private readonly selTrem: GainNode;
  private shape: number;
  private division: number;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    const mode = readParam(AUTOPAN_PARAMS, params, 'mode');
    this.shape = readParam(AUTOPAN_PARAMS, params, 'shape');
    this.division = readParam(AUTOPAN_PARAMS, params, 'division');
    const mono = { channelCount: 1, channelCountMode: 'explicit' } as const;

    this.lfo = new LfoModule(env, `${id}:lfo`, { wave: SHAPE_WAVES[this.shape], division: this.division, depth: 1 });
    const smoothed = this.own(controlSmoother(ctx, AUTOPAN_SMOOTH_HZ));
    this.lfo.output('out')!.connect(smoothed);

    // Depth control: knob + modulation, clamped to 0..1.
    this.ctl = new ControlBus(ctx, readParam(AUTOPAN_PARAMS, params, 'depth'), 1, this.own);
    this.registerMod('depth', this.ctl.modInput);

    const sum = this.own(new GainNode(ctx));
    sum.connect(this.bypass.processed);
    this.selPan = this.own(new GainNode(ctx, { gain: mode === 0 ? 1 : 0 }));
    this.selTrem = this.own(new GainNode(ctx, { gain: mode === 1 ? 1 : 0 }));
    this.selPan.connect(sum);
    this.selTrem.connect(sum);

    // Pan path.
    const p = this.own(new GainNode(ctx, { gain: 0, ...mono }));
    smoothed.connect(p);
    this.ctl.map(makeControlCurve((d) => d), p.gain);
    const shapeL = this.own(shaperNode(ctx, panCurve(0), { oversample: 'none', ...mono }));
    const shapeR = this.own(shaperNode(ctx, panCurve(1), { oversample: 'none', ...mono }));
    p.connect(shapeL);
    p.connect(shapeR);
    const split = this.own(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
    const merge = this.own(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    this.bypass.input.connect(split);
    const mid = this.own(new GainNode(ctx, mono));
    const side = this.own(new GainNode(ctx, mono));
    const half = (from: number, to: GainNode, g: number) => {
      const n = this.own(new GainNode(ctx, { gain: g, ...mono }));
      split.connect(n, from);
      n.connect(to);
    };
    half(0, mid, 0.5);
    half(1, mid, 0.5);
    half(0, side, 0.5);
    half(1, side, -0.5);
    const mL = this.own(new GainNode(ctx, { gain: 0, ...mono }));
    const mR = this.own(new GainNode(ctx, { gain: 0, ...mono }));
    shapeL.connect(mL.gain);
    shapeR.connect(mR.gain);
    mid.connect(mL);
    mid.connect(mR);
    const outL = this.own(new GainNode(ctx, mono));
    const outR = this.own(new GainNode(ctx, mono));
    const sideNeg = this.own(new GainNode(ctx, { gain: -1, ...mono }));
    mL.connect(outL);
    side.connect(outL);
    mR.connect(outR);
    side.connect(sideNeg);
    sideNeg.connect(outR);
    outL.connect(merge, 0, 0);
    outR.connect(merge, 0, 1);
    merge.connect(this.selPan);

    // Tremolo path: gain = 1 + depth/2·(lfo − 1).
    const trem = this.own(new GainNode(ctx, { gain: 1 }));
    this.bypass.input.connect(trem);
    trem.connect(this.selTrem);
    const minusOne = this.own(new ConstantSourceNode(ctx, { offset: -1 }));
    const lfoMinusOne = this.own(new GainNode(ctx, mono));
    smoothed.connect(lfoMinusOne);
    minusOne.connect(lfoMinusOne);
    minusOne.start();
    const tremDepth = this.own(new GainNode(ctx, { gain: 0, ...mono }));
    lfoMinusOne.connect(tremDepth);
    this.ctl.map(makeControlCurve((d) => d / 2), tremDepth.gain);
    tremDepth.connect(trem.gain);
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    const mode = readParam(AUTOPAN_PARAMS, params, 'mode');
    const shape = readParam(AUTOPAN_PARAMS, params, 'shape');
    const division = readParam(AUTOPAN_PARAMS, params, 'division');
    this.smooth(this.ctl.base.offset, readParam(AUTOPAN_PARAMS, params, 'depth'), t);
    this.smooth(this.selPan.gain, mode === 0 ? 1 : 0, t, SWITCH_TAU);
    this.smooth(this.selTrem.gain, mode === 1 ? 1 : 0, t, SWITCH_TAU);
    if (shape !== this.shape || division !== this.division) {
      this.shape = shape;
      this.division = division;
      this.lfo.setParams({ wave: SHAPE_WAVES[shape], division, depth: 1 }, t);
    }
  }

  setTempo(bpm: number, time: number): void {
    if (!this.disposed) this.lfo.setTempo(bpm, time);
  }

  transportStarted(time: number, tick: number, bpm: number): void {
    if (!this.disposed) this.lfo.transportStarted(time, tick, bpm);
  }

  transportStopped(time: number): void {
    if (!this.disposed) this.lfo.transportStopped(time);
  }

  /** LFO phase (0..1) at a context time, for tests and displays. */
  phaseAt(time: number): number {
    return this.lfo.phaseAt(time);
  }

  dispose(): void {
    if (this.disposed) return;
    this.lfo.dispose();
    super.dispose();
  }
}
