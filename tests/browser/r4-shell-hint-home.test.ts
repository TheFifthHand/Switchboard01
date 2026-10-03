/**
 * A view's hint home (the hint-placement contract with the views): in the
 * running app, real styles and fonts, the "Try this" chip
 * - sits on the open view's [data-hint-home] (Mix: the mixer header's
 *   subtitle, above the strips) when that spot covers nothing else, lined up
 *   with the home's start and centred on its line;
 * - never covers what a view marks [data-hint-avoid] (Mix: the spectrum's
 *   labels and axis, the loudness readings and status) or any control;
 * - goes elsewhere when something now sits on the home's spot;
 * - the quick guide (a tour of the Play view) waits on the home too, as one
 *   line, while another view is open.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { HINT_IDS, markHintDone, showHintsAgain, type HintId } from '../../src/app/views/hints/hintsState';
import { setUiMode, type UiMode } from '../../src/state/uiStore';
import { chipPlaced } from './r4-shell-chip';
import { button, click, closeShell, openShell, settle, transport, until } from './r4-shell-harness';

afterEach(closeShell);

const chip = () => document.querySelector<HTMLElement>('aside[data-hint]')!;
const tab = (name: string) => [...transport().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
const CONTROLS = 'button, [role="slider"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], input, select, textarea, a[href]';

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** Controls and [data-hint-avoid] marks under the chip, by name. */
function covered(): string[] {
  const c = chip().getBoundingClientRect();
  const out: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(`${CONTROLS}, [data-hint-avoid]`)) {
    if (chip().contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') continue;
    if (overlaps(c, r)) out.push(`${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName}${el.hasAttribute('data-hint-avoid') ? ' (avoid)' : ''}`);
  }
  return out;
}

/** The hints at `step` (the basics before it done, the song track passed). */
function showStep(step: HintId) {
  act(() => {
    showHintsAgain();
    for (const s of HINT_IDS) {
      if (s === step) break;
      markHintDone(s);
    }
    for (const s of HINT_IDS) if (s.startsWith('song-')) markHintDone(s);
  });
}

/** Mix's home on screen: the first [data-hint-home] in the view with a size. */
const home = () => [...document.querySelectorAll<HTMLElement>('main [data-hint-home]')].find((el) => el.getBoundingClientRect().width > 1);

describe('the hint home', () => {
  for (const [w, hh, mode] of [
    [1366, 768, 'simple'],
    [1366, 768, 'advanced'],
    [1920, 1080, 'simple'],
  ] as const) {
    it(`in Mix at ${w} x ${hh} (${mode}) the chip sits on the mixer header's line, over no control or readout`, async () => {
      await openShell({ width: w, height: hh });
      await click(button('Just look around')!);
      act(() => setUiMode(mode as UiMode));
      await click(tab('Mix'));
      showStep('master');
      await until(() => chip()?.hasAttribute('data-ready'), 'the chip');
      await chipPlaced();
      expect(chip().dataset.hint).toBe('master');
      const h = await until(home, 'the Mix hint home');
      const hr = h.getBoundingClientRect();
      const c = chip().getBoundingClientRect();
      // On the home's line: the home's middle runs through the chip, which starts where the home starts.
      const middle = (hr.top + hr.bottom) / 2;
      expect(c.top, 'on the home line').toBeLessThanOrEqual(middle);
      expect(c.bottom, 'on the home line').toBeGreaterThanOrEqual(middle);
      expect(Math.abs(c.left - hr.left), 'lined up with the home').toBeLessThanOrEqual(1);
      // Above the strips, over nothing to press or read.
      expect(covered()).toEqual([]);
      for (const s of document.querySelectorAll('[data-testid^="strip-"]')) expect(overlaps(c, s.getBoundingClientRect()), 'over a channel strip').toBe(false);
    });
  }

  for (const [w, hh] of [
    [1280, 800],
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`in Mix at ${w} x ${hh} the quick guide waits as one line on the home, over no control, heading or reading`, async () => {
      await openShell({ width: w, height: hh, guideDone: false });
      await click(button('Jump In')!);
      const guide = await until(() => document.querySelector<HTMLElement>('[data-guide-step]'), 'the quick guide');
      await click(tab('Mix'));
      await until(() => guide.dataset.layout === 'waiting', 'the guide to wait');
      await settle(900);
      expect(guide.textContent).toContain('This is on the Play view.');
      // Where placement put it (its left / top: it glides there, and the glide is not what is tested).
      const left = parseFloat(guide.style.left);
      const topY = parseFloat(guide.style.top);
      const g = new DOMRect(left, topY, guide.offsetWidth, guide.offsetHeight);
      const hr = (await until(home, 'the Mix hint home')).getBoundingClientRect();
      const middle = (hr.top + hr.bottom) / 2;
      expect(g.top, 'on the home line').toBeLessThanOrEqual(middle);
      expect(g.bottom, 'on the home line').toBeGreaterThanOrEqual(middle);
      const under: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(`${CONTROLS}, h2, h3, [data-hint-avoid]`)) {
        if (guide.contains(el) || el.closest('header[aria-label="Transport"]') || el.querySelector('[data-hint-home]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1 && overlaps(g, r)) under.push(el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName);
      }
      expect(under).toEqual([]);
      // Show the Play view takes the tour back there.
      await click(button('Show the Play view', guide)!);
      await until(() => guide.dataset.layout !== 'waiting', 'the guide back on Play');
    });
  }

  it('when something now sits on the home’s spot, the chip goes elsewhere', async () => {
    await openShell({ width: 1366, height: 768 });
    await click(button('Just look around')!);
    await click(tab('Mix'));
    showStep('master');
    await until(() => chip()?.hasAttribute('data-ready'), 'the chip');
    await chipPlaced();
    const before = chip().getBoundingClientRect();
    // A control appears right where the chip is (a panel opening, say).
    const intruder = document.createElement('button');
    intruder.textContent = 'New control';
    Object.assign(intruder.style, { position: 'fixed', left: `${before.left + 16}px`, top: `${before.top + 2}px`, width: '140px', height: '32px', zIndex: '1' });
    document.querySelector('main')!.appendChild(intruder);
    try {
      // (It looks again when the view's content changes, and every 600 ms anyway.)
      await settle(700);
      await chipPlaced();
      expect(overlaps(chip().getBoundingClientRect(), intruder.getBoundingClientRect())).toBe(false);
      expect(covered()).toEqual([]);
    } finally {
      intruder.remove();
    }
  });
});
