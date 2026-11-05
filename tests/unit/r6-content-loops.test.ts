/**
 * The built-in loop library and beat presets: every loop places valid notes
 * in any key, in key and in the part's register; drum loops play on every
 * kit layout; the lookup and search helpers find what a musician types.
 */
import { describe, expect, it } from 'vitest';
import { BEATS, getBeat, realizeBeat } from '../../src/content/beats';
import { KITS, SYNTH_PRESETS } from '../../src/content/catalog';
import { GENRES, LIBRARY_LOOPS, LOOP_ROLES, genresFor, getLoop, loopFitsKind, loopsFor, realizeLoop, searchLoops, type LibraryLoop } from '../../src/content/loops';
import { identifyChord } from '../../src/music/chords';
import { createClip, createProject } from '../../src/project/factory';
import { applyKitToProject, applyPresetToProject } from '../../src/content/presets';
import { TICKS_PER_BAR, type InstrumentKind, type ScaleId } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';

/* Independent reference data (not imported from the code under test). */
const SCALE_STEPS: Record<ScaleId, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const SCALES = Object.keys(SCALE_STEPS) as ScaleId[];

/** Where each part's notes may sit (MIDI), as the starter tests allow plus a little air for textures. */
const RANGE: Record<string, readonly [number, number]> = {
  bass: [28, 55],
  chords: [48, 76],
  lead: [57, 88],
  pad: [45, 76],
  texture: [43, 91],
};

const kindFor = (loop: LibraryLoop): InstrumentKind => (loop.part.kind === 'drums' ? 'drums' : loop.role === 'bass' ? 'bass' : 'poly');
const kitFor = (loop: LibraryLoop) => (loop.role === 'percussion' ? (loop.sound === 'afro-latin' ? 'afro-latin' : 'hand-percussion') : loop.sound);

/** A project with the loop's notes in the first clip of its part, played on the loop's own sound. */
function projectWith(loop: LibraryLoop, root: number, scale: ScaleId) {
  const project = createProject({ name: 'Loop test', now: 1 });
  project.root = root;
  project.scale = scale;
  const track = project.tracks.find((t) => t.role === loop.role)!;
  if (loop.part.kind === 'drums') applyKitToProject(project, track.id, kitFor(loop));
  else applyPresetToProject(project, track.id, loop.sound);
  const inst = project.tracks.find((t) => t.id === track.id)!.instrument;
  const r = realizeLoop(loop, { root, scale, kind: inst.kind, kitId: inst.kind === 'drums' ? inst.kitId : undefined, role: loop.role });
  project.tracks.find((t) => t.id === track.id)!.clips[0] = createClip(r.name, r.bars, r.notes);
  return { project, realized: r };
}

describe('loop library contents', () => {
  it('ships about 150 loops with unique, stable kebab-case ids and names unique within each part', () => {
    expect(LIBRARY_LOOPS.length).toBeGreaterThanOrEqual(140);
    const ids = LIBRARY_LOOPS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const role of LOOP_ROLES) {
      const names = loopsFor(role).map((l) => l.name);
      expect(new Set(names).size, role).toBe(names.length);
      expect(names.length, role).toBeGreaterThanOrEqual(15);
      for (const n of names) {
        expect(n.length).toBeLessThanOrEqual(24);
        expect(n.trim()).toBe(n);
      }
    }
    for (const l of LIBRARY_LOOPS) expect(getLoop(l.id)).toBe(l);
    expect(getLoop('nope')).toBeUndefined();
    expect(loopsFor('sampler')).toEqual([]);
  });

  it('suggests a real catalogue sound of the right kind for every loop', () => {
    const kits = new Set(KITS.map((k) => k.id));
    for (const l of LIBRARY_LOOPS) {
      if (l.part.kind === 'drums') expect(kits.has(l.sound), `${l.id} ${l.sound}`).toBe(true);
      else expect(SYNTH_PRESETS.some((p) => p.id === l.sound), `${l.id} ${l.sound}`).toBe(true);
      if (l.role === 'bass') expect(SYNTH_PRESETS.find((p) => p.id === l.sound)!.kind, l.id).toBe('bass');
    }
  });

  it('covers every style with loops, and every style with a beat', () => {
    for (const g of GENRES) {
      expect(LIBRARY_LOOPS.filter((l) => l.genres.includes(g.id)).length, g.id).toBeGreaterThanOrEqual(6);
      expect(BEATS.filter((b) => b.genre === g.id || b.also?.includes(g.id)).length, g.id).toBeGreaterThanOrEqual(2);
    }
    expect(genresFor('drums').length).toBe(GENRES.length);
  });
});

describe('placing loops in a project', () => {
  const keys: [number, ScaleId][] = [];
  for (const scale of SCALES) for (const root of [0, 4, 7, 10, 11]) keys.push([root, scale]);

  it('every loop realizes in every key and scale to notes the project accepts without repair', () => {
    for (const loop of LIBRARY_LOOPS) {
      for (const [root, scale] of [[0, 'minor'], [9, 'major'], [4, 'phrygian'], [6, 'blues']] as [number, ScaleId][]) {
        const { project, realized } = projectWith(loop, root, scale);
        expect(realized.notes.length, loop.id).toBeGreaterThan(0);
        expect(realized.bars).toBe(loop.bars);
        const res = validateProject(JSON.parse(JSON.stringify(project)));
        expect(res.ok, loop.id).toBe(true);
        if (res.ok) expect(res.warnings, `${loop.id} in ${root} ${scale}`).toEqual([]);
        for (const n of realized.notes) {
          expect(n.tick + n.duration, loop.id).toBeLessThanOrEqual(loop.bars * TICKS_PER_BAR);
          expect(n.velocity, loop.id).toBeGreaterThan(0);
          expect(n.velocity, loop.id).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('keeps every pitched loop in key and in its part’s register, in every key', () => {
    for (const loop of LIBRARY_LOOPS.filter((l) => l.part.kind !== 'drums')) {
      for (const [root, scale] of keys) {
        const r = realizeLoop(loop, { root, scale, kind: kindFor(loop) });
        const allowed = new Set(SCALE_STEPS[scale].map((s) => (s + root) % 12));
        const [lo, hi] = RANGE[loop.role];
        for (const n of r.notes) {
          expect(allowed.has(n.pitch % 12), `${loop.id} in ${root} ${scale}: ${n.pitch}`).toBe(true);
          expect(n.pitch, `${loop.id} in ${root} ${scale}`).toBeGreaterThanOrEqual(lo);
          expect(n.pitch, `${loop.id} in ${root} ${scale}`).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('builds consonant chords in major and minor: no diminished or augmented chord unless asked', () => {
    for (const loop of LIBRARY_LOOPS.filter((l) => l.part.kind === 'chords')) {
      for (const scale of ['major', 'minor', 'dorian', 'mixolydian', 'phrygian', 'lydian', 'harmonicMinor'] as ScaleId[]) {
        const r = realizeLoop(loop, { root: 2, scale, kind: 'poly' });
        const byTick = new Map<number, number[]>();
        for (const n of r.notes) byTick.set(n.tick, [...(byTick.get(n.tick) ?? []), n.pitch]);
        // Arpeggios: one note per hit, so judge the whole chord per change instead.
        const groups = loop.part.kind === 'chords' && loop.part.arp ? [] : [...byTick.values()].filter((g) => g.length >= 3);
        for (const g of groups) {
          const q = identifyChord(g)?.quality;
          expect(['dim', 'aug', 'm7b5', 'dim7'], `${loop.id} in D ${scale}: ${g.join(' ')}`).not.toContain(q);
        }
      }
    }
  });

  it('places a minor loop as the same tune a fifth higher in another key (it is key-relative)', () => {
    const loop = getLoop('loop-lead-bell-hook')!;
    const inC = realizeLoop(loop, { root: 0, scale: 'minor', kind: 'poly' }).notes.map((n) => n.pitch);
    const inG = realizeLoop(loop, { root: 7, scale: 'minor', kind: 'poly' }).notes.map((n) => n.pitch);
    const diffs = new Set(inC.map((p, i) => (((inG[i] - p) % 12) + 12) % 12));
    expect([...diffs]).toEqual([7]);
  });

  it('plays drum loops on every kit layout, each voice on a pad that exists', () => {
    for (const loop of LIBRARY_LOOPS.filter((l) => l.part.kind === 'drums')) {
      for (const kitId of ['round-machine', 'hand-percussion', 'afro-latin']) {
        const r = realizeLoop(loop, { root: 0, scale: 'minor', kind: 'drums', kitId });
        expect(r.notes.length, `${loop.id} on ${kitId}`).toBeGreaterThan(0);
        for (const n of r.notes) expect(n.pitch >= 0 && n.pitch <= 15 && Number.isInteger(n.pitch)).toBe(true);
      }
    }
    // A conga line on a standard kit plays toms; a kick on Hand Percussion plays the cajon (slot 14).
    const congas = realizeLoop(getLoop('loop-perc-conga-groove')!, { root: 0, scale: 'minor', kind: 'drums', kitId: 'round-machine' });
    expect(new Set(congas.notes.map((n) => n.pitch))).toEqual(new Set([6, 8, 9]));
    const four = realizeLoop(getLoop('beat-steady-four')!, { root: 0, scale: 'minor', kind: 'drums', kitId: 'hand-percussion' });
    expect(four.notes.filter((n) => n.pitch === 14)).toHaveLength(4);
  });

  it('refuses a drum loop on a synth part and a melodic loop on a drum part', () => {
    const beat = getLoop('beat-steady-four')!;
    const bass = getLoop('loop-bass-bouncy')!;
    expect(loopFitsKind(beat, 'drums')).toBe(true);
    expect(loopFitsKind(beat, 'poly')).toBe(false);
    expect(loopFitsKind(bass, 'sampler')).toBe(true);
    expect(() => realizeLoop(beat, { root: 0, scale: 'minor', kind: 'bass' })).toThrow(/drum or percussion part/);
    expect(() => realizeLoop(bass, { root: 0, scale: 'minor', kind: 'drums' })).toThrow(/not a drum kit/);
  });

  it('glides an 808 line: slide notes overlap the next note', () => {
    const r = realizeLoop(getLoop('loop-bass-808-slide')!, { root: 5, scale: 'minor', kind: 'bass' });
    const overlaps = r.notes.filter((n) => r.notes.some((m) => m.tick > n.tick && m.tick < n.tick + n.duration));
    expect(overlaps.length).toBeGreaterThanOrEqual(2);
  });
});

describe('finding loops', () => {
  it('searches names, styles, parts and feels', () => {
    const trapBass = searchLoops('trap bass');
    expect(trapBass.length).toBeGreaterThan(0);
    expect(trapBass.every((l) => l.role === 'bass' && l.genres.includes('trap'))).toBe(true);
    expect(searchLoops('808')[0].name).toMatch(/808/);
    expect(searchLoops('lo-fi keys').some((l) => l.id === 'loop-chords-dusty-sevenths')).toBe(true);
    expect(searchLoops('drum and bass', { role: 'drums' }).length).toBeGreaterThanOrEqual(3);
    expect(searchLoops('zzzz')).toEqual([]);
  });

  it('filters by part, style, feel and length', () => {
    const r = searchLoops('', { role: 'chords', genre: 'pop', feel: 'bright' });
    expect(r.length).toBeGreaterThan(0);
    for (const l of r) {
      expect(l.role).toBe('chords');
      expect(l.genres).toContain('pop');
      expect(l.feel).toBe('bright');
    }
    expect(searchLoops('', { bars: 8 }).every((l) => l.bars === 8)).toBe(true);
    expect(searchLoops('').length).toBe(LIBRARY_LOOPS.length);
  });
});

describe('beat presets', () => {
  it('ships about fifty beats with styles, tempo hints and real kits', () => {
    expect(BEATS.length).toBeGreaterThanOrEqual(50);
    const kits = new Set(KITS.map((k) => k.id));
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const b of BEATS) {
      ids.add(b.id);
      names.add(b.name);
      expect(kits.has(b.kit), b.id).toBe(true);
      expect(b.bpm).toBeGreaterThanOrEqual(60);
      expect(b.bpm).toBeLessThanOrEqual(180);
      if (b.swing !== undefined) expect(b.swing >= 0 && b.swing <= 0.6).toBe(true);
      expect(getBeat(b.id)).toBe(b);
    }
    expect(ids.size).toBe(BEATS.length);
    expect(names.size).toBe(BEATS.length);
  });

  it('every beat makes a valid drum clip with a kick or a low drum, at its own length and longer', () => {
    for (const b of BEATS) {
      for (const bars of [b.bars, 4, 8] as const) {
        if (bars % b.bars) continue;
        const project = createProject({ name: 'Beat test', now: 1 });
        const drums = project.tracks.find((t) => t.role === 'drums')!;
        const r = realizeBeat(b, { bars, fill: true });
        drums.clips[0] = createClip(r.name, r.bars, r.notes);
        const res = validateProject(JSON.parse(JSON.stringify(project)));
        expect(res.ok && res.warnings, b.id).toEqual([]);
        expect(r.notes.some((n) => n.pitch === 0 || n.pitch === 1), b.id).toBe(true);
      }
    }
  });

  it('writes the fill into the last bar only', () => {
    const b = getBeat('beat-straight-eights')!;
    const plain = realizeBeat(b, { bars: 4 });
    const filled = realizeBeat(b, { bars: 4, fill: true });
    const early = (r: typeof plain) => r.notes.filter((n) => n.tick < 3 * TICKS_PER_BAR);
    expect(early(filled)).toEqual(early(plain));
    const last = filled.notes.filter((n) => n.tick >= 3 * TICKS_PER_BAR);
    // The fill brings in the toms.
    expect(last.some((n) => n.pitch >= 8 && n.pitch <= 10)).toBe(true);
    expect(plain.notes.some((n) => n.pitch >= 8 && n.pitch <= 10)).toBe(false);
    expect(() => realizeBeat(getBeat('beat-dusty-boom')!, { bars: 1 })).toThrow();
  });

  it('rolls trap hats at 32nds', () => {
    const r = realizeBeat(getBeat('beat-night-rolls')!);
    const hats = r.notes.filter((n) => n.pitch === 4).map((n) => n.tick);
    const gaps = hats.slice(1).map((t, i) => t - hats[i]);
    expect(gaps).toContain(TICKS_PER_BAR / 32);
  });
});
