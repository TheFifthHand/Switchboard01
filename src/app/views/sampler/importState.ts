/**
 * Import progress per part, shared by every import control of that part.
 *
 * Kept outside the components so the status survives the editor switching
 * from its drop zone (part without a recording) to the full sampler editor
 * the moment an import turns the part into a sampler, and so a second import
 * cannot start on a part while one is still decoding.
 */
import { createStore } from '../../../state/store';
import type { Id } from '../../../project/types';
import { session } from '../../instance';

export type ImportStatus =
  | { phase: 'idle' }
  | { phase: 'decoding'; fileName: string }
  /** `at`: performance.now() when the import finished. */
  | { phase: 'done'; ok: boolean; message: string; fileName: string; at: number };

const IDLE: ImportStatus = { phase: 'idle' };

export const importStore = createStore<Record<Id, ImportStatus>>({});

// Results belong to the project they happened in: opening another project clears them.
session.store.subscribe((p, prev) => {
  if (p.id !== prev.id && Object.keys(importStore.getState()).length > 0) importStore.setState({});
});

export function importStatusOf(state: Record<Id, ImportStatus>, trackId: Id): ImportStatus {
  return state[trackId] ?? IDLE;
}

function setStatus(trackId: Id, status: ImportStatus): void {
  importStore.setState((s) => ({ ...s, [trackId]: status }));
}

/** Forget a finished result (the message is dismissed). */
export function clearImportStatus(trackId: Id): void {
  const cur = importStore.getState()[trackId];
  if (cur && cur.phase === 'done') setStatus(trackId, IDLE);
}

/**
 * Decode, store and assign a file to a part through the session. The
 * project is untouched when anything fails; the status carries the message.
 */
export async function importFileToPart(file: File, trackId: Id): Promise<{ ok: boolean; message: string }> {
  const cur = importStore.getState()[trackId];
  if (cur?.phase === 'decoding') return { ok: false, message: `Still decoding "${cur.fileName}". Wait for it to finish, then try again.` };
  setStatus(trackId, { phase: 'decoding', fileName: file.name });
  let res: { ok: boolean; message: string };
  try {
    res = await session.importSample(file, trackId);
  } catch (e) {
    res = { ok: false, message: `The recording could not be imported: ${e instanceof Error ? e.message : String(e)}` };
  }
  setStatus(trackId, { phase: 'done', ok: res.ok, message: res.message, fileName: file.name, at: performance.now() });
  return res;
}

/** True when an import onto this part succeeded within the last `ms` milliseconds. */
export function importedRecently(trackId: Id, ms = 3000): boolean {
  const s = importStore.getState()[trackId];
  return !!s && s.phase === 'done' && s.ok && performance.now() - s.at < ms;
}
