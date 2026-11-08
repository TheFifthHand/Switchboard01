/**
 * The five beat-maker starters (Trap, Lo-fi Hip Hop, Pop, Afrobeats, Boom
 * Bap) have their style's character. The shared starter checks (valid
 * project, scale, ranges, scene shape, clashes, levels, song) run for every
 * starter in starters.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { getStarter } from '../../src/content/starters';
import { identifyChord } from '../../src/music/chords';
import { TICKS_PER_BAR, TICKS_PER_BEAT, type Project, type Track, type TrackRole } from '../../src/project/types';

const GROOVE = 1;
const LIFT = 2;

const byRole = (p: Project, role: TrackRole): Track => p.tracks.find((t) => t.role === role)!;
const soundOf = (t: Track) => (t.instrument.kind === 'drums' ? t.instrument.kitId : t.instrument.kind === 'sampler' ? t.instrument.sampleId : t.instrument.presetId);

/** Chord symbols of a chord clip, one per onset group, as roots (pitch classes) in order of time. */
function chordRoots(t: Track, row: number): number[] {
  const byTick = new Map<number, number[]>();
  for (const n of t.clips[row]!.notes) byTick.set(n.tick, [...(byTick.get(n.tick) ?? []), n.pitch]);
  const roots: number[] = [];
  for (const [, pitches] of [...byTick].sort((a, b) => a[0] - b[0])) {
    if (pitches.length < 3) continue;
    const r = identifyChord(pitches)?.root;
    if (r !== undefined && roots[roots.length - 1] !== r) roots.push(r);
  }
  return roots;
}

describe('Trap', () => {
  const p = getStarter('trap')!.build();

  it('plays half time at about 140 BPM: the clap lands on beat three of every bar, nowhere else', () => {
    expect(p.bpm).toBeGreaterThanOrEqual(130);
    expect(p.bpm).toBeLessThanOrEqual(150);
    const groove = byRole(p, 'drums').clips[GROOVE]!;
    const claps = groove.notes.filter((n) => n.pitch === 3).map((n) => n.tick % TICKS_PER_BAR);
    expect(claps.length).toBe(groove.bars);
    for (const t of claps) expect(t).toBe(2 * TICKS_PER_BEAT);
  });

  it('rolls its hi-hats in 32nd notes', () => {
    const groove = byRole(p, 'drums').clips[GROOVE]!;
    const hats = groove.notes.filter((n) => n.pitch === 4).map((n) => n.tick);
    expect(hats.slice(1).some((t, i) => t - hats[i] === TICKS_PER_BAR / 32)).toBe(true);
  });

  it('slides a long 808 between roots', () => {
    const bass = byRole(p, 'bass');
    expect(soundOf(bass)).toBe('bass-808-boom');
    expect(bass.instrument.params.glide).toBeGreaterThan(0.07);
    const notes = bass.clips[GROOVE]!.notes;
    expect(notes.some((n) => notes.some((m) => m.tick > n.tick && m.tick < n.tick + n.duration && m.pitch !== n.pitch))).toBe(true);
    expect(byRole(p, 'drums').instrument).toMatchObject({ kitId: 'trap-night' });
  });
});

describe('Lo-fi Hip Hop', () => {
  const p = getStarter('lofi')!.build();

  it('is slow and lazily swung, on the crushed Lo-fi Crate kit and the Dusty Keys', () => {
    expect(p.bpm).toBeLessThanOrEqual(90);
    expect(p.swing).toBeGreaterThanOrEqual(0.3);
    expect(soundOf(byRole(p, 'drums'))).toBe('lofi-crate');
    expect(soundOf(byRole(p, 'chords'))).toBe('poly-dusty-keys');
  });

  it('plays four-note jazz chords (ninths) in the Groove', () => {
    const notes = byRole(p, 'chords').clips[GROOVE]!.notes;
    const sizes = new Map<number, number>();
    for (const n of notes) sizes.set(n.tick, (sizes.get(n.tick) ?? 0) + 1);
    for (const size of sizes.values()) expect(size).toBe(4);
  });
});

describe('Pop', () => {
  const p = getStarter('pop')!.build();

  it('plays the four-chord I–V–vi–IV in the Verse and a hook in the Chorus', () => {
    // B♭ major: B♭ (10), F (5), Gm (7), E♭ (3).
    expect(chordRoots(byRole(p, 'chords'), GROOVE)).toEqual([10, 5, 7, 3]);
    expect(byRole(p, 'lead').clips[LIFT]!.notes.length).toBeGreaterThan(20);
    expect(soundOf(byRole(p, 'chords'))).toBe('poly-bright-piano');
  });
});

describe('Afrobeats', () => {
  const p = getStarter('afrobeats')!.build();

  it('puts hand drums on the Afro Latin kit under a log-drum bass, with a light swing', () => {
    expect(soundOf(byRole(p, 'percussion'))).toBe('afro-latin');
    expect(soundOf(byRole(p, 'bass'))).toBe('bass-log-drum');
    expect(p.swing).toBeGreaterThan(0);
    expect(p.bpm).toBeGreaterThanOrEqual(98);
    expect(p.bpm).toBeLessThanOrEqual(112);
  });

  it('keeps the chords off the downbeats in the Groove (a skank)', () => {
    const notes = byRole(p, 'chords').clips[GROOVE]!.notes;
    expect(notes.every((n) => n.tick % TICKS_PER_BEAT !== 0)).toBe(true);
  });
});

describe('Boom Bap', () => {
  const p = getStarter('boomBap')!.build();

  it('nods at about 90 BPM on the Breakbeat Crate kit with a two-chord soul loop', () => {
    expect(Math.abs(p.bpm - 90)).toBeLessThanOrEqual(4);
    expect(soundOf(byRole(p, 'drums'))).toBe('break-crate');
    // Two voicings only (Dm9 and G13), whose single moving voice is the hook of the loop.
    const byTick = new Map<number, number[]>();
    for (const n of byRole(p, 'chords').clips[GROOVE]!.notes) byTick.set(n.tick, [...(byTick.get(n.tick) ?? []), n.pitch]);
    const voicings = [...new Set([...byTick.values()].map((v) => v.sort((a, b) => a - b).join(' ')))].map((v) => v.split(' ').map(Number));
    expect(voicings).toHaveLength(2);
    expect(voicings[0].filter((x) => !voicings[1].includes(x))).toHaveLength(1);
  });

  it('answers with a sampled chord hit over the tonic chord only', () => {
    const hits = byRole(p, 'sampler').clips[GROOVE]!.notes;
    expect(hits.length).toBeGreaterThan(0);
    // The glass chord plays a minor-seventh chord on each note: on D it is D F A C, all tones of Dm9.
    for (const n of hits) {
      expect(n.pitch % 12).toBe(2);
      expect(n.tick + n.duration).toBeLessThanOrEqual(2 * TICKS_PER_BAR);
    }
  });
});

describe('the beat-maker starters together', () => {
  it('use the new sounds and each starter has its own key', () => {
    const ps = ['trap', 'lofi', 'pop', 'afrobeats', 'boomBap'].map((id) => getStarter(id)!.build());
    const sounds = new Set(ps.flatMap((p) => p.tracks.map(soundOf)));
    for (const id of ['poly-dusty-keys', 'poly-bright-piano', 'poly-soft-pluck', 'bass-log-drum']) expect(sounds.has(id), id).toBe(true);
    expect(new Set(ps.map((p) => `${p.root}:${p.scale}`)).size).toBe(5);
  });
});
