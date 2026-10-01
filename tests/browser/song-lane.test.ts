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
      expect(lane().hasAttribute('data-dragging'), what).toBe(false);
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
    expect(bubble.textContent).toBe('×5 · 20 bars');
    expect(bubble.hasAttribute('data-on')).toBe(true);
    expect(lane().dataset.dragging).toBe('resize');
    // The block widened and the next one rippled by the same amount; nothing committed yet.
    expect(parseFloat(blockEl(id).style.width)).toBeCloseTo(5 * pass, -1);
    expect(placedX(ids[1])).toBeCloseTo(x1 + 3 * pass, -1);
    expect(blocks()[0].repeats).toBe(2);
    pointer(document.body, 'pointerup', { clientX: start.clientX + 3 * pass + 4, clientY: start.clientY });
    expect(blocks()[0].repeats).toBe(5);
    expect(undoCount()).toBe(before + 1);
    expect(bubble.hasAttribute('data-on')).toBe(false);
    expect(status()).toContain('5 passes, 20 bars');
    // The ruler numbers block 2's first bar after the longer Intro.
    await actFrame();
    const ruler = document.querySelector('[data-testid="song-ruler"]')!;
    expect([...ruler.querySelectorAll('span')].map((s) => s.textContent)).toContain('21');
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
    click(byLabel('Split Groove after pass 1 of 4', blockEl(id)));
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
    click(byLabel('Split Groove after pass 2 of 4', blockEl(id)));
    const chip = document.querySelector<HTMLElement>(`[data-join="${id}"]`)!;
    expect(chip).not.toBeNull();
    click(chip);
    expect(blocks()[1]).toMatchObject({ id, repeats: 4 });
    expect(blocks().length).toBe(6);
    // A block that cannot be joined says why in its menu.
    act(() => blockEl(id).focus());
    key(blockEl(id), 'keydown', { key: 'Enter' });
    expect(menuItem('Join with next').getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('[role="menu"]')!.textContent).toContain('Only neighbours that play the same scene');
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
    expect(cellEl(groove, lead).textContent).toContain('from Lift');
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

  it('a scene card dropped onto a block layers it in (with a preview); between blocks it inserts a new block', async () => {
    await setup();
    const ids = blockIds();
    const groove = ids[1];
    const card = byLabel<HTMLElement>('Scene Lift');
    const r = blockEl(groove).getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    pointer(card, 'pointerdown', { clientX: cr.left + 20, clientY: cr.top + 10 });
    pointer(document.body, 'pointermove', { clientX: cr.left + 30, clientY: cr.top + 5 });
    pointer(document.body, 'pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 60 });
    // Layer preview: the block is outlined, says what will happen, and the parts that change say where from.
    expect(blockEl(groove).dataset.layerTarget).toBe('on');
    expect(blockEl(groove).textContent).toContain('Layer Lift into Groove');
    const previews = [...blockEl(groove).querySelectorAll<HTMLElement>('[data-cell][data-preview]')];
    expect(previews.length).toBe(7);
    expect(previews.every((c) => c.textContent!.includes('from Lift'))).toBe(true);
    expect(document.querySelector('[data-testid="lane-ghost"]')!.textContent).toContain('Layer Lift into Groove');
    expect(document.querySelector('[data-testid="lane-slot"]')!.hasAttribute('data-on')).toBe(false);
    const before = undoCount();
    pointer(document.body, 'pointerup', { clientX: r.left + r.width / 2, clientY: r.top + 60 });
    const parts = blocks()[1].parts!;
    expect(Object.values(parts).every((v) => v === sceneId('Lift'))).toBe(true);
    expect(Object.keys(parts).length).toBe(7);
    expect(undoCount()).toBe(before + 1);
    expect(runtimeStore.getState().notice?.text).toContain('Layered Lift into Groove');

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
    expect(status()).toBe('Intro: 3 passes, 12 bars.');
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
    click(menuItem('Layer a scene in'));
    click(menuItem('Break'));
    expect(Object.values(blocks()[0].parts ?? {}).every((v) => v === sceneId('Break'))).toBe(true);
    // Alt+Right moves; Copy / Paste after from the menu.
    act(() => blockEl(ids[0]).focus());
    key(blockEl(ids[0]), 'keydown', { key: 'ArrowRight', altKey: true });
    expect(blockIds()[1]).toBe(ids[0]);
    key(document.activeElement!, 'keydown', { key: 'Enter' });
    click(menuItem('Copy block'));
    key(document.activeElement!, 'keydown', { key: 'Enter' });
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

