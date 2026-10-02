/**
 * Rescue copy (shell-03): on pagehide / visibilitychange→hidden the newest
 * pending project is written synchronously to localStorage; it is cleared
 * once the project saves; openLast / openProject take it back when it is
 * newer than the stored copy ("Recovered your last edits.").
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAutosaver } from '../../src/persistence/autosave';
import { databaseId, deleteDb, deleteProjectToTrash, listProjects, loadProjectRecord, saveProject } from '../../src/persistence/db';
import * as library from '../../src/persistence/library';
import { RESCUE_KEY, RESCUE_MAX_CHARS, RESCUE_WARNING, createRescueStore, type RescueStore } from '../../src/persistence/rescue';
import { createTabCoordinator } from '../../src/persistence/tabLock';
import { createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { FakeLocks, MemoryStorage, settle } from './r4-persist-fakes';

function storeOf(p: Project, start = 10_000): ProjectStore {
  let t = start;
  return new ProjectStore(p, { now: () => (t += 10) });
}

/** A page: document (visibility) and window (pagehide). */
function page() {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const win = new EventTarget();
  return {
    events: { document: doc, window: win },
    hide() {
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    unload() {
      win.dispatchEvent(new Event('pagehide'));
    },
  };
}

const stored = (mem: MemoryStorage) => {
  const raw = mem.getItem(RESCUE_KEY);
  return raw ? (JSON.parse(raw) as { id: string; updatedAt: number; tab: string | null; dbId: string | null; project: Project }) : null;
};

describe('rescue store', () => {
  it('writes the project JSON as it is behind a small header, reads it back and clears it by id and time', () => {
    const mem = new MemoryStorage();
    const r = createRescueStore(mem)!;
    const p = createProject({ name: 'Song "quoted"', now: 1234 });
    expect(r.write({ id: p.id, updatedAt: p.updatedAt, json: JSON.stringify(p), tab: 'tab_x', dbId: 'db_1' })).toBe(true);
    expect(mem.getItem(RESCUE_KEY)!.startsWith(`{"v":1,"id":"${p.id}","updatedAt":1234,"tab":"tab_x","dbId":"db_1","project":{`)).toBe(true);
    expect(r.header()).toEqual({ id: p.id, updatedAt: 1234, tab: 'tab_x', dbId: 'db_1' });
    expect(r.read()!.project).toEqual(JSON.parse(JSON.stringify(p)));
    // Only a copy of that project, not newer than what was saved, and (when asked) by that tab.
    expect(r.clearIf('proj_other', 9999)).toBe(false);
    expect(r.clearIf(p.id, 1000)).toBe(false);
    expect(r.clearIf(p.id, 9999, 'tab_y')).toBe(false);
    expect(r.clearIf(p.id, 1234, 'tab_x')).toBe(true);
    expect(mem.getItem(RESCUE_KEY)).toBeNull();
  });

  it('skips a project over about 2 MB, never leaves an older copy behind a failed write, and drops an unreadable copy', () => {
    const mem = new MemoryStorage();
    const r = createRescueStore(mem)!;
    expect(r.write({ id: 'p', updatedAt: 1, json: `{"x":"${'a'.repeat(RESCUE_MAX_CHARS)}"}` })).toBe(false);
    expect(mem.writes).toBe(0);
    r.write({ id: 'p', updatedAt: 1, json: '{"a":1}' });
    mem.failWrites = true;
    expect(r.write({ id: 'p', updatedAt: 2, json: '{"a":2}' })).toBe(false);
    expect(mem.getItem(RESCUE_KEY)).toBeNull();
    mem.failWrites = false;
    mem.setItem(RESCUE_KEY, '{"v":1,"id":"p","updatedAt":3,"tab":null,"dbId":null,"project":{"cut off');
    expect(r.header()).toMatchObject({ id: 'p', updatedAt: 3 });
    expect(r.read()).toBeNull();
    expect(mem.getItem(RESCUE_KEY)).toBeNull();
  });
});

describe('autosave writes a rescue copy when the page goes away', () => {
  it('on pagehide, synchronously, the newest pending state; cleared once it is saved', async () => {
    const mem = new MemoryStorage();
    const pg = page();
    const store = storeOf(createProject({ name: 'Song', now: 1 }));
    let release: () => void = () => undefined;
    const writes: number[] = [];
    const auto = createAutosaver({
      store,
      // The IndexedDB write started at unload never commits in time.
      save: (p) =>
        new Promise<void>((resolve) => {
          release = () => {
            writes.push(p.bpm);
            resolve();
          };
        }),
      events: pg.events,
      tab: null,
      rescue: createRescueStore(mem),
      versions: null,
    });
    // Nothing pending: nothing written.
    pg.unload();
    expect(mem.writes).toBe(0);
    store.apply('project:Change tempo', (d) => void (d.bpm = 107));
    pg.unload();
    // Written before anything asynchronous could run.
    expect(stored(mem)).toMatchObject({ id: store.getState().id, updatedAt: store.getState().updatedAt, dbId: null });
    expect(stored(mem)!.project.bpm).toBe(107);
    // The save started by pagehide completes: the copy goes.
    await settle(2);
    release();
    await settle(2);
    expect(writes).toEqual([107]);
    expect(mem.getItem(RESCUE_KEY)).toBeNull();
    await auto.dispose();
  });

  it('includes a save that is still being written, and also writes when the tab is hidden', async () => {
    const mem = new MemoryStorage();
    const pg = page();
    const store = storeOf(createProject({ name: 'Song', now: 1 }));
    const auto = createAutosaver({ store, save: () => new Promise<void>(() => undefined), events: pg.events, tab: null, rescue: createRescueStore(mem), versions: null });
    store.apply('project:Change tempo', (d) => void (d.bpm = 95));
    void auto.flush();
    await settle(2);
    // Nothing is pending any more, but the write has not committed.
    pg.hide();
    expect(stored(mem)!.project.bpm).toBe(95);
    void auto.dispose();
  });

  it('a read-only tab never writes a rescue copy', async () => {
    const mem = new MemoryStorage();
    const locks = new FakeLocks();
    const song = createProject({ name: 'Song', now: 1 });
    const holder = createTabCoordinator({ locks, tabId: 'A' }).acquire(song.id);
    await holder.ready();
    const pg = page();
    const store = storeOf(song);
    const auto = createAutosaver({ store, save: async () => undefined, events: pg.events, tab: createTabCoordinator({ locks, tabId: 'B' }), rescue: createRescueStore(mem), versions: null });
    await settle();
    expect(auto.status.getState().readonly).toBe('other-tab');
    store.apply('project:Change tempo', (d) => void (d.bpm = 150));
    pg.unload();
    expect(mem.writes).toBe(0);
    await auto.dispose();
  });
});

describe('opening takes a newer rescue copy back', () => {
  let mem: MemoryStorage;
  let rescue: RescueStore;
  let restore: () => void;
  beforeEach(async () => {
    await deleteDb();
    mem = new MemoryStorage();
    rescue = createRescueStore(mem)!;
    restore = library.useRescueStore(rescue);
  });
  afterEach(() => {
    restore();
  });

  async function storedSong(bpm = 120, updatedAt = 1000): Promise<Project> {
    const p = createProject({ name: 'Song', now: updatedAt });
    p.bpm = bpm;
    await saveProject(p);
    await library.setLastProject(p.id);
    return p;
  }

  const rescueOf = async (p: Project, opts: { dbId?: string | null } = {}) =>
    rescue.write({ id: p.id, updatedAt: p.updatedAt, json: JSON.stringify(p), tab: 'tab_gone', dbId: opts.dbId === undefined ? await databaseId() : opts.dbId });

  it('reload right after an edit: openLast returns the edit, stores it and clears the copy', async () => {
    const p = await storedSong(120, 1000);
    await rescueOf({ ...p, bpm: 111, updatedAt: 2000 });
    const opened = await library.openLast();
    expect(opened!.project.bpm).toBe(111);
    expect(opened!.warnings).toEqual([RESCUE_WARNING]);
    expect(RESCUE_WARNING).toBe('Recovered your last edits.');
    expect((await loadProjectRecord(p.id))!.data.bpm).toBe(111);
    expect(mem.getItem(RESCUE_KEY)).toBeNull();
    // Next time it is the normal stored project.
    expect((await library.openLast())!.warnings).toEqual([]);
  });

  it('the whole path: an autosaver whose save never commits, pagehide, then a new page opens the project', async () => {
    const p = await storedSong(120, 1000);
    const pg = page();
    const store = storeOf(p, 5000);
    const auto = createAutosaver({ store, save: () => new Promise<void>(() => undefined), events: pg.events, tab: null, rescue, versions: null });
    await databaseId();
    store.apply('project:Change tempo', (d) => void (d.bpm = 103));
    pg.unload();
    void auto.dispose();
    // The next page.
    const opened = await library.openLast();
    expect(opened).toMatchObject({ project: { id: p.id, bpm: 103 }, warnings: [RESCUE_WARNING] });
  });

  it('ignores (and removes) a copy that is older, from another database, unreadable or not a valid project', async () => {
    const p = await storedSong(120, 5000);
    await rescueOf({ ...p, bpm: 90, updatedAt: 4000 });
    expect((await library.openLast())!).toMatchObject({ project: { bpm: 120 }, warnings: [] });
    expect(mem.getItem(RESCUE_KEY)).toBeNull();

    await rescueOf({ ...p, bpm: 91, updatedAt: 6000 }, { dbId: 'db_erased_long_ago' });
    expect((await library.openLast())!.project.bpm).toBe(120);
    expect(mem.getItem(RESCUE_KEY)).toBeNull();

    await rescueOf({ ...p, bpm: 92, updatedAt: 6000, tracks: p.tracks.slice(0, 3) });
    expect((await library.openLast())!.project.bpm).toBe(120);
    expect(mem.getItem(RESCUE_KEY)).toBeNull();
    expect((await loadProjectRecord(p.id))!.data.bpm).toBe(120);
  });

  it('openProject takes it back too; a copy of another project waits for that one', async () => {
    const a = await storedSong(120, 1000);
    const b = createProject({ name: 'Other', now: 1000 });
    await saveProject(b);
    await rescueOf({ ...a, bpm: 140, updatedAt: 3000 });
    expect((await library.openProject(b.id)).warnings).toEqual([]);
    expect(rescue.header()?.id).toBe(a.id);
    const opened = await library.openProject(a.id);
    expect(opened).toMatchObject({ project: { bpm: 140 }, warnings: [RESCUE_WARNING] });
  });

  it('a first-launch preview changed just before closing comes back as a stored project; a trashed one does not', async () => {
    await databaseId();
    const preview = createProject({ name: 'House Starter', now: 1000 });
    await rescueOf({ ...preview, bpm: 97, updatedAt: 2000 });
    const opened = await library.openLast();
    expect(opened).toMatchObject({ project: { id: preview.id, bpm: 97 }, warnings: [RESCUE_WARNING] });
    expect((await listProjects()).map((s) => s.id)).toEqual([preview.id]);

    // A project deleted to the trash is not brought back by an old copy.
    const gone = createProject({ name: 'Gone', now: 1000 });
    await saveProject(gone);
    await deleteProjectToTrash(gone.id);
    await rescueOf({ ...gone, updatedAt: 3000 });
    expect((await library.openLast())!.project.id).toBe(preview.id);
    expect((await listProjects()).map((s) => s.id)).toEqual([preview.id]);
  });

  it('storage full: the project still opens with the edits, flagged unsaved, and the copy stays', async () => {
    const p = await storedSong(120, 1000);
    await rescueOf({ ...p, bpm: 112, updatedAt: 2000 });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    try {
      const opened = await library.openLast();
      expect(opened).toMatchObject({ project: { bpm: 112 }, warnings: [RESCUE_WARNING], unsaved: true });
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    expect(rescue.header()).toMatchObject({ id: p.id, updatedAt: 2000 });
    expect((await loadProjectRecord(p.id))!.data.bpm).toBe(120);
    // Storage works again: the next visit stores it.
    expect(await library.openLast()).toMatchObject({ project: { bpm: 112 }, warnings: [RESCUE_WARNING] });
    expect((await library.openLast())!.unsaved).toBeUndefined();
    expect((await loadProjectRecord(p.id))!.data.bpm).toBe(112);
  });

  it('deleting a project drops its rescue copy', async () => {
    const p = await storedSong(120, 1000);
    const other = createProject({ name: 'Other', now: 500 });
    await saveProject(other);
    await rescueOf({ ...p, updatedAt: 2000 });
    await library.deleteProject(p.id);
    expect(mem.getItem(RESCUE_KEY)).toBeNull();
  });

  it('is left alone while a living tab has the project open (that tab saves it itself)', async () => {
    const p = await storedSong(120, 1000);
    await rescueOf({ ...p, bpm: 125, updatedAt: 2000 });
    const locks = new FakeLocks();
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(nav, 'locks');
    Object.defineProperty(nav, 'locks', { value: locks, configurable: true });
    try {
      const other = createTabCoordinator({ locks, tabId: 'living' }).acquire(p.id);
      await other.ready();
      const opened = await library.openLast();
      expect(opened).toMatchObject({ project: { bpm: 120 }, warnings: [] });
      expect(rescue.header()?.id).toBe(p.id);
      other.release();
      await settle();
      expect((await library.openLast())!.project.bpm).toBe(125);
    } finally {
      if (had) Object.defineProperty(nav, 'locks', had);
      else delete nav.locks;
    }
  });
});
