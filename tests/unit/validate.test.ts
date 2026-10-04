import { describe, expect, it } from 'vitest';
import { conn, createClip, createProject } from '../../src/project/factory';
import { hasCycle, validateConnection } from '../../src/project/graph';
import { mulberry32 } from '../../src/project/rng';
import { MIGRATIONS, NEWER_VERSION_MESSAGE, migrateProject, runMigrations } from '../../src/project/migrate';
import { neutralMasteringParams } from '../../src/project/params';
import { PROJECT_SCHEMA, PROJECT_VERSION, type Performance, type Project } from '../../src/project/types';
import { VALIDATION_LIMITS, sanitizeClip, validatePerformance, validateProject } from '../../src/project/validate';

/** A project exercising most of the schema: clips, variation info, a song of loops and sections, samples, a take. */
function richProject(): Project {
  const p = createProject({ name: 'Rich', now: 1000 });
  p.tracks[0].clips[0] = createClip('Beat', 1, [
    { tick: 0, pitch: 0, velocity: 0.9, duration: 24 },
    { tick: 96, pitch: 2, velocity: 0.7, duration: 24 },
  ]);
  p.tracks[2].clips[1] = { ...createClip('Line', 2, [{ tick: 10.5, pitch: 36, velocity: 0.5, duration: 40 }]), variation: { seed: 7, generation: 2 } };
  p.arrangement.regions = [
    { id: 'rg_1', trackId: 't1', clipId: p.tracks[0].clips[0]!.id, start: 0, bars: 8, offset: 0 },
    { id: 'rg_2', trackId: 't3', clipId: p.tracks[2].clips[1]!.id, start: 2, bars: 3, offset: 1 },
    { id: 'rg_3', trackId: 't1', clipId: p.tracks[0].clips[0]!.id, start: 10, bars: 2, offset: 0 },
  ];
  p.arrangement.sections = [
    { id: 'sec_1', name: 'Intro', start: 0, bars: 4, moves: [{ id: 'mv_1', kind: 'fadeIn' }] },
    { id: 'sec_2', name: 'Drop', start: 4, bars: 8, moves: [{ id: 'mv_2', kind: 'filterRise', parts: ['t3'] }] },
  ];
  p.samples.push({ id: 'smp_abc', name: 'Loop', mime: 'audio/wav', byteLength: 1234, duration: 1.5, sampleRate: 44100, channels: 2, peaks: [-0.5, 0.5, -0.25, 0.25] });
  const sampler = p.tracks[7].instrument;
  if (sampler.kind === 'sampler') sampler.sampleId = 'smp_abc';
  p.starterId = 'house';
  const perf: Performance = {
    id: 'perf_1',
    name: 'Take 1',
    createdAt: 5,
    startTick: 0,
    endTick: 1536,
    snapshot: {
      bpm: p.bpm, swing: p.swing, root: p.root, scale: p.scale, assist: p.assist, masterVolumeDb: p.masterVolumeDb,
      tracks: structuredClone(p.tracks), scenes: structuredClone(p.scenes), patch: structuredClone(p.patch),
      launcher: p.tracks.map((t) => ({ trackId: t.id, playing: t.id === 't1' ? { slot: 0, startTick: 0 } : null })),
      seed: p.seed,
    },
    events: [
      { t: 0, type: 'scene', row: 0, atTick: 0 },
      { t: 12.5, type: 'noteOn', trackId: 't3', pitch: 48, velocity: 0.8, key: 'KeyA' },
      { t: 60, type: 'noteOff', trackId: 't3', pitch: 48, key: 'KeyA' },
      { t: 100, type: 'macro', trackId: 't1', macro: 'tone', value: 0.3 },
      { t: 120, type: 'param', module: 't1:filter', param: 'resonance', value: 0.5 },
      { t: 384, type: 'launch', trackId: 't2', slot: null, atTick: 768 },
    ],
  };
  p.performances.push(perf);
  return p;
}

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('validateProject accepts valid projects unchanged', () => {
  it('passes a fresh project with no warnings', () => {
    const p = createProject({ now: 0 });
    const r = validateProject(json(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.project).toEqual(json(p));
  });

  it('keeps a rich project deep-equal and detached from its input', () => {
    const input = json(richProject());
    const r = validateProject(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.project).toEqual(input);
    expect(r.project.tracks).not.toBe(input.tracks);
    r.project.tracks[0].clips[0]!.notes[0].pitch = 5;
    expect(input.tracks[0].clips[0]!.notes[0].pitch).toBe(0);
  });
});

describe('validateProject rejects garbage without throwing', () => {
  const valid = () => json(createProject({ now: 0 })) as unknown as Record<string, unknown>;
  const cyclic: Record<string, unknown> = { schema: PROJECT_SCHEMA, version: 1 };
  cyclic.self = cyclic;
  cyclic.tracks = [cyclic, cyclic];
  const hostile = {
    schema: PROJECT_SCHEMA,
    version: 1,
    id: 'p1',
    get tracks(): never {
      throw new Error('boom');
    },
  };
  const cases: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'project'],
    ['array', [1, 2, 3]],
    ['empty object', {}],
    ['wrong schema', { ...valid(), schema: 'other.app' }],
    ['missing version', { ...valid(), version: undefined }],
    ['string version', { ...valid(), version: '1' }],
    ['missing id', { ...valid(), id: undefined }],
    ['tracks not an array', { ...valid(), tracks: 'eight' }],
    ['seven tracks', { ...valid(), tracks: (valid().tracks as unknown[]).slice(0, 7) }],
    ['nine tracks', { ...valid(), tracks: [...(valid().tracks as unknown[]), (valid().tracks as unknown[])[0]] }],
    ['five scenes but four clip slots per part', { ...valid(), scenes: [...(valid().scenes as unknown[]), { id: 'x', name: 'x' }] }],
    ['no scenes', (() => { const v = valid(); v.scenes = []; for (const t of v.tracks as { clips: unknown[] }[]) t.clips = []; return v; })()],
    ['nine scenes', (() => {
      const v = valid();
      v.scenes = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));
      for (const t of v.tracks as { clips: unknown[] }[]) t.clips = Array.from({ length: 9 }, () => null);
      return v;
    })()],
    ['no patch', { ...valid(), patch: null }],
    ['no master', (() => { const v = valid(); (v.patch as { modules: { id: string }[] }).modules = (v.patch as { modules: { id: string }[] }).modules.filter((m) => m.id !== 'master'); return v; })()],
    ['three clip slots', (() => { const v = valid(); (v.tracks as { clips: unknown[] }[])[0].clips = [null, null, null]; return v; })()],
    ['clip with 9 bars', (() => { const v = valid(); (v.tracks as { clips: unknown[] }[])[0].clips[0] = { id: 'c', name: 'x', bars: 9, notes: [] }; return v; })()],
    ['clip with 2.5 bars', (() => { const v = valid(); (v.tracks as { clips: unknown[] }[])[0].clips[0] = { id: 'c', name: 'x', bars: 2.5, notes: [] }; return v; })()],
    ['unknown instrument', (() => { const v = valid(); (v.tracks as { instrument: unknown }[])[1].instrument = { kind: 'theremin', params: {} }; return v; })()],
    ['duplicate track ids', (() => { const v = valid(); (v.tracks as { id: string }[])[1].id = 't1'; return v; })()],
    ['too many notes', (() => {
      const v = valid();
      const notes = Array.from({ length: VALIDATION_LIMITS.maxNotesPerClip + 1 }, (_, i) => ({ id: `n${i}`, tick: 0, pitch: 60, velocity: 1, duration: 1 }));
      (v.tracks as { clips: unknown[] }[])[3].clips[0] = { id: 'c', name: 'x', bars: 1, notes };
      return v;
    })()],
    ['cyclic object', cyclic],
    ['throwing getter', hostile],
  ];
  for (const [name, input] of cases) {
    it(name, () => {
      let r: ReturnType<typeof validateProject> | undefined;
      expect(() => (r = validateProject(input))).not.toThrow();
      expect(r!.ok).toBe(false);
      if (r && !r.ok) {
        expect(r.errors.length).toBeGreaterThan(0);
        for (const e of r.errors) expect(typeof e).toBe('string');
      }
    });
  }
});

describe('validateProject repairs recoverable problems', () => {
  it('clamps out-of-range params through the registry and drops unknown ones', () => {
    const p = json(createProject({ now: 0 }));
    p.bpm = 500;
    p.swing = -1;
    p.masterVolumeDb = 40;
    p.tracks[2].instrument.params.cutoff = 999999;
    p.tracks[2].instrument.params.bogus = 3;
    p.patch.modules.find((m) => m.id === 't1:filter')!.params.cutoff = 1e9;
    p.patch.modules.find((m) => m.id === 't1:lfo')!.params.wave = 2.7;
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.bpm).toBe(220);
    expect(r.project.swing).toBe(0);
    expect(r.project.masterVolumeDb).toBe(6);
    expect(r.project.tracks[2].instrument.params.cutoff).toBe(12000); // bass cutoff max
    expect('bogus' in r.project.tracks[2].instrument.params).toBe(false);
    expect(r.project.patch.modules.find((m) => m.id === 't1:filter')!.params.cutoff).toBe(20000);
    expect(r.project.patch.modules.find((m) => m.id === 't1:lfo')!.params.wave).toBe(3); // enum rounded
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('drops invalid connections with warnings and never keeps a cycle', () => {
    const p = json(createProject({ now: 0 }));
    const originalIds = p.patch.connections.map((c) => c.id);
    p.patch.connections.push(
      conn('t1:lfo', 'out', 't1:filter', 'in'), // modulation into audio
      conn('t9:inst', 'out', 't1:filter', 'in'), // unknown module
      conn('t1:inst', 'out', 't1:drive', 'in'), // duplicate
      conn('t1:ch', 'out', 't1:drive', 'in'), // loop
    );
    (p.patch.connections as unknown[]).push({ id: 'junk', from: 'nowhere' });
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.patch.connections.map((c) => c.id)).toEqual(originalIds);
    expect(hasCycle(r.project.patch)).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/modulation output can only go to a teal modulation input/);
    expect(r.warnings.join('\n')).toMatch(/feed the sound back/);
  });

  it('cleans notes, macro targets, song loops and sampler references', () => {
    const p = json(createProject({ now: 0 }));
    p.tracks[4].clips[0] = {
      id: 'c1',
      name: 'Lead',
      bars: 1,
      notes: [
        { id: 'a', tick: 0, pitch: 60, velocity: 3, duration: -5 }, // clamped
        { id: 'b', tick: 400, pitch: 60, velocity: 1, duration: 24 }, // beyond clip: dropped
        { id: 'c', tick: 24, pitch: Number.NaN as unknown as number, velocity: 1, duration: 24 }, // non-finite (JSON null): dropped
        { id: 'a', tick: 48, pitch: 62, velocity: 0.5, duration: 24 }, // duplicate id: re-id
      ],
    };
    p.tracks[0].clips[0] = {
      id: 'd1',
      name: 'Kick',
      bars: 1,
      notes: [
        { id: 'k', tick: 0, pitch: 40, velocity: 1, duration: 24 }, // kept: left over from a melodic instrument
        { id: 'm', tick: 24, pitch: 200, velocity: 1, duration: 24 }, // outside MIDI: dropped
      ],
    };
    p.tracks[1].macroMap.tone.push({ module: 'nowhere', param: 'cutoff', min: 0, max: 1, curve: 'lin' });
    p.tracks[1].macroMap.space.push({ module: 't2:ch', param: 'sendA', min: -5, max: 7, curve: 'exp' });
    p.arrangement.regions.push({ id: 'rg_x', trackId: 't1', clipId: 'missing', start: 0, bars: 2, offset: 0 });
    p.arrangement.regions.push({ id: 'rg_y', trackId: 't5', clipId: 'c1', start: 4, bars: 600, offset: 3 });
    const sampler = p.tracks[7].instrument;
    if (sampler.kind === 'sampler') sampler.sampleId = 'smp_missing';
    const r = validateProject(json(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lead = r.project.tracks[4].clips[0]!;
    expect(lead.notes).toHaveLength(2);
    expect(lead.notes[0]).toEqual({ id: 'a', tick: 0, pitch: 60, velocity: 1, duration: 1 });
    expect(lead.notes[1].id).not.toBe('a');
    expect(r.project.tracks[0].clips[0]!.notes.map((n) => n.id)).toEqual(['k']);
    expect(r.project.tracks[1].macroMap.tone).toHaveLength(2);
    const space = r.project.tracks[1].macroMap.space;
    expect(space[space.length - 1]).toEqual({ module: 't2:ch', param: 'sendA', min: 0, max: 1, curve: 'lin' });
    // The loop of a missing clip goes; one past the song's end is cut there, its offset inside its 1-bar clip.
    expect(r.project.arrangement.regions).toEqual([{ id: 'rg_y', trackId: 't5', clipId: 'c1', start: 4, bars: 508, offset: 0 }]);
    expect(r.project.tracks[7].instrument).toMatchObject({ kind: 'sampler', sampleId: null });
    expect(r.warnings.length).toBeGreaterThan(5);
  });

  it('drops malformed performances and cleans events of valid ones', () => {
    const p = json(richProject());
    const bad = json(p.performances[0]);
    bad.id = 'perf_bad';
    (bad.snapshot as { tracks: unknown[] }).tracks = [];
    const messy = json(p.performances[0]);
    messy.id = 'perf_messy';
    (messy.events as unknown[]).push({ t: 5, type: 'teleport' }, { t: 200, type: 'noteOn', trackId: 'nobody', pitch: 60, velocity: 1, key: 'x' });
    messy.events.push({ t: 50, type: 'tempo', bpm: 999 });
    p.performances.push(bad, messy);
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.performances.map((x) => x.id)).toEqual(['perf_1', 'perf_messy']);
    const events = r.project.performances[1].events;
    expect(events).toHaveLength(7);
    expect(events.map((e) => e.t)).toEqual([...events.map((e) => e.t)].sort((a, b) => a - b));
    expect(events.find((e) => e.type === 'tempo')).toEqual({ t: 50, type: 'tempo', bpm: 220 });
  });

  it('bounds performance size', () => {
    const p = richProject();
    const perf = json(p.performances[0]);
    perf.events = Array.from({ length: VALIDATION_LIMITS.maxPerformanceEvents + 1 }, (_, i) => ({ t: i, type: 'stopAll' as const, atTick: i }));
    expect(validatePerformance(perf, p).performance).toBeNull();
    perf.events = perf.events.slice(0, 1000);
    expect(validatePerformance(perf, p).performance?.events).toHaveLength(1000);
  });

  it('sanitizes pasted clips for the target instrument', () => {
    const clip = createClip('x', 1, [
      { tick: 0, pitch: 3, velocity: 1, duration: 24 },
      { tick: 24, pitch: 64, velocity: 1, duration: 24 },
    ]);
    expect(sanitizeClip(clip, 'drums').clip!.notes.map((n) => n.pitch)).toEqual([3]);
    expect(sanitizeClip(clip, 'poly').clip!.notes).toHaveLength(2);
    expect(sanitizeClip({ bars: 9 }, 'poly').clip).toBeNull();
  });
});

describe('validateProject under random damage', () => {
  const WEIRD: unknown[] = [null, 0, -1, 1e308, 'x', '', true, [], {}, [1, 2], { a: 1 }, 'master', 't1:inst', '__proto__', 2.5];

  /** Every path in a JSON value (for picking something to damage). */
  function allPaths(o: unknown, prefix: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
    if (prefix.length) out.push(prefix);
    if (o && typeof o === 'object') for (const k of Object.keys(o)) allPaths((o as Record<string, unknown>)[k], [...prefix, Array.isArray(o) ? Number(k) : k], out);
    return out;
  }

  function damage(o: Record<string, unknown>, path: (string | number)[], value: unknown, remove: boolean): void {
    let cur = o as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) {
      if (!cur || typeof cur !== 'object') return;
      cur = cur[k] as Record<string | number, unknown>;
    }
    if (!cur || typeof cur !== 'object') return;
    const last = path[path.length - 1];
    if (remove) {
      if (Array.isArray(cur)) cur.splice(last as number, 1);
      else delete cur[last];
    } else cur[last] = value;
  }

  it('never throws, and whatever it accepts is clean: re-validation is warning-free and changes nothing', () => {
    const base = json(richProject());
    const paths = allPaths(base);
    const rnd = mulberry32(2024);
    let accepted = 0;
    for (let i = 0; i < 600; i++) {
      const input = json(base) as unknown as Record<string, unknown>;
      const what: string[] = [];
      for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
        const path = paths[Math.floor(rnd() * paths.length)];
        const remove = rnd() < 0.2;
        const value = WEIRD[Math.floor(rnd() * WEIRD.length)];
        damage(input, path, value, remove);
        what.push(`${path.join('.')} ${remove ? 'removed' : `= ${JSON.stringify(value)}`}`);
      }
      const r = validateProject(input);
      if (!r.ok) {
        // Rejections are plain messages, never a caught exception.
        expect(r.errors.join(' '), what.join('; ')).not.toMatch(/could not be read \(/);
        continue;
      }
      accepted++;
      const p = r.project;
      expect(hasCycle(p.patch), what.join('; ')).toBe(false);
      for (const c of p.patch.connections) {
        const without = { ...p.patch, connections: p.patch.connections.filter((x) => x !== c) };
        expect(validateConnection(without, c.from, c.to).ok, what.join('; ')).toBe(true);
      }
      const moduleIds = new Set(p.patch.modules.map((m) => m.id));
      for (const t of p.tracks) {
        for (const list of Object.values(t.macroMap)) for (const target of list) expect(moduleIds.has(target.module), what.join('; ')).toBe(true);
        for (const c of t.clips) for (const n of c?.notes ?? []) expect(n.tick >= 0 && n.tick < c!.bars * 384 && n.duration > 0, what.join('; ')).toBe(true);
      }
      const again = validateProject(json(p));
      expect(again.ok && again.warnings, what.join('; ')).toEqual([]);
      if (again.ok) expect(again.project, what.join('; ')).toEqual(json(p));
    }
    // The damage is mostly recoverable, so most inputs are repaired rather than rejected.
    expect(accepted).toBeGreaterThan(300);
  });

  it('ignores prototype keys in parameter maps', () => {
    const text = JSON.stringify(createProject({ now: 0 })).replace('"params":{', '"params":{"__proto__":{"polluted":1},"constructor":7,');
    const r = validateProject(JSON.parse(text));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.project.tracks[0].instrument.params)).not.toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/unknown sound setting/);
  });
});

describe('migration', () => {
  it('rejects projects from a newer version', () => {
    const p = json(createProject({ now: 0 }));
    p.version = PROJECT_VERSION + 1;
    const r = validateProject(p);
    expect(r).toEqual({ ok: false, errors: [NEWER_VERSION_MESSAGE] });
    expect(NEWER_VERSION_MESSAGE).toBe('This project was made with a newer version of Omni Song.');
  });

  it('passes current projects through without copying', () => {
    const p = json(createProject({ now: 0 }));
    const r = migrateProject(p);
    expect(r).toEqual({ ok: true, data: p, migrated: false });
    expect(MIGRATIONS.every((m) => m.from < PROJECT_VERSION)).toBe(true);
  });

  it('upgrades a version-1 project: neutral mastering is added and everything else is kept', () => {
    const v2 = json(createProject({ now: 0 }));
    const v1 = json<Record<string, unknown>>(v2 as unknown as Record<string, unknown>);
    v1.version = 1;
    delete v1.mastering;
    const r = validateProject(v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.version).toBe(PROJECT_VERSION);
    expect(r.project.mastering.enabled).toBe(true);
    expect(r.project.mastering.params).toEqual(neutralMasteringParams());
    // Nothing else changes.
    const { mastering: _a, ...rest } = r.project;
    const { mastering: _b, ...expected } = v2;
    expect(rest).toEqual(expected);
  });

  it('repairs damaged mastering settings to neutral values with a warning', () => {
    const p = json<Record<string, unknown>>(createProject({ now: 0 }) as unknown as Record<string, unknown>);
    p.mastering = { enabled: 'yes', params: { loudness: 999, width: Number.NaN, nonsense: 3 }, presetId: '../../evil' };
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.mastering.enabled).toBe(true);
    expect(r.project.mastering.params.loudness).toBe(15);
    expect(r.project.mastering.params.width).toBe(1);
    expect(r.project.mastering.params).not.toHaveProperty('nonsense');
    expect(r.project.mastering.presetId).toBeUndefined();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('runs ordered steps on a copy', () => {
    const order: number[] = [];
    const steps = [
      { from: 2, description: 'b', migrate: (d: Record<string, unknown>) => { order.push(2); return { ...d, b: true }; } },
      { from: 1, description: 'a', migrate: (d: Record<string, unknown>) => { order.push(1); return { ...d, a: true }; } },
    ];
    const input = { schema: 'test', version: 1 };
    const r = runMigrations(input, steps, 3, 'test');
    expect(order).toEqual([1, 2]);
    expect(r).toEqual({ ok: true, data: { schema: 'test', version: 3, a: true, b: true }, migrated: true });
    expect(input).toEqual({ schema: 'test', version: 1 });
    expect(runMigrations({ schema: 'test', version: 1 }, [steps[0]], 3, 'test')).toMatchObject({ ok: false });
    expect(runMigrations({ schema: 'test', version: 1 }, [{ from: 1, description: 'x', migrate: () => { throw new Error('bad'); } }], 2, 'test')).toMatchObject({ ok: false });
  });
});
