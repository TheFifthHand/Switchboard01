/**
 * Autosave: saves the open project shortly after edits.
 *
 * - Debounced (default 800 ms) with a maximum wait so a long knob drag still
 *   saves periodically.
 * - Coalesced: one save at a time; edits made during a save trigger exactly
 *   one follow-up save of the latest state.
 * - Never loses the latest state: if a different project is loaded while
 *   edits are pending, the pending project is still saved.
 * - Failures keep the unsaved state pending and surface a readable message
 *   (quota errors include recovery advice). The next edit or retry() tries again.
 * - Flushes when the page is hidden or unloaded.
 */
import type { Id, Project } from '../project/types';
import type { Listener, ReadableStore } from '../state/store';
import { toStorageError, type StorageErrorKind } from './db';

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface AutosaveState {
  status: AutosaveStatus;
  lastError: { kind: StorageErrorKind; message: string } | null;
  lastSavedAt: number | null;
  /** True while there are edits not yet written. */
  dirty: boolean;
}

export interface Autosaver {
  status: ReadableStore<AutosaveState>;
  /** Save any pending edits now; resolves when the latest state is written (or the save failed). */
  flush(): Promise<void>;
  /** Try again after an error. */
  retry(): Promise<void>;
  /** Treat this exact project state as already saved (e.g. just loaded from storage). */
  markSaved(project: Project): void;
  /**
   * Stop watching the store and the page. Edits that are still pending are
   * written first (the returned promise settles when that attempt is done).
   */
  dispose(): Promise<void>;
}

export interface AutosaveOptions {
  store: ReadableStore<Project>;
  save: (p: Project) => Promise<void>;
  debounceMs?: number;
  /** Longest time edits may wait during continuous editing. */
  maxWaitMs?: number;
  now?: () => number;
  /** Event sources for flush-on-hide; default: document and window when present. */
  events?: { document?: VisibilitySource | null; window?: EventTarget | null };
}

interface VisibilitySource extends EventTarget {
  visibilityState?: string;
}

export const QUOTA_MESSAGE = 'Browser storage is full. Export the project file to keep a copy, then free space by deleting old projects.';

/** Plain-language save failure message with recovery advice. */
export function saveErrorMessage(kind: StorageErrorKind, detail?: string): string {
  switch (kind) {
    case 'quota':
      return QUOTA_MESSAGE;
    case 'unavailable':
      return 'Browser storage is not available here (private browsing or blocked by settings). Export the project file to keep your work.';
    case 'blocked':
      return 'Another SWITCHBOARD tab is holding the storage. Close other tabs, then try again.';
    case 'not-found':
      return 'Saving failed because the project storage changed. Try again, or export the project file to keep a copy.';
    default:
      return `Saving failed${detail ? ` (${detail})` : ''}. Try again, or export the project file to keep a copy.`;
  }
}

/** Minimal observable for the status (kept local so persistence has no runtime dependency on the state layer). */
function observable<T>(initial: T): ReadableStore<T> & { set(next: T): void } {
  let state = initial;
  const listeners = new Set<Listener<T>>();
  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    set(next) {
      const prev = state;
      state = next;
      for (const l of [...listeners]) l(state, prev);
    },
  };
}

export function createAutosaver(opts: AutosaveOptions): Autosaver {
  const debounceMs = opts.debounceMs ?? 800;
  const maxWaitMs = opts.maxWaitMs ?? 5000;
  const now = opts.now ?? Date.now;
  const status = observable<AutosaveState>({ status: 'idle', lastError: null, lastSavedAt: null, dirty: false });

  /** Latest unsaved state per project id (usually one entry). */
  const pending = new Map<Id, Project>();
  /** The last state written (or known to be stored) per project id. */
  const saved = new Map<Id, Project>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAt: number | null = null;
  let inflight: Promise<void> | null = null;
  let disposed = false;

  const update = (patch: Partial<AutosaveState>) => {
    const cur = status.getState();
    if ((Object.keys(patch) as (keyof AutosaveState)[]).some((k) => !Object.is(cur[k], patch[k]))) status.set({ ...cur, ...patch });
  };

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    if (disposed) return;
    const t = now();
    if (firstPendingAt === null) firstPendingAt = t;
    clearTimer();
    const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - t));
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, wait);
  }

  function onChange(project: Project): void {
    if (saved.get(project.id) === project) {
      pending.delete(project.id);
      return;
    }
    pending.set(project.id, project);
    update({ dirty: true });
    schedule();
  }

  /** Write everything pending, one project at a time, until nothing is left (or a save fails). */
  async function drain(): Promise<void> {
    while (pending.size) {
      const [id, project] = pending.entries().next().value as [Id, Project];
      pending.delete(id);
      update({ status: 'saving' });
      try {
        await opts.save(project);
        saved.set(id, project);
        update({ status: 'saved', lastError: null, lastSavedAt: now(), dirty: pending.size > 0 });
      } catch (e) {
        // Keep it pending unless a newer state for the same project arrived meanwhile.
        if (!pending.has(id)) pending.set(id, project);
        const err = toStorageError(e, 'Saving');
        // For unexpected failures show the underlying reason, not our own "... failed:" wrapper.
        const detail = err.cause instanceof Error ? err.cause.message : err.message;
        update({ status: 'error', lastError: { kind: err.kind, message: saveErrorMessage(err.kind, detail) }, dirty: true });
        return;
      }
    }
  }

  function flush(): Promise<void> {
    clearTimer();
    firstPendingAt = null;
    if (inflight) {
      // Coalesce: after the current save, write whatever is pending then.
      return inflight.then(() => (pending.size ? flush() : undefined));
    }
    if (!pending.size) return Promise.resolve();
    inflight = drain().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const unsubscribe = opts.store.subscribe((p) => onChange(p));
  // The store's current state counts as known-saved until it changes.
  saved.set(opts.store.getState().id, opts.store.getState());

  const doc = opts.events?.document !== undefined ? opts.events.document : typeof document !== 'undefined' ? (document as VisibilitySource) : null;
  const win = opts.events?.window !== undefined ? opts.events.window : typeof window !== 'undefined' ? (window as EventTarget) : null;
  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden') void flush();
  };
  const onPageHide = () => void flush();
  doc?.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('pagehide', onPageHide);

  return {
    status: { getState: status.getState, subscribe: status.subscribe },
    flush,
    retry: () => {
      // After an error the state may be pending already; make sure the current state is included.
      const cur = opts.store.getState();
      if (saved.get(cur.id) !== cur) pending.set(cur.id, cur);
      return flush();
    },
    markSaved(project: Project) {
      saved.set(project.id, project);
      if (pending.get(project.id) === project) pending.delete(project.id);
      if (!pending.size) update({ dirty: false });
    },
    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true;
      unsubscribe();
      doc?.removeEventListener('visibilitychange', onVisibility);
      win?.removeEventListener('pagehide', onPageHide);
      // Never drop the latest edits: write what is pending one last time.
      return flush();
    },
  };
}
