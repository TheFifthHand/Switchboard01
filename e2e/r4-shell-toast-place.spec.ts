/**
 * Where toasts land (the toast placement contract, round 6), against the
 * production build: one place in every view, the bottom centre, on the
 * keyboard strip's upper half (the element marked [data-toast-floor]; with
 * none on screen, just above the window's bottom edge). There a toast covers
 * none of the working areas: not the transport, not the Loops action bar
 * (Edit steps, Duplicate, Move, Rename, Delete), not the Steps velocity lane,
 * and never the quick guide's card or the "Try this" chip (it goes above
 * them). A banner under the transport (playback stopped, a project open in
 * another tab) stays uncovered too. Checked at 1024 x 768, 1366 x 768 and
 * 960 x 540 at 2x (200 % zoom of a 1920 x 1080 screen, where the page
 * scrolls), also after the page has scrolled.
 */
import { expect, test, type Page } from '@playwright/test';
import { jumpIn, openFresh, pageErrors } from './helpers';

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Placement {
  toast: Box;
  vw: number;
  vh: number;
  /** The working areas and guidance on screen now, by name (only those with a size). */
  avoid: Record<string, Box[]>;
  /** The keyboard strip, when it is along the lower part of the window. */
  floor: Box | null;
}

/** The toast card with these words, once its entrance has finished, and the boxes it must stay clear of. */
async function placed(page: Page, words: string): Promise<Placement> {
  const toast = page.getByRole('status').filter({ hasText: words });
  await expect(toast).toBeVisible();
  // Placement runs again when guidance or the keyboard strip moves (checked every 400 ms): let it settle.
  await page.waitForTimeout(600);
  return toast.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
    const box = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const vh = document.documentElement.clientHeight;
    const all = (sel: string) =>
      [...document.querySelectorAll(sel)]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < vh)
        .map(box);
    const floors = all('[data-toast-floor]').filter((r) => r.top > vh * 0.4);
    return {
      toast: box(el.getBoundingClientRect()),
      vw: document.documentElement.clientWidth,
      vh,
      avoid: {
        transport: all('header[aria-label="Transport"]'),
        banner: all('[data-banners] [role="alert"]'),
        guidance: all('[data-toast-below][data-ready]'),
        'Loops action bar': all('[data-pad-actions]'),
        'velocity lane': all('[data-testid="velocity-lane"]'),
      },
      floor: floors[0] ?? null,
    };
  });
}

const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The toast is whole on screen, covers none of the working areas or guidance, and rests on the keyboard strip when that is on screen. */
function expectClear(p: Placement, where: string, want: string[] = []): void {
  const t = p.toast;
  const at = `${where}: toast ${Math.round(t.left)},${Math.round(t.top)}–${Math.round(t.right)},${Math.round(t.bottom)}`;
  expect(t.left, at).toBeGreaterThanOrEqual(0);
  expect(t.top, at).toBeGreaterThanOrEqual(0);
  expect(t.right, at).toBeLessThanOrEqual(p.vw + 0.5);
  expect(t.bottom, at).toBeLessThanOrEqual(p.vh + 0.5);
  expect(Math.abs((t.left + t.right) / 2 - p.vw / 2), `${at}: centred`).toBeLessThanOrEqual(4);
  for (const name of want) expect(p.avoid[name].length, `${where}: the ${name} is on screen`).toBeGreaterThan(0);
  for (const [name, boxes] of Object.entries(p.avoid)) {
    for (const b of boxes) expect(overlaps(t, b), `${at} covers the ${name} (${Math.round(b.left)},${Math.round(b.top)}–${Math.round(b.right)},${Math.round(b.bottom)})`).toBe(false);
  }
  // Moved above the guide or the hint chip: its own place.
  if (p.avoid.guidance.some((g) => g.left < t.right && g.right > t.left && t.bottom <= g.top)) return;
  if (p.floor) {
    // On the strip's upper half: its bottom edge reaches into the strip, and the keys' lower half stays free.
    expect(t.bottom, `${at} rests on the keyboard strip (top ${Math.round(p.floor.top)})`).toBeGreaterThan(p.floor.top);
    expect(t.bottom, `${at} leaves the keys' lower half free`).toBeLessThanOrEqual(p.floor.top + 56);
  } else {
    expect(p.vh - t.bottom, `${at}: just above the window's bottom edge`).toBeLessThanOrEqual(16);
  }
}

async function saveNow(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+s');
}

async function dismiss(page: Page, words: string): Promise<void> {
  const toast = page.getByRole('status').filter({ hasText: words });
  await toast.getByRole('button', { name: 'Dismiss' }).click().catch(() => undefined);
  await expect(toast).toHaveCount(0);
}

const SAVED = 'Saved in this browser.';

for (const s of [
  { width: 1024, height: 768, scale: 1 },
  { width: 1366, height: 768, scale: 1 },
  { width: 960, height: 540, scale: 2 },
]) {
  test.describe(`${s.width} x ${s.height} at ${s.scale}x`, () => {
    test.use({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale });

    test('a toast lands bottom centre on the keyboard strip, clear of the transport, guidance, banners and working areas', async ({ page }) => {
      await openFresh(page);
      await jumpIn(page);
      const skip = page.getByRole('button', { name: 'Skip guide' });
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();

      // Play › Loops: clear of the pads' action bar (and of the hint chip when it shows). At 960 x 540 the bar
      // is below the fold until the page scrolls to it.
      await page.locator('[data-pad-actions]').scrollIntoViewIfNeeded();
      await saveNow(page);
      expectClear(await placed(page, SAVED), 'Loops', ['transport', 'Loops action bar']);
      await dismiss(page, SAVED);
      await page.evaluate(() => window.scrollTo(0, 0));

      // Play › Steps: clear of the velocity lane.
      await page.getByRole('tab', { name: 'Steps', exact: true }).click();
      await page.getByTestId('velocity-lane').scrollIntoViewIfNeeded();
      await saveNow(page);
      expectClear(await placed(page, SAVED), 'Steps', ['velocity lane']);
      await dismiss(page, SAVED);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('tab', { name: 'Loops', exact: true }).click();

      // A banner under the transport (as when playback stopped in a background tab): the toast leaves it uncovered.
      await page.evaluate(() => {
        const rt = (window as any).__switchboard.runtime;
        rt.setState((st: any) => ({ ...st, stalled: 'Playback stopped because the tab was in the background or the audio device paused. Press Play to continue.' }));
      });
      await expect(page.getByRole('alert').filter({ hasText: 'Playback stopped' })).toBeVisible();
      await saveNow(page);
      expectClear(await placed(page, SAVED), 'with a banner', ['banner']);
      await dismiss(page, SAVED);

      // Scrolled to the bottom (at 960 x 540 the page scrolls; the transport stays at the top): still whole, still clear.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await saveNow(page);
      expectClear(await placed(page, SAVED), 'scrolled');
      await dismiss(page, SAVED);
      await page.evaluate(() => window.scrollTo(0, 0));

      await page.evaluate(() => {
        const rt = (window as any).__switchboard.runtime;
        rt.setState((st: any) => ({ ...st, stalled: null }));
      });
      expect(pageErrors(page)).toEqual([]);
    });
  });
}
