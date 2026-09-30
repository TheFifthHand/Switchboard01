import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { QUOTA_MESSAGE, createAutosaver } from '../../src/persistence/autosave';
import {
  StorageError,
  deleteDb,
  deleteProjectToTrash,
  garbageCollectSamples,
  getMeta,
  getSample,
  listProjects,
  listSampleIds,
  listTrash,
  loadProject,
  purgeTrash,
  putSample,
  restoreFromTrash,
  saveProject,
  setMeta,
  toStorageError,
} from '../../src/persistence/db';
import * as library from '../../src/persistence/library';

function project(name: string, updatedAt: number): Project {
  const p = createProject({ name, now: updatedAt });
  return p;
}

const bytes = (...v: number[]) => new Blob([new Uint8Array(v)], { type: 'audio/wav' });
const meta = (id: string) => ({ id, name: id, mime: 'audio/wav', byteLength: 3, duration: 0.1, sampleRate: 44100, channels: 1 });

beforeEach(async () => {
  await deleteDb();
});

describe('db: projects', () => {
  it('saves, loads and lists projects newest first', async () => {
    const a = project('A', 100);
    const b = project('B', 300);
    const c = project('C', 200);
    for (const p of [a, b, c]) await saveProject(p);
    expect((await listProjects()).map((s) => s.name)).toEqual(['B', 'C', 'A']);
    const loaded = await loadProject(b.id);
    expect(loaded.project).toEqual(JSON.parse(JSON.stringify(b)));
    expect(loaded.warnings).toEqual([]);
    // Saving again overwrites the same entry.
    await saveProject({ ...b, name: 'B2', updatedAt: 50 });
    expect((await listProjects()).map((s) => s.name)).toEqual(['C', 'A', 'B2']);
  });

  it('reports a missing project as not-found', async () => {
    await expect(loadProject('proj_missing')).rejects.toMatchObject({ name: 'StorageError', kind: 'not-found' });
  });

  it('moves deleted projects to the trash and restores them', async () => {
    const a = project('A', 100);
    const b = project('B', 200);
    await saveProject(a);
    await saveProject(b);
    await deleteProjectToTrash(a.id, 5000);
    expect((await listProjects()).map((s) => s.id)).toEqual([b.id]);
    expect(await listTrash()).toEqual([{ id: a.id, name: 'A', deletedAt: 5000, updatedAt: 100 }]);
    await expect(deleteProjectToTrash(a.id)).rejects.toMatchObject({ kind: 'not-found' });

    const restored = await restoreFromTrash(a.id);
    expect(restored.name).toBe('A');
    expect((await listProjects()).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(await listTrash()).toEqual([]);
    expect((await loadProject(a.id)).project.name).toBe('A');

    // Restoring while a live project has the same id keeps both.
    await deleteProjectToTrash(a.id);
    await saveProject({ ...a, name: 'A again' });
    const second = await restoreFromTrash(a.id);
    expect(second.id).not.toBe(a.id);
    expect((await listProjects()).map((s) => s.name).sort()).toEqual(['A', 'A again', 'B']);
    expect((await loadProject(second.id)).project.id).toBe(second.id);

    await deleteProjectToTrash(b.id);
    await purgeTrash(b.id);
    expect(await listTrash()).toEqual([]);
    await expect(restoreFromTrash(b.id)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('stores meta values', async () => {
    expect(await getMeta('lastProjectId')).toBeUndefined();
    await setMeta('lastProjectId', 'proj_x');
    expect(await getMeta('lastProjectId')).toBe('proj_x');
  });
});

describe('db: samples', () => {
  it('round-trips recording bytes', async () => {
    await putSample(meta('smp_a'), bytes(1, 2, 3));
    const s = await getSample('smp_a');
    expect(s!.meta.id).toBe('smp_a');
    expect([...new Uint8Array(await s!.blob.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(await getSample('smp_none')).toBeNull();
  });

  it('garbage-collects recordings used by no project and no trashed project', async () => {
    const live = project('Live', 1);
    live.samples.push(meta('smp_live'));
    const trashed = project('Trashed', 2);
    const sampler = trashed.tracks[7].instrument;
    if (sampler.kind === 'sampler') sampler.sampleId = 'smp_trash';
    trashed.samples.push(meta('smp_trash'));
    const takeOnly = project('Take', 3);
    const snapTrack = structuredClone(takeOnly.tracks);
    const snapSampler = snapTrack[7].instrument;
    if (snapSampler.kind === 'sampler') snapSampler.sampleId = 'smp_take';
    takeOnly.performances.push({
      id: 'perf_1', name: 'T', createdAt: 0, startTick: 0, endTick: 10, events: [],
      snapshot: { bpm: 120, swing: 0, root: 0, scale: 'minor', assist: true, masterVolumeDb: -3, tracks: snapTrack, scenes: takeOnly.scenes, patch: takeOnly.patch, launcher: [], seed: 1 },
    });
    await saveProject(live);
    await saveProject(trashed);
    await saveProject(takeOnly);
    await deleteProjectToTrash(trashed.id);
    for (const id of ['smp_live', 'smp_trash', 'smp_take', 'smp_orphan']) await putSample(meta(id), bytes(9), 0);
    await putSample(meta('smp_new'), bytes(9), 1_000_000);

    const removed = await garbageCollectSamples({ graceMs: 60_000, now: 1_000_000 });
    expect(removed).toEqual(['smp_orphan']);
    expect((await listSampleIds()).sort()).toEqual(['smp_live', 'smp_new', 'smp_take', 'smp_trash']);
    // Once the young recording is old enough and still unused, it goes too.
    expect(await garbageCollectSamples({ graceMs: 60_000, now: 2_000_000 })).toEqual(['smp_new']);
  });
});

describe('storage errors', () => {
  it('maps quota and availability failures to readable kinds', () => {
    expect(toStorageError(new DOMException('The quota has been exceeded.', 'QuotaExceededError')).kind).toBe('quota');
    expect(toStorageError(new DOMException('x', 'SecurityError')).kind).toBe('unavailable');
    expect(toStorageError(new DOMException('x', 'VersionError')).kind).toBe('blocked');
    expect(toStorageError(new DOMException('x', 'NotFoundError')).kind).toBe('not-found');
    expect(toStorageError(new Error('odd')).kind).toBe('unknown');
    const e = new StorageError('quota', 'full');
    expect(toStorageError(e)).toBe(e);
  });
});

describe('autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function deferredSaver() {
    const calls: { project: Project; resolve: () => void; reject: (e: unknown) => void }[] = [];
    const save = (p: Project) => new Promise<void>((resolve, reject) => calls.push({ project: p, resolve, reject }));
    return { calls, save };
  }

  it('goes idle -> saving -> saved after a debounced edit', async () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const { calls, save } = deferredSaver();
    const auto = createAutosaver({ store, save, debounceMs: 800, now: () => 42, events: { document: null, window: null } });
    expect(auto.status.getState()).toMatchObject({ status: 'idle', dirty: false });
    store.apply('project:Change tempo', (d) => void (d.bpm = 100));
    store.apply('project:Change tempo', (d) => void (d.bpm = 101));
    expect(auto.status.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(auto.status.getState().status).toBe('saving');
    expect(calls[0].project.bpm).toBe(101);
    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(auto.status.getState()).toMatchObject({ status: 'saved', lastSavedAt: 42, lastError: null, dirty: false });
    auto.dispose();
  });

  it('coalesces edits made during a save into one follow-up save of the latest state', async () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const { calls, save } = deferredSaver();
    const auto = createAutosaver({ store, save, debounceMs: 100, events: { document: null, window: null } });
    store.apply('project:Change tempo', (d) => void (d.bpm = 100));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    for (let i = 1; i <= 5; i++) store.apply('project:Change tempo', (d) => void (d.bpm = 100 + i));
    const flushed = auto.flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1); // still waiting for the first save
    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].project).toBe(store.getState());
    calls[1].resolve();
    await flushed;
    expect(auto.status.getState()).toMatchObject({ status: 'saved', dirty: false });
    auto.dispose();
  });

  it('surfaces a quota error with recovery advice and recovers on retry', async () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    let full = true;
    const saved: Project[] = [];
    const save = async (p: Project) => {
      if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      saved.push(p);
    };
    const auto = createAutosaver({ store, save, debounceMs: 50, events: { document: null, window: null } });
    store.apply('project:Rename project', (d) => void (d.name = 'Keep me'));
    await vi.advanceTimersByTimeAsync(50);
    expect(auto.status.getState()).toMatchObject({ status: 'error', dirty: true, lastError: { kind: 'quota', message: QUOTA_MESSAGE } });
    expect(QUOTA_MESSAGE).toBe('Browser storage is full. Export the project file to keep a copy, then free space by deleting old projects.');
    full = false;
    await auto.retry();
    expect(auto.status.getState()).toMatchObject({ status: 'saved', lastError: null, dirty: false });
    expect(saved.at(-1)!.name).toBe('Keep me');
    auto.dispose();
  });

  it('keeps pending edits of a project when another one is loaded', async () => {
    const a = createProject({ name: 'A', now: 0 });
    const b = createProject({ name: 'B', now: 0 });
    const store = new ProjectStore(a);
    const saved: Project[] = [];
    const auto = createAutosaver({ store, save: async (p) => void saved.push(p), debounceMs: 800, events: { document: null, window: null } });
    store.apply('project:Rename project', (d) => void (d.name = 'A edited'));
    store.replace(b);
    auto.markSaved(b); // just loaded from storage
    await auto.flush();
    expect(saved.map((p) => p.name)).toEqual(['A edited']);
    auto.dispose();
  });

  it('writes pending edits when disposed, then stops watching', async () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const saved: string[] = [];
    const auto = createAutosaver({ store, save: async (p) => void saved.push(p.name), debounceMs: 800, events: { document: null, window: null } });
    store.apply('project:Rename project', (d) => void (d.name = 'Last words'));
    await auto.dispose();
    expect(saved).toEqual(['Last words']);
    store.apply('project:Rename project', (d) => void (d.name = 'After dispose'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved).toEqual(['Last words']);
  });

  it('explains unexpected save failures without repeating itself', async () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const auto = createAutosaver({
      store,
      save: () => Promise.reject(toStorageError(new Error('disk on fire'), 'Saving the project')),
      debounceMs: 10,
      events: { document: null, window: null },
    });
    store.apply('project:Rename project', (d) => void (d.name = 'x'));
    await vi.advanceTimersByTimeAsync(10);
    expect(auto.status.getState().lastError).toEqual({ kind: 'unknown', message: 'Saving failed (disk on fire). Try again, or export the project file to keep a copy.' });
    await auto.dispose();
  });

  it('saves at least every maxWaitMs during continuous editing, and flushes when the page is hidden', async () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const saved: number[] = [];
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const auto = createAutosaver({ store, save: async (p) => void saved.push(p.bpm), debounceMs: 800, maxWaitMs: 2000, events: { document: doc, window: null } });
    for (let i = 0; i < 10; i++) {
      store.apply('project:Change tempo', (d) => void (d.bpm = 60 + i), { gesture: 'drag' });
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(saved.length).toBeGreaterThanOrEqual(1);
    const count = saved.length;
    store.apply('project:Change tempo', (d) => void (d.bpm = 150));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.length).toBe(count + 1);
    expect(saved.at(-1)).toBe(150);
    auto.dispose();
  });
});

describe('library', () => {
  it('opens the last project, creates from starters and falls back after deletes', async () => {
    expect(await library.openLast()).toBeNull();
    const current = createProject({ name: 'Current', now: 10 });
    const starter = createProject({ name: 'House', now: 0 });
    const created = await library.createFromStarter(starter, current, { now: 20 });
    expect(created.id).not.toBe(starter.id);
    expect(created.name).toBe('House');
    expect((await listProjects()).map((s) => s.name)).toEqual(['House', 'Current']);
    expect((await library.openLast())!.project.id).toBe(created.id);

    const copy = await library.duplicateProject(created.id, undefined, 30);
    expect(copy.name).toBe('House copy');
    expect(copy.tracks).toEqual(JSON.parse(JSON.stringify(created.tracks)));
    await library.renameProject(current.id, '  Renamed  ', 40);
    expect((await library.listProjects())[0]).toMatchObject({ id: current.id, name: 'Renamed' });

    await library.deleteProject(created.id);
    expect(await getMeta('lastProjectId')).toBeUndefined();
    // Falls back to the most recently edited remaining project.
    expect((await library.openLast())!.project.id).toBe(current.id);
    await library.restoreProject(created.id);
    expect((await library.openProject(created.id)).project.name).toBe('House');
    expect(await getMeta('lastProjectId')).toBe(created.id);
  });

  it('says so when the last project is damaged and another one opens instead', async () => {
    const good = createProject({ name: 'Good', now: 10 });
    const broken = createProject({ name: 'Broken', now: 20 });
    await saveProject(good);
    await saveProject({ ...broken, tracks: broken.tracks.slice(0, 5) });
    await library.setLastProject(broken.id);

    const opened = await library.openLast();
    expect(opened!.project.id).toBe(good.id);
    expect(opened!.warnings).toEqual(['"Broken" could not be opened (The project must have exactly 8 parts.), so the most recent readable project was opened instead. It is still in the library.']);
    expect(await getMeta('lastProjectId')).toBe(good.id);
    // The damaged project is kept, not deleted.
    expect((await listProjects()).map((s) => s.name).sort()).toEqual(['Broken', 'Good']);

    // With nothing readable left, the library is not reported as empty.
    await library.deleteProject(good.id);
    const err = await library.openLast().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toMatchObject({ kind: 'unknown', cause: [expect.stringMatching(/^"Broken" could not be opened/)] });
  });
});
