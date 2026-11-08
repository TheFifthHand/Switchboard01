/**
 * Omni Song 2.0 against the production build: the app's new name where
 * people see it (title, Welcome card, the installable app's manifest) while
 * the offline worker keeps its address, so earlier installs update in place;
 * and the next-step tips after Jump In, which follow what you actually do and
 * stay hidden once hidden: in Simple the tip line under the song, in Advanced
 * the "Try this" chip, which never covers the transport or the pads.
 */
import { expect, test } from '@playwright/test';
import { jumpIn, openFresh, pageErrors, startNewGroove } from './helpers';

test('it is called Omni Song: page title, Welcome card and app manifest; the offline worker keeps its address', async ({ page, request }) => {
  await openFresh(page);
  await expect(page).toHaveTitle('Omni Song');
  await expect(page.getByRole('dialog', { name: 'Omni Song' })).toBeVisible();
  await expect(page.getByText('Start with a beat. Make it yours.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeFocused();

  const manifest = await (await request.get('manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ name: 'Omni Song', short_name: 'Omni Song', start_url: './', scope: './' });
  // No explicit id: an app installed as SWITCHBOARD / 01 keeps its identity (start_url) and updates in place.
  expect(manifest.id).toBeUndefined();
  expect((await request.get('sw.js')).ok()).toBe(true);
  expect(pageErrors(page)).toEqual([]);
});

test('Advanced: after Jump In, "Try this" hints suggest one thing at a time, follow what you do, and stay hidden once hidden', async ({ page }) => {
  await openFresh(page, { mode: 'advanced' });
  await jumpIn(page);
  // The quick guide comes first.
  await page.getByRole('button', { name: 'Skip guide' }).click();

  const hint = page.getByRole('complementary', { name: /^Try this/ });
  await expect(hint).toContainText('Tap a pad in the Bass column.');
  await expect(hint).toHaveAccessibleName('Try this, hint 1 of 7');
  // It sits clear of the transport and the pads.
  const box = (await hint.boundingBox())!;
  const transport = (await page.locator('header[aria-label="Transport"]').boundingBox())!;
  const pads = (await page.locator('#pad-surface').boundingBox())!;
  const apart = (a: typeof box, b: typeof box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  expect(apart(box, transport)).toBe(true);
  expect(apart(box, pads)).toBe(true);

  // Tap a Bass pad: it queues for the next bar, and the hint moves on.
  await page.getByRole('button', { name: /^Bass, Lift: / }).click();
  await expect(hint).toContainText('Press Mute on Drums.');
  await page.getByRole('button', { name: 'Mute Drums', exact: true }).click();
  await expect(hint).toContainText('The Drums part is muted. Press Mute again to bring it back.');
  await page.getByRole('button', { name: 'Mute Drums', exact: true }).click();
  await expect(hint).toContainText('Drag a loop onto another pad.');

  // Hidden is remembered: not even a new groove brings it back. (Pressed with the keyboard: right
  // after the chip changes, mouse clicks on it are ignored for a moment so a double-click elsewhere
  // cannot hide it by accident; keys always work.)
  await hint.getByRole('button', { name: 'Hide hints' }).press('Enter');
  await expect(hint).toBeHidden();
  await page.reload();
  // Coming back: Continue is the main key; Start a new groove is the second.
  await expect(page.getByRole('button', { name: /^Continue “/ })).toBeFocused();
  await startNewGroove(page);
  await page.waitForTimeout(600);
  await expect(page.getByRole('complementary', { name: /^Try this/ })).toHaveCount(0);
  expect(pageErrors(page)).toEqual([]);
});

test('Simple: after Jump In, the tip line says one next step, follows what you do, and stays hidden once hidden', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  // No quick guide and no floating chip in Simple: one plain line under the song.
  await expect(page.getByRole('button', { name: 'Skip guide' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: /^Try this/ })).toHaveCount(0);
  const tip = page.locator('[role="status"]', { hasText: 'Next:' });
  // Jump In repeats the starter's main part: the first tip says how to hear the whole song.
  await expect(tip).toContainText('To hear your whole song, press ⟳ Repeating: Groove');
  // It sits clear of the top bar and the song.
  const box = (await tip.boundingBox())!;
  const bar = (await page.locator('header[aria-label="Transport"]').boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);

  // Do it: the repeat stops, the whole song plays on, and the tip moves on to something new.
  await page.getByRole('button', { name: 'Repeating: Groove' }).click();
  await expect(page.getByRole('button', { name: /^Repeat this section: |^Repeat the whole song$/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(tip).not.toContainText('To hear your whole song');
  await expect(tip).toContainText('Next:');

  // Hidden is remembered: not even a new groove brings it back.
  await page.getByRole('button', { name: 'Hide tips' }).click();
  await expect(tip).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Continue “/ })).toBeFocused();
  await startNewGroove(page);
  await page.waitForTimeout(600);
  await expect(page.locator('[role="status"]', { hasText: 'Next:' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hide tips' })).toHaveCount(0);
  expect(pageErrors(page)).toEqual([]);
});
