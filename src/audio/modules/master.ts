/**
 * Master module: the protected summing point of the patch ('in').
 *
 * The engine owns everything after the sum (volume, Mute All, limiter,
 * safety clipper) and connects `output('out')` into it directly — 'out' is
 * not a patch port, so cables can never be taken from the master.
 *
 * The metronome click is also generated here, into the master sum, so it is
 * heard through the same volume and limiter as the music.
 */
import type { Id, ParamValues } from '../../project/types';
import type { ModuleEnv, ModuleNode } from './types';

/** Metronome click: short sine blip. */
export const CLICK_FREQ_ACCENT = 1600;
export const CLICK_FREQ = 1000;
export const CLICK_LENGTH = 0.03;
const CLICK_LEVEL_ACCENT = 0.42;
const CLICK_LEVEL = 0.28;
const CLICK_ATTACK = 0.0015;

export interface ClickVoice {
  osc: OscillatorNode;
  gain: GainNode;
  /** Context time the click starts. */
  start: number;
}

/**
 * Schedule one click into `dest`. Nodes free themselves when the oscillator
 * ends; `onDone` lets the owner forget the voice.
 */
export function scheduleClickVoice(ctx: BaseAudioContext, dest: AudioNode, time: number, accent: boolean, onDone?: (v: ClickVoice) => void): ClickVoice | null {
  if (!Number.isFinite(time)) return null;
  const t = Math.max(time, ctx.currentTime);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = accent ? CLICK_FREQ_ACCENT : CLICK_FREQ;
  const gain = ctx.createGain();
  const peak = accent ? CLICK_LEVEL_ACCENT : CLICK_LEVEL;
  const g = gain.gain;
  g.value = 0;
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + CLICK_ATTACK);
  // Exponential decay to -60 dB, then a final short linear step to true zero.
  g.exponentialRampToValueAtTime(peak * 0.001, t + CLICK_LENGTH);
  g.linearRampToValueAtTime(0, t + CLICK_LENGTH + 0.002);
  osc.connect(gain);
  gain.connect(dest);
  const voice: ClickVoice = { osc, gain, start: t };
  osc.onended = () => {
    osc.onended = null;
    osc.disconnect();
    gain.disconnect();
    onDone?.(voice);
  };
  osc.start(t);
  osc.stop(t + CLICK_LENGTH + 0.004);
  return voice;
}

/** Stop and free a click immediately (it never sounds if it has not started). */
export function stopClickVoice(v: ClickVoice): void {
  v.osc.onended = null;
  try {
    v.osc.stop();
  } catch {
    // Not started yet or already stopped.
  }
  v.osc.disconnect();
  v.gain.disconnect();
}

export class MasterModule implements ModuleNode {
  readonly type = 'master' as const;
  private readonly ctx: BaseAudioContext;
  private readonly sum: GainNode;
  private readonly clicks = new Set<ClickVoice>();
  private disposed = false;

  constructor(
    env: ModuleEnv,
    readonly id: Id,
    _params: ParamValues,
  ) {
    this.ctx = env.ctx;
    this.sum = env.ctx.createGain();
    this.sum.gain.value = 1;
  }

  input(port: string): AudioNode | undefined {
    return port === 'in' ? this.sum : undefined;
  }

  output(port: string): AudioNode | undefined {
    return port === 'out' ? this.sum : undefined;
  }

  setParams(_params: ParamValues, _time: number): void {
    // The master module has no patch parameters; master volume is project-level.
  }

  setBypass(_bypass: boolean, _time: number): void {
    // The master output cannot be bypassed.
  }

  /** Metronome click at `time` (accent = first beat of the bar). */
  click(time: number, accent: boolean): void {
    if (this.disposed) return;
    const v = scheduleClickVoice(this.ctx, this.sum, time, accent, (done) => this.clicks.delete(done));
    if (v) this.clicks.add(v);
  }

  /** Number of clicks still scheduled or sounding. */
  activeClicks(): number {
    return this.clicks.size;
  }

  /** Drop clicks that start at/after `time` (the sequencer re-schedules them). */
  cancelAfter(time: number): void {
    const t = Number.isFinite(time) ? time : this.ctx.currentTime;
    for (const v of [...this.clicks]) {
      if (v.start >= t) {
        stopClickVoice(v);
        this.clicks.delete(v);
      }
    }
  }

  flush(): void {
    for (const v of this.clicks) stopClickVoice(v);
    this.clicks.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flush();
    this.sum.disconnect();
  }
}
