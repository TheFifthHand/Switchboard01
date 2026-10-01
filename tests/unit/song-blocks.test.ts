import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/project/factory';
import { blockBars, blockParts, blockRowOverrides, sameMaterial } from '../../src/project/arrangement';
import { MAX_BLOCK_REPEATS, type Id, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
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
    // Layering Lift adds its lead; layering Intro replaces the drums.
    expect(cmd.layerScene(store, ids[0], p.scenes[2].id).parts).toBe(1);
    expect(cmd.layerScene(store, ids[0], p.scenes[0].id).parts).toBe(1);
    expect(block().parts).toEqual({ [lead.id]: p.scenes[2].id, [drums.id]: p.scenes[0].id });
    expect(cmd.layerScene(store, ids[0], p.scenes[3].id).changed).toBe(false);
    // Changing the block's scene to Lift drops the lead change (it now follows the scene).
    cmd.setBlockScene(store, ids[0], p.scenes[2].id);
    expect(block().parts).toEqual({ [drums.id]: p.scenes[0].id });
    cmd.resetBlockParts(store, ids[0]);
    expect(block().parts).toBeUndefined();
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
