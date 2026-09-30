import { describe, expect, it } from 'vitest';
import { describeVariation, diffNotes, variationBudget, variationSeed, varyClip, type VariationOptions } from '../../src/music/variation';
import { isInScale, parseNote } from '../../src/music/scales';
import { pitchClassSet } from '../../src/music/chords';
import type { Clip, ClipBars, InstrumentKind, Note, ScaleId, TrackRole } from '../../src/project/types';
import { STARTERS } from '../../src/content/starters';

/* ------------------------------------------------------------------ */
/* Fixtures (original patterns written for these tests)                */
/* ------------------------------------------------------------------ */

type Row = [tick: number, pitch: number, velocity: number, duration: number];

function clip(name: string, bars: ClipBars, rows: Row[]): Clip {
  return { id: `clip-${name}`, name, bars, notes: rows.map(([tick, pitch, velocity, duration], i) => ({ id: `${name}-${i}`, tick, pitch, velocity, duration })) };
}

const N = (s: string) => parseNote(s);

function houseDrums(): Clip {
  const rows: Row[] = [];
  for (let bar = 0; bar < 2; bar++) {
    const b = bar * 384;
    for (let q = 0; q < 4; q++) rows.push([b + q * 96, 0, 0.95, 24]);
    rows.push([b + 96, 3, 0.86, 24], [b + 288, 3, 0.86, 24]);
    for (let q = 0; q < 4; q++) rows.push([b + q * 96 + 48, 4, 0.72, 12]);
    for (let s = 0; s < 16; s += 2) rows.push([b + s * 24 + 24, 6, s % 4 ? 0.3 : 0.42, 12]);
    rows.push([b + 168, 14, 0.5, 24], [b + 312, 7, 0.42, 24]);
  }
  return clip('house', 2, rows);
}

function breakDrums(): Clip {
  const rows: Row[] = [];
  for (let bar = 0; bar < 2; bar++) {
    const b = bar * 384;
    rows.push([b, 0, 0.95, 24], [b + 120, 0, 0.7, 24], [b + 192, 0, 0.9, 24], [b + 264, 1, 0.75, 24]);
    rows.push([b + 96, 2, 0.9, 24], [b + 288, 2, 0.92, 24], [b + 168, 2, 0.24, 12], [b + 336, 2, 0.2, 12]);
    for (let e = 0; e < 8; e++) rows.push([b + e * 48, 4, e % 2 ? 0.45 : 0.68, 12]);
  }
  rows.push([384 + 330, 13, 0.4, 48]);
  return clip('break', 2, rows);
}

function handPercussion(): Clip {
  return clip('perc', 1, [
    [0, 8, 0.8, 24],
    [72, 9, 0.55, 24],
    [96, 10, 0.7, 24],
    [168, 9, 0.5, 24],
    [192, 8, 0.78, 24],
    [240, 10, 0.6, 24],
    [264, 9, 0.52, 24],
    [48, 4, 0.5, 12],
    [144, 4, 0.5, 12],
    [240, 4, 0.5, 12],
    [336, 4, 0.5, 12],
    [0, 6, 0.4, 12],
    [96, 6, 0.3, 12],
    [192, 6, 0.4, 12],
    [288, 6, 0.3, 12],
    [216, 11, 0.45, 24],
  ]);
}

/** A minor, two bars. */
function bassLine(): Clip {
  return clip('bass', 2, [
    [0, N('A1'), 0.9, 90],
    [96, N('A2'), 0.7, 44],
    [168, N('A1'), 0.65, 22],
    [192, N('C2'), 0.85, 70],
    [288, N('E2'), 0.75, 44],
    [336, N('G2'), 0.6, 22],
    [384, N('D2'), 0.9, 90],
    [480, N('D3'), 0.7, 44],
    [552, N('D2'), 0.65, 22],
    [576, N('F2'), 0.85, 70],
    [672, N('E2'), 0.75, 44],
    [720, N('C2'), 0.7, 44],
  ]);
}

/** A minor melody, two bars. */
function leadLine(): Clip {
  return clip('lead', 2, [
    [0, N('E4'), 0.8, 72],
    [96, N('G4'), 0.7, 48],
    [144, N('A4'), 0.75, 48],
    [192, N('C5'), 0.85, 96],
    [312, N('B4'), 0.6, 24],
    [336, N('A4'), 0.7, 48],
    [384, N('G4'), 0.8, 144],
    [576, N('E4'), 0.7, 48],
    [624, N('D4'), 0.65, 48],
    [672, N('E4'), 0.8, 96],
  ]);
}

/** Off-beat chord stabs over a four-bar progression (Am7 Fmaj7 G6 Em7). */
function chordStabs(): Clip {
  const chords = [
    ['A3', 'C4', 'E4', 'G4'],
    ['F3', 'A3', 'C4', 'E4'],
    ['G3', 'B3', 'D4', 'E4'],
    ['E3', 'G3', 'B3', 'D4'],
  ].map((c) => c.map(N));
  const rows: Row[] = [];
  chords.forEach((c, bar) => {
    for (const off of [0, 72, 144, 240, 312]) for (const p of c) rows.push([bar * 384 + off, p, off === 0 ? 0.85 : 0.72, 36]);
  });
  return clip('stabs', 4, rows);
}

/** Long pad chords, two bars each. */
function padChords(): Clip {
  return clip('pad', 4, [
    ...['A3', 'C4', 'E4', 'B4'].map((n): Row => [0, N(n), 0.7, 760]),
    ...['F3', 'A3', 'C4', 'G4'].map((n): Row => [768, N(n), 0.7, 760]),
  ]);
}

interface Case {
  name: string;
  make: () => Clip;
  role: TrackRole;
  kind: InstrumentKind;
  scale: ScaleId;
}

const CASES: Case[] = [
  { name: 'house drums', make: houseDrums, role: 'drums', kind: 'drums', scale: 'minor' },
  { name: 'break drums', make: breakDrums, role: 'drums', kind: 'drums', scale: 'minor' },
  { name: 'hand percussion', make: handPercussion, role: 'percussion', kind: 'drums', scale: 'minor' },
  { name: 'bass line', make: bassLine, role: 'bass', kind: 'bass', scale: 'minor' },
  { name: 'lead line', make: leadLine, role: 'lead', kind: 'poly', scale: 'minor' },
  { name: 'sampler line', make: leadLine, role: 'sampler', kind: 'sampler', scale: 'minor' },
  { name: 'chord stabs', make: chordStabs, role: 'chords', kind: 'poly', scale: 'minor' },
  { name: 'pad chords', make: padChords, role: 'pad', kind: 'poly', scale: 'minor' },
];

const opts = (c: Case, seed: number, intensity?: number): VariationOptions => ({ seed, role: c.role, kind: c.kind, root: 9, scale: c.scale, intensity });

/** Musical content only (new notes get fresh random ids). */
const music = (notes: readonly Note[]) =>
  notes
    .map((n) => `${n.tick}:${n.pitch}:${n.velocity}:${n.duration}`)
    .sort()
    .join('|');

const SEEDS = Array.from({ length: 120 }, (_, i) => i * 7919 + 13);

/* ------------------------------------------------------------------ */
/* Generic guarantees                                                  */
/* ------------------------------------------------------------------ */

describe('varyClip — guarantees for every part type', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it('is deterministic for the same seed and keeps ids of untouched notes', () => {
        for (const seed of [1, 99, 123456789]) {
          const a = varyClip(c.make(), opts(c, seed));
          const b = varyClip(c.make(), opts(c, seed));
          expect(music(a)).toBe(music(b));
          const originalIds = new Set(c.make().notes.map((n) => n.id));
          expect(a.filter((n) => originalIds.has(n.id)).map((n) => n.id)).toEqual(b.filter((n) => originalIds.has(n.id)).map((n) => n.id));
        }
      });

      it('gives different results for different seeds', () => {
        const results = new Set(Array.from({ length: 12 }, (_, i) => music(varyClip(c.make(), opts(c, i + 1)))));
        // Tiny clips (a two-chord pad may change only two notes) have fewer possible outcomes.
        expect(results.size).toBeGreaterThanOrEqual(c.make().notes.length >= 12 ? 9 : 5);
      });

      it('changes something, but at most ~35% of the notes at default intensity', () => {
        const src = c.make();
        const n = src.notes.length;
        const cap = variationBudget(n);
        expect(cap).toBeLessThanOrEqual(Math.max(1, Math.floor(0.35 * n)));
        for (const seed of SEEDS) {
          const d = diffNotes(src.notes, varyClip(src, opts(c, seed)));
          expect(d.total).toBeGreaterThanOrEqual(1);
          expect(d.total).toBeLessThanOrEqual(cap);
        }
      });

      it('scales the amount of change with intensity', () => {
        const src = c.make();
        const n = src.notes.length;
        for (const seed of SEEDS.slice(0, 40)) {
          expect(diffNotes(src.notes, varyClip(src, opts(c, seed, 1))).total).toBeLessThanOrEqual(Math.max(1, Math.floor(0.7 * n)));
          expect(diffNotes(src.notes, varyClip(src, opts(c, seed, 0))).total).toBeLessThanOrEqual(1);
        }
        const avg = (i: number) => SEEDS.slice(0, 40).reduce((s, seed) => s + diffNotes(src.notes, varyClip(src, opts(c, seed, i))).total, 0) / 40;
        expect(avg(1)).toBeGreaterThan(avg(0.25));
      });

      it('never empties the clip and keeps every note valid and inside it', () => {
        const src = c.make();
        const len = src.bars * 384;
        const byId = new Map(src.notes.map((n) => [n.id, n]));
        for (const seed of SEEDS) {
          const out = varyClip(src, opts(c, seed));
          expect(out.length).toBeGreaterThan(0);
          expect(new Set(out.map((n) => n.id)).size).toBe(out.length);
          for (const n of out) {
            expect(n.tick).toBeGreaterThanOrEqual(0);
            expect(n.tick).toBeLessThan(len);
            expect(Number.isInteger(n.pitch)).toBe(true);
            if (c.kind === 'drums') expect(n.pitch >= 0 && n.pitch <= 15).toBe(true);
            else expect(n.pitch >= 0 && n.pitch <= 127).toBe(true);
            const o = byId.get(n.id);
            const edited = !o || o.tick !== n.tick || o.pitch !== n.pitch || o.velocity !== n.velocity || o.duration !== n.duration;
            if (edited) {
              expect(n.tick + n.duration).toBeLessThanOrEqual(len);
              expect(n.duration).toBeGreaterThan(0);
              expect(n.velocity).toBeGreaterThanOrEqual(0.05);
              expect(n.velocity).toBeLessThanOrEqual(1);
            } else {
              expect(n).toEqual(o);
            }
          }
        }
      });

      it('does not modify the input clip', () => {
        const src = c.make();
        const snapshot = structuredClone(src);
        varyClip(src, opts(c, 42));
        expect(src).toEqual(snapshot);
      });
    });
  }

  it('stays a variation (and stays fast) on a very dense recorded clip', () => {
    const notes: Note[] = [];
    // ~2000 unquantised hits across hats, shaker, snare, kick and toms.
    for (let t = 0; t < 1536; t += 3.75) {
      for (const p of [0, 2, 4, 6, 8, 13]) if ((Math.floor(t) + p) % 3 !== 0) notes.push({ id: `d${notes.length}`, tick: t + 0.25, pitch: p, velocity: 0.3 + ((t + p) % 50) / 100, duration: 10 });
    }
    const dense: Clip = { id: 'dense', name: 'Dense', bars: 4, notes };
    expect(notes.length).toBeGreaterThan(1500);
    const started = performance.now();
    const out = varyClip(dense, { seed: 3, role: 'drums', kind: 'drums', root: 0, scale: 'minor', intensity: 1 });
    // Measured around 50 ms; a quadratic rule would take several hundred.
    expect(performance.now() - started).toBeLessThan(300);
    const d = diffNotes(notes, out);
    expect(d.total).toBeGreaterThan(0);
    expect(d.total).toBeLessThanOrEqual(64);
  });

  it('returns nothing for an empty clip', () => {
    expect(varyClip({ id: 'e', name: 'Empty', bars: 1, notes: [] }, { seed: 1, role: 'bass', kind: 'bass', root: 0, scale: 'major' })).toEqual([]);
  });

  it('derives reproducible, distinct seeds per clip and generation', () => {
    expect(variationSeed(1234, 'clip_a', 1)).toBe(variationSeed(1234, 'clip_a', 1));
    expect(variationSeed(1234, 'clip_a', 1)).not.toBe(variationSeed(1234, 'clip_a', 2));
    expect(variationSeed(1234, 'clip_a', 1)).not.toBe(variationSeed(1234, 'clip_b', 1));
  });
});

/* ------------------------------------------------------------------ */
/* Drums                                                               */
/* ------------------------------------------------------------------ */

function anchors(src: Clip): Note[] {
  return src.notes.filter((n) => {
    const pos = n.tick % 384;
    return ((n.pitch === 0 || n.pitch === 1) && (pos === 0 || pos === 192)) || ((n.pitch === 2 || n.pitch === 3) && (pos === 96 || pos === 288));
  });
}

describe('varyClip — drums', () => {
  it('keeps kick on 1 and 3 and snare/clap on 2 and 4 exactly as they were', () => {
    for (const make of [houseDrums, breakDrums]) {
      const src = make();
      const keep = anchors(src);
      expect(keep.length).toBeGreaterThanOrEqual(8);
      for (const seed of SEEDS) {
        const out = varyClip(src, { seed, role: 'drums', kind: 'drums', root: 0, scale: 'minor' });
        for (const a of keep) expect(out).toContainEqual(a);
      }
    }
  });

  it('keeps a four-on-the-floor pulse and edits at most one kick', () => {
    const src = houseDrums();
    const quarterKicks = src.notes.filter((n) => n.pitch === 0 && n.tick % 96 === 0);
    let kickEdits = 0;
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'drums', kind: 'drums', root: 0, scale: 'minor' });
      for (const k of quarterKicks) expect(out).toContainEqual(k);
      const kicksBefore = src.notes.filter((n) => n.pitch <= 1);
      const kicksAfter = out.filter((n) => n.pitch <= 1);
      const d = diffNotes(kicksBefore, kicksAfter);
      expect(d.total).toBeLessThanOrEqual(1);
      kickEdits += d.total;
    }
    // The pickup kick exists as an option, but is not added every time.
    expect(kickEdits).toBeGreaterThan(0);
    expect(kickEdits).toBeLessThan(SEEDS.length);
  });

  it('moves at most one syncopated kick in a breakbeat', () => {
    const src = breakDrums();
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'drums', kind: 'drums', root: 0, scale: 'minor' });
      expect(diffNotes(src.notes.filter((n) => n.pitch <= 1), out.filter((n) => n.pitch <= 1)).total).toBeLessThanOrEqual(1);
    }
  });

  it('lets a new open hat ring until a closed hat chokes it an eighth later at most', () => {
    const src = houseDrums();
    let opened = 0;
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'drums', kind: 'drums', root: 0, scale: 'minor' });
      for (const o of out.filter((n) => n.pitch === 5)) {
        opened++;
        const len = src.bars * 384;
        const dist = (n: Note) => (((n.tick - o.tick) % len) + len) % len;
        const chokers = out.filter((n) => n !== o && (n.pitch === 4 || n.pitch === 6));
        expect(chokers.some((n) => dist(n) > 0 && dist(n) <= 48)).toBe(true);
        expect(chokers.some((n) => dist(n) === 0)).toBe(false);
        // Open hats land on off-beat eighths.
        expect(o.tick % 96).toBe(48);
      }
    }
    expect(opened).toBeGreaterThan(0);
  });

  it('sometimes plays a short tom/snare fill in the last beat, and only there', () => {
    const src = houseDrums();
    let fills = 0;
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'drums', kind: 'drums', root: 0, scale: 'minor' });
      const toms = out.filter((n) => n.pitch >= 8 && n.pitch <= 10);
      const newSnares = out.filter((n) => n.pitch === 2);
      if (toms.length > 0) {
        fills++;
        for (const t of toms) expect(t.tick).toBeGreaterThanOrEqual(384 + 288);
      }
      for (const s of newSnares) expect(s.tick >= 384 + 288 || [72, 120, 168, 264, 312, 360].includes(s.tick % 384)).toBe(true);
    }
    expect(fills).toBeGreaterThan(SEEDS.length * 0.1);
    expect(fills).toBeLessThan(SEEDS.length * 0.8);
  });

  it('adds and removes ghost notes rather than only changing velocities', () => {
    const src = breakDrums();
    let added = 0;
    let removed = 0;
    for (const seed of SEEDS) {
      const d = diffNotes(src.notes, varyClip(src, { seed, role: 'drums', kind: 'drums', root: 0, scale: 'minor' }));
      added += d.added;
      removed += d.removed;
    }
    expect(added).toBeGreaterThan(SEEDS.length / 2);
    expect(removed).toBeGreaterThan(SEEDS.length / 4);
  });

  it('never adds kicks or snare-lane hits to a percussion part, and fills with its own drums', () => {
    const src = handPercussion();
    let fills = 0;
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'percussion', kind: 'drums', root: 0, scale: 'minor' });
      expect(out.some((n) => n.pitch <= 3)).toBe(false);
      if (out.some((n) => n.pitch >= 8 && n.pitch <= 10 && n.tick >= 288)) fills++;
    }
    expect(fills).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Melodic lines                                                       */
/* ------------------------------------------------------------------ */

function barFirsts(notes: readonly Note[]): Map<number, Note> {
  const out = new Map<number, Note>();
  for (const n of [...notes].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)) {
    const bar = Math.floor(n.tick / 384);
    if (!out.has(bar)) out.set(bar, n);
  }
  return out;
}

/**
 * A bar's first note keeps its start, pitch and level. A bass root keeps its
 * length too, apart from at most its last 16th given to an approach tone;
 * in other parts it may be phrased (legato / staccato).
 */
function expectKeptBarFirst(actual: Note | undefined, original: Note, bass = true): void {
  expect(actual).toBeDefined();
  expect({ ...actual!, duration: 0 }).toEqual({ ...original, duration: 0 });
  if (bass) {
    expect(actual!.duration).toBeLessThanOrEqual(original.duration);
    expect(actual!.duration).toBeGreaterThanOrEqual(original.duration - 24);
  } else {
    expect(actual!.duration).toBeGreaterThanOrEqual(24);
    expect(actual!.duration).toBeLessThanOrEqual(Math.max(2 * original.duration, 96));
  }
}

describe('varyClip — melodic lines', () => {
  const melodic: [string, () => Clip, TrackRole, InstrumentKind][] = [
    ['bass', bassLine, 'bass', 'bass'],
    ['lead', leadLine, 'lead', 'poly'],
    ['texture', leadLine, 'texture', 'poly'],
  ];

  for (const [name, make, role, kind] of melodic) {
    it(`${name}: every note stays in A minor and each bar keeps its first note`, () => {
      const src = make();
      const firsts = barFirsts(src.notes);
      for (const seed of SEEDS) {
        const out = varyClip(src, { seed, role, kind, root: 9, scale: 'minor' });
        for (const n of out) expect(isInScale(n.pitch, 9, 'minor'), `${seed} ${n.pitch}`).toBe(true);
        const outFirsts = barFirsts(out);
        for (const [bar, n] of firsts) expectKeptBarFirst(outFirsts.get(bar), n, role === 'bass');
      }
    });
  }

  it('stays in a pentatonic key when the project uses one', () => {
    const src = clip('penta', 2, [
      [0, N('A3'), 0.8, 48],
      [96, N('C4'), 0.8, 48],
      [192, N('E4'), 0.8, 96],
      [384, N('G4'), 0.8, 48],
      [480, N('D4'), 0.8, 48],
      [576, N('A3'), 0.8, 96],
    ]);
    for (const seed of SEEDS) {
      for (const n of varyClip(src, { seed, role: 'lead', kind: 'poly', root: 9, scale: 'minorPentatonic' })) {
        expect(isInScale(n.pitch, 9, 'minorPentatonic')).toBe(true);
      }
    }
  });

  it('still varies sparse parts of held bar-first notes, with an approach into the next bar', () => {
    // One held root per bar (an original four-bar line in D minor): every note is a bar's first note.
    const src = clip('roots', 4, [
      [0, N('D2'), 0.7, 370],
      [384, N('A#1'), 0.7, 370],
      [768, N('F1'), 0.7, 370],
      [1152, N('C2'), 0.7, 370],
    ]);
    const firsts = barFirsts(src.notes);
    let approaches = 0;
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'bass', kind: 'bass', root: 2, scale: 'minor' });
      expect(diffNotes(src.notes, out).total).toBeGreaterThan(0);
      for (const [bar, n] of firsts) expectKeptBarFirst(barFirsts(out).get(bar), n);
      const s = [...out].sort((a, b) => a.tick - b.tick);
      for (let i = 1; i < s.length; i++) expect(s[i - 1].tick + s[i - 1].duration).toBeLessThanOrEqual(s[i].tick);
      for (const n of out.filter((m) => !src.notes.some((o) => o.id === m.id))) {
        approaches++;
        expect(isInScale(n.pitch, 2, 'minor')).toBe(true);
        // One 16th before the next root (or the loop point), a scale step away from it.
        const next = s.find((m) => m.tick > n.tick) ?? s[0];
        expect((next.tick - n.tick + 1536) % 1536).toBe(24);
        expect(Math.abs(next.pitch - n.pitch)).toBeLessThanOrEqual(2);
      }
    }
    expect(approaches).toBeGreaterThanOrEqual(SEEDS.length);
  });

  it('never lifts a bass note more than an octave above where it was', () => {
    const src = bassLine();
    const byId = new Map(src.notes.map((n) => [n.id, n]));
    const top = Math.max(...src.notes.map((n) => n.pitch));
    const bottom = Math.min(...src.notes.map((n) => n.pitch));
    for (const seed of SEEDS) {
      for (const n of varyClip(src, { seed, role: 'bass', kind: 'bass', root: 9, scale: 'minor', intensity: 1 })) {
        const o = byId.get(n.id);
        if (o) expect(n.pitch).toBeLessThanOrEqual(o.pitch + 12);
        expect(n.pitch).toBeLessThanOrEqual(top + 12);
        expect(n.pitch).toBeGreaterThanOrEqual(bottom - 2);
      }
    }
  });

  it('uses the whole toolbox: displacement, octaves, approach tones and note lengths', () => {
    const src = bassLine();
    const byId = new Map(src.notes.map((n) => [n.id, n]));
    const seen = { shift: 0, octave: 0, approach: 0, length: 0 };
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'bass', kind: 'bass', root: 9, scale: 'minor' });
      for (const n of out) {
        const o = byId.get(n.id);
        if (!o) {
          seen.approach++;
          // Approach tones are short and lead into the following note by step (within 2 semitones).
          expect(n.duration).toBeLessThanOrEqual(24);
          const next = out.filter((m) => m.tick > n.tick).sort((a, b) => a.tick - b.tick)[0] ?? out.sort((a, b) => a.tick - b.tick)[0];
          expect(Math.abs(next.pitch - n.pitch)).toBeLessThanOrEqual(2);
          continue;
        }
        if (Math.abs(n.tick - o.tick) === 24) seen.shift++;
        if (Math.abs(n.pitch - o.pitch) === 12) seen.octave++;
        if (n.duration !== o.duration && n.tick === o.tick) seen.length++;
      }
    }
    expect(seen.shift).toBeGreaterThan(10);
    expect(seen.octave).toBeGreaterThan(10);
    expect(seen.approach).toBeGreaterThan(10);
    expect(seen.length).toBeGreaterThan(10);
  });

  it('keeps monophonic lines monophonic (no new overlaps that would glide)', () => {
    const src = bassLine();
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'bass', kind: 'bass', root: 9, scale: 'minor' });
      for (let i = 1; i < out.length; i++) expect(out[i - 1].tick + out[i - 1].duration).toBeLessThanOrEqual(out[i].tick);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Chord parts                                                         */
/* ------------------------------------------------------------------ */

function chordGroups(notes: readonly Note[]): { tick: number; pcs: string; pitches: number[] }[] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const out: { tick: number; pitches: number[] }[] = [];
  for (const n of sorted) {
    const g = out[out.length - 1];
    if (g && n.tick - g.tick <= 6) g.pitches.push(n.pitch);
    else out.push({ tick: n.tick, pitches: [n.pitch] });
  }
  return out.map((g) => ({ ...g, pcs: pitchClassSet(g.pitches).join(',') }));
}

describe('varyClip — chord parts keep their harmony', () => {
  for (const [name, make, role] of [
    ['stabs', chordStabs, 'chords'],
    ['pad', padChords, 'pad'],
  ] as const) {
    it(`${name}: no new chords appear and each bar opens with its chord on time`, () => {
      const src = make();
      const harmonies = new Set(chordGroups(src.notes).map((g) => g.pcs));
      const firstByBar = new Map<number, { tick: number; pcs: string }>();
      for (const g of chordGroups(src.notes)) if (!firstByBar.has(Math.floor(g.tick / 384))) firstByBar.set(Math.floor(g.tick / 384), g);
      let revoiced = 0;
      for (const seed of SEEDS) {
        const out = varyClip(src, { seed, role, kind: 'poly', root: 9, scale: 'minor' });
        const groups = chordGroups(out);
        for (const g of groups) expect(harmonies.has(g.pcs), `seed ${seed}: ${g.pcs} at ${g.tick}`).toBe(true);
        for (const [bar, first] of firstByBar) {
          const g = groups.find((x) => Math.floor(x.tick / 384) === bar);
          expect(g?.tick).toBe(first.tick);
          expect(g?.pcs).toBe(first.pcs);
        }
        const before = chordGroups(src.notes).map((g) => [...g.pitches].sort().join());
        if (groups.some((g) => !before.includes([...g.pitches].sort().join()))) revoiced++;
      }
      // Voicing changes are the main tool for chord parts.
      expect(revoiced).toBeGreaterThan(SEEDS.length / 2);
    });
  }

  it('keeps pad chords as long, sustained chords', () => {
    const src = padChords();
    for (const seed of SEEDS) {
      const out = varyClip(src, { seed, role: 'pad', kind: 'poly', root: 9, scale: 'minor' });
      expect(chordGroups(out)).toHaveLength(2);
      for (const n of out) expect(n.duration).toBeGreaterThanOrEqual(384);
    }
  });

  it('varies stab rhythm with shifts, echoes and drops', () => {
    const src = chordStabs();
    const baseTicks = new Set(chordGroups(src.notes).map((g) => g.tick));
    let moved = 0;
    let fewer = 0;
    let more = 0;
    for (const seed of SEEDS) {
      const groups = chordGroups(varyClip(src, { seed, role: 'chords', kind: 'poly', root: 9, scale: 'minor' }));
      if (groups.some((g) => !baseTicks.has(g.tick))) moved++;
      if (groups.length < baseTicks.size) fewer++;
      if (groups.length > baseTicks.size) more++;
    }
    expect(moved).toBeGreaterThan(10);
    expect(fewer).toBeGreaterThan(5);
    expect(more).toBeGreaterThan(5);
  });
});

/* ------------------------------------------------------------------ */
/* Sampler parts                                                       */
/* ------------------------------------------------------------------ */

/** Chopped-sample line in B minor (an original figure). */
function samplerChops(): Clip {
  return clip('chops', 2, [
    [0, N('B3'), 0.85, 36],
    [72, N('B3'), 0.6, 24],
    [144, N('F#4'), 0.8, 36],
    [240, N('E4'), 0.75, 36],
    [336, N('D4'), 0.55, 24],
    [384, N('B3'), 0.85, 36],
    [480, N('A3'), 0.7, 36],
    [576, N('F#4'), 0.8, 48],
    [672, N('E4'), 0.6, 24],
  ]);
}

describe('varyClip — sampler parts keep their pitches', () => {
  it('never plays a recording at a new pitch, whatever the part’s role', () => {
    const src = samplerChops();
    const pitches = new Set(src.notes.map((n) => n.pitch));
    const byId = new Map(src.notes.map((n) => [n.id, n]));
    let added = 0;
    let moved = 0;
    for (const role of ['sampler', 'chords', 'lead'] as const) {
      for (const seed of SEEDS) {
        const out = varyClip(src, { seed, role, kind: 'sampler', root: 11, scale: 'minor' });
        for (const n of out) {
          // A sampler's pitch is its playback speed and the recording's own harmony (e.g. a chord hit).
          expect(pitches.has(n.pitch), `${role} ${seed}: ${n.pitch}`).toBe(true);
          const o = byId.get(n.id);
          if (o) {
            expect(n.pitch).toBe(o.pitch);
            if (n.tick !== o.tick) moved++;
          } else added++;
        }
      }
    }
    // It still varies: repeats (stutters) and rhythmic shifts.
    expect(added).toBeGreaterThan(SEEDS.length / 2);
    expect(moved).toBeGreaterThan(SEEDS.length / 2);
  });

  it('keeps each bar’s first sample hit exactly, so a timed riser or swell still peaks on the downbeat', () => {
    const chops = samplerChops();
    // A riser that starts at step 13 and is timed by its length to end on the next downbeat.
    const riser = clip('riser', 2, [[384 + 13 * 24, N('C4'), 0.8, 3 * 24], [3 * 24, N('C4'), 0.6, 4 * 24]]);
    for (const src of [chops, riser]) {
      for (const seed of SEEDS) {
        const out = varyClip(src, { seed, role: 'sampler', kind: 'sampler', root: 11, scale: 'minor' });
        for (const [bar, n] of barFirsts(src.notes)) expect(barFirsts(out).get(bar)).toEqual(n);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Pressed again and again                                             */
/* ------------------------------------------------------------------ */

/** Variation pressed `presses` times in a row, each press varying the previous result (as the Variation button does). */
function pressRepeatedly(src: Clip, role: TrackRole, kind: InstrumentKind, chain: number, scale: ScaleId = 'minor', presses = 25): Note[] {
  let current = src;
  for (let g = 1; g <= presses; g++) {
    current = { ...current, notes: varyClip(current, { seed: variationSeed(chain, current.id, g), role, kind, root: 9, scale }) };
  }
  return current.notes;
}

const CHAINS = [11, 222, 3333, 44444, 555555, 6666666];
const range = (notes: readonly Note[]) => [Math.min(...notes.map((n) => n.pitch)), Math.max(...notes.map((n) => n.pitch))];

describe('varyClip — stays musical when pressed again and again', () => {
  for (const [name, make, role, kind, down, up] of [
    ['bass line', bassLine, 'bass', 'bass', 2, 7],
    ['lead line', leadLine, 'lead', 'poly', 12, 12],
  ] as const) {
    it(`${name}: stays in its register, in key, on its bar-first notes and about as busy as it was`, () => {
      const src = make();
      const [lo, hi] = range(src.notes);
      const firsts = barFirsts(src.notes);
      for (const chain of CHAINS) {
        const out = pressRepeatedly(src, role, kind, chain);
        for (const n of out) {
          expect(isInScale(n.pitch, 9, 'minor')).toBe(true);
          expect(n.pitch, `chain ${chain}`).toBeGreaterThanOrEqual(lo - down);
          expect(n.pitch, `chain ${chain}`).toBeLessThanOrEqual(hi + up);
        }
        for (const [bar, n] of firsts) {
          const kept = barFirsts(out).get(bar)!;
          if (kind === 'bass') expectKeptBarFirst(kept, n);
          else expect({ ...kept, duration: 0 }).toEqual({ ...n, duration: 0 });
        }
        // Ornaments come and go, but a bar never fills up beyond eighth-note density (or what was written).
        for (let bar = 0; bar < src.bars; bar++) {
          const count = (notes: readonly Note[]) => notes.filter((n) => Math.floor(n.tick / 384) === bar).length;
          expect(count(out), `chain ${chain} bar ${bar}`).toBeLessThanOrEqual(Math.max(8, count(src.notes)));
        }
        expect(out.length, `chain ${chain}`).toBeGreaterThanOrEqual(Math.floor(src.notes.length * 0.6));
        if (kind === 'bass') {
          const s = [...out].sort((a, b) => a.tick - b.tick);
          for (let i = 1; i < s.length; i++) expect(s[i - 1].tick + s[i - 1].duration).toBeLessThanOrEqual(s[i].tick);
        }
        // Dynamics neither flatten out nor collapse to extremes.
        const vs = out.map((n) => n.velocity);
        expect(vs.filter((v) => v <= 0.15).length).toBe(0);
        expect(vs.filter((v) => v >= 0.99).length).toBeLessThanOrEqual(2);
      }
    });
  }

  for (const [name, make, role] of [
    ['stabs', chordStabs, 'chords'],
    ['pad', padChords, 'pad'],
  ] as const) {
    it(`${name}: keeps its harmony, each bar's opening chord and bass note, and its register`, () => {
      const src = make();
      const [lo, hi] = range(src.notes);
      const harmonies = new Set(chordGroups(src.notes).map((g) => g.pcs));
      const openers = new Map<number, { tick: number; bass: number }>();
      for (const g of chordGroups(src.notes)) {
        const bar = Math.floor(g.tick / 384);
        if (!openers.has(bar)) openers.set(bar, { tick: g.tick, bass: Math.min(...g.pitches) });
      }
      const perBar = (groups: { tick: number }[], bar: number) => groups.filter((g) => Math.floor(g.tick / 384) === bar).length;
      for (const chain of CHAINS) {
        const groups = chordGroups(pressRepeatedly(src, role, 'poly', chain));
        for (const g of groups) {
          expect(harmonies.has(g.pcs), `chain ${chain}: ${g.pcs}`).toBe(true);
          for (const p of g.pitches) {
            expect(p).toBeGreaterThanOrEqual(lo - 7);
            expect(p).toBeLessThanOrEqual(hi + 12);
          }
        }
        for (const [bar, opener] of openers) {
          const g = groups.find((x) => Math.floor(x.tick / 384) === bar)!;
          expect(g.tick).toBe(opener.tick);
          expect(Math.min(...g.pitches)).toBe(opener.bass);
          const count = perBar(groups, bar);
          const before = perBar(chordGroups(src.notes), bar);
          expect(count).toBeGreaterThanOrEqual(Math.min(2, before));
          expect(count).toBeLessThanOrEqual(Math.max(6, before));
        }
      }
    });
  }

  it('drums: anchors stay, fills stay in the last beat, ghosts stay capped and hats keep their dynamics', () => {
    for (const make of [houseDrums, breakDrums]) {
      const src = make();
      const keep = anchors(src);
      const len = src.bars * 384;
      const hatVel = (notes: readonly Note[]) => notes.filter((n) => n.pitch === 4 || n.pitch === 6).map((n) => n.velocity);
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      for (const chain of CHAINS) {
        const out = pressRepeatedly(src, 'drums', 'drums', chain);
        for (const a of keep) expect(out).toContainEqual(a);
        expect(out.length, `${src.name} chain ${chain}`).toBeLessThanOrEqual(Math.ceil(src.notes.length * 1.75));
        for (const t of out.filter((n) => n.pitch >= 8 && n.pitch <= 10)) expect(t.tick).toBeGreaterThanOrEqual(len - 96);
        for (let bar = 0; bar < src.bars; bar++) {
          // Snare/rim hits besides the backbeats (outside the fill beat): a handful of ghosts, not a roll.
          const extra = out.filter((n) => (n.pitch === 2 || n.pitch === 7) && Math.floor(n.tick / 384) === bar && n.tick < len - 96 && ![96, 288].includes(n.tick % 384));
          expect(extra.length, `${src.name} chain ${chain} bar ${bar}`).toBeLessThanOrEqual(6);
        }
        const hats = hatVel(out);
        expect(hats.filter((v) => v <= 0.1).length).toBeLessThanOrEqual(Math.floor(hats.length * 0.1));
        expect(med(hats) / med(hatVel(src.notes))).toBeGreaterThan(0.6);
        expect(med(hats) / med(hatVel(src.notes))).toBeLessThan(1.4);
      }
    }
  });

  it('percussion and sampler parts stay within bounds too', () => {
    const perc = handPercussion();
    const chops = samplerChops();
    const chopPitches = new Set(chops.notes.map((n) => n.pitch));
    for (const chain of CHAINS) {
      const p = pressRepeatedly(perc, 'percussion', 'drums', chain);
      expect(p.some((n) => n.pitch <= 3)).toBe(false);
      expect(p.length).toBeLessThanOrEqual(Math.ceil(perc.notes.length * 1.75));
      const s = pressRepeatedly(chops, 'sampler', 'sampler', chain);
      for (const n of s) expect(chopPitches.has(n.pitch)).toBe(true);
      expect(s.length).toBeLessThanOrEqual(Math.ceil(chops.notes.length * 1.5));
    }
  });
});

/* ------------------------------------------------------------------ */
/* The shipped starters                                                */
/* ------------------------------------------------------------------ */

describe('varyClip — on every clip of every starter project', () => {
  it('stays in key, keeps harmonies, sampler pitches and drum anchors, and stays bounded when repeated', () => {
    let clips = 0;
    const unchanged: string[] = [];
    for (const starter of STARTERS) {
      const project = starter.build();
      for (const track of project.tracks) {
        track.clips.forEach((src, slot) => {
          if (!src || src.notes.length === 0) return;
          // Clip ids are random per build; seed repeated presses from a stable key so the run is reproducible.
          const stableKey = `${starter.id}:${track.id}:${slot}`;
          clips++;
          const kind = track.instrument.kind;
          const len = src.bars * 384;
          const where = `${starter.id} ${track.name} ${src.name}`;
          const opts = (seed: number): VariationOptions => ({ seed, role: track.role, kind, root: project.root, scale: project.scale });
          const byId = new Map(src.notes.map((n) => [n.id, n]));
          const harmonies = new Set(chordGroups(src.notes).map((g) => g.pcs));
          const pitches = new Set(src.notes.map((n) => n.pitch));
          const chordPart = kind !== 'drums' && kind !== 'sampler' && (track.role === 'chords' || track.role === 'pad');
          let changed = false;
          for (const seed of [3, 17, 101, 2024, 77777, 123457]) {
            const out = varyClip(src, opts(seed));
            if (diffNotes(src.notes, out).total > 0) changed = true;
            for (const n of out) {
              expect(n.tick >= 0 && n.tick < len, where).toBe(true);
              const o = byId.get(n.id);
              if (kind === 'sampler') expect(pitches.has(n.pitch), where).toBe(true);
              else if (kind !== 'drums' && !chordPart && project.scale !== 'chromatic' && (!o || o.pitch !== n.pitch)) {
                expect(isInScale(n.pitch, project.root, project.scale), `${where}: ${n.pitch}`).toBe(true);
              }
            }
            if (chordPart) for (const g of chordGroups(out)) expect(harmonies.has(g.pcs), `${where}: ${g.pcs}`).toBe(true);
            if (kind === 'drums' && track.role === 'drums') for (const a of anchors(src)) expect(out, where).toContainEqual(a);
          }
          if (!changed) unchanged.push(`${where} (${src.notes.length} notes)`);
          // Pressed ten times in a row: still in its register and not piling up notes.
          let current = src;
          for (let g = 1; g <= 10; g++) current = { ...current, notes: varyClip(current, opts(variationSeed(project.seed, stableKey, g))) };
          expect(current.notes.length, where).toBeLessThanOrEqual(src.notes.length * 1.75 + 8);
          if (kind !== 'drums') {
            const [lo, hi] = range(src.notes);
            const [lo2, hi2] = range(current.notes);
            expect(lo2, where).toBeGreaterThanOrEqual(lo - 12);
            expect(hi2, where).toBeLessThanOrEqual(hi + 14);
          }
        });
      }
    }
    expect(clips).toBeGreaterThan(100);
    // Only single timed hits, drones and two-note held parts are left alone.
    expect(unchanged.length, unchanged.join('\n')).toBeLessThanOrEqual(Math.ceil(clips * 0.12));
  });
});

/* ------------------------------------------------------------------ */
/* Feedback text                                                       */
/* ------------------------------------------------------------------ */

describe('describeVariation', () => {
  const a: Note = { id: 'a', tick: 0, pitch: 60, velocity: 0.8, duration: 24 };
  const b: Note = { id: 'b', tick: 24, pitch: 62, velocity: 0.8, duration: 24 };
  const c: Note = { id: 'c', tick: 48, pitch: 64, velocity: 0.8, duration: 24 };

  it('counts changed, added and removed notes', () => {
    expect(describeVariation([a, b], [a, b])).toBe('No change');
    expect(describeVariation([a, b], [{ ...a, pitch: 72 }, b])).toBe('1 note changed');
    expect(describeVariation([a, b, c], [{ ...a, pitch: 72 }, { ...b, tick: 48 }, { ...c, velocity: 0.5 }])).toBe('3 notes changed');
    expect(describeVariation([a], [a, b])).toBe('1 note added');
    expect(describeVariation([a, b, c], [{ ...a, duration: 12 }, { id: 'd', tick: 72, pitch: 65, velocity: 0.5, duration: 12 }, { id: 'e', tick: 96, pitch: 67, velocity: 0.5, duration: 12 }])).toBe(
      '1 note changed, 2 added, 2 removed',
    );
    expect(describeVariation([], [])).toMatch(/empty/);
  });

  it('describes a real variation consistently with the diff', () => {
    const src = chordStabs();
    const out = varyClip(src, { seed: 5, role: 'chords', kind: 'poly', root: 9, scale: 'minor' });
    const d = diffNotes(src.notes, out);
    expect(describeVariation(src.notes, out)).toMatch(new RegExp(`^${d.changed || d.added || d.removed} note`));
  });
});
