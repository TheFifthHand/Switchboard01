/**
 * The song lane's remembered view settings (this browser only): whether the
 * lane follows the playhead, and whether the Performances panel is open or
 * folded to its one-line bar (until chosen: open only where the window has
 * room to spare). Every storage access is guarded: storage can be missing or
 * throw, and then the default applies.
 */

export const LANE_SETTINGS_KEY = 'switchboard01.songLane';

interface Stored {
  follow?: boolean;
  takesOpen?: boolean;
}

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function read(): Stored {
  try {
    const raw = storage()?.getItem(LANE_SETTINGS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Stored) : {};
  } catch {
    return {};
  }
}

/** Follow the playhead while the song plays (on unless turned off). */
export function readFollow(): boolean {
  return read().follow !== false;
}

export function writeFollow(on: boolean): void {
  try {
    storage()?.setItem(LANE_SETTINGS_KEY, JSON.stringify({ ...read(), follow: on }));
  } catch {
    /* not remembered: storage is full or blocked */
  }
}

/** Whether the Performances panel is open (true), folded to one line (false), or not chosen yet (null). */
export function readTakesOpen(): boolean | null {
  const v = read().takesOpen;
  return typeof v === 'boolean' ? v : null;
}

export function writeTakesOpen(open: boolean): void {
  try {
    storage()?.setItem(LANE_SETTINGS_KEY, JSON.stringify({ ...read(), takesOpen: open }));
  } catch {
    /* not remembered: storage is full or blocked */
  }
}
