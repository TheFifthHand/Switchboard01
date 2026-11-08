/**
 * Shape, Simple mode (the default) in real Chromium: what a first-time user
 * sees and does — the part being shaped and the way back to Play, six big
 * knobs (macros), the instrument card, and nothing else: the part's effects
 * (with the grouped Add effect menu) are under Show every setting (Advanced),
 * so each control is shown once — checked on the real project through the
 * real session, plus the layout at laptop, desktop and 200 % sizes.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { KNOB_BURST_IDLE_MS, TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { INSTRUMENT_LABEL, soundName } from '../../src/app/labels';
import { runtimeStore } from '../../src/app/runtime';
import { ShapeView } from '../../src/app/views/shape/ShapeView';
import { EFFECT_GROUPS, menuGroups, ungroupedEffects } from '../../src/app/views/shape/effectCatalog';
import { setAdvancedTab } from '../../src/app/views/shape/shapeLayout';
import { createProject } from '../../src/project/factory';
import { trackChain } from '../../src/project/graph';
import { INSERTABLE_EFFECTS } from '../../src/project/modules';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { defaultUiState, selectModule, selectTrack, setCablesOpen, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, key, mount, wait } from './ui-harness';

const project = (): Project => session.store.getState();
const track = (id: string) => project().tracks.find((t) => t.id === id)!;

/** The app's workspace below the 58 px transport and above the 100 px keyboard row. */
const MAIN_HEIGHT = (viewportHeight: number) => viewportHeight - 158;

function setup(trackId = 't4', opts: { width?: number; height?: number | 'auto' } = {}) {
  act(() => {
    session.store.setLock(null);
    session.store.replace(createProject({ name: 'Simple shape test', now: 1 }));
    selectTrack(trackId);
    setCablesOpen(false);
    selectModule(null);
    setView('shape');
    setUiMode('simple');
  });
  const m = mount(h(TipsProvider, { enabled: false }, h(ShapeView)), { width: opts.width ?? 1366 });
  m.container.style.padding = '0';
  m.container.style.height = opts.height === 'auto' ? 'auto' : `${opts.height ?? MAIN_HEIGHT(768)}px`;
  return m;
}

function slider(root: Element, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`);
  if (!el) throw new Error(`No slider "${name}"`);
  return el;
}

function button(root: Element, name: string | RegExp): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => {
    const label = x.getAttribute('aria-label') ?? x.textContent ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!b) throw new Error(`No button "${String(name)}"`);
  return b;
}

/** The Simple instrument card (a section headed "Instrument · <type>"). */
function instCard(root: Element): HTMLElement {
  const s = [...root.querySelectorAll<HTMLElement>('section')].find((x) => x.querySelector('h2')?.textContent?.startsWith('Instrument'));
  if (!s) throw new Error('No instrument card');
  return s;
}

const click = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true }));
const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Add effect"]');
const endBurst = () => act(async () => wait(KNOB_BURST_IDLE_MS + 120));

beforeEach(async () => {
  await page.viewport(1366, 768);
  window.scrollTo(0, 0);
  runtimeStore.setState((s) => ({ ...s, notice: null }));
});

afterEach(() => {
  cleanup();
  session.store.setLock(null);
  vi.restoreAllMocks();
});

describe('Simple Shape: orientation', () => {
  it('Simple is what a new user sees, and it says which part is being shaped', () => {
    expect(defaultUiState().uiMode).toBe('simple');
    const m = setup('t4');
    const heading = m.container.querySelector('h2')!;
    expect(heading.textContent).toBe(`Shaping: 4 Keys & chords — ${soundName(project(), track('t4').instrument)}`);
    // Advanced-only detail stays out of the way: no mapping editor, no cable dock.
    expect(m.container.textContent).not.toContain('Reset mappings');
    expect(m.container.querySelector('[aria-label="Cable panel"]')).toBeNull();
    // The part strip stays, and choosing another part changes what is shaped.
    click(m.container.querySelector<HTMLElement>('#shape-part-t3')!);
    expect(m.container.querySelector('h2')!.textContent).toBe(`Shaping: 3 Bass — ${soundName(project(), track('t3').instrument)}`);
  });

  it('Back to Play (Advanced: Simple shows this view as a sheet, with its own way back) goes to the Play view with the part still selected', () => {
    const m = setup('t5');
    expect([...m.container.querySelectorAll('button')].some((b) => b.textContent === 'Back to Play')).toBe(false);
    act(() => setUiMode('advanced'));
    click(button(m.container, 'Back to Play'));
    expect(uiStore.getState().view).toBe('play');
    expect(uiStore.getState().selectedTrackId).toBe('t5');
  });

  it('Show every setting (Advanced) switches to Advanced and back, keeping keyboard focus on the button', async () => {
    const m = setup('t4');
    const toggle = button(m.container, 'Show every setting (Advanced)');
    toggle.focus();
    click(toggle);
    expect(uiStore.getState().uiMode).toBe('advanced');
    await actFrame();
    // Every control is back: mapping editor, instrument panel, rack with shared effects, cable dock
    // (a 768 px window shows the three columns as tabs, the instrument first).
    expect(m.container.querySelector('#shape-col-instrument')).not.toBeNull();
    expect(m.container.querySelector('[aria-label="Cable panel"]')).not.toBeNull();
    const tab = (name: string) => [...m.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
    click(tab('Macros'));
    await actFrame();
    expect(m.container.textContent).toContain('Reset mappings');
    click(tab('Effects'));
    await actFrame();
    expect(m.container.querySelector('[aria-label="Shared Reverb return"]')).not.toBeNull();
    const back = button(m.container, 'Show fewer settings (Simple)');
    expect(document.activeElement).toBe(back);
    click(back);
    expect(uiStore.getState().uiMode).toBe('simple');
  });
});

describe('Simple Shape: macros and instrument', () => {
  it('shows the six macros large under “Big knobs”, with a one-line caption; turning one is one undo step', async () => {
    const m = setup('t4');
    expect([...m.container.querySelectorAll('h2')].map((x) => x.textContent)).toContain('Big knobs');
    expect(m.container.textContent).not.toMatch(/Macros/);
    const macros = [...m.container.querySelectorAll<HTMLElement>('[role="slider"][id^="shape-macro-"]')];
    expect(macros.map((x) => x.getAttribute('aria-label'))).toEqual(['Tone', 'Space', 'Echo', 'Motion', 'Drive', 'Pump']);
    // Large or larger: the big knobs have the view's width now that the effects are in Advanced.
    for (const k of macros) expect(['lg', 'xl']).toContain(k.closest('[data-size]')!.getAttribute('data-size'));
    const tone = m.container.querySelector<HTMLElement>('[aria-label="Tone big knob"]')!;
    expect(tone.textContent).toContain('Dark ↔ bright');
    expect(m.container.querySelector('[aria-label="Pump big knob"]')!.textContent).toContain('Dips with the beat');

    const before = track('t4').macros.tone;
    key(slider(tone, 'Tone'), 'keydown', { key: 'PageUp' });
    key(slider(tone, 'Tone'), 'keydown', { key: 'PageUp' });
    expect(track('t4').macros.tone).toBeCloseTo(before + 0.2, 5);
    await endBurst();
    act(() => session.undo());
    expect(track('t4').macros.tone).toBeCloseTo(before, 5);
  });

  it('a macro with nothing to move is shown as such and cannot be turned', () => {
    const m = setup('t4');
    act(() => {
      for (let i = track('t4').macroMap.echo.length - 1; i >= 0; i--) cmd.removeMacroTarget(session.store, 't4', 'echo', i);
    });
    const echo = m.container.querySelector<HTMLElement>('[aria-label="Echo big knob"]')!;
    expect(echo.textContent).toContain('Moves nothing here');
    expect(slider(echo, 'Echo').getAttribute('aria-disabled')).toBe('true');
  });

  it('the instrument card names the type and sound, and Change instrument opens the sound browser', () => {
    const m = setup('t3');
    const inst = instCard(m.container);
    expect(inst.textContent).toContain(INSTRUMENT_LABEL.bass);
    expect(inst.textContent).toContain(soundName(project(), track('t3').instrument));
    const change = button(inst, 'Change instrument');
    expect(change.getAttribute('aria-haspopup')).toBe('dialog');
    click(change);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // A new sound shows on the card at once.
    act(() => void session.accepted(cmd.changeInstrumentSound(session.store, 't3', 'drums', 'bright-steel')));
    expect(inst.textContent).toContain(INSTRUMENT_LABEL.drums);
    expect(inst.textContent).toContain(soundName(project(), track('t3').instrument));
  });

  it('a sampler part offers Record audio right on the card (no need for Advanced); other parts do not', () => {
    const m = setup('t8');
    expect(track('t8').instrument.kind).toBe('sampler');
    expect(instCard(m.container).textContent).toContain('Record audio');
    m.unmount();
    const other = setup('t3');
    expect(instCard(other.container).textContent).not.toContain('Record audio');
  });
});

describe('Simple Shape: the effects are under Show every setting', () => {
  it('Simple shows no effect cards, chain or Add effect; Show every setting (Advanced) lists the part’s effects in the rack', async () => {
    const m = setup('t4');
    expect(m.container.querySelectorAll('[id^="simple-card-"]')).toHaveLength(0);
    expect(m.container.querySelector('#shape-add-effect')).toBeNull();
    expect(m.container.textContent).not.toMatch(/Instrument → |is set by the .* big knob/);
    click(button(m.container, 'Show every setting (Advanced)'));
    expect(uiStore.getState().uiMode).toBe('advanced');
    act(() => setAdvancedTab('effects'));
    await actFrame();
    for (const id of trackChain(project().patch, 't4')!.slice(1, -1)) expect(m.container.querySelector(`#rack-card-${CSS.escape(id)}`), id).not.toBeNull();
    expect(m.container.querySelector('#shape-add-effect')).not.toBeNull();
    act(() => setUiMode('simple'));
  });

  it('the Add effect menu (Advanced) groups every effect by purpose, with a description each, and works from the keyboard', async () => {
    const m = setup('t4');
    act(() => {
      setAdvancedTab('effects');
      setUiMode('advanced');
    });
    await actFrame();
    const add = button(m.container, 'Add effect');
    add.focus();
    key(add, 'keydown', { key: 'ArrowDown' });
    await actFrame();
    const list = menu()!;
    expect(list).not.toBeNull();
    expect(add.getAttribute('aria-expanded')).toBe('true');
    const groups = [...list.querySelectorAll<HTMLElement>('[role="group"]')];
    const groupName = (g: HTMLElement) => document.getElementById(g.getAttribute('aria-labelledby')!)!.textContent;
    expect(groups.map(groupName)).toEqual(['Tone', 'Dynamics', 'Space', 'Movement', 'Colour', 'Stereo']);
    const items = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((x) => x.getAttribute('aria-label'));
    expect(groups.map(items)).toEqual([
      ['EQ', 'Filter'],
      ['Compressor', 'Gate'],
      ['Reverb', 'Echo'],
      ['Chorus', 'Phaser', 'Flanger', 'Auto Pan'],
      ['Drive', 'Tape', 'Bit Crusher'],
      ['Stereo Width'],
    ]);
    // Each item says what it does.
    for (const item of list.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
      const desc = document.getElementById(item.getAttribute('aria-describedby')!)!.textContent ?? '';
      expect(desc.length).toBeGreaterThan(12);
    }
    // Keyboard: the first item has focus; Down moves on, Right jumps to the next group, Escape returns to the button.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('EQ');
    key(document.activeElement!, 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter');
    key(document.activeElement!, 'keydown', { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Compressor');
    key(document.activeElement!, 'keydown', { key: 'End' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Stereo Width');
    key(document.activeElement!, 'keydown', { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(add);
    // Choosing with the keyboard adds the effect.
    key(add, 'keydown', { key: 'ArrowDown' });
    await actFrame();
    key(document.activeElement!, 'keydown', { key: 'End' });
    click(document.activeElement as HTMLElement);
    expect(trackChain(project().patch, 't4')!.at(-2)).toBe('t4:widener');
    act(() => setUiMode('simple'));
  });

  it('every insertable effect is in exactly one group of the Add effect menu', () => {
    expect(ungroupedEffects()).toEqual([]);
    const listed = EFFECT_GROUPS.flatMap((g) => g.types);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...INSERTABLE_EFFECTS].sort());
    expect(menuGroups().map((g) => g.label)).toEqual(['Tone', 'Dynamics', 'Space', 'Movement', 'Colour', 'Stereo']);
  });
});

function checkLayout(root: HTMLElement, label: string) {
  expect(root.scrollWidth, `${label}: no sideways overflow`).toBeLessThanOrEqual(root.clientWidth + 1);
  const clipped = (sel: string) =>
    [...root.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => el.offsetParent !== null)
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.textContent);
  expect(clipped('[class*="labelText"]'), `${label}: knob labels`).toEqual([]);
  expect(clipped('article h3'), `${label}: effect names`).toEqual([]);
  expect(clipped('[class*="macroCaption"]'), `${label}: macro captions`).toEqual([]);
  expect(clipped('[class*="instSound"]'), `${label}: sound name`).toEqual([]);
  expect(clipped('[class*="partName"]'), `${label}: part names`).toEqual([]);
  // Every clickable thing is at least 32 px; the primary ones at least 40 px tall.
  for (const b of root.querySelectorAll<HTMLElement>('button, [role="slider"]')) {
    if (b.offsetParent === null) continue;
    const r = b.getBoundingClientRect();
    expect(Math.min(r.width, r.height), `${label}: ${b.getAttribute('aria-label') ?? b.textContent} size`).toBeGreaterThanOrEqual(32);
  }
  // (No "Back to Play" in Simple: the view is a sheet there, with "Back to my song" in its bar.)
  const primary = [button(root, /Show every setting \(Advanced\)|Show fewer settings \(Simple\)/), button(root, 'Change instrument')];
  for (const b of primary) expect(b.getBoundingClientRect().height, `${label}: ${b.textContent} height`).toBeGreaterThanOrEqual(40);
  // Cards never overlap.
  const rects = [...root.querySelectorAll<HTMLElement>('article')].map((a) => a.getBoundingClientRect());
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      expect(overlap, `${label}: cards ${i} and ${j} overlap`).toBe(false);
    }
}

describe('Simple Shape layout', () => {
  it('fits a 1366 × 768 laptop: the instrument and the six big knobs in view, nothing clipped', async () => {
    await document.fonts.ready;
    const m = setup('t4');
    await actFrame();
    checkLayout(m.container, '1366');
    const bottom = m.container.getBoundingClientRect().bottom;
    for (const k of m.container.querySelectorAll<HTMLElement>('[id^="shape-macro-"]')) expect(k.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
    // The big knobs have the view's width (no column of effect cards beside them).
    const panel = [...m.container.querySelectorAll('h2')].find((x) => x.textContent === 'Big knobs')!.closest('section')!.getBoundingClientRect();
    expect(panel.width).toBeGreaterThan(1366 * 0.9);
  });

  it('fits 1920 × 1080', async () => {
    await page.viewport(1920, 1080);
    await document.fonts.ready;
    const m = setup('t4', { width: 1920, height: MAIN_HEIGHT(1080) });
    await actFrame();
    checkLayout(m.container, '1920');
    const bottom = m.container.getBoundingClientRect().bottom;
    for (const k of m.container.querySelectorAll<HTMLElement>('[id^="shape-macro-"]')) expect(k.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
  });

  it('at 960 × 540 (200 % zoom) the instrument sits over the big knobs and nothing is cut off', async () => {
    await page.viewport(960, 540);
    await document.fonts.ready;
    const m = setup('t4', { width: 960, height: 'auto' });
    await actFrame();
    checkLayout(m.container, '960');
    const inst = instCard(m.container).getBoundingClientRect();
    const knobs = [...m.container.querySelectorAll('h2')].find((x) => x.textContent === 'Big knobs')!.closest('section')!.getBoundingClientRect();
    expect(knobs.top).toBeGreaterThan(inst.bottom);
    expect(Math.abs(knobs.left - inst.left)).toBeLessThan(2);
  });
});
