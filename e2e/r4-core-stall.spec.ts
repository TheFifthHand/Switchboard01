/**
 * perf-01: the app's own main-thread work never makes a note late or stops
 * playback. With the CPU slowed down 4× (CDP), real clicks switch the views
 * Shape → Song → Mix → Play, 1.5 s apart, three rounds, while the Jump In
 * groove plays. Every note handed to the engine is checked against the audio
 * clock (scheduleNote wrapped): none may be later than 20 ms, and playback
 * never stops. Notes dropped (never played late) and skips are reported too.
 */
import { expect, test, type Page } from '@playwright/test';

async function clickReal(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true });
  const box = await tab.boundingBox();
  if (!box) throw new Error(`no ${name} tab`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
}

test('view switches at 4× CPU slowdown: no playback stop, no note later than 20 ms', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing), { timeout: 20_000 }).toBe(true);
  const skip = page.getByRole('button', { name: 'Skip guide' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.waitForTimeout(1000);

  // Every note the engine gets: how late it was handed over (audio clock now − its time).
  await page.evaluate(() => {
    const sb = (window as any).__switchboard;
    const engine = sb.session.engine;
    const ctx = sb.session.ctx;
    const w = window as any;
    w.__late = { notes: 0, late: 0, worst: 0, stops: 0 };
    const schedule = engine.scheduleNote.bind(engine);
    engine.scheduleNote = (trackId: string, n: { time: number }) => {
      const L = w.__late;
      L.notes++;
      const d = ctx.currentTime - n.time;
      if (d > 0.02) L.late++;
      L.worst = Math.max(L.worst, d);
      return schedule(trackId, n);
    };
    // Any stop of playback (a stall included) counts.
    sb.runtime.subscribe((s: { playing: boolean }, prev: { playing: boolean }) => {
      if (prev.playing && !s.playing) w.__late.stops++;
    });
  });
  const before = await page.evaluate(() => (window as any).__switchboard.stats().transport);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    for (let round = 0; round < 3; round++) {
      for (const view of ['Shape', 'Song', 'Mix', 'Play']) {
        await clickReal(page, view);
        await page.waitForTimeout(1500);
      }
    }
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }

  const result = await page.evaluate(() => ({ ...(window as any).__late, rt: (window as any).__switchboard.runtime.getState() }));
  const after = await page.evaluate(() => (window as any).__switchboard.stats().transport);
  console.log(
    `[r4-core-stall] notes ${result.notes}, later than 20 ms ${result.late}, worst ${(result.worst * 1000).toFixed(1)} ms, stops ${result.stops}, ` +
      `dropped (never played late) ${after.lateDropped - before.lateDropped}, skips ${after.skips - before.skips}`,
  );
  expect(result.notes).toBeGreaterThan(100);
  expect(result.stops).toBe(0);
  expect(result.rt.playing).toBe(true);
  expect(result.rt.stalled).toBeNull();
  expect(result.late).toBe(0);
  expect(errors).toEqual([]);
});
