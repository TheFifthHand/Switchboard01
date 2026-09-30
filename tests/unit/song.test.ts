import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/project/types';
import { Sequencer, sceneBars, songBlocks, songLengthTicks } from '../../src/time/sequencer';
import { makeClip, makeProject, notesOf, ofKind, runTo, sec, setClip } from './sequencer-fixtures';

/** Intro (row 0, 2 bars) x1, Groove (row 1, 1 bar) x2, Lift (row 2, empty = 1 bar) x1, plus a block whose scene is gone. */
function songProject(): { p: Project; ids: Record<string, string> } {
  let p = makeProject(120);
  const introDrums = makeClip(1, [[0, 0], [192, 1]], 'intro-drums');
  const introPad = makeClip(2, [[0, 60, 768]], 'intro-pad');
  const grooveDrums = makeClip(1, [[96, 2]], 'groove-drums');
  const grooveBass = makeClip(1, [[0, 36, 96]], 'groove-bass');
  p = setClip(p, 't1', 0, introDrums);
  p = setClip(p, 't6', 0, introPad);
  p = setClip(p, 't1', 1, grooveDrums);
  p = setClip(p, 't3', 1, grooveBass);
  p.arrangement = {
    tailSeconds: 2,
    blocks: [
      { id: 'b0', sceneId: p.scenes[0].id, repeats: 1 },
      { id: 'b1', sceneId: p.scenes[1].id, repeats: 2 },
      { id: 'gone', sceneId: 'scene_missing', repeats: 4 },
      { id: 'b3', sceneId: p.scenes[2].id, repeats: 1 },
    ],
  };
  return { p, ids: { introDrums: introDrums.id, introPad: introPad.id, grooveDrums: grooveDrums.id, grooveBass: grooveBass.id } };
}

describe('song layout', () => {
  it('scene length is the longest clip in the row (at least 1 bar)', () => {
    const { p } = songProject();
    expect(sceneBars(p, 0)).toBe(2);
    expect(sceneBars(p, 1)).toBe(1);
    expect(sceneBars(p, 2)).toBe(1);
  });

  it('song length is the sum of scene bars x repeats; missing scenes are skipped', () => {
    const { p } = songProject();
    expect(songLengthTicks(p)).toBe((2 + 1 * 2 + 1) * 384);
    expect(songBlocks(p).map((b) => [b.index, b.row, b.startTick, b.endTick])).toEqual([
      [0, 0, 0, 768],
      [1, 1, 768, 1536],
      [3, 2, 1536, 1920],
    ]);
    expect(songLengthTicks({ ...p, arrangement: { ...p.arrangement, blocks: [] } })).toBe(0);
  });
});

describe('song mode', () => {
  it('plays blocks in order, switches every track at block starts and ends after the last block', () => {
    const { p, ids } = songProject();
    const seq = new Sequencer({ getProject: () => p });
    // A live selection made before playing the song comes back after it.
    seq.launchClip('t8', 0, 0);
    seq.launchClip('t1', 1, 0);
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    const events = runTo(seq, 0, 12);

    expect(ofKind(events, 'block').map((b) => [b.tick, b.blockIndex, b.sceneRow])).toEqual([
      [0, 0, 0],
      [768, 1, 1],
      [1536, 3, 2],
    ]);
    const end = ofKind(events, 'end');
    expect(end).toHaveLength(1);
    expect(end[0].tick).toBe(1920);
    expect(end[0].time).toBeCloseTo(10, 12);
    expect(seq.ended).toBe(true);

    expect(ofKind(events, 'launch').map((l) => [l.tick, l.trackId, l.slot])).toEqual([
      [0, 't1', 0],
      [0, 't6', 0],
      [768, 't1', 1],
      [768, 't3', 1],
      [768, 't6', null],
      [1536, 't1', null],
      [1536, 't3', null],
    ]);

    const drums = notesOf(events, 't1');
    expect(drums.map((n) => [n.tick, n.clipId])).toEqual([
      [0, ids.introDrums],
      [192, ids.introDrums],
      [384, ids.introDrums],
      [576, ids.introDrums],
      [864, ids.grooveDrums],
      [1248, ids.grooveDrums],
    ]);
    expect(notesOf(events, 't3').map((n) => n.tick)).toEqual([768, 1152]);
    const pad = notesOf(events, 't6');
    expect(pad).toHaveLength(1);
    expect(pad[0].durationTicks).toBe(768);
    expect(pad[0].duration).toBeCloseTo(sec(768), 9);

    expect(events.filter((e) => e.kind !== 'end').every((e) => e.tick < 1920)).toBe(true);
    expect(ofKind(events, 'beat').at(-1)!.tick).toBe(1824);
    // Nothing more after the end.
    expect(seq.process(20)).toEqual([]);

    seq.stop(12);
    const snap = seq.getLauncherSnapshot();
    expect(snap.find((e) => e.trackId === 't1')!.playing).toEqual({ slot: 1, startTick: 0 });
    expect(snap.find((e) => e.trackId === 't6')!.playing).toBeNull();
  });

  it('starts from a later block on the song timeline', () => {
    const { p } = songProject();
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBlock: 1 } });
    expect(seq.tickAt(0)).toBe(768);
    const events = runTo(seq, 0, 8);
    expect(ofKind(events, 'block').map((b) => b.blockIndex)).toEqual([1, 3]);
    expect(notesOf(events, 't1').map((n) => n.tick)).toEqual([864, 1248]);
    expect(ofKind(events, 'end')[0].time).toBeCloseTo(sec(1920 - 768), 12);
  });

  it('counts in one bar before the first block', () => {
    const { p } = songProject();
    const seq = new Sequencer({ getProject: () => p });
    seq.start(1, { mode: { kind: 'song', fromBlock: 0 }, countInBars: 1 });
    const events = runTo(seq, 1, 3.5);
    const beats = ofKind(events, 'beat');
    expect(beats.slice(0, 5).map((b) => [b.tick, b.countIn])).toEqual([
      [-384, true],
      [-288, true],
      [-192, true],
      [-96, true],
      [0, false],
    ]);
    const block = ofKind(events, 'block')[0];
    expect(block.tick).toBe(0);
    expect(block.time).toBeCloseTo(3, 12);
    expect(notesOf(events).every((n) => n.tick >= 0)).toBe(true);
  });

  it('an empty arrangement ends immediately', () => {
    const { p } = songProject();
    const empty = { ...p, arrangement: { ...p.arrangement, blocks: [] } };
    const seq = new Sequencer({ getProject: () => empty });
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    const events = seq.process(1);
    expect(events.map((e) => e.kind)).toEqual(['end']);
  });
});
