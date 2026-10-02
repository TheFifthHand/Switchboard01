/**
 * Session lifecycle with real Web Audio in Chromium: Mute All pressed before
 * audio started still silences the output; a failed audio start leaves no
 * live context behind and the next start works (with its recordings);
 * Resume after a stall restarts what was playing (song or take) and the pads
 * and keys work while the banner waits; Jump In always lands on the lit
 * Loops pads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { MeterFrame } from '../../src/audio/contracts';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { getStarter } from '../../src/content/starters';
import { deleteDb, putSample } from '../../src/persistence/db';
import type { Project, SampleMeta } from '../../src/project/types';
import { setPadMode, setView, uiStore } from '../../src/state/uiStore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const house = (): Project => getStarter('house')!.build();
const rt = () => runtimeStore.getState();

let live: Session[] = [];
function session(p: Project = house()): Session {
  const s = new Session(p);
  live.push(s);
  return s;
}

beforeEach(async () => {
  await deleteDb();
  patchRuntime({ muteAll: false, stalled: null, playing: false, mode: 'live', replayId: null, songBlock: null, audio: 'off', audioMessage: null });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ muteAll: false, stalled: null, playing: false });
  await deleteDb();
});

/** Loudest master peak over `ms` of real output. */
async function peakOver(s: Session, ms: number): Promise<number> {
  const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
  let peak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    s.readMeters(frame);
    peak = Math.max(peak, frame.masterPeakL, frame.masterPeakR);
    await sleep(25);
  }
  return peak;
}

async function until(fn: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A short 16-bit mono WAV (a decaying tone). */
function wav(seconds = 0.2, sr = 44100): Blob {
  const n = Math.round(seconds * sr);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 330 * i) / sr) * Math.exp(-i / (sr * 0.1)) * 20000), true);
  return new Blob([buf], { type: 'audio/wav' });
}

describe('Mute All before audio starts', () => {
  it('stays muted when the first Play creates the audio engine, and unmuting brings the sound back', async () => {
    const s = session();
    s.setMuteAll(true);
    expect(rt().muteAll).toBe(true);
    await s.play();
    expect(rt().playing).toBe(true);
    await sleep(400);
    expect(await peakOver(s, 900)).toBeLessThan(1e-4);
    s.setMuteAll(false);
    await sleep(300);
    expect(await peakOver(s, 1200)).toBeGreaterThan(0.01);
  });
});

describe('A failed audio start', () => {
  it('closes its context, and the next gesture starts audio afresh with the recordings loaded', async () => {
    const meta: SampleMeta = { id: 'smp_wp1_tone', name: 'Tone', mime: 'audio/wav', byteLength: 0, duration: 0.2, sampleRate: 44100, channels: 1 };
    const blob = wav();
    meta.byteLength = blob.size;
    await putSample(meta, blob);
    const p = house();
    p.samples = [meta];
    const s = session(p);

    let first: BaseAudioContext | null = null;
    vi.spyOn(AudioEngine, 'create').mockImplementationOnce(async (ctx) => {
      first = ctx;
      throw new Error('The audio worklet could not load.');
    });
    expect(await s.startAudio()).toBe(false);
    expect(rt().audio).toBe('error');
    expect(rt().audioMessage).toContain('The audio worklet could not load.');
    // No second live context is left behind.
    await until(() => first?.state === 'closed', 'the failed context to close');
    expect(s.ctx).toBeNull();

    // The next press starts audio for real.
    expect(await s.startAudio()).toBe(true);
    expect(s.ctx).not.toBe(first);
    expect(s.ctx!.state).toBe('running');
    expect(rt().audio).toBe('running');
    // The recording is decoded into the new bank instead of being taken as "already loaded".
    expect(s.bank!.get(meta.id)).not.toBeNull();
  });
});

describe('A busy moment in a visible tab (perf-01)', () => {
  it('playback skips the missed stretch and plays on; a performance take keeps recording through it and ends only on Stop', async () => {
    const s = session();
    await s.play();
    await s.togglePerformance();
    expect(rt().recording).toBe('performance');
    await sleep(400);
    const before = s.transport!.getStats().skips;
    // The main thread busy for well over the scheduling margin, in a visible tab with audio running.
    s.transport!.simulateStall(1400, { hidden: false });
    await sleep(1700);
    expect(s.transport!.getStats().skips).toBeGreaterThan(before);
    expect(rt()).toMatchObject({ playing: true, stalled: null, recording: 'performance' });
    // At most one quiet notice, and never the stop banner.
    expect(rt().notice?.text ?? '').not.toMatch(/stopped/i);
    await sleep(300);
    s.stop();
    const perf = s.store.getState().performances.at(-1)!;
    expect(perf).toBeTruthy();
    // The take covers the whole time it ran (2.4 s at the starter's tempo), skip included.
    const seconds = ((perf.endTick - perf.startTick) / 96) * (60 / s.store.getState().bpm);
    expect(seconds).toBeGreaterThan(2);
  });
});

describe('Resume after a stall', () => {
  it('resumes the song from the block that was playing', async () => {
    const s = session();
    await s.playSong(1);
    expect(rt().mode).toBe('song');
    await sleep(250);
    s.transport!.simulateStall(700);
    await until(() => rt().stalled !== null, 'the stall');
    expect(rt().playing).toBe(false);
    expect(rt().mode).toBe('live');

    await s.resumeAfterStall();
    expect(rt().stalled).toBeNull();
    expect(rt().playing).toBe(true);
    expect(rt().mode).toBe('song');
    expect(rt().songBlock).toBe(1);
    expect(s.transport!.playing).toBe(true);
  });

  it('after a stall during a replay, keys work while the banner waits, and Resume replays the take', async () => {
    const s = session();
    await s.play();
    await s.togglePerformance();
    await sleep(900);
    await s.togglePerformance();
    const perf = s.store.getState().performances[0];
    expect(perf).toBeTruthy();

    await s.replayPerformance(perf.id);
    expect(rt().mode).toBe('replay');
    await sleep(250);
    s.transport!.simulateStall(700);
    await until(() => rt().stalled !== null, 'the stall');
    expect(rt().replayId).toBeNull();
    expect(rt().mode).toBe('live');

    // Keys play again (a replay ignores them; the stall ended the replay).
    s.noteOn('t4', 60, 0.8, 'keyboard');
    expect(rt().held.t4 ?? []).toHaveLength(1);
    s.noteOff('t4', 60, 'keyboard');
    expect(rt().held.t4 ?? []).toHaveLength(0);

    await s.resumeAfterStall();
    expect(rt().playing).toBe(true);
    expect(rt().mode).toBe('replay');
    expect(rt().replayId).toBe(perf.id);
  });

  it('Resume only clears the banner when playback was restarted another way (Record Notes keeps recording)', async () => {
    const s = session();
    await s.playSong(1);
    await sleep(250);
    s.transport!.simulateStall(700);
    await until(() => rt().stalled !== null, 'the stall');
    // Record Notes starts the transport again while the banner still shows.
    await s.toggleRecordNotes();
    expect(rt().recording).toBe('notes');
    expect(s.transport!.playing).toBe(true);

    await s.resumeAfterStall();
    expect(rt().stalled).toBeNull();
    expect(rt().recording).toBe('notes');
    expect(rt().mode).toBe('live');
    expect(s.transport!.playing).toBe(true);
    s.stop();
  });

  it('resumes the live pads with the same clips', async () => {
    const s = session();
    await s.play();
    const before = { ...rt().tracks };
    const playingParts = Object.entries(before).filter(([, t]) => t.playingSlot !== null || t.queued?.slot != null).map(([id]) => id);
    expect(playingParts.length).toBeGreaterThan(0);
    await sleep(250);
    s.transport!.simulateStall(700);
    await until(() => rt().stalled !== null, 'the stall');
    await s.resumeAfterStall();
    expect(rt().mode).toBe('live');
    expect(rt().playing).toBe(true);
    await until(() => playingParts.every((id) => rt().tracks[id]?.playingSlot !== null), 'the same parts to play');
  });
});

describe('Jump In', () => {
  it('lands on the Play view with the Loops pads, whatever view was left open last time', async () => {
    setView('arrange');
    setPadMode('steps');
    const s = session();
    await s.jumpIn();
    expect(uiStore.getState().view).toBe('play');
    expect(uiStore.getState().padMode).toBe('loops');
    expect(rt().playing).toBe(true);
  });
});
