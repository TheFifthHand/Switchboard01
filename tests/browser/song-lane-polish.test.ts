/**
 * The song lane's third-round polish in real Chromium, with real mouse and
 * keyboard input where it matters (Chrome DevTools Protocol: hit testing,
 * pointer capture and focus are the browser's own), checked on the project
 * in session.store and the runtime:
 * - a part cell clicked back to where it was leaves no undo step, and its
 *   toast offers no Undo;
 * - quick + / − presses on a block are one undo step (back to the start:
 *   none);
 * - Cut then Paste puts the block back where it was; Undo says "Cut block";
 * - Undo / Redo of a duplicate, a delete and a paste keep keyboard focus and
 *   the selection in the lane;
 * - following the playhead never turns the page while the pointer moves over
 *   the lane (it waits until it has rested), while a menu is open, or right
 *   after the user acts with the keys;
 * - Fit song shows a long song whole (compact blocks) and never makes a song
 *   that is cut off bigger; one too long to fit goes as small as it can and
 *   says so;
 * - the last block has free room after it, and its edge never runs away: it
 *   scrolls the lane only past the lane's visible edge.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { FOLLOW_KEY_REST_MS, FOLLOW_POINTER_REST_MS } from '../../src/app/views/arrange/SongLane';
import { clearBlockClipboard } from '../../src/app/views/arrange/songActions';
import { COMPACT_BLOCK_WIDTH, MIN_PX_PER_BAR, minBlockWidth, tailRoom } from '../../src/app/views/arrange/songLayout';
import { getStarter } from '../../src/content/starters';
import type { Id } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setUiMode, setView } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, mount, nextFrame, wait } from './ui-harness';

beforeEach(async () => {
  await page.viewport(1440, 900);
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  clearBlockClipboard();
  localStorage.removeItem('switchboard01.songLane');
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

async function setup(width = 1320) {
  mount(h('div', { style: { width: `${width}px`, height: '680px', display: 'flex', flexDirection: 'column' } }, h(ArrangeView)), { width: width + 40 });
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
const cellEl = (id: Id, track: Id) => blockEl(id).querySelector<HTMLElement>(`[data-cell][data-track="${track}"]`)!;
const lane = () => document.querySelector<HTMLElement>('[data-testid="song-lane"]')!;
const scroller = () => lane().children[1] as HTMLElement;
/** On a block's name, near its start (a compact block's ▶ and ⋯ appear over the right of its header on hover). */
const nameAt = (id: Id) => {
  const r = blockEl(id).querySelector<HTMLElement>('[class*="name"]')!.getBoundingClientRect();
  return { x: r.left + 8, y: r.top + r.height / 2 };
};
const notice = () => runtimeStore.getState().notice;
const undoCount = () => session.store.historySize().undo;
const selected = () => [...document.querySelectorAll<HTMLElement>('[data-block-id][data-selected]')].map((e) => e.dataset.blockId);
const laneButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Song lane view"] button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').startsWith(name))!;
const widthOf = (id: Id) => parseFloat(blockEl(id).style.width);

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

async function clickAt(p: Pt, modifiers = 0) {
  await mouse('mouseMoved', p);
  await mouse('mousePressed', p, { modifiers });
  await mouse('mouseReleased', p, { modifiers });
  await settle(40);
}

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  '+': { code: 'Equal', vk: 187, text: '+' },
  '-': { code: 'Minus', vk: 189, text: '-' },
  d: { code: 'KeyD', vk: 68 },
  c: { code: 'KeyC', vk: 67 },
  x: { code: 'KeyX', vk: 88 },
  v: { code: 'KeyV', vk: 86 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Enter: { code: 'Enter', vk: 13 },
  Escape: { code: 'Escape', vk: 27 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
};

/** A real key press on whatever has focus (modifiers: 2 = Ctrl, 8 = Shift). */
async function press(key: string, modifiers = 0) {
  const k = KEYS[key];
  await act(async () => {
    await cdp().send('Input.dispatchKeyEvent', { type: k.text && !modifiers ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers, ...(k.text && !modifiers ? { text: k.text } : {}) });
    await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
  });
  await settle(30);
}

/* ------------------------------------------------------------------ */

describe('one undo step per gesture, and no Undo for a gesture that came back', () => {
  it('a part cell clicked off and on again quickly leaves no undo step, and its toast offers no Undo', async () => {
    await setup();
    const groove = blockIds()[1];
    const drums = trackId('Drums');
    const before = undoCount();
    await clickAt(centre(cellEl(groove, drums)));
    expect(blocks()[1].parts).toEqual({ [drums]: null });
    expect(notice()).toMatchObject({ text: 'Drums off in Groove', action: 'undo' });
    await clickAt(centre(cellEl(groove, drums)));
    expect(blocks()[1].parts).toBeUndefined();
    // Back where it started: no step, and the toast says what happened without an Undo (it would undo an older edit).
    expect(undoCount()).toBe(before);
    expect(notice()?.text).toBe('Drums back on in Groove');
    expect(notice()?.action).toBeUndefined();
  });

  it('quick + presses on a block are one undo step; + then − leaves none (and no Undo); a later press is a new step', async () => {
    await setup();
    const intro = blockIds()[0];
    const r0 = blocks()[0].repeats;
    const before = undoCount();
    act(() => blockEl(intro).focus());
    await press('+');
    await press('+');
    await press('+');
    expect(blocks()[0].repeats).toBe(r0 + 3);
    expect(undoCount()).toBe(before + 1);
    expect(notice()).toMatchObject({ text: `Intro: plays ${r0 + 3} times, ${(r0 + 3) * 4} bars`, action: 'undo' });
    act(() => session.undo());
    expect(blocks()[0].repeats).toBe(r0);
    // + then − at once: back where it was, no step.
    await settle(1100);
    await press('+');
    await press('-');
    expect(blocks()[0].repeats).toBe(r0);
    expect(undoCount()).toBe(before);
    expect(notice()?.action).toBeUndefined();
    // After a pause a press is its own step.
    await settle(1100);
    await press('+');
    await settle(1100);
    await press('+');
    expect(undoCount()).toBe(before + 2);
  });
});

describe('cut and paste', () => {
  it('Cut then Paste puts the block back where it was; Undo names the Cut', async () => {
    await setup();
    const ids = blockIds();
    const lift = blocks()[2].sceneId;
    act(() => blockEl(ids[2]).focus());
    await press('x', 2);
    expect(blockIds()).toEqual(ids.filter((id) => id !== ids[2]));
    expect(session.store.undoLabel()).toBe('Cut block');
    // Focus went on to the next block; Paste right away: back in its place (a fresh copy).
    expect(document.activeElement).toBe(blockEl(ids[3]));
    await press('v', 2);
    expect(blocks().length).toBe(6);
    expect(blocks()[2].sceneId).toBe(lift);
    expect(blockIds().filter((_, i) => i !== 2)).toEqual(ids.filter((_, i) => i !== 2));
    // Once the user moves on, Paste goes after the block they are on.
    expect(document.activeElement).toBe(blockEl(blockIds()[2]));
    await press('x', 2);
    expect(document.activeElement).toBe(blockEl(ids[3]));
    await press('ArrowRight');
    expect(document.activeElement).toBe(blockEl(ids[4]));
    await press('v', 2);
    expect(blockIds().length).toBe(6);
    expect(blockIds().slice(0, 4)).toEqual([ids[0], ids[1], ids[3], ids[4]]);
    expect(blocks()[4].sceneId).toBe(lift);
  });
});

describe('Undo and Redo keep the lane in hand', () => {
  it('a duplicate, a delete and a paste: Undo / Redo keep keyboard focus in the lane and bring back the selection the step had', async () => {
    await setup();
    const ids = blockIds();
    // Duplicate block 2 (selected by a click, focused).
    await clickAt(nameAt(ids[1]));
    act(() => blockEl(ids[1]).focus());
    await press('d', 2);
    const copy = blockIds()[2];
    expect(document.activeElement).toBe(blockEl(copy));
    act(() => session.undo());
    await settle(60);
    expect(blockIds()).toEqual(ids);
    // The copy went: focus is back on the block it was copied from, which is selected again.
    expect(document.activeElement).toBe(blockEl(ids[1]));
    expect(selected()).toEqual([ids[1]]);
    act(() => session.redo());
    await settle(60);
    expect(blockIds()[2]).toBe(copy);
    expect(document.activeElement).toBe(blockEl(copy));
    expect(selected()).toEqual([copy]);
    act(() => session.undo());
    // (Let the blocks finish sliding back before clicking one.)
    await settle(400);

    // Delete block 4 (focused): focus moves on; Undo brings it back focused and selected.
    await clickAt(nameAt(ids[3]));
    act(() => blockEl(ids[3]).focus());
    await press('Delete');
    expect(blockIds()).not.toContain(ids[3]);
    expect(document.activeElement).toBe(blockEl(ids[4]));
    act(() => session.undo());
    await settle(60);
    expect(blockIds()).toEqual(ids);
    expect(document.activeElement).toBe(blockEl(ids[3]));
    expect(selected()).toEqual([ids[3]]);

    // Paste after block 1: Undo removes the pasted copy, focus goes back to block 1.
    act(() => blockEl(ids[0]).focus());
    await press('c', 2);
    await press('v', 2);
    expect(blockIds().length).toBe(7);
    expect(document.activeElement).toBe(blockEl(blockIds()[1]));
    act(() => session.undo());
    await settle(60);
    expect(blockIds()).toEqual(ids);
    expect(lane().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(blockEl(ids[0]));
  });

  it('an undo that removes the focused block hands focus to its nearest neighbour, even without a remembered step', async () => {
    await setup();
    const ids = blockIds();
    // An edit made elsewhere (a command, not the lane): a block added at the end.
    act(() => void cmd.addBlock(session.store, project().scenes[0].id));
    await settle(60);
    const added = blockIds()[6];
    act(() => blockEl(added).focus());
    act(() => session.undo());
    await settle(60);
    expect(blockIds()).toEqual(ids);
    expect(document.activeElement).toBe(blockEl(ids[5]));
  });
});

describe('following the playhead', () => {
  /** A song far longer than a 700 px lane, playing from a block whose start is near the lane's right edge. */
  async function playNearTheEdge() {
    act(() => {
      for (let i = 0; i < 12; i++) cmd.addBlock(session.store, project().scenes[i % 4].id, undefined, 4);
    });
    // The first block that starts in the right fifth of the view (a lane width where one does).
    for (const w of [750, 720, 780, 690, 810, 840, 660, 870]) {
      await setup(w);
      const sc = scroller();
      expect(sc.scrollWidth).toBeGreaterThan(sc.clientWidth * 2);
      const view = sc.getBoundingClientRect();
      const id = blockIds().find((b) => {
        const r = blockEl(b).getBoundingClientRect();
        return r.left > view.left + view.width * 0.86 && r.left < view.right - 10;
      });
      if (id) return { id, sc };
      cleanup();
    }
    throw new Error('No lane width puts a block start in the right fifth of the view.');
  }

  it('never turns the page while the pointer moves over the lane; once it has rested about 2 s, it follows', async () => {
    const { id, sc } = await playNearTheEdge();
    // A click on the bar numbers over that block's start, with the mouse (the pointer is now over the lane).
    const ruler = document.querySelector<HTMLElement>('[data-testid="song-ruler"]')!.getBoundingClientRect();
    await clickAt({ x: blockEl(id).getBoundingClientRect().left + 3, y: ruler.top + ruler.height - 6 });
    // Keep moving over the lane (while the song starts, however long that takes, and 1.5 s more): the lane stays put.
    const p = centre(blockEl(blockIds()[1]));
    let i = 0;
    const wiggle = async () => {
      await mouse('mouseMoved', { x: p.x + (i++ % 2 ? 6 : -6), y: p.y });
      await settle(100);
    };
    const start = performance.now();
    while (!(runtimeStore.getState().playing && runtimeStore.getState().mode === 'song') && performance.now() - start < 8000) await wiggle();
    expect(runtimeStore.getState().songBlockId).toBe(id);
    for (let k = 0; k < 15; k++) await wiggle();
    expect(sc.scrollLeft).toBe(0);
    // At rest: it follows once the pointer has been still long enough.
    await settle(FOLLOW_POINTER_REST_MS + 900);
    expect(sc.scrollLeft).toBeGreaterThan(50);
  });

  it('never turns the page while a block menu is open', async () => {
    const { id, sc } = await playNearTheEdge();
    // A menu opened (right-click, no pointer movement over the lane), then the song starts near the edge.
    fire(blockEl(blockIds()[0]), new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => {
      await session.playSong(blockIds().indexOf(id));
    });
    await settle(1200);
    expect(sc.scrollLeft).toBe(0);
    // The menu closes: the page turns.
    await press('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await settle(900);
    expect(sc.scrollLeft).toBeGreaterThan(50);
  });

  it('waits while the lane has keyboard focus and a key was pressed there in the last 2 s', async () => {
    const { id, sc } = await playNearTheEdge();
    act(() => blockEl(blockIds()[0]).focus());
    await press('ArrowRight');
    expect(document.activeElement).toBe(blockEl(blockIds()[1]));
    await act(async () => {
      await session.playSong(blockIds().indexOf(id));
    });
    await settle(900);
    expect(sc.scrollLeft).toBe(0);
    // About 2 s after the last key (focus still in the lane), it follows again.
    await settle(FOLLOW_KEY_REST_MS);
    expect(sc.scrollLeft).toBeGreaterThan(50);
  });

  it('Space on a focused block (the transport key) does not hold it', async () => {
    const { id, sc } = await playNearTheEdge();
    act(() => blockEl(blockIds()[0]).focus());
    await press(' ');
    await act(async () => {
      await session.playSong(blockIds().indexOf(id));
    });
    await settle(900);
    expect(sc.scrollLeft).toBeGreaterThan(50);
  });
});

describe('Fit song', () => {
  it('shows 24 blocks whole at 1366 x 768 (compact blocks), and never makes a cut-off song bigger', async () => {
    await page.viewport(1366, 768);
    // The starter's six blocks, four times.
    act(() => {
      const four = blocks().map((b) => cmd.blockTemplate(b));
      for (let i = 0; i < 3; i++) cmd.insertBlocks(session.store, four);
    });
    expect(blocks().length).toBe(24);
    // One part off in the first block (a compact block still says Off).
    act(() => void cmd.setBlockPart(session.store, blockIds()[0], trackId('Drums'), null));
    await setup(1366);
    const sc = scroller();
    // Opened: the whole song fits; the narrow blocks have a compact header (their name), the rest of it on hover or focus.
    expect(sc.scrollWidth).toBeLessThanOrEqual(sc.clientWidth + 1);
    const narrow = blockEls().filter((el) => el.getBoundingClientRect().width < 110);
    expect(narrow.length).toBeGreaterThan(20);
    for (const el of narrow) {
      expect(el.getBoundingClientRect().width).toBeGreaterThanOrEqual(COMPACT_BLOCK_WIDTH);
      expect(el.querySelector('[class*="name"]')!.getBoundingClientRect().width).toBeGreaterThan(10);
      // Name only: no length or half a word under it; its tooltip has the details.
      expect(el.querySelector<HTMLElement>('[data-testid="block-length"]')!.getBoundingClientRect().width).toBe(0);
      expect(el.querySelector<HTMLElement>('[class*="titles"]')!.title).toMatch(/ bars: .* bars, (once|\d+ times)/);
      // The cells show no clipped clip names (a filled bar plays), Off keeps its word.
      for (const c of el.querySelectorAll<HTMLElement>('[data-cell][data-kind="scene"]')) expect(c.innerText.trim()).toBe('');
    }
    expect(cellEl(blockIds()[0], trackId('Drums')).innerText.trim()).toBe('Off');
    // Hovering a cell says what it plays (its name is not shown).
    const bass = cellEl(blockIds()[1], trackId('Bass'));
    await mouse('mouseMoved', centre(bass));
    await mouse('mouseMoved', { x: centre(bass).x + 1, y: centre(bass).y });
    await settle(900);
    expect(document.querySelector('[data-testid="cell-tip"]')?.textContent).toMatch(/^Bass plays “.+”\. Click: switch it off in this block$/);
    await mouse('mouseMoved', { x: 2, y: 2 });
    expect(laneButton('Fit song').disabled).toBe(true);
    // Zoomed in (the song scrolls), Fit song makes it smaller again, to the whole song.
    const w = widthOf(blockIds()[1]);
    await clickAt(centre(laneButton('Zoom in')));
    await clickAt(centre(laneButton('Zoom in')));
    await settle(260);
    expect(sc.scrollWidth).toBeGreaterThan(sc.clientWidth);
    const zoomed = widthOf(blockIds()[1]);
    await clickAt(centre(laneButton('Fit song')));
    await settle(260);
    expect(widthOf(blockIds()[1])).toBeLessThan(zoomed);
    expect(widthOf(blockIds()[1])).toBe(w);
    expect(sc.scrollWidth).toBeLessThanOrEqual(sc.clientWidth + 1);
  });

  it('a song too long to show whole: Fit song shows as much as the smallest step can and says so', async () => {
    act(() => {
      for (let i = 0; i < 90; i++) cmd.addBlock(session.store, project().scenes[i % 4].id, undefined, 2);
    });
    await setup(1320);
    const sc = scroller();
    // It opens scrolling at a readable size.
    expect(sc.scrollWidth).toBeGreaterThan(sc.clientWidth);
    const before = widthOf(blockIds()[1]);
    const fit = laneButton('Fit song');
    expect(fit.disabled).toBe(false);
    await clickAt(centre(fit));
    await settle(260);
    expect(widthOf(blockIds()[1])).toBeLessThan(before);
    expect(widthOf(blockIds()[0])).toBe(Math.max(minBlockWidth(MIN_PX_PER_BAR), 8 * MIN_PX_PER_BAR));
    expect(notice()?.text).toContain('too long to show whole');
    expect(fit.disabled).toBe(true);
  });
});

describe('compact blocks', () => {
  it('a compact block drags from anywhere on its header (its ⋯ under the pointer too); a plain click on ⋯ still opens its menu', async () => {
    await page.viewport(1366, 768);
    act(() => {
      const four = blocks().map((b) => cmd.blockTemplate(b));
      for (let i = 0; i < 3; i++) cmd.insertBlocks(session.store, four);
    });
    await setup(1366);
    const ids = blockIds();
    const b1 = blockEl(ids[1]);
    expect(b1.getBoundingClientRect().width).toBeLessThan(110);
    // Hover the header: ⋯ shows over its right part; press there and drag three blocks to the right.
    const name = b1.querySelector<HTMLElement>('[class*="name"]')!.getBoundingClientRect();
    const from = { x: b1.getBoundingClientRect().left + 22, y: name.top + name.height / 2 };
    await mouse('mouseMoved', from);
    await settle(30);
    const under = document.elementFromPoint(from.x, from.y)!;
    expect(under.closest('[aria-haspopup="menu"]')).not.toBeNull();
    const steps = undoCount();
    await mouse('mousePressed', from);
    const to = blockEl(ids[4]).getBoundingClientRect();
    for (let i = 1; i <= 10; i++) {
      await mouse('mouseMoved', { x: from.x + ((to.left + to.width / 2 - from.x) * i) / 10, y: from.y + 2 }, { held: true });
      await nextFrame();
    }
    await mouse('mouseReleased', { x: to.left + to.width / 2, y: from.y + 2 });
    await settle(300);
    expect(blockIds().indexOf(ids[1])).toBeGreaterThanOrEqual(3);
    expect(undoCount()).toBe(steps + 1);
    // No menu opened by the drag's release.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // A plain click on a compact block's ⋯ opens its menu.
    const b5 = blockEl(blockIds()[5]);
    const r5 = b5.querySelector<HTMLElement>('[class*="name"]')!.getBoundingClientRect();
    await mouse('mouseMoved', { x: b5.getBoundingClientRect().left + 10, y: r5.top + 4 });
    await settle(30);
    await clickAt(centre(b5.querySelector<HTMLElement>('[aria-haspopup="menu"]')!));
    await settle(60);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await press('Escape');
  });
});

describe('the last block', () => {
  it('has free room after it (at least one block width), and its edge scrolls the lane only past the visible edge', async () => {
    act(() => {
      for (let i = 0; i < 12; i++) cmd.addBlock(session.store, project().scenes[i % 4].id, undefined, 4);
    });
    await setup(700);
    const sc = scroller();
    // Scrolled to the end: room after the last block.
    act(() => {
      sc.scrollLeft = sc.scrollWidth;
      sc.dispatchEvent(new Event('scroll'));
    });
    await settle(100);
    const last = blockIds().at(-1)!;
    const view = sc.getBoundingClientRect();
    const lr = blockEl(last).getBoundingClientRect();
    expect(view.right - lr.right).toBeGreaterThanOrEqual(tailRoom(14) - 2);
    // Drag its edge to just inside the lane's visible edge and hold: the lane does not run away.
    const r0 = blocks().at(-1)!.repeats;
    const steps = undoCount();
    const edge = blockEl(last).querySelector<HTMLElement>('[data-edge]')!.getBoundingClientRect();
    const from = { x: edge.left + 3, y: edge.top + 40 };
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from);
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', { x: from.x + ((view.right - 3 - from.x) * i) / 8, y: from.y }, { held: true });
      await nextFrame();
    }
    const scrollAt = sc.scrollLeft;
    await settle(800);
    expect(sc.scrollLeft).toBe(scrollAt);
    // The block's header shows the length the drop will give, live (its old length is hidden meanwhile).
    const len0 = parseInt(blockEl(last).querySelector<HTMLElement>('[data-testid="block-length"]')!.textContent!);
    const live = blockEl(last).querySelector<HTMLElement>('[data-live-len]')!;
    expect(getComputedStyle(live).display).not.toBe('none');
    expect(live.textContent).toMatch(/^\d+ bars$/);
    expect(parseInt(live.textContent!)).toBeGreaterThan(len0);
    expect(blockEl(last).querySelector<HTMLElement>('[data-testid="block-length"]')!.getBoundingClientRect().width).toBe(0);
    // Past the edge: now it scrolls (and the scrolled distance counts).
    await mouse('mouseMoved', { x: view.right + 30, y: from.y }, { held: true });
    await settle(600);
    expect(sc.scrollLeft).toBeGreaterThan(scrollAt + 40);
    await mouse('mouseReleased', { x: view.right + 30, y: from.y });
    await settle(100);
    expect(blocks().at(-1)!.repeats).toBeGreaterThan(r0);
    expect(undoCount()).toBe(steps + 1);
  });
});

function blockEls() {
  return [...document.querySelectorAll<HTMLElement>('[data-block-id]')];
}
