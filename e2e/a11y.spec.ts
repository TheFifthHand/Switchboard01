/**
 * Mouse-free use: the essential controls are reachable with the keyboard,
 * have readable accessible names and a visible focus indicator, and the main
 * views pass an automated axe-core audit (serious/critical rules).
 */
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { openFresh, pageErrors } from './helpers';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

async function audit(page: Page, label: string) {
  await page.addScriptTag({ path: AXE_PATH });
  const result = await page.evaluate(async () => {
    const axe = (window as any).axe;
    const r = await axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations
      .filter((v: any) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: any) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')).join(' | ')}`);
  });
  expect(result, `${label}:\n${result.join('\n')}`).toEqual([]);
}

/**
 * Tab through the page. For each stop: its accessible name, and whether focus
 * visibly changes the control (screenshot of the control + margin, focused vs
 * blurred) — the ring may be drawn on the element or on an inner part.
 */
async function tabTour(page: Page, presses: number) {
  const seen: { name: string; ring: boolean; what?: string }[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      const viaLabel = (el as HTMLInputElement).labels?.[0]?.textContent ?? '';
      const name = (el.getAttribute('aria-label') || labelled || viaLabel || el.textContent || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const r = el.getBoundingClientRect();
      (window as any).__tourEl = el;
      const what = `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}.${String(el.className).slice(0, 40)}`;
      return { name, what, box: { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.width + 12, height: r.height + 12 } };
    });
    // Focus left the page (Tab wrapped to the browser UI): not a stop.
    if (!info) continue;
    const visible = info.box.width > 12 && info.box.height > 12 && info.box.y < (page.viewportSize()?.height ?? 768);
    let ring = true;
    if (visible) {
      const clip = { ...info.box, width: Math.min(info.box.width, 1366 - info.box.x), height: Math.min(info.box.height, 768 - info.box.y) };
      const focused = await page.screenshot({ clip, animations: 'disabled' });
      await page.evaluate(() => (window as any).__tourEl.blur());
      const blurred = await page.screenshot({ clip, animations: 'disabled' });
      ring = !focused.equals(blurred);
      await page.evaluate(() => (window as any).__tourEl.focus());
    }
    seen.push({ name: info.name, ring, what: info.what });
  }
  return seen;
}

test('keyboard only: Jump In, reach every essential control, play a note, change a macro', async ({ page }) => {
  await openFresh(page);
  // The Jump In button has focus on arrival; Enter is the gesture that starts audio.
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  // The optional guide can be skipped from the keyboard.
  const skip = page.getByRole('button', { name: /Skip/ });
  if (await skip.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(skip).toBeHidden();
  }

  const tour = await tabTour(page, 140);
  const names = tour.map((t) => t.name);
  const reach = (re: RegExp) => expect(names.some((n) => re.test(n)), `${re} not reachable by Tab. Seen: ${names.join(' / ')}`).toBe(true);
  reach(/^Play$|^Stop$/);
  reach(/Tempo|BPM/);
  reach(/Swing/);
  reach(/Notes/);
  reach(/Performance/);
  reach(/Master/);
  reach(/Mute All/);
  reach(/^Drums, |Groove: /);
  reach(/Tone/);
  reach(/Space/);
  reach(/Keyboard|C4/);
  // Every stop in the tour shows a focus indicator.
  const missing = tour.filter((t) => t.name && !t.ring).map((t) => t.name);
  expect(missing, `no visible focus ring on: ${missing.join(', ')}`).toEqual([]);

  // Knobs work with arrow keys.
  const tone = page.getByRole('slider', { name: 'Tone' });
  await tone.focus();
  const before = Number(await tone.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => Number(await tone.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  await expect(tone).toHaveAttribute('aria-valuetext', /%/);

  // Pads launch with Enter; the computer keyboard plays notes.
  const pad = page.getByRole('button', { name: /^Bass, Lift: / });
  await pad.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^Bass, Lift: .*(Starts next bar|Playing)/ })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('KeyA');
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__switchboard.runtime.getState().held).flat().length)).toBeGreaterThan(0);
  await page.keyboard.up('KeyA');

  // Space plays/stops when focus is not on a control (on a focused button it activates that button).
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(false);
  expect(pageErrors(page)).toEqual([]);
});

test('keyboard only: every Tab stop in Shape and Arrange has a name and a visible focus ring', async ({ page }) => {
  await openFresh(page);
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  const skip = page.getByRole('button', { name: /Skip/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  for (const view of ['Shape', 'Arrange']) {
    const tab = page.getByRole('tab', { name: view, exact: true });
    await tab.click();
    await tab.focus();
    const tour = await tabTour(page, 120);
    const unnamed = tour.filter((t) => !t.name).map((t) => t.what);
    expect(unnamed, `${view}: Tab stops without an accessible name`).toEqual([]);
    const missing = tour.filter((t) => t.name && !t.ring).map((t) => t.name);
    expect(missing, `${view}: no visible focus ring on: ${missing.join(', ')}`).toEqual([]);
  }
  expect(pageErrors(page)).toEqual([]);
});

test('automated accessibility audit of the main views has no serious or critical violations', async ({ page }) => {
  await openFresh(page);
  await audit(page, 'welcome');
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  const skip = page.getByRole('button', { name: /Skip/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await audit(page, 'play / loops');
  for (const mode of ['Drums', 'Notes', 'Steps']) {
    await page.getByRole('tab', { name: mode, exact: true }).click();
    await audit(page, `play / ${mode}`);
  }
  await page.getByRole('tab', { name: 'Shape', exact: true }).click();
  await audit(page, 'shape');
  await page.getByRole('tab', { name: 'Arrange', exact: true }).click();
  await audit(page, 'arrange');
});
