/**
 * Scene cards can be heard (scene-cards-silent): ▶ on a card, while nothing
 * plays, launches that scene on the live pads and stops after one pass (the
 * stop is queued for the bar line where the pass ends, on the audio clock);
 * a second press stops at once. While the song plays the key is unavailable
 * and says "Stop the song to audition". The real transport and real clicks,
 * the running app at 1366 × 768, 1920 × 1080 and 200 % (960 × 540).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { auditionedScene } from '../../src/app/views/arrange/ScenePalette';
import { TICKS_PER_BAR } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { card, centre, clickAt, mouse, openApp, project, resetArrange, rt, sceneId, settle, teardownArrange } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const hear = (name: string) => card(name).querySelector<HTMLButtonElement>('[data-testid="scene-audition"]')!;
const playingRows = () => Object.values(rt().tracks).map((t) => t.playingSlot);

async function press(name: string) {
  const b = hear(name);
  b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await settle(30);
  const was = rt().playing;
  await clickAt(centre(b));
  // The first sound of the session waits for the audio to start.
  for (let i = 0; i < 40 && rt().playing === was; i++) await settle(50);
  await settle(50);
}

/** The tooltip bubble's text on screen (it is aria-hidden: the control is described by it instead). */
const bubble = () => [...document.querySelectorAll<HTMLElement>('[data-side][data-ready]')].map((t) => t.textContent).join(' ');

describe('hearing a scene from its card', () => {
  it('1366 x 768: one pass on the pads, then it stops by itself at the bar line where the pass ends', async () => {
    await openApp(1366, 768);
    act(() => void cmd.setBpm(session.store, 240));
    const bars = 4;
    expect(card('Groove').textContent).toContain(`${bars} bars`);
    await press('Groove');
    expect(rt().playing).toBe(true);
    expect(rt().mode).toBe('live');
    expect(auditionedScene()).toBe(sceneId('Groove'));
    expect(hear('Groove').getAttribute('aria-pressed')).toBe('true');
    expect(hear('Groove').getAttribute('aria-label')).toBe('Stop hearing Groove');
    expect(card('Groove').textContent).toContain('Playing once');
    // Groove's row plays on the pads.
    expect(playingRows().filter((s) => s === 1).length).toBeGreaterThan(0);
    // Watch the transport (one bar is 1 s at 240 BPM): the parts stop at the pass's end, then the transport.
    const end = bars * TICKS_PER_BAR;
    let lastTick = 0;
    let clipsOffAt: number | null = null;
    await act(async () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 6500 && rt().playing) {
        await new Promise((r) => requestAnimationFrame(r));
        if (!session.transport?.playing) break;
        const tick = session.transport.getPosition().tick;
        lastTick = Math.max(lastTick, tick);
        if (clipsOffAt === null && playingRows().every((s) => s === null)) clipsOffAt = tick;
      }
    });
    expect(rt().playing).toBe(false);
    // The pass played to its end (not cut short) and nothing ran on for another bar; if the parts were seen
    // stopping before the transport did, that was at the pass's end too.
    expect(lastTick).toBeGreaterThanOrEqual(end - TICKS_PER_BAR / 8);
    expect(lastTick).toBeLessThan(end + TICKS_PER_BAR / 2);
    if (clipsOffAt !== null) expect(clipsOffAt).toBeGreaterThanOrEqual(end - TICKS_PER_BAR / 8);
    await settle(100);
    expect(auditionedScene()).toBeNull();
    expect(hear('Groove').getAttribute('aria-pressed')).toBe('false');
  });

  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: a second press stops at once; while the song plays ▶ is unavailable and says why`, async () => {
      await openApp(w, hh);
      await press('Lift');
      expect(rt().playing).toBe(true);
      expect(auditionedScene()).toBe(sceneId('Lift'));
      await settle(300);
      await press('Lift');
      expect(rt().playing).toBe(false);
      expect(auditionedScene()).toBeNull();
      // The song plays: every ▶ is unavailable, with the reason on hover.
      await act(async () => {
        await session.playSong();
      });
      await settle(150);
      for (const s of project().scenes) expect(hear(s.name).getAttribute('aria-disabled')).toBe('true');
      const b = hear('Intro');
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await settle(30);
      await mouse('mouseMoved', centre(b));
      await settle(900);
      expect(bubble()).toContain('Stop the song to audition');
      // Said to a screen reader too.
      const desc = b.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      expect(desc).toContain('Stop the song to audition');
      await clickAt(centre(b));
      expect(rt().mode).toBe('song');
      expect(auditionedScene()).toBeNull();
      await mouse('mouseMoved', { x: 2, y: 2 });
    });
  }
});
