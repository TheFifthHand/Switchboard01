/**
 * The session around song playback, with the real transport and engine in
 * Chromium:
 *  - an edit while the song plays is laid out again in the edit's own task
 *    (it is cheap; see docs/ARCHITECTURE.md), so the plan is never stale, and
 *    play, pause, stop and an undo right after an edit act on the song as
 *    edited;
 *  - Play in Arrange (togglePlay with `song`) starts the song (at the loop's
 *    first block when a loop is set), a pause resumes whatever was paused,
 *    and with no block that can play it plays the pads;
 *  - runtime `songLooping` is true exactly while playback is inside the loop
 *    and will repeat it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { createClip, createProject } from '../../src/project/factory';
import type { Clip, ClipBars, Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { deleteDb } from '../../src/persistence/db';

const BAR = 384;
const rt = () => runtimeStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 10000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function clip(name: string, bars: ClipBars, notes: [tick: number, pitch: number, duration: number][]): Clip {
  return createClip(name, bars, notes.map(([tick, pitch, duration]) => ({ tick, pitch, duration, velocity: 0.9 })));
}

const track = (p: Project, id: Id) => p.tracks.find((t) => t.id === id)!;

/** Four one-bar scenes; t1 plays a note on each bar (pitch 36 + row). Song: b0 b1 b2 b3, one pass each. */
function song(bpm: number): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 1;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  for (let row = 0; row < 4; row++) track(p, 't1').clips[row] = clip(`r${row}`, 1, [[0, 36 + row, 48]]);
  p.arrangement = { tailSeconds: 0, blocks: p.scenes.map((s, i) => ({ id: `b${i}`, sceneId: s.id, repeats: 1 })) };
  return p;
}

const reset = () =>
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songBlock: null, songBlockId: null, songLoop: null, songLooping: false });

let live: Session[] = [];
async function started(p: Project): Promise<Session> {
  const s = new Session(p);
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  return s;
}
const planIds = (s: Session) => s.sequencer!.songPlan()!.map((b) => b.blockId);

beforeEach(async () => {
  await deleteDb();
  reset();
});

afterEach(async () => {
  for (const s of live) {
    s.setSongLoop(null);
    s.dispose();
  }
  live = [];
  reset();
  await deleteDb();
});

describe('an edit while the song plays is laid out in its own task', () => {
  it('the plan is current right after each edit (nothing reads a stale plan), one replan per edit', async () => {
    // 60 BPM: b0 plays 4 s, so everything below happens inside it.
    const s = await started(song(60));
    await s.playSong(0);
    await until(() => s.transport!.getPosition().tick > 20, 'b0');
    const t = s.transport!;
    const replanSong = t.replanSong.bind(t);
    let replans = 0;
    t.replanSong = (loop) => {
      replans++;
      return replanSong(loop);
    };
    cmd.removeBlocks(s.store, ['b2']);
    expect(planIds(s)).toEqual(['b0', 'b1', 'b3']);
    cmd.moveBlocks(s.store, ['b3'], 1);
    expect(planIds(s)).toEqual(['b0', 'b3', 'b1']);
    cmd.setBlockRepeats(s.store, 'b1', 2);
    expect(s.sequencer!.songPlan()!.map((b) => b.endTick)).toEqual([BAR, 2 * BAR, 4 * BAR]);
    expect(replans).toBe(3);
    // An edit that changes nothing the song plays (a name) lays nothing out again.
    cmd.renameBlock(s.store, 'b1', 'Verse');
    expect(replans).toBe(3);
    expect(rt()).toMatchObject({ playing: true, mode: 'song', songBlockId: 'b0' });
  });

  it('pause, stop or play right after an edit act on the song as edited', async () => {
    const s = await started(song(60));
    await s.playSong(0);
    await until(() => s.transport!.getPosition().tick > 20, 'b0');
    cmd.removeBlocks(s.store, ['b1']);
    s.pause();
    expect(planIds(s)).toEqual(['b0', 'b2', 'b3']);
    // Paused: an edit, then Play at once.
    cmd.moveBlocks(s.store, ['b3'], 1);
    expect(planIds(s)).toEqual(['b0', 'b3', 'b2']);
    await s.play();
    expect(planIds(s)).toEqual(['b0', 'b3', 'b2']);
    expect(rt()).toMatchObject({ playing: true, mode: 'song' });
    cmd.setBlockRepeats(s.store, 'b3', 3);
    s.stop();
    expect(rt()).toMatchObject({ playing: false, mode: 'live', songLooping: false });
  });

  it('an edit undone at once leaves the song as it was', async () => {
    const s = await started(song(60));
    await s.playSong(0);
    await until(() => s.transport!.getPosition().tick > 20, 'b0');
    const before = s.sequencer!.songPlan();
    cmd.removeBlocks(s.store, ['b1']);
    s.store.undo();
    expect(s.sequencer!.songPlan()).toEqual(before);
  });
});

describe('Play in Arrange (togglePlay with song)', () => {
  it('starts the song at the loop’s first block; Pause; Play again continues the song where it paused', async () => {
    const s = await started(song(120));
    expect(s.setSongLoop({ fromBlockId: 'b2', toBlockId: 'b2' })).toBe(true);
    await s.togglePlay({ song: true });
    expect(rt()).toMatchObject({ playing: true, mode: 'song', songBlockId: 'b2' });
    expect(s.transport!.getPosition().tick).toBe(2 * BAR);
    await until(() => s.transport!.getPosition().tick > 2 * BAR + 100, 'b2 playing');
    await s.togglePlay({ song: true });
    expect(rt()).toMatchObject({ playing: false, paused: true, mode: 'song' });
    const at = s.transport!.getPosition().tick;
    await s.togglePlay({ song: true });
    expect(rt()).toMatchObject({ playing: true, paused: false, mode: 'song' });
    // Continued, not restarted at the loop.
    expect(s.transport!.getPosition().tick).toBeCloseTo(at, 0);
  });

  it('a pause of the live pads resumes the pads, also from Arrange', async () => {
    const s = await started(song(120));
    s.transport!.launchScene(0);
    await s.play();
    await until(() => s.transport!.getPosition().tick > 40, 'the pads');
    s.pause();
    await s.togglePlay({ song: true });
    expect(rt()).toMatchObject({ playing: true, mode: 'live' });
  });

  it('a paused song resumes from the Play view too (togglePlay without song)', async () => {
    const s = await started(song(120));
    await s.playSong(1);
    await until(() => s.transport!.getPosition().tick > BAR + 40, 'b1');
    s.pause();
    await s.togglePlay();
    expect(rt()).toMatchObject({ playing: true, mode: 'song', songBlockId: 'b1' });
  });

  it('with no block that can play, it plays the pads (no warning)', async () => {
    const p = song(120);
    p.arrangement.blocks = [];
    const s = await started(p);
    patchRuntime({ notice: null });
    await s.togglePlay({ song: true });
    expect(rt()).toMatchObject({ playing: true, mode: 'live' });
    expect(rt().notice).toBeNull();
  });
});

describe('runtime songLooping', () => {
  it('false while the song plays towards the loop; true from the loop on (also paused); false once cleared, and after Stop', async () => {
    // 240 BPM: a bar is 1 s.
    const s = await started(song(240));
    s.setSongLoop({ fromBlockId: 'b1', toBlockId: 'b1' });
    await s.playSong(0);
    expect(rt().songLooping).toBe(false);
    await until(() => s.transport!.getPosition().tick > 40, 'b0');
    expect(rt().songLooping).toBe(false);
    await until(() => rt().songBlockId === 'b1', 'the loop', 4000);
    expect(rt().songLooping).toBe(true);
    s.pause();
    expect(rt().songLooping).toBe(true);
    await s.play();
    expect(rt().songLooping).toBe(true);
    s.setSongLoop(null);
    expect(rt().songLooping).toBe(false);
    s.setSongLoop({ fromBlockId: 'b1', toBlockId: 'b1' });
    expect(rt().songLooping).toBe(true);
    s.stop();
    expect(rt().songLooping).toBe(false);
  });

  it('played from after the loop: never looping, the song plays to its end', async () => {
    const s = await started(song(240));
    s.setSongLoop({ fromBlockId: 'b1', toBlockId: 'b1' });
    await s.playSong(3);
    const seen = new Set<boolean>();
    while (rt().playing || seen.size === 0) {
      seen.add(rt().songLooping);
      await sleep(30);
    }
    expect([...seen]).toEqual([false]);
    expect(rt().songLoop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
  });

  it('a loop set while the song plays outside it: false until the jump reaches it', async () => {
    const s = await started(song(240));
    await s.playSong(0);
    await until(() => s.transport!.getPosition().tick > 40, 'b0');
    s.setSongLoop({ fromBlockId: 'b3', toBlockId: 'b3' });
    expect(rt().songLooping).toBe(false);
    await until(() => rt().songBlockId === 'b3', 'the jump', 4000);
    expect(rt().songLooping).toBe(true);
  });
});
