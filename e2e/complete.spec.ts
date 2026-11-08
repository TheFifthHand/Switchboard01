/**
 * The brief's definition of done (PRODUCT_BRIEF.md §12), through the real UI
 * of the production build: a beginner plays a starter, changes a sound,
 * creates a Variation (and undoes it), explores a working cable connection
 * that changes what is heard, then reopens the same editable project after a
 * reload. (Recording and WAV export are covered by journey.spec.ts.)
 *
 * Simple: the same, on the song screen (the Sound panel's Change sound…, the
 * editor's Make it different). Advanced (2.4's part panel and Variation,
 * plus the cable drawer, which is Advanced only).
 */
import { expect, test, type Page } from '@playwright/test';
import { jumpIn, masterPeakOver, openFresh, pageErrors } from './helpers';

const bassNotes = (page: Page) =>
  page.evaluate(() => {
    const p = (window as any).__switchboard.project();
    const t = p.tracks.find((x: any) => x.id === 't3');
    return JSON.stringify(t.clips.map((c: any) => c && c.notes.map((n: any) => [n.tick, n.pitch, n.duration, n.velocity])));
  });

test('Advanced: play a starter, change a sound, Variation, a real cable edit, then reopen the edited project', async ({ page }) => {
  await openFresh(page, { mode: 'advanced' });
  await jumpIn(page);
  const skip = page.getByRole('button', { name: /Skip/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  // Select the Bass part (its Groove clip is playing) and hear only it.
  await page.getByRole('button', { name: /^Select Bass/ }).click();
  await expect(page.getByRole('heading', { name: 'Bass' })).toBeVisible();
  await page.getByRole('button', { name: 'Solo Bass' }).click();
  const soloed = await masterPeakOver(page, 1500);
  expect(soloed.rms).toBeGreaterThan(0.005);

  // Change its sound from the part panel.
  const soundBefore = await page.evaluate(() => JSON.stringify((window as any).__switchboard.project().tracks.find((t: any) => t.id === 't3').instrument));
  await page.getByRole('button', { name: /^Change instrument/ }).click();
  const browser = page.getByRole('dialog');
  await expect(browser).toBeVisible();
  const options = browser.getByRole('option');
  const current = await browser.getByRole('option', { selected: true }).first().textContent().catch(() => null);
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const text = await options.nth(i).textContent();
    if (text !== current) {
      await options.nth(i).click();
      break;
    }
  }
  await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).__switchboard.project().tracks.find((t: any) => t.id === 't3').instrument))).not.toBe(soundBefore);
  await page.keyboard.press('Escape');
  await expect(browser).toBeHidden();

  // Variation changes the playing pattern; undo brings it back; a second one is kept.
  const original = await bassNotes(page);
  await page.getByRole('button', { name: 'Variation', exact: true }).click();
  await expect.poll(() => bassNotes(page)).not.toBe(original);
  await expect(page.getByText(/^Variation on Bass/)).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press('Control+z');
  await expect.poll(() => bassNotes(page)).toBe(original);
  await page.getByRole('button', { name: 'Variation', exact: true }).click();
  await expect.poll(() => bassNotes(page)).not.toBe(original);
  const varied = await bassNotes(page);

  // Open the cable drawer (an Advanced control) and unplug the instrument's audio output with the keyboard picker.
  await page.getByRole('region', { name: 'Cables drawer' }).getByRole('button', { expanded: false }).click();
  const cables = page.getByRole('region', { name: /^Cables for Bass/ });
  await expect(cables).toBeVisible();
  const instOut = cables.getByRole('button', { name: /audio output, to / }).first();
  await instOut.focus();
  await page.keyboard.press('Enter');
  const disconnect = page.getByRole('button', { name: /^Disconnect / }).first();
  await expect(disconnect).toBeVisible();
  await disconnect.click();
  await expect(cables.getByText('This part has no path to the output.', { exact: true })).toBeVisible();
  // The real audio graph changed: the soloed part is no longer heard.
  await page.waitForTimeout(400);
  const cut = await masterPeakOver(page, 1200);
  expect(cut.rms).toBeLessThan(soloed.rms * 0.05);

  // Restore Connection puts it back and the part is heard again.
  await cables.getByRole('button', { name: 'Restore Connection' }).click();
  await expect(cables.getByText('This part has no path to the output.', { exact: true })).toBeHidden();
  await page.waitForTimeout(300);
  const back = await masterPeakOver(page, 1500);
  expect(back.rms).toBeGreaterThan(soloed.rms * 0.3);

  // Reopen: the project comes back as it was left, and stays editable.
  await page.getByRole('button', { name: 'Solo Bass' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 5000 });
  const name = await page.evaluate(() => (window as any).__switchboard.project().name);
  const sound = await page.evaluate(() => JSON.stringify((window as any).__switchboard.project().tracks.find((t: any) => t.id === 't3').instrument));
  await page.reload();
  await page.getByRole('button', { name: `Continue “${name}”` }).click();
  expect(await bassNotes(page)).toBe(varied);
  expect(await page.evaluate(() => JSON.stringify((window as any).__switchboard.project().tracks.find((t: any) => t.id === 't3').instrument))).toBe(sound);
  await page.getByRole('button', { name: /^Bass, Groove: / }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  await page.getByRole('button', { name: 'Variation', exact: true }).click();
  await expect.poll(() => bassNotes(page)).not.toBe(varied);
  expect(pageErrors(page)).toEqual([]);
});

/** Every loop of Bass, on the pads and in the song. */
const bassLoops = (page: Page) =>
  page.evaluate(() => {
    const t = (window as any).__switchboard.project().tracks.find((x: any) => x.id === 't3');
    return JSON.stringify([...t.clips, ...(t.songClips ?? [])].map((c: any) => c && c.notes.map((n: any) => [n.tick, n.pitch, n.duration, n.velocity])));
  });
const bassSound = (page: Page) => page.evaluate(() => JSON.stringify((window as any).__switchboard.project().tracks.find((t: any) => t.id === 't3').instrument));

test('Simple: play a starter, change a sound, Make it different (and Undo), then reopen the edited project', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);

  // Bass, heard alone (Solo on its row).
  await page.getByRole('button', { name: 'Solo Bass', exact: true }).click();
  const soloed = await masterPeakOver(page, 1500);
  expect(soloed.rms).toBeGreaterThan(0.005);

  // Its name opens its Sound panel; Change sound… is the Sound browser.
  await page.getByRole('button', { name: 'Bass (Bass): open its sound' }).click();
  const before = await bassSound(page);
  await page.getByRole('button', { name: /^Change sound/ }).click();
  const browser = page.getByRole('dialog');
  await expect(browser).toBeVisible();
  const current = await browser.getByRole('option', { selected: true }).first().textContent().catch(() => null);
  const options = browser.getByRole('option');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    if ((await options.nth(i).textContent()) !== current) {
      await options.nth(i).click();
      break;
    }
  }
  await expect.poll(() => bassSound(page)).not.toBe(before);
  await page.keyboard.press('Escape');
  await expect(browser).toBeHidden();
  // The new sound is heard.
  expect((await masterPeakOver(page, 1500)).rms).toBeGreaterThan(0.003);

  // A single click on a Bass loop opens the editor; Make it different changes its notes; Undo brings them back.
  await page.getByRole('group', { name: /^Bass( \(solo\))?: \d+ loops?$/ }).getByRole('button').first().click();
  const editor = page.getByRole('region', { name: /^Editor: / });
  await expect(editor).toBeVisible();
  const original = await bassLoops(page);
  await editor.getByRole('button', { name: 'Make it different' }).click();
  await expect.poll(() => bassLoops(page)).not.toBe(original);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect.poll(() => bassLoops(page)).toBe(original);
  await editor.getByRole('button', { name: 'Make it different' }).click();
  await expect.poll(() => bassLoops(page)).not.toBe(original);
  const varied = await bassLoops(page);
  const sound = await bassSound(page);

  // Reopen: the project comes back as it was left, and stays editable.
  await page.getByRole('button', { name: 'Solo Bass', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Project: .*\. Saved$/ })).toBeVisible({ timeout: 5000 });
  const name = await page.evaluate(() => (window as any).__switchboard.project().name);
  await page.reload();
  await page.getByRole('button', { name: `Continue “${name}”` }).click();
  expect(await bassLoops(page)).toBe(varied);
  expect(await bassSound(page)).toBe(sound);
  await expect(page.getByRole('heading', { name: 'Your song', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  expect((await masterPeakOver(page, 1500)).rms).toBeGreaterThan(0.005);
  expect(pageErrors(page)).toEqual([]);
});
