/**
 * Integrated loudness and true peak measure one playback. Every start begins a
 * new measurement, including starts that do not begin at bar 1: the replay of
 * a take recorded while the pads were already playing, and the song from a
 * later block. Continuing from Pause keeps counting.
 */
import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../../src/time/snapshot';
import { Sequencer } from '../../src/time/sequencer';
import { RealtimeTransport } from '../../src/time/transport';
import { makeClip, makeProject, setClip } from './sequencer-fixtures';

/** An engine that only notes which calls the transport makes (with the tick of each start). */
function loggingEngine(log: string[]) {
  return new Proxy(
    {},
    {
      get: (_t, name) =>
        (...args: unknown[]) => {
          if (name === 'transportStarted') log.push(`started@${Math.round(args[1] as number)}`);
          if (name === 'resetLoudness') log.push('reset');
          return null;
        },
    },
  ) as never;
}

describe('Loudness measurement and playback starts', () => {
  it('restarts on every start (a replay from bar 5, the song from block 2, the pads) but not on resume', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, [[0, 36]]));
    // A take that started at bar 5, as one started while the pads were already playing does.
    const startTick = 4 * 384;
    p = {
      ...p,
      performances: [{ id: 'perf1', name: 'Take 1', createdAt: 1, startTick, endTick: startTick + 8 * 384, snapshot: makeSnapshot(p, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], startTick), events: [] }],
      arrangement: { ...p.arrangement, blocks: [{ id: 'b1', sceneId: p.scenes[0].id, repeats: 1 }, { id: 'b2', sceneId: p.scenes[0].id, repeats: 1 }] },
    };
    const log: string[] = [];
    const ctx = { currentTime: 1, state: 'running', addEventListener() {}, removeEventListener() {} };
    const t = new RealtimeTransport({ ctx: ctx as never, engine: loggingEngine(log), sequencer: new Sequencer({ getProject: () => p }) });
    try {
      const starts: string[][] = [];
      const step = (fn: () => void) => {
        log.length = 0;
        fn();
        starts.push([...log]);
      };
      step(() => t.start({ mode: { kind: 'replay', performanceId: 'perf1' } }));
      step(() => t.start({ mode: { kind: 'song', fromBlock: 1 } }));
      step(() => t.start({ mode: { kind: 'live' } }));
      ctx.currentTime = 3;
      step(() => t.pause());
      ctx.currentTime = 4;
      step(() => t.resume());
      // The replay and the later block start after bar 1, and still restart the measurement.
      expect(starts[0]).toEqual([`started@${startTick}`, 'reset']);
      expect(starts[1][0]).toMatch(/^started@[1-9]/);
      expect(starts[1]).toContain('reset');
      expect(starts[2]).toEqual(['started@0', 'reset']);
      // Pause and resume keep counting.
      expect(starts[3]).not.toContain('reset');
      expect(starts[4][0]).toMatch(/^started@[1-9]/);
      expect(starts[4]).not.toContain('reset');
    } finally {
      t.dispose();
    }
  });
});
