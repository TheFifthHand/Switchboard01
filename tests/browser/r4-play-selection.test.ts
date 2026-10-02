/**
 * PLAY-01, one selected clip, in the running app with real input: after Jump
 * In, pressing "Select Lead" (Lead is not playing and has no clip in the
 * playing row) rings Lead's first clip, Bell Hook, and every control acts on
 * that same clip: the pad action bar, the part's ▶, Variation, Steps and
 * Record Notes. The rule holds through a scene inserted above (the ring
 * follows the clip) and for a part that is playing (it gets its playing clip).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { insertScene } from '../../src/state/commands';
import { slotFor, uiStore } from '../../src/state/uiStore';
import { SIZES, button, clickEl, clipsOf, noticesDuring, openApp, pad, panel, setUp, tearDown, until } from './r4-play-helpers';

beforeEach(setUp);
afterEach(tearDown);

describe('one selected clip (PLAY-01)', () => {
  for (const s of SIZES) {
    it(`at ${s.name}: after Jump In, Select Lead rings Bell Hook and ▶, the action bar, Variation, Record Notes and Steps all act on it`, async () => {
      await openApp(s.w, s.h, { play: true });
      const bell = clipsOf('t5').findIndex((c) => c?.name === 'Bell Hook');
      expect(bell).toBeGreaterThan(0);
      // Lead is not in the playing row: nothing is chosen for it yet.
      expect(uiStore.getState().selectedSlot.t5).toBeUndefined();
      expect(clipsOf('t5')[0]).toBeNull();

      await clickEl(button(/^Select Lead/));
      expect(uiStore.getState().selectedTrackId).toBe('t5');
      expect(uiStore.getState().selectedSlot.t5).toBe(bell);

      // The ring and the action bar.
      const ringed = [...document.querySelectorAll<HTMLButtonElement>('[data-pad-cell] button[data-selected]')];
      expect(ringed.map((b) => b.id)).toEqual([`pad-t5-${bell}`]);
      expect(pad('t5', bell).getAttribute('aria-label')).toMatch(/^Lead, .*: Bell Hook, .*Selected\.$/);
      const bar = document.querySelector<HTMLElement>('[data-pad-actions]')!;
      expect(bar.textContent).toContain('Bell Hook');
      expect(bar.textContent).toContain('Lead');

      // The part's ▶ names (and would start) the same clip.
      expect(button('Play Lead: Bell Hook')).not.toBeNull();

      // Variation changes Bell Hook, nothing else.
      const before = clipsOf('t5').map((c) => c?.notes ?? null);
      const said = await noticesDuring(() => clickEl(button('Variation', panel())));
      expect(said.some((t) => /^Variation on Lead · Bell Hook: /.test(t)), said.join(' | ')).toBe(true);
      const after = clipsOf('t5').map((c) => c?.notes ?? null);
      after.forEach((n, i) => {
        if (i === bell) expect(n).not.toBe(before[i]);
        else expect(n).toBe(before[i]);
      });

      // Record Notes records into Bell Hook (no new "Take" clip in an empty pad).
      const filled = clipsOf('t5').filter(Boolean).length;
      await act(async () => {
        await session.toggleRecordNotes();
      });
      expect(runtimeStore.getState().recordTarget).toEqual({ trackId: 't5', slot: bell });
      await act(async () => {
        await session.toggleRecordNotes();
      });
      expect(clipsOf('t5').filter(Boolean).length).toBe(filled);

      // Steps opens Bell Hook and leaves the selection where it was.
      const steps = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Steps')!;
      await clickEl(steps);
      await until(() => !!document.querySelector('input[aria-label="Clip name"]'), 'the Steps editor');
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Clip name"]')!.value).toBe('Bell Hook');
      expect(slotFor(uiStore.getState(), 't5')).toBe(bell);
    });
  }

  it('the ring follows its clip when a scene is inserted above it, and a playing part is given its playing clip', async () => {
    await openApp(1366, 768, { play: true });
    const bell = clipsOf('t5').findIndex((c) => c?.name === 'Bell Hook');
    await clickEl(button(/^Select Lead/));
    act(() => void insertScene(session.store, 0));
    await until(() => clipsOf('t5')[bell + 1]?.name === 'Bell Hook', 'the rows to move down');
    expect(uiStore.getState().selectedSlot.t5).toBe(bell + 1);
    expect(pad('t5', bell + 1).hasAttribute('data-selected')).toBe(true);
    expect(button('Play Lead: Bell Hook')).not.toBeNull();

    // Bass plays; with its choice cleared, selecting it again gives it the clip it plays.
    const playing = runtimeStore.getState().tracks.t3?.playingSlot;
    expect(playing).not.toBeNull();
    act(() =>
      uiStore.setState((st) => {
        const { t3: _gone, ...rest } = st.selectedSlot;
        return { ...st, selectedSlot: rest, selectedTrackId: 't5' };
      }),
    );
    await clickEl(button(/^Select Bass/));
    expect(uiStore.getState().selectedSlot.t3).toBe(playing);
    expect(pad('t3', playing!).hasAttribute('data-selected')).toBe(true);
  });
});
