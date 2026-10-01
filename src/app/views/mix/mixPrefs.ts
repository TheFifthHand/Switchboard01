/**
 * Loudness targets for Match target, and the one the user picked (a viewing
 * preference: remembered in this browser, never part of the project).
 */
import { createStore, useStore } from '../../../state/store';

export type LoudnessTargetId = 'streaming' | 'gentle' | 'loud';

export interface LoudnessTarget {
  id: LoudnessTargetId;
  name: string;
  lufs: number;
  /** One plain sentence about when to use it. */
  description: string;
}

export const LOUDNESS_TARGETS: readonly LoudnessTarget[] = [
  { id: 'streaming', name: 'Streaming', lufs: -14, description: 'The level streaming services play songs at: louder masters are simply turned down.' },
  { id: 'gentle', name: 'Gentle', lufs: -18, description: 'Quieter, with more room for dynamics: good for calm music and listening at home.' },
  { id: 'loud', name: 'Loud', lufs: -9, description: 'Club and party level: dense and loud, with little dynamic range left.' },
];

export const MIX_PREFS_KEY = 'switchboard01.mix';

function readTarget(): LoudnessTargetId {
  try {
    const raw = globalThis.localStorage?.getItem(MIX_PREFS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    const id = typeof v === 'object' && v !== null ? (v as { target?: unknown }).target : undefined;
    if (LOUDNESS_TARGETS.some((t) => t.id === id)) return id as LoudnessTargetId;
  } catch {
    /* storage unavailable or malformed: use the default */
  }
  return 'streaming';
}

const prefs = createStore<{ target: LoudnessTargetId }>({ target: readTarget() });

export function setLoudnessTarget(id: LoudnessTargetId): void {
  if (!LOUDNESS_TARGETS.some((t) => t.id === id)) return;
  prefs.setState((s) => (s.target === id ? s : { ...s, target: id }));
  try {
    globalThis.localStorage?.setItem(MIX_PREFS_KEY, JSON.stringify({ target: id }));
  } catch {
    /* not remembered */
  }
}

export function loudnessTarget(id: LoudnessTargetId = prefs.getState().target): LoudnessTarget {
  return LOUDNESS_TARGETS.find((t) => t.id === id) ?? LOUDNESS_TARGETS[0];
}

export function useLoudnessTarget(): LoudnessTarget {
  return loudnessTarget(useStore(prefs, (s) => s.target));
}
