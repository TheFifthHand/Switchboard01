/**
 * The Loop button says what it does (loop-button): pressed only when it names
 * the loop that is on; with the loop elsewhere it reads "Move loop to Groove
 * (block 2)", unpressed. A chip ("Loop: Lift–Lift ✕") says what loops and
 * stops it. A loop set with a drag on the ruler says so in a toast with a
 * "Stop looping" action. Real mouse, the running app.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { blockEl, blockIds, centre, clickAt, mouse, nameAt, openApp, resetArrange, rt, settle, teardownArrange, toggle } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const chip = () => document.querySelector<HTMLElement>('[data-testid="loop-chip"]');
const loop = () => rt().songLoop;

/** The notice toast on screen (its text and action button), if any. */
function toast(): { text: string; action: HTMLButtonElement | null } | null {
  // A toast is a status card with its own buttons (the lane's spoken status line is another status).
  const el = [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].find(
    (x) => x.closest('[aria-live]') && /Loop on/.test(x.textContent ?? '') && x.querySelector('button[aria-label="Dismiss"]'),
  );
  if (!el) return null;
  return { text: el.textContent ?? '', action: [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Stop looping') ?? null };
}

/** Drag across the bar numbers from block `a` to block `b` (real mouse). */
async function rulerDrag(a: number, b: number) {
  const ids = blockIds();
  const ruler = document.querySelector<HTMLElement>('[data-testid="song-ruler"]')!.getBoundingClientRect();
  const y = ruler.bottom - 6;
  const from = { x: blockEl(ids[a]).getBoundingClientRect().left + 20, y };
  const to = { x: blockEl(ids[b]).getBoundingClientRect().left + 30, y };
  await mouse('mouseMoved', from);
  await mouse('mousePressed', from);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / 8, y }, { buttons: 1 });
  await mouse('mouseReleased', to);
  await settle(80);
}

describe('the Loop button and the loop chip', () => {
  it('pressed only for the loop that is on; elsewhere it offers to move the loop; the chip says what loops and stops it', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    await act(async () => {
      await session.playSong();
    });
    await settle(200);
    expect(chip()).toBeNull();
    // A drag along the ruler loops Lift to Lift (blocks 3–5), and the toast says so with a way back.
    await rulerDrag(2, 4);
    expect(loop()).toEqual({ fromBlockId: ids[2], toBlockId: ids[4] });
    expect(toast()?.text).toContain('Loop on: Lift to Lift (blocks 3–5)');
    expect(toast()?.action).not.toBeNull();
    expect(chip()!.querySelector('[class*="loopChipText"]')!.textContent).toBe('Loop: Lift–Lift');
    // Nothing selected: the button names the loop that is on, pressed.
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().getAttribute('aria-label')).toBe('Loop blocks 3–5');
    // Groove selected: the button offers to move the loop there, not pressed.
    await clickAt(nameAt(ids[1]));
    expect(toggle().getAttribute('aria-label')).toBe('Move loop to Groove (block 2)');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().textContent).toContain('Move loop to');
    expect(chip()!.textContent).toContain('Loop: Lift–Lift');
    // Pressed: the loop moves to Groove, and now the button is pressed for it.
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[1] });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().getAttribute('aria-label')).toBe('Loop Groove (block 2)');
    expect(chip()!.querySelector('[class*="loopChipText"]')!.textContent).toBe('Loop: Groove');
    // The chip's ✕ stops looping.
    await clickAt(centre(chip()!.querySelector<HTMLElement>('button[aria-label^="Stop looping"]')!));
    expect(loop()).toBeNull();
    expect(chip()).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('the toast of a loop set on the ruler stops it with one press', async () => {
    await openApp(1366, 768);
    await rulerDrag(1, 3);
    expect(loop()).not.toBeNull();
    const t = toast()!;
    expect(t.text).toContain('Loop on: Groove to Break (blocks 2–4)');
    await clickAt(centre(t.action!));
    expect(loop()).toBeNull();
    expect(chip()).toBeNull();
  });
});
