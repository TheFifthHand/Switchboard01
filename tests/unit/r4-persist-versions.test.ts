/**
 * Version history (capability-06), the database upgrade that adds it,
 * thinning, garbage collection that keeps the recordings versions use,
 * versions travelling with a trashed project, automatic versions while
 * editing; and unique names for new projects (shell-02 / shell-16) and the
 * library rows' song facts.
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosaver } from '../../src/persistence/autosave';
import {
  DB_NAME,
  databaseId,
  deleteDb,
  garbageCollectSamples,
  getMeta,
  getSample,
  listProjects,
  listSampleIds,
  listTrash,
  loadProjectRecord,
  putSample,
  saveProject,
  sampleIdsOf,
} from '../../src/persistence/db';
import * as library from '../../src/persistence/library';
import { uniqueName } from '../../src/persistence/names';
import { formatClock, projectShape, songLine } from '../../src/persistence/summary';
import { MAX_UNNAMED_VERSIONS, reasonBefore, restoredName, versionLabel, versionsToThin } from '../../src/persistence/versions';
import { getStarter } from '../../src/content/starters';
import { createProject } from '../../src/project/factory';
import type { Project, SampleMeta } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const meta = (id: string): SampleMeta => ({ id, name: id, mime: 'audio/wav', byteLength: 3, duration: 0.1, sampleRate: 44100, channels: 1 });
const bytes = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

/** A project whose Vocal (sampler) part plays the recording `sampleId`. */
function withRecording(name: string, sampleId: string, now = 1000): Project {
  const p = createProject({ name, now });
  const inst = p.tracks[7].instrument;
  if (inst.kind === 'sampler') inst.sampleId = sampleId;
  p.samples.push(meta(sampleId));
  return p;
}

beforeEach(async () => {
  await deleteDb();
});

describe('database upgrade', () => {
  it('opens a version-1 database with everything in it and adds the versions store', async () => {
    // What SWITCHBOARD / 01 and Omni Song 2.0 stored (database version 1).
    const old = withRecording('Old Song', 'smp_old', 1000);
    const trashed = createProject({ name: 'Trashed', now: 900 });
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('updatedAt', 'updatedAt');
        db.createObjectStore('samples', { keyPath: 'id' });
        db.createObjectStore('meta');
        db.createObjectStore('trash', { keyPath: 'id' });
      },
    });
    await v1.put('projects', { id: old.id, name: old.name, updatedAt: old.updatedAt, createdAt: old.createdAt, data: old });
    await v1.put('samples', { id: 'smp_old', meta: meta('smp_old'), blob: bytes(), addedAt: 0 });
    await v1.put('meta', old.id, 'lastProjectId');
    await v1.put('trash', { id: trashed.id, deletedAt: 950, record: { id: trashed.id, name: 'Trashed', updatedAt: 900, createdAt: 900, data: trashed } });
    v1.close();

    // Version 2 opens it: nothing is lost.
    const opened = await library.openLast();
    expect(opened!.project).toMatchObject({ id: old.id, name: 'Old Song' });
    expect((await listProjects()).map((s) => s.name)).toEqual(['Old Song']);
    expect((await listTrash()).map((t) => t.name)).toEqual(['Trashed']);
    expect(await getMeta('lastProjectId')).toBe(old.id);
    expect((await getSample('smp_old'))!.meta.id).toBe('smp_old');
    expect(await databaseId()).toMatch(/^db_/);
    // The new store works, and the trashed project comes back as before.
    await library.saveVersion(opened!.project, { name: 'After the upgrade' });
    expect((await library.listVersions(old.id)).map((v) => v.name)).toEqual(['After the upgrade']);
    expect((await library.restoreProject(trashed.id)).name).toBe('Trashed');
    const raw = await openDB(DB_NAME);
    expect(raw.version).toBe(2);
    expect([...raw.objectStoreNames].sort()).toEqual(['meta', 'projects', 'samples', 'trash', 'versions']);
    raw.close();
  });

  it('a new database gets a new identity', async () => {
    const first = await databaseId();
    await deleteDb();
    const second = await databaseId();
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});

describe('versions', () => {
  it('saves, lists newest first, restores as a new project and deletes', async () => {
    const p = createProject({ name: 'Song', now: 1000 });
    await saveProject(p);
    const t0 = new Date(2026, 9, 2, 10, 42).getTime();
    const named = await library.saveVersion(p, { name: '  Before   mixing ', now: t0 });
    expect(named).toMatchObject({ projectId: p.id, name: 'Before mixing', reason: 'manual', summary: songLine(projectShape(p)), createdAt: t0 });
    const later = { ...p, bpm: 99, updatedAt: 2000 };
    await library.saveVersion(later, { reason: 'auto', now: t0 + 60_000 });
    // An unnamed version of a state already kept adds nothing.
    await library.saveVersion(later, { reason: reasonBefore('project:Variation'), now: t0 + 120_000 });
    const list = await library.listVersions(p.id);
    expect(list.map((v) => versionLabel(v))).toEqual(['Autosaved while editing', 'Before mixing']);

    const copy = await library.restoreVersionAsCopy(named.id, { now: t0 + 5 * 60_000 });
    expect(copy.id).not.toBe(p.id);
    expect(copy.name).toBe('Song (10:42)');
    expect(copy.bpm).toBe(p.bpm);
    expect((await loadProjectRecord(copy.id))!.data.tracks).toEqual(JSON.parse(JSON.stringify(p.tracks)));
    // The original and its versions are untouched; a second restore gets its own name.
    expect((await loadProjectRecord(p.id))!.data.bpm).toBe(p.bpm);
    expect((await library.restoreVersionAsCopy(named.id, { now: t0 + 6 * 60_000 })).name).toBe('Song (10:42) 2');

    await library.deleteVersion(named.id);
    expect((await library.listVersions(p.id)).map((v) => v.reason)).toEqual(['auto']);
    await expect(library.restoreVersionAsCopy(named.id)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('labels, reasons and restored names', () => {
    expect(reasonBefore('project:Variation')).toBe('before:Variation');
    expect(versionLabel({ reason: 'before:Clear notes' })).toBe('Before Clear notes');
    expect(versionLabel({ reason: 'manual' })).toBe('Saved by you');
    expect(versionLabel({ name: 'Drop idea', reason: 'manual' })).toBe('Drop idea');
    const now = new Date(2026, 9, 2, 18, 0).getTime();
    expect(restoredName('House Starter', new Date(2026, 9, 2, 9, 5).getTime(), now)).toBe('House Starter (09:05)');
    expect(restoredName('House Starter', new Date(2026, 8, 12, 9, 5).getTime(), now)).toMatch(/^House Starter \(.*12.* 09:05\)$/);
  });
});

describe('thinning', () => {
  const now = new Date(2026, 9, 20, 12, 30).getTime();
  const v = (id: string, ago: number, name?: string) => ({ id, createdAt: now - ago, ...(name ? { name } : {}) });

  it('keeps every version of the last hour, then one per clock hour for a day, then one per day', () => {
    const list = [
      v('m5', 5 * 60_000),
      v('m20', 20 * 60_000),
      v('m50', 50 * 60_000),
      // 11:xx is past the hour for some, so the hour buckets start after the last hour.
      v('h2a', 2 * HOUR + 5 * 60_000),
      v('h2b', 2 * HOUR + 20 * 60_000),
      v('h5', 5 * HOUR),
      v('d2a', 2 * DAY),
      v('d2b', 2 * DAY + 60_000),
      v('d3', 3 * DAY),
    ];
    const drop = versionsToThin(list, now);
    expect(drop.sort()).toEqual(['d2b', 'h2b']);
  });

  it('never drops named versions and keeps at most 30 unnamed ones', () => {
    const list = [...Array.from({ length: 40 }, (_, i) => v(`d${i}`, (i + 2) * DAY)), v('named-old', 400 * DAY, 'Keep me'), v('named-new', 60_000, 'Me too')];
    const drop = versionsToThin(list, now);
    expect(drop).toHaveLength(40 - MAX_UNNAMED_VERSIONS);
    expect(drop).not.toContain('named-old');
    expect(drop).not.toContain('named-new');
    // The oldest go.
    expect(drop).toContain('d39');
    expect(drop).not.toContain('d0');
  });

  it('saveVersion thins as it goes', async () => {
    const p = createProject({ name: 'Song', now: 1 });
    await saveProject(p);
    await library.saveVersion(p, { name: 'Named', now: now - 100 * DAY });
    for (let i = 35; i >= 1; i--) await library.saveVersion({ ...p, updatedAt: 100 + i }, { reason: 'auto', now: now - i * DAY });
    const list = await library.listVersions(p.id);
    expect(list.filter((x) => !x.name)).toHaveLength(MAX_UNNAMED_VERSIONS);
    expect(list.some((x) => x.name === 'Named')).toBe(true);
  });
});

describe('recordings, the trash and garbage collection', () => {
  it('a version keeps its recording through a GC pass and restores as a new project with it', async () => {
    const p = withRecording('Song', 'smp_take1');
    await saveProject(p);
    await putSample(meta('smp_take1'), bytes(), 0);
    const kept = await library.saveVersion(p, { name: 'With take 1' });
    // The project moves on without that recording.
    const moved = createProject({ name: 'Song', now: 5000 });
    await saveProject({ ...moved, id: p.id });
    expect(await garbageCollectSamples({ graceMs: 1000, now: 10_000_000 })).toEqual([]);
    expect(await listSampleIds()).toEqual(['smp_take1']);
    const copy = await library.restoreVersionAsCopy(kept.id);
    expect(sampleIdsOf(copy).has('smp_take1')).toBe(true);
    expect([...new Uint8Array(await (await getSample('smp_take1'))!.blob.arrayBuffer())]).toEqual([1, 2, 3]);
    // Once nothing refers to it any more, it goes.
    await library.deleteVersion(kept.id);
    await library.deleteProject(copy.id);
    await library.deleteForever(copy.id);
    expect(await garbageCollectSamples({ graceMs: 1000, now: 10_000_000 })).toEqual(['smp_take1']);
  });

  it('counts recordings that clips play themselves (per-clip samples)', () => {
    const p = createProject({ name: 'Clips', now: 1 });
    const clip = { id: 'clip_x', name: 'Take', bars: 1, notes: [], sample: { id: 'smp_clip', start: 0, end: 1, rootNote: 60 } };
    (p.tracks[7].clips as unknown[])[0] = clip;
    expect(sampleIdsOf(p).has('smp_clip')).toBe(true);
  });

  it('a trashed project carries its versions; restoring brings them back; deleting forever removes them', async () => {
    const p = withRecording('Song', 'smp_v');
    await saveProject(p);
    await putSample(meta('smp_v'), bytes(), 0);
    await library.saveVersion(p, { name: 'One' });
    await saveProject({ ...createProject({ name: 'Song', now: 3000 }), id: p.id });
    const other = createProject({ name: 'Other', now: 4000 });
    await saveProject(other);

    await library.deleteProject(p.id);
    expect(await library.listVersions(p.id)).toEqual([]);
    // In the trash, its versions still hold their recordings.
    expect(await garbageCollectSamples({ graceMs: 0, now: 10_000_000 })).toEqual([]);
    await library.restoreProject(p.id);
    expect((await library.listVersions(p.id)).map((x) => x.name)).toEqual(['One']);

    // Restored while a live project took the id: the versions follow the restored copy.
    await library.deleteProject(p.id);
    await saveProject({ ...createProject({ name: 'Same id again', now: 5000 }), id: p.id });
    const back = await library.restoreProject(p.id);
    expect(back.id).not.toBe(p.id);
    expect((await library.listVersions(back.id)).map((x) => x.name)).toEqual(['One']);
    expect(await library.listVersions(p.id)).toEqual([]);

    await library.deleteProject(back.id);
    await library.deleteForever(back.id);
    expect(await library.listVersions(back.id)).toEqual([]);
    expect(await garbageCollectSamples({ graceMs: 0, now: 10_000_000 })).toEqual(['smp_v']);
  });

  it('versions of a project that was never stored are removed once old enough', async () => {
    const preview = createProject({ name: 'Preview', now: 1 });
    await library.saveVersion(preview, { reason: reasonBefore('Variation'), now: 1000 });
    await garbageCollectSamples({ graceMs: 60_000, now: 30_000 });
    expect(await library.listVersions(preview.id)).toHaveLength(1);
    await garbageCollectSamples({ graceMs: 60_000, now: 100_000 });
    expect(await library.listVersions(preview.id)).toEqual([]);
  });
});

describe('automatic versions while editing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('after about ten minutes of editing; idle time does not count', async () => {
    let t = 0;
    const store = new ProjectStore(createProject({ now: 0 }), { now: () => t });
    const kept: { reason: string; bpm: number }[] = [];
    const auto = createAutosaver({
      store,
      save: async () => undefined,
      now: () => t,
      debounceMs: 100,
      tab: null,
      rescue: null,
      events: { document: null, window: null },
      versions: { save: async (p, o) => void kept.push({ reason: o.reason, bpm: p.bpm }) },
    });
    const editFor = async (minutes: number, every = 30_000) => {
      for (let i = 0; i < (minutes * 60_000) / every; i++) {
        t += every;
        store.apply('project:Change tempo', (d) => void (d.bpm = 60 + ((d.bpm + 1) % 100)));
        await vi.advanceTimersByTimeAsync(200);
      }
    };
    await editFor(9);
    expect(kept).toEqual([]);
    // A long break is not editing.
    t += 60 * 60_000;
    await editFor(0.5);
    expect(kept).toEqual([]);
    await editFor(2);
    expect(kept).toHaveLength(1);
    expect(kept[0].reason).toBe('auto');
    await editFor(5);
    expect(kept).toHaveLength(1);
    await auto.dispose();
  });
});

describe('names and row facts', () => {
  it('four Jump Ins make House Starter, 2, 3 and 4; each says which project it replaced', async () => {
    const house = getStarter('house')!;
    let current: Project | null = null;
    const names: string[] = [];
    const replaced: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await library.createFromStarter(house.build(), current);
      names.push(res.project.name);
      replaced.push(res.replaced?.name ?? null);
      current = res.project;
    }
    expect(names).toEqual(['House Starter', 'House Starter 2', 'House Starter 3', 'House Starter 4']);
    expect(replaced).toEqual([null, 'House Starter', 'House Starter 2', 'House Starter 3']);
    // A name in the trash counts as taken too.
    await library.deleteProject(current!.id);
    expect((await library.createFromStarter(house.build(), null)).project.name).toBe('House Starter 5');
  });

  it('copies get names that can be told apart', async () => {
    const p = createProject({ name: 'Song', now: 1 });
    await saveProject(p);
    expect((await library.duplicateProject(p.id)).name).toBe('Song copy');
    expect((await library.duplicateProject(p.id)).name).toBe('Song copy 2');
    expect((await library.saveCopy({ ...p, bpm: 77 })).name).toBe('Song copy 3');
    expect(uniqueName('house starter', ['House Starter', 'HOUSE STARTER 2'])).toBe('house starter 3');
    expect(uniqueName('x'.repeat(90), ['x'.repeat(80)])).toBe(`${'x'.repeat(78)} 2`);
  });

  it('rows know the song length and scene count', async () => {
    const house = getStarter('house')!.build();
    await saveProject(house);
    const [row] = await listProjects();
    const shape = projectShape(house);
    expect(row).toMatchObject({ sceneCount: house.scenes.length, blockCount: house.arrangement.blocks.length, songSeconds: shape.songSeconds });
    expect(shape.songSeconds).toBeGreaterThan(60);
    expect(formatClock(139.4)).toBe('2:19');
    expect(formatClock(7)).toBe('0:07');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(songLine({ blocks: 6, songSeconds: 139 })).toBe('6 blocks · 2:19');
    expect(songLine({ blocks: 0, songSeconds: 0 })).toBe('No song yet');
    // A damaged stored project still lists.
    expect(projectShape({ bogus: true } as unknown as Project)).toMatchObject({ blocks: 0, songSeconds: 0 });
  });
});
