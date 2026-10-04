/**
 * Where toasts land (the toast placement contract), against the production
 * build: toasts sit at the top centre just under the transport, at
 * --transport-h + 8 px, which the TransportBar writes on the page root and
 * keeps up to date as the strip wraps or grows. At 1024 x 768, 1366 x 768 and
 * 960 x 540 at 2x (200 % zoom of a 1920 x 1080 screen, where the strip has two
 * rows) a toast's top lands just below the strip's bottom; with a banner under
 * the strip (playback stopped, a project open in another tab) it lands just
 * below the banner, so it never hides the banner's keys; once the page has
 * scrolled the banner away (below 1024 px the strip stays at the top), just
 * below the strip again.
 */
import { expect, test, type Page } from '@playwright/test';
import { jumpIn, openFresh, pageErrors } from './helpers';

/** The toast card with these words, once its entrance has finished: its box and the bottoms of the strip and the banners. */
async function placed(page: Page, words: string): Promise<{ top: number; left: number; right: number; bar: number; banners: number; vw: number }> {
  const toast = page.getByRole('status').filter({ hasText: words });
  await expect(toast).toBeVisible();
  return toast.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
    const r = el.getBoundingClientRect();
    const bar = document.querySelector('header[aria-label="Transport"]')!.getBoundingClientRect().bottom;
    const banners = document.querySelector('[data-banners]')!.getBoundingClientRect().bottom;
    return { top: r.top, left: r.left, right: r.right, bar, banners, vw: document.documentElement.clientWidth };
  });
}

async function saveNow(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+s');
}

for (const s of [
  { width: 1024, height: 768, scale: 1 },
  { width: 1366, height: 768, scale: 1 },
  { width: 960, height: 540, scale: 2 },
]) {
  test.describe(`${s.width} x ${s.height} at ${s.scale}x`, () => {
    test.use({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale });

    test('a toast lands just under the transport, and under a banner when one shows', async ({ page }) => {
      await openFresh(page);
      await jumpIn(page);
      const skip = page.getByRole('button', { name: 'Skip guide' });
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();

      // No banner: just under the strip (8 px). (Sideways the toast slides clear of controls under its band: the toast's own business.)
      await saveNow(page);
      const a = await placed(page, 'Saved in this browser.');
      expect(a.banners).toBeCloseTo(a.bar, 0);
      expect(a.top - a.bar, `toast top ${a.top}, strip bottom ${a.bar}`).toBeGreaterThanOrEqual(0);
      expect(a.top - a.bar).toBeLessThanOrEqual(12);
      expect(a.left).toBeGreaterThanOrEqual(0);
      expect(a.right).toBeLessThanOrEqual(a.vw);
      await page.getByRole('status').filter({ hasText: 'Saved in this browser.' }).getByRole('button', { name: 'Dismiss' }).click().catch(() => undefined);

      // A banner under the strip (as when playback stopped in a background tab): the toast moves below it.
      await page.evaluate(() => {
        const rt = (window as any).__switchboard.runtime;
        rt.setState((st: any) => ({ ...st, stalled: 'Playback stopped because the tab was in the background or the audio device paused. Press Play to continue.' }));
      });
      await expect(page.getByRole('alert').filter({ hasText: 'Playback stopped' })).toBeVisible();
      await saveNow(page);
      const b = await placed(page, 'Saved in this browser.');
      expect(b.banners).toBeGreaterThan(b.bar + 20);
      expect(b.top - b.banners, `toast top ${b.top}, banner bottom ${b.banners}`).toBeGreaterThanOrEqual(0);
      expect(b.top - b.banners).toBeLessThanOrEqual(12);
      if (s.width < 1024) {
        // Below 1024 px the strip stays at the top while the page scrolls, and the banner scrolls away with the page:
        // the toast then sits just under the strip, not where the banner was.
        await page.getByRole('status').filter({ hasText: 'Saved in this browser.' }).getByRole('button', { name: 'Dismiss' }).click().catch(() => undefined);
        await page.evaluate(() => window.scrollTo(0, 400));
        await expect.poll(() => page.evaluate(() => document.querySelector('[data-banners]')!.getBoundingClientRect().bottom)).toBeLessThan(0);
        await saveNow(page);
        const c = await placed(page, 'Saved in this browser.');
        expect(c.top - c.bar, `scrolled: toast top ${c.top}, strip bottom ${c.bar}`).toBeGreaterThanOrEqual(0);
        expect(c.top - c.bar).toBeLessThanOrEqual(12);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.evaluate(() => {
        const rt = (window as any).__switchboard.runtime;
        rt.setState((st: any) => ({ ...st, stalled: null }));
      });
      expect(pageErrors(page)).toEqual([]);
    });
  });
}
