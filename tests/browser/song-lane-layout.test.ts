/**
 * The Arrange view in the running app (real Chromium, the app's fonts and
 * styles): the song lane fits at 1366 x 768, 1920 x 1080 and 960 x 540
 * (200 % zoom of 1920 x 1080) without the page scrolling sideways, part rows
 * grow with the free height (26–32 px at 1366 x 768 and 1920 x 1080, never
 * under 18 px), the Performances panel is a one-line bar without takes and
 * keeps room with them, the lane scrolls on its own when the song is longer
 * than it, and the details read as they should (the edge grip on every block,
 * a calm Off, loop grips above the bar numbers). With reduced
 * motion, blocks jump to their places (no slides) and everything else works
 * the same. axe-core finds no serious or critical issues in the Arrange view
 * (Simple and Advanced, playing, with a part off and a layered part).
 */
import type { AxeResults } from 'axe-core';
// The audit script as text (a script tag), so the test needs no dependency pre-bundling.
import axeSource from 'axe-core/axe.min.js?raw';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { getStarter } from '../../src/content/starters';
import { deleteDb } from '../../src/persistence/db';
import * as cmd from '../../src/state/commands';
import { setGuideDone, setKeyboardCollapsed, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { makeSnapshot } from '../../src/time/snapshot';
import { actFrame, cleanup, key, mount, wait } from './ui-harness';
import { mouse } from './r4-uikit-input';

let boot: BootInfo;

beforeEach(async () => {
  await deleteDb();
  // The lane's remembered settings (the Performances panel open or folded) start fresh.
  localStorage.removeItem('switchboard01.songLane');
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('arrange');
    setKeyboardCollapsed(false);
  });
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  act(() => {
    setUiMode('simple');
    setView('play');
    patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null });
  });
  await session.autosaver?.flush();
  await deleteDb();
});

async function settle(ms = 60) {
  await Promise.all(['400 13px "Inter Variable"', '650 13px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await wait(ms);
  });
}

async function openArrange(w: number, hh: number) {
  await page.viewport(w, hh);
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  // The starter's song (six blocks) in the lane.
  act(() => {
    session.store.replace(getStarter('house')!.build(), { resetHistory: true });
    setView('arrange');
  });
  await settle(300);
}

const songPanel = () => document.querySelector<HTMLElement>('section[aria-labelledby="song-title"]')!;
const perfPanel = () => document.querySelector<HTMLElement>('section[aria-labelledby="perf-title"]')!;
const laneEl = () => document.querySelector<HTMLElement>('[data-testid="song-lane"]')!;
const blockEls = () => [...document.querySelectorAll<HTMLElement>('[data-block-id]')];

describe('Arrange layout', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh}: the lane fits, rows grow with the free height (to 48 px on a tall window, 26 at 200 %), targets are big enough, the page never scrolls sideways`, async () => {
      await openArrange(w, hh);
      const doc = document.scrollingElement!;
      expect(doc.scrollWidth, 'page scrolls sideways').toBeLessThanOrEqual(window.innerWidth);
      const panel = songPanel().getBoundingClientRect();
      expect(panel.left).toBeGreaterThanOrEqual(0);
      expect(panel.right).toBeLessThanOrEqual(w);
      expect(songPanel().scrollWidth).toBeLessThanOrEqual(songPanel().clientWidth + 1);
      // Part rows: one cell per part, aligned with the part names; they grow with the window's height.
      const cells = [...blockEls()[1].querySelectorAll<HTMLElement>('[data-cell]')];
      expect(cells.length).toBe(8);
      const [lo, hi] = hh <= 540 ? [26, 32] : hh >= 1080 ? [48, 48] : [30, 40];
      for (const c of cells) {
        const ch = c.getBoundingClientRect().height;
        expect(ch).toBeGreaterThanOrEqual(lo);
        expect(ch).toBeLessThanOrEqual(hi);
      }
      const names = [...laneEl().querySelectorAll<HTMLElement>('[data-name-row]')].filter((d) => d.querySelector('[class*="partNameText"]')?.textContent === 'Drums');
      expect(names.length).toBe(1);
      expect(Math.abs(names[0].getBoundingClientRect().top - cells[0].getBoundingClientRect().top)).toBeLessThan(2);
      // Each part row has its Mute and Solo keys, 32 px wide (shown while the row has focus or the pointer).
      act(() => names[0].querySelector<HTMLElement>('[aria-haspopup="menu"]')!.focus());
      await settle(30);
      for (const k of names[0].querySelectorAll<HTMLElement>('button[aria-pressed]')) expect(k.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      // The blocks are inside the lane, which scrolls by itself when the song is longer than it.
      const scroller = blockEls()[0].closest<HTMLElement>('[data-testid="lane-scroller"]')!;
      const last = blockEls()[blockEls().length - 1];
      expect(scroller.scrollWidth).toBeGreaterThanOrEqual(Math.floor(last.getBoundingClientRect().right - scroller.getBoundingClientRect().left + scroller.scrollLeft) - 1);
      expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(panel.right);
      // Header buttons keep a usable size; on a block with room (Groove) they are 32 px. A compact block (an
      // overview step: the whole song fits only that small) shows them on keyboard focus (and hover).
      const b0 = blockEls()[0];
      if (b0.getBoundingClientRect().width < 110) {
        expect(b0.querySelector<HTMLElement>('[aria-haspopup="menu"]')!.getBoundingClientRect().height).toBe(0);
        act(() => b0.focus());
        await settle();
        const more = b0.querySelector<HTMLElement>('[aria-haspopup="menu"]')!.getBoundingClientRect();
        expect(more.height).toBeGreaterThanOrEqual(32);
        expect(more.width).toBeGreaterThanOrEqual(32);
        expect(more.right).toBeLessThanOrEqual(b0.getBoundingClientRect().right + 1);
        act(() => b0.blur());
      } else {
        // From 110 px the keys are 32 px (under 150 px they show on hover and focus).
        act(() => b0.focus());
        await settle();
        const play = b0.querySelector<HTMLElement>('[aria-label^="Play song from block 1"]')!;
        expect(play.getBoundingClientRect().height).toBeGreaterThanOrEqual(28);
        act(() => b0.blur());
      }
      const wide = blockEls()[1];
      if (wide.getBoundingClientRect().width >= 110) {
        for (const b of wide.querySelectorAll<HTMLElement>('[aria-label^="Play song from block 2"], [aria-haspopup="menu"][aria-label*="block actions"]')) {
          expect(b.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
          expect(b.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
        }
      }
      // Scissors (shown with the block hovered or focused): a 24 px target.
      act(() => wide.focus());
      const split = wide.querySelector<HTMLElement>('[aria-label^="Split Groove"]')!;
      expect(split.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
      expect(split.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
      act(() => wide.blur());
      // Out of the layout otherwise (nothing invisible to click, or for the hint chip to avoid); the pointer away.
      await mouse('mouseMoved', { x: 2, y: 2 });
      await settle(30);
      expect(split.getBoundingClientRect().width).toBe(0);
      // The lane's view tools (Follow, zoom, Fit song) are on screen, in the lane's corner.
      for (const name of ['Follow playhead', 'Zoom out', 'Zoom in', 'Fit song']) {
        const b = [...document.querySelectorAll<HTMLElement>('[role="group"][aria-label="Song lane view"] button')].find((x) => (x.getAttribute('aria-label') ?? x.textContent ?? '').startsWith(name))!;
        const r = b.getBoundingClientRect();
        expect(r.right, name).toBeLessThanOrEqual(panel.right);
        // At 200 % zoom the Arrange view scrolls down to the palette; at laptop and desktop size it is in view.
        if (hh >= 768) expect(r.bottom, name).toBeLessThanOrEqual(hh);
      }
      // No takes: Performances is one line, inside the window at laptop size; a tall window has room for it
      // open (how to record a take), so it opens by itself there.
      if (hh >= 1080) expect(perfPanel().hasAttribute('data-collapsed')).toBe(false);
      else {
        expect(perfPanel().hasAttribute('data-collapsed')).toBe(true);
        expect(perfPanel().getBoundingClientRect().height).toBeLessThanOrEqual(52);
      }
      if (hh >= 768) {
        expect(perfPanel().getBoundingClientRect().bottom).toBeLessThanOrEqual(hh);
        // No empty band under the panels, and at most 120 px of empty lane under the blocks.
        const view = perfPanel().parentElement!.getBoundingClientRect();
        expect(view.bottom - perfPanel().getBoundingClientRect().bottom, 'empty band under the Arrange view').toBeLessThanOrEqual(14);
        const lane = laneEl().getBoundingClientRect();
        const lastCell = [...blockEls()[1].querySelectorAll<HTMLElement>('[data-cell]')].at(-1)!.getBoundingClientRect();
        expect(lane.bottom - lastCell.bottom, 'empty lane under the blocks').toBeLessThanOrEqual(120);
      }
      // Advanced adds detail but no width; the part picker arrows are 24 px wide.
      act(() => setUiMode('advanced'));
      await settle();
      expect(doc.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(blockEls()[1].textContent).toContain('4 × 4');
      const pick = blockEls()[1].querySelector<HTMLElement>('[aria-label^="Choose what"]')!;
      expect(pick.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
      // Split Groove: the Join button on the seam is a 24 px target.
      act(() => split.click());
      await settle();
      const join = document.querySelector<HTMLElement>('[data-join]')!;
      expect(join.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
      expect(join.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
      if (hh >= 768) expect(perfPanel().getBoundingClientRect().bottom).toBeLessThanOrEqual(hh);
    });
  }

  it('with takes, the Performances panel is one line at 1366 x 768 ("3 takes ▸"); opened, it keeps room and the rows give way (never under 18 px)', async () => {
    await openArrange(1366, 768);
    const p = session.store.getState();
    act(() => {
      for (let i = 0; i < 3; i++) {
        cmd.addPerformance(session.store, {
          id: `perf-${i}`,
          name: `Take ${i + 1}`,
          createdAt: Date.now(),
          startTick: 0,
          endTick: 4 * 384,
          snapshot: makeSnapshot(p, p.tracks.map((t) => ({ trackId: t.id, playing: null })), 0),
          events: [],
        });
      }
    });
    await settle(300);
    expect(perfPanel().hasAttribute('data-collapsed')).toBe(true);
    expect(perfPanel().textContent).toContain('3 takes');
    const folded = blockEls()[1].querySelector<HTMLElement>('[data-cell]')!.getBoundingClientRect().height;
    expect(folded).toBeGreaterThanOrEqual(30);
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="takes-open"]')!.click());
    await settle(300);
    expect(perfPanel().hasAttribute('data-collapsed')).toBe(false);
    const cell = blockEls()[1].querySelector<HTMLElement>('[data-cell]')!.getBoundingClientRect().height;
    expect(cell).toBeGreaterThanOrEqual(18);
    expect(cell).toBeLessThan(folded);
    expect(perfPanel().getBoundingClientRect().height).toBeGreaterThanOrEqual(130);
    expect(perfPanel().getBoundingClientRect().bottom).toBeLessThanOrEqual(768);
    expect(document.scrollingElement!.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it('details: an edge grip on every block, a calm Off (coral tick, grey word), loop grips (8 px drawn, 24 px target) above the bar numbers', async () => {
    await openArrange(1366, 768);
    const p = session.store.getState();
    const [b0, b1] = p.arrangement.blocks;
    act(() => {
      cmd.setBlockPart(session.store, b1.id, p.tracks[0].id, null);
      session.setSongLoop({ fromBlockId: b0.id, toBlockId: b1.id });
    });
    await settle(200);
    // The right-edge grip shows on every block without hovering it.
    for (const el of blockEls()) {
      const grip = getComputedStyle(el.querySelector('[data-edge]')!, '::after');
      expect(Number(grip.opacity)).toBeGreaterThan(0.2);
      expect(parseFloat(grip.width)).toBeGreaterThanOrEqual(4);
    }
    // Off: the word, in grey, with a coral tick on its left (not a coral alarm box).
    const off = blockEls()[1].querySelector<HTMLElement>(`[data-cell][data-track="${p.tracks[0].id}"]`)!;
    expect(off.textContent).toBe('Off');
    const cs = getComputedStyle(off);
    const ink3 = getComputedStyle(document.documentElement).getPropertyValue('--ink-3').trim();
    const probe = document.createElement('span');
    probe.style.color = ink3;
    document.body.appendChild(probe);
    expect(cs.color).toBe(getComputedStyle(probe).color);
    probe.remove();
    expect(cs.boxShadow).toMatch(/^rgb\(220, 95, 71\) 2px 0px 0px 0px inset/);
    expect(Number(cs.fontWeight)).toBeLessThan(600);
    // Loop grips: drawn at least 8 px wide, a 24 px wide target, not over the bar numbers.
    const nums = [...document.querySelectorAll<HTMLElement>('[data-testid="song-ruler"] [class*="markNum"]')].map((n) => n.getBoundingClientRect());
    for (const id of ['loop-start', 'loop-end']) {
      const end = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      const r = end.getBoundingClientRect();
      expect(r.width).toBeGreaterThanOrEqual(24);
      expect(parseFloat(getComputedStyle(end, '::after').width)).toBeGreaterThanOrEqual(8);
      for (const n of nums) expect(r.bottom <= n.top + 0.5 || r.right <= n.left || r.left >= n.right, 'a loop grip covers a bar number').toBe(true);
    }
    act(() => session.setSongLoop(null));
  });

  it('a long song scrolls inside the lane, and the lane follows keyboard focus', async () => {
    await openArrange(1366, 768);
    // Forty more blocks: too long to show whole even at the smallest zoom step.
    act(() => {
      for (let i = 0; i < 40; i++) cmd.addBlock(session.store, session.store.getState().scenes[i % 4].id, undefined, 4);
    });
    await settle(300);
    const scroller = laneEl().querySelector<HTMLElement>('[data-testid="lane-scroller"]')!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(document.scrollingElement!.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const blocks = blockEls();
    act(() => blocks[0].focus());
    key(blocks[0], 'keydown', { key: 'End' });
    await settle(400);
    const last = blocks[blocks.length - 1].getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    expect(document.activeElement).toBe(blocks[blocks.length - 1]);
    expect(last.right).toBeLessThanOrEqual(sr.right + 1);
    expect(last.left).toBeGreaterThanOrEqual(sr.left - 1);
  });
});

describe('Reduced motion', () => {
  it('blocks jump to their new places (no slide or spring); the same edits work', async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    try {
      expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
      session.store.replace(getStarter('house')!.build(), { resetHistory: true });
      mount(h('div', { style: { width: '1320px', height: '680px', display: 'flex', flexDirection: 'column' } }, h(ArrangeView)), { width: 1360 });
      await actFrame();
      await actFrame();
      const ids = session.store.getState().arrangement.blocks.map((b) => b.id);
      const el = (id: string) => document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
      const dur = getComputedStyle(el(ids[0])).transitionDuration.split(',').map((d) => parseFloat(d));
      expect(Math.max(...dur)).toBe(0);
      const left0 = el(ids[0]).getBoundingClientRect().left;
      act(() => el(ids[0]).focus());
      key(el(ids[0]), 'keydown', { key: 'ArrowRight', altKey: true });
      expect(session.store.getState().arrangement.blocks[1].id).toBe(ids[0]);
      // Already in place on the next frame (a 170 ms slide would still be under way).
      await actFrame();
      expect(Math.abs(el(ids[1]).getBoundingClientRect().left - left0)).toBeLessThan(1);
      expect(Math.abs(el(ids[0]).getBoundingClientRect().left - el(ids[1]).getBoundingClientRect().right)).toBeLessThan(1.5);
    } finally {
      await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    }
  });
});

interface AxeApi {
  run(context: Element, options: object): Promise<AxeResults>;
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

describe('Accessibility audit', () => {
  for (const mode of ['simple', 'advanced'] as const) {
    it(`${mode}: no serious or critical axe-core violations in Arrange (playing block, a part off, a layered part, a selection)`, async () => {
      await openArrange(1366, 768);
      act(() => setUiMode(mode));
      const p = session.store.getState();
      const [b0, b1] = p.arrangement.blocks;
      act(() => {
        cmd.setBlockPart(session.store, b1.id, p.tracks[0].id, null);
        cmd.setBlockPart(session.store, b1.id, p.tracks[4].id, p.scenes[2].id);
        patchRuntime({ playing: true, mode: 'song', songBlock: 1, songBlockId: b1.id });
      });
      await settle(200);
      act(() => document.querySelector<HTMLElement>(`[data-block-id="${b0.id}"]`)!.click());
      await settle();
      const r = await loadAxe().run(document.querySelector('main') ?? document.body, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      const bad = r.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      expect(bad).toEqual([]);
    });
  }
});
