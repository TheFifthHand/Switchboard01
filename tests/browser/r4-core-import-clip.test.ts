/**
 * shape-05: importing a recording makes a new clip that plays it as
 * recorded (one undo step), on the part's selected pad when it is empty or
 * the next empty one; the new clip is selected, other clips keep their
 * recordings, and the message says where it went (or why it could not).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchRuntime } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { applySamplerToProject } from '../../src/content/presets';
import { createClip, createProject } from '../../src/project/factory';
import type { Project, SamplerInstrument } from '../../src/project/types';
import { encodeWav } from '../../src/render/wav';
import * as db from '../../src/persistence/db';
import { selectSlot, uiStore } from '../../src/state/uiStore';

const SR = 48000;

/** A WAV file of `seconds` of a quiet tone. */
function wavFile(name: string, seconds: number): File {
  const n = Math.round(seconds * SR);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return new File([encodeWav([ch, ch], SR, 16)], name, { type: 'audio/wav' });
}

/** t8 is a sampler on builtin:vocal-oh with a clip in rows 0 and 2; t3 (Bass) a synth with a clip in row 0. */
function project(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  p.seed = 9;
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  applySamplerToProject(p, 't8', 'builtin:vocal-oh');
  const t8 = p.tracks.find((t) => t.id === 't8')!;
  t8.instrument.params.mode = 0;
  t8.clips[0] = createClip('Oh Chops', 1, [{ tick: 0, pitch: 62, velocity: 1, duration: 48 }]);
  t8.clips[2] = createClip('Long Oh', 1, [{ tick: 0, pitch: 55, velocity: 1, duration: 384 }]);
  p.tracks.find((t) => t.id === 't3')!.clips[0] = createClip('Bounce', 1, [{ tick: 0, pitch: 36, velocity: 1, duration: 96 }]);
  return p;
}

let live: Session[] = [];
beforeEach(async () => {
  await db.deleteDb();
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null });
});
afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  await db.deleteDb();
});

function session(): Session {
  const s = new Session(project());
  live.push(s);
  return s;
}

describe('Import a recording as a clip (shape-05)', () => {
  it('makes a clip on the selected empty pad that plays the file once at its own pitch; other clips keep theirs; one undo step', async () => {
    const s = session();
    selectSlot('t8', 1);
    const before = s.store.getState();
    // 2 bars at 120 BPM (4 s).
    const r = await s.importSample(wavFile('Loop 1.wav', 4), 't8');
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toBe(`Imported “Loop 1” as a new clip on Sampler · ${before.scenes[1].name}. It plays at its recorded pitch.`);
    const p = s.store.getState();
    const meta = p.samples.find((x) => x.name === 'Loop 1')!;
    expect(meta).toBeTruthy();
    const t8 = p.tracks.find((t) => t.id === 't8')!;
    const clip = t8.clips[1]!;
    expect(clip.bars).toBe(2);
    expect(clip.sample).toEqual({ id: meta.id, start: 0, end: 1, rootNote: 60 });
    expect(clip.notes).toEqual([expect.objectContaining({ tick: 0, pitch: 60, duration: 768 })]);
    // The other clips and the part's recording stay as they were.
    expect(t8.clips[0]).toBe(before.tracks.find((t) => t.id === 't8')!.clips[0]);
    expect(t8.clips[2]).toBe(before.tracks.find((t) => t.id === 't8')!.clips[2]);
    expect((t8.instrument as SamplerInstrument).sampleId).toBe('builtin:vocal-oh');
    // The new clip is selected.
    expect(uiStore.getState().selectedSlot.t8).toBe(1);
    expect(uiStore.getState().selectedTrackId).toBe('t8');
    // The file is stored; one Undo removes the clip and the recording from the project.
    expect(await db.getSample(meta.id)).toBeTruthy();
    s.undo();
    expect(s.store.getState().samples).toEqual(before.samples);
    expect(s.store.getState().tracks.find((t) => t.id === 't8')!.clips[1]).toBeNull();
  });

  it('the selected pad is taken: the next empty pad gets it; every pad taken: refused, nothing changes and nothing is left stored', async () => {
    const s = session();
    selectSlot('t8', 0);
    const r = await s.importSample(wavFile('Loop 2.wav', 2), 't8');
    expect(r.ok, r.message).toBe(true);
    expect(s.store.getState().tracks.find((t) => t.id === 't8')!.clips[1]?.name).toBe('Loop 2');
    expect(uiStore.getState().selectedSlot.t8).toBe(1);
    const r2 = await s.importSample(wavFile('Loop 3.wav', 2), 't8');
    expect(r2.ok).toBe(true);
    expect(s.store.getState().tracks.find((t) => t.id === 't8')!.clips[3]?.name).toBe('Loop 3');
    const before = s.store.getState();
    const stored = new Set(await db.listSampleIds());
    const r3 = await s.importSample(wavFile('Loop 4.wav', 2), 't8');
    expect(r3).toEqual({ ok: false, message: 'No empty pad on Sampler: delete or move a clip first.' });
    expect(s.store.getState()).toBe(before);
    // The file stored for it went again.
    await new Promise((r) => setTimeout(r, 50));
    expect(new Set(await db.listSampleIds())).toEqual(stored);
  });

  it('onto a synth part: it becomes a sampler, and the message says its other clips now play the recording', async () => {
    const s = session();
    selectSlot('t3', 1);
    const r = await s.importSample(wavFile('Loop 5.wav', 2), 't3');
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^Imported “Loop 5” as a new clip on Bass · .*\. It plays at its recorded pitch\. Bass plays recordings now, so its other clips play this one at their notes’ pitches\.$/);
    expect(s.store.getState().tracks.find((t) => t.id === 't3')!.instrument.kind).toBe('sampler');
  });

  it('a part whose sampler settings transpose or loop says so', async () => {
    const s = session();
    s.store.apply('sample:Change Pitch', (d) => {
      d.tracks.find((t) => t.id === 't8')!.instrument.params.pitch = 5;
    });
    selectSlot('t8', 1);
    const r = await s.importSample(wavFile('Loop 6.wav', 2), 't8');
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/It plays with Sampler’s sampler settings \(transposed\): set them in Shape to hear it as recorded\.$/);
  });
});
