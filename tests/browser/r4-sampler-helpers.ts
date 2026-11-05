/**
 * Shared set-up for the round-4 sampler and sound browser tests: the whole
 * app (House starter) through the Play slice's helpers, the Shape view on a
 * part, generated test audio (made here, never stored in the repository),
 * offline renders of one part, and a pitch measurement.
 */
import { act } from 'react';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { session } from '../../src/app/instance';
import * as db from '../../src/persistence/db';
import type { Id, Project } from '../../src/project/types';
import { rms } from '../../src/render/analysis';
import { renderOffline } from '../../src/render/offline';
import { encodeWav } from '../../src/render/wav';
import { selectTrack, setUiMode, setView } from '../../src/state/uiStore';
import { settleFrames } from './r4-uikit-input';

export { SIZES, clickEl, dragEl, openApp, press, setUp, tearDown, until, button, described, noticesDuring } from './r4-play-helpers';

export const SR = 48000;
export const project = (): Project => session.store.getState();
export const track = (id: Id) => project().tracks.find((t) => t.id === id)!;

/** The Shape view in Advanced (where the sampler editor is) on part `trackId`. */
export async function shapeOn(trackId: Id): Promise<void> {
  act(() => {
    setUiMode('advanced');
    setView('shape');
    selectTrack(trackId);
  });
  await settleFrames(3);
}

/**
 * A drum-like loop: `bars` bars at `bpm` of 8th-note hits, each a burst of
 * `hz` (sine) decaying over about 0.1 s. Mono, 16-bit.
 */
export function loopWav(name: string, opts: { bars?: number; bpm?: number; hz?: number; rate?: number } = {}): File {
  const bars = opts.bars ?? 2;
  const bpm = opts.bpm ?? 100;
  const hz = opts.hz ?? 440;
  const rate = opts.rate ?? SR;
  const seconds = (bars * 4 * 60) / bpm;
  const x = new Float32Array(Math.round(seconds * rate));
  const step = 60 / bpm / 2;
  for (let hit = 0; hit * step < seconds - 1e-9; hit++) {
    const at = Math.round(hit * step * rate);
    for (let i = 0; i < Math.round(0.25 * rate) && at + i < x.length; i++) x[at + i] += 0.6 * Math.sin((2 * Math.PI * hz * i) / rate) * Math.exp(-i / (0.1 * rate));
  }
  return new File([encodeWav([x], rate, 16)], name, { type: 'audio/wav' });
}

/** Short clicks (1 ms) at `times` seconds in an otherwise silent file of `seconds`. */
export function clicksWav(name: string, seconds: number, times: readonly number[]): File {
  const x = new Float32Array(Math.round(seconds * SR));
  for (const t of times) {
    const at = Math.round(t * SR);
    for (let i = 0; i < 48 && at + i < x.length; i++) x[at + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SR) * (1 - i / 48);
  }
  return new File([encodeWav([x], SR, 16)], name, { type: 'audio/wav' });
}

/** A bank holding the project's imported recordings (from browser storage), as an export makes it. */
async function bankFor(p: Project): Promise<SampleBank> {
  const bank = new SampleBank(SR);
  const ctx = new OfflineAudioContext(2, 1, SR);
  for (const s of p.samples) {
    const rec = await db.getSample(s.id);
    if (rec) bank.add(s.id, await ctx.decodeAudioData(await rec.blob.arrayBuffer()));
  }
  return bank;
}

/** Render scene `row` (`bars` bars) with only `trackId` sounding and no reverb or echo: what that part plays there. */
export async function renderPart(p: Project, trackId: Id, row: number, bars = 2): Promise<Float32Array> {
  const solo: Project = structuredClone(p);
  for (const t of solo.tracks) {
    t.mute = t.id !== trackId;
    t.solo = false;
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  const bank = await bankFor(solo);
  const buf = await renderOffline({
    project: solo,
    source: { kind: 'scene', row, bars },
    sampleRate: SR,
    tailSeconds: 0.3,
    align: true,
    mastering: false,
    createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: solo.seed, meters: false }),
  });
  return buf.getChannelData(0).slice();
}

/** Energy of `x` at `hz` (Goertzel over the whole buffer, normalised). */
export function energyAt(x: Float32Array, hz: number, rate = SR): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / x.length;
}

/** The semitone offset (−12…+12) whose frequency from `hz` holds the most energy in `x`. */
export function strongestSemitone(x: Float32Array, hz: number): number {
  let best = 0;
  let bestE = -1;
  for (let st = -12; st <= 12; st++) {
    const e = energyAt(x, hz * 2 ** (st / 12));
    if (e > bestE) {
      bestE = e;
      best = st;
    }
  }
  return best;
}

/** How different two renders are (RMS of the difference over the RMS of `b`). */
export function difference(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = a[i] - b[i];
  return rms(d) / Math.max(1e-9, rms(b.subarray(0, n)));
}

/** Recordings stored by a test, to remove afterwards. */
export async function forgetSamples(ids: Iterable<Id>): Promise<void> {
  for (const id of ids) await db.deleteSample(id).catch(() => undefined);
}
