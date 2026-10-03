/**
 * The part names column and the headers stay readable and quick to reach
 * (review minors 4, 5 and 6):
 * - the column is one Tab stop (arrows move between parts and their Mute and
 *   Solo); the lane's view tools come before the blocks in the Tab order;
 * - it is narrow (the names and their state; 108 px), every name whole; on
 *   hover or keyboard focus it widens over the lane's edge (the lane does not
 *   move) and the part under the pointer shows Mute and Solo;
 * - a Mute or Solo key takes a press anywhere in 32 x 32 px around its centre
 *   however short the rows (200 %, or 1366 with Performances open);
 * - block headers show the whole name at rest (▶ and ⋯ on hover below
 *   150 px), and a helper's compact blocks put their step first ("1/4 Lift").
 * Real keys and mouse (CDP), the running app.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { blockEl, blockIds, byLabel, centre, clickAt, mouse, openApp, press, project, resetArrange, sceneTake, scroller, settle, teardownArrange, toggle, trackId } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const names = () => document.querySelector<HTMLElement>('[data-testid="part-names"]')!;
const row = (part: string) => names().querySelector<HTMLElement>(`[data-name-row][data-track="${trackId(part)}"]`)!;
const nameButton = (part: string) => row(part).querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
const key = (part: string, kind: 'Mute' | 'Solo') => names().querySelector<HTMLButtonElement>(`button[aria-label="${kind} ${part}"]`)!;
const label = (el: Element | null) => el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '';

describe('the keyboard', () => {
  it('from Loop, Tab reaches the view tools, then the part names (one stop), then the ruler and the blocks', async () => {
    await openApp(1366, 768);
    act(() => toggle().focus());
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await press('Tab');
      seen.push(label(document.activeElement));
    }
    // (The zoom level is unavailable while the song is fitted: no stop.)
    expect(seen.slice(0, 3)).toEqual(['Zoom out', 'Zoom in', 'Follow playhead']);
    expect(seen[3]).toBe('Drums: song actions for this part');
    expect(seen[4]).toMatch(/^Song position/);
    expect(seen[5]).toMatch(/^Block 1 of 6: Intro/);
    expect(seen.filter((s) => /^[A-Z][a-z]+(?: \(.+\))?: song actions for this part$|^(Mute|Solo) /.test(s)).length).toBe(1);
  });

  it('in the names column the arrows move between parts and their Mute and Solo; the column is still one stop', async () => {
    await openApp(1366, 768);
    act(() => nameButton('Drums').focus());
    await press('ArrowDown');
    expect(document.activeElement).toBe(nameButton('Percussion'));
    await press('ArrowRight');
    expect(document.activeElement).toBe(key('Percussion', 'Mute'));
    await press('ArrowRight');
    expect(document.activeElement).toBe(key('Percussion', 'Solo'));
    await press('ArrowUp');
    expect(document.activeElement).toBe(key('Drums', 'Solo'));
    await press('End');
    expect(document.activeElement).toBe(key('Vocal', 'Solo'));
    await press(' ');
    expect(project().tracks.find((t) => t.name === 'Vocal')!.solo).toBe(true);
    await press('Home');
    expect(document.activeElement).toBe(key('Drums', 'Solo'));
    await press('ArrowLeft');
    await press('ArrowLeft');
    expect(document.activeElement).toBe(nameButton('Drums'));
    // The one Tab stop is the key last used; Tab leaves the column.
    expect([...names().querySelectorAll('button')].filter((b) => b.tabIndex === 0)).toEqual([nameButton('Drums')]);
    await press('Tab');
    expect(label(document.activeElement)).toMatch(/^Song position/);
  });
});

describe('narrow, every name whole; wider on hover', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: 108 px of names with nothing cut; hovered, it widens over the lane (which stays put) and the row shows Mute and Solo`, async () => {
      await openApp(w, hh);
      names().scrollIntoView({ block: 'center' });
      await mouse('mouseMoved', { x: 2, y: 2 });
      await settle(60);
      expect(Math.round(names().getBoundingClientRect().width)).toBeLessThanOrEqual(110);
      for (const r of names().querySelectorAll<HTMLElement>('[class*="partNameText"]')) expect(r.scrollWidth, r.textContent!).toBeLessThanOrEqual(r.clientWidth + 0.5);
      const laneLeft = scroller().getBoundingClientRect().left;
      await mouse('mouseMoved', centre(nameButton('Percussion'), 0.2));
      await settle(80);
      expect(names().getBoundingClientRect().width).toBeGreaterThanOrEqual(150);
      expect(scroller().getBoundingClientRect().left).toBe(laneLeft);
      expect(key('Percussion', 'Mute').getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
      expect(key('Drums', 'Mute').getBoundingClientRect().width).toBe(0);
      const t = nameButton('Percussion').querySelector<HTMLElement>('[class*="partNameText"]')!;
      expect(t.scrollWidth).toBeLessThanOrEqual(t.clientWidth + 0.5);
      await mouse('mouseMoved', { x: 2, y: 2 });
    });
  }

  for (const [w, hh, takes] of [
    [960, 540, false],
    [1366, 768, true],
  ] as const) {
    it(`${w} x ${hh}${takes ? ' with Performances open' : ''}: a press anywhere 32 x 32 around a key's centre takes it, however short the row`, async () => {
      await openApp(w, hh);
      if (takes) {
        sceneTake([[0, 4]]);
        await settle(150);
        await clickAt(centre(document.querySelector<HTMLElement>('[data-testid="takes-open"]')!));
        await settle(200);
      }
      const rowH = row('Bass').getBoundingClientRect().height;
      expect(rowH).toBeLessThan(32);
      nameButton('Bass').scrollIntoView({ block: 'center' });
      await mouse('mouseMoved', centre(nameButton('Bass'), 0.2));
      await settle(60);
      for (const kind of ['Mute', 'Solo'] as const) {
        const k = key('Bass', kind);
        const c = centre(k);
        for (const [dx, dy] of [
          [0, -15],
          [0, 15],
          [-15, 0],
          [15, 0],
          [-14, -14],
          [14, 14],
        ]) {
          const hit = document.elementFromPoint(c.x + dx, c.y + dy);
          expect(hit && k.contains(hit), `${kind} at ${dx},${dy} (row ${Math.round(rowH)} px) hits ${hit?.className}`).toBe(true);
        }
      }
      // A real click at the edge of that area.
      const m = centre(key('Bass', 'Mute'));
      await clickAt({ x: m.x, y: m.y + 14 });
      expect(project().tracks.find((t) => t.name === 'Bass')!.mute).toBe(true);
    });
  }
});

describe('block headers', () => {
  it('1366 x 768: every block’s name is whole at rest (the last 8-bar Groove too); ▶ and ⋯ show on hover below 150 px', async () => {
    await openApp(1366, 768);
    await mouse('mouseMoved', { x: 2, y: 2 });
    await settle(60);
    for (const id of blockIds()) {
      const n = blockEl(id).querySelector<HTMLElement>('[class*="name"]')!;
      expect(n.scrollWidth, n.textContent!).toBeLessThanOrEqual(n.clientWidth + 0.5);
    }
    const last = blockEl(blockIds()[5]);
    const w = last.getBoundingClientRect().width;
    expect(w).toBeGreaterThanOrEqual(110);
    expect(w).toBeLessThan(150);
    const more = last.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-label*="block actions"]')!;
    expect(more.getBoundingClientRect().width).toBe(0);
    await mouse('mouseMoved', centre(last.querySelector<HTMLElement>('[class*="name"]')!, 0.2));
    await settle(40);
    expect(more.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
    await mouse('mouseMoved', { x: 2, y: 2 });
  });

  it('after Build up the compact blocks read 1/4 Lift … 4/4 Lift', async () => {
    await openApp(1366, 768);
    act(() => void cmd.shapeBlock(session.store, project().arrangement.blocks[2].id, 'build'));
    await settle(300);
    await mouse('mouseMoved', { x: 2, y: 2 });
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(60);
    const shown = blockIds()
      .slice(2, 6)
      .map((id) => {
        const n = blockEl(id).querySelector<HTMLElement>('[class*="name"]')!;
        return getComputedStyle(n, '::before').content.replace(/"/g, '');
      });
    expect(shown).toEqual(['1/4 Lift', '2/4 Lift', '3/4 Lift', '4/4 Lift']);
    // The names themselves are unchanged (the block's name and title say it whole).
    expect(blockEl(blockIds()[2]).querySelector('[class*="name"]')!.textContent).toBe('Lift · build 1/4');
    expect(byLabel('Block 3 of 9: Lift · build 1/4')).not.toBeNull();
  });
});
