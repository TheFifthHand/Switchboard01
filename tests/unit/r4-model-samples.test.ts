/**
 * Per-clip recordings (capability-01, shape-05): a recorded take or an
 * imported file goes into its own clip, which plays it at its own pitch; the
 * part's other clips keep their recordings. Usage counts clip references, so
 * a recording a clip plays is never removed.
 */
import { describe, expect, it } from 'vitest';
import { HOUSE } from '../../src/content/starters/house';
import { createClip, createProject } from '../../src/project/factory';
import type { Project, SampleMeta, SamplerInstrument } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { setClipSampleRegion } from '../../src/state/commands/clips';
import { setInstrumentParam } from '../../src/state/commands/tracks';
import {
  RECORDED_TAKE_ROOT,
  addRecordedTake,
  addSampleMeta,
  addSampleVersion,
  clipSampleIds,
  importRecordingAsClip,
  removeSampleMeta,
  sampleUsage,
} from '../../src/state/commands/samples';

const meta = (id: string, name = id, duration = 2): SampleMeta => ({ id, name, mime: 'audio/wav', byteLength: 1000, duration, sampleRate: 48000, channels: 1 });

function valid(p: Project): void {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  expect(r.ok && r.warnings).toEqual([]);
}

const vocal = (p: Project) => p.tracks.find((t) => t.name === 'Vocal')!;

describe('recorded takes go into their own clips', () => {
  it('two takes on Vocal: Recording 1 and Recording 2 each play their own take; Oh Chops and Long Oh still play the "Oh"', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = vocal(store.getState());
    expect((before.instrument as SamplerInstrument).sampleId).toBe('builtin:vocal-oh');
    const one = addRecordedTake(store, { trackId: before.id, meta: meta('smp_take1', 'Recording 1'), slot: 0, bars: 1, bpm: 124, clipName: 'Recording 1' });
    expect(one).toMatchObject({ changed: true, slot: 0, partRecording: false });
    const two = addRecordedTake(store, { trackId: before.id, meta: meta('smp_take2', 'Recording 2'), slot: 1, bars: 8, bpm: 124, clipName: 'Recording 2' });
    expect(two).toMatchObject({ changed: true, slot: 1, partRecording: false });
    const p = store.getState();
    const t = vocal(p);
    expect(t.clips[0]!.name).toBe('Recording 1');
    expect(t.clips[0]!.sample).toEqual({ id: 'smp_take1', start: 0, end: 1, rootNote: RECORDED_TAKE_ROOT });
    expect(t.clips[1]!.sample).toEqual({ id: 'smp_take2', start: 0, end: 1, rootNote: RECORDED_TAKE_ROOT });
    expect(t.clips[1]!.bars).toBe(8);
    expect(t.clips[1]!.notes).toEqual([expect.objectContaining({ tick: 0, pitch: RECORDED_TAKE_ROOT, velocity: 1, duration: 8 * 384 })]);
    // The part, its settings and its other clips are as they were.
    expect(t.instrument).toEqual(before.instrument);
    expect(t.clips.slice(2)).toEqual(before.clips.slice(2));
    expect(p.samples.map((s) => s.id)).toEqual(['smp_take1', 'smp_take2']);
    valid(p);
    // Each step undoes on its own.
    store.undo();
    expect(vocal(store.getState()).clips[1]).toBeNull();
    expect(store.getState().samples.map((s) => s.id)).toEqual(['smp_take1']);
  });

  it('a part with nothing else to play takes the recording as its own, played as recorded', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const r = addRecordedTake(store, { trackId: 't8', meta: meta('smp_a'), slot: 2, bars: 4, bpm: 97, clipName: 'Take' });
    expect(r.partRecording).toBe(true);
    const inst = store.getState().tracks[7].instrument as SamplerInstrument;
    expect(inst.sampleId).toBe('smp_a');
    expect(inst.params).toMatchObject({ start: 0, end: 1, mode: 0, pitch: 0, sync: 0, rootNote: 60, originalBpm: 97 });
    // Settings the user sets for the first take apply to every clip of the part.
    setInstrumentParam(store, 't8', 'pitch', 5);
    setInstrumentParam(store, 't8', 'mode', 1);
    const tuned = store.getState().tracks[7].instrument;
    // A second take: the first clip plays on the part, so the part keeps its recording and settings.
    const r2 = addRecordedTake(store, { trackId: 't8', meta: meta('smp_b'), slot: 3, bars: 2, bpm: 120, clipName: 'Take 2' });
    expect(r2).toMatchObject({ changed: true, partRecording: false });
    const t8 = store.getState().tracks[7];
    expect(t8.instrument).toEqual(tuned);
    expect(t8.instrument.params).toMatchObject({ pitch: 5, mode: 1, originalBpm: 97 });
    expect(t8.clips[2]!.sample!.id).toBe('smp_a');
    expect(t8.clips[3]!.sample).toEqual({ id: 'smp_b', start: 0, end: 1, rootNote: RECORDED_TAKE_ROOT });
    valid(store.getState());
  });

  it('a part whose clips are all empty still takes the next recording as its own', () => {
    const p = createProject({ now: 0 });
    p.tracks[7].clips[0] = createClip('Empty', 1);
    const store = new ProjectStore(p);
    expect(addRecordedTake(store, { trackId: 't8', meta: meta('smp_a'), slot: 1, bars: 1, bpm: 120, clipName: 'R' }).partRecording).toBe(true);
    expect((store.getState().tracks[7].instrument as SamplerInstrument).sampleId).toBe('smp_a');
  });

  it('refuses lengths beyond 8 bars and slots the part does not have', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    expect(addRecordedTake(store, { trackId: 't8', meta: meta('smp_a'), slot: 4, bars: 1, bpm: 120, clipName: 'R' }).changed).toBe(false);
    expect(addRecordedTake(store, { trackId: 't8', meta: meta('smp_a'), slot: 0, bars: 9 as never, bpm: 120, clipName: 'R' }).changed).toBe(false);
  });
});

describe('an imported recording becomes its own clip', () => {
  it('goes into the next empty pad (wrapping round), as long as the file in whole bars, at its own pitch; one undo step', () => {
    const store = new ProjectStore(HOUSE.build());
    const before = store.getState();
    const t = vocal(before);
    // 5.5 s at the House tempo is a little under 3 bars.
    const barSeconds = 240 / before.bpm;
    const r = importRecordingAsClip(store, t.id, 'smp_loop', { durationSeconds: 5.5, slot: 2, meta: meta('smp_loop', 'Loop 1', 5.5) });
    expect(r).toMatchObject({ changed: true, slot: 0, partRecording: false });
    const p = store.getState();
    const clip = vocal(p).clips[0]!;
    expect(clip.name).toBe('Loop 1');
    expect(clip.bars).toBe(Math.round(5.5 / barSeconds));
    expect(clip.sample).toEqual({ id: 'smp_loop', start: 0, end: 1, rootNote: 60 });
    expect(clip.notes).toEqual([expect.objectContaining({ tick: 0, pitch: 60, duration: clip.bars * 384 })]);
    expect(vocal(p).instrument).toEqual(t.instrument);
    expect(vocal(p).clips.slice(2)).toEqual(t.clips.slice(2));
    expect(p.samples.map((s) => s.id)).toEqual(['smp_loop']);
    expect(store.undoLabel()).toBe('Import recording as a clip');
    valid(p);
    store.undo();
    expect(store.getState().samples).toEqual([]);
    expect(vocal(store.getState()).clips).toEqual(t.clips);
  });

  it('a synth part becomes a sampler playing the file as recorded; lengths are 1 to 8 bars', () => {
    const store = new ProjectStore(createProject({ now: 0, name: 'T' }));
    addSampleMeta(store, meta('smp_long', 'Long', 60));
    const r = importRecordingAsClip(store, 't4', 'smp_long', { durationSeconds: 60 });
    expect(r).toMatchObject({ changed: true, slot: 0, partRecording: true });
    const t = store.getState().tracks[3];
    expect(t.instrument).toMatchObject({ kind: 'sampler', sampleId: 'smp_long', params: expect.objectContaining({ pitch: 0, mode: 0, rootNote: 60 }) });
    expect(t.clips[0]!.bars).toBe(8);
    importRecordingAsClip(store, 't4', 'smp_long', { durationSeconds: 0.2, slot: 3 });
    expect(store.getState().tracks[3].clips[3]!.bars).toBe(1);
  });

  it('with no empty pad it is refused and says what to do', () => {
    const p = createProject({ now: 0 });
    p.tracks[7].name = 'Vocal';
    for (let i = 0; i < 4; i++) p.tracks[7].clips[i] = createClip(`C${i}`, 1);
    const store = new ProjectStore(p);
    const r = importRecordingAsClip(store, 't8', 'builtin:bell-hit', { durationSeconds: 2 });
    expect(r).toMatchObject({ changed: false, reason: 'occupied', message: 'No empty pad on Vocal: delete or move a clip first.' });
    expect(store.getState()).toBe(p);
    expect(importRecordingAsClip(store, 't8', 'smp_nope', { durationSeconds: 2 })).toMatchObject({ changed: false, reason: 'invalid' });
  });

  it('is refused while a take records', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    store.setLock('Recording a performance', (label) => label.startsWith('module:'));
    expect(importRecordingAsClip(store, 't8', 'builtin:bell-hit', { durationSeconds: 2 }).refused).toBe('Recording a performance');
  });
});

describe('usage counts clips', () => {
  it('a recording a clip plays is in use: it cannot be removed, and its id is kept for storage', () => {
    const store = new ProjectStore(HOUSE.build());
    const t = vocal(store.getState());
    addRecordedTake(store, { trackId: t.id, meta: meta('smp_take1'), slot: 0, bars: 1, bpm: 124, clipName: 'Recording 1' });
    const p = store.getState();
    expect(sampleUsage(p, 'smp_take1')).toEqual({ tracks: [], clips: [{ trackId: t.id, slot: 0, clipId: vocal(p).clips[0]!.id }], performances: [] });
    expect(clipSampleIds(p)).toEqual(new Set(['smp_take1']));
    expect(removeSampleMeta(store, 'smp_take1')).toMatchObject({ changed: false, reason: 'in-use', message: 'This recording plays in a clip (Recording 1 on Vocal). Delete that clip or give it another recording first.' });
  });

  it('a new version of a clip’s own recording replaces it in that clip; the old one leaves once unused', () => {
    const store = new ProjectStore(HOUSE.build());
    const t = vocal(store.getState());
    addRecordedTake(store, { trackId: t.id, meta: meta('smp_take1'), slot: 0, bars: 1, bpm: 124, clipName: 'Recording 1' });
    const r = addSampleVersion(store, t.id, 'smp_take1', meta('smp_take1b'), { label: 'Crop recording', region: { start: 0.25, end: 0.75 }, slot: 0 });
    expect(r.changed).toBe(true);
    const p = store.getState();
    expect(vocal(p).clips[0]!.sample).toEqual({ id: 'smp_take1b', start: 0.25, end: 0.75, rootNote: 60 });
    expect((vocal(p).instrument as SamplerInstrument).sampleId).toBe('builtin:vocal-oh');
    expect(p.samples.map((s) => s.id)).toEqual(['smp_take1b']);
    expect(addSampleVersion(store, t.id, 'smp_take1', meta('smp_x'), { label: 'Normalize recording', slot: 0 })).toMatchObject({ changed: false, reason: 'invalid' });
  });

  /** A part whose own recording is take 1, which its clip also plays itself. */
  function partTake() {
    const store = new ProjectStore(createProject({ now: 0 }));
    expect(addRecordedTake(store, { trackId: 't8', meta: meta('smp_a'), slot: 0, bars: 1, bpm: 120, clipName: 'Recording 1' }).partRecording).toBe(true);
    return store;
  }

  it('a new version of the part’s recording moves the part’s clips that play it onto the version too (the edit is heard there)', () => {
    const store = partTake();
    expect(addSampleVersion(store, 't8', 'smp_a', meta('smp_b'), { label: 'Normalize recording' }).changed).toBe(true);
    const p = store.getState();
    expect((p.tracks[7].instrument as SamplerInstrument).sampleId).toBe('smp_b');
    expect(p.tracks[7].clips[0]!.sample).toEqual({ id: 'smp_b', start: 0, end: 1, rootNote: RECORDED_TAKE_ROOT });
    expect(p.samples.map((s) => s.id)).toEqual(['smp_b']);
    valid(p);
    store.undo();
    expect(store.getState().tracks[7].clips[0]!.sample!.id).toBe('smp_a');
    expect(store.getState().samples.map((s) => s.id)).toEqual(['smp_a']);
  });

  it('a crop maps a clip’s region into the kept part; a clip wholly outside it keeps the old recording, which stays in the project', () => {
    const p0 = partTake().getState();
    const p = JSON.parse(JSON.stringify(p0)) as Project;
    const t = p.tracks[7];
    (t.instrument as SamplerInstrument).params.start = 0.2;
    (t.instrument as SamplerInstrument).params.end = 0.6;
    t.clips[0]!.sample = { id: 'smp_a', start: 0.3, end: 0.5, rootNote: 60 };
    t.clips[1] = { ...t.clips[0]!, id: 'clip_out', name: 'Outside', sample: { id: 'smp_a', start: 0.7, end: 0.9, rootNote: 60 } };
    const store = new ProjectStore(p);
    // Crop keeps 0.2..0.6 of the old recording: the new file plays whole.
    expect(addSampleVersion(store, 't8', 'smp_a', meta('smp_c'), { label: 'Crop recording', region: { start: 0, end: 1 } }).changed).toBe(true);
    const q = store.getState();
    const [inside, outside] = q.tracks[7].clips;
    expect(inside!.sample!.id).toBe('smp_c');
    expect(inside!.sample!.start).toBeCloseTo(0.25, 9);
    expect(inside!.sample!.end).toBeCloseTo(0.75, 9);
    expect(outside!.sample).toEqual({ id: 'smp_a', start: 0.7, end: 0.9, rootNote: 60 });
    expect((q.tracks[7].instrument as SamplerInstrument).params).toMatchObject({ start: 0, end: 1 });
    // The old recording still plays in a clip: it is kept.
    expect(q.samples.map((s) => s.id)).toEqual(['smp_a', 'smp_c']);
    valid(q);
  });

  it('a version of one clip’s recording keeps the old one while the part (or another clip) still plays it', () => {
    const store = partTake();
    expect(addSampleVersion(store, 't8', 'smp_a', meta('smp_d'), { label: 'Reverse recording', slot: 0 }).changed).toBe(true);
    const p = store.getState();
    expect(p.tracks[7].clips[0]!.sample!.id).toBe('smp_d');
    expect((p.tracks[7].instrument as SamplerInstrument).sampleId).toBe('smp_a');
    expect(p.samples.map((s) => s.id)).toEqual(['smp_a', 'smp_d']);
    valid(p);
  });
});

describe('a clip’s own recording: region, root and which recording', () => {
  function setup() {
    const store = new ProjectStore(HOUSE.build());
    const t = vocal(store.getState());
    addRecordedTake(store, { trackId: t.id, meta: meta('smp_take1'), slot: 0, bars: 1, bpm: 124, clipName: 'Recording 1' });
    return { store, id: t.id };
  }

  it('trims the region and sets the root note; a drag is one undo step', () => {
    const { store, id } = setup();
    const undo = store.historySize().undo;
    setClipSampleRegion(store, id, 0, { start: 0.1 }, 'drag-1');
    setClipSampleRegion(store, id, 0, { start: 0.2, end: 0.8 }, 'drag-1');
    expect(store.historySize().undo).toBe(undo + 1);
    expect(store.undoLabel()).toBe('Trim clip recording');
    setClipSampleRegion(store, id, 0, { rootNote: 64 });
    expect(store.undoLabel()).toBe('Change clip root note');
    expect(vocal(store.getState()).clips[0]!.sample).toEqual({ id: 'smp_take1', start: 0.2, end: 0.8, rootNote: 64 });
  });

  it('refuses a region that is not valid and an unknown recording, with nothing changed', () => {
    const { store, id } = setup();
    const before = store.getState();
    expect(setClipSampleRegion(store, id, 0, { start: 0.8, end: 0.2 }).changed).toBe(false);
    expect(setClipSampleRegion(store, id, 0, { end: 1.2 }).changed).toBe(false);
    expect(setClipSampleRegion(store, id, 0, { rootNote: 130 }).changed).toBe(false);
    expect(setClipSampleRegion(store, id, 0, { id: 'smp_gone' })).toMatchObject({ changed: false, message: 'That recording is not in this project.' });
    // An empty pad has no clip to give a recording.
    expect(setClipSampleRegion(store, id, 1, { start: 0.5 })).toMatchObject({ changed: false, reason: 'not-found' });
    expect(store.getState()).toBe(before);
  });

  it('gives a clip another recording, starts one from the part’s, and goes back to the part’s with null', () => {
    const { store, id } = setup();
    setClipSampleRegion(store, id, 0, { id: 'builtin:bell-hit' });
    expect(store.undoLabel()).toBe('Change clip recording');
    expect(vocal(store.getState()).clips[0]!.sample!.id).toBe('builtin:bell-hit');
    // Oh Chops plays the part's recording; it can get its own, starting from the part's.
    setClipSampleRegion(store, id, 2, { start: 0.5 });
    expect(vocal(store.getState()).clips[2]!.sample).toEqual({ id: 'builtin:vocal-oh', start: 0.5, end: 1, rootNote: 60 });
    setClipSampleRegion(store, id, 2, null);
    expect(vocal(store.getState()).clips[2]!.sample).toBeUndefined();
    valid(store.getState());
  });
});
