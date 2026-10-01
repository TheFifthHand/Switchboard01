/**
 * The song lane with real touch and pen input (Chrome DevTools Protocol
 * Input.dispatchTouchEvent / dispatchMouseEvent with pointerType "pen"), so
 * the browser's own gesture handling is in play: a quick swipe pans the lane
 * natively (touch-action lets it), the element under the finger holds the
 * pointer (implicit capture) until the lane takes it for a lifted block, and
 * that hand-over must not cancel the drag. Synthetic PointerEvents cannot
 * show this.
 *
 * Checked on the project in session.store: a quick finger swipe scrolls the
 * lane and edits nothing; a finger held still (HOLD_MS) lifts a block (the
 * lift is shown at once) and then drags it, by its name or a part cell; a hold
 * let go in place opens the block's actions (the part picker on a cell); the
 * right edge stays immediate (passes); scene cards are held, then dragged in
 * (insert between blocks, layer into a block); a pen drags at once. A tap on a
 * part cell still switches it, and a second finger tapping a cell while a
 * block is carried changes nothing.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { HOLD_MS } from '../../src/app/views/arrange/laneGestures';
import { clearBlockClipboard } from '../../src/app/views/arrange/songActions';
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
    patchRuntime({ held: {}, notice: null, recording: 'off', playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, replayId: null });
    setView('arrange');
    setUiMode('simple');
  });
  await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
});

afterEach(async () => {
  await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
  cleanup();
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
const sceneId = (name: string) => project().scenes.find((s) => s.name === name)!.id;
const blockEl = (id: Id) => document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const cellEl = (id: Id, track: Id) => blockEl(id).querySelector<HTMLButtonElement>(`[data-cell][data-track="${track}"]`)!;
const lane = () => document.querySelector<HTMLElement>('[data-testid="song-lane"]')!;
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

async function touch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: (Pt & { id: number })[]) {
  await cdp().send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ ...toPage(p.x, p.y), id: p.id })) });
}

/** Long enough for a resting finger to lift what it is on (with room for a busy machine). */
const HOLD_WAIT = HOLD_MS + 120;

/**
 * A finger from `from` to `to` in `steps` moves (a frame apart). `hold`: it rests first, long enough
 * to lift a block or card (the way a block or card is dragged); without it, it moves at once (a swipe,
 * or an edge). `during` runs before the finger lifts.
 */
async function fingerDrag(from: Pt, to: Pt, opts: { steps?: number; hold?: boolean; during?: () => Promise<void> | void } = {}) {
  const steps = opts.steps ?? 14;
  await touch('touchStart', [{ ...from, id: 1 }]);
  await nextFrame();
  if (opts.hold) await settle(HOLD_WAIT);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 }]);
    await nextFrame();
  }
  await opts.during?.();
  await touch('touchEnd', []);
  await settle(120);
}

async function pen(type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', p: Pt) {
  await cdp().send('Input.dispatchMouseEvent', { type, ...toPage(p.x, p.y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen' });
}

const headerPoint = (id: Id): Pt => {
  const name = blockEl(id).querySelector<HTMLElement>('[class*="name"]')!.getBoundingClientRect();
  return { x: name.left + 12, y: name.top + name.height / 2 };
};

describe('touch', () => {
  it("a finger held on a block's name lifts it, then it follows and lands where the slot opened (one undo step)", async () => {
    await setup();
    const ids = blockIds();
    const before = undoCount();
    const from = headerPoint(ids[0]);
    const r3 = blockEl(ids[3]).getBoundingClientRect();
    let mid: string | undefined;
    let clone = false;
    await fingerDrag(from, { x: r3.right - 30, y: from.y }, {
      hold: true,
      during: async () => {
        await actFrame();
        mid = lane().dataset.carry;
        clone = !!document.querySelector('[data-testid="lane-clone"]');
      },
    });
    // Still dragging just before the finger lifted: handing the pointer from the name to the block did not cancel it.
    expect(mid).toBe('move');
    expect(clone).toBe(true);
    expect(blockIds().indexOf(ids[0])).toBe(3);
    expect(undoCount()).toBe(before + 1);
    expect(lane().hasAttribute('data-carry')).toBe(false);
  });

  it('a quick finger swipe over the blocks scrolls the lane natively and edits nothing', async () => {
    // A song longer than the lane, so it scrolls.
    act(() => {
      for (let i = 0; i < 10; i++) cmd.addBlock(session.store, project().scenes[i % 4].id, undefined, 4);
    });
    session.store.clearHistory();
    await setup();
    const ids = blockIds();
    const scroller = lane().children[1] as HTMLElement;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth + 200);
    expect(scroller.scrollLeft).toBe(0);
    let carried = false;
    // A finger flicked leftwards across Groove's name and cells, no rest.
    const from = headerPoint(ids[1]);
    await fingerDrag({ x: from.x + 300, y: from.y + 60 }, { x: from.x - 60, y: from.y + 60 }, {
      steps: 8,
      during: async () => {
        carried = lane().hasAttribute('data-carry');
      },
    });
    await settle(250);
    expect(carried).toBe(false);
    expect(scroller.scrollLeft).toBeGreaterThan(100);
    expect(blockIds()).toEqual(ids);
    expect(blocks().every((b) => !b.parts)).toBe(true);
    expect(undoCount()).toBe(0);
    expect(document.querySelector('[data-testid="lane-clone"]')).toBeNull();
    expect(document.querySelectorAll('[data-block-id][data-selected]').length).toBe(0);
  });

  it('a held finger lifts the block before it moves (the lift is shown at once); let go in place, the block shows its actions', async () => {
    await setup();
    const ids = blockIds();
    const from = headerPoint(ids[2]);
    await touch('touchStart', [{ ...from, id: 1 }]);
    await nextFrame();
    // Resting: the block shows it is being pressed, and nothing is lifted yet.
    await settle(Math.round(HOLD_MS / 2));
    expect(lane().hasAttribute('data-carry')).toBe(false);
    expect(blockEl(ids[2]).hasAttribute('data-pressing')).toBe(true);
    await settle(HOLD_WAIT - Math.round(HOLD_MS / 2));
    expect(lane().dataset.carry).toBe('move');
    const clone = document.querySelector<HTMLElement>('[data-testid="lane-clone"]')!;
    expect(clone.hasAttribute('data-held')).toBe(true);
    // The lift: a short pop on the lifted copy.
    expect(getComputedStyle(clone.querySelector<HTMLElement>('[class*="cloneItem"]')!).animationName).toMatch(/holdLift/);
    expect(blockEl(ids[2]).hasAttribute('data-pressing')).toBe(false);
    // Let go without moving: nothing moved, no undo step; the block's actions are open.
    await touch('touchEnd', []);
    await settle(150);
    expect(blockIds()).toEqual(ids);
    expect(undoCount()).toBe(0);
    expect(lane().hasAttribute('data-carry')).toBe(false);
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBe(`Block 3: Lift`);
    menu!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(100);
    // Held on a part cell and let go: that part's picker.
    const c = cellEl(ids[1], trackId('Bass')).getBoundingClientRect();
    await touch('touchStart', [{ x: c.left + 20, y: c.top + c.height / 2, id: 1 }]);
    await settle(HOLD_WAIT);
    await touch('touchEnd', []);
    await settle(150);
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('What Bass plays in Groove');
    expect(blocks().every((b) => !b.parts)).toBe(true);
  });

  it('a finger that moves before the hold never lifts the block (the browser takes it as a swipe)', async () => {
    await setup();
    const ids = blockIds();
    const from = headerPoint(ids[0]);
    await touch('touchStart', [{ ...from, id: 1 }]);
    await nextFrame();
    for (let i = 1; i <= 6; i++) {
      await touch('touchMove', [{ x: from.x + i * 12, y: from.y, id: 1 }]);
      await nextFrame();
    }
    // Resting now, past the hold time: still nothing lifted.
    await settle(HOLD_WAIT);
    expect(lane().hasAttribute('data-carry')).toBe(false);
    await touch('touchEnd', []);
    await settle(120);
    expect(blockIds()).toEqual(ids);
    expect(undoCount()).toBe(0);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('a finger held on a part cell drags the block (a move, not a toggle); a tap on a cell still switches the part', async () => {
    await setup();
    const ids = blockIds();
    const drums = trackId('Drums');
    const c = cellEl(ids[1], drums).getBoundingClientRect();
    // Carry Groove so its left edge sits on block 5's left edge: it lands as block 5.
    const dx = blockEl(ids[4]).getBoundingClientRect().left - blockEl(ids[1]).getBoundingClientRect().left;
    await fingerDrag({ x: c.left + 20, y: c.top + c.height / 2 }, { x: c.left + 20 + dx, y: c.top + c.height / 2 }, { hold: true });
    expect(blockIds().indexOf(ids[1])).toBe(4);
    expect(blocks().every((b) => !b.parts)).toBe(true);
    // A tap (no travel) switches the part off. (On a very busy machine a tap can arrive as a long press,
    // which opens the part picker instead: close it and tap again.)
    await settle(200);
    const c2 = cellEl(ids[2], drums).getBoundingClientRect();
    for (let attempt = 0; attempt < 2 && !blocks().find((b) => b.id === ids[2])!.parts; attempt++) {
      await touch('touchStart', [{ x: c2.left + 20, y: c2.top + c2.height / 2, id: 1 }]);
      await touch('touchEnd', []);
      await settle(150);
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      if (menu) {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle(100);
      }
    }
    expect(blocks().find((b) => b.id === ids[2])!.parts).toEqual({ [drums]: null });
  });

  it("a finger on the seam drags the left block's right edge: whole passes, one undo step, the block is selected", async () => {
    await setup();
    const ids = blockIds();
    const id = ids[0];
    const pass = blockEl(id).getBoundingClientRect().width / 2;
    const seam = blockEl(id).getBoundingClientRect().right;
    const y = blockEl(id).getBoundingClientRect().top + 90;
    // Just left of the seam (the handle) and just right of it (over the next block): both take the edge.
    let undo = undoCount();
    for (const [x, passes] of [
      [seam - 4, 4],
      [seam + 5, 6],
    ] as const) {
      const from = { x: x + (passes === 6 ? 2 * pass : 0), y };
      await fingerDrag(from, { x: from.x + 2 * pass + 4, y });
      expect(blocks()[0].repeats).toBe(passes);
      expect(undoCount()).toBe(undo + 1);
      undo = undoCount();
      expect(blockIds()).toEqual(ids);
      expect(blockEl(id).hasAttribute('data-selected')).toBe(true);
      await settle(200);
    }
  });

  it('a finger held on a scene card lifts it: onto the middle of a block layers it, between blocks inserts it', async () => {
    await setup();
    const ids = blockIds();
    const card = [...document.querySelectorAll<HTMLElement>('[aria-label^="Scene Lift"]')][0].getBoundingClientRect();
    const target = blockEl(ids[1]).getBoundingClientRect();
    await fingerDrag({ x: card.left + 60, y: card.top + 14 }, { x: target.left + target.width / 2, y: target.top + 70 }, { hold: true });
    expect(Object.values(blocks()[1].parts ?? {})).toContain(sceneId('Lift'));
    await settle(200);
    const card2 = [...document.querySelectorAll<HTMLElement>('[aria-label^="Scene Break"]')][0].getBoundingClientRect();
    const r3 = blockEl(ids[3]).getBoundingClientRect();
    await fingerDrag({ x: card2.left + 60, y: card2.top + 14 }, { x: r3.left + 4, y: r3.top + 70 }, { hold: true, during: () => settle(220) });
    expect(blocks().length).toBe(7);
    expect(blocks()[3].sceneId).toBe(sceneId('Break'));
  });

  it('a second finger tapping a part cell while a held block is carried changes nothing; the drag goes on', async () => {
    await setup();
    const ids = blockIds();
    const drums = trackId('Drums');
    const from = headerPoint(ids[0]);
    const r3 = blockEl(ids[3]).getBoundingClientRect();
    const other = cellEl(ids[5], drums).getBoundingClientRect();
    const to = { x: r3.right - 30, y: from.y };
    await touch('touchStart', [{ ...from, id: 1 }]);
    await settle(HOLD_WAIT);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / 10, y: from.y, id: 1 }]);
      await nextFrame();
    }
    // Second finger down and up on another block's cell, the first still down (CDP: the list is every finger now down).
    await touch('touchStart', [
      { ...to, id: 1 },
      { x: other.left + 20, y: other.top + other.height / 2, id: 2 },
    ]);
    await nextFrame();
    await touch('touchMove', [{ ...to, id: 1 }]);
    await actFrame();
    expect(lane().dataset.carry).toBe('move');
    expect(blocks().every((b) => !b.parts)).toBe(true);
    await touch('touchEnd', []);
    await settle(120);
    expect(blockIds().indexOf(ids[0])).toBe(3);
    expect(blocks().every((b) => !b.parts)).toBe(true);
  });
});

describe('pen', () => {
  it('a pen drags a block by its name', async () => {
    await setup();
    const ids = blockIds();
    const from = headerPoint(ids[0]);
    const r2 = blockEl(ids[2]).getBoundingClientRect();
    await pen('mousePressed', from);
    for (let i = 1; i <= 12; i++) {
      await pen('mouseMoved', { x: from.x + ((r2.right - 30 - from.x) * i) / 12, y: from.y });
      await nextFrame();
    }
    await actFrame();
    expect(lane().dataset.carry).toBe('move');
    await pen('mouseReleased', { x: r2.right - 30, y: from.y });
    await settle(120);
    expect(blockIds().indexOf(ids[0])).toBe(2);
  });
});
