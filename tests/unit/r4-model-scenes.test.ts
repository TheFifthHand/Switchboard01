/**
 * Scene rows (PLAY-10, capability-08, arrange-only-four-scenes): insert,
 * duplicate, delete (its clips' loops leave the song with it; the UI asks
 * first, counting them with sceneUse), and capture what plays. Each is one
 * undo step, refuses bad input with nothing changed, and is refused while a
 * take records.
 */
import { describe, expect, it } from 'vitest';
import { HOUSE } from '../../src/content/starters/house';
import { createProject } from '../../src/project/factory';
import { MAX_SCENES, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { captureScene, deleteScene, duplicateScene, insertScene, sceneUse, uniqueSceneName } from '../../src/state/commands/scenes';

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
    // The song plays the same clips (loops point at clip ids).
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
  it('takes the loops that play its clips out of the song with it, in one undo step; sceneUse counts them first', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    const lift = before.scenes[2];
    const liftClips = new Set(before.tracks.map((t) => t.clips[2]?.id).filter(Boolean));
    const playing = before.arrangement.regions.filter((r) => liftClips.has(r.clipId)).length;
    expect(playing).toBeGreaterThan(0);
    expect(sceneUse(before, lift.id)).toEqual({ regions: playing });
    const r = deleteScene(store, 2);
    expect(r).toMatchObject({ changed: true, regions: playing });
    const p = store.getState();
    expect(names(p)).toEqual(['Intro', 'Groove', 'Break']);
    expect(p.tracks.every((t) => t.clips.length === 3)).toBe(true);
    expect(row(p, 2)).toEqual(row(before, 3));
    expect(p.arrangement.regions.length).toBe(before.arrangement.regions.length - playing);
    expect(p.arrangement.regions.some((x) => liftClips.has(x.clipId))).toBe(false);
    // Sections are labels: they stay.
    expect(p.arrangement.sections).toEqual(before.arrangement.sections);
    valid(p);
    expect(store.historySize().undo).toBe(1);
    expect(store.undoLabel()).toBe('Delete scene');
    store.undo();
    expect(store.getState().scenes).toEqual(before.scenes);
    expect(store.getState().arrangement).toEqual(before.arrangement);
    expect(store.getState().tracks).toEqual(before.tracks);
  });

  it('deletes a scene the song does not use at once, and never the last scene', () => {
    const store = new ProjectStore(createProject({ now: 0, scenes: ['A', 'B'] }));
    expect(sceneUse(store.getState(), store.getState().scenes[1].id)).toEqual({ regions: 0 });
    expect(deleteScene(store, 1)).toMatchObject({ changed: true, regions: 0 });
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

describe('the take lock', () => {
  it('refuses every scene edit while a performance records, with nothing changed', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    takeLock(store);
    for (const r of [insertScene(store), duplicateScene(store, 0), deleteScene(store, 3), captureScene(store, { t1: 1 })]) {
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
        const regions = p.arrangement.regions;
        const sections = p.arrangement.sections;
        const ops: (() => unknown)[] = [
          () => insertScene(store, int(rows + 1)),
          () => duplicateScene(store, int(rows)),
          () => deleteScene(store, int(rows)),
          () => captureScene(store, Object.fromEntries(p.tracks.map((x) => [x.id, rnd() < 0.5 ? int(rows) : null]))),
          () => clips.createClip(store, t, int(rows), pick([1, 2, 4, 8] as const)),
          () => clips.repeatClipToBars(store, t, int(rows), pick([2, 4, 8] as const)),
          () => clips.duplicateClipContent(store, t, int(rows)),
          () => clips.deleteClip(store, t, int(rows)),
          () => arr.addSceneToSong(store, int(rows), int(80)),
          () => regions.length && arr.moveRegions(store, [pick(regions).id], int(9) - 4),
          () => regions.length && arr.splitRegions(store, [pick(regions).id], int(80)),
          () => sections.length && arr.toggleSectionMove(store, pick(sections).id, pick(['fadeIn', 'fadeOut', 'filterRise', 'echoThrow'] as const)),
          () => sections.length && arr.shapeSection(store, pick(sections).id, pick(['build', 'strip', 'breakdown'] as const)),
          () => arr.addEnding(store),
          () => sections.length && arr.duplicateSection(store, pick(sections).id),
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
