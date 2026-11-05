/**
 * The Play view's open menus pass an automated axe-core audit with no serious
 * or critical violations (the e2e audit never opens a menu): a role="menu"
 * owns only menu items, groups and separators, so its title block, hint
 * lines, key rows (lengths, Tighten / Loosen) and lock notes are
 * presentational or grouped. Checked on a clip's menu (a filled pad and an
 * empty one), a scene's menu and a part's ⋯ menu, and on a clip's menu during
 * a performance take (its one-line lock note).
 */
import type { AxeResults } from 'axe-core';
import axeSource from 'axe-core/axe.min.js?raw';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { selectSlot, selectTrack } from '../../src/state/uiStore';
import { button, clickEl, clipsOf, menu, openApp, pad, press, setUp, tearDown, until } from './r4-play-helpers';

beforeEach(setUp);
afterEach(tearDown);

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

/** Serious and critical axe-core findings inside the open menu. */
async function audit(): Promise<string[]> {
  const m = menu();
  expect(m, 'an open menu').not.toBeNull();
  const r = await loadAxe().run(m!, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')}`);
}

/** The ⋯ key of a pad (shown on the selected pad). */
function clipOptions(trackId: string, slot: number): HTMLButtonElement | null {
  act(() => {
    selectTrack(trackId);
    selectSlot(trackId, slot);
  });
  return pad(trackId, slot).closest('[data-pad-cell]')!.querySelector<HTMLButtonElement>('button[aria-label^="Options for"]');
}

describe('open menus pass axe-core (no serious or critical violations)', () => {
  it("a filled clip's menu (lengths, Tighten / Loosen), an empty pad's menu, a scene's menu and a part's menu", async () => {
    await openApp(1366, 768);
    const full = clipsOf('t3').findIndex((c) => !!c && c.notes.length > 2);
    await clickEl(clipOptions('t3', full));
    expect(await audit()).toEqual([]);
    await press('{Escape}');

    const empty = clipsOf('t3').findIndex((c) => !c);
    await clickEl(clipOptions('t3', empty));
    expect(await audit()).toEqual([]);
    await press('{Escape}');

    await clickEl(button('Options for scene Intro'));
    expect(await audit()).toEqual([]);
    await press('{Escape}');

    await clickEl(button('Options for part Bass'));
    expect(await audit()).toEqual([]);
    await press('{Escape}');
  });

  it("a clip's menu and a scene's menu during a performance take (with the lock note)", async () => {
    await openApp(1366, 768, { play: true });
    await act(async () => {
      await session.togglePerformance();
    });
    await until(() => session.store.info.getState().lock !== null, 'the take');
    const full = clipsOf('t3').findIndex((c) => !!c);
    await clickEl(clipOptions('t3', full));
    expect(await audit()).toEqual([]);
    await press('{Escape}');
    await clickEl(button('Options for scene Groove'));
    expect(await audit()).toEqual([]);
    await press('{Escape}');
    await act(async () => {
      await session.togglePerformance();
    });
  });
});
