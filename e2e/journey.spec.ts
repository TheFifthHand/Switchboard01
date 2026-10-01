/**
 * The first-minute journey from PRODUCT_BRIEF.md §1, in a fresh browser
 * profile against the production build.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { jumpIn, masterPeakOver, openFresh, pageErrors, parseWavHeader, wavStats16 } from './helpers';

const CEILING = 0.8912509381337456; // -1 dBFS

test('Jump In → groove → switch clips → Tone/Space → keyboard → record performance → export WAV', async ({ page }) => {
  await openFresh(page);
  await expect(page.getByText('Start with a beat. Make it yours.')).toBeVisible();

  // 1-2. Jump In enables audio and plays a starter groove at a comfortable level.
  await jumpIn(page);
  expect(await page.evaluate(() => (window as any).__switchboard.audioState())).toBe('running');
  const level = await masterPeakOver(page, 2500);
  expect(level.rms).toBeGreaterThan(0.01);
  expect(level.peak).toBeLessThanOrEqual(CEILING + 1e-3);

  // 3. Several pads are lit and say so in text.
  const playingPads = page.getByRole('button', { name: /Playing\.( Selected\.)?$/ });
  await expect(playingPads).toHaveCount(4);
  await expect(page.getByRole('button', { name: /^Bass, Groove: .*Playing\./ })).toBeVisible();

  // 4. Tap another Bass variation: it queues immediately and joins on the next bar.
  await page.evaluate(() => {
    const sb = (window as any).__switchboard;
    (window as any).__launches = [];
    sb.session.transport.on('launch', (ev: any) => (window as any).__launches.push({ trackId: ev.trackId, slot: ev.slot, tick: ev.tick, heardAt: sb.position().tick }));
  });
  const lift = page.getByRole('button', { name: /^Bass, Lift: / });
  await lift.click();
  await expect(page.getByRole('button', { name: /^Bass, Lift: .*Starts next bar\./ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Bass, Lift: .*Playing\./ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: /^Bass, Groove: .*Ready\./ })).toBeVisible();
  const launches = await page.evaluate(() => (window as any).__launches as { trackId: string; slot: number; tick: number; heardAt: number }[]);
  const bassSwitch = launches.find((l) => l.trackId === 't3' && l.slot === 2)!;
  expect(bassSwitch).toBeTruthy();
  // The switch happens exactly on a bar line, and the UI is told when that audio time arrives (not early, < 1/8 note late).
  expect(bassSwitch.tick % 384).toBe(0);
  expect(bassSwitch.heardAt).toBeGreaterThanOrEqual(bassSwitch.tick);
  expect(bassSwitch.heardAt - bassSwitch.tick).toBeLessThan(48);

  // 5. Tone and Space change the selected part (tapping the Bass pad selected Bass).
  await expect(page.getByRole('heading', { name: 'Bass' })).toBeVisible();
  const tone = page.getByRole('slider', { name: 'Tone' });
  await tone.focus();
  await page.keyboard.press('End');
  await expect(tone).toHaveAttribute('aria-valuenow', '1');
  const space = page.getByRole('slider', { name: 'Space' });
  await space.focus();
  await page.keyboard.press('End');
  const macros = await page.evaluate(() => (window as any).__switchboard.project().tracks.find((t: any) => t.id === 't3').macros);
  expect(macros.tone).toBe(1);
  expect(macros.space).toBe(1);

  // 6. Keyboard with Musical Assist: an out-of-key key plays the nearest in-key note.
  const key = await page.evaluate(() => {
    const p = (window as any).__switchboard.project();
    return { root: p.root, scale: p.scale, assist: p.assist };
  });
  expect(key.assist).toBe(true);
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.down('KeyA');
  await expect.poll(() => page.evaluate(() => ((window as any).__switchboard.runtime.getState().held.t3 ?? []).length)).toBe(1);
  await page.keyboard.up('KeyA');
  await expect.poll(() => page.evaluate(() => ((window as any).__switchboard.runtime.getState().held.t3 ?? []).length)).toBe(0);

  // 7. Record Performance, play for a while, stop, export something to listen to.
  await page.getByRole('button', { name: 'Record Performance' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyD');
  await page.getByRole('button', { name: /^Launch scene Lift/ }).click();
  await page.waitForTimeout(3500);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  const perf = await page.evaluate(() => (window as any).__switchboard.project().performances[0]);
  expect(perf).toBeTruthy();
  const types = new Set(perf.events.map((e: any) => e.type));
  expect(types.has('noteOn')).toBe(true);
  expect(types.has('scene')).toBe(true);

  // Export is also in the More menu at every width (the strip shows it from 1280 px in Simple).
  await page.getByRole('button', { name: /^More:/ }).click();
  await page.getByRole('menuitem', { name: /Export WAV/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export audio' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('What to export')).toHaveValue(`perf:${perf.id}`);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Export WAV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.wav$/);
  const wav = readFileSync(await download.path());
  const h = parseWavHeader(wav);
  expect(h.channels).toBe(2);
  expect(h.sampleRate).toBe(48000);
  expect(h.bitDepth).toBe(16);
  const seconds = h.frames / h.sampleRate;
  const expected = await page.evaluate(
    ({ id, tail }) => (window as any).__switchboard.session.renderPlan({ kind: 'performance', performanceId: id }, tail).totalSeconds,
    { id: perf.id, tail: await page.evaluate(() => (window as any).__switchboard.project().arrangement.tailSeconds) },
  );
  expect(Math.abs(seconds - expected)).toBeLessThan(0.01);
  const stats = wavStats16(wav, h.dataOffset, h.frames, h.channels);
  expect(stats.finite).toBe(true);
  expect(stats.rms).toBeGreaterThan(0.005);
  expect(stats.peak).toBeLessThanOrEqual(CEILING + 1 / 32768);

  expect(pageErrors(page)).toEqual([]);
});

test('Jump In always lands on the lit Loops pads, even when another view was left open last time', async ({ page }) => {
  // A returning user who last left the app in Arrange with the Steps pad mode.
  await page.addInitScript(() => localStorage.setItem('switchboard01.ui', JSON.stringify({ view: 'arrange', padMode: 'steps', guideDone: true })));
  await openFresh(page);
  // Behind the Welcome card (inert), the remembered view is showing.
  await expect(page.locator('header[aria-label="Transport"] [role="tab"][aria-selected="true"]')).toContainText('Arrange');
  await jumpIn(page);
  await expect(page.getByRole('tab', { name: 'Play', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Loops', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /Playing\.( Selected\.)?$/ })).toHaveCount(4);
  expect(pageErrors(page)).toEqual([]);
});
