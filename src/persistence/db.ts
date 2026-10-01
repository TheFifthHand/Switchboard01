/**
 * IndexedDB working storage (database "switchboard01", version 1).
 *
 * Stores:
 *  - projects: {id, name, updatedAt, createdAt, data: Project}
 *  - samples:  {id, meta: SampleMeta, blob: Blob, addedAt}  (original file bytes)
 *  - meta:     key -> value (e.g. lastProjectId)
 *  - trash:    {id, deletedAt, record: ProjectRecord}      (recoverable deletes)
 *
 * Every failure surfaces as a StorageError with a kind the UI can explain
 * (quota full, storage unavailable, blocked by another tab, not found).
 * Browser storage is working storage; exported bundles are the portable backup.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { uid } from '../project/factory';
import type { Id, Project, SampleMeta } from '../project/types';
import { validateProject } from '../project/validate';

export const DB_NAME = 'switchboard01';
export const DB_VERSION = 1;

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

export interface TrashRecord {
  id: Id;
  deletedAt: number;
  record: ProjectRecord;
}

export interface ProjectSummary {
  id: Id;
  name: string;
  updatedAt: number;
  createdAt: number;
  bpm: number;
  starterId?: string;
}

export interface TrashSummary {
  id: Id;
  name: string;
  deletedAt: number;
  updatedAt: number;
}

interface SwitchboardDB extends DBSchema {
  projects: { key: string; value: ProjectRecord; indexes: { updatedAt: number } };
  samples: { key: string; value: SampleRecord };
  meta: { key: string; value: unknown };
  trash: { key: string; value: TrashRecord };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type StorageErrorKind = 'quota' | 'unavailable' | 'blocked' | 'not-found' | 'unknown';

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  constructor(kind: StorageErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
    this.kind = kind;
  }
}

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

function open(): Promise<IDBPDatabase<SwitchboardDB>> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new StorageError('unavailable', 'Browser storage is not available.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    openDB<SwitchboardDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const projects = db.createObjectStore('projects', { keyPath: 'id' });
          projects.createIndex('updatedAt', 'updatedAt');
          db.createObjectStore('samples', { keyPath: 'id' });
          db.createObjectStore('meta');
          db.createObjectStore('trash', { keyPath: 'id' });
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
      (db) => {
        if (settled) db.close();
        else {
          settled = true;
          resolve(db);
        }
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
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(toStorageError(req.error, 'Deleting storage'));
    req.onblocked = () => resolve();
  });
}

async function guard<T>(context: string, fn: (db: IDBPDatabase<SwitchboardDB>) => Promise<T>): Promise<T> {
  try {
    return await fn(await getDb());
  } catch (e) {
    throw toStorageError(e, context);
  }
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

function recordOf(p: Project): ProjectRecord {
  return { id: p.id, name: p.name, updatedAt: p.updatedAt, createdAt: p.createdAt, data: p };
}

function summaryOf(r: ProjectRecord): ProjectSummary {
  const s: ProjectSummary = { id: r.id, name: r.name, updatedAt: r.updatedAt, createdAt: r.createdAt, bpm: r.data?.bpm ?? 120 };
  if (r.data?.starterId) s.starterId = r.data.starterId;
  return s;
}

export function saveProject(project: Project): Promise<void> {
  return guard('Saving the project', async (db) => {
    await db.put('projects', recordOf(project));
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
export async function loadProject(id: Id): Promise<{ project: Project; warnings: string[] }> {
  const rec = await loadProjectRecord(id);
  if (!rec) throw new StorageError('not-found', 'That project is no longer in this browser.');
  const v = validateProject(rec.data);
  // `cause` carries the plain-language validation errors for callers that list them.
  if (!v.ok) throw new StorageError('unknown', `This saved project could not be opened: ${v.errors[0]}`, { cause: v.errors });
  return { project: v.project, warnings: v.warnings };
}

/** Project summaries, most recently edited first. */
export function listProjects(): Promise<ProjectSummary[]> {
  return guard('Listing projects', async (db) => {
    const all = await db.getAll('projects');
    return all.map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

/** Move a project to the trash (recoverable). */
export function deleteProjectToTrash(id: Id, now: number = Date.now()): Promise<void> {
  return guard('Deleting the project', async (db) => {
    const tx = db.transaction(['projects', 'trash'], 'readwrite');
    const rec = await tx.objectStore('projects').get(id);
    if (!rec) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new StorageError('not-found', 'That project is no longer in this browser.');
    }
    await tx.objectStore('trash').put({ id, deletedAt: now, record: rec });
    await tx.objectStore('projects').delete(id);
    await tx.done;
  });
}

/**
 * Put a trashed project back in the library. Returns its summary. If a live
 * project now uses the same id (the same file imported again), the restored
 * copy gets a new id instead of overwriting it.
 */
export function restoreFromTrash(id: Id): Promise<ProjectSummary> {
  return guard('Restoring the project', async (db) => {
    const tx = db.transaction(['projects', 'trash'], 'readwrite');
    const t = await tx.objectStore('trash').get(id);
    if (!t) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new StorageError('not-found', 'That project is no longer in the trash.');
    }
    let record = t.record;
    if (await tx.objectStore('projects').getKey(id)) {
      const newId = uid('proj');
      record = { ...record, id: newId, data: { ...record.data, id: newId } };
    }
    await tx.objectStore('projects').put(record);
    await tx.objectStore('trash').delete(id);
    await tx.done;
    return summaryOf(record);
  });
}

export function listTrash(): Promise<TrashSummary[]> {
  return guard('Listing deleted projects', async (db) => {
    const all = await db.getAll('trash');
    return all.map((t) => ({ id: t.id, name: t.record.name, deletedAt: t.deletedAt, updatedAt: t.record.updatedAt })).sort((a, b) => b.deletedAt - a.deletedAt);
  });
}

/** Permanently delete one trashed project. */
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

/** Every sample id a project refers to (metadata, sampler parts, and takes' starting states). */
export function sampleIdsOf(p: Project | undefined | null): Set<Id> {
  const ids = new Set<Id>();
  if (!p) return ids;
  for (const s of p.samples ?? []) ids.add(s.id);
  const fromTracks = (tracks: Project['tracks'] | undefined) => {
    for (const t of tracks ?? []) if (t?.instrument?.kind === 'sampler' && t.instrument.sampleId) ids.add(t.instrument.sampleId);
  };
  fromTracks(p.tracks);
  for (const perf of p.performances ?? []) fromTracks(perf?.snapshot?.tracks);
  return ids;
}

/**
 * Delete stored recordings that no saved or trashed project refers to.
 * Recordings stored within `graceMs` are kept, so an import whose project has
 * not been autosaved yet is never collected. Returns the deleted ids.
 */
export function garbageCollectSamples(opts: { graceMs?: number; now?: number; keep?: Iterable<Id> } = {}): Promise<Id[]> {
  const grace = opts.graceMs ?? 10 * 60 * 1000;
  const now = opts.now ?? Date.now();
  return guard('Cleaning up recordings', async (db) => {
    const used = new Set<Id>(opts.keep ?? []);
    for (const r of await db.getAll('projects')) for (const id of sampleIdsOf(r.data)) used.add(id);
    for (const t of await db.getAll('trash')) for (const id of sampleIdsOf(t.record?.data)) used.add(id);
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
