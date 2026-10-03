/**
 * A scene card dragged onto the middle of a block layers into it, however
 * slowly it is dragged there (P1 arrange-card-layer-becomes-insert). The
 * insertion slot opens only after the pointer rests on a boundary (about
 * 250 ms with less than 3 px of movement), so crossing a boundary on the way
 * to a block's middle never pushes that block away.
 *
 * Real input: CDP mouse events at 60 Hz along smooth human-like paths (a
 * minimum-jerk speed profile) of 0.5, 0.8, 1.1 and 1.4 s, from each scene card
 * into the middle of blocks 2–5, approaching from the left. A run the machine
 * stalled in (a gap between two pointer moves long enough to be a rest) is
 * run again: a rest is exactly what opens the slot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layerPreview, layerText } from '../../src/app/views/arrange/songModel';
import { SLOT_DELAY_MS } from '../../src/app/views/arrange/laneGestures';
import { blockEl, blockIds, blocks, card, ghostText, mouse, openApp, press, project, resetArrange, sceneId, settle, smoothDrag, teardownArrange, type Pt } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const CARDS = ['Intro', 'Groove', 'Lift', 'Break'];
const TARGETS = [1, 2, 3, 4];
/** A gap between pointer moves this long is a rest the machine made, not the path. */
const STALL_MS = 180;

/** What dropping `scene` on block `i` says (the layer target's own words). */
function expectedTitle(scene: string, i: number): string {
  const p = project();
  const b = p.arrangement.blocks[i];
  const name = blockEl(b.id).querySelector('[class*="name"]')!.textContent!;
  return layerText(layerPreview(p, b, sceneId(scene), 'fill'), name).title;
}

/** Card → a point left of block `i` → the middle of block `i`. */
function pathTo(scene: string, i: number): { points: Pt[]; middle: Pt } {
  const c = card(scene).getBoundingClientRect();
  const t = blockEl(blockIds()[i]).getBoundingClientRect();
  const start = { x: c.left + 58, y: c.top + c.height / 2 };
  const middle = { x: t.left + t.width / 2, y: t.top + Math.min(160, t.height / 2) };
  const before = { x: t.left - 90, y: middle.y + 40 };
  const lift = { x: (start.x + before.x) / 2, y: Math.min(start.y, before.y) + (start.y - before.y) * 0.35 };
  return { points: [start, lift, before, middle], middle };
}

interface Run {
  text: string;
  layered: boolean;
  pushed: boolean;
  slotOpen: boolean;
  stalled: boolean;
}

async function dragInto(scene: string, i: number, ms: number): Promise<Run> {
  const ids = blockIds();
  const lefts = ids.map((id) => Math.round(blockEl(id).getBoundingClientRect().left));
  const { points, middle } = pathTo(scene, i);
  const { gaps } = await smoothDrag(points, ms, { release: false });
  // The pointer now rests in the middle of the block, longer than the slot's delay: still a layer.
  await settle(SLOT_DELAY_MS + 60);
  const meta = document.querySelector<HTMLElement>('[data-testid="lane-ghost"] [class*="ghostMeta"]')?.textContent ?? ghostText();
  const run: Run = {
    text: meta,
    layered: blockEl(ids[i]).hasAttribute('data-layer-target'),
    pushed: ids.some((id, k) => Math.abs(Math.round(blockEl(id).getBoundingClientRect().left) - lefts[k]) > 1),
    slotOpen: (() => {
      const slot = document.querySelector<HTMLElement>('[data-testid="lane-slot"]')!;
      return slot.hasAttribute('data-on') && !slot.hasAttribute('data-pending');
    })(),
    stalled: gaps.some((g) => g > STALL_MS),
  };
  // Cancel (Escape), so the next run starts from the same song.
  await press('Escape');
  await mouse('mouseReleased', middle);
  await settle(60);
  return run;
}

async function dragIntoReliably(scene: string, i: number, ms: number): Promise<Run & { tries: number }> {
  for (let tries = 1; ; tries++) {
    const r = await dragInto(scene, i, ms);
    if (!r.stalled || tries >= 4) return { ...r, tries };
  }
}

function check(scene: string, i: number, ms: number, r: Run, expected: string) {
  const what = `${scene} card → block ${i + 1} in ${ms} ms`;
  expect(r.text, what).toBe(expected);
  expect(r.text.startsWith('Insert'), what).toBe(false);
  expect(r.layered, `${what}: block outlined as the layer target`).toBe(true);
  expect(r.pushed, `${what}: no block pushed aside`).toBe(false);
  expect(r.slotOpen, `${what}: no insertion slot open`).toBe(false);
}

/** "Layer … into …" drops per speed, over the four cards (each card is its own test, so a slow machine has time). */
const layered = new Map<number, number>();

describe('a scene card dragged into the middle of a block layers into it (1366 x 768)', () => {
  for (const ms of [500, 800, 1100, 1400]) {
    for (const scene of CARDS) {
      it(`the ${scene} card into blocks 2–5 over ${ms} ms, approaching from the left`, async () => {
        await openApp(1366, 768);
        const ids = blockIds();
        for (const i of TARGETS) {
          const expected = expectedTitle(scene, i);
          const r = await dragIntoReliably(scene, i, ms);
          check(scene, i, ms, r, expected);
          if (/^Layer .+ into .+$/.test(r.text)) layered.set(ms, (layered.get(ms) ?? 0) + 1);
        }
        // Nothing was changed by the cancelled drags.
        expect(blockIds()).toEqual(ids);
      }, 180_000);
    }
  }

  it('most of those 16 pairs at each speed read "Layer … into …" (the rest: a block of the same scene, or nothing silent to fill)', () => {
    for (const ms of [500, 800, 1100, 1400]) expect(layered.get(ms) ?? 0, `${ms} ms`).toBeGreaterThanOrEqual(10);
  });

  it('the four reported drags read "Layer … into …" in 20 of 20 runs (5 at each speed)', async () => {
    await openApp(1366, 768);
    // Intro → Groove (2), Intro → Lift (3), Lift → Groove (2), Break → Lift (5), Break → Groove (2).
    const pairs: [string, number][] = [
      ['Intro', 1],
      ['Intro', 2],
      ['Lift', 1],
      ['Break', 4],
      ['Break', 1],
    ];
    let ok = 0;
    for (const ms of [500, 800, 1100, 1400]) {
      for (const [scene, i] of pairs) {
        const r = await dragIntoReliably(scene, i, ms);
        check(scene, i, ms, r, expectedTitle(scene, i));
        expect(r.text).toMatch(/^Layer .+ into .+$/);
        ok++;
      }
    }
    expect(ok).toBe(20);
  }, 120_000);

  it('a drop there layers the card in (one undo step); a deliberate rest on a boundary still opens the slot and inserts', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    const groove = blocks()[1];
    // Intro into Groove at an ordinary hand speed, then released: Groove's silent parts play Intro's clips.
    const { points } = pathTo('Intro', 1);
    await smoothDrag(points, 1000);
    await settle(120);
    expect(blockIds()).toEqual(ids);
    const parts = blocks()[1].parts ?? {};
    expect(Object.values(parts).filter((v) => v === sceneId('Intro')).length).toBeGreaterThan(0);
    expect(blocks()[1].sceneId).toBe(groove.sceneId);

    // Rest on the boundary between Lift (3) and Break (4) for 300 ms: the slot opens and the drop inserts there.
    const c = card('Break').getBoundingClientRect();
    const b = blockEl(ids[3]).getBoundingClientRect();
    const start = { x: c.left + 58, y: c.top + c.height / 2 };
    const seam = { x: b.left + 2, y: b.top + 120 };
    await smoothDrag([start, { x: b.left - 120, y: b.top + 150 }, seam], 800, { release: false });
    await settle(300 + 80);
    const slot = document.querySelector<HTMLElement>('[data-testid="lane-slot"]')!;
    expect(slot.hasAttribute('data-on')).toBe(true);
    expect(slot.hasAttribute('data-pending')).toBe(false);
    expect(slot.getBoundingClientRect().width).toBeGreaterThan(40);
    const meta = document.querySelector<HTMLElement>('[data-testid="lane-ghost"] [class*="ghostMeta"]')!.textContent;
    expect(meta).toBe('Insert Break as block 4');
    await mouse('mouseReleased', seam);
    await settle(120);
    expect(blocks().length).toBe(ids.length + 1);
    expect(blocks()[3].sceneId).toBe(sceneId('Break'));
    expect(blockIds()[4]).toBe(ids[3]);
  });

  it('after the slot opened, going on the way the pointer came closes it and layers into the block beyond', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    const c = card('Intro').getBoundingClientRect();
    const lift = blockEl(ids[2]).getBoundingClientRect();
    const start = { x: c.left + 58, y: c.top + c.height / 2 };
    const seam = { x: lift.left + 4, y: lift.top + 120 };
    await smoothDrag([start, { x: lift.left - 150, y: lift.top + 160 }, seam], 700, { release: false });
    await settle(SLOT_DELAY_MS + 120);
    const slot = document.querySelector<HTMLElement>('[data-testid="lane-slot"]')!;
    expect(slot.hasAttribute('data-on') && !slot.hasAttribute('data-pending')).toBe(true);
    // On to the right, into what was Lift's middle: the slot closes and Intro layers into Lift.
    for (let x = seam.x; x <= lift.left + lift.width / 2; x += 8) await mouse('mouseMoved', { x, y: seam.y }, { buttons: 1 });
    await settle(SLOT_DELAY_MS + 60);
    expect(slot.hasAttribute('data-on') && !slot.hasAttribute('data-pending')).toBe(false);
    expect(blockEl(ids[2]).hasAttribute('data-layer-target')).toBe(true);
    expect(Math.round(blockEl(ids[2]).getBoundingClientRect().left)).toBe(Math.round(lift.left));
    await press('Escape');
    await mouse('mouseReleased', seam);
    expect(blockIds()).toEqual(ids);
  });
});

describe('the same at 1920 x 1080 and at 200 % (960 x 540)', () => {
  const runs = new Map<number, number>();
  for (const [w, hh] of [
    [1920, 1080],
    [960, 540],
  ] as const) {
    for (const scene of CARDS) {
      it(`${w} x ${hh}: the ${scene} card into blocks 2–5 over 1.1 s layers`, async () => {
        await openApp(w, hh);
        for (const i of TARGETS) {
          // At 200 % the page scrolls: the scene cards at the window's bottom, the blocks above them.
          card(scene).scrollIntoView({ block: 'end' });
          await settle(30);
          const t = blockEl(blockIds()[i]).getBoundingClientRect();
          // The lane scrolls sideways there too: only blocks wholly in view (with room left of them) are aimed at.
          const view = document.querySelector<HTMLElement>('[data-testid="lane-scroller"]')!.getBoundingClientRect();
          if (t.right > view.right || t.left - 100 < view.left || t.top < 0) continue;
          const r = await dragIntoReliably(scene, i, 1100);
          check(scene, i, 1100, r, expectedTitle(scene, i));
          runs.set(w, (runs.get(w) ?? 0) + 1);
        }
      }, 180_000);
    }
  }

  it('at both sizes at least 8 of the 16 pairs were in view to try', () => {
    expect(runs.get(1920) ?? 0).toBeGreaterThanOrEqual(8);
    expect(runs.get(960) ?? 0).toBeGreaterThanOrEqual(8);
  });
});
