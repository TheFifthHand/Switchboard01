/**
 * IndexedDB working storage (database "switchboard01", version 2).
 *
 * Stores:
 *  - projects: {id, name, updatedAt, createdAt, data: Project}
 *  - samples:  {id, meta: SampleMeta, blob: Blob, addedAt}  (original file bytes)
 *  - meta:     key -> value (lastProjectId, dbId)
 *  - trash:    {id, deletedAt, record: ProjectRecord, versions?}  (recoverable deletes;
 *              a trashed project carries its versions with it)
 *  - versions: {id, projectId, createdAt, name?, reason, summary, projectName,
 *              projectUpdatedAt}: what lists show (version 2; indexes projectId
 *              and createdAt)
 *  - versionData: {id, data: Project}: the saved project of each version (version 2),
 *              read only to restore one or to collect garbage
 *
 * Every failure surfaces as a StorageError with a kind the UI can explain
 * (quota full, storage unavailable, blocked by another tab, not found, or a
 * conflict: the stored copy was changed by another tab since this tab loaded
 * or saved it). Browser storage is working storage; exported bundles are the
 * portable backup.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { uid } from '../project/factory';
import type { Id, Project, SampleMeta } from '../project/types';
import { validateProject } from '../project/validate';
import { uniqueName } from './names';
import { projectShape } from './summary';

export const DB_NAME = 'switchboard01';
export const DB_VERSION = 2;

export interface ProjectRecord {
  id: Id;
  name: string;
  updatedAt: number;
  createdAt: number;
  data: Project;
}

export interface SampleRecord {
  id: Id;
  meta: SampleMeta;
  blob: Blob;
  /** When the recording was stored; young samples are spared by garbage collection. */
  addedAt?: number;
}

/** A saved state of a project (version history). Recordings are shared by id, never copied. */
export interface VersionRecord {
  id: Id;
  projectId: Id;
  createdAt: number;
  /** Named versions are kept until deleted; unnamed ones are thinned out over time. */
  name?: string;
  /** 'auto' (taken while editing), 'manual' (saved by the user) or 'before:<edit>' (before a bulk edit). */
  reason: string;
  /** One line about the state, e.g. "6 blocks · 2:19". */
  summary: string;
  data: Project;
}

export interface TrashRecord {
  id: Id;
  deletedAt: number;
  record: ProjectRecord;
  /** The project's versions, moved here with it (restored with it, deleted with it). */
  versions?: VersionRecord[];
}

export interface ProjectSummary {
  id: Id;
  name: string;
  updatedAt: number;
  createdAt: number;
  bpm: number;
  starterId?: string;
  /** Number of scenes. */
  sceneCount: number;
  /** Number of song blocks. */
  blockCount: number;
  /** Song length in seconds at the project's tempo (0 without a song). */
  songSeconds: number;
}

export interface TrashSummary {
  id: Id;
  name: string;
  deletedAt: number;
  updatedAt: number;
}

/** A version without its project data (what the versions store holds, and what lists show). */
export interface VersionSummary {
  id: Id;
  projectId: Id;
  createdAt: number;
  name?: string;
  reason: string;
  summary: string;
  /** The saved project's name and last edit time. */
  projectName: string;
  projectUpdatedAt: number;
}

interface SwitchboardDB extends DBSchema {
  projects: { key: string; value: ProjectRecord; indexes: { updatedAt: number } };
  samples: { key: string; value: SampleRecord };
  meta: { key: string; value: unknown };
  trash: { key: string; value: TrashRecord };
  versions: { key: string; value: VersionSummary; indexes: { projectId: string; createdAt: number } };
  versionData: { key: string; value: { id: Id; data: Project } };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * 'conflict': the stored copy is newer than the one this tab works on.
 * 'open-elsewhere': another tab has the project open, so this tab does not change it.
 */
export type StorageErrorKind = 'quota' | 'unavailable' | 'blocked' | 'not-found' | 'conflict' | 'open-elsewhere' | 'unknown';

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  constructor(kind: StorageErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
    this.kind = kind;
  }
}

/** Why a save was refused: the stored copy is newer than the one this tab works on. */
export const CONFLICT_MESSAGE = 'This project was changed in another tab, so this tab did not save over it.';

function errorName(e: unknown): string {
  if (e && typeof e === 'object' && 'name' in e && typeof (e as { name: unknown }).name === 'string') return (e as { name: string }).name;
  return '';
}

/** Map any IndexedDB/DOM failure to a StorageError. */
export function toStorageError(e: unknown, context = 'Storage'): StorageError {
  if (e instanceof StorageError) return e;
  const name = errorName(e);
  const msg = e instanceof Error ? e.message : String(e);
  const code = e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014 || /quota/i.test(msg)) {
    return new StorageError('quota', 'Browser storage is full.', { cause: e });
  }
  if (name === 'VersionError' || /blocked/i.test(msg)) {
    return new StorageError('blocked', 'Another Omni Song tab is using the storage.', { cause: e });
  }
  if (name === 'NotFoundError') return new StorageError('not-found', `${context}: not found.`, { cause: e });
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'UnknownError' || /indexeddb/i.test(msg)) {
    return new StorageError('unavailable', 'Browser storage is not available.', { cause: e });
  }
  return new StorageError('unknown', `${context} failed: ${msg}`, { cause: e });
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

let dbPromise: Promise<IDBPDatabase<SwitchboardDB>> | null = null;
/** Identity of the open database (meta 'dbId'): a rescue copy is only taken back into the database it came from. */
let dbIdCache: string | null = null;

export const META_DB_ID = 'dbId';

function open(): Promise<IDBPDatabase<SwitchboardDB>> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new StorageError('unavailable', 'Browser storage is not available.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    openDB<SwitchboardDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const projects = db.createObjectStore('projects', { keyPath: 'id' });
          projects.createIndex('updatedAt', 'updatedAt');
          db.createObjectStore('samples', { keyPath: 'id' });
          db.createObjectStore('meta');
          db.createObjectStore('trash', { keyPath: 'id' });
        }
        if (oldVersion < 2) {
          // Version history. Everything stored by version 1 stays as it is.
          const versions = db.createObjectStore('versions', { keyPath: 'id' });
          versions.createIndex('projectId', 'projectId');
          versions.createIndex('createdAt', 'createdAt');
          db.createObjectStore('versionData', { keyPath: 'id' });
          void tx.objectStore('meta').put(uid('db'), META_DB_ID);
        }
      },
      blocked() {
        // An older connection in another tab refuses to close.
        if (!settled) {
          settled = true;
          reject(new StorageError('blocked', 'Another Omni Song tab is using the storage. Close other tabs and try again.'));
        }
      },
      blocking() {
        // A newer version wants to open: let it, and reconnect lazily next time.
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
    }).then(
      async (db) => {
        if (settled) {
          db.close();
          return;
        }
        try {
          let id = await db.get('meta', META_DB_ID);
          if (typeof id !== 'string') {
            id = uid('db');
            await db.put('meta', id, META_DB_ID);
          }
          dbIdCache = id as string;
        } catch {
          // The identity only guards rescue copies; storage itself works.
        }
        settled = true;
        resolve(db);
      },
      (e: unknown) => {
        if (!settled) {
          settled = true;
          reject(toStorageError(e, 'Opening storage'));
        }
      },
    );
  });
}

function getDb(): Promise<IDBPDatabase<SwitchboardDB>> {
  if (!dbPromise) {
    dbPromise = open();
    // A failed open must not be cached: the next call retries.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** Close the connection (tests, or before deleting the database). */
export async function closeDb(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  if (p) {
    try {
      (await p).close();
    } catch {
      // Never opened.
    }
  }
}

/** Delete the whole database (tests and "erase all data"). */
export async function deleteDb(): Promise<void> {
  await closeDb();
  editorBase.clear();
  dbIdCache = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(toStorageError(req.error, 'Deleting storage'));
    req.onblocked = () => resolve();
  });
}

/** Identity of the database (opens it). Each database created gets a new one. */
export async function databaseId(): Promise<string | null> {
  try {
    await getDb();
  } catch {
    return null;
  }
  return dbIdCache;
}

/** The database identity if the database has been opened in this tab (synchronous, for page-hide handlers). */
export function openDatabaseId(): string | null {
  return dbIdCache;
}

async function guard<T>(context: string, fn: (db: IDBPDatabase<SwitchboardDB>) => Promise<T>): Promise<T> {
  try {
    return await fn(await getDb());
  } catch (e) {
    throw toStorageError(e, context);
  }
}

/** Abort a transaction that is being abandoned (it may have finished or aborted already). */
function abandon(tx: { abort(): void; done: Promise<void> }): void {
  tx.done.catch(() => undefined);
  try {
    tx.abort();
  } catch {
    // Already finished.
  }
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

/**
 * The stored version (updatedAt) each project's editor in this tab is based
 * on: set when the project is opened for editing (setEditorBase) and when
 * this tab saves it. A save is refused (kind 'conflict') when the stored copy
 * is newer than that, so a stale tab never writes its old project over newer
 * work saved by another tab.
 */
const editorBase = new Map<Id, number>();

/** This tab opened `id` for editing, based on the stored copy with this updatedAt. */
export function setEditorBase(id: Id, updatedAt: number): void {
  editorBase.set(id, updatedAt);
}

/** The stored version this tab's editor of `id` is based on (undefined when it never loaded or saved it). */
export function getEditorBase(id: Id): number | undefined {
  return editorBase.get(id);
}

function recordOf(p: Project): ProjectRecord {
  return { id: p.id, name: p.name, updatedAt: p.updatedAt, createdAt: p.createdAt, data: p };
}

function summaryOf(r: ProjectRecord): ProjectSummary {
  const shape = projectShape(r.data);
  const s: ProjectSummary = {
    id: r.id,
    name: r.name,
    updatedAt: r.updatedAt,
    createdAt: r.createdAt,
    bpm: r.data?.bpm ?? 120,
    sceneCount: shape.scenes,
    blockCount: shape.blocks,
    songSeconds: shape.songSeconds,
  };
  if (r.data?.starterId) s.starterId = r.data.starterId;
  return s;
}

export interface SaveProjectOptions {
  /**
   * The stored updatedAt this write is based on (read-modify-write by the
   * library). Default: the version this tab's editor is based on.
   */
  base?: number;
}

/**
 * Store a project. The stored copy is read and replaced in one transaction:
 * when it is newer than the version this write is based on (another tab
 * saved it since), nothing is written and the promise rejects with kind
 * 'conflict'.
 */
export function saveProject(project: Project, opts: SaveProjectOptions = {}): Promise<void> {
  const explicit = opts.base !== undefined;
  const base = explicit ? opts.base : editorBase.get(project.id);
  return guard('Saving the project', async (db) => {
    const tx = db.transaction('projects', 'readwrite');
    try {
      const stored = await tx.store.get(project.id);
      if (stored && base !== undefined && stored.updatedAt > base) throw new StorageError('conflict', CONFLICT_MESSAGE);
      await tx.store.put(recordOf(project));
      await tx.done;
    } catch (e) {
      abandon(tx);
      throw e;
    }
    // A library edit moves the editor's base along only when the editor was based on what it changed.
    if (!explicit || editorBase.get(project.id) === base) editorBase.set(project.id, project.updatedAt);
  });
}

/**
 * Store a new project under `base` or, when another stored or trashed
 * project has that name, the next free one ("House Starter 2"). The names
 * are read and the project written in one transaction, so two tabs adding
 * projects at the same moment never pick the same name. Returns the project
 * as stored (with its name).
 */
export function addProjectWithFreeName(project: Project, base: string): Promise<Project> {
  return guard('Saving the project', async (db) => {
    const tx = db.transaction(['projects', 'trash'], 'readwrite');
    let named: Project;
    try {
      const [projects, trash] = await Promise.all([tx.objectStore('projects').getAll(), tx.objectStore('trash').getAll()]);
      const taken = [...projects.filter((r) => r.id !== project.id).map((r) => r.name), ...trash.map((t) => t.record?.name ?? '')];
      named = { ...project, name: uniqueName(base, taken) };
      await tx.objectStore('projects').put(recordOf(named));
      await tx.done;
    } catch (e) {
      abandon(tx);
      throw e;
    }
    editorBase.set(named.id, named.updatedAt);
    return named;
  });
}

/** True when the stored copy of `id` is newer than the version this tab's editor is based on. */
export function storedIsNewer(id: Id): Promise<boolean> {
  const base = editorBase.get(id);
  if (base === undefined) return Promise.resolve(false);
  return guard('Checking the project', async (db) => {
    const rec = await db.get('projects', id);
    return !!rec && rec.updatedAt > base;
  });
}

/** The stored record, unvalidated (null when absent). */
export function loadProjectRecord(id: Id): Promise<ProjectRecord | null> {
  return guard('Loading the project', async (db) => (await db.get('projects', id)) ?? null);
}

/**
 * Load, migrate and validate a stored project. Rejects with kind 'not-found'
 * when absent and 'unknown' when the stored data cannot be used.
 */
export async function loadProject(id: Id): Promise<{ project: Project; warnings: string[]; storedAt: number }> {
  const rec = await loadProjectRecord(id);
  if (!rec) throw new StorageError('not-found', 'That project is no longer in this browser.');
  const v = validateProject(rec.data);
  // `cause` carries the plain-language validation errors for callers that list them.
  if (!v.ok) throw new StorageError('unknown', `This saved project could not be opened: ${v.errors[0]}`, { cause: v.errors });
  return { project: v.project, warnings: v.warnings, storedAt: rec.updatedAt };
}

/** Project summaries, most recently edited first. */
export function listProjects(): Promise<ProjectSummary[]> {
  return guard('Listing projects', async (db) => {
    const all = await db.getAll('projects');
    return all.map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

/** Names of every stored and trashed project (to pick names that are not taken). */
export function listProjectNames(): Promise<string[]> {
  return guard('Listing projects', async (db) => {
    const [projects, trash] = await Promise.all([db.getAll('projects'), db.getAll('trash')]);
    return [...projects.map((p) => p.name), ...trash.map((t) => t.record?.name ?? '')];
  });
}

/** Move a project to the trash (recoverable), with its versions. */
export function deleteProjectToTrash(id: Id, now: number = Date.now()): Promise<void> {
  return guard('Deleting the project', async (db) => {
    const tx = db.transaction(['projects', 'trash', 'versions', 'versionData'], 'readwrite');
    try {
      const rec = await tx.objectStore('projects').get(id);
      if (!rec) throw new StorageError('not-found', 'That project is no longer in this browser.');
      const metas = await tx.objectStore('versions').index('projectId').getAll(id);
      const versions: VersionRecord[] = [];
      for (const m of metas) {
        const d = await tx.objectStore('versionData').get(m.id);
        if (d) versions.push(recordFromParts(m, d.data));
      }
      const entry: TrashRecord = { id, deletedAt: now, record: rec };
      if (versions.length) entry.versions = versions;
      await tx.objectStore('trash').put(entry);
      for (const m of metas) {
        await tx.objectStore('versions').delete(m.id);
        await tx.objectStore('versionData').delete(m.id);
      }
      await tx.objectStore('projects').delete(id);
      await tx.done;
    } catch (e) {
      abandon(tx);
      throw e;
    }
  });
}

/**
 * Put a trashed project back in the library, with its versions. Returns its
 * summary. If a live project now uses the same id (the same file imported
 * again), the restored copy gets a new id instead of overwriting it.
 */
export function restoreFromTrash(id: Id): Promise<ProjectSummary> {
  return guard('Restoring the project', async (db) => {
    const tx = db.transaction(['projects', 'trash', 'versions', 'versionData'], 'readwrite');
    try {
      const t = await tx.objectStore('trash').get(id);
      if (!t) throw new StorageError('not-found', 'That project is no longer in the trash.');
      let record = t.record;
      if (await tx.objectStore('projects').getKey(id)) {
        const newId = uid('proj');
        record = { ...record, id: newId, data: { ...record.data, id: newId } };
      }
      await tx.objectStore('projects').put(record);
      for (const v of t.versions ?? []) {
        await tx.objectStore('versions').put(versionSummaryOf({ ...v, projectId: record.id }));
        await tx.objectStore('versionData').put({ id: v.id, data: v.data });
      }
      await tx.objectStore('trash').delete(id);
      await tx.done;
      return summaryOf(record);
    } catch (e) {
      abandon(tx);
      throw e;
    }
  });
}

export function listTrash(): Promise<TrashSummary[]> {
  return guard('Listing deleted projects', async (db) => {
    const all = await db.getAll('trash');
    return all.map((t) => ({ id: t.id, name: t.record.name, deletedAt: t.deletedAt, updatedAt: t.record.updatedAt })).sort((a, b) => b.deletedAt - a.deletedAt);
  });
}

/** Permanently delete one trashed project (and the versions it carries). */
export function purgeTrash(id: Id): Promise<void> {
  return guard('Emptying the trash', async (db) => {
    await db.delete('trash', id);
  });
}

/** Permanently delete trashed projects older than `maxAgeMs` (all when 0). Returns the ids removed. */
export function purgeTrashOlderThan(maxAgeMs: number, now: number = Date.now()): Promise<Id[]> {
  return guard('Emptying the trash', async (db) => {
    const tx = db.transaction('trash', 'readwrite');
    const removed: Id[] = [];
    for (const t of await tx.store.getAll()) {
      if (now - t.deletedAt >= maxAgeMs) {
        await tx.store.delete(t.id);
        removed.push(t.id);
      }
    }
    await tx.done;
    return removed;
  });
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

function versionSummaryOf(v: VersionRecord): VersionSummary {
  const s: VersionSummary = {
    id: v.id,
    projectId: v.projectId,
    createdAt: v.createdAt,
    reason: v.reason,
    summary: v.summary,
    projectName: v.data?.name ?? '',
    projectUpdatedAt: v.data?.updatedAt ?? v.createdAt,
  };
  if (v.name) s.name = v.name;
  return s;
}

function recordFromParts(m: VersionSummary, data: Project): VersionRecord {
  const v: VersionRecord = { id: m.id, projectId: m.projectId, createdAt: m.createdAt, reason: m.reason, summary: m.summary, data };
  if (m.name) v.name = m.name;
  return v;
}

/** Store a version: its summary (for lists) and its project data, together. */
export function putVersion(v: VersionRecord): Promise<void> {
  return guard('Saving a version', async (db) => {
    const tx = db.transaction(['versions', 'versionData'], 'readwrite');
    try {
      await tx.objectStore('versionData').put({ id: v.id, data: v.data });
      await tx.objectStore('versions').put(versionSummaryOf(v));
      await tx.done;
    } catch (e) {
      abandon(tx);
      throw e;
    }
  });
}

export function getVersion(id: Id): Promise<VersionRecord | null> {
  return guard('Loading the version', async (db) => {
    const tx = db.transaction(['versions', 'versionData']);
    const [m, d] = await Promise.all([tx.objectStore('versions').get(id), tx.objectStore('versionData').get(id)]);
    return m && d ? recordFromParts(m, d.data) : null;
  });
}

/** A project's versions without their data, newest first (reads only the small summaries). */
export function listVersionSummaries(projectId: Id): Promise<VersionSummary[]> {
  return guard('Listing versions', async (db) => {
    const all = await db.getAllFromIndex('versions', 'projectId', projectId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  });
}

export function deleteVersions(ids: Iterable<Id>): Promise<void> {
  const list = [...ids];
  if (!list.length) return Promise.resolve();
  return guard('Deleting versions', async (db) => {
    const tx = db.transaction(['versions', 'versionData'], 'readwrite');
    for (const id of list) {
      await tx.objectStore('versions').delete(id);
      await tx.objectStore('versionData').delete(id);
    }
    await tx.done;
  });
}

/* ------------------------------------------------------------------ */
/* Samples                                                             */
/* ------------------------------------------------------------------ */

export function putSample(meta: SampleMeta, blob: Blob, now: number = Date.now()): Promise<void> {
  return guard('Storing the recording', async (db) => {
    await db.put('samples', { id: meta.id, meta, blob, addedAt: now });
  });
}

export function getSample(id: Id): Promise<{ meta: SampleMeta; blob: Blob } | null> {
  return guard('Loading the recording', async (db) => {
    const r = await db.get('samples', id);
    return r ? { meta: r.meta, blob: r.blob } : null;
  });
}

export function hasSample(id: Id): Promise<boolean> {
  return guard('Checking the recording', async (db) => (await db.getKey('samples', id)) !== undefined);
}

export function deleteSample(id: Id): Promise<void> {
  return guard('Deleting the recording', async (db) => {
    await db.delete('samples', id);
  });
}

export function listSampleIds(): Promise<Id[]> {
  return guard('Listing recordings', async (db) => (await db.getAllKeys('samples')).map(String));
}

/**
 * Every sample id a project refers to: its metadata, sampler parts, clips that
 * play their own recording (`clip.sample.id`), and the same in takes' starting
 * states.
 */
export function sampleIdsOf(p: Project | undefined | null): Set<Id> {
  const ids = new Set<Id>();
  if (!p) return ids;
  for (const s of p.samples ?? []) ids.add(s.id);
  const fromTracks = (tracks: Project['tracks'] | undefined) => {
    for (const t of tracks ?? []) {
      if (t?.instrument?.kind === 'sampler' && t.instrument.sampleId) ids.add(t.instrument.sampleId);
      for (const c of t?.clips ?? []) {
        // Per-clip recordings (schema v3); read loosely so older and newer projects both work.
        const own = (c as { sample?: { id?: unknown } } | null)?.sample?.id;
        if (typeof own === 'string' && own) ids.add(own);
      }
    }
  };
  fromTracks(p.tracks);
  for (const perf of p.performances ?? []) fromTracks(perf?.snapshot?.tracks);
  return ids;
}

/**
 * Delete stored recordings that no saved project, trashed project or
 * version refers to. Recordings stored within `graceMs` are kept, so an
 * import whose project has not been autosaved yet is never collected.
 * Versions of projects that are neither stored nor trashed (an untouched
 * preview's) are removed first once they are older than the grace period.
 * Returns the deleted sample ids.
 */
export function garbageCollectSamples(opts: { graceMs?: number; now?: number; keep?: Iterable<Id> } = {}): Promise<Id[]> {
  const grace = opts.graceMs ?? 10 * 60 * 1000;
  const now = opts.now ?? Date.now();
  return guard('Cleaning up recordings', async (db) => {
    const used = new Set<Id>(opts.keep ?? []);
    const projects = await db.getAll('projects');
    const live = new Set(projects.map((r) => r.id));
    for (const r of projects) for (const id of sampleIdsOf(r.data)) used.add(id);
    for (const t of await db.getAll('trash')) {
      for (const id of sampleIdsOf(t.record?.data)) used.add(id);
      for (const v of t.versions ?? []) for (const id of sampleIdsOf(v.data)) used.add(id);
    }
    const vtx = db.transaction(['versions', 'versionData'], 'readwrite');
    const kept = new Set<Id>();
    let vc = await vtx.objectStore('versions').openCursor();
    while (vc) {
      const v = vc.value;
      if (!live.has(v.projectId) && now - v.createdAt >= grace) {
        await vtx.objectStore('versionData').delete(v.id);
        await vc.delete();
      } else kept.add(v.id);
      vc = await vc.continue();
    }
    let dc = await vtx.objectStore('versionData').openCursor();
    while (dc) {
      if (kept.has(dc.value.id)) for (const id of sampleIdsOf(dc.value.data)) used.add(id);
      else await dc.delete();
      dc = await dc.continue();
    }
    await vtx.done;
    const tx = db.transaction('samples', 'readwrite');
    const removed: Id[] = [];
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const r = cursor.value;
      if (!used.has(r.id) && now - (r.addedAt ?? 0) >= grace) {
        await cursor.delete();
        removed.push(r.id);
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return removed;
  });
}

/* ------------------------------------------------------------------ */
/* Meta                                                                */
/* ------------------------------------------------------------------ */

export const META_LAST_PROJECT = 'lastProjectId';

export function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  return guard('Reading settings', async (db) => (await db.get('meta', key)) as T | undefined);
}

export function setMeta(key: string, value: unknown): Promise<void> {
  return guard('Saving settings', async (db) => {
    await db.put('meta', value, key);
  });
}

export function deleteMeta(key: string): Promise<void> {
  return guard('Saving settings', async (db) => {
    await db.delete('meta', key);
  });
}

/* ------------------------------------------------------------------ */
/* Storage quota                                                       */
/* ------------------------------------------------------------------ */

/** Used and available bytes, when the browser reports them. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await (globalThis.navigator as Navigator | undefined)?.storage?.estimate?.();
    return est && typeof est.usage === 'number' && typeof est.quota === 'number' ? { usage: est.usage, quota: est.quota } : null;
  } catch {
    return null;
  }
}

/** Ask the browser not to evict this site's storage under pressure. Resolves to whether it agreed. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await (globalThis.navigator as Navigator | undefined)?.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
