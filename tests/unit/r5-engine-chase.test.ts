/**
 * Note chase: where playback enters a part's music in the middle (Play or a
 * seek from any bar, every pass of a song loop, a jump into the loop,
 * Resume), a note of a melodic part that began before that point and still
 * sounds there is played from there with what is left of it, at its
 * velocity, exactly as when the song plays through. Drum kits and samplers
 * never chase; a note with less than a 16th left is not chased. A note
 * already scheduled that an edit (or a launch called off) no longer cuts at
 * a switch or at the song's end sounds on from there. Checked against the
 * oracle computed from the regions alone (r5-engine-rig.ts), on every
 * starter and on small hand-made songs. Also the review's smaller findings
 * on exact instants and edges (m1, m3, m5, m6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STARTERS } from '../../src/content/starters';
import { songBars } from '../../src/project/arrangement';
import type { Id, Project, SongRegion } from '../../src/project/types';
import * as A from '../../src/state/commands/arrangement';
import { MIN_CHASE_TICKS, type SongPass } from '../../src/time/sequencer';
import { makeClip, makeProject, notesOf, setClip } from './sequencer-fixtures';
import { BAR, Rig, TransportRig, chasesNotes, expectedChases, expectedNotes, fixture, heardEnd, soundingAt, straight, withSong } from './r5-engine-rig';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A one-part song: `trackId` (default t4, a synth) plays a clip of `notes` over `regions` ([start, bars, offset] in bars). */
function oneClip(notes: [number, number, number][], bars: 1 | 2 | 4 | 8, regions: [number, number, number][], trackId: Id = 't4'): Project {
  let p = makeProject(120);
  p = setClip(p, trackId, 0, makeClip(bars, notes, 'held'));
  const clipId = p.tracks.find((t) => t.id === trackId)!.clips[0]!.id;
  return withSong(
    p,
    regions.map(([start, n, offset], i) => ({ id: `r${i}`, trackId, clipId, start, bars: n, offset })),
  );
}

/** Four 16th-long beats on every bar (a drum part). */
const BEATS = [0, 96, 192, 288].map((t) => [t, 36, 24] as [number, number, number]);

describe('every starter: no held note is lost', () => {
  it('played from each bar: every note sounding there is chased, with what is left of it and its velocity; nothing else', () => {
    const problems: string[] = [];
    let chased = 0;
    let starts = 0;
    for (const s of STARTERS) {
      const p = s.build();
      const len = songBars(p);
      for (let bar = 1; bar < len; bar++) {
        const at = bar * BAR;
        const r = new Rig(p).playSong(bar);
        starts++;
        for (const t of p.tracks) {
          const want = expectedChases(p, straight(bar), t.id, at, at + 1);
          const got = r.chased(t.id);
          if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${s.id} bar ${bar + 1} ${t.name}: chased ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
          const sounding = soundingAt(p, t.id, at);
          for (const n of notesOf(r.out, t.id).filter((x) => x.chased)) {
            chased++;
            const o = sounding.find((x) => x.pitch === n.pitch)!;
            if (n.tick !== at || n.durationTicks !== o.end - at || Math.abs(n.velocity - clamp01(o.velocity)) > 1e-9) {
              problems.push(`${s.id} bar ${bar + 1} ${t.name} ${n.pitch}: ${n.tick}+${n.durationTicks} v${n.velocity}, expected ${at}+${o.end - at} v${o.velocity}`);
            }
          }
          if (!chasesNotes(p, t.id) && got.length) problems.push(`${s.id} ${t.name} (${t.instrument.kind}) chased`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(starts).toBeGreaterThan(400);
    // The starters do hold notes across bar lines (the review found a note lost on 97 start bars, 190 notes).
    expect(chased).toBeGreaterThan(100);
  });

  it('looping any stretch: every pass that enters held music chases it, none lost; the other notes are the song’s there', () => {
    const problems: string[] = [];
    let chased = 0;
    for (const s of STARTERS) {
      const p = s.build();
      const len = songBars(p);
      for (let from = 0; from + 1 < len; from++) {
        const to = Math.min(len, from + 1 + (from % 3));
        const r = new Rig(p);
        r.seq.setSongLoop({ fromBar: from, toBar: to }, 0);
        const end = from * BAR + 3 * (to - from) * BAR;
        r.playSong(from).to(end);
        const passes: SongPass[] = r.allPasses().filter((x) => x.at < end);
        for (const t of p.tracks) {
          const want = expectedChases(p, passes, t.id, 0, end);
          const got = r.chased(t.id).filter(([tick]) => tick < end);
          chased += got.length;
          if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${s.id} loop ${from + 1}–${to} ${t.name}: chased ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
          if (JSON.stringify(r.notes(t.id).filter(([tick]) => tick < end - BAR)) !== JSON.stringify(expectedNotes(p, passes, t.id, 0, end - BAR))) {
            problems.push(`${s.id} loop ${from + 1}–${to} ${t.name}: notes differ from the song's`);
          }
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(chased).toBeGreaterThan(100);
  }, 120_000);
});

describe('what is chased', () => {
  it('a 4-bar held note: Play from bar 3, every pass of a loop over bars 3–4, and Resume all play it on', () => {
    const p = oneClip([[0, 60, 4 * BAR]], 4, [[0, 4, 0]]);
    // Played through: one note, bars 1–4.
    expect(new Rig(p).playSong().finish().held('t4')).toEqual([[0, 60, 4 * BAR]]);
    // From bar 3: the rest of it.
    const from3 = new Rig(p).playSong(2).finish();
    expect(from3.held('t4')).toEqual([[2 * BAR, 60, 4 * BAR]]);
    expect(from3.chased('t4')).toEqual([[2 * BAR, 60]]);
    // A loop over bars 3–4: the rest of it, at every pass.
    const loop = new Rig(p);
    loop.seq.setSongLoop({ fromBar: 2, toBar: 4 }, 0);
    loop.playSong(0).to(10 * BAR);
    expect(loop.held('t4').filter(([t]) => t < 10 * BAR)).toEqual([[0, 60, 4 * BAR], [4 * BAR, 60, 6 * BAR], [6 * BAR, 60, 8 * BAR], [8 * BAR, 60, 10 * BAR]]);
    // Paused at bar 2.5 and resumed: from the pause point.
    const paused = new Rig(p).playSong().to(1.5 * BAR).pause();
    paused.now += 1;
    paused.resume().finish();
    const [first, second, ...rest] = notesOf(paused.out, 't4');
    expect(rest).toEqual([]);
    expect(first.tick).toBe(0);
    expect(paused.endOf(first)).toBeCloseTo(1.5 * BAR, 6);
    expect(second.chased).toBe(true);
    expect(second.tick).toBeCloseTo(1.5 * BAR, 6);
    expect(second.tick + second.durationTicks).toBe(4 * BAR);
    expect(second.velocity).toBe(0.8);
  });

  it('with a count-in, the chase is where the music starts', () => {
    const p = oneClip([[0, 60, 4 * BAR]], 4, [[0, 4, 0]]);
    const r = new Rig(p).play({ mode: { kind: 'song', fromBar: 2 }, countInBars: 1 }).finish();
    expect(r.held('t4')).toEqual([[2 * BAR, 60, 4 * BAR]]);
  });

  it('a note with less than a 16th left is not chased (its attack and release would click)', () => {
    expect(MIN_CHASE_TICKS).toBe(24);
    const p = oneClip([[0, 60, BAR + 23], [0, 62, BAR + 24], [0, 64, BAR + 200]], 2, [[0, 2, 0]]);
    const r = new Rig(p).playSong(1).finish();
    expect(r.held('t4')).toEqual([[BAR, 62, BAR + 24], [BAR, 64, BAR + 200]]);
  });

  it('drum kits and samplers never chase; a bass (one note at a time) chases the note sounding', () => {
    let p = makeProject(120);
    p = setClip(p, 't1', 0, makeClip(2, [[0, 0, 2 * BAR]]));
    p = setClip(p, 't8', 0, makeClip(2, [[0, 60, 2 * BAR]]));
    // The bass's first note is ended by its second.
    p = setClip(p, 't3', 0, makeClip(2, [[0, 40, 2 * BAR], [BAR + 96, 43, 96]]));
    const reg = (trackId: Id): SongRegion => ({ id: trackId, trackId, clipId: p.tracks.find((t) => t.id === trackId)!.clips[0]!.id, start: 0, bars: 2, offset: 0 });
    p = withSong(p, [reg('t1'), reg('t3'), reg('t8')]);
    const r = new Rig(p).playSong(1).finish();
    expect(r.chased('t1')).toEqual([]);
    expect(r.chased('t8')).toEqual([]);
    expect(r.held('t3')).toEqual([[BAR, 40, BAR + 96], [BAR + 96, 43, BAR + 192]]);
  });

  it('a note begun in an earlier region of the same clip, in phase, is chased; a region that starts its clip over begins with its own notes', () => {
    // The clip holds a note from its bar 2 to its end.
    const notes: [number, number, number][] = [[BAR, 60, 3 * BAR]];
    const inPhase = new Rig(oneClip(notes, 4, [[0, 2, 0], [2, 2, 2]])).playSong(3).finish();
    expect(inPhase.held('t4')).toEqual([[3 * BAR, 60, 4 * BAR]]);
    expect(inPhase.chased('t4')).toEqual([[3 * BAR, 60]]);
    const restarts = new Rig(oneClip(notes, 4, [[0, 2, 0], [2, 2, 0]])).playSong(3).finish();
    expect(restarts.held('t4')).toEqual([[3 * BAR, 60, 4 * BAR]]);
    expect(restarts.chased('t4')).toEqual([]);
    // A region starting right there plays nothing that began before it.
    const fresh = new Rig(oneClip(notes, 4, [[2, 2, 0]])).playSong(2).finish();
    expect(fresh.chased('t4')).toEqual([]);
    expect(fresh.held('t4')).toEqual([[3 * BAR, 60, 4 * BAR]]);
  });

  it('swing: a note whose swung start is past the resume point plays at its swung time, once (not chased)', () => {
    // An off-beat 16th (tick 24) swung to tick 32; paused at tick 28, between the two.
    const p = oneClip([[24, 60, 96]], 1, [[0, 4, 0]]);
    p.swing = 1;
    const r = new Rig(p).playSong().to(28).pause();
    expect(notesOf(r.out, 't4')).toEqual([]);
    r.now += 1;
    r.resume().to(BAR);
    const n = notesOf(r.out, 't4').filter((x) => x.tick < BAR);
    expect(n.map((x) => [x.tick, !!x.chased])).toEqual([[24, false]]);
    // At its swung time (tick 32) after the resume.
    expect(n[0].time).toBeCloseTo(r.seq.timeAt(32), 9);
  });

  it('a pad that keeps its clip through a song change: after a pause, its held note is chased from where it began', () => {
    // t4: an 8-bar clip holding one note over bars [0, 4), then another clip over [4, 8).
    let p = makeProject(120);
    p = setClip(p, 't4', 0, makeClip(8, [[0, 60, 8 * BAR]], 'long'));
    p = setClip(p, 't4', 1, makeClip(1, [[0, 70, 48]], 'other'));
    const [x, y] = p.tracks[3].clips;
    p = withSong(p, [
      { id: 'a', trackId: 't4', clipId: x!.id, start: 0, bars: 4, offset: 0 },
      { id: 'b', trackId: 't4', clipId: y!.id, start: 4, bars: 4, offset: 0 },
    ]);
    const r = new Rig(p).playSong().to(3.5 * BAR).tap('t4', 0).to(5 * BAR).pause();
    r.now += 1;
    r.resume().to(6 * BAR);
    expect(r.notes('t4')).toEqual([[0, 60]]);
    expect(r.chased('t4')).toEqual([[5 * BAR, 60]]);
    const chord = notesOf(r.out, 't4').find((n) => n.chased)!;
    // Until the song stops the part at bar 9 (the pad holds against the change at bar 5 only).
    expect(chord.tick + chord.durationTicks).toBe(8 * BAR);
  });
});

describe('a note already scheduled goes on when an edit removes the end that cut it (m4)', () => {
  /** A 2-bar clip holding one note through it. */
  const held2 = (regions: [number, number, number][]) => oneClip([[0, 60, 2 * BAR]], 2, regions);

  it('a region lengthened while its note sounds: the note sounds on from the old end (a scheduled voice cannot be lengthened)', () => {
    const p = held2([[0, 1, 0]]);
    p.arrangement.sections = [{ id: 's', name: 'S', start: 0, bars: 6 }];
    const r = new Rig(p).playSong().to(0.5 * BAR);
    expect(r.regions((rs) => rs.map((x) => ({ ...x, bars: 4 })))).toBe(true);
    r.finish();
    expect(r.held('t4')).toEqual([[0, 60, BAR], [BAR, 60, 2 * BAR], [2 * BAR, 60, 4 * BAR]]);
    expect(r.chased('t4')).toEqual([[BAR, 60]]);
  });

  it('a loop cleared while a note crosses its end: the note sounds on there', () => {
    const r = new Rig(held2([[0, 4, 0]]));
    r.seq.setSongLoop({ fromBar: 0, toBar: 1 }, 0);
    r.playSong().to(0.5 * BAR);
    r.setLoop(null).finish();
    expect(r.held('t4')).toEqual([[0, 60, BAR], [BAR, 60, 2 * BAR], [2 * BAR, 60, 4 * BAR]]);
  });

  it('an edit that keeps the switch keeps the cut; a removed switch to another clip lets the note ring on', () => {
    let p = held2([[0, 1, 0]]);
    p = setClip(p, 't4', 1, makeClip(1, [[0, 70, 48]], 'other'));
    const other = p.tracks[3].clips[1]!.id;
    p = withSong(p, [...p.arrangement.regions, { id: 'b', trackId: 't4', clipId: other, start: 1, bars: 1, offset: 0 }]);
    // The other region moved later: still a switch at bar 2 (to silence), so still cut there.
    const kept = new Rig(p).playSong().to(0.5 * BAR);
    kept.regions((rs) => rs.map((x) => (x.id === 'b' ? { ...x, start: 3 } : x)));
    kept.finish();
    expect(kept.held('t4')).toEqual([[0, 60, BAR], [3 * BAR, 70, 3 * BAR + 48]]);
    // Its clip swapped for the held one, in phase: no switch at bar 2 any more.
    const gone = new Rig(p).playSong().to(0.5 * BAR);
    gone.regions((rs) => rs.map((x) => (x.id === 'b' ? { ...x, clipId: rs[0].clipId, offset: 1 } : x)));
    gone.finish();
    expect(gone.held('t4')).toEqual([[0, 60, BAR], [BAR, 60, 2 * BAR]]);
  });

  it('a pad tapped twice (a stop called off): the note it had cut at the bar line sounds on', () => {
    let p = makeProject(120);
    p = setClip(p, 't4', 0, makeClip(2, [[0, 60, 2 * BAR]]));
    const r = new Rig(p);
    r.seq.launchClip('t4', 0, 0);
    r.play({}).to(100);
    // Tapping the playing pad stops it at the next bar (as the session does); tapping it again calls that off.
    r.stopPart('t4').to(200);
    expect(r.held('t4')).toEqual([[0, 60, BAR]]);
    r.tap('t4', 0).to(2.5 * BAR);
    expect(r.held('t4').filter(([t]) => t < 2 * BAR)).toEqual([[0, 60, BAR], [BAR, 60, 2 * BAR]]);
  });
});

describe('on the real transport (fake audio clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('m3: a song shortened while a note sounds past its new end releases it at the end on the audio clock, however late “end” arrives', () => {
    // A 4-bar held note over bars 1–12; at bar 9.5 the region is cut to end at bar 10 (the song's end).
    const p = oneClip([[0, 57, 4 * BAR]], 4, [[0, 12, 0]]);
    const r = new TransportRig(p);
    r.transport.start({ mode: { kind: 'song', fromBar: 0 } });
    r.toBar(8.5);
    r.edit((s) => A.resizeRegions(s, ['r0'], 'end', -2));
    // The main thread is busy for 300 ms across the end.
    r.toBar(9.95).block(300).toEnd();
    const v = r.heard('t4').find((x) => x.note?.tick === 8 * BAR)!;
    expect(Math.abs(heardEnd(v) - r.seq.timeAt(10 * BAR)) * 1000).toBeLessThan(1);
    r.dispose();
  });

  it('m5: Pause exactly when a note starts, or a hair before or after: it sounds once, after Resume', () => {
    for (const nudge of [-1e-12, 0, 1e-12]) {
      const r = new TransportRig(oneClip(BEATS, 1, [[0, 8, 0]], 't1'));
      r.transport.start({ mode: { kind: 'song', fromBar: 0 } });
      // Beat 2 of bar 2 (tick 480).
      const beat = r.seq.timeAt(5 * 96);
      while (r.ctx.currentTime < beat - 0.0125) r.run(25);
      r.ctx.currentTime = beat + nudge;
      r.transport.pause();
      r.run(500);
      r.transport.resume();
      r.run(1000);
      r.transport.stop();
      expect(r.heard('t1').filter((v) => v.note?.tick === 5 * 96), `pause at the beat ${nudge}`).toHaveLength(1);
      r.dispose();
    }
  });

  it('m1: a region’s end in a loop pass is exact (no rounding of the window edge plays its clip on into silence)', () => {
    // The review's case: 200 BPM, drums over bars 16–23; from bar 15, the loop set to bars 23–25 at bar 16.5.
    const p = oneClip(BEATS, 1, [[15, 8, 0]], 't1');
    p.bpm = 200;
    p.arrangement.sections = [{ id: 's', name: 'Verse', start: 0, bars: 25 }];
    const r = new TransportRig(p);
    r.transport.start({ mode: { kind: 'song', fromBar: 14 } });
    while (r.transport.getPosition().tick < 15.49 * BAR) r.run(25);
    r.transport.setSongLoop({ fromBar: 22, toBar: 25 });
    r.run(8000);
    r.transport.stop();
    // From transport bar 17 every pass of 3 bars plays song bar 23 (the drums' last bar), then bars 24–25 where they are silent.
    const after = r.heard('t1').filter((v) => v.note && v.note.tick >= 16 * BAR);
    expect(after.filter((v) => (v.note!.tick - 16 * BAR) % (3 * BAR) >= BAR)).toEqual([]);
    expect(after.length).toBeGreaterThanOrEqual(8);
    r.dispose();
  });
});

describe('m1: the region end in a loop pass, wherever the window edges fall', () => {
  it('driven every 25 ms from many start times and tempos: never a note where the region has ended', () => {
    let bad = 0;
    let runs = 0;
    for (const bpm of [200, 120, 128, 140, 174]) {
      for (let k = 0; k < 40; k++) {
        const p = oneClip(BEATS, 1, [[15, 8, 0]], 't1');
        p.bpm = bpm;
        p.arrangement.sections = [{ id: 's', name: 'Verse', start: 0, bars: 25 }];
        const r = new Rig(p);
        r.seq.setSongLoop({ fromBar: 22, toBar: 25 }, 0);
        r.now = 0.137 * k;
        r.playSong(15).wait(20 * 3 * (240 / bpm));
        runs++;
        // The first pass plays song bars 16–25 at the same transport bars, then passes of 3 bars play song bars 23–25 (the drums only in the first).
        if (r.notes('t1').some(([t]) => t >= 25 * BAR && (t - 25 * BAR) % (3 * BAR) >= BAR)) bad++;
      }
    }
    expect(runs).toBe(200);
    expect(bad).toBe(0);
  });
});

describe('m5: a loop set exactly on a bar line', () => {
  it('when rounding puts the bar’s time a hair before the edit time, its downbeat is heard once, from the pass that plays there', () => {
    let cases = 0;
    for (const bpm of [97, 89, 101, 133, 151, 173, 120, 140]) {
      const p = { ...fixture(), bpm };
      for (let bar = 3; bar < 9 && cases < 4; bar++) {
        const T = bar * BAR;
        const r = new Rig(p).playSong();
        // An edit time a hair after the bar's time, where the playhead still rounds up to the bar.
        const at = r.seq.timeAt(T);
        const found = (t: number) => t > at && Math.ceil(r.seq.tickAt(t)) === T && r.seq.timeAt(T) < t;
        let t = at;
        for (let k = 0; k < 3 && !found(t); k++) t += t * Number.EPSILON * 0.5000001;
        if (!found(t)) continue;
        cases++;
        // The downbeat is already handed out (in the look-ahead).
        r.to(T - 20);
        expect(r.notes('t1').some(([tick]) => tick === T)).toBe(true);
        expect(r.seq.setSongLoop({ fromBar: 0, toBar: 2 }, t)).toBe(true);
        r.cancelFrom(t);
        r.to(T + 3 * BAR);
        const passes = r.allPasses();
        for (const id of ['t1', 't2']) {
          const got = r.notes(id).filter(([tick]) => tick === T);
          expect(got, `${id} at bar ${bar}`).toEqual(expectedNotes(r.project, passes, id, T, T + 1));
          expect(got).toHaveLength(1);
        }
      }
    }
    expect(cases).toBeGreaterThan(0);
  });
});

describe('m6: the launcher state as of the playhead', () => {
  it('a song change generated ahead of the playhead shows as queued, not yet as playing', () => {
    // Fixture: t1 plays slot 1 over bars 3–6, slot 2 from bar 7 (tick 2304).
    const r = new Rig(fixture()).playSong().to(2304 - 40);
    // The look-ahead has applied the change at bar 7 already.
    expect(r.seq.generatedTick).toBeGreaterThan(2304);
    expect(r.seq.getTrackState('t1').playing?.slot).toBe(2);
    const st = r.seq.getTrackState('t1', r.tick);
    expect(st.playing?.slot).toBe(1);
    expect(st.queued).toEqual({ slot: 2, atTick: 2304 });
    // From the change on, playing.
    r.to(2304 + 10);
    expect(r.seq.getTrackState('t1', r.tick).playing?.slot).toBe(2);
    expect(Object.keys(r.seq.getTrackState('t1', r.tick).playing!).sort()).toEqual(['clipId', 'slot', 'startTick']);
  });
});
