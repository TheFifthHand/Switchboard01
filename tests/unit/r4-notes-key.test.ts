/**
 * A key change that moves the song (PLAY-04, capability-04) and transposing
 * a clip by steps of the key.
 */
import { describe, expect, it } from 'vitest';
import { getStarter } from '../../src/content/starters';
import { isInScale } from '../../src/music/scales';
import type { Project, Track } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { transposeClipInScale } from '../../src/state/commands/notes';
import { setKey, transposeSong } from '../../src/state/commands/project';

function house() {
  return new ProjectStore(getStarter('house')!.build());
}
const part = (p: Project, role: string): Track => p.tracks.find((t) => t.role === role)!;
const clipNamed = (t: Track, name: string) => t.clips.find((c) => c?.name === name)!;
const pitches = (t: Track, name: string) => clipNamed(t, name).notes.map((n) => n.pitch);
const valid = (p: Project) => {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  return r.ok && r.warnings.length === 0;
};

describe('move the song to a new key', () => {
  it('moves Bass “Bounce” up 2 from G to A Dorian, leaves drums alone, and undoes key and notes together', () => {
    const store = house();
    const before = store.getState();
    expect(before.root).toBe(7);
    expect(before.scale).toBe('dorian');
    const bounce = pitches(part(before, 'bass'), 'Bounce');
    const drums = part(before, 'drums').clips;
    const r = transposeSong(store, { root: 9, scale: 'dorian' });
    expect(r.changed).toBe(true);
    const after = store.getState();
    expect([after.root, after.scale]).toEqual([9, 'dorian']);
    expect(pitches(part(after, 'bass'), 'Bounce')).toEqual(bounce.map((p) => p + 2));
    expect(pitches(part(after, 'chords'), 'Stabs')).toEqual(pitches(part(before, 'chords'), 'Stabs').map((p) => p + 2));
    // Drums never move; the sampler part is not listed, so its recording keeps its pitch.
    expect(part(after, 'drums').clips).toBe(drums);
    expect(part(after, 'percussion').clips).toBe(part(before, 'percussion').clips);
    expect(part(after, 'sampler').clips).toBe(part(before, 'sampler').clips);
    // Counts for the toast: every bass and synth clip.
    const melodic = before.tracks.filter((t) => t.instrument.kind === 'bass' || t.instrument.kind === 'poly');
    const clips = melodic.flatMap((t) => t.clips.filter((c) => c && c.notes.length));
    expect(r.clips).toBe(clips.length);
    expect(r.notes).toBe(clips.reduce((s, c) => s + c!.notes.length, 0));
    expect(r.clamped).toBe(0);
    expect(store.undoLabel()).toBe('Move the song to A Dorian');
    expect(valid(after)).toBe(true);

    store.undo();
    const undone = store.getState();
    expect([undone.root, undone.scale]).toEqual([7, 'dorian']);
    expect(undone.tracks).toEqual(before.tracks);
  });

  it('maps scale degrees from Dorian to Aeolian: every moved note stays in the new key, and E becomes E♭', () => {
    const store = house();
    const before = store.getState();
    transposeSong(store, { root: 7, scale: 'minor' });
    const after = store.getState();
    for (const t of after.tracks) {
      if (t.instrument.kind !== 'bass' && t.instrument.kind !== 'poly') continue;
      t.clips.forEach((c, slot) => {
        c?.notes.forEach((n, i) => {
          const old = before.tracks.find((x) => x.id === t.id)!.clips[slot]!.notes[i];
          if (isInScale(old.pitch, 7, 'dorian')) expect(isInScale(n.pitch, 7, 'minor'), `${t.name} ${c.name}`).toBe(true);
          // The Dorian sixth (E) is the only degree that changes: down a semitone.
          expect(n.pitch - old.pitch).toBe(old.pitch % 12 === 4 ? -1 : 0);
        });
      });
    }
    // The held chords' E4 (64) became E♭4 (63).
    const held = pitches(part(before, 'chords'), 'Held');
    expect(held).toContain(64);
    expect(pitches(part(after, 'chords'), 'Held')).toEqual(held.map((p) => (p === 64 ? 63 : p)));
    expect(store.undoLabel()).toBe('Move the song to G minor');
  });

  it('moves sampler parts only when they are listed, and refuses unknown parts', () => {
    const store = house();
    const before = store.getState();
    const sampler = part(before, 'sampler');
    const at = store.getState();
    expect(transposeSong(store, { root: 9, scale: 'dorian' }, { samplerParts: ['nope'] })).toMatchObject({ changed: false, reason: 'not-found' });
    expect(transposeSong(store, { root: 13.5 as never, scale: 'nope' as never })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState()).toBe(at);
    transposeSong(store, { root: 9, scale: 'dorian' }, { samplerParts: [sampler.id] });
    expect(pitches(part(store.getState(), 'sampler'), 'Oh Chops')).toEqual(pitches(sampler, 'Oh Chops').map((p) => p + 2));
    expect(part(store.getState(), 'drums').clips).toBe(part(before, 'drums').clips);
  });

  it('takes the shortest way (G to F goes down 2) and changes nothing when the key is the same', () => {
    const store = house();
    const bounce = pitches(part(store.getState(), 'bass'), 'Bounce');
    transposeSong(store, { root: 5, scale: 'dorian' });
    expect(pitches(part(store.getState(), 'bass'), 'Bounce')).toEqual(bounce.map((p) => p - 2));
    const at = store.getState();
    expect(transposeSong(store, { root: 17, scale: 'dorian' })).toMatchObject({ changed: false, clips: 0 });
    expect(store.getState()).toBe(at);
  });

  it('folds notes that would leave the range back an octave and counts them', () => {
    const store = house();
    store.apply('notes:Write', (d) => {
      d.tracks.find((t) => t.role === 'lead')!.clips[2]!.notes[0].pitch = 127;
    });
    const r = transposeSong(store, { root: 1, scale: 'dorian' });
    expect(r.clamped).toBe(1);
    expect(part(store.getState(), 'lead').clips[2]!.notes[0].pitch).toBe(127 + 6 - 12);
    expect(valid(store.getState())).toBe(true);
  });

  it('leaves recorded performance takes in their own key and says how many', () => {
    const store = house();
    const p = store.getState();
    store.apply('performance:Add take', (d) => {
      const snapshot = { bpm: p.bpm, swing: p.swing, root: p.root, scale: p.scale, assist: p.assist, masterVolumeDb: p.masterVolumeDb, tracks: p.tracks, scenes: p.scenes, patch: p.patch, launcher: [], seed: p.seed };
      d.performances.push({ id: 'take1', name: 'Take 1', createdAt: 0, startTick: 0, endTick: 384, snapshot: structuredClone(snapshot), events: [{ t: 0, type: 'noteOn', trackId: 't4', pitch: 62, velocity: 0.8, key: 'k' }] });
    });
    const take = store.getState().performances[0];
    const r = transposeSong(store, { root: 9, scale: 'dorian' });
    expect(r).toMatchObject({ changed: true, takesKept: 1 });
    expect(store.getState().performances[0]).toBe(take);
    expect(store.getState().performances[0].snapshot.root).toBe(7);
  });

  it('names the root when moving to the chromatic scale', () => {
    const store = house();
    expect(transposeSong(store, { root: 2, scale: 'chromatic' })).toMatchObject({ changed: true, takesKept: 0 });
    expect(store.undoLabel()).toBe('Move the song to D chromatic');
    const bounce = pitches(part(store.getState(), 'bass'), 'Bounce');
    store.undo();
    // To chromatic, notes move by the interval only (G to D: down 5).
    expect(bounce).toEqual(pitches(part(store.getState(), 'bass'), 'Bounce').map((p) => p - 5));
  });

  it('is refused during a performance take, like the key change itself', () => {
    const store = house();
    store.setLock('Recording a performance', (label) => label === 'project:Change tempo');
    const at = store.getState();
    expect(transposeSong(store, { root: 9, scale: 'dorian' })).toMatchObject({ changed: false, refused: 'Recording a performance', clips: 0, notes: 0 });
    expect(setKey(store, 9, 'dorian').changed).toBe(false);
    expect(store.getState()).toBe(at);
  });
});

describe('transpose a clip by steps of the key', () => {
  it('moves the Chords stabs one step of G Dorian, every note staying in key, and ±7 steps is an octave', () => {
    const store = house();
    const chords = part(store.getState(), 'chords');
    const slot = chords.clips.findIndex((c) => c?.name === 'Stabs');
    const before = chords.clips[slot]!.notes.map((n) => n.pitch);
    const r = transposeClipInScale(store, chords.id, slot, 1);
    expect(r).toMatchObject({ changed: true });
    expect(r.moved).toBe(before.length);
    const up = store.getState().tracks.find((t) => t.id === chords.id)!.clips[slot]!.notes.map((n) => n.pitch);
    up.forEach((p, i) => {
      if (isInScale(before[i], 7, 'dorian')) expect(isInScale(p, 7, 'dorian')).toBe(true);
      expect(p - before[i]).toBeGreaterThanOrEqual(1);
      expect(p - before[i]).toBeLessThanOrEqual(2);
    });
    expect(store.undoLabel()).toBe('Transpose clip up 1 scale step');
    store.undo();
    transposeClipInScale(store, chords.id, slot, 7);
    expect(store.getState().tracks.find((t) => t.id === chords.id)!.clips[slot]!.notes.map((n) => n.pitch)).toEqual(before.map((p) => p + 12));
  });

  it('refuses drums and non-integer steps', () => {
    const store = house();
    const at = store.getState();
    expect(transposeClipInScale(store, 't1', 1, 1)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(transposeClipInScale(store, 't4', 1, 0.5)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState()).toBe(at);
  });
});
