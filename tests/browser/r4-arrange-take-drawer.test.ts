/**
 * A take's events open in a tall side drawer (take-editor-cramped): its
 * header (Replay, Export, Make song blocks, close) stays put while the events
 * scroll under it, the song folds to its header row meanwhile, and the drawer
 * keeps the "Try this" chip off it (data-hint-avoid). Event times are the
 * music's bar.beat.step (take-timing), and the take can start later as well
 * as end earlier. The running app at 1366 × 768, 1920 × 1080 and 200 %
 * (960 × 540), real clicks and keys.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TICKS_PER_BAR, type PerformanceEvent } from '../../src/project/types';
import { addTake, blockIds, blockEl, centre, clickAt, press, project, resetArrange, settle, teardownArrange, openApp, wheelAt } from './r4-arrange-helpers';
import { act } from 'react';

beforeEach(resetArrange);
afterEach(teardownArrange);

const drawer = () => document.querySelector<HTMLElement>('[data-testid="take-drawer"]');
const songPanel = () => document.querySelector<HTMLElement>('section[aria-labelledby="song-title"]')!;

/** A take from bar 3 with `n` notes, one a beat, on the Lead part. */
function noteTake(n: number) {
  const start = 2 * TICKS_PER_BAR;
  const lead = project().tracks[4].id;
  const events: PerformanceEvent[] = [];
  for (let i = 0; i < n; i++) {
    const t = start + 10 + i * (TICKS_PER_BAR / 4);
    events.push({ t, type: 'noteOn', trackId: lead, pitch: 60 + (i % 12), velocity: 0.8, key: 'KeyA' });
    events.push({ t: t + 40, type: 'noteOff', trackId: lead, pitch: 60 + (i % 12), key: 'KeyA' });
  }
  return addTake(events, { name: 'Long take', startTick: start, bars: Math.ceil(n / 4) + 1 });
}

async function openEvents() {
  const open = document.querySelector<HTMLElement>('[data-testid="takes-open"]');
  if (open) {
    open.scrollIntoView({ block: 'center' });
    await settle(30);
    await clickAt(centre(open));
  }
  await settle(120);
  const expand = document.querySelector<HTMLElement>('button[aria-label="Show the events of Long take"]')!;
  expand.scrollIntoView({ block: 'center' });
  await clickAt(centre(expand));
  await settle(200);
}

describe('the take drawer', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: tall, beside the takes, with a header that stays while the events scroll; the song folds meanwhile`, async () => {
      await openApp(w, hh);
      noteTake(40);
      await settle(200);
      await openEvents();
      const d = drawer()!;
      expect(d).not.toBeNull();
      expect(d.hasAttribute('data-hint-avoid')).toBe(true);
      // Beside the take list, not under it.
      const list = document.querySelector<HTMLElement>('[data-testid="take-list"]')!.getBoundingClientRect();
      const box = d.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(list.right - 1);
      expect(Math.abs(box.top - list.top)).toBeLessThanOrEqual(2);
      // The song folds to its header row, with a way back.
      expect(songPanel().hasAttribute('data-folded')).toBe(true);
      const block = document.querySelector<HTMLElement>('[data-block-id]');
      expect(block === null || block.getBoundingClientRect().height === 0).toBe(true);
      // Only its header row is left (one line on a wide window; it wraps at 200 %).
      const songHead = songPanel().querySelector<HTMLElement>('header')!.getBoundingClientRect().height;
      expect(songPanel().getBoundingClientRect().height).toBeLessThanOrEqual(songHead + 32);
      if (w >= 1366) expect(songPanel().getBoundingClientRect().height).toBeLessThanOrEqual(100);
      expect(document.querySelector('[data-testid="show-song"]')).not.toBeNull();
      // Tall: most of the view's height (the page scrolls at 200 %, so there it keeps a useful minimum).
      expect(box.height).toBeGreaterThanOrEqual(w === 960 ? 260 : Math.min(600, hh * 0.5));
      // The header keeps Replay, Export, Make song blocks and Close at the top while the events scroll.
      const head = d.querySelector<HTMLElement>('header')!;
      for (const label of ['Replay Long take', 'Export Long take as WAV', 'Make song blocks from Long take', 'Close the events of Long take and show the song']) {
        expect(head.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
      }
      const body = head.nextElementSibling as HTMLElement;
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight + 100);
      const headTop = head.getBoundingClientRect().top;
      const firstRow = d.querySelector<HTMLElement>('[role="rowgroup"] [role="row"]')!;
      const rowTop = firstRow.getBoundingClientRect().top;
      // A real wheel over the events scrolls them under the header.
      const p = centre(body);
      await wheelAt({ x: p.x, y: Math.min(p.y, window.innerHeight - 30) }, 300);
      await settle(300);
      expect(body.scrollTop).toBeGreaterThan(100);
      expect(head.getBoundingClientRect().top).toBeCloseTo(headTop, 0);
      expect(firstRow.getBoundingClientRect().top).toBeLessThan(rowTop - 100);
      // Escape closes it: the song is back, focus not lost in a hidden drawer.
      head.querySelector<HTMLButtonElement>('[aria-label^="Close the events"]')!.focus();
      await press('Escape');
      await settle(200);
      expect(drawer()).toBeNull();
      expect(songPanel().hasAttribute('data-folded')).toBe(false);
      expect(blockEl(blockIds()[0]).getBoundingClientRect().height).toBeGreaterThan(100);
    });
  }

  it('times are the music’s bar.beat.step; Start later… starts the take there (one undo), beside End earlier…', async () => {
    await openApp(1366, 768);
    const id = noteTake(12);
    await settle(200);
    await openEvents();
    const d = drawer()!;
    // The take starts at bar 3: its first note reads 3.1.1, not 1.1.1.
    const times = [...d.querySelectorAll<HTMLElement>('[role="rowgroup"] [role="row"] [role="cell"]:first-child')].map((c) => c.textContent);
    expect(times[0]).toBe('3.1.1');
    expect(times[4]).toBe('4.1.1');
    const bounds = d.querySelector<HTMLElement>('[data-testid="take-bounds"]')!;
    expect(bounds.textContent).toContain('Starts at 3.1.1');
    const later = bounds.querySelector<HTMLButtonElement>('[data-take-start]')!;
    const earlier = bounds.querySelector<HTMLButtonElement>('[data-take-end]')!;
    expect(later.textContent).toBe('Start later…');
    expect(earlier.textContent).toBe('End earlier…');
    later.scrollIntoView({ block: 'center' });
    await clickAt(centre(later));
    const field = bounds.querySelector<HTMLInputElement>('input[aria-label^="New start of Long take"]')!;
    expect(document.activeElement).toBe(field);
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(field, '4.1.1');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Enter');
    await settle(100);
    const perf = project().performances.find((p) => p.id === id)!;
    expect(perf.startTick).toBe(3 * TICKS_PER_BAR);
    // The notes before bar 4 are gone from the list (they became the starting state); times stay absolute.
    const after = [...drawer()!.querySelectorAll<HTMLElement>('[role="rowgroup"] [role="row"] [role="cell"]:first-child')].map((c) => c.textContent);
    expect(after[0]).toBe('4.1.1');
    expect(drawer()!.querySelector('[data-testid="take-bounds"]')!.textContent).toContain('Starts at 4.1.1');
  });
});
