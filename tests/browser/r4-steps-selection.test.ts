/**
 * The piano roll's selection model with real mouse and keyboard (PLAY-08, capability-12),
 * on House · Chords · Stabs (4 bars, G Dorian):
 * - a click on a note selects it and does not delete it; Delete removes the selection with a
 *   toast that offers Undo; a double-click removes too;
 * - Shift-drag on empty grid draws a selection box;
 * - dragging two selected notes from bar 1 into bar 2 (holding past the right edge turns the
 *   page) moves both, as one undo step;
 * - with the top chord note selected, the velocity lane changes only that note.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { press, setUp, tearDown } from './r4-play-helpers';
import { click, mouse, settleFrames } from './r4-uikit-input';
import { CHORDS, cellPt, clipOf, col, lane, lanePt, noteEl, notePt, notesOf, notice, openSteps, page, roll, selected, showRow } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(tearDown);

const SHIFT = 8;
const stabs = () => notesOf(CHORDS, 1);
/** The chord starting at `tick` (lowest note first). */
const chordAt = (tick: number) =>
  stabs()
    .filter((n) => n.tick === tick)
    .sort((a, b) => a.pitch - b.pitch);

describe('selecting and removing notes', () => {
  it('a click selects (and does not delete); Delete removes with a toast and Undo; a double-click removes', async () => {
    await openSteps(CHORDS, 1);
    expect(clipOf(CHORDS, 1).name).toBe('Stabs');
    const before = stabs().length;
    const top = chordAt(72).at(-1)!;
    await showRow(top.pitch);
    await click(notePt(top.id));
    expect(stabs().length).toBe(before);
    expect(selected()).toEqual([top.id]);
    expect(noteEl(top.id)!.hasAttribute('data-selected')).toBe(true);
    // The selection is said in words too.
    expect(lane().textContent).toContain('1 note selected');

    await press('{Delete}');
    expect(stabs().length).toBe(before - 1);
    expect(stabs().some((n) => n.id === top.id)).toBe(false);
    expect(notice()?.text).toBe('Deleted 1 note.');
    expect(notice()?.action).toBe('undo');
    await press('{Control>}z{/Control}');
    expect(stabs().length).toBe(before);

    // Double-click a note: gone.
    const other = chordAt(72)[0];
    await showRow(other.pitch);
    const p = notePt(other.id);
    await mouse('mouseMoved', p);
    await mouse('mousePressed', p);
    await mouse('mouseReleased', p);
    await mouse('mousePressed', p, { clickCount: 2 });
    await mouse('mouseReleased', p, { clickCount: 2 });
    await settleFrames();
    expect(stabs().some((n) => n.id === other.id)).toBe(false);
    expect(notice()?.text).toBe('Deleted 1 note.');
  });

  it('Shift-drag on empty grid draws a selection box around the notes it covers', async () => {
    await openSteps(CHORDS, 1);
    // Bar 1 holds a chord at step 4 (tick 72) and one at step 7 (tick 144): B♭3 D4 F4 A4.
    const inBox = stabs().filter((n) => n.tick >= 48 && n.tick < 9 * 24 && n.pitch >= 57 && n.pitch <= 70);
    expect(inBox.length).toBe(8);
    await showRow(64);
    const a = cellPt(1, 70);
    const b = cellPt(8, 57);
    await mouse('mouseMoved', a);
    await mouse('mousePressed', a, { modifiers: SHIFT });
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', { x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }, { buttons: 1, modifiers: SHIFT });
      await new Promise((r) => requestAnimationFrame(r));
    }
    // The box is drawn while dragging.
    expect(roll().querySelector('[class*="box"]')).not.toBeNull();
    await mouse('mouseReleased', b, { modifiers: SHIFT });
    await settleFrames();
    expect([...selected()].sort()).toEqual(inBox.map((n) => n.id).sort());
    expect(roll().querySelectorAll('[data-note-id][data-selected]').length).toBe(8);
    // Nothing was added or removed.
    expect(stabs().length).toBe(68);
    // A plain drag on empty grid still draws a note.
    await showRow(72);
    const from = cellPt(0, 72);
    const to = cellPt(2, 72);
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from);
    for (let i = 1; i <= 4; i++) {
      await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / 4, y: from.y }, { buttons: 1 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    await mouse('mouseReleased', to);
    await settleFrames();
    expect(stabs().length).toBe(69);
    const drawn = stabs().find((n) => n.pitch === 72 && n.tick === 0)!;
    expect(drawn.duration).toBe(72);
    expect(selected()).toEqual([drawn.id]);
  });
});

describe('moving across bars', () => {
  it('drags two selected notes from bar 1 into bar 2: holding past the right edge turns the page; one undo step', async () => {
    await openSteps(CHORDS, 1);
    const [, , f4, a4] = chordAt(72);
    await showRow(67);
    await click(notePt(a4.id));
    await click({ ...notePt(f4.id) }); // plain click: only F4
    expect(selected()).toEqual([f4.id]);
    // Shift-click adds A4.
    const ap = notePt(a4.id);
    await mouse('mouseMoved', ap);
    await mouse('mousePressed', ap, { modifiers: SHIFT });
    await mouse('mouseReleased', ap, { modifiers: SHIFT });
    await settleFrames();
    expect([...selected()].sort()).toEqual([a4.id, f4.id].sort());

    // Bar 2's cell 2 (tick 408) is free on those pitches.
    expect(stabs().some((n) => n.tick === 408 && (n.pitch === 69 || n.pitch === 65))).toBe(false);
    const grab = notePt(a4.id);
    const lastCol = col(15).getBoundingClientRect();
    const past = { x: lastCol.right + 24, y: grab.y };
    await mouse('mouseMoved', grab);
    await mouse('mousePressed', grab);
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', { x: grab.x + ((past.x - grab.x) * i) / 8, y: grab.y }, { buttons: 1 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Held at the edge: after 400 ms the page turns to bar 2.
    expect(page(CHORDS)).toBe(0);
    await new Promise((r) => setTimeout(r, 650));
    await settleFrames();
    expect(page(CHORDS)).toBe(1);
    // Into bar 2, cell 2 (the grab was in the note's first cell, 12 ticks in).
    const target = cellPt(1, 69, 0.5);
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', { x: past.x + ((target.x - past.x) * i) / 6, y: grab.y }, { buttons: 1 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Nothing is committed until the drop.
    expect(stabs().find((n) => n.id === a4.id)!.tick).toBe(72);
    await mouse('mouseReleased', target);
    await settleFrames();
    const moved = (id: string) => stabs().find((n) => n.id === id)!;
    expect(moved(a4.id)).toMatchObject({ tick: 408, pitch: 69 });
    expect(moved(f4.id)).toMatchObject({ tick: 408, pitch: 65 });
    expect(stabs().length).toBe(68);
    // One undo step puts both back.
    session.undo();
    expect(moved(a4.id).tick).toBe(72);
    expect(moved(f4.id).tick).toBe(72);
  });
});

describe('per-note velocity', () => {
  it('with the top note of a chord selected, the velocity lane changes only that note', async () => {
    await openSteps(CHORDS, 1);
    const chord = chordAt(240);
    expect(chord.length).toBe(4);
    const top = chord.at(-1)!;
    await showRow(top.pitch);
    await click(notePt(top.id));
    expect(selected()).toEqual([top.id]);
    const cell = 240 / 24;
    // One bar per voice, the selected one marked.
    const column = lane().querySelector<HTMLElement>(`[data-step="${cell}"]`)!;
    expect(column.querySelectorAll('[data-voice-id]').length).toBe(4);
    expect(column.querySelector('[data-voice-id][data-selected]')!.getAttribute('data-voice-id')).toBe(top.id);
    const others = chord.slice(0, 3).map((n) => n.velocity);
    const from = lanePt(cell, top.velocity);
    const to = lanePt(cell, 0.3);
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from);
    await mouse('mouseMoved', { x: from.x, y: (from.y + to.y) / 2 }, { buttons: 1 });
    await mouse('mouseMoved', to, { buttons: 1 });
    await mouse('mouseReleased', to);
    await settleFrames();
    const after = chordAt(240);
    expect(after.at(-1)!.velocity).toBeCloseTo(0.3, 1);
    expect(after.slice(0, 3).map((n) => n.velocity)).toEqual(others);
    // One drag, one undo step.
    expect(session.store.undoLabel()).toMatch(/velocity of 1 note/);
    // Nothing selected: the lane sets every voice on the step.
    await press('{Escape}');
    expect(selected()).toEqual([]);
    const all = lanePt(cell, 0.6);
    await click(all);
    expect(chordAt(240).every((n) => Math.abs(n.velocity - 0.6) < 0.06)).toBe(true);
  });
});
