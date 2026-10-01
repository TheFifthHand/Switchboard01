/**
 * Runtime state: what the audio side is doing right now (transport, launcher,
 * recording, audio device status). Not part of the Project and never saved.
 * Updated at musical-event rate (launches, start/stop), never per frame —
 * playheads and meters read the transport/engine directly in rAF loops.
 *
 * Also the offline readiness of the installed app (fed by pwa.ts), kept here
 * so views can show it without loading the service-worker module.
 */
import { createStore, useStore, shallowEqual } from '../state/store';
import type { Id } from '../project/types';

export type AudioStatus = 'off' | 'starting' | 'running' | 'suspended' | 'error';

export interface TrackRuntime {
  /** Slot currently sounding, or null. */
  playingSlot: number | null;
  /** Pending change at the next bar: a slot, or null meaning "stop". */
  queued: { slot: number | null; atTick: number } | null;
}

export type PlayMode = 'live' | 'song' | 'replay';
export type RecordingState = 'off' | 'notes' | 'performance';

export interface RuntimeState {
  audio: AudioStatus;
  audioMessage: string | null;
  playing: boolean;
  /**
   * Holding at a pause (`playing` is false): the position, the mode (live pads,
   * song or replay) and every playing clip's phase are kept for Play.
   */
  paused: boolean;
  mode: PlayMode;
  replayId: Id | null;
  songBlock: number | null;
  tracks: Record<Id, TrackRuntime>;
  recording: RecordingState;
  /** Clip that Record Notes writes into. */
  recordTarget: { trackId: Id; slot: number } | null;
  /** Waiting for the count-in bar before recording starts. */
  countingIn: boolean;
  /** Transport stopped itself because scheduling could not keep up (background tab, device). */
  stalled: string | null;
  muteAll: boolean;
  /** The open project is the Jump In starter shown as a preview: not stored until it is changed. */
  preview: boolean;
  /** Notes currently held per track (keyboard/pad highlighting). */
  held: Record<Id, readonly number[]>;
  /** One-line status message shown in the transport (e.g. "Variation: 5 notes changed"). */
  notice: { id: number; text: string; tone: 'info' | 'warn' | 'error'; action?: 'undo' } | null;
}

export const EMPTY_TRACK_RUNTIME: TrackRuntime = { playingSlot: null, queued: null };

export const runtimeStore = createStore<RuntimeState>({
  audio: 'off',
  audioMessage: null,
  playing: false,
  paused: false,
  mode: 'live',
  replayId: null,
  songBlock: null,
  tracks: {},
  recording: 'off',
  recordTarget: null,
  countingIn: false,
  stalled: null,
  muteAll: false,
  preview: false,
  held: {},
  notice: null,
});

export function patchRuntime(partial: Partial<RuntimeState>): void {
  runtimeStore.setState((s) => ({ ...s, ...partial }));
}

export function setTrackRuntime(trackId: Id, tr: TrackRuntime): void {
  runtimeStore.setState((s) => {
    const cur = s.tracks[trackId];
    if (cur && cur.playingSlot === tr.playingSlot && shallowEqual(cur.queued, tr.queued)) return s;
    return { ...s, tracks: { ...s.tracks, [trackId]: tr } };
  });
}

let noticeCounter = 0;
export function notify(text: string, tone: 'info' | 'warn' | 'error' = 'info', action?: 'undo'): void {
  noticeCounter += 1;
  patchRuntime({ notice: { id: noticeCounter, text, tone, action } });
}

/** The transport's state in one word, as the transport shows it. */
export type TransportWord = 'Playing' | 'Paused' | 'Stopped' | 'Song' | 'Replay';

export function transportWord(s: Pick<RuntimeState, 'playing' | 'paused' | 'mode'>): TransportWord {
  if (s.paused) return 'Paused';
  if (!s.playing) return 'Stopped';
  return s.mode === 'song' ? 'Song' : s.mode === 'replay' ? 'Replay' : 'Playing';
}

export function useRuntime<S>(selector: (s: RuntimeState) => S, equality?: (a: S, b: S) => boolean): S {
  return useStore(runtimeStore, selector, equality);
}

/* ------------------------------------------------------------------ */
/* Offline readiness (service worker)                                  */
/* ------------------------------------------------------------------ */

export type OfflineState = 'unsupported' | 'installing' | 'ready' | 'update-ready' | 'error';

/** `apply` installs a waiting new version (the page reloads); set only in 'update-ready'. */
export const offlineStore = createStore<{ state: OfflineState; apply: (() => void) | null }>({ state: 'unsupported', apply: null });

export function useOffline() {
  return useStore(offlineStore, (s) => s);
}
