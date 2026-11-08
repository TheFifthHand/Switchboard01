/**
 * Per-note recordings (capability-01): a sampler note can name its own
 * recording, region and root note (NoteTrigger.sample, from a clip's own
 * recording); it plays that buffer at its own pitch with the part's other
 * settings. A note whose recording is not loaded is skipped and counted,
 * never thrown; preloadSamples loads recordings through the SampleProvider.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { SampleProvider } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { createProject } from '../../src/project/factory';
import { estimateFundamental } from '../../src/render/analysis';

const SR = 48000;

function toneBuffer(parts: [freq: number, seconds: number][]): AudioBuffer {
  const total = parts.reduce((a, [, s]) => a + s, 0);
  const buf = new AudioBuffer({ numberOfChannels: 1, length: Math.round(total * SR), sampleRate: SR });
  const d = buf.getChannelData(0);
  let i = 0;
  for (const [f, s] of parts) {
    const n = Math.round(s * SR);
    for (let k = 0; k < n; k++, i++) d[i] = 0.5 * Math.sin((2 * Math.PI * f * k) / SR);
  }
  return buf;
}

function provider(buffers: Record<string, AudioBuffer>, loads?: string[]): SampleProvider {
  const map = new Map(Object.entries(buffers));
  const p: SampleProvider = { get: (id) => map.get(id) ?? null };
  if (loads) {
    p.load = async (id) => {
      loads.push(id);
      return map.get(id) ?? null;
    };
  }
  return p;
}

/** Render notes on the sampler part (t8) and return the mono output. */
async function renderNotes(samples: SampleProvider, notes: Parameters<AudioEngine['scheduleNote']>[1][], seconds = 2): Promise<{ out: Float32Array; engine: AudioEngine }> {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const engine = await AudioEngine.create(ctx, { samples, seed: 1, meters: false });
  const p = createProject({ now: 0 });
  for (const t of p.tracks) t.macros = { ...t.macros, space: 0, echo: 0 };
  const sampler = p.tracks.find((t) => t.instrument.kind === 'sampler')!;
  if (sampler.instrument.kind === 'sampler') sampler.instrument.sampleId = 'own';
  engine.setProject(p);
  for (const n of notes) engine.scheduleNote(sampler.id, n);
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) out[i] = 0.5 * (L[i] + R[i]);
  return { out, engine };
}

const slice = (x: Float32Array, a: number, b: number) => x.subarray(Math.round(a * SR), Math.round(b * SR));

describe('sampler notes with their own recordings', () => {
  it('two notes with different recordings play their own buffers at their own root pitch', async () => {
    // One-shots play their whole recording: 0.4 s each, so the notes do not overlap.
    const samples = provider({ own: toneBuffer([[220, 0.4]]), take1: toneBuffer([[440, 0.4]]), take2: toneBuffer([[660, 0.4]]) });
    const { out } = await renderNotes(samples, [
      // Recording 1 played at its root: its own pitch.
      { pitch: 60, velocity: 0.9, time: 0.05, duration: 0.3, sample: { id: 'take1', start: 0, end: 1, rootNote: 60 } },
      // Recording 2, root 64, played at 64: its own pitch too.
      { pitch: 64, velocity: 0.9, time: 0.6, duration: 0.3, sample: { id: 'take2', start: 0, end: 1, rootNote: 64 } },
      // The part's own recording when the note names none.
      { pitch: 60, velocity: 0.9, time: 1.2, duration: 0.3 },
    ]);
    const f1 = estimateFundamental(slice(out, 0.15, 0.4), SR);
    const f2 = estimateFundamental(slice(out, 0.7, 0.95), SR);
    const f3 = estimateFundamental(slice(out, 1.3, 1.55), SR);
    console.info(`[sampler-clip] take 1 ${f1.toFixed(1)} Hz, take 2 ${f2.toFixed(1)} Hz, the part's own ${f3.toFixed(1)} Hz`);
    expect(Math.abs(f1 - 440)).toBeLessThan(3);
    expect(Math.abs(f2 - 660)).toBeLessThan(4);
    expect(Math.abs(f3 - 220 * Math.pow(2, 0))).toBeLessThan(2);
  });

  it('a note transposes from its recording’s root, and plays only the region it names', async () => {
    // First half 300 Hz, second half 500 Hz.
    const samples = provider({ own: toneBuffer([[220, 0.4]]), take: toneBuffer([[300, 0.5], [500, 0.5]]) });
    const { out } = await renderNotes(samples, [
      // An octave over the root: twice as fast and high.
      { pitch: 72, velocity: 0.9, time: 0.05, duration: 0.2, sample: { id: 'take', start: 0, end: 0.5, rootNote: 60 } },
      // The second half only.
      { pitch: 60, velocity: 0.9, time: 0.6, duration: 0.3, sample: { id: 'take', start: 0.5, end: 1, rootNote: 60 } },
    ]);
    expect(Math.abs(estimateFundamental(slice(out, 0.08, 0.25), SR) - 600)).toBeLessThan(6);
    expect(Math.abs(estimateFundamental(slice(out, 0.7, 0.95), SR) - 500)).toBeLessThan(5);
  });

  it('a note whose recording is not loaded is skipped and counted, never thrown', async () => {
    const samples = provider({ own: toneBuffer([[220, 1]]) });
    const { out, engine } = await renderNotes(samples, [
      { pitch: 60, velocity: 0.9, time: 0.05, duration: 0.3, sample: { id: 'missing', start: 0, end: 1, rootNote: 60 } },
      { pitch: 60, velocity: 0.9, time: 0.5, duration: 0.3, sample: { id: 'missing', start: 0, end: 1, rootNote: 60 } },
    ]);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBe(0);
    expect(engine.getStats().skippedSampleNotes).toBe(2);
  });

  it('preloadSamples loads through the provider, once per id, and never rejects', async () => {
    const loads: string[] = [];
    const samples = provider({ a: toneBuffer([[440, 0.1]]) }, loads);
    const ctx = new OfflineAudioContext(2, SR, SR);
    const engine = await AudioEngine.create(ctx, { samples, seed: 1, meters: false });
    await engine.preloadSamples(['a', 'b', 'a']);
    expect(loads).toEqual(['a', 'b']);
    const failing: SampleProvider = { get: () => null, load: () => Promise.reject(new Error('gone')) };
    const e2 = await AudioEngine.create(new OfflineAudioContext(2, SR, SR), { samples: failing, seed: 1, meters: false });
    await expect(e2.preloadSamples(['x'])).resolves.toBeUndefined();
    // Without load(), get() is asked once per id (a built-in sample is generated there).
    const asked: string[] = [];
    const plain: SampleProvider = { get: (id) => (asked.push(id), null) };
    const e3 = await AudioEngine.create(new OfflineAudioContext(2, SR, SR), { samples: plain, seed: 1, meters: false });
    await e3.preloadSamples(['p', 'q']);
    expect(asked).toEqual(['p', 'q']);
    for (const e of [engine, e2, e3]) e.dispose();
  });

  it('a SampleBank fetches an imported recording through its loader on preload, and the note then plays it', async () => {
    const fetched: string[] = [];
    const recordings: Record<string, AudioBuffer> = { 'rec-1': toneBuffer([[440, 0.4]]) };
    const bank = new SampleBank(SR, async (id) => {
      fetched.push(id);
      await new Promise((r) => setTimeout(r, 5));
      return recordings[id] ?? null;
    });
    bank.add('own', toneBuffer([[220, 0.4]]));
    // Not loaded yet: get() does not fetch.
    expect(bank.get('rec-1')).toBeNull();
    const ctx = new OfflineAudioContext(2, SR, SR);
    const engine = await AudioEngine.create(ctx, { samples: bank, seed: 1, meters: false });
    // Concurrent preloads fetch once; an unknown id resolves without a buffer.
    await Promise.all([engine.preloadSamples(['rec-1', 'nope']), engine.preloadSamples(['rec-1'])]);
    expect(fetched.filter((id) => id === 'rec-1')).toHaveLength(1);
    expect(bank.get('rec-1')).toBe(recordings['rec-1']);
    expect(bank.get('nope')).toBeNull();
    engine.dispose();
    const { out, engine: e2 } = await renderNotes(bank, [{ pitch: 60, velocity: 0.9, time: 0.05, duration: 0.3, sample: { id: 'rec-1', start: 0, end: 1, rootNote: 60 } }], 1);
    expect(Math.abs(estimateFundamental(slice(out, 0.15, 0.4), SR) - 440)).toBeLessThan(3);
    expect(e2.getStats().skippedSampleNotes ?? 0).toBe(0);
    e2.dispose();
  });
});
