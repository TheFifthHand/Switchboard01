/**
 * Shape, Advanced mode in real Chromium: reordering effects by dragging
 * their cards (one undo step, Escape cancels, refused while a take records),
 * the new effect types fully editable in the rack and patchable in the cable
 * panel, and the layout with full-word knob labels at three window sizes.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { CablePanel } from '../../src/app/views/cables';
import { ShapeView } from '../../src/app/views/shape/ShapeView';
import { dropIndex } from '../../src/app/views/shape/useEffectDrag';
import { createProject } from '../../src/project/factory';
import { trackChain } from '../../src/project/graph';
import { MODULE_DEFS } from '../../src/project/modules';
import { MODULE_PARAMS } from '../../src/project/params';
import type { ModuleType, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { selectModule, selectTrack, setCablesOpen, setUiMode } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, key, mount, pointer, pointIn } from './ui-harness';

const project = (): Project => session.store.getState();
const mod = (id: string) => project().patch.modules.find((m) => m.id === id);
const NEW_TYPES: ModuleType[] = ['eq', 'compressor', 'gate', 'autopan', 'widener', 'flanger', 'tape'];

function setup(trackId = 't3', opts: { width?: number; height?: number | 'auto'; effects?: ModuleType[] } = {}) {
  const ids: string[] = [];
  act(() => {
    session.store.setLock(null);
    session.store.replace(createProject({ name: 'Advanced shape test', now: 1 }));
    for (const t of opts.effects ?? []) ids.push(cmd.insertEffect(session.store, trackId, t).moduleId!);
    selectTrack(trackId);
    setCablesOpen(false);
    selectModule(null);
    setUiMode('advanced');
  });
  const m = mount(h(TipsProvider, { enabled: false }, h(ShapeView)), { width: opts.width ?? 1366 });
  m.container.style.padding = '0';
  m.container.style.height = opts.height === 'auto' ? 'auto' : `${opts.height ?? 610}px`;
  return { m, ids };
}

function slider(root: Element, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`);
  if (!el) throw new Error(`No slider "${name}"`);
  return el;
}

const rackCard = (root: Element, id: string) => root.querySelector<HTMLElement>(`#rack-card-${CSS.escape(id)}`)!;
const cell = (root: Element, id: string) => root.querySelector<HTMLElement>(`[data-rack-cell="${CSS.escape(id)}"]`)!;
const grip = (root: Element, id: string) => root.querySelector<HTMLElement>(`[data-grip="${CSS.escape(id)}"]`)!;

/** Drag a card's grip to a point, in small steps like a hand. */
function dragGrip(g: HTMLElement, to: { clientX: number; clientY: number }, opts: { release?: boolean } = {}) {
  const from = pointIn(g);
  pointer(g, 'pointerdown', from);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    pointer(g, 'pointermove', { clientX: from.clientX + ((to.clientX - from.clientX) * i) / steps, clientY: from.clientY + ((to.clientY - from.clientY) * i) / steps });
  }
  if (opts.release !== false) pointer(g, 'pointerup', to);
}

beforeEach(async () => {
  // Tall enough for the three Advanced columns side by side (shorter windows show them as tabs: r4-shape-layout).
  await page.viewport(1366, 900);
  window.scrollTo(0, 0);
  runtimeStore.setState((s) => ({ ...s, notice: null }));
});

afterEach(() => {
  cleanup();
  session.store.setLock(null);
});

describe('Reordering effects by dragging', () => {
  it('works out the landing place in reading order across rows', () => {
    const r = (left: number, top: number) => new DOMRect(left, top, 100, 50);
    const cells = [r(0, 0), r(110, 0), r(0, 60)];
    expect(dropIndex(cells, 10, 20)).toBe(0); // left half of the first card
    expect(dropIndex(cells, 70, 20)).toBe(1); // right half of the first card
    expect(dropIndex(cells, 200, 20)).toBe(2); // right half of the second card
    expect(dropIndex(cells, 10, 55)).toBe(2); // in the gap before the second row
    expect(dropIndex(cells, 90, 80)).toBe(3); // after the last card
  });

  it('dropping a card before another moves it there in the real chain, as one undo step', async () => {
    // Tall enough that the rack does not scroll while dragging.
    const { m, ids } = setup('t3', { height: 1400, effects: ['chorus', 'phaser'] });
    const [chorus, phaser] = ids;
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:filter', chorus, phaser, 't3:ch']);
    const drive = cell(m.container, 't3:drive').getBoundingClientRect();
    const target = { clientX: drive.left + 12, clientY: drive.top + drive.height / 2 };

    dragGrip(grip(m.container, phaser), target, { release: false });
    // While dragging: the card follows the pointer and a bar marks where it lands.
    expect(rackCard(m.container, phaser).hasAttribute('data-dragging')).toBe(true);
    expect(rackCard(m.container, phaser).style.transform).toMatch(/translate/);
    expect(cell(m.container, 't3:drive').getAttribute('data-drop')).toBe('before');
    pointer(grip(m.container, phaser), 'pointerup', target);

    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', phaser, 't3:drive', 't3:filter', chorus, 't3:ch']);
    expect(rackCard(m.container, phaser).hasAttribute('data-dragging')).toBe(false);
    expect(rackCard(m.container, phaser).style.transform).toBe('');
    expect(runtimeStore.getState().notice).toMatchObject({ text: 'Moved Phaser: it now comes first in the chain.', action: 'undo' });
    await actFrame();
    expect(document.activeElement?.id).toBe(`rack-${phaser}-name`);
    act(() => session.undo());
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:filter', chorus, phaser, 't3:ch']);
  });

  it('moves a card later too, and names where it went', () => {
    const { m, ids } = setup('t3', { height: 1400, effects: ['chorus'] });
    const [chorus] = ids;
    const last = cell(m.container, chorus).getBoundingClientRect();
    dragGrip(grip(m.container, 't3:drive'), { clientX: last.right - 10, clientY: last.top + last.height / 2 });
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:filter', chorus, 't3:drive', 't3:ch']);
    expect(runtimeStore.getState().notice?.text).toBe('Moved Drive: it now comes after Chorus.');
  });

  it('Escape, a tiny movement or dropping where it started change nothing', () => {
    const { m, ids } = setup('t3', { height: 1400, effects: ['chorus'] });
    const before = trackChain(project().patch, 't3');
    const undoLabel = session.store.info.getState().undoLabel;
    // Escape mid-drag.
    const filter = cell(m.container, 't3:drive').getBoundingClientRect();
    dragGrip(grip(m.container, ids[0]), { clientX: filter.left + 8, clientY: filter.top + 20 }, { release: false });
    key(window, 'keydown', { key: 'Escape' });
    expect(rackCard(m.container, ids[0]).hasAttribute('data-dragging')).toBe(false);
    pointer(grip(m.container, ids[0]), 'pointerup', { clientX: filter.left + 8, clientY: filter.top + 20 });
    expect(trackChain(project().patch, 't3')).toEqual(before);
    // A press with a 3 px wobble is not a drag.
    const g = grip(m.container, ids[0]);
    const p = pointIn(g);
    pointer(g, 'pointerdown', p);
    pointer(g, 'pointermove', { clientX: p.clientX + 3, clientY: p.clientY });
    expect(rackCard(m.container, ids[0]).hasAttribute('data-dragging')).toBe(false);
    pointer(g, 'pointerup', { clientX: p.clientX + 3, clientY: p.clientY });
    // Back to its own place.
    const own = cell(m.container, ids[0]).getBoundingClientRect();
    dragGrip(grip(m.container, ids[0]), { clientX: own.left + own.width * 0.75, clientY: own.top + 10 });
    expect(trackChain(project().patch, 't3')).toEqual(before);
    expect(session.store.info.getState().undoLabel).toBe(undoLabel);
  });

  it('is refused while a performance records, with the reason; the arrows are disabled too', () => {
    const { m, ids } = setup('t3', { height: 1400, effects: ['chorus'] });
    act(() => session.store.setLock('Recording a performance: routing is locked until the take ends.'));
    const before = trackChain(project().patch, 't3');
    const drive = cell(m.container, 't3:drive').getBoundingClientRect();
    dragGrip(grip(m.container, ids[0]), { clientX: drive.left + 8, clientY: drive.top + 20 });
    expect(trackChain(project().patch, 't3')).toEqual(before);
    expect(runtimeStore.getState().notice?.text).toBe('Recording a performance: routing is locked until the take ends.');
    expect(m.container.querySelector<HTMLButtonElement>('[aria-label="Move Chorus earlier"]')!.disabled).toBe(true);
    expect(m.container.textContent).toContain('Effects are locked while a performance records.');
    // The knobs keep working (a take records them).
    const depth = slider(rackCard(m.container, ids[0]), 'Depth');
    const d0 = mod(ids[0])!.params.depth;
    key(depth, 'keydown', { key: 'ArrowUp' });
    expect(mod(ids[0])!.params.depth).toBeGreaterThan(d0);
  });

  it('the keyboard alternative: Move earlier / later buttons', () => {
    const { m, ids } = setup('t3', { effects: ['chorus'] });
    fire(m.container.querySelector<HTMLElement>('[aria-label="Move Chorus earlier"]')!, new MouseEvent('click', { bubbles: true }));
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', ids[0], 't3:filter', 't3:ch']);
  });
});

describe('New effect types in the rack', () => {
  it('every setting of every new effect type is a knob that changes it', () => {
    for (let start = 0; start < NEW_TYPES.length; start += 4) {
      const batch = NEW_TYPES.slice(start, start + 4);
      const { m, ids } = setup('t3', { effects: batch });
      batch.forEach((type, i) => {
        const c = rackCard(m.container, ids[i]);
        expect(c, type).not.toBeNull();
        const specs = MODULE_PARAMS[type];
        expect(c.querySelectorAll('[role="slider"]')).toHaveLength(specs.length);
        for (const spec of specs) {
          const knob = slider(c, spec.label);
          const before = mod(ids[i])!.params[spec.id];
          const k = before >= spec.max ? 'Home' : 'End';
          key(knob, 'keydown', { key: k });
          expect(mod(ids[i])!.params[spec.id], `${type}.${spec.id}`).toBe(k === 'End' ? spec.max : spec.min);
        }
      });
      cleanup();
    }
  });

  it('the EQ reads as three bands and the compressor as two rows', () => {
    const { m, ids } = setup('t3', { effects: ['eq', 'compressor'] });
    const rows = (id: string) => [...rackCard(m.container, id).querySelectorAll('[data-fixed]')].map((r) => [...r.querySelectorAll('[role="slider"]')].map((s) => s.getAttribute('aria-label')));
    expect(rows(ids[0])).toEqual([
      ['Low Cut', 'Lows', 'Lows Pitch'],
      ['Mids', 'Mids Pitch', 'Mids Width'],
      ['Highs', 'Highs Pitch', 'High Cut'],
    ]);
    expect(rows(ids[1])).toEqual([
      ['Threshold', 'Squeeze', 'Makeup'],
      ['Attack', 'Release', 'Mix'],
    ]);
  });

  it('a modulation cable into a new effect marks the knob it moves', () => {
    const { m, ids } = setup('t3', { effects: ['eq', 'tape'] });
    act(() => {
      expect(cmd.connect(session.store, { module: 't3:lfo', port: 'out' }, { module: ids[0], port: 'mid' }).ok).toBe(true);
      expect(cmd.connect(session.store, { module: 't3:lfo', port: 'out' }, { module: ids[1], port: 'drive' }).ok).toBe(true);
    });
    expect(slider(rackCard(m.container, ids[0]), 'Mids Pitch').getAttribute('aria-valuetext')).toMatch(/modulated$/);
    expect(slider(rackCard(m.container, ids[0]), 'Mids').getAttribute('aria-valuetext')).not.toMatch(/modulated/);
    expect(slider(rackCard(m.container, ids[1]), 'Saturation').getAttribute('aria-valuetext')).toMatch(/modulated$/);
    expect(m.container.querySelector('[aria-label="LFO"]')!.textContent).toContain('EQ Mids');
  });
});

describe('New effect types in the cable panel', () => {
  it('each is a block with its full name, audio sockets and its labelled modulation input', async () => {
    await page.viewport(1920, 1080);
    for (let start = 0; start < NEW_TYPES.length; start += 4) {
      const batch = NEW_TYPES.slice(start, start + 4);
      const ids: string[] = [];
      act(() => {
        session.store.replace(createProject({ name: 'Cables', now: 1 }));
        for (const t of batch) ids.push(cmd.insertEffect(session.store, 't3', t).moduleId!);
      });
      const m = mount(h(CablePanel, { trackId: 't3', height: 340 }), { width: 2200 });
      await document.fonts.ready;
      await actFrame();
      batch.forEach((type, i) => {
        const block = m.container.querySelector<HTMLElement>(`[data-module="${CSS.escape(ids[i])}"]`)!;
        expect(block, type).not.toBeNull();
        const name = block.querySelector<HTMLElement>('button[aria-pressed]')!;
        expect(name.textContent).toBe(MODULE_DEFS[type].label);
        expect(name.scrollWidth, `${type} name fits`).toBeLessThanOrEqual(name.clientWidth);
        // No abbreviated legend ("COMP", "FLNG").
        expect(block.querySelector('[class*="legend"]')).toBeNull();
        for (const port of MODULE_DEFS[type].ports) {
          const s = m.container.querySelector<HTMLElement>(`button[data-socket-key="${CSS.escape(`${port.direction}|${ids[i]}|${port.id}`)}"]`)!;
          expect(s, `${type} ${port.id}`).not.toBeNull();
          expect(s.dataset.kind).toBe(port.kind);
          if (port.kind === 'mod') {
            expect(s.textContent).toBe(`${port.label} mod`);
            expect(s.getAttribute('aria-label')).toContain('modulation input');
          }
        }
      });
      // The chain is drawn in signal order.
      const x = (id: string) => parseFloat(m.container.querySelector<HTMLElement>(`[data-module="${CSS.escape(id)}"]`)!.style.left);
      for (let i = 1; i < ids.length; i++) expect(x(ids[i])).toBeGreaterThan(x(ids[i - 1]));
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function checkLayout(root: HTMLElement, label: string) {
  expect(root.scrollWidth, `${label}: no sideways overflow`).toBeLessThanOrEqual(root.clientWidth + 1);
  const clipped = [...root.querySelectorAll<HTMLElement>('[class*="labelText"]')]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
    .map((el) => el.textContent);
  expect(clipped, `${label}: knob labels cut off`).toEqual([]);
  // Small knobs in one row keep their values on one line (labels of one or two lines take the same room).
  for (const row of root.querySelectorAll<HTMLElement>('[class*="knobRow"], [class*="modKnobs"]')) {
    const knobs = [...row.querySelectorAll<HTMLElement>('[data-size="sm"]')];
    const tops = new Set(knobs.map((k) => Math.round(k.getBoundingClientRect().top)));
    const values = knobs.map((k) => k.querySelector<HTMLElement>('[class*="value"]')!.getBoundingClientRect());
    const byTop = new Map<number, number[]>();
    knobs.forEach((k, i) => {
      const t = Math.round(k.getBoundingClientRect().top);
      byTop.set(t, [...(byTop.get(t) ?? []), Math.round(values[i].top)]);
    });
    for (const [, v] of byTop) expect(new Set(v).size, `${label}: values aligned in a row`).toBe(1);
    expect(tops.size).toBeGreaterThan(0);
  }
  if (!root.querySelector('#shape-col-effects')) return;
  for (const h3 of ['In this part’s chain', 'Channel', 'Shared effects', 'Movement (LFOs)']) {
    expect([...root.querySelectorAll('h3')].some((x) => x.textContent?.startsWith(h3)), `${label}: heading ${h3}`).toBe(true);
  }
}

describe('Advanced Shape layout', () => {
  it('1366 × 768, 1920 × 1080 and 960 × 540: full-word labels wrap cleanly, nothing overflows', async () => {
    for (const [w, hgt] of [
      [1366, 768],
      [1920, 1080],
      [960, 540],
    ] as const) {
      await page.viewport(w, hgt);
      await document.fonts.ready;
      const { m } = setup('t4', { width: w, height: w < 1024 ? 'auto' : hgt - 158, effects: ['eq', 'compressor', 'tape', 'widener'] });
      await actFrame();
      // A short window shows the columns as tabs: check each one.
      const tabs = [...m.container.querySelectorAll<HTMLElement>('[role="tab"]')];
      expect(tabs.length > 0, `${w} × ${hgt}: tabs`).toBe(hgt < 850 && w >= 1024);
      if (tabs.length) {
        for (const t of tabs) {
          act(() => t.click());
          await actFrame();
          checkLayout(m.container, `${w} ${t.textContent}`);
        }
      } else checkLayout(m.container, `${w}`);
      cleanup();
    }
  });

  it('opening the cable panel lays it over the columns, below the header and part strip, inside the view', async () => {
    const { m } = setup('t4', { height: 610 });
    const strip = m.container.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Part to shape"]')!.getBoundingClientRect();
    act(() => setCablesOpen(true));
    await actFrame();
    const split = m.container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize cable panel"]')!;
    const dock = m.container.querySelector<HTMLElement>('[aria-label="Cable panel"]')!.getBoundingClientRect();
    // Full height at first: from under the part strip to the bottom of the view.
    expect(dock.top).toBeGreaterThanOrEqual(strip.bottom);
    expect(dock.top).toBeLessThan(strip.bottom + 20);
    expect(dock.bottom).toBeLessThanOrEqual(m.container.getBoundingClientRect().bottom + 1);
    expect(Number(split.getAttribute('aria-valuenow'))).toBe(Number(split.getAttribute('aria-valuemax')));
  });
});
