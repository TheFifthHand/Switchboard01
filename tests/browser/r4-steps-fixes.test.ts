/**
 * Fix round for the piano roll, real mouse and keyboard on the House starter:
 * - M1: moves are held to whole grid steps: at the clip's end an arrow says so and moves
 *   nothing (never 23 ticks, off the grid); a last-bar note dragged past the right edge lands
 *   on step 16, where the drag drew it;
 * - M2: released past the right edge after the page turned, the note lands on the bar shown
 *   (and is drawn there during the hold);
 * - M3: Ctrl+D keeps the copy on the grid (1/8T, 1/32);
 * - the key chip never cuts the root off; the velocity lane's "1/4" reads well and a drag on a
 *   step with no selected notes says why nothing changes; Follow turning the bar never scrolls
 *   the page.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { keyLabel, keyRootName } from '../../src/music/scales';
import type { ScaleId } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setStepPage, setStepsFollow } from '../../src/state/uiStore';
import { press, setUp, tearDown } from './r4-play-helpers';
import { click, contrast, mouse, settleFrames, type Pt } from './r4-uikit-input';
import { BASS, CHORDS, cellPt, col, lane, lanePt, noteEl, notePt, notesOf, notice, openSteps, page, selected, showRow } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(async () => {
  act(() => setStepsFollow(false));
  await tearDown();
});

const stabs = () => notesOf(CHORDS, 1);
const bounce = () => notesOf(BASS, 1);
const sig = (ns: { tick: number; pitch: number }[]) => ns.map((n) => `${n.tick}:${n.pitch}`).sort().join(',');

/** A mouse drag in steps a frame apart; `hold` waits with the button down at the end, `release: false` keeps it down. */
async function dragTo(from: Pt, to: Pt, opts: { steps?: number; release?: boolean } = {}): Promise<void> {
  const steps = opts.steps ?? 8;
  await mouse('mouseMoved', from);
  await mouse('mousePressed', from);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, { buttons: 1 });
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (opts.release !== false) {
    await mouse('mouseReleased', to);
    await settleFrames();
  }
}

describe('M1: moves keep to the grid at the clip end', () => {
  it('Ctrl+A then → at the end of the clip moves nothing and says so; ← moves every note one step, on the grid', async () => {
    await openSteps(CHORDS, 1);
    const before = stabs();
    expect(Math.max(...before.map((n) => n.tick))).toBe(1512); // a note on the very last step
    const any = before.find((n) => n.tick === 72)!;
    await showRow(any.pitch);
    await click(notePt(any.id));
    await press('{Control>}a{/Control}');
    expect(selected().length).toBe(before.length);
    await press('{ArrowRight}');
    expect(sig(stabs())).toBe(sig(before));
    expect(notice()?.text).toBe('The notes are already at the end of the clip.');
    await press('{ArrowLeft}');
    const after = stabs();
    expect(sig(after)).toBe(sig(before.map((n) => ({ tick: n.tick - 24, pitch: n.pitch }))));
  });

  it('a note on step 16 of the last bar: → stays and says so', async () => {
    await openSteps(BASS, 1);
    act(() => void cmd.addNote(session.store, BASS, 1, { tick: 744, pitch: 43, velocity: 0.8, duration: 24 }));
    act(() => setStepPage(BASS, 1));
    await settleFrames(2);
    await showRow(43);
    const n = bounce().find((x) => x.tick === 744)!;
    await click(notePt(n.id));
    await press('{ArrowRight}');
    expect(bounce().find((x) => x.id === n.id)!.tick).toBe(744);
    expect(notice()?.text).toBe('The notes are already at the end of the clip.');
  });

  it('a last-bar note dragged past the right edge lands on step 16, where the drag drew it', async () => {
    await openSteps(BASS, 1);
    act(() => setStepPage(BASS, 1));
    await settleFrames(2);
    const n = bounce().find((x) => x.tick === 432)!; // bar 2, step 4
    await showRow(n.pitch);
    const from = notePt(n.id);
    const past = { x: col(15).getBoundingClientRect().right + 30, y: from.y };
    await dragTo(from, past, { release: false });
    // Drawn on the last step while the pointer is past the edge.
    const drawn = noteEl(n.id)!.getBoundingClientRect();
    const last = col(15).getBoundingClientRect();
    expect(drawn.left).toBeGreaterThanOrEqual(last.left - 1);
    expect(drawn.left).toBeLessThan(last.right);
    await mouse('mouseReleased', past);
    await settleFrames();
    expect(bounce().find((x) => x.id === n.id)!.tick).toBe(744);
  });
});

describe('M2: a drop past the edge lands on the bar shown', () => {
  it('held past the right edge until bar 2 shows, then released there: bar 2, step 16 (drawn there meanwhile)', async () => {
    await openSteps(CHORDS, 1);
    const a4 = stabs().find((n) => n.tick === 72 && n.pitch === 69)!;
    await showRow(69);
    const from = notePt(a4.id);
    const lastCol = col(15).getBoundingClientRect();
    // Inside the last column (its right part): the note is drawn there, on this bar.
    await dragTo(from, { x: lastCol.right - 4, y: from.y }, { release: false });
    await settleFrames();
    expect(page(CHORDS)).toBe(0);
    expect(noteEl(a4.id)!.getBoundingClientRect().left).toBeGreaterThanOrEqual(lastCol.left - 1);
    const past = { x: lastCol.right + 30, y: from.y };
    for (let i = 1; i <= 3; i++) {
      await mouse('mouseMoved', { x: lastCol.right - 4 + ((past.x - lastCol.right + 4) * i) / 3, y: from.y }, { buttons: 1 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    const held = performance.now();
    while (page(CHORDS) === 0 && performance.now() - held < 3000) await new Promise((r) => requestAnimationFrame(r));
    expect(page(CHORDS)).toBeGreaterThanOrEqual(1);
    // The dragged note is drawn on the shown bar's last step during the hold.
    const drawn = noteEl(a4.id);
    expect(drawn).not.toBeNull();
    expect(drawn!.getBoundingClientRect().left).toBeGreaterThanOrEqual(col(15).getBoundingClientRect().left - 1);
    await mouse('mouseReleased', past);
    // (A busy machine can let the hold turn one bar more before the release: the drop lands on the bar shown then.)
    const shown = page(CHORDS);
    await settleFrames();
    const moved = stabs().find((n) => n.id === a4.id)!;
    expect(moved.tick).toBe(shown * 384 + 15 * 24);
    expect(page(CHORDS)).toBe(shown);
  });
});

describe('M3: Ctrl+D keeps to the grid', () => {
  for (const [grid, g] of [
    ['1/8T', 32],
    ['1/32', 12],
  ] as const) {
    it(`on ${grid} a one-cell note at tick 0 is copied to tick ${g}`, async () => {
      await openSteps(BASS, 0, { grid });
      act(() => void cmd.createClip(session.store, BASS, 0, 1));
      await settleFrames(2);
      await showRow(43);
      await click(cellPt(0, 43));
      expect(notesOf(BASS, 0).map((n) => [n.tick, n.duration])).toEqual([[0, g]]);
      await press('{Control>}d{/Control}');
      expect(
        notesOf(BASS, 0)
          .map((n) => n.tick)
          .sort((a, b) => a - b),
      ).toEqual([0, g]);
      await press('{Control>}d{/Control}');
      expect(
        notesOf(BASS, 0)
          .map((n) => n.tick)
          .sort((a, b) => a - b),
      ).toEqual([0, g, 2 * g]);
    });
  }
});

describe('the key chip never cuts the root off', () => {
  for (const [root, scale] of [
    [3, 'harmonicMinor'],
    [0, 'minorPentatonic'],
    [10, 'majorPentatonic'],
  ] as [number, ScaleId][]) {
    it(`${keyLabel(root, scale)}: the chip shows its root in full, and says the whole key`, async () => {
      await openSteps(CHORDS, 1);
      act(() => void cmd.setKey(session.store, root, scale));
      await settleFrames(3);
      const chip = document.querySelector<HTMLElement>('[aria-label^="Rows in key"]')!;
      expect(chip.getAttribute('aria-label')).toBe(`Rows in key: ${keyLabel(root, scale)}`);
      const shown = chip.querySelector<HTMLElement>('[class*="keyText"]')!;
      expect(shown.textContent!.startsWith(keyRootName(root, scale))).toBe(true);
      expect(shown.scrollWidth).toBeLessThanOrEqual(shown.clientWidth);
      const c = chip.getBoundingClientRect();
      const t = shown.getBoundingClientRect();
      expect(t.left).toBeGreaterThanOrEqual(c.left);
      expect(t.right).toBeLessThanOrEqual(c.right);
    });
  }
});

describe('velocity lane with a selection', () => {
  it('the "1/4" count reads well over the teal bar; a drag on a step with no selected notes says why nothing changes', async () => {
    await openSteps(CHORDS, 1);
    const chord = stabs()
      .filter((n) => n.tick === 240)
      .sort((a, b) => a.pitch - b.pitch);
    const top = chord.at(-1)!;
    await showRow(top.pitch);
    await click(notePt(top.id));
    const count = lane().querySelector<HTMLElement>('[data-step="10"] [data-picked]')!;
    expect(count.textContent).toBe('1/4');
    const cs = getComputedStyle(count);
    expect(contrast(cs.color, cs.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    // Step 4 holds a chord with none of it selected.
    const before = stabs().filter((n) => n.tick === 72).map((n) => n.velocity);
    await click(lanePt(3, 0.3));
    expect(stabs().filter((n) => n.tick === 72).map((n) => n.velocity)).toEqual(before);
    expect(notice()?.text).toMatch(/^Only the selected notes change\. Press Esc to clear the selection/);
    expect(lane().textContent).toContain('1 note selected · Esc clears');
  });
});

describe('Follow never scrolls the page', () => {
  it('at 960 x 540 (the page scrolls), turning the shown bar (as Follow does) keeps the page where it is', async () => {
    await openSteps(CHORDS, 1, { w: 960, h: 540 });
    document.scrollingElement!.scrollTop = document.scrollingElement!.scrollHeight;
    await settleFrames(2);
    const y = document.scrollingElement!.scrollTop;
    expect(y).toBeGreaterThan(100);
    // Follow turns the page with setStepPage from its frame loop; the bar strip then brings the bar's key into view.
    for (const p of [1, 2, 3, 0]) {
      act(() => setStepPage(CHORDS, p));
      await settleFrames(2);
      expect(document.scrollingElement!.scrollTop, `bar ${p + 1}`).toBe(y);
    }
  });
});
