/**
 * Drum synthesis and kit recipes, measured on the rendered samples:
 * sanity of every kit x slot, determinism, decay scaling, pitch and
 * spectral placement of key voices, choke-family layout, level matching,
 * how different the kits are, and render time.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DRUM_DECAY_MAX,
  DRUM_DECAY_MIN,
  clearDrumVoiceCache,
  drumVoiceCacheStats,
  drumVoiceKey,
  getDrumVoice,
  quantizeDrumDecay,
  renderDrumVoice,
} from '../../src/audio/instruments/drumSynth';
import { DEFAULT_KIT_ID, getKitRecipe, getKitVoiceNames } from '../../src/audio/instruments/kits';
import { bandProfileDb, energy, fractionAbove, peakAbs, powerSpectrum, rms, rmsEnvelope, zeroCrossingFrequency } from '../../src/audio/dsp';
import { DRUM_SLOTS, KITS } from '../../src/content/catalog';

const SR = 48000;
const KIT_IDS = KITS.map((k) => k.id);
/** Kits with the standard drum-kit layout (the rest are percussion sets). */
const STANDARD = KITS.filter((k) => k.family === 'kit').map((k) => k.id);
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

/** Default-decay renders of every kit, shared by the tests below. */
const rendered = new Map<string, Float32Array[]>();
beforeAll(() => {
  for (const id of KIT_IDS) rendered.set(id, Array.from({ length: 16 }, (_, s) => renderDrumVoice(id, s, SR, 1)));
});
const voice = (kit: string, slot: number) => rendered.get(kit)![slot];

/** Time (s) after which the 5 ms RMS envelope stays 40 dB below its maximum. */
function audibleLength(x: Float32Array): number {
  const win = 240;
  const env = rmsEnvelope(x, win);
  let max = 0;
  for (const v of env) max = Math.max(max, v);
  let last = 0;
  env.forEach((v, i) => {
    if (v > max * 0.01) last = i;
  });
  return ((last + 1) * win) / SR;
}

/** Largest sample-to-sample change in x[from, to). */
function slew(x: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(1, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}
/** Largest step over the first four samples (out of the silent sample 0). */
const onsetStep = (x: Float32Array) => slew(x, 1, 5);

/** Onsets (ms) in a 1.5 ms power envelope: peaks separated by a dip to half their level and a doubling rise. */
function onsetsMs(x: Float32Array, untilSeconds: number): number[] {
  const a = 1 - Math.exp(-1 / (0.0015 * SR));
  const n = Math.min(x.length, Math.round(untilSeconds * SR));
  const env = new Float64Array(n);
  let e = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    e += a * (x[i] * x[i] - e);
    env[i] = e;
    max = Math.max(max, e);
  }
  const out: number[] = [];
  let armed = true;
  let cand = -1;
  let candV = 0;
  let minSince = Infinity;
  for (let i = 0; i < n; i++) {
    const v = env[i];
    if (armed) {
      if (v > 0.2 * max && v > candV) {
        cand = i;
        candV = v;
      }
      if (cand >= 0 && v < candV * 0.5) {
        out.push((cand / SR) * 1000);
        armed = false;
        minSince = v;
      }
    } else {
      minSince = Math.min(minSince, v);
      if (v > minSince * 2 && v > 0.2 * max) {
        armed = true;
        cand = i;
        candV = v;
      }
    }
  }
  if (armed && cand >= 0) out.push((cand / SR) * 1000);
  return out;
}

describe('kit recipes and names', () => {
  it('every catalogue kit has 16 distinct, named voices', () => {
    for (const id of KIT_IDS) {
      const names = getKitVoiceNames(id);
      expect(names).toHaveLength(DRUM_SLOTS.length);
      expect(new Set(names).size).toBe(16);
      expect(getKitRecipe(id).id).toBe(id);
    }
  });

  it('standard kits follow the pad layout; only hats choke each other', () => {
    for (const id of STANDARD) {
      const n = getKitVoiceNames(id);
      expect(n[0]).toBe('Kick');
      expect(n[2]).toBe('Snare');
      expect(n[4]).toBe('Closed Hat');
      expect(n[5]).toBe('Open Hat');
      expect(n.slice(8, 11)).toEqual(['Low Tom', 'Mid Tom', 'High Tom']);
      // Every choke group is made of hats: the closed hat always chokes the open hat.
      const groups = getKitRecipe(id).chokeGroups;
      expect(groups.some((g) => g.includes(4) && g.includes(5))).toBe(true);
      for (const g of groups) for (const slot of g) expect(n[slot]).toMatch(/Hat$/);
    }
    // Slot 6 chokes the hats exactly where it is a pedal hat; elsewhere it is a shaker-like sound that leaves them alone.
    for (const id of STANDARD) {
      const pedal = getKitVoiceNames(id)[6] === 'Pedal Hat';
      expect(getKitRecipe(id).chokeGroups, id).toEqual(pedal ? [[4, 5, 6]] : [[4, 5]]);
    }
    expect(getKitVoiceNames('tight-circuit')[6]).toBe('Pedal Hat');
    for (const id of ['round-machine', 'dust-tape', 'bright-steel']) expect(getKitVoiceNames(id)[6]).toBe('Shaker');
    for (const id of ['punch-909', 'trap-night', 'studio-acoustic', 'electro-wire']) expect(getKitVoiceNames(id)[6], id).toBe('Pedal Hat');
    // Percussion sets: only strokes of one drum cut each other (the djembe's bass, tone and slap).
    expect(getKitRecipe('afro-latin').chokeGroups).toEqual([[0, 1, 2]]);
    expect(getKitVoiceNames('afro-latin').slice(0, 3)).toEqual(['Djembe Bass', 'Djembe Tone', 'Djembe Slap']);
    const hp = getKitVoiceNames('hand-percussion');
    expect(hp.slice(4, 7)).toEqual(['Shaker', 'Tambourine', 'Cabasa']);
    expect(hp).toContain('Low Conga');
    expect(getKitRecipe('hand-percussion').chokeGroups).toEqual([]);
  });

  it('unknown kits fall back to the default kit', () => {
    expect(getKitVoiceNames('no-such-kit')).toEqual(getKitVoiceNames(DEFAULT_KIT_ID));
    expect(Array.from(renderDrumVoice('no-such-kit', 0, SR, 1))).toEqual(Array.from(voice(DEFAULT_KIT_ID, 0)));
  });
});

describe('every kit x slot', () => {
  it('is finite, audible, peak-normalised, and starts and ends in silence', () => {
    for (const id of KIT_IDS) {
      const recipe = getKitRecipe(id);
      for (let s = 0; s < 16; s++) {
        const x = voice(id, s);
        const label = `${id} #${s} ${recipe.voices[s].name}`;
        expect(x.every(Number.isFinite), label).toBe(true);
        const p = peakAbs(x);
        expect(p, label).toBeLessThanOrEqual(1);
        expect(p, label).toBeCloseTo(recipe.voices[s].peak, 4);
        expect(rms(x), label).toBeGreaterThan(0.01);
        expect(x[0], label).toBe(0);
        expect(x[x.length - 1], label).toBe(0);
        // Last 10 ms at least 50 dB below the peak: no truncated tails.
        const tail = rms(x, x.length - Math.round(0.01 * SR));
        expect(db(tail / p), label).toBeLessThan(-50);
        // No discontinuity at the start: the first steps out of silence stay within a few times the
        // sound's own sample-to-sample movement over the next 5 ms (designed stick/click transients are
        // fast but continuous; a sound starting at a held level jumps far beyond its later movement).
        expect(onsetStep(x), label).toBeLessThan(3 * slew(x, 5, 5 + Math.round(0.005 * SR)));
      }
    }
  });

  it('stays clean at other sample rates and at the decay extremes', () => {
    for (const [sr, dm] of [
      [44100, DRUM_DECAY_MIN],
      [96000, DRUM_DECAY_MAX],
    ] as const) {
      for (const id of KIT_IDS) {
        for (let s = 0; s < 16; s++) {
          const x = renderDrumVoice(id, s, sr, dm);
          const label = `${id} #${s} @${sr} x${dm}`;
          const p = peakAbs(x);
          expect(x.every(Number.isFinite), label).toBe(true);
          expect(p, label).toBeCloseTo(getKitRecipe(id).voices[s].peak, 4);
          expect(rms(x), label).toBeGreaterThan(0.01);
          expect(x[0], label).toBe(0);
          expect(x[x.length - 1], label).toBe(0);
          expect(db(rms(x, x.length - Math.round(0.01 * sr)) / p), label).toBeLessThan(-50);
          expect(onsetStep(x), label).toBeLessThan(3 * slew(x, 5, 5 + Math.round(0.005 * sr)));
        }
      }
    }
  });

  it('is deterministic', () => {
    for (const id of KIT_IDS) {
      for (const s of [0, 2, 3, 5, 12, 13, 14, 15]) {
        expect(Array.from(renderDrumVoice(id, s, SR, 1)), `${id} #${s}`).toEqual(Array.from(voice(id, s)));
      }
    }
  });

  it('lengthens with decayMul: longer decay puts more energy late', () => {
    for (const id of KIT_IDS) {
      for (let s = 0; s < 16; s++) {
        const short = renderDrumVoice(id, s, SR, 0.5);
        const long = renderDrumVoice(id, s, SR, 2);
        const label = `${id} #${s}`;
        expect(long.length, label).toBeGreaterThan(short.length);
        // Fraction of energy after half the default length.
        const t = Math.round(voice(id, s).length / 2);
        const lateShort = energy(short, t) / energy(short);
        const lateLong = energy(long, t) / energy(long);
        expect(lateLong, label).toBeGreaterThan(lateShort * 1.5);
      }
    }
  });

  it('works at 44.1 kHz with proportionally sized buffers', () => {
    for (const id of KIT_IDS) {
      for (const s of [0, 4, 12]) {
        const a = renderDrumVoice(id, s, 44100, 1);
        const b = voice(id, s);
        expect(a.every(Number.isFinite)).toBe(true);
        expect(a.length / 44100).toBeCloseTo(b.length / SR, 1);
      }
    }
  });

  it('clamps out-of-range arguments', () => {
    expect(renderDrumVoice('round-machine', 99, SR, 1).length).toBe(voice('round-machine', 15).length);
    expect(renderDrumVoice('round-machine', 0, SR, Number.NaN).length).toBe(voice('round-machine', 0).length);
    expect(renderDrumVoice('round-machine', 12, SR, 100).length).toBe(renderDrumVoice('round-machine', 12, SR, DRUM_DECAY_MAX).length);
  });
});

describe('voice character', () => {
  it('kicks have a 40–100 Hz body with a downward pitch sweep', () => {
    for (const id of STANDARD) {
      for (const s of [0, 1]) {
        const x = voice(id, s);
        const body = zeroCrossingFrequency(x, SR, Math.round(0.08 * SR), Math.round(0.2 * SR));
        const attack = zeroCrossingFrequency(x, SR, 0, Math.round(0.02 * SR));
        expect(body, `${id} #${s}`).toBeGreaterThan(40);
        expect(body, `${id} #${s}`).toBeLessThan(100);
        expect(attack, `${id} #${s}`).toBeGreaterThan(body * 1.4);
        // Almost all energy below 200 Hz.
        expect(1 - fractionAbove(powerSpectrum(x, SR), 200), `${id} #${s}`).toBeGreaterThan(0.85);
      }
    }
  });

  it('hats, shakers and jingles put most energy above 5 kHz', () => {
    for (const id of KIT_IDS) {
      for (const s of [4, 5, 6]) {
        expect(fractionAbove(powerSpectrum(voice(id, s), SR), 5000), `${id} #${s}`).toBeGreaterThan(0.6);
      }
    }
  });

  it('closed hats are short, open hats ring, and slot 6 is shorter and softer than the open hat', () => {
    for (const id of STANDARD) {
      const closed = audibleLength(voice(id, 4));
      const open = audibleLength(voice(id, 5));
      const pedal = audibleLength(voice(id, 6));
      expect(closed, id).toBeLessThan(0.1);
      expect(open, id).toBeGreaterThan(Math.max(0.15, 3 * closed));
      expect(open, id).toBeLessThan(0.7);
      expect(pedal, id).toBeLessThan(open);
      expect(peakAbs(voice(id, 6)), id).toBeLessThan(peakAbs(voice(id, 5)));
    }
  });

  it('snares combine a tonal body with band-limited noise', () => {
    for (const id of STANDARD) {
      const spec = powerSpectrum(voice(id, 2), SR);
      const low = 1 - fractionAbove(spec, 450);
      const high = fractionAbove(spec, 1500);
      expect(low, id).toBeGreaterThan(0.05);
      expect(high, id).toBeGreaterThan(0.15);
    }
  });

  it('claps have 3–4 bursts about 10 ms apart', () => {
    for (const id of STANDARD) {
      const on = onsetsMs(voice(id, 3), 0.04);
      expect(on.length, id).toBeGreaterThanOrEqual(3);
      for (let k = 1; k < 3; k++) {
        expect(on[k] - on[k - 1], id).toBeGreaterThan(6);
        expect(on[k] - on[k - 1], id).toBeLessThan(15);
      }
    }
  });

  it('toms are tuned low < mid < high with a musical spread and bend downwards', () => {
    for (const id of STANDARD) {
      const f = [8, 9, 10].map((s) => zeroCrossingFrequency(voice(id, s), SR, Math.round(0.1 * SR), Math.round(0.25 * SR)));
      expect(f[1] / f[0], id).toBeGreaterThan(1.2);
      expect(f[1] / f[0], id).toBeLessThan(1.5);
      expect(f[2] / f[1], id).toBeGreaterThan(1.2);
      expect(f[2] / f[1], id).toBeLessThan(1.5);
      const early = zeroCrossingFrequency(voice(id, 9), SR, 0, Math.round(0.02 * SR));
      expect(early / f[1], id).toBeGreaterThan(1.05);
      expect(early / f[1], id).toBeLessThan(1.3);
    }
  });

  it('cymbals ring far longer than hats', () => {
    for (const id of STANDARD) {
      const closed = audibleLength(voice(id, 4));
      const open = audibleLength(voice(id, 5));
      for (const s of [12, 13]) {
        expect(audibleLength(voice(id, s)), `${id} #${s}`).toBeGreaterThan(Math.max(0.5, 1.5 * open, 8 * closed));
      }
    }
  });

  it('hand drums are tuned from low conga up to high bongo', () => {
    const f = [0, 1, 2, 3].map((s) => zeroCrossingFrequency(voice('hand-percussion', s), SR, Math.round(0.03 * SR), Math.round(0.1 * SR)));
    for (let k = 1; k < 4; k++) expect(f[k]).toBeGreaterThan(f[k - 1] * 1.2);
    expect(f[0]).toBeGreaterThan(150);
    expect(f[3]).toBeLessThan(800);
  });
});

describe('kits', () => {
  it('are level-matched: the same slot sits within 5 dB across the standard kits', () => {
    // Short-term loudness proxy: RMS over the first 100 ms.
    for (const s of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]) {
      const levels = STANDARD.map((id) => db(rms(voice(id, s), 0, Math.round(0.1 * SR))));
      expect(Math.max(...levels) - Math.min(...levels), `slot ${s}`).toBeLessThan(5);
    }
  });

  it('keep a sensible balance between roles', () => {
    for (const id of STANDARD) {
      const lvl = (s: number) => db(rms(voice(id, s), 0, Math.round(0.1 * SR)));
      expect(lvl(0), id).toBeGreaterThan(lvl(2));
      expect(lvl(2), id).toBeGreaterThan(lvl(4));
      expect(lvl(0) - lvl(4), id).toBeGreaterThan(12);
    }
  });

  it('differ measurably from each other', () => {
    const edges = [20, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 24000];
    const profile = (x: Float32Array) => bandProfileDb(powerSpectrum(x, SR, 2048), edges).map((v) => Math.max(-60, v));
    const prof = new Map(KIT_IDS.map((id) => [id, rendered.get(id)!.map(profile)]));
    const lens = new Map(KIT_IDS.map((id) => [id, rendered.get(id)!.map(audibleLength)]));
    for (let a = 0; a < KIT_IDS.length; a++) {
      for (let b = a + 1; b < KIT_IDS.length; b++) {
        const A = KIT_IDS[a];
        const B = KIT_IDS[b];
        let differing = 0;
        let spectral = 0;
        for (let s = 0; s < 16; s++) {
          const pa = prof.get(A)![s];
          const pb = prof.get(B)![s];
          const d = pa.reduce((sum, v, e) => sum + Math.abs(v - pb[e]), 0) / pa.length;
          const la = lens.get(A)![s];
          const lb = lens.get(B)![s];
          const ratio = Math.max(la, lb) / Math.min(la, lb);
          spectral += d / 16;
          if (d >= 3 || ratio >= 1.25) differing++;
        }
        expect(differing, `${A} vs ${B}`).toBeGreaterThanOrEqual(12);
        expect(spectral, `${A} vs ${B}`).toBeGreaterThan(3);
      }
    }
  });

  it('render a whole kit at 48 kHz in well under 200 ms', () => {
    renderDrumVoice('round-machine', 12, SR, 1); // JIT warm-up
    for (const id of KIT_IDS) {
      const t0 = performance.now();
      for (let s = 0; s < 16; s++) renderDrumVoice(id, s, SR, 1);
      expect(performance.now() - t0, id).toBeLessThan(200);
    }
  });
});

describe('voice cache', () => {
  it('shares renders for the same quantised decay and evicts nothing needed', () => {
    clearDrumVoiceCache();
    const a = getDrumVoice('tight-circuit', 5, SR, 1);
    const b = getDrumVoice('tight-circuit', 5, SR, 1.01);
    expect(b).toBe(a);
    expect(drumVoiceCacheStats().entries).toBe(1);
    const c = getDrumVoice('tight-circuit', 5, SR, 1.5);
    expect(c).not.toBe(a);
    expect(c.length).toBeGreaterThan(a.length);
    expect(drumVoiceKey('tight-circuit', 5, SR, 1)).toBe(drumVoiceKey('tight-circuit', 5, SR, 1.01));
    expect(Array.from(a)).toEqual(Array.from(renderDrumVoice('tight-circuit', 5, SR, 1)));
    clearDrumVoiceCache();
    expect(drumVoiceCacheStats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('quantises decay to a bounded 1/12-octave grid', () => {
    expect(quantizeDrumDecay(0.01)).toBe(DRUM_DECAY_MIN);
    expect(quantizeDrumDecay(1e6)).toBe(DRUM_DECAY_MAX);
    expect(quantizeDrumDecay(Number.NaN)).toBe(1);
    const q = quantizeDrumDecay(1.3);
    expect(Math.abs(Math.log2(q / 1.3))).toBeLessThanOrEqual(1 / 24 + 1e-9);
  });
});
