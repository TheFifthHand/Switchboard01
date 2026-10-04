/**
 * The part headers and a finger. Each row's header names the part and its
 * sound; its Mute and Solo keys change the part (what the song plays) and the
 * row says so in words. With touch (real CDP touch input, touch emulation on):
 * a swipe scrolls the song and moves nothing; a finger that rests first picks
 * a loop up and moves it in whole bars (the song does not pan under it); a tap
 * selects a loop, and a tap on the ruler moves the playhead.
 */
import { act } from 'react';
import { cdp } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { TOUCH_HOLD_MS } from '../../src/ui/components';
import type { Project } from '../../src/project/types';
import { touch } from './r4-uikit-input';
import { barX, centre, clickAt, on, openSong, project, regionEl, regions, region, resetSong, rt, scroller, settle, teardownSong, undoCount, type Pt } from './r5-song-helpers';

const head = (trackId: string) => document.querySelector<HTMLElement>(`[data-lane-row="${trackId}"] [data-part-head]`)!;
const key = (trackId: string, kind: 'mute' | 'solo') => head(trackId).querySelector<HTMLButtonElement>(`[data-kind="${kind}"]`)!;
const lane = (trackId: string) => document.querySelector<HTMLElement>(`[data-lane="${trackId}"]`)!;

beforeEach(resetSong);
afterEach(teardownSong);

describe('part headers', () => {
  it('name the part and its sound; Mute and Solo change the part, and the row says so in words', async () => {
    await openSong(1366, 768);
    const [drums, , bass] = project().tracks;
    expect(head(bass.id).textContent).toContain(bass.name);
    expect(key(bass.id, 'mute').getAttribute('aria-label')).toBe(`Mute ${bass.name}`);
    // Mute the bass: the part is muted, the key is pressed and the row reads "Muted".
    await clickAt(centre(key(bass.id, 'mute')));
    expect(project().tracks[2].mute).toBe(true);
    expect(key(bass.id, 'mute').getAttribute('aria-pressed')).toBe('true');
    expect(head(bass.id).textContent).toContain('Muted');
    expect(lane(bass.id).getAttribute('aria-label')).toContain('(muted)');
    await clickAt(centre(key(bass.id, 'mute')));
    expect(project().tracks[2].mute).toBe(false);
    expect(head(bass.id).textContent).not.toContain('Muted');
    // Solo the drums: every other row says it is not soloed.
    await clickAt(centre(key(drums.id, 'solo')));
    expect(project().tracks[0].solo).toBe(true);
    expect(head(drums.id).textContent).toContain('Solo');
    expect(head(bass.id).textContent).toContain('Not soloed');
    expect(lane(bass.id).getAttribute('aria-label')).toContain('(not soloed)');
    await clickAt(centre(key(drums.id, 'solo')));
    expect(project().tracks[0].solo).toBe(false);
    expect(head(bass.id).textContent).not.toContain('Not soloed');
  });

  it('the keys are at least 32 px and the header stays put while the song scrolls', async () => {
    await openSong(1366, 768);
    const bass = project().tracks[2];
    for (const kind of ['mute', 'solo'] as const) {
      const r = key(bass.id, kind).getBoundingClientRect();
      expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(32);
    }
    const before = head(bass.id).getBoundingClientRect().left;
    act(() => ppbStore.setState(64));
    await settle(200);
    scroller().scrollLeft = 600;
    await settle(120);
    expect(scroller().scrollLeft).toBeGreaterThan(300);
    expect(head(bass.id).getBoundingClientRect().left).toBeCloseTo(before, 0);
  });
});

/** A song with room to scroll: A on the drums at bar 11, B on the bass at bar 3, and a loop far along. */
function song(p: Project): void {
  const d = p.tracks[0];
  const b = p.tracks[2];
  const dc = d.clips.find((c) => c)!.id;
  const bc = b.clips.find((c) => c)!.id;
  p.arrangement.regions = [region('B', b.id, bc, 2, 4), region('A', d.id, dc, 10, 4), region('Z', b.id, bc, 72, 4)];
  p.arrangement.sections = [];
}

/** A finger from `a` to `b`: resting `restMs` first, then `steps` moves a frame apart. */
async function finger(a: Pt, b: Pt, restMs: number, steps = 12): Promise<void> {
  await touch('touchStart', [a]);
  if (restMs) await settle(restMs);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }]);
    await new Promise((r) => requestAnimationFrame(r));
  }
  await touch('touchEnd', []);
  await settle(150);
}

async function tap(p: Pt): Promise<void> {
  await touch('touchStart', [p]);
  await touch('touchEnd', []);
  await settle(120);
}

describe('with a finger', () => {
  beforeEach(async () => {
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  });
  afterEach(async () => {
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
  });

  it('a swipe scrolls the song and moves nothing; a rest first picks a loop up and moves it in whole bars', async () => {
    await openSong(1366, 768, song);
    act(() => ppbStore.setState(32));
    await settle(200);
    const sc = scroller();
    expect(sc.scrollWidth).toBeGreaterThan(sc.clientWidth + 400);
    const undo = undoCount();
    // A quick swipe to the left that starts on loop A: the song scrolls on, A stays where it is.
    const a = on('A');
    await finger(a, { x: a.x - 300, y: a.y }, 0);
    await settle(300);
    expect(sc.scrollLeft).toBeGreaterThan(150);
    expect(regions().find((r) => r.id === 'A')!.start).toBe(10);
    expect(undoCount()).toBe(undo);
    // Back to the start; a finger that rests on A, then moves three bars right.
    sc.scrollLeft = 0;
    await settle(150);
    const from = on('A');
    await touch('touchStart', [from]);
    await settle(TOUCH_HOLD_MS + 80);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', [{ x: from.x + (3 * 32 * i) / 12, y: from.y }]);
      await new Promise((r) => requestAnimationFrame(r));
    }
    // The finger owns the loop: the song did not pan under it.
    expect(sc.scrollLeft).toBeLessThanOrEqual(1);
    await touch('touchEnd', []);
    await settle(150);
    expect(regions().find((r) => r.id === 'A')!.start).toBe(13);
    expect(undoCount()).toBe(undo + 1);
  });

  it('a tap selects a loop; a tap on the ruler moves the playhead there', async () => {
    await openSong(1366, 768, song);
    act(() => ppbStore.setState(32));
    await settle(200);
    await tap(on('B'));
    expect(regionEl('B').getAttribute('aria-pressed')).toBe('true');
    const ruler = document.querySelector('[data-ruler]')!.getBoundingClientRect();
    await tap({ x: barX(6) + 4, y: ruler.bottom - 8 });
    expect(rt().songCursor).toBe(6);
    expect(rt().playing).toBe(false);
  });
});
