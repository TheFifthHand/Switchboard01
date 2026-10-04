/**
 * Launching the clip a part already plays keeps it playing in phase: a stop
 * or switch queued for the part is called off (also one the look-ahead had
 * already applied) and its loop is not restarted at the next bar. That is
 * what a second click on a pad queued to stop does, and "Play row" on a row
 * that partly plays already. In the song, the pad holds the clip in phase
 * against a song change on that bar line.
 */
import { describe, expect, it } from 'vitest';
import type { Id, Project } from '../../src/project/types';
import { makeClip, makeProject, setClip } from './sequencer-fixtures';
import { BAR, Rig, fixture, pitchOf, plays } from './r5-engine-rig';

/** t1 and t2: a 2-bar clip in slot 0 (a note per bar, pitch 30 + bar) and a 1-bar one in slot 1 (pitch 50). */
function pads(): Project {
  let p = makeProject(120);
  for (const id of ['t1', 't2']) {
    p = setClip(p, id, 0, makeClip(2, [[0, 30, 48], [BAR, 31, 48]], 'two'));
    p = setClip(p, id, 1, makeClip(1, [[0, 50, 48]], 'one'));
  }
  return p;
}

/** Ask for a stop of `trackId` now, as RealtimeTransport.stopTrack does (regenerating when it lands inside what is scheduled). */
function stop(r: Rig, trackId: Id): void {
  const res = r.seq.stopTrack(trackId, r.now);
  if (res.atTick < r.seq.generatedTick) r.cancelFrom(Math.max(res.atTime, r.now));
}

const before = (tick: number) => ([t]: readonly [number, ...unknown[]]) => t < tick;

describe('the clip a part plays, launched again', () => {
  it('a stop queued for the part is called off: the clip plays on in phase, nothing restarts', () => {
    const r = new Rig(pads());
    r.tap('t1', 0).play({ mode: { kind: 'live' } }).to(100);
    stop(r, 't1');
    expect(r.seq.getTrackState('t1').queued).toEqual({ slot: null, atTick: BAR });
    r.tap('t1', 0);
    expect(r.seq.getTrackState('t1').queued).toBeNull();
    r.to(4 * BAR);
    // Bar 2 is the clip's second bar: it was not restarted.
    expect(r.notes('t1').filter(before(4 * BAR))).toEqual([[0, 30], [BAR, 31], [2 * BAR, 30], [3 * BAR, 31]]);
    // Armed and started with Play (no launch event), never launched again.
    expect(r.launches('t1')).toEqual([]);
    expect(r.seq.getTrackState('t1').playing).toMatchObject({ slot: 0, startTick: 0 });
  });

  it('also when the look-ahead had already applied the stop (the click comes just before the bar line)', () => {
    const r = new Rig(pads());
    r.tap('t1', 0).play({ mode: { kind: 'live' } }).to(BAR - 150);
    stop(r, 't1');
    // 300 ms ahead: the stop at the bar line is already generated.
    r.to(BAR - 30);
    expect(r.seq.generatedTick).toBeGreaterThan(BAR);
    r.tap('t1', 0);
    r.to(3 * BAR);
    expect(r.notes('t1').filter(before(3 * BAR))).toEqual([[0, 30], [BAR, 31], [2 * BAR, 30]]);
    expect(r.launches('t1').filter(([t]) => t < 3 * BAR)).toEqual([]);
  });

  it('a switch to another clip queued for the part is called off the same way', () => {
    const r = new Rig(pads());
    r.tap('t1', 0).play({ mode: { kind: 'live' } }).to(BAR + 100);
    r.tap('t1', 1);
    expect(r.seq.getTrackState('t1').queued).toEqual({ slot: 1, atTick: 2 * BAR });
    r.tap('t1', 0);
    r.to(4 * BAR);
    expect(r.notes('t1').filter(before(4 * BAR))).toEqual([[0, 30], [BAR, 31], [2 * BAR, 30], [3 * BAR, 31]]);
  });

  it('Play row on a row that partly plays: what already plays it goes on in phase, the others switch at the next bar', () => {
    const r = new Rig(pads());
    r.tap('t1', 0).tap('t2', 1).play({ mode: { kind: 'live' } }).to(BAR + 100);
    r.seq.launchScene(0, r.now);
    r.to(4 * BAR);
    // t1 was in its clip's second bar at bar 2 and goes on: bar 3 is its first again.
    expect(r.notes('t1').filter(before(4 * BAR))).toEqual([[0, 30], [BAR, 31], [2 * BAR, 30], [3 * BAR, 31]]);
    // t2 switches to the 2-bar clip at bar 3, from its start.
    expect(r.notes('t2').filter(before(4 * BAR))).toEqual([[0, 50], [BAR, 50], [2 * BAR, 30], [3 * BAR, 31]]);
    expect(r.launches('t1')).toEqual([]);
    expect(r.launches('t2')).toEqual([[2 * BAR, 0]]);
  });

  it('while paused: called off the same way; Resume plays on in phase', () => {
    const r = new Rig(pads());
    r.tap('t1', 0).play({ mode: { kind: 'live' } }).to(BAR + 100).pause();
    stop(r, 't1');
    r.tap('t1', 0);
    r.wait(0.5).resume().to(4 * BAR);
    expect(r.notes('t1').filter(before(4 * BAR))).toEqual([[0, 30], [BAR, 31], [2 * BAR, 30], [3 * BAR, 31]]);
  });

  it('in the song, a pad of the clip the part plays holds it, in phase, over the song’s change on that bar line', () => {
    // t1 plays slot 1 over bars 3–6 (its 2-bar clip), slot 2 from bar 7.
    const r = new Rig(fixture()).playSong(2).to(2304 - 150);
    r.tap('t1', 1);
    r.to(2304 + 2 * BAR);
    // The 2-bar clip goes on past bar 7, in phase with its region (bar 7 is its first bar again).
    expect(r.notes('t1').filter((n) => n[0] >= 768 && n[0] < 3072)).toEqual(plays(1, 768, 3072));
    expect(r.notes('t1').find(([t]) => t === 2304)).toEqual([2304, pitchOf(1, 0)]);
  });
});
