/**
 * Scene edits. Scenes are clip rows: scene i is slot i of every part, so a
 * row's clips move, copy and go with it. A project has MIN_SCENES to
 * MAX_SCENES scenes (schema v3). The song's regions point at clips by id, so
 * adding, moving or copying a row never changes what the song plays; deleting
 * one takes its clips' regions out of the song (see keepSongWithClips).
 */
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
 * part's clip in that row moves with it, in one undo step. The song's regions
 * point at clips by id, so the song keeps playing the same music.
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
/* Insert, duplicate, capture                                          */
/* ------------------------------------------------------------------ */

/**
 * Insert an empty scene row at `at` (0 = before the first row, the scene
 * count = after the last; default: the end), in one undo step. Every part
 * gets an empty slot there; the rows after it move down one (the song keeps
 * playing the same clips).
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

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */

export interface DeleteSceneResult extends CommandResult {
  /** Song regions that played the scene's clips and left the song with it. */
  regions?: number;
}

/** What uses a scene (pure): how many song regions play one of its clips (0 for an unknown scene). */
export function sceneUse(p: Project, sceneId: Id): { regions: number } {
  const row = p.scenes.findIndex((s) => s.id === sceneId);
  const clips = new Set<Id>();
  if (row >= 0) for (const t of p.tracks) if (t.clips[row]) clips.add(t.clips[row]!.id);
  return { regions: p.arrangement.regions.filter((r) => clips.has(r.clipId)).length };
}

/**
 * Delete a scene row and its clips (one undo step). The last scene cannot be
 * deleted. The song regions that play its clips leave the song in the same
 * step (`regions`: how many; the UI asks first, see sceneUse), so Undo
 * brings both back.
 */
export function deleteScene(store: ProjectStore, row: number): DeleteSceneResult {
  const p = store.getState();
  const scene = Number.isInteger(row) ? p.scenes[row] : undefined;
  if (!scene) return NOT_FOUND('scene');
  if (p.scenes.length <= MIN_SCENES) return refuse('invalid', 'A project needs at least one scene.');
  const use = sceneUse(p, scene.id);
  const r = run(store, 'scene:Delete scene', (d) => {
    d.scenes.splice(row, 1);
    for (const t of d.tracks) t.clips.splice(row, 1);
  });
  return { ...r, regions: r.changed ? use.regions : 0 };
}
