/**
 * Editing recorded takes: changing the value of a recorded knob, macro,
 * tempo, swing or volume change, and ending a take earlier. Every edit is
 * one undo step, values stay inside the control's range, and events that
 * carry no value are refused with a reason.
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/factory';
import { BPM_SPEC, MASTER_VOLUME_SPEC } from '../../src/project/params';
import type { Performance, PerformanceEvent, Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { addPerformance, performanceEventSpec, setPerformanceEventValue, trimPerformance } from '../../src/state/commands/performances';

function take(p: Project, events: PerformanceEvent[]): Performance {
  return {
    id: 'perf_a',
    name: 'Take',
    createdAt: 1,
    startTick: 0,
    endTick: 1536,
    snapshot: { bpm: p.bpm, swing: p.swing, root: p.root, scale: p.scale, assist: p.assist, masterVolumeDb: p.masterVolumeDb, tracks: p.tracks, scenes: p.scenes, patch: p.patch, launcher: [], seed: p.seed },
    events,
  };
}

const EVENTS: PerformanceEvent[] = [
  { t: 10, type: 'launch', trackId: 't3', slot: 1, atTick: 384 },
  { t: 96, type: 'tempo', bpm: 124 },
  { t: 150, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 0.8, key: 'KeyA' },
  { t: 192, type: 'macro', trackId: 't3', macro: 'tone', value: 0.62 },
  { t: 250, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyA' },
  { t: 300, type: 'param', module: 't4:filter', param: 'cutoff', value: 1200 },
  { t: 400, type: 'master', volumeDb: -3 },
  { t: 800, type: 'swing', swing: 0.2 },
  { t: 900, type: 'param', module: 't3:inst', param: 'cutoff', value: 700 },
];

function setup() {
  const store = new ProjectStore(createProject({ now: 0 }));
  expect(addPerformance(store, take(store.getState(), EVENTS)).changed).toBe(true);
  const events = () => store.getState().performances[0].events;
  return { store, events };
}

describe('changing a recorded value', () => {
  it('changes tempo, macro, knob, volume and swing values in place, each as one undo step', () => {
    const { store, events } = setup();
    expect(setPerformanceEventValue(store, 'perf_a', 1, 132).changed).toBe(true);
    expect(store.undoLabel()).toBe('Change recorded value');
    expect(setPerformanceEventValue(store, 'perf_a', 3, 0.25).changed).toBe(true);
    expect(setPerformanceEventValue(store, 'perf_a', 5, 3000).changed).toBe(true);
    expect(setPerformanceEventValue(store, 'perf_a', 6, -9).changed).toBe(true);
    expect(setPerformanceEventValue(store, 'perf_a', 7, 0.5).changed).toBe(true);
    expect(events()[1]).toEqual({ t: 96, type: 'tempo', bpm: 132 });
    expect(events()[3]).toMatchObject({ t: 192, macro: 'tone', value: 0.25 });
    expect(events()[5]).toMatchObject({ t: 300, module: 't4:filter', param: 'cutoff', value: 3000 });
    expect(events()[6]).toEqual({ t: 400, type: 'master', volumeDb: -9 });
    expect(events()[7]).toEqual({ t: 800, type: 'swing', swing: 0.5 });
    // Nothing moved in time and nothing else changed.
    expect(events().map((e) => e.t)).toEqual(EVENTS.map((e) => e.t));
    for (let i = 0; i < 5; i++) store.undo();
    expect(events()).toEqual(EVENTS);
  });

  it('keeps values inside the control range, like a knob', () => {
    const { store, events } = setup();
    setPerformanceEventValue(store, 'perf_a', 1, 999);
    expect(events()[1]).toMatchObject({ bpm: BPM_SPEC.max });
    setPerformanceEventValue(store, 'perf_a', 3, -2);
    expect(events()[3]).toMatchObject({ value: 0 });
    setPerformanceEventValue(store, 'perf_a', 6, 40);
    expect(events()[6]).toMatchObject({ volumeDb: MASTER_VOLUME_SPEC.max });
  });

  it('reads knob ranges from the take’s own sounds (an instrument knob uses the part’s instrument)', () => {
    const { store } = setup();
    const perf = store.getState().performances[0];
    const bass = perf.snapshot.tracks.find((t) => t.id === 't3')!;
    const spec = performanceEventSpec(perf, perf.events[8])!;
    expect(spec.id).toBe('cutoff');
    expect(bass.instrument.kind).toBe('bass');
    expect(spec.max).toBe(12000);
    setPerformanceEventValue(store, 'perf_a', 8, 50000);
    expect(store.getState().performances[0].events[8]).toMatchObject({ value: 12000 });
  });

  it('refuses events without a value and bad input; an unchanged value adds no undo step', () => {
    const { store } = setup();
    const before = store.getState();
    expect(setPerformanceEventValue(store, 'perf_a', 0, 1)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(setPerformanceEventValue(store, 'perf_a', 2, 1).message).toMatch(/knob, macro, tempo/);
    expect(setPerformanceEventValue(store, 'perf_a', 1, Number.NaN)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(setPerformanceEventValue(store, 'perf_a', 99, 1)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(setPerformanceEventValue(store, 'nope', 1, 1)).toMatchObject({ changed: false, reason: 'not-found' });
    expect(setPerformanceEventValue(store, 'perf_a', 1, 124)).toEqual({ changed: false });
    expect(store.getState()).toBe(before);
    expect(store.canUndo()).toBe(true); // only the take itself
    expect(store.undoLabel()).toBe('Save performance');
  });
});

describe('ending a take earlier', () => {
  it('removes the actions at and after the new end; a note cut short keeps sounding to the end', () => {
    const { store, events } = setup();
    expect(trimPerformance(store, 'perf_a', 192).changed).toBe(true);
    const perf = store.getState().performances[0];
    expect(perf.endTick).toBe(192);
    // The macro move at exactly the new end is gone (replay plays [start, end)); the note's release after it too.
    expect(events().map((e) => `${e.type}@${e.t}`)).toEqual(['launch@10', 'tempo@96', 'noteOn@150']);
    store.undo();
    expect(events()).toEqual(EVENTS);
    expect(store.getState().performances[0].endTick).toBe(1536);
  });

  it('only shortens: the current end is a no-op and a later end is refused', () => {
    const { store } = setup();
    expect(trimPerformance(store, 'perf_a', 1536)).toEqual({ changed: false });
    expect(trimPerformance(store, 'perf_a', 2000)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(trimPerformance(store, 'perf_a', 0)).toMatchObject({ changed: false, reason: 'invalid' });
  });
});
