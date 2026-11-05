/**
 * The view each project was last in (Play, Shape, Song, Mix), remembered on
 * this device so that opening a project from My projects lands where the
 * person left it, as the app itself reopens in the view it was left in. A
 * project with nothing remembered (an imported file, a new starter) opens in
 * the view on screen. Every storage access is guarded (storage can be
 * missing, full or blocked); never part of the project, never undoable.
 */
import type { View } from '../state/uiStore';

export const PROJECT_VIEWS_KEY = 'switchboard01.projectViews';
/** Only the most recent projects are kept. */
const MAX_PROJECTS = 60;
const VIEWS: readonly View[] = ['play', 'shape', 'arrange', 'mix'];

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function read(s: Storage | null): [string, View][] {
  try {
    const raw = s?.getItem(PROJECT_VIEWS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is [string, View] => Array.isArray(e) && typeof e[0] === 'string' && VIEWS.includes(e[1] as View));
  } catch {
    return [];
  }
}

/** Remember `view` as the one project `id` was last in (the newest first). */
export function rememberProjectView(id: string, view: View, s: Storage | null = storage()): void {
  if (!s || !VIEWS.includes(view)) return;
  const list = read(s).filter(([pid]) => pid !== id);
  list.unshift([id, view]);
  try {
    s.setItem(PROJECT_VIEWS_KEY, JSON.stringify(list.slice(0, MAX_PROJECTS)));
  } catch {
    /* not remembered: storage is full or blocked */
  }
}

/** The view project `id` was last in, or null when none is remembered. */
export function projectView(id: string, s: Storage | null = storage()): View | null {
  return read(s).find(([pid]) => pid === id)?.[1] ?? null;
}
