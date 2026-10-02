/**
 * The ruler with a finger (touch-ruler): a swipe along the bar numbers
 * scrolls the lane (touch-action pan-x), as on the blocks; a finger that rests
 * there for 200 ms takes the ruler, and dragging then sets a loop, with the
 * toast "Loop on: Lift to Lift (blocks 3–5)" and its Stop looping action.
 * Real touch input (CDP Input.dispatchTouchEvent with touch emulation), the
 * running app at 1366 × 768, 1920 × 1080 and 200 % (960 × 540).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { RULER_HOLD_MS } from '../../src/app/views/arrange/LaneRuler';
import { blockEl, blockIds, byLabel, centre, clickAt, openApp, resetArrange, rt, scroller, settle, teardownArrange, type Pt } from './r4-arrange-helpers';
import { touch } from './r4-uikit-input';

beforeEach(async () => {
  await resetArrange();
  await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
});
afterEach(async () => {
  await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await teardownArrange();
});

const ruler = () => document.querySelector<HTMLElement>('[data-testid="song-ruler"]')!;

function loopToast(): { text: string; stop: HTMLButtonElement | null } | null {
  const el = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((x) => x.closest('[aria-live]') && /Loop on/.test(x.textContent ?? '') && x.querySelector('button[aria-label="Dismiss"]'));
  if (!el) return null;
  return { text: el.textContent ?? '', stop: [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Stop looping') ?? null };
}

/** A finger along the ruler from `a` to `b`: resting `restMs` first, then moving in `steps` moves a frame apart. */
async function finger(a: Pt, b: Pt, restMs: number, steps = 12) {
  await touch('touchStart', [a]);
  if (restMs) await settle(restMs);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / steps, y: a.y }]);
    await new Promise((r) => requestAnimationFrame(r));
  }
  await touch('touchEnd', []);
  await settle(150);
}

describe('the ruler with a finger', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: a swipe scrolls the lane and sets nothing; a 200 ms rest, then a drag, sets a loop with a Stop looping toast`, async () => {
      await openApp(w, hh);
      const ids = blockIds();
      ruler().scrollIntoView({ block: 'center' });
      await settle(60);
      const sc = scroller();
      // Zoomed in, so there is somewhere to scroll.
      if (sc.scrollWidth <= sc.clientWidth + 300) {
        await clickAt(centre(byLabel('Zoom in')));
        await clickAt(centre(byLabel('Zoom in')));
        await settle(300);
      }
      sc.scrollLeft = 0;
      await settle(80);
      const r = ruler().getBoundingClientRect();
      const y = r.top + r.height / 2;
      const view = sc.getBoundingClientRect();
      // A quick swipe to the left: the lane scrolls on; no loop, nothing plays.
      await finger({ x: view.right - 40, y }, { x: view.right - 340, y }, 0);
      await settle(300);
      expect(sc.scrollLeft).toBeGreaterThan(150);
      expect(rt().songLoop).toBeNull();
      expect(rt().playing).toBe(false);
      // Back to the start, then a rest on Lift (block 3) and a drag to the second Lift (block 5).
      sc.scrollLeft = 0;
      await settle(120);
      // Block 3 near the lane's left edge, so blocks 3 to 5 are in view.
      sc.scrollLeft = Math.max(0, blockEl(ids[2]).getBoundingClientRect().left - view.left - 20);
      await settle(120);
      const from = { x: blockEl(ids[2]).getBoundingClientRect().left + 16, y };
      const toEl = blockEl(ids[4]).getBoundingClientRect();
      expect(toEl.left + 24).toBeLessThan(view.right - 30);
      const to = { x: toEl.left + 24, y };
      const scrolled = sc.scrollLeft;
      await touch('touchStart', [from]);
      await settle(RULER_HOLD_MS + 80);
      expect(ruler().hasAttribute('data-holding')).toBe(true);
      for (let i = 1; i <= 12; i++) {
        await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / 12, y }]);
        await new Promise((res) => requestAnimationFrame(res));
      }
      // The finger owns the ruler: the lane did not pan under it (beyond its own edge scrolling).
      expect(Math.abs(sc.scrollLeft - scrolled)).toBeLessThanOrEqual(1);
      await touch('touchEnd', []);
      await settle(150);
      const loop = rt().songLoop;
      expect(loop?.fromBlockId).toBe(ids[2]);
      expect(loop?.toBlockId).toBe(ids[4]);
      const t = loopToast();
      expect(t?.text).toContain('Loop on: Lift to Lift (blocks 3–5)');
      expect(t?.stop).not.toBeNull();
      expect(ruler().hasAttribute('data-holding')).toBe(false);
      // Its Stop looping, with a finger tap.
      const s = centre(t!.stop!);
      await touch('touchStart', [s]);
      await touch('touchEnd', []);
      await settle(150);
      expect(rt().songLoop).toBeNull();
    });
  }
});
