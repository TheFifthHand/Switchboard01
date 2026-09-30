/**
 * Project library over db.ts: open the last project, create from a starter,
 * rename, duplicate, delete to trash and restore.
 *
 * The open project is edited through the ProjectStore; library operations on
 * it (rename) should go through the store's commands so autosave and the
 * library never disagree. These functions operate on stored projects.
 */
import { duplicateProject as duplicateData } from '../project/clone';
import { uid } from '../project/factory';
import type { Id, Project } from '../project/types';
import {
  META_LAST_PROJECT,
  StorageError,
  deleteMeta,
  deleteProjectToTrash,
  getMeta,
  listProjects as dbListProjects,
  listTrash as dbListTrash,
  loadProject,
  loadProjectRecord,
  purgeTrash,
  restoreFromTrash,
  saveProject,
  setMeta,
  type ProjectSummary,
  type TrashSummary,
} from './db';

export type { ProjectSummary, TrashSummary };

export interface OpenedProject {
  project: Project;
  warnings: string[];
}

/** Remember which project to reopen next time. */
export async function setLastProject(id: Id): Promise<void> {
  await setMeta(META_LAST_PROJECT, id);
}

const UNREADABLE_LIBRARY_MESSAGE = 'None of the saved projects in this browser could be opened. They are still in the library.';

/**
 * Reopen the last project, falling back to the most recently edited one.
 * Returns null when the library is empty. A stored project that can no longer
 * be read is skipped in favour of the next most recent readable one, and the
 * result's warnings say which project could not be opened and why. Rejects
 * (StorageError 'unknown', the reasons in `cause`) when projects exist but
 * none can be read, and with the storage error when storage itself fails.
 */
export async function openLast(): Promise<OpenedProject | null> {
  const lastId = await getMeta<string>(META_LAST_PROJECT);
  const summaries = await dbListProjects();
  const candidates: Id[] = [];
  if (typeof lastId === 'string') candidates.push(lastId);
  for (const s of summaries) if (!candidates.includes(s.id)) candidates.push(s.id);
  const skipped: string[] = [];
  for (const id of candidates) {
    try {
      const opened = await loadProject(id);
      if (id !== lastId) await setLastProject(id);
      return skipped.length ? { project: opened.project, warnings: [...skipped, ...opened.warnings] } : opened;
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

/** Open a stored project and remember it as the last one. */
export async function openProject(id: Id): Promise<OpenedProject> {
  const opened = await loadProject(id);
  await setLastProject(id);
  return opened;
}

/**
 * Start a new project from a starter (or blank) project. The currently open
 * project is saved first so nothing is lost, then the starter is stored under
 * a fresh id and becomes the last project. Returns the new project.
 */
export async function createFromStarter(starter: Project, current: Project | null, opts: { name?: string; now?: number } = {}): Promise<Project> {
  if (current) await saveProject(current);
  const project = duplicateData(starter, opts.name ?? starter.name, opts.now ?? Date.now());
  await saveProject(project);
  await setLastProject(project.id);
  return project;
}

/** Store a project (e.g. an imported bundle) as a new library entry and make it the last project. */
export async function addToLibrary(project: Project): Promise<void> {
  await saveProject(project);
  await setLastProject(project.id);
}

/** Rename a stored project (not the open one: use the renameProject command for that). */
export async function renameProject(id: Id, name: string, now: number = Date.now()): Promise<void> {
  const n = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!n) throw new StorageError('unknown', 'A project needs a name.');
  const rec = await loadProjectRecord(id);
  if (!rec) throw new StorageError('not-found', 'That project is no longer in this browser.');
  await saveProject({ ...rec.data, name: n, updatedAt: now });
}

/** Copy a stored project under a new id. The copy shares the stored recordings. */
export async function duplicateProject(id: Id, name?: string, now: number = Date.now()): Promise<Project> {
  const { project } = await loadProject(id);
  const copy = duplicateData(project, name ?? `${project.name} copy`.slice(0, 80), now);
  await saveProject(copy);
  return copy;
}

/** Move a project to the trash. If it was the last-opened project, that memory is cleared. */
export async function deleteProject(id: Id): Promise<void> {
  await deleteProjectToTrash(id);
  if ((await getMeta<string>(META_LAST_PROJECT)) === id) await deleteMeta(META_LAST_PROJECT);
}

/** Bring a project back from the trash. */
export async function restoreProject(id: Id): Promise<ProjectSummary> {
  return restoreFromTrash(id);
}

/** Permanently delete a trashed project. */
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
  'Projects are kept in this browser as working storage. Export a project file (.sb01.zip) as your portable backup — clearing browser data removes stored projects.';
