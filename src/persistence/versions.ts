/**
 * Version history: saved states of a project that can be restored as a copy.
 *
 * - Versions are taken automatically while editing (autosave, about every
 *   ten minutes of active editing), before bulk edits (autosaver
 *   snapshotBefore) and on request ("Save version…", optionally named).
 * - Thinning: named versions are kept until deleted. Unnamed ones keep
 *   everything from the last hour, then the newest of each hour for a day,
 *   then the newest of each day, at most 30 per project.
 * - A version holds the whole project; recordings are shared by id (garbage
 *   collection keeps the ones versions use), never copied.
 * - A trashed project carries its versions; deleting it forever removes them.
 */
import { duplicateProject as duplicateData } from '../project/clone';
import { uid } from '../project/factory';
import type { Id, Project } from '../project/types';
import { validateProject } from '../project/validate';
import { StorageError, deleteVersions, getVersion, listProjectNames, listVersionSummaries, putVersion, saveProject, type VersionRecord, type VersionSummary } from './db';
import { cleanName, uniqueName } from './names';
import { projectShape, songLine } from './summary';

export type { VersionSummary };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Unnamed versions kept per project at most. */
export const MAX_UNNAMED_VERSIONS = 30;

export interface SaveVersionOptions {
  /** A name keeps the version until it is deleted. */
  name?: string;
  /** 'auto', 'manual' (default) or 'before:<edit>' (see reasonBefore). */
  reason?: string;
  now?: number;
}

/** The reason stored for a version taken before a bulk edit ("project:Variation" → 'before:Variation'). */
export function reasonBefore(label: string): string {
  const plain = label.replace(/^[a-z]+:/i, '').trim();
  return `before:${plain || 'a big change'}`;
}

/** What the version list shows for a version: its name, or why it was taken. */
export function versionLabel(v: { name?: string; reason: string }): string {
  if (v.name) return v.name;
  if (v.reason === 'auto') return 'Autosaved while editing';
  if (v.reason === 'manual') return 'Saved by you';
  if (v.reason.startsWith('before:')) return `Before ${v.reason.slice('before:'.length)}`;
  return v.reason;
}

const two = (n: number) => String(n).padStart(2, '0');

function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "10:42" today, "Yesterday 18:03", or "12 Sep 10:42". */
export function versionWhen(createdAt: number, now: number = Date.now()): string {
  const d = new Date(createdAt);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (localDay(createdAt) === localDay(now)) return `Today ${time}`;
  if (localDay(createdAt) === localDay(now - DAY)) return `Yesterday ${time}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })} ${time}`;
}

/** The name of a restored copy: "House Starter (10:42)", or with the date when it is not from today. */
export function restoredName(projectName: string, createdAt: number, now: number = Date.now()): string {
  const d = new Date(createdAt);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const when = localDay(createdAt) === localDay(now) ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
  const suffix = ` (${when})`;
  return `${cleanName(projectName, 80 - suffix.length) || 'Untitled'}${suffix}`;
}

/**
 * Which versions thinning removes (ids). Named versions stay. Unnamed ones,
 * newest first: all from the last hour; then the newest in each clock hour
 * up to a day old; then the newest of each day; at most `maxUnnamed`.
 */
export function versionsToThin(list: readonly { id: Id; createdAt: number; name?: string }[], now: number, maxUnnamed = MAX_UNNAMED_VERSIONS): Id[] {
  const unnamed = list.filter((v) => !v.name).sort((a, b) => b.createdAt - a.createdAt);
  const hours = new Set<number>();
  const days = new Set<string>();
  const drop: Id[] = [];
  let kept = 0;
  for (const v of unnamed) {
    const age = now - v.createdAt;
    let keep: boolean;
    if (age < HOUR) keep = true;
    else if (age < DAY) {
      const k = Math.floor(v.createdAt / HOUR);
      keep = !hours.has(k);
      hours.add(k);
    } else {
      const k = localDay(v.createdAt);
      keep = !days.has(k);
      days.add(k);
    }
    if (keep && kept < maxUnnamed) kept += 1;
    else drop.push(v.id);
  }
  return drop;
}

function summaryOf(v: VersionRecord): VersionSummary {
  const s: VersionSummary = { id: v.id, projectId: v.projectId, createdAt: v.createdAt, reason: v.reason, summary: v.summary, projectName: v.data.name, projectUpdatedAt: v.data.updatedAt };
  if (v.name) s.name = v.name;
  return s;
}

/**
 * Keep a version of `project`, then thin out its older unnamed versions.
 * An unnamed version of a state that is already kept adds nothing: the
 * existing version is returned instead.
 */
export async function saveVersion(project: Project, opts: SaveVersionOptions = {}): Promise<VersionSummary> {
  const now = opts.now ?? Date.now();
  const name = opts.name ? cleanName(opts.name) : '';
  const existing = await listVersionSummaries(project.id);
  if (!name) {
    const same = existing.find((v) => v.projectUpdatedAt === project.updatedAt);
    if (same) return same;
  }
  const rec: VersionRecord = {
    id: uid('ver'),
    projectId: project.id,
    createdAt: now,
    reason: opts.reason ?? 'manual',
    summary: songLine(projectShape(project)),
    data: project,
  };
  if (name) rec.name = name;
  await putVersion(rec);
  const summary = summaryOf(rec);
  await deleteVersions(versionsToThin([summary, ...existing], now));
  return summary;
}

/** A project's versions, newest first (without their data). */
export function listVersions(projectId: Id): Promise<VersionSummary[]> {
  return listVersionSummaries(projectId);
}

/**
 * Store a version as a new project (new id), named after the project and
 * the version's time ("House Starter (10:42)", numbered if taken). The
 * original project and the version stay as they are. Returns the new project.
 */
export async function restoreVersionAsCopy(versionId: Id, opts: { now?: number } = {}): Promise<Project> {
  const now = opts.now ?? Date.now();
  const v = await getVersion(versionId);
  if (!v) throw new StorageError('not-found', 'That version is no longer in this browser.');
  const checked = validateProject(v.data);
  if (!checked.ok) throw new StorageError('unknown', `This version could not be opened: ${checked.errors[0]}`, { cause: checked.errors });
  const name = uniqueName(restoredName(checked.project.name, v.createdAt, now), await listProjectNames());
  const copy = duplicateData(checked.project, name, now);
  await saveProject(copy);
  return copy;
}

export function deleteVersion(id: Id): Promise<void> {
  return deleteVersions([id]);
}
