/**
 * One tab per project: a tab writes a project only while it holds that
 * project's lock.
 *
 * - With the Web Locks API (every current browser): the lock is
 *   `navigator.locks` 'switchboard01.project.<id>', requested with
 *   {ifAvailable: true}. A tab that does not get it is read-only for that
 *   project ('other-tab'). Take over requests it with {steal: true}; the tab
 *   it was taken from sees its request end (AbortError) and turns read-only.
 *   Locks go away with the tab, however it closes.
 * - Without Web Locks, a heartbeat on BroadcastChannel('switchboard01') does
 *   the same: a tab asks who holds the project and waits QUERY_MS for an
 *   answer; the holder answers and repeats its claim every HEARTBEAT_MS;
 *   'takeover' messages carry an epoch that beats every older claim.
 *   Take over is posted on the channel in both modes.
 *
 * Within a tab the lock is shared: several handles (an autosaver being
 * replaced and its successor) keep one lock, released when the last handle
 * lets go.
 */
import type { Id } from '../project/types';

export const LOCK_PREFIX = 'switchboard01.project.';
export const CHANNEL_NAME = 'switchboard01';
/** Fallback: how long a tab waits for a holder to answer. */
export const QUERY_MS = 300;
/** Fallback: how often the holder repeats its claim. */
export const HEARTBEAT_MS = 2000;

/** 'pending': still asking; 'held': this tab may write; 'other-tab': another tab has the project open. */
export type TabLockState = 'pending' | 'held' | 'other-tab';

export interface ProjectLock {
  readonly id: Id;
  state(): TabLockState;
  /** Settles once the state is no longer 'pending'. */
  ready(): Promise<TabLockState>;
  subscribe(fn: (state: TabLockState) => void): () => void;
  /** Ask again without taking it (it is free once the other tab closed or moved on). */
  retry(): Promise<TabLockState>;
  /** Take it from the other tab, which turns read-only. */
  takeOver(): Promise<TabLockState>;
  /** Let go of this handle. The tab keeps the lock while another handle uses it. */
  release(): void;
}

export interface TabCoordinator {
  readonly tabId: string;
  acquire(id: Id): ProjectLock;
  /** True when this tab holds the lock for `id`. */
  holds(id: Id): boolean;
  dispose(): void;
}

/** The parts of the Web Locks API used here (tests pass a fake). */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

/** The parts of BroadcastChannel used here. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  close(): void;
}

export interface TabCoordinatorOptions {
  locks?: LockManagerLike | null;
  channel?: ChannelLike | null;
  tabId?: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Message {
  app: typeof CHANNEL_NAME;
  type: 'query' | 'claim' | 'takeover' | 'release';
  id: Id;
  tab: string;
  epoch?: number;
  since?: number;
}

interface Entry {
  id: Id;
  state: TabLockState;
  refs: number;
  listeners: Set<(s: TabLockState) => void>;
  waiters: ((s: TabLockState) => void)[];
  /** Bumped by every request and by the release: a callback of an older request does nothing. */
  gen: number;
  /** Web Locks: lets go of the held lock. */
  drop: (() => void) | null;
  /** Web Locks: settles once the lock this entry asked for is free again. */
  done: Promise<void> | null;
  /** Fallback: claim order (a take over raises the epoch), and whether a holder answered a query. */
  epoch: number;
  maxEpoch: number;
  since: number;
  /** Fallback: a query is waiting for answers, and whether one came. */
  querying: boolean;
  heard: boolean;
  beat: unknown;
}

function randomTabId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `tab_${[...bytes].map((b) => b.toString(36).padStart(2, '0')).join('')}`;
}

function isMessage(m: unknown): m is Message {
  if (!m || typeof m !== 'object') return false;
  const x = m as Partial<Message>;
  return x.app === CHANNEL_NAME && typeof x.id === 'string' && typeof x.tab === 'string' && typeof x.type === 'string';
}

export function createTabCoordinator(opts: TabCoordinatorOptions): TabCoordinator {
  const locks = opts.locks ?? null;
  const channel = opts.channel ?? null;
  const tabId = opts.tabId ?? randomTabId();
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<Id, Entry>();
  /** Locks this tab let go of whose release the browser has not finished yet. */
  const releasing = new Map<Id, Promise<void>>();

  function set(e: Entry, s: TabLockState): void {
    if (e.state === s) return;
    e.state = s;
    if (s !== 'pending') for (const w of e.waiters.splice(0)) w(s);
    for (const l of [...e.listeners]) l(s);
  }

  function post(msg: Omit<Message, 'app' | 'tab'>): void {
    try {
      channel?.postMessage({ app: CHANNEL_NAME, tab: tabId, ...msg });
    } catch {
      // A closed channel: nothing to tell.
    }
  }

  /* ---------- Web Locks ---------- */

  function viaLocks(lm: LockManagerLike, e: Entry, steal: boolean): Promise<TabLockState> {
    const gen = ++e.gen;
    const prior = steal ? undefined : releasing.get(e.id);
    return (prior ?? Promise.resolve()).then(
      () =>
        new Promise<TabLockState>((resolve) => {
          if (gen !== e.gen || e.refs === 0) return resolve(e.state);
          let settle: () => void = () => undefined;
          const held = new Promise<void>((r) => (settle = r));
          let granted = false;
          let request: Promise<unknown>;
          try {
            request = lm.request(LOCK_PREFIX + e.id, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
              // Given up (released, or asked again) meanwhile: let it go at once.
              if (gen !== e.gen || e.refs === 0) {
                resolve(e.state);
                return undefined;
              }
              if (!lock) {
                set(e, 'other-tab');
                resolve('other-tab');
                return undefined;
              }
              granted = true;
              e.drop = settle;
              set(e, 'held');
              resolve('held');
              return held;
            });
          } catch {
            // Web Locks unusable here (e.g. an opaque origin): never lock the user out of saving.
            set(e, 'held');
            return resolve('held');
          }
          e.done = request.then(
            () => resolve(e.state),
            () => {
              if (granted && e.drop === settle) {
                // Taken over by another tab: this one turns read-only.
                e.drop = null;
                settle();
                if (e.refs > 0) set(e, 'other-tab');
              } else if (!granted && gen === e.gen && e.state === 'pending') {
                set(e, 'held');
              }
              resolve(e.state);
            },
          );
        }),
    );
  }

  /* ---------- BroadcastChannel heartbeat (no Web Locks) ---------- */

  function stopBeat(e: Entry): void {
    if (e.beat !== null && e.beat !== undefined) clearTimer(e.beat);
    e.beat = null;
  }

  function claim(e: Entry): void {
    e.since = now();
    set(e, 'held');
    const beat = () => {
      if (e.state !== 'held' || e.refs === 0) return;
      post({ type: 'claim', id: e.id, epoch: e.epoch, since: e.since });
      e.beat = setTimer(beat, HEARTBEAT_MS);
    };
    stopBeat(e);
    beat();
  }

  function lose(e: Entry): void {
    stopBeat(e);
    e.gen++;
    e.querying = false;
    set(e, 'other-tab');
  }

  function viaChannel(e: Entry, steal: boolean): Promise<TabLockState> {
    const gen = ++e.gen;
    e.querying = false;
    if (steal) {
      e.epoch = e.maxEpoch + 1;
      e.maxEpoch = e.epoch;
      post({ type: 'takeover', id: e.id, epoch: e.epoch });
      claim(e);
      return Promise.resolve('held');
    }
    e.heard = false;
    e.querying = true;
    post({ type: 'query', id: e.id });
    return new Promise((resolve) => {
      setTimer(() => {
        if (gen !== e.gen || e.refs === 0) return resolve(e.state);
        e.querying = false;
        if (e.heard) set(e, 'other-tab');
        else {
          e.epoch = e.maxEpoch;
          claim(e);
        }
        resolve(e.state);
      }, QUERY_MS);
    });
  }

  const onMessage = (ev: { data: unknown }) => {
    const m = ev.data;
    if (!isMessage(m) || m.tab === tabId) return;
    const e = entries.get(m.id);
    if (!e) return;
    const epoch = typeof m.epoch === 'number' ? m.epoch : 0;
    if (epoch > e.maxEpoch) e.maxEpoch = epoch;
    // With Web Locks the lock itself decides; the channel only matters without it.
    if (locks) return;
    if (m.type === 'query') {
      if (e.state === 'held') post({ type: 'claim', id: e.id, epoch: e.epoch, since: e.since });
    } else if (m.type === 'claim' || m.type === 'takeover') {
      if (e.querying) e.heard = true;
      else if (e.state === 'held') {
        const since = typeof m.since === 'number' ? m.since : 0;
        const wins = m.type === 'takeover' ? epoch >= e.epoch : epoch > e.epoch || (epoch === e.epoch && (since < e.since || (since === e.since && m.tab < tabId)));
        if (wins) lose(e);
      }
    }
  };
  channel?.addEventListener('message', onMessage);

  function ask(e: Entry, steal: boolean): Promise<TabLockState> {
    if (locks) {
      if (steal) post({ type: 'takeover', id: e.id });
      return viaLocks(locks, e, steal);
    }
    if (channel) return viaChannel(e, steal);
    set(e, 'held');
    return Promise.resolve('held');
  }

  function letGo(e: Entry): void {
    e.gen++;
    stopBeat(e);
    if (e.drop) {
      const d = e.drop;
      e.drop = null;
      d();
    }
    if (e.state === 'held') post({ type: 'release', id: e.id });
    entries.delete(e.id);
    const done = e.done;
    if (done) {
      releasing.set(e.id, done);
      void done.then(() => {
        if (releasing.get(e.id) === done) releasing.delete(e.id);
      });
    }
    for (const w of e.waiters.splice(0)) w(e.state);
    e.listeners.clear();
  }

  return {
    tabId,
    acquire(id) {
      let e = entries.get(id);
      if (!e) {
        e = { id, state: 'pending', refs: 0, listeners: new Set(), waiters: [], gen: 0, drop: null, done: null, epoch: 0, maxEpoch: 0, since: 0, querying: false, heard: false, beat: null };
        entries.set(id, e);
        e.refs = 1;
        void ask(e, false);
      } else e.refs += 1;
      const entry = e;
      const mine = new Set<(s: TabLockState) => void>();
      let released = false;
      return {
        id,
        state: () => entry.state,
        ready: () => (entry.state !== 'pending' ? Promise.resolve(entry.state) : new Promise<TabLockState>((r) => entry.waiters.push(r))),
        subscribe(fn) {
          if (released) return () => undefined;
          mine.add(fn);
          entry.listeners.add(fn);
          return () => {
            mine.delete(fn);
            entry.listeners.delete(fn);
          };
        },
        retry: () => (released || entry.state === 'held' ? Promise.resolve(entry.state) : ask(entry, false)),
        takeOver: () => (released || entry.state === 'held' ? Promise.resolve(entry.state) : ask(entry, true)),
        release() {
          if (released) return;
          released = true;
          for (const fn of mine) entry.listeners.delete(fn);
          mine.clear();
          entry.refs -= 1;
          if (entry.refs <= 0 && entries.get(id) === entry) letGo(entry);
        },
      };
    },
    holds: (id) => entries.get(id)?.state === 'held',
    dispose() {
      for (const e of [...entries.values()]) letGo(e);
      channel?.removeEventListener('message', onMessage);
    },
  };
}

/* ------------------------------------------------------------------ */
/* This page's coordinator                                             */
/* ------------------------------------------------------------------ */

function pageLocks(): LockManagerLike | null {
  try {
    const l = (globalThis.navigator as (Navigator & { locks?: LockManagerLike }) | undefined)?.locks;
    return l && typeof l.request === 'function' ? l : null;
  } catch {
    return null;
  }
}

let shared: TabCoordinator | null | undefined;

/**
 * The coordinator for this page: Web Locks, plus BroadcastChannel for Take
 * over notes (and as the fallback). Null where neither exists: then every
 * tab writes, and the stored-version check in db.saveProject still refuses
 * to write over newer work.
 */
export function defaultTabCoordinator(): TabCoordinator | null {
  if (shared !== undefined) return shared;
  const locks = pageLocks();
  let channel: ChannelLike | null = null;
  try {
    if (typeof BroadcastChannel === 'function') {
      const bc = new BroadcastChannel(CHANNEL_NAME) as BroadcastChannel & { unref?: () => void };
      // Node (unit tests) keeps a process alive for an open channel unless told not to.
      bc.unref?.();
      channel = bc as unknown as ChannelLike;
    }
  } catch {
    channel = null;
  }
  shared = locks || channel ? createTabCoordinator({ locks, channel }) : null;
  return shared;
}

/**
 * Whether no tab holds the project's lock, waiting up to `waitMs` for a tab
 * that is just closing (a reload) to let go. False when this page or a
 * living tab has the project open. True where Web Locks do not exist.
 */
export async function projectLockFree(id: Id, waitMs = 1500, lm: LockManagerLike | null = pageLocks()): Promise<boolean> {
  if (!lm) return true;
  if (shared?.holds(id)) return false;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), waitMs) : null;
  try {
    await lm.request(LOCK_PREFIX + id, ctrl ? { signal: ctrl.signal } : { ifAvailable: true }, (lock) => {
      if (!lock) throw new DOMException('held', 'AbortError');
      return undefined;
    });
    return true;
  } catch (e) {
    return !(e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError');
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
