/**
 * Tighten timing and Loosen (capability-02) from the Timing… menu of the Steps header's Clip group, real mouse:
 * - Tighten timing… says how many notes will move, then moves them to the grid with the chosen
 *   strength, as one undo step with a toast ('8 notes moved…');
 * - Loosen (humanize)… shifts timing and level a little, stored in the notes (so exports
 *   match), one undo step with a toast;
 * - notes that merge (two of one pitch pulled onto one tick) are named in the preview and the toast.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { button, item, menu, setUp, tearDown } from './r4-play-helpers';
import { centre, click } from './r4-uikit-input';
import { BASS, notesOf, notice, openSteps } from './r4-steps-helpers';

/** The Timing… menu, then one of its items (Tighten timing… or Loosen (humanize)…). */
async function timing(which: 'Tighten timing…' | 'Loosen (humanize)…'): Promise<void> {
  await click(centre(button('Timing…')!));
  await click(centre(item(which)));
}

beforeEach(setUp);
afterEach(tearDown);

const OFF_GRID = [3, 29, 50, 70, 100, 125, 150, 170];

/** House · Bass, Intro slot: a new 1-bar clip of eight loosely played notes. */
async function looseClip(): Promise<void> {
  await openSteps(BASS, 0);
  act(() => {
    expect(cmd.createClip(session.store, BASS, 0, 1).changed).toBe(true);
    for (const tick of OFF_GRID) cmd.addNote(session.store, BASS, 0, { tick, pitch: 43, velocity: 0.8, duration: 20 });
  });
  await new Promise((r) => requestAnimationFrame(r));
  expect(notesOf(BASS, 0).length).toBe(8);
}

const ticks = () =>
  notesOf(BASS, 0)
    .map((n) => n.tick)
    .sort((a, b) => a - b);

describe('Tighten timing… (quantize)', () => {
  it('previews the count, moves every note onto the 1/16 grid, says "8 notes moved", and Undo puts them back', async () => {
    await looseClip();
    await timing('Tighten timing…');
    expect(menu()).not.toBeNull();
    expect(menu()!.textContent).toContain('8 notes of 8 will move towards the 1/16 grid');
    await click(centre(item('Tighten 8 notes')));
    expect(ticks()).toEqual([0, 24, 48, 72, 96, 120, 144, 168]);
    expect(notice()?.text).toBe('8 notes moved to the 1/16 grid.');
    expect(notice()?.action).toBe('undo');
    // Lengths stay.
    expect(notesOf(BASS, 0).every((n) => n.duration === 20)).toBe(true);
    session.undo();
    expect(ticks()).toEqual(OFF_GRID);
  });

  it('a 50% strength halves each note’s distance to the grid; a coarser grid is offered too', async () => {
    await looseClip();
    await timing('Tighten timing…');
    await click(centre(menu()!.querySelector<HTMLElement>('[aria-label="Strength 50%"]')!));
    await click(centre(menu()!.querySelector<HTMLElement>('[aria-label="Grid 1/8"]')!));
    expect(menu()!.textContent).toContain('towards the 1/8 grid');
    await click(centre(item(/^Tighten \d+ notes$/)));
    // 1/8 = 48 ticks: 3 -> 1.5, 29 -> 38.5, 50 -> 49, 70 -> 59, 100 -> 98, 125 -> 134.5, 150 -> 147, 170 -> 181.
    expect(ticks()).toEqual([1.5, 38.5, 49, 59, 98, 134.5, 147, 181]);
    expect(notice()?.text).toBe('8 notes moved 50% of the way to the 1/8 grid.');
  });
});

describe('merged notes are named', () => {
  it('two notes of one pitch pulled onto one tick become one, and the preview and the toast say so', async () => {
    await openSteps(BASS, 0);
    act(() => {
      cmd.createClip(session.store, BASS, 0, 1);
      for (const tick of [94, 100, 150]) cmd.addNote(session.store, BASS, 0, { tick, pitch: 43, velocity: 0.8, duration: 20 });
    });
    await new Promise((r) => requestAnimationFrame(r));
    await timing('Tighten timing…');
    expect(menu()!.textContent).toContain('3 notes of 3 will move towards the 1/16 grid');
    expect(menu()!.textContent).toContain('1 pair of notes merged');
    await click(centre(item('Tighten 3 notes')));
    expect(ticks()).toEqual([96, 144]);
    expect(notice()?.text).toBe('3 notes moved to the 1/16 grid. 1 pair of notes merged.');
  });
});

describe('Loosen (humanize)…', () => {
  it('shifts note times and levels a little, kept in the notes, as one undo step', async () => {
    await looseClip();
    act(() => void cmd.quantizeClip(session.store, BASS, 0, { grid: '1/16' }));
    const before = notesOf(BASS, 0).map((n) => ({ tick: n.tick, velocity: n.velocity }));
    await timing('Loosen (humanize)…');
    expect(menu()!.textContent).toContain('Loosen (humanize)');
    await click(centre(item('Loosen 8 notes')));
    const after = notesOf(BASS, 0);
    expect(notice()?.text).toMatch(/^Loosened [1-8] notes?/);
    // Timing ±4 ticks and level ±10% (the defaults); something changed.
    let changed = 0;
    after.forEach((n, i) => {
      expect(Math.abs(n.tick - before[i].tick)).toBeLessThanOrEqual(4);
      expect(Math.abs(n.velocity - before[i].velocity)).toBeLessThanOrEqual(0.081);
      if (n.tick !== before[i].tick || n.velocity !== before[i].velocity) changed++;
    });
    expect(changed).toBeGreaterThan(0);
    session.undo();
    expect(notesOf(BASS, 0).map((n) => ({ tick: n.tick, velocity: n.velocity }))).toEqual(before);
  });
});
