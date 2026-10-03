import { describe, expect, it } from 'vitest';
import type { Performance, Project } from '../../src/project/types';
import type { SeqEvent } from '../../src/time/contracts';
import { Sequencer, nextBarTick, type NoteEvent } from '../../src/time/sequencer';
import { makeSnapshot } from '../../src/time/snapshot';
import { Holder, effectiveEnds, makeClip, makeProject, notesOf, ofKind, runTo, sec, setClip } from './sequencer-fixtures';
import { DEFAULT_LOOKAHEAD as LOOKAHEAD } from '../../src/time/transport';

const SIXTEENTHS = Array.from({ length: 16 }, (_, i) => [i * 24, 60 + (i % 4)] as [number, number]);

function expectOrdered(events: readonly SeqEvent[]): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].tick).toBeGreaterThanOrEqual(events[i - 1].tick);
    expect(events[i].time).toBeGreaterThanOrEqual(events[i - 1].time - 1e-9);
  }
}

describe('Sequencer: looping clips', () => {
  it('plays note n of a clip at S + k*L + n.tick with exact times over 5 bars', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [96, 1], [192, 0], [288, 1], [336, 2]]));
    p = setClip(p, 't4', 0, makeClip(2, [[0, 60, 48], [400, 64, 96]]));
    const seq = new Sequencer({ getProject: new Holder(p).get });
    // Launching while stopped arms the clip for Play.
    expect(seq.launchClip('t1', 0, 0)).toMatchObject({ slot: 0, atTick: 0 });
    seq.launchClip('t4', 0, 0);
    expect(seq.getTrackState('t1')).toMatchObject({ playing: { slot: 0, startTick: 0 }, queued: null });

    const t0 = 1;
    seq.start(t0);
    const events = runTo(seq, t0, t0 + 10);
    expectOrdered(events);

    const drums = notesOf(events, 't1');
    const expected: number[] = [];
    for (let k = 0; k < 5; k++) for (const n of [0, 96, 192, 288, 336]) expected.push(k * 384 + n);
    expect(drums.map((n) => n.tick)).toEqual(expected);
    for (const n of drums) {
      expect(n.time).toBeCloseTo(t0 + sec(n.tick), 9);
      expect(n.source).toBe('clip');
    }

    const chords = notesOf(events, 't4');
    expect(chords.map((n) => n.tick)).toEqual([0, 400, 768, 1168, 1536]);
    expect(chords[1].durationTicks).toBe(96);
    expect(chords[1].duration).toBeCloseTo(sec(96), 9);

    const beats = ofKind(events, 'beat');
    expect(beats.map((b) => b.tick)).toEqual(Array.from({ length: 20 }, (_, i) => i * 96));
    expect(beats.every((b) => !b.countIn && b.beatSeconds === 0.5)).toBe(true);
    expect(beats.slice(0, 5).map((b) => [b.bar, b.beat])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [1, 0]]);
  });

  it('gives the same events however the timeline is windowed', () => {
    let p = makeProject(97);
    p.swing = 0.6;
    p = setClip(p, 't1', 0, makeClip(3, [[0, 0], [24, 1, 30], [500, 2], [1100, 3, 90]]));
    p = setClip(p, 't3', 0, makeClip(1, [[0, 36, 60], [24, 38, 48], [200, 40, 300]]));
    const make = (): Sequencer => {
      const s = new Sequencer({ getProject: () => p });
      s.launchClip('t1', 0, 0);
      s.launchClip('t3', 0, 0);
      s.start(0.25);
      return s;
    };
    const a = make();
    const b = make();
    const one = a.process(9);
    const many = runTo(b, 0.25, 9, 0.0173);
    const key = (e: SeqEvent) => JSON.stringify(e);
    expect(many.map(key)).toEqual(one.map(key));
    expect(one.length).toBeGreaterThan(30);
  });

  it('plays a start launcher entered later on the timeline from the start, in loop phase', () => {
    let p = makeProject(120);
    const drums = makeClip(1, [[0, 0], [192, 1]], 'drums');
    const pad = makeClip(2, [[0, 60, 96], [384, 64, 96]], 'pad');
    p = setClip(p, 't1', 0, drums);
    p = setClip(p, 't6', 0, pad);
    const seq = new Sequencer({ getProject: () => p });
    // Snapshot of a transport that was at bar 7: drums entered at bar 5, the 2-bar pad at bar 7.
    seq.start(0, {
      launcher: [
        { trackId: 't1', playing: { slot: 0, startTick: 5 * 384 } },
        { trackId: 't6', playing: { slot: 0, startTick: 7 * 384 } },
      ],
    });
    const events = runTo(seq, 0, 4);
    expect(notesOf(events, 't1').map((n) => n.tick)).toEqual([0, 192, 384, 576]);
    // 7 bars = 3.5 pad loops: at tick 0 the pad is half-way, in its second bar.
    expect(notesOf(events, 't6').map((n) => [n.tick, n.pitch])).toEqual([
      [0, 64],
      [384, 60],
    ]);
    expect(seq.getTrackState('t6').playing).toMatchObject({ slot: 0, startTick: -384 });
  });

  it('keeps generating notes for muted tracks (the engine mutes at the channel)', () => {
    let p = makeProject();
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0]]));
    p.tracks[0].mute = true;
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    expect(notesOf(seq.process(2.5), 't1').map((n) => n.tick)).toEqual([0, 384]);
  });
});

describe('Sequencer: live launcher', () => {
  it('queues a launch at the next bar strictly after the playhead', () => {
    expect(nextBarTick(0)).toBe(384);
    expect(nextBarTick(383.9)).toBe(384);
    expect(nextBarTick(384)).toBe(768);
    expect(nextBarTick(-200)).toBe(0);
    let p = makeProject();
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0]]));
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0);
    expect(seq.launchClip('t1', 0, 2).atTick).toBe(768); // exactly on bar 1
    expect(seq.launchClip('t1', 0, 2.0001)).toMatchObject({ atTick: 768, atTime: 4 });
  });

  it('switches exactly at the next bar and never overlaps two clips on one track', () => {
    let p = makeProject();
    const A = makeClip(2, [[0, 60, 768], [384, 62, 96]], 'A');
    const B = makeClip(1, [[0, 67, 96], [192, 69, 96]], 'B');
    p = setClip(p, 't4', 0, A);
    p = setClip(p, 't4', 1, B);
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t4', 0, 0);
    seq.start(0);
    const e1 = runTo(seq, 0, 1.3); // generated up to tick ~250: A's long note is out already
    expect(notesOf(e1, 't4')[0]).toMatchObject({ tick: 0, durationTicks: 768 });

    const r = seq.launchClip('t4', 1, 1.3);
    expect(r).toEqual({ trackId: 't4', slot: 1, atTick: 384, atTime: 2 });
    expect(seq.getTrackState('t4')).toMatchObject({ playing: { slot: 0 }, queued: { slot: 1, atTick: 384 } });
    // The outgoing long note is cut at the switch.
    const cuts = seq.takeCuts();
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ trackId: 't4', tick: 384 });
    expect(cuts[0].time).toBeCloseTo(2, 12);
    expect(cuts[0].note.tick).toBe(0);

    // Re-launching the queued slot keeps it.
    expect(seq.launchClip('t4', 1, 1.6).atTick).toBe(384);
    expect(seq.takeCuts()).toHaveLength(0);

    const e2 = runTo(seq, 1.3, 5);
    const launches = ofKind(e2, 'launch');
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ tick: 384, trackId: 't4', slot: 1, clipId: B.id });
    expect(launches[0].time).toBeCloseTo(2, 12);
    expect(seq.getTrackState('t4')).toEqual({ playing: { slot: 1, clipId: B.id, startTick: 384 }, queued: null });

    const all = notesOf([...e1, ...e2], 't4');
    expect(all.filter((n) => n.clipId === A.id).map((n) => n.tick)).toEqual([0]);
    expect(all.filter((n) => n.clipId === B.id).map((n) => n.tick)).toEqual([384, 576, 768]);
    const ends = effectiveEnds(all, cuts);
    for (const a of all.filter((n) => n.clipId === A.id)) {
      for (const b of all.filter((n) => n.clipId === B.id)) {
        const overlap = Math.min(ends.get(a)!, ends.get(b)!) - Math.max(a.time, b.time);
        expect(overlap).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it('playingAt tells which clip (and loop start) a track played at an earlier tick, across switches and restarts', () => {
    let p = makeProject();
    p = setClip(p, 't4', 0, makeClip(1, [[0, 60]], 'A'));
    p = setClip(p, 't4', 1, makeClip(1, [[0, 62]], 'B'));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t4', 0, 0);
    // Armed while stopped, with a count-in: it plays from tick 0, and the count-in counts as before it.
    seq.start(0, { countInBars: 1 });
    expect(seq.playingAt('t4', -200)).toEqual({ slot: 0, startTick: 0 });
    runTo(seq, 0, 2.5); // tick 96
    seq.launchClip('t4', 1, 2.5); // at 384
    runTo(seq, 2.5, 4.5); // tick 480
    seq.launchClip('t4', 1, 4.5); // restart at 768
    runTo(seq, 4.5, 6.1); // past 768
    expect(seq.playingAt('t4', 100)).toEqual({ slot: 0, startTick: 0 });
    expect(seq.playingAt('t4', 383)).toEqual({ slot: 0, startTick: 0 });
    expect(seq.playingAt('t4', 384)).toEqual({ slot: 1, startTick: 384 });
    expect(seq.playingAt('t4', 767)).toEqual({ slot: 1, startTick: 384 });
    expect(seq.playingAt('t4', 800)).toEqual({ slot: 1, startTick: 768 });
    expect(seq.playingAt('t9', 800)).toBeNull();
  });

  it('launching the playing slot with nothing queued restarts it at the next bar', () => {
    let p = makeProject();
    const A = makeClip(2, [[0, 60, 24], [384, 62, 24]], 'A');
    p = setClip(p, 't4', 0, A);
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t4', 0, 0);
    seq.start(0);
    const e1 = runTo(seq, 0, 0.5);
    expect(seq.launchClip('t4', 0, 0.5).atTick).toBe(384);
    const e2 = runTo(seq, 0.5, 4.5);
    expect(ofKind(e2, 'launch')).toMatchObject([{ tick: 384, slot: 0, clipId: A.id }]);
    // Restarted from the top at 384: pitch 60 there, not A's second bar.
    expect(notesOf([...e1, ...e2], 't4').map((n) => [n.tick, n.pitch])).toEqual([
      [0, 60],
      [384, 60],
      [768, 62],
    ]);
  });

  it('launches a scene row (empty slots stop) and stops everything at the next bar', () => {
    let p = makeProject();
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [192, 1]]));
    p = setClip(p, 't1', 1, makeClip(1, [[96, 2], [288, 3]]));
    p = setClip(p, 't2', 0, makeClip(1, [[48, 5]]));
    p = setClip(p, 't3', 1, makeClip(1, [[0, 36, 96]]));
    const seq = new Sequencer({ getProject: () => p });
    const armed = seq.launchScene(0, 0);
    expect(armed.map((r) => r.slot)).toEqual([0, 0, null, null, null, null, null, null]);
    seq.start(0);
    const e1 = runTo(seq, 0, 0.7);
    const rs = seq.launchScene(1, 0.7);
    expect(rs.every((r) => r.atTick === 384)).toBe(true);
    expect(rs.slice(0, 3).map((r) => r.slot)).toEqual([1, null, 1]);
    const e2 = runTo(seq, 0.7, 2.9);
    const stops = seq.stopAll(2.9);
    expect(stops.every((r) => r.atTick === 768 && r.slot === null)).toBe(true);
    const e3 = runTo(seq, 2.9, 6);
    const all = [...e1, ...e2, ...e3];
    expectOrdered(all);

    const launches = ofKind(all, 'launch').map((l) => [l.tick, l.trackId, l.slot]);
    expect(launches).toEqual([
      [384, 't1', 1],
      [384, 't2', null],
      [384, 't3', 1],
      [768, 't1', null],
      [768, 't3', null],
    ]);
    expect(notesOf(all, 't1').map((n) => n.tick)).toEqual([0, 192, 480, 672]);
    expect(notesOf(all, 't2').map((n) => n.tick)).toEqual([48]);
    expect(notesOf(all, 't3').map((n) => n.tick)).toEqual([384]);
    // The transport keeps running after stop-all.
    expect(ofKind(all, 'beat')).toHaveLength(12);
    expect(seq.getLauncherSnapshot().every((e) => e.playing === null)).toBe(true);
  });

  it('a launch inside the generated window is exact after invalidating from its time', () => {
    let p = makeProject();
    const A = makeClip(1, SIXTEENTHS, 'A');
    const B = makeClip(1, [[0, 72, 24]], 'B');
    p = setClip(p, 't5', 0, A);
    p = setClip(p, 't5', 1, B);
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t5', 0, 0);
    seq.start(0);
    const e1 = seq.process(2.1); // look-ahead already past bar 1 (tick 403)
    const r = seq.launchClip('t5', 1, 1.95);
    expect(r.atTick).toBe(384);
    expect(r.atTick).toBeLessThan(seq.generatedTick);
    // The driver cancels what starts at/after the switch, then regenerates.
    seq.invalidate(r.atTime);
    const e2 = runTo(seq, 2.1, 4);
    expect(e2.every((e) => e.time >= r.atTime)).toBe(true);
    const kept = e1.filter((e) => e.time < r.atTime);
    const timeline = notesOf([...kept, ...e2], 't5');
    expect(timeline.filter((n) => n.clipId === A.id).map((n) => n.tick)).toEqual(SIXTEENTHS.map(([t]) => t));
    expect(timeline.filter((n) => n.clipId === B.id).map((n) => n.tick)).toEqual([384]);
    expect(ofKind(e2, 'launch')).toMatchObject([{ tick: 384, slot: 1 }]);
  });

  it('a tempo change after a queued switch still ends the outgoing note exactly at the switch', () => {
    let p = makeProject(120);
    const A = makeClip(2, [[0, 60, 768]], 'A');
    const B = makeClip(1, [[0, 67, 96]], 'B');
    p = setClip(p, 't4', 0, A);
    p = setClip(p, 't4', 1, B);
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t4', 0, 0);
    seq.start(0);
    const e1 = seq.process(0.3);
    seq.launchClip('t4', 1, 0.3); // switch at 384; A's long note is cut there (2 s at 120 BPM)
    const cuts = seq.takeCuts();
    const e2 = seq.process(0.6);
    // Faster: bar 1 now comes long before 2 s.
    seq.setTempo(200, 0.5);
    cuts.push(...seq.takeCuts());
    seq.invalidate(0.5);
    const e3 = runTo(seq, 0.6, 3);
    cuts.push(...seq.takeCuts());
    const all = notesOf([...e1, ...e2.filter((e) => e.time < 0.5), ...e3], 't4');
    const a = all.find((n) => n.clipId === A.id)!;
    const b = all.find((n) => n.clipId === B.id)!;
    const switchTime = 0.5 + sec(384 - 96, 200);
    expect(b.tick).toBe(384);
    expect(b.time).toBeCloseTo(switchTime, 9);
    expect(effectiveEnds(all, cuts).get(a)).toBeCloseTo(switchTime, 9);
  });

  it('shortens a sounding note that spans a tempo increase to end at its tick', () => {
    let p = makeProject(120);
    p = setClip(p, 't6', 0, makeClip(2, [[0, 48, 768]]));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t6', 0, 0);
    seq.start(0);
    const [pad] = notesOf(seq.process(0.2));
    expect(pad.duration).toBeCloseTo(4, 9);
    seq.setTempo(180, 1);
    // Tick 768 is now at 1 s + 576 ticks at 180 BPM.
    expect(seq.takeCuts()).toMatchObject([{ note: pad, tick: 768, time: expect.closeTo(1 + sec(576, 180), 9) }]);
    // Slower tempo: a voice cannot be lengthened, so no cut is issued.
    seq.setTempo(60, 1.5);
    expect(seq.takeCuts()).toEqual([]);
  });

  it('hands out the end of a song once, also when invalidated just after it', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [336, 1]]));
    p.arrangement = { tailSeconds: 1, blocks: [{ id: 'b', sceneId: p.scenes[0].id, repeats: 1 }] };
    const run = (from: number): { first: SeqEvent[]; again: SeqEvent[] } => {
      const seq = new Sequencer({ getProject: () => p });
      seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
      const first = seq.process(2.1); // the end (tick 384, 2 s) is out
      seq.invalidate(from);
      return { first, again: seq.process(2.5) };
    };
    // Invalidated after the end: it stays delivered and is not repeated.
    const late = run(2.02);
    expect(ofKind(late.first, 'end')).toHaveLength(1);
    expect(late.again).toEqual([]);
    // Invalidated before the end: the driver cancelled it, so it comes back exactly once.
    const early = run(1.7);
    expect(ofKind(early.again, 'end')).toMatchObject([{ tick: 384, time: 2 }]);
    expect(notesOf(early.again).map((n) => n.tick)).toEqual([336]);
  });

  it('a failed replay start leaves the current playback running', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [192, 1]]));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    seq.process(0.5);
    expect(() => seq.start(0.6, { mode: { kind: 'replay', performanceId: 'missing' } })).toThrow(/not found/);
    expect(seq.playing).toBe(true);
    expect(notesOf(seq.process(2.5)).map((n) => n.tick)).toEqual([192, 384]);
  });

  it('Stop re-arms the latest intention; Play starts it from the top', () => {
    let p = makeProject();
    const A = makeClip(1, [[0, 60]], 'A');
    const B = makeClip(1, [[48, 64]], 'B');
    p = setClip(p, 't4', 0, A);
    p = setClip(p, 't4', 1, B);
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t4', 0, 0);
    seq.start(0);
    runTo(seq, 0, 1);
    seq.launchClip('t4', 1, 1); // queued for 384, stopped before it happens
    seq.stop(1.2);
    expect(seq.playing).toBe(false);
    expect(seq.getLauncherSnapshot().find((e) => e.trackId === 't4')).toEqual({ trackId: 't4', playing: { slot: 1, startTick: 0 } });
    // Stop returns the playhead to the start (bar 1).
    expect(seq.getPosition(5)).toEqual({ tick: 0, bar: 0, beat: 0, step: 0 });
    expect(seq.process(10)).toEqual([]);
    seq.start(10);
    expect(notesOf(seq.process(11), 't4').map((n) => [n.tick, n.clipId])).toEqual([[48, B.id]]);
  });
});

describe('Sequencer: tempo, swing and invalidation', () => {
  it('a tempo change mid-play re-times only later events', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, SIXTEENTHS));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    const e1 = runTo(seq, 0, 1.12); // look-ahead past t = 1.0 (tick 192)
    seq.setTempo(60, 1.0);
    seq.invalidate(1.0);
    const e2 = runTo(seq, 1.12, 5);
    expect(e2.every((e) => e.time >= 1.0)).toBe(true);
    const timeline = [...e1.filter((e) => e.time < 1.0), ...e2];
    const notes = notesOf(timeline);
    expect(notes.map((n) => n.tick)).toEqual(Array.from({ length: 24 }, (_, i) => i * 24));
    for (const n of notes) {
      const expected = n.tick < 192 ? sec(n.tick, 120) : 1 + sec(n.tick - 192, 60);
      expect(n.time).toBeCloseTo(expected, 9);
    }
    // Earlier ticks keep their times.
    expect(seq.timeAt(96)).toBeCloseTo(0.5, 12);
    expect(ofKind(e2, 'beat').every((b) => b.beatSeconds === 1)).toBe(true);
    expect(seq.bpm).toBe(60);
  });

  it('clamps tempo changes to 40-220 BPM', () => {
    const seq = new Sequencer({ getProject: () => makeProject() });
    seq.start(0);
    seq.setTempo(500, 0);
    expect(seq.bpm).toBe(220);
    seq.setTempo(1, 0);
    expect(seq.bpm).toBe(40);
  });

  it('swing delays off-beat 16ths by swing x 8 ticks and leaves on-beats alone', () => {
    let p = makeProject(120);
    p.swing = 0.5;
    p = setClip(p, 't1', 0, makeClip(1, SIXTEENTHS.map(([t, pitch]) => [t, pitch, 24] as [number, number, number])));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    const notes = notesOf(seq.process(2));
    expect(notes).toHaveLength(16);
    for (const n of notes) {
      const off = n.tick % 48 === 24;
      expect(n.time).toBeCloseTo(sec(n.tick + (off ? 4 : 0)), 9);
      // Duration runs from the swung start to the swung end.
      expect(n.duration).toBeCloseTo(sec(off ? 20 : 28), 9);
      expect(n.durationTicks).toBe(24);
    }
  });

  it('a swing change applies from its tick; swung notes before it keep their timing', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, SIXTEENTHS));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    const e1 = runTo(seq, 0, 1.1);
    seq.setSwing(1, 1.0); // from tick 192
    seq.invalidate(1.0);
    const e2 = runTo(seq, 1.1, 4);
    const notes = notesOf([...e1.filter((e) => e.time < 1.0), ...e2]);
    expect(notes.map((n) => n.tick)).toEqual(Array.from({ length: 32 }, (_, i) => i * 24));
    for (const n of notes) {
      const off = n.tick % 48 === 24 && n.tick >= 192;
      expect(n.time).toBeCloseTo(sec(n.tick + (off ? 8 : 0)), 9);
    }
    expect(seq.swingAt(100)).toBe(0);
    expect(seq.swingAt(200)).toBe(1);
  });

  it('invalidate regenerates notes whose swung time is at/after fromTime even if their tick is earlier', () => {
    let p = makeProject(120);
    p.swing = 1;
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [24, 1], [48, 2]]));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    const e1 = seq.process(0.3); // ticks < 57.6
    expect(notesOf(e1).map((n) => [n.tick, n.time])).toEqual([
      [0, 0],
      [24, sec(32)],
      [48, sec(48)],
    ]);
    const from = sec(30); // tickAt(from) = 30 > 24, but the note at 24 sounds at 32
    seq.invalidate(from);
    const e2 = seq.process(0.3);
    expect(notesOf(e2).map((n) => n.tick)).toEqual([24, 48]);
    expect(e2.every((e) => e.time >= from)).toBe(true);
    // Invalidating again without new output regenerates nothing twice.
    seq.invalidate(0.29);
    expect(notesOf(seq.process(0.3))).toHaveLength(0);
  });

  it('step edits after invalidate change later events only', () => {
    const h = new Holder(setClip(makeProject(120), 't2', 0, makeClip(1, SIXTEENTHS.map(([t]) => [t, 5] as [number, number]))));
    const seq = new Sequencer({ getProject: h.get });
    seq.launchClip('t2', 0, 0);
    seq.start(0);
    const e1 = runTo(seq, 0, 2.12);
    // Edit the clip (immutably, keeping its id) while playing.
    const old = h.project.tracks[1].clips[0]!;
    h.project = setClip(h.project, 't2', 0, { ...old, notes: old.notes.map((n) => ({ ...n, pitch: 9 })) });
    seq.invalidate(1.5);
    const e2 = runTo(seq, 2.12, 4);
    expect(e2.every((e) => e.time >= 1.5)).toBe(true);
    const timeline = notesOf([...e1.filter((e) => e.time < 1.5), ...e2]);
    expect(timeline.map((n) => n.tick)).toEqual(Array.from({ length: 32 }, (_, i) => i * 24));
    for (const n of timeline) expect(n.pitch).toBe(n.time < 1.5 ? 5 : 9);
  });

  it('rolls back and replays a clip switch when invalidating across it', () => {
    let p = makeProject();
    const A = makeClip(1, SIXTEENTHS, 'A');
    const B = makeClip(1, [[0, 72], [96, 74]], 'B');
    p = setClip(p, 't5', 0, A);
    p = setClip(p, 't5', 1, B);
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t5', 0, 0);
    seq.start(0);
    runTo(seq, 0, 1);
    seq.launchClip('t5', 1, 1);
    const e1 = runTo(seq, 1, 2.6); // switch at 384 (2.0 s) applied
    expect(ofKind(e1, 'launch')).toHaveLength(1);
    seq.invalidate(1.9);
    const e2 = runTo(seq, 2.6, 3);
    // The switch is replayed exactly once, at the same tick.
    expect(ofKind(e2, 'launch')).toMatchObject([{ tick: 384, slot: 1 }]);
    const timeline = notesOf([...e1.filter((e) => e.time < 1.9), ...e2], 't5');
    expect(timeline.filter((n) => n.tick >= 384).every((n) => n.clipId === B.id)).toBe(true);
    expect(timeline.filter((n) => n.tick < 384 && n.tick >= 192).every((n) => n.clipId === A.id)).toBe(true);
    expect(timeline.filter((n) => n.tick >= 360 && n.tick < 384)).toHaveLength(1);
  });
});

describe('Sequencer: count-in', () => {
  it('clicks one bar before tick 0 and plays no clip before it', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [192, 1]]));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t1', 0, 0);
    seq.start(3, { countInBars: 1 });
    expect(seq.tickAt(3)).toBe(-384);
    // Before the start time comes, the playhead waits at the start (not in the bar before it).
    expect(seq.getPosition(2.9)).toEqual({ tick: -384, bar: -1, beat: 0, step: 0 });
    const events = runTo(seq, 3, 7);
    const beats = ofKind(events, 'beat');
    expect(beats.map((b) => [b.tick, b.countIn])).toEqual([
      [-384, true],
      [-288, true],
      [-192, true],
      [-96, true],
      [0, false],
      [96, false],
      [192, false],
      [288, false],
    ]);
    expect(beats[0]).toMatchObject({ bar: -1, beat: 0 });
    expect(beats[0].time).toBeCloseTo(3, 12);
    const notes = notesOf(events);
    expect(notes.map((n) => n.tick)).toEqual([0, 192]);
    expect(notes[0].time).toBeCloseTo(5, 12);
  });
});

describe('Sequencer: mono parts', () => {
  it('marks legato when a note starts before the previous one ends and truncates the previous', () => {
    let p = makeProject(120);
    // t3 is the mono bass.
    p = setClip(p, 't3', 0, makeClip(1, [[0, 36, 48], [24, 38, 48], [96, 40, 24], [192, 43, 12], [192, 31, 12], [300, 45, 200]]));
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t3', 0, 0);
    seq.start(0);
    const notes = notesOf(seq.process(2.5), 't3');
    expect(notes.slice(0, 5).map((n) => [n.tick, n.pitch, n.durationTicks, n.legato])).toEqual([
      [0, 36, 24, false],
      [24, 38, 48, true],
      [96, 40, 24, false],
      // Two notes at once on a mono part: the lowest wins.
      [192, 31, 12, false],
      [300, 45, 84, false],
    ]);
    // The looped first note is not legato: the last note ended at the loop end.
    expect(notes[5]).toMatchObject({ tick: 384, legato: false });
    for (let i = 1; i < notes.length; i++) expect(notes[i - 1].time + notes[i - 1].duration).toBeLessThanOrEqual(notes[i].time + 1e-9);
  });

  it('cuts an already scheduled mono note when an arp note starts under it', () => {
    let p = makeProject(120);
    p = setClip(p, 't3', 0, makeClip(1, [[0, 36, 300]]));
    p.tracks[2].arp = { ...p.tracks[2].arp, enabled: true, division: '1/4', gate: 0.5 };
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t3', 0, 0);
    seq.start(0);
    const e1 = seq.process(0.3);
    expect(notesOf(e1)[0]).toMatchObject({ tick: 0, durationTicks: 300 });
    seq.setArpHeld('t3', [48], 0.3); // next quarter: tick 96
    const e2 = seq.process(1);
    const arp = notesOf(e2).filter((n) => n.source === 'arp');
    expect(arp[0]).toMatchObject({ tick: 96, pitch: 48, legato: true });
    expect(seq.takeCuts()).toMatchObject([{ tick: 96, note: { tick: 0 } }]);
  });
});

/* ------------------------------------------------------------------ */
/* Pause and resume                                                    */
/* ------------------------------------------------------------------ */

describe('Sequencer: pause and resume', () => {
  /** A 1-bar 16ths clip on t1 and a 3-bar clip on t4 (phases that only line up every 3 bars). */
  function twoClips(swing = 0): Project {
    let p = makeProject(120);
    p.swing = swing;
    p = setClip(p, 't1', 0, makeClip(1, SIXTEENTHS, 'hats'));
    p = setClip(p, 't4', 0, makeClip(3, [[0, 60, 96], [500, 64, 48], [1000, 67, 96]], 'long'));
    return p;
  }

  function playing(p: Project, t0: number): Sequencer {
    const s = new Sequencer({ getProject: () => p });
    s.launchClip('t1', 0, 0);
    s.launchClip('t4', 0, 0);
    s.start(t0);
    return s;
  }

  /**
   * What is heard with a pause from `pauseAt` to `resumeAt`: notes handed out
   * before the pause count when they start before it (the driver cancels the
   * rest of the look-ahead), plus everything after the resume.
   */
  function heardWithPause(seq: Sequencer, t0: number, pauseAt: number, resumeAt: number, until: number) {
    const before = runTo(seq, t0, pauseAt + LOOKAHEAD);
    expect(seq.pause(pauseAt)).toBe(true);
    // Nothing is generated while paused, however long the pause lasts.
    expect(seq.process(resumeAt - 0.001)).toEqual([]);
    expect(seq.resume(resumeAt)).toBe(true);
    const after = runTo(seq, resumeAt, until);
    return { before: before.filter((e) => e.time < pauseAt), after };
  }

  const key = (n: NoteEvent) => `${n.trackId}:${n.tick}:${n.pitch}`;

  it('holds the playhead and every clip phase; Play continues exactly there, in time, with no backlog', () => {
    const p = twoClips();
    const t0 = 1;
    const ref = notesOf(runTo(playing(p, t0), t0, t0 + sec(3200)));
    const pauseTick = 1234.5; // mid-bar 4, inside a 16th
    const pauseAt = t0 + sec(pauseTick);
    const resumeAt = 40;
    const seq = playing(p, t0);
    const { before, after } = heardWithPause(seq, t0, pauseAt, resumeAt, resumeAt + sec(3200 - pauseTick));
    // While paused (and after resuming, until the music moves on) the playhead reads the pause point.
    expect(seq.getPosition(resumeAt).tick).toBeCloseTo(pauseTick, 6);
    expect(seq.getTrackState('t4').playing).toMatchObject({ slot: 0, startTick: 0 });

    // No backlog: nothing after the resume is timed before it.
    expect(after.every((e) => e.time >= resumeAt - 1e-9)).toBe(true);
    const shift = resumeAt - pauseAt;
    const heard = [...notesOf(before), ...notesOf(after)];
    // Every note of the uninterrupted run is heard exactly once: before the pause at its own time,
    // after it shifted by the length of the pause (so every clip keeps its phase).
    const expected = ref.filter((n) => n.tick < 3190);
    const got = heard.filter((n) => n.tick < 3190);
    expect(got.map(key)).toEqual(expected.map(key));
    got.forEach((n, i) => {
      const r = expected[i];
      expect(n.time).toBeCloseTo(r.tick < pauseTick ? r.time : r.time + shift, 9);
      expect(n.durationTicks).toBe(r.durationTicks);
    });
    // The 3-bar clip's second loop comes in at tick 1152 + 384 ... i.e. its notes stay on S + k*L + n.
    expect(notesOf(after, 't4').map((n) => n.tick)).toEqual([1652, 2152, 2304, 2804]);
    // The first beat after the resume is the next beat after the pause point.
    const beats = ofKind(after, 'beat');
    expect(beats[0]).toMatchObject({ tick: 1248, bar: 3, beat: 1 });
    expect(beats[0].time).toBeCloseTo(resumeAt + sec(1248 - pauseTick), 9);
  });

  it('a swung note the pause came before plays after the resume, once', () => {
    const p = twoClips(0.6);
    const t0 = 0.5;
    const ref = notesOf(runTo(playing(p, t0), t0, t0 + 6));
    // The off-beat 16th at 792 is swung to 796.8: pause in between.
    const pauseTick = 794;
    const seq = playing(p, t0);
    const pauseAt = seq.timeAt(pauseTick);
    const resumeAt = 20;
    const { before, after } = heardWithPause(seq, t0, pauseAt, resumeAt, resumeAt + 6 - (pauseAt - t0));
    const shift = resumeAt - pauseAt;
    const swungLate = notesOf(after, 't1')[0];
    expect(swungLate.tick).toBe(792);
    expect(swungLate.time).toBeCloseTo(resumeAt + sec(796.8 - pauseTick), 9);
    const heard = [...notesOf(before), ...notesOf(after)];
    const limit = ref.filter((n) => n.time + (n.time >= pauseAt ? shift : 0) < resumeAt + 5.5 - (pauseAt - t0));
    expect(heard.slice(0, limit.length).map(key)).toEqual(limit.map(key));
    heard.slice(0, limit.length).forEach((n, i) => expect(n.time).toBeCloseTo(limit[i].time < pauseAt ? limit[i].time : limit[i].time + shift, 9));
  });

  it('a launch queued before the pause, and one made while paused, happen at their bar after the resume', () => {
    let p = makeProject(120);
    const A = makeClip(1, [[0, 60], [192, 62]], 'A');
    const B = makeClip(1, [[0, 70], [96, 72]], 'B');
    p = setClip(p, 't4', 0, A);
    p = setClip(p, 't4', 1, B);
    const seq = new Sequencer({ getProject: () => p });
    seq.launchClip('t4', 0, 0);
    seq.start(0);
    runTo(seq, 0, sec(300));
    expect(seq.launchClip('t4', 1, sec(300)).atTick).toBe(384);
    runTo(seq, sec(300), sec(350) + LOOKAHEAD);
    expect(seq.pause(sec(350))).toBe(true);
    expect(seq.getTrackState('t4')).toMatchObject({ playing: { slot: 0 }, queued: { slot: 1, atTick: 384 } });
    seq.resume(10);
    const after = runTo(seq, 10, 10 + sec(700));
    expect(ofKind(after, 'launch')).toMatchObject([{ tick: 384, slot: 1, clipId: B.id }]);
    expect(ofKind(after, 'launch')[0].time).toBeCloseTo(10 + sec(34), 9);
    expect(notesOf(after).map((n) => [n.tick, n.pitch])).toEqual([[384, 70], [480, 72], [768, 70], [864, 72]]);

    // Paused again, a launch queues for the next bar after the pause point.
    const at = 10 + sec(700);
    runTo(seq, 10 + sec(700), at + 0.1);
    seq.pause(at);
    expect(seq.getPosition(at).tick).toBeCloseTo(1050, 6);
    expect(seq.launchClip('t4', 0, 99)).toMatchObject({ slot: 0, atTick: 1152 });
    expect(seq.getTrackState('t4').queued).toEqual({ slot: 0, atTick: 1152 });
    seq.resume(30);
    const later = runTo(seq, 30, 31);
    expect(ofKind(later, 'launch')).toMatchObject([{ tick: 1152, slot: 0, clipId: A.id }]);
    expect(ofKind(later, 'launch')[0].time).toBeCloseTo(30 + sec(1152 - 1050), 9);
  });

  it('Stop from a pause goes back to bar 1 with the playing clips armed; Play starts them from the top', () => {
    const p = twoClips();
    const seq = playing(p, 0);
    runTo(seq, 0, 2.6);
    seq.pause(2.5);
    seq.stop(9);
    expect(seq.paused).toBe(false);
    expect(seq.playing).toBe(false);
    expect(seq.getPosition(9)).toEqual({ tick: 0, bar: 0, beat: 0, step: 0 });
    expect(seq.getLauncherSnapshot().filter((e) => e.playing).map((e) => [e.trackId, e.playing!.startTick])).toEqual([
      ['t1', 0],
      ['t4', 0],
    ]);
    expect(seq.resume(10)).toBe(false);
    seq.start(10);
    expect(notesOf(seq.process(10.01)).map((n) => [n.trackId, n.tick])).toEqual([
      ['t1', 0],
      ['t4', 0],
    ]);
  });

  it('a tempo change while paused applies from the resume (live and song playback follow the project)', () => {
    const h = new Holder(twoClips());
    const seq = new Sequencer({ getProject: h.get });
    seq.launchClip('t1', 0, 0);
    seq.start(0);
    runTo(seq, 0, 1.12);
    seq.pause(1); // tick 192
    h.project = { ...h.project, bpm: 60 };
    seq.resume(5);
    const beats = ofKind(runTo(seq, 5, 8), 'beat');
    expect(beats.slice(0, 3).map((b) => [b.tick, b.time])).toEqual([
      [192, expect.closeTo(5, 9)],
      [288, expect.closeTo(6, 9)],
      [384, expect.closeTo(7, 9)],
    ]);
  });

  it('song mode continues from the same block and bar', () => {
    let p = makeProject(120);
    const intro = makeClip(1, [[0, 36]], 'intro');
    const groove = makeClip(1, [[0, 40], [192, 41]], 'groove');
    const pad = makeClip(2, [[96, 60, 48]], 'pad');
    p = setClip(p, 't1', 0, intro);
    p = setClip(p, 't1', 1, groove);
    p = setClip(p, 't6', 1, pad);
    p.arrangement = { tailSeconds: 1, blocks: [{ id: 'a', sceneId: p.scenes[0].id, repeats: 1 }, { id: 'b', sceneId: p.scenes[1].id, repeats: 2 }] };
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    runTo(seq, 0, sec(1000) + LOOKAHEAD);
    expect(seq.pause(sec(1000))).toBe(true); // block b, second bar of the 2-bar pad
    expect(seq.mode).toEqual({ kind: 'song', fromBlock: 0 });
    seq.resume(20);
    expect(seq.mode).toEqual({ kind: 'song', fromBlock: 0 });
    const after = runTo(seq, 20, 30);
    // No block or launch is announced again: block b (2 bars x 2) simply carries on, its clips in phase.
    expect(ofKind(after, 'block')).toEqual([]);
    expect(ofKind(after, 'launch')).toEqual([]);
    expect(notesOf(after).map((n) => [n.trackId, n.tick])).toEqual([
      ['t1', 1152],
      ['t6', 1248],
      ['t1', 1344],
      ['t1', 1536],
      ['t1', 1728],
    ]);
    const end = ofKind(after, 'end');
    expect(end).toHaveLength(1);
    expect(end[0].tick).toBe(1920);
    expect(end[0].time).toBeCloseTo(20 + sec(920), 9);
  });

  it('a paused replay sends the control values the take had reached again when it resumes, and keeps its tempo map', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(1, [[0, 0], [192, 1]], 'A'));
    const snapshot = makeSnapshot(p, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], 0);
    const perf: Performance = {
      id: 'perf1',
      name: 'Take 1',
      createdAt: 0,
      startTick: 0,
      endTick: 3072,
      snapshot,
      events: [
        { t: 100, type: 'macro', trackId: 't1', macro: 'tone', value: 0.1 },
        { t: 300, type: 'macro', trackId: 't1', macro: 'tone', value: 0.7 },
        { t: 350, type: 'param', module: 't1:filter', param: 'cutoff', value: 900 },
        { t: 400, type: 'mute', trackId: 't2', mute: true },
        { t: 500, type: 'master', volumeDb: -6 },
        { t: 600, type: 'tempo', bpm: 60 },
        { t: 1600, type: 'macro', trackId: 't1', macro: 'tone', value: 0.3 },
        { t: 2000, type: 'tempo', bpm: 120 },
      ],
    };
    p = { ...p, performances: [perf] };
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'replay', performanceId: 'perf1' } });
    const pauseAt = sec(600) + sec(400, 60); // tick 1000, at 60 BPM since 600
    runTo(seq, 0, pauseAt + LOOKAHEAD);
    expect(seq.pause(pauseAt)).toBe(true);
    expect(seq.getPosition(0).tick).toBeCloseTo(1000, 6);
    seq.resume(50);
    const first = seq.process(50.001);
    const sent = first.filter((e) => e.kind !== 'beat' && e.kind !== 'note');
    expect(sent).toHaveLength(4);
    expect(sent).toEqual(expect.arrayContaining([
      { kind: 'macro', tick: 1000, time: 50, trackId: 't1', macro: 'tone', value: 0.7 },
      { kind: 'param', tick: 1000, time: 50, module: 't1:filter', param: 'cutoff', value: 900 },
      { kind: 'mute', tick: 1000, time: 50, trackId: 't2', mute: true },
      { kind: 'master', tick: 1000, time: 50, volumeDb: -6 },
    ]));
    const after = [...first, ...runTo(seq, 50.001, 70)];
    // 60 BPM from the resume, then the take's own change back to 120 at tick 2000.
    expect(ofKind(after, 'macro').map((m) => [m.tick, m.value])).toEqual([
      [1000, 0.7],
      [1600, 0.3],
    ]);
    expect(ofKind(after, 'macro')[1].time).toBeCloseTo(50 + sec(600, 60), 9);
    expect(ofKind(after, 'tempo').map((e) => [e.tick, e.bpm])).toEqual([[2000, 120]]);
    expect(ofKind(after, 'end')[0].time).toBeCloseTo(50 + sec(1000, 60) + sec(1072, 120), 9);
  });

  it('cannot pause when stopped or at the end of the music; a latched arpeggio ends at the pause', () => {
    const p = twoClips();
    p.tracks[4].arp = { enabled: true, division: '1/16', mode: 'up', octaves: 1, latch: true, gate: 0.5 };
    const seq = new Sequencer({ getProject: () => p });
    expect(seq.pause(0)).toBe(false);
    seq.start(0);
    seq.setArpHeld('t5', [60, 64], 0.1, 0.8);
    seq.setArpHeld('t5', [], 0.2); // latched: plays on
    runTo(seq, 0, 1.1);
    expect(seq.pause(1)).toBe(true);
    expect(seq.process(4)).toEqual([]);
    seq.resume(5);
    expect(notesOf(runTo(seq, 5, 7), 't5')).toEqual([]);
    // A song paused right at its end stops instead.
    const song = { ...p, arrangement: { tailSeconds: 1, blocks: [{ id: 'a', sceneId: p.scenes[0].id, repeats: 1 }] } };
    const s2 = new Sequencer({ getProject: () => song });
    s2.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    runTo(s2, 0, 7); // 3 bars (the longest clip in the row) = 6 s
    expect(s2.ended).toBe(true);
    expect(s2.pause(6.9)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Clips moved between pads                                            */
/* ------------------------------------------------------------------ */

describe('Sequencer: the launcher follows moved clips', () => {
  it('a clip moved within its part keeps playing from its new slot, in phase', () => {
    const h = new Holder(makeProject(120));
    const A = makeClip(2, [[0, 60], [384, 62]], 'A');
    h.project = setClip(h.project, 't4', 0, A);
    const seq = new Sequencer({ getProject: h.get });
    seq.launchClip('t4', 0, 0);
    seq.start(0);
    const before = runTo(seq, 0, sec(500));
    // The clip moves from slot 0 to slot 3 at tick 500 (the store change, then the launcher follows).
    h.project = setClip(setClip(h.project, 't4', 0, null), 't4', 3, A);
    expect(seq.relocateSlots('t4', new Map([[0, 3]]), sec(500))).toBe(true);
    seq.invalidate(sec(500));
    expect(seq.getTrackState('t4').playing).toMatchObject({ slot: 3, startTick: 0, clipId: A.id });
    const after = runTo(seq, sec(500), sec(1700));
    const notes = [...notesOf(before).filter((n) => n.time < sec(500)), ...notesOf(after)];
    expect(notes.map((n) => [n.tick, n.pitch])).toEqual([
      [0, 60],
      [384, 62],
      [768, 60],
      [1152, 62],
      [1536, 60],
    ]);
    expect(ofKind(after, 'launch')).toEqual([]);
  });

  it('a clip that left its part stops there at once (sounding notes cut), and its queued launch is dropped', () => {
    const h = new Holder(makeProject(120));
    const A = makeClip(1, [[0, 60, 380]], 'A');
    const B = makeClip(1, [[0, 64]], 'B');
    h.project = setClip(setClip(h.project, 't4', 0, A), 't4', 1, B);
    const seq = new Sequencer({ getProject: h.get });
    seq.launchClip('t4', 0, 0);
    seq.start(0);
    const first = runTo(seq, 0, sec(100) + LOOKAHEAD);
    seq.launchClip('t4', 1, sec(100)); // queued for 384
    // A moves to another part at tick 100; B moves too (both left t4).
    h.project = setClip(setClip(h.project, 't4', 0, null), 't4', 1, null);
    expect(seq.relocateSlots('t4', new Map([[0, null], [1, null]]), sec(100))).toBe(true);
    const cut = seq.takeCuts();
    expect(cut).toHaveLength(1);
    expect(cut[0].note).toBe(notesOf(first)[0]);
    expect(cut[0].time).toBeCloseTo(sec(100), 9);
    expect(seq.getTrackState('t4')).toEqual({ playing: null, queued: null });
    seq.invalidate(sec(100));
    expect(notesOf(runTo(seq, sec(100), 4))).toEqual([]);
  });

  it('moves while stopped keep the armed clip, and while paused the held clip, on its pad', () => {
    const h = new Holder(makeProject(120));
    const A = makeClip(1, [[0, 60]], 'A');
    h.project = setClip(h.project, 't4', 0, A);
    const seq = new Sequencer({ getProject: h.get });
    seq.launchClip('t4', 0, 0);
    h.project = setClip(setClip(h.project, 't4', 0, null), 't4', 2, A);
    seq.relocateSlots('t4', new Map([[0, 2]]), 0);
    expect(seq.getLauncherSnapshot()[3].playing).toEqual({ slot: 2, startTick: 0 });
    seq.start(1);
    runTo(seq, 1, 2.2);
    seq.pause(2); // tick 192
    h.project = setClip(setClip(h.project, 't4', 2, null), 't4', 1, A);
    seq.relocateSlots('t4', new Map([[2, 1]]), 5);
    expect(seq.getTrackState('t4').playing).toMatchObject({ slot: 1, startTick: 0 });
    seq.resume(10);
    const after = notesOf(runTo(seq, 10, 14));
    expect(after.map((n) => [n.tick, n.clipId])).toEqual([
      [384, A.id],
      [768, A.id],
    ]);
    expect(after[0].time).toBeCloseTo(10 + sec(384 - 192), 9);
  });

  it('a playing song keeps its scenes when the rows are reordered', () => {
    let p = makeProject(120);
    const intro = makeClip(1, [[0, 36]], 'intro');
    const groove = makeClip(1, [[0, 40]], 'groove');
    p = setClip(setClip(p, 't1', 0, intro), 't1', 1, groove);
    p.arrangement = { tailSeconds: 1, blocks: [{ id: 'a', sceneId: p.scenes[0].id, repeats: 1 }, { id: 'b', sceneId: p.scenes[1].id, repeats: 1 }] };
    const h = new Holder(p);
    const seq = new Sequencer({ getProject: h.get });
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    runTo(seq, 0, 0.3);
    // Swap rows 0 and 1 (scenes and clips together).
    h.project = { ...h.project, scenes: [h.project.scenes[1], h.project.scenes[0], ...h.project.scenes.slice(2)] };
    h.project = setClip(setClip(h.project, 't1', 0, groove), 't1', 1, intro);
    seq.relocateSongRows(new Map([[0, 1], [1, 0]]));
    seq.relocateSlots('t1', new Map([[0, 1], [1, 0]]), 0.3);
    seq.invalidate(0.3);
    const after = runTo(seq, 0.3, 5);
    expect(notesOf(after).map((n) => [n.tick, n.clipId])).toEqual([[384, groove.id]]);
    expect(ofKind(after, 'block').map((b) => [b.tick, b.sceneRow])).toEqual([[384, 0]]);
  });
});
