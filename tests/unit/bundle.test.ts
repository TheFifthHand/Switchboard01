import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createClip, createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { insertEffect, connect } from '../../src/state/commands/patch';
import { setMacroTarget } from '../../src/state/commands/tracks';
import { BUNDLE_EXTENSION, BUNDLE_MAX_BYTES, BundleExportError, bundleFileName, exportBundle, importBundle, samplePath } from '../../src/persistence/bundle';

const SAMPLE_BYTES = new Uint8Array(Array.from({ length: 2048 }, (_, i) => (i * 37) % 256));

/** A project with edits in every area a bundle must carry. */
function fullProject(): Project {
  const store = new ProjectStore(createProject({ name: 'Night Drive', now: 1000 }));
  insertEffect(store, 't4', 'chorus');
  connect(store, { module: 't1:lfo', port: 'out' }, { module: 't1:inst', port: 'pitch' }, -0.4);
  setMacroTarget(store, 't4', 'motion', 1, { module: 't4:chorus', param: 'depth', min: 0.1, max: 0.9, curve: 'lin', macroFrom: 0.2 });
  store.apply('test:content', (d) => {
    d.tracks[0].clips[0] = createClip('Beat', 2, [
      { tick: 0, pitch: 0, velocity: 1, duration: 24 },
      { tick: 390.5, pitch: 4, velocity: 0.55, duration: 12 },
    ]);
    d.tracks[4].clips[3] = { ...createClip('Hook', 1, [{ tick: 48, pitch: 72, velocity: 0.8, duration: 96 }]), variation: { seed: 99, generation: 3 } };
    d.arrangement.blocks.reverse();
    d.arrangement.blocks[0].repeats = 5;
    d.arrangement.tailSeconds = 4.5;
    d.samples.push({ id: 'smp_loop', name: 'Loop', mime: 'audio/wav', byteLength: SAMPLE_BYTES.byteLength, duration: 2, sampleRate: 48000, channels: 2, peaks: [-0.1, 0.2] });
    const s = d.tracks[7].instrument;
    if (s.kind === 'sampler') s.sampleId = 'smp_loop';
    d.performances.push({
      id: 'perf_1',
      name: 'Take one',
      createdAt: 1234,
      startTick: 0,
      endTick: 3072,
      snapshot: {
        bpm: d.bpm, swing: d.swing, root: d.root, scale: d.scale, assist: d.assist, masterVolumeDb: d.masterVolumeDb,
        tracks: JSON.parse(JSON.stringify(d.tracks)), scenes: JSON.parse(JSON.stringify(d.scenes)), patch: JSON.parse(JSON.stringify(d.patch)),
        launcher: [{ trackId: 't1', playing: { slot: 0, startTick: 0 } }], seed: d.seed,
      },
      events: [
        { t: 0, type: 'scene', row: 0, atTick: 0 },
        { t: 10.25, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 0.7, key: 'KeyZ' },
        { t: 40, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyZ' },
        { t: 200, type: 'param', module: 't4:chorus', param: 'mix', value: 0.8 },
        { t: 384, type: 'tempo', bpm: 128 },
      ],
    });
  });
  return store.getState();
}

async function blobBytes(b: Blob): Promise<number[]> {
  return [...new Uint8Array(await b.arrayBuffer())];
}

describe('project bundles', () => {
  it('round-trips the project exactly and the recording bytes', async () => {
    const project = fullProject();
    const bundle = await exportBundle(project, async (id) => (id === 'smp_loop' ? new Blob([SAMPLE_BYTES], { type: 'audio/wav' }) : null));
    expect(bundle.type).toBe('application/zip');

    const entries = unzipSync(new Uint8Array(await bundle.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(['README.txt', 'project.json', 'samples/smp_loop.wav']);

    const r = await importBundle(bundle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    const expected = JSON.parse(JSON.stringify(project));
    expect(r.project).toEqual(expected);
    // Spot-check the parts a bundle must never lose.
    expect(r.project.id).toBe(project.id);
    expect(r.project.patch.connections.map((c) => c.id)).toEqual(project.patch.connections.map((c) => c.id));
    expect(r.project.tracks[3].macroMap.motion).toEqual(project.tracks[3].macroMap.motion);
    expect(r.project.arrangement).toEqual(expected.arrangement);
    expect(r.project.performances[0].events).toEqual(expected.performances[0].events);
    expect(r.project.tracks[4].clips[3]!.variation).toEqual({ seed: 99, generation: 3 });

    expect(r.samples).toHaveLength(1);
    expect(r.samples[0].meta).toEqual(project.samples[0]);
    expect(r.samples[0].blob.type).toBe('audio/wav');
    expect(await blobBytes(r.samples[0].blob)).toEqual([...SAMPLE_BYTES]);
  });

  it('can give the imported project a new id', async () => {
    const project = createProject({ now: 0 });
    const r = await importBundle(await exportBundle(project, async () => null), { newId: true });
    expect(r.ok && r.project.id !== project.id && r.project.id.startsWith('proj_')).toBe(true);
  });

  it('refuses to export a bundle with a missing recording', async () => {
    const project = fullProject();
    await expect(exportBundle(project, async () => null)).rejects.toBeInstanceOf(BundleExportError);
  });

  it('gives readable errors for bad files', async () => {
    const notZip = await importBundle(new Blob(['hello, this is text']));
    expect(notZip).toEqual({ ok: false, error: expect.stringMatching(/not a SWITCHBOARD project file/) });

    const good = new Uint8Array(await (await exportBundle(createProject({ now: 0 }), async () => null)).arrayBuffer());
    const corrupt = good.slice(0, Math.floor(good.length / 2));
    corrupt.fill(0x41, 40, 400);
    const damaged = await importBundle(new Blob([corrupt]));
    expect(damaged.ok).toBe(false);
    if (!damaged.ok) expect(damaged.error).toMatch(/damaged|could not be opened/);

    const noProject = await importBundle(new Blob([zipSync({ 'README.txt': strToU8('hi') })]));
    expect(noProject).toEqual({ ok: false, error: 'This zip file does not contain a SWITCHBOARD project (project.json is missing).' });

    const badJson = await importBundle(new Blob([zipSync({ 'project.json': strToU8('{"schema": ') })]));
    expect(badJson).toEqual({ ok: false, error: expect.stringMatching(/not valid JSON/) });

    const invalid = await importBundle(new Blob([zipSync({ 'project.json': strToU8(JSON.stringify({ schema: 'switchboard01.project', version: 1, id: 'p', tracks: [] })) })]));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatch(/^This project file cannot be opened: /);

    const newer = { ...JSON.parse(JSON.stringify(createProject({ now: 0 }))), version: 99 };
    const future = await importBundle(new Blob([zipSync({ 'project.json': strToU8(JSON.stringify(newer)) })]));
    expect(future).toEqual({ ok: false, error: 'This project file cannot be opened: This project was made with a newer version of SWITCHBOARD.' });

    expect(await importBundle(new Blob([]))).toEqual({ ok: false, error: 'This file is empty.' });
  });

  it('rejects a bundle whose used recording is missing, and drops unused missing ones', async () => {
    const project = fullProject();
    const json = strToU8(JSON.stringify(project));
    const missingUsed = await importBundle(new Blob([zipSync({ 'project.json': json })]));
    expect(missingUsed).toEqual({ ok: false, error: 'The recording "Loop" is missing from this project file, so it cannot be opened completely.' });

    const unused = JSON.parse(JSON.stringify(project)) as Project;
    const s = unused.tracks[7].instrument;
    if (s.kind === 'sampler') s.sampleId = null;
    unused.performances = [];
    const r = await importBundle(new Blob([zipSync({ 'project.json': strToU8(JSON.stringify(unused)) })]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.project.samples).toEqual([]);
      expect(r.warnings.join(' ')).toMatch(/unused recording "Loop"/);
    }
  });

  it('refuses a bundle that claims to expand to far more data than it holds (zip bomb)', async () => {
    const project = fullProject();
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(project)), 'samples/smp_loop.wav': SAMPLE_BYTES });
    // Rewrite the recording's uncompressed size in the central directory to 2 GB.
    const name = strToU8('samples/smp_loop.wav');
    let patched = false;
    for (let i = 0; i + 46 < zip.length; i++) {
      if (zip[i] !== 0x50 || zip[i + 1] !== 0x4b || zip[i + 2] !== 1 || zip[i + 3] !== 2) continue;
      const nameLen = zip[i + 28] | (zip[i + 29] << 8);
      if (nameLen === name.length && name.every((b, k) => zip[i + 46 + k] === b)) {
        new DataView(zip.buffer, zip.byteOffset).setUint32(i + 24, 0x7fffffff, true);
        patched = true;
      }
    }
    expect(patched).toBe(true);
    expect(await importBundle(new Blob([zip]))).toEqual({ ok: false, error: 'This project file expands to more data than SWITCHBOARD can open.' });
  });

  it('refuses to export a bundle that would be too large to import again', async () => {
    const project = fullProject();
    let read = false;
    const huge = { size: BUNDLE_MAX_BYTES + 1, type: 'audio/wav', arrayBuffer: async () => ((read = true), new ArrayBuffer(0)) } as unknown as Blob;
    const err = await exportBundle(project, async () => huge).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleExportError);
    expect((err as Error).message).toMatch(/300 MB/);
    // Refused before reading the recording into memory.
    expect(read).toBe(false);
  });

  it('names files safely', () => {
    expect(bundleFileName({ name: 'Night Drive / v2?' })).toBe(`Night-Drive-v2${BUNDLE_EXTENSION}`);
    expect(bundleFileName({ name: '///' })).toBe(`switchboard-project${BUNDLE_EXTENSION}`);
    expect(samplePath({ id: 'smp_a', mime: 'audio/mpeg' })).toBe('samples/smp_a.mp3');
  });
});
