/**
 * Review follow-ups: a tab that does not hold a project never writes it
 * through the library (Replace it / starters, rename, delete), the holder
 * still can; heldElsewhere asks without taking the lock (Web Locks query, or
 * the channel heartbeat); names picked in the write transaction; versions:
 * a burst keeps the older history, before-edit snapshots are rate-limited,
 * a full storage pauses versions and makes thinning harder, and version
 * lists never read project data.
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_EVERY_MS, VERSION_BACKOFF_MS, createAutosaver } from '../../src/persistence/autosave';
import * as db from '../../src/persistence/db';
import * as library from '../../src/persistence/library';
import { QUERY_MS, createTabCoordinator, useTabCoordinator, type TabCoordinator } from '../../src/persistence/tabLock';
import { MAX_UNNAMED_VERSIONS, MAX_UNNAMED_VERSIONS_WHEN_FULL, saveVersion, versionsToThin } from '../../src/persistence/versions';
import { getStarter } from '../../src/content/starters';
import { createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { ChannelHub, FakeLocks, settle } from './r4-persist-fakes';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  await db.deleteDb();
});
afterEach(async () => {
  await db.deleteDb();
});

describe('a tab that does not hold the project writes nothing through the library', () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  /** Tab A holds `song`; this page is tab B (read-only for it). */
  async function setup(): Promise<{ song: Project; locks: FakeLocks; a: TabCoordinator; b: TabCoordinator }> {
    const song = createProject({ name: 'Song', now: 1000 });
    song.bpm = 100;
    await db.saveProject(song);
    const locks = new FakeLocks();
    const a = createTabCoordinator({ locks, tabId: 'A' });
    await a.acquire(song.id).ready();
    const b = createTabCoordinator({ locks, tabId: 'B' });
    restore = useTabCoordinator(b);
    expect(await b.acquire(song.id).ready()).toBe('other-tab');
    return { song, locks, a, b };
  }

  it('"Replace it": a new starter does not store the read-only copy of the open project', async () => {
    const { song } = await setup();
    const res = await library.createFromStarter(getStarter('techno')!.build(), { ...song, bpm: 140, updatedAt: 9000 });
    expect(res.replaced).toEqual({ id: song.id, name: 'Song' });
    expect((await db.loadProjectRecord(song.id))!.data.bpm).toBe(100);
    expect((await db.loadProjectRecord(res.project.id))!.name).toBe('Techno Starter');
  });

  it('rename and delete refuse with a plain message and change nothing', async () => {
    const { song } = await setup();
    await expect(library.renameProject(song.id, 'Renamed in B')).rejects.toMatchObject({ kind: 'open-elsewhere', message: '“Song” is open in another tab. Rename it there, or close that tab first.' });
    await expect(library.deleteProject(song.id)).rejects.toMatchObject({ kind: 'open-elsewhere', message: '“Song” is open in another tab. Close it there first, then delete it here.' });
    expect((await db.loadProjectRecord(song.id))!.name).toBe('Song');
    expect(await library.listTrash()).toEqual([]);
  });

  it('a project nobody has open, and the holder tab itself, can be renamed and deleted', async () => {
    const { song, a } = await setup();
    const free = createProject({ name: 'Free', now: 1000 });
    await db.saveProject(free);
    await library.renameProject(free.id, 'Free renamed');
    await library.deleteProject(free.id);
    expect((await library.listTrash()).map((t) => t.name)).toEqual(['Free renamed']);
    // The tab that has it open may rename it.
    restore();
    restore = useTabCoordinator(a);
    await library.renameProject(song.id, 'Renamed by its tab');
    expect((await db.loadProjectRecord(song.id))!.name).toBe('Renamed by its tab');
  });

  it('heldElsewhere asks without taking the lock, so a tab opening the project then still gets it', async () => {
    const locks = new FakeLocks();
    const c = createTabCoordinator({ locks, tabId: 'C' });
    expect(await c.heldElsewhere('p')).toBe(false);
    const d = createTabCoordinator({ locks, tabId: 'D' });
    expect(await d.acquire('p').ready()).toBe('held');
    expect(await c.heldElsewhere('p')).toBe(true);
    expect(await d.heldElsewhere('p')).toBe(false);
  });
});

describe('heldElsewhere without Web Locks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a holder answers the question on the channel', async () => {
    const hub = new ChannelHub();
    const a = createTabCoordinator({ channel: hub.channel(), tabId: 'A' });
    const b = createTabCoordinator({ channel: hub.channel(), tabId: 'B' });
    a.acquire('p');
    await vi.advanceTimersByTimeAsync(QUERY_MS + 5);
    const asked = b.heldElsewhere('p');
    await vi.advanceTimersByTimeAsync(QUERY_MS + 5);
    expect(await asked).toBe(true);
    const free = b.heldElsewhere('q');
    await vi.advanceTimersByTimeAsync(QUERY_MS + 5);
    expect(await free).toBe(false);
    a.dispose();
    b.dispose();
  });
});

describe('names are picked where they are written', () => {
  it('two starters stored at the same moment get different names', async () => {
    const s = createProject({ name: 'House Starter', now: 1 });
    const [a, b] = await Promise.all([library.createFromStarter(s, null, { now: 10 }), library.createFromStarter(s, null, { now: 11 })]);
    expect([a.project.name, b.project.name].sort()).toEqual(['House Starter', 'House Starter 2']);
    const copies = await Promise.all([library.saveCopy(a.project), library.saveCopy(a.project), library.saveCopy(a.project)]);
    expect(copies.map((c) => c.name).sort()).toEqual(['House Starter copy', 'House Starter copy 2', 'House Starter copy 3']);
  });
});

describe('versions: bursts, rate, full storage, light lists', () => {
  it('a burst of 30 versions in ten minutes keeps the hourly and daily history', () => {
    const now = Date.UTC(2026, 9, 2, 12, 0, 0);
    const list: { id: string; createdAt: number }[] = [];
    for (let d = 1; d <= 7; d++) list.push({ id: `day${d}`, createdAt: now - d * DAY });
    for (let h = 2; h <= 10; h++) list.push({ id: `hour${h}`, createdAt: now - h * HOUR });
    for (let i = 0; i < 30; i++) list.push({ id: `burst${i}`, createdAt: now - i * 20_000 });
    const dropped = new Set(versionsToThin(list, now));
    const kept = list.filter((v) => !dropped.has(v.id)).map((v) => v.id);
    expect(kept).toHaveLength(MAX_UNNAMED_VERSIONS);
    for (let d = 1; d <= 7; d++) expect(kept).toContain(`day${d}`);
    for (let h = 2; h <= 10; h++) expect(kept).toContain(`hour${h}`);
    // The newest of the burst, and as many more of it as fit.
    expect(kept).toContain('burst0');
    expect(kept.filter((k) => k.startsWith('burst'))).toHaveLength(MAX_UNNAMED_VERSIONS - 16);
    expect(kept).toContain('burst13');
    expect(kept).not.toContain('burst14');
  });

  it('versions before the same kind of edit are kept at most every few minutes', async () => {
    let t = 1_000_000;
    const kept: string[] = [];
    const store = new ProjectStore(createProject({ name: 'S', now: 1 }), { now: () => t });
    const auto = createAutosaver({ store, save: async () => undefined, now: () => t, tab: null, rescue: null, events: { document: null, window: null }, versions: { save: async (_p, o) => void kept.push(o.reason) } });
    for (let i = 0; i < 8; i++) {
      t += 10_000;
      await auto.snapshotBefore(store.getState(), 'project:Variation');
    }
    await auto.snapshotBefore(store.getState(), 'clip:Clear notes');
    expect(kept).toEqual(['before:Variation', 'before:Clear notes']);
    t += SNAPSHOT_EVERY_MS;
    await auto.snapshotBefore(store.getState(), 'project:Variation');
    expect(kept).toEqual(['before:Variation', 'before:Clear notes', 'before:Variation']);
    await auto.dispose();
  });

  it('a full storage never holds up saving the project, and pauses versions for a while', async () => {
    let t = 1_000_000;
    let calls = 0;
    const store = new ProjectStore(createProject({ name: 'S', now: 1 }), { now: () => t });
    const saved: number[] = [];
    const auto = createAutosaver({
      store,
      save: async (p) => void saved.push(p.bpm),
      now: () => t,
      debounceMs: 5,
      tab: null,
      rescue: null,
      events: { document: null, window: null },
      versions: {
        save: async () => {
          calls += 1;
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        },
      },
    });
    await expect(auto.snapshotBefore(store.getState(), 'Variation')).resolves.toBeUndefined();
    expect(calls).toBe(1);
    t += SNAPSHOT_EVERY_MS + 1;
    await auto.snapshotBefore(store.getState(), 'Clear notes');
    expect(calls).toBe(1);
    store.apply('project:Change tempo', (d) => void (d.bpm = 101));
    await auto.flush();
    expect(saved).toEqual([101]);
    expect(auto.status.getState()).toMatchObject({ status: 'saved', failures: 0 });
    t += VERSION_BACKOFF_MS;
    await auto.snapshotBefore(store.getState(), 'Clear notes');
    expect(calls).toBe(2);
    await auto.dispose();
  });

  it('with the real store: a full disk for versions leaves the project saving normally', async () => {
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'versions' || this.name === 'versionData') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return orig.apply(this, args);
    };
    try {
      let t = 1000;
      const p = createProject({ name: 'Q', now: 1 });
      await db.saveProject(p);
      const store = new ProjectStore(p, { now: () => (t += 1000) });
      const auto = createAutosaver({ store, save: (x) => db.saveProject(x), debounceMs: 5, tab: null, rescue: null, autoVersionMs: 1, events: { document: null, window: null } });
      for (let i = 0; i < 5; i++) {
        store.apply('project:Change tempo', (d) => void (d.bpm = 100 + i));
        await auto.flush();
        await settle();
      }
      await expect(auto.snapshotBefore(store.getState(), 'project:Variation')).resolves.toBeUndefined();
      expect(auto.status.getState()).toMatchObject({ status: 'saved', failures: 0 });
      expect((await db.loadProjectRecord(p.id))!.data.bpm).toBe(104);
      await auto.dispose();
    } finally {
      IDBObjectStore.prototype.put = orig;
    }
  });

  it('when storage is full, saving a version thins harder and tries once more', async () => {
    const p = createProject({ name: 'S', now: 1 });
    await db.saveProject(p);
    const now = Date.UTC(2026, 9, 20, 12);
    for (let d = 25; d >= 1; d--) await saveVersion({ ...p, updatedAt: 100 + d }, { reason: 'auto', now: now - d * DAY });
    await saveVersion({ ...p, updatedAt: 99 }, { name: 'Keep', now: now - 40 * DAY });
    const orig = IDBObjectStore.prototype.put;
    let failed = 0;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'versionData' && failed === 0) {
        failed += 1;
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return orig.apply(this, args);
    };
    try {
      await saveVersion({ ...p, updatedAt: 500 }, { reason: 'auto', now });
    } finally {
      IDBObjectStore.prototype.put = orig;
    }
    const list = await library.listVersions(p.id);
    expect(failed).toBe(1);
    expect(list.filter((v) => !v.name)).toHaveLength(MAX_UNNAMED_VERSIONS_WHEN_FULL);
    expect(list[0].projectUpdatedAt).toBe(500);
    expect(list.some((v) => v.name === 'Keep')).toBe(true);
  });

  it('the version list reads only small summaries (no project data in the versions store)', async () => {
    const p = getStarter('house')!.build();
    await db.saveProject(p);
    await saveVersion(p, { name: 'One' });
    const raw = await openDB(db.DB_NAME);
    const metas = await raw.getAll('versions');
    const data = await raw.getAll('versionData');
    raw.close();
    expect(metas).toHaveLength(1);
    expect(Object.keys(metas[0]).sort()).toEqual(['createdAt', 'id', 'name', 'projectId', 'projectName', 'projectUpdatedAt', 'reason', 'summary']);
    expect(JSON.stringify(metas[0]).length).toBeLessThan(400);
    expect(data).toHaveLength(1);
    expect(data[0].data.id).toBe(p.id);
  });

  it('GC keeps a recording only a version uses (clip sample, take snapshot) and one only a trashed version uses', async () => {
    const p = createProject({ name: 'G', now: 1 });
    await db.saveProject(p);
    const now = 10_000_000;
    const meta = (id: string) => ({ id, name: id, mime: 'audio/wav', byteLength: 3, duration: 0.1, sampleRate: 44100, channels: 1 });
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    for (const id of ['s_clip', 's_take', 's_trashver', 's_orphan']) await db.putSample(meta(id), blob, 0);
    const v1: Project = structuredClone(p);
    (v1.tracks[0].clips as unknown[])[0] = { id: 'clip_a', name: 'A', bars: 1, notes: [], sample: { id: 's_clip' } };
    (v1 as unknown as { performances: unknown[] }).performances = [{ snapshot: { tracks: [{ instrument: { kind: 'sampler', sampleId: 's_take' }, clips: [] }] } }];
    await saveVersion({ ...v1, updatedAt: 5 }, { now: now - 1000 });
    const q = createProject({ name: 'T', now: 2 });
    await db.saveProject(q);
    const vq: Project = structuredClone(q);
    (vq.tracks[0].clips as unknown[])[0] = { id: 'clip_b', name: 'B', bars: 1, notes: [], sample: { id: 's_trashver' } };
    await saveVersion({ ...vq, updatedAt: 6 }, { now: now - 1000 });
    await library.deleteProject(q.id);
    expect(await db.garbageCollectSamples({ now, graceMs: 10 })).toEqual(['s_orphan']);
  });
});
