/**
 * Rescue copy: the last unsaved state of a project, written synchronously to
 * localStorage when the page is hidden or unloaded (an IndexedDB write
 * started then often never commits). The next time that project is opened
 * (library.openLast / openProject) the copy is taken back when it is newer
 * than the stored project; it is cleared as soon as the project saves.
 *
 * One slot ('switchboard01.rescue'), at most ~2 MB. The stored value is
 * `{"v":1,"id":…,"updatedAt":…,"tab":…,"dbId":…,"project":<project JSON>}`:
 * the project's JSON is embedded as it is (never escaped twice), and the
 * small header in front can be read without parsing the project.
 */
import type { Id } from '../project/types';

export const RESCUE_KEY = 'switchboard01.rescue';
/** Larger projects are not copied (localStorage holds about 5 MB per site). */
export const RESCUE_MAX_CHARS = 2_000_000;
/** The warning openLast / openProject return when they took a rescue copy back. */
export const RESCUE_WARNING = 'Recovered your last edits.';

export interface RescueHeader {
  id: Id;
  /** The project's updatedAt in the copy. */
  updatedAt: number;
  /** The tab that wrote it. */
  tab: string | null;
  /** The database it belongs to (a copy is never taken into another, e.g. after "erase all data"). */
  dbId: string | null;
}

export interface RescueCopy extends RescueHeader {
  /** The project as written (unvalidated). */
  project: unknown;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RescueStore {
  /** Write the copy synchronously. False when skipped: too large, or storage unavailable or full. */
  write(copy: { id: Id; updatedAt: number; json: string; tab?: string | null; dbId?: string | null }): boolean;
  /** The header of the copy there is, without parsing the project. */
  header(): RescueHeader | null;
  /** The whole copy, or null (none, or unreadable: an unreadable copy is removed). */
  read(): RescueCopy | null;
  clear(): void;
  /**
   * Remove the copy if it is for `id` and not newer than `upTo` (and, with
   * `tab`, only one written by that tab). Returns whether it was removed.
   */
  clearIf(id: Id, upTo: number, tab?: string): boolean;
}

const STR = '"(?:[^"\\\\]|\\\\.)*"';
const NUM = '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';
const HEADER = new RegExp(`^\\{"v":1,"id":(${STR}),"updatedAt":(${NUM}),"tab":(null|${STR}),"dbId":(null|${STR}),"project":`);

function parseHeader(raw: string): RescueHeader | null {
  const m = HEADER.exec(raw.slice(0, 1024));
  if (!m) return null;
  try {
    const id = JSON.parse(m[1]) as string;
    const updatedAt = Number(m[2]);
    if (!id || !Number.isFinite(updatedAt)) return null;
    return { id, updatedAt, tab: JSON.parse(m[3]) as string | null, dbId: JSON.parse(m[4]) as string | null };
  } catch {
    return null;
  }
}

/** The page's localStorage, or null where it cannot be used. */
export function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

export function createRescueStore(storage: StorageLike | null | undefined = defaultStorage()): RescueStore | null {
  if (!storage) return null;
  const get = (): string | null => {
    try {
      return storage.getItem(RESCUE_KEY);
    } catch {
      return null;
    }
  };
  const remove = () => {
    try {
      storage.removeItem(RESCUE_KEY);
    } catch {
      // Nothing more to do.
    }
  };
  const store: RescueStore = {
    write({ id, updatedAt, json, tab = null, dbId = null }) {
      if (json.length > RESCUE_MAX_CHARS) return false;
      const value = `{"v":1,"id":${JSON.stringify(id)},"updatedAt":${JSON.stringify(updatedAt)},"tab":${JSON.stringify(tab)},"dbId":${JSON.stringify(dbId)},"project":${json}}`;
      try {
        storage.setItem(RESCUE_KEY, value);
        return true;
      } catch {
        // Full or blocked: an older copy must not stand in for this state.
        remove();
        return false;
      }
    },
    header() {
      const raw = get();
      return raw ? parseHeader(raw) : null;
    },
    read() {
      const raw = get();
      if (!raw) return null;
      const head = parseHeader(raw);
      try {
        const parsed = JSON.parse(raw) as { project?: unknown };
        if (head && parsed && typeof parsed === 'object' && parsed.project && typeof parsed.project === 'object') return { ...head, project: parsed.project };
      } catch {
        // Unreadable (cut off while being written): useless.
      }
      remove();
      return null;
    },
    clear: remove,
    clearIf(id, upTo, tab) {
      const head = store.header();
      if (!head || head.id !== id || head.updatedAt > upTo) return false;
      if (tab !== undefined && head.tab !== tab) return false;
      remove();
      return true;
    },
  };
  return store;
}

let shared: RescueStore | null | undefined;

/** The rescue store over this page's localStorage (null where there is none). */
export function defaultRescueStore(): RescueStore | null {
  if (shared === undefined) shared = createRescueStore();
  return shared;
}
