/**
 * Coming back (shell-02, shell-12), against the production build:
 * - the Welcome card's focused main key is Continue “<name>”; Start a new
 *   groove is the secondary key, and says which project it took the place of
 *   (with Open it, which brings that one back as it was);
 * - the tab's title names the open project;
 * - after an update, What's new is offered once; Help → About shows the
 *   version from package.json.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { jumpIn, openFresh, pageErrors, startNewGroove } from './helpers';

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

test('Continue is the main key; Start a new groove says what it replaced, and Open it brings that back', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  const skip = page.getByRole('button', { name: 'Skip guide' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click().catch(() => undefined);
  const tempo = page.getByRole('spinbutton', { name: /Tempo/ }).first();
  await tempo.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('100');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 10_000 });
  const name = await page.evaluate(() => (window as any).__switchboard.project().name as string);
  await expect(page).toHaveTitle(`${name} — Omni Song`);

  await page.reload();
  const cont = page.getByRole('button', { name: `Continue “${name}”` });
  await expect(cont).toBeFocused();
  await expect(cont).toHaveAttribute('data-variant', 'primary');
  await expect(page.getByRole('button', { name: 'Start a new groove' })).toHaveAttribute('data-variant', 'secondary');
  await expect(page.getByRole('button', { name: 'Jump In' })).toHaveCount(0);

  await startNewGroove(page);
  const fresh = await page.evaluate(() => (window as any).__switchboard.project().name as string);
  expect(fresh).toBe(`${name} 2`);
  const toast = page.getByRole('status').filter({ hasText: 'Started a new' });
  await expect(toast).toContainText(`Started a new ${fresh}. Your earlier “${name}” is in My projects.`);
  await expect(page).toHaveTitle(`▶ ${fresh} — Omni Song`);
  await toast.getByRole('button', { name: 'Open it' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.project().name as string)).toBe(name);
  expect(await page.evaluate(() => (window as any).__switchboard.project().bpm)).toBe(100);
  await expect(page).toHaveTitle(`${name} — Omni Song`);
  expect(pageErrors(page)).toEqual([]);
});

test('after an update What’s new is offered once; Help → About shows the version', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  const skip = page.getByRole('button', { name: 'Skip guide' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 10_000 });
  // The first run recorded this version.
  expect(await page.evaluate(() => localStorage.getItem('switchboard01.seenVersion'))).toBe(version);
  // As if an older version had been used last.
  await page.evaluate(() => localStorage.setItem('switchboard01.seenVersion', '2.0.0'));
  await page.reload();
  await page.getByRole('button', { name: /^Continue “/ }).click();
  const toast = page.getByRole('status').filter({ hasText: `Omni Song is updated to version ${version}.` });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'What’s new' }).click();
  const help = page.getByRole('dialog', { name: 'Help' });
  await expect(help).toBeVisible();
  await expect(help.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true');
  await expect(help.getByTestId('app-version')).toHaveText(`version ${version}`);
  await expect(help).toContainText(`What’s new in ${version}`);
  await page.keyboard.press('Escape');
  // Once: the next visit does not offer it again.
  await page.reload();
  await page.getByRole('button', { name: /^Continue “/ }).click();
  await page.waitForTimeout(800);
  await expect(page.getByRole('status').filter({ hasText: 'Omni Song is updated' })).toHaveCount(0);
  // ? opens Help at any time.
  await page.locator('main').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByRole('dialog', { name: 'Help' })).toBeVisible();
  expect(pageErrors(page)).toEqual([]);
});
