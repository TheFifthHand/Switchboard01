/** Scene edits. Scenes are clip rows; their count is fixed. */
import type { Id } from '../../project/types';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, cleanName, refuse, run, type CommandResult } from './common';

export function renameScene(store: ProjectStore, sceneId: Id, name: string): CommandResult {
  if (!store.getState().scenes.some((s) => s.id === sceneId)) return NOT_FOUND('scene');
  const n = cleanName(name, 40);
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
