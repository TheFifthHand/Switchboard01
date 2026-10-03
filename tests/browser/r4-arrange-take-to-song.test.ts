/**
 * Takes become song blocks (takes-separate-from-song): a take's "Make song
 * blocks" adds blocks after the song for its scene launches (one Undo), the
 * lane selects them, and the toast says what was rounded and that played
 * notes and knob moves are not carried over. An empty song offers it too when
 * there are takes. The running app at 1366 × 768, 1920 × 1080 and 200 %
 * (960 × 540), real clicks.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { blockEl, blocks, centre, clickAt, notice, openApp, project, resetArrange, sceneTake, settle, teardownArrange, undoCount } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

async function openTakes() {
  const open = document.querySelector<HTMLElement>('[data-testid="takes-open"]');
  if (!open) return;
  open.scrollIntoView({ block: 'center' });
  await settle(30);
  await clickAt(centre(open));
  await settle(120);
}

describe('song blocks from a take', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: Make song blocks adds the take’s scenes after the song, selected, one Undo; the toast says what was rounded and left out`, async () => {
      await openApp(w, hh);
      // Intro for a pass, Groove for two, Lift for one and a half (rounded), plus a played note and a knob move.
      const id = sceneTake([
        [0, 4],
        [1, 8],
        [2, 6],
      ]);
      await settle(150);
      const plan = cmd.takeToBlocks(project(), id)!;
      expect(plan.blocks.length).toBe(3);
      expect(plan.rounded).toBe(true);
      const n = blocks().length;
      await openTakes();
      const make = document.querySelector<HTMLElement>('[data-testid="take-list"] [aria-label="Make song blocks from Take 1"]')!;
      expect(make).not.toBeNull();
      make.scrollIntoView({ block: 'center' });
      await settle(30);
      const undo = undoCount();
      await clickAt(centre(make));
      await settle(200);
      // Three blocks after the song, as planned (by scene and passes).
      expect(blocks().length).toBe(n + 3);
      expect(blocks().slice(n).map((b) => [b.sceneId, b.repeats])).toEqual(plan.blocks.map((t) => [t.sceneId, t.repeats]));
      expect(undoCount()).toBe(undo + 1);
      // The toast says it all.
      const text = notice()!.text;
      expect(text).toContain(`Made 3 song blocks from “Take 1” as blocks ${n + 1}–${n + 3}`);
      expect(text).toContain('rounded to whole passes');
      expect(text).toContain('1 note and 1 knob move are not carried over');
      // The lane selects them (and shows them).
      const made = blocks().slice(n).map((b) => b.id);
      for (const b of made) expect(blockEl(b).hasAttribute('data-selected')).toBe(true);
      // One Undo takes them all back.
      act(() => session.undo());
      expect(blocks().length).toBe(n);
    });
  }

  it('names a last launch too short to make a block: “Lift (5 beats) was too short to make a block and was left out”', async () => {
    await openApp(1366, 768);
    // Intro for a pass, Groove for two, then Lift for 5 beats only (under half its 4-bar pass).
    const id = sceneTake([
      [0, 4],
      [1, 8],
      [2, 1.25],
    ]);
    await settle(150);
    const n = blocks().length;
    await openTakes();
    const make = document.querySelector<HTMLElement>('[data-testid="take-list"] [aria-label="Make song blocks from Take 1"]')!;
    make.scrollIntoView({ block: 'center' });
    await clickAt(centre(make));
    await settle(200);
    // Two blocks (Intro, Groove); Lift is named as left out, with its length.
    expect(blocks().slice(n).map((b) => b.sceneId)).toEqual([project().scenes[0].id, project().scenes[1].id]);
    const text = notice()!.text;
    expect(text).toContain('Made 2 song blocks from “Take 1”');
    expect(text).toContain('Lift (5 beats) was too short to make a block and was left out');
    expect(cmd.takeToBlocks(project(), id)).not.toBeNull();
  });

  it('an empty song with takes offers “Make song blocks from” the newest take; the blocks become the song', async () => {
    await openApp(1366, 768);
    sceneTake([
      [3, 4],
      [1, 4],
    ], { name: 'Late take' });
    act(() => void cmd.removeBlocks(session.store, blocks().map((b) => b.id)));
    await settle(200);
    expect(blocks().length).toBe(0);
    const offer = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="song-lane"] button')].find((b) => b.textContent === 'Make song blocks from “Late take”')!;
    expect(offer).toBeDefined();
    // Add all scenes is still the first choice.
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-testid="song-lane"] button')].some((b) => b.textContent?.startsWith('Add all'))).toBe(true);
    await clickAt(centre(offer));
    await settle(200);
    expect(blocks().map((b) => b.sceneId)).toEqual([project().scenes[3].id, project().scenes[1].id]);
    expect(notice()!.text).toContain('Made 2 song blocks from “Late take” as the song');
  });
});
