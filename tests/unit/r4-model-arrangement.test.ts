/**
 * Starting a recorded take later (trimTakeStart): what happened before the
 * new start becomes the take's starting state. (The 2.2 song-block tests that
 * lived here moved with the song to schema v4: see r5-song-*.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/project/factory';
import { TICKS_PER_BAR, type Performance, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { takeStartingAt, trimTakeStart } from '../../src/state/commands/performances';
import { makeSnapshot } from '../../src/time/snapshot';

const BAR = TICKS_PER_BAR;

function valid(p: Project): void {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  expect(r.ok && r.warnings).toEqual([]);
}

describe('start a take later', () => {
  function take(): { store: ProjectStore; perf: Performance } {
    const p = createProject({ now: 0 });
    p.tracks[0].clips[0] = createClip('Beat', 1);
    p.tracks[0].clips[1] = createClip('Beat 2', 1);
    p.tracks[3].clips[1] = createClip('Stabs', 2);
    const perf: Performance = {
      id: 'perf_1',
      name: 'Take',
      createdAt: 5,
      startTick: 140,
      endTick: 8 * BAR,
      snapshot: makeSnapshot(p, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], 140),
      events: [
        { t: 150, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 0.9, key: 'KeyA' },
        { t: 200, type: 'macro', trackId: 't4', macro: 'tone', value: 0.8 },
        { t: 250, type: 'noteOn', trackId: 't5', pitch: 62, velocity: 0.5, key: 'KeyS' },
        { t: 300, type: 'noteOff', trackId: 't5', pitch: 62, key: 'KeyS' },
        { t: 320, type: 'scene', row: 1, atTick: BAR },
        { t: 330, type: 'tempo', bpm: 128 },
        { t: 340, type: 'param', module: 't4:filter', param: 'resonance', value: 0.4 },
        { t: 700, type: 'launch', trackId: 't1', slot: 0, atTick: 2 * BAR },
        { t: 900, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyA' },
        { t: 1000, type: 'mute', trackId: 't2', mute: true },
      ],
    };
    p.performances.push(perf);
    return { store: new ProjectStore(p), perf };
  }

  it('makes what happened before the new start the starting state; held notes start there; launches still landing are kept', () => {
    const { store, perf } = take();
    const at = 2 * BAR - 50;
    const r = trimTakeStart(store, 'perf_1', at);
    expect(r.changed).toBe(true);
    expect(store.undoLabel()).toBe('Start take later');
    const x = store.getState().performances[0];
    expect(x.startTick).toBe(at);
    expect(x.endTick).toBe(8 * BAR);
    // The scene launched at bar 2 (Groove): drums and chords play from it; the tempo, a knob and a big knob are in the snapshot.
    expect(x.snapshot.launcher.find((e) => e.trackId === 't1')!.playing).toEqual({ slot: 1, startTick: BAR });
    expect(x.snapshot.launcher.find((e) => e.trackId === 't4')!.playing).toEqual({ slot: 1, startTick: BAR });
    expect(x.snapshot.bpm).toBe(128);
    expect(x.snapshot.tracks[3].macros.tone).toBe(0.8);
    expect(x.snapshot.patch.modules.find((m) => m.id === 't4:filter')!.params.resonance).toBe(0.4);
    expect(x.events).toEqual([
      // Pressed before the new start, landing after it: still launches.
      { t: at, type: 'launch', trackId: 't1', slot: 0, atTick: 2 * BAR },
      // Still held at the new start: it starts there.
      { t: at, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 0.9, key: 'KeyA' },
      { t: 900, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyA' },
      { t: 1000, type: 'mute', trackId: 't2', mute: true },
    ]);
    valid(store.getState());
    store.undo();
    expect(store.getState().performances[0]).toEqual(perf);
  });

  it('refuses a start that is not later, or not before the end', () => {
    const { store, perf } = take();
    expect(trimTakeStart(store, 'perf_1', perf.startTick)).toEqual({ changed: false });
    expect(trimTakeStart(store, 'perf_1', 100)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(trimTakeStart(store, 'perf_1', perf.endTick)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(trimTakeStart(store, 'nope', 500)).toMatchObject({ changed: false, reason: 'not-found' });
    expect(takeStartingAt(perf, 400).events.every((e) => e.t >= 400)).toBe(true);
  });
});
