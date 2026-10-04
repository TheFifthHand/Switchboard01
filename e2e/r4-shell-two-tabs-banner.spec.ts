/**
 * One project in two tabs (shell-01), against the production build: the tab
 * that does not save the project says so in a banner ("This project is open
 * in another tab. Changes here are not saved.") with Take over and Open a
 * copy; after the other tab saved newer work, the banner says that instead,
 * with Open the latest. Every key does what it says, read back from
 * IndexedDB.
 */
import { expect, test, type Page } from '@playwright/test';
import { openFresh, pageErrors } from './helpers';

/** Jump In and wait until its starter is stored (this is about storage, not sound). */
async function jumpIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect
    .poll(() => page.evaluate(() => ((window as any).__switchboard.project().starterId === 'house' && !(window as any).__switchboard.session.isPreview) as boolean), { timeout: 15_000 })
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 10_000 });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  if (await stop.isEnabled()) await stop.click({ timeout: 5000 }).catch(() => undefined);
  // The quick guide is about Play / Pause, the pads and the sound, not this: skip it.
  const skip = page.getByRole('button', { name: 'Skip guide' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

const sb = (page: Page, fn: string) => page.evaluate((src) => new Function('sb', `return (${src})(sb)`)((window as any).__switchboard), fn);
const readonly = (page: Page) => sb(page, '(sb) => sb.session.autosaver.status.getState().readonly');
const banner = (page: Page) => page.locator('[data-readonly]');

async function setTempo(page: Page, value: number): Promise<void> {
  await page.getByRole('spinbutton', { name: /Tempo/ }).first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.project().bpm as number)).toBe(value);
}

/** Every stored project's name and tempo. */
function storedProjects(page: Page): Promise<{ id: string; name: string; bpm: number }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('switchboard01');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('projects').objectStore('projects').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result.map((r: any) => ({ id: r.id, name: r.data.name, bpm: r.data.bpm })));
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

test('the tab that does not save says so; Take over and Open a copy do what they say; a stale tab offers Open the latest', async ({ context, page: a }) => {
  await openFresh(a);
  await jumpIn(a);
  const { id, name } = (await sb(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })')) as { id: string; name: string };
  await expect(banner(a)).toHaveCount(0);

  // Tab B opens the same project: the banner, with its two keys.
  const b = await context.newPage();
  await b.goto('/');
  await b.getByRole('button', { name: `Continue “${name}”` }).click();
  await expect.poll(() => readonly(b)).toBe('other-tab');
  await expect(banner(b)).toContainText('This project is open in another tab. Changes here are not saved.');
  await expect(banner(b).getByRole('button', { name: 'Take over' })).toBeVisible();
  await expect(banner(b).getByRole('button', { name: 'Open a copy' })).toBeVisible();

  // Take over: B saves from now on, A says it does not.
  await banner(b).getByRole('button', { name: 'Take over' }).click();
  await expect.poll(() => readonly(b)).toBeNull();
  await expect(banner(b)).toHaveCount(0);
  await a.bringToFront();
  await expect.poll(() => readonly(a)).toBe('other-tab');
  await expect(banner(a)).toContainText('This project is open in another tab.');
  await b.bringToFront();
  await setTempo(b, 140);
  await expect.poll(async () => (await storedProjects(b)).find((p) => p.id === id)?.bpm, { timeout: 5000 }).toBe(140);

  // A presses Take over too, but B saved newer work meanwhile: A never writes over it and says so.
  await a.bringToFront();
  await banner(a).getByRole('button', { name: 'Take over' }).click();
  await expect.poll(() => readonly(a)).toBe('conflict');
  await expect(banner(a)).toContainText('This project was changed in another tab after this tab opened it. Changes here are not saved.');
  await expect(banner(a).getByRole('button', { name: 'Open the latest' })).toBeVisible();
  expect((await storedProjects(a)).find((p) => p.id === id)?.bpm).toBe(140);

  // Open a copy keeps what A shows as a new project that A saves.
  await setTempo(a, 95);
  await banner(a).getByRole('button', { name: 'Open a copy' }).click();
  await expect.poll(() => readonly(a)).toBeNull();
  await expect(banner(a)).toHaveCount(0);
  const copy = (await sb(a, '(sb) => ({ id: sb.project().id, name: sb.project().name, bpm: sb.project().bpm })')) as { id: string; name: string; bpm: number };
  expect(copy.id).not.toBe(id);
  expect(copy.name).toBe(`${name} copy`);
  expect(copy.bpm).toBe(95);
  await expect.poll(async () => (await storedProjects(a)).find((p) => p.id === copy.id)?.bpm, { timeout: 5000 }).toBe(95);
  // The original is as B saved it.
  expect((await storedProjects(a)).find((p) => p.id === id)?.bpm).toBe(140);
  expect(pageErrors(a)).toEqual([]);
  expect(pageErrors(b)).toEqual([]);
});

test('Open the latest loads what the other tab saved, and this tab saves again', async ({ context, page: a }) => {
  await openFresh(a);
  await jumpIn(a);
  const { id, name } = (await sb(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })')) as { id: string; name: string };
  const b = await context.newPage();
  await b.goto('/');
  await b.getByRole('button', { name: `Continue “${name}”` }).click();
  await expect.poll(() => readonly(b)).toBe('other-tab');
  // A saves newer work after B opened it; B then takes over and finds it stale.
  await a.bringToFront();
  await setTempo(a, 101);
  await expect.poll(async () => (await storedProjects(a)).find((p) => p.id === id)?.bpm, { timeout: 5000 }).toBe(101);
  await b.bringToFront();
  await banner(b).getByRole('button', { name: 'Take over' }).click();
  await expect.poll(() => readonly(b)).toBe('conflict');
  await banner(b).getByRole('button', { name: 'Open the latest' }).click();
  await expect.poll(() => readonly(b)).toBeNull();
  await expect(banner(b)).toHaveCount(0);
  expect(await b.evaluate(() => (window as any).__switchboard.project().bpm)).toBe(101);
});
