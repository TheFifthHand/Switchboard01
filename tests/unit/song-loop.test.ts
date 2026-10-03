/**
 * Song looping: what the lane shows is what plays. A loop is the blocks from
 * its first to its last block (inclusive) in the song's current order; at the
 * end of its last block playback continues at the start of its first block,
 * in time, every clip starting from that block's start exactly as the song
 * plays it there, until the loop is cleared. Checked on the notes, launches,
 * block events and the end a driver behaving like RealtimeTransport receives,
 * with the session's loop rules mirrored by the rig (see song-live-rig.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { TempoMap } from '../../src/time/clock';
import { songLoopAfterEdit, songLoopBlockIds, songLoopRange } from '../../src/time/songLoop';
import { songBlocks } from '../../src/time/sequencer';
import { notesOf, ofKind, setClip } from './sequencer-fixtures';
import { BAR, MARGIN, Rig, UNEDITED, barClip, beatFixture, beats, fixture, pitchOf, plays } from './song-live-rig';

/** Notes of a bar-note part over consecutive stretches [row, from, to] (each clip looping from the stretch start). */
function song(...parts: [row: number, from: number, to: number][]): [number, number][] {
  return parts.flatMap(([row, from, to]) => plays(row, from, to));
}

/** `cycles` passes of a loop of [row, ticks] blocks from `start`, as [row, from, to] stretches. */
function cycles(start: number, n: number, blocks: [row: number, ticks: number][]): [number, number, number][] {
  const out: [number, number, number][] = [];
  let t = start;
  for (let k = 0; k < n; k++) {
    for (const [row, len] of blocks) {
      out.push([row, t, t + len]);
      t += len;
    }
  }
  return out;
}

const before = (tick: number) => ([t]: readonly [number, ...unknown[]]) => t < tick;

/** Block events handed out before `tick`, as [tick, blockId]. */
function blockIds(r: Rig, tick: number): [number, string][] {
  return r.blocks().filter(before(tick)).map(([t, , id]) => [t, id]);
}

/** Common checks on a stretch of looped playback: launches on bar lines, no note twice, no end. */
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
  const bl = ofKind(r.out, 'block');
  for (let i = 1; i < bl.length; i++) expect(bl[i].tick).toBeGreaterThan(bl[i - 1].tick);
}

describe('a loop plays its blocks again and again, exactly as the song plays them there', () => {
  it('one block: Play song starts at it; three passes, each in phase with the block start; no end', () => {
    // b1 = row 1 (2-bar clips) x 2 = 4 bars, on the lane at [768, 2304).
    const r = new Rig().setLoop('b1').playSong();
    expect(r.tick).toBe(768);
    r.to(768 + 3 * 1536);
    const end = 768 + 3 * 1536;
    expect(blockIds(r, end)).toEqual([[768, 'b1'], [2304, 'b1'], [3840, 'b1']]);
    expect(r.notes('t1').filter(before(end))).toEqual(song(...cycles(768, 3, [[1, 1536]])));
    expect(r.notes('t2').filter(before(end))).toEqual(song(...cycles(768, 3, [[1, 1536]])));
    // The held chord starts with every pass and ends at the seam.
    expect(r.held('t4').filter(before(end))).toEqual([768, 2304, 3840].flatMap((s) => [[s, 50, s + 768], [s + 768, 50, s + 1536]]));
    expect(r.launches('t1').filter(before(end))).toEqual([[768, 1], [2304, 1], [3840, 1]]);
    expect(r.ends()).toEqual([]);
    expect(r.seq.ended).toBe(false);
    seamless(r);
  });

  it('a clip shorter than the block restarts with the block at the seam, as the song plays it there', () => {
    // b1 plays a 3-bar clip on t2 and a 2-bar clip on t1, once: [768, 1920). t1 goes bar 0, 1, 0, then bar 0 again.
    let p = fixture();
    p = setClip(p, 't2', 1, barClip(1, 3));
    p.arrangement.blocks[1].repeats = 1;
    const r = new Rig(p).setLoop('b1').playSong().to(768 + 3 * 1152);
    const end = 768 + 3 * 1152;
    const t1 = r.notes('t1').filter(before(end));
    expect(t1).toEqual([768, 1920, 3072].flatMap((s) => plays(1, s, s + 1152, s)));
    expect(t1.slice(0, 4).map(([, pitch]) => pitch)).toEqual([pitchOf(1, 0), pitchOf(1, 1), pitchOf(1, 0), pitchOf(1, 0)]);
    expect(r.notes('t2').filter(before(end))).toEqual([768, 1920, 3072].flatMap((s) => plays(1, s, s + 1152, s, 3)));
    seamless(r);
  });

  it('several blocks: they play in song order, then again from the first, over three passes', () => {
    // Loop b1..b2: b1 [4 bars] + b2 [2 bars] = 2304 ticks a pass.
    const r = new Rig().setLoop('b1', 'b2').playSong().to(768 + 3 * 2304);
    const end = 768 + 3 * 2304;
    const loop = cycles(768, 3, [[1, 1536], [2, 768]]);
    expect(r.notes('t1').filter(before(end))).toEqual(song(...loop));
    expect(r.notes('t2').filter(before(end))).toEqual(song(...loop));
    expect(blockIds(r, end)).toEqual(loop.map(([row, from]) => [from, row === 1 ? 'b1' : 'b2']));
    // Row 2 has no chord: the chord stops with b1 and comes back with it.
    expect(r.launches('t4').filter(before(end))).toEqual(loop.map(([row, from]) => [from, row === 1 ? 1 : null]));
    expect(r.ends()).toEqual([]);
    seamless(r);
  });

  it('the loop given the other way round covers the same blocks', () => {
    const a = new Rig().setLoop('b2', 'b1').playSong().to(6000);
    const b = new Rig().setLoop('b1', 'b2').playSong().to(6000);
    expect(a.notes('t1')).toEqual(b.notes('t1'));
    expect(a.tick).toBe(b.tick);
  });

  it('every beat exactly once across the seams; the arpeggiator and swing run on through them', () => {
    const p: Project = beatFixture();
    p.swing = 0.5;
    p.tracks[5].arp = { enabled: true, division: '1/16', mode: 'up', octaves: 1, latch: false, gate: 0.5 };
    // b3: row 3 (1 bar) once, [3072, 3456): a one-bar loop.
    const r = new Rig(p).setLoop('b3').playSong();
    r.seq.setArpHeld('t6', [60, 64], r.now + MARGIN);
    r.cancelFrom(r.now + MARGIN);
    const end = 3072 + 4 * BAR;
    r.to(end);
    expect(r.notes('t5').filter(before(end))).toEqual(beats(3, 3072, end));
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
    const r = new Rig().play().to(1000);
    r.setLoop('b1', 'b2');
    r.to(6000);
    expect(blockIds(r, 6000)).toEqual([[0, 'b0'], [768, 'b1'], [2304, 'b2'], [3072, 'b1'], [4608, 'b2'], [5376, 'b1']]);
    expect(r.notes('t1').filter(before(6000))).toEqual(song([0, 0, 768], [1, 768, 2304], [2, 2304, 3072], [1, 3072, 4608], [2, 4608, 5376], [1, 5376, 6000]));
    seamless(r);
  });

  it('with the playhead before it, playback continues at the loop’s first block at the next bar line', () => {
    const r = new Rig().play().to(200);
    r.traceLane = true;
    r.setLoop('b2');
    expect(r.laneTick()).toBeCloseTo(r.tick, 6);
    r.to(2000);
    // b0 sounds to bar line 384; b2 (2 bars) starts there and loops.
    expect(blockIds(r, 2000)).toEqual([[0, 'b0'], [384, 'b2'], [1152, 'b2'], [1920, 'b2']]);
    expect(r.notes('t1').filter(before(2000))).toEqual(song([0, 0, 384], [2, 384, 2000]));
    // The chord of b0 ends at the jump (row 2 has none).
    expect(r.held('t4')).toEqual([[0, 30, 384]]);
    expect(r.launches('t1').filter(before(2000))).toEqual([[0, 0], [384, 2], [1152, 2], [1920, 2]]);
    // The lane playhead jumps to b2 (lane bar 6) at the bar line.
    const lane = r.laneTrace.map((x) => x.lane);
    const jump = lane.findIndex((x) => x >= 2304);
    expect(lane[jump - 1]).toBeLessThan(384 + 1e-6);
    expect(lane[jump]).toBeLessThan(2304 + 60);
    seamless(r);
  });

  it('with the playhead after it, the same: the loop starts at the next bar line', () => {
    const r = new Rig().playSong(2).to(2500);
    r.setLoop('b0', 'b1');
    r.to(6000);
    expect(blockIds(r, 6000)).toEqual([[2304, 'b2'], [2688, 'b0'], [3456, 'b1'], [4992, 'b0'], [5760, 'b1']]);
    expect(r.notes('t1').filter(before(6000))).toEqual(song([2, 2304, 2688], [0, 2688, 3456], [1, 3456, 4992], [0, 4992, 5760], [1, 5760, 6000]));
    seamless(r);
  });

  it('set right after Play, before the first block sounds: the loop’s first block starts in its place', () => {
    const r = new Rig().play();
    r.setLoop('b2');
    r.to(2000);
    expect(blockIds(r, 2000)).toEqual([[0, 'b2'], [768, 'b2'], [1536, 'b2']]);
    expect(r.notes('t1').filter(before(2000))).toEqual(song([2, 0, 2000]));
    expect(r.held('t4')).toEqual([]);
    // The lane shows b2 from the start.
    expect(r.laneTick()).toBeCloseTo(2304 + (r.tick % 768), 6);
  });

  it('cleared while it loops: the pass playing ends as usual and the song goes on to its end', () => {
    const r = new Rig().setLoop('b1').playSong().to(3304);
    r.setLoop(null);
    r.finish();
    expect(r.notes('t1')).toEqual(song([1, 768, 2304], [1, 2304, 3840], [2, 3840, 4608], [3, 4608, 4992]));
    expect(blockIds(r, Infinity)).toEqual([[768, 'b1'], [2304, 'b1'], [3840, 'b2'], [4608, 'b3']]);
    expect(r.ends()).toEqual([4992]);
  });

  it('cleared before a jump to it came: nothing jumps, the song plays as laid out', () => {
    const r = new Rig().play().to(200);
    r.setLoop('b2');
    r.to(300);
    r.setLoop(null);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.ends()).toEqual([3456]);
  });

  it('changed while it loops: inside the new loop it plays on, outside it jumps at the next bar line', () => {
    // Looping b1..b2; at 2500 (in b2) the loop becomes b2..b3: b2 plays on, then b3, then b2 again.
    const a = new Rig().setLoop('b1', 'b2').playSong().to(2500);
    a.setLoop('b2', 'b3');
    a.to(5000);
    expect(blockIds(a, 5000)).toEqual([[768, 'b1'], [2304, 'b2'], [3072, 'b3'], [3456, 'b2'], [4224, 'b3'], [4608, 'b2']]);
    // At 1000 (in b1) the loop becomes b3 alone: b1 sounds to bar line 1152, then b3 loops.
    const b = new Rig().setLoop('b1', 'b2').playSong().to(1000);
    b.setLoop('b3');
    b.to(2500);
    expect(blockIds(b, 2500)).toEqual([[768, 'b1'], [1152, 'b3'], [1536, 'b3'], [1920, 'b3'], [2304, 'b3']]);
    expect(b.notes('t1').filter(before(2500))).toEqual(song([1, 768, 1152], [3, 1152, 2500]));
    seamless(b);
  });
});

describe('where the song starts with a loop set', () => {
  it('from a block before the loop: it plays into the loop and loops', () => {
    const r = new Rig().setLoop('b2').playSong(0).to(4000);
    expect(r.notes('t1').filter(before(4000))).toEqual([...UNEDITED.filter(before(3072)), ...plays(2, 3072, 4000)]);
    expect(blockIds(r, 4000)).toEqual([[0, 'b0'], [768, 'b1'], [2304, 'b2'], [3072, 'b2'], [3840, 'b2']]);
  });

  it('from a bar inside the loop: there, in phase, then it loops', () => {
    // Lane bar 3 (tick 1152) is the second bar of b1's first pass.
    const r = new Rig().setLoop('b1').playSong(undefined, 3).to(3000);
    expect(r.notes('t1').filter(before(3000))).toEqual([...plays(1, 1152, 2304, 768), ...plays(1, 2304, 3000)]);
  });

  it('from a block or bar after the loop: to the song’s end, the loop never engages', () => {
    const a = new Rig().setLoop('b0', 'b1').playSong(3).finish();
    expect(a.notes('t1')).toEqual(plays(3, 3072, 3456));
    expect(a.ends()).toEqual([3456]);
    const b = new Rig().setLoop('b0', 'b1').playSong(undefined, 6).finish();
    expect(b.notes('t1')).toEqual(UNEDITED.filter(([t]) => t >= 2304));
    expect(b.ends()).toEqual([3456]);
  });
});

describe('edits while the song loops', () => {
  it('a block moved into the loop plays in it; one moved out no longer does', () => {
    const a = new Rig().setLoop('b1', 'b2').playSong().to(1000);
    a.edit((s) => cmd.moveBlocks(s, ['b3'], 2));
    a.to(6500);
    expect(blockIds(a, 6500)).toEqual([[768, 'b1'], [2304, 'b3'], [2688, 'b2'], [3456, 'b1'], [4992, 'b3'], [5376, 'b2'], [6144, 'b1']]);

    const b = new Rig().setLoop('b0', 'b2').playSong().to(300);
    b.edit((s) => cmd.moveBlocks(s, ['b1'], 4));
    b.to(3500);
    expect(blockIds(b, 3500)).toEqual([[0, 'b0'], [768, 'b2'], [1536, 'b0'], [2304, 'b2'], [3072, 'b0']]);
    expect(b.notes('t1').filter(before(3500))).toEqual(song([0, 0, 768], [2, 768, 1536], [0, 1536, 2304], [2, 2304, 3072], [0, 3072, 3500]));
  });

  it('the looped block lengthened or shortened while it plays: the pass follows, the loop takes its new length', () => {
    const a = new Rig().setLoop('b2').playSong().to(2500);
    a.edit((s) => cmd.setBlockRepeats(s, 'b2', 3));
    a.to(6000);
    expect(blockIds(a, 6000)).toEqual([[2304, 'b2'], [3456, 'b2'], [4608, 'b2'], [5760, 'b2']]);
    seamless(a);
    // Shortened to one pass while its second plays: on the looped lane the playhead now lies in the
    // block's next pass, which plays the same clips, so playback simply goes on there (no switch).
    const b = new Rig().setLoop('b1').playSong().to(1800);
    const lane = b.laneTick()!;
    b.edit((s) => cmd.setBlockRepeats(s, 'b1', 1));
    expect(b.laneTick()).toBeCloseTo(lane - 768, 6);
    b.to(5000);
    expect(blockIds(b, 5000)).toEqual([[768, 'b1'], [2304, 'b1'], [3072, 'b1'], [3840, 'b1'], [4608, 'b1']]);
    expect(b.notes('t1').filter(before(5000))).toEqual(plays(1, 768, 5000));
    expect(b.launches('t1').filter(before(5000))).toEqual([[768, 1], [2304, 1], [3072, 1], [3840, 1], [4608, 1]]);
    // With other clips in the shortened block's next pass (a 3-bar part), it sounds on to the next bar line instead.
    const p = fixture();
    p.arrangement.blocks[1].parts = {};
    const c = new Rig(setClip(p, 't2', 1, barClip(1, 3))).setLoop('b1', 'b2').playSong().to(768 + 4 * BAR + 10);
    // b1 = 3-bar passes x 2 = [768, 3072); in its second pass (at 2314), shorten it to one pass and give t2
    // row 0's clip: b1 is now 2 bars, so the looped lane puts the playhead in b1's next pass, which
    // sounds different. b1 sounds on to bar line 2688 (t2 switching at the edit point), then b2.
    c.edit((s) => {
      cmd.setBlockRepeats(s, 'b1', 1);
      cmd.setBlockPart(s, 'b1', 't2', s.getState().scenes[0].id);
    });
    c.to(5000);
    expect(blockIds(c, 5000)).toEqual([[768, 'b1'], [2688, 'b2'], [3456, 'b1'], [4224, 'b2'], [4992, 'b1']]);
    expect(c.launches('t2').filter(before(3500))).toEqual([[768, 1], [c.editTicks.at(-1)!, 0], [2688, 2], [3456, 0]]);
    seamless(c);
  });

  it('the loop’s first block deleted: the loop shrinks to what is left of it', () => {
    // While b2 (the loop's last block) plays.
    const a = new Rig().setLoop('b1', 'b2').playSong().to(2500);
    a.edit((s) => cmd.removeBlocks(s, ['b1']));
    expect(a.loop).toEqual({ fromBlockId: 'b2', toBlockId: 'b2' });
    a.to(5000);
    expect(blockIds(a, 5000)).toEqual([[768, 'b1'], [2304, 'b2'], [3072, 'b2'], [3840, 'b2'], [4608, 'b2']]);
    // While b1 itself plays: it sounds on to the next bar line, then b2 loops.
    const b = new Rig().setLoop('b1', 'b2').playSong().to(1000);
    b.edit((s) => cmd.removeBlocks(s, ['b1']));
    b.to(3000);
    expect(blockIds(b, 3000)).toEqual([[768, 'b1'], [1152, 'b2'], [1920, 'b2'], [2688, 'b2']]);
    expect(b.notes('t1').filter(before(3000))).toEqual(song([1, 768, 1152], [2, 1152, 3000]));
    seamless(b);
  });

  it('the loop’s last block deleted: the loop shrinks; deleted while it plays, the loop’s first block takes over at the next bar line', () => {
    const a = new Rig().setLoop('b1', 'b2').playSong().to(1000);
    a.edit((s) => cmd.removeBlocks(s, ['b2']));
    expect(a.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    a.to(5000);
    expect(blockIds(a, 5000)).toEqual([[768, 'b1'], [2304, 'b1'], [3840, 'b1']]);

    const b = new Rig().setLoop('b1', 'b2').playSong().to(2500);
    b.edit((s) => cmd.removeBlocks(s, ['b2']));
    b.to(6000);
    expect(blockIds(b, 6000)).toEqual([[768, 'b1'], [2304, 'b2'], [2688, 'b1'], [4224, 'b1'], [5760, 'b1']]);
    expect(b.notes('t1').filter(before(6000))).toEqual(song([1, 768, 2304], [2, 2304, 2688], [1, 2688, 4224], [1, 4224, 5760], [1, 5760, 6000]));
    // Meanwhile the lane shows the block taking over.
    seamless(b);
  });

  it('every block of the loop deleted while it plays: the loop clears and the song goes on after it', () => {
    const r = new Rig().setLoop('b1', 'b2').playSong().to(2500);
    r.edit((s) => cmd.removeBlocks(s, ['b1', 'b2']));
    expect(r.loop).toBeNull();
    r.finish();
    expect(r.notes('t1')).toEqual(song([1, 768, 2304], [2, 2304, 2688], [3, 2688, 3072]));
    expect(r.ends()).toEqual([3072]);
  });

  it('a split inside the loop keeps both halves in it; nothing you hear changes', () => {
    const plain = new Rig().setLoop('b1').playSong().to(7000);
    for (const at of [1000, 1800]) {
      const r = new Rig().setLoop('b1').playSong().to(at);
      r.edit((s) => cmd.splitBlock(s, 'b1', 1));
      const second = r.project.arrangement.blocks[2].id;
      expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: second });
      r.to(7000);
      expect(r.notes('t1')).toEqual(plain.notes('t1'));
      expect(r.held('t4')).toEqual(plain.held('t4'));
      // Undone: the loop is the whole block again.
      r.edit((s) => s.undo());
      expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    }
  });

  it('joining two halves of the loop keeps it on the joined block; nothing you hear changes', () => {
    const p = fixture();
    p.arrangement.blocks.splice(1, 1, { id: 'b1', sceneId: p.scenes[1].id, repeats: 1 }, { id: 'b1b', sceneId: p.scenes[1].id, repeats: 1 });
    const plain = new Rig(p).setLoop('b1', 'b1b').playSong().to(7000);
    const r = new Rig(p).setLoop('b1', 'b1b').playSong().to(1800);
    r.edit((s) => cmd.joinWithNext(s, 'b1'));
    expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    r.to(7000);
    expect(r.notes('t1')).toEqual(plain.notes('t1'));
    expect(r.held('t4')).toEqual(plain.held('t4'));
  });

  it('undo and redo are edits like any other; Undo of a deletion that shrank the loop brings the loop back, Redo shrinks it again', () => {
    const r = new Rig().setLoop('b1', 'b2').playSong().to(1000);
    r.edit((s) => cmd.removeBlocks(s, ['b2']));
    expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    r.to(1500);
    r.edit((s) => s.undo());
    expect(r.project.arrangement.blocks.map((b) => b.id)).toEqual(['b0', 'b1', 'b2', 'b3']);
    expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b2' });
    // b2 plays after b1 again; deleted again while it plays (Redo), it sounds on to the next bar line and
    // the loop that is left (b1) takes over there.
    r.to(2500);
    r.edit((s) => s.redo());
    expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    r.to(5000);
    expect(blockIds(r, 5000)).toEqual([[768, 'b1'], [2304, 'b2'], [2688, 'b1'], [4224, 'b1']]);
    expect(r.notes('t1').filter(before(5000))).toEqual(song([1, 768, 2304], [2, 2304, 2688], ...cycles(2688, 2, [[1, 1536]])).filter(before(5000)));
    seamless(r);
  });

  it('a part changed in a looped block switches at the edit point and stays changed in every later pass', () => {
    const r = new Rig().setLoop('b1').playSong().to(1000);
    r.edit((s) => cmd.setBlockPart(s, 'b1', 't2', null));
    r.to(5000);
    expect(r.notes('t2').filter(before(5000))).toEqual(plays(1, 768, 1002));
    expect(r.launches('t2').filter(before(5000))).toEqual([[768, 1], [1002, null]]);
    expect(r.notes('t1').filter(before(5000))).toEqual(song(...cycles(768, 3, [[1, 1536]])).filter(before(5000)));
    // Undo: back at once, in phase, and in every pass after.
    r.edit((s) => s.undo());
    r.to(8000);
    expect(r.notes('t2').filter(([t]) => t >= 5376 && t < 8000)).toEqual(plays(1, 5376, 6912).concat(plays(1, 6912, 8000)));
  });
});

describe('pause, change the loop, resume', () => {
  it('a loop set while paused before it: Resume plays to the next bar line after the pause point, then the loop', () => {
    const r = new Rig().play().to(200).pause();
    r.now += 2;
    r.setLoop('b2');
    r.now += 1;
    r.resume().to(2000);
    expect(blockIds(r, 2000)).toEqual([[0, 'b0'], [384, 'b2'], [1152, 'b2'], [1920, 'b2']]);
    expect(r.notes('t1').filter(before(2000))).toEqual(song([0, 0, 384], [2, 384, 2000]));
  });

  it('a loop changed while paused inside it to one that leaves the playhead outside: the jump comes after Resume', () => {
    const r = new Rig().setLoop('b1', 'b2').playSong().to(2500).pause();
    r.now += 1;
    r.setLoop('b0', 'b1');
    r.now += 1;
    r.resume().to(6000);
    expect(blockIds(r, 6000)).toEqual([[768, 'b1'], [2304, 'b2'], [2688, 'b0'], [3456, 'b1'], [4992, 'b0'], [5760, 'b1']]);
  });

  it('cleared while paused: Resume plays on to the song’s end', () => {
    const r = new Rig().setLoop('b1').playSong().to(2500).pause();
    r.now += 1;
    r.setLoop(null);
    r.now += 1;
    r.resume().finish();
    expect(r.notes('t1')).toEqual(song([1, 768, 2304], [1, 2304, 3840], [2, 3840, 4608], [3, 4608, 4992]));
    expect(r.ends()).toEqual([4992]);
  });

  it('paused across a seam: Resume goes on in the next pass, in phase', () => {
    const r = new Rig().setLoop('b3').playSong().to(3456 + 3 * BAR - 10).pause();
    r.now += 2;
    r.resume().to(3456 + 6 * BAR);
    const end = 3456 + 6 * BAR;
    expect(r.notes('t1').filter(before(end))).toEqual(plays(3, 3072, end));
    seamless(r);
  });
});

describe('a long loop', () => {
  it('200 passes of a one-bar loop: the right notes to the last pass, and the plan stays small', () => {
    // 120 BPM: b3 is one bar (2 s). 200 passes are 400 s of audio.
    const r = new Rig().setLoop('b3').playSong();
    let most = 0;
    for (let k = 1; k <= 200; k++) {
      r.to(3072 + k * BAR);
      most = Math.max(most, r.seq.songPlan()!.length);
      // Keep what the driver holds small too (it forgets what was handed out long ago).
      if (k % 20 === 0) r.out = r.out.filter((e) => e.tick >= 3072 + (k - 2) * BAR);
    }
    expect(most).toBeLessThanOrEqual(16);
    const end = 3072 + 200 * BAR;
    expect(r.notes('t1').filter(([t]) => t >= end - 2 * BAR && t < end)).toEqual(plays(3, end - 2 * BAR, end));
    expect(r.blocks().filter(([t]) => t >= end - 2 * BAR && t < end)).toEqual([[end - 2 * BAR, 3, 'b3'], [end - BAR, 3, 'b3']]);
    expect(r.ends()).toEqual([]);
    // The lane playhead is inside b3 (lane [3072, 3456)) and not behind the plan.
    expect(r.laneTick()).toBeGreaterThanOrEqual(3072);
    expect(r.laneTick()).toBeLessThan(3456);
  });
});

describe('the lane and the runtime follow the loop', () => {
  it('the lane playhead goes back to the loop’s first block at every seam; the block at the playhead is the looped one', () => {
    const r = new Rig().setLoop('b1', 'b2').playSong();
    r.traceLane = true;
    r.to(768 + 2 * 2304 + 100);
    const lane = r.laneTrace.map((x) => x.lane);
    // Inside [768, 3072) all the time; it goes back exactly twice (at the two seams).
    for (const x of lane) {
      expect(x).toBeGreaterThanOrEqual(768);
      expect(x).toBeLessThan(3072);
    }
    let back = 0;
    for (let i = 1; i < lane.length; i++) if (lane[i] < lane[i - 1]) back++;
    expect(back).toBe(2);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b1' });
  });
});

describe('the loop after an edit (songLoopAfterEdit)', () => {
  const p = fixture();
  const loop = { fromBlockId: 'b1', toBlockId: 'b2' };
  const edited = (fn: (s: import('../../src/state/projectStore').ProjectStore) => unknown) => {
    const r = new Rig(p);
    fn(r.store);
    return r.project;
  };

  it('keeps the same loop while its blocks are there; moves change what lies between them', () => {
    const moved = edited((s) => cmd.moveBlocks(s, ['b3'], 2));
    expect(songLoopAfterEdit(loop, p, moved)).toBe(loop);
    expect(songLoopBlockIds(moved, loop)).toEqual(['b1', 'b3', 'b2']);
    expect(songLoopRange(songBlocks(moved), loop)).toEqual([1, 3]);
  });

  it('shrinks to what is left of its span, or clears', () => {
    expect(songLoopAfterEdit(loop, p, edited((s) => cmd.removeBlocks(s, ['b1'])))).toEqual({ fromBlockId: 'b2', toBlockId: 'b2' });
    expect(songLoopAfterEdit(loop, p, edited((s) => cmd.removeBlocks(s, ['b2'])))).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    expect(songLoopAfterEdit(loop, p, edited((s) => cmd.removeBlocks(s, ['b1', 'b2'])))).toBeNull();
    const wide = { fromBlockId: 'b0', toBlockId: 'b3' };
    expect(songLoopAfterEdit(wide, p, edited((s) => cmd.removeBlocks(s, ['b0', 'b3'])))).toEqual({ fromBlockId: 'b1', toBlockId: 'b2' });
    // Given the other way round, the same.
    expect(songLoopAfterEdit({ fromBlockId: 'b3', toBlockId: 'b0' }, p, edited((s) => cmd.removeBlocks(s, ['b0', 'b3'])))).toEqual({ fromBlockId: 'b1', toBlockId: 'b2' });
  });

  it('a block that leaves the project, or another project, clears it', () => {
    expect(songLoopAfterEdit(loop, p, { ...p, arrangement: { ...p.arrangement, blocks: [] } })).toBeNull();
    expect(songLoopAfterEdit(null, p, edited((s) => cmd.removeBlocks(s, ['b1'])))).toBeNull();
  });
});

describe('Replay and live pads ignore the loop', () => {
  it('live playback plays the pads, no song plan', () => {
    const r = new Rig().setLoop('b1');
    r.seq.launchScene(0, 0);
    r.play({ mode: { kind: 'live' } }).to(2000);
    expect(r.seq.songPlan()).toBeNull();
    expect(r.notes('t1').filter(before(2000))).toEqual(plays(0, 0, 2000));
  });
});

describe('looping now (runtime songLooping, Sequencer.songLoopingAt)', () => {
  const looping = (r: Rig) => r.seq.songLoopingAt(r.tick);

  it('false while the song plays towards the loop; true inside it, on every pass and while paused there', () => {
    const r = new Rig().setLoop('b1');
    expect(looping(r)).toBe(false);
    r.playSong(0).to(400);
    expect(looping(r)).toBe(false);
    r.to(800);
    expect(looping(r)).toBe(true);
    // The loop's second pass (b1 again from 2304).
    r.to(2304 + 200);
    expect(r.seq.songBlockAt(r.tick)).toEqual({ index: 1, blockId: 'b1' });
    expect(looping(r)).toBe(true);
    r.pause();
    expect(looping(r)).toBe(true);
    r.resume().to(2304 + 600);
    expect(looping(r)).toBe(true);
    // Cleared inside it: the song plays on to its end.
    r.setLoop(null);
    expect(looping(r)).toBe(false);
  });

  it('played from a block after the loop: never looping (the song plays to its end)', () => {
    const r = new Rig().setLoop('b1').playSong(3);
    for (const t of [3100, 3300, 3450]) {
      r.to(t);
      expect(looping(r)).toBe(false);
    }
  });

  it('a loop set while the song plays outside it: false until the jump at the bar line, then true', () => {
    const r = new Rig().playSong(0).to(100);
    r.setLoop('b2');
    expect(looping(r)).toBe(false);
    r.to(380);
    expect(looping(r)).toBe(false);
    r.to(420);
    expect(r.seq.songBlockAt(r.tick)!.blockId).toBe('b2');
    expect(looping(r)).toBe(true);
  });

  it('an edit that moves the playing block out of the loop: false (the song plays on to its end), Undo: true again', () => {
    const r = new Rig().setLoop('b1', 'b3').playSong(2).to(2304 + 100);
    expect(looping(r)).toBe(true);
    // b2 moved after b3: the loop (b1 .. b3) no longer holds it, and an edit never jumps.
    r.edit((s) => cmd.moveBlocks(s, ['b2'], 4));
    expect(r.seq.songBlockAt(r.tick)!.blockId).toBe('b2');
    expect(looping(r)).toBe(false);
    r.edit((s) => s.undo());
    expect(looping(r)).toBe(true);
  });
});
