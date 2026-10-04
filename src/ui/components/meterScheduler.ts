/**
 * One animation-frame loop for every Meter on screen.
 *
 * Each meter registers a task. The loop reads every source each frame (at most ~70 times a second:
 * the engine's analysers hold about 21 ms of audio, so no peak falls between two reads), runs the
 * ballistics, and draws at most 30 times a second, only what changed. Each meter draws into its own
 * small canvas, so a draw changes nothing in the page's paint or layer tree (no layout, no paint of
 * other elements, no re-layerization); only the clip lamp, the peak number and the aria values are
 * DOM writes, and those change rarely.
 *
 * The loop sleeps once every meter shows its floor (no level, no held peak, no clip lamp) and
 * nothing has called `meterWake()` for METER_SLEEP_AFTER_MS: a stopped, silent app then runs no
 * meter frames at all. It wakes on `meterWake()` (call it when playback starts, a note or a
 * preview plays, or audio input is opened), on any key or pointer press (they are what starts
 * sound when nothing plays), when the tab becomes visible, and, as a safety net for sound that
 * starts on its own (a MIDI note, a song coming out of a silent bar), from a slow timer that peeks
 * at every source while asleep (no animation frames).
 *
 * Display only: nothing here times audio.
 */

export interface MeterTask {
  /**
   * One frame: read the source and advance the ballistics; when `write` is true, update the DOM.
   * Returns true while the meter still has something to show or to settle (a level above the
   * floor, a held peak, a lit clip lamp, a readout not yet written).
   */
  frame(now: number, dt: number, write: boolean): boolean;
  /** While the loop sleeps: true when the source is above the floor (the loop then wakes). */
  probe(): boolean;
}

/** DOM writes happen at most this often (30 Hz). */
export const METER_WRITE_INTERVAL_MS = 1000 / 30;
/** The loop keeps running at least this long after the last wake-up. */
export const METER_SLEEP_AFTER_MS = 500;
/** While asleep, sources are peeked at this often (a timer, not animation frames). */
export const METER_PROBE_INTERVAL_MS = 125;
/** Frames closer together than this are skipped (fast displays): reads stay at most ~70 per second. */
const MIN_FRAME_MS = 14;

const tasks = new Set<MeterTask>();
let raf = 0;
let probeTimer: number | undefined;
let lastFrame = 0;
let lastWrite = -Infinity;
let wokeAt = -Infinity;
let listening = false;

const hidden = () => typeof document !== 'undefined' && document.hidden;

function clearProbe(): void {
  if (probeTimer !== undefined) window.clearTimeout(probeTimer);
  probeTimer = undefined;
}

function run(): void {
  if (raf || tasks.size === 0 || hidden()) return;
  clearProbe();
  // The first frame after a wake-up always runs.
  lastFrame = performance.now() - MIN_FRAME_MS;
  raf = requestAnimationFrame(frame);
}

function sleep(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  clearProbe();
  if (tasks.size === 0) return;
  const peek = () => {
    probeTimer = undefined;
    if (tasks.size === 0) return;
    if (!hidden()) {
      for (const t of tasks) {
        if (t.probe()) {
          meterWake();
          return;
        }
      }
    }
    probeTimer = window.setTimeout(peek, METER_PROBE_INTERVAL_MS);
  };
  probeTimer = window.setTimeout(peek, METER_PROBE_INTERVAL_MS);
}

function frame(now: number): void {
  raf = 0;
  if (tasks.size === 0) return;
  if (now - lastFrame < MIN_FRAME_MS) {
    raf = requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(0.25, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const write = now - lastWrite >= METER_WRITE_INTERVAL_MS - 2;
  if (write) lastWrite = now;
  let busy = false;
  for (const t of tasks) if (t.frame(now, dt, write)) busy = true;
  // Sleep only right after a write, so what is on screen is the floor.
  if (busy || !write || now - wokeAt < METER_SLEEP_AFTER_MS) raf = requestAnimationFrame(frame);
  else sleep();
}

function onVisibility(): void {
  if (hidden()) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearProbe();
  } else meterWake();
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pointerdown', meterWake, { capture: true, passive: true });
  window.addEventListener('keydown', meterWake, { capture: true, passive: true });
}

function unlisten(): void {
  if (!listening) return;
  listening = false;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pointerdown', meterWake, { capture: true });
  window.removeEventListener('keydown', meterWake, { capture: true });
}

/**
 * Wake every meter now and keep them running for at least METER_SLEEP_AFTER_MS. Cheap; call it
 * whenever sound may start: playback, a note-on, a preview, opening audio input.
 */
export function meterWake(): void {
  wokeAt = performance.now();
  run();
}

/** Register a meter's task (it runs from the next frame); returns the unregister function. */
export function addMeterTask(task: MeterTask): () => void {
  tasks.add(task);
  listen();
  meterWake();
  return () => {
    tasks.delete(task);
    if (tasks.size > 0) return;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearProbe();
    unlisten();
  };
}

/** For tests: whether the loop is running animation frames right now. */
export function metersAwake(): boolean {
  return raf !== 0;
}
