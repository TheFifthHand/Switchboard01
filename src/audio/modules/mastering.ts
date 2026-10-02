/**
 * Mastering chain on the master bus (Project.mastering, MASTERING_PARAMS).
 * Owned by the engine, between the master volume and Mute All:
 *
 *   in ─┬─ direct (Off) ───────────────────────────────────────────────────────────────┐
 *       └─ low cut ─ Lows ─ Mids ─ Highs ─ Air ─ [Glue ─ Warmth ─ Width/Mono Bass] ─ Loudness ─ processed (On) ┴─> out
 *
 * - Low Cut: 24 dB/oct Butterworth high-pass (two biquads), crossfaded in
 *   above 10 Hz (10 Hz = off: the stage is a straight wire).
 * - EQ: low shelf (Lows, Lows Pitch), wide peaking band (Mids, Q 0.7),
 *   high shelf (Highs, Highs Pitch) and a 14 kHz "Air" shelf. At 0 dB each
 *   band's coefficients reduce to a pass-through.
 * - Glue, Warmth, Width and Mono Bass run in the 'sb-mastering' worklet
 *   (src/audio/worklets/mastering.ts); at neutral settings it outputs its
 *   input bit for bit.
 * - Loudness: gain into the protected output limiter (ceiling −1 dBFS).
 * - On/Off crossfades the whole chain against the direct path (20 ms).
 *
 * No stage adds latency, so the chain never shifts the timing and a project
 * with neutral (or switched-off) mastering renders as it did before the
 * chain existed. Every continuous parameter is smoothed.
 */
import { MASTERING_PARAMS, dbToGain, neutralMasteringParams, readParam } from '../../project/params';
import type { Mastering, ParamValues } from '../../project/types';
import { MASTERING_PROCESSOR_NAME } from '../worklets/mastering';
import { BYPASS_TAU, WorkletFlush, linearQToDb, stereoWorklet, workletParam } from './fxutil';
import { PARAM_SMOOTHING } from './types';

/** Low Cut at or below this is off. */
export const MASTER_LOW_CUT_OFF = 10;
/** Corner of the Air shelf. */
export const MASTER_AIR_HZ = 14000;
/** Glide of the A/B level match (seconds). */
export const COMPARE_TRIM_TAU = 0.03;
/** When a comparison ends, the trim returns to unity this long after (the un-mastered path has faded out by then). */
export const COMPARE_RELEASE_HOLD = 10 * BYPASS_TAU;
/** Q of the wide Mids band. */
export const MASTER_MID_Q = 0.7;
/** 4th-order Butterworth as two biquads (linear Q). */
const BUTTERWORTH4_Q = [0.5411961001461969, 1.3065629648763766];

const WORKLET_PARAMS = ['glue', 'punch', 'saturation', 'width', 'monoBass'] as const;
/** Project param id -> worklet AudioParam name. */
const WORKLET_NAME: Record<(typeof WORKLET_PARAMS)[number], string> = {
  glue: 'glue',
  punch: 'punch',
  saturation: 'warmth',
  width: 'width',
  monoBass: 'monoBass',
};

export interface MasteringChainOptions {
  /** Gain-reduction reports from the worklet (live contexts). */
  onGlueReduction?: (db: number) => void;
}

export class MasteringChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly direct: GainNode;
  /** Level match of the un-mastered sound during an A/B comparison (unity otherwise). */
  private readonly compareTrim: GainNode;
  private trimGain = 1;
  private readonly processed: GainNode;
  private readonly lcDry: GainNode;
  private readonly lcWet: GainNode;
  private readonly hp: BiquadFilterNode[];
  private readonly lowShelf: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;
  private readonly highShelf: BiquadFilterNode;
  private readonly air: BiquadFilterNode;
  private readonly worklet: AudioWorkletNode;
  private readonly wparams = new Map<string, AudioParam>();
  private readonly flusher: WorkletFlush;
  private readonly loud: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly targets = new Map<AudioParam, number>();
  private enabled = true;
  /** A/B comparison in progress (listening only). */
  private listenBypass = false;
  private current: Mastering | null = null;
  private disposed = false;

  constructor(ctx: BaseAudioContext, opts: MasteringChainOptions = {}) {
    this.ctx = ctx;
    const own = <T extends AudioNode>(n: T): T => {
      this.nodes.push(n);
      return n;
    };
    const p = neutralMasteringParams();
    const nyq = ctx.sampleRate / 2;
    this.input = own(new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' }));
    this.output = own(new GainNode(ctx));
    this.direct = own(new GainNode(ctx, { gain: 0 }));
    this.compareTrim = own(new GainNode(ctx, { gain: 1 }));
    this.processed = own(new GainNode(ctx, { gain: 1 }));
    this.input.connect(this.direct);
    this.direct.connect(this.compareTrim);
    this.compareTrim.connect(this.output);
    this.processed.connect(this.output);

    // Low cut (crossfaded).
    this.lcDry = own(new GainNode(ctx, { gain: 1 }));
    this.lcWet = own(new GainNode(ctx, { gain: 0 }));
    this.hp = BUTTERWORTH4_Q.map((q) => own(new BiquadFilterNode(ctx, { type: 'highpass', frequency: MASTER_LOW_CUT_OFF, Q: linearQToDb(q) })));
    const lcOut = own(new GainNode(ctx));
    this.input.connect(this.lcDry);
    this.input.connect(this.hp[0]);
    this.hp[0].connect(this.hp[1]);
    this.hp[1].connect(this.lcWet);
    this.lcDry.connect(lcOut);
    this.lcWet.connect(lcOut);

    // EQ.
    this.lowShelf = own(new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: p.lowFreq, gain: 0 }));
    this.mid = own(new BiquadFilterNode(ctx, { type: 'peaking', frequency: p.midFreq, Q: MASTER_MID_Q, gain: 0 }));
    this.highShelf = own(new BiquadFilterNode(ctx, { type: 'highshelf', frequency: Math.min(p.highFreq, nyq * 0.9), gain: 0 }));
    this.air = own(new BiquadFilterNode(ctx, { type: 'highshelf', frequency: Math.min(MASTER_AIR_HZ, nyq * 0.9), gain: 0 }));
    lcOut.connect(this.lowShelf);
    this.lowShelf.connect(this.mid);
    this.mid.connect(this.highShelf);
    this.highShelf.connect(this.air);

    // Glue, Warmth, Width / Mono Bass.
    this.worklet = own(
      stereoWorklet(ctx, MASTERING_PROCESSOR_NAME, 'Mastering', {
        parameterData: { glue: 0, punch: p.punch, warmth: 0, width: 1, monoBass: p.monoBass },
        processorOptions: { report: !!opts.onGlueReduction },
      }),
    );
    for (const k of WORKLET_PARAMS) this.wparams.set(k, workletParam(this.worklet, WORKLET_NAME[k], 'Mastering'));
    this.flusher = new WorkletFlush(workletParam(this.worklet, 'flush', 'Mastering'));
    if (opts.onGlueReduction) {
      const report = opts.onGlueReduction;
      this.worklet.port.onmessage = (e: MessageEvent) => {
        const db = typeof e.data === 'number' && Number.isFinite(e.data) ? Math.max(0, e.data) : 0;
        report(db);
      };
    }
    this.air.connect(this.worklet);

    // Loudness.
    this.loud = own(new GainNode(ctx, { gain: 1 }));
    this.worklet.connect(this.loud);
    this.loud.connect(this.processed);
  }

  /** True when the chain is processing: switched on and not bypassed for an A/B comparison. */
  get isEnabled(): boolean {
    return this.enabled && !this.listenBypass;
  }

  /** True when the project has mastering on (whether or not an A/B comparison bypasses it right now). */
  get isOn(): boolean {
    return this.enabled;
  }

  /**
   * A/B listening: hear the mix without mastering without changing the
   * project (exports, which build their own engine, always keep it).
   * `trimGain` (linear) is applied to the un-mastered sound while the
   * comparison is on, so both sides can be heard at the same loudness. When
   * the comparison starts the trim is in place at once (the un-mastered path
   * is fading in from silence, so nothing jumps); when it ends the trim stays
   * until that path has faded out, then returns to unity; a new trim while
   * comparing glides (COMPARE_TRIM_TAU).
   */
  setListenBypass(on: boolean, time: number, trimGain = 1): void {
    if (this.disposed) return;
    const t = Number.isFinite(time) ? Math.max(time, this.ctx.currentTime) : this.ctx.currentTime;
    const trim = on && this.enabled && Number.isFinite(trimGain) && trimGain > 0 ? trimGain : 1;
    const g = this.compareTrim.gain;
    // The direct path is silent before a comparison starts (mastering on) and after this fade.
    const directSilent = !this.listenBypass && this.enabled;
    if (on !== this.listenBypass && !on && this.enabled) {
      // Ending: keep the trim on the fading un-mastered sound, unity once it is gone.
      if (this.trimGain !== 1) {
        this.trimGain = 1;
        g.cancelScheduledValues(t);
        g.setValueAtTime(1, t + COMPARE_RELEASE_HOLD);
      }
    } else if (trim !== this.trimGain) {
      this.trimGain = trim;
      g.cancelScheduledValues(t);
      if (on && directSilent) g.setValueAtTime(trim, t);
      else g.setTargetAtTime(trim, t, COMPARE_TRIM_TAU);
    }
    if (on === this.listenBypass) return;
    this.listenBypass = on;
    this.route(t, false);
  }

  /** Crossfade between the processed and the direct path. */
  private route(t: number, immediate: boolean): void {
    const on = this.enabled && !this.listenBypass;
    const pairs: [AudioParam, number][] = [
      [this.processed.gain, on ? 1 : 0],
      [this.direct.gain, on ? 0 : 1],
    ];
    for (const [param, value] of pairs) {
      if (immediate) {
        param.cancelScheduledValues(0);
        param.value = value;
        this.targets.set(param, value);
        continue;
      }
      if (this.targets.get(param) === value) continue;
      this.targets.set(param, value);
      param.setTargetAtTime(value, t, BYPASS_TAU);
    }
  }

  /**
   * Apply Project.mastering. `immediate` sets values without smoothing
   * (the first build, before anything sounds). Missing data is neutral and on.
   */
  set(mastering: Mastering | undefined, time: number, immediate = false): void {
    if (this.disposed) return;
    const m: Mastering = mastering ?? { enabled: true, params: neutralMasteringParams() };
    if (m === this.current) return;
    this.current = m;
    const now = this.ctx.currentTime;
    const t = Number.isFinite(time) ? Math.max(time, now) : now;
    const v = (k: string) => readParam(MASTERING_PARAMS, m.params, k);
    const nyq = this.ctx.sampleRate / 2;
    const set = (param: AudioParam, value: number, tau = PARAM_SMOOTHING) => {
      if (!Number.isFinite(value)) return;
      if (immediate) {
        param.cancelScheduledValues(0);
        param.value = value;
        this.targets.set(param, value);
        return;
      }
      if (this.targets.get(param) === value) return;
      this.targets.set(param, value);
      param.setTargetAtTime(value, t, tau);
    };

    const lowCut = v('lowCut');
    const lcOn = lowCut > MASTER_LOW_CUT_OFF;
    if (lcOn) for (const f of this.hp) set(f.frequency, lowCut);
    set(this.lcWet.gain, lcOn ? 1 : 0, BYPASS_TAU);
    set(this.lcDry.gain, lcOn ? 0 : 1, BYPASS_TAU);
    set(this.lowShelf.frequency, v('lowFreq'));
    set(this.lowShelf.gain, v('lowGain'));
    set(this.mid.frequency, v('midFreq'));
    set(this.mid.gain, v('midGain'));
    set(this.highShelf.frequency, Math.min(v('highFreq'), nyq * 0.9));
    set(this.highShelf.gain, v('highGain'));
    set(this.air.gain, v('air'));
    for (const k of WORKLET_PARAMS) set(this.wparams.get(k)!, v(k));
    set(this.loud.gain, dbToGain(v('loudness')));

    this.enabled = m.enabled !== false;
    this.route(t, immediate);
  }

  /** The values in force (for tests and the meters). */
  params(): ParamValues {
    return { ...(this.current?.params ?? neutralMasteringParams()) };
  }

  /** Mute All: drop the Glue's gain reduction and the filters' memory in the worklet. */
  flush(): void {
    if (!this.disposed) this.flusher.fire(this.ctx.currentTime);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worklet.port.onmessage = null;
    this.worklet.port.postMessage('dispose');
    for (const n of this.nodes) n.disconnect();
    this.targets.clear();
  }
}
