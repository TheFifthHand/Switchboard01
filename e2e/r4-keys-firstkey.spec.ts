/**
 * The first computer key after "Just look around" starts audio and sounds, now that a kit's keys
 * always use the drum-pad layout (PLAY-07): with the Drums part selected (the default), Z is the
 * Kick and A the Closed Hat, in every pad mode. The level is measured from the key press (a
 * closed hat is short), against the production build.
 */
import { expect, test, type Page } from '@playwright/test';
import { openFresh, pageErrors } from './helpers';

/** Highest master peak from now for `ms`, read every 10 ms once audio runs. */
function peakFrom(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (ms) => {
    const sb = (window as any).__switchboard;
    let peak = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (sb.audioState() === 'running') {
        const m = sb.meters();
        peak = Math.max(peak, m.masterPeakL, m.masterPeakR);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return peak;
  }, ms);
}

for (const [code, sound, voice] of [
  ['KeyZ', 'Kick', 0],
  ['KeyA', 'Closed Hat', 4],
] as const) {
  test(`the first key (${code.slice(3)}) after "Just look around" starts audio and plays the ${sound}`, async ({ page }) => {
    await openFresh(page);
    await page.getByRole('button', { name: 'Just look around' }).click();
    expect(await page.evaluate(() => (window as any).__switchboard.ui.getState().selectedTrackId)).toBe('t1');
    expect(await page.evaluate(() => (window as any).__switchboard.audioState())).toBe('none');
    await page.locator('body').click({ position: { x: 700, y: 5 } }).catch(() => undefined);
    const peak = peakFrom(page, 1500);
    await page.keyboard.down(code);
    await expect.poll(() => page.evaluate(() => ((window as any).__switchboard.runtime.getState().held.t1 ?? []) as number[]), { timeout: 5000 }).toEqual([voice]);
    expect(await peak).toBeGreaterThan(0.005);
    await page.keyboard.up(code);
    await expect.poll(() => page.evaluate(() => ((window as any).__switchboard.runtime.getState().held.t1 ?? []).length)).toBe(0);
    // The strip names the key it played.
    await expect(page.locator('[aria-label^="Keyboard playing Drums"] [data-midi]').nth(voice)).toContainText(code.slice(3));
    expect(pageErrors(page)).toEqual([]);
  });
}
