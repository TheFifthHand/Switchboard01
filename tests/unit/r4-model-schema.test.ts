/**
 * Project schema v3: up to 8 scenes, clips of up to 8 bars, per-clip
 * recordings, song moves and designed big-knob positions. Version-2 projects
 * (and .sb01.zip files) still open, unchanged; an older build refuses a
 * version-3 project instead of losing what it cannot hold.
 */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { HOUSE } from '../../src/content/starters/house';
import { importBundle } from '../../src/persistence/bundle';
import { createClip, createProject } from '../../src/project/factory';
import { MIGRATIONS, NEWER_VERSION_MESSAGE, migrateProject, runMigrations } from '../../src/project/migrate';
import {
  CLIP_BAR_CHOICES,
  DEFAULT_SCENE_ROWS,
  MAX_CLIP_BARS,
  MAX_SCENES,
  MIN_SCENES,
  PROJECT_SCHEMA,
  PROJECT_VERSION,
  SCENE_ROWS,
  TICKS_PER_BAR,
  sceneCount,
  type Project,
} from '../../src/project/types';
import { VALIDATION_LIMITS, sanitizeClip, validateProject } from '../../src/project/validate';

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** A copy to damage on purpose (untyped JSON). */
const loose = (v: unknown) => JSON.parse(JSON.stringify(v));

function check(p: unknown) {
  const r = validateProject(json(p));
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r;
}

const sceneNames = (n: number) => Array.from({ length: n }, (_, i) => `Scene ${i + 1}`);

/** A version-2 House export, as the previous release wrote it (no designed positions, version 2). */
function houseV2(): Record<string, unknown> {
  const p = json(HOUSE.build()) as unknown as Record<string, unknown> & { tracks: Record<string, unknown>[] };
  for (const t of p.tracks) delete t.macroHome;
  p.version = 2;
  return p;
}

describe('schema v3 constants', () => {
  it('a project holds 1 to 8 scenes and clips of 1 to 8 bars; new projects start with 4 scenes', () => {
    expect(PROJECT_VERSION).toBe(3);
    expect([MIN_SCENES, MAX_SCENES, DEFAULT_SCENE_ROWS]).toEqual([1, 8, 4]);
    // The deprecated alias still names the default, so older view code compiles.
    expect(SCENE_ROWS).toBe(DEFAULT_SCENE_ROWS);
    expect(MAX_CLIP_BARS).toBe(8);
    expect(CLIP_BAR_CHOICES).toEqual([1, 2, 3, 4, 8]);
    expect(VALIDATION_LIMITS.maxNoteTicks).toBe(8 * TICKS_PER_BAR);
    const p = createProject({ now: 0 });
    expect(sceneCount(p)).toBe(4);
    expect(p.tracks.every((t) => t.clips.length === 4)).toBe(true);
    const six = createProject({ now: 0, scenes: sceneNames(6) });
    expect(six.scenes.map((s) => s.name)).toEqual(sceneNames(6));
    expect(six.tracks.every((t) => t.clips.length === 6)).toBe(true);
  });
});

describe('migration', () => {
  it('opens a version-2 House export unchanged and saves it as version 3', () => {
    const v2 = houseV2();
    const r = check(v2);
    expect(r.warnings).toEqual([]);
    expect(r.project.version).toBe(PROJECT_VERSION);
    expect({ ...r.project, version: 2 }).toEqual(v2);
    // Saved again, it is a version-3 project that opens as it is.
    expect(check(r.project).project).toEqual(r.project);
  });

  it('every step upgrades one version, and the step to 3 changes nothing', () => {
    expect(MIGRATIONS.map((m) => m.from)).toEqual([1, 2]);
    const v2 = houseV2();
    const m = migrateProject(v2);
    expect(m.ok && m.migrated).toBe(true);
    if (m.ok) expect({ ...m.data, version: 2 }).toEqual(v2);
  });

  it('an older build (made for version 2) refuses a version-3 project with the newer-version message', () => {
    const v3 = json(HOUSE.build());
    const olderBuild = runMigrations(v3, MIGRATIONS.filter((s) => s.from < 2), 2);
    expect(olderBuild).toEqual({ ok: false, error: NEWER_VERSION_MESSAGE });
    expect(NEWER_VERSION_MESSAGE).toBe('This project was made with a newer version of Omni Song.');
    // And this build refuses whatever comes after it.
    expect(validateProject({ ...v3, version: PROJECT_VERSION + 1 })).toEqual({ ok: false, errors: [NEWER_VERSION_MESSAGE] });
  });

  it('still imports a version-2 project from a .sb01.zip file', async () => {
    const v2 = houseV2();
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(v2)) });
    const r = await importBundle(new File([zip], 'House.sb01.zip', { type: 'application/zip' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.version).toBe(PROJECT_VERSION);
    expect(r.project.schema).toBe(PROJECT_SCHEMA);
    expect(r.project.tracks.map((t) => t.clips.map((c) => c?.name ?? null))).toEqual((v2.tracks as Project['tracks']).map((t) => t.clips.map((c) => c?.name ?? null)));
  });
});

describe('scenes: 1 to 8 per project, one clip slot per scene on every part', () => {
  it('accepts every count from 1 to 8 with matching slots, round-tripping exactly', () => {
    for (let n = MIN_SCENES; n <= MAX_SCENES; n++) {
      const p = createProject({ now: 0, scenes: sceneNames(n) });
      p.tracks[2].clips[n - 1] = createClip('Last row', 2, [{ tick: 0, pitch: 40, velocity: 1, duration: 96 }]);
      const r = check(p);
      expect(r.warnings, `${n} scenes`).toEqual([]);
      expect(r.project).toEqual(p);
    }
  });

  it('rejects 0 or 9 scenes, and parts whose slots do not match the scenes', () => {
    const none = json(createProject({ now: 0, scenes: sceneNames(1) }));
    none.scenes = [];
    for (const t of none.tracks) t.clips = [];
    expect(validateProject(none)).toEqual({ ok: false, errors: expect.arrayContaining(['The project must have 1 to 8 scenes.']) });

    const nine = json(createProject({ now: 0, scenes: sceneNames(8) }));
    nine.scenes.push({ id: 'scene_9', name: 'Nine' });
    for (const t of nine.tracks) t.clips.push(null);
    expect(validateProject(nine).ok).toBe(false);

    const mismatch = json(createProject({ now: 0, scenes: sceneNames(6) }));
    mismatch.tracks[3].clips.pop();
    const r = validateProject(mismatch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('Part 4 has 5 clip slots but the project has 6 scenes: every part needs one slot per scene.');
  });
});

describe('clips of up to 8 bars', () => {
  it('keeps 5- to 8-bar clips with notes and lengths up to 8 bars; refuses 9 bars', () => {
    const p = createProject({ now: 0 });
    const end = 8 * TICKS_PER_BAR;
    p.tracks[3].clips[0] = createClip('Long', 8, [
      { tick: 0, pitch: 60, velocity: 1, duration: end },
      { tick: end - 1, pitch: 62, velocity: 0.5, duration: 1 },
    ]);
    for (const bars of [5, 6, 7] as const) p.tracks[4].clips[bars - 5] = createClip(`${bars}`, bars, [{ tick: (bars - 1) * TICKS_PER_BAR, pitch: 70, velocity: 1, duration: 24 }]);
    const r = check(p);
    expect(r.warnings).toEqual([]);
    expect(r.project).toEqual(p);

    const bad = loose(p);
    bad.tracks[3].clips[0].bars = 9;
    const refused = validateProject(bad);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors).toContain('A clip has an invalid length (clips are 1 to 8 bars).');
    expect(sanitizeClip({ id: 'c', name: 'x', bars: 9, notes: [] }, 'poly').clip).toBeNull();
  });
});

describe('a clip that plays its own recording (Clip.sample)', () => {
  const withSample = () => {
    const p = createProject({ now: 0 });
    p.samples.push({ id: 'smp_take', name: 'Take', mime: 'audio/wav', byteLength: 10, duration: 2, sampleRate: 48000, channels: 1 });
    p.tracks[7].clips[0] = { ...createClip('Take', 2, [{ tick: 0, pitch: 60, velocity: 1, duration: 768 }]), sample: { id: 'smp_take', start: 0.1, end: 0.9, rootNote: 60 } };
    p.tracks[7].clips[1] = { ...createClip('Oh', 1), sample: { id: 'builtin:vocal-oh', start: 0, end: 1, rootNote: 64 } };
    return p;
  };

  it('keeps references to the project’s or built-in recordings, exactly', () => {
    const p = withSample();
    const r = check(p);
    expect(r.warnings).toEqual([]);
    expect(r.project).toEqual(p);
  });

  it('a reference to a recording the project lacks is dropped (the clip plays its part’s recording); the clip stays', () => {
    const p = loose(withSample());
    p.tracks[7].clips[0].sample.id = 'smp_gone';
    p.tracks[7].clips[1].sample.id = 'builtin:nothing';
    const r = check(p);
    expect(r.project.tracks[7].clips[0]!.sample).toBeUndefined();
    expect(r.project.tracks[7].clips[1]!.sample).toBeUndefined();
    expect(r.project.tracks[7].clips[0]!.notes).toHaveLength(1);
    expect(r.warnings).toContain('A clip referred to a recording that is not in the project; it plays its part’s recording instead. (2 times)');
  });

  it('repairs a region that is not valid and a root note out of range', () => {
    const p = loose(withSample());
    p.tracks[7].clips[0].sample = { id: 'smp_take', start: 0.8, end: 0.2, rootNote: 60 };
    p.tracks[7].clips[1].sample = { id: 'builtin:vocal-oh', start: -0.5, end: 1.5, rootNote: 200 };
    const r = check(p);
    expect(r.project.tracks[7].clips[0]!.sample).toEqual({ id: 'smp_take', start: 0, end: 1, rootNote: 60 });
    expect(r.project.tracks[7].clips[1]!.sample).toEqual({ id: 'builtin:vocal-oh', start: 0, end: 1, rootNote: 96 });
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('a pasted clip keeps its recording only when the target project has it', () => {
    const clip = withSample().tracks[7].clips[0]!;
    expect(sanitizeClip(clip, 'sampler', new Set(['smp_take'])).clip!.sample).toEqual(clip.sample);
    expect(sanitizeClip(clip, 'sampler', new Set()).clip!.sample).toBeUndefined();
  });
});

describe('song moves on blocks', () => {
  it('keeps one move of each kind, with parts for filter rise and echo throw', () => {
    const p = createProject({ now: 0 });
    p.arrangement.blocks[0].moves = [{ id: 'mv_a', kind: 'fadeIn' }];
    p.arrangement.blocks[2].moves = [
      { id: 'mv_b', kind: 'filterRise', parts: ['t4', 't5'] },
      { id: 'mv_c', kind: 'echoThrow' },
      { id: 'mv_d', kind: 'fadeOut' },
    ];
    const r = check(p);
    expect(r.warnings).toEqual([]);
    expect(r.project).toEqual(p);
  });

  it('drops unknown and repeated kinds, missing parts, parts on fades and repeated ids', () => {
    const p = loose(createProject({ now: 0 }));
    p.arrangement.blocks[0].moves = [
      { id: 'mv_a', kind: 'fadeIn', parts: ['t1'] },
      { id: 'mv_b', kind: 'spin' },
      { id: 'mv_c', kind: 'fadeIn' },
      { id: 'mv_d', kind: 'echoThrow', parts: ['t5', 'ghost', 't5'] },
      { id: 'mv_e', kind: 'filterRise', parts: ['ghost'] },
    ];
    p.arrangement.blocks[1].moves = [{ id: 'mv_a', kind: 'fadeOut' }];
    p.arrangement.blocks[2].moves = 'everything';
    const r = check(p);
    const [a, b, c] = r.project.arrangement.blocks;
    expect(a.moves).toEqual([
      { id: 'mv_a', kind: 'fadeIn' },
      { id: 'mv_d', kind: 'echoThrow', parts: ['t5'] },
      { id: 'mv_e', kind: 'filterRise' },
    ]);
    expect(b.moves).toHaveLength(1);
    expect(b.moves![0].kind).toBe('fadeOut');
    expect(b.moves![0].id).not.toBe('mv_a');
    expect(c.moves).toBeUndefined();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('an empty list of parts or of moves is left out, and the repair is said (never dropped silently)', () => {
    const p = loose(createProject({ now: 0 }));
    p.arrangement.blocks[0].moves = [{ id: 'mv_a', kind: 'filterRise', parts: [] }];
    p.arrangement.blocks[1].moves = [];
    const r = check(p);
    const [a, b] = r.project.arrangement.blocks;
    expect(a.moves).toEqual([{ id: 'mv_a', kind: 'filterRise' }]);
    expect(b.moves).toBeUndefined();
    expect(r.warnings).toEqual(['Adjusted the parts a song move acts on.', 'Removed an empty list of song moves from a block.']);
    // What validation keeps round-trips exactly.
    expect(check(JSON.parse(JSON.stringify(r.project))).warnings).toEqual([]);
  });
});

describe('designed big-knob positions (Track.macroHome)', () => {
  it('are kept, clamped to 0..1, and unknown entries dropped', () => {
    const p = createProject({ now: 0 });
    p.tracks[3].macroHome = { tone: 0.62, space: 0.28, pump: 0.45 };
    expect(check(p).project).toEqual(p);
    const bad = json(p) as unknown as { tracks: { macroHome: unknown }[] };
    bad.tracks[3].macroHome = { tone: 3, sparkle: 0.5, echo: 'loud' };
    bad.tracks[4].macroHome = 'nope';
    const r = check(bad);
    expect(r.project.tracks[3].macroHome).toEqual({ tone: 1 });
    expect(r.project.tracks[4].macroHome).toBeUndefined();
  });

  it('starters and synth sounds write them', () => {
    const house = HOUSE.build();
    for (const t of house.tracks) expect(t.macroHome).toEqual(t.macros);
  });
});

describe('takes keep their own scene count', () => {
  it('a take recorded with 4 scenes stays valid in a 6-scene project; its launches are checked against its own rows', () => {
    const p = createProject({ now: 0, scenes: sceneNames(6) });
    const old = createProject({ now: 0 });
    p.performances.push({
      id: 'perf_1',
      name: 'Take',
      createdAt: 0,
      startTick: 0,
      endTick: 3072,
      snapshot: { bpm: 120, swing: 0, root: 0, scale: 'minor', assist: true, masterVolumeDb: 0, tracks: old.tracks, scenes: old.scenes, patch: old.patch, launcher: [{ trackId: 't1', playing: { slot: 3, startTick: 0 } }], seed: 1 },
      events: [
        { t: 0, type: 'scene', row: 3, atTick: 0 },
        { t: 10, type: 'launch', trackId: 't2', slot: 2, atTick: 384 },
      ],
    });
    const ok = check(p);
    expect(ok.project.performances[0]).toEqual(p.performances[0]);

    const bad = json(p);
    bad.performances[0].events.push({ t: 20, type: 'scene', row: 5, atTick: 768 }, { t: 30, type: 'launch', trackId: 't3', slot: 4, atTick: 768 });
    bad.performances[0].snapshot.launcher.push({ trackId: 't2', playing: { slot: 5, startTick: 0 } });
    const r = check(bad);
    // Rows 4 and 5 do not exist in the take's own 4 scenes.
    expect(r.project.performances[0].events).toEqual(p.performances[0].events);
    expect(r.project.performances[0].snapshot.launcher).toEqual(p.performances[0].snapshot.launcher);
  });
});
