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
