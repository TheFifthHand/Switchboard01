/**
 * The very first touch makes sound, and Play is never silent:
 *  - after "Just look around", the first computer key both starts audio and plays its note (measured
 *    from the key press: on a drum part A plays a short kit sound);
 *  - pressing Play with nothing armed arms the starter's groove instead of running silently;
 *  - a starter opened from the library plays when Play is pressed.
 */
import { expect, test } from '@playwright/test';
import { masterPeakFrom, masterPeakOver, openFresh, pageErrors } from './helpers';

test('the first key after "Just look around" starts audio and sounds', async ({ page }) => {
  await openFresh(page);
  await page.getByRole('button', { name: 'Just look around' }).click();
  expect(await page.evaluate(() => (window as any).__switchboard.audioState())).toBe('none');
  await page.locator('body').click({ position: { x: 700, y: 5 } }).catch(() => undefined);
  // Measured from the key press: with a drum part selected A plays a kit sound (the Closed Hat), which is short.
  const peak = masterPeakFrom(page, 1500);
  await page.keyboard.down('KeyA');
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.audioState()), { timeout: 5000 }).toBe('running');
  expect(await peak).toBeGreaterThan(0.005);
  await page.keyboard.up('KeyA');
  expect(pageErrors(page)).toEqual([]);
});

test('Play with nothing armed plays the groove, and a starter from the library plays', async ({ page }) => {
  await openFresh(page);
  await page.getByRole('button', { name: 'Just look around' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  await expect(page.getByRole('button', { name: /Playing\.( Selected\.)?$/ }).first()).toBeVisible({ timeout: 5000 });
  expect((await masterPeakOver(page, 1500)).rms).toBeGreaterThan(0.005);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  // Load another starter through the session (as the library does) and press Play.
  await page.evaluate(() => (window as any).__switchboard.session.newFromStarter('techno'));
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.project().starterId)).toBe('techno');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: /Playing\.( Selected\.)?$/ }).first()).toBeVisible({ timeout: 5000 });
  expect((await masterPeakOver(page, 1500)).rms).toBeGreaterThan(0.005);
  expect(pageErrors(page)).toEqual([]);
});
