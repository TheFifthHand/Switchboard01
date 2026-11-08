/**
 * What the tip line remembers about each project (Simple), so its next step
 * does not go back when the Song screen is closed and opened again (a sheet,
 * Recorded takes) or the app comes back another day:
 *
 * - a loop of it was opened in the editor (a ready-made song's "click any
 *   loop" step is done), for this visit of the app;
 * - its repeat was switched off (Jump In's "hear the whole song" step is
 *   done), for this visit of the app;
 * - it was shared (a music file or the project saved from Share), kept on
 *   this device, so the tip line goes on to ideas of what to do next.
 *
 * Every storage access is guarded: without storage the tip line just forgets.
 */
import type { Id } from '../../../project/types';
import { createStore } from '../../../state/store';

export interface TipMemory {
  opened: ReadonlySet<Id>;
  heardWhole: ReadonlySet<Id>;
  shared: ReadonlySet<Id>;
  /** Which "what next" idea to offer (the tip line's Another idea counts it up). */
  idea: number;
}

export const SHARED_SONGS_KEY = 'switchboard01.sharedSongs';
/** How many shared projects the device remembers (the oldest are forgotten first). */
const SHARED_KEEP = 200;

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readShared(): Set<Id> {
  try {
    const raw = storage()?.getItem(SHARED_SONGS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeShared(ids: ReadonlySet<Id>): void {
  try {
    storage()?.setItem(SHARED_SONGS_KEY, JSON.stringify([...ids].slice(-SHARED_KEEP)));
  } catch {
    /* not remembered: storage is full or blocked */
  }
}

export const tipMemoryStore = createStore<TipMemory>({ opened: new Set(), heardWhole: new Set(), shared: readShared(), idea: 0 });

function add(key: 'opened' | 'heardWhole' | 'shared', id: Id): void {
  const m = tipMemoryStore.getState();
  if (m[key].has(id)) return;
  const next = new Set(m[key]);
  next.add(id);
  tipMemoryStore.setState({ ...m, [key]: next });
  if (key === 'shared') writeShared(next);
}

/** A loop of project `id` was opened in the editor. */
export function noteLoopOpened(id: Id): void {
  add('opened', id);
}

/** Project `id`'s repeat was switched off: the person heard (or can hear) the whole song. */
export function noteHeardWhole(id: Id): void {
  add('heardWhole', id);
}

/** Project `id` was shared from Share (a music file or the project file). */
export function noteShared(id: Id): void {
  add('shared', id);
}

/** The tip line's next idea. */
export function nextIdea(): void {
  const m = tipMemoryStore.getState();
  tipMemoryStore.setState({ ...m, idea: m.idea + 1 });
}

/** For tests: forget everything (the device's list of shared projects too). */
export function resetTipMemory(): void {
  try {
    storage()?.removeItem(SHARED_SONGS_KEY);
  } catch {
    /* nothing stored */
  }
  tipMemoryStore.setState({ opened: new Set(), heardWhole: new Set(), shared: new Set(), idea: 0 });
}
