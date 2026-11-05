/**
 * Live-context code paths (env.offline = false): the reverb's debounced IR
 * regeneration, the delay's fade-and-release flush, timer bookkeeping and
 * complete disposal. Renders use an OfflineAudioContext suspended at a known
 * time while real timers run.
 */
import { describe, expect, it } from 'vitest';
import { ChorusModule } from '../../src/audio/modules/chorus';
import { DelayModule } from '../../src/audio/modules/delay';
import { DriveModule } from '../../src/audio/modules/drive';
import { FilterModule } from '../../src/audio/modules/filter';
import { clearImpulseCache, impulseCacheStats } from '../../src/audio/modules/fxutil';
import { PhaserModule } from '../../src/audio/modules/phaser';
import { ReverbModule } from '../../src/audio/modules/reverb';
import type { ModuleEnv, ModuleNode } from '../../src/audio/modules/types';
import { SR, diffDb, frames, impulses, makeEnv, noise, peak, render } from './fx-helpers';

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function liveEnv(ctx: BaseAudioContext, seed = 99) {
  const pending = new Set<number>();
  const env: ModuleEnv = {
    ...makeEnv(ctx, { seed, offline: false }),
    setTimer: (fn, ms) => {
      const id = window.setTimeout(() => {
        pending.delete(id);
        fn();
      }, ms);
      pending.add(id);
      return id;
    },
    clearTimer: (id) => {
      pending.delete(id);
      window.clearTimeout(id);
    },
  };
  return { env, pending };
}

function play(ctx: OfflineAudioContext, m: ModuleNode, x: Float32Array): void {
  const buf = new AudioBuffer({ numberOfChannels: 2, length: ctx.length, sampleRate: SR });
  buf.copyToChannel(x.slice(0, ctx.length), 0);
  buf.copyToChannel(x.slice(0, ctx.length), 1);
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  src.connect(m.input('in') as AudioNode);
  (m.output('out') as AudioNode).connect(ctx.destination);
  src.start(0);
}

describe('live contexts', () => {
  it('reverb regenerates the IR once, 120 ms after the last Size change', async () => {
    const seconds = 3;
    const ctx = new OfflineAudioContext(2, frames(seconds), SR);
    const { env, pending } = liveEnv(ctx);
    // Rooms are built once per (size, seed, rate) for the whole page: count builds from an empty cache.
    clearImpulseCache();
    const builds0 = impulseCacheStats().builds;
    const irsBuilt = () => impulseCacheStats().builds - builds0;
    const m = new ReverbModule(env, 'r', { decay: 0.5, predelay: 0, mix: 1 });
    const x = noise(seconds, 0.5, 5, 0.6, 0.65);
    play(ctx, m, x);
    const seen: number[] = [];
    void ctx.suspend(0.3).then(async () => {
      // A knob drag: several changes inside the debounce window coalesce.
      m.setParams({ decay: 2, predelay: 0, mix: 1 }, ctx.currentTime);
      m.setParams({ decay: 3.5, predelay: 0, mix: 1 }, ctx.currentTime);
      m.setParams({ decay: 5, predelay: 0, mix: 1 }, ctx.currentTime);
      seen.push(irsBuilt(), pending.size);
      await sleep(400);
      seen.push(irsBuilt());
      void ctx.resume();
    });
    const out = await ctx.startRendering();
    // One IR at construction; none during the burst of changes; one after.
    expect(seen).toEqual([1, 1, 2]);
    // The burst (after the switch) sounds exactly like a 5 s room from the start.
    const ref = await render({
      seconds,
      input: x,
      env: { seed: 99 },
      create: (e) => new ReverbModule(e, 'r', { decay: 5, predelay: 0, mix: 1 }),
    });
    expect(diffDb(out.getChannelData(0), ref.L, frames(0.6), frames(seconds))).toBeLessThan(-80);
    m.dispose();
    expect(pending.size).toBe(0);
  });

  it('delay flush fades the old lines out, releases them, and keeps echoing new input', async () => {
    const ctx = new OfflineAudioContext(2, frames(2), SR);
    const { env, pending } = liveEnv(ctx);
    const m = new DelayModule(env, 'dl', { division: 1, feedback: 0.85, tone: 12000, width: 0, mix: 1 });
    play(ctx, m, impulses(2, [0.1, 1.2]));
    const seen: number[] = [];
    void ctx.suspend(0.5).then(async () => {
      m.flush?.();
      seen.push(pending.size);
      await sleep(150);
      seen.push(pending.size);
      void ctx.resume();
    });
    const L = (await ctx.startRendering()).getChannelData(0);
    expect(seen).toEqual([1, 0]);
    expect(peak(L, frames(0.52), frames(1.2)).value).toBeLessThan(1e-6);
    const again = peak(L, frames(1.43), frames(1.47));
    expect(Math.abs(again.index - frames(1.45))).toBeLessThanOrEqual(frames(0.001));
    m.dispose();
  });

  it('dispose cancels pending work: a debounced Size change never runs', async () => {
    const ctx = new OfflineAudioContext(2, 128, SR);
    const { env, pending } = liveEnv(ctx);
    const m = new ReverbModule(env, 'r', { decay: 1 });
    m.setParams({ decay: 4 }, 0);
    expect(pending.size).toBe(1);
    m.dispose();
    expect(pending.size).toBe(0);
    await sleep(200);
    expect(pending.size).toBe(0);
  });

  it('disposed modules are silent and stop their oscillators', async () => {
    const makers: ((env: ModuleEnv) => ModuleNode)[] = [
      (env) => new FilterModule(env, 'f', {}),
      (env) => new DriveModule(env, 'd', { amount: 0.5 }),
      (env) => new DelayModule(env, 'dl', {}),
      (env) => new ReverbModule(env, 'r', {}),
      (env) => new ChorusModule(env, 'c', { mix: 1 }),
      (env) => new PhaserModule(env, 'p', { mix: 1 }),
    ];
    for (const make of makers) {
      const ctx = new OfflineAudioContext(2, frames(0.5), SR);
      const m = make(makeEnv(ctx));
      play(ctx, m, noise(0.5, 0.5));
      m.dispose();
      m.dispose(); // idempotent
      m.setParams({}, 0); // ignored after dispose
      const out = await ctx.startRendering();
      expect(peak(out.getChannelData(0)).value, m.type).toBe(0);
    }
  });
});
