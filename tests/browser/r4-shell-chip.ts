/**
 * Waiting for the "Try this" chip to find its spot. It places itself after
 * the view has painted, in idle time, and looks again a moment later
 * (Hints.tsx): so a check of where it sits waits until it is on screen and
 * has stopped moving, rather than for a fixed time, which a busy machine can
 * outrun.
 */
import { act } from 'react';

const chip = () => document.querySelector<HTMLElement>('[data-hint]');

/** One placement round of the chip's: the next paint, idle time after it, and its second look (200 ms) with room to spare. */
const round = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestIdleCallback(() => resolve(), { timeout: 1000 })));
    await new Promise<void>((resolve) => setTimeout(resolve, 260));
  });

const where = () => {
  const c = chip();
  return c ? `${c.hasAttribute('data-ready')}|${c.dataset.hint}|${c.style.left}|${c.style.top}|${c.style.maxWidth}|${c.offsetWidth}x${c.offsetHeight}` : 'none';
};

/** Until the chip (when there is one) is on screen and still in the same place, at the same size, after a whole round (at most about 10 s). */
export async function chipPlaced(): Promise<void> {
  let last = where();
  for (let i = 0; i < 30; i++) {
    await round();
    const now = where();
    if (now === last && (!chip() || chip()!.hasAttribute('data-ready'))) return;
    last = now;
  }
}
