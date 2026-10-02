/**
 * PLAY-06: while a performance take records (the real Record Performance),
 * the Loops grid shows it is locked instead of looking editable:
 * - a pad dragged with the real mouse lifts with "Locked" and the refused
 *   icon, no pad lights as a target, and the drop changes nothing;
 * - the pad action bar becomes one coral line, "Locked while a performance
 *   records";
 * - Variation, Keep pattern and the new-clip choices are unavailable, each
 *   with the reason in its tooltip;
 * - pad taps and scene launches keep working (the take records them).
 * Stopping the take brings the action bar back.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { selectSlot, selectTrack } from '../../src/state/uiStore';
import { mouse, settleFrames } from './r4-uikit-input';
import { SIZES, button, clickEl, clipsOf, described, dragEl, grid, menu, openApp, pad, panel, project, setUp, tearDown, until } from './r4-play-helpers';

beforeEach(setUp);
afterEach(tearDown);

const LOCK = 'Locked while a performance records';

async function startTake(): Promise<void> {
  await act(async () => {
    await session.togglePerformance();
  });
  await until(() => runtimeStore.getState().recording === 'performance' && session.store.info.getState().lock !== null, 'the take to start');
}

describe('the grid while a performance take records (PLAY-06)', () => {
  for (const s of SIZES) {
    it(`at ${s.name}: the lift says Locked with no targets, the action bar is one coral line, editing keys say why; taps and scene launches still work`, async () => {
      await openApp(s.w, s.h, { play: true });
      // A Bass clip that is not playing (it will be dragged, and then tapped).
      const playing = runtimeStore.getState().tracks.t3?.playingSlot ?? null;
      const other = clipsOf('t3').findIndex((c, i) => !!c && i !== playing);
      const empty = clipsOf('t3').findIndex((c) => !c);
      expect(other).toBeGreaterThanOrEqual(0);
      act(() => {
        selectTrack('t3');
        selectSlot('t3', other);
      });
      await startTake();
      const before = project();

      // The action bar: one coral line instead of the keys.
      const bar = document.querySelector<HTMLElement>('[data-move-bar] [data-locked]')!;
      expect(bar).not.toBeNull();
      expect(bar.textContent).toContain(LOCK);
      expect(document.querySelector('[data-pad-actions]')).toBeNull();
      expect(button('Delete', bar)).toBeNull();
      // Coral, the attention colour: its words are --coral-ink.
      const probe = document.createElement('span');
      probe.style.color = 'var(--coral-ink)';
      document.body.append(probe);
      expect(getComputedStyle(bar.querySelector('p')!).color).toBe(getComputedStyle(probe).color);
      probe.remove();

      // Variation, its menu key and Keep pattern: off, with the reason.
      const variation = button('Variation', panel())!;
      expect(variation.disabled).toBe(true);
      expect(described(variation)).toContain(LOCK);
      expect(button('More Variation choices', panel())!.disabled).toBe(true);
      const keep = button('Keep pattern', panel())!;
      expect(keep.disabled).toBe(true);
      expect(described(keep)).toContain(LOCK);
      // Add scene too.
      expect(button('Add scene')?.disabled ?? true).toBe(true);

      // A drag: the lifted pad says Locked with the refused icon; no pad is a target.
      await dragEl(pad('t3', other), pad('t3', empty), { release: false });
      const lift = document.querySelector<HTMLElement>('[data-testid="pad-lift"]')!;
      expect(lift).not.toBeNull();
      expect(lift.textContent).toContain('Locked');
      expect(lift.dataset.kind).toBe('no');
      const refused = lift.querySelector<HTMLElement>('[data-for="no"]')!;
      expect(getComputedStyle(refused).display).not.toBe('none');
      expect(grid().querySelectorAll('[data-pad-cell][data-target], [data-pad-cell][data-drop="ok"], [data-pad-cell][data-drop="no"]').length).toBe(0);
      const target = pad('t3', empty).getBoundingClientRect();
      await mouse('mouseReleased', { x: target.left + target.width / 2, y: target.top + target.height / 2 });
      await settleFrames(3);
      expect(document.querySelector('[data-testid="pad-lift"]')).toBeNull();
      expect(project().tracks).toBe(before.tracks);

      // The empty pad's new-clip keys: off, with the reason.
      act(() => selectSlot('t3', empty));
      await clickEl(pad('t3', empty));
      const keys = [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
      expect(keys.length).toBe(5);
      for (const k of keys) {
        expect(k.getAttribute('aria-disabled')).toBe('true');
        expect(described(k)).toContain(LOCK);
      }
      await act(async () => {
        keys[0].click();
      });
      expect(clipsOf('t3')[empty]).toBeNull();
      await act(async () => {
        menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(menu()).toBeNull();

      // A tap still queues a clip, and a scene button still launches its row (the take records both).
      await clickEl(pad('t3', other));
      await until(() => {
        const t = runtimeStore.getState().tracks.t3;
        return t?.queued?.slot === other || t?.playingSlot === other;
      }, 'the tapped clip to queue');
      const row = 3;
      await clickEl(document.querySelector(`[data-scene-row="${row}"] button[data-scene]`));
      await until(() => {
        const t = runtimeStore.getState().tracks.t4;
        return t?.queued?.slot === row || t?.playingSlot === row;
      }, 'the scene to launch');
      expect(project().tracks).toBe(before.tracks);

      // Stopping the take: the action bar comes back.
      await act(async () => {
        await session.togglePerformance();
      });
      await until(() => session.store.info.getState().lock === null, 'the take to stop');
      await until(() => !!document.querySelector('[data-pad-actions]') || !!document.querySelector('[data-move-bar] [role="region"]'), 'the action bar');
      expect(button('Variation', panel())!.disabled).toBe(false);
    });
  }
});
