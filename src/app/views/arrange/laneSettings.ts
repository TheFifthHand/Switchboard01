/**
 * The Song view's remembered settings (this browser only): whether the
 * timeline follows the playhead, the zoom of each project's song, whether
 * the loop browser and the Performances panel are open or folded (until
 * chosen: the loop browser opens by itself while the song is empty or
 * small, the Performances panel stays folded). Every storage access is
 * guarded: storage can be missing or throw, and then the default applies.
 */

export const LANE_SETTINGS_KEY = 'switchboard01.songLane';
/** Projects whose zoom is remembered (the most recently zoomed ones). */
export const REMEMBERED_ZOOMS = 30;

interface Stored {
  follow?: boolean;
  takesOpen?: boolean;
  browserOpen?: boolean;
  /** Pixels per bar per project id, oldest first. */
  zoom?: Record<string, number>;
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
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Stored) : {};
  } catch {
    return {};
  }
}

function write(patch: Partial<Stored>): void {
  try {
    storage()?.setItem(LANE_SETTINGS_KEY, JSON.stringify({ ...read(), ...patch }));
  } catch {
    /* not remembered: storage is full or blocked */
  }
}

/** Follow the playhead while the song plays (on unless turned off). */
export function readFollow(): boolean {
  return read().follow !== false;
}

export function writeFollow(on: boolean): void {
  write({ follow: on });
}

/** Whether the Performances panel is open (true), folded to one line (false), or not chosen yet (null). */
export function readTakesOpen(): boolean | null {
  const v = read().takesOpen;
  return typeof v === 'boolean' ? v : null;
}

export function writeTakesOpen(open: boolean): void {
  write({ takesOpen: open });
}

/** Whether the loop browser is open (true), hidden (false), or not chosen yet (null: open while the song is empty or small). */
export function readBrowserOpen(): boolean | null {
  const v = read().browserOpen;
  return typeof v === 'boolean' ? v : null;
}

export function writeBrowserOpen(open: boolean): void {
  write({ browserOpen: open });
}

/** The zoom (pixels per bar) last used for a project's song, or null (fit the song). */
export function readZoom(projectId: string): number | null {
  const v = read().zoom?.[projectId];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Remember a project's zoom (null forgets it). Only the most recent REMEMBERED_ZOOMS projects are kept. */
export function writeZoom(projectId: string, pxPerBar: number | null): void {
  const zoom = { ...(read().zoom ?? {}) };
  delete zoom[projectId];
  if (pxPerBar !== null && Number.isFinite(pxPerBar) && pxPerBar > 0) zoom[projectId] = pxPerBar;
  const keys = Object.keys(zoom);
  for (const k of keys.slice(0, Math.max(0, keys.length - REMEMBERED_ZOOMS))) delete zoom[k];
  write({ zoom });
}
