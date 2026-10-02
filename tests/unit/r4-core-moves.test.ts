/**
 * Song moves (arrange-no-change-over-time, capability-09 stage 1): the
 * sequencer expands each block's moves into song-gain and big-knob ramps on
 * the song timeline, sends them when generation reaches them, and sends the
 * reached value again wherever playback starts, resumes or is regenerated in
 * the middle of one.
 */
import { describe, expect, it } from 'vitest';
import type { BlockMove, Project } from '../../src/project/types';
import type { SeqEvent } from '../../src/time/contracts';
import { ECHO_THROW_TO, FILTER_RISE_FROM, blockMoveSegments, timelineSegments } from '../../src/time/moves';
import { Sequencer } from '../../src/time/sequencer';
import { makeClip, makeProject, runTo, sec, setClip } from './sequencer-fixtures';

type Gain = Extract<SeqEvent, { kind: 'songGain' }>;
type Ramp = Extract<SeqEvent, { kind: 'macroRamp' }>;

const gains = (ev: readonly SeqEvent[]) => ev.filter((e): e is Gain => e.kind === 'songGain').map((e) => [e.tick, e.from, e.value, e.endTick]);
const ramps = (ev: readonly SeqEvent[], macro?: string) =>
  ev.filter((e): e is Ramp => e.kind === 'macroRamp' && (macro === undefined || e.macro === macro)).map((e) => [e.trackId, e.macro, e.tick, +e.from.toFixed(4), +e.value.toFixed(4), e.endTick]);

/** Four 1-bar scenes; song A (1 bar), B (scene 1 x2 = 2 bars), C (1 bar), D (1 bar). */
function song(moves: Partial<Record<'A' | 'B' | 'C' | 'D', BlockMove[]>>): Project {
  let p = makeProject(120);
  for (let row = 0; row < 4; row++) p = setClip(p, 't1', row, makeClip(1, [[0, row]]));
  p.arrangement = {
    tailSeconds: 1,
    blocks: (['A', 'B', 'C', 'D'] as const).map((id, i) => ({ id, sceneId: p.scenes[[0, 1, 2, 3][i]].id, repeats: id === 'B' ? 2 : 1, ...(moves[id] ? { moves: moves[id] } : {}) })),
  };
  return p;
}

const fade = (kind: 'fadeIn' | 'fadeOut'): BlockMove => ({ id: `m-${kind}`, kind });

describe('song moves: segments', () => {
  it('fades, filter rise and echo throw as the types describe them', () => {
    const p = song({ B: [fade('fadeIn'), { id: 'f', kind: 'filterRise', parts: ['t4'] }, { id: 'e', kind: 'echoThrow', parts: ['t4'] }] });
    const segs = blockMoveSegments(p, 'B', 384, 1152);
    const own = p.tracks.find((t) => t.id === 't4')!.macros;
    expect(segs.map((s) => [s.key.replace('\u0000', '/'), s.tick0, s.tick1, s.v0, s.v1])).toEqual([
      ['gain', 384, 1152, 0, 1],
      ['t4/tone', 384, 1152, FILTER_RISE_FROM, own.tone],
      ['t4/echo', 1152 - 96, 1152, own.echo, ECHO_THROW_TO],
      ['t4/echo', 1152, 1152 + 384 - 96, ECHO_THROW_TO, ECHO_THROW_TO],
      ['t4/echo', 1152 + 384 - 96, 1152 + 384, ECHO_THROW_TO, own.echo],
    ]);
  });

  it('a block with both fades rises over its first half and falls over its second; filter rise without parts takes every melodic part', () => {
    const p = song({ B: [fade('fadeIn'), fade('fadeOut'), { id: 'f', kind: 'filterRise' }] });
    const segs = blockMoveSegments(p, 'B', 384, 1152);
    expect(segs.filter((s) => s.key === 'gain').map((s) => [s.tick0, s.tick1, s.v0, s.v1])).toEqual([[384, 768, 0, 1], [768, 1152, 1, 0]]);
    expect(segs.filter((s) => s.macro === 'tone').map((s) => s.trackId)).toEqual(['t3', 't4', 't5', 't6', 't7', 't8']);
  });

  it("a later block's move takes a target over from its own start", () => {
    const p = song({ A: [{ id: 'e', kind: 'echoThrow', parts: ['t4'] }], B: [{ id: 'e2', kind: 'echoThrow', parts: ['t4'] }] });
    // B is 2 bars: A's throw returns over [672, 768) untouched; B's own rise starts at 1056.
    const segs = timelineSegments(p, [{ blockId: 'A', startTick: 0, endTick: 384 }, { blockId: 'B', startTick: 384, endTick: 1152 }]).filter((s) => s.macro === 'echo');
    expect(segs.map((s) => [s.tick0, s.tick1])).toEqual([[288, 384], [384, 672], [672, 768], [1056, 1152], [1152, 1440], [1440, 1536]]);
    // A 1-bar B: its rise (at 672) cuts A's return.
    const short = { ...p, arrangement: { ...p.arrangement, blocks: p.arrangement.blocks.map((b) => (b.id === 'B' ? { ...b, repeats: 1 } : b)) } };
    const cut = timelineSegments(short, [{ blockId: 'A', startTick: 0, endTick: 384 }, { blockId: 'B', startTick: 384, endTick: 768 }]).filter((s) => s.macro === 'echo');
    expect(cut.map((s) => [s.tick0, s.tick1])).toEqual([[288, 384], [384, 672], [672, 768], [768, 1056], [1056, 1152]]);
  });
});

describe('song moves: ramp events at the right ticks', () => {
  it('a fade in, a fade out, then back to unity where a block without moves starts', () => {
    const p = song({ B: [fade('fadeIn')], C: [fade('fadeOut')] });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    const ev = runTo(seq, 0, sec(1920) + 1);
    expect(gains(ev)).toEqual([
      [384, 0, 1, 1152],
      [1152, 1, 0, 1536],
      [1536, 1, 1, 1536],
    ]);
    const g = ev.filter((e): e is Gain => e.kind === 'songGain');
    expect(g[0].time).toBeCloseTo(sec(384), 9);
    expect(g[0].endTime).toBeCloseTo(sec(1152), 9);
  });

  it('nothing is sent for a song without moves, nor in live playback', () => {
    const p = song({});
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    expect(runTo(seq, 0, 6).filter((e) => e.kind === 'songGain' || e.kind === 'macroRamp')).toEqual([]);
    const live = song({ B: [fade('fadeIn')] });
    const s2 = new Sequencer({ getProject: () => live });
    s2.launchClip('t1', 1, 0);
    s2.start(0);
    expect(runTo(s2, 0, 4).filter((e) => e.kind === 'songGain' || e.kind === 'macroRamp')).toEqual([]);
  });

  it('a start in the middle of a fade (seek) begins at the value it has reached there', () => {
    const p = song({ B: [fade('fadeIn')] });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(1, { mode: { kind: 'song', fromBlock: 0 }, fromTick: 768 });
    const ev = runTo(seq, 1, 1 + sec(800));
    // Back at rest where C starts (it had reached unity: the same value again).
    expect(gains(ev)).toEqual([[768, 0.5, 1, 1152], [1152, 1, 1, 1152]]);
    const g = ev.find((e): e is Gain => e.kind === 'songGain')!;
    expect(g.time).toBeCloseTo(1, 9);
    expect(g.endTime).toBeCloseTo(1 + sec(384), 9);
  });

  it('filter rise per part, put back where the next block starts; echo throw rises over the last beat and returns a bar later', () => {
    const p = song({ B: [{ id: 'f', kind: 'filterRise', parts: ['t3', 't4'] }], C: [{ id: 'e', kind: 'echoThrow', parts: ['t5'] }] });
    const own = (id: string, m: 'tone' | 'echo') => p.tracks.find((t) => t.id === id)!.macros[m];
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    const ev = runTo(seq, 0, sec(1920) + 1);
    expect(ramps(ev, 'tone')).toEqual([
      ['t3', 'tone', 384, FILTER_RISE_FROM, own('t3', 'tone'), 1152],
      ['t4', 'tone', 384, FILTER_RISE_FROM, own('t4', 'tone'), 1152],
      ['t3', 'tone', 1152, own('t3', 'tone'), own('t3', 'tone'), 1152],
      ['t4', 'tone', 1152, own('t4', 'tone'), own('t4', 'tone'), 1152],
    ]);
    expect(ramps(ev, 'echo')).toEqual([
      ['t5', 'echo', 1440, own('t5', 'echo'), ECHO_THROW_TO, 1536],
      ['t5', 'echo', 1536, ECHO_THROW_TO, ECHO_THROW_TO, 1824],
      ['t5', 'echo', 1824, ECHO_THROW_TO, own('t5', 'echo'), 1920],
    ]);
  });

  it('pause and resume in the middle of a fade: it goes on from the value it had reached', () => {
    const p = song({ B: [fade('fadeIn')] });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    runTo(seq, 0, sec(576) + 0.3);
    expect(seq.pause(sec(576))).toBe(true);
    seq.resume(10);
    const ev = runTo(seq, 10, 10 + sec(500));
    expect(gains(ev)).toEqual([[576, 0.25, 1, 1152]]);
    expect(ev.find((e) => e.kind === 'songGain')!.time).toBeCloseTo(10, 9);
  });

  it('a regeneration (an edit, a launch, a replan) sends the value reached at its point again; a move removed meanwhile puts the target back at rest', () => {
    let p = song({ B: [fade('fadeIn')] });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    runTo(seq, 0, sec(576));
    seq.invalidate(sec(576));
    const again = runTo(seq, sec(576), sec(700));
    expect(gains(again)).toEqual([[576, 0.25, 1, 1152]]);
    // The fade is removed while it plays: the song gain returns to unity at the edit point.
    p = song({});
    seq.invalidate(sec(700));
    const after = runTo(seq, sec(700), sec(1600));
    expect(gains(after)).toEqual([[700, 1, 1, 700]]);
  });

  it('a song loop fades in on every pass, in its own ticks', () => {
    const p = song({ B: [fade('fadeIn')] });
    const seq = new Sequencer({ getProject: () => p });
    seq.setSongLoop({ fromBlockId: 'A', toBlockId: 'B' }, 0);
    seq.start(0, { mode: { kind: 'song', fromBlock: 0 } });
    const ev = runTo(seq, 0, sec(2304) + 0.01);
    expect(gains(ev)).toEqual([
      [384, 0, 1, 1152],
      [1152, 1, 1, 1152],
      [1536, 0, 1, 2304],
      [2304, 1, 1, 2304],
    ]);
  });

  it('an export windows the timeline differently and gets the same moves (offline render is identical)', () => {
    const p = song({ B: [fade('fadeIn'), { id: 'f', kind: 'filterRise', parts: ['t4'] }], C: [fade('fadeOut'), { id: 'e', kind: 'echoThrow', parts: ['t4'] }] });
    const take = (step: number, look: number) => {
      const seq = new Sequencer({ getProject: () => p });
      seq.start(0.005, { mode: { kind: 'song', fromBlock: 0 } });
      const out: SeqEvent[] = [];
      for (let t = 0; t < 30 && !seq.ended; t += step) out.push(...seq.process(t + look));
      return out.filter((e) => e.kind === 'songGain' || e.kind === 'macroRamp');
    };
    expect(take(1, 0.12)).toEqual(take(0.025, 0.3));
  });
});
