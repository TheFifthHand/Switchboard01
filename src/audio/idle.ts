/**
 * Idle-time work queue for preparation that must not block the main thread
 * or the transport (drum voice rendering after Jump In or a kit change).
 *
 * Work runs in slices of at most IDLE_SLICE_MS: requestIdleCallback where
 * the browser has it (with a timeout, so a busy page still makes progress),
 * otherwise setTimeout 0. A task is a function that does one unit of work and
 * says whether more remains; a slice runs units until its budget is used
 * (always at least one, so every slice makes progress). Units are small
 * (one drum voice, ~2-15 ms), so the main thread is never held long.
 */

/** Longest stretch of idle work in one go (ms). */
export const IDLE_SLICE_MS = 8;
/** A busy page still gets a slice this often (ms). */
const IDLE_TIMEOUT_MS = 100;

/** One unit of work; returns true while more remains. */
export type IdleTask = () => boolean;

interface Entry {
  task: IdleTask;
  done: () => void;
}

interface IdleDeadline {
  didTimeout: boolean;
  timeRemaining(): number;
}

type IdleScheduler = (cb: (deadline: IdleDeadline | null) => void) => void;

const queue: Entry[] = [];
let scheduled = false;
let slices = 0;

function defaultScheduler(): IdleScheduler {
  const g = globalThis as unknown as { requestIdleCallback?: (cb: (d: IdleDeadline) => void, opts?: { timeout: number }) => number };
  if (typeof g.requestIdleCallback === 'function') {
    const ric = g.requestIdleCallback.bind(globalThis);
    return (cb) => {
      ric((d) => cb(d), { timeout: IDLE_TIMEOUT_MS });
    };
  }
  return (cb) => {
    setTimeout(() => cb(null), 0);
  };
}

let scheduler: IdleScheduler | null = null;

function schedule(): void {
  if (scheduled || queue.length === 0) return;
  scheduled = true;
  (scheduler ??= defaultScheduler())(runSlice);
}

function runSlice(deadline: IdleDeadline | null): void {
  scheduled = false;
  slices++;
  const start = performance.now();
  const budget = deadline && !deadline.didTimeout ? Math.max(0, Math.min(IDLE_SLICE_MS, deadline.timeRemaining())) : IDLE_SLICE_MS;
  let ran = false;
  while (queue.length > 0) {
    if (ran && performance.now() - start >= budget) break;
    const entry = queue[0];
    let more = false;
    try {
      more = entry.task();
    } catch (err) {
      console.error('Idle preparation failed', err);
      more = false;
    }
    ran = true;
    if (!more) {
      queue.shift();
      entry.done();
    }
  }
  schedule();
}

/** Queue `task` for idle time; the promise resolves when it reports nothing more to do. */
export function runWhenIdle(task: IdleTask): Promise<void> {
  return new Promise<void>((resolve) => {
    queue.push({ task, done: resolve });
    schedule();
  });
}

/** Queue length and slices run so far (tests, diagnostics). */
export function idleStats(): { queued: number; slices: number } {
  return { queued: queue.length, slices };
}
