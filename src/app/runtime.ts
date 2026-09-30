/**
 * Runtime state: what the audio side is doing right now (transport, launcher,
 * recording, audio device status). Not part of the Project and never saved.
 * Updated at musical-event rate (launches, start/stop), never per frame —
 * playheads and meters read the transport/engine directly in rAF loops.
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
  mode: 'live',
  replayId: null,
  songBlock: null,
  tracks: {},
  recording: 'off',
  recordTarget: null,
  countingIn: false,
  stalled: null,
  muteAll: false,
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

export function useRuntime<S>(selector: (s: RuntimeState) => S, equality?: (a: S, b: S) => boolean): S {
  return useStore(runtimeStore, selector, equality);
}
