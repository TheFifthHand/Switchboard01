/**
 * Recording edits and recorded takes, without a browser: the edit maths on
 * the trimmed region (Normalize, Reverse, Crop, Fades, Gain), version names,
 * the limits audio made in the app shares with imports, and the commands
 * that put a take or a new version on a part in one undo step.
 */
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, encodeMadeAudio, madeAudioLimitMessage } from '../../src/persistence/audioImport';
import { createProject } from '../../src/project/factory';
import type { Performance, SampleMeta, SamplerInstrument } from '../../src/project/types';
import { parseWav } from '../../src/render/wav';
import { ProjectStore } from '../../src/state/projectStore';
import { addPerformance } from '../../src/state/commands/performances';
import { RECORDED_TAKE_ROOT, addRecordedTake, addSampleMeta, addSampleVersion, assignSample, setSamplerParam } from '../../src/state/commands/samples';
import { makeSnapshot } from '../../src/time/snapshot';
import {
  NORMALIZE_PEAK,
  applySampleEdit,
  fadeFrames,
  peakOf,
  regionFrames,
  versionName,
  type EditResult,
} from '../../src/app/views/sampler/sampleEdit';
import { nextRecordingName } from '../../src/app/audioInput';

const SR = 1000;

/** Two channels of a ramp 1..n (scaled), so positions are easy to read. */
function ramp(n: number, scale = 0.001): Float32Array[] {
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (i + 1) * scale;
    b[i] = -(i + 1) * scale;
  }
  return [a, b];
}

function ok(r: EditResult) {
  if (!r.ok) throw new Error(`edit refused: ${r.message}`);
  return r;
}

describe('Edits on the trimmed region', () => {
  it('the region is whole frames, at least one, whatever order Start and End are in', () => {
    expect(regionFrames(1000, 0.25, 0.75)).toEqual([250, 750]);
    expect(regionFrames(1000, 0.75, 0.25)).toEqual([250, 750]);
    expect(regionFrames(1000, 0.5, 0.5)).toEqual([500, 501]);
    expect(regionFrames(1000, 1, 1)).toEqual([999, 1000]);
    expect(regionFrames(1000, -1, 2)).toEqual([0, 1000]);
  });

  it('Normalize brings the region’s peak to -1 dB and leaves the rest and the source alone', () => {
    const src = ramp(1000);
    const before = Float32Array.from(src[0]);
    const r = ok(applySampleEdit(src, SR, 0.2, 0.4, { kind: 'normalize' }));
    expect(peakOf(r.channels, 200, 400)).toBeCloseTo(NORMALIZE_PEAK, 5);
    // Outside the region: unchanged.
    expect(r.channels[0][100]).toBeCloseTo(src[0][100], 7);
    expect(r.channels[1][900]).toBeCloseTo(src[1][900], 7);
    // The source (which may be the buffer playing right now) is never written.
    expect(src[0]).toEqual(before);
    expect(r.region).toBeNull();
  });

  it('Normalize refuses a silent region and one already at -1 dB', () => {
    const silent = [new Float32Array(100)];
    const r = applySampleEdit(silent, SR, 0, 1, { kind: 'normalize' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/silent/);
    const done = ok(applySampleEdit(ramp(100), SR, 0, 1, { kind: 'normalize' }));
    const again = applySampleEdit(done.channels, SR, 0, 1, { kind: 'normalize' });
    expect(again.ok).toBe(false);
  });

  it('Reverse plays the region backwards in place', () => {
    // Steps of 1/16 (exact in 32-bit floats, and under full scale: edits clip like the stored WAV).
    const r = ok(applySampleEdit(ramp(10, 1 / 16), SR, 0.2, 0.6, { kind: 'reverse' }));
    expect([...r.channels[0]]).toEqual([1, 2, 6, 5, 4, 3, 7, 8, 9, 10].map((k) => k / 16));
    expect([...r.channels[1]]).toEqual([-1, -2, -6, -5, -4, -3, -7, -8, -9, -10].map((k) => k / 16));
  });

  it('Crop keeps only the region and makes it the whole recording; a whole-file crop is refused', () => {
    const r = ok(applySampleEdit(ramp(10, 1 / 16), SR, 0.3, 0.7, { kind: 'crop' }));
    expect([...r.channels[0]]).toEqual([4, 5, 6, 7].map((k) => k / 16));
    expect(r.region).toEqual({ start: 0, end: 1 });
    const whole = applySampleEdit(ramp(10, 1), SR, 0, 1, { kind: 'crop' });
    expect(whole.ok).toBe(false);
  });

  it('Fade in and Fade out are linear over the chosen length, never longer than the region', () => {
    const flat = [new Float32Array(2000).fill(0.5)];
    const fin = ok(applySampleEdit(flat, SR, 0.25, 1, { kind: 'fadeIn', length: 'half' }));
    // Region starts at frame 500; half a second at 1 kHz = 500 frames.
    expect(fin.channels[0][499]).toBe(0.5);
    expect(fin.channels[0][500]).toBe(0);
    expect(fin.channels[0][750]).toBeCloseTo(0.25, 2);
    expect(fin.channels[0][999]).toBeCloseTo(0.5, 5);
    expect(fin.channels[0][1500]).toBe(0.5);
    const fout = ok(applySampleEdit(flat, SR, 0, 0.5, { kind: 'fadeOut', length: 'region' }));
    expect(fout.channels[0][0]).toBeCloseTo(0.5, 5);
    expect(fout.channels[0][999]).toBe(0);
    expect(fout.channels[0][1000]).toBe(0.5);
    expect(fadeFrames('two', SR, 300)).toBe(300);
    expect(fadeFrames('short', 48000, 100000)).toBe(2400);
  });

  it('Gain changes the region by up to 12 dB and reports peaks over full scale', () => {
    const flat = [new Float32Array(100).fill(0.5)];
    const up = ok(applySampleEdit(flat, SR, 0, 1, { kind: 'gain', db: 6 }));
    expect(up.channels[0][10]).toBeCloseTo(0.5 * 10 ** (6 / 20), 5);
    expect(up.peak).toBeGreaterThan(0.99);
    // At most 12 dB.
    const quiet = [new Float32Array(100).fill(0.1)];
    const limited = ok(applySampleEdit(quiet, SR, 0, 1, { kind: 'gain', db: 40 }));
    expect(limited.channels[0][0]).toBeCloseTo(0.1 * 10 ** (12 / 20), 4);
    // Over full scale: reported, and clipped as the stored WAV is.
    const clamp = ok(applySampleEdit(flat, SR, 0, 1, { kind: 'gain', db: 40 }));
    expect(clamp.peak).toBeGreaterThan(1);
    expect(clamp.channels[0][0]).toBe(1);
    expect(applySampleEdit(flat, SR, 0, 1, { kind: 'gain', db: 0 }).ok).toBe(false);
  });

  it('names new versions after the versions already there', () => {
    expect(versionName('Vocal', [])).toBe('Vocal (edit 1)');
    expect(versionName('Vocal (edit 1)', ['Vocal (edit 1)'])).toBe('Vocal (edit 2)');
    expect(versionName('Vocal', ['Vocal (edit 1)', 'Vocal (edit 4)', 'Other (edit 9)'])).toBe('Vocal (edit 5)');
    expect(versionName('a.b (c)', ['a.b (c) (edit 2)'])).toBe('a.b (c) (edit 3)');
    expect(nextRecordingName(['Recording 2', 'Bell', 'Recording 7'])).toBe('Recording 8');
    expect(nextRecordingName([])).toBe('Recording 1');
  });
});

describe('Audio made in the app keeps the import limits', () => {
  it('encodes a 24-bit WAV with its metadata, and refuses what is too long', () => {
    const ch = [new Float32Array(4800).fill(0.25)];
    const made = encodeMadeAudio('Recording 1', ch, 48000);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.meta).toMatchObject({ name: 'Recording 1', mime: 'audio/wav', channels: 1, sampleRate: 48000 });
    expect(made.meta.duration).toBeCloseTo(0.1, 6);
    expect(made.meta.byteLength).toBe(44 + 4800 * 3);
    expect(made.meta.peaks?.length).toBeGreaterThan(0);
    expect(made.blob.size).toBe(made.meta.byteLength);
    expect(madeAudioLimitMessage('Take', IMPORT_LIMITS.maxSeconds + 1, 1000)).toMatch(/limit is 60 seconds/);
    expect(madeAudioLimitMessage('Take', 10, IMPORT_LIMITS.maxBytes + 1)).toMatch(/limit is 50 MB/);
    expect(madeAudioLimitMessage('Take', 0, 10)).toMatch(/empty/);
    const long = encodeMadeAudio('Long', [new Float32Array(1000 * 61)], 1000);
    expect(long.ok).toBe(false);
  });

  it('the WAV decodes back to the same audio (within 24-bit rounding)', async () => {
    const x = new Float32Array(480);
    for (let i = 0; i < x.length; i++) x[i] = 0.7 * Math.sin(i / 7);
    const made = encodeMadeAudio('Tone', [x, x], 48000);
    if (!made.ok) throw new Error(made.message);
    const parsed = parseWav(await made.blob.arrayBuffer());
    expect(parsed.bitDepth).toBe(24);
    expect(parsed.channels).toHaveLength(2);
    for (let i = 0; i < x.length; i += 37) expect(parsed.channels[1][i]).toBeCloseTo(x[i], 5);
  });
});

const meta = (id: string, name = id): SampleMeta => ({ id, name, mime: 'audio/wav', byteLength: 1000, duration: 2, sampleRate: 48000, channels: 1, peaks: [-0.5, 0.5] });

describe('A recorded take on a part: one undo step', () => {
  it('adds the recording, plays it at its own pitch and speed, and a clip plays it from the downbeat', () => {
    const store = new ProjectStore(createProject({ name: 'T', now: 1 }));
    // Earlier settings on the part (a long fade, a transposition) do not colour the take.
    expect(setSamplerParam(store, 't8', 'fadeIn', 400).changed).toBe(true);
    expect(setSamplerParam(store, 't8', 'pitch', 7).changed).toBe(true);
    expect(setSamplerParam(store, 't8', 'gain', -6).changed).toBe(true);
    const before = store.getState();
    const r = addRecordedTake(store, { trackId: 't8', meta: meta('smp_take1', 'Recording 1'), slot: 2, bars: 4, bpm: 97, clipName: 'Recording 1' });
    expect(r.changed).toBe(true);
    const p = store.getState();
    const t = p.tracks.find((x) => x.id === 't8')!;
    const inst = t.instrument as SamplerInstrument;
    expect(p.samples.map((s) => s.id)).toContain('smp_take1');
    expect(inst.sampleId).toBe('smp_take1');
    expect(inst.params).toMatchObject({ start: 0, end: 1, mode: 0, pitch: 0, fine: 0, sync: 0, fadeIn: 3, fadeOut: 15, originalBpm: 97, rootNote: RECORDED_TAKE_ROOT });
    // The part keeps its own level.
    expect(inst.params.gain).toBe(-6);
    const clip = t.clips[2]!;
    expect(clip.bars).toBe(4);
    expect(clip.notes).toHaveLength(1);
    expect(clip.notes[0]).toMatchObject({ tick: 0, pitch: RECORDED_TAKE_ROOT, velocity: 1, duration: 4 * 384 });
    expect(store.info.getState().undoLabel).toBe('Record audio');
    store.undo();
    expect(store.getState().samples).toEqual(before.samples);
    expect(store.getState().tracks).toEqual(before.tracks);
    store.redo();
    expect(store.getState().tracks.find((x) => x.id === 't8')!.clips[2]?.id).toBe(clip.id);
  });

  it('turns a synth part into a sampler, and is refused during a performance take', () => {
    const store = new ProjectStore(createProject({ name: 'T', now: 1 }));
    expect(addRecordedTake(store, { trackId: 't4', meta: meta('smp_take2'), slot: 0, bars: 2, bpm: 120, clipName: 'R' }).changed).toBe(true);
    expect(store.getState().tracks.find((x) => x.id === 't4')!.instrument.kind).toBe('sampler');
    store.setLock('Recording a performance', (label) => label.startsWith('track:Change'));
    const r = addRecordedTake(store, { trackId: 't8', meta: meta('smp_take3'), slot: 0, bars: 1, bpm: 120, clipName: 'R' });
    expect(r.changed).toBe(false);
    expect(r.refused).toBe('Recording a performance');
    expect(addRecordedTake(store, { trackId: 't8', meta: meta('smp_take4'), slot: 9, bars: 1, bpm: 120, clipName: 'R' }).changed).toBe(false);
  });
});

describe('A new version of a recording: one undo step', () => {
  function setup() {
    const store = new ProjectStore(createProject({ name: 'T', now: 1 }));
    addSampleMeta(store, meta('smp_orig', 'Vocal'));
    assignSample(store, 't8', 'smp_orig');
    store.endGesture();
    return store;
  }

  it('replaces the recording on the part and drops the original once nothing uses it; undo brings it back', () => {
    const store = setup();
    const r = addSampleVersion(store, 't8', 'smp_orig', meta('smp_v1', 'Vocal (edit 1)'), { label: 'Crop recording', region: { start: 0, end: 1 } });
    expect(r.changed).toBe(true);
    const p = store.getState();
    expect((p.tracks.find((t) => t.id === 't8')!.instrument as SamplerInstrument).sampleId).toBe('smp_v1');
    expect(p.samples.map((s) => s.id)).toEqual(['smp_v1']);
    expect(store.info.getState().undoLabel).toBe('Crop recording');
    store.undo();
    const back = store.getState();
    expect((back.tracks.find((t) => t.id === 't8')!.instrument as SamplerInstrument).sampleId).toBe('smp_orig');
    expect(back.samples.map((s) => s.id)).toEqual(['smp_orig']);
  });

  it('keeps the original while another part or a saved take uses it', () => {
    const store = setup();
    assignSample(store, 't7', 'smp_orig');
    addSampleVersion(store, 't8', 'smp_orig', meta('smp_v1'), { label: 'Normalize recording' });
    expect(store.getState().samples.map((s) => s.id).sort()).toEqual(['smp_orig', 'smp_v1']);

    const store2 = setup();
    const p = store2.getState();
    const perf: Performance = { id: 'perf_1', name: 'Take 1', createdAt: 1, startTick: 0, endTick: 384, snapshot: makeSnapshot(p, [], 0), events: [] };
    addPerformance(store2, perf);
    addSampleVersion(store2, 't8', 'smp_orig', meta('smp_v2'), { label: 'Reverse recording' });
    expect(store2.getState().samples.map((s) => s.id).sort()).toEqual(['smp_orig', 'smp_v2']);
  });

  it('is refused when the part plays another recording by now, or the region is not valid', () => {
    const store = setup();
    expect(addSampleVersion(store, 't8', 'smp_other', meta('smp_v1'), { label: 'Normalize recording' }).changed).toBe(false);
    expect(addSampleVersion(store, 't8', 'smp_orig', meta('smp_v1'), { label: 'Crop recording', region: { start: 0.5, end: 0.2 } }).changed).toBe(false);
    expect(store.getState().samples.map((s) => s.id)).toEqual(['smp_orig']);
  });
});
