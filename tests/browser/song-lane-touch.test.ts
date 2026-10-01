/**
 * The song lane with real touch and pen input (Chrome DevTools Protocol
 * Input.dispatchTouchEvent / dispatchMouseEvent with pointerType "pen"), so
 * the browser's own implicit pointer capture is in play: the element under
 * the finger holds the pointer until the lane takes it for the dragged
 * block, and that hand-over must not cancel the drag. Synthetic
 * PointerEvents cannot show this.
 *
 * Checked on the project in session.store: a finger drags a block by its
 * name and by a part cell, drags its right edge for passes, and drags scene
 * cards in (insert between blocks, layer into a block); a pen drags a block.
 * A tap on a part cell still switches it, and a second finger tapping a cell
 * while a block is carried changes nothing.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { clearBlockClipboard } from '../../src/app/views/arrange/songActions';
import { getStarter } from '../../src/content/starters';
import type { Id } from '../../src/project/types';
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

/** A finger from `from` to `to` in `steps` moves (a frame apart); `during` runs before the finger lifts. */
async function fingerDrag(from: Pt, to: Pt, opts: { steps?: number; during?: () => Promise<void> | void } = {}) {
  const steps = opts.steps ?? 14;
  await touch('touchStart', [{ ...from, id: 1 }]);
  await nextFrame();
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
  it('a finger drags a block by its name: it lifts, follows, lands where the slot opened (one undo step)', async () => {
    await setup();
    const ids = blockIds();
    const before = undoCount();
    const from = headerPoint(ids[0]);
    const r3 = blockEl(ids[3]).getBoundingClientRect();
    let mid: string | undefined;
    let clone = false;
    await fingerDrag(from, { x: r3.right - 30, y: from.y }, {
      during: async () => {
        await actFrame();
        mid = lane().dataset.dragging;
        clone = !!document.querySelector('[data-testid="lane-clone"]');
      },
    });
    // Still dragging just before the finger lifted: handing the pointer from the name to the block did not cancel it.
    expect(mid).toBe('move');
    expect(clone).toBe(true);
    expect(blockIds().indexOf(ids[0])).toBe(3);
    expect(undoCount()).toBe(before + 1);
    expect(lane().hasAttribute('data-dragging')).toBe(false);
  });

  it('a finger drags a block by a part cell (a move, not a toggle); a tap on a cell still switches the part', async () => {
    await setup();
    const ids = blockIds();
    const drums = trackId('Drums');
    const c = cellEl(ids[1], drums).getBoundingClientRect();
    // Carry Groove so its left edge sits on block 5's left edge: it lands as block 5.
    const dx = blockEl(ids[4]).getBoundingClientRect().left - blockEl(ids[1]).getBoundingClientRect().left;
    await fingerDrag({ x: c.left + 20, y: c.top + c.height / 2 }, { x: c.left + 20 + dx, y: c.top + c.height / 2 });
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

  it('a finger drags scene cards in: onto the middle of a block layers it, between blocks inserts it', async () => {
    await setup();
    const ids = blockIds();
    const card = [...document.querySelectorAll<HTMLElement>('[aria-label^="Scene Lift"]')][0].getBoundingClientRect();
    const target = blockEl(ids[1]).getBoundingClientRect();
    await fingerDrag({ x: card.left + 60, y: card.top + 14 }, { x: target.left + target.width / 2, y: target.top + 70 });
    expect(Object.values(blocks()[1].parts ?? {})).toContain(sceneId('Lift'));
    await settle(200);
    const card2 = [...document.querySelectorAll<HTMLElement>('[aria-label^="Scene Break"]')][0].getBoundingClientRect();
    const r3 = blockEl(ids[3]).getBoundingClientRect();
    await fingerDrag({ x: card2.left + 60, y: card2.top + 14 }, { x: r3.left + 4, y: r3.top + 70 }, { during: () => settle(220) });
    expect(blocks().length).toBe(7);
    expect(blocks()[3].sceneId).toBe(sceneId('Break'));
  });

  it('a second finger tapping a part cell while a block is carried changes nothing; the drag goes on', async () => {
    await setup();
    const ids = blockIds();
    const drums = trackId('Drums');
    const from = headerPoint(ids[0]);
    const r3 = blockEl(ids[3]).getBoundingClientRect();
    const other = cellEl(ids[5], drums).getBoundingClientRect();
    const to = { x: r3.right - 30, y: from.y };
    await touch('touchStart', [{ ...from, id: 1 }]);
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
    expect(lane().dataset.dragging).toBe('move');
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
    expect(lane().dataset.dragging).toBe('move');
    await pen('mouseReleased', { x: r2.right - 30, y: from.y });
    await settle(120);
    expect(blockIds().indexOf(ids[0])).toBe(2);
  });
});
