/**
 * Variation that explores instead of drifting (PLAY-16): Subtle and Bold
 * strengths, and varying from the clip's original notes so eight presses
 * stay close to the original.
 */
import { describe, expect, it } from 'vitest';
import { getStarter, STARTERS } from '../../src/content/starters';
import { variationSeed } from '../../src/music/variation';
import type { Note, Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { repeatClipToBars } from '../../src/state/commands/clips';
import { INTENSITY, applyVariation } from '../../src/state/commands/variation';

const clipOf = (p: Project, trackId: string, slot: number) => p.tracks.find((t) => t.id === trackId)!.clips[slot]!;

/** Press Variation `presses` times the way the view will: each press varies the original with the next seed. */
function press(store: ProjectStore, trackId: string, slot: number, presses: number, intensity?: number): number[] {
  const base: Note[] = clipOf(store.getState(), trackId, slot).notes;
  const counts: number[] = [];
  for (let i = 1; i <= presses; i++) {
    // The view seeds with the clip id; a fixed label keeps this test reproducible.
    const seed = variationSeed(store.getState().seed, `${trackId}:${slot}`, i);
    const r = applyVariation(store, trackId, slot, seed, intensity, { from: base });
    expect(r.changed).toBe(true);
    counts.push(clipOf(store.getState(), trackId, slot).notes.length);
  }
  return counts;
}

describe('Variation from the original', () => {
  it('keeps the note count within ±30% of the original for every clip of every starter, at every strength', () => {
    let presses = 0;
    for (const starter of STARTERS) {
      const p = starter.build();
      const cases: [string, number, number][] = [];
      for (const t of p.tracks) t.clips.forEach((c, slot) => c && c.notes.length > 0 && cases.push([t.id, slot, c.notes.length]));
      for (const [trackId, slot, base] of cases) {
        for (const intensity of [undefined, INTENSITY.subtle, INTENSITY.bold]) {
          const store = new ProjectStore(starter.build());
          for (const n of press(store, trackId, slot, 10, intensity)) {
            presses++;
            const where = `${starter.id} ${trackId} slot ${slot} (${base} notes)`;
            expect(n, where).toBeLessThanOrEqual(base * 1.3);
            expect(n, where).toBeGreaterThanOrEqual(base * 0.7);
            // Three notes or fewer: 30% is less than a note, so the count stays.
            if (base <= 3) expect(n, where).toBe(base);
          }
        }
      }
    }
    expect(presses).toBeGreaterThan(3000);
  });

  it('drums stay near the original where pressing on the result kept piling notes up', () => {
    const store = new ProjectStore(getStarter('house')!.build());
    const drums = store.getState().tracks[0];
    const slot = drums.clips.findIndex((c) => c?.name === 'Four Floor');
    const base = drums.clips[slot]!.notes.length;
    const fromBase = press(store, drums.id, slot, 8);
    expect(Math.max(...fromBase)).toBeLessThanOrEqual(Math.ceil(base * 1.3));
    // Each press is a different exploration of the same original, not a copy of the last one.
    const a = clipOf(store.getState(), drums.id, slot).notes.map((n) => `${n.tick}|${n.pitch}`).sort();
    store.undo();
    const b = clipOf(store.getState(), drums.id, slot).notes.map((n) => `${n.tick}|${n.pitch}`).sort();
    expect(a).not.toEqual(b);
  });

  it('records the generation and seed, names Subtle and Bold presses, and returns a summary for the toast', () => {
    const store = new ProjectStore(getStarter('house')!.build());
    const r = applyVariation(store, 't4', 1, 77, INTENSITY.bold);
    expect(r.changed).toBe(true);
    expect(r.summary).toMatch(/note/);
    expect(r.diff!.total).toBeGreaterThan(0);
    expect(store.undoLabel()).toBe('Bold variation');
    expect(clipOf(store.getState(), 't4', 1).variation).toEqual({ seed: 77, generation: 1 });
    applyVariation(store, 't4', 1, 78, INTENSITY.subtle);
    expect(store.undoLabel()).toBe('Subtle variation');
    expect(clipOf(store.getState(), 't4', 1).variation).toEqual({ seed: 78, generation: 2 });
    applyVariation(store, 't4', 1, 79);
    expect(store.undoLabel()).toBe('Variation');
    expect(INTENSITY).toEqual({ subtle: 0.35, bold: 0.85 });
    const v = validateProject(JSON.parse(JSON.stringify(store.getState())));
    expect(v.ok && v.warnings).toEqual([]);
  });

  it('subtle changes less than bold', () => {
    let subtle = 0;
    let bold = 0;
    for (const s of STARTERS) {
      for (let seed = 1; seed <= 3; seed++) {
        for (const [intensity, add] of [
          [INTENSITY.subtle, (n: number) => (subtle += n)],
          [INTENSITY.bold, (n: number) => (bold += n)],
        ] as const) {
          const store = new ProjectStore(s.build());
          const t = store.getState().tracks.find((x) => x.role === 'drums')!;
          const slot = t.clips.findIndex((c) => c && c.notes.length > 8);
          if (slot < 0) continue;
          const r = applyVariation(store, t.id, slot, seed, intensity);
          add(r.diff?.total ?? 0);
        }
      }
    }
    expect(bold).toBeGreaterThan(subtle);
  });

  it('leaves out original notes that no longer fit, and refuses when none do', () => {
    const store = new ProjectStore(getStarter('house')!.build());
    const clip = clipOf(store.getState(), 't3', 1);
    const at = store.getState();
    expect(applyVariation(store, 't3', 1, 5, undefined, { from: [{ id: 'x', tick: 99999, pitch: 40, velocity: 1, duration: 24 }] })).toMatchObject({ changed: false, reason: 'empty' });
    expect(applyVariation(store, 't3', 1, 5, Number.NaN)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(store.getState()).toBe(at);
    const r = applyVariation(store, 't3', 1, 5, undefined, { from: [...clip.notes, { id: 'late', tick: 5000, pitch: 40, velocity: 1, duration: 24 }] });
    expect(r.changed).toBe(true);
    expect(clipOf(store.getState(), 't3', 1).notes.every((n) => n.tick < 768)).toBe(true);
  });

  it('varies 8-bar clips inside the clip, every part kind', () => {
    const store = new ProjectStore(getStarter('house')!.build());
    for (const t of store.getState().tracks) {
      const slot = t.clips.findIndex((c) => c && c.notes.length > 0);
      if (slot < 0) continue;
      repeatClipToBars(store, t.id, slot, 8);
      const base = clipOf(store.getState(), t.id, slot).notes;
      for (let seed = 1; seed <= 4; seed++) {
        expect(applyVariation(store, t.id, slot, seed, INTENSITY.bold, { from: base }).changed).toBe(true);
        const c = clipOf(store.getState(), t.id, slot);
        expect(c.bars).toBe(8);
        expect(c.notes.every((n) => n.tick >= 0 && n.tick < 8 * 384)).toBe(true);
      }
    }
    const v = validateProject(JSON.parse(JSON.stringify(store.getState())));
    expect(v.ok && v.warnings).toEqual([]);
  });

  it('is refused during a performance take and for a locked part', () => {
    const store = new ProjectStore(getStarter('house')!.build());
    store.setLock('Recording a performance', (label) => label.startsWith('module:'));
    expect(applyVariation(store, 't4', 1, 3)).toMatchObject({ changed: false, refused: 'Recording a performance' });
    store.setLock(null);
    store.apply('track:Lock part', (d) => {
      d.tracks[3].locked = true;
    });
    expect(applyVariation(store, 't4', 1, 3)).toMatchObject({ changed: false, reason: 'locked' });
  });
});
