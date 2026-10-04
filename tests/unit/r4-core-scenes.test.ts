/**
 * Variable scene count (PLAY-10, capability-08): the sequencer launches any of
 * the project's rows (1 to 8), the song takes loops of every row, and a
 * performance recorded with another number of scenes replays its own.
 */
import { describe, expect, it } from 'vitest';
import { MAX_SCENES, type Performance, type Project } from '../../src/project/types';
import { uid } from '../../src/project/factory';
import { ProjectStore } from '../../src/state/projectStore';
import { addSceneToSong } from '../../src/state/commands/arrangement';
import { Sequencer } from '../../src/time/sequencer';
import { makeSnapshot } from '../../src/time/snapshot';
import { makeClip, makeProject, notesOf, ofKind, runTo, sec } from './sequencer-fixtures';

/** `rows` scenes; t1 plays pitch = row in every row (1 bar). */
function rowsProject(rows: number): Project {
  const p = makeProject(120);
  p.scenes = Array.from({ length: rows }, (_, i) => ({ id: `s${i}`, name: `Scene ${i + 1}` }));
  p.tracks = p.tracks.map((t) => ({ ...t, clips: Array.from({ length: rows }, (_, row) => (t.id === 't1' ? makeClip(1, [[0, row]]) : null)) }));
  return p;
}

describe('8 scenes', () => {
  it('launches the eighth row, and refuses a row past the last', () => {
    const p = rowsProject(MAX_SCENES);
    const seq = new Sequencer({ getProject: () => p });
    seq.launchScene(7, 0);
    seq.start(0);
    const ev = runTo(seq, 0, sec(800));
    expect(notesOf(ev, 't1').map((n) => n.pitch)).toEqual([7, 7, 7]);
    expect(() => seq.launchScene(8, sec(800))).toThrow(RangeError);
    // A 2-row project: row 2 is out of range.
    const small = rowsProject(2);
    const s2 = new Sequencer({ getProject: () => small });
    expect(() => s2.launchScene(2, 0)).toThrow(RangeError);
  });

  it('the song plays regions of every row, in order', () => {
    const p = rowsProject(MAX_SCENES);
    const t1 = p.tracks.find((t) => t.id === 't1')!;
    // Rows 8 down to 1, one bar each.
    p.arrangement = { tailSeconds: 0, sections: [], regions: [7, 6, 5, 4, 3, 2, 1, 0].map((row, i) => ({ id: `r${row}`, trackId: 't1', clipId: t1.clips[row]!.id, start: i, bars: 1, offset: 0 })) };
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBar: 0 } });
    const ev = runTo(seq, 0, sec(8 * 384) + 1);
    expect(notesOf(ev, 't1').map((n) => n.pitch)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(ofKind(ev, 'end')).toHaveLength(1);
  });

  it('the song takes loops of every row, in any order', () => {
    const p = rowsProject(MAX_SCENES);
    const store = new ProjectStore(p);
    for (let i = 0; i < MAX_SCENES; i++) expect(addSceneToSong(store, MAX_SCENES - 1 - i, i).changed).toBe(true);
    const song = store.getState().arrangement;
    const rowOf = (clipId: string) => p.tracks[0].clips.findIndex((c) => c?.id === clipId);
    expect(song.regions.map((r) => [rowOf(r.clipId), r.start, r.bars])).toEqual([7, 6, 5, 4, 3, 2, 1, 0].map((row, i) => [row, i, 1]));
    expect(song.sections.map((s) => s.name)).toEqual(['Scene 8', 'Scene 7', 'Scene 6', 'Scene 5', 'Scene 4', 'Scene 3', 'Scene 2', 'Scene 1']);
  });

  it('a take recorded with 3 scenes replays its own rows in a project that has 8 now', () => {
    const then = rowsProject(3);
    const perf: Performance = {
      id: uid('perf'),
      name: 'Take 1',
      createdAt: 0,
      startTick: 0,
      endTick: 3 * 384,
      snapshot: makeSnapshot(then, [{ trackId: 't1', playing: { slot: 2, startTick: 0 } }], 0),
      events: [{ t: 200, type: 'scene', row: 1, atTick: 384 }],
    };
    const now = { ...rowsProject(MAX_SCENES), performances: [perf] };
    const seq = new Sequencer({ getProject: () => now });
    seq.start(0, { mode: { kind: 'replay', performanceId: perf.id } });
    const ev = runTo(seq, 0, sec(3 * 384) + 1);
    expect(notesOf(ev, 't1').map((n) => n.pitch)).toEqual([2, 1, 1]);
  });
});
