/**
 * Mouse-free use: the essential controls are reachable with the keyboard,
 * have readable accessible names and a visible focus indicator, and the main
 * screens pass an automated axe-core audit (serious/critical rules).
 *
 * Simple (everyone's start): the song screen's essential controls — the top
 * bar, the song header, the rows, LOOPS, the tip line — are Tab stops and work
 * from the keyboard (an instrument's sound, a big knob, Make it longer, Share,
 * ⋯), and the song screen, the editor, the Sound panel, Share and the sheets
 * pass axe. Advanced (⋯ › Show every control) keeps 2.4's checks: the strip,
 * the pads, Shape and Song Tab stops, every view's audit, and at 200 % zoom
 * the transport strip, with Mute All, stays on screen while the page scrolls.
 */
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { openFresh, pageErrors } from './helpers';

const playing = (page: Page) => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing as boolean);
/** What has keyboard focus: its accessible name (as tabTour reads it) and role. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { name: (el?.getAttribute('aria-label') || el?.textContent || '').trim(), role: el?.getAttribute('role') ?? el?.tagName.toLowerCase() ?? '' };
  });

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
async function tabTour(page: Page, presses: number, key: 'Tab' | 'Shift+Tab' = 'Tab') {
  const seen: { name: string; ring: boolean; what?: string }[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(key);
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

/** A tour takes two screenshots per Tab stop (some 300 in all): it needs more than the default 90 s on a busy machine. */
const TOUR_TIMEOUT_MS = 240_000;

test('Simple, keyboard only: Jump In, reach every essential control of the song screen, and use them', async ({ page }) => {
  test.setTimeout(TOUR_TIMEOUT_MS);
  await openFresh(page);
  // The Jump In button has focus on arrival; Enter is the gesture that starts audio.
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => playing(page)).toBe(true);
  // Simple has no quick guide and no view tabs: one song screen.
  await expect(page.getByRole('button', { name: /Skip/ })).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);

  const tour = await tabTour(page, 120);
  const names = tour.map((t) => t.name);
  const reach = (re: RegExp) => expect(names.some((n) => re.test(n)), `${re} not reachable by Tab. Seen: ${names.join(' / ')}`).toBe(true);
  // The top bar: [Project ▾] [Play/Pause] [Stop] [● Record] [↶] [↷] … [Share] [⋯].
  reach(/^Project: /);
  reach(/^Play$|^Pause$/);
  reach(/^Stop$/);
  reach(/^Record .* into the song$/);
  reach(/^Undo$/);
  reach(/^Redo$/);
  reach(/^Share$/);
  reach(/^More$/);
  // The song header.
  reach(/^Repeating: |^Repeat /);
  reach(/^Make it longer$/);
  reach(/^Add instrument$/);
  reach(/^Fit$/);
  // The song: a section, an instrument (its name opens its sound; its volume; Mute and Solo are one stop, ← → move), a loop.
  reach(/^Section /);
  reach(/: open its sound$/);
  reach(/ volume$/);
  reach(/^Mute /);
  reach(/, from \d+:\d\d to \d+:\d\d/);
  // LOOPS and the tip line.
  reach(/^Search the loop library$/);
  reach(/^Hear /);
  reach(/^Hide tips$/);
  // No 2.4 words or controls on the song screen.
  expect(names.filter((n) => /^(Play|Shape|Song|Mix)$|Tempo|BPM|Master|Mute All|Record Performance/.test(n) && !/^Play$/.test(n)), 'Simple shows no 2.4 strip').toEqual([]);
  // Every stop in the tour shows a focus indicator and has a name.
  expect(tour.filter((t) => !t.name).map((t) => t.what), 'Tab stops without an accessible name').toEqual([]);
  const missing = tour.filter((t) => t.name && !t.ring).map((t) => t.name);
  expect(missing, `no visible focus ring on: ${missing.join(', ')}`).toEqual([]);

  // An instrument's name, with Enter, opens its Sound panel; a big knob there moves with the arrow keys.
  await page.getByRole('button', { name: 'Bass (Bass): open its sound' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Bass (Bass): open its sound' })).toHaveAttribute('aria-pressed', 'true');
  const tone = page.getByRole('slider', { name: 'Tone' });
  await expect(tone).toBeVisible();
  const toneBefore = await page.evaluate(() => (window as any).__switchboard.project().tracks.find((t: any) => t.id === 't3').macros.tone as number);
  await tone.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.project().tracks.find((t: any) => t.id === 't3').macros.tone as number)).toBeGreaterThan(toneBefore);
  await expect(tone).toHaveAttribute('aria-valuetext', /%/);

  // Make it longer opens its menu with focus on an item; Esc closes it and gives focus back.
  const longer = page.getByTestId('make-longer');
  await longer.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Make it longer or shorter' })).toBeVisible();
  await expect.poll(async () => (await focused(page)).role).toMatch(/^menuitem/);
  // Enter on the focused item makes the song longer, in one step.
  const bars = () => page.evaluate(() => Math.max(0, ...(window as any).__switchboard.project().arrangement.regions.map((r: any) => r.start + r.bars)) as number);
  const barsBefore = await bars();
  await page.keyboard.press('Enter');
  await expect.poll(bars).toBeGreaterThan(barsBefore);
  await longer.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Make it longer or shorter' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Make it longer or shorter' })).toBeHidden();
  await expect(longer).toBeFocused();

  // Share opens its dialog with focus inside it; Esc closes it and gives focus back.
  const share = page.getByRole('button', { name: 'Share', exact: true });
  await share.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Share your song' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(share).toBeFocused();

  // ⋯ opens with the keyboard; a sheet (Mixer) opens from it, and Esc comes back to the song.
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Mixer' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Back to my song' })).toBeVisible();
  await page.locator('body').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Back to my song' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your song', exact: true })).toBeVisible();

  // Space plays/pauses when focus is not on a control.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const was = await playing(page);
  await page.keyboard.press('Space');
  await expect.poll(() => playing(page)).toBe(!was);
  expect(pageErrors(page)).toEqual([]);
});

test('Advanced, keyboard only: Jump In, reach every essential control, play a note, change a macro', async ({ page }) => {
  test.setTimeout(TOUR_TIMEOUT_MS);
  await openFresh(page, { mode: 'advanced' });
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

  // The strip's offline status is a Tab stop too (its tooltip explains it).
  const tour = await tabTour(page, 150);
  const names = tour.map((t) => t.name);
  const reach = (re: RegExp) => expect(names.some((n) => re.test(n)), `${re} not reachable by Tab. Seen: ${names.join(' / ')}`).toBe(true);
  reach(/^Play$|^Pause$/);
  reach(/^Stop$/);
  reach(/Tempo|BPM/);
  // The Simple · Advanced switch is on the strip at 1366 px.
  reach(/^Simple$|^Advanced$/);
  reach(/^Record Notes$/);
  reach(/^Record Performance$/);
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

  // Space plays/pauses when focus is not on a control (a control reached with Tab is pressed by Space instead).
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(false);

  // Back to Simple from the keyboard: the Simple · Advanced switch is a Tab stop; ← chooses Simple. The
  // strip and its tabs go; the Play view stays open as a sheet over the song, with its way back.
  let onSwitch = false;
  for (let i = 0; i < 200 && !onSwitch; i++) {
    await page.keyboard.press('Tab');
    onSwitch = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute('role') === 'radio' && el.textContent?.trim() === 'Advanced';
    });
  }
  expect(onSwitch, 'the Simple · Advanced switch is a Tab stop').toBe(true);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('header[aria-label="Transport"][data-mode="simple"]')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Shape', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to my song' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your song', exact: true })).toBeVisible();
  expect(pageErrors(page)).toEqual([]);
});

test('Advanced, keyboard only: every Tab stop in Shape and Arrange has a name and a visible focus ring', async ({ page }) => {
  test.setTimeout(TOUR_TIMEOUT_MS);
  await openFresh(page, { mode: 'advanced' });
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  const skip = page.getByRole('button', { name: /Skip/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  for (const view of ['Shape', 'Song']) {
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

test('Simple: automated accessibility audit of the song screen, its editor, Sound panel, Share and sheets', async ({ page }) => {
  test.setTimeout(TOUR_TIMEOUT_MS);
  await openFresh(page);
  await audit(page, 'welcome');
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect.poll(() => playing(page)).toBe(true);
  await audit(page, 'song screen');
  // A single click on a loop opens the editor under the song (Draw, then Play).
  await page.getByRole('button', { name: /^Hats & Rim, Drums, from / }).click();
  const editor = page.getByRole('region', { name: /^Editor: / });
  await expect(editor).toBeVisible();
  await audit(page, 'editor / Draw');
  await editor.getByRole('radio', { name: 'Play' }).check();
  await audit(page, 'editor / Play');
  await editor.getByRole('button', { name: /^Close the editor/ }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'Bass (Bass): open its sound' }).click();
  await expect(page.getByRole('slider', { name: 'Tone' })).toBeVisible();
  await audit(page, 'sound panel');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Share your song' })).toBeVisible();
  await audit(page, 'share');
  await page.keyboard.press('Escape');
  for (const sheet of ['Jam pads', 'Mixer', 'Every setting']) {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: sheet }).click();
    await expect(page.getByRole('button', { name: 'Back to my song' })).toBeVisible();
    await audit(page, `sheet / ${sheet}`);
    await page.getByRole('button', { name: 'Back to my song' }).click();
    await expect(page.getByRole('heading', { name: 'Your song', exact: true })).toBeVisible();
  }
  expect(pageErrors(page)).toEqual([]);
});

test('Advanced: automated accessibility audit of the main views has no serious or critical violations', async ({ page }) => {
  await openFresh(page, { mode: 'advanced' });
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
  await page.getByRole('tab', { name: 'Song', exact: true }).click();
  await audit(page, 'song');
});

test('Advanced, 200 % zoom: the transport strip with Mute All stays on screen while the page scrolls', async ({ page }) => {
  // 1920 x 1080 at 200 % zoom is about 960 x 470 CSS pixels: the page scrolls vertically.
  await page.setViewportSize({ width: 960, height: 470 });
  await openFresh(page, { mode: 'advanced' });
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing)).toBe(true);
  // The quick guide opens after the first Jump In; skip it so its callout does not sit over the strip.
  const skip = page.getByRole('button', { name: /Skip/ });
  await expect(skip).toBeVisible();
  await skip.click();
  await expect(skip).toBeHidden();
  // Scroll to the keyboard strip at the bottom of the page.
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(100);
  const mute = page.getByRole('button', { name: 'Mute All' });
  await expect(mute).toBeInViewport();
  await mute.click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().muteAll)).toBe(true);
  await expect(page.getByRole('button', { name: 'MUTED' })).toBeInViewport();
  expect(pageErrors(page)).toEqual([]);
});
