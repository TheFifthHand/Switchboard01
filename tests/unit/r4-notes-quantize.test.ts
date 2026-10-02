/**
 * Quantize and humanize a clip after the fact (capability-02).
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/factory';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { createClip } from '../../src/state/commands/clips';
import { humanizeClip, quantizeClip } from '../../src/state/commands/notes';

const LEAD = 't5';
/** The off-grid offsets the audit measured after Record Notes with quantize off. */
const OFFSETS = [16.6, 15.4, 14.8, 7.5, 2.9, 4, 1.3, 10.5];
const PITCHES = [62, 65, 67, 69, 70, 72, 74, 77];

function setup(seed = 1234) {
  const p = createProject({ now: 0 });
  p.seed = seed;
  const store = new ProjectStore(p);
  createClip(store, LEAD, 0, 2, 'Take');
  store.apply('notes:Write', (d) => {
    // Eight notes, each a little late after a 1/8 line.
    d.tracks[4].clips[0]!.notes = OFFSETS.map((off, i) => ({ id: `n${i}`, tick: i * 48 + off, pitch: PITCHES[i], velocity: 0.7, duration: 30 }));
  });
  return store;
}
const notes = (store: ProjectStore) => store.getState().tracks[4].clips[0]!.notes;
const valid = (store: ProjectStore) => {
  const r = validateProject(JSON.parse(JSON.stringify(store.getState())));
  return r.ok && r.warnings.length === 0;
};

describe('quantize a clip', () => {
  it('puts 8 off-grid notes on the 1/16 grid at strength 1, in one undo step', () => {
    const store = setup();
    const before = notes(store);
    const r = quantizeClip(store, LEAD, 0, { grid: '1/16', strength: 1 });
    expect(r).toMatchObject({ changed: true, moved: 8 });
    for (const n of notes(store)) expect(n.tick % 24).toBe(0);
    // Each note goes to its nearest 16th: offsets above 12 go forward, the rest back.
    expect(notes(store).map((n) => n.tick)).toEqual([24, 72, 120, 144, 192, 240, 288, 336]);
    // Lengths are kept unless ends are asked for.
    expect(notes(store).every((n) => n.duration === 30)).toBe(true);
    expect(store.undoLabel()).toBe('Quantize 8 notes to 1/16');
    expect(valid(store)).toBe(true);
    store.undo();
    expect(notes(store)).toEqual(before);
  });

  it('halves each offset at 50% strength', () => {
    const store = setup();
    quantizeClip(store, LEAD, 0, { grid: '1/8', strength: 0.5 });
    notes(store).forEach((n, i) => expect(n.tick).toBeCloseTo(i * 48 + OFFSETS[i] / 2, 3));
  });

  it('snaps to triplet and 1/32 grids, and to note ends when asked', () => {
    const store = setup();
    quantizeClip(store, LEAD, 0, { grid: '1/16T', strength: 1, ends: true });
    for (const n of notes(store)) {
      expect(n.tick % 16).toBe(0);
      expect((n.tick + n.duration) % 16).toBe(0);
    }
    const s2 = setup();
    quantizeClip(s2, LEAD, 0, { grid: '1/32' });
    for (const n of notes(s2)) expect(n.tick % 12).toBe(0);
  });

  it('wraps a note pulled onto the loop end to the start, and merges two notes landing together', () => {
    const store = setup();
    store.apply('notes:Write', (d) => {
      d.tracks[4].clips[0]!.notes = [
        { id: 'end', tick: 765, pitch: 60, velocity: 0.5, duration: 10 },
        { id: 'x', tick: 50, pitch: 64, velocity: 0.4, duration: 10 },
        { id: 'y', tick: 46, pitch: 64, velocity: 0.9, duration: 10 },
      ];
    });
    expect(quantizeClip(store, LEAD, 0, { grid: '1/16' })).toMatchObject({ changed: true, moved: 3 });
    expect(notes(store).map((n) => [n.id, n.tick])).toEqual([
      ['end', 0],
      ['y', 48],
    ]);
  });

  it('refuses unknown grids and strengths outside 0..1, and changes nothing on the grid already', () => {
    const store = setup();
    const at = store.getState();
    expect(quantizeClip(store, LEAD, 0, { grid: '1/5' as never })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(quantizeClip(store, LEAD, 0, { grid: '1/16', strength: 1.5 })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(quantizeClip(store, LEAD, 0, { grid: '1/16', strength: 0 })).toMatchObject({ changed: false, moved: 0 });
    expect(quantizeClip(store, LEAD, 3, { grid: '1/16' })).toMatchObject({ changed: false, reason: 'not-found' });
    expect(store.getState()).toBe(at);
    quantizeClip(store, LEAD, 0, { grid: '1/16' });
    expect(quantizeClip(store, LEAD, 0, { grid: '1/16' })).toMatchObject({ changed: false, moved: 0 });
  });
});

describe('humanize a clip', () => {
  it('is deterministic per seed, bounded, and one undo step', () => {
    const a = setup(99);
    quantizeClip(a, LEAD, 0, { grid: '1/16' });
    const grid = notes(a);
    const r = humanizeClip(a, LEAD, 0, { timingTicks: 6, velocityPct: 20, seed: 1 });
    expect(r.changed).toBe(true);
    expect(r.notes).toBeGreaterThan(0);
    const once = notes(a);
    once.forEach((n, i) => {
      expect(Math.abs(n.tick - grid[i].tick)).toBeLessThanOrEqual(6);
      expect(Number.isInteger(n.tick)).toBe(true);
      expect(n.velocity).toBeGreaterThanOrEqual(grid[i].velocity * 0.8 - 1e-9);
      expect(n.velocity).toBeLessThanOrEqual(grid[i].velocity * 1.2 + 1e-9);
      expect(n.id).toBe(grid[i].id);
    });
    expect(a.undoLabel()).toBe('Humanize 8 notes');
    expect(valid(a)).toBe(true);

    // Same project seed, clip and press seed: the same result (so live and exported renders match).
    const b = setup(99);
    quantizeClip(b, LEAD, 0, { grid: '1/16' });
    b.apply('clip:Same id', (d) => {
      d.tracks[4].clips[0]!.id = a.getState().tracks[4].clips[0]!.id;
    });
    humanizeClip(b, LEAD, 0, { timingTicks: 6, velocityPct: 20, seed: 1 });
    expect(notes(b).map((n) => [n.tick, n.velocity])).toEqual(once.map((n) => [n.tick, n.velocity]));
    // Another press seed gives another result.
    a.undo();
    humanizeClip(a, LEAD, 0, { timingTicks: 6, velocityPct: 20, seed: 2 });
    expect(notes(a).map((n) => n.tick)).not.toEqual(once.map((n) => n.tick));
  });

  it('never pushes a note before the clip start, and refuses missing amounts', () => {
    const store = setup(5);
    quantizeClip(store, LEAD, 0, { grid: '1/16' });
    store.apply('notes:Write', (d) => {
      d.tracks[4].clips[0]!.notes[0].tick = 0;
    });
    for (let seed = 0; seed < 20; seed++) {
      humanizeClip(store, LEAD, 0, { timingTicks: 48, velocityPct: 100, seed });
      for (const n of notes(store)) {
        expect(n.tick).toBeGreaterThanOrEqual(0);
        expect(n.tick).toBeLessThan(768);
        expect(n.velocity).toBeGreaterThan(0);
        expect(n.velocity).toBeLessThanOrEqual(1);
      }
    }
    const at = store.getState();
    expect(humanizeClip(store, LEAD, 0, { timingTicks: Number.NaN, velocityPct: 10, seed: 1 })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState()).toBe(at);
  });
});
