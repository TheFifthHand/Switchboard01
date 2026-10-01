/**
 * The song lane's loop and song helpers in real Chromium, with real mouse
 * input (Chrome DevTools Protocol Input.dispatchMouseEvent: hit testing,
 * pointer capture and click synthesis are the browser's own), checked on the
 * runtime loop (session.setSongLoop) and the project in session.store:
 * - the Loop toggle: the selected blocks, else the playing block, else the
 *   first; pressed state; what the status line says; off again;
 * - a drag across the ruler loops the blocks it crosses (the band shows it
 *   while dragging, snapped to block edges); a click still plays from that
 *   bar; the band's two ends drag to other block edges; Esc puts it back;
 * - the block menu's Loop this block / Loop selected blocks / Stop looping;
 *   a loop whose blocks are gone is ignored;
 * - Build up, Strip down and Breakdown from the menu: the right part cells,
 *   one undo step, refusals with their reason, and the song as it plays
 *   follows at once.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { clearBlockClipboard } from '../../src/app/views/arrange/songActions';
import { getSongPlan } from '../../src/app/views/arrange/songPlan';
import { getStarter } from '../../src/content/starters';
import type { Id } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setUiMode, setView } from '../../src/state/uiStore';
import { actFrame, cleanup, mount, nextFrame, wait } from './ui-harness';

beforeEach(async () => {
  await page.viewport(1440, 900);
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  clearBlockClipboard();
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off', playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, songLoop: null, replayId: null });
    setView('arrange');
    setUiMode('simple');
  });
});

afterEach(() => {
  if (session.playing) act(() => session.stop());
  cleanup();
  vi.restoreAllMocks();
  act(() => patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, songLoop: null, replayId: null }));
});

async function setup() {
  mount(h('div', { style: { width: '1320px', height: '680px', display: 'flex', flexDirection: 'column' } }, h(ArrangeView)), { width: 1360 });
  await actFrame();
  await actFrame();
  await settle(260);
}

async function settle(ms = 300) {
  await act(async () => {
    await wait(ms);
  });
}

const project = () => session.store.getState();
const blocks = () => project().arrangement.blocks;
const blockIds = () => blocks().map((b) => b.id);
const trackId = (name: string) => project().tracks.find((t) => t.name === name)!.id;
const blockEl = (id: Id) => document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const loop = () => runtimeStore.getState().songLoop;
const status = () => document.querySelector('[data-testid="lane-status"]')!.textContent ?? '';
const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid="loop-toggle"]')!;
const band = () => document.querySelector<HTMLElement>('[data-testid="loop-band"]');
const ruler = () => document.querySelector<HTMLElement>('[data-testid="song-ruler"]')!;
const undoCount = () => session.store.historySize().undo;

/** Page coordinates of a point in this frame (the test frame may sit anywhere in the runner's page). */
function toPage(x: number, y: number) {
  const fe = window.frameElement as HTMLElement | null;
  if (!fe) return { x, y };
  const r = fe.getBoundingClientRect();
  const k = fe.offsetWidth ? r.width / fe.offsetWidth : 1;
  return { x: r.left + x * k, y: r.top + y * k };
}

type Pt = { x: number; y: number };
const centre = (el: Element): Pt => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

async function mouse(type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', p: Pt, opts: { held?: boolean; modifiers?: number } = {}) {
  const pressed = type === 'mousePressed' || (type === 'mouseMoved' && opts.held);
  await cdp().send('Input.dispatchMouseEvent', {
    type,
    ...toPage(p.x, p.y),
    button: type === 'mouseMoved' ? (opts.held ? 'left' : 'none') : 'left',
    buttons: pressed ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
    modifiers: opts.modifiers ?? 0,
  });
}

/** A real click (press and release, no travel). */
async function clickAt(p: Pt, modifiers = 0) {
  await mouse('mouseMoved', p);
  await mouse('mousePressed', p, { modifiers });
  await mouse('mouseReleased', p, { modifiers });
  await settle(60);
}

/** A real drag from `from` to `to` in `steps` moves (a frame apart); `during` runs before the button comes up. */
async function drag(from: Pt, to: Pt, opts: { steps?: number; during?: () => Promise<void> | void } = {}) {
  const steps = opts.steps ?? 10;
  await mouse('mouseMoved', from);
  await mouse('mousePressed', from);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, { held: true });
    await nextFrame();
  }
  await opts.during?.();
  await mouse('mouseReleased', to);
  await settle(80);
}

/** A point on the ruler's bar numbers over block `id`, `f` of the way across it. */
function rulerAt(id: Id, f = 0.5): Pt {
  const b = blockEl(id).getBoundingClientRect();
  const r = ruler().getBoundingClientRect();
  return { x: b.left + b.width * f, y: r.bottom - 6 };
}

function menuItem(text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((x) => x.textContent!.trim().startsWith(text));
  if (!el) throw new Error(`No menu item "${text}…" in ${[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((x) => x.textContent).join(' | ')}`);
  return el;
}

async function openMenu(id: Id) {
  await clickAt(centre(blockEl(id).querySelector<HTMLElement>('[aria-haspopup="menu"]')!));
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
}

/** What each part does in each of the given blocks, from the lane's cells: "scene", "off", "layer" or "empty". */
function cellKinds(ids: Id[], parts: string[]) {
  return ids.map((id) => parts.map((name) => blockEl(id).querySelector<HTMLElement>(`[data-cell][data-track="${trackId(name)}"]`)!.dataset.kind));
}

/* ------------------------------------------------------------------ */

describe('the Loop toggle', () => {
  it('loops the first block, the playing block, or the selected blocks (first to last), and turns off again', async () => {
    await setup();
    const ids = blockIds();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(band()).toBeNull();
    // Nothing selected, stopped: the first block.
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[0], toBlockId: ids[0] });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(status()).toBe('Looping Intro (block 1).');
    const b = band()!.getBoundingClientRect();
    expect(Math.abs(b.left - blockEl(ids[0]).getBoundingClientRect().left)).toBeLessThan(1.5);
    expect(Math.abs(b.right - blockEl(ids[0]).getBoundingClientRect().right)).toBeLessThan(1.5);
    expect(band()!.textContent).toContain('Loop');
    // Off: the song plays through.
    await clickAt(centre(toggle()));
    expect(loop()).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(status()).toBe('Loop off: the song plays through.');
    expect(band()).toBeNull();
    // The block playing now.
    act(() => patchRuntime({ playing: true, mode: 'song', songBlock: 2, songBlockId: ids[2] }));
    await settle(60);
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[2], toBlockId: ids[2] });
    await clickAt(centre(toggle()));
    act(() => patchRuntime({ playing: false, mode: 'live', songBlock: null, songBlockId: null }));
    // Blocks 2 and 4 selected (Ctrl+click): blocks 2 to 4.
    const name = (id: Id) => centre(blockEl(id).querySelector<HTMLElement>('[class*="name"]')!);
    await clickAt(name(ids[1]));
    await clickAt(name(ids[3]), 2);
    expect([...document.querySelectorAll<HTMLElement>('[data-block-id][data-selected]')].map((e) => e.dataset.blockId)).toEqual([ids[1], ids[3]]);
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[3] });
    expect(status()).toBe('Looping Groove to Break (blocks 2–4).');
    // Play song asks the session for the song from the loop (no block index: it starts at the loop's first block).
    const play = vi.spyOn(session, 'playSong').mockResolvedValue();
    await clickAt(centre([...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === 'Play song')!));
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0][0]).toBeUndefined();
    // The loop is playback state: no project edit, no undo step.
    expect(undoCount()).toBe(0);
  });

  it('a loop whose blocks are gone is ignored: no band, the toggle is off and turns it on afresh', async () => {
    await setup();
    const ids = blockIds();
    // (The session refuses such a loop and clears one whose blocks are deleted; the lane must not trust it either.)
    act(() => patchRuntime({ songLoop: { fromBlockId: 'gone', toBlockId: ids[1] } }));
    await settle(60);
    expect(band()).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[0], toBlockId: ids[0] });
  });
});

describe('the ruler', () => {
  it('a drag across it loops every block it crosses (shown while dragging, snapped to block edges); a click plays from that bar', async () => {
    await setup();
    const ids = blockIds();
    const play = vi.spyOn(session, 'playSong').mockResolvedValue();
    let during: { left: number; right: number; preview: boolean; loop: unknown } | null = null;
    await drag(rulerAt(ids[1], 0.4), rulerAt(ids[3], 0.6), {
      during: async () => {
        await actFrame();
        const r = band()!.getBoundingClientRect();
        during = { left: r.left, right: r.right, preview: band()!.hasAttribute('data-preview'), loop: loop() };
      },
    });
    // While dragging: the band covers Groove to Break exactly; nothing is set until the button comes up.
    expect(during!.preview).toBe(true);
    expect(during!.loop).toBeNull();
    expect(Math.abs(during!.left - blockEl(ids[1]).getBoundingClientRect().left)).toBeLessThan(1.5);
    expect(Math.abs(during!.right - blockEl(ids[3]).getBoundingClientRect().right)).toBeLessThan(1.5);
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[3] });
    expect(band()!.hasAttribute('data-preview')).toBe(false);
    expect(status()).toBe('Looping Groove to Break (blocks 2–4).');
    // The drag did not play anything; a plain click (and a 2 px wiggle) plays from the bar under it.
    expect(play).not.toHaveBeenCalled();
    const at = rulerAt(ids[4], 0.05);
    await clickAt(at);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0][0]).toBe(4);
    expect(play.mock.calls[0][1]?.fromBar).toBe(48);
    await drag(at, { x: at.x + 2, y: at.y }, { steps: 2 });
    expect(play).toHaveBeenCalledTimes(2);
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[3] });
    // Dragged backwards, past the song's start: from the first block.
    await drag(rulerAt(ids[2], 0.5), { x: blockEl(ids[0]).getBoundingClientRect().left - 30, y: at.y });
    expect(loop()).toEqual({ fromBlockId: ids[0], toBlockId: ids[2] });
    expect(undoCount()).toBe(0);
  });

  it("the band's ends drag to other block edges (never past each other); Esc puts the loop back", async () => {
    await setup();
    const ids = blockIds();
    const play = vi.spyOn(session, 'playSong').mockResolvedValue();
    act(() => session.setSongLoop({ fromBlockId: ids[1], toBlockId: ids[2] }));
    await settle(60);
    const end = () => centre(document.querySelector('[data-testid="loop-end"]')!);
    const start = () => centre(document.querySelector('[data-testid="loop-start"]')!);
    // The end to Break's right edge (a little short of it: the nearest edge wins).
    await drag(end(), { x: blockEl(ids[3]).getBoundingClientRect().right - 14, y: end().y });
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[3] });
    expect(Math.abs(band()!.getBoundingClientRect().right - blockEl(ids[3]).getBoundingClientRect().right)).toBeLessThan(1.5);
    // The start to the song's start.
    await drag(start(), { x: blockEl(ids[0]).getBoundingClientRect().left + 10, y: start().y });
    expect(loop()).toEqual({ fromBlockId: ids[0], toBlockId: ids[3] });
    // The start dragged past the end stops at the last looped block.
    await drag(start(), { x: blockEl(ids[5]).getBoundingClientRect().right, y: start().y });
    expect(loop()).toEqual({ fromBlockId: ids[3], toBlockId: ids[3] });
    // Esc while dragging an end: the loop stays as it was, and no click plays.
    const from = end();
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from);
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', { x: from.x + i * 40, y: from.y }, { held: true });
      await nextFrame();
    }
    await actFrame();
    expect(band()!.hasAttribute('data-preview')).toBe(true);
    await cdp().send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await mouse('mouseReleased', { x: from.x + 240, y: from.y });
    await settle(60);
    expect(loop()).toEqual({ fromBlockId: ids[3], toBlockId: ids[3] });
    expect(band()!.hasAttribute('data-preview')).toBe(false);
    expect(play).not.toHaveBeenCalled();
    // A plain click on an end plays from the bar there (it does not change the loop).
    await clickAt({ x: end().x - 4, y: end().y });
    expect(play).toHaveBeenCalledTimes(1);
    expect(loop()).toEqual({ fromBlockId: ids[3], toBlockId: ids[3] });
  });
});

describe('the block menu', () => {
  it('Loop this block, Loop selected blocks and Stop looping', async () => {
    await setup();
    const ids = blockIds();
    await openMenu(ids[1]);
    expect(() => menuItem('Stop looping')).toThrow();
    act(() => menuItem('Loop this block').click());
    await settle(60);
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[1] });
    expect(status()).toBe('Looping Groove (block 2).');
    await openMenu(ids[1]);
    const again = menuItem('Loop this block');
    expect(again.getAttribute('aria-disabled')).toBe('true');
    expect(again.textContent).toContain('Looping now');
    act(() => again.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => menuItem('Stop looping').click());
    await settle(60);
    expect(loop()).toBeNull();
    // Shift+click selects Groove to Lift: their menu loops both.
    const name = (id: Id) => centre(blockEl(id).querySelector<HTMLElement>('[class*="name"]')!);
    await clickAt(name(ids[1]));
    await clickAt(name(ids[2]), 8);
    await openMenu(ids[2]);
    act(() => menuItem('Loop selected blocks').click());
    await settle(60);
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[2] });
    // A menu fits a laptop screen (no scrolling at 768 high).
    await page.viewport(1366, 768);
    await settle(100);
    await openMenu(ids[4]);
    const m = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight + 1);
    for (const text of ['One pass fewer', 'Copy block', 'Cut block', 'Move earlier', 'Move later', 'Stop looping']) {
      const t = menuItem(text).querySelector<HTMLElement>('[class*="itemText"]')!;
      expect(t.scrollWidth, `${text} is cut off`).toBeLessThanOrEqual(t.clientWidth + 1);
    }
  });
});

describe('song helpers', () => {
  const PARTS = ['Drums', 'Percussion', 'Bass', 'Chords'];

  it('Build up: Groove splits into its passes and its parts come in one at a time (chords, percussion, bass, drums); one undo step', async () => {
    await setup();
    const ids = blockIds();
    const before = undoCount();
    await openMenu(ids[1]);
    act(() => menuItem('Shape this block').click());
    expect(menuItem('Build up').getAttribute('aria-disabled')).toBeNull();
    act(() => menuItem('Build up').click());
    await settle(120);
    const now = blockIds();
    expect(now.length).toBe(9);
    expect(now[1]).toBe(ids[1]);
    const built = now.slice(1, 5);
    expect(cellKinds(built, PARTS)).toEqual([
      ['off', 'off', 'off', 'scene'],
      ['off', 'scene', 'off', 'scene'],
      ['off', 'scene', 'scene', 'scene'],
      ['scene', 'scene', 'scene', 'scene'],
    ]);
    // Each pass keeps its 4 bars; the four blocks are selected; the toast offers Undo.
    expect(blocks().slice(1, 5).map((b) => b.repeats)).toEqual([1, 1, 1, 1]);
    expect(built.map((id) => blockEl(id).querySelector('[data-testid="block-length"]')!.textContent)).toEqual(['4 bars', '4 bars', '4 bars', '4 bars']);
    expect(built.every((id) => blockEl(id).hasAttribute('data-selected'))).toBe(true);
    expect(status()).toBe('Groove builds up: its 4 parts come in one at a time (4 blocks).');
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    expect(undoCount()).toBe(before + 1);
    act(() => session.undo());
    await settle(120);
    expect(blockIds()).toEqual(ids);
    expect(blocks()[1].parts).toBeUndefined();
  });

  it('a looped block keeps looping as a whole after Build up splits it', async () => {
    await setup();
    const ids = blockIds();
    act(() => session.setSongLoop({ fromBlockId: ids[0], toBlockId: ids[1] }));
    await openMenu(ids[1]);
    act(() => menuItem('Shape this block').click());
    act(() => menuItem('Build up').click());
    await settle(120);
    const now = blockIds();
    expect(loop()).toEqual({ fromBlockId: ids[0], toBlockId: now[4] });
    expect(Math.abs(band()!.getBoundingClientRect().right - blockEl(now[4]).getBoundingClientRect().right)).toBeLessThan(1.5);
  });

  it('Strip down and Breakdown; a helper that cannot work says why and does nothing', async () => {
    await setup();
    const ids = blockIds();
    // Strip down on the last Groove (2 passes): all four parts, then chords and percussion.
    await openMenu(ids[5]);
    act(() => menuItem('Shape this block').click());
    act(() => menuItem('Strip down').click());
    await settle(120);
    const stripped = blockIds().slice(5, 7);
    expect(cellKinds(stripped, PARTS)).toEqual([
      ['scene', 'scene', 'scene', 'scene'],
      ['off', 'scene', 'off', 'scene'],
    ]);
    // Breakdown on Lift: its drums, percussion and bass off; everything else plays on.
    await openMenu(ids[2]);
    act(() => menuItem('Shape this block').click());
    act(() => menuItem('Breakdown').click());
    await settle(120);
    expect(cellKinds([ids[2]], [...PARTS, 'Lead', 'Pad'])).toEqual([['off', 'off', 'off', 'scene', 'scene', 'scene']]);
    expect(blocks().find((b) => b.id === ids[2])!.repeats).toBe(4);
    // Break has no drums or percussion, but bass: Breakdown works; Intro playing once cannot build up.
    act(() => cmd.setBlockRepeats(session.store, ids[0], 1));
    await settle(60);
    const undo = undoCount();
    await openMenu(ids[0]);
    act(() => menuItem('Shape this block').click());
    const build = menuItem('Build up');
    expect(build.getAttribute('aria-disabled')).toBe('true');
    expect(build.textContent).toContain('Plays once');
    expect(document.querySelector('[role="menu"]')!.textContent).toContain('give it at least 2 passes first');
    act(() => build.click());
    expect(undoCount()).toBe(undo);
    expect(blocks()[0].parts).toBeUndefined();
  });

  it('while the song plays, Build up on the playing block changes what plays at once', async () => {
    await setup();
    const ids = blockIds();
    await act(async () => {
      await session.playSong(1);
      await wait(50);
    });
    const start = performance.now();
    while (!(runtimeStore.getState().playing && runtimeStore.getState().mode === 'song') && performance.now() - start < 8000) await settle(30);
    expect(runtimeStore.getState().songBlockId).toBe(ids[1]);
    await openMenu(ids[1]);
    act(() => menuItem('Shape this block').click());
    act(() => menuItem('Build up').click());
    await settle(150);
    // The song as it plays now has the new blocks, with the drums silent until the last pass.
    const plan = getSongPlan()!;
    const made = blockIds().slice(1, 5);
    const drums = trackId('Drums');
    for (const [i, id] of made.entries()) {
      const b = plan.find((x) => x.blockId === id);
      expect(b, `block ${i + 2} in the plan`).toBeTruthy();
      expect(drums in b!.parts ? b!.parts[drums] : 'scene').toBe(i < 3 ? null : 'scene');
    }
  });
});
