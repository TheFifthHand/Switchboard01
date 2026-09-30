/**
 * Delay module: tempo-synced stereo ping-pong echo with bounded feedback.
 *
 *   in ─┬─ dryGate (1 − mix) ───────────────────────────────────────┐
 *       └─ comp ─ split ─ inject ─> sumL ─ lpL ─ lineL ─┬─ merge ─ wetGate ─┴─> out
 *                                  sumR ─ lpR ─ lineR ─┘
 *   lineL ─ fb·(1−w) ─> sumL      lineL ─ fb·w ─> sumR
 *   lineR ─ fb·(1−w) ─> sumR      lineR ─ fb·w ─> sumL
 *
 * Width w = 0 gives two parallel mono echoes; w = 1 feeds the input into the
 * left line only and fully crosses the feedback, so repeats alternate L/R.
 * For every w the self + cross feedback sums to `fb` (<= 0.85) and the
 * Butterworth tone filter never exceeds unity, so repeats always decay.
 *
 * Exact timing. Chromium adds one render quantum to every trip around a
 * feedback cycle, and the tone filter adds a little group delay. The line is
 * shortened by both and the input is pre-delayed by the cycle latency ("comp")
 * so the first echo and every repeat land exactly on multiples of the synced
 * time. The per-browser cycle latency is measured once with a tiny offline
 * render (`measureFeedbackCycleLatency`).
 */
import { BPM_SPEC, DELAY_DIVISION_BEATS, DELAY_PARAMS, clampParam, readParam } from '../../project/params';
import type { Id, ParamValues } from '../../project/types';
import { BUTTERWORTH_Q_DB, ControlBus, EffectModule, clamp01Curve } from './fxutil';
import type { ModuleEnv } from './types';

const MAX_DELAY = 4;
/** Time constant for delay-time glides on tempo / division changes. */
const TIME_TAU = 0.04;
/** How quickly the old echo lines fade when flushed. */
const FLUSH_TAU = 0.003;
const FLUSH_CLEANUP_MS = 60;

/* ------------------------------------------------------------------ */
/* Feedback-cycle latency                                              */
/* ------------------------------------------------------------------ */

/** Chromium (and WebKit) add one render quantum per trip around a cycle. */
const DEFAULT_CYCLE_EXTRA_FRAMES = 128;
let cycleExtraFrames = DEFAULT_CYCLE_EXTRA_FRAMES;
let cycleProbe: Promise<number> | null = null;
const liveDelays = new Set<DelayModule>();

/** Extra frames the current browser adds per trip around a feedback cycle (measured or default). */
export function feedbackCycleExtraFrames(): number {
  return cycleExtraFrames;
}

/**
 * Measure (once) how many frames this browser adds to a feedback cycle that
 * contains a DelayNode, and retime live delay modules if it differs from the
 * default. Engines may await this before rendering so exports are exact from
 * the first echo.
 */
export function measureFeedbackCycleLatency(): Promise<number> {
  if (cycleProbe) return cycleProbe;
  if (typeof OfflineAudioContext === 'undefined') {
    cycleProbe = Promise.resolve(cycleExtraFrames);
    return cycleProbe;
  }
  cycleProbe = (async () => {
    try {
      const sr = 8000;
      const line = 256;
      const ctx = new OfflineAudioContext(1, 2048, sr);
      const imp = ctx.createBuffer(1, 1, sr);
      imp.getChannelData(0)[0] = 1;
      const src = new AudioBufferSourceNode(ctx, { buffer: imp });
      const sum = new GainNode(ctx);
      const dl = new DelayNode(ctx, { maxDelayTime: 1, delayTime: line / sr });
      const fb = new GainNode(ctx, { gain: 0.5 });
      src.connect(sum);
      sum.connect(dl);
      dl.connect(fb);
      fb.connect(sum);
      dl.connect(ctx.destination);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      const peaks: number[] = [];
      for (let i = 0; i < out.length && peaks.length < 2; i++) {
        if (Math.abs(out[i]) > 0.2) {
          peaks.push(i);
          i += 16;
        }
      }
      if (peaks.length === 2) {
        const extra = peaks[1] - peaks[0] - line;
        if (extra >= 0 && extra <= 1024) cycleExtraFrames = extra;
      }
    } catch {
      /* keep the default */
    }
    for (const d of liveDelays) d.retime();
    return cycleExtraFrames;
  })();
  return cycleProbe;
}

/** Synced delay time in seconds. */
export function delaySeconds(division: number, bpm: number): number {
  const beats = DELAY_DIVISION_BEATS[Math.min(DELAY_DIVISION_BEATS.length - 1, Math.max(0, Math.round(division)))];
  return (beats * 60) / clampParam(BPM_SPEC, bpm);
}

/**
 * DC group delay (seconds) of Web Audio's Butterworth low-pass biquad at
 * `freq`: alpha / (1 − cos w0) samples for the RBJ coefficients with
 * Q = 1/sqrt(2). This is the mean delay each pass through the tone filter adds.
 */
export function toneGroupDelay(freq: number, sampleRate: number): number {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
  const alpha = Math.sin(w0) / Math.SQRT2;
  const s = Math.sin(w0 / 2);
  return alpha / (2 * s * s) / sampleRate;
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

interface Plan {
  comp: number;
  line: number;
  tone: number;
  injLL: number;
  injRL: number;
  injRR: number;
  fbSelf: number;
  fbCross: number;
}

/** The stateful part (lines, filters, feedback). Recreated on flush. */
interface Core {
  comp: DelayNode;
  out: GainNode;
  injLL: GainNode;
  injRL: GainNode;
  injRR: GainNode;
  lp: BiquadFilterNode[];
  lines: DelayNode[];
  /** [LL, RR] self and [LR, RL] cross feedback. */
  fbSelf: GainNode[];
  fbCross: GainNode[];
  nodes: AudioNode[];
}

export class DelayModule extends EffectModule {
  readonly type = 'delay' as const;
  private readonly ctl: ControlBus;
  private readonly dryGate: GainNode;
  private readonly wetGate: GainNode;
  private core: Core;
  private bpm: number;
  /** Last applied parameter values (registry-clamped on read). */
  private params: ParamValues;
  private plan: Plan;

  constructor(env: ModuleEnv, id: Id, params: ParamValues) {
    super(env, id);
    const ctx = this.ctx;
    this.bpm = clampParam(BPM_SPEC, env.getBpm());
    this.params = { ...params };
    const mix = readParam(DELAY_PARAMS, params, 'mix');
    this.plan = this.computePlan();

    const sum = this.own(new GainNode(ctx));
    sum.connect(this.bypass.processed);
    this.dryGate = this.own(new GainNode(ctx, { gain: 1 - mix }));
    this.bypass.input.connect(this.dryGate);
    this.dryGate.connect(sum);
    this.wetGate = this.own(new GainNode(ctx, { gain: 0 }));
    this.wetGate.connect(sum);

    // Wet level = clamp(mix + mod, 0, 1). The dry level follows the knob only,
    // so modulating a send-return delay never leaks dry signal.
    this.ctl = new ControlBus(ctx, mix, 1, this.own);
    this.registerMod('mix', this.ctl.modInput);
    this.ctl.map(clamp01Curve(), this.wetGate.gain);

    this.core = this.buildCore();
    liveDelays.add(this);
    void measureFeedbackCycleLatency();
  }

  private computePlan(): Plan {
    const p = this.params;
    const fb = readParam(DELAY_PARAMS, p, 'feedback');
    const w = readParam(DELAY_PARAMS, p, 'width');
    const tone = readParam(DELAY_PARAMS, p, 'tone');
    const sr = this.ctx.sampleRate;
    const comp = cycleExtraFrames / sr;
    const groupDelay = toneGroupDelay(tone, sr);
    const T = delaySeconds(readParam(DELAY_PARAMS, p, 'division'), this.bpm);
    const line = Math.min(MAX_DELAY, Math.max(128 / sr, T - comp - groupDelay));
    return {
      comp,
      line,
      tone,
      injLL: 1 - 0.5 * w,
      injRL: 0.5 * w,
      injRR: 1 - w,
      fbSelf: fb * (1 - w),
      fbCross: fb * w,
    };
  }

  private buildCore(): Core {
    const ctx = this.ctx;
    const t = this.plan;
    const nodes: AudioNode[] = [];
    const mk = <T extends AudioNode>(n: T): T => {
      nodes.push(this.own(n));
      return n;
    };
    const comp = mk(new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: t.comp }));
    const split = mk(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
    const merge = mk(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    const out = mk(new GainNode(ctx));
    const injLL = mk(new GainNode(ctx, { gain: t.injLL }));
    const injRL = mk(new GainNode(ctx, { gain: t.injRL }));
    const injRR = mk(new GainNode(ctx, { gain: t.injRR }));
    const sums = [mk(new GainNode(ctx)), mk(new GainNode(ctx))];
    const lp = [0, 1].map(() => mk(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: t.tone, Q: BUTTERWORTH_Q_DB })));
    const lines = [0, 1].map(() => mk(new DelayNode(ctx, { maxDelayTime: MAX_DELAY, delayTime: t.line })));
    const fbSelf = [0, 1].map(() => mk(new GainNode(ctx, { gain: t.fbSelf })));
    const fbCross = [0, 1].map(() => mk(new GainNode(ctx, { gain: t.fbCross })));

    this.bypass.input.connect(comp);
    comp.connect(split);
    split.connect(injLL, 0);
    split.connect(injRL, 1);
    split.connect(injRR, 1);
    injLL.connect(sums[0]);
    injRL.connect(sums[0]);
    injRR.connect(sums[1]);
    for (let c = 0; c < 2; c++) {
      sums[c].connect(lp[c]);
      lp[c].connect(lines[c]);
      lines[c].connect(merge, 0, c);
      lines[c].connect(fbSelf[c]);
      fbSelf[c].connect(sums[c]);
      lines[c].connect(fbCross[c]);
      fbCross[c].connect(sums[1 - c]);
    }
    merge.connect(out);
    out.connect(this.wetGate);
    return { comp, out, injLL, injRL, injRR, lp, lines, fbSelf, fbCross, nodes };
  }

  private applyPlan(time: number, timeTau: number): void {
    const c = this.core;
    const t = this.plan;
    this.smooth(c.comp.delayTime, t.comp, time, timeTau);
    this.smooth(c.injLL.gain, t.injLL, time);
    this.smooth(c.injRL.gain, t.injRL, time);
    this.smooth(c.injRR.gain, t.injRR, time);
    for (let i = 0; i < 2; i++) {
      this.smooth(c.lines[i].delayTime, t.line, time, timeTau);
      this.smooth(c.lp[i].frequency, t.tone, time);
      this.smooth(c.fbSelf[i].gain, t.fbSelf, time);
      this.smooth(c.fbCross[i].gain, t.fbCross, time);
    }
  }

  setParams(params: ParamValues, time: number): void {
    if (this.disposed) return;
    const t = this.at(time);
    this.params = { ...params };
    const mix = readParam(DELAY_PARAMS, params, 'mix');
    this.smooth(this.dryGate.gain, 1 - mix, t);
    this.smooth(this.ctl.base.offset, mix, t);
    this.plan = this.computePlan();
    this.applyPlan(t, TIME_TAU);
  }

  setTempo(bpm: number, time: number): void {
    if (this.disposed) return;
    this.bpm = clampParam(BPM_SPEC, bpm);
    this.retimeAt(this.at(time));
  }

  /** Re-derive line times (tempo or measured cycle latency changed). */
  retime(): void {
    if (!this.disposed) this.retimeAt(this.ctx.currentTime);
  }

  private retimeAt(time: number): void {
    this.plan = this.computePlan();
    this.applyPlan(time, TIME_TAU);
  }

  /** Clear every echo now: the old lines fade out within a few ms and fresh, empty lines take over. */
  flush(): void {
    if (this.disposed) return;
    const old = this.core;
    this.bypass.input.disconnect(old.comp);
    const now = this.ctx.currentTime;
    for (const g of [...old.fbSelf, ...old.fbCross]) {
      g.gain.cancelScheduledValues(0);
      g.gain.value = 0;
    }
    this.forgetParams(this.coreParams(old));
    this.core = this.buildCore();
    if (this.env.offline) {
      this.release(old.nodes);
      return;
    }
    old.out.gain.setTargetAtTime(0, now, FLUSH_TAU);
    this.startTimer(() => this.release(old.nodes), FLUSH_CLEANUP_MS);
  }

  private coreParams(c: Core): AudioParam[] {
    const ps: AudioParam[] = [c.comp.delayTime, c.injLL.gain, c.injRL.gain, c.injRR.gain];
    for (let i = 0; i < 2; i++) ps.push(c.lines[i].delayTime, c.lp[i].frequency, c.fbSelf[i].gain, c.fbCross[i].gain);
    return ps;
  }

  dispose(): void {
    liveDelays.delete(this);
    super.dispose();
  }
}
