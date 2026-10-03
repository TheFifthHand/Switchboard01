/**
 * When the insertion slot opens, and which way it closes (review minor 1):
 * - the way the card came is its net travel across (12 px or more); a card
 *   brought straight up to a boundary has no way across, so after the slot
 *   opened, leaving the edge zone either way passes through: right into the
 *   block's middle it is that block (Break onto Break: nothing to do), left
 *   into the other block's middle it layers;
 * - the slot opens in the frame after its delay, and not when pointer moves
 *   queued during a busy moment arrive meanwhile: a 260 ms stall of the main
 *   thread while the card passes a boundary still layers, and the slot never
 *   opens.
 * Real mouse (CDP), the running app at 1366 × 768.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SLOT_DELAY_MS } from '../../src/app/views/arrange/laneGestures';
import { blockEl, blockIds, blocks, card, mouse, openApp, resetArrange, sceneId, settle, smoothDrag, teardownArrange, type Pt } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const slotEl = () => document.querySelector<HTMLElement>('[data-testid="lane-slot"]')!;
const slotOpen = () => slotEl().hasAttribute('data-on') && !slotEl().hasAttribute('data-pending');
const ghost = () => document.querySelector<HTMLElement>('[data-testid="lane-ghost"] [class*="ghostMeta"]')?.textContent ?? '';
const snapshot = () => JSON.stringify(blocks().map((b) => [b.id, b.parts ?? {}]));

/** Watch the slot: true once it has been open at any moment. */
function watchSlot(): () => boolean {
  let opened = slotOpen();
  const mo = new MutationObserver(() => {
    if (slotOpen()) opened = true;
  });
  mo.observe(slotEl(), { attributes: true });
  return () => {
    mo.disconnect();
    return opened;
  };
}

async function line(a: Pt, b: Pt, ms: number) {
  const steps = Math.max(2, Math.round(ms / 16.7));
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }, { buttons: 1 });
    await new Promise((r) => setTimeout(r, 14));
  }
}

describe('the slot of a card brought straight up to a boundary', () => {
  for (const side of ['right', 'left'] as const) {
    it(`after resting on the Lift | Break seam (the slot opened), on ${side} into the middle of ${side === 'right' ? 'Break: nothing to do' : 'Lift: it layers'}`, async () => {
      await openApp(1366, 768);
      const ids = blockIds();
      const before = snapshot();
      const brk = card('Break').getBoundingClientRect();
      const lift = blockEl(ids[2]).getBoundingClientRect();
      const b4 = blockEl(ids[3]).getBoundingClientRect();
      const s = { x: b4.left + 5, y: brk.top + 14 };
      const up = { x: b4.left + 2, y: b4.top + 140 };
      await mouse('mouseMoved', s);
      await mouse('mousePressed', s);
      await line(s, up, 500);
      await settle(SLOT_DELAY_MS + 90);
      expect(slotOpen()).toBe(true);
      expect(ghost()).toBe('Insert Break as block 4');
      const target = side === 'right' ? { x: b4.left + b4.width / 2, y: up.y } : { x: lift.left + lift.width / 2, y: up.y };
      await line(up, target, 400);
      await settle(200);
      expect(slotOpen()).toBe(false);
      if (side === 'right') expect(ghost()).toBe('Break already plays Break');
      else expect(ghost()).toMatch(/^Layer Break into Lift/);
      await mouse('mouseReleased', target);
      await settle(200);
      expect(blocks().length).toBe(ids.length);
      if (side === 'right') expect(snapshot()).toBe(before);
      else expect(Object.values(blocks()[2].parts ?? {})).toContain(sceneId('Break'));
    });
  }
});

describe('a busy moment while the card passes a boundary', () => {
  it('a 260 ms stall at the Groove | Lift seam: the queued moves count, the slot never opens, and it layers into Lift', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    const intro = card('Intro').getBoundingClientRect();
    const lift = blockEl(ids[2]).getBoundingClientRect();
    const start = { x: intro.left + 90, y: intro.top + intro.height / 2 };
    const seam = { x: lift.left + 2, y: lift.top + 140 };
    const middle = { x: lift.left + lift.width / 2, y: lift.top + 140 };
    const opened = watchSlot();
    // On to the seam at an ordinary hand speed (the pointer arrives there and the slot's delay starts).
    await smoothDrag([start, { x: lift.left - 150, y: lift.top + 170 }, seam], 700, { release: false });
    // (Its last move heard: the pointer is on the seam and the slot's delay is running.)
    await settle(20);
    expect(ghost()).toBe('Insert Intro as block 3');
    // The page stalls for 260 ms (longer than what is left of the slot's delay) as the card goes on past the
    // seam. As after a real stall, the overdue timer runs first, and the pointer moves that queued up
    // meanwhile are delivered with the next frame (before its animation callbacks): they must still count,
    // and the slot must not open.
    const until = performance.now() + 260;
    while (performance.now() < until) {
      /* the main thread is busy */
    }
    await new Promise<void>((done) =>
      requestAnimationFrame(() => {
        for (let i = 1; i <= 6; i++) {
          const x = seam.x + ((middle.x - seam.x) * i) / 6;
          window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1, clientX: x, clientY: seam.y, bubbles: true }));
        }
        done();
      }),
    );
    await mouse('mouseMoved', middle, { buttons: 1 });
    await settle(SLOT_DELAY_MS + 100);
    expect(opened()).toBe(false);
    expect(ghost()).toMatch(/^Layer Intro into Lift/);
    await mouse('mouseReleased', middle);
    await settle(200);
    expect(blocks().length).toBe(ids.length);
    expect(Object.values(blocks()[2].parts ?? {})).toContain(sceneId('Intro'));
  });
});
