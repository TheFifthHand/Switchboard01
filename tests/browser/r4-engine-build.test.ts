/**
 * Engine build cost (perf-05): building the House starter's graph creates no
 * IIRFilterNode (the control smoothers are critically damped biquads) and
 * assigns WaveShaper curves after construction (passing them as constructor
 * options is a slow element-by-element copy). Measured against the previous
 * build in the same test: the previous constructs are put back by wrapping
 * the node constructors (an IIRFilterNode built for every smoother, every
 * curve copied through the constructor option), with the same cold room
 * (impulse response) cache, on fresh contexts, interleaved.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { CRITICAL_Q_DB, clearImpulseCache, impulseCacheStats } from '../../src/audio/modules/fxutil';
import { HOUSE } from '../../src/content/starters/house';

type Win = Record<string, unknown>;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Put the previous build's node constructs back while `fn` runs; counts IIR filters made. */
async function withPreviousConstructs<T>(previous: boolean, fn: () => Promise<T>): Promise<{ result: T; iirs: number }> {
  const w = window as unknown as Win;
  const OrigIIR = window.IIRFilterNode;
  const OrigBiquad = window.BiquadFilterNode;
  const OrigShaper = window.WaveShaperNode;
  let iirs = 0;
  w.IIRFilterNode = class extends OrigIIR {
    constructor(c: BaseAudioContext, o: IIRFilterOptions) {
      super(c, o);
      iirs++;
    }
  };
  if (previous) {
    // The previous smoother: a one-pole IIRFilterNode where a critically damped biquad is now.
    w.BiquadFilterNode = class extends OrigBiquad {
      constructor(c: BaseAudioContext, o?: BiquadFilterOptions) {
        super(c, o);
        if (o?.Q === CRITICAL_Q_DB && o.type === 'lowpass') {
          const a = Math.exp((-2 * Math.PI * 50) / c.sampleRate);
          new (w.IIRFilterNode as typeof IIRFilterNode)(c, { feedforward: [1 - a], feedback: [1, -a] });
        }
      }
    };
    // The previous shapers: the curve copied through the constructor option.
    const desc = Object.getOwnPropertyDescriptor(OrigShaper.prototype, 'curve')!;
    class PrevShaper extends OrigShaper {}
    Object.defineProperty(PrevShaper.prototype, 'curve', {
      get(this: WaveShaperNode) {
        return desc.get!.call(this);
      },
      set(this: WaveShaperNode, v: Float32Array<ArrayBuffer> | null) {
        if (v) new OrigShaper(this.context, { curve: v });
        desc.set!.call(this, v);
      },
    });
    w.WaveShaperNode = PrevShaper;
  }
  try {
    return { result: await fn(), iirs };
  } finally {
    w.IIRFilterNode = OrigIIR;
    w.BiquadFilterNode = OrigBiquad;
    w.WaveShaperNode = OrigShaper;
  }
}

async function liveBuild(previous: boolean): Promise<{ ms: number; iirs: number }> {
  const project = HOUSE.build();
  const ctx = new AudioContext();
  try {
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: project.seed, meters: true });
    clearImpulseCache();
    const { result: ms, iirs } = await withPreviousConstructs(previous, async () => {
      const t = performance.now();
      engine.setProject(project);
      return performance.now() - t;
    });
    engine.dispose();
    return { ms, iirs };
  } finally {
    await ctx.close();
  }
}

async function exportBuild(previous: boolean): Promise<number> {
  const project = HOUSE.build();
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const engine = await AudioEngine.create(ctx, { samples: new SampleBank(48000), seed: project.seed, meters: false });
  clearImpulseCache();
  const { result } = await withPreviousConstructs(previous, async () => {
    const t = performance.now();
    engine.setProject(project);
    return performance.now() - t;
  });
  engine.dispose();
  return result;
}

describe('engine build (perf-05)', () => {
  it('House builds without an IIRFilterNode, at least 40 % faster than the previous build (Jump In and export)', async () => {
    // Warm-up (module code, curve tables), not measured.
    await liveBuild(false);
    const now: number[] = [];
    const prev: number[] = [];
    let iirs = 0;
    for (let k = 0; k < 4; k++) {
      const a = await liveBuild(false);
      iirs += a.iirs;
      now.push(a.ms);
      prev.push((await liveBuild(true)).ms);
    }
    const nowX: number[] = [];
    const prevX: number[] = [];
    for (let k = 0; k < 3; k++) {
      nowX.push(await exportBuild(false));
      prevX.push(await exportBuild(true));
    }
    console.info(
      `[build] House setProject, live: ${median(now).toFixed(1)} ms (previous constructs ${median(prev).toFixed(1)} ms); export: ${median(nowX).toFixed(1)} ms (previous ${median(prevX).toFixed(1)} ms)`,
    );
    expect(iirs).toBe(0);
    expect(median(now)).toBeLessThanOrEqual(0.6 * median(prev));
    expect(median(nowX)).toBeLessThanOrEqual(0.6 * median(prevX));
  }, 120_000);

  it('rebuilding the same project reuses its reverb room (no impulse response is generated again)', async () => {
    const project = HOUSE.build();
    const times: number[] = [];
    for (let k = 0; k < 2; k++) {
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const engine = await AudioEngine.create(ctx, { samples: new SampleBank(48000), seed: project.seed, meters: false });
      if (k === 0) clearImpulseCache();
      const before = impulseCacheStats().builds;
      const t = performance.now();
      engine.setProject(project);
      times.push(performance.now() - t);
      const built = impulseCacheStats().builds - before;
      expect(built).toBe(k === 0 ? 1 : 0);
      engine.dispose();
    }
    console.info(`[build] export build with a cold room cache ${times[0].toFixed(1)} ms, warm ${times[1].toFixed(1)} ms`);
  }, 60_000);
});
