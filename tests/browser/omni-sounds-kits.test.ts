/**
 * The drum kits through the real DrumKitEngine in Chromium: every kit plays
 * a typical beat at a matched loudness when it sits at its catalogue Level
 * (so switching kits never jumps the part's volume), the new kits' choke
 * groups cut what they should and nothing else, every hit is freed after it
 * ends, and a kit renders identically twice.
 */
import { describe, expect, it } from 'vitest';
import type { InstrumentContext } from '../../src/audio/contracts';
import { DrumKitEngine } from '../../src/audio/instruments/drumKit';
import { getKitRecipe } from '../../src/audio/instruments/kits';
import { KITS, type KitInfo } from '../../src/content/catalog';
import { createInstrument } from '../../src/project/factory';
import type { DrumsInstrument } from '../../src/project/types';

const SR = 48000;
const BEAT = 0.5;
const STEP = BEAT / 4;

function kitInstrument(info: KitInfo): DrumsInstrument {
  const base = createInstrument('drums', info.id) as DrumsInstrument;
  return { ...base, params: { ...base.params, level: info.level } };
}

/** Two bars of a typical part: [slot, step, velocity]. */
function pattern(info: KitInfo): [number, number, number][] {
  const hits: [number, number, number][] = [];
  for (let bar = 0; bar < 2; bar++) {
    const o = bar * 16;
    if (info.family === 'kit') {
      for (const s of [0, 6, 8]) hits.push([0, o + s, 0.95]);
      for (const s of [4, 12]) hits.push([2, o + s, 0.9]);
      for (let s = 0; s < 16; s += 2) if (s !== 14) hits.push([4, o + s, s % 4 ? 0.6 : 0.8]);
      hits.push([5, o + 14, 0.75]);
    } else {
      // A percussion groove over the low, middle and high drums, shakers and a bell.
      for (const [slot, s] of [[0, 0], [1, 3], [1, 6], [2, 10], [3, 12], [8, 8], [9, 14], [10, 15], [11, 4], [7, 11]] as const) hits.push([slot, o + s, 0.85]);
      for (let s = 0; s < 16; s++) hits.push([4, o + s, s % 2 ? 0.55 : 0.75]);
    }
  }
  return hits;
}

/** Integrated loudness (R128-style gating) of a stereo render, K-weighted in the graph. */
function gatedLoudness(l: Float32Array, r: Float32Array): number {
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const powers: number[] = [];
  for (let s = 0; s + block <= l.length; s += hop) {
    let z = 0;
    for (let i = s; i < s + block; i++) z += l[i] * l[i] + r[i] * r[i];
    powers.push(z / block);
  }
  const lufs = (z: number) => -0.691 + 10 * Math.log10(z + 1e-20);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const abs = powers.filter((z) => lufs(z) > -70);
  const gate = lufs(avg(abs)) - 10;
  return lufs(avg(abs.filter((z) => lufs(z) > gate)));
}

async function renderBeat(info: KitInfo): Promise<{ loudness: number; L: Float32Array; hitsLeft: number }> {
  const seconds = 2 * 4 * BEAT + 3;
  const ctx = new OfflineAudioContext(4, Math.round(seconds * SR), SR);
  const ictx: InstrumentContext = { ctx, samples: { get: () => null }, noise: ctx.createBuffer(1, SR, SR), getBpm: () => 120 };
  const kit = new DrumKitEngine(ictx, kitInstrument(info));
  const raw = ctx.createChannelSplitter(2);
  const weighted = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(4);
  const shelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 1681.97, gain: 4 });
  const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 38.13, Q: 0.5 });
  const stereo = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit' });
  kit.output.connect(stereo);
  stereo.connect(raw);
  stereo.connect(shelf).connect(hp).connect(weighted);
  raw.connect(merger, 0, 0);
  raw.connect(merger, 1, 1);
  weighted.connect(merger, 0, 2);
  weighted.connect(merger, 1, 3);
  merger.connect(ctx.destination);
  for (const [slot, step, velocity] of pattern(info)) kit.trigger({ pitch: slot, velocity, time: 0.05 + step * STEP });
  const buf = await ctx.startRendering();
  await new Promise((r) => setTimeout(r, 20));
  const hitsLeft = kit.activeVoices();
  kit.dispose();
  const frames = Math.round(2 * 4 * BEAT * SR);
  return { loudness: gatedLoudness(buf.getChannelData(2).subarray(0, frames), buf.getChannelData(3).subarray(0, frames)), L: buf.getChannelData(0).slice(), hitsLeft };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** The kits the starters shipped with set the reference loudness of each family. */
const REFERENCE: Record<KitInfo['family'], readonly string[]> = {
  kit: ['round-machine', 'tight-circuit', 'dust-tape', 'bright-steel'],
  percussion: ['hand-percussion'],
};
/** A new kit at its matched Level plays its beat within this many LU of its family's reference... */
const MATCH_LU = 1;
/** ...and the shipped kits (whose Levels the starters and saved projects rely on) stay within this. */
const SHIPPED_LU = 3;

describe('drum kits through the real engine', () => {
  it(`every kit at its matched Level plays a beat within ±${MATCH_LU} LU of its family (shipped kits ±${SHIPPED_LU}), and frees every hit`, async () => {
    const results = new Map<string, number>();
    for (const info of KITS) {
      const r = await renderBeat(info);
      expect(r.L.every(Number.isFinite), info.id).toBe(true);
      expect(r.hitsLeft, `${info.id} left hits allocated`).toBe(0);
      results.set(info.id, r.loudness);
    }
    const problems: string[] = [];
    for (const family of ['kit', 'percussion'] as const) {
      const ref = median(REFERENCE[family].map((id) => results.get(id)!));
      const report = KITS.filter((k) => k.family === family).map((k) => {
        const off = results.get(k.id)! - ref;
        const allowed = Object.values(REFERENCE).flat().includes(k.id) ? SHIPPED_LU : MATCH_LU;
        if (Math.abs(off) > allowed) problems.push(`${k.name} plays ${off.toFixed(1)} LU from the ${family} reference: set its level to ${(k.level - off).toFixed(1)} dB`);
        return `${k.name} ${off >= 0 ? '+' : ''}${off.toFixed(1)}`;
      });
      console.info(`[kits] ${family} reference ${ref.toFixed(1)} LUFS: ${report.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('renders the same beat identically twice', async () => {
    for (const id of ['boom-808', 'iron-forge', 'afro-latin']) {
      const info = KITS.find((k) => k.id === id)!;
      const a = await renderBeat(info);
      const b = await renderBeat(info);
      let d = 0;
      for (let i = 0; i < a.L.length; i++) d = Math.max(d, Math.abs(a.L[i] - b.L[i]));
      expect(d, id).toBeLessThan(1e-6);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Chokes of the new kits                                              */
/* ------------------------------------------------------------------ */

async function renderHits(kitId: string, hits: [number, number][], seconds = 1.2): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.round(seconds * SR), SR);
  const ictx: InstrumentContext = { ctx, samples: { get: () => null }, noise: ctx.createBuffer(1, SR, SR), getBpm: () => 120 };
  const kit = new DrumKitEngine(ictx, createInstrument('drums', kitId) as DrumsInstrument);
  kit.output.connect(ctx.destination);
  for (const [slot, t] of hits) kit.trigger({ pitch: slot, velocity: 1, time: t });
  const buf = await ctx.startRendering();
  return buf.getChannelData(0).slice();
}

function energy(x: Float32Array, a: number, b: number): number {
  let e = 0;
  for (let i = Math.round(a * SR); i < Math.min(x.length, Math.round(b * SR)); i++) e += x[i] * x[i];
  return e;
}

describe('choke groups of the extended kits', () => {
  for (const info of KITS.filter((k) => !['round-machine', 'tight-circuit', 'dust-tape', 'bright-steel', 'hand-percussion'].includes(k.id))) {
    const groups = getKitRecipe(info.id).chokeGroups;
    it(`${info.name}: ${groups.map((g) => g.join('+')).join(', ')} cut each other; other sounds ring on`, async () => {
      for (const group of groups) {
        // The ringing sound is the longest of the group; every other member chokes it.
        const ringing = group.includes(5) ? 5 : group[0];
        const alone = await renderHits(info.id, [[ringing, 0.05]]);
        for (const choker of group.filter((s) => s !== ringing)) {
          const other = await renderHits(info.id, [[choker, 0.3]]);
          const both = await renderHits(info.id, [[ringing, 0.05], [choker, 0.3]]);
          // After the choke, what is left is the choking hit alone (the ringing one is gone within ~10 ms).
          const residual = both.map((v, i) => v - other[i]);
          const before = energy(alone, 0.315, 0.6);
          expect(before, `${info.id} slot ${ringing} should still ring at 0.3 s`).toBeGreaterThan(0);
          expect(10 * Math.log10(energy(residual, 0.315, 0.6) / before), `${info.id}: ${choker} cuts ${ringing}`).toBeLessThan(-40);
        }
      }
      // A slot outside every group leaves a ringing open hat (or the group's first sound) alone.
      const inGroup = new Set(groups.flat());
      const ringing = inGroup.has(5) ? 5 : 5;
      const outsider = [6, 7, 11, 14].find((s) => !inGroup.has(s) && s !== ringing)!;
      const ring = await renderHits(info.id, [[ringing, 0.05]]);
      const alone = await renderHits(info.id, [[outsider, 0.3]]);
      const both = await renderHits(info.id, [[ringing, 0.05], [outsider, 0.3]]);
      let d = 0;
      for (let i = 0; i < both.length; i++) d = Math.max(d, Math.abs(both[i] - ring[i] - alone[i]));
      expect(d, `${info.id}: slot ${outsider} must not choke slot ${ringing}`).toBeLessThan(1e-5);
    });
  }
});
