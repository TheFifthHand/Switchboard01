/**
 * Shape, Simple mode (the default) in real Chromium: what a first-time user
 * sees and does — the part being shaped and the way back to Play, six large
 * macros, the instrument card, effects as cards with one main knob each, the
 * grouped Add effect menu, Show every setting — checked on the real project
 * through the real session, plus the layout at laptop, desktop and 200 % sizes.
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
import { EFFECT_GROUPS, EFFECT_INFO, effectSentence, mainParamSpec, menuGroups, ungroupedEffects } from '../../src/app/views/shape/effectCatalog';
import { createProject } from '../../src/project/factory';
import { trackChain } from '../../src/project/graph';
import { INSERTABLE_EFFECTS, MODULE_DEFS } from '../../src/project/modules';
import { MODULE_PARAMS, specById } from '../../src/project/params';
import type { ModuleType, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { defaultUiState, selectModule, selectTrack, setCablesOpen, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, key, mount, wait } from './ui-harness';

const project = (): Project => session.store.getState();
const track = (id: string) => project().tracks.find((t) => t.id === id)!;
const mod = (id: string) => project().patch.modules.find((m) => m.id === id);

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

function switchOf(root: Element): HTMLButtonElement {
  const s = root.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!s) throw new Error('No switch');
  return s;
}

/** The Simple instrument card (a section headed "Instrument · <type>"). */
function instCard(root: Element): HTMLElement {
  const s = [...root.querySelectorAll<HTMLElement>('section')].find((x) => x.querySelector('h2')?.textContent?.startsWith('Instrument'));
  if (!s) throw new Error('No instrument card');
  return s;
}

const click = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true }));
const card = (root: Element, id: string) => root.querySelector<HTMLElement>(`#simple-card-${CSS.escape(id)}`);
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
    expect(heading.textContent).toBe(`Shaping: 4 Chords — ${soundName(project(), track('t4').instrument)}`);
    // Advanced-only detail stays out of the way: no mapping editor, no cable dock.
    expect(m.container.textContent).not.toContain('Reset mappings');
    expect(m.container.querySelector('[aria-label="Cable panel"]')).toBeNull();
    // The part strip stays, and choosing another part changes what is shaped.
    click(m.container.querySelector<HTMLElement>('#shape-part-t3')!);
    expect(m.container.querySelector('h2')!.textContent).toBe(`Shaping: 3 Bass — ${soundName(project(), track('t3').instrument)}`);
  });

  it('Back to Play goes to the Play view with the part still selected', () => {
    const m = setup('t5');
    click(button(m.container, 'Back to Play'));
    expect(uiStore.getState().view).toBe('play');
    expect(uiStore.getState().selectedTrackId).toBe('t5');
  });

  it('Show every setting switches to Advanced and back, keeping keyboard focus on the button', async () => {
    const m = setup('t4');
    const toggle = button(m.container, 'Show every setting');
    toggle.focus();
    click(toggle);
    expect(uiStore.getState().uiMode).toBe('advanced');
    await actFrame();
    // Every control is back: mapping editor, instrument panel, rack with shared effects, cable dock.
    expect(m.container.textContent).toContain('Reset mappings');
    expect(m.container.querySelector('[aria-label="Shared Reverb return"]')).not.toBeNull();
    expect(m.container.querySelector('[aria-label="Cable panel"]')).not.toBeNull();
    const back = button(m.container, 'Show fewer settings');
    expect(document.activeElement).toBe(back);
    click(back);
    expect(uiStore.getState().uiMode).toBe('simple');
  });
});

describe('Simple Shape: macros and instrument', () => {
  it('shows the six macros large with a one-line caption; turning one is one undo step', async () => {
    const m = setup('t4');
    const macros = [...m.container.querySelectorAll<HTMLElement>('[role="slider"][id^="shape-macro-"]')];
    expect(macros.map((x) => x.getAttribute('aria-label'))).toEqual(['Tone', 'Space', 'Echo', 'Motion', 'Drive', 'Pump']);
    for (const k of macros) expect(k.closest('[data-size]')!.getAttribute('data-size')).toBe('lg');
    const tone = m.container.querySelector<HTMLElement>('[aria-label="Tone macro"]')!;
    expect(tone.textContent).toContain('Darker ↔ brighter');
    expect(m.container.querySelector('[aria-label="Pump macro"]')!.textContent).toContain('Ducks with the beat');

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
    const echo = m.container.querySelector<HTMLElement>('[aria-label="Echo macro"]')!;
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
});

describe('Simple Shape: effects', () => {
  it('lists the part’s effects as cards in signal order, each with one main knob and a plain sentence', () => {
    const m = setup('t4');
    expect(trackChain(project().patch, 't4')).toEqual(['t4:inst', 't4:drive', 't4:filter', 't4:ch']);
    const list = m.container.querySelector<HTMLElement>('[role="list"][aria-label="Effects in signal order"]')!;
    const cards = [...list.querySelectorAll<HTMLElement>('article')];
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Drive, effect 1 of 2', 'Filter, effect 2 of 2']);
    for (const c of cards) expect(c.querySelectorAll('[role="slider"]')).toHaveLength(1);
    expect(cards[0].textContent).toContain(effectSentence('drive'));
    // The default Drive and Filter knobs belong to macros: read-only, and the card says which macro sets them.
    const drive = slider(cards[0], 'Drive');
    expect(drive.getAttribute('aria-readonly')).toBe('true');
    expect(cards[0].textContent).toContain('Drive is set by the Drive macro.');
    expect(cards[1].textContent).toContain('Cutoff is set by the Tone macro.');
    // The signal flow reads left to right.
    expect(m.container.querySelector('[aria-label="Signal flow"]')!.textContent).toMatch(/Instrument→Drive→Filter→Channel→Master/);
  });

  it('adds, switches off, turns and removes an effect: each is one undo step and says what happened', async () => {
    const m = setup('t4');
    click(button(m.container, 'Add effect'));
    click(button(menu()!, 'Chorus'));
    expect(menu()).toBeNull();
    expect(trackChain(project().patch, 't4')).toEqual(['t4:inst', 't4:drive', 't4:filter', 't4:chorus', 't4:ch']);
    expect(runtimeStore.getState().notice).toMatchObject({ text: expect.stringContaining('Added Chorus'), action: 'undo' });
    const chorus = card(m.container, 't4:chorus')!;
    expect(chorus.getAttribute('aria-label')).toBe('Chorus, effect 3 of 3');

    // Its one knob is the Mix, and it sets the real module parameter.
    const mix = slider(chorus, 'Mix');
    const before = mod('t4:chorus')!.params.mix;
    key(mix, 'keydown', { key: 'PageUp' });
    expect(mod('t4:chorus')!.params.mix).toBeCloseTo(before + 0.1, 5);
    await endBurst();

    click(switchOf(chorus));
    expect(mod('t4:chorus')!.bypass).toBe(true);
    expect(chorus.getAttribute('aria-label')).toBe('Chorus, effect 3 of 3, off');
    expect(m.container.querySelector('[aria-label="Signal flow"]')!.textContent).toMatch(/Chorus off/i);

    click(button(chorus, 'Remove Chorus'));
    expect(mod('t4:chorus')).toBeUndefined();
    expect(trackChain(project().patch, 't4')).toEqual(['t4:inst', 't4:drive', 't4:filter', 't4:ch']);
    expect(runtimeStore.getState().notice?.text).toBe('Removed Chorus. The sound now flows straight past it.');
    await actFrame();
    // Focus lands on the remaining card next to it, not on the page.
    expect(document.activeElement?.id).toBe('simple-t4:filter-onoff');

    act(() => session.undo()); // remove
    expect(mod('t4:chorus')).toBeDefined();
    act(() => session.undo()); // bypass
    expect(mod('t4:chorus')!.bypass).toBe(false);
    act(() => session.undo()); // mix
    expect(mod('t4:chorus')!.params.mix).toBeCloseTo(before, 5);
    act(() => session.undo()); // add
    expect(mod('t4:chorus')).toBeUndefined();
  });

  it('the Add effect menu groups every effect by purpose, with a description each, and works from the keyboard', async () => {
    const m = setup('t4');
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
      ['Reverb', 'Delay'],
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
  });

  it('every insertable effect is in exactly one group, and its sentence names its main knob', () => {
    expect(ungroupedEffects()).toEqual([]);
    const listed = EFFECT_GROUPS.flatMap((g) => g.types);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...INSERTABLE_EFFECTS].sort());
    expect(menuGroups().map((g) => g.label)).toEqual(['Tone', 'Dynamics', 'Space', 'Movement', 'Colour', 'Stereo']);
    for (const type of INSERTABLE_EFFECTS) {
      const spec = mainParamSpec(type)!;
      expect(specById(MODULE_PARAMS[type], EFFECT_INFO[type]!.main)).toBe(spec);
      expect(effectSentence(type)).toContain(spec.label);
    }
  });

  it('each effect type’s main knob changes that effect’s own setting', () => {
    const types = INSERTABLE_EFFECTS;
    for (let start = 0; start < types.length; start += 4) {
      const batch = types.slice(start, start + 4);
      const m = setup('t4');
      const ids: string[] = [];
      act(() => {
        for (const t of batch) ids.push(cmd.insertEffect(session.store, 't4', t).moduleId!);
      });
      batch.forEach((type: ModuleType, i) => {
        const c = card(m.container, ids[i])!;
        expect(c, `${type} card`).not.toBeNull();
        const spec = mainParamSpec(type)!;
        const knob = slider(c, spec.label);
        expect(knob.hasAttribute('aria-readonly'), `${type} main knob is free`).toBe(false);
        const before = mod(ids[i])!.params[spec.id];
        const keyName = before >= spec.max ? 'Home' : 'End';
        key(knob, 'keydown', { key: keyName });
        expect(mod(ids[i])!.params[spec.id], `${MODULE_DEFS[type].label} ${spec.label}`).toBe(keyName === 'End' ? spec.max : spec.min);
      });
      cleanup();
    }
  });

  it('All settings opens that effect in the Advanced view, selected and in view', async () => {
    const m = setup('t4');
    let chorus = '';
    act(() => {
      chorus = cmd.insertEffect(session.store, 't4', 'chorus').moduleId!;
    });
    click(button(card(m.container, chorus)!, 'All settings of Chorus'));
    expect(uiStore.getState().uiMode).toBe('advanced');
    expect(uiStore.getState().selectedModuleId).toBe(chorus);
    await actFrame();
    await actFrame();
    await actFrame();
    const rackCard = m.container.querySelector<HTMLElement>(`#rack-card-${CSS.escape(chorus)}`)!;
    expect(rackCard.hasAttribute('data-selected')).toBe(true);
    // Every Chorus setting is there.
    for (const spec of MODULE_PARAMS.chorus) expect(slider(rackCard, spec.label)).toBeTruthy();
    expect(document.activeElement?.id).toBe(`rack-${chorus}-name`);
  });

  it('says when the part is full, and Add effect is unavailable', () => {
    const m = setup('t4');
    act(() => {
      for (let i = 0; i < 4; i++) cmd.insertEffect(session.store, 't4', 'phaser');
    });
    expect(button(m.container, 'Add effect').disabled).toBe(true);
    expect(m.container.textContent).toContain('This part already has 6 effects, the most it can hold. Remove one to add another.');
  });

  it('while a performance records, routing edits are locked and say so; the knobs keep working', () => {
    const m = setup('t4');
    let chorus = '';
    act(() => {
      chorus = cmd.insertEffect(session.store, 't4', 'chorus').moduleId!;
      session.store.setLock('Recording a performance: routing is locked until the take ends.');
    });
    expect(m.container.textContent).toContain('Effects are locked while a performance records.');
    expect(button(m.container, 'Add effect').disabled).toBe(true);
    const c = card(m.container, chorus)!;
    expect(switchOf(c).disabled).toBe(true);
    expect(button(c, 'Remove Chorus').disabled).toBe(true);
    const before = mod(chorus)!.params.mix;
    key(slider(c, 'Mix'), 'keydown', { key: 'PageUp' });
    expect(mod(chorus)!.params.mix).toBeGreaterThan(before);
    key(slider(m.container, 'Tone'), 'keydown', { key: 'PageUp' });
    expect(track('t4').macros.tone).toBeGreaterThan(0.5);
  });

  it('custom routing: says so, lists the effects without order numbers, and Add effect points to Advanced', () => {
    const m = setup('t3');
    act(() => {
      expect(cmd.connect(session.store, { module: 't3:inst', port: 'out' }, { module: 't3:ch', port: 'in' }).ok).toBe(true);
    });
    expect(m.container.textContent).toContain('This part has custom cable routing.');
    expect(button(m.container, 'Add effect').disabled).toBe(true);
    expect(card(m.container, 't3:drive')!.getAttribute('aria-label')).toBe('Drive');
  });

  it('a part with no path to the output says so, and Restore Connection plugs it back in', () => {
    const m = setup('t3');
    const link = project().patch.connections.find((c) => c.from.module === 't3:ch' && c.to.module === 'master')!;
    act(() => void cmd.disconnect(session.store, link.id));
    const warning = [...m.container.querySelectorAll<HTMLElement>('[role="alert"]')].find((x) => x.textContent?.includes('This part has no path to the output.'))!;
    expect(warning).toBeTruthy();
    click(button(warning, 'Restore Connection'));
    expect(project().patch.connections.some((c) => c.from.module === 't3:ch' && c.to.module === 'master')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/** Nothing clipped, nothing overflowing sideways, targets big enough. */
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
  const primary = [button(root, 'Back to Play'), button(root, /Show every setting|Show fewer settings/), button(root, 'Change instrument'), button(root, 'Add effect'), ...root.querySelectorAll<HTMLElement>('article [role="switch"]')];
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
  const fill = () =>
    act(() => {
      for (const t of ['compressor', 'widener', 'tape', 'crusher'] as const) cmd.insertEffect(session.store, 't4', t);
    });

  it('fits a 1366 × 768 laptop: the essentials in view, nothing clipped', async () => {
    await document.fonts.ready;
    const m = setup('t4');
    fill();
    await actFrame();
    checkLayout(m.container, '1366');
    // The view fits the workspace: macros, instrument and the first effects are visible without scrolling the page.
    const bottom = m.container.getBoundingClientRect().bottom;
    for (const k of m.container.querySelectorAll<HTMLElement>('[id^="shape-macro-"]')) expect(k.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
    expect(m.container.querySelector('#simple-card-t4\\:drive')!.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
  });

  it('fits 1920 × 1080', async () => {
    await page.viewport(1920, 1080);
    await document.fonts.ready;
    const m = setup('t4', { width: 1920, height: MAIN_HEIGHT(1080) });
    fill();
    await actFrame();
    checkLayout(m.container, '1920');
    // Six effects fit without scrolling at this size.
    const scroller = m.container.querySelector<HTMLElement>('[class*="fxBody"]')!;
    expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight + 1);
  });

  it('at 960 × 540 (200 % zoom) everything stacks in one column and nothing is cut off', async () => {
    await page.viewport(960, 540);
    await document.fonts.ready;
    const m = setup('t4', { width: 960, height: 'auto' });
    fill();
    await actFrame();
    checkLayout(m.container, '960');
    const inst = instCard(m.container).getBoundingClientRect();
    const fx = [...m.container.querySelectorAll('h2')].find((x) => x.textContent === 'Effects')!.closest('section')!.getBoundingClientRect();
    expect(fx.top).toBeGreaterThan(inst.bottom);
    expect(Math.abs(fx.left - inst.left)).toBeLessThan(2);
  });

  it('the Add effect menu stays inside the window at every size', async () => {
    for (const [w, hgt] of [
      [1366, 768],
      [1920, 1080],
      [960, 540],
    ] as const) {
      await page.viewport(w, hgt);
      // Let the resize settle first: a resize closes an open menu (its button may have moved).
      await actFrame();
      await actFrame();
      const m = setup('t4', { width: w, height: w < 1024 ? 'auto' : MAIN_HEIGHT(hgt) });
      click(button(m.container, 'Add effect'));
      await actFrame();
      expect(menu(), `${w}: menu open`).not.toBeNull();
      const r = menu()!.getBoundingClientRect();
      expect(r.left, `${w} left`).toBeGreaterThanOrEqual(0);
      expect(r.right, `${w} right`).toBeLessThanOrEqual(w);
      expect(r.top, `${w} top`).toBeGreaterThanOrEqual(0);
      expect(r.bottom, `${w} bottom`).toBeLessThanOrEqual(hgt);
      // Every item can be reached (the menu scrolls inside itself when the window is short).
      const items = menu()!.querySelectorAll('[role="menuitem"]');
      expect(items).toHaveLength(14);
      key(document.activeElement!, 'keydown', { key: 'Escape' });
      cleanup();
    }
  });
});
