/**
 * "Try this" hints: what has been offered, done and hidden. Remembered in
 * localStorage (every access guarded: storage can be missing or throw), never
 * part of the project and never undoable.
 *
 * - `started`: hints were offered (for the first project, or "Show hints
 *   again" in Help or the Project library).
 * - `song`: the song track was offered (Arrange opened while hints run); its
 *   steps come first from then on.
 * - `hidden`: the person closed them; they stay closed until shown again.
 * - `done`: steps done by doing them, or passed over with "Next hint".
 * - `finished`: the closing message was dismissed.
 */
import { createStore, type Store } from '../../../state/store';
import type { KeyValueStorage } from '../../../state/uiStore';

export const HINTS_STORAGE_KEY = 'omnisong.hints';

/** The basics track, then the song track (see steps.ts). */
export const HINT_IDS = ['pad', 'mute', 'drag', 'tone', 'instrument', 'master', 'record', 'song-play', 'song-repeats', 'song-part', 'song-export'] as const;
export type HintId = (typeof HINT_IDS)[number];

export interface HintsState {
  started: boolean;
  hidden: boolean;
  done: readonly HintId[];
  finished: boolean;
  /** The song track was offered (Arrange opened while the hints ran). Absent in older stored state: no. */
  song?: boolean;
}

export const INITIAL_HINTS: HintsState = { started: false, hidden: false, done: [], finished: false, song: false };

function defaultStorage(): KeyValueStorage | null {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Remembered state, ignoring anything malformed. */
export function readHints(storage: KeyValueStorage | null): HintsState {
  if (!storage) return INITIAL_HINTS;
  try {
    const raw = storage.getItem(HINTS_STORAGE_KEY);
    if (!raw) return INITIAL_HINTS;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return INITIAL_HINTS;
    const o = v as Record<string, unknown>;
    const done = Array.isArray(o.done) ? HINT_IDS.filter((id) => (o.done as unknown[]).includes(id)) : [];
    return { started: o.started === true, hidden: o.hidden === true, done, finished: o.finished === true, song: o.song === true };
  } catch {
    return INITIAL_HINTS;
  }
}

export type HintsStore = Store<HintsState>;

export function createHintsStore(storage: KeyValueStorage | null = defaultStorage()): HintsStore {
  const store = createStore<HintsState>(readHints(storage));
  if (storage) {
    store.subscribe((s) => {
      try {
        storage.setItem(HINTS_STORAGE_KEY, JSON.stringify(s));
      } catch {
        // Storage full or blocked: hints simply start over next time.
      }
    });
  }
  return store;
}

/** The app's hints store. */
export const hintsStore: HintsStore = createHintsStore();

/** Offer hints (for the first project: Jump In, a starter, Blank, Just look around). Does nothing once they were offered, hidden or finished. */
export function startHints(store: HintsStore = hintsStore): void {
  store.setState((s) => (s.started ? s : { ...s, started: true }));
}

/** A step was done (or passed over with "Next hint"). */
export function markHintDone(id: HintId, store: HintsStore = hintsStore): void {
  store.setState((s) => (s.done.includes(id) ? s : { ...s, done: HINT_IDS.filter((x) => x === id || s.done.includes(x)) }));
}

/** Close the hints until "Show hints again". */
export function hideHints(store: HintsStore = hintsStore): void {
  store.setState((s) => (s.hidden ? s : { ...s, hidden: true }));
}

/** The closing message was dismissed: the hints are over. */
export function finishHints(store: HintsStore = hintsStore): void {
  store.setState((s) => (s.finished ? s : { ...s, finished: true }));
}

/** Arrange opened while the hints run: the song track becomes current (once). */
export function startSongHints(store: HintsStore = hintsStore): void {
  store.setState((s) => (s.song || !hintsRunning(s) ? s : { ...s, song: true }));
}

/** Start the hints again from the first step. */
export function showHintsAgain(store: HintsStore = hintsStore): void {
  store.setState({ started: true, hidden: false, done: [], finished: false, song: false });
}

/**
 * Exports that finished in this page (a WAV was made): the song track's
 * "Export a WAV" step is done by the next one. The shell counts them.
 */
export const exportsDone = createStore<number>(0);

export function noteExportDone(store: Store<number> = exportsDone): void {
  store.setState((n) => n + 1);
}

/** True while the hints have something to show (whether or not they are on screen right now). */
export function hintsRunning(s: HintsState): boolean {
  return s.started && !s.hidden && !s.finished;
}
