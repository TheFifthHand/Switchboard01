/**
 * The Song view passes an automated axe-core audit (no serious or critical
 * violations), at rest and with each of its menus open: the loop menu, the
 * section menu and the loop picker; and with the loop browser open.
 */
import type { AxeResults } from 'axe-core';
import axeSource from 'axe-core/axe.min.js?raw';
import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import type { Project } from '../../src/project/types';
import { barX, centre, clickAt, doubleClickAt, on, openSong, press, region, resetSong, rightClickAt, rowY, settle, teardownSong } from './r5-song-helpers';

interface AxeApi {
  run(context: Element, options: Record<string, unknown>): Promise<AxeResults>;
}
function loadAxe(): AxeApi {
  const w = window as unknown as { axe?: AxeApi };
  if (!w.axe) {
    const script = document.createElement('script');
    script.textContent = axeSource;
    document.head.appendChild(script);
  }
  return w.axe!;
}

async function audit(root: Element): Promise<string[]> {
  const r = await loadAxe().run(root, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')}`);
}

function song(p: Project): void {
  const d = p.tracks[0];
  const b = p.tracks[2];
  p.arrangement.regions = [region('A', d.id, d.clips.find((c) => c)!.id, 0, 8), region('C', b.id, b.clips.find((c) => c)!.id, 2, 12, 1)];
  p.arrangement.sections = [{ id: 'S1', name: 'Intro', start: 0, bars: 8, moves: [{ id: 'm1', kind: 'fadeIn' }] }];
}

beforeEach(resetSong);
afterEach(teardownSong);

it('the Song view and its menus pass axe-core', async () => {
  await openSong(1366, 768, song);
  act(() => ppbStore.setState(32));
  await settle();
  const view = document.querySelector('section[aria-labelledby="song-title"]')!;
  expect(await audit(view)).toEqual([]);
  // With the loop browser open.
  await clickAt(centre(document.querySelector('[data-testid="loops-toggle"]')!));
  expect(await audit(view)).toEqual([]);
  // The loop menu.
  await rightClickAt(on('C', 0.3));
  expect(await audit(document.querySelector('[role="menu"]')!)).toEqual([]);
  await press('Escape');
  // The section menu.
  await rightClickAt(centre(document.querySelector('[data-section-id="S1"]')!));
  expect(await audit(document.querySelector('[role="menu"]')!)).toEqual([]);
  await press('Escape');
  // The loop picker.
  await doubleClickAt({ x: barX(20) + 6, y: rowY(document.querySelectorAll<HTMLElement>('[data-lane]')[3].dataset.lane!) });
  expect(await audit(document.querySelector('[role="menu"]')!)).toEqual([]);
});
