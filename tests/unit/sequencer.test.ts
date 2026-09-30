import { describe, expect, it } from 'vitest';
import type { SeqEvent } from '../../src/time/contracts';
import { Sequencer, nextBarTick } from '../../src/time/sequencer';
import { Holder, effectiveEnds, makeClip, makeProject, notesOf, ofKind, runTo, sec, setClip } from './sequencer-fixtures';

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
    expect(seq.getPosition(5)).toMatchObject({ tick: expect.closeTo(230.4, 6), bar: 0, beat: 2, step: 9 });
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
