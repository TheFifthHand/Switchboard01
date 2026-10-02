/**
 * The piano roll's keys with a selection, real keyboard (PLAY-08), on House · Bass · Bounce
 * (2 bars, G Dorian, Musical Assist on):
 * - arrows move the selection by the grid step, Alt+←/→ nudges 4 ticks, ↑/↓ moves a scale
 *   step and Shift+↑/↓ an octave; a move that would land on a note stops with a message;
 * - Ctrl+D duplicates, Ctrl+C / Ctrl+V copy and paste (at the keyboard cursor, else at the
 *   shown bar's start), Ctrl+X cuts, Ctrl+A selects all; each is one undo step with a toast.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { press, setUp, tearDown } from './r4-play-helpers';
import { click } from './r4-uikit-input';
import { BASS, cursorEl, notePt, notesOf, notice, openSteps, page, selected, showRow } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(tearDown);

const bounce = () => notesOf(BASS, 1);
const byId = (id: string) => bounce().find((n) => n.id === id)!;

describe('keys move the selection (PLAY-08)', () => {
  it('arrows by the grid step, Alt nudges, Up/Down by scale steps, Shift by an octave', async () => {
    await openSteps(BASS, 1);
    const first = bounce().find((n) => n.tick === 48)!;
    expect(first.pitch).toBe(31); // G1
    await showRow(31);
    await click(notePt(first.id));
    expect(selected()).toEqual([first.id]);

    await press('{ArrowRight}');
    expect(byId(first.id).tick).toBe(72);
    await press('{ArrowLeft}');
    expect(byId(first.id).tick).toBe(48);
    await press('{Alt>}{ArrowRight}{/Alt}');
    expect(byId(first.id).tick).toBe(52);
    await press('{Alt>}{ArrowLeft}{/Alt}');
    expect(byId(first.id).tick).toBe(48);
    // G Dorian: G1 up a step is A1; Shift+Up an octave (A2); Shift+Down back; Down to G1.
    await press('{ArrowUp}');
    expect(byId(first.id).pitch).toBe(33);
    await press('{Shift>}{ArrowUp}{/Shift}');
    expect(byId(first.id).pitch).toBe(45);
    await press('{Shift>}{ArrowDown}{/Shift}');
    expect(byId(first.id).pitch).toBe(33);
    await press('{ArrowDown}');
    expect(byId(first.id).pitch).toBe(31);
    // The cursor followed the note, and the move is said.
    expect(cursorEl().getAttribute('aria-label')).toMatch(/^Note grid, bar 1\. G1, step 3: note \(selected\)/);
    // Left from step 3 by a step at a time stops at the clip's start with a message, deleting nothing.
    const count = bounce().length;
    await press('{ArrowLeft}');
    await press('{ArrowLeft}');
    expect(byId(first.id).tick).toBe(0);
    await press('{ArrowLeft}');
    expect(byId(first.id).tick).toBe(0);
    expect(notice()?.text).toMatch(/already at the start of the clip/);
    expect(bounce().length).toBe(count);
  });

  it('moving right past the bar follows the selection to bar 2', async () => {
    await openSteps(BASS, 1);
    const n = bounce().find((x) => x.tick === 336)!; // bar 1, step 15
    await showRow(n.pitch);
    await click(notePt(n.id));
    await press('{ArrowRight}');
    await press('{ArrowRight}');
    expect(byId(n.id).tick).toBe(384);
    expect(page(BASS)).toBe(1);
  });
});

describe('copy, paste, cut, duplicate and select all', () => {
  it('Ctrl+D duplicates; Ctrl+C then Ctrl+V pastes at the keyboard cursor; Ctrl+X cuts; Ctrl+A selects all', async () => {
    await openSteps(BASS, 1);
    const count = bounce().length;
    const first = bounce().find((n) => n.tick === 48)!;
    await showRow(31);
    await click(notePt(first.id));

    // Duplicate: right after the note (its length rounded up to a 16th: 43 ticks -> 48).
    await press('{Control>}d{/Control}');
    expect(bounce().length).toBe(count + 1);
    const copy = bounce().find((n) => n.tick === 96 && n.pitch === 31)!;
    expect(copy).toBeDefined();
    expect(selected()).toEqual([copy.id]);
    expect(notice()?.text).toBe('Duplicated 1 note.');
    expect(notice()?.action).toBe('undo');

    // Copy it, clear the selection, walk the cursor four steps right, paste there.
    await press('{Control>}c{/Control}');
    expect(notice()?.text).toMatch(/^Copied 1 note\./);
    await press('{Escape}');
    expect(selected()).toEqual([]);
    for (let i = 0; i < 4; i++) await press('{ArrowRight}');
    await press('{Control>}v{/Control}');
    expect(bounce().length).toBe(count + 2);
    const pasted = bounce().find((n) => n.tick === 192 && n.pitch === 31)!;
    expect(pasted).toBeDefined();
    expect(selected()).toEqual([pasted.id]);
    expect(notice()?.text).toBe('Pasted 1 note at bar 1.');

    // Cut it: gone, one undo step brings it back.
    await press('{Control>}x{/Control}');
    expect(bounce().length).toBe(count + 1);
    expect(notice()?.text).toBe('Cut 1 note.');
    session.undo();
    expect(bounce().length).toBe(count + 2);

    // A mouse click puts the paste point back at the shown bar's start.
    await click(notePt(first.id));
    await press('{Control>}v{/Control}');
    expect(bounce().some((n) => n.tick === 0 && n.pitch === 31)).toBe(true);

    await press('{Control>}a{/Control}');
    expect(selected().length).toBe(bounce().length);
    expect(cursorEl().getAttribute('aria-label')).toContain(`${bounce().length} notes selected`);
  });
});
