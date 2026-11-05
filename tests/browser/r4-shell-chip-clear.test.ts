/**
 * The "Try this" chip stays clear and readable (review M1, M4), in the
 * running app with its real styles:
 * - a toast appearing (and going) never moves the chip: toasts pass above it;
 * - with a banner under the transport (playback stopped) the chip sits below
 *   the banner and never covers its keys, also when a toast shows;
 * - where no spot leaves every control free, the chip waits off screen
 *   rather than cover one, and comes back once there is room;
 * - after a view switch the chip arrives at full opacity (a slide, no fade),
 *   so its words never show at low contrast.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { notify, patchRuntime } from '../../src/app/runtime';
import { STALL_MESSAGE } from '../../src/app/session';
import { chipPlaced } from './r4-shell-chip';
import { button, click, closeShell, openShell, settle, transport, until } from './r4-shell-harness';

afterEach(async () => {
  act(() => patchRuntime({ stalled: null }));
  for (const el of document.querySelectorAll('[data-test-crowd]')) el.remove();
  await closeShell();
});

const chip = () => document.querySelector<HTMLElement>('aside[data-hint]');
const where = () => {
  const c = chip()!;
  return `${c.style.left},${c.style.top},${c.style.maxWidth}`;
};
const toastCards = () => [...document.querySelectorAll<HTMLElement>('body > [aria-live] [role="status"], body > [aria-live] [role="alert"]')];
const CONTROLS = 'button, [role="slider"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], input, select, textarea';
function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}
/** Controls under the chip (toasts, which pass above it, aside). */
function coveredControls(): string[] {
  const c = chip()!.getBoundingClientRect();
  const out: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (chip()!.contains(el) || el.closest('body > [aria-live]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') continue;
    if (overlaps(c, r)) out.push(el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName);
  }
  return out;
}

async function lookAround(width = 1366, height = 768) {
  await openShell({ width, height });
  await click(button('Just look around')!);
  await until(() => chip()?.hasAttribute('data-ready'), 'the chip');
  await chipPlaced();
}

describe('toasts pass above the chip', () => {
  for (const [w, hh] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh} a toast appearing and going does not move the chip`, async () => {
      await lookAround(w, hh);
      const before = where();
      act(() => notify('Moved Bounce to Lift.', 'info', 'undo'));
      await until(() => toastCards().length > 0, 'a toast');
      // Longer than the chip's periodic look (600 ms) several times over.
      for (let i = 0; i < 6; i++) {
        await settle(300);
        expect(where(), `while the toast shows (${i})`).toBe(before);
      }
      for (const b of document.querySelectorAll<HTMLButtonElement>('body > [aria-live] button[aria-label="Dismiss"]')) await click(b);
      await settle(900);
      expect(where()).toBe(before);
      expect(coveredControls()).toEqual([]);
    });
  }
});

describe('a banner under the transport', () => {
  for (const [w, hh] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh} the chip sits below the stall banner and never covers its keys, toast or not`, async () => {
      await lookAround(w, hh);
      act(() => patchRuntime({ stalled: STALL_MESSAGE }));
      const banner = await until(() => document.querySelector<HTMLElement>('[data-banners] [role="alert"]'), 'the banner');
      await settle(900);
      await chipPlaced();
      const check = (label: string) => {
        const c = chip()!.getBoundingClientRect();
        expect(chip()!.hasAttribute('data-ready'), `${label}: on screen`).toBe(true);
        expect(c.top, `${label}: below the banner`).toBeGreaterThanOrEqual(banner.getBoundingClientRect().bottom);
        for (const key of banner.querySelectorAll('button')) expect(overlaps(c, key.getBoundingClientRect()), `${label}: over ${key.textContent}`).toBe(false);
        expect(coveredControls(), `${label}: controls`).toEqual([]);
      };
      check('banner');
      act(() => notify('Saved in this browser.'));
      await until(() => toastCards().length > 0, 'a toast');
      await settle(1300);
      check('banner and toast');
    });
  }
});

describe('no room', () => {
  it('where every spot would cover a control, the chip waits off screen, and comes back once there is room', async () => {
    await lookAround();
    // Controls everywhere the chip could go (a stand-in for a crowded panel opening).
    const main = document.querySelector('main')!;
    const top = transport().getBoundingClientRect().bottom;
    for (let y = top; y < window.innerHeight; y += 30) {
      for (let x = 0; x < window.innerWidth; x += 60) {
        const b = document.createElement('button');
        b.textContent = '·';
        b.setAttribute('data-test-crowd', '');
        Object.assign(b.style, { position: 'fixed', left: `${x}px`, top: `${y}px`, width: '56px', height: '26px', zIndex: '1' });
        main.appendChild(b);
      }
    }
    await settle(900);
    await until(() => !chip()?.hasAttribute('data-ready'), 'the chip to step aside', 4000);
    // It never sits over a control meanwhile.
    expect(getComputedStyle(chip()!).visibility).toBe('hidden');
    for (const el of document.querySelectorAll('[data-test-crowd]')) el.remove();
    await until(() => chip()?.hasAttribute('data-ready'), 'the chip back', 6000);
    await chipPlaced();
    expect(coveredControls()).toEqual([]);
  });
});

describe('after a view switch', () => {
  it('the chip arrives at full opacity: a slide, never a fade', async () => {
    await lookAround();
    const tab = (name: string) => [...transport().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
    for (const view of ['Mix', 'Shape', 'Play']) {
      await click(tab(view));
      await until(() => chip()?.hasAttribute('data-ready'), `the chip in ${view}`);
      // Every frame of its entrance, and no animation of its opacity at all.
      for (let i = 0; i < 8; i++) {
        expect(getComputedStyle(chip()!).opacity, `${view}, frame ${i}`).toBe('1');
        for (const a of chip()!.getAnimations()) {
          const frames = (a.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
          expect(frames.some((k) => 'opacity' in k), `${view}: an opacity animation`).toBe(false);
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
  });
});
