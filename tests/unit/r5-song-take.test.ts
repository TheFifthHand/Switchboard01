/**
 * A recorded performance take made into song loops (songFromTake): each
 * launch plays until that part's next launch or stop, in whole bars from the
 * take's start; what was playing when the take began carries on in its phase.
 */
import { describe, expect, it } from 'vitest';
import { TICKS_PER_BAR, type Performance, type PerformanceEvent, type Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import * as cmd from '../../src/state/commands';
import { makeSnapshot } from '../../src/time/snapshot';
import { expectRefused, expectValid, sketch, songProject } from './r5-song-fixtures';

const BAR = TICKS_PER_BAR;

/** A take of `bars` bars starting at `startTick`; the Beat (2 bars) was already playing, launched one bar before. */
function withTake(events: PerformanceEvent[], opts: { bars?: number; startTick?: number; edit?: (p: Project) => void } = {}) {
  const { p, clip } = songProject();
  const startTick = opts.startTick ?? 16 * BAR;
  const perf: Performance = {
    id: 'perf_1',
    name: 'Take 1',
    createdAt: 0,
    startTick,
    endTick: startTick + (opts.bars ?? 8) * BAR,
    snapshot: makeSnapshot(p, [{ trackId: 't1', playing: { slot: 0, startTick: startTick - BAR } }], startTick),
    events: events.map((e) => ('atTick' in e ? { ...e, atTick: e.atTick + startTick } : e)),
  };
  p.performances.push(perf);
  opts.edit?.(p);
  return { store: new ProjectStore(p), clip };
}

const EVENTS: PerformanceEvent[] = [
  { t: 0, type: 'launch', trackId: 't3', slot: 0, atTick: 0 },
  { t: 1, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 1, key: 'KeyA' },
  { t: 8, type: 'scene', row: 1, atTick: 4 * BAR },
  { t: 12, type: 'launch', trackId: 't5', slot: null, atTick: 6 * BAR },
  { t: 14, type: 'stopAll', atTick: 7 * BAR },
];

describe('a take made into song loops', () => {
  it('each launch plays until the part’s next launch or stop; what was playing carries on in its phase', () => {
    const { store } = withTake(EVENTS);
    const plan = cmd.takeToRegions(store.getState(), 'perf_1')!;
    expect(plan).toMatchObject({ bars: 8, rounded: false, missing: 0 });
    const r = cmd.songFromTake(store, 'perf_1');
    expect(r).toMatchObject({ changed: true, rounded: false, missing: 0 });
    // The Beat began a bar before the take: its loop starts a bar into the clip.
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+4~1', 't3:Bounce@0+4~0', 't1:Fill@4+3~0', 't3:Walk@4+3~0', 't5:Hook@4+2~0']);
    expect(r.ids).toHaveLength(5);
    expect(store.undoLabel()).toBe('Make song from Take 1');
    expectValid(store.getState());
    // Again, after the song (by default), or at a bar.
    cmd.songFromTake(store, 'perf_1');
    expect(sketch(store.getState()).slice(5)).toEqual(['t1:Beat@7+4~1', 't3:Bounce@7+4~0', 't1:Fill@11+3~0', 't3:Walk@11+3~0', 't5:Hook@11+2~0']);
    // At bar 2 it wins over what is there: the loops it lands on are cut, the rest go on in phase.
    cmd.songFromTake(store, 'perf_1', { at: 2 });
    expect(sketch(store.getState())).toEqual([
      't1:Beat@0+2~1',
      't3:Bounce@0+2~0',
      't1:Beat@2+4~1',
      't3:Bounce@2+4~0',
      't5:Hook@4+2~0',
      't1:Fill@6+3~0',
      't3:Walk@6+3~0',
      't5:Hook@6+2~0',
      't1:Beat@9+2~1',
      't3:Bounce@9+2~2',
      't1:Fill@11+3~0',
      't3:Walk@11+3~0',
      't5:Hook@11+2~0',
    ]);
    expectValid(store.getState());
  });

  it('a clip launched again in phase is one loop; out of phase, two', () => {
    const inPhase = withTake([
      { t: 0, type: 'launch', trackId: 't3', slot: 0, atTick: 0 },
      { t: 1, type: 'launch', trackId: 't3', slot: 0, atTick: 4 * BAR },
    ]).store;
    cmd.songFromTake(inPhase, 'perf_1');
    expect(sketch(inPhase.getState())).toEqual(['t1:Beat@0+8~1', 't3:Bounce@0+8~0']);
    const outOfPhase = withTake([
      { t: 0, type: 'launch', trackId: 't3', slot: 0, atTick: 0 },
      { t: 1, type: 'launch', trackId: 't3', slot: 0, atTick: 2 * BAR },
    ]).store;
    cmd.songFromTake(outOfPhase, 'perf_1');
    expect(sketch(outOfPhase.getState())).toEqual(['t1:Beat@0+8~1', 't3:Bounce@0+2~0', 't3:Bounce@2+6~0']);
  });

  it('finds clips by id: one moved to another part follows it, one deleted since is left out and counted', () => {
    const moved = withTake(EVENTS).store;
    cmd.moveClip(moved, 't5', 1, 't4', 3);
    cmd.deleteClip(moved, 't3', 1);
    const r = cmd.songFromTake(moved, 'perf_1');
    expect(r).toMatchObject({ changed: true, missing: 1 });
    expect(sketch(moved.getState())).toEqual(['t1:Beat@0+4~1', 't3:Bounce@0+4~0', 't1:Fill@4+3~0', 't4:Hook@4+2~0']);
  });

  it('rounds launches between bar lines to the nearest bar, and says so', () => {
    const { store } = withTake([
      { t: 0, type: 'launch', trackId: 't3', slot: 0, atTick: 0 },
      { t: 1, type: 'launch', trackId: 't3', slot: 1, atTick: 3 * BAR + 100 },
    ]);
    expect(cmd.songFromTake(store, 'perf_1')).toMatchObject({ changed: true, rounded: true });
    expect(sketch(store.getState())).toEqual(['t1:Beat@0+8~1', 't3:Bounce@0+3~0', 't3:Walk@3+5~0']);
  });

  it('refuses a missing take, a take that played nothing, and no room before bar 512', () => {
    const { store } = withTake(EVENTS);
    expectRefused(store, () => cmd.songFromTake(store, 'perf_gone'), 'not-found');
    expectRefused(store, () => cmd.songFromTake(store, 'perf_1', { at: 510 }), 'limit');
    expectRefused(store, () => cmd.songFromTake(store, 'perf_1', { at: -1 }), 'invalid');
    const silent = withTake([{ t: 0, type: 'stopAll', atTick: 0 }]).store;
    expectRefused(silent, () => cmd.songFromTake(silent, 'perf_1'), 'empty');
    const gone = withTake([{ t: 0, type: 'stopAll', atTick: 4 * BAR }]).store;
    cmd.deleteClip(gone, 't1', 0);
    const r = cmd.songFromTake(gone, 'perf_1');
    expect(r).toMatchObject({ changed: false, reason: 'empty', missing: 1 });
    expect(r.message).toBe('This take makes no song: the clips it played have been deleted since.');
  });
});
