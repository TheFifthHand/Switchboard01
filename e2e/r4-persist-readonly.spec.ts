/**
 * A tab that does not hold a project never writes it through the Project
 * library (review regression, adapted from adv-lock-bypass and
 * adv-delete-other): in the read-only tab Rename is refused, Duplicate copies
 * what that tab shows, Replace it (Starters) leaves the project alone, Open
 * asks before dropping its unsaved changes; from another tab, Rename and
 * Delete of a project open elsewhere are refused. The holder keeps saving
 * throughout. Real clicks and keys in the library.
 */
import { expect, test, type Page } from '@playwright/test';
import { allStored, bpm, continueIn, jumpInStored, openFresh, openLibrary, pageErrors, readonly, sb, storedRec, trashIds } from './r4-persist-helpers';

test.use({ serviceWorkers: 'block' });

/** Tab A has a stored House Starter at 100 BPM; tab B continues it (read-only) and sets 140. */
async function twoTabs(a: Page, b: Page): Promise<{ id: string; name: string }> {
  await openFresh(a);
  await jumpInStored(a);
  await sb(a, '(sb) => sb.session.setBpm(100)');
  const song = await sb<{ id: string; name: string }>(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })');
  await expect.poll(async () => (await storedRec(a, song.id))?.bpm).toBe(100);
  await continueIn(b, song.name);
  await expect.poll(() => readonly(b)).toBe('other-tab');
  await sb(b, '(sb) => sb.session.setBpm(140)');
  await expect(b.getByRole('button', { name: 'Autosave: Not saved' })).toBeVisible();
  return song;
}

/** The holder still saves. */
async function holderSaves(a: Page, id: string, value: number): Promise<void> {
  await a.bringToFront();
  await sb(a, `(sb) => sb.session.setBpm(${value})`);
  await expect.poll(async () => (await storedRec(a, id))?.bpm, { timeout: 10_000 }).toBe(value);
  expect(await readonly(a)).toBeNull();
}

test('read-only tab: Rename is refused, Duplicate copies what it shows, Replace it leaves the project alone', async ({ context, page: a }) => {
  const b = await context.newPage();
  const song = await twoTabs(a, b);
  await openLibrary(b);
  const lib = b.getByRole('dialog', { name: 'Project library' });
  await lib.getByRole('tab', { name: 'My projects' }).click();

  // Rename: refused, with a plain message; nothing changes here or in storage.
  await lib.getByRole('button', { name: `Rename ${song.name}`, exact: true }).click();
  const field = lib.getByRole('textbox').first();
  await field.fill('Renamed in B');
  await field.press('Enter');
  await expect(lib.getByText(`“${song.name}” is open in another tab, so it can't be renamed here. Rename it in that tab.`)).toBeVisible();
  expect((await storedRec(b, song.id))?.name).toBe(song.name);
  expect(await sb(b, '(sb) => sb.project().name')).toBe(song.name);

  // Duplicate: a copy of what this tab shows (140 BPM); the project itself stays as A saved it.
  await lib.getByRole('button', { name: 'Cancel' }).click().catch(() => undefined);
  await lib.getByRole('button', { name: `Duplicate ${song.name}`, exact: true }).click();
  await expect(lib.getByText(`Made a copy: “${song.name} copy”.`)).toBeVisible();
  const copy = (await allStored(b)).find((p) => p.name === `${song.name} copy`);
  expect(copy?.bpm).toBe(140);
  expect((await storedRec(b, song.id))?.bpm).toBe(100);

  // Replace it (Starters asks first, since this tab's changes are not saved): the project is not written.
  await lib.getByRole('tab', { name: 'Starters' }).click();
  await lib.getByRole('button', { name: /^Start Techno/ }).click();
  await lib.getByRole('group', { name: 'Start Techno?' }).getByRole('button', { name: 'Replace it' }).click();
  await expect.poll(() => sb(b, '(sb) => sb.project().starterId'), { timeout: 15_000 }).toBe('techno');
  await b.waitForTimeout(1000);
  expect((await storedRec(b, song.id))?.bpm).toBe(100);
  expect((await allStored(b)).some((p) => p.name === 'Techno Starter')).toBe(true);
  expect(await readonly(b)).toBeNull();

  await holderSaves(a, song.id, 95);
  expect(pageErrors(a)).toEqual([]);
  expect(pageErrors(b)).toEqual([]);
});

test('read-only tab: opening another project asks first, and can keep the changes as a copy', async ({ context, page: a }) => {
  const b = await context.newPage();
  // Another stored project to open.
  await openFresh(a);
  await jumpInStored(a);
  const other = await sb<{ id: string; name: string }>(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })');
  await sb(a, '(sb) => sb.session.newFromStarter("garage")');
  await expect.poll(() => sb(a, '(sb) => sb.project().starterId')).toBe('garage');
  await sb(a, '(sb) => sb.session.setBpm(100)');
  const song = await sb<{ id: string; name: string }>(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })');
  await expect.poll(async () => (await storedRec(a, song.id))?.bpm).toBe(100);

  await continueIn(b, song.name);
  await expect.poll(() => readonly(b)).toBe('other-tab');
  await sb(b, '(sb) => sb.session.setBpm(141)');
  await openLibrary(b);
  const lib = b.getByRole('dialog', { name: 'Project library' });
  await lib.getByRole('tab', { name: 'My projects' }).click();

  await lib.getByRole('button', { name: `Open ${other.name}`, exact: true }).click();
  const ask = lib.getByRole('group', { name: `Open ${other.name}?` });
  await expect(ask).toContainText('are not saved, because it is open in another tab');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(await sb(b, '(sb) => sb.project().id')).toBe(song.id);
  expect(await bpm(b)).toBe(141);

  await lib.getByRole('button', { name: `Open ${other.name}`, exact: true }).click();
  await lib.getByRole('group', { name: `Open ${other.name}?` }).getByRole('button', { name: 'Keep them as a copy and open' }).click();
  await expect.poll(() => sb(b, '(sb) => sb.project().id'), { timeout: 15_000 }).toBe(other.id);
  const kept = (await allStored(b)).find((p) => p.name === `${song.name} copy`);
  expect(kept?.bpm).toBe(141);
  expect((await storedRec(b, song.id))?.bpm).toBe(100);
  await holderSaves(a, song.id, 96);
});

test('another tab cannot rename or delete a project open elsewhere; the holder keeps saving', async ({ context, page: a }) => {
  await openFresh(a);
  await jumpInStored(a);
  const song = await sb<{ id: string; name: string }>(a, '(sb) => ({ id: sb.project().id, name: sb.project().name })');
  const b = await context.newPage();
  await b.goto('/');
  await expect(b.getByRole('button', { name: `Continue “${song.name}”` })).toBeVisible({ timeout: 30_000 });
  // B moves on to its own project, then tries A's from My projects.
  await jumpInStored(b);
  expect(await readonly(b)).toBeNull();
  await openLibrary(b);
  const lib = b.getByRole('dialog', { name: 'Project library' });
  await lib.getByRole('tab', { name: 'My projects' }).click();

  await lib.getByRole('button', { name: `Rename ${song.name}`, exact: true }).click();
  const field = lib.getByRole('textbox').first();
  await field.fill('Renamed from B');
  await field.press('Enter');
  await expect(lib.getByText(`“${song.name}” is open in another tab. Rename it there, or close that tab first.`)).toBeVisible();
  expect((await storedRec(b, song.id))?.name).toBe(song.name);
  await lib.getByRole('button', { name: 'Cancel' }).click();

  await lib.getByRole('button', { name: `Delete ${song.name}`, exact: true }).click();
  await lib.getByRole('group', { name: `Delete ${song.name}?` }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(lib.getByText(`“${song.name}” is open in another tab. Close it there first, then delete it here.`)).toBeVisible();
  expect(await storedRec(b, song.id)).not.toBeNull();
  expect(await trashIds(b)).toEqual([]);

  await holderSaves(a, song.id, 97);
  expect((await storedRec(a, song.id))?.name).toBe(song.name);
  expect(await trashIds(a)).toEqual([]);
});
