/**
 * Cable panel behaviour in real Chromium: patching with pointer drags,
 * click-then-click, the keyboard connection picker, moving and unplugging
 * cables, refusals, undo, the no-path warning with Restore Connection, the
 * restore confirmation and the performance-take lock. Every check reads the
 * real project through session.store.
 */
import { Profiler, act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { session } from '../../src/app/instance';
import { CablePanel, CablesDrawer } from '../../src/app/views/cables';
import { lfoDepth } from '../../src/app/views/cables/model';
import { createProject } from '../../src/project/factory';
import type { Connection } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setCablesOpen, uiStore } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, key, mount, nextFrame, pointer, pointIn } from './ui-harness';

type Pt = { clientX: number; clientY: number };

const k = (dir: 'in' | 'out', module: string, port: string) => `${dir}|${module}|${port}`;
const conns = (): Connection[] => session.store.getState().patch.connections;
const find = (from: string, fromPort: string, to: string, toPort: string) =>
  conns().find((c) => c.from.module === from && c.from.port === fromPort && c.to.module === to && c.to.port === toPort);

function setup(trackId = 't3') {
  const m = mount(h(CablePanel, { trackId, height: 340 }), { width: 1500 });
  const root = m.container;
  const sock = (key: string) => {
    const el = root.querySelector<HTMLButtonElement>(`button[data-socket-key="${CSS.escape(key)}"]`);
    if (!el) throw new Error(`No socket ${key}`);
    return el;
  };
  const jack = (key: string): Pt => pointIn(sock(key).firstElementChild!);
  /** The grabbable part of a plug (outside the jack ring). */
  const plug = (connectionId: string, end: 'from' | 'to'): { el: Element; at: Pt } => {
    const el = root.querySelector(`[data-plug="${connectionId}:${end}"] rect`);
    if (!el) throw new Error(`No plug ${connectionId}:${end}`);
    return { el, at: pointIn(el) };
  };
  /** A visible point in empty panel (bottom right, away from every socket). */
  const empty = (): Pt => {
    const stage = root.querySelector<HTMLElement>('[data-cable-stage]')!;
    const r = stage.getBoundingClientRect();
    const v = stage.parentElement!.getBoundingClientRect();
    const jacks = [...stage.querySelectorAll('[data-socket-key] > span:first-child')].map((j) => pointIn(j));
    const bottom = Math.min(r.bottom, v.bottom) - 8;
    for (let x = Math.min(r.right, v.right) - 16; x > Math.max(r.left, v.left); x -= 12) {
      const p = { clientX: x, clientY: bottom };
      const clear = jacks.every((j) => Math.hypot(j.clientX - p.clientX, j.clientY - p.clientY) > 40);
      if (clear && document.elementFromPoint(p.clientX, p.clientY) === stage) return p;
    }
    throw new Error('No empty panel point in view');
  };
  return { m, root, sock, jack, plug, empty };
}

function drag(target: Element, from: Pt, to: Pt, steps = 6): void {
  pointer(target, 'pointerdown', from);
  for (let i = 1; i <= steps; i++) {
    pointer(target, 'pointermove', { clientX: from.clientX + ((to.clientX - from.clientX) * i) / steps, clientY: from.clientY + ((to.clientY - from.clientY) * i) / steps });
  }
  pointer(target, 'pointerup', to);
}

function click(target: Element, at: Pt): void {
  pointer(target, 'pointerdown', at);
  pointer(target, 'pointerup', at);
}

const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent ?? '');

/** Real browser input (CDP): real focus changes and default actions, unlike dispatched events. */
async function real(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await fn();
    await nextFrame();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

beforeEach(async () => {
  await page.viewport(1600, 1000);
  session.store.setLock(null);
  session.store.replace(createProject({ name: 'Cable test' }));
  uiStore.setState((s) => ({ ...s, selectedModuleId: null, cablesOpen: false }));
});

afterEach(() => {
  cleanup();
  session.store.setLock(null);
});

describe('Cable panel layout', () => {
  it('shows the part as blocks in signal order with labelled sockets and a text list of cables', () => {
    const { root, sock } = setup('t3');
    const blocks = [...root.querySelectorAll<HTMLElement>('[data-module]')];
    const x = (id: string) => parseFloat(blocks.find((b) => b.dataset.module === id)!.style.left);
    // Instrument → Drive → Filter → Channel → returns → Master Out, LFO below.
    expect(x('t3:inst')).toBeLessThan(x('t3:drive'));
    expect(x('t3:drive')).toBeLessThan(x('t3:filter'));
    expect(x('t3:filter')).toBeLessThan(x('t3:ch'));
    expect(x('t3:ch')).toBeLessThan(x('fx:reverb'));
    expect(x('fx:reverb')).toBeLessThan(x('master'));
    const top = (id: string) => parseFloat(blocks.find((b) => b.dataset.module === id)!.style.top);
    expect(top('t3:lfo')).toBeGreaterThan(top('t3:inst'));

    // Audio sockets are amber-kind, modulation sockets teal-kind, with plain labels.
    expect(sock(k('out', 't3:filter', 'out')).dataset.kind).toBe('audio');
    expect(sock(k('in', 't3:filter', 'cutoff')).dataset.kind).toBe('mod');
    expect(sock(k('in', 't3:filter', 'cutoff')).textContent).toContain('Cutoff mod');
    expect(sock(k('out', 't3:ch', 'sendA')).textContent).toContain('Send A');
    expect(sock(k('in', 't3:filter', 'in')).getAttribute('aria-label')).toBe('Filter In, audio input, from Drive Out');

    const list = [...root.querySelectorAll('.visually-hidden li')].map((li) => li.textContent);
    expect(list).toContain('Filter Out → Channel In');
    expect(list).toContain('LFO Mod Out → Filter Cutoff mod, amount 100%');
    // Other parts' sends reach the shared returns: shown as one labelled stub.
    expect(root.textContent).toContain('From 7 other parts');
  });

  it('turns an effect off and on with its bypass switch', () => {
    const { root } = setup('t3');
    const sw = root.querySelector<HTMLButtonElement>('[role="switch"][aria-labelledby]')!;
    const drive = () => session.store.getState().patch.modules.find((m) => m.id === 't3:drive')!;
    expect(drive().bypass).toBe(false);
    fire(sw, new MouseEvent('click', { bubbles: true }));
    expect(drive().bypass).toBe(true);
    expect(root.querySelector('[data-module="t3:drive"]')!.getAttribute('aria-label')).toContain('bypassed');
    // The state is also written on the switch, not only shown by its lamp.
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.textContent).toContain('Bypassed');

    // The effect's name selects it, shared with its card in the effects rack.
    const name = root.querySelector<HTMLButtonElement>('[data-module="t3:drive"] button[aria-pressed]')!;
    fire(name, new MouseEvent('click', { bubbles: true }));
    expect(uiStore.getState().selectedModuleId).toBe('t3:drive');
    expect(root.querySelector('[data-module="t3:drive"]')!.hasAttribute('data-selected')).toBe(true);
    // Blocks without a rack card have a plain title, not a button that does nothing elsewhere.
    expect(root.querySelector('[data-module="master"] button[aria-pressed]')).toBeNull();
    fire(sw, new MouseEvent('click', { bubbles: true }));
    expect(drive().bypass).toBe(false);
  });
});

describe('LFO depth', () => {
  it('shows the depth the LFO really runs at, which follows the Motion macro', () => {
    const { root } = setup('t3');
    const block = () => root.querySelector<HTMLElement>('[data-module="t3:lfo"]')!;
    const shown = () => /Depth (\d+)%/.exec(block().textContent ?? '')?.[1];
    const actual = () => String(Math.round(lfoDepth(session.store.getState(), 't3:lfo')!.depth * 100));
    act(() => void cmd.setMacro(session.store, 't3', 'motion', 0));
    expect(shown()).toBe('0');
    expect(block().querySelector('[data-still]')).not.toBeNull(); // no movement: neutral, not teal
    act(() => void cmd.setMacro(session.store, 't3', 'motion', 1));
    expect(Number(actual())).toBeGreaterThan(0);
    expect(shown()).toBe(actual());
    expect(block().querySelector('[data-still]')).toBeNull();
  });
});

describe('Patching with the pointer', () => {
  it('drag from an output to a compatible input adds a connection; compatible sockets light, others dim', () => {
    const { sock, jack } = setup('t3');
    const from = k('out', 't3:lfo', 'out');
    const to = k('in', 't3:inst', 'pitch');
    expect(find('t3:lfo', 'out', 't3:inst', 'pitch')).toBeUndefined();

    const a = jack(from);
    const b = jack(to);
    pointer(sock(from), 'pointerdown', a);
    pointer(sock(from), 'pointermove', { clientX: a.clientX + 20, clientY: a.clientY - 20 });
    expect(sock(to).dataset.compat).toBe('yes');
    expect(sock(k('in', 't3:ch', 'pan')).dataset.compat).toBe('yes');
    expect(sock(k('in', 't3:drive', 'in')).dataset.compat).toBe('no');
    pointer(sock(from), 'pointermove', b);
    expect(sock(to).dataset.hover).toBe('true');
    pointer(sock(from), 'pointerup', b);

    const c = find('t3:lfo', 'out', 't3:inst', 'pitch');
    expect(c).toBeDefined();
    expect(c!.amount).toBe(1);
    // Highlights are gone once the plug is dropped.
    expect(sock(to).dataset.compat).toBeUndefined();
  });

  it('refuses an incompatible drop with a plain message by the socket and leaves the patch unchanged', () => {
    const { root, sock, jack } = setup('t3');
    const before = JSON.stringify(conns());
    const from = k('out', 't3:filter', 'out');
    drag(sock(from), jack(from), jack(k('in', 't3:inst', 'pitch')));
    expect(JSON.stringify(conns())).toBe(before);
    const bubble = root.querySelector('[role="alert"]');
    expect(bubble?.textContent).toBe('An audio output can only go to an audio input.');

    // A modulation output onto an audio input explains the teal sockets.
    const lfo = k('out', 't3:lfo', 'out');
    drag(sock(lfo), jack(lfo), jack(k('in', 't3:ch', 'in')));
    expect(alerts()).toContain('A modulation output can only go to a teal modulation input.');

    // A loop back into the chain is refused as feedback.
    drag(sock(from), jack(from), jack(k('in', 't3:drive', 'in')));
    expect(alerts().some((t) => t.includes('Feedback loops are not allowed'))).toBe(true);
    expect(JSON.stringify(conns())).toBe(before);
  });

  it('click an output, then a compatible input, connects; Escape cancels an armed socket', () => {
    const { root, sock, jack } = setup('t3');
    const lfo = k('out', 't3:lfo', 'out');
    click(sock(lfo), jack(lfo));
    expect(sock(lfo).dataset.armed).toBe('true');
    expect(root.textContent).toContain('Choose a destination for LFO Mod Out');
    key(sock(lfo), 'keydown', { key: 'Escape' });
    expect(sock(lfo).dataset.armed).toBeUndefined();

    click(sock(lfo), jack(lfo));
    const amount = k('in', 't3:drive', 'amount');
    expect(sock(amount).dataset.compat).toBe('yes');
    click(sock(amount), jack(amount));
    expect(find('t3:lfo', 'out', 't3:drive', 'amount')).toBeDefined();
    expect(sock(lfo).dataset.armed).toBeUndefined();

    // Clicking an incompatible input explains why and keeps the socket armed.
    const filterOut = k('out', 't3:filter', 'out');
    click(sock(filterOut), jack(filterOut));
    const pitch = k('in', 't3:inst', 'pitch');
    click(sock(pitch), jack(pitch));
    expect(alerts()).toContain('An audio output can only go to an audio input.');
    expect(sock(filterOut).dataset.armed).toBe('true');
  });

  it('drags a plug to another socket to move the cable (same cable, new end)', () => {
    const { sock, jack, plug } = setup('t3');
    const c = find('t3:lfo', 'out', 't3:filter', 'cutoff')!;
    const p = plug(c.id, 'to');
    drag(p.el, p.at, jack(k('in', 't3:ch', 'pan')));
    const moved = conns().find((x) => x.id === c.id)!;
    expect(moved.to).toEqual({ module: 't3:ch', port: 'pan' });
    expect(moved.from).toEqual({ module: 't3:lfo', port: 'out' });
    expect(sock(k('in', 't3:ch', 'pan')).getAttribute('aria-label')).toContain('from LFO Mod Out');
  });

  it('drops a plug in empty panel to unplug it, and undo puts it back', () => {
    const { plug, empty } = setup('t3');
    const c = find('t3:lfo', 'out', 't3:filter', 'cutoff')!;
    const p = plug(c.id, 'to');
    drag(p.el, p.at, empty());
    expect(conns().some((x) => x.id === c.id)).toBe(false);
    session.undo();
    const back = conns().find((x) => x.id === c.id);
    expect(back?.to).toEqual({ module: 't3:filter', port: 'cutoff' });
    session.redo();
    expect(conns().some((x) => x.id === c.id)).toBe(false);
  });

  it('selecting a modulation cable shows its amount, which changes the real connection', () => {
    const { root, plug } = setup('t3');
    const c = find('t3:lfo', 'out', 't3:filter', 'cutoff')!;
    const p = plug(c.id, 'to');
    click(p.el, p.at);
    const group = root.querySelector('[aria-label="Selected cable"]')!;
    expect(group.textContent).toContain('LFO Mod Out → Filter Cutoff mod');
    const field = group.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    expect(field.getAttribute('aria-valuenow')).toBe('100');
    field.focus();
    for (let i = 0; i < 5; i++) key(field, 'keydown', { key: 'ArrowDown', shiftKey: false });
    expect(conns().find((x) => x.id === c.id)!.amount).toBeCloseTo(0.95, 5);
    // Unplug from the inspector.
    const unplug = [...group.querySelectorAll('button')].find((b) => b.textContent?.includes('Unplug'))!;
    fire(unplug, new MouseEvent('click', { bubbles: true }));
    expect(conns().some((x) => x.id === c.id)).toBe(false);
  });

  it('a cable clicked with the real pointer is unplugged by Delete; Escape clears the selection', async () => {
    const { root, plug } = setup('t3');
    const c = find('t3:lfo', 'out', 't3:filter', 'cutoff')!;
    // A real click (not a dispatched event), so the browser moves focus as it would for a user.
    const hit = plug(c.id, 'to');
    await real(() => userEvent.click(hit.el, { force: true }));
    expect(root.querySelector('[aria-label="Selected cable"]')?.textContent).toContain('LFO Mod Out → Filter Cutoff mod');
    await real(() => userEvent.keyboard('{Escape}'));
    expect(root.querySelector('[aria-label="Selected cable"]')).toBeNull();
    expect(conns().some((x) => x.id === c.id)).toBe(true);

    await real(() => userEvent.click(hit.el, { force: true }));
    await real(() => userEvent.keyboard('{Delete}'));
    expect(conns().some((x) => x.id === c.id)).toBe(false);
    expect(root.querySelector('[aria-label="Selected cable"]')).toBeNull();
    session.undo();
    expect(conns().some((x) => x.id === c.id)).toBe(true);
  });
});

describe('Routing across parts and fitting the space', () => {
  it('opens the Other parts strip and patches this part into another part’s Channel In', () => {
    const { root, sock, jack } = setup('t3');
    const toggle = [...root.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Other parts'))!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector(`button[data-socket-key="${k('in', 't5:ch', 'in')}"]`)).toBeNull();
    fire(toggle, new MouseEvent('click', { bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const lead = k('in', 't5:ch', 'in');
    expect(sock(lead).getAttribute('aria-label')).toContain('Lead Channel In');
    const from = k('out', 't3:filter', 'out');
    sock(lead).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    drag(sock(from), jack(from), jack(lead));
    expect(find('t3:filter', 'out', 't5:ch', 'in')).toBeDefined();
    // Collapsed again, the cable ends at a labelled edge stub.
    fire(toggle, new MouseEvent('click', { bubbles: true }));
    expect(root.textContent).toContain('To Lead · Channel');
  });

  it('uses the compact layout in a short region so the patch fits without vertical scrolling', async () => {
    const m = mount(h(CablePanel, { trackId: 't3', height: 262 }), { width: 1000 });
    await actFrame();
    await actFrame();
    const stage = m.container.querySelector<HTMLElement>('[data-cable-stage]')!;
    const viewport = stage.parentElement!;
    expect(stage.dataset.compact).toBe('true');
    expect(stage.offsetHeight).toBeLessThanOrEqual(viewport.clientHeight);
    expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth); // wide chains scroll sideways
  });

  it('does not re-render while module knobs move elsewhere', () => {
    let commits = 0;
    mount(h(Profiler, { id: 'cables', onRender: () => void (commits += 1) }, h(CablePanel, { trackId: 't3', height: 340 })), { width: 1500 });
    commits = 0;
    for (let i = 0; i < 20; i++) {
      act(() => void cmd.setModuleParam(session.store, 't3:filter', 'cutoff', 400 + i * 50, 'drag-test'));
      act(() => void cmd.setModuleParam(session.store, 't3:ch', 'level', -i / 2, 'drag-test-2'));
    }
    expect(session.store.getState().patch.modules.find((m) => m.id === 't3:filter')!.params.cutoff).toBe(1350);
    expect(commits).toBe(0);
    // A routing change does render.
    act(() => void cmd.setBypass(session.store, 't3:filter', true));
    expect(commits).toBeGreaterThan(0);
  });
});

describe('Keyboard connection picker', () => {
  it('Enter on an output lists compatible inputs; choosing one connects; Enter on an input disconnects', async () => {
    const { sock } = setup('t3');
    const lfo = sock(k('out', 't3:lfo', 'out'));
    lfo.focus();
    // Arrow keys move between sockets.
    key(lfo, 'keydown', { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('data-socket-key')).not.toBe(k('out', 't3:lfo', 'out'));
    sock(k('out', 't3:lfo', 'out')).focus();
    key(sock(k('out', 't3:lfo', 'out')), 'keydown', { key: 'Enter' });
    await actFrame();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.textContent).toContain('Connect LFO Mod Out to…');
    const list = dialog.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(document.activeElement).toBe(list);
    const options = [...list.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('aria-label'));
    expect(options).toContain('Channel Pan mod');
    expect(options).not.toContain('Filter Cutoff mod'); // already connected
    expect(options.some((o) => o?.includes('Channel In'))).toBe(false); // audio inputs are not offered

    // Move to "Channel Pan mod" and press Enter.
    for (let i = 0; i < 40; i++) {
      const active = document.getElementById(list.getAttribute('aria-activedescendant')!);
      if (active?.getAttribute('aria-label') === 'Channel Pan mod') break;
      key(list, 'keydown', { key: 'ArrowDown' });
    }
    key(list, 'keydown', { key: 'Enter' });
    expect(find('t3:lfo', 'out', 't3:ch', 'pan')).toBeDefined();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Enter on the input lists its cables with Disconnect.
    const pan = sock(k('in', 't3:ch', 'pan'));
    pan.focus();
    key(pan, 'keydown', { key: 'Enter' });
    await actFrame();
    const d2 = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const btn = d2.querySelector<HTMLButtonElement>('button[aria-label="Disconnect LFO Mod Out → Channel Pan mod"]')!;
    expect(btn).toBeTruthy();
    fire(btn, new MouseEvent('click', { bubbles: true }));
    expect(find('t3:lfo', 'out', 't3:ch', 'pan')).toBeUndefined();
    key(d2, 'keydown', { key: 'Escape' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('No path to the output', () => {
  it('warns after Channel → Master is unplugged, and Restore Connection plugs it back', () => {
    const { root, plug, empty } = setup('t3');
    expect(root.textContent).not.toContain('This part has no path to the output.');
    const c = find('t3:ch', 'out', 'master', 'in')!;
    const p = plug(c.id, 'to');
    drag(p.el, p.at, empty());
    expect(find('t3:ch', 'out', 'master', 'in')).toBeUndefined();
    expect(root.textContent).toContain('This part has no path to the output.');
    expect(alerts().some((t) => t.includes('This part has no path to the output.'))).toBe(true);

    const restore = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Restore Connection')!;
    fire(restore, new MouseEvent('click', { bubbles: true }));
    expect(find('t3:ch', 'out', 'master', 'in')).toBeDefined();
    expect(root.textContent).not.toContain('This part has no path to the output.');
    // The rest of the part's routing was not touched.
    expect(find('t3:lfo', 'out', 't3:filter', 'cutoff')).toBeDefined();
  });

  it('Restore Connection plugs a link broken mid-chain back in and keeps an effect the user added', () => {
    const { root, plug, empty } = setup('t3');
    let chorus = '';
    act(() => {
      chorus = cmd.insertEffect(session.store, 't3', 'chorus').moduleId!;
    });
    expect(find('t3:filter', 'out', chorus, 'in')).toBeDefined();
    const link = find('t3:drive', 'out', 't3:filter', 'in')!;
    const p = plug(link.id, 'to');
    const x = (id: string) => parseFloat(root.querySelector<HTMLElement>(`[data-module="${id}"]`)!.style.left);
    const order = () => ['t3:inst', 't3:drive', 't3:filter', chorus, 't3:ch'].map(x);
    const before = order();
    drag(p.el, p.at, empty());
    expect(find('t3:drive', 'out', 't3:filter', 'in')).toBeUndefined();
    // Pulling one cable does not reshuffle the blocks.
    expect(order()).toEqual(before);
    expect(root.textContent).toContain('This part has no path to the output.');
    expect(alerts().some((t) => t.includes('Restore Connection adds Drive Out → Filter In'))).toBe(true);

    const count = conns().length;
    const restore = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Restore Connection')!;
    fire(restore, new MouseEvent('click', { bubbles: true }));
    // Exactly the missing link comes back; the added Chorus and its cables stay.
    expect(find('t3:drive', 'out', 't3:filter', 'in')).toBeDefined();
    expect(conns().length).toBe(count + 1);
    expect(find('t3:filter', 'out', chorus, 'in')).toBeDefined();
    expect(find(chorus, 'out', 't3:ch', 'in')).toBeDefined();
    expect(root.textContent).not.toContain('This part has no path to the output.');
    // One undo step takes it out again.
    session.undo();
    expect(find('t3:drive', 'out', 't3:filter', 'in')).toBeUndefined();
    expect(session.store.getState().patch.modules.some((m) => m.id === chorus)).toBe(true);
  });

  it('restores the part’s default cables after confirmation', () => {
    const { root, plug, empty } = setup('t3');
    const link = find('t3:drive', 'out', 't3:filter', 'in')!;
    const p = plug(link.id, 'to');
    drag(p.el, p.at, empty());
    expect(find('t3:drive', 'out', 't3:filter', 'in')).toBeUndefined();

    const open = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Restore…')!;
    fire(open, new MouseEvent('click', { bubbles: true }));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Restore default cables?');
    // Nothing changes until a choice is confirmed.
    expect(find('t3:drive', 'out', 't3:filter', 'in')).toBeUndefined();
    const part = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Restore Bass’ cables')!;
    fire(part, new MouseEvent('click', { bubbles: true }));
    expect(find('t3:drive', 'out', 't3:filter', 'in')).toBeDefined();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // "Restore all parts" also mends another part's routing.
    const lead = find('t5:ch', 'out', 'master', 'in')!;
    act(() => void cmd.disconnect(session.store, lead.id));
    fire(open, new MouseEvent('click', { bubbles: true }));
    const all = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'Restore all parts')!;
    fire(all, new MouseEvent('click', { bubbles: true }));
    expect(find('t5:ch', 'out', 'master', 'in')).toBeDefined();
  });
});

describe('Performance take lock', () => {
  it('shows the lock message and refuses patch edits while a take records', () => {
    const { root, sock, jack } = setup('t3');
    const message = 'Recording a performance: cables are locked until you stop.';
    session.store.setLock(message);
    return actFrame().then(() => {
      expect(root.textContent).toContain(message);
      const before = JSON.stringify(conns());
      const lfo = k('out', 't3:lfo', 'out');
      // The panel itself refuses to pick up a plug (not just the command behind it).
      pointer(sock(lfo), 'pointerdown', jack(lfo));
      pointer(sock(lfo), 'pointermove', { clientX: jack(lfo).clientX + 60, clientY: jack(lfo).clientY - 40 });
      expect(root.querySelector('[data-dragging]')).toBeNull();
      expect(sock(k('in', 't3:inst', 'pitch')).dataset.compat).toBeUndefined();
      pointer(sock(lfo), 'pointerup', jack(k('in', 't3:inst', 'pitch')));
      expect(sock(lfo).dataset.armed).toBeUndefined();
      drag(sock(lfo), jack(lfo), jack(k('in', 't3:inst', 'pitch')));
      expect(JSON.stringify(conns())).toBe(before);
      expect(sock(lfo).getAttribute('aria-disabled')).toBe('true');
      const sw = root.querySelector<HTMLButtonElement>('[role="switch"]')!;
      expect(sw.disabled).toBe(true);
      const restore = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Restore…')!;
      expect(restore.disabled).toBe(true);
    });
  });
});

describe('Cables drawer', () => {
  it('is collapsed by default and opens the selected part’s cable panel', async () => {
    uiStore.setState((s) => ({ ...s, selectedTrackId: 't5' }));
    const m = mount(h(CablesDrawer), { width: 1400 });
    const bar = m.container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    expect(bar.textContent).toContain('Lead');
    expect(m.container.querySelector('[data-socket-key]')).toBeNull();
    fire(bar, new MouseEvent('click', { bubbles: true }));
    expect(uiStore.getState().cablesOpen).toBe(true);
    expect(m.container.querySelector(`button[data-socket-key="${k('out', 't5:inst', 'out')}"]`)).toBeTruthy();
    const hide = m.container.querySelector<HTMLButtonElement>('button[aria-label="Hide cables"]')!;
    fire(hide, new MouseEvent('click', { bubbles: true }));
    expect(uiStore.getState().cablesOpen).toBe(false);
    setCablesOpen(false);
  });
});
