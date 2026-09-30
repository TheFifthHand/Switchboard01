/**
 * DrumKitEngine on a real OfflineAudioContext: rendered audio is measured
 * for audibility, velocity, tuning, pitch/cutoff modulation, kit params,
 * panning, choke groups, cancellation, voice lifetime, kill/releaseAll,
 * polyphony limits and kit changes.
 */
import { describe, expect, it } from 'vitest';
import type { InstrumentContext } from '../../src/audio/contracts';
import { DRUM_MAX_HITS, DrumKitEngine, drumVelocityGain } from '../../src/audio/instruments/drumKit';
import { energy, peakAbs, zeroCrossingFrequency } from '../../src/audio/dsp';
import { createInstrument } from '../../src/project/factory';
import type { DrumVoiceSettings, DrumsInstrument } from '../../src/project/types';

const SR = 48000;
const sec = (t: number) => Math.round(t * SR);
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-15));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function drums(kitId = 'round-machine', params: Record<string, number> = {}, voice?: (slot: number) => Partial<DrumVoiceSettings>): DrumsInstrument {
  const base = createInstrument('drums', kitId) as DrumsInstrument;
  return {
    ...base,
    params: { ...base.params, ...params },
    voices: base.voices.map((v, s) => ({ ...v, ...(voice?.(s) ?? {}) })),
  };
}

type Step = (kit: DrumKitEngine, ctx: OfflineAudioContext) => void | Promise<void>;

interface Rendered {
  L: Float32Array;
  R: Float32Array;
  kit: DrumKitEngine;
}

async function render(opts: { seconds: number; instrument?: DrumsInstrument; play: Step; at?: [number, Step][]; pitchCents?: number }): Promise<Rendered> {
  const ctx = new OfflineAudioContext(2, sec(opts.seconds), SR);
  const ictx: InstrumentContext = { ctx, samples: { get: () => null }, noise: ctx.createBuffer(1, SR, SR), getBpm: () => 120 };
  const kit = new DrumKitEngine(ictx, opts.instrument ?? drums());
  kit.output.connect(ctx.destination);
  if (opts.pitchCents !== undefined) {
    const c = new ConstantSourceNode(ctx, { offset: opts.pitchCents });
    c.connect(kit.pitchMod);
    c.start(0);
  }
  await opts.play(kit, ctx);
  for (const [t, fn] of opts.at ?? []) {
    void ctx.suspend(t).then(async () => {
      await fn(kit, ctx);
      await ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0).slice();
  const R = buf.getChannelData(1).slice();
  expect(L.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
  return { L, R, kit };
}

const hit = (kit: DrumKitEngine, pitch: number, time: number, velocity = 1) => kit.trigger({ pitch, velocity, time });

function diff(a: Float32Array, b: Float32Array): Float32Array {
  return a.map((v, i) => v - b[i]);
}

describe('DrumKitEngine', () => {
  it('plays audible, centred one-shots at the designed level', async () => {
    const { L, R } = await render({ seconds: 1, play: (k) => void hit(k, 0, 0.05) });
    expect(peakAbs(L, 0, sec(0.05))).toBe(0);
    const p = peakAbs(L);
    // Kick peak 0.95 at centre (pan-law makeup restores unity per side).
    expect(p).toBeGreaterThan(0.85);
    expect(p).toBeLessThan(1.0);
    expect(peakAbs(diff(L, R))).toBeLessThan(1e-6);
  });

  it('scales level by the velocity curve and the kit velocity sensitivity', async () => {
    const play: Step = (k) => {
      hit(k, 0, 0.05, 1);
      hit(k, 0, 1.05, 0.3);
    };
    const a = await render({ seconds: 2, play });
    const ratio = peakAbs(a.L, sec(1.05)) / peakAbs(a.L, 0, sec(1.0));
    expect(ratio).toBeCloseTo(drumVelocityGain(0.3, 0.6), 2);
    expect(drumVelocityGain(0.3, 0.6)).toBeCloseTo(0.4 + 0.6 * Math.pow(0.3, 1.6), 10);
    const flat = await render({ seconds: 2, instrument: drums('round-machine', { velocity: 0 }), play });
    expect(peakAbs(flat.L, sec(1.05)) / peakAbs(flat.L, 0, sec(1.0))).toBeCloseTo(1, 3);
  });

  it('kit tune and voice tune transpose by semitones', async () => {
    const tomPitch = async (instrument: DrumsInstrument, rate: number) => {
      const { L } = await render({ seconds: 1.2, instrument, play: (k) => void hit(k, 9, 0.05) });
      // Same stretch of the underlying buffer regardless of playback rate.
      return zeroCrossingFrequency(L, SR, sec(0.05 + 0.1 / rate), sec(0.05 + 0.3 / rate));
    };
    const f0 = await tomPitch(drums(), 1);
    expect(f0).toBeGreaterThan(110);
    expect(f0).toBeLessThan(140);
    expect((await tomPitch(drums('round-machine', { tune: 12 }), 2)) / f0).toBeCloseTo(2, 1);
    expect((await tomPitch(drums('round-machine', {}, (s) => (s === 9 ? { tune: -12 } : {})), 0.5)) / f0).toBeCloseTo(0.5, 2);
    expect((await tomPitch(drums('round-machine', { tune: 7 }), Math.pow(2, 7 / 12))) / f0).toBeCloseTo(Math.pow(2, 7 / 12), 1);
  });

  it('pitchMod (cents) bends every hit', async () => {
    const plain = await render({ seconds: 1, play: (k) => void hit(k, 9, 0.05) });
    const bent = await render({ seconds: 1, pitchCents: 1200, play: (k) => void hit(k, 9, 0.05) });
    const f0 = zeroCrossingFrequency(plain.L, SR, sec(0.15), sec(0.35));
    const f1 = zeroCrossingFrequency(bent.L, SR, sec(0.1), sec(0.2));
    expect(f1 / f0).toBeCloseTo(2, 1);
  });

  it('kit cutoff, cutoffMod and level shape the whole kit', async () => {
    const hat = (instrument: DrumsInstrument) => render({ seconds: 0.5, instrument, play: (k) => void hit(k, 4, 0.05) });
    const open = await hat(drums());
    const dark = await hat(drums('round-machine', { cutoff: 400 }));
    expect(db(Math.sqrt(energy(dark.L) / energy(open.L)))).toBeLessThan(-30);

    // cutoffMod: -3600 cents from 20 kHz is ~2.5 kHz: a strong cut on the hat as well.
    const ctx = new OfflineAudioContext(2, sec(0.5), SR);
    const kit = new DrumKitEngine({ ctx, samples: { get: () => null }, noise: ctx.createBuffer(1, SR, SR), getBpm: () => 120 }, drums());
    kit.output.connect(ctx.destination);
    const c = new ConstantSourceNode(ctx, { offset: -3600 });
    c.connect(kit.cutoffMod);
    c.start(0);
    hit(kit, 4, 0.05);
    const modded = (await ctx.startRendering()).getChannelData(0);
    expect(db(Math.sqrt(energy(modded) / energy(open.L)))).toBeLessThan(-12);

    const kick = (instrument: DrumsInstrument) => render({ seconds: 1, instrument, play: (k) => void hit(k, 0, 0.05) });
    const full = await kick(drums());
    const quiet = await kick(drums('round-machine', { level: -12 }));
    expect(peakAbs(quiet.L) / peakAbs(full.L)).toBeCloseTo(Math.pow(10, -12 / 20), 2);
  });

  it('voice level and pan place each drum', async () => {
    const centre = await render({ seconds: 1, play: (k) => void hit(k, 0, 0.05) });
    const left = await render({ seconds: 1, instrument: drums('round-machine', {}, (s) => (s === 0 ? { pan: -1, level: 0.5 } : {})), play: (k) => void hit(k, 0, 0.05) });
    expect(peakAbs(left.R)).toBeLessThan(1e-4);
    // Equal-power law: hard left carries the centre's two sides in one (+3 dB), times the voice level.
    expect(peakAbs(left.L) / peakAbs(centre.L)).toBeCloseTo(0.5 * Math.SQRT2, 2);
  });

  it('kit decay lengthens and shortens the drums', async () => {
    const tail = async (decay: number) => {
      const { L } = await render({ seconds: 1.5, instrument: drums('round-machine', { decay }), play: (k) => void hit(k, 5, 0.05) });
      return energy(L, sec(0.35)) / energy(L);
    };
    expect(await tail(2)).toBeGreaterThan((await tail(0.5)) * 5);
  });

  describe('choke', () => {
    for (const [kitId, choker] of [
      ['round-machine', 4],
      ['tight-circuit', 4],
      ['tight-circuit', 6],
    ] as const) {
      it(`slot ${choker} cuts the open slot 5 with a short fade (${kitId})`, async () => {
        const inst = drums(kitId);
        const a = await render({ seconds: 1, instrument: inst, play: (k) => void hit(k, 5, 0.05) });
        const b = await render({
          seconds: 1,
          instrument: inst,
          play: (k) => {
            hit(k, 5, 0.05);
            hit(k, choker, 0.25);
          },
        });
        const c = await render({ seconds: 1, instrument: inst, play: (k) => void hit(k, choker, 0.25) });
        // Identical until the choke...
        expect(peakAbs(diff(b.L, a.L), 0, sec(0.25))).toBeLessThan(1e-6);
        const residual = diff(b.L, c.L);
        // ...then a fade, not a click: a linear 8 ms ramp keeps about -5 dB of the energy in its window...
        const fade = db(Math.sqrt(energy(residual, sec(0.25), sec(0.258)) / energy(a.L, sec(0.25), sec(0.258))));
        expect(fade).toBeGreaterThan(-9);
        expect(fade).toBeLessThan(-2);
        // ...and the open hit is gone within ~10 ms.
        const from = sec(0.262);
        const to = sec(0.8);
        expect(energy(a.L, from, to)).toBeGreaterThan(0);
        expect(db(Math.sqrt(energy(residual, from, to) / energy(a.L, from, to)))).toBeLessThan(-40);
      });
    }

    for (const [kitId, slot, name] of [
      ['round-machine', 6, 'shaker'],
      ['bright-steel', 6, 'shaker'],
      ['hand-percussion', 4, 'shaker'],
      ['hand-percussion', 6, 'cabasa'],
    ] as const) {
      it(`a ${name} (slot ${slot}) leaves the ringing slot 5 alone (${kitId})`, async () => {
        const inst = drums(kitId);
        const ring = await render({ seconds: 1, instrument: inst, play: (k) => void hit(k, 5, 0.05) });
        const alone = await render({ seconds: 1, instrument: inst, play: (k) => void hit(k, slot, 0.25) });
        const both = await render({
          seconds: 1,
          instrument: inst,
          play: (k) => {
            hit(k, 5, 0.05);
            hit(k, slot, 0.25);
          },
        });
        // The open hat (or tambourine) keeps ringing under the shaker: the mix is just the sum of both.
        expect(energy(ring.L, sec(0.3), sec(0.6))).toBeGreaterThan(0);
        const sum = ring.L.map((v, i) => v + alone.L[i]);
        expect(peakAbs(diff(both.L, sum))).toBeLessThan(1e-5);
      });
    }

    it('the later hit wins when triggers arrive out of order, and the choked hit is freed', async () => {
      let voicesAfterChoke = -1;
      const b = await render({
        seconds: 1,
        play: (k) => {
          hit(k, 4, 0.4);
          // Triggered second but starts first (e.g. a live pad against sequenced notes).
          hit(k, 5, 0.1);
        },
        at: [[0.45, (k) => void (voicesAfterChoke = k.activeVoices())]],
      });
      const open = await render({ seconds: 1, play: (k) => void hit(k, 5, 0.1) });
      const closed = await render({ seconds: 1, play: (k) => void hit(k, 4, 0.4) });
      expect(peakAbs(diff(b.L, open.L), 0, sec(0.4))).toBeLessThan(1e-6);
      const residual = diff(b.L, closed.L);
      expect(db(Math.sqrt(energy(residual, sec(0.412), sec(0.7)) / energy(open.L, sec(0.412), sec(0.7))))).toBeLessThan(-40);
      // Only the closed hat is still allocated: the open one stopped at its choke instead of running on silently.
      expect(voicesAfterChoke).toBe(1);
    });

    it('cancelling a scheduled hit gives back the choke it would have caused', async () => {
      const open = await render({ seconds: 1, play: (k) => void hit(k, 5, 0.05) });
      // Like the transport regenerating upcoming notes while the open hat rings.
      let pending: ReturnType<DrumKitEngine['trigger']> = null;
      const undone = await render({
        seconds: 1,
        play: (k) => {
          hit(k, 5, 0.05);
          pending = hit(k, 4, 0.3);
        },
        at: [[0.2, () => pending?.cancel()]],
      });
      expect(peakAbs(diff(undone.L, open.L))).toBeLessThan(1e-6);

      // With a later group hit still scheduled, its choke applies instead.
      const rechoked = await render({
        seconds: 1,
        play: (k) => {
          hit(k, 5, 0.05);
          pending = hit(k, 4, 0.3);
          hit(k, 4, 0.4);
        },
        at: [[0.2, () => pending?.cancel()]],
      });
      const closed = await render({ seconds: 1, play: (k) => void hit(k, 4, 0.4) });
      expect(peakAbs(diff(rechoked.L, open.L), 0, sec(0.4))).toBeLessThan(1e-6);
      const residual = diff(rechoked.L, closed.L);
      expect(db(Math.sqrt(energy(residual, sec(0.412), sec(0.7)) / energy(open.L, sec(0.412), sec(0.7))))).toBeLessThan(-40);
    });

    it('the open hat retrigger chokes itself, repeated kicks overlap', async () => {
      const pair = async (slot: number) => {
        const a = await render({ seconds: 1.2, play: (k) => void hit(k, slot, 0.05) });
        const b = await render({
          seconds: 1.2,
          play: (k) => {
            hit(k, slot, 0.05);
            hit(k, slot, 0.25);
          },
        });
        const c = await render({ seconds: 1.2, play: (k) => void hit(k, slot, 0.25) });
        const residual = diff(b.L, c.L);
        const from = sec(0.262);
        const to = sec(0.75);
        return energy(residual, from, to) / energy(a.L, from, to);
      };
      expect(db(Math.sqrt(await pair(5)))).toBeLessThan(-40);
      expect(await pair(0)).toBeCloseTo(1, 2);
    });
  });

  it('cancel() before the start time means the hit never sounds', async () => {
    const { L, kit } = await render({
      seconds: 0.6,
      play: (k) => {
        const h = hit(k, 0, 0.2);
        expect(h).not.toBeNull();
        h!.cancel();
        expect(h!.ended).toBe(true);
        expect(k.activeVoices()).toBe(0);
      },
    });
    expect(peakAbs(L)).toBe(0);
    expect(kit.activeVoices()).toBe(0);
  });

  it('release() does not cut a one-shot', async () => {
    const a = await render({ seconds: 1, play: (k) => void hit(k, 5, 0.05) });
    const b = await render({ seconds: 1, play: (k) => void hit(k, 5, 0.05)?.release(0.1) });
    expect(peakAbs(diff(a.L, b.L))).toBeLessThan(1e-6);
  });

  it('voices end and are freed after their buffers finish', async () => {
    const handles: ReturnType<DrumKitEngine['trigger']>[] = [];
    let during = -1;
    const { kit } = await render({
      seconds: 1.5,
      play: (k) => {
        for (const [slot, t] of [
          [0, 0.02],
          [2, 0.05],
          [4, 0.08],
          [7, 0.1],
          [9, 0.12],
        ] as const) {
          handles.push(hit(k, slot, t));
        }
      },
      at: [
        [
          0.15,
          (k) => {
            during = k.activeVoices();
          },
        ],
      ],
    });
    expect(during).toBe(5);
    await tick();
    expect(kit.activeVoices()).toBe(0);
    expect(handles.every((h) => h?.ended)).toBe(true);
  });

  it('kill() silences immediately', async () => {
    const { L, kit } = await render({
      seconds: 1.2,
      play: (k) => {
        hit(k, 12, 0.05);
        hit(k, 0, 0.9);
      },
      at: [[0.5, (k) => k.kill()]],
    });
    expect(peakAbs(L, sec(0.3), sec(0.5))).toBeGreaterThan(0.01);
    expect(peakAbs(L, sec(0.5) + 128)).toBeLessThan(1e-5);
    await tick();
    expect(kit.activeVoices()).toBe(0);
  });

  it('releaseAll() fades sounding hits and drops scheduled ones', async () => {
    const { L } = await render({
      seconds: 1.2,
      play: (k) => {
        hit(k, 12, 0.05);
        hit(k, 0, 0.9);
      },
      at: [[0.4, (k) => k.releaseAll(0.4)]],
    });
    expect(peakAbs(L, sec(0.3), sec(0.4))).toBeGreaterThan(0.01);
    // Fades rather than clicks: still some level in the first few ms after the release...
    expect(peakAbs(L, sec(0.4), sec(0.41))).toBeGreaterThan(0.001);
    // ...and nothing after the 60 ms fade, including the kick that was scheduled for later.
    expect(peakAbs(L, sec(0.47))).toBeLessThan(1e-5);
  });

  it(`never plays more than ${DRUM_MAX_HITS} hits at once`, async () => {
    // Like the transport: every 20 ms, schedule the next two long cymbal hits just ahead of time.
    let peakVoices = 0;
    let scheduled = 0;
    const steps: [number, Step][] = Array.from({ length: 30 }, (_, i) => [
      0.02 + i * 0.02,
      async (k: DrumKitEngine, ctx: OfflineAudioContext) => {
        await tick(2);
        peakVoices = Math.max(peakVoices, k.activeVoices());
        for (let j = 0; j < 2; j++) {
          hit(k, j === 0 ? 12 : 13, ctx.currentTime + 0.005 + j * 0.003, 0.8);
          scheduled++;
        }
      },
    ]);
    const { L, kit } = await render({ seconds: 0.9, play: () => undefined, at: steps });
    await tick(5);
    peakVoices = Math.max(peakVoices, kit.activeVoices());
    expect(scheduled).toBe(60);
    // Without the cap all 60 two-second hits would still be ringing.
    expect(peakVoices).toBeGreaterThan(DRUM_MAX_HITS - 5);
    expect(peakVoices).toBeLessThanOrEqual(DRUM_MAX_HITS);
    expect(peakAbs(L)).toBeLessThan(40);
  });

  it('steals the oldest hit when full, and gives it back if the new hit is cancelled first', async () => {
    const full = (k: DrumKitEngine) => {
      for (let i = 0; i < DRUM_MAX_HITS; i++) hit(k, 12, 0.01 + i * 0.01, 0.5);
    };
    const ref = await render({ seconds: 1, play: full });
    const stolen = await render({ seconds: 1, play: (k) => (full(k), void hit(k, 13, 0.6, 0.5)) });
    const ride = await render({ seconds: 1, play: (k) => void hit(k, 13, 0.6, 0.5) });
    // The first crash (the oldest) fades out when the 41st hit starts.
    const first = await render({ seconds: 1, play: (k) => void hit(k, 12, 0.01, 0.5) });
    const lost = diff(diff(ref.L, stolen.L), ride.L.map((v) => -v));
    const from = sec(0.61);
    expect(db(Math.sqrt(energy(diff(lost, first.L), from) / energy(first.L, from)))).toBeLessThan(-40);

    let pending: ReturnType<DrumKitEngine['trigger']> = null;
    const restored = await render({
      seconds: 1,
      play: (k) => {
        full(k);
        pending = hit(k, 13, 0.6, 0.5);
      },
      at: [[0.5, () => pending?.cancel()]],
    });
    expect(peakAbs(diff(restored.L, ref.L))).toBeLessThan(1e-5);
  });

  it('kit level and cutoff changes are smoothed and reach hits that are already ringing', async () => {
    const inst = drums();
    const ref = await render({ seconds: 1, instrument: inst, play: (k) => void hit(k, 12, 0.05) });
    const quiet = await render({ seconds: 1, instrument: inst, play: (k) => void hit(k, 12, 0.05), at: [[0.3, (k) => k.update({ ...inst, params: { ...inst.params, level: -12 } }, 0.3)]] });
    // Level ratio in 1 ms windows: unchanged before, a smooth glide (no step), then exactly -12 dB.
    const win = sec(0.001);
    const ratio: number[] = [];
    for (let t = sec(0.29); t < sec(0.5); t += win) ratio.push(Math.sqrt(energy(quiet.L, t, t + win) / energy(ref.L, t, t + win)));
    expect(ratio[0]).toBeCloseTo(1, 4);
    expect(ratio[ratio.length - 1]).toBeCloseTo(Math.pow(10, -12 / 20), 2);
    for (let i = 1; i < ratio.length; i++) expect(Math.abs(ratio[i] - ratio[i - 1])).toBeLessThan(0.12);

    const dark = await render({ seconds: 1, instrument: inst, play: (k) => void hit(k, 12, 0.05), at: [[0.3, (k) => k.update({ ...inst, params: { ...inst.params, cutoff: 400 } }, 0.3)]] });
    expect(peakAbs(diff(dark.L, ref.L), 0, sec(0.3))).toBeLessThan(1e-6);
    expect(db(Math.sqrt(energy(dark.L, sec(0.4), sec(0.9)) / energy(ref.L, sec(0.4), sec(0.9))))).toBeLessThan(-25);
  });

  it('a kit change affects only later hits; an unchanged update is a no-op', async () => {
    const same = drums('round-machine');
    const play: Step = (k) => {
      hit(k, 0, 0.05);
      hit(k, 0, 0.6);
    };
    const a = await render({ seconds: 1.4, instrument: same, play, at: [[0.4, (k) => k.update(same, 0.4)]] });
    const b = await render({ seconds: 1.4, instrument: same, play: (k) => void hit(k, 0, 0.05), at: [[0.4, (k) => void (k.update(drums('tight-circuit'), 0.4), hit(k, 0, 0.6))]] });
    const ref = await render({ seconds: 1.4, instrument: same, play });
    expect(peakAbs(diff(a.L, ref.L))).toBeLessThan(1e-6);
    expect(peakAbs(diff(b.L, ref.L), 0, sec(0.6))).toBeLessThan(1e-6);
    const changed = diff(b.L, ref.L);
    expect(db(Math.sqrt(energy(changed, sec(0.6)) / energy(ref.L, sec(0.6))))).toBeGreaterThan(-10);
  });

  it('rejects invalid pads and stops after dispose()', async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const kit = new DrumKitEngine({ ctx, samples: { get: () => null }, noise: ctx.createBuffer(1, SR, SR), getBpm: () => 120 }, drums());
    expect(kit.trigger({ pitch: 16, velocity: 1, time: 0 })).toBeNull();
    expect(kit.trigger({ pitch: -1, velocity: 1, time: 0 })).toBeNull();
    expect(kit.trigger({ pitch: Number.NaN, velocity: 1, time: 0 })).toBeNull();
    const h = kit.trigger({ pitch: 3, velocity: Number.NaN, time: Number.NaN });
    expect(h).not.toBeNull();
    kit.dispose();
    expect(kit.activeVoices()).toBe(0);
    expect(kit.trigger({ pitch: 0, velocity: 1, time: 0 })).toBeNull();
  });
});
