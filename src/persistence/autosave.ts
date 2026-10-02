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
 *   (quota errors include recovery advice). The next edit or retry() tries
 *   again. `failures` counts failed writes in a row and `firstFailureAt`
 *   says when the run began, so the UI can tell once per run.
 * - One tab per project (see tabLock.ts): only the tab holding the open
 *   project's lock writes it. Another tab is read-only for it
 *   (status.readonly 'other-tab'): its edits stay in memory, pending, and
 *   nothing is written until takeOver() (or retry() once the other tab is
 *   gone). A save refused because another tab changed the stored copy since
 *   this tab loaded it (db 'conflict') makes it read-only too
 *   ('conflict'): load the latest, or keep this state as a copy.
 * - Rescue copy: when the page is hidden or unloaded with edits pending,
 *   the newest pending project is written synchronously to localStorage
 *   (rescue.ts); it is cleared once that project saves.
 * - Versions: after about ten minutes of active editing (time between
 *   saves, idle gaps not counted) a version is kept automatically;
 *   snapshotBefore() keeps one before a bulk edit.
 */
import type { Id, Project } from '../project/types';
import type { Listener, ReadableStore } from '../state/store';
import { openDatabaseId, storedIsNewer, toStorageError, type StorageErrorKind } from './db';
import { RESCUE_MAX_CHARS, defaultRescueStore, type RescueStore } from './rescue';
import { defaultTabCoordinator, type ProjectLock, type TabCoordinator } from './tabLock';
import { reasonBefore, saveVersion } from './versions';

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Why this tab does not write the open project. */
export type AutosaveReadonly = 'other-tab' | 'conflict';

export interface AutosaveState {
  status: AutosaveStatus;
  lastError: { kind: StorageErrorKind; message: string } | null;
  lastSavedAt: number | null;
  /** True while there are edits not yet written. */
  dirty: boolean;
  /**
   * Null while this tab saves the open project. 'other-tab': it is open in
   * another tab, so nothing is written here (takeOver() changes that).
   * 'conflict': another tab saved it after this tab loaded it, so this tab
   * did not write over that. With edits waiting, status is also 'error'
   * with a plain message in lastError.
   */
  readonly?: AutosaveReadonly | null;
  /** Failed writes in a row (storage errors; read-only refusals do not count). 0 again after a save. */
  failures?: number;
  /** When the current run of failures began (null when there is none). */
  firstFailureAt?: number | null;
}

export const IDLE_AUTOSAVE_STATE: AutosaveState = { status: 'idle', lastError: null, lastSavedAt: null, dirty: false, readonly: null, failures: 0, firstFailureAt: null };

export interface Autosaver {
  status: ReadableStore<AutosaveState>;
  /** Save any pending edits now; resolves when the latest state is written (or the save failed or was refused). */
  flush(): Promise<void>;
  /** Try again after an error (and, read-only because of another tab, ask for the project again). */
  retry(): Promise<void>;
  /** Treat this exact project state as already saved (e.g. just loaded from storage). Older pending edits of it are dropped. */
  markSaved(project: Project): void;
  /**
   * Take the open project over from the tab that has it: this tab writes it
   * from now on and the other turns read-only. When that tab saved it after
   * this one loaded it, status.readonly becomes 'conflict' instead and
   * nothing is written (load the latest, or keep this state as a copy).
   */
  takeOver(): Promise<void>;
  /**
   * Keep a version of `project` (the state before a bulk edit; `reason` is
   * the edit, e.g. "Variation"). Skipped while read-only. Never rejects.
   */
  snapshotBefore(project: Project, reason: string): Promise<void>;
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
  /** Tab coordination (one tab per project). Default: this page's; null: none (every write goes ahead). */
  tab?: TabCoordinator | null;
  /** Where the rescue copy goes. Default: localStorage; null: none. */
  rescue?: RescueStore | null;
  /** Where versions go. Default: the version history (versions.ts); null: no versions. */
  versions?: { save(project: Project, opts: { reason: string }): Promise<unknown> } | null;
  /** Active editing time between automatic versions (default 10 minutes). */
  autoVersionMs?: number;
  /** Whether the stored copy is newer than this tab's (checked on takeOver). Default: db.storedIsNewer. */
  isStale?: (id: Id) => Promise<boolean>;
}

interface VisibilitySource extends EventTarget {
  visibilityState?: string;
}

export const QUOTA_MESSAGE = 'Browser storage is full. Export the project file to keep a copy, then free space by deleting old projects.';
export const OTHER_TAB_MESSAGE = 'This project is open in another tab, so changes made here are not saved. Close the other tab and try again, or export the project file to keep a copy.';
export const CONFLICT_SAVE_MESSAGE =
  'This project was changed in another tab after this tab opened it, so the changes made here were not saved over it. Open it again to see the latest, or export the project file to keep this version.';

/** Active editing time between automatic versions. */
export const AUTO_VERSION_MS = 10 * 60 * 1000;
/** A longer pause between saves is not counted as editing. */
const ACTIVE_GAP_MS = 2 * 60 * 1000;
/** Longest wait for an answer about the lock before writing anyway (the stored-version check still guards). */
const LOCK_ANSWER_MS = 5000;

/** Plain-language save failure message with recovery advice. */
export function saveErrorMessage(kind: StorageErrorKind, detail?: string): string {
  switch (kind) {
    case 'quota':
      return QUOTA_MESSAGE;
    case 'unavailable':
      return 'Browser storage is not available here (private browsing or blocked by settings). Export the project file to keep your work.';
    case 'blocked':
      return 'Another Omni Song tab is holding the storage. Close other tabs, then try again.';
    case 'not-found':
      return 'Saving failed because the project storage changed. Try again, or export the project file to keep a copy.';
    case 'conflict':
      return CONFLICT_SAVE_MESSAGE;
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

function sameState(a: AutosaveState, b: AutosaveState): boolean {
  return (
    a.status === b.status &&
    a.lastSavedAt === b.lastSavedAt &&
    a.dirty === b.dirty &&
    a.readonly === b.readonly &&
    a.failures === b.failures &&
    a.firstFailureAt === b.firstFailureAt &&
    (a.lastError === b.lastError || (!!a.lastError && !!b.lastError && a.lastError.kind === b.lastError.kind && a.lastError.message === b.lastError.message))
  );
}

/** Writer id for rescue copies when there is no tab coordinator. */
const LOCAL_TAB_ID = `tab_${Math.random().toString(36).slice(2, 10)}`;

export function createAutosaver(opts: AutosaveOptions): Autosaver {
  const debounceMs = opts.debounceMs ?? 800;
  const maxWaitMs = opts.maxWaitMs ?? 5000;
  const now = opts.now ?? Date.now;
  const tab = opts.tab !== undefined ? opts.tab : defaultTabCoordinator();
  const rescue = opts.rescue !== undefined ? opts.rescue : defaultRescueStore();
  const versions = opts.versions !== undefined ? opts.versions : { save: (p: Project, o: { reason: string }) => saveVersion(p, o) };
  const autoVersionMs = opts.autoVersionMs ?? AUTO_VERSION_MS;
  const isStale = opts.isStale ?? storedIsNewer;
  const tabId = tab?.tabId ?? LOCAL_TAB_ID;
  const status = observable<AutosaveState>({ ...IDLE_AUTOSAVE_STATE });

  /** Latest unsaved state per project id (usually one entry). */
  const pending = new Map<Id, Project>();
  /** The last state written (or known to be stored) per project id. */
  const saved = new Map<Id, Project>();
  /** This tab's lock per project id: the open project's, and those of projects with edits still to write. */
  const locks = new Map<Id, ProjectLock>();
  /** Lock requests that went unanswered for too long (written anyway). */
  const unanswered = new Set<Id>();
  /** Projects another tab changed since this tab loaded them: not written until loaded again. */
  const conflicts = new Set<Id>();
  /** Active editing time per project since its last automatic version. */
  const activity = new Map<Id, { active: number; last: number }>();
  let writing: Project | null = null;
  let phase: AutosaveStatus = 'idle';
  let writeError: AutosaveState['lastError'] = null;
  let lastSavedAt: number | null = null;
  let failures = 0;
  let firstFailureAt: number | null = null;
  let currentId: Id = opts.store.getState().id;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAt: number | null = null;
  let inflight: Promise<void> | null = null;
  let disposed = false;

  function readonlyOf(id: Id): AutosaveReadonly | null {
    if (conflicts.has(id)) return 'conflict';
    return locks.get(id)?.state() === 'other-tab' ? 'other-tab' : null;
  }

  function publish(): void {
    const ro = readonlyOf(currentId);
    const blocked = ro !== null && pending.has(currentId);
    const next: AutosaveState = {
      status: blocked ? 'error' : phase,
      lastError: blocked ? { kind: ro === 'conflict' ? 'conflict' : 'blocked', message: ro === 'conflict' ? CONFLICT_SAVE_MESSAGE : OTHER_TAB_MESSAGE } : writeError,
      lastSavedAt,
      dirty: pending.size > 0 || writing !== null,
      readonly: ro,
      failures,
      firstFailureAt,
    };
    if (!sameState(status.getState(), next)) status.set(next);
  }

  function lockFor(id: Id): ProjectLock | null {
    if (!tab) return null;
    let l = locks.get(id);
    if (!l) {
      l = tab.acquire(id);
      locks.set(id, l);
      l.subscribe((s) => {
        if (disposed) return;
        // Writable again (the other tab let go, or Take over): write what waits.
        if (s === 'held' && pending.has(id)) schedule();
        publish();
      });
    }
    return l;
  }

  /** Whether this tab may write `id` now, must wait for the lock's answer, or must not write it. */
  function access(id: Id, create = true): 'write' | 'wait' | 'refuse' {
    if (conflicts.has(id)) return 'refuse';
    if (!tab) return 'write';
    const l = create ? lockFor(id) : (locks.get(id) ?? null);
    if (!l) return 'refuse';
    const s = l.state();
    if (s === 'held') return 'write';
    if (s === 'pending') return unanswered.has(id) ? 'write' : 'wait';
    return 'refuse';
  }

  function releaseIdle(): void {
    // Edits of a project no longer on screen that this tab may not write (taken over, or changed in
    // another tab meanwhile) cannot be saved from here: they go, so the state does not stay "unsaved".
    for (const id of [...pending.keys()]) if (id !== currentId && writing?.id !== id && access(id, false) === 'refuse') pending.delete(id);
    for (const [id, l] of [...locks]) {
      if (id === currentId || pending.has(id) || writing?.id === id) continue;
      l.release();
      locks.delete(id);
      unanswered.delete(id);
      conflicts.delete(id);
    }
  }

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

  function switchTo(id: Id): void {
    const previous = currentId;
    currentId = id;
    lockFor(id);
    // Edits this tab may not write (another tab has that project, or changed it) leave with it.
    if (previous !== id) releaseIdle();
  }

  function onChange(project: Project): void {
    if (project.id !== currentId) switchTo(project.id);
    if (saved.get(project.id) === project) {
      pending.delete(project.id);
      publish();
      return;
    }
    pending.set(project.id, project);
    publish();
    schedule();
  }

  function afterSave(p: Project): void {
    rescue?.clearIf(p.id, p.updatedAt);
    if (!versions) return;
    const t = now();
    const a = activity.get(p.id);
    if (!a) {
      activity.set(p.id, { active: 0, last: t });
      return;
    }
    const gap = t - a.last;
    if (gap > 0 && gap <= ACTIVE_GAP_MS) a.active += gap;
    a.last = t;
    if (a.active >= autoVersionMs) {
      a.active = 0;
      void versions.save(p, { reason: 'auto' }).catch(() => undefined);
    }
  }

  async function waitForAnswer(l: ProjectLock): Promise<void> {
    let late: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      late = setTimeout(() => {
        if (l.state() === 'pending') unanswered.add(l.id);
        resolve();
      }, LOCK_ANSWER_MS);
    });
    await Promise.race([l.ready().then(() => undefined), timeout]);
    if (late !== null) clearTimeout(late);
  }

  /** Write everything pending that this tab may write, one project at a time, until nothing is left (or a save fails). */
  async function drain(): Promise<void> {
    for (;;) {
      let pick: Project | null = null;
      let waitFor: ProjectLock | null = null;
      for (const [id, p] of pending) {
        const a = access(id);
        if (a === 'write') {
          pick = p;
          break;
        }
        if (a === 'wait' && !waitFor) waitFor = locks.get(id) ?? null;
      }
      if (!pick) {
        if (waitFor) {
          await waitForAnswer(waitFor);
          continue;
        }
        break;
      }
      const project = pick;
      const id = project.id;
      pending.delete(id);
      writing = project;
      phase = 'saving';
      publish();
      try {
        await opts.save(project);
        writing = null;
        saved.set(id, project);
        phase = 'saved';
        writeError = null;
        failures = 0;
        firstFailureAt = null;
        lastSavedAt = now();
        afterSave(project);
        publish();
      } catch (e) {
        writing = null;
        // Keep it pending unless a newer state for the same project arrived meanwhile.
        if (!pending.has(id)) pending.set(id, project);
        const err = toStorageError(e, 'Saving');
        if (err.kind === 'conflict') {
          // Another tab saved it since this tab loaded it: never write over that.
          conflicts.add(id);
          // A rescue copy this tab wrote of it holds the refused edits: it must not come back next time.
          rescue?.clearIf(id, Number.POSITIVE_INFINITY, tabId);
          publish();
          continue;
        }
        // For unexpected failures show the underlying reason, not our own "... failed:" wrapper.
        const detail = err.cause instanceof Error ? err.cause.message : err.message;
        phase = 'error';
        writeError = { kind: err.kind, message: saveErrorMessage(err.kind, detail) };
        failures += 1;
        if (firstFailureAt === null) firstFailureAt = now();
        publish();
        return;
      }
    }
    releaseIdle();
    publish();
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

  /** Page hidden or unloading: copy the newest edits this tab may write to the rescue slot, synchronously. */
  function writeRescue(): void {
    if (!rescue) return;
    let best: Project | null = null;
    for (const p of writing ? [...pending.values(), writing] : pending.values()) {
      if (access(p.id, false) !== 'write') continue;
      if (!best || p.updatedAt > best.updatedAt) best = p;
    }
    if (!best) return;
    let json: string;
    try {
      json = JSON.stringify(best);
    } catch {
      return;
    }
    if (json.length > RESCUE_MAX_CHARS) return;
    rescue.write({ id: best.id, updatedAt: best.updatedAt, json, tab: tabId, dbId: openDatabaseId() });
  }

  const unsubscribe = opts.store.subscribe((p) => onChange(p));
  // The store's current state counts as known-saved until it changes.
  saved.set(currentId, opts.store.getState());
  lockFor(currentId);
  publish();

  const doc = opts.events?.document !== undefined ? opts.events.document : typeof document !== 'undefined' ? (document as VisibilitySource) : null;
  const win = opts.events?.window !== undefined ? opts.events.window : typeof window !== 'undefined' ? (window as EventTarget) : null;
  const onVisibility = () => {
    if (doc?.visibilityState !== 'hidden') return;
    writeRescue();
    void flush();
  };
  const onPageHide = () => {
    writeRescue();
    void flush();
  };
  doc?.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('pagehide', onPageHide);

  return {
    status: { getState: status.getState, subscribe: status.subscribe },
    flush,
    async retry() {
      // After an error the state may be pending already; make sure the current state is included.
      const cur = opts.store.getState();
      if (saved.get(cur.id) !== cur) pending.set(cur.id, cur);
      // Changed in another tab: look again (still newer, and it is refused again).
      conflicts.delete(cur.id);
      const l = locks.get(cur.id);
      if (l?.state() === 'other-tab') await l.retry();
      publish();
      return flush();
    },
    markSaved(project: Project) {
      saved.set(project.id, project);
      // The store shows a stored state now: older pending edits of the same project are obsolete.
      pending.delete(project.id);
      conflicts.delete(project.id);
      // A rescue copy stays until this project is written (or opened again): if the caller's
      // "stored" was optimistic, the copy is what still holds those edits.
      publish();
    },
    async takeOver() {
      if (disposed) return;
      const id = currentId;
      const l = lockFor(id);
      if (l) await l.takeOver();
      if (disposed || id !== currentId) return;
      // The other tab may have saved it since this tab loaded it: never write over that.
      let stale = false;
      try {
        stale = await isStale(id);
      } catch {
        stale = false;
      }
      if (stale) conflicts.add(id);
      publish();
      if (!stale) await flush();
    },
    async snapshotBefore(project: Project, reason: string) {
      if (disposed || !versions) return;
      let a = access(project.id, false);
      if (a === 'wait') {
        const l = locks.get(project.id);
        if (l) await waitForAnswer(l);
        a = access(project.id, false);
      }
      if (a !== 'write') return;
      try {
        await versions.save(project, { reason: reasonBefore(reason) });
      } catch {
        // A safety net only: the edit itself goes ahead.
      }
    },
    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true;
      unsubscribe();
      doc?.removeEventListener('visibilitychange', onVisibility);
      win?.removeEventListener('pagehide', onPageHide);
      // Never drop the latest edits: write what is pending one last time, then let the locks go.
      return flush().then(() => {
        for (const l of locks.values()) l.release();
        locks.clear();
      });
    },
  };
}
