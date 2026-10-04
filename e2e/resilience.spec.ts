/**
 * Reliability evidence:
 *  - the production build works offline once cached (service worker), and
 *    the transport says so ("Offline ready"),
 *  - background throttling (a hidden tab) stops playback coherently; the
 *    banner says so and its Play restarts what was playing (live pads, the
 *    song, or a take),
 *  - repeated Play/Stop does not accumulate voices, handles or listeners,
 *  - minutes of playback keep resources bounded and output within the ceiling.
 */
import { expect, test, type Page } from '@playwright/test';
import { jumpIn, openFresh, pageErrors } from './helpers';

const CEILING = 0.8912509381337456;

const stats = (page: Page) => page.evaluate(() => (window as any).__switchboard.stats());

test('reopens and plays a built-in starter with the network unavailable', async ({ page, context }) => {
  await openFresh(page);
  // First visit: the service worker installs (precaching every asset) and activates.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  // A later visit is served by the service worker.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // The app reports that it is ready to work offline (the transport's status sits behind the Welcome card).
  // The indicator is on the strip from 1440 px; narrower windows list it in the More menu.
  await page.setViewportSize({ width: 1440, height: 800 });
  const offline = page.locator('header[aria-label="Transport"] [role="status"]', { hasText: 'Offline ready' });
  await expect(offline).toBeVisible();
  await page.setViewportSize({ width: 1366, height: 768 });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeVisible();
  await jumpIn(page);
  await expect
    .poll(async () => (await page.evaluate(() => (window as any).__switchboard.meters())).masterRms, { timeout: 5000 })
    .toBeGreaterThan(0.005);
  await context.setOffline(false);
});

/**
 * Stall playback as a hidden (throttled) tab would: its ticks stop for 1.2 s.
 * A hidden tab paints no frames, so the long-animation-frame watcher (which
 * braces a visible, busy tab by scheduling a second ahead at once) is
 * switched off first; otherwise the busy moments right after Jump In refill
 * the schedule while the ticks are held, and nothing stalls.
 */
async function stallHidden(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t = (window as any).__switchboard.session.transport;
    t.longFrames?.disconnect();
    t.longFrames = null;
    t.simulateStall(1200);
  });
}

/** The stall banner's key: "Play" (the banner says "Press Play to continue"). */
const playAgain = (page: Page) => page.getByRole('button', { name: 'Play from where it stopped' });

test('a stalled (throttled) tab stops coherently and offers Play', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  await stallHidden(page);
  await expect(page.getByRole('alert')).toContainText('Playback stopped because the tab was in the background or the audio device paused. Press Play to continue.');
  await expect(playAgain(page)).toHaveText('Play');
  expect(await page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(false);
  // No backlog of notes: nothing is left scheduled.
  await expect.poll(async () => (await stats(page)).transport.pendingHandles).toBe(0);
  await playAgain(page).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  expect(pageErrors(page)).toEqual([]);
});

test('Play after a stall restarts the song from its block, and a stalled take replay frees the keys', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  const state = () => page.evaluate(() => {
    const s = (window as any).__switchboard.runtime.getState();
    return { playing: s.playing, mode: s.mode, songBlock: s.songBlock, replayId: s.replayId, held: Object.values(s.held).flat().length };
  });

  // The song: Play plays the arrangement again from the block that was playing, not the live pads.
  await page.evaluate(() => (window as any).__switchboard.session.playSong(1));
  await expect.poll(async () => (await state()).mode).toBe('song');
  await stallHidden(page);
  await expect(page.getByRole('alert')).toContainText('Playback stopped');
  await playAgain(page).click();
  await expect.poll(state).toMatchObject({ playing: true, mode: 'song', songBlock: 1 });

  // A take: record a short one, replay it, stall.
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Record Performance' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop recording performance' }).click();
  const perfId = await page.evaluate(() => (window as any).__switchboard.project().performances[0]?.id);
  expect(perfId).toBeTruthy();
  await page.evaluate((id) => (window as any).__switchboard.session.replayPerformance(id), perfId);
  await expect.poll(async () => (await state()).mode).toBe('replay');
  await stallHidden(page);
  await expect(page.getByRole('alert')).toContainText('Playback stopped');
  // While the banner waits, the keyboard plays again (a replay would ignore it).
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.down('KeyA');
  await expect.poll(async () => (await state()).held).toBe(1);
  await page.keyboard.up('KeyA');
  // Play replays the take.
  await playAgain(page).click();
  await expect.poll(state).toMatchObject({ playing: true, mode: 'replay', replayId: perfId });
  expect(pageErrors(page)).toEqual([]);
});

test('repeated Play/Stop does not accumulate voices, handles or listeners', async ({ page }) => {
  await openFresh(page);
  await jumpIn(page);
  const play = page.getByRole('button', { name: 'Play', exact: true });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await stop.click();
  await page.waitForTimeout(1500);
  const base = await stats(page);
  for (let i = 0; i < 25; i++) {
    await play.click();
    await page.waitForTimeout(120 + (i % 5) * 60);
    await stop.click();
  }
  await page.waitForTimeout(2500);
  const after = await stats(page);
  expect(after.engine.modules).toBe(base.engine.modules);
  expect(after.engine.connections).toBe(base.engine.connections);
  expect(after.transport.listeners).toBe(base.transport.listeners);
  expect(after.transport.pendingHandles).toBe(0);
  expect(after.engine.voices).toBeLessThanOrEqual(base.engine.voices + 2);
  expect(after.engine.pendingTimers).toBeLessThanOrEqual(base.engine.pendingTimers + 2);
  expect(pageErrors(page)).toEqual([]);
});

test('three minutes of playback: bounded resources, no drift, output within the ceiling', async ({ page }) => {
  test.setTimeout(260_000);
  await openFresh(page);
  await jumpIn(page);
  // Play the fullest scene for more voices.
  await page.getByRole('button', { name: /^Play row Lift/ }).click();
  const samples: { voices: number; pending: number; sounding: number; peak: number; tick: number; t: number }[] = [];
  const t0 = await page.evaluate(() => ({ tick: (window as any).__switchboard.position().tick, t: (window as any).__switchboard.session.ctx.currentTime }));
  for (let i = 0; i < 18; i++) {
    const s = await page.evaluate(async () => {
      const sb = (window as any).__switchboard;
      let peak = 0;
      for (let k = 0; k < 20; k++) {
        const m = sb.meters();
        peak = Math.max(peak, m.masterPeakL, m.masterPeakR);
        await new Promise((r) => setTimeout(r, 25));
      }
      const st = sb.stats();
      // Voices sounding now: those allocated minus the notes handed out ahead of the audio clock and not started
      // yet (pendingHandles). How many are handed out ahead follows the look-ahead (0.3 s, or 1 s for a few
      // seconds after a busy moment), so the allocated count alone says more about the machine's load than
      // about growth.
      return { voices: st.engine.voices, pending: st.transport.pendingHandles, sounding: Math.max(0, st.engine.voices - st.transport.pendingHandles), peak, tick: sb.position().tick, t: sb.session.ctx.currentTime };
    });
    samples.push(s);
    await page.waitForTimeout(9500);
  }
  const bpm = await page.evaluate(() => (window as any).__switchboard.project().bpm);
  const last = samples[samples.length - 1];
  expect(last.t - t0.t).toBeGreaterThan(170);
  // The musical position advances exactly with the audio clock (no drift).
  const expectedTicks = ((last.t - t0.t) * bpm * 96) / 60;
  expect(Math.abs(last.tick - t0.tick - expectedTicks)).toBeLessThan(2);
  // Never stalled, never stopped.
  expect(await page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  for (const s of samples) {
    expect(s.voices).toBeLessThan(120);
    expect(s.pending).toBeLessThan(120);
    expect(s.peak).toBeLessThanOrEqual(CEILING + 1e-3);
  }
  // No growth: late sounding-voice counts are in the same range as early ones (scheduled-ahead notes are
  // not counted: their number follows the look-ahead, which a busy moment raises for a few seconds).
  const early = Math.max(...samples.slice(0, 6).map((s) => s.sounding));
  const late = Math.max(...samples.slice(-6).map((s) => s.sounding));
  expect(late, `sounding voices early ${early}, late ${late}`).toBeLessThanOrEqual(early * 1.5 + 8);
  expect(pageErrors(page)).toEqual([]);
});
