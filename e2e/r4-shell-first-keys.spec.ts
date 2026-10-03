/**
 * The keyboard-only first minute (review M3), against the production build:
 * Enter on Jump In starts the groove and gives focus to the quick guide's
 * Next; its first step says "Pause it here or with the Space bar", and Space
 * does exactly that (it does not press Next). Enter then presses Next.
 */
import { expect, test } from '@playwright/test';
import { openFresh, pageErrors } from './helpers';

const playing = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing as boolean);

test('Enter on Jump In, then Space pauses the music as the guide says; Enter moves the guide on', async ({ page }) => {
  await openFresh(page);
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => playing(page), { timeout: 20_000 }).toBe(true);
  const next = page.locator('[data-guide-next]');
  await expect(next).toBeFocused();
  const step = page.locator('[data-guide-step]');
  await expect(step).toHaveAttribute('data-guide-step', 'play');
  await expect(step).toContainText('Space bar');

  await page.keyboard.press('Space');
  await expect.poll(() => playing(page)).toBe(false);
  // Still on the first step: Space did not press Next.
  await expect(step).toHaveAttribute('data-guide-step', 'play');
  await page.keyboard.press('Space');
  await expect.poll(() => playing(page)).toBe(true);

  // Enter presses Next.
  await page.keyboard.press('Enter');
  await expect(step).toHaveAttribute('data-guide-step', 'pads');
  expect(pageErrors(page)).toEqual([]);
});
