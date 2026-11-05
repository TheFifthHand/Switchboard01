/**
 * Test doubles for the persist tests: a Web Locks manager shared by several
 * simulated tabs (ifAvailable, steal, waiting with an abort signal), a
 * BroadcastChannel hub, an in-memory localStorage, and an in-memory "disk"
 * that refuses stale writes the way db.saveProject does.
 */
import { CONFLICT_MESSAGE, StorageError } from '../../src/persistence/db';
import type { ChannelLike, LockManagerLike } from '../../src/persistence/tabLock';
import type { StorageLike } from '../../src/persistence/rescue';
import type { Id, Project } from '../../src/project/types';

interface Holder {
  stolen: boolean;
  reject(e: unknown): void;
}

/** One origin's lock manager (navigator.locks), shared by every simulated tab. */
export class FakeLocks implements LockManagerLike {
  private holders = new Map<string, Holder>();
  private waiting = new Map<string, (() => void)[]>();

  held(name: string): boolean {
    return this.holders.has(name);
  }

  /** Like LockManager.query(): the names held now. */
  async query(): Promise<{ held: { name: string }[] }> {
    return { held: [...this.holders.keys()].map((name) => ({ name })) };
  }

  private grant(name: string, cb: (lock: unknown) => unknown, resolve: (v: unknown) => void, reject: (e: unknown) => void): void {
    const h: Holder = { stolen: false, reject };
    this.holders.set(name, h);
    queueMicrotask(() => {
      let result: Promise<unknown>;
      try {
        result = Promise.resolve(cb({ name, mode: 'exclusive' }));
      } catch (e) {
        result = Promise.reject(e);
      }
      result.then(
        (v) => {
          if (h.stolen) return;
          this.free(name, h);
          resolve(v);
        },
        (e) => {
          if (h.stolen) return;
          this.free(name, h);
          reject(e);
        },
      );
    });
  }

  private free(name: string, h: Holder): void {
    if (this.holders.get(name) !== h) return;
    this.holders.delete(name);
    this.waiting.get(name)?.shift()?.();
  }

  request(name: string, options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, cb: (lock: unknown) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const cur = this.holders.get(name);
      if (options.steal) {
        if (cur) {
          cur.stolen = true;
          this.holders.delete(name);
          cur.reject(new DOMException('The lock was stolen.', 'AbortError'));
        }
        this.grant(name, cb, resolve, reject);
        return;
      }
      if (!cur && !this.waiting.get(name)?.length) {
        this.grant(name, cb, resolve, reject);
        return;
      }
      if (options.ifAvailable) {
        queueMicrotask(() => {
          Promise.resolve()
            .then(() => cb(null))
            .then(resolve, reject);
        });
        return;
      }
      const q = this.waiting.get(name) ?? [];
      this.waiting.set(name, q);
      const go = () => this.grant(name, cb, resolve, reject);
      q.push(go);
      options.signal?.addEventListener('abort', () => {
        const i = q.indexOf(go);
        if (i >= 0) {
          q.splice(i, 1);
          reject(new DOMException('The request was aborted.', 'AbortError'));
        }
      });
    });
  }
}

/** BroadcastChannel('switchboard01') across simulated tabs (delivered in a microtask, never to the sender). */
export class ChannelHub {
  private channels = new Set<FakeChannel>();
  readonly sent: unknown[] = [];
  channel(): FakeChannel {
    const c = new FakeChannel(this);
    this.channels.add(c);
    return c;
  }
  deliver(from: FakeChannel, message: unknown): void {
    this.sent.push(message);
    for (const c of this.channels) if (c !== from) queueMicrotask(() => c.receive(structuredClone(message)));
  }
  remove(c: FakeChannel): void {
    this.channels.delete(c);
  }
}

export class FakeChannel implements ChannelLike {
  private listeners = new Set<(ev: { data: unknown }) => void>();
  constructor(private hub: ChannelHub) {}
  postMessage(message: unknown): void {
    this.hub.deliver(this, message);
  }
  addEventListener(_type: 'message', l: (ev: { data: unknown }) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_type: 'message', l: (ev: { data: unknown }) => void): void {
    this.listeners.delete(l);
  }
  receive(data: unknown): void {
    for (const l of [...this.listeners]) l({ data });
  }
  close(): void {
    this.hub.remove(this);
  }
}

export class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  writes = 0;
  failWrites = false;
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.writes += 1;
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Stored projects shared by simulated tabs. */
export class FakeDisk {
  readonly projects = new Map<Id, Project>();
  readonly writes: { tab: string; project: Project }[] = [];
  /** One tab's view: it refuses to write over a stored copy newer than the one the tab loaded or saved. */
  tab(name: string) {
    const base = new Map<Id, number>();
    return {
      load: (id: Id): Project => {
        const p = this.projects.get(id);
        if (!p) throw new Error(`no project ${id}`);
        base.set(id, p.updatedAt);
        return p;
      },
      save: async (p: Project): Promise<void> => {
        const stored = this.projects.get(p.id);
        const b = base.get(p.id);
        if (stored && b !== undefined && stored.updatedAt > b) throw new StorageError('conflict', CONFLICT_MESSAGE);
        this.projects.set(p.id, p);
        this.writes.push({ tab: name, project: p });
        base.set(p.id, p.updatedAt);
      },
      isStale: async (id: Id): Promise<boolean> => {
        const stored = this.projects.get(id);
        const b = base.get(id);
        return !!stored && b !== undefined && stored.updatedAt > b;
      },
    };
  }
}

/** Let queued microtasks and promise chains run (real timers). */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}
