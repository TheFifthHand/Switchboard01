/**
 * Edits while the song plays, with the real session and transport in
 * Chromium:
 *  - deleting the playing clip of the block that plays (or dragging it to
 *    another part), then Undo: the part is silent at once and comes straight
 *    back, in phase (H1);
 *  - a split while a later pass plays changes nothing you hear, the runtime
 *    follows the block that now covers the playhead and the readout stays;
 *  - the block that plays shortened below the playhead, or deleted: the
 *    readout and the lane playhead wait at the hand-over position (never
 *    past it, never back) until the next block takes over at the bar line,
 *    and the runtime never names the deleted block (L2);
 *  - a stall while a deleted block hands over: Resume goes on with the block
 *    that takes over, not with the first block (L1).
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session as appSession } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { TransportBar } from '../../src/app/views/TransportBar';
import { songTimelineBar } from '../../src/app/views/arrange/songPlan';
import { createClip, createProject } from '../../src/project/factory';
import type { Clip, ClipBars, Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { deleteDb } from '../../src/persistence/db';
import type { SeqEvent } from '../../src/time/contracts';
import { TipsProvider } from '../../src/ui/components';
import { cleanup, mount } from './ui-harness';

const BAR = 384;
const BEAT = 96;
const rt = () => runtimeStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
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

/** No clips anywhere, no reverb or delay sends, fixed seed. */
function emptyProject(bpm: number): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 1;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  return p;
}

/** 220 BPM. t4 plays a note on every beat in row 0. Song: one block, row 0, 8 passes (8 bars). */
function beatSong(): Project {
  const p = emptyProject(220);
  track(p, 't4').clips[0] = clip('beats', 1, [[0, 60, 48], [96, 62, 48], [192, 64, 48], [288, 65, 48]]);
  p.arrangement = { tailSeconds: 0, blocks: [{ id: 'b0', sceneId: p.scenes[0].id, repeats: 8 }] };
  return p;
}

/** Four one-bar scenes; each row's clip on t1 has one note on the bar. Song: b0 b1 b2 b3, one pass each. */
function quickSong(bpm: number): Project {
  const p = emptyProject(bpm);
  for (let row = 0; row < 4; row++) track(p, 't1').clips[row] = clip(`r${row}`, 1, [[0, 36 + row, 48]]);
  p.arrangement = { tailSeconds: 1, blocks: p.scenes.map((s, i) => ({ id: `b${i}`, sceneId: s.id, repeats: 1 })) };
  return p;
}

let live: Session[] = [];

beforeEach(async () => {
  await deleteDb();
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songBlock: null, songBlockId: null });
});

afterEach(async () => {
  cleanup();
  for (const s of live) s.dispose();
  live = [];
  if (appSession.playing || appSession.paused) act(() => appSession.stop());
  patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, stalled: null });
  await deleteDb();
});

/** A session playing `p` as a song, with every note it schedules recorded (transport tick, part). */
async function playing(p: Project): Promise<{ s: Session; notes: { tick: number; trackId: Id }[] }> {
  const s = new Session(p);
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  const notes: { tick: number; trackId: Id }[] = [];
  const engine = s.engine!;
  const schedule = engine.scheduleNote.bind(engine);
  engine.scheduleNote = (trackId, n) => {
    notes.push({ tick: Math.round(s.sequencer!.tickAt(n.time)), trackId });
    return schedule(trackId, n);
  };
  await s.playSong(0);
  return { s, notes };
}

/** Every beat in [from, to]. */
function beatsIn(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(from / BEAT) * BEAT; t <= to; t += BEAT) out.push(t);
  return out;
}

describe('clip edits in Play while the song plays, then Undo (H1)', () => {
  it('delete the playing clip, Undo at once: the part keeps playing', async () => {
    const { s, notes } = await playing(beatSong());
    await until(() => s.transport!.getPosition().tick > BAR + 40, 'bar 2');
    const editTick = s.transport!.getPosition().tick;
    cmd.deleteClip(s.store, 't4', 0);
    s.store.undo();
    expect(track(s.store.getState(), 't4').clips[0]).not.toBeNull();
    await until(() => s.transport!.getPosition().tick > 4 * BAR + 40, 'bar 5');
    s.stop();
    const after = notes.filter((n) => n.trackId === 't4' && n.tick > editTick + 30 && n.tick <= 4 * BAR).map((n) => n.tick);
    expect(after).toEqual(beatsIn(editTick + 31, 4 * BAR));
  });

  it('move the playing clip to another part, Undo at once: the part keeps playing', async () => {
    const { s, notes } = await playing(beatSong());
    await until(() => s.transport!.getPosition().tick > BAR + 40, 'bar 2');
    const editTick = s.transport!.getPosition().tick;
    expect(s.accepted(cmd.moveClip(s.store, 't4', 0, 't6', 3))).toBe(true);
    s.store.undo();
    await until(() => s.transport!.getPosition().tick > 4 * BAR + 40, 'bar 5');
    s.stop();
    const after = notes.filter((n) => n.trackId === 't4' && n.tick > editTick + 30 && n.tick <= 4 * BAR).map((n) => n.tick);
    expect(after).toEqual(beatsIn(editTick + 31, 4 * BAR));
    // The clip never sounded on the part it visited (its row is not in the block).
    expect(notes.filter((n) => n.trackId === 't6')).toEqual([]);
  });

  it('while paused: delete (or move away) the playing clip, Undo, Play: the part plays on', async () => {
    for (const edit of ['delete', 'move'] as const) {
      const { s, notes } = await playing(beatSong());
      await until(() => s.transport!.getPosition().tick > BAR + 40, 'bar 2');
      s.pause();
      const pauseTick = s.transport!.getPosition().tick;
      if (edit === 'delete') cmd.deleteClip(s.store, 't4', 0);
      else expect(s.accepted(cmd.moveClip(s.store, 't4', 0, 't6', 3))).toBe(true);
      s.store.undo();
      await s.play();
      await until(() => s.transport!.getPosition().tick > 4 * BAR + 40, 'bar 5');
      s.stop();
      const after = notes.filter((n) => n.trackId === 't4' && n.tick > pauseTick + 30 && n.tick <= 4 * BAR).map((n) => n.tick);
      expect({ edit, after }).toEqual({ edit, after: beatsIn(pauseTick + 31, 4 * BAR) });
    }
  });

  it('delete the playing clip: the part is silent at once; Undo a bar later brings it straight back, in phase', async () => {
    const { s, notes } = await playing(beatSong());
    await until(() => s.transport!.getPosition().tick > BAR + 40, 'bar 2');
    const editTick = s.transport!.getPosition().tick;
    cmd.deleteClip(s.store, 't4', 0);
    // The pad shows the part stopped.
    await until(() => rt().tracks.t4?.playingSlot === null, 'the part to stop');
    await until(() => s.transport!.getPosition().tick > editTick + BAR, 'a bar later');
    const undoTick = s.transport!.getPosition().tick;
    s.store.undo();
    await until(() => s.transport!.getPosition().tick > 5 * BAR + 40, 'bar 6');
    s.stop();
    const t4 = notes.filter((n) => n.trackId === 't4').map((n) => n.tick);
    expect(t4.filter((t) => t > editTick + 30 && t < undoTick)).toEqual([]);
    expect(t4.filter((t) => t > undoTick + 30 && t <= 5 * BAR)).toEqual(beatsIn(undoTick + 31, 5 * BAR));
  });
});

describe('a split while a later pass plays (real session)', () => {
  it('changes nothing you hear: the runtime follows the second half, no block event, the lane playhead stays', async () => {
    const p = quickSong(120);
    p.arrangement.blocks[1].repeats = 2;
    const s = new Session(p);
    live.push(s);
    expect(await s.startAudio()).toBe(true);
    const got: SeqEvent[] = [];
    s.transport!.on('block', (e) => got.push(e));
    s.transport!.on('launch', (e) => got.push(e));
    await s.playSong(1);
    // b1 [384, 1152): its second pass starts at 768.
    await until(() => s.transport!.getPosition().tick > 2 * BAR + 60, 'the second pass of b1');
    const before = got.length;
    cmd.splitBlock(s.store, 'b1', 1);
    const second = s.store.getState().arrangement.blocks[2].id;
    expect(rt()).toMatchObject({ songBlock: 2, songBlockId: second });
    expect(s.sequencer!.songPlan()!.map((b) => [b.blockId, b.startTick, b.endTick])).toEqual([['b0', 0, 384], ['b1', 384, 768], [second, 768, 1152], ['b2', 1152, 1536], ['b3', 1536, 1920]]);
    await until(() => got.some((e) => e.kind === 'block' && e.blockId === 'b2'), 'b2');
    // Only b2's start: no block event for the second half, no switch for t1 before b2.
    expect(got.slice(before).map((e) => [e.kind, e.tick])).toEqual([['block', 1152], ['launch', 1152]]);
  });
});

describe('the readout and the lane playhead while a block hands over (L2)', () => {
  /** The transport readout, mounted. */
  function readout(): () => string {
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    return () => m.container.querySelector('[role="timer"]')!.textContent ?? '';
  }

  /** Bar.beat as one comparable number. */
  const value = (text: string) => {
    const [bar, beat] = text.split('.').map(Number);
    return bar * 10 + beat;
  };

  /** Sample the lane playhead and the readout until the transport passes `tick`. */
  async function sampleUntil(tick: number, timer: () => string): Promise<{ tick: number; bar: number; text: string; id: Id | null }[]> {
    const out: { tick: number; bar: number; text: string; id: Id | null }[] = [];
    while (appSession.transport!.getPosition().tick < tick) {
      await act(async () => {
        await sleep(40);
      });
      const at = appSession.transport!.getPosition().tick;
      out.push({ tick: at, bar: songTimelineBar(at)!, text: timer(), id: rt().songBlockId });
    }
    return out;
  }

  function forward(samples: { bar: number; text: string }[]): void {
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].bar).toBeGreaterThanOrEqual(samples[i - 1].bar);
      expect(value(samples[i].text)).toBeGreaterThanOrEqual(value(samples[i - 1].text));
    }
  }

  it('the playing block shortened below the playhead: they wait at its end on the lane, then follow the next block', async () => {
    // 120 BPM: b1 plays two passes of a one-bar scene, [384, 1152). Shorten it to one pass during the second.
    const p = quickSong(120);
    p.arrangement.blocks[1].repeats = 2;
    appSession.store.replace(p, { resetHistory: true });
    const timer = readout();
    await act(async () => {
      await appSession.playSong(1);
    });
    await until(() => appSession.transport!.getPosition().tick > 2 * BAR + 60, 'the second pass of b1');
    act(() => void cmd.setBlockRepeats(appSession.store, 'b1', 1));
    // Lane: b0 [0,1) b1 [1,2) b2 [2,3) b3 [3,4). b1 sounds on to tick 1152; meanwhile the playhead waits at bar 2.
    expect(appSession.sequencer!.songPlan()!.find((b) => b.blockId === 'b1')!.endTick).toBe(3 * BAR);
    const samples = await sampleUntil(3 * BAR + 2 * BEAT, timer);
    const waiting = samples.filter((x) => x.tick < 3 * BAR - 10);
    expect(waiting.length).toBeGreaterThan(3);
    for (const x of waiting) expect({ bar: x.bar, text: x.text, id: x.id }).toEqual({ bar: 2, text: '3.1', id: 'b1' });
    forward(samples);
    expect(value(samples.at(-1)!.text)).toBeGreaterThan(value('3.1'));
    expect(rt().songBlockId).toBe('b2');
  });

  it('the playing block deleted: they wait where the next block starts, the runtime already names it; it takes over at the bar line', async () => {
    const p = quickSong(120);
    p.arrangement.blocks[1].repeats = 2;
    appSession.store.replace(p, { resetHistory: true });
    const timer = readout();
    const blocks: [number, Id][] = [];
    await act(async () => {
      await appSession.playSong(1);
    });
    await until(() => appSession.transport!.getPosition().tick > 2 * BAR + 60, 'the second pass of b1');
    const off = appSession.transport!.on('block', (e) => blocks.push([e.tick, e.blockId]));
    act(() => void cmd.removeBlocks(appSession.store, ['b1']));
    // Lane: b0 [0,1) b2 [1,2) b3 [2,3). b1 sounds on to tick 1152; the playhead waits at bar 1 where b2 starts.
    expect(rt()).toMatchObject({ songBlock: 1, songBlockId: 'b2' });
    const samples = await sampleUntil(3 * BAR + 2 * BEAT, timer);
    const waiting = samples.filter((x) => x.tick < 3 * BAR - 10);
    expect(waiting.length).toBeGreaterThan(3);
    for (const x of waiting) expect({ bar: x.bar, text: x.text, id: x.id }).toEqual({ bar: 1, text: '2.1', id: 'b2' });
    forward(samples);
    expect(value(samples.at(-1)!.text)).toBeGreaterThan(value('2.1'));
    expect(blocks).toEqual([[3 * BAR, 'b2']]);
    off();
  });
});

describe('a stall while a deleted block hands over (L1)', () => {
  it('Resume goes on with the block that takes over, not with the first block', async () => {
    const s = new Session(quickSong(60));
    live.push(s);
    await s.playSong(1);
    await until(() => rt().songBlockId === 'b1' && s.transport!.getPosition().tick > BAR + 50, 'block b1');
    // Delete the playing block: it sounds on to the next bar line (tick 768, 3 s away), where b2 takes over.
    cmd.removeBlocks(s.store, ['b1']);
    expect(rt()).toMatchObject({ songBlock: 1, songBlockId: 'b2' });
    s.transport!.simulateStall(700);
    await until(() => rt().stalled !== null, 'the stall');
    await s.resumeAfterStall();
    // Lane: b0 b2 b3: the song goes on with b2 (lane bar 2).
    expect({ songBlockId: rt().songBlockId, tick: s.transport!.getPosition().tick }).toEqual({ songBlockId: 'b2', tick: BAR });
  });
});
