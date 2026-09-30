import { describe, expect, it } from 'vitest';
import type { Performance, PerformanceEvent, Project } from '../../src/project/types';
import type { SeqEvent } from '../../src/time/contracts';
import { Sequencer } from '../../src/time/sequencer';
import { makeSnapshot, projectFromSnapshot } from '../../src/time/snapshot';
import { makeClip, makeProject, notesOf, ofKind, runTo, sec, setClip } from './sequencer-fixtures';

const T_TEMPO = 800.5;
/** Time of a tick in the recorded take: 120 BPM, then 60 BPM from tick 800.5. */
function takeTime(tick: number): number {
  return tick < T_TEMPO ? sec(tick, 120) : sec(T_TEMPO, 120) + sec(tick - T_TEMPO, 60);
}

function recorded(extraEvents: PerformanceEvent[] = []): { live: Project; perf: Performance; A: string; B: string } {
  let p = makeProject(120);
  const A = makeClip(1, [[0, 0], [192, 1]], 'A');
  const B = makeClip(1, [[120, 2, 12]], 'B');
  p = setClip(p, 't1', 0, A);
  p = setClip(p, 't1', 1, B);
  const snapshot = makeSnapshot(p, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], 0);
  const perf: Performance = {
    id: 'perf1',
    name: 'Take 1',
    createdAt: 0,
    startTick: 0,
    endTick: 1536,
    snapshot,
    events: [
      { t: 100, type: 'noteOn', trackId: 't4', pitch: 72, velocity: 0.9, key: 'KeyA' },
      { t: 196, type: 'noteOff', trackId: 't4', pitch: 72, key: 'KeyA' },
      { t: 400, type: 'macro', trackId: 't1', macro: 'tone', value: 0.2 },
      { t: 450, type: 'param', module: 't1:filter', param: 'cutoff', value: 900 },
      { t: 500, type: 'launch', trackId: 't1', slot: 1, atTick: 768 },
      { t: 600, type: 'mute', trackId: 't2', mute: true },
      { t: 700, type: 'master', volumeDb: -6 },
      { t: T_TEMPO, type: 'tempo', bpm: 60 },
      { t: 900, type: 'swing', swing: 0.5 },
      // Held past the end of the take.
      { t: 1000, type: 'noteOn', trackId: 't4', pitch: 74, velocity: 0.5, key: 'KeyS' },
      ...extraEvents,
    ],
  };
  // After recording the live project moved on; replay must not notice.
  let live = setClip(p, 't1', 0, makeClip(1, [[48, 9]], 'edited'));
  live = { ...live, bpm: 90, swing: 0.8, performances: [perf] };
  return { live, perf, A: A.id, B: B.id };
}

describe('performance snapshots', () => {
  it('projectFromSnapshot restores the recorded musical state as a deep copy', () => {
    const { live, perf } = recorded();
    const r = projectFromSnapshot(live, perf.snapshot);
    expect(r.bpm).toBe(120);
    expect(r.swing).toBe(0);
    expect(r.tracks[0].clips[0]!.name).toBe('A');
    expect(r.performances).toBe(live.performances);
    r.tracks[0].clips[0]!.notes[0].pitch = 99;
    expect(perf.snapshot.tracks[0].clips[0]!.notes[0].pitch).toBe(0);
  });

  it('makeSnapshot fills every track and keeps loop phase with bounded start ticks', () => {
    let p = makeProject();
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0]]));
    p = setClip(p, 't4', 0, makeClip(2, [[0, 60]]));
    const snap = makeSnapshot(
      p,
      [
        { trackId: 't1', playing: { slot: 0, startTick: 0 } },
        { trackId: 't4', playing: { slot: 0, startTick: 384 } },
        { trackId: 't5', playing: { slot: 2, startTick: 0 } },
      ],
      2000,
    );
    expect(snap.launcher).toHaveLength(8);
    expect(snap.launcher[0].playing).toEqual({ slot: 0, startTick: 1920 });
    expect(snap.launcher[3].playing).toEqual({ slot: 0, startTick: 1920 });
    expect(snap.launcher[4].playing).toBeNull(); // empty slot
    expect(snap.tracks).not.toBe(p.tracks);
    expect(snap.tracks).toEqual(p.tracks);
  });
});

describe('performance replay', () => {
  function replayAll(live: Project): { seq: Sequencer; events: SeqEvent[] } {
    const seq = new Sequencer({ getProject: () => live });
    seq.start(0, { mode: { kind: 'replay', performanceId: 'perf1' } });
    return { seq, events: runTo(seq, 0, 20) };
  }

  it('reproduces launches, clip notes and played notes at the recorded ticks with the snapshot state', () => {
    const { live, A, B } = recorded();
    const { seq, events } = replayAll(live);
    expect(seq.activeProject().bpm).toBe(120);

    expect(ofKind(events, 'launch')).toMatchObject([{ tick: 768, trackId: 't1', slot: 1, clipId: B }]);
    const clipNotes = notesOf(events, 't1');
    expect(clipNotes.map((n) => [n.tick, n.clipId])).toEqual([
      [0, A],
      [192, A],
      [384, A],
      [576, A],
      [888, B],
      [1272, B],
    ]);
    for (const n of clipNotes) {
      // Swing 0.5 from tick 900 delays B's off-beat 16th at 1272 by 4 ticks.
      const swungTick = n.tick === 1272 ? 1276 : n.tick;
      expect(n.time).toBeCloseTo(takeTime(swungTick), 9);
    }

    const played = notesOf(events, 't4');
    expect(played.map((n) => [n.tick, n.pitch, n.durationTicks, n.source])).toEqual([
      [100, 72, 96, 'replay'],
      [1000, 74, 536, 'replay'],
    ]);
    expect(played[0].velocity).toBe(0.9);
    // Played notes keep the player's timing: never swung.
    expect(played[1].time).toBeCloseTo(takeTime(1000), 9);
    expect(played[1].duration).toBeCloseTo(takeTime(1536) - takeTime(1000), 9);
  });

  it('reproduces macro, parameter, mute, master, tempo and swing events', () => {
    const { live } = recorded();
    const { events } = replayAll(live);
    const controls = events.filter((e) => ['macro', 'param', 'mute', 'master', 'tempo', 'swing'].includes(e.kind));
    expect(controls).toEqual([
      { kind: 'macro', tick: 400, time: takeTime(400), trackId: 't1', macro: 'tone', value: 0.2 },
      { kind: 'param', tick: 450, time: takeTime(450), module: 't1:filter', param: 'cutoff', value: 900 },
      { kind: 'mute', tick: 600, time: takeTime(600), trackId: 't2', mute: true },
      { kind: 'master', tick: 700, time: takeTime(700), volumeDb: -6 },
      { kind: 'tempo', tick: T_TEMPO, time: takeTime(T_TEMPO), bpm: 60 },
      { kind: 'swing', tick: 900, time: takeTime(900), swing: 0.5 },
    ]);
    const beats = ofKind(events, 'beat');
    expect(beats.filter((b) => b.tick < T_TEMPO).every((b) => b.beatSeconds === 0.5)).toBe(true);
    expect(beats.filter((b) => b.tick > T_TEMPO).every((b) => b.beatSeconds === 1)).toBe(true);
    const end = ofKind(events, 'end');
    expect(end).toHaveLength(1);
    expect(end[0].tick).toBe(1536);
    expect(end[0].time).toBeCloseTo(takeTime(1536), 9);
    expect(events.filter((e) => e.kind === 'note').every((e) => e.tick < 1536)).toBe(true);
  });

  it('is identical when invalidated mid-take (tempo changes are re-applied, not doubled)', () => {
    const { live } = recorded();
    const straight = replayAll(live).events;
    const seq = new Sequencer({ getProject: () => live });
    seq.start(0, { mode: { kind: 'replay', performanceId: 'perf1' } });
    // Generated past the tempo change (4.17 s), then invalidated from just before it.
    const e1 = runTo(seq, 0, 4.25);
    seq.invalidate(4.1);
    const e2 = runTo(seq, 4.25, 20);
    const joined = [...e1.filter((e) => e.time < 4.1), ...e2];
    expect(ofKind(joined, 'tempo')).toHaveLength(1);
    const key = (e: SeqEvent) => JSON.stringify(e);
    expect(joined.map(key)).toEqual(straight.map(key));
  });

  it('drives the arpeggiator from recorded key presses on an arp track', () => {
    const base = makeProject(120);
    base.tracks[4].arp = { enabled: true, division: '1/16', mode: 'up', octaves: 1, latch: false, gate: 0.5 };
    const perf: Performance = {
      id: 'perf1',
      name: 'Arp take',
      createdAt: 0,
      startTick: 0,
      endTick: 384,
      snapshot: makeSnapshot(base, [], 0),
      events: [
        { t: 0, type: 'noteOn', trackId: 't5', pitch: 64, velocity: 0.7, key: 'k1' },
        { t: 10, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 0.7, key: 'k2' },
        { t: 96, type: 'noteOff', trackId: 't5', pitch: 64, key: 'k1' },
        { t: 96, type: 'noteOff', trackId: 't5', pitch: 60, key: 'k2' },
      ],
    };
    const live = { ...base, performances: [perf] };
    const seq = new Sequencer({ getProject: () => live });
    seq.start(0, { mode: { kind: 'replay', performanceId: 'perf1' } });
    const notes = notesOf(runTo(seq, 0, 3), 't5');
    expect(notes.map((n) => [n.tick, n.pitch, n.source])).toEqual([
      [0, 64, 'arp'],
      [24, 64, 'arp'],
      [48, 60, 'arp'],
      [72, 64, 'arp'],
    ]);
  });

  /** A take whose pad note (tick 0-768) spans a recorded slow-down to 60 BPM at tick 384. */
  function slowDownTake(): Project {
    const base = setClip(makeProject(120), 't6', 0, makeClip(2, [[0, 60, 768]], 'pad'));
    const perf: Performance = {
      id: 'perf1',
      name: 'Slow down',
      createdAt: 0,
      startTick: 0,
      endTick: 1152,
      snapshot: makeSnapshot(base, [{ trackId: 't6', playing: { slot: 0, startTick: 0 } }], 0),
      events: [{ t: 384, type: 'tempo', bpm: 60 }],
    };
    return { ...base, performances: [perf] };
  }

  it('a note spanning a recorded tempo change lasts until its end tick, however the timeline is windowed', () => {
    const live = slowDownTake();
    for (const step of [0.025, 0.37, 5]) {
      const seq = new Sequencer({ getProject: () => live });
      seq.start(0, { mode: { kind: 'replay', performanceId: 'perf1' } });
      const events = runTo(seq, 0, 11, step);
      const [pad] = notesOf(events, 't6');
      // 2 s at 120 BPM, then 384 ticks at 60 BPM.
      expect(pad.duration).toBeCloseTo(2 + 4, 9);
      expect(seq.takeCuts()).toEqual([]);
      expect(ofKind(events, 'end')[0].time).toBeCloseTo(2 + 4 + 4, 9);
    }
  });

  it('a live tempo change during a replay holds until the take changes tempo again', () => {
    const base = setClip(makeProject(120), 't1', 0, makeClip(1, [[0, 0], [96, 0], [192, 0], [288, 0]]));
    const perf: Performance = {
      id: 'perf1',
      name: 'Tempo take',
      createdAt: 0,
      startTick: 0,
      endTick: 1536,
      snapshot: makeSnapshot(base, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], 0),
      events: [
        { t: 768, type: 'tempo', bpm: 60 },
        { t: 1152, type: 'tempo', bpm: 120 },
      ],
    };
    const live = { ...base, performances: [perf] };
    const seq = new Sequencer({ getProject: () => live });
    seq.start(0, { mode: { kind: 'replay', performanceId: 'perf1' } });
    const e1 = runTo(seq, 0, 1.1);
    seq.setTempo(240, 1); // tick 192 -> 220 BPM (clamped) until the take's change at 768
    seq.invalidate(1);
    const e2 = runTo(seq, 1.1, 12);
    const beats = ofKind([...e1.filter((e) => e.time < 1), ...e2], 'beat');
    const t768 = 1 + sec(768 - 192, 220);
    const t1152 = t768 + sec(384, 60);
    const expected = (tick: number): number =>
      tick < 192 ? sec(tick) : tick < 768 ? 1 + sec(tick - 192, 220) : tick < 1152 ? t768 + sec(tick - 768, 60) : t1152 + sec(tick - 1152, 120);
    expect(beats.map((b) => b.tick)).toEqual(Array.from({ length: 16 }, (_, i) => i * 96));
    for (const b of beats) expect(b.time).toBeCloseTo(expected(b.tick), 9);
    expect(ofKind(e2, 'tempo').map((e) => e.bpm)).toEqual([60, 120]);
  });

  it('starting later in a take keeps fromTick at the start time and applies earlier changes there', () => {
    const { live } = recorded();
    const seq = new Sequencer({ getProject: () => live });
    // From tick 1152: after the recorded launch (768), macro, mute, master, tempo (60 BPM) and swing.
    seq.start(5, { mode: { kind: 'replay', performanceId: 'perf1' }, fromTick: 1152 });
    expect(seq.tickAt(5)).toBeCloseTo(1152, 9);
    expect(seq.bpm).toBe(60);
    const events = runTo(seq, 5, 10);
    const controls = events.filter((e) => ['macro', 'param', 'mute', 'master', 'tempo', 'swing'].includes(e.kind));
    expect(controls).toHaveLength(6);
    for (const c of controls) expect(c).toMatchObject({ tick: 1152, time: 5 });
    // B (entered at 768) keeps its loop phase; its swung note at 1272 plays at 60 BPM.
    expect(notesOf(events, 't1').map((n) => [n.tick, n.time])).toEqual([[1272, 5 + sec(1276 - 1152, 60)]]);
    expect(ofKind(events, 'end')[0].time).toBeCloseTo(5 + sec(1536 - 1152, 60), 9);
  });

  it('a played note on a mono part ends the swung clip note exactly where it starts', () => {
    const base = setClip(makeProject(120), 't3', 0, makeClip(1, [[0, 36, 96]]));
    base.swing = 1;
    const perf: Performance = {
      id: 'perf1',
      name: 'Bass take',
      createdAt: 0,
      startTick: 0,
      endTick: 384,
      snapshot: makeSnapshot(base, [{ trackId: 't3', playing: { slot: 0, startTick: 0 } }], 0),
      events: [
        { t: 30, type: 'noteOn', trackId: 't3', pitch: 43, velocity: 1, key: 'k' },
        { t: 60, type: 'noteOff', trackId: 't3', pitch: 43, key: 'k' },
      ],
    };
    const live = { ...base, performances: [perf] };
    const seq = new Sequencer({ getProject: () => live });
    seq.start(0, { mode: { kind: 'replay', performanceId: 'perf1' } });
    const [clip, played] = notesOf(seq.process(0.5), 't3');
    expect(played).toMatchObject({ tick: 30, source: 'replay', legato: true, time: sec(30) });
    // Truncated at the played note's (unswung) start, not at the swung position of tick 30.
    expect(clip.time + clip.duration).toBeCloseTo(played.time, 12);
    expect(clip.durationTicks).toBe(30);
  });

  it('restores the live launcher when the replay stops', () => {
    const { live } = recorded();
    const seq = new Sequencer({ getProject: () => live });
    seq.launchClip('t1', 1, 0);
    seq.start(0, { mode: { kind: 'replay', performanceId: 'perf1' } });
    expect(seq.getTrackState('t1').playing).toMatchObject({ slot: 0 });
    runTo(seq, 0, 3);
    seq.stop(3);
    expect(seq.getTrackState('t1').playing).toMatchObject({ slot: 1, startTick: 0 });
    expect(seq.activeProject()).toBe(live);
  });

  it('rejects an unknown performance', () => {
    const { live } = recorded();
    const seq = new Sequencer({ getProject: () => live });
    expect(() => seq.start(0, { mode: { kind: 'replay', performanceId: 'nope' } })).toThrow(/not found/);
    expect(seq.playing).toBe(false);
  });
});
