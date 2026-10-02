/**
 * A toast never covers a block's menu (toast-covers-block-menu): with a
 * toast on screen (an edit's "Drums off in Groove" with its Undo), the block
 * menu opened from ⋯ is wholly usable: the point under "Remove from song" is
 * that menu item. (The Popover marks body[data-popover-open] while a menu is
 * open and the toasts move up under the transport: the UI kit's contract.)
 * Real clicks, the running app at 1366 × 768, 1920 × 1080 and 200 %.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockEl, blockIds, cellEl, centre, clickAt, menuItem, notice, openApp, openBlockMenu, press, resetArrange, settle, teardownArrange, trackId } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const toastCard = () => [...document.querySelectorAll<HTMLElement>('[aria-live] [role="status"]')].find((x) => x.querySelector('button[aria-label="Dismiss"]'));

describe('a toast and the block menu', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: after a toast, every item of the ⋯ menu is the element under its own centre`, async () => {
      await openApp(w, hh);
      const ids = blockIds();
      // An edit with a toast (and its Undo).
      blockEl(ids[1]).scrollIntoView({ block: 'center', inline: 'nearest' });
      await settle(60);
      await clickAt(centre(cellEl(ids[1], trackId('Drums'))));
      await settle(100);
      expect(notice()?.text).toBe('Drums off in Groove');
      expect(toastCard()).toBeDefined();
      // The menu of the block below the toast's usual place.
      for (const i of [2, 4]) {
        blockEl(ids[i]).scrollIntoView({ block: 'center', inline: 'nearest' });
        await settle(60);
        await openBlockMenu(ids[i]);
        const remove = menuItem('Remove from song');
        const c = centre(remove);
        expect(c.y).toBeLessThan(window.innerHeight);
        const hit = document.elementFromPoint(c.x, c.y);
        expect(hit && remove.contains(hit), `block ${i + 1}: the point under “Remove from song” is ${hit?.className}`).toBe(true);
        for (const item of document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')) {
          const r = item.getBoundingClientRect();
          if (r.bottom > window.innerHeight || r.height === 0) continue;
          const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          expect(h && item.contains(h), `“${item.textContent}” under ${h?.className}`).toBe(true);
        }
        // The toast is still there (moved out of the way, not dropped).
        expect(toastCard()).toBeDefined();
        await press('Escape');
        await settle(60);
      }
    });
  }
});
