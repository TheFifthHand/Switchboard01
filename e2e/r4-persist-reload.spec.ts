/**
 * Edits made just before a reload, a closed tab or browser Back are kept
 * (shell-03): the page writes a rescue copy synchronously when it goes away,
 * and the next visit takes it back ("Recovered your last edits.").
 * Real input: the Tempo field is typed into and confirmed with Enter; Mute
 * is clicked.
 */
import { expect, test, type Page } from '@playwright/test';
import { openFresh, pageErrors } from './helpers';

/**
 * Jump In and wait until its starter is stored. These tests are about
 * storage, not sound: on a busy machine playback may stall, which changes
 * nothing here.
 */
async function jumpIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect
    .poll(() => page.evaluate(() => ((window as any).__switchboard.project().starterId === 'house' && !(window as any).__switchboard.session.isPreview) as boolean), { timeout: 15_000 })
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 10_000 });
}

/** Stop the Jump In groove (on a busy machine playback may have stopped by itself already). */
async function stopPlayback(page: Page): Promise<void> {
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  if (await stop.isEnabled()) await stop.click({ timeout: 5000 }).catch(() => undefined);
}

const bpm = (page: Page) => page.evaluate(() => (window as any).__switchboard.project().bpm as number);
const rescueSlot = (page: Page) => page.evaluate(() => localStorage.getItem('switchboard01.rescue'));

async function setTempo(page: Page, value: number): Promise<void> {
  await page.getByRole('spinbutton', { name: /Tempo/ }).first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await expect.poll(() => bpm(page)).toBe(value);
}

/** Jump In, stop, and wait until the starter is stored. Returns its name. */
async function startedSong(page: Page): Promise<string> {
  await openFresh(page);
  await jumpIn(page);
  await stopPlayback(page);
  await expect(page.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 5000 });
  return page.evaluate(() => (window as any).__switchboard.project().name as string);
}

for (const delay of [0, 100, 300]) {
  test(`a tempo edit is kept when the page reloads ${delay} ms after it`, async ({ page }) => {
    const name = await startedSong(page);
    const target = 101 + delay / 100;
    await setTempo(page, target);
    if (delay) await page.waitForTimeout(delay);
    await page.reload();
    await expect(page.getByRole('button', { name: `Continue “${name}”` })).toBeVisible();
    expect(await bpm(page)).toBe(target);
    // The edit is stored again, and the rescue copy is gone.
    expect(await rescueSlot(page)).toBeNull();
    await page.reload();
    await expect(page.getByRole('button', { name: `Continue “${name}”` })).toBeVisible();
    expect(await bpm(page)).toBe(target);
    expect(pageErrors(page)).toEqual([]);
  });
}

test('the Welcome card says the last edits were recovered', async ({ page }) => {
  const name = await startedSong(page);
  await setTempo(page, 104);
  await page.reload();
  const card = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: `Continue “${name}”` }) });
  await expect(card.getByText('Recovered your last edits.')).toBeVisible();
});

test('a mute is kept when the page reloads 100 ms after it', async ({ page }) => {
  const name = await startedSong(page);
  const mute = page.getByRole('button', { name: /^Mute Drums/ }).first();
  await mute.click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.project().tracks[0].mute)).toBe(true);
  await page.waitForTimeout(100);
  await page.reload();
  await expect(page.getByRole('button', { name: `Continue “${name}”` })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__switchboard.project().tracks[0].mute)).toBe(true);
});

test('an edit is kept when the tab is closed right after it, and after browser Back', async ({ context, page }) => {
  const name = await startedSong(page);
  await setTempo(page, 77);
  await page.close({ runBeforeUnload: true });
  const again = await context.newPage();
  await again.goto('/');
  await expect(again.getByRole('button', { name: `Continue “${name}”` })).toBeVisible();
  expect(await bpm(again)).toBe(77);

  await again.getByRole('button', { name: `Continue “${name}”` }).click();
  await setTempo(again, 88);
  await again.goto('about:blank');
  await again.goBack();
  // Back reloads the app (or restores it as it was): the edit is there either way.
  await again.waitForFunction(() => !!(window as any).__switchboard?.project);
  await expect.poll(() => bpm(again)).toBe(88);
});
