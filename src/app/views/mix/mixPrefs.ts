/**
 * Viewing preferences of the Mix view, remembered in this browser (never part
 * of the project): the loudness target Match aims for, and whether Advanced
 * strips show each part's sends and effects.
 */
import { useSyncExternalStore } from 'react';
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

interface MixPrefs {
  target: LoudnessTargetId;
  /** Advanced: the strips' Sends and effects row is shown (null: not chosen yet, shown when the window is tall). */
  sends: boolean | null;
}

function read(): MixPrefs {
  const out: MixPrefs = { target: 'streaming', sends: null };
  try {
    const raw = globalThis.localStorage?.getItem(MIX_PREFS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (typeof v === 'object' && v !== null) {
      const { target, sends } = v as { target?: unknown; sends?: unknown };
      if (LOUDNESS_TARGETS.some((t) => t.id === target)) out.target = target as LoudnessTargetId;
      if (typeof sends === 'boolean') out.sends = sends;
    }
  } catch {
    /* storage unavailable or malformed: the defaults */
  }
  return out;
}

const prefs = createStore<MixPrefs>(read());

function save(): void {
  try {
    const s = prefs.getState();
    globalThis.localStorage?.setItem(MIX_PREFS_KEY, JSON.stringify(s.sends === null ? { target: s.target } : s));
  } catch {
    /* not remembered */
  }
}

export function setLoudnessTarget(id: LoudnessTargetId): void {
  if (!LOUDNESS_TARGETS.some((t) => t.id === id)) return;
  prefs.setState((s) => (s.target === id ? s : { ...s, target: id }));
  save();
}

export function loudnessTarget(id: LoudnessTargetId = prefs.getState().target): LoudnessTarget {
  return LOUDNESS_TARGETS.find((t) => t.id === id) ?? LOUDNESS_TARGETS[0];
}

export function useLoudnessTarget(): LoudnessTarget {
  return loudnessTarget(useStore(prefs, (s) => s.target));
}

/** A window this tall has room for the Sends and effects row above full-height faders. */
export const SENDS_ROW_MIN_HEIGHT = 1000;

const tallQuery = (): MediaQueryList | null => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(`(min-height: ${SENDS_ROW_MIN_HEIGHT}px)`) : null);
const isTall = (): boolean => tallQuery()?.matches ?? (typeof window !== 'undefined' && window.innerHeight >= SENDS_ROW_MIN_HEIGHT);
function onTallChange(listener: () => void): () => void {
  const q = tallQuery();
  if (!q) return () => {};
  q.addEventListener('change', listener);
  return () => q.removeEventListener('change', listener);
}

/** Whether Advanced strips show the Sends and effects row: the user's choice, else only on tall windows. */
export function sendsRowShown(): boolean {
  return prefs.getState().sends ?? isTall();
}

/** The same, following the window: until the user chooses, it appears and goes as the window gets taller or shorter. */
export function useSendsRow(): boolean {
  const chosen = useStore(prefs, (s) => s.sends);
  const tall = useSyncExternalStore(onTallChange, isTall, () => false);
  return chosen ?? tall;
}

/** Show or hide the Sends and effects row (remembered); `null` forgets the choice. */
export function setSendsRow(shown: boolean | null): void {
  prefs.setState((s) => (s.sends === shown ? s : { ...s, sends: shown }));
  save();
}
