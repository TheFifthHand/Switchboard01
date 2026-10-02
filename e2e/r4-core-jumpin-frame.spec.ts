/**
 * perf-06: Jump In does not freeze the page. Audio starts from the click, the
 * view change paints before the engine is built (one frame's yield), and the
 * instruments warm up in idle slices instead of one long task. Measured with
 * the browser's long-animation-frame entries from the click to the first
 * sound at 1× CPU: the longest frame is at most 300 ms (it was 580–670 ms).
 */
import { expect, test } from '@playwright/test';

test('Jump In: no animation frame longer than 300 ms, and sound starts', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const w = window as any;
    w.__loafs = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__loafs.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: 'long-animation-frame', buffered: true });
      w.__loafSupported = true;
    } catch {
      w.__loafSupported = false;
    }
  });
  await page.goto('/');
  const jump = page.getByRole('button', { name: 'Jump In' });
  await expect(jump).toBeVisible({ timeout: 30_000 });
  // Let the start-up frames settle, then measure from the click.
  await page.waitForTimeout(1500);
  const box = (await jump.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  const clickAt = await page.evaluate(() => performance.now());
  await page.mouse.down();
  await page.mouse.up();
  // First sound: the master meter moves.
  const soundAt = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const sb = (window as any).__switchboard;
        const end = performance.now() + 20_000;
        const poll = () => {
          if (sb.runtime.getState().playing && sb.meters().masterPeakL > 0.003) resolve(performance.now());
          else if (performance.now() > end) reject(new Error('no sound'));
          else requestAnimationFrame(poll);
        };
        poll();
      }),
  );
  await page.waitForTimeout(500);
  const { supported, loafs } = await page.evaluate(() => ({ supported: (window as any).__loafSupported as boolean, loafs: (window as any).__loafs as { start: number; duration: number }[] }));
  expect(supported).toBe(true);
  const during = loafs.filter((l) => l.start + l.duration >= clickAt && l.start <= soundAt);
  const longest = Math.max(0, ...during.map((l) => l.duration));
  console.log(`[r4-core-jumpin-frame] click → sound ${(soundAt - clickAt).toFixed(0)} ms; long frames ${during.map((l) => l.duration.toFixed(0)).join(', ') || 'none'}; longest ${longest.toFixed(0)} ms`);
  expect(longest).toBeLessThanOrEqual(300);
});
