/**
 * The song loop (bars [fromBar, toBar), runtime only): when the playhead
 * reaches the loop's end, playback continues at its start, in time, every
 * part playing exactly what the song plays there (each clip in phase with its
 * region), again and again until the loop is cleared. The transport tick runs
 * on (each pass is a new stretch of it), so beats, swing and the
 * arpeggiator run on through the seams. Setting, changing and clearing it
 * while the song plays or is paused follows SongLoop's rules (see
 * Sequencer.setSongLoop). Checked against the oracle computed from the
 * regions through the passes.
 */
import { describe, expect, it } from 'vitest';
import { TempoMap } from '../../src/time/clock';
import type { SongPass } from '../../src/time/sequencer';
import { notesOf, ofKind } from './sequencer-fixtures';
import { BAR, BEAT, MARGIN, Rig, UNEDITED, beatFixture, beatPitch, expectedChases, expectedNotes, pitchOf, plays } from './r5-engine-rig';

/** Passes of loop [from, to) bars following a first pass of song ticks [first, to) at transport tick `at` (`n` passes in all). */
function loopPasses(at: number, first: number, from: number, to: number, n: number): SongPass[] {
  const out: SongPass[] = [{ at, from: first * BAR, to: to * BAR }];
  for (let k = 1; k < n; k++) {
    const prev = out[k - 1];
    out.push({ at: prev.at + (prev.to - prev.from), from: from * BAR, to: to * BAR });
  }
  return out;
}

const before = (tick: number) => ([t]: readonly [number, ...unknown[]]) => t < tick;

/** No note twice on a part, launches on bar lines (or where an edit took effect), no end. */
function seamless(r: Rig, parts = ['t1', 't2', 't4']): void {
  for (const l of ofKind(r.out, 'launch')) if (!r.editTicks.includes(l.tick)) expect(l.tick % BAR, `launch at ${l.tick}`).toBe(0);
  for (const trackId of parts) {
    const seen = new Set<string>();
    for (const n of notesOf(r.out, trackId)) {
      const k = `${n.tick}:${n.pitch}`;
      expect(seen.has(k), `${trackId} ${k} twice`).toBe(false);
      seen.add(k);
    }
  }
  expect(r.ends()).toEqual([]);
}

describe('a loop plays its bars again and again, exactly as the song plays them there', () => {
  it('loop bars 3–6 from its start: three passes, every clip in phase with its region; no end', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 2, toBar: 6 }, 0);
    r.playSong(2).to(768 + 3 * 1536);
    const passes = loopPasses(768, 2, 2, 6, 3);
    for (const id of ['t1', 't2', 't4']) expect(r.notes(id).filter(before(5376)), id).toEqual(expectedNotes(r.project, passes, id, 0, 5376));
    expect(r.notes('t1').filter(before(5376))).toEqual([...plays(1, 768, 2304), ...plays(1, 2304, 3840), ...plays(1, 3840, 5376)]);
    // The loop starts where the region does: nothing is under way to chase.
    expect(r.chased('t4')).toEqual([]);
    // The 2-bar clip runs on through the seams (4 bars is two of its loops): nothing relaunches.
    expect(r.launches('t1')).toEqual([[768, 1]]);
    expect(r.seq.songLoopingAt(r.tick)).toBe(true);
    seamless(r);
  });

  it('a loop that starts inside a region restarts its clip in phase at every seam', () => {
    const r = new Rig();
    // Bars [3, 6): the slot 1 clip is in its second bar at bar 3.
    r.seq.setSongLoop({ fromBar: 3, toBar: 6 }, 0);
    r.playSong(3).to(1152 + 3 * 1152);
    const passes = loopPasses(1152, 3, 3, 6, 3);
    for (const id of ['t1', 't2', 't4']) expect(r.notes(id).filter(before(4608)), id).toEqual(expectedNotes(r.project, passes, id, 0, 4608));
    expect(r.notes('t1').filter(before(2304)).map(([, p]) => p)).toEqual([pitchOf(1, 1), pitchOf(1, 0), pitchOf(1, 1)]);
    expect(r.launches('t1').filter(before(4608))).toEqual([[1152, 1], [2304, 1], [3456, 1]]);
    // The held chord sounds as the song plays it there: at the start and at every seam, the chord under way
    // (struck in the clip's first bar) sounds from there with what is left of it; then it is struck again
    // where the clip starts over, and cut at the seam.
    expect(r.held('t4').filter(before(4608))).toEqual([[1152, 50, 1536], [1536, 50, 2304], [2304, 50, 2688], [2688, 50, 3456], [3456, 50, 3840], [3840, 50, 4608]]);
    expect(r.chased('t4').filter(before(4608))).toEqual([[1152, 50], [2304, 50], [3456, 50]]);
    expect(r.chased('t4').filter(before(4608))).toEqual(expectedChases(r.project, passes, 't4', 0, 4608));
    // A drum kit never chases.
    expect(r.chased('t1')).toEqual([]);
    seamless(r);
  });

  it('a loop over several regions, ending inside one: they play in song order, then again from the loop start', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 1, toBar: 7 }, 0);
    r.playSong(1).to(BAR + 3 * 6 * BAR);
    const passes = loopPasses(BAR, 1, 1, 7, 3);
    for (const id of ['t1', 't2', 't4']) {
      expect(r.notes(id).filter(before(19 * BAR)), id).toEqual(expectedNotes(r.project, passes, id, 0, 19 * BAR));
      expect(r.chased(id).filter(before(19 * BAR)), id).toEqual(expectedChases(r.project, passes, id, 0, 19 * BAR));
    }
    // Bar 2 is the second bar of the 2-bar held chord of slot 0: chased at the start and at every seam.
    expect(r.chased('t4').filter(before(19 * BAR))).toEqual([[BAR, 30], [7 * BAR, 30], [13 * BAR, 30]]);
    seamless(r);
  });

  it('every beat exactly once across the seams; the arpeggiator and swing run on through them', () => {
    const p = beatFixture();
    p.swing = 0.5;
    p.tracks[5].arp = { enabled: true, division: '1/16', mode: 'up', octaves: 1, latch: false, gate: 0.5 };
    // Bar 9 (slot 3, one bar): a one-bar loop.
    const r = new Rig(p);
    r.seq.setSongLoop({ fromBar: 8, toBar: 9 }, 0);
    r.playSong(8);
    r.seq.setArpHeld('t6', [60, 64], r.now + MARGIN);
    r.cancelFrom(r.now + MARGIN);
    const end = 3072 + 4 * BAR;
    r.to(end);
    const beats: [number, number][] = [];
    for (let t = 3072; t < end; t += BEAT) beats.push([t, beatPitch(3, (t / BEAT) % 4)]);
    expect(r.notes('t5').filter(before(end))).toEqual(beats);
    expect(ofKind(r.out, 'beat').filter((b) => b.tick < end).map((b) => b.tick)).toEqual(beats.map(([t]) => t));
    const arp = r.notes('t6').filter(before(end));
    // One step every 16th from the first, alternating, never restarted or doubled at a seam.
    expect(arp.map(([t]) => t)).toEqual(Array.from({ length: arp.length }, (_, i) => arp[0][0] + i * 24));
    expect(arp.at(-1)![0]).toBe(end - 24);
    for (let i = 1; i < arp.length; i++) expect(arp[i][1]).not.toBe(arp[i - 1][1]);
    // Swing follows the transport tick, which runs on through every seam.
    const clock = new TempoMap({ time: 0.05, tick: 3072, bpm: 120 });
    for (const n of notesOf(r.out).filter((x) => x.tick < end)) expect(n.time).toBeCloseTo(clock.timeAtSwung(n.tick, 0.5), 9);
    seamless(r, ['t5', 't6']);
  });
});

describe('setting and clearing the loop while the song plays', () => {
  it('with the playhead inside the new loop, it plays on and loops at the loop’s end', () => {
    const r = new Rig().playSong().to(900);
    r.setLoop({ fromBar: 2, toBar: 6 }).to(2304 + 1536);
    expect(r.notes('t1').filter(before(3840))).toEqual([...UNEDITED.filter(before(2304)), ...plays(1, 2304, 3840)]);
    seamless(r);
  });

  it('with the playhead before it, playback continues at the loop’s start at the next bar line', () => {
    const r = new Rig().playSong().to(100);
    r.setLoop({ fromBar: 6, toBar: 8 }).to(384 + 3 * 768);
    // Bar 1 plays as it was; from 384 the loop (slot 2, one-bar clip) again and again.
    expect(r.notes('t1').filter(before(2688))).toEqual([[0, pitchOf(0, 0)], ...plays(2, 384, 2688)]);
    expect(r.notes('t4').filter(before(2688))).toEqual([[0, 30]]);
    // The chord is cut at the jump.
    expect(r.held('t4')).toEqual([[0, 30, 384]]);
    expect(r.bar).toBeGreaterThanOrEqual(6);
    expect(r.bar).toBeLessThan(8);
    seamless(r);
  });

  it('with the playhead after it, the same: the loop starts at the next bar line', () => {
    const r = new Rig().playSong(6).to(2304 + 100);
    r.setLoop({ fromBar: 0, toBar: 2 }).to(2688 + 2 * 768);
    expect(r.notes('t1').filter(before(4224))).toEqual([[2304, pitchOf(2, 0)], ...plays(0, 2688, 4224)]);
    seamless(r);
  });

  it('set right after Play, before anything sounded: the loop starts in its place', () => {
    const r = new Rig().playSong();
    r.setLoop({ fromBar: 2, toBar: 6 }).to(1500);
    expect(r.notes('t1').filter(before(1500))).toEqual(plays(1, 0, 1500));
    expect(r.bar).toBeCloseTo(2 + 1500 / BAR, 6);
    seamless(r);
  });

  it('cleared while it loops: the pass playing goes on past the loop’s end to the song’s end', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 2, toBar: 6 }, 0);
    r.playSong(2).to(2304 + 100);
    r.setLoop(null).finish();
    // The second pass plays song bars 2–9 from transport 2304; the song ends 2688 ticks later.
    expect(r.ends()).toEqual([2304 + (3456 - 768)]);
    const passes: SongPass[] = [
      { at: 768, from: 768, to: 2304 },
      { at: 2304, from: 768, to: Infinity },
    ];
    for (const id of ['t1', 't4']) expect(r.notes(id)).toEqual(expectedNotes(r.project, passes, id, 0, 4992));
  });

  it('cleared before a jump to it came: nothing jumps, the song plays as laid out', () => {
    const r = new Rig().playSong().to(100);
    r.setLoop({ fromBar: 6, toBar: 8 }).to(200);
    r.setLoop(null).finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.ends()).toEqual([3456]);
  });

  it('changed while it loops: inside the new loop it plays on; outside it, it jumps at the next bar line', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 2, toBar: 6 }, 0);
    r.playSong(2).to(2304 + 100);
    // Song bar 2.25 now: inside [0, 4): plays on to bar 4 (transport 2304 + 768), then from bar 0.
    r.setLoop({ fromBar: 0, toBar: 4 }).to(3072 + 100);
    expect(r.bar).toBeCloseTo(100 / BAR, 6);
    // Song bar 0.25: outside [6, 8): at the next bar line (transport 3456) song bar 6.
    r.setLoop({ fromBar: 6, toBar: 8 }).to(3456 + 10);
    expect(r.bar).toBeCloseTo(6 + 10 / BAR, 6);
    const passes: SongPass[] = [
      { at: 768, from: 768, to: 2304 },
      { at: 2304, from: 768, to: 1536 },
      { at: 3072, from: 0, to: 384 },
      { at: 3456, from: 2304, to: 3072 },
    ];
    for (const id of ['t1', 't4']) expect(r.notes(id).filter(before(3456 + 10))).toEqual(expectedNotes(r.project, passes, id, 0, 3466));
    seamless(r);
  });
});

describe('where the song starts with a loop set', () => {
  it('from a bar before the loop: it plays into the loop and loops', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 6, toBar: 8 }, 0);
    r.playSong(0).to(3072 + 2 * 768);
    const passes = loopPasses(0, 0, 6, 8, 3);
    expect(r.notes('t1').filter(before(4608))).toEqual(expectedNotes(r.project, passes, 't1', 0, 4608));
    expect(r.seq.songLoopingAt(100)).toBe(false);
    expect(r.seq.songLoopingAt(2400)).toBe(true);
    seamless(r);
  });

  it('from a bar inside the loop: there, in phase, then it loops', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 2, toBar: 6 }, 0);
    r.playSong(5).to(1920 + 384 + 1536);
    const passes = loopPasses(1920, 5, 2, 6, 3);
    expect(r.notes('t1').filter(before(3840))).toEqual(expectedNotes(r.project, passes, 't1', 0, 3840));
    expect(r.notes('t1')[0]).toEqual([1920, pitchOf(1, 1)]);
    seamless(r);
  });

  it('from a bar after the loop: to the song’s end, the loop never engages', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 2, toBar: 6 }, 0);
    r.playSong(6).finish();
    expect(r.notes('t1')).toEqual(UNEDITED.filter(([t]) => t >= 2304));
    expect(r.ends()).toEqual([3456]);
  });
});

describe('pause, change the loop, resume', () => {
  it('a loop set while paused before it: Resume plays to the next bar line after the pause point, then the loop', () => {
    const r = new Rig().playSong().to(500).pause();
    r.setLoop({ fromBar: 6, toBar: 8 });
    r.wait(0.5).resume().to(768 + 768 + 100);
    expect(r.notes('t1').filter(before(1636))).toEqual([[0, pitchOf(0, 0)], [384, pitchOf(0, 1)], ...plays(2, 768, 1636)]);
    seamless(r);
  });

  it('cleared while paused inside it: Resume plays on to the song’s end', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 2, toBar: 6 }, 0);
    r.playSong(2).to(1000).pause();
    r.setLoop(null);
    r.wait(0.3).resume().finish();
    expect(r.notes('t1')).toEqual(UNEDITED.filter(([t]) => t >= 768));
    expect(r.ends()).toEqual([3456]);
  });

  it('paused just before a seam: Resume goes on in the next pass, in phase', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 3, toBar: 6 }, 0);
    r.playSong(3).to(2304 - 30).pause();
    r.wait(1).resume().to(2304 + 1152 + 10);
    const passes = loopPasses(1152, 3, 3, 6, 3);
    expect(r.notes('t1').filter(before(3466))).toEqual(expectedNotes(r.project, passes, 't1', 0, 3466));
    expect(r.bar).toBeCloseTo(3 + 10 / BAR, 6);
    seamless(r);
  });
});

describe('a long loop', () => {
  it('200 passes of a one-bar loop: the right notes to the last pass, and the passes kept stay few', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 8, toBar: 9 }, 0);
    r.playSong(8);
    let most = 0;
    for (let k = 1; k <= 200; k++) {
      r.to(3072 + k * BAR);
      most = Math.max(most, r.passes().length);
      // Keep what the driver holds small too (it forgets what was handed out long ago).
      if (k % 20 === 0) r.out = r.out.filter((e) => e.tick >= 3072 + (k - 2) * BAR);
    }
    expect(most).toBeLessThanOrEqual(14);
    const end = 3072 + 200 * BAR;
    expect(r.notes('t1').filter(([t]) => t >= end - 2 * BAR && t < end)).toEqual(plays(3, end - 2 * BAR, end));
    expect(r.ends()).toEqual([]);
    expect(r.bar).toBeGreaterThanOrEqual(8);
    expect(r.bar).toBeLessThan(9);
  });
});

describe('looping now (runtime songLooping, Sequencer.songLoopingAt)', () => {
  it('false while the song plays towards the loop; true inside it, on every pass and while paused there', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 2, toBar: 4 }, 0);
    r.playSong(0).to(300);
    expect(r.seq.songLoopingAt(r.tick)).toBe(false);
    r.to(800);
    expect(r.seq.songLoopingAt(r.tick)).toBe(true);
    r.to(1536 + 800);
    expect(r.seq.songLoopingAt(r.tick)).toBe(true);
    r.pause();
    expect(r.seq.songLoopingAt(r.tick)).toBe(true);
  });

  it('a loop set while the song plays outside it: false until the jump at the bar line, then true', () => {
    const r = new Rig().playSong().to(100);
    r.setLoop({ fromBar: 6, toBar: 8 });
    expect(r.seq.songLoopingAt(r.tick)).toBe(false);
    r.to(400);
    expect(r.seq.songLoopingAt(r.tick)).toBe(true);
  });
});

describe('edits while the song loops', () => {
  it('a region added inside the loop plays from the edit point, in phase, and on every later pass; removed, it stops there', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 2, toBar: 6 }, 0);
    // Second pass, song bar 3.something.
    r.playSong(2).to(2304 + 400);
    // t5 gets a copy of t1's slot 0 clip, and a region of it over bars 2–6.
    const c = r.project.tracks[0].clips[0]!;
    r.edit((st) =>
      st.apply('arrange:Test', (d) => {
        d.tracks[4].clips[0] = { ...c, id: 'c5' };
        d.arrangement.regions.push({ id: 'n', trackId: 't5', clipId: 'c5', start: 2, bars: 4, offset: 0 });
      }),
    );
    const e1 = r.editTicks[0];
    const edited = r.project;
    r.to(3840 + 1536 + 400);
    r.regions((rs) => rs.filter((x) => x.id !== 'n'));
    const e2 = r.editTicks[1];
    r.to(e2 + 1536);
    const passes = loopPasses(768, 2, 2, 6, 6);
    const got = r.notes('t5');
    // From the first edit to the second exactly what the loop plays with the region, then nothing.
    expect(got).toEqual(expectedNotes(edited, passes, 't5', e1, e2));
    expect(got.length).toBeGreaterThan(4);
    seamless(r, ['t1', 't5']);
  });
});

describe('the pads and a replay ignore the loop', () => {
  it('live playback plays the pads, with no song timeline', () => {
    const r = new Rig();
    r.seq.setSongLoop({ fromBar: 0, toBar: 1 }, 0);
    r.tap('t1', 0).play({ mode: { kind: 'live' } }).to(4 * BAR);
    expect(r.notes('t1').filter(before(4 * BAR))).toEqual(plays(0, 0, 4 * BAR));
    expect(r.seq.songPasses()).toBeNull();
    expect(r.seq.songLoopingAt(r.tick)).toBe(false);
  });
});
