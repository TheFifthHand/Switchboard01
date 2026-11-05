/**
 * PLAY-16 and PLAY-13 with real input: Variation is a split key. Its main
 * press makes a subtle variation of the selected clip's original notes (kept
 * for the session), so eight presses in a row stay near the original instead
 * of piling up; its menu has Subtle, Bold and Back to original, which brings
 * the original notes back in one step. An edit made some other way makes the
 * clip's new notes the original. "Keep pattern" (pressed: "Pattern kept")
 * stops Variation, and says so.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import type { Note } from '../../src/project/types';
import { toggleStep } from '../../src/state/commands';
import { selectSlot, selectTrack } from '../../src/state/uiStore';
import { SIZES, button, clickEl, clipsOf, described, item, menu, noticesDuring, openApp, panel, setUp, tearDown } from './r4-play-helpers';

beforeEach(setUp);
afterEach(tearDown);

const sig = (notes: readonly Note[]) =>
  notes
    .map((n) => `${n.tick}/${n.pitch}/${n.duration}/${n.velocity}`)
    .sort()
    .join(' ');

describe('Variation as a split key (PLAY-16)', () => {
  for (const s of SIZES) {
    it(`at ${s.name}: eight Subtle presses stay within ±30% of the original; Bold and Back to original from its menu`, async () => {
      await openApp(s.w, s.h);
      const slot = clipsOf('t1').findIndex((c) => c?.name === 'Four Floor');
      act(() => {
        selectTrack('t1');
        selectSlot('t1', slot);
      });
      const original = clipsOf('t1')[slot]!.notes;
      const n = original.length;
      const seen = new Set<string>([sig(original)]);
      for (let i = 0; i < 8; i++) {
        const said = await noticesDuring(() => clickEl(button('Variation', panel())));
        expect(said.some((t) => /^Variation on Drums · Four Floor: /.test(t)), said.join(' | ')).toBe(true);
        const now = clipsOf('t1')[slot]!.notes;
        expect(now.length, `press ${i + 1}`).toBeGreaterThanOrEqual(Math.ceil(n * 0.7));
        expect(now.length, `press ${i + 1}`).toBeLessThanOrEqual(Math.floor(n * 1.3));
        seen.add(sig(now));
      }
      // The presses explore: several different variations, not one repeated.
      expect(seen.size).toBeGreaterThan(3);
      expect(clipsOf('t1')[slot]!.variation?.generation).toBe(8);

      // Bold, from the menu.
      await clickEl(button('More Variation choices', panel()));
      expect(menu()?.textContent).toContain('Vary Four Floor');
      const bold = await noticesDuring(() => clickEl(item('Bold variation')));
      expect(bold.some((t) => /^Bold variation on Drums · Four Floor: /.test(t)), bold.join(' | ')).toBe(true);
      expect(clipsOf('t1')[slot]!.notes.length).toBeLessThanOrEqual(Math.floor(n * 1.3));

      // Back to original: the original notes, in one step.
      await clickEl(button('More Variation choices', panel()));
      await clickEl(item('Back to original'));
      expect(sig(clipsOf('t1')[slot]!.notes)).toBe(sig(original));
      expect(clipsOf('t1')[slot]!.variation).toBeUndefined();
      expect(session.store.undoLabel()).toBe('Back to original');
      // Now it is the original: Back to original has nothing to do.
      await clickEl(button('More Variation choices', panel()));
      expect(item('Back to original').getAttribute('aria-disabled')).toBe('true');
      expect(item('Back to original').textContent).toContain('Already the original');
      act(() => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    });
  }

  it('an edit made some other way becomes the original; Keep pattern stops Variation and says why', async () => {
    await openApp(1366, 768);
    const slot = clipsOf('t3').findIndex((c) => !!c && c.notes.length > 4);
    act(() => {
      selectTrack('t3');
      selectSlot('t3', slot);
    });
    await clickEl(button('Variation', panel()));
    // A step painted by hand (as Steps does): that is the clip's original from now on.
    act(() => void toggleStep(session.store, 't3', slot, 15, 40));
    const edited = sig(clipsOf('t3')[slot]!.notes);
    await clickEl(button('More Variation choices', panel()));
    expect(item('Back to original').getAttribute('aria-disabled')).toBe('true');
    await clickEl(item('Subtle variation'));
    await clickEl(button('More Variation choices', panel()));
    await clickEl(item('Back to original'));
    expect(sig(clipsOf('t3')[slot]!.notes)).toBe(edited);

    // Keep pattern: Variation stops, and its tooltip says why; the key reads "Pattern kept".
    await clickEl(button('Keep pattern', panel()));
    expect(clipsOf('t3') && session.store.getState().tracks[2].locked).toBe(true);
    const kept = button('Pattern kept', panel())!;
    expect(kept.getAttribute('aria-pressed')).toBe('true');
    const variation = button('Variation', panel())!;
    expect(variation.disabled).toBe(true);
    expect(described(variation)).toContain('keeps its pattern');
    await clickEl(kept);
    expect(session.store.getState().tracks[2].locked).toBe(false);
    expect(button('Variation', panel())!.disabled).toBe(false);
  });
});
