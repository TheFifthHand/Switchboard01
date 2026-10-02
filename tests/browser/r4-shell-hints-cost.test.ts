/**
 * What the "Try this" chip costs (perf-02, shell-15, design-09), measured in
 * the running app with real mouse input:
 * - a Play → Mix switch shows Mix as fast with the hints on as with them
 *   hidden (within 1.3×): the chip finds its new spot after the new view has
 *   painted, in idle time, never in the click's own work;
 * - during a drag of a song block's right edge the chip does not move (no
 *   placing or checking while a pointer is pressed); it may move after the
 *   release.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { hideHints, showHintsAgain, markHintDone } from '../../src/app/views/hints/hintsState';
import { mouse, settleFrames } from './r4-uikit-input';
import { button, click, closeShell, openShell, settle, transport, until } from './r4-shell-harness';

afterEach(closeShell);

const chip = () => document.querySelector<HTMLElement>('aside[data-hint]');
const tab = (name: string) => [...transport().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
const heading = () => document.querySelector('main h1')?.textContent ?? '';

/**
 * Click a view tab with the real mouse and time it: from the click (its
 * event time) to the first animation frame in which the new view is in the
 * page (its h1 names it), i.e. the frame that paints it.
 */
async function timeSwitch(name: string): Promise<number> {
  const el = tab(name);
  const r = el.getBoundingClientRect();
  const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  let clickAt = 0;
  const onClick = (e: Event) => {
    clickAt = e.timeStamp;
  };
  el.addEventListener('click', onClick, { capture: true, once: true });
  const shown = new Promise<number>((resolve) => {
    const frame = (t: number) => {
      if (clickAt && heading().includes(`— ${name} ·`)) resolve(t);
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await mouse('mouseMoved', p);
  await mouse('mousePressed', p);
  await mouse('mouseReleased', p);
  const at = await shown;
  await settleFrames(2);
  return at - clickAt;
}

/** Until the page is idle: whatever an earlier step set going (a placement, a render) has finished, in both conditions alike. */
const idle = () => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 2000 }));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe('the cost of the hints', () => {
  it('a Play → Mix switch paints Mix within 1.3× of the time it takes with the hints hidden', async () => {
    await openShell();
    await click(button('Just look around')!);
    await until(() => chip()?.hasAttribute('data-ready'), 'the chip');
    // Warm up both views once (first mounts load code and fonts).
    await timeSwitch('Mix');
    await timeSwitch('Play');
    const on: number[] = [];
    const off: number[] = [];
    for (let round = 0; round < 8; round++) {
      // Interleaved, so a busy moment of the machine falls on both alike.
      for (const hints of round % 2 ? [false, true] : [true, false]) {
        act(() => {
          if (hints) {
            showHintsAgain();
            markHintDone('pad');
          } else hideHints();
        });
        if (hints) await until(() => chip()?.hasAttribute('data-ready'), 'the chip on screen');
        await settle(400);
        if (!hints) expect(chip()).toBeNull();
        await idle();
        (hints ? on : off).push(await timeSwitch('Mix'));
        await settle(400);
        await idle();
        await timeSwitch('Play');
        await settle(200);
      }
    }
    const ratio = median(on) / median(off);
    // eslint-disable-next-line no-console
    console.log(`Play → Mix, click to Mix painted: hints on ${median(on).toFixed(1)} ms, hidden ${median(off).toFixed(1)} ms, ratio ${ratio.toFixed(2)} (on ${on.map((x) => x.toFixed(0)).join(' ')}; off ${off.map((x) => x.toFixed(0)).join(' ')})`);
    expect(ratio).toBeLessThanOrEqual(1.3);
  });

  it('during a drag of a block’s right edge the chip does not move', async () => {
    await openShell();
    await click(button('Just look around')!);
    await click(tab('Arrange'));
    const c = await until(() => (chip()?.dataset.hint === 'song-play' && chip()?.hasAttribute('data-ready') ? chip() : null), 'the chip in Arrange');
    await settle(700);
    const edge = await until(() => document.querySelector<HTMLElement>('[data-edge]'), 'a block edge');
    const r = edge.getBoundingClientRect();
    const start = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    // Where placement put it (its own left / top; the entrance animation may still be easing its box into place).
    const at = () => `${c.style.left},${c.style.top},${c.style.maxWidth}`;
    const before = at();
    const seen = new Set<string>();
    await mouse('mouseMoved', start);
    await mouse('mousePressed', start);
    for (let i = 1; i <= 30; i++) {
      await mouse('mouseMoved', { x: start.x + i * 6, y: start.y }, { buttons: 1 });
      await new Promise((res) => requestAnimationFrame(res));
      seen.add(at());
      // Long enough for the chip's periodic check to have come round several times.
      if (i % 10 === 0) await new Promise((res) => setTimeout(res, 650));
    }
    expect([...seen]).toEqual([before]);
    await mouse('mouseReleased', { x: start.x + 180, y: start.y });
    await settle(900);
    // After the release it looks again (and never sits over a control).
    expect(chip()).not.toBeNull();
  });
});
