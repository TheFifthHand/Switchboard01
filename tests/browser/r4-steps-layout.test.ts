/**
 * The Steps header stays two rows and leaves the roll its room (fix round M4), on the House
 * starter in Simple and Advanced mode:
 * - the bar line (bar keys, Follow, grid, tools) is one line: tools fold into a "⋯" menu when
 *   they would wrap;
 * - the roll shows at least 18 rows at 1366 x 768, 16 at 1280 x 720 and 13.5 at 1024 x 768
 *   (in Simple mode; Advanced adds the cables bar under the editor);
 * - the header is at most 80 px for melodic and drum parts at 1366 and 1280;
 * - every control in the header is at least 32 x 32 px, and the folded tools open from the
 *   keyboard.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { setUiMode } from '../../src/state/uiStore';
import { menu, press, setUp, tearDown } from './r4-play-helpers';
import { settleFrames } from './r4-uikit-input';
import { BASS, CHORDS, openSteps, scroller } from './r4-steps-helpers';

beforeEach(setUp);
afterEach(async () => {
  act(() => setUiMode('simple'));
  await tearDown();
});

const head = () => document.querySelector<HTMLElement>('[data-steps-root]')!.firstElementChild as HTMLElement;
const barLine = () => head().children[1] as HTMLElement;
const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

function measure() {
  const line = barLine();
  const items = [...line.children].filter(visible);
  const tops = items.map((k) => Math.round(k.getBoundingClientRect().top));
  const lineHeight = line.getBoundingClientRect().height;
  const controls = [...head().querySelectorAll<HTMLElement>('button, select, input')].filter(visible);
  const small = controls
    .map((c) => ({ c, r: c.getBoundingClientRect() }))
    .filter(({ r }) => r.width < 31.5 || r.height < 31.5)
    .map(({ c, r }) => `${c.getAttribute('aria-label') ?? c.textContent?.trim()} ${Math.round(r.width)}x${Math.round(r.height)}`);
  return {
    oneLine: Math.max(...tops) - Math.min(...tops) <= 4 && lineHeight <= 40,
    headH: head().getBoundingClientRect().height,
    rows: document.querySelector('[data-testid="pitch-roll"]') ? scroller().clientHeight / 18 : null,
    small,
  };
}

const SIZES = [
  { w: 1366, h: 768, rows: 18, head: 80 },
  { w: 1280, h: 720, rows: 16, head: 80 },
  { w: 1024, h: 768, rows: 13.5, head: null },
] as const;

describe('Steps header fits two rows (M4)', () => {
  for (const s of SIZES) {
    it(`${s.w} x ${s.h}: Chords (4 and 8 bars, Simple and Advanced), Bass and Drums`, async () => {
      await openSteps(CHORDS, 1, { w: s.w, h: s.h });
      const cases: { what: string; setup?: () => void; drums?: boolean }[] = [
        { what: 'Chords, 4 bars' },
        { what: 'Chords, 8 bars', setup: () => void cmd.duplicateClipContent(session.store, CHORDS, 1) },
        { what: 'Chords, 8 bars, Advanced', setup: () => setUiMode('advanced') },
      ];
      for (const c of cases) {
        if (c.setup) act(c.setup);
        await settleFrames(4);
        const m = measure();
        expect(m.oneLine, `${c.what}: the bar line is one line`).toBe(true);
        expect(m.small, `${c.what}: controls under 32 px`).toEqual([]);
        // (Advanced adds the cables bar under the editor, which is not the header's doing: rows are checked in Simple.)
        if (!c.what.includes('Advanced')) expect(m.rows!, `${c.what}: roll rows`).toBeGreaterThanOrEqual(s.rows);
        if (s.head) expect(m.headH, `${c.what}: header height`).toBeLessThanOrEqual(s.head);
      }
      act(() => setUiMode('simple'));
      for (const [trackId, slot, what] of [
        [BASS, 1, 'Bass'],
        ['t1', 1, 'Drums'],
      ] as const) {
        await openSteps(trackId, slot, { w: s.w, h: s.h });
        await settleFrames(4);
        const m = measure();
        expect(m.oneLine, `${what}: the bar line is one line`).toBe(true);
        expect(m.small, `${what}: controls under 32 px`).toEqual([]);
        if (trackId === BASS) expect(m.rows!, `${what}: roll rows`).toBeGreaterThanOrEqual(s.rows);
        if (s.head) expect(m.headH, `${what}: header height`).toBeLessThanOrEqual(s.head);
      }
    });
  }

  it('folded tools stay reachable: at 1024 x 768 the "⋯" key opens them from the keyboard', async () => {
    await openSteps(CHORDS, 1, { w: 1024, h: 768 });
    await settleFrames(4);
    const more = barLine().querySelector<HTMLButtonElement>('button[aria-haspopup="menu"][aria-label$="tools"]')!;
    expect(more).not.toBeNull();
    more.focus();
    await press('{Enter}');
    const m = menu()!;
    expect(m).not.toBeNull();
    const items = [...m.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) => i.querySelector('[class*="itemText"]')?.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(['Copy bar 1', 'Paste onto bar 1', 'Copy bar 1 to bar 2', 'Clear bar 1']));
    await press('{Escape}');
    expect(menu()).toBeNull();
  });

  it('at 1920 x 1080 nothing folds: the bar tools and Timing… are on the line', async () => {
    await openSteps(CHORDS, 1, { w: 1920, h: 1080 });
    await settleFrames(4);
    const names = [...barLine().querySelectorAll<HTMLElement>('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(['Copy bar 1', 'Paste onto bar 1', 'To bar 2', 'Clear bar 1', 'Timing…']));
    expect(barLine().querySelector('button[aria-haspopup="menu"][aria-label$="tools"]')).toBeNull();
  });
});
