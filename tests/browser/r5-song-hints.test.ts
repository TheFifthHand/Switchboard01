/**
 * The song's "Try this" steps in the running app, each done by the real
 * gesture with a real mouse: drag a loop in from the loop browser, stretch a
 * loop by its right edge, move a loop, click a bar number, press Play (Space).
 * The chip sits in the Song header's free middle while there is room, in
 * one line; with the header busy it never hangs under the ruler (the
 * timeline never draws over it). The first step says where Add loops is
 * while the loop browser is shut.
 */
import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hintsStore, markHintDone, showHintsAgain } from '../../src/app/views/hints/hintsState';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { session } from '../../src/app/instance';
import { setTipsEnabled } from '../../src/state/uiStore';
import { chipPlaced } from './r4-shell-chip';
import { barX, centre, clickAt, dragTo, edge, on, openSong, press, project, regions, resetSong, rowY, rt, settle, teardownSong, waitFor } from './r5-song-helpers';

const chip = () => document.querySelector<HTMLElement>('aside[data-hint]');
const hint = () => chip()?.dataset.hint ?? null;

beforeEach(resetSong);
afterEach(async () => {
  act(() => setTipsEnabled(false));
  await teardownSong();
});

it('the song steps are done by the real gestures, one after another', async () => {
  await openSong(1366, 768);
  act(() => {
    setTipsEnabled(true);
    showHintsAgain();
    for (const s of ['pad', 'mute', 'drag', 'tone', 'instrument', 'master', 'record'] as const) markHintDone(s);
  });
  await chipPlaced();
  // The song track became current when the Song view opened.
  expect(hintsStore.getState().song).toBe(true);
  expect(hint()).toBe('song-add');
  expect(chip()!.hasAttribute('data-ready')).toBe(true);
  // The loop browser is shut (the House song is long): the step says where its key is.
  expect(document.querySelector('[data-testid="loops-toggle"]')!.getAttribute('aria-pressed')).not.toBe('true');
  expect(chip()!.textContent).toContain('Press Add loops (top right)');
  // It sits in the header row, in one line.
  const head = document.querySelector('header[class*="head"]')!.getBoundingClientRect();
  const c = chip()!.getBoundingClientRect();
  expect(c.top).toBeLessThan(head.bottom);
  expect(c.bottom).toBeLessThanOrEqual(head.bottom + 8);

  act(() => ppbStore.setState(16));
  await settle();
  // 1. A loop from the browser onto its own row.
  await clickAt(centre(document.querySelector('[data-testid="loops-toggle"]')!));
  const bass = project().tracks[2];
  const chipEl = document.querySelector<HTMLElement>(`[data-chip="${bass.clips.find((x) => x)!.id}"]`)!;
  chipEl.scrollIntoView({ block: 'nearest' });
  // The Bass row is empty over bars 1–8 in the House song.
  await dragTo(centre(chipEl), { x: barX(0) + 4, y: rowY(bass.id) });
  await waitFor(() => hint() === 'song-stretch', 'the stretch step');

  // 2. Its right edge, two bars longer.
  const added = regions().find((r) => r.trackId === bass.id && r.start === 0)!;
  const grip = edge(added.id, 'end');
  await dragTo(grip, { x: grip.x + 2 * 16, y: grip.y });
  await waitFor(() => hint() === 'song-move', 'the move step');

  // 3. Moved two bars on.
  const from = on(added.id, 0.4);
  await dragTo(from, { x: from.x + 2 * 16, y: from.y });
  await waitFor(() => hint() === 'song-ruler', 'the ruler step');

  // 4. A bar number.
  const ruler = document.querySelector('[data-ruler]')!.getBoundingClientRect();
  await clickAt({ x: barX(8) + 3, y: ruler.bottom - 8 });
  expect(rt().songCursor).toBe(8);
  await waitFor(() => hint() === 'song-play', 'the play step');

  // 5. Space plays the song.
  await press(' ');
  await waitFor(() => rt().playing && rt().mode === 'song', 'the song to play');
  await waitFor(() => hint() === 'song-export', 'the export step');
});

it('with the header busy, the chip is never under the ruler: drawn on top wherever it sits, and never over the loop band', async () => {
  await openSong(1366, 768);
  act(() => {
    setTipsEnabled(true);
    showHintsAgain();
    for (const s of ['pad', 'mute', 'drag', 'tone', 'instrument', 'master', 'record'] as const) markHintDone(s);
  });
  await chipPlaced();
  // A loop range on the Loop key ("Loop · Bars 9–24") and the pads playing (their chip): a crowded header.
  const ruler = document.querySelector('[data-ruler]')!.getBoundingClientRect();
  await dragTo({ x: barX(8) + 3, y: ruler.bottom - 8 }, { x: barX(24) + 3, y: ruler.bottom - 8 });
  await act(async () => {
    await session.play();
  });
  await waitFor(() => !!document.querySelector('[data-testid="pads-playing"]'), 'the pads chip');
  await chipPlaced();
  const c = chip()!;
  if (!c.hasAttribute('data-ready')) return; // No room anywhere: it waits unseen (the rulebook's rule).
  const box = c.getBoundingClientRect();
  const band = document.querySelector('[data-range-band]')!.getBoundingClientRect();
  expect(box.bottom <= band.top || box.top >= band.bottom || box.right <= band.left || box.left >= band.right).toBe(true);
  // Whatever it sits over, it is drawn on top: every corner of its words is the chip's.
  const text = c.querySelector<HTMLElement>('[class*="text"]') ?? c;
  const t = text.getBoundingClientRect();
  for (const [x, y] of [
    [t.left + 4, t.top + 4],
    [t.right - 4, t.bottom - 4],
    [t.left + 4, t.bottom - 4],
  ]) expect(c.contains(document.elementFromPoint(x, y))).toBe(true);
});
