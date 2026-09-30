/**
 * Persistence evidence:
 *  - a project with a custom (imported) sample survives export → import into
 *    a FRESH browser profile → a second audio render that matches the first;
 *  - autosave reopens the last project;
 *  - the first-launch preview is stored on its first change (never before)
 *    and is offered again after a reload;
 *  - a storage failure shows an understandable recovery path, and the
 *    recovery export downloads a project file and says so.
 */
import { expect, test, type Page } from '@playwright/test';
import { jumpIn, openFresh, pageErrors } from './helpers';

/** Build a 1-second 16-bit WAV of a decaying 330 Hz tone inside the page and import it onto the Vocal (sampler) part. */
async function importToneSample(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const sb = (window as any).__switchboard;
    const sr = 44100;
    const n = sr;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 330 * i) / sr) * Math.exp(-i / (sr * 0.4)) * 20000), true);
    const file = new File([buf], 'test-tone.wav', { type: 'audio/wav' });
    const res = await sb.session.importSample(file, 't8');
    if (!res.ok) throw new Error(res.message);
    return sb.project().tracks.find((t: any) => t.id === 't8').instrument.sampleId as string;
  });
}

/** Render the scene the sampler plays in (row 3 "Break" has a Vocal clip) and return RMS + a coarse fingerprint. */
async function renderFingerprint(page: Page): Promise<{ rms: number; env: number[] }> {
  return page.evaluate(async () => {
    const sb = (window as any).__switchboard;
    const blob: Blob = await sb.session.renderWav({ source: { kind: 'scene', row: 3, bars: 2 }, sampleRate: 44100, bitDepth: 16, tailSeconds: 0.5 });
    const dv = new DataView(await blob.arrayBuffer());
    const frames = (dv.byteLength - 44) / 4;
    let sum = 0;
    const env: number[] = [];
    const block = Math.floor(frames / 32);
    for (let b = 0; b < 32; b++) {
      let s = 0;
      for (let i = b * block; i < (b + 1) * block; i++) {
        const l = dv.getInt16(44 + i * 4, true) / 32768;
        s += l * l;
      }
      env.push(Math.sqrt(s / block));
      sum += s;
    }
    return { rms: Math.sqrt(sum / (block * 32)), env };
  });
}

test('a project with an imported sample survives export and import into a fresh profile', async ({ browser }) => {
  // Profile 1: make a project that uses a custom recording, and export it.
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  await openFresh(page1);
  await jumpIn(page1);
  await page1.getByRole('button', { name: 'Stop', exact: true }).click();
  const sampleId = await importToneSample(page1);
  expect(sampleId).toMatch(/^smp_|^sample|^s_/);
  // Make sure the Vocal part has a clip in the Break row that plays the recording.
  await page1.evaluate(() => {
    const sb = (window as any).__switchboard;
    const clip = sb.project().tracks.find((t: any) => t.id === 't8').clips[3];
    if (!clip) throw new Error('fixture: the starter has no Vocal clip in row 4');
  });
  const before = await renderFingerprint(page1);
  expect(before.rms).toBeGreaterThan(0.005);
  const bundle = await page1.evaluate(async () => {
    const { blob, filename } = await (window as any).__switchboard.session.exportProjectFile();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { filename, bytes: Array.from(bytes) };
  });
  expect(bundle.filename).toMatch(/\.sb01\.zip$/);
  const projectBefore = await page1.evaluate(() => (window as any).__switchboard.project());
  await ctx1.close();

  // Profile 2: a fresh browser profile (no IndexedDB data) imports the file.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await openFresh(page2);
  const imported = await page2.evaluate(async ({ bytes, filename }) => {
    const file = new File([new Uint8Array(bytes)], filename, { type: 'application/zip' });
    return (window as any).__switchboard.session.importProjectFile(file);
  }, bundle);
  expect(imported.ok, imported.message).toBe(true);
  const projectAfter = await page2.evaluate(() => (window as any).__switchboard.project());
  // Musical state intact (the imported copy gets a new id).
  for (const key of ['tracks', 'scenes', 'patch', 'arrangement', 'performances', 'samples', 'bpm', 'swing', 'root', 'scale', 'seed']) {
    expect(projectAfter[key], key).toEqual(projectBefore[key]);
  }
  // Start audio in this profile (a user gesture) and render again.
  await page2.getByRole('button', { name: 'Just look around' }).click();
  await page2.getByRole('button', { name: 'Play', exact: true }).click();
  await page2.getByRole('button', { name: 'Stop', exact: true }).click();
  const after = await renderFingerprint(page2);
  expect(after.rms).toBeGreaterThan(0.005);
  expect(Math.abs(after.rms - before.rms) / before.rms).toBeLessThan(0.01);
  after.env.forEach((e, i) => expect(Math.abs(e - before.env[i])).toBeLessThan(0.002 + before.env[i] * 0.02));
  expect(pageErrors(page2)).toEqual([]);
  await ctx2.close();
});

test('autosave reopens the last project after a reload', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.evaluate(() => {
    const sb = (window as any).__switchboard;
    sb.session.setBpm(97);
  });
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5000 });
  const name = await page.evaluate(() => (window as any).__switchboard.project().name);
  await page.reload();
  await expect(page.getByRole('button', { name: `Continue “${name}”` })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__switchboard.project().bpm)).toBe(97);
});

test('the preview from "Just look around" is stored on its first change and reopens after a reload', async ({ page }) => {
  await openFresh(page);
  await page.getByRole('button', { name: 'Just look around' }).click();
  await expect(page.getByRole('button', { name: 'Autosave: Preview, not stored until you change it' })).toBeVisible();
  // Looking around stores nothing.
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as any).__switchboard.session.isPreview)).toBe(true);
  // The first change makes it a normal, saved project.
  await page.evaluate(() => (window as any).__switchboard.session.setBpm(97));
  await expect(page.getByRole('button', { name: 'Autosave: Saved' })).toBeVisible({ timeout: 5000 });
  const name = await page.evaluate(() => (window as any).__switchboard.project().name);
  await page.reload();
  await expect(page.getByRole('button', { name: `Continue “${name}”` })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__switchboard.project().bpm)).toBe(97);
  expect(pageErrors(page)).toEqual([]);
});

test('a storage failure shows "Not saved" with Try again and Export project file', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  // Simulate a full disk: every IndexedDB write now fails with a quota error.
  await page.evaluate(() => {
    const orig = IDBObjectStore.prototype.put;
    (window as any).__restorePut = () => (IDBObjectStore.prototype.put = orig);
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await page.evaluate(() => (window as any).__switchboard.session.setBpm(101));
  const status = page.getByRole('button', { name: /Not saved/ });
  await expect(status).toBeVisible({ timeout: 5000 });
  await status.click();
  const pop = page.getByRole('alertdialog', { name: 'Saving failed' });
  await expect(pop).toContainText('storage is full');
  await expect(pop.getByRole('button', { name: 'Try again' })).toBeVisible();
  // The recovery export downloads the project file and says so.
  const [download] = await Promise.all([page.waitForEvent('download'), pop.getByRole('button', { name: 'Export project file' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.sb01\.zip$/);
  await expect(page.getByText(`Saved “${download.suggestedFilename()}” to your downloads. Keep it as your backup.`)).toBeVisible();
  // Recovery: storage frees up, Try again saves.
  await page.evaluate(() => (window as any).__restorePut());
  await pop.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5000 });
});
