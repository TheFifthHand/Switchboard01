/**
 * Shared state and helpers for the Steps editor: the bar and note clipboards,
 * the note selection, note audition, keyboard gesture bursts and the
 * playhead (with Follow).
 */
import { useEffect, useRef, type RefObject } from 'react';
import { TICKS_PER_BAR, TICKS_PER_STEP, type Id, type Note } from '../../../project/types';
import type { ClipPhase } from '../../../time/contracts';
import { setStepPage } from '../../../state/uiStore';
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
/* Note clipboard and selection (piano roll)                           */
/* ------------------------------------------------------------------ */

/** Copied notes (Ctrl+C in the roll): ticks relative to the earliest one. Session only. */
export const noteClipboard = createStore<{ notes: Omit<Note, 'id'>[]; source: string } | null>(null);

/**
 * The roll's selected notes, for one clip at a time (`key` names the part,
 * slot and clip). Ids that no longer exist are simply not found; opening
 * another clip starts with nothing selected. Session only, never saved.
 */
export const noteSelection = createStore<{ key: string; ids: readonly Id[] }>({ key: '', ids: [] });

const NONE: readonly Id[] = [];

export function selectionKey(trackId: Id, slot: number, clipId: Id): string {
  return `${trackId}|${slot}|${clipId}`;
}

/** The selected ids of the clip `key` (empty for any other clip). */
export function selectedIdsFor(key: string): readonly Id[] {
  const s = noteSelection.getState();
  return s.key === key ? s.ids : NONE;
}

export function useSelectedIds(key: string): readonly Id[] {
  return useStore(noteSelection, (s) => (s.key === key ? s.ids : NONE));
}

export function setSelectedIds(key: string, ids: readonly Id[]): void {
  const s = noteSelection.getState();
  if (s.key === key && s.ids.length === ids.length && s.ids.every((id, i) => id === ids[i])) return;
  noteSelection.setState({ key, ids: [...new Set(ids)] });
}

/* ------------------------------------------------------------------ */
/* Audition                                                            */
/* ------------------------------------------------------------------ */

/** Minimum time an auditioned note sounds, so a quick click is still heard. */
export const AUDITION_MIN_MS = 140;

/**
 * True when a preview must stay silent: Record Notes on this part would
 * write it into the clip, and a performance take would miss it (previews are
 * never recorded, so its replay and export could not match what was heard).
 * A replay pauses live notes anyway.
 */
function previewBlocked(trackId: Id): boolean {
  const s = runtimeStore.getState();
  return s.recording === 'performance' || s.replayId !== null || (s.recording === 'notes' && s.recordTarget?.trackId === trackId);
}

export interface Audition {
  /** Stop the note (not before AUDITION_MIN_MS after it started). */
  release(): void;
}

const NO_AUDITION: Audition = { release() {} };

/**
 * Let the user hear a note they just placed, at exactly its pitch (a preview:
 * no Musical Assist, no arpeggiator, never recorded). It stays silent while
 * a take records, or Record Notes records this part (see previewBlocked).
 */
export function audition(trackId: Id, pitch: number, velocity: number): Audition {
  if (previewBlocked(trackId)) return NO_AUDITION;
  session.noteOn(trackId, pitch, velocity, 'preview');
  const started = performance.now();
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      const left = AUDITION_MIN_MS - (performance.now() - started);
      if (left > 0) window.setTimeout(() => session.noteOff(trackId, pitch, 'preview'), left);
      else session.noteOff(trackId, pitch, 'preview');
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

const phase: ClipPhase = { slot: 0, startTick: 0, lengthTicks: 0 };

/**
 * Where the edited clip is heard now: its page and cell (of `cellTicks`
 * ticks; 1/16 steps by default), or null when it is not sounding. Reads the
 * transport's audible position (the audio clock minus the output latency),
 * so the light matches the sound. Allocation-free: call it from a frame loop.
 */
export function clipPlayPosition(trackId: Id, slot: number, bars: number, cellTicks = TICKS_PER_STEP): { page: number; step: number } | null {
  const transport = session.transport;
  if (!transport) return null;
  const ph = transport.clipPhase(trackId, phase);
  if (!ph || ph.slot !== slot) return null;
  const rel = transport.audibleTick() - ph.startTick;
  if (rel < 0) return null;
  const len = ph.lengthTicks > 0 ? ph.lengthTicks : bars * TICKS_PER_BAR;
  const r = rel % len;
  return { page: Math.floor(r / TICKS_PER_BAR), step: Math.floor((r % TICKS_PER_BAR) / cellTicks) };
}

/** True while the edited clip is the one playing on its part. */
export function useClipPlaying(trackId: Id, slot: number): boolean {
  return useRuntime((s) => (s.playing || s.paused) && s.tracks[trackId]?.playingSlot === slot);
}

export interface PlayheadOptions {
  /** Ticks per lit cell (the roll's grid; default a 1/16 step). */
  cellTicks?: number;
  /** Turn the shown page with the playhead (Follow), except while a pointer is pressed in the editor. */
  follow?: boolean;
}

/**
 * Light the current step while the edited clip plays. Elements marked
 * `data-ph-step="<n>"` get `data-playhead` on the current cell of the shown
 * page; elements marked `data-ph-page="<n>"` get `data-live` for the page
 * that is heard. DOM attributes only — no React state per frame. With
 * `follow`, the frame loop also turns the shown page when the heard page
 * changes, unless a pointer gesture is under way in the editor.
 */
export function usePlayhead(rootRef: RefObject<HTMLElement | null>, trackId: Id, slot: number, bars: number, page: number, options: PlayheadOptions = {}): void {
  const { cellTicks = TICKS_PER_STEP, follow = false } = options;
  const active = useClipPlaying(trackId, slot);
  const shown = useRef({ step: -2, page: -2 });
  const lastLive = useRef(-1);
  const pressed = useRef(new Set<number>());

  // Any render may have replaced marked elements: re-apply on the next frame.
  useEffect(() => {
    shown.current = { step: -2, page: -2 };
  });

  // A pointer pressed anywhere in the editor holds Follow back (a drag must not have the page turned under it).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const set = pressed.current;
    const down = (e: PointerEvent) => set.add(e.pointerId);
    const up = (e: PointerEvent) => set.delete(e.pointerId);
    const clear = () => set.clear();
    root.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', clear);
    return () => {
      root.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', clear);
      set.clear();
    };
  }, [rootRef]);

  // Follow on: the next frame shows the page that is heard.
  useEffect(() => {
    lastLive.current = -1;
  }, [follow, trackId, slot]);

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
    const pos = clipPlayPosition(trackId, slot, bars, cellTicks);
    const step = pos ? pos.step : -1;
    const livePage = pos ? pos.page : -1;
    if (follow && livePage >= 0 && livePage !== lastLive.current && pressed.current.size === 0) {
      lastLive.current = livePage;
      if (livePage !== page) setStepPage(trackId, livePage);
    }
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
