/**
 * A/B: hear the mix without mastering, then with it again.
 *
 * Listening only: the session bypasses the mastering chain in the live
 * engine (Session.setMasteringListen). The project never changes, so there
 * is no undo step, Redo survives, the take lock does not apply, and saved
 * projects and exports always keep their mastering. Loading another project
 * ends the comparison.
 *
 * Level-matched: the engine plays the un-mastered sound at the loudness the
 * mastered one had over the last 3 seconds (MeterFrame.compareTrimDb, measured
 * once as the comparison starts), so the comparison is about tone and punch,
 * not volume. The readings taken meanwhile are of the comparison, so its end
 * restarts the loudness measurement.
 */
import { createStore, useStore } from '../../../state/store';
import { session } from '../../instance';
import { STOPPED_COMPARE, loudnessChanged, matchState, stopMatch } from './loudnessMatch';

export type CompareMode = 'off' | 'held' | 'latched';

export interface CompareState {
  mode: CompareMode;
  /** Kept for the panel's state shape; listening-only A/B never has to wait. */
  waiting: boolean;
}

const compareStore = createStore<CompareState>({ mode: 'off', waiting: false });

/** Project the comparison started in. */
let engagedIn: string | null = null;
let unwatch: (() => void) | null = null;

function set(next: Partial<CompareState>): void {
  compareStore.setState((s) => {
    const merged = { ...s, ...next };
    return merged.mode === s.mode && merged.waiting === s.waiting ? s : merged;
  });
}

function finish(): void {
  engagedIn = null;
  unwatch?.();
  unwatch = null;
  session.setMasteringListen(false);
  set({ mode: 'off', waiting: false });
  // What was measured meanwhile was the comparison: measure the mastered mix again.
  loudnessChanged('compare');
}

/** Start hearing without mastering. False when there is nothing to compare (mastering is off). */
export function engageCompare(mode: Exclude<CompareMode, 'off'>): boolean {
  const state = compareStore.getState();
  if (state.mode !== 'off') {
    set({ mode });
    return true;
  }
  const p = session.store.getState();
  if (!p.mastering.enabled) return false;
  engagedIn = p.id;
  // Match acts on readings of the mastered sound: the comparison ends it, and says so.
  if (matchState().matching) stopMatch(STOPPED_COMPARE);
  session.setMasteringListen(true);
  // Another project, or mastering switched off meanwhile, ends the comparison.
  unwatch = session.store.subscribe((next) => {
    if (engagedIn !== null && (next.id !== engagedIn || !next.mastering.enabled)) finish();
  });
  set({ mode, waiting: false });
  return true;
}

/** Hear the mastering again (no-op when not engaged). */
export function releaseCompare(): void {
  if (compareStore.getState().mode === 'off') return;
  finish();
}

export function compareState(): CompareState {
  return compareStore.getState();
}

export function useCompare(): CompareState {
  return useStore(compareStore, (s) => s);
}
