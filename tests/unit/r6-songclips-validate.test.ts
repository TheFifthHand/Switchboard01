/**
 * Song clips (schema v5) on load: checked like pad clips, ids unique, at most
 * MAX_SONG_CLIPS per part, loops no region plays removed with a plain
 * warning; version-4 projects load unchanged; a project file keeps them.
 */
import { describe, expect, it } from 'vitest';
import { exportBundle, importBundle } from '../../src/persistence/bundle';
import { sampleIdsOf } from '../../src/persistence/db';
import { createProject } from '../../src/project/factory';
import { MAX_SONG_CLIPS, type Clip, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';

const loop = (id: string, extra: Partial<Clip> = {}): Clip => ({ id, name: id, bars: 1, notes: [{ id: `${id}_n`, tick: 0, pitch: 48, velocity: 0.8, duration: 24 }], ...extra });
const region = (id: string, clipId: string, start: number, trackId = 't3') => ({ id, trackId, clipId, start, bars: 1, offset: 0 });

/** Raw project data with song clips on Bass (t3) and loops playing `played`. */
function raw(songClips: unknown, played: string[]): Record<string, unknown> {
  const p = JSON.parse(JSON.stringify(createProject({ now: 0 }))) as Project & Record<string, unknown>;
  (p.tracks[2] as unknown as Record<string, unknown>).songClips = songClips;
  p.arrangement.regions = played.map((c, i) => region(`rg${i}`, c, i));
  return p;
}

function load(data: unknown) {
  const r = validateProject(data);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r;
}

describe('validating song clips', () => {
  it('keeps song clips the song plays, unchanged and without warnings', () => {
    const r = load(raw([loop('a'), loop('b', { variation: { seed: 4, generation: 2 } })], ['a', 'b']));
    expect(r.warnings).toEqual([]);
    expect(r.project.tracks[2].songClips).toEqual([loop('a'), loop('b', { variation: { seed: 4, generation: 2 } })]);
    expect(r.project.arrangement.regions.map((x) => x.clipId)).toEqual(['a', 'b']);
  });

  it('an empty or missing list leaves the field out', () => {
    expect(load(raw([], [])).project.tracks[2].songClips).toBeUndefined();
    expect(load(raw(undefined, [])).project.tracks[2]).not.toHaveProperty('songClips');
    expect(load(raw([], [])).warnings).toEqual([]);
  });

  it('removes a loop nothing in the song plays, saying so', () => {
    const r = load(raw([loop('a'), loop('b')], ['b']));
    expect(r.project.tracks[2].songClips?.map((c) => c.id)).toEqual(['b']);
    expect(r.warnings).toContain('Removed a loop that nothing in the song played.');
  });

  it('a repeated id gets a new one and the song keeps playing the first clip with it', () => {
    const data = raw([loop('a'), loop('a', { name: 'second' })], ['a']);
    // The second clip gets a new id that no loop plays, so it leaves the part too.
    const r = load(data);
    expect(r.warnings).toContain('Gave a clip a new id.');
    expect(r.project.tracks[2].songClips?.map((c) => c.name)).toEqual(['a']);
    // A pad clip with the same id as a song clip keeps its id: pads are checked first.
    const d2 = raw([loop('pad')], ['pad']);
    (d2.tracks as Project['tracks'])[2].clips[0] = loop('pad', { name: 'on the pad' });
    const r2 = load(d2);
    expect(r2.project.tracks[2].clips[0]?.id).toBe('pad');
    expect(r2.project.arrangement.regions[0].clipId).toBe('pad');
    expect(r2.project.tracks[2].songClips).toBeUndefined();
  });

  it('checks notes like a pad clip and drops a damaged song clip instead of failing the project', () => {
    const r = load(raw([loop('a', { notes: [{ id: 'x', tick: 9999, pitch: 48, velocity: 1, duration: 24 }] }), { id: 'bad', bars: 99, notes: [] }, 'junk'], ['a', 'bad']));
    expect(r.project.tracks[2].songClips?.map((c) => [c.id, c.notes.length])).toEqual([['a', 0]]);
    expect(r.warnings).toContain('Removed a note outside its clip.');
    expect(r.warnings.some((w) => w.startsWith('Removed a damaged loop from the song.'))).toBe(true);
    expect(r.project.arrangement.regions.map((x) => x.clipId)).toEqual(['a']);
    expect(load(raw('nope', [])).warnings).toContain('Removed a damaged list of loops from the song.');
  });

  it('keeps at most MAX_SONG_CLIPS per part', () => {
    const many = Array.from({ length: MAX_SONG_CLIPS + 3 }, (_, i) => loop(`c${i}`));
    const r = load(raw(many, many.map((c) => c.id)));
    expect(r.project.tracks[2].songClips).toHaveLength(MAX_SONG_CLIPS);
    expect(r.project.arrangement.regions).toHaveLength(MAX_SONG_CLIPS);
    expect(r.warnings).toContain(`Removed loops beyond the limit of ${MAX_SONG_CLIPS} for one part from the song.`);
  });

  it('a song clip’s own recording must be in the project', () => {
    const r = load(raw([loop('a', { sample: { id: 'smp_missing', start: 0, end: 1, rootNote: 60 } })], ['a']));
    expect(r.project.tracks[2].songClips?.[0].sample).toBeUndefined();
  });

  it('a loop of another part’s song clip is removed', () => {
    const data = raw([loop('a')], []);
    (data.arrangement as Project['arrangement']).regions = [region('rg', 'a', 0, 't5')];
    const r = load(data);
    expect(r.warnings).toContain('Removed a loop that played another part’s clip.');
    expect(r.project.tracks[2].songClips).toBeUndefined();
  });

  it('a take’s starting state leaves song clips out', () => {
    const data = raw([loop('a')], ['a']);
    const snap = JSON.parse(JSON.stringify(data));
    (data.performances as unknown[]) = [{ id: 'perf', name: 'Take', createdAt: 0, startTick: 0, endTick: 96, snapshot: { ...snap, launcher: [], seed: 1 }, events: [] }];
    const r = load(data);
    expect(r.project.performances[0].snapshot.tracks[2].songClips).toBeUndefined();
    expect(r.project.tracks[2].songClips).toHaveLength(1);
  });
});

describe('older projects and files', () => {
  it('a version-4 project loads unchanged (no song clips)', () => {
    const v4 = { ...JSON.parse(JSON.stringify(createProject({ now: 0 }))), version: 4 };
    const r = load(v4);
    expect(r.warnings).toEqual([]);
    expect(r.project.version).toBe(5);
    expect({ ...r.project, version: 4 }).toEqual(v4);
  });

  it('a project file keeps song clips (save, then open)', async () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    cmd.addLoopToSong(store, 't3', 2, { bars: 2, notes: [{ tick: 0, pitch: 40, velocity: 1, duration: 48 }] });
    cmd.addLoopToSong(store, 't5', 0, { bars: 1, name: 'Hook' });
    const p = store.getState();
    const blob = await exportBundle(p, async () => null);
    const back = await importBundle(blob);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.warnings).toEqual([]);
    expect(back.project.tracks.map((t) => t.songClips)).toEqual(p.tracks.map((t) => t.songClips));
    expect(back.project.arrangement).toEqual(p.arrangement);
  });

  it('a recording only a song clip plays counts as used (kept by storage clean-up)', () => {
    const p = load(raw([loop('a', { sample: { id: 'builtin:none', start: 0, end: 1, rootNote: 60 } })], ['a'])).project;
    const data = JSON.parse(JSON.stringify(p));
    data.tracks[2].songClips[0].sample = { id: 'smp_song', start: 0, end: 1, rootNote: 60 };
    expect(sampleIdsOf(data).has('smp_song')).toBe(true);
  });
});
