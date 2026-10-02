/**
 * Project library over db.ts: open the last project, create from a starter,
 * rename, duplicate, delete to trash and restore, and the version history
 * (versions.ts).
 *
 * The open project is edited through the ProjectStore; library operations on
 * it (rename) should go through the store's commands so autosave and the
 * library never disagree. These functions operate on stored projects.
 *
 * Opening a project (openLast, openProject) takes back its rescue copy
 * (rescue.ts) when that is newer than the stored project: the edits made
 * just before the page was reloaded or closed. The copy is validated and
 * migrated like any stored project, saved, and the result's warnings say
 * "Recovered your last edits."
 */
import { duplicateProject as duplicateData } from '../project/clone';
import { uid } from '../project/factory';
import type { Id, Project } from '../project/types';
import { validateProject } from '../project/validate';
import {
  META_LAST_PROJECT,
  StorageError,
  databaseId,
  deleteMeta,
  deleteProjectToTrash,
  getMeta,
  listProjectNames,
  listProjects as dbListProjects,
  listTrash as dbListTrash,
  loadProject,
  loadProjectRecord,
  purgeTrash,
  restoreFromTrash,
  saveProject,
  setEditorBase,
  setMeta,
  type ProjectSummary,
  type TrashSummary,
} from './db';
import { cleanName, uniqueName } from './names';
import { RESCUE_WARNING, defaultRescueStore, type RescueStore } from './rescue';
import { projectLockFree } from './tabLock';

export type { ProjectSummary, TrashSummary };
export { RESCUE_WARNING } from './rescue';
export { deleteVersion, listVersions, restoreVersionAsCopy, saveVersion, versionLabel, versionWhen, type SaveVersionOptions, type VersionSummary } from './versions';
import { saveVersion, type SaveVersionOptions, type VersionSummary } from './versions';

export interface OpenedProject {
  project: Project;
  warnings: string[];
  /**
   * True when the project opened with a rescue copy that could not be stored
   * (storage full…): it is not saved yet, so autosave should treat it as
   * unsaved. The copy stays in place until it is.
   */
  unsaved?: boolean;
}

/** What a starter replaced on screen: the project that was open (it stays in the library). */
export interface StarterResult {
  project: Project;
  replaced: { id: Id; name: string } | null;
}

/** Where rescue copies are read from (tests swap it). */
let rescueStore: () => RescueStore | null = defaultRescueStore;

/** Use another rescue store (tests). Returns a function that puts the default back. */
export function useRescueStore(store: RescueStore | null): () => void {
  const previous = rescueStore;
  rescueStore = () => store;
  return () => {
    rescueStore = previous;
  };
}

/** Remember which project to reopen next time. */
export async function setLastProject(id: Id): Promise<void> {
  await setMeta(META_LAST_PROJECT, id);
}

const UNREADABLE_LIBRARY_MESSAGE = 'None of the saved projects in this browser could be opened. They are still in the library.';

/* ------------------------------------------------------------------ */
/* Rescue copies                                                       */
/* ------------------------------------------------------------------ */

/**
 * The rescue copy of `id`, validated, when it should be taken back: it is
 * newer than the stored copy (`storedAt`; null when there is none), it
 * belongs to this database, and no tab has the project open (the tab that
 * wrote it is gone; a living one saves it itself). A copy that is older
 * than the stored project, or unreadable, is removed.
 */
async function rescueFor(id: Id, storedAt: number | null, stored: Project | null): Promise<Project | null> {
  const store = rescueStore();
  const head = store?.header();
  if (!store || !head || head.id !== id) return null;
  const dbId = await databaseId();
  if (!head.dbId || head.dbId !== dbId) {
    // From an earlier database (erased since): it must never come back.
    if (dbId) store.clear();
    return null;
  }
  if (storedAt !== null && head.updatedAt < storedAt) {
    store.clear();
    return null;
  }
  const copy = store.read();
  if (!copy) return null;
  const checked = validateProject(copy.project);
  if (!checked.ok || checked.project.id !== id) {
    store.clear();
    return null;
  }
  // Same time as the stored copy: only a different state is worth taking back.
  if (storedAt !== null && head.updatedAt === storedAt && stored && JSON.stringify(stored) === JSON.stringify(checked.project)) {
    store.clear();
    return null;
  }
  if (!(await projectLockFree(id))) return null;
  return checked.project;
}

/** Store a taken-back rescue copy; the copy is removed once it is stored. Never throws: the project opens anyway. Returns whether it was stored. */
async function adoptRescue(project: Project): Promise<boolean> {
  try {
    await saveProject(project);
    rescueStore()?.clearIf(project.id, project.updatedAt);
    return true;
  } catch {
    // Not stored (storage full…): the copy stays for next time, and the project opens with the edits.
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

/** Load a stored project for editing, taking back its rescue copy when that is newer. */
async function openForEditing(id: Id): Promise<OpenedProject> {
  let loaded: Awaited<ReturnType<typeof loadProject>> | null = null;
  let failure: unknown = null;
  try {
    loaded = await loadProject(id);
  } catch (e) {
    if (!(e instanceof StorageError) || (e.kind !== 'not-found' && e.kind !== 'unknown')) throw e;
    failure = e;
  }
  // A damaged stored project can still be replaced by a readable rescue copy of it.
  const storedAt = loaded ? loaded.storedAt : failure instanceof StorageError && failure.kind === 'unknown' ? ((await loadProjectRecord(id))?.updatedAt ?? null) : null;
  if (loaded || storedAt !== null) {
    const rescued = await rescueFor(id, storedAt, loaded?.project ?? null);
    if (rescued) {
      if (storedAt !== null) setEditorBase(id, storedAt);
      const stored = await adoptRescue(rescued);
      return stored ? { project: rescued, warnings: [RESCUE_WARNING] } : { project: rescued, warnings: [RESCUE_WARNING], unsaved: true };
    }
  }
  if (!loaded) throw failure;
  setEditorBase(id, loaded.storedAt);
  return { project: loaded.project, warnings: loaded.warnings };
}

/**
 * A rescue copy of a project that was never stored (the first-launch
 * preview, changed just before the page closed), when it belongs to this
 * database and the project is neither stored nor in the trash.
 */
async function unstoredRescue(known: ReadonlySet<Id>): Promise<OpenedProject | null> {
  const head = rescueStore()?.header();
  if (!head || known.has(head.id)) return null;
  const trashed = (await dbListTrash()).some((t) => t.id === head.id);
  if (trashed) return null;
  const project = await rescueFor(head.id, null, null);
  if (!project) return null;
  try {
    await saveProject(project);
    await setLastProject(project.id);
    rescueStore()?.clearIf(project.id, project.updatedAt);
  } catch {
    // Opens anyway (not stored yet); the copy stays until it is.
    return { project, warnings: [RESCUE_WARNING], unsaved: true };
  }
  return { project, warnings: [RESCUE_WARNING] };
}

/**
 * Reopen the last project, falling back to the most recently edited one.
 * Returns null when the library is empty. A stored project that can no longer
 * be read is skipped in favour of the next most recent readable one, and the
 * result's warnings say which project could not be opened and why. Rejects
 * (StorageError 'unknown', the reasons in `cause`) when projects exist but
 * none can be read, and with the storage error when storage itself fails.
 * Takes back a newer rescue copy (warning RESCUE_WARNING).
 */
export async function openLast(): Promise<OpenedProject | null> {
  const lastId = await getMeta<string>(META_LAST_PROJECT);
  const summaries = await dbListProjects();
  const rescued = await unstoredRescue(new Set(summaries.map((s) => s.id)));
  if (rescued) return rescued;
  const candidates: Id[] = [];
  if (typeof lastId === 'string') candidates.push(lastId);
  for (const s of summaries) if (!candidates.includes(s.id)) candidates.push(s.id);
  const skipped: string[] = [];
  for (const id of candidates) {
    try {
      const opened = await openForEditing(id);
      if (id !== lastId) await setLastProject(id);
      return skipped.length ? { ...opened, warnings: [...skipped, ...opened.warnings] } : opened;
    } catch (e) {
      if (!(e instanceof StorageError) || (e.kind !== 'not-found' && e.kind !== 'unknown')) throw e;
      // A remembered id whose project was deleted is not worth a message; a damaged project is.
      if (e.kind === 'unknown') {
        const name = summaries.find((s) => s.id === id)?.name;
        const reason = Array.isArray(e.cause) && typeof e.cause[0] === 'string' ? e.cause[0] : e.message;
        skipped.push(`${name ? `"${name}"` : 'A saved project'} could not be opened (${reason}), so the most recent readable project was opened instead. It is still in the library.`);
      }
    }
  }
  // Projects exist but none can be read: say so instead of looking like an empty library.
  if (skipped.length) throw new StorageError('unknown', UNREADABLE_LIBRARY_MESSAGE, { cause: skipped });
  return null;
}

/**
 * True for openLast's rejection when projects are stored but none can be
 * read. Storage itself works then, so saving is still possible.
 */
export function isUnreadableLibrary(e: unknown): e is StorageError {
  return e instanceof StorageError && e.kind === 'unknown' && e.message === UNREADABLE_LIBRARY_MESSAGE;
}

/** Open a stored project and remember it as the last one. Takes back a newer rescue copy (warning RESCUE_WARNING). */
export async function openProject(id: Id): Promise<OpenedProject> {
  const opened = await openForEditing(id);
  await setLastProject(id);
  return opened;
}

/* ------------------------------------------------------------------ */
/* New projects                                                        */
/* ------------------------------------------------------------------ */

/**
 * Start a new project from a starter (or blank) project. The currently open
 * project is saved first so nothing is lost (unless another tab saved newer
 * work to it, which is kept), then the starter is stored under a fresh id and
 * a name no other project has ("House Starter 2", "… 3") and becomes the last
 * project. `replaced` is the project that was open (it stays in My projects),
 * or null.
 */
export async function createFromStarter(starter: Project, current: Project | null, opts: { name?: string; now?: number } = {}): Promise<StarterResult> {
  if (current) {
    try {
      await saveProject(current);
    } catch (e) {
      // Another tab saved newer work to it: that stays, and this tab's older copy is not written.
      if (!(e instanceof StorageError && e.kind === 'conflict')) throw e;
    }
  }
  const name = uniqueName(opts.name ?? starter.name, await listProjectNames());
  const project = duplicateData(starter, name, opts.now ?? Date.now());
  await saveProject(project);
  await setLastProject(project.id);
  return { project, replaced: current ? { id: current.id, name: current.name } : null };
}

/** Store a project (e.g. an imported bundle) as a new library entry and make it the last project. */
export async function addToLibrary(project: Project): Promise<void> {
  await saveProject(project);
  await setLastProject(project.id);
}

/**
 * Store a copy of `project` as it is now (e.g. the state on screen in a tab
 * that may not save it) under a new id and a free name ("Song copy"). The
 * copy shares the stored recordings. Returns it; it is not opened.
 */
export async function saveCopy(project: Project, opts: { name?: string; now?: number } = {}): Promise<Project> {
  const name = uniqueName(opts.name ?? `${project.name} copy`, await listProjectNames());
  const copy = duplicateData(project, name, opts.now ?? Date.now());
  await saveProject(copy);
  return copy;
}

/** Keep a version of a stored project as it is stored now (for the open project, version the store's state instead). */
export async function saveStoredVersion(id: Id, opts: SaveVersionOptions = {}): Promise<VersionSummary> {
  const { project } = await loadProject(id);
  return saveVersion(project, opts);
}

/** Rename a stored project (not the open one: use the renameProject command for that). */
export async function renameProject(id: Id, name: string, now: number = Date.now()): Promise<void> {
  const n = cleanName(name);
  if (!n) throw new StorageError('unknown', 'A project needs a name.');
  const rec = await loadProjectRecord(id);
  if (!rec) throw new StorageError('not-found', 'That project is no longer in this browser.');
  await saveProject({ ...rec.data, name: n, updatedAt: now }, { base: rec.updatedAt });
}

/** Copy a stored project under a new id and a free name ("Song copy", "Song copy 2"). The copy shares the stored recordings. */
export async function duplicateProject(id: Id, name?: string, now: number = Date.now()): Promise<Project> {
  const { project } = await loadProject(id);
  const copy = duplicateData(project, name ? cleanName(name) : uniqueName(`${project.name} copy`, await listProjectNames()), now);
  await saveProject(copy);
  return copy;
}

/** Move a project (and its versions) to the trash. If it was the last-opened project, that memory is cleared. */
export async function deleteProject(id: Id): Promise<void> {
  await deleteProjectToTrash(id);
  // A rescue copy of it must not bring it back as a new project later.
  rescueStore()?.clearIf(id, Number.POSITIVE_INFINITY);
  if ((await getMeta<string>(META_LAST_PROJECT)) === id) await deleteMeta(META_LAST_PROJECT);
}

/** Bring a project back from the trash, with its versions. */
export async function restoreProject(id: Id): Promise<ProjectSummary> {
  return restoreFromTrash(id);
}

/** Permanently delete a trashed project and its versions. */
export async function deleteForever(id: Id): Promise<void> {
  await purgeTrash(id);
}

export function listProjects(): Promise<ProjectSummary[]> {
  return dbListProjects();
}

export function listTrash(): Promise<TrashSummary[]> {
  return dbListTrash();
}

/** A fresh project id (for imports that must not replace an existing project). */
export function newProjectId(): Id {
  return uid('proj');
}

/** Short explanation for the library screen. */
export const LIBRARY_STORAGE_NOTE =
  'Projects are kept in this browser as working storage. Export a project file (.omnisong.zip) as your portable backup — clearing browser data removes stored projects.';
