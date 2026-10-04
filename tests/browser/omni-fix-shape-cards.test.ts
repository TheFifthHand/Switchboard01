/**
 * Shape fixes, in real Chromium with the app's theme, session and toasts:
 * - Every Simple effect card's knob changes the sound: the effect's main
 *   setting, or (when a big knob sets it) that big knob itself, and the card
 *   says so; a Filter card adds Resonance while the filter is closed.
 * - Switching to Advanced from Shape says so in a toast with "Back to Simple";
 *   the switch is named "Show every setting (Advanced)" / "Show fewer
 *   settings (Simple)".
 * - One set of words: "Big knobs" in Simple, "Macros (big knobs)" in
 *   Advanced, cards say "set by the Tone knob", and the delay module is
 *   "Echo" in the Add effect menu, the cards, the rack, the cables and Mix.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { KNOB_BURST_IDLE_MS, TipsProvider, ToastProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { ShapeView } from '../../src/app/views/shape/ShapeView';
import { MixView } from '../../src/app/views/mix/MixView';
import { setSendsRow } from '../../src/app/views/mix/mixPrefs';
import { ADVANCED_TOAST_TEXT } from '../../src/app/views/shape/shared';
import { STARTERS } from '../../src/content/starters';
import { createProject } from '../../src/project/factory';
import { MODULE_DEFS } from '../../src/project/modules';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { selectModule, selectTrack, setCablesOpen, setUiMode, setView, uiStore, type UiMode } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, key, mount, pointIn, pointer, wait } from './ui-harness';

const project = (): Project => session.store.getState();
const mod = (id: string) => project().patch.modules.find((m) => m.id === id)!;
const track = (id: string) => project().tracks.find((t) => t.id === id)!;
const click = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const endBurst = () => act(async () => wait(KNOB_BURST_IDLE_MS + 120));

function setup(opts: { trackId?: string; mode?: UiMode; project?: Project; view?: 'shape' | 'mix' } = {}) {
  act(() => {
    session.store.setLock(null);
    session.store.replace(opts.project ?? createProject({ name: 'Shape fixes', now: 1 }));
    selectTrack(opts.trackId ?? 't4');
    setCablesOpen(false);
    selectModule(null);
    setView(opts.view ?? 'shape');
    setUiMode(opts.mode ?? 'simple');
  });
  const m = mount(h(TipsProvider, { enabled: false }, h(ToastProvider, null, h(opts.view === 'mix' ? MixView : ShapeView))), { width: 1366 });
  m.container.style.padding = '0';
  m.container.style.height = '610px';
  return m;
}

function slider(root: Element, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`);
  if (!el) throw new Error(`No slider "${name}"`);
  return el;
}

function button(root: ParentNode, name: string | RegExp): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => {
    const label = x.getAttribute('aria-label') ?? x.textContent ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!b) throw new Error(`No button "${String(name)}"`);
  return b;
}

function drag(el: HTMLElement, dy: number) {
  const start = pointIn(el);
  pointer(el, 'pointerdown', start);
  for (let i = 1; i <= 5; i++) pointer(el, 'pointermove', { ...start, clientY: start.clientY - (dy * i) / 5 });
  pointer(el, 'pointerup', { ...start, clientY: start.clientY - dy });
}

const card = (root: Element, id: string) => root.querySelector<HTMLElement>(`#simple-card-${CSS.escape(id)}`)!;
const toast = () => [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((x) => x.textContent?.includes(ADVANCED_TOAST_TEXT)) ?? null;

beforeEach(async () => {
  // Tall enough for the three Advanced columns side by side (shorter windows show them as tabs: r4-shape-layout).
  await page.viewport(1366, 900);
  // Let a resize settle first: a resize closes an open menu (its button may have moved).
  await actFrame();
  await actFrame();
  runtimeStore.setState((s) => ({ ...s, notice: null }));
});

afterEach(() => {
  cleanup();
  session.store.setLock(null);
  act(() => setUiMode('simple'));
});

describe('Simple effect cards: the one knob always changes the sound', () => {
  it('default Drive: its Drive amount belongs to the Drive big knob, so the card carries that big knob, and dragging it turns the macro', async () => {
    const m = setup();
    const drive = card(m.container, 't4:drive');
    expect(drive.querySelectorAll('[role="slider"]')).toHaveLength(1);
    const knob = slider(drive, 'Drive');
    expect(knob.hasAttribute('aria-readonly')).toBe(false);
    expect(drive.textContent).toContain('Drive is set by the Drive big knob: the knob here turns it.');
    expect(drive.textContent).toContain('Turn Drive up for more grit.');
    const before = track('t4').macros.drive;
    drag(knob, 60);
    expect(track('t4').macros.drive).toBeGreaterThan(before);
    await endBurst();
    // Arrow keys too.
    const mid = track('t4').macros.drive;
    key(knob, 'keydown', { key: 'ArrowDown' });
    expect(track('t4').macros.drive).toBeLessThan(mid);
  });

  it('default Filter: Cutoff belongs to a big knob, so the card carries it; Resonance comes in once the filter closes below 12 kHz', async () => {
    const m = setup();
    const filter = () => card(m.container, 't4:filter');
    const by = [...filter().querySelectorAll('[role="slider"]')].map((x) => x.getAttribute('aria-label'));
    expect(by).toHaveLength(1);
    const knobName = by![0]!;
    expect(['Tone', 'Motion']).toContain(knobName);
    expect(filter().textContent).toContain(`Cutoff is set by the ${knobName} big knob: the knob here turns it.`);
    expect(filter().textContent).toContain('Resonance appears once the filter closes below 12 kHz.');
    // Close the filter with the card's own knob (Tone down / Motion up): Resonance appears, free to turn.
    key(slider(filter(), knobName), 'keydown', { key: knobName === 'Tone' ? 'Home' : 'End' });
    await endBurst();
    const res = slider(filter(), 'Resonance');
    expect(res.hasAttribute('aria-readonly')).toBe(false);
    const before = mod('t4:filter').params.resonance;
    key(res, 'keydown', { key: 'ArrowUp' });
    expect(mod('t4:filter').params.resonance).toBeGreaterThan(before);
  });

  it('every card of every part, in a new project and in every starter song, has a knob that is free to turn', () => {
    for (const p of [createProject({ name: 'New', now: 1 }), ...STARTERS.map((s) => s.build())]) {
      const m = setup({ project: p });
      for (const t of project().tracks) {
        act(() => selectTrack(t.id));
        const cards = [...m.container.querySelectorAll<HTMLElement>('article[id^="simple-card-"]')];
        expect(cards.length, `${p.name} ${t.name}`).toBeGreaterThan(0);
        for (const c of cards) {
          const knobs = [...c.querySelectorAll<HTMLElement>('[role="slider"]')];
          // The main knob, and a filter's Resonance while the filter is closed.
          expect(knobs.length, c.id).toBeGreaterThanOrEqual(1);
          expect(knobs.length, c.id).toBeLessThanOrEqual(2);
          for (const k of knobs) {
            expect(k.hasAttribute('aria-readonly'), `${p.name} ${c.id} ${k.getAttribute('aria-label')}`).toBe(false);
            expect(k.getAttribute('aria-disabled'), c.id).not.toBe('true');
          }
        }
      }
      cleanup();
    }
  });

  it('when big knobs set every main setting, the card shows that big knob, says so, and turning it turns the macro', async () => {
    const p = createProject({ name: 'All mapped', now: 1 });
    const t4 = p.tracks.find((t) => t.id === 't4')!;
    t4.macroMap.drive.push({ module: 't4:drive', param: 'tone', min: 2000, max: 16000, curve: 'exp' }, { module: 't4:drive', param: 'mix', min: 0.5, max: 1, curve: 'lin' });
    const m = setup({ project: p });
    const drive = card(m.container, 't4:drive');
    const knobs = [...drive.querySelectorAll<HTMLElement>('[role="slider"]')];
    expect(knobs).toHaveLength(1);
    expect(knobs[0].getAttribute('aria-label')).toBe('Drive');
    expect(knobs[0].hasAttribute('aria-readonly')).toBe(false);
    expect(drive.textContent).toContain('Drive is set by the Drive big knob: the knob here turns it.');
    const before = track('t4').macros.drive;
    const toneBefore = mod('t4:drive').params.tone;
    key(knobs[0], 'keydown', { key: 'PageUp' });
    expect(track('t4').macros.drive).toBeCloseTo(before + 0.1, 5);
    // The big knob in the Big knobs panel moved with it.
    expect(Number(slider(m.container.querySelector('[aria-label="Drive big knob"]')!, 'Drive').getAttribute('aria-valuenow'))).toBeCloseTo(before + 0.1, 5);
    // The stored setting is untouched; the macro moves it on the way to the sound.
    expect(mod('t4:drive').params.tone).toBe(toneBefore);
    await endBurst();
    act(() => session.undo());
    expect(track('t4').macros.drive).toBeCloseTo(before, 5);
  });
});

describe('Switching to Advanced from Shape says so', () => {
  it('“Show every setting (Advanced)” shows a toast with Back to Simple, which returns to Simple', async () => {
    const m = setup();
    click(button(m.container, 'Show every setting (Advanced)'));
    expect(uiStore.getState().uiMode).toBe('advanced');
    await actFrame();
    const t = toast()!;
    expect(t).not.toBeNull();
    expect(t.textContent).toContain('Now showing every setting (Advanced), in every view.');
    const back = button(t, 'Back to Simple');
    expect(back.getBoundingClientRect().height).toBeGreaterThanOrEqual(28);
    click(back);
    expect(uiStore.getState().uiMode).toBe('simple');
    await actFrame();
    await actFrame();
    expect(toast()).toBeNull();
    expect(document.activeElement?.id).toBe('shape-mode-toggle');
    expect(document.activeElement?.textContent).toBe('Show every setting (Advanced)');
  });

  it('a card’s “Every setting” says so too; going back with “Show fewer settings (Simple)” takes the toast away', async () => {
    const m = setup();
    click(button(card(m.container, 't4:filter'), 'Every setting of Filter (Advanced)'));
    expect(uiStore.getState().uiMode).toBe('advanced');
    expect(uiStore.getState().selectedModuleId).toBe('t4:filter');
    await actFrame();
    expect(toast()).not.toBeNull();
    click(button(m.container, 'Show fewer settings (Simple)'));
    expect(uiStore.getState().uiMode).toBe('simple');
    await actFrame();
    expect(toast()).toBeNull();
  });
});

describe('One set of words', () => {
  it('Simple says “Big knobs”; Advanced says “Macros (big knobs)”', async () => {
    const m = setup();
    const headings = () => [...m.container.querySelectorAll('h2')].map((x) => x.textContent);
    expect(headings()).toContain('Big knobs');
    expect(headings()).not.toContain('Macros');
    act(() => setUiMode('advanced'));
    await actFrame();
    expect(headings()).toContain('Macros (big knobs)');
    // The heading is not cut off in its column.
    const h2 = [...m.container.querySelectorAll<HTMLElement>('h2')].find((x) => x.textContent === 'Macros (big knobs)')!;
    expect(h2.scrollWidth).toBeLessThanOrEqual(h2.clientWidth + 1);
  });

  it('the effect count reads “2 effects (up to 8)” in Simple and Advanced', async () => {
    const m = setup();
    const effects = () => [...m.container.querySelectorAll('h2')].find((x) => x.textContent === 'Effects')!.closest('section')!;
    expect(effects().textContent).toContain('2 effects (up to 8)');
    act(() => void cmd.insertEffect(session.store, 't4', 'chorus'));
    expect(effects().textContent).toContain('3 effects (up to 8)');
    act(() => setUiMode('advanced'));
    await actFrame();
    expect(effects().textContent).toContain('3 effects (up to 8)');
  });

  it('the delay module is “Echo” everywhere: menu, card, rack, cables and Mix', async () => {
    expect(MODULE_DEFS.delay.label).toBe('Echo');
    const m = setup();
    click(button(m.container, 'Add effect'));
    await actFrame();
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Add effect"]')!;
    const item = menu.querySelector<HTMLElement>('[data-effect="delay"]')!;
    expect(item.getAttribute('aria-label')).toBe('Echo');
    expect(document.getElementById(item.getAttribute('aria-describedby')!)!.textContent).toBe('Echoes in time with the beat (a delay).');
    expect(menu.textContent).not.toMatch(/Delay/);
    click(item);
    const echo = card(m.container, 't4:delay');
    expect(echo.querySelector('h3')!.textContent).toBe('Echo');
    expect(runtimeStore.getState().notice?.text).toMatch(/^Added Echo\./);
    expect(m.container.querySelector('[aria-label="Signal flow"]')!.textContent).toContain('Echo');

    act(() => {
      setUiMode('advanced');
      setCablesOpen(true);
    });
    await actFrame();
    await actFrame();
    expect(m.container.querySelector('[aria-label="Shared Echo return"]')).not.toBeNull();
    expect(m.container.querySelector('[aria-label="Shared Delay return"]')).toBeNull();
    const cables = m.container.querySelector<HTMLElement>('[aria-label="Cable panel"]')!;
    expect(cables.querySelector('[aria-label^="Echo module"]')).not.toBeNull();
    expect([...cables.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')).filter((x) => /module/.test(x!))).toContain('Echo module, shared by all parts');
    expect(cables.textContent).not.toMatch(/Delay/);
    m.unmount();

    // Mix shows a strip's effects in its Advanced “Sends & effects” row (folded on short windows).
    act(() => setSendsRow(true));
    const mix = setup({ project: project(), mode: 'advanced', view: 'mix' });
    const strip = mix.container.querySelector<HTMLElement>('[data-testid="strip-t4"]')!;
    expect([...strip.querySelectorAll('li')].map((x) => x.textContent)).toContain('Echo');
    act(() => setSendsRow(null));
  });
});
