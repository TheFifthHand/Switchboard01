/**
 * Helpers for the r4-persist e2e specs (two pages of one browser context;
 * the stored copy is read straight from IndexedDB).
 */
import { expect, type Page } from '@playwright/test';

export const sb = <T = unknown>(page: Page, fn: string): Promise<T> =>
  page.evaluate((src) => new Function('sb', `return (${src})(sb)`)((window as any).__switchboard), fn) as Promise<T>;
export const readonly = (page: Page) => sb<string | null>(page, '(sb) => sb.session.autosaver.status.getState().readonly');
export const bpm = (page: Page) => page.evaluate(() => (window as any).__switchboard.project().bpm as number);

export async function openFresh(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as Page & { __errors?: string[] }).__errors = errors;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeVisible({ timeout: 30_000 });
}

export const pageErrors = (page: Page): string[] => (page as Page & { __errors?: string[] }).__errors ?? [];

/** Jump In and wait until the starter is stored (these tests are about storage, not sound). */
export async function jumpInStored(page: Page): Promise<void> {
  const before = await page.evaluate(() => (window as any).__switchboard.project().id as string);
  // A first visit says Jump In; a returning one (a project is stored) says Start a new groove.
  await page.getByRole('button', { name: /^(Jump In|Start a new groove)$/ }).click();
  await expect
    .poll(() => page.evaluate((b) => (window as any).__switchboard.project().id !== b && !(window as any).__switchboard.session.isPreview, before), { timeout: 30_000 })
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 15_000 });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  if (await stop.isEnabled().catch(() => false)) await stop.click({ timeout: 5000 }).catch(() => undefined);
}

/** A second page of the same context opens the app and continues the last project. */
export async function continueIn(page: Page, name: string): Promise<void> {
  await page.goto('/');
  const cont = page.getByRole('button', { name: `Continue “${name}”` });
  await expect(cont).toBeVisible({ timeout: 30_000 });
  await cont.click();
}

/** Open the Project library from the More menu. */
export async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^More:/ }).click();
  await page.getByRole('menuitem', { name: /Projects…/ }).click();
  await expect(page.getByRole('dialog', { name: 'Project library' })).toBeVisible();
}

function idb<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    ({ body, arg }) =>
      new Promise<unknown>((resolve, reject) => {
        const req = indexedDB.open('switchboard01');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const fn = new Function('db', 'arg', 'resolve', 'reject', body);
          fn(
            db,
            arg,
            (v: unknown) => {
              db.close();
              resolve(v);
            },
            (e: unknown) => {
              db.close();
              reject(e);
            },
          );
        };
      }),
    { body, arg },
  ) as Promise<T>;
}

export function storedRec(page: Page, id: string): Promise<{ name: string; bpm: number; updatedAt: number } | null> {
  return idb(
    page,
    `const g = db.transaction('projects').objectStore('projects').get(arg);
     g.onsuccess = () => resolve(g.result ? { name: g.result.name, bpm: g.result.data.bpm, updatedAt: g.result.updatedAt } : null);
     g.onerror = () => reject(g.error);`,
    id,
  );
}

export function allStored(page: Page): Promise<{ id: string; name: string; bpm: number }[]> {
  return idb(
    page,
    `const g = db.transaction('projects').objectStore('projects').getAll();
     g.onsuccess = () => resolve(g.result.map((r) => ({ id: r.id, name: r.name, bpm: r.data.bpm })));
     g.onerror = () => reject(g.error);`,
  );
}

export function trashIds(page: Page): Promise<string[]> {
  return idb(page, `const g = db.transaction('trash').objectStore('trash').getAllKeys(); g.onsuccess = () => resolve(g.result); g.onerror = () => reject(g.error);`);
}
