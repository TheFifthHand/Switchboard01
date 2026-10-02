/**
 * The grid menu (instruction 2, capability-12) with real input: the roll's columns follow the
 * chosen grid (1/16: 16 a bar, 1/32: 32, 1/8T: 12, 1/16T: 24), a click places a note on that
 * grid (a 1/32 note lands at tick 12), dragging snaps to it, and Alt places freely. Drum parts
 * keep their 16 steps and show no grid menu.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { uiStore } from '../../src/state/uiStore';
import { setUp, tearDown } from './r4-play-helpers';
import { click, mouse, settleFrames } from './r4-uikit-input';
import { BASS, cellPt, notePt, notesOf, openSteps, roll, showRow } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(tearDown);

const gridSelect = () => ([...document.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent === 'Grid')?.control as HTMLSelectElement | null | undefined) ?? null;
const columns = () => roll().querySelectorAll('[data-col]').length;
const numbers = () => [...document.querySelectorAll<HTMLElement>('[data-cells] [data-ph-step]')].filter((el) => !el.closest('[data-testid="pitch-roll"]'));

async function choose(grid: string): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.selectOptions(gridSelect()!, grid);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames(2);
}

async function emptyBass(): Promise<void> {
  await openSteps(BASS, 0);
  act(() => void cmd.createClip(session.store, BASS, 0, 1));
  await settleFrames(2);
  await showRow(43);
}

describe('grid menu', () => {
  it('1/32: 32 columns, and a click on the second lands at tick 12 (one 32nd long)', async () => {
    await emptyBass();
    expect(columns()).toBe(16);
    await choose('1/32');
    expect(uiStore.getState().stepGrid).toBe('1/32');
    expect(columns()).toBe(32);
    // The ruler counts 16ths: 1 · 2 · …
    expect(numbers().slice(0, 4).map((n) => n.textContent)).toEqual(['1', '·', '2', '·']);
    await click(cellPt(1, 43));
    expect(notesOf(BASS, 0)).toEqual([expect.objectContaining({ tick: 12, pitch: 43, duration: 12 })]);
  });

  it('1/8T shows 12 columns (three a beat) and 1/16T 24; notes land on triplet ticks', async () => {
    await emptyBass();
    await choose('1/8T');
    expect(columns()).toBe(12);
    expect(numbers().length).toBe(12);
    await click(cellPt(4, 43));
    expect(notesOf(BASS, 0).map((n) => n.tick)).toEqual([128]);
    await choose('1/16T');
    expect(columns()).toBe(24);
    await click(cellPt(5, 43));
    expect(notesOf(BASS, 0).map((n) => n.tick).sort((a, b) => a - b)).toEqual([80, 128]);
    // The columns of every lane line up: the velocity lane has 24 too.
    expect(document.querySelectorAll('[data-testid="velocity-lane"] [data-step]').length).toBe(24);
  });

  it('dragging snaps to the grid; Alt places freely', async () => {
    await emptyBass();
    await click(cellPt(0, 43));
    const id = notesOf(BASS, 0)[0].id;
    await click(cellPt(0, 50)); // another note, so the first is not double-clicked
    const from = notePt(id);
    const to = cellPt(3, 43, 0.35);
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from);
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / 6, y: from.y }, { buttons: 1 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    await mouse('mouseReleased', to);
    await settleFrames();
    const snapped = notesOf(BASS, 0).find((n) => n.id === id)!.tick;
    expect(snapped % 24).toBe(0);
    expect(snapped).toBe(72);
    // With Alt the note goes where the pointer is, between grid lines.
    const ALT = 1;
    const p = notePt(id);
    const q = { x: p.x + 9, y: p.y };
    await mouse('mouseMoved', p);
    await mouse('mousePressed', p, { modifiers: ALT });
    for (let i = 1; i <= 4; i++) {
      await mouse('mouseMoved', { x: p.x + ((q.x - p.x) * i) / 4, y: p.y }, { buttons: 1, modifiers: ALT });
      await new Promise((r) => requestAnimationFrame(r));
    }
    await mouse('mouseReleased', q, { modifiers: ALT });
    await settleFrames();
    const free = notesOf(BASS, 0).find((n) => n.id === id)!.tick;
    expect(free).toBeGreaterThan(72);
    expect(free % 12).not.toBe(0);
  });

  it('drum parts keep 16 steps and have no grid menu', async () => {
    await openSteps('t1', 1, { grid: '1/32' });
    expect(gridSelect()).toBeFalsy();
    expect(document.querySelectorAll('[data-testid="velocity-lane"] [data-step]').length).toBe(16);
  });
});
