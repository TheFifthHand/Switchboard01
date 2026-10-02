/**
 * Song building: part changes across many blocks, a recorded take turned into
 * song blocks, an intro and an ending, helper labels that read as one
 * section, song moves (and where they go when blocks split, join or are
 * shaped), and starting a take later.
 */
import { describe, expect, it } from 'vitest';
import { HOUSE } from '../../src/content/starters/house';
import { blockParts } from '../../src/project/arrangement';
import { createClip, createProject } from '../../src/project/factory';
import { TICKS_PER_BAR, type Performance, type PerformanceEvent, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import * as cmd from '../../src/state/commands/arrangement';
import { takeStartingAt, trimTakeStart } from '../../src/state/commands/performances';
import { makeSnapshot } from '../../src/time/snapshot';

const BAR = TICKS_PER_BAR;
const BEAT = BAR / 4;

function valid(p: Project): void {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  expect(r.ok && r.warnings).toEqual([]);
}

const takeLock = (s: ProjectStore) => s.setLock('Recording a performance', (label) => label.startsWith('module:'));

const blockSummary = (p: Project) =>
  p.arrangement.blocks.map((b) => ({ scene: p.scenes.find((s) => s.id === b.sceneId)!.name, repeats: b.repeats, ...(b.parts ? { parts: b.parts } : {}) }));

describe('a part in several blocks at once', () => {
  it('switches Drums off in the selected blocks as one step named after the part', () => {
    const store = new ProjectStore(HOUSE.build());
    const p = store.getState();
    const ids = p.arrangement.blocks.slice(1, 5).map((b) => b.id);
    const r = cmd.setBlocksPart(store, ids, 't1', null);
    expect(r).toMatchObject({ changed: true, blocks: 4 });
    expect(store.undoLabel()).toBe('Drums off in 4 blocks');
    expect(store.getState().arrangement.blocks.filter((b) => ids.includes(b.id)).every((b) => b.parts?.t1 === null)).toBe(true);
    expect(store.historySize().undo).toBe(1);
    // Back on in one of them: the step names the block.
    cmd.setBlocksPart(store, [ids[0]], 't1', undefined);
    expect(store.undoLabel()).toBe(`Drums back in ${p.scenes.find((s) => s.id === p.arrangement.blocks[1].sceneId)!.name}`);
    // Nothing to change: no step.
    expect(cmd.setBlocksPart(store, [ids[0]], 't1', undefined)).toMatchObject({ changed: false, blocks: 0 });
    store.undo();
    store.undo();
    expect(store.getState().arrangement).toEqual(p.arrangement);
    valid(store.getState());
  });

  it('switches a part off everywhere and back on everywhere, keeping clips layered in', () => {
    const store = new ProjectStore(HOUSE.build());
    const p = store.getState();
    cmd.setBlockPart(store, p.arrangement.blocks[0].id, 't5', p.scenes[2].id);
    const r = cmd.setPartEverywhere(store, 't3', false);
    expect(store.undoLabel()).toBe('Bass off everywhere');
    // Off where it played; blocks where it had nothing to play are left alone.
    const q = store.getState();
    const bassPlays = (proj: Project) => proj.arrangement.blocks.filter((b) => blockParts(proj, b).find((x) => x.trackId === 't3')!.clip !== null).length;
    expect(r.blocks).toBe(bassPlays(p));
    expect(bassPlays(q)).toBe(0);
    expect(q.arrangement.blocks.filter((b) => b.parts?.t3 === null)).toHaveLength(r.blocks!);
    cmd.setPartEverywhere(store, 't5', true);
    expect(store.getState().arrangement.blocks[0].parts?.t5).toBe(p.scenes[2].id);
    cmd.setPartEverywhere(store, 't3', true);
    expect(store.undoLabel()).toBe('Bass back on everywhere');
    expect(store.getState().arrangement.blocks.some((b) => b.parts && 't3' in b.parts)).toBe(false);
    valid(store.getState());
  });

  it('is refused while a take records', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    takeLock(store);
    expect(cmd.setBlocksPart(store, [before.arrangement.blocks[0].id], 't1', null).refused).toBe('Recording a performance');
    expect(cmd.setPartEverywhere(store, 't1', false).refused).toBe('Recording a performance');
    expect(store.getState()).toBe(before);
  });
});

describe('make song blocks from a take', () => {
  /** Intro, Groove and Lift with 4-bar passes; drums, bass, chords, and a lead only in Lift. */
  function jam(): { store: ProjectStore; perf: Performance } {
    const p = createProject({ now: 0 });
    p.arrangement.blocks = [];
    p.tracks[0].clips[0] = createClip('Beat A', 1);
    p.tracks[0].clips[1] = createClip('Beat B', 1);
    p.tracks[2].clips[1] = createClip('Bass', 2);
    p.tracks[3].clips[0] = createClip('Pads', 4);
    p.tracks[3].clips[1] = createClip('Stabs', 4);
    p.tracks[4].clips[2] = createClip('Hook', 4);
    const events: PerformanceEvent[] = [
      { t: 0, type: 'scene', row: 0, atTick: 0 },
      { t: 100, type: 'noteOn', trackId: 't4', pitch: 60, velocity: 1, key: 'KeyA' },
      { t: 200, type: 'noteOff', trackId: 't4', pitch: 60, key: 'KeyA' },
      { t: 300, type: 'macro', trackId: 't4', macro: 'tone', value: 0.7 },
      // A scene launch at bar 8 and one beat (quantize off), then the Lift lead alone four bars later.
      { t: 8 * BAR, type: 'scene', row: 1, atTick: 8 * BAR + BEAT },
      { t: 12 * BAR, type: 'launch', trackId: 't5', slot: 2, atTick: 12 * BAR + BEAT },
    ];
    const perf: Performance = {
      id: 'perf_jam',
      name: 'Jam',
      createdAt: 0,
      startTick: 0,
      endTick: 16 * BAR + BEAT,
      snapshot: makeSnapshot(p, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }, { trackId: 't4', playing: { slot: 0, startTick: 0 } }], 0),
      events,
    };
    p.performances.push(perf);
    return { store: new ProjectStore(p), perf };
  }

  it('turns each stretch between launches into whole passes of its scene, and a single-part launch into a part change', () => {
    const { store } = jam();
    const plan = cmd.takeToBlocks(store.getState(), 'perf_jam')!;
    const p = store.getState();
    const scene = (r: number) => p.scenes[r].id;
    expect(plan.blocks).toEqual([
      { sceneId: scene(0), repeats: 2 },
      { sceneId: scene(1), repeats: 1 },
      { sceneId: scene(1), repeats: 1, parts: { t5: scene(2) } },
    ]);
    // 8 bars and a beat of Intro became two 4-bar passes; the notes and the knob move are left out.
    expect(plan.rounded).toBe(true);
    expect(plan.ignored).toEqual({ notes: 1, knobs: 1 });
  });

  it('appends or replaces the song in one undo step and says what it made', () => {
    const { store } = jam();
    const r = cmd.makeSongFromTake(store, 'perf_jam', { mode: 'append' });
    expect(r).toMatchObject({ changed: true, rounded: true, ignored: { notes: 1, knobs: 1 } });
    expect(r.blockIds).toHaveLength(3);
    expect(store.undoLabel()).toBe('Make song blocks');
    expect(blockSummary(store.getState())).toEqual([
      { scene: 'Intro', repeats: 2 },
      { scene: 'Groove', repeats: 1 },
      { scene: 'Groove', repeats: 1, parts: { t5: store.getState().scenes[2].id } },
    ]);
    valid(store.getState());
    cmd.addBlock(store, store.getState().scenes[3].id);
    cmd.makeSongFromTake(store, 'perf_jam', { mode: 'replace' });
    expect(store.getState().arrangement.blocks).toHaveLength(3);
    store.undo();
    expect(store.getState().arrangement.blocks).toHaveLength(4);
    expect(cmd.makeSongFromTake(store, 'perf_none', { mode: 'append' })).toMatchObject({ changed: false, reason: 'not-found' });
  });

  it('leaves silence out and reads parts that stop as switched off', () => {
    const { store, perf } = jam();
    store.apply('performance:Edit', (d) => {
      const x = d.performances[0];
      x.events = [
        { t: 0, type: 'scene', row: 1, atTick: 0 },
        { t: 4 * BAR, type: 'launch', trackId: 't3', slot: null, atTick: 4 * BAR },
        { t: 8 * BAR, type: 'stopAll', atTick: 8 * BAR },
        { t: 12 * BAR, type: 'scene', row: 0, atTick: 12 * BAR },
      ];
      x.endTick = 16 * BAR;
    });
    const plan = cmd.takeToBlocks(store.getState(), perf.id)!;
    const p = store.getState();
    expect(plan.blocks).toEqual([
      { sceneId: p.scenes[1].id, repeats: 1 },
      { sceneId: p.scenes[1].id, repeats: 1, parts: { t3: null } },
      { sceneId: p.scenes[0].id, repeats: 1 },
    ]);
    expect(plan.rounded).toBe(false);
  });

  it('is refused while a take records', () => {
    const { store } = jam();
    takeLock(store);
    expect(cmd.makeSongFromTake(store, 'perf_jam', { mode: 'append' }).refused).toBe('Recording a performance');
  });
});

describe('an intro and an ending', () => {
  it('add an intro: a build-up of the first block’s scene at the start, one undo step', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    const r = cmd.addIntro(store);
    expect(r.changed).toBe(true);
    const p = store.getState();
    const made = p.arrangement.blocks.slice(0, r.blockIds!.length);
    expect(made.map((b) => b.id)).toEqual(r.blockIds);
    expect(made.every((b) => b.sceneId === before.arrangement.blocks[0].sceneId)).toBe(true);
    const n = made.length;
    expect(made.map((b) => b.label)).toEqual(made.map((_, i) => `Intro · build ${i + 1}/${n}`));
    expect(p.arrangement.blocks.slice(n)).toEqual(before.arrangement.blocks);
    expect(store.undoLabel()).toBe('Add an intro');
    valid(p);
  });

  it('add an ending: a strip-down of the last block’s scene, appended; an echo tail of 0 s becomes 2 s', () => {
    const store = new ProjectStore(HOUSE.build());
    cmd.setTailSeconds(store, 0);
    const before = store.getState();
    const last = before.arrangement.blocks[before.arrangement.blocks.length - 1];
    const r = cmd.addEnding(store);
    expect(r.changed).toBe(true);
    const p = store.getState();
    const made = p.arrangement.blocks.slice(before.arrangement.blocks.length);
    expect(made.map((b) => b.id)).toEqual(r.blockIds);
    expect(made.every((b) => b.sceneId === last.sceneId)).toBe(true);
    expect(made[0].label).toMatch(/ · strip 1\/\d$/);
    expect(p.arrangement.tailSeconds).toBe(cmd.ENDING_TAIL_SECONDS);
    store.undo();
    expect(store.getState().arrangement).toEqual(before.arrangement);
    // A tail already set stays.
    cmd.setTailSeconds(store, 5);
    cmd.addEnding(store);
    expect(store.getState().arrangement.tailSeconds).toBe(5);
  });

  it('is refused, with nothing changed, when the scene has one part', () => {
    const p = createProject({ now: 0 });
    p.tracks[0].clips[0] = createClip('Beat', 1);
    const store = new ProjectStore(p);
    expect(cmd.addIntro(store)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState()).toBe(p);
  });
});

describe('helper labels', () => {
  it('label a helper’s blocks after the block, numbered, and replace an earlier helper’s suffix', () => {
    expect(cmd.helperLabels('Lift', 'build', 4)).toEqual(['Lift · build 1/4', 'Lift · build 2/4', 'Lift · build 3/4', 'Lift · build 4/4']);
    expect(cmd.helperLabels('Lift · build 2/4', 'breakdown', 1)).toEqual(['Lift · breakdown']);
    expect(cmd.helperLabels('A very long block name that fills the label', 'strip', 2).every((l) => l.length <= 40 && l.endsWith('/2'))).toBe(true);
  });

  it('blocksWithLabel finds a whole build-up from any of its blocks, or blocks by name', () => {
    const store = new ProjectStore(HOUSE.build());
    const p = store.getState();
    const groove = p.arrangement.blocks.findIndex((b) => b.sceneId === p.scenes[1].id);
    const built = cmd.shapeBlock(store, p.arrangement.blocks[groove].id, 'build').blockIds!;
    const q = store.getState();
    expect(cmd.blocksWithLabel(q, `Groove · build 2/${built.length}`)).toEqual(built);
    expect(cmd.blocksWithLabel(q, 'Intro')).toEqual(q.arrangement.blocks.filter((b) => !b.label && b.sceneId === q.scenes[0].id).map((b) => b.id));
    expect(cmd.blocksWithLabel(q, '   ')).toEqual([]);
  });
});

describe('song moves', () => {
  it('toggle a move on and off (one undo step each), one per kind, parts kept for filter rise', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const id = store.getState().arrangement.blocks[1].id;
    expect(cmd.toggleBlockMove(store, id, 'fadeIn')).toMatchObject({ changed: true, on: true });
    expect(store.undoLabel()).toBe('Add Fade in');
    cmd.toggleBlockMove(store, id, 'filterRise', ['t4', 'ghost', 't4']);
    const moves = () => store.getState().arrangement.blocks[1].moves;
    expect(moves()!.map((m) => [m.kind, m.parts ?? null])).toEqual([['fadeIn', null], ['filterRise', ['t4']]]);
    expect(cmd.toggleBlockMove(store, id, 'fadeIn')).toMatchObject({ changed: true, on: false });
    expect(store.undoLabel()).toBe('Remove Fade in');
    expect(moves()!.map((m) => m.kind)).toEqual(['filterRise']);
    valid(store.getState());
  });

  it('setBlockMoves keeps ids of moves already there, drops repeats and parts on fades; an empty list clears', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const id = store.getState().arrangement.blocks[0].id;
    cmd.setBlockMoves(store, id, [{ kind: 'echoThrow' }]);
    const echoId = store.getState().arrangement.blocks[0].moves![0].id;
    cmd.setBlockMoves(store, id, [{ kind: 'fadeOut', parts: ['t1'] }, { kind: 'echoThrow', parts: ['t5'] }, { kind: 'fadeOut' }]);
    const m = store.getState().arrangement.blocks[0].moves!;
    expect(m.map((x) => [x.kind, x.parts ?? null])).toEqual([['fadeOut', null], ['echoThrow', ['t5']]]);
    expect(m[1].id).toBe(echoId);
    expect(cmd.setBlockMoves(store, id, m)).toMatchObject({ changed: false });
    expect(cmd.setBlockMoves(store, id, [{ kind: 'spin' as never }])).toMatchObject({ changed: false, reason: 'invalid' });
    cmd.setBlockMoves(store, id, []);
    expect(store.getState().arrangement.blocks[0].moves).toBeUndefined();
  });

  it('stay where they happen when a block is split, joined, shaped or copied', () => {
    const store = new ProjectStore(HOUSE.build());
    const p = store.getState();
    const groove = p.arrangement.blocks.find((b) => b.sceneId === p.scenes[1].id && b.repeats >= 2)!;
    cmd.setBlockMoves(store, groove.id, [{ kind: 'fadeIn' }, { kind: 'filterRise' }, { kind: 'echoThrow' }]);
    const second = cmd.splitBlock(store, groove.id, 1).blockId!;
    const blocks = () => store.getState().arrangement.blocks;
    const kinds = (id: string) => (blocks().find((b) => b.id === id)!.moves ?? []).map((m) => m.kind);
    expect(kinds(groove.id)).toEqual(['fadeIn']);
    expect(kinds(second)).toEqual(['filterRise', 'echoThrow']);
    cmd.joinWithNext(store, groove.id);
    expect(kinds(groove.id)).toEqual(['fadeIn', 'filterRise', 'echoThrow']);
    const copy = cmd.duplicateBlocks(store, [groove.id]).blockIds![0];
    expect(kinds(copy)).toEqual(['fadeIn', 'filterRise', 'echoThrow']);
    const ids = new Set(blocks().flatMap((b) => (b.moves ?? []).map((m) => m.id)));
    expect(ids.size).toBe(6);
    const shaped = cmd.shapeBlock(store, groove.id, 'build').blockIds!;
    expect(kinds(shaped[0])).toEqual(['fadeIn']);
    expect(kinds(shaped[shaped.length - 1])).toEqual(['filterRise', 'echoThrow']);
    for (const id of shaped.slice(1, -1)) expect(kinds(id)).toEqual([]);
    valid(store.getState());
  });

  it('are refused while a take records', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    takeLock(store);
    expect(cmd.toggleBlockMove(store, store.getState().arrangement.blocks[0].id, 'fadeOut').refused).toBe('Recording a performance');
  });
});

describe('start a take later', () => {
  function take(): { store: ProjectStore; perf: Performance } {
    const p = createProject({ now: 0 });
    p.tracks[0].clips[0] = createClip('Beat', 1);
    p.tracks[0].clips[1] = createClip('Beat 2', 1);
    p.tracks[3].clips[1] = createClip('Stabs', 2);
    const perf: Performance = {
      id: 'perf_1',
      name: 'Take',
      createdAt: 5,
      startTick: 140,
      endTick: 8 * BAR,
      snapshot: makeSnapshot(p, [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], 140),
      events: [
        { t: 150, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 0.9, key: 'KeyA' },
        { t: 200, type: 'macro', trackId: 't4', macro: 'tone', value: 0.8 },
        { t: 250, type: 'noteOn', trackId: 't5', pitch: 62, velocity: 0.5, key: 'KeyS' },
        { t: 300, type: 'noteOff', trackId: 't5', pitch: 62, key: 'KeyS' },
        { t: 320, type: 'scene', row: 1, atTick: BAR },
        { t: 330, type: 'tempo', bpm: 128 },
        { t: 340, type: 'param', module: 't4:filter', param: 'resonance', value: 0.4 },
        { t: 700, type: 'launch', trackId: 't1', slot: 0, atTick: 2 * BAR },
        { t: 900, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyA' },
        { t: 1000, type: 'mute', trackId: 't2', mute: true },
      ],
    };
    p.performances.push(perf);
    return { store: new ProjectStore(p), perf };
  }

  it('makes what happened before the new start the starting state; held notes start there; launches still landing are kept', () => {
    const { store, perf } = take();
    const at = 2 * BAR - 50;
    const r = trimTakeStart(store, 'perf_1', at);
    expect(r.changed).toBe(true);
    expect(store.undoLabel()).toBe('Start take later');
    const x = store.getState().performances[0];
    expect(x.startTick).toBe(at);
    expect(x.endTick).toBe(8 * BAR);
    // The scene launched at bar 2 (Groove): drums and chords play from it; the tempo, a knob and a big knob are in the snapshot.
    expect(x.snapshot.launcher.find((e) => e.trackId === 't1')!.playing).toEqual({ slot: 1, startTick: BAR });
    expect(x.snapshot.launcher.find((e) => e.trackId === 't4')!.playing).toEqual({ slot: 1, startTick: BAR });
    expect(x.snapshot.bpm).toBe(128);
    expect(x.snapshot.tracks[3].macros.tone).toBe(0.8);
    expect(x.snapshot.patch.modules.find((m) => m.id === 't4:filter')!.params.resonance).toBe(0.4);
    expect(x.events).toEqual([
      // Pressed before the new start, landing after it: still launches.
      { t: at, type: 'launch', trackId: 't1', slot: 0, atTick: 2 * BAR },
      // Still held at the new start: it starts there.
      { t: at, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 0.9, key: 'KeyA' },
      { t: 900, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyA' },
      { t: 1000, type: 'mute', trackId: 't2', mute: true },
    ]);
    valid(store.getState());
    store.undo();
    expect(store.getState().performances[0]).toEqual(perf);
  });

  it('refuses a start that is not later, or not before the end', () => {
    const { store, perf } = take();
    expect(trimTakeStart(store, 'perf_1', perf.startTick)).toEqual({ changed: false });
    expect(trimTakeStart(store, 'perf_1', 100)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(trimTakeStart(store, 'perf_1', perf.endTick)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(trimTakeStart(store, 'nope', 500)).toMatchObject({ changed: false, reason: 'not-found' });
    expect(takeStartingAt(perf, 400).events.every((e) => e.t >= 400)).toBe(true);
  });
});
