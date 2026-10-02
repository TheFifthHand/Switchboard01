/**
 * Chord help for non-theory users (PLAY-12, capability-03, PLAY-23): chord
 * names spelled in the key, one-finger chords in key, and "Write a
 * progression…" voice-led into the part's register.
 */
import { describe, expect, it } from 'vitest';
import { getStarter } from '../../src/content/starters';
import { PROGRESSIONS, chordAt, chordName, getProgression, harmonicParent, pitchClassSet, resolveProgression, romanNumeral, spellChord, voiceLeadLoop, voiceLeadingDistance } from '../../src/music/chords';
import { SCALES, isInScale, relativeMajorRoot } from '../../src/music/scales';
import { createProject } from '../../src/project/factory';
import type { Note, ScaleId } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { chordForPad, createProgressionClip } from '../../src/state/commands/notes';

const SCALES_LIST: ScaleId[] = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonicMinor', 'majorPentatonic', 'minorPentatonic', 'blues', 'chromatic'];

/** Chords of a clip: the notes starting together, in time order. */
function chordsOf(notes: readonly Note[]): number[][] {
  const at = new Map<number, number[]>();
  for (const n of notes) at.set(n.tick, [...(at.get(n.tick) ?? []), n.pitch]);
  return [...at.entries()].sort((a, b) => a[0] - b[0]).map(([, ps]) => ps.sort((x, y) => x - y));
}

describe('chord names in the key', () => {
  it('reads G Dorian as Gm, Am, B♭, C, Dm, E°, F (and sevenths)', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => chordName(7, 'dorian', d))).toEqual(['Gm', 'Am', 'B♭', 'C', 'Dm', 'E°', 'F']);
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => chordName(7, 'dorian', d, { size: 4 }))).toEqual(['Gm7', 'Am7', 'B♭maj7', 'C7', 'Dm7', 'Em7♭5', 'Fmaj7']);
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => chordName(9, 'minor', d))).toEqual(['Am', 'B°', 'C', 'Dm', 'Em', 'F', 'G']);
    expect(chordName(9, 'harmonicMinor', 2)).toBe('C+');
    expect(chordName(9, 'harmonicMinor', 4)).toBe('E');
    expect(spellChord({ root: 7, quality: 'min', bass: 10 }, { root: 7, scale: 'dorian' })).toBe('Gm/B♭');
    expect(spellChord({ root: 10, quality: 'maj' })).toBe('A#');
  });

  it('names a chord for every degree of every key, with roman numerals beside it', () => {
    for (let root = 0; root < 12; root++) {
      for (const scale of SCALES_LIST) {
        for (let d = 0; d < 7; d++) {
          expect(chordName(root, scale, d).length).toBeGreaterThan(0);
          expect(chordName(root, scale, d, { size: 4 }).length).toBeGreaterThan(0);
        }
      }
    }
    expect(romanNumeral(7, 'dorian', 3)).toBe('IV');
  });
});

describe('chordAt: one-finger chords in key', () => {
  it('builds the diatonic chord around a register, every note in key', () => {
    for (let root = 0; root < 12; root++) {
      for (const scale of ['major', 'minor', 'dorian', 'mixolydian'] as ScaleId[]) {
        for (let d = 0; d < 7; d++) {
          for (const size of [3, 4] as const) {
            const c = chordAt(root, scale, d, { size, near: 60 });
            expect(c).toHaveLength(size);
            expect(c.every((p) => isInScale(p, root, scale))).toBe(true);
            expect(Math.abs(c.reduce((s, p) => s + p, 0) / size - 60)).toBeLessThanOrEqual(7);
            expect([...c].sort((a, b) => a - b)).toEqual(c);
          }
        }
      }
    }
    // G Dorian, degree 0 near G3: G B♭ D.
    expect(chordAt(7, 'dorian', 0, { near: 58 })).toEqual([55, 58, 62]);
    // An inversion keeps its shape: first inversion of Gm is B♭ D G.
    expect(chordAt(7, 'dorian', 0, { inversion: 1, near: 64 })).toEqual([58, 62, 67]);
    expect(chordAt(7, 'dorian', 0, { inversion: 2, near: 64 })).toEqual([62, 67, 70]);
    // Leading from a chord moves as little as possible.
    const from = chordAt(7, 'dorian', 0, { near: 60 });
    const next = chordAt(7, 'dorian', 3, { near: 60, from });
    expect(pitchClassSet(next)).toEqual(pitchClassSet([0, 4, 7]));
    expect(voiceLeadingDistance(from, next)).toBeLessThanOrEqual(5);
  });

  it('places chord pads in the register the part already plays', () => {
    const p = getStarter('house')!.build();
    const chords = p.tracks.find((t) => t.role === 'chords')!;
    const c = chordForPad(p, chords.id, 0);
    expect(pitchClassSet(c)).toEqual(pitchClassSet([7, 10, 2]));
    expect(Math.min(...c)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...c)).toBeLessThanOrEqual(80);
  });
});

describe('progressions', () => {
  it('lists eight progressions with plain names and roman numerals', () => {
    expect(PROGRESSIONS).toHaveLength(8);
    expect(PROGRESSIONS.map((p) => p.numerals)).toEqual(['I–V–vi–IV', 'vi–IV–I–V', 'I–vi–IV–V', 'ii–V–I', 'i–VI–III–VII', 'i–iv–v–i', 'i–VII–VI–VII', 'I–IV–vi–V']);
    expect(getProgression('pop')!.name).toBe('Pop');
    expect(getProgression('sad-pop')!.name).toBe('Sad pop');
    expect(new Set(PROGRESSIONS.map((p) => p.id)).size).toBe(8);
    expect(new Set(PROGRESSIONS.map((p) => p.name)).size).toBe(8);
  });

  it('places each progression in the key with major and minor chords, every note in key', () => {
    expect(resolveProgression(0, 'major', getProgression('pop')!).names).toEqual(['C', 'G', 'Am', 'F']);
    expect(resolveProgression(9, 'minor', getProgression('sad-pop')!).names).toEqual(['Am', 'F', 'C', 'G']);
    // G Dorian: the major-key Pop is played from F, the key's relative major.
    expect(resolveProgression(7, 'dorian', getProgression('pop')!).names).toEqual(['F', 'C', 'Dm', 'B♭']);
    // Dorian's own colour where it suits: i–iv–v–i from G gives Gm C Dm Gm.
    expect(resolveProgression(7, 'dorian', getProgression('moody')!).names).toEqual(['Gm', 'C', 'Dm', 'Gm']);
    // Harmonic minor: the dominant is major.
    expect(resolveProgression(9, 'harmonicMinor', getProgression('moody')!).names).toEqual(['Am', 'Dm', 'E', 'Am']);
    for (let root = 0; root < 12; root++) {
      for (const scale of SCALES_LIST) {
        for (const prog of PROGRESSIONS) {
          const r = resolveProgression(root, scale, prog);
          for (const c of r.chords) {
            const third = c[1] - c[0];
            const fifth = c[2] - c[0];
            expect(fifth, `${prog.name} in ${root} ${scale}`).toBe(7);
            expect([3, 4]).toContain(third);
            // The rule: every chord note is in the key's seven-note scale; pentatonic, blues and chromatic keys use their parent's.
            expect(c.every((p) => isInScale(p, root, harmonicParent(scale)))).toBe(true);
            if (harmonicParent(scale) === scale) expect(c.every((p) => isInScale(p, root, scale))).toBe(true);
          }
        }
      }
    }
  });

  it('starts only from the key’s root or its relative major / minor, so every progression comes home', () => {
    // Harmonic minor: the Jazz turn ends on the home chord, not on V.
    expect(resolveProgression(7, 'harmonicMinor', getProgression('jazz-turn')!).names).toEqual(['Cm', 'D', 'Gm', 'Gm']);
    expect(resolveProgression(0, 'harmonicMinor', getProgression('jazz-turn')!).names).toEqual(['Fm', 'G', 'Cm', 'Cm']);
    for (let root = 0; root < 12; root++) {
      for (const scale of SCALES_LIST) {
        const iv = SCALES[harmonicParent(scale)].intervals;
        for (const prog of PROGRESSIONS) {
          const relPc = prog.home === 'major' ? relativeMajorRoot(root, scale) : (relativeMajorRoot(root, scale) + 9) % 12;
          const relative = iv.indexOf((relPc - root + 12) % 12);
          const r = resolveProgression(root, scale, prog);
          expect([0, relative], `${prog.name} in ${root} ${scale}`).toContain(r.anchor);
        }
        // The Jazz turn (ii–V–I–I) always lands on the chord it counts from.
        const jazz = resolveProgression(root, scale, getProgression('jazz-turn')!);
        expect(jazz.degrees[2]).toBe(jazz.anchor);
        expect(jazz.degrees[3]).toBe(jazz.anchor);
      }
    }
  });

  it('voice-leads every progression in every key with at most 7 semitones of movement per change (triads)', () => {
    for (let root = 0; root < 12; root++) {
      for (const scale of SCALES_LIST) {
        for (const prog of PROGRESSIONS) {
          const v = voiceLeadLoop(resolveProgression(root, scale, prog).chords, 50, 74);
          for (let i = 0; i < v.length; i++) expect(voiceLeadingDistance(v[i], v[(i + 1) % v.length]), `${prog.name} ${root} ${scale}`).toBeLessThanOrEqual(7);
        }
      }
    }
  });
});

describe('write a progression into a clip', () => {
  it('writes the Pop progression into an empty Chords slot: in key, voice-led, one undo step', () => {
    const p = createProject({ now: 0 });
    p.root = 7;
    p.scale = 'dorian';
    const store = new ProjectStore(p);
    const r = createProgressionClip(store, 't4', 0, { progressionId: 'pop', rhythm: 'held', bars: 4, size: 3 });
    expect(r).toMatchObject({ changed: true, notes: 12, chords: ['F', 'C', 'Dm', 'B♭'] });
    const clip = store.getState().tracks[3].clips[0]!;
    expect(clip.id).toBe(r.clipId);
    expect(clip.name).toBe('Pop');
    expect(clip.bars).toBe(4);
    expect(clip.notes.every((n) => isInScale(n.pitch, 7, 'dorian'))).toBe(true);
    const chords = chordsOf(clip.notes);
    expect(chords).toHaveLength(4);
    for (let i = 0; i < 4; i++) expect(voiceLeadingDistance(chords[i], chords[(i + 1) % 4])).toBeLessThanOrEqual(7);
    expect(chords.map((c) => pitchClassSet(c))).toEqual([pitchClassSet([5, 9, 0]), pitchClassSet([0, 4, 7]), pitchClassSet([2, 5, 9]), pitchClassSet([10, 2, 5])]);
    expect(store.undoLabel()).toBe('Write the Pop progression');
    const v = validateProject(JSON.parse(JSON.stringify(store.getState())));
    expect(v.ok && v.warnings).toEqual([]);
    store.undo();
    expect(store.getState().tracks[3].clips[0]).toBeNull();
  });

  it('follows the rhythm and length: stabs on every beat, off-beats between them, faster changes in short clips, repeats in long ones', () => {
    const p = createProject({ now: 0 });
    const store = new ProjectStore(p);
    createProgressionClip(store, 't4', 0, { progressionId: 'epic', rhythm: 'stabs', bars: 8, size: 4 });
    let clip = store.getState().tracks[3].clips[0]!;
    expect(clip.bars).toBe(8);
    const ticks = [...new Set(clip.notes.map((n) => n.tick))].sort((a, b) => a - b);
    expect(ticks).toEqual(Array.from({ length: 32 }, (_, i) => i * 96));
    const ch = chordsOf(clip.notes);
    // The loop repeats: bar 5 plays bar 1's chord, voiced the same.
    expect(ch[16]).toEqual(ch[0]);
    expect(ch.every((c) => c.length === 4)).toBe(true);

    createProgressionClip(store, 't4', 1, { progressionId: 'jazz-turn', rhythm: 'offbeats', bars: 2, size: 3 });
    clip = store.getState().tracks[3].clips[1]!;
    expect([...new Set(clip.notes.map((n) => n.tick))].sort((a, b) => a - b)).toEqual([48, 144, 240, 336, 432, 528, 624, 720]);
    expect(clip.notes.every((n) => n.tick + n.duration <= 768)).toBe(true);
  });

  it('writes the roots for a bass part, and replaces an existing clip’s notes and length (keeping its name)', () => {
    const store = new ProjectStore(getStarter('house')!.build());
    const bass = store.getState().tracks.find((t) => t.role === 'bass')!;
    const slot = bass.clips.findIndex((c) => c?.name === 'Bounce');
    const r = createProgressionClip(store, bass.id, slot, { progressionId: 'anthem', rhythm: 'offbeats', bars: 4, size: 3 });
    expect(r.changed).toBe(true);
    const clip = store.getState().tracks.find((t) => t.id === bass.id)!.clips[slot]!;
    expect(clip.name).toBe('Bounce');
    expect(clip.bars).toBe(4);
    // One note at a time, the chord roots of Dm C B♭ C (Anthem from G Dorian's relative minor, D).
    expect(chordsOf(clip.notes).every((c) => c.length === 1)).toBe(true);
    expect(r.chords).toEqual(['Dm', 'C', 'B♭', 'C']);
    const roots = [0, 1, 2, 3].map((bar) => clip.notes.find((n) => n.tick >= bar * 384)!.pitch % 12);
    expect(roots).toEqual([2, 0, 10, 0]);
    expect(Math.max(...clip.notes.map((n) => n.pitch))).toBeLessThanOrEqual(60);
  });

  it('in a pentatonic or blues key uses the parent scale’s chords and says so', () => {
    const p = createProject({ now: 0 });
    p.root = 0;
    p.scale = 'minorPentatonic';
    const store = new ProjectStore(p);
    const r = createProgressionClip(store, 't4', 0, { progressionId: 'moody', rhythm: 'held', bars: 4, size: 3 });
    expect(r).toMatchObject({ changed: true, chords: ['Cm', 'Fm', 'Gm', 'Cm'], message: 'C minor pentatonic has too few notes for full chords, so the chords use the notes of C minor.' });
    const clip = store.getState().tracks[3].clips[0]!;
    expect(clip.notes.every((n) => isInScale(n.pitch, 0, 'minor'))).toBe(true);
    // A♭ (Fm) and D (Gm) are chord notes the five-note key does not have.
    expect(clip.notes.some((n) => !isInScale(n.pitch, 0, 'minorPentatonic'))).toBe(true);
    const chromatic = createProject({ now: 0 });
    chromatic.scale = 'chromatic';
    chromatic.root = 2;
    const s2 = new ProjectStore(chromatic);
    expect(createProgressionClip(s2, 't4', 0, { progressionId: 'pop', rhythm: 'held', bars: 4, size: 3 }).message).toBe('A chromatic key has no chords of its own, so the chords use the notes of D major.');
    const s3 = new ProjectStore(createProject({ now: 0 }));
    expect(createProgressionClip(s3, 't4', 0, { progressionId: 'pop', rhythm: 'held', bars: 4, size: 3 }).message).toBeUndefined();
  });

  it('refuses drums and sampler parts with a reason, and bad options, changing nothing', () => {
    const store = new ProjectStore(createProject({ now: 0 }));
    const at = store.getState();
    const ok = { progressionId: 'pop', rhythm: 'held' as const, bars: 4, size: 3 as const };
    expect(createProgressionClip(store, 't1', 0, ok)).toMatchObject({ changed: false, reason: 'invalid', message: expect.stringMatching(/Drum parts/) });
    expect(createProgressionClip(store, 't8', 0, ok)).toMatchObject({ changed: false, reason: 'invalid', message: expect.stringMatching(/keeps its own pitch/) });
    expect(createProgressionClip(store, 't4', 0, { ...ok, progressionId: 'nope' })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(createProgressionClip(store, 't4', 0, { ...ok, bars: 9 })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(createProgressionClip(store, 't4', 0, { ...ok, rhythm: 'swing' as never })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(createProgressionClip(store, 't4', 0, { ...ok, size: 5 as never })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(createProgressionClip(store, 't4', 5, ok)).toMatchObject({ changed: false, reason: 'invalid' });
    store.setLock('Recording a performance', () => false);
    expect(createProgressionClip(store, 't4', 0, ok)).toMatchObject({ changed: false, refused: 'Recording a performance', notes: 0 });
    expect(store.getState()).toBe(at);
  });

  it('is deterministic', () => {
    const make = () => {
      const store = new ProjectStore(getStarter('house')!.build());
      createProgressionClip(store, 't6', 1, { progressionId: 'uplift', rhythm: 'stabs', bars: 4, size: 4 });
      return store.getState().tracks[5].clips[1]!.notes.map(({ tick, pitch, velocity, duration }) => [tick, pitch, velocity, duration]);
    };
    expect(make()).toEqual(make());
  });
});
