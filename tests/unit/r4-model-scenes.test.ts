/**
 * Scene rows (PLAY-10, capability-08, arrange-only-four-scenes): insert,
 * duplicate, delete (asking first when the song uses the scene), capture what
 * plays, and make a scene from a song block. Each is one undo step, refuses
 * bad input with nothing changed, and is refused while a take records.
 */
import { describe, expect, it } from 'vitest';
import { HOUSE } from '../../src/content/starters/house';
import { blockParts } from '../../src/project/arrangement';
import { createClip, createProject } from '../../src/project/factory';
import { MAX_SCENES, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { setBlockPart } from '../../src/state/commands/arrangement';
import { captureScene, deleteScene, duplicateScene, insertScene, sceneFromBlock, sceneUse, uniqueSceneName } from '../../src/state/commands/scenes';

function valid(p: Project): void {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  expect(r.ok && r.warnings).toEqual([]);
}

/** A performance take's lock: only recordable edits pass (clip, scene and song edits are refused). */
const takeLock = (s: ProjectStore) => s.setLock('Recording a performance', (label) => label.startsWith('module:') || label === 'track:Mute part' || label === 'track:Unmute part');

const names = (p: Project) => p.scenes.map((s) => s.name);
const row = (p: Project, r: number) => p.tracks.map((t) => t.clips[r]?.name ?? null);

describe('insertScene', () => {
  it('adds an empty row where asked; later rows move down with their clips; one undo step', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    const r = insertScene(store, 1);
    expect(r).toMatchObject({ changed: true, row: 1 });
    const p = store.getState();
    expect(names(p)).toEqual(['Intro', 'Scene 2', 'Groove', 'Lift', 'Break']);
    expect(row(p, 1).every((c) => c === null)).toBe(true);
    expect(row(p, 2)).toEqual(row(before, 1));
    expect(p.tracks.every((t) => t.clips.length === 5)).toBe(true);
    // The song plays the same scenes (blocks point at scene ids).
    expect(p.arrangement).toEqual(before.arrangement);
    valid(p);
    expect(store.undoLabel()).toBe('Add scene');
    store.undo();
    expect(store.getState()).toEqual({ ...before, updatedAt: store.getState().updatedAt });
  });

  it('appends by default, takes a name, and refuses past 8 scenes or a row that does not exist', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    expect(insertScene(store, undefined, '  Drop  ')).toMatchObject({ changed: true, row: 4 });
    expect(names(store.getState())[4]).toBe('Drop');
    expect(insertScene(store, 9).changed).toBe(false);
    expect(insertScene(store, -1).changed).toBe(false);
    while (store.getState().scenes.length < MAX_SCENES) insertScene(store);
    const full = store.getState();
    expect(insertScene(store)).toMatchObject({ changed: false, reason: 'limit', message: 'A project holds up to 8 scenes. Delete one first.' });
    expect(duplicateScene(store, 0)).toMatchObject({ changed: false, reason: 'limit' });
    expect(captureScene(store, { t1: 0 })).toMatchObject({ changed: false, reason: 'limit' });
    expect(store.getState()).toBe(full);
    valid(full);
  });
});

describe('duplicateScene', () => {
  it('copies the row below itself with new ids and a numbered name', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    const r = duplicateScene(store, 1);
    expect(r).toMatchObject({ changed: true, row: 2 });
    const p = store.getState();
    expect(names(p)).toEqual(['Intro', 'Groove', 'Groove 2', 'Lift', 'Break']);
    for (const t of p.tracks) {
      const a = t.clips[1];
      const b = t.clips[2];
      if (!a) {
        expect(b).toBeNull();
        continue;
      }
      expect(b!.id).not.toBe(a.id);
      expect(b!.notes.map((n) => [n.tick, n.pitch, n.velocity, n.duration])).toEqual(a.notes.map((n) => [n.tick, n.pitch, n.velocity, n.duration]));
      expect(b!.notes.every((n, i) => n.id !== a.notes[i].id)).toBe(true);
    }
    valid(p);
    // Again: "Groove 3", and a copy of "Groove 2" is "Groove 3" too when free.
    duplicateScene(store, 1);
    expect(names(store.getState()).slice(0, 4)).toEqual(['Intro', 'Groove', 'Groove 3', 'Groove 2']);
    expect(uniqueSceneName(store.getState(), 'Groove 2')).toBe('Groove 4');
    store.undo();
    store.undo();
    expect(store.getState().scenes).toEqual(before.scenes);
    expect(duplicateScene(store, 7).changed).toBe(false);
  });
});

describe('deleteScene', () => {
  it('asks first when song blocks play the scene or layer it in, and says which', () => {
    const store = new ProjectStore(HOUSE.build());
    const p = store.getState();
    const lift = p.scenes[2];
    // Layer Lift's lead into the first block.
    setBlockPart(store, p.arrangement.blocks[0].id, 't5', lift.id);
    const before = store.getState();
    const r = deleteScene(store, 2);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('in-use');
    expect(r.blocksUsing).toEqual(sceneUse(before, lift.id).blocksUsing);
    expect(r.blocksUsing!.length).toBeGreaterThan(0);
    expect(r.blocksLayering).toEqual([before.arrangement.blocks[0].id]);
    expect(r.message).toMatch(/^Lift is in the song: \d song blocks? plays? it and 1 block layers one of its clips in\./);
    expect(store.getState()).toBe(before);
  });

  it('with removeBlocks: the row, its clips and the blocks that play it go; layered parts follow their block again; one undo step', () => {
    const store = new ProjectStore(HOUSE.build());
    const lift = store.getState().scenes[2];
    setBlockPart(store, store.getState().arrangement.blocks[0].id, 't5', lift.id);
    const before = store.getState();
    const r = deleteScene(store, 2, { removeBlocks: true });
    expect(r.changed).toBe(true);
    const p = store.getState();
    expect(names(p)).toEqual(['Intro', 'Groove', 'Break']);
    expect(p.tracks.every((t) => t.clips.length === 3)).toBe(true);
    expect(row(p, 2)).toEqual(row(before, 3));
    expect(p.arrangement.blocks.some((b) => b.sceneId === lift.id)).toBe(false);
    expect(p.arrangement.blocks.length).toBe(before.arrangement.blocks.length - r.blocksUsing!.length);
    expect(p.arrangement.blocks[0].parts).toBeUndefined();
    valid(p);
    expect(store.undoLabel()).toBe('Delete scene');
    store.undo();
    expect(store.getState().scenes).toEqual(before.scenes);
    expect(store.getState().arrangement).toEqual(before.arrangement);
    expect(store.getState().tracks).toEqual(before.tracks);
  });

  it('deletes a scene the song does not use at once, and never the last scene', () => {
    const store = new ProjectStore(createProject({ now: 0, scenes: ['A', 'B'] }));
    store.apply('arrange:Clear', (d) => void (d.arrangement.blocks = []));
    expect(deleteScene(store, 1).changed).toBe(true);
    expect(deleteScene(store, 0)).toMatchObject({ changed: false, message: 'A project needs at least one scene.' });
    expect(deleteScene(store, 5)).toMatchObject({ changed: false, reason: 'not-found' });
    valid(store.getState());
  });
});

describe('captureScene', () => {
  it('copies the given clips into a new last scene; parts not playing stay empty', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    const r = captureScene(store, { t1: 1, t3: 2, t4: null, t5: 0 });
    expect(r).toMatchObject({ changed: true, row: 4 });
    const p = store.getState();
    expect(names(p)[4]).toBe('Scene 5');
    expect(row(p, 4)).toEqual([before.tracks[0].clips[1]!.name, null, before.tracks[2].clips[2]!.name, null, before.tracks[4].clips[0]?.name ?? null, null, null, null]);
    expect(p.tracks[0].clips[4]!.id).not.toBe(before.tracks[0].clips[1]!.id);
    valid(p);
    expect(captureScene(store, { t1: null, t2: 3 }, 'Nothing').changed).toBe(before.tracks[1].clips[3] !== null);
  });

  it('refuses when nothing plays', () => {
    const store = new ProjectStore(HOUSE.build());
    expect(captureScene(store, {})).toMatchObject({ changed: false, reason: 'empty' });
    expect(captureScene(store, { t1: null })).toMatchObject({ changed: false, reason: 'empty' });
  });
});

describe('sceneFromBlock', () => {
  it('freezes what a block plays (its scene, layered clips, parts off) into a new scene and points the block at it', () => {
    const store = new ProjectStore(HOUSE.build());
    const p0 = store.getState();
    const block = p0.arrangement.blocks.find((b) => b.sceneId === p0.scenes[1].id)!;
    setBlockPart(store, block.id, 't5', p0.scenes[2].id);
    setBlockPart(store, block.id, 't1', null);
    const before = store.getState();
    const plays = blockParts(before, before.arrangement.blocks.find((b) => b.id === block.id)!).map((x) => x.clip?.name ?? null);
    const r = sceneFromBlock(store, block.id);
    expect(r).toMatchObject({ changed: true, row: 4 });
    const p = store.getState();
    expect(names(p)[4]).toBe('Groove 2');
    expect(row(p, 4)).toEqual(plays);
    const b = p.arrangement.blocks.find((x) => x.id === block.id)!;
    expect(b.sceneId).toBe(r.sceneId);
    expect(b.parts).toBeUndefined();
    // It plays exactly the same clips (as copies).
    expect(blockParts(p, b).map((x) => x.clip?.name ?? null)).toEqual(plays);
    valid(p);
    expect(store.undoLabel()).toBe('Make a scene from a block');
    store.undo();
    expect(store.getState().arrangement).toEqual(before.arrangement);
    expect(store.getState().scenes).toEqual(before.scenes);
  });

  it('a block with a name gives the scene that name; a silent block is refused', () => {
    const p = createProject({ now: 0 });
    p.tracks[0].clips[0] = createClip('Beat', 1);
    p.arrangement.blocks[0].label = 'Drop';
    const store = new ProjectStore(p);
    expect(sceneFromBlock(store, p.arrangement.blocks[0].id).changed).toBe(true);
    expect(store.getState().scenes[4].name).toBe('Drop');
    expect(sceneFromBlock(store, p.arrangement.blocks[1].id)).toMatchObject({ changed: false, reason: 'empty' });
    expect(sceneFromBlock(store, 'nope')).toMatchObject({ changed: false, reason: 'not-found' });
  });
});

describe('the take lock', () => {
  it('refuses every scene edit while a performance records, with nothing changed', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    takeLock(store);
    const block = before.arrangement.blocks[0].id;
    for (const r of [insertScene(store), duplicateScene(store, 0), deleteScene(store, 3, { removeBlocks: true }), captureScene(store, { t1: 1 }), sceneFromBlock(store, block)]) {
      expect(r.changed).toBe(false);
      expect(r.refused).toBe('Recording a performance');
    }
    expect(store.getState()).toBe(before);
  });
});

describe('random scene, clip and song edits', () => {
  it('every state validates cleanly, and undo/redo walk back and forth exactly', async () => {
    const { mulberry32 } = await import('../../src/project/rng');
    const clips = await import('../../src/state/commands/clips');
    const arr = await import('../../src/state/commands/arrangement');
    const strip = (p: Project) => ({ ...JSON.parse(JSON.stringify(p)), updatedAt: 0 });
    for (let seed = 1; seed <= 5; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
      const int = (n: number) => Math.floor(rnd() * n);
      const store = new ProjectStore(HOUSE.build());
      const states: unknown[] = [strip(store.getState())];
      for (let i = 0; i < 80; i++) {
        const p = store.getState();
        const t = pick(p.tracks).id;
        const rows = p.scenes.length;
        const blocks = p.arrangement.blocks;
        const ops: (() => unknown)[] = [
          () => insertScene(store, int(rows + 1)),
          () => duplicateScene(store, int(rows)),
          () => deleteScene(store, int(rows), { removeBlocks: rnd() < 0.7 }),
          () => captureScene(store, Object.fromEntries(p.tracks.map((x) => [x.id, rnd() < 0.5 ? int(rows) : null]))),
          () => blocks.length && sceneFromBlock(store, pick(blocks).id),
          () => clips.createClip(store, t, int(rows), pick([1, 2, 4, 8] as const)),
          () => clips.repeatClipToBars(store, t, int(rows), pick([2, 4, 8] as const)),
          () => clips.duplicateClipContent(store, t, int(rows)),
          () => clips.deleteClip(store, t, int(rows)),
          () => blocks.length && arr.setBlocksPart(store, blocks.slice(int(blocks.length)).map((b) => b.id), t, pick([null, undefined, pick(p.scenes).id])),
          () => blocks.length && arr.toggleBlockMove(store, pick(blocks).id, pick(['fadeIn', 'fadeOut', 'filterRise', 'echoThrow'] as const)),
          () => blocks.length && arr.splitBlock(store, pick(blocks).id, 1),
          () => blocks.length && arr.shapeBlock(store, pick(blocks).id, pick(['build', 'strip', 'breakdown'] as const)),
          () => arr.addEnding(store),
          () => blocks.length && arr.duplicateBlocks(store, [pick(blocks).id]),
        ];
        const before = store.historySize().undo;
        pick(ops)();
        const now = store.getState();
        if (store.historySize().undo > before) states.push(strip(now));
        const v = validateProject(JSON.parse(JSON.stringify(now)));
        expect(v.ok && v.warnings, `seed ${seed}, step ${i}`).toEqual([]);
        expect(now.tracks.every((x) => x.clips.length === now.scenes.length)).toBe(true);
      }
      for (let k = states.length - 1; k > 0; k--) {
        expect(strip(store.getState())).toEqual(states[k]);
        store.undo();
      }
      expect(strip(store.getState())).toEqual(states[0]);
      for (let k = 1; k < states.length; k++) {
        store.redo();
        expect(strip(store.getState())).toEqual(states[k]);
      }
    }
  });
});
