/**
 * Song looping with the real session, transport and engine in Chromium:
 *  - a one-block loop repeats: its 'block' event comes at every pass, the
 *    lane playhead (songTimelineBar) goes back to the block's start each
 *    time, every pass plays the block's notes, and the transport readout
 *    follows the lane; cleared, the pass playing ends and the song goes on
 *    to the next block and its end;
 *  - the session keeps the loop valid when its blocks are deleted (the views
 *    only read runtime.songLoop);
 *  - Resume after a stall starts inside the loop.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session as appSession } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { TransportBar } from '../../src/app/views/TransportBar';
import { getSongPlan, songTimelineBar } from '../../src/app/songPlayback';
import { createClip, createProject } from '../../src/project/factory';
import type { Clip, ClipBars, Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { deleteDb } from '../../src/persistence/db';
import type { SeqEvent } from '../../src/time/contracts';
import { TipsProvider } from '../../src/ui/components';
import { cleanup, mount } from './ui-harness';

const BAR = 384;
const rt = () => runtimeStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 10000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function clip(name: string, bars: ClipBars, notes: [tick: number, pitch: number, duration: number][]): Clip {
  return createClip(name, bars, notes.map(([tick, pitch, duration]) => ({ tick, pitch, duration, velocity: 0.9 })));
}

const track = (p: Project, id: Id) => p.tracks.find((t) => t.id === id)!;

/** Four scenes; t1 plays one note on every bar of each row's clip (pitch 36 + row). Song: b0 b1 b2 b3, b1 twice (2 bars). */
function loopSong(bpm: number): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 1;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  for (let row = 0; row < 4; row++) track(p, 't1').clips[row] = clip(`r${row}`, 1, [[0, 36 + row, 48]]);
  p.arrangement = { tailSeconds: 0, blocks: p.scenes.map((s, i) => ({ id: `b${i}`, sceneId: s.id, repeats: i === 1 ? 2 : 1 })) };
  return p;
}

const reset = () => patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songBlock: null, songBlockId: null, songLoop: null });

let live: Session[] = [];

beforeEach(async () => {
  await deleteDb();
  reset();
});

afterEach(async () => {
  cleanup();
  for (const s of live) {
    s.setSongLoop(null);
    s.dispose();
  }
  live = [];
  appSession.setSongLoop(null);
  if (appSession.playing || appSession.paused) act(() => appSession.stop());
  reset();
  await deleteDb();
});

describe('a song loop with the real session and transport', () => {
  it('one block repeats (block events, lane playhead and readout go back each pass); cleared, the song goes on to the next block and ends', async () => {
    // 220 BPM: a bar is ~1.09 s. b1 is lane bars 2-3 ([384, 1152) in ticks).
    const p = loopSong(220);
    appSession.store.replace(p, { resetHistory: true });
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    const timer = () => m.container.querySelector('[role="timer"]')!.textContent ?? '';
    expect(await appSession.startAudio()).toBe(true);
    expect(appSession.setSongLoop({ fromBlockId: 'b1', toBlockId: 'b1' })).toBe(true);
    expect(rt().songLoop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    const events: SeqEvent[] = [];
    const notes: { tick: number; pitch: number }[] = [];
    const t = appSession.transport!;
    const offs = [t.on('block', (e) => events.push(e)), t.on('end', (e) => events.push(e))];
    const engine = appSession.engine!;
    const schedule = engine.scheduleNote.bind(engine);
    engine.scheduleNote = (trackId, n) => {
      if (trackId === 't1') notes.push({ tick: Math.round(appSession.sequencer!.tickAt(n.time)), pitch: n.pitch });
      return schedule(trackId, n);
    };
    try {
      // Play song: from the loop's first block.
      await act(async () => {
        await appSession.playSong();
      });
      expect(t.getPosition().tick).toBe(BAR);
      expect(rt()).toMatchObject({ mode: 'song', songBlockId: 'b1' });
      // The plan the views read repeats b1 (same id) after itself.
      expect(getSongPlan()!.filter((b) => b.startTick >= BAR).map((b) => b.blockId).slice(0, 2)).toEqual(['b1', 'b1']);

      // Three passes and the start of a fourth, sampled.
      const samples: { tick: number; bar: number; text: string; id: Id | null }[] = [];
      while (t.getPosition().tick < 7 * BAR + 60) {
        await act(async () => {
          await sleep(35);
        });
        const at = t.getPosition().tick;
        samples.push({ tick: at, bar: songTimelineBar(at)!, text: timer(), id: rt().songBlockId });
      }
      const blocks = events.filter((e): e is Extract<SeqEvent, { kind: 'block' }> => e.kind === 'block');
      expect(blocks.slice(0, 4).map((b) => [b.tick, b.blockId])).toEqual([[BAR, 'b1'], [3 * BAR, 'b1'], [5 * BAR, 'b1'], [7 * BAR, 'b1']]);
      // The lane playhead stays on b1 (lane bars [1, 3)) and goes back to its start at every pass.
      for (const s of samples) {
        expect(s.bar).toBeGreaterThanOrEqual(1);
        expect(s.bar).toBeLessThan(3);
        expect(s.id).toBe('b1');
        if (s.text) expect(['2', '3']).toContain(s.text.split('.')[0]);
      }
      const backs = samples.filter((s, i) => i > 0 && s.bar < samples[i - 1].bar - 1);
      expect(backs.length).toBe(3);
      for (const s of backs) expect(s.bar).toBeLessThan(1.2);
      // The readout goes back too: from bar 3 to bar 2 of the lane.
      expect(samples.some((s, i) => i > 0 && s.text.startsWith('2.') && samples[i - 1].text.startsWith('3.'))).toBe(true);
      // Every pass plays b1's notes: one note (pitch 37) on each bar.
      const played = notes.filter((n) => n.tick < 7 * BAR);
      expect(played.map((n) => [n.tick, n.pitch])).toEqual([1, 2, 3, 4, 5, 6].map((k) => [k * BAR, 37]));
      expect(events.some((e) => e.kind === 'end')).toBe(false);

      // Cleared: the pass playing ends as usual, then b2, b3 and the end.
      const passEnd = Math.ceil((t.getPosition().tick - BAR) / (2 * BAR)) * 2 * BAR + BAR;
      act(() => void appSession.setSongLoop(null));
      expect(rt().songLoop).toBeNull();
      await until(() => events.some((e) => e.kind === 'end'), 'the end', 15000);
      const after = events.filter((e) => e.tick >= passEnd).map((e) => [e.kind, e.tick, 'blockId' in e ? e.blockId : null]);
      expect(after).toEqual([['block', passEnd, 'b2'], ['block', passEnd + BAR, 'b3'], ['end', passEnd + 2 * BAR, null]]);
      await until(() => !rt().playing, 'the stop at the end');
    } finally {
      engine.scheduleNote = schedule;
      for (const off of offs) off();
    }
  });

  it('set while the song plays before it: playback continues at the loop at the next bar line; the plan the views read repeats it', async () => {
    const s = new Session(loopSong(220));
    live.push(s);
    expect(await s.startAudio()).toBe(true);
    const blocks: [number, Id][] = [];
    s.transport!.on('block', (e) => blocks.push([e.tick, e.blockId]));
    await s.playSong(0);
    await until(() => s.transport!.getPosition().tick > 40, 'b0');
    expect(s.setSongLoop({ fromBlockId: 'b3', toBlockId: 'b3' })).toBe(true);
    await until(() => blocks.filter(([, id]) => id === 'b3').length >= 3, 'three passes of b3', 15000);
    expect(blocks.slice(0, 4)).toEqual([[0, 'b0'], [BAR, 'b3'], [2 * BAR, 'b3'], [3 * BAR, 'b3']]);
    // The sequencer's plan repeats b3 (same id) ahead of the playhead.
    expect(s.sequencer!.songPlan()!.filter((b) => b.blockId === 'b3' && b.endTick > s.transport!.getPosition().tick).length).toBeGreaterThanOrEqual(1);
  });
});

describe('the session owns the loop', () => {
  it('a block of the loop deleted: the loop shrinks to what is left (Undo brings it back); every block deleted: cleared (Undo brings it back)', async () => {
    const s = new Session(loopSong(120));
    live.push(s);
    expect(s.setSongLoop({ fromBlockId: 'b1', toBlockId: 'b3' })).toBe(true);
    // A block that is not in the song is refused.
    expect(s.setSongLoop({ fromBlockId: 'nope', toBlockId: 'b3' })).toBe(false);
    expect(rt().songLoop).toEqual({ fromBlockId: 'b1', toBlockId: 'b3' });
    cmd.removeBlocks(s.store, ['b3']);
    expect(rt().songLoop).toEqual({ fromBlockId: 'b1', toBlockId: 'b2' });
    // Undo brings the block back, and the loop with it; Redo shrinks it again.
    s.store.undo();
    expect(rt().songLoop).toEqual({ fromBlockId: 'b1', toBlockId: 'b3' });
    s.store.redo();
    expect(rt().songLoop).toEqual({ fromBlockId: 'b1', toBlockId: 'b2' });
    cmd.removeBlocks(s.store, ['b1']);
    expect(rt().songLoop).toEqual({ fromBlockId: 'b2', toBlockId: 'b2' });
    cmd.removeBlocks(s.store, ['b2']);
    expect(rt().songLoop).toBeNull();
    s.store.undo();
    expect(rt().songLoop).toEqual({ fromBlockId: 'b2', toBlockId: 'b2' });
  });

  it('while the song plays: deleting the loop’s last block keeps playback in the loop that is left', async () => {
    const s = new Session(loopSong(220));
    live.push(s);
    expect(await s.startAudio()).toBe(true);
    s.setSongLoop({ fromBlockId: 'b1', toBlockId: 'b2' });
    const blocks: [number, Id][] = [];
    s.transport!.on('block', (e) => blocks.push([e.tick, e.blockId]));
    await s.playSong();
    await until(() => s.transport!.getPosition().tick > BAR + 40, 'b1');
    cmd.removeBlocks(s.store, ['b2']);
    expect(rt().songLoop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    await until(() => blocks.length >= 3, 'two passes after the edit', 15000);
    expect(blocks.slice(0, 3)).toEqual([[BAR, 'b1'], [3 * BAR, 'b1'], [5 * BAR, 'b1']]);
  });

  it('Resume after a stall starts inside the loop (at its first block when the music stopped outside it)', async () => {
    // 60 BPM: a bar is 4 s, so the stall comes while b0 still plays, before the loop.
    const s = new Session(loopSong(60));
    live.push(s);
    s.setSongLoop({ fromBlockId: 'b2', toBlockId: 'b2' });
    await s.playSong(0);
    await until(() => (s.transport?.getPosition().tick ?? 0) > 20, 'b0');
    s.transport!.simulateStall(700);
    await until(() => rt().stalled !== null, 'the stall');
    await s.resumeAfterStall();
    expect({ songBlockId: rt().songBlockId, tick: s.transport!.getPosition().tick }).toEqual({ songBlockId: 'b2', tick: 3 * BAR });
  });
});
