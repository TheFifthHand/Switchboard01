/**
 * One tab per project (shell-01): Web Locks with a BroadcastChannel
 * heartbeat fallback, the autosaver in two tabs (the second is read-only,
 * Take over swaps them, a stale tab never writes over newer work), the
 * stored-version check in db.saveProject, and the failure counters.
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFLICT_SAVE_MESSAGE, OTHER_TAB_MESSAGE, createAutosaver, type Autosaver } from '../../src/persistence/autosave';
import { DB_NAME, DB_VERSION, deleteDb, loadProjectRecord, saveProject, storedIsNewer, type ProjectRecord } from '../../src/persistence/db';
import * as library from '../../src/persistence/library';
import { HEARTBEAT_MS, LOCK_PREFIX, QUERY_MS, createTabCoordinator, projectLockFree, type TabCoordinator } from '../../src/persistence/tabLock';
import { createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { ChannelHub, FakeDisk, FakeLocks, settle } from './r4-persist-fakes';

const NO_PAGE = { events: { document: null, window: null }, rescue: null, versions: null } as const;

/** A store whose clock always moves on (every edit gets a later updatedAt). */
function storeOf(p: Project, start = Date.now()): ProjectStore {
  let t = start;
  return new ProjectStore(p, { now: () => (t += 10) });
}

describe('tab locks with Web Locks', () => {
  it('gives the project to the first tab; the second is read-only until it takes over', async () => {
    const locks = new FakeLocks();
    const hub = new ChannelHub();
    const a = createTabCoordinator({ locks, channel: hub.channel(), tabId: 'A' });
    const b = createTabCoordinator({ locks, channel: hub.channel(), tabId: 'B' });
    const la = a.acquire('p1');
    expect(la.state()).toBe('pending');
    expect(await la.ready()).toBe('held');
    const lb = b.acquire('p1');
    expect(await lb.ready()).toBe('other-tab');
    expect(a.holds('p1')).toBe(true);
    expect(b.holds('p1')).toBe(false);

    const seenByA: string[] = [];
    la.subscribe((s) => seenByA.push(s));
    expect(await lb.takeOver()).toBe('held');
    await settle();
    // The tab it was taken from sees its lock end and turns read-only.
    expect(la.state()).toBe('other-tab');
    expect(seenByA).toEqual(['other-tab']);
    expect(hub.sent).toContainEqual(expect.objectContaining({ app: 'switchboard01', type: 'takeover', id: 'p1', tab: 'B' }));
    // Asking again does not take it back.
    expect(await la.retry()).toBe('other-tab');
    // Once B lets go, A can have it again.
    lb.release();
    await settle();
    expect(await la.retry()).toBe('held');
    a.dispose();
    b.dispose();
  });

  it('shares the lock between the handles of one tab and frees it with the last one', async () => {
    const locks = new FakeLocks();
    const a = createTabCoordinator({ locks, tabId: 'A' });
    const h1 = a.acquire('p');
    expect(await h1.ready()).toBe('held');
    // A second handle (an autosaver replacing another) shares it: never "open in another tab".
    const h2 = a.acquire('p');
    expect(h2.state()).toBe('held');
    h1.release();
    await settle();
    expect(locks.held(`${LOCK_PREFIX}p`)).toBe(true);
    h2.release();
    await settle();
    expect(locks.held(`${LOCK_PREFIX}p`)).toBe(false);
    // Let go and asked for again at once: the tab's own release is waited for, not mistaken for another tab.
    const h3 = a.acquire('p');
    await h3.ready();
    h3.release();
    const h4 = a.acquire('p');
    expect(await h4.ready()).toBe('held');
    a.dispose();
  });

  it('projectLockFree waits for a closing tab and says no while a tab has the project', async () => {
    const locks = new FakeLocks();
    const b = createTabCoordinator({ locks, tabId: 'B' });
    const lb = b.acquire('q');
    await lb.ready();
    expect(await projectLockFree('q', 40, locks)).toBe(false);
    setTimeout(() => lb.release(), 20);
    expect(await projectLockFree('q', 1000, locks)).toBe(true);
    // No Web Locks: nothing to wait for.
    expect(await projectLockFree('q', 10, null)).toBe(true);
    b.dispose();
  });
});

describe('tab locks without Web Locks (BroadcastChannel heartbeat)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims after a quiet query, answers later tabs, and gives way to a take over', async () => {
    const hub = new ChannelHub();
    const a = createTabCoordinator({ channel: hub.channel(), tabId: 'A' });
    const b = createTabCoordinator({ channel: hub.channel(), tabId: 'B' });
    const la = a.acquire('p');
    await vi.advanceTimersByTimeAsync(QUERY_MS + 5);
    expect(la.state()).toBe('held');
    // The holder keeps saying so.
    const claims = () => hub.sent.filter((m) => (m as { type: string; tab: string }).type === 'claim' && (m as { tab: string }).tab === 'A').length;
    const before = claims();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2 + 5);
    expect(claims()).toBeGreaterThanOrEqual(before + 2);

    const lb = b.acquire('p');
    await vi.advanceTimersByTimeAsync(QUERY_MS + 5);
    expect(lb.state()).toBe('other-tab');

    const takeOver = lb.takeOver();
    await vi.advanceTimersByTimeAsync(5);
    expect(await takeOver).toBe('held');
    expect(la.state()).toBe('other-tab');
    // A's older heartbeat cannot win it back, and asking again finds B.
    const retry = la.retry();
    await vi.advanceTimersByTimeAsync(QUERY_MS + 5);
    expect(await retry).toBe('other-tab');
    expect(lb.state()).toBe('held');

    // B leaves: A gets it on the next try.
    lb.release();
    const again = la.retry();
    await vi.advanceTimersByTimeAsync(QUERY_MS + 5);
    expect(await again).toBe('held');
    a.dispose();
    b.dispose();
  });

  it('two tabs claiming at the same moment end with exactly one holder', async () => {
    const hub = new ChannelHub();
    const tabs = ['A', 'B', 'C'].map((t) => createTabCoordinator({ channel: hub.channel(), tabId: t, now: () => 1000 }));
    const handles = tabs.map((t) => t.acquire('same'));
    await vi.advanceTimersByTimeAsync(QUERY_MS + 5);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 5);
    expect(handles.map((h) => h.state()).filter((s) => s === 'held')).toHaveLength(1);
    expect(handles[0].state()).toBe('held');
    for (const t of tabs) t.dispose();
  });
});

describe('autosave in two tabs', () => {
  function twoTabs() {
    const locks = new FakeLocks();
    const hub = new ChannelHub();
    const disk = new FakeDisk();
    const song = createProject({ name: 'Song', now: 1000 });
    disk.projects.set(song.id, song);
    const open = (name: string, tab: TabCoordinator) => {
      const io = disk.tab(name);
      const store = storeOf(io.load(song.id), name === 'A' ? 10_000 : 20_000);
      const auto = createAutosaver({ store, save: io.save, isStale: io.isStale, tab, debounceMs: 50, ...NO_PAGE });
      return { store, auto, io };
    };
    const tabA = createTabCoordinator({ locks, channel: hub.channel(), tabId: 'A' });
    const tabB = createTabCoordinator({ locks, channel: hub.channel(), tabId: 'B' });
    return { locks, hub, disk, song, open, tabA, tabB };
  }

  const status = (a: Autosaver) => a.status.getState();

  it('the second tab is read-only and writes nothing; the first keeps saving; Take over swaps them; the stale tab never overwrites', async () => {
    const { disk, song, open, tabA, tabB } = twoTabs();
    const A = open('A', tabA);
    await settle();
    A.store.apply('project:Change tempo', (d) => void (d.bpm = 100));
    await A.auto.flush();
    expect(disk.projects.get(song.id)!.bpm).toBe(100);

    const B = open('B', tabB);
    await settle();
    expect(status(B.auto)).toMatchObject({ readonly: 'other-tab', status: 'idle', dirty: false, failures: 0 });
    expect(status(A.auto).readonly).toBeNull();

    // B's edits stay in memory, pending, and say so; nothing is written.
    B.store.apply('project:Change tempo', (d) => void (d.bpm = 140));
    expect(status(B.auto)).toMatchObject({ readonly: 'other-tab', status: 'error', dirty: true, lastError: { kind: 'blocked', message: OTHER_TAB_MESSAGE } });
    await B.auto.flush();
    await settle();
    expect(disk.writes.filter((w) => w.tab === 'B')).toHaveLength(0);
    expect(status(B.auto).failures).toBe(0);

    // A keeps saving.
    A.store.apply('track:Mute', (d) => void (d.tracks[0].mute = true));
    await A.auto.flush();
    expect(disk.projects.get(song.id)).toMatchObject({ bpm: 100 });
    expect(disk.projects.get(song.id)!.tracks[0].mute).toBe(true);

    // B takes over: A saved after B opened it, so B does not write its old copy over that.
    await B.auto.takeOver();
    await settle();
    expect(status(B.auto)).toMatchObject({ readonly: 'conflict', status: 'error', lastError: { kind: 'conflict', message: CONFLICT_SAVE_MESSAGE } });
    expect(disk.writes.filter((w) => w.tab === 'B')).toHaveLength(0);
    // A lost the project and turns read-only: its next edit is not written.
    expect(status(A.auto).readonly).toBe('other-tab');
    A.store.apply('project:Change tempo', (d) => void (d.bpm = 90));
    await A.auto.flush();
    expect(disk.projects.get(song.id)!.bpm).toBe(100);
    expect(status(A.auto)).toMatchObject({ status: 'error', lastError: { kind: 'blocked' } });

    // B loads the latest: it saves normally from there.
    const latest = B.io.load(song.id);
    B.store.replace(latest);
    B.auto.markSaved(latest);
    expect(status(B.auto)).toMatchObject({ readonly: null, dirty: false });
    B.store.apply('project:Change tempo', (d) => void (d.bpm = 128));
    await B.auto.flush();
    expect(disk.projects.get(song.id)).toMatchObject({ bpm: 128 });
    expect(disk.projects.get(song.id)!.tracks[0].mute).toBe(true);
    await A.auto.dispose();
    await B.auto.dispose();
  });

  it('a tab that takes over with nothing newer stored writes its waiting edits at once', async () => {
    const { disk, song, open, tabA, tabB } = twoTabs();
    const A = open('A', tabA);
    await settle();
    const B = open('B', tabB);
    await settle();
    B.store.apply('project:Change tempo', (d) => void (d.bpm = 141));
    await B.auto.takeOver();
    expect(disk.projects.get(song.id)!.bpm).toBe(141);
    expect(status(B.auto)).toMatchObject({ readonly: null, status: 'saved', dirty: false });
    expect(status(A.auto).readonly).toBe('other-tab');
    await A.auto.dispose();
    await B.auto.dispose();
  });

  it('Try again writes once the other tab is closed', async () => {
    const { disk, song, open, tabA, tabB } = twoTabs();
    const A = open('A', tabA);
    await settle();
    const B = open('B', tabB);
    await settle();
    B.store.apply('project:Change tempo', (d) => void (d.bpm = 99));
    await B.auto.retry();
    expect(status(B.auto).readonly).toBe('other-tab');
    await A.auto.dispose();
    await settle();
    await B.auto.retry();
    expect(disk.projects.get(song.id)!.bpm).toBe(99);
    expect(status(B.auto)).toMatchObject({ readonly: null, status: 'saved' });
    await B.auto.dispose();
  });

  it('a read-only tab that moves on to another project leaves the unsaveable edits behind and saves the new one', async () => {
    const { disk, open, tabA, tabB } = twoTabs();
    const A = open('A', tabA);
    await settle();
    const B = open('B', tabB);
    await settle();
    B.store.apply('project:Change tempo', (d) => void (d.bpm = 150));
    expect(status(B.auto)).toMatchObject({ readonly: 'other-tab', dirty: true });
    const other = createProject({ name: 'Other', now: 1 });
    B.store.replace(other);
    B.auto.markSaved(other);
    await settle();
    expect(status(B.auto)).toMatchObject({ readonly: null, dirty: false });
    B.store.apply('project:Change tempo', (d) => void (d.bpm = 61));
    await B.auto.flush();
    expect(disk.writes.map((w) => [w.tab, w.project.name, w.project.bpm])).toEqual([['B', 'Other', 61]]);
    await A.auto.dispose();
    await B.auto.dispose();
  });

  it('follows the open project: a new project gets its own lock, the old one is let go once written', async () => {
    const locks = new FakeLocks();
    const tab = createTabCoordinator({ locks, tabId: 'A' });
    const p1 = createProject({ name: 'One', now: 1 });
    const p2 = createProject({ name: 'Two', now: 1 });
    const store = storeOf(p1);
    const saved: string[] = [];
    const auto = createAutosaver({ store, save: async (p) => void saved.push(p.name), tab, debounceMs: 50, ...NO_PAGE });
    await settle();
    expect(locks.held(LOCK_PREFIX + p1.id)).toBe(true);
    store.apply('project:Rename project', (d) => void (d.name = 'One edited'));
    store.replace(p2);
    auto.markSaved(p2);
    await auto.flush();
    await settle();
    expect(saved).toEqual(['One edited']);
    expect(locks.held(LOCK_PREFIX + p1.id)).toBe(false);
    expect(locks.held(LOCK_PREFIX + p2.id)).toBe(true);
    await auto.dispose();
    await settle();
    expect(locks.held(LOCK_PREFIX + p2.id)).toBe(false);
  });

  it('snapshotBefore keeps a version only in the tab that may write', async () => {
    const { open, tabA, tabB, song } = twoTabs();
    const kept: { tab: string; reason: string }[] = [];
    const A = open('A', tabA);
    await settle();
    const B = open('B', tabB);
    await settle();
    const withVersions = (name: string, x: typeof A, tab: TabCoordinator) => {
      void x.auto.dispose();
      return createAutosaver({ store: x.store, save: x.io.save, tab, debounceMs: 50, events: { document: null, window: null }, rescue: null, versions: { save: async (_p, o) => void kept.push({ tab: name, reason: o.reason }) } });
    };
    const autoA = withVersions('A', A, tabA);
    const autoB = withVersions('B', B, tabB);
    await settle();
    await autoA.snapshotBefore(A.store.getState(), 'project:Variation');
    await autoB.snapshotBefore(B.store.getState(), 'Variation');
    expect(kept).toEqual([{ tab: 'A', reason: 'before:Variation' }]);
    expect(song.id).toBe(A.store.getState().id);
    await autoA.dispose();
    await autoB.dispose();
  });
});

describe('failure counters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('count failed writes in a row from the first one, and reset on success', async () => {
    let t = 5000;
    const store = new ProjectStore(createProject({ now: 0 }));
    let full = true;
    const auto = createAutosaver({
      store,
      save: async () => {
        if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
      now: () => t,
      debounceMs: 10,
      tab: null,
      ...NO_PAGE,
    });
    expect(auto.status.getState()).toMatchObject({ failures: 0, firstFailureAt: null, readonly: null });
    store.apply('project:Change tempo', (d) => void (d.bpm = 101));
    await vi.advanceTimersByTimeAsync(10);
    expect(auto.status.getState()).toMatchObject({ status: 'error', failures: 1, firstFailureAt: 5000 });
    t = 9000;
    store.apply('project:Change tempo', (d) => void (d.bpm = 102));
    await vi.advanceTimersByTimeAsync(10);
    expect(auto.status.getState()).toMatchObject({ failures: 2, firstFailureAt: 5000 });
    full = false;
    await auto.retry();
    expect(auto.status.getState()).toMatchObject({ status: 'saved', failures: 0, firstFailureAt: null, lastError: null });
    await auto.dispose();
  });
});

describe('db: the stored-version check', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  /** Another tab writes the project straight into IndexedDB. */
  async function writeFromAnotherTab(rec: ProjectRecord): Promise<void> {
    const db = await openDB(DB_NAME, DB_VERSION);
    await db.put('projects', rec);
    db.close();
  }

  it('refuses to save over a newer stored copy and leaves it untouched', async () => {
    const p = createProject({ name: 'Song', now: 1000 });
    await saveProject(p);
    const theirs = { ...p, name: 'Saved in another tab', updatedAt: 5000 };
    await writeFromAnotherTab({ id: p.id, name: theirs.name, updatedAt: 5000, createdAt: p.createdAt, data: theirs });
    expect(await storedIsNewer(p.id)).toBe(true);
    await expect(saveProject({ ...p, name: 'Stale tab', updatedAt: 2000 })).rejects.toMatchObject({ name: 'StorageError', kind: 'conflict' });
    expect((await loadProjectRecord(p.id))!.name).toBe('Saved in another tab');
    // Opening it again bases this tab on the stored copy: saving works from there.
    const opened = await library.openProject(p.id);
    expect(opened.project.name).toBe('Saved in another tab');
    expect(await storedIsNewer(p.id)).toBe(false);
    await saveProject({ ...opened.project, bpm: 99, updatedAt: 6000 });
    expect((await loadProjectRecord(p.id))!.data.bpm).toBe(99);
  });

  it('a library rename moves the editor along only when the editor was up to date', async () => {
    const p = createProject({ name: 'Song', now: 1000 });
    await saveProject(p);
    // In step: rename, then the editor's next save goes through.
    await library.renameProject(p.id, 'Renamed', 2000);
    await expect(saveProject({ ...p, name: 'Renamed', bpm: 90, updatedAt: 3000 })).resolves.toBeUndefined();
    // Another tab saved meanwhile: a rename here does not make this tab's old copy look current.
    await writeFromAnotherTab({ id: p.id, name: 'Renamed', updatedAt: 4000, createdAt: p.createdAt, data: { ...p, name: 'Renamed', bpm: 77, updatedAt: 4000 } });
    await library.renameProject(p.id, 'Renamed again', 5000);
    await expect(saveProject({ ...p, bpm: 91, updatedAt: 6000 })).rejects.toMatchObject({ kind: 'conflict' });
    expect((await loadProjectRecord(p.id))!.data).toMatchObject({ name: 'Renamed again', bpm: 77 });
  });

  it('the autosaver turns read-only on a conflict, keeps the edits pending and does not count it as a failure', async () => {
    const p = createProject({ name: 'Song', now: 1000 });
    await saveProject(p);
    const store = storeOf(p, 1500);
    const auto = createAutosaver({ store, save: (x) => saveProject(x), debounceMs: 10, tab: null, ...NO_PAGE });
    await writeFromAnotherTab({ id: p.id, name: 'Theirs', updatedAt: 9_000_000_000_000, createdAt: p.createdAt, data: { ...p, name: 'Theirs', updatedAt: 9_000_000_000_000 } });
    store.apply('project:Change tempo', (d) => void (d.bpm = 133));
    await auto.flush();
    expect(auto.status.getState()).toMatchObject({ readonly: 'conflict', status: 'error', dirty: true, failures: 0, lastError: { kind: 'conflict' } });
    expect((await loadProjectRecord(p.id))!.name).toBe('Theirs');
    // Later edits are not written either.
    store.apply('project:Change tempo', (d) => void (d.bpm = 134));
    await auto.flush();
    expect((await loadProjectRecord(p.id))!.name).toBe('Theirs');
    // Load the latest: read-only ends and saving resumes.
    const latest = (await library.openProject(p.id)).project;
    store.replace(latest);
    auto.markSaved(latest);
    expect(auto.status.getState()).toMatchObject({ readonly: null, dirty: false });
    await auto.dispose();
  });
});
