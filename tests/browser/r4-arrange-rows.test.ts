/**
 * Vertical room is shared out well (vertical-room, design-03): one take no
 * longer shrinks the song's rows, because the Performances panel folds to one
 * line even with takes ("1 take ▸") and remembers that; on a tall window the
 * rows grow to 48 px with 13 px part names and the lane leaves at most 120 px
 * empty under the blocks. The running app at 1366 × 768, 1920 × 1080 and
 * 200 % (960 × 540), real clicks.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROW_MAX_PX } from '../../src/app/views/arrange/songLayout';
import { cleanup } from './ui-harness';
import { blockIds, cellEl, centre, clickAt, lane, openApp, project, resetArrange, sceneTake, settle, teardownArrange } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const panel = () => document.querySelector<HTMLElement>('[data-testid="performances"]')!;
const rowHeight = () => cellEl(blockIds()[1], project().tracks[0].id).getBoundingClientRect().height;
const nameFont = () => parseFloat(getComputedStyle(document.querySelector<HTMLElement>('[data-name-row] [aria-haspopup="menu"]')!).fontSize);
/** Empty lane under the last part row (px). */
function emptyUnder(): number {
  const tracks = project().tracks;
  const last = cellEl(blockIds()[1], tracks[tracks.length - 1].id).getBoundingClientRect();
  return lane().getBoundingClientRect().bottom - last.bottom;
}

/** The app again (as after a reload: what is remembered comes back), with the take added again. */
async function reopen(w: number, hh: number) {
  act(() => cleanup());
  await openApp(w, hh);
  sceneTake([[0, 2], [1, 2]]);
  await settle(200);
}

describe('rows, the Performances bar and the empty band', () => {
  it('1366 x 768: one take folds to "1 take ▸" and the rows keep their size; open and fold are remembered', async () => {
    await openApp(1366, 768);
    const before = rowHeight();
    expect(before).toBeGreaterThanOrEqual(32);
    sceneTake([[0, 2], [1, 2]]);
    await settle(200);
    // One line, saying how many takes, with the way to open it.
    expect(panel().hasAttribute('data-collapsed')).toBe(true);
    expect(panel().getBoundingClientRect().height).toBeLessThanOrEqual(52);
    const open = panel().querySelector<HTMLButtonElement>('[data-testid="takes-open"]')!;
    expect(open.textContent).toBe('1 take');
    expect(open.querySelector('svg')).not.toBeNull();
    expect(open.getAttribute('aria-expanded')).toBe('false');
    // The take did not cost the song its rows.
    expect(rowHeight()).toBe(before);

    // Opened: the take list shows; the rows give way but stay comfortable targets.
    await clickAt(centre(open));
    await settle(200);
    expect(panel().hasAttribute('data-collapsed')).toBe(false);
    expect(document.querySelector('[data-testid="take-list"]')).not.toBeNull();
    expect(rowHeight()).toBeGreaterThanOrEqual(18);
    // Remembered: the app opened again shows it open.
    await reopen(1366, 768);
    expect(panel().hasAttribute('data-collapsed')).toBe(false);
    // Folded: remembered too.
    await clickAt(centre(document.querySelector<HTMLElement>('[data-testid="takes-fold"]')!));
    await settle(200);
    expect(panel().hasAttribute('data-collapsed')).toBe(true);
    expect(rowHeight()).toBe(before);
    await reopen(1366, 768);
    expect(panel().hasAttribute('data-collapsed')).toBe(true);
    expect(rowHeight()).toBe(before);
  });

  it(`1920 x 1080: rows grow to ${ROW_MAX_PX} px with 13 px names, and at most 120 px of the lane is empty under them`, async () => {
    await openApp(1920, 1080);
    expect(rowHeight()).toBe(ROW_MAX_PX);
    expect(nameFont()).toBe(13);
    expect(emptyUnder()).toBeLessThanOrEqual(120);
    expect(emptyUnder()).toBeGreaterThanOrEqual(0);
    // With a take: the panel has room here, so it shows (until the user folds it); the rows stay as they were.
    sceneTake([[0, 2], [1, 2]]);
    await settle(250);
    expect(panel().hasAttribute('data-collapsed')).toBe(false);
    expect(rowHeight()).toBe(ROW_MAX_PX);
    expect(emptyUnder()).toBeLessThanOrEqual(120);
    // Folded, the lane takes the room: still at most 120 px empty, rows unchanged.
    await clickAt(centre(document.querySelector<HTMLElement>('[data-testid="takes-fold"]')!));
    await settle(250);
    expect(panel().hasAttribute('data-collapsed')).toBe(true);
    expect(rowHeight()).toBe(ROW_MAX_PX);
    expect(emptyUnder()).toBeLessThanOrEqual(120);
  });

  it('200 % (960 x 540): the page scrolls instead, the rows keep their size, nothing scrolls sideways', async () => {
    await openApp(960, 540);
    const page = document.scrollingElement!;
    expect(page.scrollHeight).toBeGreaterThan(page.clientHeight);
    expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
    const h = rowHeight();
    expect(h).toBeGreaterThanOrEqual(24);
    sceneTake([[0, 2], [1, 2]]);
    await settle(200);
    expect(panel().hasAttribute('data-collapsed')).toBe(true);
    expect(rowHeight()).toBe(h);
    expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  });
});
