/**
 * The song plays its regions on an absolute timeline (song v4): each region
 * plays its clip from its start bar for its length, the clip repeating to
 * fill it and `offset` bars in at its start; a part is silent where it has no
 * region; the song ends where its last region or section ends. Checked on
 * the notes, launches and the end the sequencer hands to a driver that
 * behaves like RealtimeTransport (25 ms ticker, the look-ahead), against the
 * oracle computed straight from the regions (r5-engine-rig.ts expectedNotes).
 */
import { describe, expect, it } from 'vitest';
import type { Project, SongRegion } from '../../src/project/types';
import type { SeqEvent } from '../../src/time/contracts';
import { Sequencer, songLengthTicks, type NoteEvent } from '../../src/time/sequencer';
import { makeClip, makeProject, notesOf, ofKind, runTo, sec, setClip } from './sequencer-fixtures';
import { TempoMap } from '../../src/time/clock';
import { BAR, BEAT, Rig, UNEDITED, barClip, clipId, expectedNotes, fixture, heldClip, pitchOf, plays, region, straight, withSong } from './r5-engine-rig';

/** t1: a 2-bar bar-note clip in slot 0 and a 1-bar one in slot 2; t4: a held 2-bar chord in slot 0. */
function small(regions: (p: Project) => SongRegion[]): Project {
  let p = makeProject(120);
  p = setClip(p, 't1', 0, barClip(0));
  p = setClip(p, 't1', 2, barClip(2));
  p = setClip(p, 't4', 0, heldClip(0));
  return withSong(p, regions(p));
}

describe('regions on the timeline', () => {
  it('the 2.2 song as regions plays bar for bar as it did: every part from its region start, silent where it has none', () => {
    const r = new Rig().playSong().finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.notes('t2')).toEqual(UNEDITED);
    // One region per scene stretch: the chord rings its whole clip, again on each pass; t4 has nothing in [2304, 3072).
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(r.launches('t4')).toEqual([[0, 0], [768, 1], [2304, null], [3072, 3]]);
    expect(r.ends()).toEqual([3456]);
    for (const id of ['t1', 't2', 't4']) expect(r.notes(id)).toEqual(expectedNotes(r.project, straight(), id, 0, 3456));
  });

  it('a region longer than its clip repeats it; one with an offset starts that many bars in; one shorter ends mid-clip, its note cut', () => {
    const p = small((q) => [
      // The 2-bar clip over 5 bars: 0 1 0 1 0.
      region(q, 'a', 't1', 0, 0, 5),
      // From bar 6, one bar into the clip: 1 0 1.
      region(q, 'b', 't1', 0, 6, 3, 1),
      // The held 2-bar chord for one bar only, from bar 2.
      region(q, 'c', 't4', 0, 2, 1),
    ]);
    const r = new Rig(p).playSong().finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 5 * BAR), ...plays(0, 6 * BAR, 9 * BAR, 5 * BAR)]);
    expect(r.notes('t1').slice(5, 8).map(([, pitch]) => pitch)).toEqual([pitchOf(0, 1), pitchOf(0, 0), pitchOf(0, 1)]);
    // The chord starts at the region start and stops at its end, not at the clip's.
    expect(r.held('t4')).toEqual([[2 * BAR, 30, 3 * BAR]]);
    expect(r.ends()).toEqual([9 * BAR]);
    expect(r.notes('t1')).toEqual(expectedNotes(p, straight(), 't1', 0, 9 * BAR));
  });

  it('two regions of a part that touch and play on as one do not relaunch (a held note rings on); restarting the clip does', () => {
    const p = small((q) => [
      // Bars [0, 2) then [2, 4) one clip-length further: one continuous loop.
      region(q, 'a', 't4', 0, 0, 2),
      region(q, 'b', 't4', 0, 2, 2),
      // Bars [4, 5) then [5, 6) both from the clip's start: the second restarts it.
      region(q, 'c', 't4', 0, 4, 1),
      region(q, 'd', 't4', 0, 5, 1),
    ]);
    const r = new Rig(p).playSong().finish();
    // (The song ends with the last region: no stop is sent at the end.)
    expect(r.launches('t4')).toEqual([[0, 0], [5 * BAR, 0]]);
    expect(r.held('t4')).toEqual([[0, 30, 2 * BAR], [2 * BAR, 30, 4 * BAR], [4 * BAR, 30, 5 * BAR], [5 * BAR, 30, 6 * BAR]]);
  });

  it('a part switches clips exactly at the region boundary: never two clips at once, the old note cut there', () => {
    const p = small((q) => [region(q, 'a', 't1', 0, 0, 1), region(q, 'b', 't1', 2, 1, 2), region(q, 'c', 't4', 0, 0, 1)]);
    const r = new Rig(p).playSong().finish();
    expect(r.notes('t1')).toEqual([[0, pitchOf(0, 0)], [BAR, pitchOf(2, 0)], [2 * BAR, pitchOf(2, 0)]]);
    expect(r.launches('t1')).toEqual([[0, 0], [BAR, 2]]);
    expect(r.held('t4')).toEqual([[0, 30, BAR]]);
    // The song is as long as its last region; a section after it makes it longer (silence there).
    expect(r.ends()).toEqual([3 * BAR]);
    const q = { ...p, arrangement: { ...p.arrangement, sections: [{ id: 's', name: 'Outro', start: 3, bars: 2 }] } };
    expect(songLengthTicks(q)).toBe(5 * BAR);
    expect(new Rig(q).playSong().finish().ends()).toEqual([5 * BAR]);
  });

  it('silence between regions; a region whose clip is gone plays nothing', () => {
    let p = small((q) => [region(q, 'a', 't1', 0, 0, 1), region(q, 'b', 't1', 0, 3, 1), region(q, 'c', 't1', 2, 5, 1)]);
    p = setClip(p, 't1', 2, null);
    const r = new Rig(p).playSong().finish();
    expect(r.notes('t1')).toEqual([[0, pitchOf(0, 0)], [3 * BAR, pitchOf(0, 0)]]);
    expect(r.launches('t1')).toEqual([[0, 0], [BAR, null], [3 * BAR, 0], [4 * BAR, null]]);
  });

  it('plays from a bar: every region already under way joins in phase there; nothing before it is played late', () => {
    // Bar 5 (tick 1920) is the fourth bar of slot 1's region [2, 6): its 2-bar clip is in its second bar.
    const r = new Rig().playSong(5);
    expect(r.tick).toBe(5 * BAR);
    expect(r.bar).toBe(5);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED.filter(([t]) => t >= 5 * BAR));
    expect(r.notes('t1')[0]).toEqual([5 * BAR, pitchOf(1, 1)]);
    // The held chord of that region started before the start position: it is not played late.
    expect(r.held('t4')).toEqual([[3072, 90, 3456]]);
  });

  it('starting at or after the end ends at once, and an empty song ends at once', () => {
    expect(new Rig().playSong(9).finish().ends()).toEqual([9 * BAR]);
    expect(new Rig(withSong(fixture(), [])).playSong().finish().ends()).toEqual([0]);
  });

  it('note times are exact on the audio clock (swung 16ths included) from bar 2 on, as from bar 1', () => {
    const p = fixture();
    p.swing = 0.5;
    p.tracks[4].clips[1] = makeClip(1, [[0, 60], [24, 62], [BEAT + 24, 64]], 'swung');
    p.arrangement.regions = [...p.arrangement.regions, region(p, 'sw', 't5', 1, 0, 9)];
    for (const from of [0, 2]) {
      const r = new Rig(p).playSong(from).finish();
      // Play starts START_OFFSET (50 ms) after the gesture, at the start bar.
      const clock = new TempoMap({ time: 0.05, tick: from * BAR, bpm: 120 });
      for (const n of notesOf(r.out)) expect(n.time).toBeCloseTo(clock.timeAtSwung(n.tick, 0.5), 9);
      expect(r.notes('t5')).toEqual(expectedNotes(p, straight(from), 't5', 0, 9 * BAR));
    }
  });

  it('gives the same events however the timeline is windowed (an export plays what playback plays)', () => {
    const p = fixture();
    // t2 starts its 2-bar clips one bar in.
    const twoBar = new Set([clipId(p, 't2', 0), clipId(p, 't2', 1)]);
    p.arrangement.regions = p.arrangement.regions.map((x) => (twoBar.has(x.clipId) ? { ...x, offset: 1 } : x));
    const run = (step: number): SeqEvent[] => {
      const seq = new Sequencer({ getProject: () => p });
      seq.start(0.005, { mode: { kind: 'song', fromBar: 0 } });
      const out = runTo(seq, 0.005, sec(10 * BAR), step);
      const cut = seq.takeCuts();
      return out.map((e) => (e.kind === 'note' ? { ...e, duration: Math.min(e.time + e.duration, ...cut.filter((c) => c.note === e).map((c) => c.time)) - e.time } : e));
    };
    const key = (e: SeqEvent) => (e.kind === 'note' ? `n${e.trackId}@${e.tick}:${e.pitch}/${e.duration.toFixed(9)}` : `${e.kind}@${e.tick}${'trackId' in e ? e.trackId : ''}`);
    const a = run(1.12).map(key).sort();
    expect(run(0.025).map(key).sort()).toEqual(a);
    expect(run(0.3).map(key).sort()).toEqual(a);
  });

  it('the playhead on the song timeline: waits at the start until it comes, follows the clock, stays at the end', () => {
    const r = new Rig();
    expect(r.seq.songBarAt(0)).toBeNull();
    r.playSong(2);
    expect(r.bar).toBe(2);
    r.to(3 * BAR + BEAT);
    expect(r.bar).toBeCloseTo(3.25, 9);
    r.finish();
    expect(r.seq.songBarAt(r.tick + 10 * BAR)).toBe(9);
    // Live playback has no song timeline.
    const live = new Rig().play({ mode: { kind: 'live' } });
    expect(live.bar).toBeNull();
  });
});

describe('clips and the launcher during the song', () => {
  it('a part plays its region’s clip wherever it sits now: clips moved between slots (a scene reorder) keep playing in phase', () => {
    const r = new Rig().playSong().to(BAR + 40);
    // Slots 0 and 1 of every part swap (as moving scene row 0 below row 1 does).
    r.edit((s) =>
      s.apply('scene:Move', (d) => {
        for (const t of d.tracks) [t.clips[0], t.clips[1]] = [t.clips[1], t.clips[0]];
      }),
    );
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
    // From the move on the parts report the clips' new slots.
    expect(r.launches('t1')).toEqual([[0, 0], [768, 0], [2304, 2], [3072, 3]]);
  });

  it('clip phase and the queued change read from the song: the clip loops from its region, the next change is seen a bar ahead', () => {
    const r = new Rig().playSong().to(BAR + 10);
    const out = { slot: 0, startTick: 0, lengthTicks: 0 };
    expect(r.seq.clipPhaseAt('t1', r.tick, out)).toEqual({ slot: 0, startTick: 0, lengthTicks: 768 });
    // The region of slot 1 starts at 768: a bar ahead it is queued.
    expect(r.seq.queuedAtTick('t1', r.tick)).toBe(768);
    expect(r.seq.getTrackState('t1').queued).toEqual({ slot: 1, atTick: 768 });
    r.to(2 * BAR + 10);
    // Slot 1 runs on into its second pass at 1536 without a change: nothing is queued until a bar before 2304.
    expect(r.seq.clipPhaseAt('t1', 3 * BAR, out)).toMatchObject({ slot: 1, lengthTicks: 768 });
    expect((3 * BAR - out.startTick) % 768).toBe(BAR);
    expect(r.seq.queuedAtTick('t1', r.tick)).toBeNull();
    r.to(5 * BAR + 10);
    expect(r.seq.queuedAtTick('t1', r.tick)).toBe(2304);
  });
});

describe('note lengths at region boundaries', () => {
  it('a mono part’s note ends where the next region’s first note starts; a poly note crossing an end is cut there', () => {
    let p = makeProject(120);
    // t3 (bass, mono): a 2-bar note in a 2-bar clip in slot 0 (its region one bar long), a short one in slot 1.
    p = setClip(p, 't3', 0, makeClip(2, [[0, 40, 2 * BAR]]));
    p = setClip(p, 't3', 1, makeClip(1, [[0, 43, 48]]));
    p = withSong(p, [region(p, 'a', 't3', 0, 0, 1), region(p, 'b', 't3', 1, 1, 1)]);
    const r = new Rig(p).playSong().finish();
    expect(r.held('t3')).toEqual([[0, 40, BAR], [BAR, 43, BAR + 48]]);
    const ns = notesOf(r.out, 't3') as NoteEvent[];
    expect(ns[0].time + ns[0].duration).toBeCloseTo(r.seq.timeAt(BAR), 9);
    expect(ofKind(r.out, 'end').map((e) => e.tick)).toEqual([2 * BAR]);
  });
});
