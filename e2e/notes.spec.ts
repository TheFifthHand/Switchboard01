/**
 * Held notes never get stuck: they stop on key release, window blur, pointer
 * cancel, Stop and Mute All, also when the part, the octave or the
 * arpeggiator changes while a key is down.
 */
import { expect, test, type Page } from '@playwright/test';
import { jumpIn, openFresh, pageErrors } from './helpers';

const held = (page: Page, track = 't4') => page.evaluate((t) => ((window as any).__switchboard.runtime.getState().held[t] ?? []).length as number, track);
const liveVoices = (page: Page) => page.evaluate(() => (window as any).__switchboard.stats().engine.voices as number);

async function selectChords(page: Page) {
  await page.getByRole('button', { name: /^Select Chords/ }).click();
  await expect(page.getByRole('heading', { name: 'Chords' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  // Stop the groove so only our live notes sound.
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await selectChords(page);
  await page.locator('body').focus();
});

test('computer-key notes release on key up and on window blur', async ({ page }) => {
  await page.keyboard.down('KeyA');
  await page.keyboard.down('KeyD');
  await expect.poll(() => held(page)).toBe(2);
  await page.keyboard.up('KeyA');
  await expect.poll(() => held(page)).toBe(1);
  // Focus leaves the window while a key is down: everything is released.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => held(page)).toBe(0);
  await page.keyboard.up('KeyD');
  await expect.poll(() => liveVoices(page), { timeout: 5000 }).toBe(0);
  expect(pageErrors(page)).toEqual([]);
});

test('mouse notes release on pointer up and on pointer cancel', async ({ page }) => {
  const kb = page.getByRole('group', { name: /^Keyboard playing/ }).or(page.locator('[aria-label^="Keyboard playing"]')).first();
  const box = (await kb.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height - 10);
  await page.mouse.down();
  await expect.poll(() => held(page)).toBe(1);
  await page.mouse.up();
  await expect.poll(() => held(page)).toBe(0);

  // Pointer cancel (e.g. a touch interrupted by the system).
  await page.mouse.move(box.x + 60, box.y + box.height - 10);
  await page.mouse.down();
  await expect.poll(() => held(page)).toBe(1);
  await page.evaluate(() => {
    const el = document.querySelector('[aria-label^="Keyboard playing"]')!;
    const target = el.querySelector('[data-pressed="true"], [aria-pressed="true"]') ?? el;
    target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
    target.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
  });
  await expect.poll(() => held(page)).toBe(0);
  await page.mouse.up();
});

test('a key held while the part or the octave changes stops when it is let go', async ({ page }) => {
  await page.keyboard.down('KeyA');
  await expect.poll(() => held(page)).toBe(1);
  // Another part is chosen with the mouse while A is still down.
  await page.getByRole('button', { name: /^Select Bass/ }).click();
  await page.keyboard.up('KeyA');
  await expect.poll(() => held(page)).toBe(0);
  expect(await held(page, 't3')).toBe(0);

  // Now on Bass: the octave changes under a held key.
  await page.keyboard.down('KeyS');
  await expect.poll(() => held(page, 't3')).toBe(1);
  await page.getByRole('button', { name: 'Octave up (X)' }).click();
  await page.keyboard.up('KeyS');
  await expect.poll(() => held(page, 't3')).toBe(0);
  await expect.poll(() => liveVoices(page), { timeout: 5000 }).toBe(0);
  expect(pageErrors(page)).toEqual([]);
});

test('switching the arpeggiator on while a key is held does not leave the note sounding', async ({ page }) => {
  await page.keyboard.down('KeyA');
  await expect.poll(() => held(page)).toBe(1);
  await page.getByRole('switch', { name: 'Arp', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Arp', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.up('KeyA');
  await expect.poll(() => held(page)).toBe(0);
  await expect.poll(() => liveVoices(page), { timeout: 5000 }).toBe(0);
  expect(pageErrors(page)).toEqual([]);
});

test('Stop and Mute All silence held notes and effect tails', async ({ page }) => {
  await page.keyboard.down('KeyA');
  await expect.poll(() => held(page)).toBe(1);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => held(page)).toBe(0);
  await page.keyboard.up('KeyA');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.keyboard.down('KeyS');
  await expect.poll(() => held(page)).toBe(1);
  await page.getByRole('button', { name: 'Mute All' }).click();
  await expect(page.getByRole('button', { name: 'MUTED' })).toBeVisible();
  await expect.poll(() => held(page)).toBe(0);
  // Output is silent within a short time even though clips keep playing in time.
  await expect
    .poll(async () => {
      const m = await page.evaluate(() => (window as any).__switchboard.meters());
      return Math.max(m.masterPeakL, m.masterPeakR);
    }, { timeout: 3000 })
    .toBeLessThan(1e-4);
  await page.keyboard.up('KeyS');
  await page.getByRole('button', { name: 'MUTED' }).click();
  await expect(page.getByRole('button', { name: 'Mute All' })).toBeVisible();
  expect(pageErrors(page)).toEqual([]);
});
