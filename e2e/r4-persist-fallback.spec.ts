/**
 * Two tabs in a browser without Web Locks: the BroadcastChannel heartbeat
 * fallback (adapted from the review's adv-fallback). The second tab is
 * read-only, the holder saves, Take over swaps them, a stale tab never
 * writes, nothing flaps over several heartbeats, and two tabs opening the
 * same project at once end with one writer.
 */
import { expect, test } from '@playwright/test';
import { bpm, jumpInStored, openFresh, pageErrors, readonly, sb, storedRec } from './r4-persist-helpers';

test.use({ serviceWorkers: 'block' });

test('without Web Locks: second tab read-only, holder saves, take over swaps, closing the holder lets Try again write', async ({ context, page: a }) => {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });
  });
  await openFresh(a);
  expect(await a.evaluate(() => (navigator as any).locks)).toBeUndefined();
  await jumpInStored(a);
  await sb(a, '(sb) => sb.session.setBpm(100)');
  await expect(a.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible();
  const { id, name } = await sb<{ id: string; name: string }>(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })');
  expect(await readonly(a)).toBeNull();

  const b = await context.newPage();
  await b.goto('/');
  await expect(b.getByRole('button', { name: `Continue “${name}”` })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => readonly(b)).toBe('other-tab');
  await sb(b, '(sb) => sb.session.setBpm(140)');
  await b.waitForTimeout(1500);
  expect((await storedRec(b, id))?.bpm).toBe(100);

  // Holder keeps saving.
  await sb(a, '(sb) => sb.session.setBpm(101)');
  await expect.poll(async () => (await storedRec(a, id))?.bpm).toBe(101);
  expect(await readonly(a)).toBeNull();

  // B takes over: A turns read-only; B is stale (A saved since B opened) so it refuses to write.
  await sb(b, '(sb) => sb.session.autosaver.takeOver()');
  await expect.poll(() => readonly(a)).toBe('other-tab');
  await expect.poll(() => readonly(b)).toBe('conflict');
  await b.waitForTimeout(1000);
  expect((await storedRec(b, id))?.bpm).toBe(101);

  // B opens the latest and saves.
  await sb(b, `(sb) => sb.session.openProject(${JSON.stringify(id)})`);
  await expect.poll(() => readonly(b)).toBeNull();
  await sb(b, '(sb) => sb.session.setBpm(128)');
  await expect.poll(async () => (await storedRec(b, id))?.bpm).toBe(128);
  // A's edits never land.
  await sb(a, '(sb) => sb.session.setBpm(90)');
  await a.waitForTimeout(2500);
  expect((await storedRec(a, id))?.bpm).toBe(128);

  // Heartbeat: after several seconds both stay as they are (no flapping).
  await b.waitForTimeout(5000);
  expect(await readonly(a)).toBe('other-tab');
  expect(await readonly(b)).toBeNull();

  // B closes; A presses Try again: A gets the project, but A is stale -> conflict (nothing written).
  await b.close();
  await sb(a, '(sb) => sb.session.autosaver.retry()');
  await a.waitForTimeout(1000);
  // A was based on an older copy, so it does not write over B's work.
  await expect.poll(() => readonly(a)).toBe('conflict');
  expect((await storedRec(a, id))?.bpm).toBe(128);

  // A third tab opening now (A holds the lock after retry) is read-only.
  const c = await context.newPage();
  await c.goto('/');
  await expect(c.getByRole('button', { name: `Continue “${name}”` })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => readonly(c)).toBe('other-tab');
  expect(await bpm(c)).toBe(128);
  expect(pageErrors(a)).toEqual([]);
});

test('without Web Locks: two tabs opening the same project at the same moment end with one writer', async ({ context, page: a }) => {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });
  });
  await openFresh(a);
  await jumpInStored(a);
  const { name } = await sb<{ id: string; name: string }>(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })');
  await a.close();
  const p1 = await context.newPage();
  const p2 = await context.newPage();
  await Promise.all([p1.goto('/'), p2.goto('/')]);
  await expect(p1.getByRole('button', { name: `Continue “${name}”` })).toBeVisible({ timeout: 30_000 });
  await expect(p2.getByRole('button', { name: `Continue “${name}”` })).toBeVisible({ timeout: 30_000 });
  await p1.waitForTimeout(3000);
  const r = [await readonly(p1), await readonly(p2)];
  expect(r.filter((x) => x === null)).toHaveLength(1);
  expect(r.filter((x) => x === 'other-tab')).toHaveLength(1);
});
