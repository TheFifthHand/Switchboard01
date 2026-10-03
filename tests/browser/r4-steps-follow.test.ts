/**
 * Follow (PLAY-14) with the real Jump In and the audio clock, on House · Chords · Stabs
 * (4 bars, playing): with Follow on, the shown bar turns with the bar that is heard; a pointer
 * held down in the editor holds it back until it is let go; with Follow off the bar stays.
 * The toggle is remembered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { TICKS_PER_BAR } from '../../src/project/types';
import { setStepsFollow, uiStore } from '../../src/state/uiStore';
import { act } from 'react';
import { button, setUp, tearDown } from './r4-play-helpers';
import { centre, click, mouse, settleFrames } from './r4-uikit-input';
import { CHORDS, openSteps, page, tabs } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(async () => {
  act(() => setStepsFollow(false));
  await tearDown();
});

/** The bar of Stabs that is heard now (from the transport's audible position). */
function heardBar(): number {
  const t = session.transport!;
  const ph = t.clipPhase(CHORDS)!;
  const rel = (((t.audibleTick() - ph.startTick) % ph.lengthTicks) + ph.lengthTicks) % ph.lengthTicks;
  return Math.floor(rel / TICKS_PER_BAR);
}

const BAR_MS = (60 / 124) * 4 * 1000;

async function watch(ms: number, each: () => void): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await settleFrames(1);
    each();
  }
}

describe('Follow (PLAY-14)', () => {
  it('turns the shown bar with the heard bar; a held pointer holds it back; off, the bar stays', async () => {
    await openSteps(CHORDS, 1, { play: true });
    expect(session.transport!.clipPhase(CHORDS)?.slot).toBe(1);
    const follow = button('Follow')!;
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    await click(centre(follow));
    expect(uiStore.getState().stepsFollow).toBe(true);
    expect(follow.getAttribute('aria-pressed')).toBe('true');

    // Over two and a half bars the shown page changes, and (away from the bar line) it is the heard one.
    const seen = new Set<number>();
    let agree = 0;
    let checked = 0;
    await watch(BAR_MS * 2.5, () => {
      seen.add(page(CHORDS));
      const t = session.transport!;
      const ph = t.clipPhase(CHORDS)!;
      const inBar = ((((t.audibleTick() - ph.startTick) % ph.lengthTicks) + ph.lengthTicks) % ph.lengthTicks) % TICKS_PER_BAR;
      if (inBar < 40 || inBar > TICKS_PER_BAR - 40) return;
      checked++;
      if (page(CHORDS) === heardBar()) agree++;
      // The heard bar's key carries the play lamp.
    });
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect(checked).toBeGreaterThan(10);
    expect(agree / checked).toBeGreaterThan(0.9);
    expect(tabs()[page(CHORDS)].hasAttribute('data-live')).toBe(true);

    // A pointer pressed in the editor (on the step ruler) holds the page while bars go by.
    const num = document.querySelector<HTMLElement>('[data-cells] [data-ph-step="2"]')!;
    const p = centre(num);
    const held = page(CHORDS);
    await mouse('mouseMoved', p);
    await mouse('mousePressed', p);
    await watch(BAR_MS * 1.3, () => expect(page(CHORDS)).toBe(held));
    await mouse('mouseReleased', p);
    await watch(BAR_MS * 0.6, () => {});
    expect(page(CHORDS)).not.toBe(held);

    // Off: the bar stays where it is.
    await click(centre(follow));
    expect(uiStore.getState().stepsFollow).toBe(false);
    const stay = page(CHORDS);
    await watch(BAR_MS * 1.3, () => expect(page(CHORDS)).toBe(stay));
  });
});
