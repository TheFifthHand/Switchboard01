/**
 * Touch on the piano roll (PLAY-02) with CDP touch, on House · Bass · Bounce:
 * - a 200 px swipe over the note grid scrolls the roll (scrollTop changes) and adds no note;
 *   a swipe over the note names scrolls too and plays nothing;
 * - a tap (under 8 px, under 250 ms) adds a note; a tap on a note removes it (Undo in the
 *   toast); a tap on a note name plays it;
 * - a finger that rests 300 ms and then moves sideways draws a longer note.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setUp, tearDown } from './r4-play-helpers';
import { finger, settleFrames, touch, type Pt } from './r4-uikit-input';
import { recordPlayed } from './r4-keys-helpers';
import { BASS, cellPt, notePt, notesOf, notice, openSteps, rowLabel, scroller, showRow } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(tearDown);

const bounce = () => notesOf(BASS, 1);

/** Wait until the roll stops scrolling (a fling can run on after the finger lifts). */
async function settleScroll(): Promise<void> {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    await settleFrames(2);
    const now = scroller().scrollTop;
    if (now === last) return;
    last = now;
  }
}

async function tap(p: Pt): Promise<void> {
  await touch('touchStart', [p]);
  await new Promise((r) => setTimeout(r, 40));
  await touch('touchEnd', []);
  await settleFrames();
}

describe('touch on the roll (PLAY-02)', () => {
  it('a 200 px swipe scrolls the roll and adds no note; a swipe over the note names scrolls and plays nothing', async () => {
    await openSteps(BASS, 1);
    const count = bounce().length;
    const sc = scroller();
    // The roll opens centred on the notes, with room to scroll both ways.
    expect(sc.scrollTop).toBeGreaterThan(200);
    const before = sc.scrollTop;
    const box = sc.getBoundingClientRect();
    const a = { x: box.left + box.width * 0.55, y: box.top + 40 };
    await finger(a, { x: a.x, y: a.y + 200 }, { steps: 12 });
    await settleScroll();
    expect(sc.scrollTop).toBeLessThan(before - 100);
    expect(bounce().length).toBe(count);

    const played = recordPlayed();
    try {
      const names = rowLabel(43).getBoundingClientRect();
      const top = sc.scrollTop;
      const b = { x: names.left + names.width / 2, y: box.bottom - 30 };
      await finger(b, { x: b.x, y: b.y - 200 }, { steps: 12 });
      await settleScroll();
      expect(sc.scrollTop).toBeGreaterThan(top + 100);
      expect(played.ons()).toEqual([]);
      expect(bounce().length).toBe(count);
    } finally {
      played.restore();
    }
  });

  it('a tap adds one note; a tap on it removes it; a tap on a note name plays it', async () => {
    await openSteps(BASS, 1);
    const count = bounce().length;
    await showRow(43);
    const played = recordPlayed();
    try {
      await tap(cellPt(9, 43));
      expect(bounce().length).toBe(count + 1);
      const added = bounce().find((n) => n.tick === 9 * 24 && n.pitch === 43)!;
      expect(added).toBeDefined();
      expect(played.ons().at(-1)).toMatchObject({ pitch: 43, source: 'preview' });

      await new Promise((r) => setTimeout(r, 120));
      await tap(notePt(added.id));
      expect(bounce().length).toBe(count);
      expect(notice()?.text).toBe('Deleted 1 note.');
      expect(notice()?.action).toBe('undo');

      const ons = played.ons().length;
      const name = rowLabel(43).getBoundingClientRect();
      await tap({ x: name.left + name.width / 2, y: name.top + name.height / 2 });
      expect(played.ons().length).toBe(ons + 1);
      expect(played.ons().at(-1)).toMatchObject({ pitch: 43, source: 'preview' });
    } finally {
      played.restore();
    }
  });

  it('a finger resting 300 ms on an empty cell, then moving sideways, draws a longer note', async () => {
    await openSteps(BASS, 1);
    const count = bounce().length;
    await showRow(43);
    const a = cellPt(9, 43);
    const b = cellPt(12, 43);
    const top = scroller().scrollTop;
    await finger(a, b, { steps: 6, holdMs: 380 });
    await settleScroll();
    expect(bounce().length).toBe(count + 1);
    expect(bounce().find((n) => n.tick === 9 * 24 && n.pitch === 43)).toMatchObject({ duration: 4 * 24 });
    expect(scroller().scrollTop).toBe(top);
  });
});
