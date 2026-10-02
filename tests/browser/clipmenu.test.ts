/**
 * Clip management in the Loops grid, in real Chromium: the pad menu (right
 * click and the '⋯' key on the selected pad), its actions on the project
 * (new clip, rename, length, duplicate, copy/paste into an empty slot, clear,
 * delete) with undo, the pad keyboard shortcuts (Delete, Ctrl+C, Ctrl+V, F2,
 * Shift+F10) and focus handling (arrows in the menu, Escape returns focus).
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { LoopsGrid } from '../../src/app/views/LoopsGrid';
import { getStarter } from '../../src/content/starters';
import type { Clip, Id } from '../../src/project/types';
import { selectSlot, selectTrack, setClipboard, setPadMode, slotFor, uiStore } from '../../src/state/uiStore';
import { cleanup, fire, key, mount, pointer } from './ui-harness';

beforeEach(() => {
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off', playing: false });
    setClipboard(null);
    setPadMode('loops');
    selectTrack('t1');
    selectSlot('t1', 0);
  });
});

afterEach(() => {
  cleanup();
  act(() => setClipboard(null));
});

function setup() {
  return mount(h('div', { style: { width: '1000px', height: '560px', display: 'flex', flexDirection: 'column' } }, h(LoopsGrid)), { width: 1040 });
}

const clips = (trackId: Id): (Clip | null)[] => session.store.getState().tracks.find((t) => t.id === trackId)!.clips;
const pad = (trackId: Id, slot: number) => document.getElementById(`pad-${trackId}-${slot}`) as HTMLButtonElement;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

function click(el: Element) {
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function rightClick(el: Element) {
  const r = el.getBoundingClientRect();
  fire(el, new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 12, clientY: r.top + 12 }));
}

/** A menu row by its visible text. */
function item(text: string | RegExp): HTMLButtonElement {
  const m = menu();
  if (!m) throw new Error('no menu open');
  const rows = [...m.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
  const found = rows.find((b) => (typeof text === 'string' ? b.textContent?.includes(text) : text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? '')));
  if (!found) throw new Error(`no menu item ${String(text)} in: ${rows.map((r) => r.textContent).join(' | ')}`);
  return found;
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** First slot with a clip and the first empty slot of a part. */
function slotsOf(trackId: Id) {
  const c = clips(trackId);
  return { full: c.findIndex((x) => x !== null), empty: c.findIndex((x) => x === null) };
}

describe('Clip pad menu', () => {
  it('right-click opens the clip menu at the pad and selects it without launching', () => {
    setup();
    const { full } = slotsOf('t3');
    const launched: [Id, number][] = [];
    const realPress = session.pressClip;
    session.pressClip = async (trackId, slot) => {
      launched.push([trackId, slot]);
    };
    try {
      // A primary press launches (so the spy is live)...
      pointer(pad('t2', 0), 'pointerdown');
      pointer(pad('t2', 0), 'pointerup');
      expect(launched).toEqual([['t2', 0]]);
      // ...a real right-click (secondary pointerdown, then contextmenu) only opens the menu.
      pointer(pad('t3', full), 'pointerdown', { button: 2, buttons: 2 });
      pointer(pad('t3', full), 'pointerup', { button: 2 });
      rightClick(pad('t3', full));
      expect(launched).toEqual([['t2', 0]]);
    } finally {
      session.pressClip = realPress;
    }
    const m = menu()!;
    expect(m).not.toBeNull();
    expect(m.getAttribute('aria-label')).toContain(clips('t3')[full]!.name);
    expect(uiStore.getState().selectedTrackId).toBe('t3');
    expect(slotFor(uiStore.getState(), 't3')).toBe(full);
    // Focus moved into the menu (first item).
    expect(m.contains(document.activeElement)).toBe(true);
  });

  it('Duplicate copies the clip into the next empty slot of the part, and Undo removes it', () => {
    setup();
    const trackId = 't4';
    const c = clips(trackId);
    const from = c.findIndex((x) => x !== null);
    const source = c[from]!;
    // The next empty slot after it, wrapping around.
    const to = [1, 2, 3].map((k) => (from + k) % 4).find((s) => c[s] === null)!;
    expect(to).toBeDefined();
    rightClick(pad(trackId, from));
    click(item('Duplicate'));
    expect(menu()).toBeNull();
    const copy = clips(trackId)[to]!;
    expect(copy).not.toBeNull();
    expect(copy.name).toBe(source.name);
    expect(copy.bars).toBe(source.bars);
    expect(copy.notes.map((n) => [n.tick, n.pitch])).toEqual(source.notes.map((n) => [n.tick, n.pitch]));
    expect(copy.id).not.toBe(source.id);
    expect(slotFor(uiStore.getState(), trackId)).toBe(to);
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    act(() => session.undo());
    expect(clips(trackId)[to]).toBeNull();
  });

  it('Copy then Paste into an empty slot (menu), including on another part', () => {
    setup();
    const { full } = slotsOf('t3');
    const source = clips('t3')[full]!;
    rightClick(pad('t3', full));
    click(item('Copy'));
    expect(uiStore.getState().clipboard?.name).toBe(source.name);

    const empty = slotsOf('t5').empty;
    rightClick(pad('t5', empty));
    expect(menu()!.textContent).toContain('Empty slot');
    click(item(/Paste/));
    const pasted = clips('t5')[empty]!;
    expect(pasted).not.toBeNull();
    expect(pasted.name).toBe(source.name);
    expect(pasted.notes.length).toBe(source.notes.length);
    act(() => session.undo());
    expect(clips('t5')[empty]).toBeNull();
  });

  it('Paste is offered but disabled while the clipboard is empty', () => {
    setup();
    const empty = slotsOf('t5').empty;
    rightClick(pad('t5', empty));
    const paste = item(/Paste/);
    expect(paste.getAttribute('aria-disabled')).toBe('true');
    const before = session.store.getState();
    click(paste);
    expect(session.store.getState()).toBe(before);
  });

  it('Length keys resize the clip (notes past the end are dropped with an undo notice)', () => {
    setup();
    const trackId = 't4';
    const slot = clips(trackId).findIndex((c) => c !== null && c.bars >= 2);
    const before = clips(trackId)[slot]!;
    rightClick(pad(trackId, slot));
    const oneBar = menu()!.querySelector<HTMLButtonElement>('[aria-label="Length 1 bar"]')!;
    expect(menu()!.querySelector(`[aria-label="Length ${before.bars} bars"]`)!.getAttribute('aria-checked')).toBe('true');
    click(oneBar);
    const after = clips(trackId)[slot]!;
    expect(after.bars).toBe(1);
    expect(after.notes.every((n) => n.tick < 384)).toBe(true);
    if (after.notes.length < before.notes.length) expect(runtimeStore.getState().notice?.text).toMatch(/past the end removed/);
    act(() => session.undo());
    expect(clips(trackId)[slot]!.bars).toBe(before.bars);
    expect(clips(trackId)[slot]!.notes.length).toBe(before.notes.length);
  });

  it('Clear notes keeps an empty clip; Delete clip empties the slot; both undo', () => {
    setup();
    const { full } = slotsOf('t2');
    const name = clips('t2')[full]!.name;
    rightClick(pad('t2', full));
    click(item('Clear notes'));
    expect(clips('t2')[full]!.notes).toHaveLength(0);
    expect(clips('t2')[full]!.name).toBe(name);
    // Clearing again is not offered.
    rightClick(pad('t2', full));
    expect(item('Clear notes').getAttribute('aria-disabled')).toBe('true');
    click(item('Delete clip'));
    expect(clips('t2')[full]).toBeNull();
    act(() => session.undo());
    act(() => session.undo());
    expect(clips('t2')[full]!.notes.length).toBeGreaterThan(0);
  });

  it('New clip on an empty slot creates a clip of the chosen length', () => {
    setup();
    const empty = slotsOf('t6').empty;
    rightClick(pad('t6', empty));
    click(menu()!.querySelector<HTMLButtonElement>('[aria-label="New clip, 2 bars"]')!);
    const c = clips('t6')[empty]!;
    expect(c).not.toBeNull();
    expect(c.bars).toBe(2);
    expect(c.notes).toHaveLength(0);
    expect(c.name).toBe(session.store.getState().scenes[empty].name);
    expect(pad('t6', empty).getAttribute('aria-label')).toContain(c.name);
  });

  it('Rename changes the clip name (inline field, Enter/submit saves)', () => {
    setup();
    const { full } = slotsOf('t3');
    rightClick(pad('t3', full));
    click(item('Rename'));
    expect(menu()).toBeNull();
    const input = dialog()!.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    typeInto(input, '  Deep   Roll ');
    click(dialog()!.querySelector('button[type="submit"]')!);
    expect(clips('t3')[full]!.name).toBe('Deep Roll');
    expect(dialog()).toBeNull();
  });

  it('Edit steps selects the clip and switches the pads to Steps', () => {
    setup();
    const { full } = slotsOf('t3');
    rightClick(pad('t3', full));
    click(item('Edit steps'));
    expect(uiStore.getState().padMode).toBe('steps');
    expect(uiStore.getState().selectedTrackId).toBe('t3');
    expect(slotFor(uiStore.getState(), 't3')).toBe(full);
  });

  it("the selected pad shows a '⋯' key that opens the same menu and toggles it", () => {
    setup();
    act(() => {
      selectTrack('t3');
      selectSlot('t3', slotsOf('t3').full);
    });
    const more = document.querySelector<HTMLButtonElement>('button[aria-label^="Options for clip"]')!;
    expect(more).not.toBeNull();
    expect(document.querySelectorAll('button[aria-label^="Options for clip"], button[aria-label^="Options for empty slot"]')).toHaveLength(1);
    click(more);
    expect(menu()).not.toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    click(more);
    expect(menu()).toBeNull();
  });

  it('menu keys: arrows move between rows, Escape closes and returns focus to the pad', () => {
    setup();
    const { full } = slotsOf('t3');
    const p = pad('t3', full);
    act(() => p.focus());
    key(p, 'keydown', { key: 'F10', shiftKey: true });
    const m = menu()!;
    expect(m).not.toBeNull();
    const first = document.activeElement as HTMLElement;
    expect(first.textContent).toContain('Edit steps');
    key(first, 'keydown', { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).textContent).toContain('Rename');
    key(document.activeElement!, 'keydown', { key: 'ArrowDown' });
    // Into the length row at the clip's current length, then Left along it.
    const bars = clips('t3')[full]!.bars;
    expect(document.activeElement!.getAttribute('aria-label')).toBe(`Length ${bars} bar${bars === 1 ? '' : 's'}`);
    if (bars > 1) {
      key(document.activeElement!, 'keydown', { key: 'ArrowLeft' });
      expect(document.activeElement!.getAttribute('aria-label')).toBe(`Length ${bars - 1} bar${bars - 1 === 1 ? '' : 's'}`);
    }
    key(document.activeElement!, 'keydown', { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).textContent).toContain('Double (repeat)');
    key(document.activeElement!, 'keydown', { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).textContent).toContain('Repeat to 8 bars');
    key(document.activeElement!, 'keydown', { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).textContent).toContain('Move…');
    key(document.activeElement!, 'keydown', { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).textContent).toContain('Duplicate');
    key(document.activeElement!, 'keydown', { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(pad('t3', full));
  });

  it('an outside press closes the menu without changing the project', () => {
    setup();
    const before = session.store.getState();
    rightClick(pad('t3', slotsOf('t3').full));
    expect(menu()).not.toBeNull();
    fire(document.body, new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(menu()).toBeNull();
    expect(session.store.getState()).toBe(before);
  });
});

describe('Pad keyboard shortcuts', () => {
  it('Delete removes the focused clip with an Undo notice; Undo brings it back', () => {
    setup();
    const { full } = slotsOf('t3');
    const name = clips('t3')[full]!.name;
    const p = pad('t3', full);
    act(() => p.focus());
    key(p, 'keydown', { key: 'Delete' });
    expect(clips('t3')[full]).toBeNull();
    const notice = runtimeStore.getState().notice!;
    expect(notice.action).toBe('undo');
    expect(notice.text).toContain(name);
    act(() => session.undo());
    expect(clips('t3')[full]!.name).toBe(name);
  });

  it('Ctrl+C on a pad and Ctrl+V on an empty pad copy the clip across', () => {
    setup();
    const { full } = slotsOf('t1');
    const empty = slotsOf('t1').empty;
    const src = pad('t1', full);
    act(() => src.focus());
    key(src, 'keydown', { key: 'c', ctrlKey: true });
    expect(uiStore.getState().clipboard?.name).toBe(clips('t1')[full]!.name);
    const dst = pad('t1', empty);
    act(() => dst.focus());
    key(dst, 'keydown', { key: 'v', ctrlKey: true });
    expect(clips('t1')[empty]!.name).toBe(clips('t1')[full]!.name);
    expect(clips('t1')[empty]!.notes.length).toBe(clips('t1')[full]!.notes.length);
    expect(slotFor(uiStore.getState(), 't1')).toBe(empty);
  });

  it('F2 on a pad opens the rename field straight away', () => {
    setup();
    const { full } = slotsOf('t3');
    const p = pad('t3', full);
    act(() => p.focus());
    key(p, 'keydown', { key: 'F2' });
    const input = dialog()!.querySelector('input')!;
    expect(input.value).toBe(clips('t3')[full]!.name);
    key(input, 'keydown', { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(p);
  });

  it('shortcuts are refused while a performance is recording (take lock)', () => {
    setup();
    const { full } = slotsOf('t3');
    session.store.setLock('Recording a performance', () => false);
    try {
      const p = pad('t3', full);
      act(() => p.focus());
      key(p, 'keydown', { key: 'Delete' });
      expect(clips('t3')[full]).not.toBeNull();
      expect(runtimeStore.getState().notice?.tone).toBe('warn');
    } finally {
      session.store.setLock(null);
    }
  });
});
