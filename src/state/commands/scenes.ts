/**
 * Scene edits. Scenes are clip rows: scene i is slot i of every part, so a
 * row's clips move, copy and go with it. A project has MIN_SCENES to
 * MAX_SCENES scenes (schema v3). Song blocks point at scenes by id, so adding,
 * moving or copying a row never changes what the song plays.
 */
import { blockParts } from '../../project/arrangement';
import { cloneClipWithNewIds } from '../../project/clone';
import { uid } from '../../project/factory';
import { MAX_SCENES, MIN_SCENES, type Clip, type Id, type Project, type Scene } from '../../project/types';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, cleanName, refuse, run, type CommandResult } from './common';

/** Longest scene name, in characters. */
export const MAX_SCENE_NAME = 40;

const FULL_MESSAGE = `A project holds up to ${MAX_SCENES} scenes. Delete one first.`;

export function renameScene(store: ProjectStore, sceneId: Id, name: string): CommandResult {
  if (!store.getState().scenes.some((s) => s.id === sceneId)) return NOT_FOUND('scene');
  const n = cleanName(name, MAX_SCENE_NAME);
  if (!n) return refuse('invalid', 'A scene needs a name.');
  return run(store, 'scene:Rename scene', (d) => {
    const s = d.scenes.find((x) => x.id === sceneId);
    if (s) s.name = n;
  });
}

/** Move one item of an array from `from` to `to` (the others close up / make room). */
function moveItem<T>(list: T[], from: number, to: number): void {
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

/**
 * Reorder the scene rows: the scene at `fromRow` moves to `toRow` and every
 * part's clip in that row moves with it, in one undo step. Song blocks point
 * at scenes by id, so the song keeps playing the same music.
 */
export function moveScene(store: ProjectStore, fromRow: number, toRow: number): CommandResult {
  const p = store.getState();
  const rows = p.scenes.length;
  if (!Number.isInteger(fromRow) || fromRow < 0 || fromRow >= rows) return NOT_FOUND('scene');
  if (!Number.isInteger(toRow) || toRow < 0 || toRow >= rows) return refuse('invalid', 'There is no scene row there.');
  if (fromRow === toRow) return { changed: false };
  return run(store, 'scene:Move scene', (d) => {
    moveItem(d.scenes, fromRow, toRow);
    for (const t of d.tracks) moveItem(t.clips, fromRow, toRow);
  });
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * A scene name not used yet, from `base`: "Groove" → "Groove 2" (or "Groove 3"
 * when that exists); "Groove 2" → "Groove 3". Pure. With `allowBase`, `base`
 * itself is returned when it is free.
 */
export function uniqueSceneName(p: Pick<Project, 'scenes'>, base: string, allowBase = false): string {
  const taken = new Set(p.scenes.map((s) => s.name.toLowerCase()));
  const clean = cleanName(base, MAX_SCENE_NAME) ?? 'Scene';
  if (allowBase && !taken.has(clean.toLowerCase())) return clean;
  const m = /^(.*\S)\s+(\d+)$/.exec(clean);
  const stem = m ? m[1] : clean;
  for (let n = m ? Number(m[2]) + 1 : 2; ; n++) {
    const suffix = ` ${n}`;
    const name = `${stem.slice(0, MAX_SCENE_NAME - suffix.length)}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** "Scene 5" for a new fifth row, or the next free "Scene N". */
function newSceneName(p: Pick<Project, 'scenes'>, row: number): string {
  return uniqueSceneName(p, `Scene ${row + 1}`, true);
}

/** Insert a scene row at `row` in a draft: `clips[i]` goes to part i (empty when missing). */
function insertRow(d: Project, row: number, scene: Scene, clips: readonly (Clip | null)[]): void {
  d.scenes.splice(row, 0, scene);
  d.tracks.forEach((t, i) => {
    t.clips.splice(row, 0, clips[i] ?? null);
  });
}

export interface SceneResult extends CommandResult {
  sceneId?: Id;
  /** Row of the new scene. */
  row?: number;
}

/* ------------------------------------------------------------------ */
/* Insert, duplicate, capture, make from a block                       */
/* ------------------------------------------------------------------ */

/**
 * Insert an empty scene row at `at` (0 = before the first row, the scene
 * count = after the last; default: the end), in one undo step. Every part
 * gets an empty slot there; the rows after it move down one (song blocks keep
 * playing the same scenes).
 */
export function insertScene(store: ProjectStore, at?: number, name?: string): SceneResult {
  const p = store.getState();
  const rows = p.scenes.length;
  if (rows >= MAX_SCENES) return refuse('limit', FULL_MESSAGE);
  const row = at === undefined ? rows : at;
  if (!Number.isInteger(row) || row < 0 || row > rows) return refuse('invalid', 'There is no scene row there.');
  const given = name !== undefined ? cleanName(name, MAX_SCENE_NAME) : null;
  const scene: Scene = { id: uid('scene'), name: given ?? newSceneName(p, row) };
  const r = run(store, 'scene:Add scene', (d) => insertRow(d, row, scene, []));
  return { ...r, sceneId: scene.id, row };
}

/**
 * Copy a scene row just below itself: every clip is copied (new ids, the same
 * notes and recordings), and the copy is named like "Groove 2". One undo step.
 */
export function duplicateScene(store: ProjectStore, row: number): SceneResult {
  const p = store.getState();
  const src = Number.isInteger(row) ? p.scenes[row] : undefined;
  if (!src) return NOT_FOUND('scene');
  if (p.scenes.length >= MAX_SCENES) return refuse('limit', FULL_MESSAGE);
  const scene: Scene = { id: uid('scene'), name: uniqueSceneName(p, src.name) };
  const clips = p.tracks.map((t) => {
    const c = t.clips[row];
    return c ? cloneClipWithNewIds(c) : null;
  });
  const r = run(store, 'scene:Duplicate scene', (d) => insertRow(d, row + 1, scene, clips));
  return { ...r, sceneId: scene.id, row: row + 1 };
}

/**
 * Capture clips into a new last scene (one undo step): for each part listed
 * in `slots`, a copy of its clip in that slot (the Play view passes what is
 * playing now; null, an unlisted part or an empty slot leaves the part's new
 * slot empty).
 */
export function captureScene(store: ProjectStore, slots: Readonly<Record<Id, number | null>>, name?: string): SceneResult {
  const p = store.getState();
  if (p.scenes.length >= MAX_SCENES) return refuse('limit', FULL_MESSAGE);
  const clips = p.tracks.map((t) => {
    const slot = slots[t.id];
    const clip = typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 ? t.clips[slot] : null;
    return clip ? cloneClipWithNewIds(clip) : null;
  });
  if (clips.every((c) => c === null)) return refuse('empty', 'Nothing is playing, so there is nothing to capture into a scene.');
  const row = p.scenes.length;
  const given = name !== undefined ? cleanName(name, MAX_SCENE_NAME) : null;
  const scene: Scene = { id: uid('scene'), name: given ?? newSceneName(p, row) };
  const r = run(store, 'scene:Capture scene', (d) => insertRow(d, row, scene, clips));
  return { ...r, sceneId: scene.id, row };
}

/**
 * "Make a scene from this block": a new last scene holding a copy of the clip
 * every part plays in the block (its scene's clip, a clip layered in from
 * another scene, nothing for a part switched off), named after the block
 * ("Drop" for a block called Drop, else like "Groove 2"). The block then
 * plays the new scene with no part changes, so it sounds the same, and its
 * parts can be edited as one scene in Play. One undo step.
 */
export function sceneFromBlock(store: ProjectStore, blockId: Id): SceneResult {
  const p = store.getState();
  const b = p.arrangement.blocks.find((x) => x.id === blockId);
  if (!b) return NOT_FOUND('block');
  const own = p.scenes.find((s) => s.id === b.sceneId);
  if (!own) return refuse('invalid', 'The scene this block played was deleted.');
  if (p.scenes.length >= MAX_SCENES) return refuse('limit', FULL_MESSAGE);
  const parts = blockParts(p, b);
  if (parts.every((x) => x.clip === null)) return refuse('empty', 'No part plays in this block, so there is nothing to make a scene of.');
  const clips = parts.map((x) => (x.clip ? cloneClipWithNewIds(x.clip) : null));
  const row = p.scenes.length;
  const scene: Scene = { id: uid('scene'), name: uniqueSceneName(p, b.label || own.name, !!b.label) };
  const r = run(store, 'scene:Make a scene from a block', (d) => {
    insertRow(d, row, scene, clips);
    const x = d.arrangement.blocks.find((y) => y.id === blockId);
    if (!x) return;
    x.sceneId = scene.id;
    delete x.parts;
  });
  return { ...r, sceneId: scene.id, row };
}

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */

export interface DeleteSceneResult extends CommandResult {
  /** Song blocks that play the scene (the delete is refused without `removeBlocks`; with it they are removed). */
  blocksUsing?: Id[];
  /** Song blocks that layer one of its clips into another scene (their part change is cleared). */
  blocksLayering?: Id[];
}

/** The song blocks that play a scene, and those that layer one of its clips in (pure). */
export function sceneUse(p: Project, sceneId: Id): { blocksUsing: Id[]; blocksLayering: Id[] } {
  const blocksUsing: Id[] = [];
  const blocksLayering: Id[] = [];
  for (const b of p.arrangement.blocks) {
    if (b.sceneId === sceneId) blocksUsing.push(b.id);
    else if (b.parts && Object.values(b.parts).includes(sceneId)) blocksLayering.push(b.id);
  }
  return { blocksUsing, blocksLayering };
}

/**
 * Delete a scene row and its clips (one undo step). The last scene cannot be
 * deleted. When song blocks play the scene, or layer one of its clips in, the
 * delete is refused and says so (`blocksUsing`, `blocksLayering`), unless
 * `removeBlocks`: then the blocks that play it leave the song and the part
 * changes that layered it in are cleared (those parts follow their block's
 * scene again).
 */
export function deleteScene(store: ProjectStore, row: number, opts: { removeBlocks?: boolean } = {}): DeleteSceneResult {
  const p = store.getState();
  const scene = Number.isInteger(row) ? p.scenes[row] : undefined;
  if (!scene) return NOT_FOUND('scene');
  if (p.scenes.length <= MIN_SCENES) return refuse('invalid', 'A project needs at least one scene.');
  const use = sceneUse(p, scene.id);
  const n = use.blocksUsing.length;
  const m = use.blocksLayering.length;
  if ((n || m) && !opts.removeBlocks) {
    const plays = n ? `${n === 1 ? '1 song block plays' : `${n} song blocks play`} it` : '';
    const layers = m ? `${m === 1 ? '1 block layers' : `${m} blocks layer`} one of its clips in` : '';
    const what = [plays, layers].filter(Boolean).join(' and ');
    const fix = n ? 'Delete those blocks with it' : 'Delete it and those parts follow their own scene';
    return { ...refuse('in-use', `${scene.name} is in the song: ${what}. ${fix}, or change the song first.`), ...use };
  }
  const gone = new Set(use.blocksUsing);
  const r = run(store, 'scene:Delete scene', (d) => {
    d.scenes.splice(row, 1);
    for (const t of d.tracks) t.clips.splice(row, 1);
    if (gone.size) d.arrangement.blocks = d.arrangement.blocks.filter((b) => !gone.has(b.id));
    for (const b of d.arrangement.blocks) {
      if (!b.parts || !Object.values(b.parts).includes(scene.id)) continue;
      for (const k of Object.keys(b.parts)) if (b.parts[k] === scene.id) delete b.parts[k];
      if (!Object.keys(b.parts).length) delete b.parts;
    }
  });
  return { ...r, ...use };
}
