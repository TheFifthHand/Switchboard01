/**
 * The song lane's loop and song helpers in real Chromium, with real mouse
 * input (Chrome DevTools Protocol Input.dispatchMouseEvent: hit testing,
 * pointer capture and click synthesis are the browser's own), checked on the
 * runtime loop (session.setSongLoop) and the project in session.store:
 * - the Loop button: it names its target (the blocks the user selected by a
 *   click or the keyboard, else the loop that is on, else the playing block,
 *   else the first); pressing it loops them, again turns the loop off, and
 *   with other blocks selected moves the loop there; a selection an action
 *   left (a duplicate) does not count; pressed state; the status line;
 * - a drag across the ruler loops the blocks it crosses (the band shows it
 *   while dragging, snapped to block edges); a click still plays from that
 *   bar; the band's two ends drag to other block edges; Esc puts it back;
 * - the block menu's Loop list (Loop this block / Loop selected blocks / Stop
 *   looping); a loop whose blocks are gone is ignored; the menu fits a
 *   laptop screen and its lists never move it;
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
    patchRuntime({ held: {}, notice: null, recording: 'off', playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, songLoop: null, songLooping: false, replayId: null });
    setView('arrange');
    setUiMode('simple');
  });
});

afterEach(() => {
  if (session.playing) act(() => session.stop());
  cleanup();
  vi.restoreAllMocks();
  act(() => patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, songLoop: null, songLooping: false, replayId: null }));
  // The view is remembered in localStorage, shared with the other test files: leave the default.
  act(() => setView('play'));
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

describe('the Loop button', () => {
  it('names what it loops: the first block, the playing block, or the blocks the user selected; again turns it off', async () => {
    await setup();
    const ids = blockIds();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(band()).toBeNull();
    // Nothing selected, stopped: the first block, by name.
    expect(toggle().getAttribute('aria-label')).toBe('Loop Intro (block 1)');
    expect(toggle().textContent).toContain('Intro (block 1)');
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[0], toBlockId: ids[0] });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(status()).toBe('Loop on: Intro (block 1).');
    const b = band()!.getBoundingClientRect();
    expect(Math.abs(b.left - blockEl(ids[0]).getBoundingClientRect().left)).toBeLessThan(1.5);
    expect(Math.abs(b.right - blockEl(ids[0]).getBoundingClientRect().right)).toBeLessThan(1.5);
    expect(band()!.textContent).toContain('Loop');
    // Pressed again on the same blocks: off, the song plays through.
    await clickAt(centre(toggle()));
    expect(loop()).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(status()).toBe('Loop off: the song plays through.');
    expect(band()).toBeNull();
    // The block playing now.
    act(() => patchRuntime({ playing: true, mode: 'song', songBlock: 2, songBlockId: ids[2] }));
    await settle(60);
    expect(toggle().getAttribute('aria-label')).toBe('Loop Lift (block 3)');
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[2], toBlockId: ids[2] });
    // A loop on and nothing selected: the button names that loop, and turns it off (not onto the playing block).
    act(() => patchRuntime({ songBlock: 3, songBlockId: ids[3] }));
    await settle(60);
    expect(toggle().getAttribute('aria-label')).toBe('Loop Lift (block 3)');
    await clickAt(centre(toggle()));
    expect(loop()).toBeNull();
    act(() => patchRuntime({ playing: false, mode: 'live', songBlock: null, songBlockId: null }));
    // Blocks 2 and 4 selected (Ctrl+click): blocks 2 to 4.
    const name = (id: Id) => centre(blockEl(id).querySelector<HTMLElement>('[class*="name"]')!);
    await clickAt(name(ids[1]));
    await clickAt(name(ids[3]), 2);
    expect([...document.querySelectorAll<HTMLElement>('[data-block-id][data-selected]')].map((e) => e.dataset.blockId)).toEqual([ids[1], ids[3]]);
    expect(toggle().getAttribute('aria-label')).toBe('Loop blocks 2–4');
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[3] });
    expect(status()).toBe('Loop on: Groove to Break (blocks 2–4).');
    // Another block selected while that loop is on: the button names it and moves the loop there.
    await clickAt(name(ids[4]));
    expect(toggle().getAttribute('aria-label')).toBe('Loop Lift (block 5)');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await clickAt(centre(toggle()));
    expect(loop()).toEqual({ fromBlockId: ids[4], toBlockId: ids[4] });
    // The loop is playback state: no project edit, no undo step.
    expect(undoCount()).toBe(0);
  });

  it('a selection an action left (the copies a duplicate made) is not what the button loops', async () => {
    await setup();
    const ids = blockIds();
    act(() => blockEl(ids[1]).focus());
    await act(async () => {
      await cdp().send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, modifiers: 2 });
      await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, modifiers: 2 });
    });
    await settle(60);
    // The copy is selected (and focused), but the user did not select it: the button names the first block.
    const copy = blockIds()[2];
    expect(blockEl(copy).hasAttribute('data-selected')).toBe(true);
    expect(toggle().getAttribute('aria-label')).toBe('Loop Intro (block 1)');
    // Arrow keys are the user's own selection: the button follows them.
    await act(async () => {
      await cdp().send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    });
    await settle(60);
    expect(toggle().getAttribute('aria-label')).toBe('Loop Lift (block 4)');
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
    expect(status()).toBe('Loop on: Groove to Break (blocks 2–4).');
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
  it('its Loop list: Loop this block, Loop selected blocks and Stop looping', async () => {
    await setup();
    const ids = blockIds();
    await openMenu(ids[1]);
    act(() => menuItem('Loop…').click());
    expect(menuItem('Stop looping').getAttribute('aria-disabled')).toBe('true');
    act(() => menuItem('Loop this block').click());
    await settle(60);
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[1] });
    expect(status()).toBe('Loop on: Groove (block 2).');
    await openMenu(ids[1]);
    expect(menuItem('Loop…').textContent).toContain('Loop is on');
    act(() => menuItem('Loop…').click());
    const again = menuItem('Loop this block');
    expect(again.getAttribute('aria-disabled')).toBe('true');
    expect(again.textContent).toContain('Loop is on');
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
    act(() => menuItem('Loop…').click());
    act(() => menuItem('Loop selected blocks').click());
    await settle(60);
    expect(loop()).toEqual({ fromBlockId: ids[1], toBlockId: ids[2] });
  });

  it('fits a 1366 x 768 screen (most used actions first, the rest in lists); opening a list or going Back never moves it', async () => {
    await page.viewport(1366, 768);
    await setup();
    const ids = blockIds();
    const rect = () => {
      const r = document.querySelector<HTMLElement>('[role="menu"]')!.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    for (const i of [1, 4]) {
      await openMenu(ids[i]);
      const m = document.querySelector<HTMLElement>('[role="menu"]')!;
      const r = m.getBoundingClientRect();
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.bottom).toBeLessThanOrEqual(768);
      expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight + 1);
      // Short enough to sit wholly below (or above) its ⋯ at 768 high, so it never has to cover it.
      const trigger = blockEl(ids[i]).querySelector<HTMLElement>('[aria-haspopup="menu"]')!.getBoundingClientRect();
      expect(r.height).toBeLessThanOrEqual(Math.max(768 - trigger.bottom, trigger.top) - 8);
      expect(r.height).toBeLessThanOrEqual(560);
      // The most used first: play from here, rename, duplicate, split, join, then one more time / one fewer.
      const items = [...m.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((x) => x.querySelector('[class*="itemText"]')?.textContent ?? x.textContent);
      expect(items.slice(0, 7)).toEqual(['Play song from here', 'Rename…', 'Duplicate block', 'Split in half', 'Join with next', 'One more time', 'One time fewer']);
      expect(items.at(-1)).toBe('Remove from song');
      for (const text of ['One time fewer', 'Join with next', 'Split in half', 'Scenes and clips…', 'Copy, cut, move…']) {
        const t = menuItem(text).querySelector<HTMLElement>('[class*="itemText"]')!;
        expect(t.scrollWidth, `${text} is cut off`).toBeLessThanOrEqual(t.clientWidth + 1);
      }
      // Every list keeps the menu's place and size.
      const at = rect();
      for (const list of ['Parts in this block…', 'Scenes and clips…', 'Shape this block…', 'Loop…', 'Copy, cut, move…']) {
        act(() => menuItem(list).click());
        await settle(30);
        expect(rect(), list).toEqual(at);
        // Focus moves to the list's first item (Back), for the keyboard.
        expect(document.activeElement?.textContent).toContain('Back');
        if (list === 'Scenes and clips…') {
          act(() => menuItem('Change scene').click());
          await settle(30);
          expect(rect(), 'Change scene…').toEqual(at);
          act(() => menuItem('Back').click());
        }
        if (list === 'Copy, cut, move…') {
          for (const text of ['Copy block', 'Cut block', 'Move earlier', 'Move later']) {
            const t = menuItem(text).querySelector<HTMLElement>('[class*="itemText"]')!;
            expect(t.scrollWidth, `${text} is cut off`).toBeLessThanOrEqual(t.clientWidth + 1);
          }
        }
        act(() => menuItem('Back').click());
        await settle(30);
        expect(rect(), `Back from ${list}`).toEqual(at);
      }
      await cdp().send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await settle(60);
      expect(document.querySelector('[role="menu"]')).toBeNull();
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

  it('a looped block keeps looping as a whole after Build up splits it, after Undo and after Redo (the session keeps the loop; the lane only draws it)', async () => {
    await setup();
    const ids = blockIds();
    act(() => session.setSongLoop({ fromBlockId: ids[0], toBlockId: ids[1] }));
    await openMenu(ids[1]);
    act(() => menuItem('Shape this block').click());
    act(() => menuItem('Build up').click());
    await settle(120);
    const now = blockIds();
    const covers = (first: Id, last: Id) => {
      expect(loop()).toEqual({ fromBlockId: first, toBlockId: last });
      const b = band()!.getBoundingClientRect();
      expect(Math.abs(b.left - blockEl(first).getBoundingClientRect().left)).toBeLessThan(1.5);
      expect(Math.abs(b.right - blockEl(last).getBoundingClientRect().right)).toBeLessThan(1.5);
    };
    // The whole build (Groove became blocks 2–5) is in the loop.
    expect(now.length).toBe(ids.length + 3);
    covers(ids[0], now[4]);
    // Undo: Groove is one block again, and the loop ends with it.
    act(() => session.undo());
    await settle(260);
    expect(blockIds()).toEqual(ids);
    covers(ids[0], ids[1]);
    // Redo: the build again, all of it looped.
    act(() => session.redo());
    await settle(260);
    expect(blockIds()).toEqual(now);
    covers(ids[0], now[4]);
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
    expect(document.querySelector('[role="menu"]')!.textContent).toContain('make it play at least 2 times first');
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
    const rs = runtimeStore.getState();
    // (If the browser stalls, the session stops the song and says so: the message shows it.)
    expect(plan, JSON.stringify({ playing: rs.playing, paused: rs.paused, mode: rs.mode, stalled: rs.stalled, notice: rs.notice, block: rs.songBlockId })).not.toBeNull();
    const made = blockIds().slice(1, 5);
    const drums = trackId('Drums');
    for (const [i, id] of made.entries()) {
      const b = plan.find((x) => x.blockId === id);
      expect(b, `block ${i + 2} in the plan`).toBeTruthy();
      expect(drums in b!.parts ? b!.parts[drums] : 'scene').toBe(i < 3 ? null : 'scene');
    }
  });
});
