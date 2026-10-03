/**
 * Exporting while music plays: the music plays on. Building the export's
 * engine keeps the main thread busy for a moment; while an export runs, live
 * playback is scheduled further ahead, so such a block loses nothing. A block
 * longer than that never stops playback in a visible tab either (perf-01): the
 * missed stretch is skipped, nothing plays late, and the music goes on in
 * time. After the export the usual look-ahead is back; only a background tab
 * or a paused device stops playback, with a message that says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { STALL_MESSAGE, Session } from '../../src/app/session';
import { getStarter } from '../../src/content/starters';
import { deleteDb } from '../../src/persistence/db';

const rt = () => runtimeStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Keep the main thread busy (as building a big engine does). */
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* busy */
  }
}

let live: Session[] = [];
beforeEach(async () => {
  await deleteDb();
  patchRuntime({ stalled: null, playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null });
});
afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ stalled: null, playing: false, paused: false, mode: 'live' });
  await deleteDb();
});

/** The House starter's groove playing on the pads; returns the audio times of the notes the live engine got, and how late each was handed over. */
async function grooving(): Promise<{ s: Session; times: number[]; late: number[] }> {
  const s = new Session(getStarter('house')!.build());
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  const times: number[] = [];
  const late: number[] = [];
  const engine = s.engine!;
  const schedule = engine.scheduleNote.bind(engine);
  engine.scheduleNote = (trackId, n) => {
    times.push(n.time);
    late.push(s.ctx!.currentTime - n.time);
    return schedule(trackId, n);
  };
  await s.launchScene(1);
  await s.play();
  await sleep(400);
  expect(rt().playing).toBe(true);
  return { s, times, late };
}

/** Longest stretch without a note starting, over [from, to] (audio time). */
function longestGap(times: number[], from: number, to: number): number {
  const ts = [...new Set(times.filter((t) => t >= from && t <= to))].sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
  return Math.max(gap, ts.length ? ts[0] - from : to - from, ts.length ? to - ts[ts.length - 1] : 0);
}

describe('export while the music plays', () => {
  it('a slow export start (the main thread busy for 0.9 s) does not stop the music, and nothing goes missing', async () => {
    const { s, times } = await grooving();
    const t0 = s.ctx!.currentTime;
    let first = true;
    await s.renderWav({
      source: { kind: 'scene', row: 1, bars: 2 },
      sampleRate: 44100,
      bitDepth: 16,
      tailSeconds: 0,
      onProgress: () => {
        if (!first) return;
        first = false;
        block(900);
      },
    });
    expect(first).toBe(false);
    await sleep(300);
    const t1 = s.ctx!.currentTime;
    expect(rt()).toMatchObject({ playing: true, stalled: null });
    // The groove has notes at least every 16th (0.125 s at 120 BPM): no hole where the main thread was busy.
    expect(longestGap(times, t0, t1 - 0.2)).toBeLessThan(0.3);
  });

  it('a real export while it plays (the starter’s whole engine built offline): no stop', async () => {
    const { s } = await grooving();
    const blob = await s.renderWav({ source: { kind: 'scene', row: 1, bars: 4 }, sampleRate: 44100, bitDepth: 16, tailSeconds: 1 });
    expect(blob.size).toBeGreaterThan(1000);
    await sleep(200);
    expect(rt()).toMatchObject({ playing: true, stalled: null });
  }, 90000);

  it('the song playing while part of it is exported, with a slow start: the song plays on', async () => {
    const s = new Session(getStarter('house')!.build());
    live.push(s);
    expect(await s.startAudio()).toBe(true);
    await s.playSong(0);
    await sleep(400);
    expect(rt()).toMatchObject({ playing: true, mode: 'song' });
    const blocks = s.store.getState().arrangement.blocks;
    let first = true;
    const blob = await s.renderWav({
      source: { kind: 'songRange', fromBlockId: blocks[0].id, toBlockId: blocks[0].id },
      sampleRate: 44100,
      bitDepth: 16,
      tailSeconds: 0,
      onProgress: () => {
        if (!first) return;
        first = false;
        block(900);
      },
    });
    expect(blob.size).toBeGreaterThan(1000);
    await sleep(300);
    expect(rt()).toMatchObject({ playing: true, mode: 'song', stalled: null });
  }, 90000);

  it('busy for longer than playback can be held ahead: in a visible tab it skips the missed stretch and plays on, nothing late', async () => {
    const { s, late } = await grooving();
    let first = true;
    await s.renderWav({
      source: { kind: 'scene', row: 1, bars: 1 },
      sampleRate: 44100,
      bitDepth: 16,
      tailSeconds: 0,
      onProgress: () => {
        if (!first) return;
        first = false;
        block(2600);
      },
    });
    await sleep(800);
    expect(rt()).toMatchObject({ playing: true, stalled: null });
    expect(s.transport!.getStats().skips).toBeGreaterThanOrEqual(1);
    // No note was handed to the engine more than 10 ms after its time.
    expect(late.filter((d) => d > 0.01)).toEqual([]);
  });

  it('after the export the usual look-ahead is back; a long block plays on, only a background tab stops (and says so)', async () => {
    const { s, late } = await grooving();
    await s.renderWav({ source: { kind: 'scene', row: 1, bars: 1 }, sampleRate: 44100, bitDepth: 16, tailSeconds: 0 });
    expect(s.exporting).toBe(false);
    // What was scheduled ahead during the export plays out first (2 s); then the usual look-ahead.
    await sleep(2300);
    expect(rt()).toMatchObject({ playing: true, stalled: null });
    block(700);
    await sleep(500);
    expect(rt()).toMatchObject({ playing: true, stalled: null });
    expect(late.filter((d) => d > 0.01)).toEqual([]);
    // A throttled background tab stops playback, and the message says why.
    s.transport!.simulateStall(700);
    const until = performance.now() + 2000;
    while (rt().stalled === null && performance.now() < until) await sleep(20);
    expect(rt().stalled).toBe(STALL_MESSAGE);
    expect(rt().playing).toBe(false);
  });
});
