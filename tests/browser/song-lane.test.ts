/**
 * The song lane's gestures in real Chromium, with real PointerEvents and
 * KeyboardEvents, checked on the project in session.store (the data playback
 * and export use):
 * - selection (click, Shift, Ctrl/Cmd, empty lane, Ctrl+A, Esc);
 * - drag with Ctrl = copy (also toggled mid-drag), multi-select drags keep
 *   their order, every cancel path (Esc, release away, pointercancel, lost
 *   capture, window blur, unmount) leaves no change, no lifted block and no
 *   listener behind, edge auto-scroll;
 * - edge drag for passes (one undo step), split at a divider, join from the
 *   menu and from the seam;
 * - part cells (off/on, the picker, layering one part), a scene card dropped
 *   onto a block (layer, with a preview) or between blocks (insert);
 * - the block clipboard, rename, and a keyboard-only path for every action;
 * - Simple vs Advanced detail.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { clearBlockClipboard } from '../../src/app/views/arrange/songActions';
import { getStarter } from '../../src/content/starters';
import type { Id } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setUiMode, setView } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, key, mount, pointer, wait } from './ui-harness';

beforeEach(() => {
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  clearBlockClipboard();
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off', playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, replayId: null });
    setView('arrange');
    setUiMode('simple');
  });
});

afterEach(() => {
  if (session.playing) act(() => session.stop());
  cleanup();
  vi.restoreAllMocks();
  act(() => {
    patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, replayId: null });
    setUiMode('simple');
    // The view is remembered in localStorage, shared with the other test files: leave the default.
    setView('play');
  });
});

async function setup(width = 1320) {
  const m = mount(h('div', { style: { width: `${width}px`, height: '680px', display: 'flex', flexDirection: 'column' } }, h(ArrangeView)), { width: width + 40 });
  await actFrame();
  await actFrame();
  await settle(260);
  return m;
}

async function settle(ms = 360) {
  await act(async () => {
    await wait(ms);
  });
}

const project = () => session.store.getState();
const blocks = () => project().arrangement.blocks;
const blockIds = () => blocks().map((b) => b.id);
const sceneId = (name: string) => project().scenes.find((s) => s.name === name)!.id;
const trackId = (name: string) => project().tracks.find((t) => t.name === name)!.id;
const blockEl = (id: Id) => document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const cellEl = (id: Id, track: Id) => blockEl(id).querySelector<HTMLButtonElement>(`[data-cell][data-track="${track}"]`)!;
const placedX = (id: Id) => Number(/translate3d\((-?[\d.]+)px/.exec(blockEl(id).style.transform)?.[1] ?? NaN);
const lane = () => document.querySelector<HTMLElement>('[data-testid="song-lane"]')!;
const clone = () => document.querySelector<HTMLElement>('[data-testid="lane-clone"]');
const status = () => document.querySelector('[data-testid="lane-status"]')!.textContent ?? '';
const undoCount = () => session.store.historySize().undo;
const selected = () => [...document.querySelectorAll<HTMLElement>('[data-block-id][data-selected]')].map((e) => e.dataset.blockId);

function click(el: Element, init: MouseEventInit = {}) {
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
}

function menuItem(text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((x) => x.textContent!.trim().startsWith(text));
  if (!el) throw new Error(`No menu item "${text}…" in ${[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((x) => x.textContent).join(' | ')}`);
  return el;
}

function byLabel<T extends HTMLElement = HTMLButtonElement>(start: string, root: ParentNode = document): T {
  const el = [...root.querySelectorAll<T>('[aria-label]')].find((x) => x.getAttribute('aria-label')!.startsWith(start));
  if (!el) throw new Error(`No element labelled "${start}…"`);
  return el;
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Press on a block's header, pass the threshold, and move by dx. */
function startDrag(id: Id, dx: number, init: PointerEventInit = {}) {
  const r = blockEl(id).getBoundingClientRect();
  const start = { clientX: r.left + 20, clientY: r.top + 12 };
  pointer(blockEl(id), 'pointerdown', start);
  pointer(document.body, 'pointermove', { clientX: start.clientX + 6, clientY: start.clientY + 1, ...init });
  const at = { clientX: start.clientX + dx, clientY: start.clientY + 2, ...init };
  pointer(document.body, 'pointermove', at);
  return at;
}

/**
 * Record the listeners added to window and document from now on; `balanced()`
 * says whether every one of them was removed again.
 */
function watchListeners() {
  const added: [EventTarget, string, unknown][] = [];
  const removed: [EventTarget, string, unknown][] = [];
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
      added.push([target, type, fn]);
      add(type, fn, opts);
    });
    vi.spyOn(target, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
      removed.push([target, type, fn]);
      remove(type, fn, opts);
    });
  }
  return {
    count: () => added.length,
    leftover: () => added.filter(([t, type, fn]) => !removed.some(([t2, type2, fn2]) => t2 === t && type2 === type && fn2 === fn)).map(([, type]) => type),
  };
}

/* ------------------------------------------------------------------ */

describe('selection', () => {
  it('click selects; Shift+click a range; Ctrl/Cmd+click toggles; empty lane, Esc clear; Ctrl+A selects all', async () => {
    await setup();
    const ids = blockIds();
    click(blockEl(ids[1]));
    expect(selected()).toEqual([ids[1]]);
    expect(blockEl(ids[1]).getAttribute('aria-label')).toContain('selected');
    click(blockEl(ids[3]), { shiftKey: true });
    expect(selected()).toEqual(ids.slice(1, 4));
    click(blockEl(ids[2]), { ctrlKey: true });
    expect(selected()).toEqual([ids[1], ids[3]]);
    click(blockEl(ids[5]), { metaKey: true });
    expect(selected()).toEqual([ids[1], ids[3], ids[5]]);
    // Clicking the empty end of the lane clears it.
    const track = blockEl(ids[0]).parentElement!;
    pointer(track, 'pointerdown', { clientX: 5, clientY: 5 });
    pointer(track, 'pointerup', { clientX: 5, clientY: 5 });
    expect(selected()).toEqual([]);
    act(() => blockEl(ids[0]).focus());
    key(blockEl(ids[0]), 'keydown', { key: 'a', ctrlKey: true });
    expect(selected()).toEqual(ids);
    expect(status()).toContain('All 6 blocks selected');
    const esc = key(blockEl(ids[0]), 'keydown', { key: 'Escape' });
    expect(esc.defaultPrevented).toBe(true);
    expect(selected()).toEqual([]);
    // Nothing selected: Escape is left to others.
    expect(key(blockEl(ids[0]), 'keydown', { key: 'Escape' }).defaultPrevented).toBe(false);
  });
});

describe('dragging blocks', () => {
  it('Ctrl while dropping copies: the original stays, the copy lands where the slot opened, one undo step', async () => {
    await setup();
    const ids = blockIds();
    const xs = ids.map(placedX);
    const at = startDrag(ids[0], xs[3] - xs[0] + 10, { ctrlKey: true });
    expect(clone()!.textContent).toContain('+ Copy');
    expect(clone()!.dataset.copy).toBeDefined();
    // The original stays in place, visible; the slot opened before block 4 (blocks 4–6 moved right by its width).
    const w = blockEl(ids[0]).getBoundingClientRect().width;
    expect(placedX(ids[0])).toBe(xs[0]);
    expect(blockEl(ids[0]).hasAttribute('data-hidden')).toBe(false);
    expect(placedX(ids[3])).toBeCloseTo(xs[3] + w, 0);
    const before = undoCount();
    pointer(document.body, 'pointerup', { ...at, ctrlKey: true });
    const after = blocks();
    expect(after.length).toBe(7);
    expect(after.slice(0, 3).map((b) => b.id)).toEqual(ids.slice(0, 3));
    expect(after[3].sceneId).toBe(blocks()[0].sceneId);
    expect(after[3].id).not.toBe(ids[0]);
    expect(undoCount()).toBe(before + 1);
    expect(selected()).toEqual([after[3].id]);
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    act(() => session.undo());
    expect(blockIds()).toEqual(ids);
  });

  it('pressing Ctrl mid-drag switches to copy, releasing it switches back to move', async () => {
    await setup();
    const ids = blockIds();
    const xs = ids.map(placedX);
    const at = startDrag(ids[0], xs[3] - xs[0] + 10);
    expect(clone()!.dataset.copy).toBeUndefined();
    expect(blockEl(ids[0]).hasAttribute('data-hidden')).toBe(true);
    key(window, 'keydown', { key: 'Control', ctrlKey: true });
    expect(clone()!.dataset.copy).toBeDefined();
    expect(blockEl(ids[0]).hasAttribute('data-hidden')).toBe(false);
    key(window, 'keyup', { key: 'Control' });
    expect(clone()!.dataset.copy).toBeUndefined();
    pointer(document.body, 'pointerup', at);
    expect(blockIds().length).toBe(6);
    expect(blockIds().indexOf(ids[0])).toBe(3);
  });

  it('a multi-selection moves together and keeps its order', async () => {
    await setup();
    const ids = blockIds();
    click(blockEl(ids[0]));
    click(blockEl(ids[2]), { ctrlKey: true });
    expect(selected()).toEqual([ids[0], ids[2]]);
    const xs = ids.map(placedX);
    // Carry block 3 (and block 1 with it) past the end.
    const at = startDrag(ids[2], 2000);
    expect(clone()!.textContent).toContain('2 blocks');
    expect(blockEl(ids[0]).hasAttribute('data-hidden')).toBe(true);
    expect(blockEl(ids[2]).hasAttribute('data-hidden')).toBe(true);
    expect(placedX(ids[1])).toBe(0);
    pointer(document.body, 'pointerup', at);
    expect(blockIds()).toEqual([ids[1], ids[3], ids[4], ids[5], ids[0], ids[2]]);
    expect(selected()).toEqual([ids[0], ids[2]]);
    expect(status()).toContain('Moved 2 blocks');
    act(() => session.undo());
    expect(blockIds()).toEqual(ids);
    expect(xs[0]).toBe(0);
  });

  it('every way a drag can end early leaves the song, the blocks and the listeners as they were', async () => {
    const m = await setup();
    const ids = blockIds();
    const xs = ids.map(placedX);
    const before = undoCount();
    const ends: [string, () => void][] = [
      ['Escape', () => key(window, 'keydown', { key: 'Escape' })],
      ['pointercancel', () => pointer(document.body, 'pointercancel', { clientX: 400, clientY: 300 })],
      ['lost capture', () => pointer(blockEl(ids[1]), 'lostpointercapture', { clientX: 400, clientY: 300 })],
      ['window blur', () => fire(window, new Event('blur'))],
      ['release away from the lane', () => pointer(document.body, 'pointerup', { clientX: 400, clientY: 2000 })],
    ];
    for (const [what, end] of ends) {
      const watch = watchListeners();
      startDrag(ids[1], xs[4] - xs[1]);
      expect(clone(), what).not.toBeNull();
      expect(watch.count(), what).toBeGreaterThan(0);
      end();
      // A release after the cancel does nothing either.
      pointer(document.body, 'pointerup', { clientX: 900, clientY: 300 });
      expect(clone(), what).toBeNull();
      expect(lane().hasAttribute('data-carry'), what).toBe(false);
      expect(blockIds(), what).toEqual(ids);
      expect(watch.leftover(), what).toEqual([]);
      vi.restoreAllMocks();
      await settle();
      expect(ids.map(placedX), what).toEqual(xs);
      expect(blockEl(ids[1]).hasAttribute('data-hidden'), what).toBe(false);
    }
    expect(undoCount()).toBe(before);
    // The lane going away mid-drag (a view switch) cleans up too.
    const watch = watchListeners();
    startDrag(ids[1], 300);
    m.unmount();
    pointer(document.body, 'pointermove', { clientX: 900, clientY: 300 });
    pointer(document.body, 'pointerup', { clientX: 900, clientY: 300 });
    expect(blockIds()).toEqual(ids);
    expect(watch.leftover()).toEqual([]);
  });

  it('dragging near the lane edge scrolls it, and the drop target follows the scroll', async () => {
    // A song too long to show whole in a 700 px lane (it opens scrolling).
    act(() => {
      for (let i = 0; i < 16; i++) cmdAddBlock(project().scenes[i % 4].id);
    });
    await setup(700);
    const ids = blockIds();
    const scroller = blockEl(ids[0]).closest<HTMLElement>('[data-fade-right], [data-fade-left]') ?? blockEl(ids[0]).parentElement!.parentElement!.parentElement!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(scroller.scrollLeft).toBe(0);
    const right = scroller.getBoundingClientRect().right;
    const r = blockEl(ids[0]).getBoundingClientRect();
    pointer(blockEl(ids[0]), 'pointerdown', { clientX: r.left + 20, clientY: r.top + 12 });
    pointer(document.body, 'pointermove', { clientX: r.left + 30, clientY: r.top + 13 });
    pointer(document.body, 'pointermove', { clientX: right - 4, clientY: r.top + 13 });
    await settle(900);
    expect(scroller.scrollLeft).toBeGreaterThan(100);
    pointer(document.body, 'pointerup', { clientX: right - 4, clientY: r.top + 13 });
    // Carried to the far end while the lane scrolled.
    expect(blockIds().indexOf(ids[0])).toBeGreaterThanOrEqual(4);
  });
});

describe('length, split and join', () => {
  it('dragging the right edge changes passes live; the drop is one undo step and the ruler follows', async () => {
    await setup();
    const ids = blockIds();
    const id = ids[0];
    const before = undoCount();
    const w0 = blockEl(id).getBoundingClientRect().width;
    const pass = w0 / 2;
    const x1 = placedX(ids[1]);
    const edge = blockEl(id).querySelector<HTMLElement>('[data-edge]')!;
    const r = edge.getBoundingClientRect();
    const start = { clientX: r.left + r.width / 2, clientY: r.top + 20 };
    pointer(edge, 'pointerdown', start);
    pointer(document.body, 'pointermove', { clientX: start.clientX + 6, clientY: start.clientY });
    pointer(document.body, 'pointermove', { clientX: start.clientX + 3 * pass + 4, clientY: start.clientY });
    const bubble = document.querySelector<HTMLElement>('[data-testid="lane-bubble"]')!;
    expect(bubble.textContent).toBe('5 times · 20 bars');
    expect(bubble.hasAttribute('data-on')).toBe(true);
    expect(lane().dataset.carry).toBe('resize');
    // The block's header says the length the drop gives, live (its own length is the old one until the drop).
    await actFrame();
    const liveLen = blockEl(id).querySelector<HTMLElement>('[data-live-len]')!;
    expect(liveLen.textContent).toBe('20 bars');
    expect(getComputedStyle(liveLen).display).not.toBe('none');
    expect(getComputedStyle(blockEl(id).querySelector('[data-testid="block-length"]')!).display).toBe('none');
    // The block widened and the next one rippled by the same amount; nothing committed yet.
    expect(parseFloat(blockEl(id).style.width)).toBeCloseTo(5 * pass, -1);
    expect(placedX(ids[1])).toBeCloseTo(x1 + 3 * pass, -1);
    expect(blocks()[0].repeats).toBe(2);
    pointer(document.body, 'pointerup', { clientX: start.clientX + 3 * pass + 4, clientY: start.clientY });
    expect(blocks()[0].repeats).toBe(5);
    expect(undoCount()).toBe(before + 1);
    expect(bubble.hasAttribute('data-on')).toBe(false);
    expect(status()).toContain('plays 5 times, 20 bars');
    await actFrame();
    expect(getComputedStyle(liveLen).display).toBe('none');
    expect(blockEl(id).querySelector('[data-testid="block-length"]')!.textContent).toBe('20 bars');
    // The ruler marks block 2's first bar after the longer Intro (a block-start line at its left edge), and its
    // numbers stay on a regular bar step.
    await actFrame();
    const ruler = document.querySelector('[data-testid="song-ruler"]')!;
    const starts = [...ruler.querySelectorAll<HTMLElement>('[data-start]')].map((m) => Math.round(parseFloat(m.style.left)));
    expect(starts).toContain(Math.round(placedX(ids[1])));
    const nums = [...ruler.querySelectorAll<HTMLElement>('[data-label]')].map((m) => Number(m.textContent));
    expect(nums[0]).toBe(1);
    expect(nums.every((n) => (n - 1) % (nums[1] - 1) === 0)).toBe(true);
    expect(document.querySelector('[data-testid="song-length"]')!.textContent).toContain('84 bars');
    act(() => session.undo());
    expect(blocks()[0].repeats).toBe(2);
    // Escape during an edge drag commits nothing.
    const r2 = edge.getBoundingClientRect();
    pointer(edge, 'pointerdown', { clientX: r2.left + 6, clientY: r2.top + 20 });
    pointer(document.body, 'pointermove', { clientX: r2.left + 6 + 200, clientY: r2.top + 20 });
    key(window, 'keydown', { key: 'Escape' });
    pointer(document.body, 'pointerup', { clientX: r2.left + 6 + 200, clientY: r2.top + 20 });
    expect(blocks()[0].repeats).toBe(2);
    await settle();
    expect(blockEl(id).getBoundingClientRect().width).toBeCloseTo(w0, 0);
  });

  it('splits at a pass divider (scissors) and joins again from the menu and from the seam', async () => {
    await setup();
    const id = blockIds()[1]; // Groove, 4 passes
    const before = undoCount();
    click(byLabel('Split Groove in two after it plays once (of 4)', blockEl(id)));
    expect(blocks().length).toBe(7);
    expect(blocks()[1]).toMatchObject({ id, repeats: 1 });
    expect(blocks()[2]).toMatchObject({ sceneId: blocks()[1].sceneId, repeats: 3 });
    expect(undoCount()).toBe(before + 1);
    // Join with next from the actions menu.
    act(() => blockEl(id).focus());
    key(blockEl(id), 'keydown', { key: 'Enter' });
    click(menuItem('Join with next'));
    expect(blocks().length).toBe(6);
    expect(blocks()[1]).toMatchObject({ id, repeats: 4 });
    // Split again; this time join from the chip on the seam between the two halves.
    click(byLabel('Split Groove in two after it plays 2 times (of 4)', blockEl(id)));
    const chip = document.querySelector<HTMLElement>(`[data-join="${id}"]`)!;
    expect(chip).not.toBeNull();
    click(chip);
    expect(blocks()[1]).toMatchObject({ id, repeats: 4 });
    expect(blocks().length).toBe(6);
    // A block that cannot be joined says why in its menu.
    act(() => blockEl(id).focus());
    key(blockEl(id), 'keydown', { key: 'Enter' });
    expect(menuItem('Join with next').getAttribute('aria-disabled')).toBe('true');
    // The reason is said once (in full under the item; the item itself carries a short hint).
    const menuText = document.querySelector('[role="menu"]')!.textContent!;
    expect(menuText.split('Only neighbours that play the same scene').length - 1).toBe(1);
    expect(menuItem('Join with next').textContent).toContain('Not the same');
    key(document.activeElement!, 'keydown', { key: 'Escape' });
  });
});

describe('parts', () => {
  it('a cell click switches a part off and on again; a cell without a clip opens the picker, which layers or switches off', async () => {
    await setup();
    const groove = blockIds()[1];
    const drums = trackId('Drums');
    const lead = trackId('Lead');
    const parts = () => blocks().find((b) => b.id === groove)!.parts;
    click(cellEl(groove, drums));
    expect(parts()).toEqual({ [drums]: null });
    expect(cellEl(groove, drums).getAttribute('aria-pressed')).toBe('false');
    expect(cellEl(groove, drums).textContent).toBe('Off');
    expect(cellEl(groove, drums).getAttribute('aria-label')).toBe('Drums in Groove (block 2): off');
    click(cellEl(groove, drums));
    expect(parts()).toBeUndefined();
    // Groove has no Lead clip: the click opens the picker.
    click(cellEl(groove, lead));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('What Lead plays in Groove');
    const liftClip = project().tracks.find((t) => t.id === lead)!.clips[project().scenes.findIndex((s) => s.name === 'Lift')]!.name;
    click(menuItem(`Lift: ${liftClip}`));
    expect(parts()).toEqual({ [lead]: sceneId('Lift') });
    // A layered part says where it comes from and what it plays.
    expect(cellEl(groove, lead).textContent).toBe(`Lift:${liftClip}`);
    expect(cellEl(groove, lead).querySelector('svg')).not.toBeNull();
    expect(cellEl(groove, lead).getAttribute('aria-label')).toBe(`Lead in Groove (block 2): plays “${liftClip}” from Lift`);
    // The block's length follows the longest clip it plays.
    expect(blockEl(groove).getAttribute('aria-label')).toContain('1 part changed');
    // Right-click a cell: the picker again; Off in this block.
    fire(cellEl(groove, lead), new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    click(menuItem('Off in this block'));
    expect(parts()).toEqual({ [lead]: null });
    // Reset all parts from the block's menu.
    act(() => blockEl(groove).focus());
    key(blockEl(groove), 'keydown', { key: 'Enter' });
    click(menuItem('Parts in this block'));
    click(menuItem('Reset all parts'));
    expect(parts()).toBeUndefined();
  });

  it('a press on a cell that moves is a drag, not a toggle', async () => {
    await setup();
    const ids = blockIds();
    const xs = ids.map(placedX);
    const drums = trackId('Drums');
    const cell = cellEl(ids[0], drums);
    const r = cell.getBoundingClientRect();
    pointer(cell, 'pointerdown', { clientX: r.left + 10, clientY: r.top + 5 });
    pointer(document.body, 'pointermove', { clientX: r.left + 20, clientY: r.top + 5 });
    pointer(document.body, 'pointermove', { clientX: r.left + 10 + xs[2] - xs[0] + 10, clientY: r.top + 5 });
    pointer(cell, 'pointerup', { clientX: r.left + 10 + xs[2] - xs[0] + 10, clientY: r.top + 5 });
    // The click the browser sends after a drag is swallowed.
    click(cell);
    expect(blockIds().indexOf(ids[0])).toBe(2);
    expect(blocks().find((b) => b.id === ids[0])!.parts).toBeUndefined();
  });

  it('a scene card dropped onto a block fills its silent parts (with a preview); between blocks it inserts a new block', async () => {
    await setup();
    const ids = blockIds();
    const groove = ids[1];
    // The parts Groove leaves silent that Lift has a clip for: what layering fills.
    const p0 = project();
    const liftRow = p0.scenes.findIndex((s) => s.name === 'Lift');
    const grooveRow = p0.scenes.findIndex((s) => s.name === 'Groove');
    const silent = p0.tracks.filter((t) => t.clips[liftRow] && !t.clips[grooveRow]).map((t) => t.id);
    const both = p0.tracks.filter((t) => t.clips[liftRow]).map((t) => t.id);
    expect(silent.length).toBeGreaterThan(0);
    expect(both.length).toBeGreaterThan(silent.length);
    const card = byLabel<HTMLElement>('Scene Lift');
    const r = blockEl(groove).getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    pointer(card, 'pointerdown', { clientX: cr.left + 20, clientY: cr.top + 10 });
    pointer(document.body, 'pointermove', { clientX: cr.left + 30, clientY: cr.top + 5 });
    pointer(document.body, 'pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 60 });
    // Layer preview: the block is outlined, says what will happen, and the parts that change say where from and what.
    expect(blockEl(groove).dataset.layerTarget).toBe('on');
    expect(blockEl(groove).textContent).toContain('Layer Lift into Groove');
    let previews = [...blockEl(groove).querySelectorAll<HTMLElement>('[data-cell][data-preview]')];
    expect(previews.map((c) => c.dataset.track).sort()).toEqual([...silent].sort());
    expect(previews.every((c) => c.textContent!.startsWith('Lift:'))).toBe(true);
    const ghost = () => document.querySelector('[data-testid="lane-ghost"]')!.textContent!;
    expect(ghost()).toContain('Layer Lift into Groove');
    expect(ghost()).toContain(`Shift replaces ${both.length} parts`);
    expect(document.querySelector('[data-testid="lane-slot"]')!.hasAttribute('data-on')).toBe(false);
    // Holding Shift turns it into Replace: every part Lift has, said in the preview.
    key(window, 'keydown', { key: 'Shift', shiftKey: true });
    expect(ghost()).toContain('Replace Groove’s parts with Lift’s');
    expect(blockEl(groove).textContent).toContain('Replace Groove’s parts with Lift’s');
    previews = [...blockEl(groove).querySelectorAll<HTMLElement>('[data-cell][data-preview]')];
    expect(previews.length).toBe(both.length);
    key(window, 'keyup', { key: 'Shift' });
    expect(ghost()).toContain('Layer Lift into Groove');
    const before = undoCount();
    pointer(document.body, 'pointerup', { clientX: r.left + r.width / 2, clientY: r.top + 60 });
    const parts = blocks()[1].parts!;
    expect(Object.keys(parts).sort()).toEqual([...silent].sort());
    expect(Object.values(parts).every((v) => v === sceneId('Lift'))).toBe(true);
    expect(undoCount()).toBe(before + 1);
    expect(runtimeStore.getState().notice?.text).toContain('Layered Lift into Groove');
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    // Shift held while dropping replaces (one more undo step).
    act(() => session.undo());
    await settle();
    pointer(card, 'pointerdown', { clientX: cr.left + 20, clientY: cr.top + 10 });
    pointer(document.body, 'pointermove', { clientX: cr.left + 30, clientY: cr.top + 5, shiftKey: true });
    pointer(document.body, 'pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 60, shiftKey: true });
    pointer(document.body, 'pointerup', { clientX: r.left + r.width / 2, clientY: r.top + 60, shiftKey: true });
    expect(Object.keys(blocks()[1].parts!).sort()).toEqual([...both].sort());
    expect(runtimeStore.getState().notice?.text).toContain('Replaced');
    act(() => session.undo());
    await settle();

    // Between blocks 3 and 4: the slot opens there and the drop inserts a block.
    const card2 = byLabel<HTMLElement>('Scene Break');
    const r3 = blockEl(ids[3]).getBoundingClientRect();
    const c2 = card2.getBoundingClientRect();
    pointer(card2, 'pointerdown', { clientX: c2.left + 20, clientY: c2.top + 10 });
    pointer(document.body, 'pointermove', { clientX: c2.left + 30, clientY: c2.top + 5 });
    pointer(document.body, 'pointermove', { clientX: r3.left + 4, clientY: r3.top + 60 });
    const slot = document.querySelector<HTMLElement>('[data-testid="lane-slot"]')!;
    expect(slot.hasAttribute('data-on')).toBe(true);
    expect(document.querySelector('[data-testid="lane-ghost"]')!.textContent).toContain('Insert Break as block 4');
    expect(document.querySelector('[data-layer-target]')).toBeNull();
    // First a line on the boundary (nothing moves yet); after a short rest the slot opens and block 4 moves aside.
    const x3 = placedX(ids[3]);
    expect(slot.hasAttribute('data-pending')).toBe(true);
    expect(placedX(ids[3])).toBe(x3);
    await settle(250);
    expect(slot.hasAttribute('data-pending')).toBe(false);
    expect(placedX(ids[3])).toBeGreaterThan(x3 + 50);
    pointer(document.body, 'pointerup', { clientX: r3.left + 4, clientY: r3.top + 60 });
    expect(blocks().length).toBe(7);
    expect(blocks()[3].sceneId).toBe(sceneId('Break'));
    expect(blocks()[4].id).toBe(ids[3]);
    // Coming from the side over a boundary to the middle of a block (without resting on the boundary) layers into it.
    await settle();
    const b5 = blocks()[5].id;
    const r4 = blockEl(blocks()[4].id).getBoundingClientRect();
    const r5 = blockEl(b5).getBoundingClientRect();
    const c3 = byLabel<HTMLElement>('Scene Intro').getBoundingClientRect();
    pointer(byLabel<HTMLElement>('Scene Intro'), 'pointerdown', { clientX: c3.left + 20, clientY: c3.top + 10 });
    pointer(document.body, 'pointermove', { clientX: c3.left + 30, clientY: c3.top + 5 });
    for (let x = r4.left + r4.width / 2; x <= r5.left + r5.width / 2; x += 12) pointer(document.body, 'pointermove', { clientX: x, clientY: r4.top + 60 });
    pointer(document.body, 'pointermove', { clientX: r5.left + r5.width / 2, clientY: r4.top + 60 });
    expect(blockEl(b5).dataset.layerTarget).toBe('on');
    pointer(document.body, 'pointerup', { clientX: r5.left + r5.width / 2, clientY: r4.top + 60 });
    expect(blocks().length).toBe(7);
    expect(Object.values(blocks()[5].parts ?? {})).toContain(sceneId('Intro'));
    // Dropped back on the palette: nothing.
    pointer(card2, 'pointerdown', { clientX: c2.left + 20, clientY: c2.top + 10 });
    pointer(document.body, 'pointermove', { clientX: c2.left + 60, clientY: c2.top + 10 });
    pointer(document.body, 'pointerup', { clientX: c2.left + 60, clientY: c2.top + 10 });
    expect(blocks().length).toBe(7);
  });
});

describe('clipboard and rename', () => {
  it('Ctrl+C / Ctrl+V paste copies after the selection; Ctrl+X cuts; each is one undo step', async () => {
    await setup();
    const ids = blockIds();
    act(() => blockEl(ids[0]).focus());
    key(blockEl(ids[0]), 'keydown', { key: 'c', ctrlKey: true });
    expect(runtimeStore.getState().notice?.text).toContain('Copied Intro');
    click(blockEl(ids[2]));
    act(() => blockEl(ids[2]).focus());
    key(blockEl(ids[2]), 'keydown', { key: 'v', ctrlKey: true });
    expect(blocks().length).toBe(7);
    expect(blocks()[3].sceneId).toBe(blocks()[0].sceneId);
    expect(blocks()[3].repeats).toBe(blocks()[0].repeats);
    expect(selected()).toEqual([blocks()[3].id]);
    expect(document.activeElement).toBe(blockEl(blocks()[3].id));
    act(() => session.undo());
    expect(blockIds()).toEqual(ids);
    // Cut block 2, paste it after the last.
    act(() => blockEl(ids[1]).focus());
    const groove = blocks()[1];
    key(blockEl(ids[1]), 'keydown', { key: 'x', ctrlKey: true });
    expect(blockIds()).not.toContain(ids[1]);
    const last = blockIds()[blockIds().length - 1];
    act(() => blockEl(last).focus());
    key(blockEl(last), 'keydown', { key: 'v', ctrlKey: true });
    expect(blocks().length).toBe(6);
    expect(blocks()[5]).toMatchObject({ sceneId: groove.sceneId, repeats: groove.repeats });
    // The shortcuts also work while a part cell of the block has focus.
    const first = blocks()[0].id;
    act(() => cellEl(first, trackId('Drums')).focus());
    key(cellEl(first, trackId('Drums')), 'keydown', { key: 'd', ctrlKey: true });
    expect(blocks().length).toBe(7);
    expect(blocks()[1].sceneId).toBe(blocks()[0].sceneId);
  });

  it('renames inline (F2 or the menu): Enter saves, Escape cancels, empty shows the scene name again', async () => {
    await setup();
    const id = blockIds()[2]; // Lift
    act(() => blockEl(id).focus());
    key(blockEl(id), 'keydown', { key: 'F2' });
    let input = blockEl(id).querySelector<HTMLInputElement>('input')!;
    expect(document.activeElement).toBe(input);
    typeInto(input, 'Drop');
    key(input, 'keydown', { key: 'Enter' });
    expect(blocks()[2].label).toBe('Drop');
    expect(blockEl(id).getAttribute('aria-label')).toContain('Drop (scene Lift)');
    expect(blockEl(id).textContent).toContain('Lift');
    expect(document.activeElement).toBe(blockEl(id));
    // Escape keeps the name.
    key(blockEl(id), 'keydown', { key: 'Enter' });
    click(menuItem('Rename'));
    input = blockEl(id).querySelector<HTMLInputElement>('input')!;
    typeInto(input, 'Nope');
    key(input, 'keydown', { key: 'Escape' });
    expect(blocks()[2].label).toBe('Drop');
    // Empty: back to the scene name.
    key(blockEl(id), 'keydown', { key: 'F2' });
    input = blockEl(id).querySelector<HTMLInputElement>('input')!;
    typeInto(input, '');
    key(input, 'keydown', { key: 'Enter' });
    expect(blocks()[2].label).toBeUndefined();
    expect(blockEl(id).getAttribute('aria-label')).toContain(': Lift,');
  });
});

describe('keyboard only', () => {
  it('moves through blocks and parts, extends the selection, duplicates, removes, changes parts and passes, and plays from a bar', async () => {
    await setup();
    const ids = blockIds();
    // One Tab stop for the blocks: only the first is tabbable.
    expect([...document.querySelectorAll('[data-block-id]')].filter((e) => e.getAttribute('tabindex') === '0').length).toBe(1);
    act(() => blockEl(ids[0]).focus());
    key(document.activeElement!, 'keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(blockEl(ids[1]));
    expect(selected()).toEqual([ids[1]]);
    key(document.activeElement!, 'keydown', { key: 'ArrowRight', shiftKey: true });
    expect(selected()).toEqual([ids[1], ids[2]]);
    expect(blockEl(ids[2]).getAttribute('tabindex')).toBe('0');
    // Ctrl+D: copies of both right after them, selected.
    key(document.activeElement!, 'keydown', { key: 'd', ctrlKey: true });
    expect(blocks().length).toBe(8);
    expect(blocks()[3].sceneId).toBe(blocks()[1].sceneId);
    expect(blocks()[4].sceneId).toBe(blocks()[2].sceneId);
    expect(selected()).toEqual([blocks()[3].id, blocks()[4].id]);
    // Delete removes the selection in one step.
    key(document.activeElement!, 'keydown', { key: 'Delete' });
    expect(blockIds()).toEqual(ids);
    // +/- on the focused block, with a status line for screen readers.
    act(() => blockEl(ids[3]).focus());
    key(blockEl(ids[3]), 'keydown', { key: 'Home' });
    expect(document.activeElement).toBe(blockEl(ids[0]));
    key(document.activeElement!, 'keydown', { key: '+' });
    expect(blocks()[0].repeats).toBe(3);
    expect(status()).toBe('Intro: plays 3 times, 12 bars.');
    // Down into the part cells; Enter toggles; up and down; Escape back to the block.
    key(document.activeElement!, 'keydown', { key: 'ArrowDown' });
    const drums = trackId('Drums');
    expect(document.activeElement).toBe(cellEl(ids[0], drums));
    key(document.activeElement!, 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cellEl(ids[0], trackId('Percussion')));
    key(document.activeElement!, 'keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cellEl(ids[1], trackId('Percussion')));
    click(document.activeElement!);
    expect(blocks()[1].parts).toEqual({ [trackId('Percussion')]: null });
    // "." opens the picker for that part.
    key(document.activeElement!, 'keydown', { key: '.' });
    expect(document.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('What Percussion plays in Groove');
    click(menuItem('Groove:'));
    expect(blocks()[1].parts).toBeUndefined();
    key(cellEl(ids[1], trackId('Percussion')), 'keydown', { key: 'Escape' });
    expect(document.activeElement).toBe(blockEl(ids[1]));
    // The actions menu (Shift+F10) lists the parts with checkboxes.
    key(document.activeElement!, 'keydown', { key: 'F10', shiftKey: true });
    click(menuItem('Parts in this block'));
    const bass = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemcheckbox"]')].find((x) => x.textContent!.startsWith('Bass'))!;
    expect(bass.getAttribute('aria-checked')).toBe('true');
    click(bass);
    expect(blocks()[1].parts).toEqual({ [trackId('Bass')]: null });
    key(document.activeElement!, 'keydown', { key: 'Escape' });
    // Split in half and Layer a scene in, from the menu.
    act(() => blockEl(ids[1]).focus());
    key(blockEl(ids[1]), 'keydown', { key: 'ContextMenu' });
    click(menuItem('Split in half'));
    expect(blocks()[1].repeats).toBe(2);
    expect(blocks()[2].repeats).toBe(2);
    act(() => blockEl(ids[0]).focus());
    key(blockEl(ids[0]), 'keydown', { key: 'Enter' });
    click(menuItem('Scenes and clips'));
    click(menuItem('Layer a scene in'));
    click(menuItem('Break'));
    expect(Object.values(blocks()[0].parts ?? {}).every((v) => v === sceneId('Break'))).toBe(true);
    // Alt+Right moves; Copy / Paste after from the menu.
    act(() => blockEl(ids[0]).focus());
    key(blockEl(ids[0]), 'keydown', { key: 'ArrowRight', altKey: true });
    expect(blockIds()[1]).toBe(ids[0]);
    key(document.activeElement!, 'keydown', { key: 'Enter' });
    click(menuItem('Copy, cut, move'));
    click(menuItem('Copy block'));
    key(document.activeElement!, 'keydown', { key: 'Enter' });
    click(menuItem('Copy, cut, move'));
    click(menuItem('Paste after'));
    expect(blocks()[2].sceneId).toBe(blocks()[1].sceneId);
    // The ruler: arrows choose a bar, Enter plays the song from it.
    const ruler = document.querySelector<HTMLElement>('[data-testid="song-ruler"]')!;
    expect(ruler.getAttribute('tabindex')).toBe('0');
    act(() => ruler.focus());
    for (let i = 0; i < 9; i++) key(ruler, 'keydown', { key: 'ArrowRight' });
    expect(ruler.getAttribute('aria-valuenow')).toBe('10');
    await act(async () => {
      key(ruler, 'keydown', { key: 'Enter' });
      await wait(50);
    });
    const start = performance.now();
    while (!(runtimeStore.getState().playing && runtimeStore.getState().mode === 'song') && performance.now() - start < 8000) await settle(30);
    expect(runtimeStore.getState().mode).toBe('song');
    expect(session.transport!.getPosition().tick).toBeGreaterThanOrEqual(9 * 384 - 1);
  });
});

describe('Simple and Advanced', () => {
  it('Advanced adds the pass detail and the part picker arrows; Simple keeps cells, drag, edge and split', async () => {
    await setup();
    const id = blockIds()[1];
    expect(blockEl(id).textContent).not.toContain('4 × 4');
    expect(blockEl(id).querySelectorAll('[aria-haspopup="menu"][aria-label^="Choose what"]').length).toBe(0);
    expect(blockEl(id).querySelectorAll('[data-cell]').length).toBe(8);
    expect(blockEl(id).querySelector('[data-edge]')).not.toBeNull();
    expect(blockEl(id).querySelectorAll('[aria-label^="Split Groove"]').length).toBe(3);
    act(() => setUiMode('advanced'));
    expect(blockEl(id).textContent).toContain('4 × 4');
    const picks = blockEl(id).querySelectorAll<HTMLElement>('[aria-haspopup="menu"][aria-label^="Choose what"]');
    expect(picks.length).toBe(8);
    click(picks[0]);
    expect(document.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('What Drums plays in Groove');
  });
});

describe('real input (the browser own pointer events and pointer capture)', () => {
  it('a real click on a part cell switches the part (not the block selection); a real drag moves a block', async () => {
    await page.viewport(1440, 900);
    await setup();
    const ids = blockIds();
    const drums = trackId('Drums');
    await userEvent.click(cellEl(ids[1], drums));
    expect(blocks()[1].parts).toEqual({ [drums]: null });
    await userEvent.click(cellEl(ids[1], drums));
    expect(blocks()[1].parts).toBeUndefined();
    // A real click on the header selects the block.
    await userEvent.click(blockEl(ids[2]), { position: { x: 30, y: 10 } });
    expect(selected()).toEqual([ids[2]]);
    // Drag block 4 onto the middle of block 2: it lands at position 2, and the click after the drag toggles nothing.
    // Real mouse: down on block 4's header, move onto block 2's middle, up (positions inside the lane).
    const laneBox = lane().getBoundingClientRect();
    const from = blockEl(ids[3]).getBoundingClientRect();
    const to = blockEl(ids[1]).getBoundingClientRect();
    const laneLoc = page.getByTestId('song-lane');
    await laneLoc.dropTo(laneLoc, {
      sourcePosition: { x: from.left - laneBox.left + 24, y: from.top - laneBox.top + 12 },
      targetPosition: { x: to.left - laneBox.left + to.width / 2, y: to.top - laneBox.top + 14 },
    });
    await settle();
    expect(blockIds()).toEqual([ids[0], ids[3], ids[1], ids[2], ids[4], ids[5]]);
    expect(blocks().every((b) => !b.parts)).toBe(true);
    expect(clone()).toBeNull();
  });
});


/* ------------------------------------------------------------------ */
/* The fix round: scale, follow, lock, second pointer, feedback        */
/* ------------------------------------------------------------------ */

const scroller = () => document.querySelector<HTMLElement>('[data-testid="lane-scroller"]')!;
/** Web Animations started by the lane (not CSS transitions such as a box-shadow fading). */
const scriptAnimations = (el: Element) => el.getAnimations().filter((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation));
const widthOf = (id: Id) => parseFloat(blockEl(id).style.width);
const notice = () => runtimeStore.getState().notice;
const laneButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Song lane view"] button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').startsWith(name))!;

describe('the scale stays put while editing', () => {
  it('a drop that makes the song longer keeps every block its size; the dropped block stays under the pointer and the lane scrolls instead', async () => {
    await setup();
    const ids = blockIds();
    const w0 = ids.map(widthOf);
    const fitsBefore = scroller().scrollWidth <= scroller().clientWidth + 1;
    // Drag the last block's right edge out to 12 passes: the song gets far longer than the lane.
    const last = ids[5];
    const edge = blockEl(last).querySelector<HTMLElement>('[data-edge]')!;
    const r = edge.getBoundingClientRect();
    const pass = widthOf(last) / blocks()[5].repeats;
    const start = { clientX: r.left + r.width / 2, clientY: r.top + 20 };
    const end = { clientX: start.clientX + 10 * pass + 4, clientY: start.clientY };
    pointer(edge, 'pointerdown', start);
    pointer(document.body, 'pointermove', { clientX: start.clientX + 6, clientY: start.clientY });
    pointer(document.body, 'pointermove', end);
    const leftDuring = blockEl(last).getBoundingClientRect().left;
    pointer(document.body, 'pointerup', end);
    await settle();
    expect(blocks()[5].repeats).toBe(12);
    // No re-fit: the other blocks kept their widths, the edited block its left edge, and its right edge is where the pointer let go.
    expect(ids.slice(0, 5).map(widthOf)).toEqual(w0.slice(0, 5));
    expect(blockEl(last).getBoundingClientRect().left).toBeCloseTo(leftDuring, 0);
    expect(Math.abs(blockEl(last).getBoundingClientRect().right - (end.clientX - r.width / 2))).toBeLessThan(pass / 2 + 2);
    expect(fitsBefore).toBe(true);
    expect(scroller().scrollWidth).toBeGreaterThan(scroller().clientWidth);
    // A Ctrl+drag copy that lengthens the song: same.
    const xs = blockIds().map(placedX);
    const at = startDrag(ids[1], xs[3] - xs[1] + 10, { ctrlKey: true });
    pointer(document.body, 'pointerup', { ...at, ctrlKey: true });
    await settle();
    expect(blocks().length).toBe(7);
    expect(ids.slice(0, 5).map(widthOf)).toEqual(w0.slice(0, 5));
    const copy = blocks()[3].id;
    const cr = blockEl(copy).getBoundingClientRect();
    expect(at.clientX).toBeGreaterThanOrEqual(cr.left);
    expect(at.clientX).toBeLessThanOrEqual(cr.right);
  });

  it('Fit song, the zoom buttons and Ctrl+wheel change the scale (gliding, the bar under the pointer stays put); a plain wheel never does', async () => {
    await setup();
    const ids = blockIds();
    const fit = laneButton('Fit song');
    expect(fit.disabled).toBe(true);
    const w1 = widthOf(ids[1]);
    // Zoom in: wider blocks; Fit song comes back.
    click(laneButton('Zoom in'));
    await actFrame();
    expect(widthOf(ids[1])).toBeGreaterThan(w1);
    expect(fit.disabled).toBe(false);
    // The glide: a Web Animation of the block's width and place, about 200 ms.
    const anim = scriptAnimations(blockEl(ids[1]))[0];
    expect(anim).toBeDefined();
    expect(Number(anim.effect!.getComputedTiming().duration)).toBeGreaterThanOrEqual(180);
    expect(Number(anim.effect!.getComputedTiming().duration)).toBeLessThanOrEqual(220);
    await settle(260);
    click(fit);
    await settle(260);
    expect(widthOf(ids[1])).toBe(w1);
    expect(fit.disabled).toBe(true);
    // Ctrl+wheel over a block zooms around the pointer: that spot stays where it is on screen.
    const b = blockEl(ids[2]).getBoundingClientRect();
    const px = b.left + b.width * 0.5;
    const fracBefore = (px - b.left) / b.width;
    const wheel = (init: WheelEventInit) => fire(scroller(), new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: px, clientY: b.top + 30, ...init }));
    const ev = wheel({ deltaY: -120, ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    await settle(260);
    const b2 = blockEl(ids[2]).getBoundingClientRect();
    expect(b2.width).toBeGreaterThan(b.width);
    expect(Math.abs(b2.left + b2.width * fracBefore - px)).toBeLessThan(2);
    // A plain wheel only scrolls: the page first while it can (this test page is taller than its window),
    // then the lane sideways, as the zoomed lane is wider than its view. The scale stays.
    const w = widthOf(ids[2]);
    expect(scroller().scrollWidth).toBeGreaterThan(scroller().clientWidth);
    const page = document.scrollingElement!;
    const pageCanScroll = page.scrollHeight > page.clientHeight + 1;
    if (pageCanScroll) {
      page.scrollTop = 0;
      expect(wheel({ deltaY: 300 }).defaultPrevented).toBe(false);
      page.scrollTop = page.scrollHeight;
    }
    act(() => {
      scroller().scrollLeft = 0;
      scroller().dispatchEvent(new Event('scroll'));
    });
    const left0 = scroller().scrollLeft;
    const plain = wheel({ deltaY: 300 });
    expect(plain.defaultPrevented).toBe(true);
    await settle(260);
    expect(widthOf(ids[2])).toBe(w);
    expect(scroller().scrollLeft).toBeGreaterThan(left0);
  });

  it('a window resize fits the song again; an edit never does', async () => {
    const m = await setup();
    const ids = blockIds();
    const w = widthOf(ids[1]);
    // An edit: one pass fewer on Groove keeps the scale.
    act(() => blockEl(ids[1]).focus());
    key(blockEl(ids[1]), 'keydown', { key: '-' });
    await settle();
    expect(widthOf(ids[1])).toBeCloseTo((w * 3) / 4, 0);
    // The lane gets wider (a window resize): the scale is chosen again for it (Fit song has nothing left to do).
    const host = m.container.firstElementChild as HTMLElement;
    host.style.width = '1800px';
    await settle(400);
    expect(widthOf(ids[1])).toBeGreaterThan((w * 3) / 4);
    expect(laneButton('Fit song').disabled).toBe(true);
    expect(scroller().scrollWidth).toBeLessThanOrEqual(scroller().clientWidth + 1);
    // And back: the blocks glide to the scale that fits the narrower lane (the shorter song now fits a step larger than before).
    const wide = widthOf(ids[1]);
    host.style.width = '1320px';
    await settle(400);
    expect(widthOf(ids[1])).toBeLessThan(wide);
    expect(widthOf(ids[1])).toBeGreaterThanOrEqual((w * 3) / 4);
    expect(laneButton('Fit song').disabled).toBe(true);
  });
});

describe('the lane never scrolls into empty room', () => {
  it('room kept for a view never grows the lane: after something scrolls it past the song (a block in flight), the next placement brings it back', async () => {
    await setup();
    const ids = blockIds();
    const sc = scroller();
    const content = sc.firstElementChild as HTMLElement;
    expect(sc.scrollWidth).toBeLessThanOrEqual(sc.clientWidth + 1);
    // A block drawn far right for a moment (as a block springing in from where it was let go) makes room to scroll into…
    const last = blockEl(ids[5]);
    const resting = last.style.transform;
    last.style.transform = 'translate3d(2400px, 0, 0)';
    act(() => {
      sc.scrollLeft = 600;
      sc.dispatchEvent(new Event('scroll'));
    });
    expect(sc.scrollLeft).toBeGreaterThan(0);
    last.style.transform = resting;
    // …and the next placement (any render: here a selection) must not keep that room.
    click(blockEl(ids[1]));
    await settle();
    expect(parseFloat(/max\(100%, (\d+)px\)/.exec(content.style.width)![1])).toBeLessThanOrEqual(sc.clientWidth);
    expect(sc.scrollLeft).toBe(0);
    // A drop released far right of the lane lands at the end without scrolling the lane; Undo puts it back.
    act(() => blockEl(ids[0]).focus());
    const r = blockEl(ids[0]).getBoundingClientRect();
    pointer(blockEl(ids[0]), 'pointerdown', { clientX: r.left + 20, clientY: r.top + 12 });
    for (let i = 1; i <= 10; i++) pointer(document.body, 'pointermove', { clientX: r.left + 20 + i * 140, clientY: r.top + 12 });
    pointer(document.body, 'pointerup', { clientX: sc.getBoundingClientRect().right + 300, clientY: r.top + 12 });
    expect(blockIds()[5]).toBe(ids[0]);
    await settle();
    expect(sc.scrollLeft).toBe(0);
    act(() => session.undo());
    await settle();
    expect(blockIds()).toEqual(ids);
    expect(sc.scrollLeft).toBe(0);
    expect(sc.scrollWidth).toBeLessThanOrEqual(sc.clientWidth + 1);
  });
});

describe('following the playhead', () => {
  it('Follow playhead is on by default and remembered; the lane glides to the playhead, and waits after a scroll', async () => {
    localStorage.removeItem('switchboard01.songLane');
    // A song longer than the lane.
    act(() => {
      for (let i = 0; i < 8; i++) cmdAddBlock(project().scenes[i % 4].id);
    });
    await setup(700);
    const follow = laneButton('Follow playhead');
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    const sc = scroller();
    expect(sc.scrollWidth).toBeGreaterThan(sc.clientWidth * 2);
    // Play from a block far to the right (real transport): the lane glides there over several frames.
    const ids = blockIds();
    await act(async () => {
      click(byLabel('Play song from block 9', blockEl(ids[8])));
      await wait(50);
    });
    const start = performance.now();
    while (!(runtimeStore.getState().playing && runtimeStore.getState().mode === 'song') && performance.now() - start < 8000) await settle(30);
    const seen: number[] = [];
    for (let i = 0; i < 40 && sc.scrollLeft < placedX(ids[8]) - sc.clientWidth; i++) {
      await actFrame();
      seen.push(sc.scrollLeft);
    }
    await settle(500);
    const x8 = placedX(ids[8]);
    expect(sc.scrollLeft).toBeGreaterThan(x8 - sc.clientWidth);
    expect(sc.scrollLeft).toBeLessThanOrEqual(x8 + 10);
    // Smooth: it passed through positions in between, not one jump.
    expect(new Set(seen.map((v) => Math.round(v / 40))).size).toBeGreaterThan(2);
    // The user scrolls away: the lane stays there (the song keeps playing).
    act(() => {
      sc.scrollLeft = 0;
      sc.dispatchEvent(new Event('scroll'));
    });
    await settle(1200);
    expect(sc.scrollLeft).toBe(0);
    // Turned off: remembered.
    click(follow);
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem('switchboard01.songLane')!)).toEqual({ follow: false });
    click(follow);
    expect(JSON.parse(localStorage.getItem('switchboard01.songLane')!)).toEqual({ follow: true });
    act(() => session.stop());
  });
});

describe('locked while a take records', () => {
  it('the lane says so in one line, shows no handles, and refuses edits quietly (no long toast)', async () => {
    await setup();
    const ids = blockIds();
    const drums = trackId('Drums');
    act(() => session.store.setLock('Recording a performance: the long message.', () => false));
    act(() => patchRuntime({ recording: 'performance', notice: null }));
    await actFrame();
    try {
      expect(lane().hasAttribute('data-locked')).toBe(true);
      const line = document.querySelector<HTMLElement>('[data-testid="lane-lock"]')!;
      expect(line.textContent).toContain('The song is locked while a take records.');
      expect(getComputedStyle(blockEl(ids[0])).cursor).toBe('default');
      expect(getComputedStyle(blockEl(ids[0]).querySelector('[data-edge]')!).display).toBe('none');
      // + on a block, a cell click, a drag, Delete: nothing changes, no toast, the line nudges and the status says why.
      act(() => blockEl(ids[0]).focus());
      key(blockEl(ids[0]), 'keydown', { key: '+' });
      click(cellEl(ids[1], drums));
      key(blockEl(ids[0]), 'keydown', { key: 'Delete' });
      startDrag(ids[0], 300);
      expect(clone()).toBeNull();
      pointer(document.body, 'pointerup', { clientX: 900, clientY: 300 });
      expect(blocks().map((b) => [b.id, b.repeats, b.parts])).toEqual(getStarter('house')!.build().arrangement.blocks.map((b, i) => [ids[i], b.repeats, b.parts]));
      expect(notice()).toBeNull();
      expect(document.querySelector('[data-testid="lane-lock"] [data-pulse]')).not.toBeNull();
      expect(status()).toBe('The song is locked while a take records.');
    } finally {
      act(() => session.store.setLock(null));
      act(() => patchRuntime({ recording: 'off' }));
    }
    await actFrame();
    expect(lane().hasAttribute('data-locked')).toBe(false);
    key(blockEl(ids[0]), 'keydown', { key: '+' });
    expect(blocks()[0].repeats).toBe(3);
  });
});

describe('one pointer at a time', () => {
  it('a second pointer pressing or clicking a part cell while a block is carried changes nothing and does not end the drag', async () => {
    await setup();
    const ids = blockIds();
    const drums = trackId('Drums');
    const xs = ids.map(placedX);
    const at = startDrag(ids[0], xs[3] - xs[0] + 10);
    const cell = cellEl(ids[5], drums);
    const down = pointer(cell, 'pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 1000, clientY: 400 });
    expect(down.defaultPrevented).toBe(true);
    const c = new PointerEvent('click', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch' });
    fire(cell, c);
    expect(blocks().every((b) => !b.parts)).toBe(true);
    expect(lane().dataset.carry).toBe('move');
    expect(clone()).not.toBeNull();
    pointer(document.body, 'pointerup', at);
    expect(blockIds().indexOf(ids[0])).toBe(3);
    expect(blocks().every((b) => !b.parts)).toBe(true);
    // With nothing carried, the same click switches the part.
    await settle();
    click(cellEl(ids[5], drums));
    expect(blocks()[5].parts).toEqual({ [drums]: null });
  });
});

describe('feedback', () => {
  it('a cell click says what it did with Undo; quick clicks on the same cell are one undo step; hovering says what a click does', async () => {
    await setup();
    const ids = blockIds();
    const drums = trackId('Drums');
    const before = undoCount();
    click(cellEl(ids[1], drums));
    expect(notice()?.text).toBe('Drums off in Groove');
    expect(notice()?.action).toBe('undo');
    expect(notice()?.text).not.toMatch(/next bar/);
    click(cellEl(ids[1], drums));
    expect(notice()?.text).toBe('Drums back on in Groove');
    click(cellEl(ids[1], drums));
    expect(blocks()[1].parts).toEqual({ [drums]: null });
    expect(undoCount()).toBe(before + 1);
    act(() => session.undo());
    expect(blocks()[1].parts).toBeUndefined();
    // After a pause, a click is its own step.
    await settle(600);
    click(cellEl(ids[1], drums));
    await settle(600);
    click(cellEl(ids[1], drums));
    expect(undoCount()).toBe(before + 2);
    // The hover bubble and the description say what a click does.
    expect(document.getElementById(cellEl(ids[1], drums).getAttribute('aria-describedby')!)!.textContent).toContain('switches this part off');
    pointer(cellEl(ids[2], drums), 'pointerover', { pointerType: 'mouse', buttons: 0 });
    await settle(450);
    expect(document.querySelector('[data-testid="cell-tip"]')!.textContent).toBe('Click: switch Drums off in this block');
    pointer(cellEl(ids[2], drums), 'pointerdown', { pointerType: 'mouse' });
    expect(document.querySelector('[data-testid="cell-tip"]')).toBeNull();
  });

  it('moves, lengths and renames name the block in a short Undo toast (one per gesture); the edge selects its block', async () => {
    await setup();
    const ids = blockIds();
    act(() => blockEl(ids[0]).focus());
    key(blockEl(ids[0]), 'keydown', { key: 'ArrowRight', altKey: true });
    expect(notice()).toMatchObject({ text: 'Moved Intro to position 2', action: 'undo' });
    key(blockEl(ids[0]), 'keydown', { key: '+' });
    expect(notice()).toMatchObject({ text: 'Intro: plays 3 times, 12 bars', action: 'undo' });
    key(blockEl(ids[0]), 'keydown', { key: 'F2' });
    const input = blockEl(ids[0]).querySelector<HTMLInputElement>('input')!;
    typeInto(input, 'Opening');
    key(input, 'keydown', { key: 'Enter' });
    expect(notice()).toMatchObject({ text: 'Block 2 is now called Opening', action: 'undo' });
    // An edge drag: one toast for the whole drag, and the block is selected.
    click(blockEl(ids[3]));
    const edge = blockEl(ids[2]).querySelector<HTMLElement>('[data-edge]')!;
    const r = edge.getBoundingClientRect();
    pointer(edge, 'pointerdown', { clientX: r.left + 6, clientY: r.top + 20 });
    for (let i = 1; i <= 6; i++) pointer(document.body, 'pointermove', { clientX: r.left + 6 + i * 30, clientY: r.top + 20 });
    expect(selected()).toEqual([ids[2]]);
    act(() => patchRuntime({ notice: null }));
    pointer(document.body, 'pointerup', { clientX: r.left + 6 + 180, clientY: r.top + 20 });
    expect(notice()?.text).toMatch(/^Lift: plays \d+ times, \d+ bars$/);
  });

  it('a dropped block settles in about 200 ms from where it was let go, starting at once', async () => {
    await setup();
    const ids = blockIds();
    const xs = ids.map(placedX);
    const at = startDrag(ids[0], xs[3] - xs[0] + 10);
    const dropLeft = clone()!.getBoundingClientRect().left;
    pointer(document.body, 'pointerup', at);
    const el = blockEl(ids[0]);
    const anim = scriptAnimations(el)[0];
    expect(anim).toBeDefined();
    const timing = anim.effect!.getComputedTiming();
    expect(Number(timing.duration)).toBeGreaterThanOrEqual(180);
    expect(Number(timing.duration)).toBeLessThanOrEqual(220);
    expect(Number(timing.delay ?? 0)).toBe(0);
    // It starts where the block was let go.
    const first = (anim.effect as KeyframeEffect).getKeyframes()[0].transform as string;
    const content = lane().querySelector<HTMLElement>('[class*="content"]')!.getBoundingClientRect().left;
    expect(Math.abs(Number(/translate3d\((-?[\d.]+)px/.exec(first)![1]) + content - dropLeft)).toBeLessThan(3);
    await settle(260);
    // (Allow a busy machine a little longer to finish the 200 ms settle.)
    for (let i = 0; i < 20 && (scriptAnimations(el).length || el.hasAttribute('data-settling')); i++) await settle(50);
    expect(scriptAnimations(el).length).toBe(0);
    expect(el.hasAttribute('data-settling')).toBe(false);
  });

  it('labels under a dragged block and next to a scene card stay inside the lane and the window', async () => {
    await setup(900);
    const ids = blockIds();
    const sc = scroller().getBoundingClientRect();
    // Carry the first block (a copy, so the label is long) to the lane's right edge.
    const r = blockEl(ids[0]).getBoundingClientRect();
    pointer(blockEl(ids[0]), 'pointerdown', { clientX: r.left + 20, clientY: r.top + 12 });
    pointer(document.body, 'pointermove', { clientX: r.left + 30, clientY: r.top + 12, ctrlKey: true });
    pointer(document.body, 'pointermove', { clientX: sc.right - 70, clientY: r.top + 12, ctrlKey: true });
    const badge = document.querySelector<HTMLElement>('[data-testid="lane-badge"]')!;
    expect(badge.textContent).toMatch(/\+ Copy to position \d+/);
    const b = badge.getBoundingClientRect();
    expect(b.right).toBeLessThanOrEqual(sc.right);
    expect(b.left).toBeGreaterThanOrEqual(sc.left);
    key(window, 'keydown', { key: 'Escape' });
    pointer(document.body, 'pointerup', { clientX: sc.right - 70, clientY: r.top + 12 });
    // A scene card near the window's right edge: its label floats on the pointer's left.
    await settle();
    const card = byLabel<HTMLElement>('Scene Lift').getBoundingClientRect();
    const lastBlock = blockEl(blockIds()[5]).getBoundingClientRect();
    pointer(byLabel<HTMLElement>('Scene Lift'), 'pointerdown', { clientX: card.left + 20, clientY: card.top + 10 });
    pointer(document.body, 'pointermove', { clientX: card.left + 30, clientY: card.top + 5 });
    pointer(document.body, 'pointermove', { clientX: window.innerWidth - 20, clientY: lastBlock.top + 60 });
    await actFrame();
    const ghost = document.querySelector<HTMLElement>('[data-testid="lane-ghost"]')!.getBoundingClientRect();
    expect(ghost.right).toBeLessThanOrEqual(window.innerWidth);
    expect(ghost.left).toBeGreaterThanOrEqual(0);
    key(window, 'keydown', { key: 'Escape' });
    pointer(document.body, 'pointerup', { clientX: 10, clientY: 10 });
  });

  it('dropping a scene card on a block of the same scene says so and changes nothing', async () => {
    await setup();
    const ids = blockIds();
    const groove = ids[1];
    const card = byLabel<HTMLElement>('Scene Groove');
    const r = blockEl(groove).getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    pointer(card, 'pointerdown', { clientX: cr.left + 20, clientY: cr.top + 10 });
    pointer(document.body, 'pointermove', { clientX: cr.left + 30, clientY: cr.top + 5 });
    pointer(document.body, 'pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 60 });
    expect(document.querySelector('[data-testid="lane-ghost"]')!.textContent).toContain('Groove already plays Groove');
    expect(blockEl(groove).textContent).not.toContain('Layer Groove into Groove');
    expect(blockEl(groove).dataset.layerTarget).toBe('none');
    const before = undoCount();
    pointer(document.body, 'pointerup', { clientX: r.left + r.width / 2, clientY: r.top + 60, shiftKey: true });
    expect(undoCount()).toBe(before);
    expect(blocks()[1].parts).toBeUndefined();
    expect(blockIds()).toEqual(ids);
  });

  it('when the block playing now is removed, the next one says it takes over; nothing says Playing', async () => {
    await setup();
    const ids = blockIds();
    act(() => patchRuntime({ playing: true, mode: 'song', songBlock: 2, songBlockId: ids[2] }));
    await actFrame();
    expect(blockEl(ids[2]).dataset.current).toBeDefined();
    act(() => blockEl(ids[2]).focus());
    key(blockEl(ids[2]), 'keydown', { key: 'Delete' });
    await actFrame();
    expect(document.querySelector('[data-current]')).toBeNull();
    expect(lane().textContent).not.toContain('Playing');
    expect(blockEl(ids[3]).dataset.next).toBeDefined();
    expect(blockEl(ids[3]).textContent).toContain('Next');
    expect(blockEl(ids[3]).getAttribute('aria-label')).toContain('plays next');
    expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toContain(`next: ${project().scenes.find((s) => s.id === blocks()[2].sceneId)!.name} (block 3)`);
    // The hand-over: the runtime moves on to that block.
    act(() => patchRuntime({ songBlock: 2, songBlockId: ids[3] }));
    await actFrame();
    expect(blockEl(ids[3]).dataset.current).toBeDefined();
    expect(blockEl(ids[3]).dataset.next).toBeUndefined();
  });

  it("a block's edge scrolls the lane only once the pointer passes the lane's visible edge, and the scrolled distance counts", async () => {
    act(() => {
      for (let i = 0; i < 16; i++) cmdAddBlock(project().scenes[i % 4].id);
    });
    await setup(700);
    const ids = blockIds();
    const sc = scroller();
    const right = sc.getBoundingClientRect().right;
    const id = ids[1];
    const edge = blockEl(id).querySelector<HTMLElement>('[data-edge]')!;
    const r = edge.getBoundingClientRect();
    const r0 = blocks()[1].repeats;
    pointer(edge, 'pointerdown', { clientX: r.left + 6, clientY: r.top + 20 });
    pointer(document.body, 'pointermove', { clientX: r.left + 12, clientY: r.top + 20 });
    // Near the edge but inside the lane: it stays still (an edge never runs away under a resting pointer).
    pointer(document.body, 'pointermove', { clientX: right - 4, clientY: r.top + 20 });
    await settle(500);
    expect(sc.scrollLeft).toBe(0);
    // Past the visible edge: it scrolls, and the scrolled distance counts.
    pointer(document.body, 'pointermove', { clientX: right + 30, clientY: r.top + 20 });
    const travel = right + 30 - (r.left + 6);
    const pass = widthOf(id) / r0;
    await settle(700);
    expect(sc.scrollLeft).toBeGreaterThan(100);
    pointer(document.body, 'pointerup', { clientX: right + 30, clientY: r.top + 20 });
    expect(blocks()[1].repeats).toBeGreaterThan(Math.min(16, r0 + Math.round(travel / pass)));
  });
});

function cmdAddBlock(sceneId: Id) {
  const r = cmd.addBlock(session.store, sceneId, undefined, 4);
  expect(r.changed).toBe(true);
}
