/**
 * Hear a loop before it is used (the Song view's loop library, "Start from
 * a beat…"): its notes play once on a part's own instrument, timed on the
 * audio clock like the sequencer's notes, never by a UI timer.
 *
 * One preview at a time: starting another stops the first, and so does
 * anything that takes over the sound (Play, a pad, Stop, Mute All, the
 * window losing focus). A small look-ahead loop hands the engine the notes
 * due in the next moment (as the transport does), so a long loop does not
 * hold every voice at once; the times themselves come from the audio
 * context's clock, fixed when the preview starts.
 *
 * The preview starts at once (a short lead so the first note is not late).
 * It is not offered while the song or the pads play: the UI says so.
 */
import { createStore, useStore } from '../state/store';
import type { VoiceHandle } from '../audio/contracts';
import { swingWarp, ticksToSeconds } from '../time/clock';
import { TICKS_PER_BAR, type Id } from '../project/types';
import { meterWake } from '../ui/components/meterScheduler';
import { session } from './instance';
import { runtimeStore } from './runtime';

/** A note of a previewed loop (ticks from the loop's start). */
export interface PreviewNote {
  tick: number;
  pitch: number;
  velocity: number;
  duration: number;
}

/** What plays now: `key` names it for the UI (a library loop's id). Times are audio-context seconds. */
export interface PreviewState {
  key: string;
  trackId: Id;
  start: number;
  end: number;
}

/** Seconds between pressing ▶ and the first note (the first note is never late). */
export const PREVIEW_LEAD_S = 0.06;
/** How far ahead the engine is handed notes (s). */
const AHEAD_S = 0.2;
/** How often the look-ahead loop runs (ms). It times nothing itself. */
const POLL_MS = 25;

export const previewStore = createStore<PreviewState | null>(null);

/** The key of the preview playing now (null: none). */
export function usePreviewKey(): string | null {
  return useStore(previewStore, (s) => s?.key ?? null);
}

interface Pending {
  time: number;
  pitch: number;
  velocity: number;
  duration: number;
}

let queue: Pending[] = [];
let next = 0;
let voices: VoiceHandle[] = [];
let timer = 0;
let unhook: (() => void) | null = null;
/** Bumped by every start and stop: a start still waiting for the audio to start gives up when it changed. */
let generation = 0;

function pump(): void {
  const s = previewStore.getState();
  const engine = session.engine;
  const ctx = session.ctx;
  if (!s || !engine || !ctx) {
    stopPreview();
    return;
  }
  if (typeof document !== 'undefined' && document.hidden) {
    // Timers slow down in a hidden tab: stop rather than play late.
    stopPreview();
    return;
  }
  const now = ctx.currentTime;
  const until = now + AHEAD_S;
  while (next < queue.length && queue[next].time < until) {
    const n = queue[next++];
    const h = engine.scheduleNote(s.trackId, { pitch: n.pitch, velocity: n.velocity, time: n.time, duration: n.duration });
    if (h) voices.push(h);
  }
  voices = voices.filter((v) => !v.ended);
  if (next >= queue.length && now >= s.end) finish();
}

function finish(): void {
  if (timer) window.clearInterval(timer);
  timer = 0;
  unhook?.();
  unhook = null;
  queue = [];
  next = 0;
  voices = [];
  previewStore.setState(null);
}

/**
 * Play `notes` (one pass of a loop `bars` long) on part `trackId` from now,
 * at the project's tempo and swing. Resolves true once it is playing (false:
 * no sound could start, or another preview or a stop came first).
 */
export async function startPreview(key: string, trackId: Id, notes: readonly PreviewNote[], bars: number): Promise<boolean> {
  stopPreview();
  const mine = ++generation;
  const ok = await session.startAudio();
  if (!ok || mine !== generation) return false;
  const engine = session.engine;
  const ctx = session.ctx;
  if (!engine || !ctx) return false;
  const p = session.store.getState();
  if (!p.tracks.some((t) => t.id === trackId)) return false;
  session.transport?.restoreSongGain();
  meterWake();
  const start = ctx.currentTime + PREVIEW_LEAD_S;
  const at = (tick: number) => start + ticksToSeconds(swingWarp(tick, p.swing), p.bpm);
  const length = Math.max(1, bars) * TICKS_PER_BAR;
  queue = notes
    .filter((n) => Number.isFinite(n.tick) && n.tick >= 0 && n.tick < length)
    .map((n) => ({ time: at(n.tick), pitch: n.pitch, velocity: n.velocity, duration: ticksToSeconds(Math.max(1, n.duration), p.bpm) }))
    .sort((a, b) => a.time - b.time);
  next = 0;
  voices = [];
  const end = Math.max(at(length), ...queue.map((n) => n.time + n.duration));
  previewStore.setState({ key, trackId, start, end });
  // Anything else that makes or stops sound ends the preview.
  const offRelease = session.onAllNotesReleased(() => stopPreview());
  const offRuntime = runtimeStore.subscribe((s, prev) => {
    if ((s.playing && !prev.playing) || (s.muteAll && !prev.muteAll) || s.recording !== prev.recording) stopPreview();
  });
  unhook = () => {
    offRelease();
    offRuntime();
  };
  pump();
  if (previewStore.getState()?.key === key) timer = window.setInterval(pump, POLL_MS);
  return previewStore.getState()?.key === key;
}

/** Stop the preview now: notes sounding end with their release, notes not started yet never sound. */
export function stopPreview(): void {
  generation++;
  if (!previewStore.getState() && !timer) return;
  const now = session.ctx?.currentTime ?? 0;
  for (const v of voices) {
    if (v.ended) continue;
    if (v.startTime > now) v.cancel();
    else if (v.stop) v.stop(now);
    else v.release(now);
  }
  finish();
}
