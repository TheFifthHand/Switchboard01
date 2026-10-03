/**
 * Random edit sequences while the song plays (see song-live-fuzz.ts for what
 * is checked). A trimmed run keeps guarding every invariant; set
 * SONG_FUZZ_SEEDS (e.g. 3000) for a deep run.
 */
import { describe, expect, it } from 'vitest';
import { runFuzz } from './song-live-fuzz';

const SEEDS = Math.max(1, Number(process.env.SONG_FUZZ_SEEDS) || 400);

describe('random edits while the song plays, against the final plan', () => {
  it('without split', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) problems.push(...runFuzz(seed, { split: false }));
    expect(problems.slice(0, 12)).toEqual([]);
  });

  it('with split', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= Math.ceil(SEEDS * 0.6); seed++) problems.push(...runFuzz(seed, { split: true }));
    expect(problems.slice(0, 12)).toEqual([]);
  });

  it('includes the seed whose edit right after Resume once left the song without an end', () => {
    expect(runFuzz(935, { split: false })).toEqual([]);
  });

  it('with song loops set, changed and cleared at random (see song-live-fuzz.ts for the loop invariants)', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) problems.push(...runFuzz(seed, { split: false, loops: true }));
    expect(problems.slice(0, 12)).toEqual([]);
  });

  it('with the song helpers (build up, strip down, breakdown), mostly on the playing block', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= Math.ceil(SEEDS * 0.6); seed++) problems.push(...runFuzz(seed, { split: true, shape: true, steps: 20 }));
    expect(problems.slice(0, 12)).toEqual([]);
  });

  it('with the song helpers and song loops', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= Math.ceil(SEEDS * 0.6); seed++) problems.push(...runFuzz(seed, { split: true, shape: true, loops: true, steps: 20 }));
    expect(problems.slice(0, 12)).toEqual([]);
  });

  it('with song loops and splits', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= Math.ceil(SEEDS * 0.6); seed++) problems.push(...runFuzz(seed, { split: true, loops: true, steps: 20 }));
    expect(problems.slice(0, 12)).toEqual([]);
  });
});
