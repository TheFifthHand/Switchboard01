/**
 * Shared state and helpers for the Steps editor: the bar clipboard, note
 * audition, keyboard gesture bursts and the playhead.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { TICKS_PER_BAR, TICKS_PER_STEP, type Id, type Note } from '../../../project/types';
import { createStore, useStore } from '../../../state/store';
import { newGestureId, useRafLoop } from '../../../ui/components';
import { session } from '../../instance';
import { runtimeStore, useRuntime } from '../../runtime';

/* ------------------------------------------------------------------ */
/* Bar clipboard                                                       */
/* ------------------------------------------------------------------ */

export interface BarClipboard {
  /** Drum hits and melodic notes do not mix: pitches mean different things. */
  kind: 'drums' | 'melodic';
  /** Ticks relative to the bar start. */
  notes: Omit<Note, 'id'>[];
  /** "Drums · Four Floor, bar 2" */
  source: string;
}

/** Copied bar, shared by every part of the same kind (kept for the session, never saved). */
export const barClipboard = createStore<BarClipboard | null>(null);

export function useBarClipboard(): BarClipboard | null {
  return useStore(barClipboard, (s) => s);
}

/* ------------------------------------------------------------------ */
/* Audition                                                            */
/* ------------------------------------------------------------------ */

/** Minimum time an auditioned note sounds, so a quick click is still heard. */
export const AUDITION_MIN_MS = 140;

/** True when playing a note now would be written into the clip (Record Notes on this part). */
function recordingInto(trackId: Id): boolean {
  const s = runtimeStore.getState();
  return s.recording === 'notes' && s.recordTarget?.trackId === trackId;
}

export interface Audition {
  /** Stop the note (not before AUDITION_MIN_MS after it started). */
  release(): void;
}

const NO_AUDITION: Audition = { release() {} };

/**
 * Let the user hear a note they just placed. It plays through the part like a
 * pad (Musical Assist applies to melodic notes). Skipped while Record Notes
 * writes into this part, so an edit is never recorded twice.
 */
export function audition(trackId: Id, pitch: number, velocity: number): Audition {
  if (recordingInto(trackId)) return NO_AUDITION;
  session.noteOn(trackId, pitch, velocity, 'pad');
  const started = performance.now();
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      const left = AUDITION_MIN_MS - (performance.now() - started);
      if (left > 0) window.setTimeout(() => session.noteOff(trackId, pitch, 'pad'), left);
      else session.noteOff(trackId, pitch, 'pad');
    },
  };
}

/** A short audition that releases itself (keyboard entry). */
export function auditionBlip(trackId: Id, pitch: number, velocity: number): void {
  audition(trackId, pitch, velocity).release();
}

/* ------------------------------------------------------------------ */
/* Keyboard bursts                                                     */
/* ------------------------------------------------------------------ */

const BURST_IDLE_MS = 700;

/**
 * One gesture id for a burst of key presses on the same target, so holding
 * or tapping Up five times is one undo step.
 */
export function useKeyBurst(): (target: string) => string {
  const ref = useRef<{ target: string; gesture: string; at: number } | null>(null);
  return (target: string) => {
    const now = performance.now();
    const cur = ref.current;
    if (cur && cur.target === target && now - cur.at < BURST_IDLE_MS) {
      cur.at = now;
      return cur.gesture;
    }
    session.store.endGesture();
    const gesture = newGestureId('steps-key');
    ref.current = { target, gesture, at: now };
    return gesture;
  };
}

/* ------------------------------------------------------------------ */
/* Playhead                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where the edited clip is playing now: its page and step, or null when it is
 * not sounding. Reads the transport directly (call it from a frame loop).
 */
export function clipPlayPosition(trackId: Id, slot: number, bars: number): { page: number; step: number } | null {
  const transport = session.transport;
  const seq = session.sequencer;
  if (!transport || !seq) return null;
  const pos = transport.getPosition();
  if (!pos.playing) return null;
  const st = seq.getTrackState(trackId).playing;
  if (!st || st.slot !== slot) return null;
  const rel = pos.tick - st.startTick;
  if (rel < 0) return null;
  const len = bars * TICKS_PER_BAR;
  const r = rel % len;
  return { page: Math.floor(r / TICKS_PER_BAR), step: Math.floor((r % TICKS_PER_BAR) / TICKS_PER_STEP) };
}

/** True while the edited clip is the one playing on its part. */
export function useClipPlaying(trackId: Id, slot: number): boolean {
  return useRuntime((s) => s.playing && s.tracks[trackId]?.playingSlot === slot);
}

/**
 * Light the current step while the edited clip plays. Elements marked
 * `data-ph-step="<n>"` get `data-playhead` on the current step of the shown
 * page; elements marked `data-ph-page="<n>"` get `data-live` for the page
 * that is sounding. DOM attributes only — no React state per frame.
 */
export function usePlayhead(rootRef: RefObject<HTMLElement | null>, trackId: Id, slot: number, bars: number, page: number): void {
  const active = useClipPlaying(trackId, slot);
  const shown = useRef({ step: -2, page: -2 });

  // Any render may have replaced marked elements: re-apply on the next frame.
  useEffect(() => {
    shown.current = { step: -2, page: -2 };
  });

  const apply = (step: number, livePage: number) => {
    const root = rootRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll('[data-playhead]')) el.removeAttribute('data-playhead');
    for (const el of root.querySelectorAll('[data-live]')) el.removeAttribute('data-live');
    if (livePage < 0) return;
    for (const el of root.querySelectorAll(`[data-ph-page="${livePage}"]`)) el.setAttribute('data-live', '');
    if (livePage === page && step >= 0) for (const el of root.querySelectorAll(`[data-ph-step="${step}"]`)) el.setAttribute('data-playhead', '');
  };

  useRafLoop(() => {
    const pos = clipPlayPosition(trackId, slot, bars);
    const step = pos ? pos.step : -1;
    const livePage = pos ? pos.page : -1;
    const s = shown.current;
    if (s.step === step && s.page === livePage) return;
    shown.current = { step, page: livePage };
    apply(step, livePage);
  }, active);

  useEffect(() => {
    if (active) return;
    shown.current = { step: -2, page: -2 };
    apply(-1, -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, page]);
}
