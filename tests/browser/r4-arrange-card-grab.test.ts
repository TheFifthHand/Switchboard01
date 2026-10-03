/**
 * A scene card can be picked up anywhere on it (review M1): with a mouse a
 * drag may start on its keys too (▶ Hear, + Add, ⋯ actions: the press stays a
 * click unless it travels, and the click that ends a drag does nothing); a
 * finger held anywhere on the card lifts it, and a held drag from a key never
 * hands the touch to the browser (no history swipe: the page stays). A quick
 * tap or click still presses the key. A dotted grip shows it can be picked
 * up. Real mouse and touch (CDP), the running app at 1366 × 768.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { HOLD_MS } from '../../src/app/views/arrange/laneGestures';
import { auditionedScene } from '../../src/app/views/arrange/ScenePalette';
import { blockEl, blockIds, blocks, card, centre, clickAt, mouse, openApp, press, project, resetArrange, rt, sceneId, settle, teardownArrange, type Pt } from './r4-arrange-helpers';
import { touch } from './r4-uikit-input';

beforeEach(resetArrange);
afterEach(async () => {
  await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await teardownArrange();
});

const lifted = () => !!document.querySelector('[data-lifted]') || !!document.querySelector('[data-testid="lane-ghost"][data-on]');
const keyOf = (scene: string, which: 'hear' | 'add' | 'more') =>
  card(scene).querySelector<HTMLElement>(which === 'hear' ? '[data-testid="scene-audition"]' : which === 'add' ? 'button[aria-label^="Add "]' : '[data-card-menu]')!;

/** Into the middle of Break (block 4): a layer of Groove's clips into its silent parts. */
const breakMiddle = (): Pt => {
  const r = blockEl(blockIds()[3]).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + 150 };
};

async function mouseDragFrom(p: Pt, to: Pt, release = true) {
  await mouse('mouseMoved', p);
  await mouse('mousePressed', p);
  for (let i = 1; i <= 20; i++) await mouse('mouseMoved', { x: p.x + ((to.x - p.x) * i) / 20, y: p.y + ((to.y - p.y) * i) / 20 }, { buttons: 1 });
  if (release) await mouse('mouseReleased', to);
  await settle(120);
}

describe('picking up a scene card', () => {
  it('a mouse drag starts anywhere across the card, its keys included', async () => {
    await openApp(1366, 768);
    const c = card('Groove').getBoundingClientRect();
    let ok = 0;
    let n = 0;
    for (let x = c.left + 4; x < c.right - 2; x += 8) {
      const p = { x, y: c.top + c.height / 2 };
      await mouse('mouseMoved', p);
      await mouse('mousePressed', p);
      for (let i = 1; i <= 6; i++) await mouse('mouseMoved', { x: p.x + 3 * i, y: p.y - 12 * i }, { buttons: 1 });
      await settle(20);
      n++;
      if (lifted()) ok++;
      await press('Escape');
      await mouse('mouseReleased', { x: p.x + 18, y: p.y - 72 });
      await settle(60);
    }
    expect(ok).toBe(n);
    // Nothing else happened: no audition, no menu, nothing added.
    expect(auditionedScene()).toBeNull();
    expect(rt().playing).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(blocks().length).toBe(6);
  });

  for (const which of ['hear', 'more', 'add'] as const) {
    it(`a mouse drag from its ${which === 'hear' ? '▶' : which === 'more' ? '⋯' : '+'} lays the card into a block (and does not press the key)`, async () => {
      await openApp(1366, 768);
      const before = { n: blocks().length, parts: JSON.stringify(blocks()[3].parts ?? {}) };
      await mouseDragFrom(centre(keyOf('Groove', which)), breakMiddle());
      // Layered into Break: its silent parts play Groove's clips; nothing added at the end.
      expect(blocks().length).toBe(before.n);
      expect(JSON.stringify(blocks()[3].parts ?? {})).not.toBe(before.parts);
      expect(Object.values(blocks()[3].parts ?? {})).toContain(sceneId('Groove'));
      expect(auditionedScene()).toBeNull();
      expect(rt().playing).toBe(false);
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });
  }

  it('a plain click still presses the key: ▶ hears the scene, ⋯ opens its actions, + adds it', async () => {
    await openApp(1366, 768);
    await clickAt(centre(keyOf('Lift', 'more')));
    await settle(60);
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Scene Lift');
    await press('Escape');
    await clickAt(centre(keyOf('Lift', 'add')));
    await settle(60);
    expect(blocks().length).toBe(7);
    expect(blocks()[6].sceneId).toBe(sceneId('Lift'));
    await clickAt(centre(keyOf('Lift', 'hear')));
    for (let i = 0; i < 40 && !rt().playing; i++) await settle(50);
    expect(auditionedScene()).toBe(sceneId('Lift'));
    await clickAt(centre(keyOf('Lift', 'hear')));
    expect(rt().playing).toBe(false);
  });

  it('shows a dotted grip at its left edge', async () => {
    await openApp(1366, 768);
    const grip = getComputedStyle(card('Intro'), '::before');
    expect(grip.content).not.toBe('none');
    expect(grip.backgroundImage).toMatch(/radial-gradient/);
    expect(parseFloat(grip.width)).toBeGreaterThanOrEqual(5);
  });
});

describe('with a finger', () => {
  beforeEach(async () => {
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  });

  for (const which of ['hear', 'more', 'add'] as const) {
    it(`held on its ${which === 'hear' ? '▶' : which === 'more' ? '⋯' : '+'} and dragged to the lane, the card lifts and lands; the page stays`, async () => {
      await openApp(1366, 768);
      const url = location.href;
      const top = window.top?.location.href;
      const s = centre(keyOf('Groove', which));
      const e = breakMiddle();
      await touch('touchStart', [s]);
      await settle(HOLD_MS + 120);
      expect(lifted()).toBe(true);
      for (let i = 1; i <= 30; i++) {
        await touch('touchMove', [{ x: s.x + ((e.x - s.x) * i) / 30, y: s.y + ((e.y - s.y) * i) / 30 }]);
        await new Promise((r) => requestAnimationFrame(r));
      }
      await touch('touchEnd', []);
      await settle(300);
      expect(location.href).toBe(url);
      expect(window.top?.location.href).toBe(top);
      expect(Object.values(blocks()[3].parts ?? {})).toContain(sceneId('Groove'));
      expect(blocks().length).toBe(6);
      expect(auditionedScene()).toBeNull();
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });
  }

  it('a hold anywhere across the card lifts it; a quick tap on + still adds the scene', async () => {
    await openApp(1366, 768);
    const c = card('Groove').getBoundingClientRect();
    let ok = 0;
    let n = 0;
    for (let x = c.left + 4; x < c.right - 2; x += 12) {
      await touch('touchStart', [{ x, y: c.top + c.height / 2 }]);
      await settle(HOLD_MS + 100);
      n++;
      if (lifted()) ok++;
      await touch('touchCancel', []);
      await settle(150);
      await press('Escape');
    }
    expect(ok).toBe(n);
    expect(project().arrangement.blocks.length).toBe(6);
    // A tap.
    const add = centre(keyOf('Break', 'add'));
    await touch('touchStart', [add]);
    await touch('touchEnd', []);
    await settle(200);
    expect(blocks().length).toBe(7);
    expect(blocks()[6].sceneId).toBe(sceneId('Break'));
  });
});
