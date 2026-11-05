/**
 * Shape fixes, in real Chromium with the app's theme, session and toasts:
 * - Switching to Advanced from Shape says so in a toast with "Back to Simple";
 *   the switch is named "Show every setting (Advanced)" / "Show fewer
 *   settings (Simple)".
 * - One set of words: "Big knobs" in Simple, "Macros (big knobs)" in
 *   Advanced, and the delay module is "Echo" in the Add effect menu, the
 *   rack, the cables and Mix. (Simple shows no effect cards since r6: they
 *   are under "Show every setting".)
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TipsProvider, ToastProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { ShapeView } from '../../src/app/views/shape/ShapeView';
import { MixView } from '../../src/app/views/mix/MixView';
import { setSendsRow } from '../../src/app/views/mix/mixPrefs';
import { ADVANCED_TOAST_TEXT } from '../../src/app/views/shape/shared';
import { createProject } from '../../src/project/factory';
import { MODULE_DEFS } from '../../src/project/modules';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { selectModule, selectTrack, setCablesOpen, setUiMode, setView, uiStore, type UiMode } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, mount } from './ui-harness';

const project = (): Project => session.store.getState();
const click = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

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

function button(root: ParentNode, name: string | RegExp): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => {
    const label = x.getAttribute('aria-label') ?? x.textContent ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!b) throw new Error(`No button "${String(name)}"`);
  return b;
}

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

  it('the effect count reads “2 effects (up to 8)” in the Advanced rack (Simple shows no effects)', async () => {
    const m = setup({ mode: 'advanced' });
    await actFrame();
    const effects = () => [...m.container.querySelectorAll('h2')].find((x) => x.textContent === 'Effects')!.closest('section')!;
    expect(effects().textContent).toContain('2 effects (up to 8)');
    act(() => void cmd.insertEffect(session.store, 't4', 'chorus'));
    expect(effects().textContent).toContain('3 effects (up to 8)');
    act(() => setUiMode('simple'));
    await actFrame();
    expect([...m.container.querySelectorAll('h2')].some((x) => x.textContent === 'Effects')).toBe(false);
  });

  it('the delay module is “Echo” everywhere: menu, rack, cables and Mix', async () => {
    expect(MODULE_DEFS.delay.label).toBe('Echo');
    const m = setup({ mode: 'advanced' });
    await actFrame();
    click(button(m.container, 'Add effect'));
    await actFrame();
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Add effect"]')!;
    const item = menu.querySelector<HTMLElement>('[data-effect="delay"]')!;
    expect(item.getAttribute('aria-label')).toBe('Echo');
    expect(document.getElementById(item.getAttribute('aria-describedby')!)!.textContent).toBe('Echoes in time with the beat (a delay).');
    expect(menu.textContent).not.toMatch(/Delay/);
    click(item);
    await actFrame();
    const echo = m.container.querySelector<HTMLElement>(`#rack-card-${CSS.escape('t4:delay')}`)!;
    expect(echo.textContent).toContain('Echo');
    expect(echo.textContent).not.toMatch(/Delay/);
    expect(runtimeStore.getState().notice?.text).toMatch(/^Added Echo\./);
    expect(m.container.querySelector('[aria-label="Signal flow"]')!.textContent).toContain('Echo');

    act(() => setCablesOpen(true));
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
