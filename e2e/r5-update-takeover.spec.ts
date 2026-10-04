/**
 * A new download always opens the new version (2.3). Against two real builds
 * served by the real launcher (launcher/serve.mjs) at one address:
 *  - build A: this build (dist/);
 *  - build B: a copy of it as the next version would be: its page names
 *    version 9.9.9 (the omni-song-version meta and the Welcome card's
 *    "Version" line), its main script has a new name and sw.js lists the new
 *    files, so the browser sees a new service worker, exactly as after a
 *    rebuild with a new version number.
 * The old launcher window is closed and the new one started (the new one
 * waits for the old one first), then the browser opens the address again, as
 * double-clicking "Start Omni Song.bat" does. Checked:
 *  - pages not in use switch to the new version by themselves;
 *  - a page in use (a key pressed in it) is never reloaded: it offers Update
 *    in the ⋯ menu, and so does any page still showing the old version;
 *  - with the new version waiting, a refresh opens it once nothing is in use;
 *  - pages of 2.2.0 (the real release, which cannot answer) are reloaded into
 *    the new version by its service worker;
 *  - how a page answers "omni:busy?".
 */
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { openFresh, pageErrors } from './helpers';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(ROOT, process.env.E2E_DIST ?? 'dist');
const SERVE = join(ROOT, 'launcher', 'serve.mjs');
/** The 2.2.0 release (npm run package at 2.2.0), when this machine has it. */
const RELEASE_22 = join(ROOT, 'release', 'omni-song-2.2.0.zip');
const NEXT = '9.9.9';

let work = '';
let buildA = '';
let buildB = '';
let versionA = '';
const launchers: ChildProcess[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'omni-takeover-'));
  buildA = join(work, 'a');
  buildB = join(work, 'b');
  cpSync(DIST, buildA, { recursive: true });
  versionA = /<meta name="omni-song-version" content="([^"]+)">/.exec(readFileSync(join(buildA, 'index.html'), 'utf8'))![1];
  nextBuild(buildA, buildB);
});

test.afterEach(async () => {
  await Promise.all(launchers.splice(0).map(stop));
});

test.afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** Copy build `from` to `to` as the next version (9.9.9) would be built. */
function nextBuild(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
  const indexPath = join(to, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  const main = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(html)![1];
  const renamed = main.replace(/\.js$/, '-next.js');
  const js = readFileSync(join(to, main), 'utf8');
  const nextJs = js.split(`\`${versionA}\``).join(`\`${NEXT}\``).split(`"${versionA}"`).join(`"${NEXT}"`);
  expect(nextJs).not.toBe(js);
  writeFileSync(join(to, renamed), nextJs);
  unlinkSync(join(to, main));
  html = html.replace(`content="${versionA}"`, `content="${NEXT}"`).replace(main, renamed);
  writeFileSync(indexPath, html);
  const swPath = join(to, 'sw.js');
  const sw = readFileSync(swPath, 'utf8');
  const nextSw = sw
    .replace(`url:"${main}"`, `url:"${renamed}"`)
    .replace(/(url:"index\.html",revision:")[0-9a-f]+"/, `$1${createHash('md5').update(html).digest('hex')}"`);
  expect(nextSw).toContain(renamed);
  expect(nextSw).not.toBe(sw.replace(`url:"${main}"`, `url:"${renamed}"`));
  writeFileSync(swPath, nextSw);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}

async function freePort(): Promise<number> {
  for (let p = 4390; p < 4400; p++) if (await isFree(p)) return p;
  throw new Error('No free port in 4390-4399');
}

interface Launcher {
  child: ChildProcess;
  out(): string;
}

/** Start the launcher for `dir` at `port`, as the .bat does (without opening a browser). */
function launch(dir: string, port: number): Launcher {
  const child = spawn(process.execPath, [SERVE, dir, '--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  launchers.push(child);
  let out = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (out += d));
  return { child, out: () => out };
}

async function until(l: Launcher, re: RegExp, ms = 10_000): Promise<void> {
  await expect.poll(() => re.test(l.out()), { timeout: ms, message: `launcher output: ${l.out()}` }).toBe(true);
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once('exit', () => done());
    child.kill();
  });
}

/** The old launcher window is closed and the new one started: the new one waits for the old one, then serves at the same address. */
async function switchLauncher(old: Launcher, dir: string, port: number): Promise<Launcher> {
  const next = launch(dir, port);
  await until(next, /Waiting for the other copy to stop/);
  await stop(old.child);
  await until(next, /Omni Song is running at/);
  return next;
}

/** The version the page in the tab names (null while it is between pages). */
function versionOf(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('meta[name="omni-song-version"]')?.getAttribute('content') ?? null).catch(() => null);
}

const controlled = (page: Page) => page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false);

/** This page was not reloaded since `mark` (window state survives). */
const mark = (page: Page) => page.evaluate(() => ((window as any).__notReloaded = true));
const notReloaded = (page: Page) => page.evaluate(() => (window as any).__notReloaded === true);

/** The ⋯ More button says a new version is ready (its Update item). */
const offersUpdate = (page: Page) => page.locator('header[aria-label="Transport"] button[aria-label^="More: update ready"]');

/** Open the app at `url` in this tab and wait until the installed version serves it. */
async function openControlled(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => controlled(page)).toBe(true);
}

async function pressUpdate(page: Page): Promise<void> {
  // The Welcome card first ("Just look around"), then ⋯ More → Update to the new version.
  await page.getByRole('button', { name: 'Just look around' }).click();
  await page.locator('header[aria-label="Transport"] button[aria-label^="More: update ready"]').click();
  await page.getByRole('menuitem', { name: /Update to the new version/ }).click();
}

test('pages not in use switch to the new version by themselves, also the tab the new launcher opens', async ({ page, context }) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const a = launch(buildA, port);
  await until(a, /Omni Song is running at/);
  await openControlled(page, url);
  expect(await versionOf(page)).toBe(versionA);
  await expect(page.getByTestId('welcome-version')).toHaveText(`Version ${versionA}`);

  await switchLauncher(a, buildB, port);
  // The new launcher opens the address in the browser: a new tab.
  const opened = await context.newPage();
  await opened.goto(url);
  // Both tabs end up on the new version, with no click or key.
  await expect.poll(() => versionOf(opened), { timeout: 20_000 }).toBe(NEXT);
  await expect.poll(() => versionOf(page), { timeout: 20_000 }).toBe(NEXT);
  await expect(opened.getByTestId('welcome-version')).toHaveText(`Version ${NEXT}`);
  await expect(page.getByTestId('welcome-version')).toHaveText(`Version ${NEXT}`);
  await expect(opened.getByRole('button', { name: 'Jump In' })).toBeVisible();
  // Nothing left to update.
  await expect(offersUpdate(opened)).toHaveCount(0);
  expect(pageErrors(page)).toEqual([]);
});

test('a page in use is never reloaded: it offers Update, which then opens the new version', async ({ page, context }) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const a = launch(buildA, port);
  await until(a, /Omni Song is running at/);
  await openControlled(page, url);
  // In use: a key pressed in the page.
  await page.keyboard.press('Shift');
  await mark(page);

  await switchLauncher(a, buildB, port);
  const opened = await context.newPage();
  await opened.goto(url);
  // The new version waits: both tabs still show the old one and offer Update.
  await expect(offersUpdate(opened)).toHaveCount(1, { timeout: 20_000 });
  await expect(offersUpdate(page)).toHaveCount(1);
  await page.waitForTimeout(1500);
  expect(await notReloaded(page)).toBe(true);
  expect(await versionOf(page)).toBe(versionA);
  expect(await versionOf(opened)).toBe(versionA);

  // Update in the other tab opens the new version there; the page in use still is not reloaded.
  await pressUpdate(opened);
  await expect.poll(() => versionOf(opened), { timeout: 20_000 }).toBe(NEXT);
  await page.waitForTimeout(1500);
  expect(await notReloaded(page)).toBe(true);
  expect(await versionOf(page)).toBe(versionA);
  await expect(offersUpdate(page)).toHaveCount(1);

  // Its own Update reloads it into the new version.
  await pressUpdate(page);
  await expect.poll(() => versionOf(page), { timeout: 20_000 }).toBe(NEXT);
  await expect(page.getByTestId('welcome-version')).toHaveText(`Version ${NEXT}`);
});

test('with the new version waiting (the page was in use), a refresh opens it', async ({ page }) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const a = launch(buildA, port);
  await until(a, /Omni Song is running at/);
  await openControlled(page, url);
  await page.keyboard.press('Shift');

  await switchLauncher(a, buildB, port);
  // The page looks for a new version (as the browser does on its own from time to time).
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
  await expect(offersUpdate(page)).toHaveCount(1, { timeout: 20_000 });
  expect(await versionOf(page)).toBe(versionA);

  // A refresh: the fresh page is not in use, so the waiting version takes over and the page shows it.
  await page.reload();
  await expect.poll(() => versionOf(page), { timeout: 20_000 }).toBe(NEXT);
  await expect(page.getByTestId('welcome-version')).toHaveText(`Version ${NEXT}`);
});

test('pages that cannot answer (built before 2.3) are reloaded into the new version by its service worker', async ({ page, context }) => {
  // Such a page neither answers the question nor reloads itself when the version changes.
  await page.addInitScript(() => {
    const add = ServiceWorkerContainer.prototype.addEventListener;
    ServiceWorkerContainer.prototype.addEventListener = function (this: ServiceWorkerContainer, type: string, ...rest: any[]) {
      if (type === 'message' || type === 'controllerchange') return;
      return (add as any).call(this, type, ...rest);
    } as any;
  });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const a = launch(buildA, port);
  await until(a, /Omni Song is running at/);
  await openControlled(page, url);
  await mark(page);

  await switchLauncher(a, buildB, port);
  const opened = await context.newPage();
  await opened.goto(url);
  await expect.poll(() => versionOf(page), { timeout: 20_000 }).toBe(NEXT);
  expect(await notReloaded(page)).toBe(false);
  await expect.poll(() => versionOf(opened), { timeout: 20_000 }).toBe(NEXT);
});

test('the 2.2.0 release open in the browser: the new launcher waits for its window, and both tabs then show the new version', async ({ page, context }) => {
  test.skip(!existsSync(RELEASE_22), 'needs release/omni-song-2.2.0.zip (npm run package at 2.2.0)');
  const old = join(work, 'release-2.2.0');
  for (const [name, data] of Object.entries(unzipSync(readFileSync(RELEASE_22)))) {
    if (!name.startsWith('app/') || name.endsWith('/')) continue;
    const file = join(old, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const a = launch(join(old, 'app'), port);
  await until(a, /Omni Song is running at/);
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeVisible();
  expect(await versionOf(page)).toBeNull();
  // 2.2 serves itself from the browser's copy from the second visit on.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => controlled(page)).toBe(true);

  const next = launch(buildA, port);
  await until(next, /Another copy of Omni Song \(an older version\) is running in another window/);
  expect(next.out()).toContain(`This is version ${versionA}.`);
  await stop(a.child);
  await until(next, /Omni Song is running at/);
  const opened = await context.newPage();
  await opened.goto(url);
  await expect.poll(() => versionOf(opened), { timeout: 20_000 }).toBe(versionA);
  await expect.poll(() => versionOf(page), { timeout: 20_000 }).toBe(versionA);
  await expect(opened.getByTestId('welcome-version')).toHaveText(`Version ${versionA}`);
});

test('how a page answers "omni:busy?": idle until it is used, playing, paused, recording or exporting', async ({ page }) => {
  await openFresh(page);
  const ask = () =>
    page.evaluate(
      () =>
        new Promise<string>((done) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (e) => done(e.data);
          navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: 'omni:busy?', ports: [channel.port2] }));
        }),
    );
  const runtime = (patch: Record<string, unknown>) => page.evaluate((p) => (window as any).__switchboard.runtime.setState((s: any) => ({ ...s, ...p })), patch);
  expect(await ask()).toBe('idle');
  for (const patch of [{ playing: true }, { paused: true }, { recording: 'performance' }, { recording: 'notes' }, { countingIn: true }]) {
    await runtime(patch);
    expect(await ask()).toBe('busy');
    await runtime({ playing: false, paused: false, recording: 'off', countingIn: false });
    expect(await ask()).toBe('idle');
  }
  await page.evaluate(() => ((window as any).__switchboard.session.exportsRunning = 1));
  expect(await ask()).toBe('busy');
  await page.evaluate(() => ((window as any).__switchboard.session.exportsRunning = 0));
  expect(await ask()).toBe('idle');
  // Once a key (or the pointer) is pressed in it, the page stays in use until it reloads.
  await page.keyboard.press('Shift');
  expect(await ask()).toBe('busy');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeVisible();
  expect(await ask()).toBe('idle');
});
