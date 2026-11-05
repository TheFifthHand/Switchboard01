/**
 * One tab per project (shell-01), two pages in one browser context: the
 * second page on the same project is read-only and writes nothing while the
 * first keeps saving; Take over swaps them; a stale tab never writes its old
 * copy over newer work. The stored copy is read straight from IndexedDB.
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

const sb = (page: Page, fn: string) => page.evaluate((src) => new Function('sb', `return (${src})(sb)`)((window as any).__switchboard), fn);
const readonly = (page: Page) => sb(page, '(sb) => sb.session.autosaver.status.getState().readonly');
const bpm = (page: Page) => page.evaluate(() => (window as any).__switchboard.project().bpm as number);

/** The project as stored in IndexedDB right now. */
function stored(page: Page, id: string): Promise<{ bpm: number; drumsMuted: boolean; updatedAt: number }> {
  return page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('switchboard01');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const get = db.transaction('projects').objectStore('projects').get(id);
          get.onsuccess = () => {
            const rec = get.result;
            db.close();
            resolve({ bpm: rec.data.bpm, drumsMuted: rec.data.tracks[0].mute, updatedAt: rec.updatedAt });
          };
          get.onerror = () => reject(get.error);
        };
      }),
    id,
  );
}

async function setTempo(page: Page, value: number): Promise<void> {
  await page.getByRole('spinbutton', { name: /Tempo/ }).first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await expect.poll(() => bpm(page)).toBe(value);
}

test('the second tab is read-only and writes nothing; the first keeps saving; Take over swaps them; the stale tab never overwrites', async ({ context, page: a }) => {
  await openFresh(a);
  await jumpIn(a);
  await stopPlayback(a);
  await setTempo(a, 100);
  await expect(a.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 5000 });
  const { id, name } = (await sb(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })')) as { id: string; name: string };
  expect(await readonly(a)).toBeNull();

  // Tab B opens the same project.
  const b = await context.newPage();
  await b.goto('/');
  await b.getByRole('button', { name: `Continue “${name}”` }).click();
  await expect.poll(() => readonly(b)).toBe('other-tab');
  await setTempo(b, 140);
  // B says it does not save, and nothing it does reaches storage.
  await expect(b.getByRole('button', { name: 'Autosave: Not saved' })).toBeVisible({ timeout: 5000 });
  expect(await sb(b, '(sb) => sb.session.autosaver.status.getState().lastError.message')).toContain('open in another tab');
  await b.waitForTimeout(1500);
  expect(await stored(b, id)).toMatchObject({ bpm: 100, drumsMuted: false });

  // A keeps saving.
  await a.bringToFront();
  await a.getByRole('button', { name: /^Mute Drums/ }).first().click();
  await expect.poll(async () => (await stored(a, id)).drumsMuted, { timeout: 5000 }).toBe(true);
  expect((await stored(a, id)).bpm).toBe(100);
  expect(await readonly(a)).toBeNull();

  // B takes over. A saved after B opened the project, so B refuses to write its stale copy over that.
  await b.bringToFront();
  await sb(b, '(sb) => sb.session.autosaver.takeOver()');
  await expect.poll(() => readonly(b)).toBe('conflict');
  await expect.poll(() => readonly(a)).toBe('other-tab');
  await b.waitForTimeout(1000);
  expect(await stored(b, id)).toMatchObject({ bpm: 100, drumsMuted: true });

  // A lost the project: its edits are not written any more.
  await a.bringToFront();
  await setTempo(a, 90);
  await a.waitForTimeout(1500);
  expect((await stored(a, id)).bpm).toBe(100);
  await expect(a.getByRole('button', { name: 'Autosave: Not saved' })).toBeVisible();

  // B opens the latest and saves from there.
  await b.bringToFront();
  await sb(b, `(sb) => sb.session.openProject(${JSON.stringify(id)})`);
  await expect.poll(() => readonly(b)).toBeNull();
  expect(await bpm(b)).toBe(100);
  await setTempo(b, 128);
  await expect.poll(async () => (await stored(b, id)).bpm, { timeout: 5000 }).toBe(128);
  expect((await stored(b, id)).drumsMuted).toBe(true);

  // A third tab reopens what B saved, and is read-only while B has it.
  const c = await context.newPage();
  await c.goto('/');
  await c.getByRole('button', { name: `Continue “${name}”` }).click();
  expect(await bpm(c)).toBe(128);
  await expect.poll(() => readonly(c)).toBe('other-tab');
  expect(pageErrors(a)).toEqual([]);
});

test('a second tab that takes over before the first saved anything new writes its edits', async ({ context, page: a }) => {
  await openFresh(a);
  await jumpIn(a);
  await stopPlayback(a);
  await expect(a.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 5000 });
  const { id, name } = (await sb(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })')) as { id: string; name: string };

  const b = await context.newPage();
  await b.goto('/');
  await b.getByRole('button', { name: `Continue “${name}”` }).click();
  await expect.poll(() => readonly(b)).toBe('other-tab');
  await setTempo(b, 133);
  await sb(b, '(sb) => sb.session.autosaver.takeOver()');
  await expect.poll(async () => (await stored(b, id)).bpm, { timeout: 5000 }).toBe(133);
  expect(await readonly(b)).toBeNull();
  await expect.poll(() => readonly(a)).toBe('other-tab');
  await expect(b.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible();
});
