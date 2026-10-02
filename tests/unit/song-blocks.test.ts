import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/project/factory';
import { blockBars, blockParts, blockRowOverrides, sameMaterial } from '../../src/project/arrangement';
import { MAX_BLOCK_REPEATS, type Id, type Project } from '../../src/project/types';
import { VALIDATION_LIMITS, validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import * as cmd from '../../src/state/commands';
import { songBlocks } from '../../src/time/sequencer';

/** Rows: 0 Intro (drums 1 bar), 1 Groove (drums 1 bar, bass 2 bars), 2 Lift (lead 4 bars), 3 Break (empty). */
function project(): Project {
  const p = createProject({ now: 0 });
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  const [drums, bass, , lead] = p.tracks;
  drums.clips[0] = createClip('intro drums', 1);
  drums.clips[1] = createClip('groove drums', 1);
  bass.clips[1] = createClip('groove bass', 2);
  lead.clips[2] = createClip('lift lead', 4);
  p.arrangement = { tailSeconds: 2, blocks: [] };
  return p;
}

function storeWith(blocks: { sceneRow: number; repeats: number }[]): { store: ProjectStore; ids: Id[]; p: Project } {
  const p = project();
  const store = new ProjectStore(p);
  const ids: Id[] = [];
  for (const b of blocks) {
    const r = cmd.addBlock(store, p.scenes[b.sceneRow].id, undefined, b.repeats);
    ids.push(r.blockId!);
  }
  store.clearHistory?.();
  return { store, ids, p };
}

const order = (s: ProjectStore) => s.getState().arrangement.blocks.map((b) => b.id);

describe('cut', () => {
  it('removing blocks as a Cut names its undo step "Cut block"', () => {
    const { store, ids } = storeWith([
      { sceneRow: 0, repeats: 2 },
      { sceneRow: 1, repeats: 2 },
      { sceneRow: 2, repeats: 2 },
    ]);
    expect(cmd.removeBlocks(store, [ids[1]], { cut: true }).changed).toBe(true);
    expect(store.undoLabel()).toBe('Cut block');
    store.undo();
    cmd.removeBlocks(store, [ids[0], ids[2]], { cut: true });
    expect(store.undoLabel()).toBe('Cut blocks');
    store.undo();
    cmd.removeBlocks(store, [ids[0]]);
    expect(store.undoLabel()).toBe('Remove block');
  });
});

describe('what a block plays', () => {
  it('follows its scene, a layered scene, or nothing, part by part', () => {
    const p = project();
    const [drums, bass, chords, lead] = p.tracks;
    const block = { id: 'b', sceneId: p.scenes[1].id, repeats: 1, parts: { [drums.id]: null, [lead.id]: p.scenes[2].id } };
    const parts = blockParts(p, block);
    expect(parts.find((x) => x.trackId === drums.id)).toMatchObject({ kind: 'off', row: null, clip: null });
    expect(parts.find((x) => x.trackId === bass.id)).toMatchObject({ kind: 'scene', row: 1 });
    expect(parts.find((x) => x.trackId === bass.id)!.clip?.name).toBe('groove bass');
    expect(parts.find((x) => x.trackId === chords.id)).toMatchObject({ kind: 'scene', row: 1, clip: null });
    expect(parts.find((x) => x.trackId === lead.id)).toMatchObject({ kind: 'layer', row: 2, sceneId: p.scenes[2].id });
    expect(blockRowOverrides(p, block)).toEqual({ [drums.id]: null, [lead.id]: 2 });
    // The layered 4-bar lead makes one pass 4 bars long.
    expect(blockBars(p, block)).toBe(4);
    expect(blockBars(p, { id: 'c', sceneId: p.scenes[1].id, repeats: 1 })).toBe(2);
  });

  it('a layer pointing at a deleted scene falls back to the block scene', () => {
    const p = project();
    const block = { id: 'b', sceneId: p.scenes[1].id, repeats: 1, parts: { [p.tracks[1].id]: 'gone' } };
    expect(blockParts(p, block)[1]).toMatchObject({ kind: 'scene', row: 1 });
  });

  it('the song plan carries the per-part rows and the true pass length', () => {
    const p = project();
    p.arrangement.blocks = [
      { id: 'a', sceneId: p.scenes[0].id, repeats: 2, parts: { [p.tracks[3].id]: p.scenes[2].id } },
      { id: 'b', sceneId: p.scenes[1].id, repeats: 16 },
    ];
    const plan = songBlocks(p);
    expect(plan.map((b) => [b.blockId, b.bars, b.repeats, b.startTick, b.endTick])).toEqual([
      ['a', 4, 2, 0, 8 * 384],
      ['b', 2, 16, 8 * 384, 8 * 384 + 32 * 384],
    ]);
    expect(plan[0].parts).toEqual({ [p.tracks[3].id]: 2 });
    expect(plan[1].parts).toEqual({});
  });

  it('same material means same scene and the same part changes', () => {
    expect(sameMaterial({ id: '1', sceneId: 's', repeats: 1 }, { id: '2', sceneId: 's', repeats: 3 })).toBe(true);
    expect(sameMaterial({ id: '1', sceneId: 's', repeats: 1, parts: { t: null } }, { id: '2', sceneId: 's', repeats: 1 })).toBe(false);
    expect(sameMaterial({ id: '1', sceneId: 's', repeats: 1, parts: { t: null } }, { id: '2', sceneId: 's', repeats: 1, parts: { t: null } })).toBe(true);
  });
});

describe('arrangement commands', () => {
  it('moves several blocks together, in song order, as one undo step', () => {
    const { store, ids } = storeWith([0, 1, 2, 3, 0].map((r) => ({ sceneRow: r, repeats: 1 })));
    const [a, b, c, d, e] = ids;
    expect(cmd.moveBlocks(store, [d, b], 0).changed).toBe(true);
    expect(order(store)).toEqual([b, d, a, c, e]);
    expect(cmd.moveBlocks(store, [b, d], 5).changed).toBe(true);
    expect(order(store)).toEqual([a, c, e, b, d]);
    // Dropping a group back where it is changes nothing and adds no undo step.
    expect(cmd.moveBlocks(store, [b, d], 3).changed).toBe(false);
    store.undo();
    expect(order(store)).toEqual([b, d, a, c, e]);
    store.undo();
    expect(order(store)).toEqual([a, b, c, d, e]);
  });

  it('orderAfterMove keeps every block exactly once for any gap', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    const subsets = [['a'], ['c'], ['e'], ['a', 'e'], ['b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e']];
    for (const ids of subsets) {
      for (let gap = -1; gap <= 6; gap++) {
        const out = cmd.orderAfterMove(list, ids, gap).map((x) => x.id);
        expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
        // The moved blocks sit side by side, in their old order.
        const at = out.indexOf(ids[0]);
        expect(out.slice(at, at + ids.length)).toEqual(ids);
      }
    }
  });

  it('duplicates blocks with new ids right after them, or at a chosen gap', () => {
    const { store, ids, p } = storeWith([{ sceneRow: 0, repeats: 2 }, { sceneRow: 1, repeats: 3 }]);
    cmd.setBlockPart(store, ids[1], p.tracks[0].id, null);
    cmd.renameBlock(store, ids[1], 'Verse');
    const r = cmd.duplicateBlocks(store, [ids[1], ids[0]]);
    expect(r.changed).toBe(true);
    const list = store.getState().arrangement.blocks;
    expect(list.map((b) => b.id).slice(0, 2)).toEqual(ids);
    expect(r.blockIds).toEqual([list[2].id, list[3].id]);
    expect(list[2]).toMatchObject({ sceneId: p.scenes[0].id, repeats: 2 });
    expect(list[3]).toMatchObject({ sceneId: p.scenes[1].id, repeats: 3, label: 'Verse', parts: { [p.tracks[0].id]: null } });
    expect(new Set(list.map((b) => b.id)).size).toBe(4);
    // The copy's part changes are its own.
    cmd.setBlockPart(store, list[3].id, p.tracks[0].id, undefined);
    expect(store.getState().arrangement.blocks[1].parts).toEqual({ [p.tracks[0].id]: null });
    const at0 = cmd.duplicateBlocks(store, [ids[0]], 0);
    expect(store.getState().arrangement.blocks[0].id).toBe(at0.blockIds![0]);
  });

  it('pastes templates and skips ones whose scene is gone', () => {
    const { store, ids, p } = storeWith([{ sceneRow: 0, repeats: 1 }]);
    const t = cmd.blockTemplate(store.getState().arrangement.blocks[0]);
    const r = cmd.insertBlocks(store, [t, { sceneId: 'gone', repeats: 2 }, { ...t, repeats: 99, parts: { [p.tracks[0].id]: 'gone', nope: null } }], 0);
    expect(r.skipped).toBe(1);
    const list = store.getState().arrangement.blocks;
    expect(list.map((b) => b.id).at(-1)).toBe(ids[0]);
    expect(list[1].repeats).toBe(MAX_BLOCK_REPEATS);
    expect(list[1].parts).toBeUndefined();
    expect(cmd.insertBlocks(store, [{ sceneId: 'gone', repeats: 1 }]).changed).toBe(false);
  });

  it('removes several blocks in one step', () => {
    const { store, ids } = storeWith([0, 1, 2].map((r) => ({ sceneRow: r, repeats: 1 })));
    expect(cmd.removeBlocks(store, [ids[2], ids[0], 'nope']).removed).toBe(2);
    expect(order(store)).toEqual([ids[1]]);
    store.undo();
    expect(order(store)).toEqual(ids);
  });

  it('repeats run 1 to 16; an edge drag with one gesture id is one undo step', () => {
    const { store, ids } = storeWith([{ sceneRow: 1, repeats: 2 }]);
    for (const n of [3, 4, 5, 40]) cmd.setBlockRepeats(store, ids[0], n, 'edge-1');
    expect(store.getState().arrangement.blocks[0].repeats).toBe(16);
    cmd.setBlockRepeats(store, ids[0], 0);
    expect(store.getState().arrangement.blocks[0].repeats).toBe(1);
    store.undo();
    store.undo();
    expect(store.getState().arrangement.blocks[0].repeats).toBe(2);
  });

  it('split then join gives back the same block length', () => {
    const { store, ids, p } = storeWith([{ sceneRow: 1, repeats: 5 }, { sceneRow: 0, repeats: 1 }]);
    cmd.setBlockPart(store, ids[0], p.tracks[3].id, p.scenes[2].id);
    expect(cmd.splitBlock(store, ids[0], 0).changed).toBe(false);
    expect(cmd.splitBlock(store, ids[0], 5).changed).toBe(false);
    const r = cmd.splitBlock(store, ids[0], 2);
    expect(r.changed).toBe(true);
    let list = store.getState().arrangement.blocks;
    expect(list.map((b) => [b.id, b.repeats])).toEqual([[ids[0], 2], [r.blockId, 3], [ids[1], 1]]);
    expect(list[1].parts).toEqual({ [p.tracks[3].id]: p.scenes[2].id });
    expect(cmd.joinProblem(store.getState(), ids[0])).toBeNull();
    expect(cmd.joinProblem(store.getState(), r.blockId!)).toMatch(/same scene/);
    expect(cmd.joinProblem(store.getState(), ids[1])).toMatch(/no block after/);
    expect(cmd.joinWithNext(store, ids[0]).changed).toBe(true);
    list = store.getState().arrangement.blocks;
    expect(list.map((b) => [b.id, b.repeats])).toEqual([[ids[0], 5], [ids[1], 1]]);
  });

  it('refuses a join longer than 16 passes', () => {
    const { store, ids } = storeWith([{ sceneRow: 1, repeats: 10 }, { sceneRow: 1, repeats: 7 }]);
    expect(cmd.joinProblem(store.getState(), ids[0])).toMatch(/16/);
    expect(cmd.joinWithNext(store, ids[0]).changed).toBe(false);
  });

  it('part choices: layer, silence, follow the scene again', () => {
    const { store, ids, p } = storeWith([{ sceneRow: 1, repeats: 1 }]);
    const [drums, bass, , lead] = p.tracks;
    const block = () => store.getState().arrangement.blocks[0];
    expect(cmd.setBlockPart(store, ids[0], drums.id, null).changed).toBe(true);
    expect(cmd.setBlockPart(store, ids[0], drums.id, null).changed).toBe(false);
    // Choosing the block's own scene is the same as following it.
    expect(cmd.setBlockPart(store, ids[0], bass.id, p.scenes[1].id).changed).toBe(false);
    expect(cmd.setBlockPart(store, ids[0], drums.id, 'gone').reason).toBe('not-found');
    expect(block().parts).toEqual({ [drums.id]: null });
    cmd.setBlockPart(store, ids[0], drums.id, undefined);
    expect(block().parts).toBeUndefined();
    // Layering Lift fills the silent lead; layering Intro fills nothing (Groove has drums) unless it replaces them.
    expect(cmd.layerScene(store, ids[0], p.scenes[2].id).parts).toBe(1);
    const fill = cmd.layerScene(store, ids[0], p.scenes[0].id);
    expect(fill.changed).toBe(false);
    expect(fill.message).toMatch(/Nothing to fill/);
    expect(cmd.layerScene(store, ids[0], p.scenes[0].id, 'replace').parts).toBe(1);
    expect(block().parts).toEqual({ [lead.id]: p.scenes[2].id, [drums.id]: p.scenes[0].id });
    expect(cmd.layerScene(store, ids[0], p.scenes[3].id).changed).toBe(false);
    expect(cmd.layerScene(store, ids[0], p.scenes[1].id, 'replace').changed).toBe(false);
    // Changing the block's scene to Lift drops the lead change (it now follows the scene).
    cmd.setBlockScene(store, ids[0], p.scenes[2].id);
    expect(block().parts).toEqual({ [drums.id]: p.scenes[0].id });
    cmd.resetBlockParts(store, ids[0]);
    expect(block().parts).toBeUndefined();
  });

  it('layering fills only the silent parts by default; replace takes every part the scene has; one undo step each', () => {
    // Rows: 0 Intro (drums), 1 Groove (drums, bass), 2 Lift (lead) — plus a Lift drums clip and a Groove-only perc part here.
    const { store, ids, p } = storeWith([{ sceneRow: 1, repeats: 2 }]);
    const [drums, bass, perc, lead] = p.tracks;
    store.replace(
      (() => {
        const q = structuredClone(store.getState());
        q.tracks[0].clips[2] = createClip('lift drums', 1);
        q.tracks[1].clips[2] = createClip('lift bass', 1);
        q.tracks[2].clips[2] = createClip('lift perc', 1);
        return q;
      })(),
      { resetHistory: true },
    );
    const lift = p.scenes[2].id;
    const block = () => store.getState().arrangement.blocks[0];
    // Bass switched off on purpose: fill leaves it off.
    cmd.setBlockPart(store, ids[0], bass.id, null);
    const undo0 = store.historySize().undo;
    expect(cmd.layerChanges(store.getState(), block(), lift, 'fill').sort()).toEqual([perc.id, lead.id].sort());
    const r = cmd.layerScene(store, ids[0], lift);
    expect(r.parts).toBe(2);
    expect(block().parts).toEqual({ [bass.id]: null, [perc.id]: lift, [lead.id]: lift });
    expect(store.historySize().undo).toBe(undo0 + 1);
    // Now nothing is silent: fill has nothing to do, replace takes drums and bass as well.
    expect(cmd.layerChanges(store.getState(), block(), lift, 'fill')).toEqual([]);
    expect(cmd.layerChanges(store.getState(), block(), lift, 'replace').sort()).toEqual([drums.id, bass.id].sort());
    store.undo();
    expect(block().parts).toEqual({ [bass.id]: null });
    // Replace in one step: every part with a Lift clip plays Lift here, Off or not.
    const r2 = cmd.layerScene(store, ids[0], lift, 'replace');
    expect(r2.parts).toBe(4);
    expect(block().parts).toEqual({ [drums.id]: lift, [bass.id]: lift, [perc.id]: lift, [lead.id]: lift });
    expect(store.historySize().undo).toBe(undo0 + 1);
    // The block's own scene is never layered into itself.
    expect(cmd.layerChanges(store.getState(), block(), block().sceneId, 'replace')).toEqual([]);
    expect(cmd.layerScene(store, ids[0], block().sceneId).message).toMatch(/already plays that scene/);
  });

  it('a part layered from a scene that has no clip for it counts as silent', () => {
    const { store, ids, p } = storeWith([{ sceneRow: 3, repeats: 1 }]);
    const [drums] = p.tracks;
    // Break (row 3) is empty; drums layered from Lift (no drums clip there) is silent, Intro fills it.
    cmd.setBlockPart(store, ids[0], drums.id, p.scenes[2].id);
    expect(cmd.layerChanges(store.getState(), store.getState().arrangement.blocks[0], p.scenes[0].id)).toEqual([drums.id]);
  });

  it('names a block; an empty name shows the scene name again', () => {
    const { store, ids } = storeWith([{ sceneRow: 1, repeats: 1 }]);
    cmd.renameBlock(store, ids[0], '  Chorus   one ');
    expect(store.getState().arrangement.blocks[0].label).toBe('Chorus one');
    expect(cmd.renameBlock(store, ids[0], 'Chorus one').changed).toBe(false);
    cmd.renameBlock(store, ids[0], '   ');
    expect(store.getState().arrangement.blocks[0].label).toBeUndefined();
  });
});

describe('validation of song blocks', () => {
  it('keeps names and valid part changes; drops ones for missing parts or scenes', () => {
    const p = project();
    const raw = JSON.parse(JSON.stringify(p));
    raw.arrangement.blocks = [
      { id: 'blk_a', sceneId: p.scenes[1].id, repeats: 12, label: '  Verse  ', parts: { [p.tracks[0].id]: null, [p.tracks[1].id]: p.scenes[1].id, [p.tracks[3].id]: p.scenes[2].id, ghost: null, [p.tracks[2].id]: 'gone' } },
      { id: 'blk_b', sceneId: p.scenes[0].id, repeats: 30, label: 7, parts: 'nonsense' },
    ];
    const r = validateProject(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = r.project.arrangement.blocks;
    expect(a).toEqual({ id: 'blk_a', sceneId: p.scenes[1].id, repeats: 12, label: 'Verse', parts: { [p.tracks[0].id]: null, [p.tracks[3].id]: p.scenes[2].id } });
    expect(b).toEqual({ id: 'blk_b', sceneId: p.scenes[0].id, repeats: 16 });
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Song helpers: build up, strip down, breakdown                       */
/* ------------------------------------------------------------------ */

describe('song helpers', () => {
  /**
   * One scene ("Drop", row 0) where every part has a clip of `bars` (or
   * `lengths` per role), and one block of it playing `repeats` passes.
   * Tracks (factory roles): drums, percussion, bass, chords, lead, pad, texture, sampler.
   */
  function shaped(repeats: number, lengths: Partial<Record<string, 1 | 2 | 3 | 4 | null>>, parts?: (p: Project) => Record<Id, Id | null>) {
    const p = createProject({ now: 0 });
    for (const t of p.tracks) t.clips = t.clips.map(() => null);
    for (const t of p.tracks) {
      const bars = lengths[t.role];
      if (bars) t.clips[0] = createClip(`${t.role} clip`, bars);
    }
    // Another scene with a lead clip, for a layered part.
    p.tracks.find((t) => t.role === 'lead')!.clips[2] = createClip('lift lead', 4);
    p.arrangement = { tailSeconds: 2, blocks: [{ id: 'blk_x', sceneId: p.scenes[0].id, repeats, ...(parts ? { parts: parts(p) } : {}) }] };
    const store = new ProjectStore(p);
    const role = (r: string) => p.tracks.find((t) => t.role === r)!.id;
    return { store, p, role, list: () => store.getState().arrangement.blocks };
  }
  /** The parts that play in each block, by role, with its passes. */
  function playing(store: ProjectStore) {
    const p = store.getState();
    return p.arrangement.blocks.map((b) => ({
      repeats: b.repeats,
      plays: blockParts(p, b)
        .filter((x) => x.clip)
        .map((x) => p.tracks.find((t) => t.id === x.trackId)!.role)
        .sort(),
    }));
  }
  const ticks = (s: ProjectStore) => songBlocks(s.getState()).reduce((n, b) => n + (b.endTick - b.startTick), 0);

  it('the build order: texture, pad, chords, lead, sampler, percussion, bass, drums (same role: track order)', () => {
    expect(cmd.BUILD_ORDER).toEqual(['texture', 'pad', 'chords', 'lead', 'sampler', 'percussion', 'bass', 'drums']);
    const { p, role } = shaped(4, { drums: 4, percussion: 4, bass: 4, chords: 4, lead: 4, pad: 4, texture: 4, sampler: 4 });
    expect(cmd.soundingInBuildOrder(p, p.arrangement.blocks[0])).toEqual(['texture', 'pad', 'chords', 'lead', 'sampler', 'percussion', 'bass', 'drums'].map(role));
    // Two parts with one role keep their track order.
    const q = structuredClone(p);
    q.tracks[1].role = 'drums';
    expect(cmd.soundingInBuildOrder(q, q.arrangement.blocks[0]).slice(-2)).toEqual([q.tracks[0].id, q.tracks[1].id]);
  });

  it('shapePasses: pass i plays the first ceil((i+1)·k/n) parts; strip down is the reverse', () => {
    const o = ['a', 'b', 'c', 'd'];
    expect(cmd.shapePasses(o, 4, 'build')).toEqual([['a'], ['a', 'b'], ['a', 'b', 'c'], o]);
    expect(cmd.shapePasses(o, 2, 'build')).toEqual([['a', 'b'], o]);
    expect(cmd.shapePasses(['a', 'b', 'c'], 6, 'build').map((s) => s.length)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(cmd.shapePasses(o, 4, 'strip')).toEqual([o, ['a', 'b', 'c'], ['a', 'b'], ['a']]);
    // The last pass of a strip-down keeps at least one part.
    expect(cmd.shapePasses(['a', 'b'], 16, 'strip').at(-1)).toEqual(['a']);
  });

  it('build up: parts come in one at a time, pass by pass, as one undo step; the first block keeps its id', () => {
    const { store, list } = shaped(4, { drums: 4, bass: 4, chords: 4, pad: 4 });
    const before = structuredClone(store.getState().arrangement);
    const length = ticks(store);
    const r = cmd.shapeBlock(store, 'blk_x', 'build');
    expect(r.changed).toBe(true);
    expect(r.parts).toBe(4);
    expect(playing(store)).toEqual([
      { repeats: 1, plays: ['pad'] },
      { repeats: 1, plays: ['chords', 'pad'] },
      { repeats: 1, plays: ['bass', 'chords', 'pad'] },
      { repeats: 1, plays: ['bass', 'chords', 'drums', 'pad'] },
    ]);
    expect(list()[0].id).toBe('blk_x');
    expect(r.blockIds).toEqual(list().map((b) => b.id));
    expect(new Set(r.blockIds).size).toBe(4);
    // Every change is a per-part Off; the last pass plays the scene as it is.
    expect(list()[3].parts).toBeUndefined();
    expect(ticks(store)).toBe(length);
    expect(store.historySize().undo).toBe(1);
    store.undo();
    expect(store.getState().arrangement).toEqual(before);
  });

  it('build up joins neighbouring passes with the same parts (3 parts over 6 passes: three blocks of 2 passes)', () => {
    const { store } = shaped(6, { drums: 2, chords: 2, texture: 2 });
    cmd.shapeBlock(store, 'blk_x', 'build');
    expect(playing(store)).toEqual([
      { repeats: 2, plays: ['texture'] },
      { repeats: 2, plays: ['chords', 'texture'] },
      { repeats: 2, plays: ['chords', 'drums', 'texture'] },
    ]);
  });

  it('strip down: every part first, then they drop out (drums first); the last pass keeps one', () => {
    const { store } = shaped(4, { drums: 4, bass: 4, chords: 4, pad: 4 });
    const length = ticks(store);
    cmd.shapeBlock(store, 'blk_x', 'strip');
    expect(playing(store)).toEqual([
      { repeats: 1, plays: ['bass', 'chords', 'drums', 'pad'] },
      { repeats: 1, plays: ['bass', 'chords', 'pad'] },
      { repeats: 1, plays: ['chords', 'pad'] },
      { repeats: 1, plays: ['pad'] },
    ]);
    expect(ticks(store)).toBe(length);
    expect(store.historySize().undo).toBe(1);
  });

  it('parts silent in the block stay silent; a part switched Off stays off; a layered part takes part', () => {
    const { store, p, role } = shaped(3, { drums: 4, percussion: 4, pad: 4 }, (q) => ({
      [q.tracks.find((t) => t.role === 'percussion')!.id]: null,
      [q.tracks.find((t) => t.role === 'lead')!.id]: q.scenes[2].id,
    }));
    expect(cmd.soundingInBuildOrder(p, p.arrangement.blocks[0])).toEqual([role('pad'), role('lead'), role('drums')]);
    cmd.shapeBlock(store, 'blk_x', 'build');
    expect(playing(store)).toEqual([
      { repeats: 1, plays: ['pad'] },
      { repeats: 1, plays: ['lead', 'pad'] },
      { repeats: 1, plays: ['drums', 'lead', 'pad'] },
    ]);
    // Percussion is off in every block, the layered lead keeps its scene where it plays.
    for (const b of store.getState().arrangement.blocks) expect(b.parts![role('percussion')]).toBeNull();
    expect(store.getState().arrangement.blocks[2].parts![role('lead')]).toBe(p.scenes[2].id);
  });

  it('a pass keeps its length when the parts that play in it are shorter (the song length does not change)', () => {
    // Pad 1 bar, drums 4 bars: the first pass (pad only) plays its 1-bar clip four times.
    const { store } = shaped(2, { pad: 1, drums: 4 });
    const length = ticks(store);
    cmd.shapeBlock(store, 'blk_x', 'build');
    expect(playing(store)).toEqual([
      { repeats: 4, plays: ['pad'] },
      { repeats: 1, plays: ['drums', 'pad'] },
    ]);
    expect(ticks(store)).toBe(length);
    // 16 passes: the pad-only half is 8 × 4 = 32 one-bar passes, two blocks of 16.
    const big = shaped(16, { pad: 1, drums: 4 });
    const bigLength = ticks(big.store);
    cmd.shapeBlock(big.store, 'blk_x', 'build');
    expect(playing(big.store)).toEqual([
      { repeats: 16, plays: ['pad'] },
      { repeats: 16, plays: ['pad'] },
      { repeats: 8, plays: ['drums', 'pad'] },
    ]);
    expect(ticks(big.store)).toBe(bigLength);
    expect(big.store.historySize().undo).toBe(1);
  });

  it('breakdown switches off the drums, percussion and bass that sound there (one undo step)', () => {
    const { store, role, list } = shaped(4, { drums: 4, percussion: 2, chords: 4, pad: 4 });
    const length = ticks(store);
    const r = cmd.shapeBlock(store, 'blk_x', 'breakdown');
    expect(r.changed).toBe(true);
    expect(r.parts).toBe(2);
    expect(list()).toEqual([{ id: 'blk_x', sceneId: store.getState().scenes[0].id, repeats: 4, parts: { [role('drums')]: null, [role('percussion')]: null } }]);
    expect(ticks(store)).toBe(length);
    expect(store.historySize().undo).toBe(1);
  });

  it('refuses with a short reason when a helper cannot shape the block', () => {
    const reason = (s: ReturnType<typeof shaped>, kind: cmd.ShapeKind) => cmd.shapeProblem(s.store.getState(), 'blk_x', kind)?.short ?? null;
    const once = shaped(1, { drums: 4, pad: 4 });
    expect(reason(once, 'build')).toBe('Plays once');
    expect(reason(once, 'strip')).toBe('Plays once');
    expect(reason(once, 'breakdown')).toBeNull();
    const one = shaped(4, { pad: 4 });
    expect(reason(one, 'build')).toBe('One part');
    expect(cmd.shapeProblem(one.store.getState(), 'blk_x', 'strip')?.text).toContain('nothing to drop out');
    expect(reason(one, 'breakdown')).toBe('No beat or bass');
    const none = shaped(4, {});
    expect(reason(none, 'build')).toBe('Nothing plays');
    const beat = shaped(4, { drums: 4, bass: 2 });
    expect(reason(beat, 'breakdown')).toBe('Nothing left');
    expect(reason(beat, 'build')).toBeNull();
    // Refused commands change nothing and add no undo step.
    const r = cmd.shapeBlock(beat.store, 'blk_x', 'breakdown');
    expect(r.changed).toBe(false);
    expect(r.message).toContain('would leave silence');
    expect(beat.store.historySize().undo).toBe(0);
    expect(cmd.shapeBlock(beat.store, 'nope', 'build').changed).toBe(false);
    // A block whose scene was deleted.
    const gone = shaped(4, { drums: 4, pad: 4 });
    gone.store.apply('x', (d) => {
      d.arrangement.blocks[0].sceneId = 'missing';
    });
    expect(reason(gone, 'build')).toBe('Scene missing');
  });

  it('uneven clip lengths (a 3-bar clip in a 4-bar pass): refused with a short reason; the song never changes length', () => {
    // Pad 3 bars, drums 4: the pad-only passes of a build-up would be 3-bar passes in 4-bar room.
    const uneven = shaped(4, { pad: 3, drums: 4 });
    const before = structuredClone(uneven.store.getState().arrangement);
    for (const kind of ['build', 'strip'] as const) {
      const why = cmd.shapeProblem(uneven.store.getState(), 'blk_x', kind);
      expect(why).toEqual({ short: 'Uneven clips', text: 'Its clips have different lengths (3 and 4 bars), so the repeats would not line up and the song would change length.' });
      const r = cmd.shapeBlock(uneven.store, 'blk_x', kind);
      expect(r.changed).toBe(false);
      expect(r.message).toContain('different lengths');
    }
    // Breakdown without the drums leaves the 3-bar pad to fill 16 bars: refused too.
    expect(cmd.shapeProblem(uneven.store.getState(), 'blk_x', 'breakdown')).toEqual({
      short: 'Uneven clips',
      text: 'Its clips have different lengths (3 and 4 bars): without the drums and bass the rest would not fill the block exactly, and the song would change length.',
    });
    expect(cmd.shapeBlock(uneven.store, 'blk_x', 'breakdown').changed).toBe(false);
    expect(uneven.store.getState().arrangement).toEqual(before);
    expect(uneven.store.historySize().undo).toBe(0);
    // Lengths that divide the pass still work, and keep the song's length exactly (a 2-bar pad in 4-bar passes).
    const even = shaped(4, { pad: 2, drums: 4 });
    const length = ticks(even.store);
    expect(cmd.shapeProblem(even.store.getState(), 'blk_x', 'build')).toBeNull();
    expect(cmd.shapeBlock(even.store, 'blk_x', 'build').changed).toBe(true);
    expect(ticks(even.store)).toBe(length);
    // A 3-bar clip over three 4-bar passes fills 12 bars exactly: allowed (four 3-bar passes).
    const twelve = shaped(4, { pad: 3, drums: 4 }, undefined);
    twelve.store.apply('arrange:x', (d) => {
      d.arrangement.blocks[0].repeats = 3;
    });
    expect(cmd.shapeProblem(twelve.store.getState(), 'blk_x', 'breakdown')).toBeNull();
    const t0 = ticks(twelve.store);
    cmd.shapeBlock(twelve.store, 'blk_x', 'breakdown');
    expect(playing(twelve.store)).toEqual([{ repeats: 4, plays: ['pad'] }]);
    expect(ticks(twelve.store)).toBe(t0);
  });

  it('never changes the song length: across clip-length mixes and repeat counts, each helper keeps the length exactly or is refused with nothing changed', () => {
    const lens = [1, 2, 3, 4, null] as const;
    let shapedCount = 0;
    let refused = 0;
    // A deterministic walk over mixes of four parts' lengths and 1–16 repeats.
    for (let seed = 0; seed < 400; seed++) {
      const pick = (k: number) => lens[(seed * 7 + k * 13 + Math.floor(seed / (k + 2))) % lens.length];
      const lengths = { drums: pick(1), bass: pick(2), chords: pick(3), pad: pick(4) };
      const repeats = 1 + ((seed * 5) % 16);
      for (const kind of ['build', 'strip', 'breakdown'] as const) {
        const s = shaped(repeats, lengths);
        const before = structuredClone(s.store.getState().arrangement);
        const t0 = ticks(s.store);
        const problem = cmd.shapeProblem(s.store.getState(), 'blk_x', kind);
        const r = cmd.shapeBlock(s.store, 'blk_x', kind);
        if (problem) {
          refused++;
          expect(r.changed).toBe(false);
          expect(s.store.getState().arrangement).toEqual(before);
        } else {
          shapedCount++;
          expect(r.changed, `${kind} ${JSON.stringify(lengths)} ×${repeats}`).toBe(true);
          expect(ticks(s.store), `${kind} ${JSON.stringify(lengths)} ×${repeats}`).toBe(t0);
        }
      }
    }
    // Both outcomes happen in the walk.
    expect(shapedCount).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
  });

  it('refuses when the song has no room for the new blocks', () => {
    const { store } = shaped(8, { drums: 4, bass: 4, chords: 4, pad: 4 });
    store.apply('fill', (d) => {
      for (let i = d.arrangement.blocks.length; i < VALIDATION_LIMITS.maxBlocks - 1; i++) d.arrangement.blocks.push({ id: `f${i}`, sceneId: d.scenes[1].id, repeats: 1 });
    });
    const n = store.getState().arrangement.blocks.length;
    const r = cmd.shapeBlock(store, 'blk_x', 'build');
    expect(r.changed).toBe(false);
    expect(r.message).toContain('as many blocks');
    expect(store.getState().arrangement.blocks.length).toBe(n);
  });
});
