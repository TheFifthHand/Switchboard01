/**
 * Song clips (schema v5) play in the song exactly like pad clips: a region
 * that points at a song clip plays it (launched on its song slot), notes are
 * chased into it, edits to it while the song plays are followed, its slot
 * moving (an earlier song clip removed) changes nothing heard, and the pads
 * never launch it. Recording into the song plays on past the song's end.
 */
import { describe, expect, it } from 'vitest';
import { songSlot } from '../../src/project/clips';
import type { Clip, Id, Project, SongRegion } from '../../src/project/types';
import { songPlayChanged } from '../../src/time/sequencer';
import { makeClip, makeProject, setClip } from './sequencer-fixtures';
import { BAR, Rig, barClip, heldClip, pitchOf, withSong } from './r5-engine-rig';

function withSongClips(p: Project, trackId: Id, clips: Clip[]): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, songClips: clips } : t)) };
}

const reg = (id: Id, trackId: Id, clipId: Id, start: number, bars: number, offset = 0): SongRegion => ({ id, trackId, clipId, start, bars, offset });

/** t1: pad clip in slot 0 (bars 0–1); song clips A (2 bars, pitches 70/71, bars 2–5) and B (1 bar, 90, bars 6–8) on t1; t4 holds a chord from song clip H. */
function project(): Project {
  let p = makeProject(120);
  p = setClip(p, 't1', 0, barClip(0));
  const a = makeClip(2, [[0, 70, 48], [BAR, 71, 48]], 'A');
  const b = makeClip(1, [[0, 90, 48]], 'B');
  p = withSongClips(p, 't1', [a, b]);
  const h = heldClip(1, 4);
  p = withSongClips(p, 't4', [h]);
  const pad = p.tracks.find((t) => t.id === 't1')!.clips[0]!;
  return withSong(p, [reg('r0', 't1', pad.id, 0, 2), reg('ra', 't1', a.id, 2, 4), reg('rb', 't1', b.id, 6, 3), reg('rh', 't4', h.id, 0, 4)]);
}

describe('song clips in song playback', () => {
  it('regions play song clips like pad clips, launched on their song slots', () => {
    const r = new Rig(project()).playSong().finish();
    expect(r.notes('t1')).toEqual([
      [0, pitchOf(0, 0)], [BAR, pitchOf(0, 1)],
      [2 * BAR, 70], [3 * BAR, 71], [4 * BAR, 70], [5 * BAR, 71],
      [6 * BAR, 90], [7 * BAR, 90], [8 * BAR, 90],
    ]);
    expect(r.launches('t1')).toEqual([[0, 0], [2 * BAR, songSlot(0)], [6 * BAR, songSlot(1)]]);
    expect(r.held('t4')).toEqual([[0, pitchOf(1, 0), 4 * BAR]]);
    expect(r.ends()).toEqual([9 * BAR]);
  });

  it('starting mid-region chases a held note of a song clip', () => {
    const r = new Rig(project()).playSong(1).to(3 * BAR);
    expect(r.chased('t4')).toEqual([[BAR, pitchOf(1, 0)]]);
  });

  it('editing a song clip’s notes while the song plays: what plays from then on follows', () => {
    const r = new Rig(project()).playSong();
    r.to(2 * BAR + 10);
    const changed = (p: Project) => p.tracks.find((t) => t.id === 't1')!.songClips![0];
    r.edit((s) => s.apply('notes:Test', (d) => void (d.tracks.find((t) => t.id === 't1')!.songClips![0].notes[1].pitch = 75)));
    expect(changed(r.project).notes[1].pitch).toBe(75);
    r.finish();
    expect(r.notes('t1').filter(([t]) => t >= 2 * BAR && t < 6 * BAR)).toEqual([[2 * BAR, 70], [3 * BAR, 75], [4 * BAR, 70], [5 * BAR, 75]]);
  });

  it('a longer song clip (its bars) while the song plays is a song change: the song replans', () => {
    const p = project();
    const q = { ...p, tracks: p.tracks.map((t) => (t.id === 't1' ? { ...t, songClips: t.songClips!.map((c, i) => (i === 1 ? { ...c, bars: 2 as const } : c)) } : t)) };
    expect(songPlayChanged(q, p)).toBe(true);
    const notes = { ...p, tracks: p.tracks.map((t) => (t.id === 't1' ? { ...t, songClips: t.songClips!.map((c) => ({ ...c, name: 'x' })) } : t)) };
    expect(songPlayChanged(notes, p)).toBe(false);
  });

  it('a song clip whose slot moves while it plays (one before it went) plays on, in phase', () => {
    const r = new Rig(project()).playSong();
    r.to(6 * BAR + 10);
    // Song clip A goes (its regions with it): B moves from song slot 1 to song slot 0.
    r.edit((s) =>
      s.apply('arrange:Test', (d) => {
        const t = d.tracks.find((x) => x.id === 't1')!;
        t.songClips = t.songClips!.slice(1);
        d.arrangement.regions = d.arrangement.regions.filter((g) => g.id !== 'ra');
      }),
    );
    r.finish();
    expect(r.notes('t1').filter(([t]) => t >= 6 * BAR)).toEqual([[6 * BAR, 90], [7 * BAR, 90], [8 * BAR, 90]]);
  });

  it('pads never launch a song slot', () => {
    const r = new Rig(project());
    expect(() => r.seq.launchClip('t1', songSlot(0), 0)).toThrow(RangeError);
  });
});

describe('recording into the song', () => {
  it('an open-ended song plays on past its end with no end event, until it is closed again', () => {
    const r = new Rig(project()).play({ mode: { kind: 'song', fromBar: 5, openEnd: true } });
    r.to(12 * BAR);
    expect(r.ends()).toEqual([]);
    expect(r.bar).toBeGreaterThan(11);
    // Recording stops: the song gets its end back, never behind the playhead (the next bar line).
    expect(r.seq.setSongOpenEnd(false)).toBe(true);
    expect(r.seq.replanSong(r.now + 0.01)).toBe(true);
    r.cancelFrom(r.now + 0.01);
    r.finish();
    expect(r.ends()).toEqual([13 * BAR]);
  });

  it('an empty song records from its cursor too', () => {
    const p = withSong(makeProject(120), []);
    const r = new Rig(p).play({ mode: { kind: 'song', fromBar: 3, openEnd: true } }).to(5 * BAR);
    expect(r.ends()).toEqual([]);
    expect(r.seq.songTickAt(r.tick)!.tick).toBeCloseTo(r.tick, 6);
    expect(r.seq.songTickAt(2 * BAR)).toEqual({ tick: 2 * BAR, passEnd: Infinity });
  });

  it('opening the end of a song already playing: it plays past its last bar', () => {
    const r = new Rig(project()).playSong(5);
    r.to(5 * BAR + 10);
    expect(r.seq.setSongOpenEnd(true)).toBe(true);
    r.to(10 * BAR);
    expect(r.ends()).toEqual([]);
  });

  it('songTickAt maps a looping song back to the loop start, with where each pass ends', () => {
    const r = new Rig(project()).setLoop({ fromBar: 2, toBar: 4 }).play({ mode: { kind: 'song', fromBar: 2, openEnd: true } });
    r.to(5 * BAR);
    expect(r.seq.songTickAt(3 * BAR)).toEqual({ tick: 3 * BAR, passEnd: 4 * BAR });
    expect(r.seq.songTickAt(4 * BAR + 10)).toEqual({ tick: 2 * BAR + 10, passEnd: 4 * BAR });
  });
});
